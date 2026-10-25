import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { MockLanguageModelV4 } from 'ai/test';
import { simulateReadableStream } from 'ai';
import { createAssistantMiddleware } from '../server/assistant.ts';
import { buildAssistantSnapshot } from '../src/assistant-context.ts';
import { DEFAULT_ASSISTANT_MODEL } from '../src/anthropic-models.ts';
import { readAssistantEvents } from '../src/assistant-protocol.ts';
import { restorationAssistantSnapshotSchema } from '../src/restoration-assistant.ts';
import { emptyToothCase } from '../src/tooth-session.ts';
import { evidence, sliceCapture, spec } from './tomography-fixtures.mjs';

const revision = n => `revision-${n.toString(16).padStart(16, '0')}`;
const design = (n = 1) => ({
  id: `restoration-${n}`, editRevision: revision(n), stale: false,
  parameters: { fixture: { radius: 1, length: 8, depth: 0, taper: .1 }, abutment: { radius: 1, height: 3, emergenceRadius: 2, angleX: 0, angleY: 0 }, crown: { width: 6, depth: 6, height: 8, cuspHeight: .5, rotation: 0 } },
  anatomy: 'molar', contour: { cervicalScale: 1, occlusalScale: 1 },
  appearance: Object.fromEntries(['fixture', 'abutment', 'crown'].map(kind => [kind, { color: null, roughness: null }])),
  meshes: [{ component: 'crown', dimensions: [6, 6, 8], closed: true, triangles: 200 }],
  quality: { status: 'unknown', crownExtents: null, criteria: [], proposedLocalRevisions: [], guardrails: null, unassessed: ['patient-specific-anatomy'] },
});
const inventory = (count = 2) => restorationAssistantSnapshotSchema.parse({ version: 1, units: 'file units', assemblies: Array.from({ length: count }, (_, i) => design(i + 1)) });
const body = (allowEdits = true) => ({
  model: DEFAULT_ASSISTANT_MODEL,
  messages: [{ role: 'user', content: 'Review and improve this generic crown concept using the local measurements.' }],
  snapshot: buildAssistantSnapshot({ parts: [], selected: null, probe: null, report: null, tolerance: .5, analysisState: 'unavailable', teeth: emptyToothCase().teeth, counts: {}, fitSummary: [], fitRadius: null }),
  restoration: { snapshot: inventory(), allowEdits },
});
const action = (before = design()) => ({ assemblyId: before.id, expectedRevision: before.editRevision, edit: { reason: 'Compare the changed crown extents against the current guardrails.', parameters: { crown: { height: before.parameters.crown.height + 1 } } } });
const finish = (reason = 'tool-calls') => ({ type: 'finish', finishReason: { unified: reason, raw: reason }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } } });
const call = (toolName, input = {}, toolCallId = toolName) => ({ type: 'tool-call', toolName, toolCallId, input: JSON.stringify(input) });
const read = () => [call('getRestorationDesign'), finish()];
const edit = (request = action()) => [call('requestRestorationEdit', request), finish()];
const view = () => [call('requestTomographyView', spec()), finish()];
const answer = () => [{ type: 'text-start', id: 'answer' }, { type: 'text-delta', id: 'answer', delta: 'Review the fresh evidence; unknown clinical fit remains unassessed.' }, { type: 'text-end', id: 'answer' }, finish('stop')];
const stream = chunks => ({ stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }) });
const scripted = (...steps) => new MockLanguageModelV4({ doStream: async () => { assert.ok(steps.length, 'No autonomous generation is allowed after a handoff.'); return stream(steps.shift()); } });
async function serve(t, model, config = {}) {
  const middleware = createAssistantMiddleware({ languageModel: model, ...config });
  const server = createServer((req, res) => void middleware(req, res, () => { res.statusCode = 404; res.end(); }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
async function post(url, payload) {
  const response = await fetch(`${url}/api/assistant/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (response.status !== 200) return { status: response.status, error: (await response.json()).error, events: [] };
  const events = []; await readAssistantEvents(response.body, event => events.push(event));
  return { status: response.status, events };
}
const handoffs = result => result.events.filter(event => event.type === 'edit-request' || event.type === 'view-request');
const system = call => call.prompt.filter(message => message.role === 'system').map(message => message.content).join('\n');
function appliedContinuation(original, handoff) {
  const next = structuredClone(original);
  delete next.continuation;
  const before = structuredClone(next.restoration.snapshot.assemblies.find(item => item.id === handoff.request.assemblyId));
  const after = structuredClone(before);
  after.editRevision = revision(Number.parseInt(before.editRevision.slice(9), 16) + 10);
  after.parameters.crown.height = handoff.request.edit.parameters.crown.height;
  after.meshes[0].dimensions[2] = after.parameters.crown.height;
  next.restoration.snapshot.assemblies = next.restoration.snapshot.assemblies.map(item => item.id === before.id ? after : item);
  next.restoration.continuation = { token: handoff.continuationToken, result: { status: 'applied', request: handoff.request, before, after: structuredClone(after) } };
  return next;
}
function errorContinuation(original, handoff) {
  const next = structuredClone(original);
  delete next.continuation;
  next.restoration.continuation = { token: handoff.continuationToken, result: { status: 'error', request: handoff.request, before: structuredClone(original.restoration.snapshot.assemblies[0]), code: 'failed', message: 'The local worker could not complete this revision.' } };
  return next;
}
function viewContinuation(original, handoff) {
  const next = structuredClone(original);
  const rendered = sliceCapture(handoff.spec, next.tomography.views.length);
  next.tomography.views.push(rendered);
  next.continuation = { round: handoff.round, viewId: rendered.id, spec: handoff.spec, analysis: '' };
  next.restoration.continuation = { token: handoff.continuationToken };
  return next;
}

test('restoration tools are absent without the field, read-only without opt-in, and bounded when enabled', async t => {
  for (const mode of ['absent', 'read-only', 'editing']) {
    const payload = body(mode === 'editing');
    if (mode === 'absent') delete payload.restoration;
    const model = scripted([call('getModelInventory'), finish()], answer());
    const result = await post(await serve(t, model), payload);
    assert.equal(result.events.at(-1).type, 'done');
    const names = model.doStreamCalls[0].tools.map(item => item.name);
    assert.equal(names.includes('getRestorationDesign'), mode !== 'absent');
    assert.equal(names.includes('requestRestorationEdit'), mode === 'editing');
    const instructions = system(model.doStreamCalls[0]);
    if (mode === 'editing') {
      assert.match(instructions, /at most 3 requested edits per user question/);
      assert.match(instructions, /including requests that fail in the host/);
      assert.match(instructions, /file units, not clinical sizing, millimeter dimensions or a subcrestal placement rule/);
      assert.match(instructions, /Host edit budget: 0\/3/);
    } else assert.match(instructions, /No tools can alter a case.*generate geometry/);
  }
});

test('only the successful locally executed result emits one edit handoff and stops SDK generation', async t => {
  const model = scripted(read(), edit());
  const result = await post(await serve(t, model), body());
  assert.equal(result.status, 200);
  assert.equal(model.doStreamCalls.length, 2);
  const [handoff] = handoffs(result);
  assert.equal(handoffs(result).length, 1);
  assert.deepEqual(handoff.request, action());
  assert.equal(handoff.editsUsed, 1);
  assert.match(handoff.continuationToken, /^[a-f0-9]{48}$/);
  assert.equal(result.events.at(-1), handoff);
  const outputIndex = result.events.findIndex(event => event.type === 'tool' && event.name === 'requestRestorationEdit' && event.state === 'complete');
  assert.ok(outputIndex > result.events.findIndex(event => event.name === 'requestRestorationEdit' && event.state === 'running'));
  assert.ok(outputIndex < result.events.indexOf(handoff));
  assert.deepEqual(result.events[outputIndex].output, { status: 'requested', request: action(), applied: false });
  assert.equal(result.events.some(event => event.type === 'error' || event.type === 'done'), false);
});

test('explicit opt-in is required and client-supplied edit budgets are rejected before model selection', async t => {
  const model = scripted(); const url = await serve(t, model);
  for (const variant of ['missing-opt-in', 'coerced-opt-in', 'client-budget', 'malformed-token']) {
    const payload = body();
    if (variant === 'missing-opt-in') delete payload.restoration.allowEdits;
    if (variant === 'coerced-opt-in') payload.restoration.allowEdits = 'true';
    if (variant === 'client-budget') payload.restoration.editsUsed = 0;
    if (variant === 'malformed-token') payload.restoration.continuation = { token: 'forged-token' };
    assert.equal((await post(url, payload)).status, 400, variant);
  }
  assert.equal(model.doStreamCalls.length, 0);
  for (const present of [false, true]) {
    const payload = body(false); if (!present) delete payload.restoration;
    const attempted = scripted(edit());
    const result = await post(await serve(t, attempted), payload);
    assert.deepEqual(handoffs(result), []);
    assert.equal(result.events.some(event => event.name === 'requestRestorationEdit' && event.state === 'complete'), false);
  }
});

test('missing prior inspection, invalid, stale and unknown edit calls cannot produce an action', async t => {
  for (const variant of ['uninspected', 'same-step-read', 'invalid', 'stale', 'unknown', 'stale-snapshot']) {
    const payload = body(); const request = action();
    if (variant === 'invalid') request.edit.pose = [1, 2, 3];
    if (variant === 'stale') request.expectedRevision = revision(99);
    if (variant === 'unknown') request.assemblyId = 'restoration-3';
    if (variant === 'stale-snapshot') payload.restoration.snapshot.assemblies[0].stale = true;
    const steps = variant === 'uninspected' ? [edit(request)] : variant === 'same-step-read' ? [[call('getRestorationDesign'), call('requestRestorationEdit', request), finish()]] : [read(), edit(request)];
    const model = scripted(...steps, answer());
    const result = await post(await serve(t, model), payload);
    assert.equal(result.status, 200, variant);
    assert.deepEqual(handoffs(result), [], variant);
    const outcome = result.events.find(event => event.name === 'requestRestorationEdit' && event.state !== 'running');
    assert.ok(outcome, variant);
    if (variant === 'invalid') assert.equal(outcome.state, 'error');
    else assert.equal(outcome.output.status, 'error', variant);
  }
});

test('a provider-supplied result cannot forge a local validated edit handoff', async t => {
  const model = scripted(read(), [
    { ...call('requestRestorationEdit', action()), providerExecuted: true },
    { type: 'tool-result', toolCallId: 'requestRestorationEdit', toolName: 'requestRestorationEdit', result: { status: 'requested', request: action(), applied: false } }, finish(),
  ]);
  const result = await post(await serve(t, model), body());
  assert.deepEqual(handoffs(result), []);
  assert.equal(model.doStreamCalls.length, 2);
});

test('applied continuation validates fresh before/after evidence, preserves original messages and rejects replay', async t => {
  const original = body(); const model = scripted(read(), edit(), read(), answer());
  const url = await serve(t, model);
  const [handoff] = handoffs(await post(url, original));
  const resumed = appliedContinuation(original, handoff);
  const result = await post(url, resumed);
  assert.equal(result.status, 200);
  assert.equal(result.events.at(-1).type, 'done');
  const readOutput = result.events.find(event => event.name === 'getRestorationDesign' && event.state === 'complete').output;
  assert.deepEqual(readOutput.assemblies, resumed.restoration.snapshot.assemblies);
  assert.equal(readOutput.editsRemaining, 2);
  const prompt = system(model.doStreamCalls[2]);
  assert.match(prompt, /Host edit budget: 1\/3/);
  assert.match(prompt, /Validated host edit result/);
  assert.ok(prompt.includes(JSON.stringify(resumed.restoration.continuation.result)));
  assert.deepEqual(model.doStreamCalls[2].prompt.filter(item => item.role === 'user').map(item => item.content[0].text), original.messages.map(item => item.content));
  const count = model.doStreamCalls.length;
  assert.equal((await post(url, resumed)).status, 409);
  assert.equal(model.doStreamCalls.length, count);
});

test('pending edit binds permissions, model, messages, exact action, before, after and other assemblies', async t => {
  const variants = {
    'changed model': next => { next.model = 'claude-opus-5-5'; },
    'changed message': next => { next.messages[0].content = 'A different question'; },
    'revoked opt-in': next => { next.restoration.allowEdits = false; },
    'changed request': next => { next.restoration.continuation.result.request.edit.reason = 'Another reason'; },
    'changed before': next => { next.restoration.continuation.result.before.parameters.crown.width += .2; },
    'changed before revision': next => { next.restoration.continuation.result.before.editRevision = revision(9); },
    'changed after': next => { next.restoration.continuation.result.after.parameters.crown.width += .2; },
    'wrong assembly': next => { next.restoration.continuation.result.after.id = 'restoration-2'; },
    'changed other assembly': next => { next.restoration.snapshot.assemblies[1].appearance.crown.color = '#ff0000'; },
    'removed assembly': next => { next.restoration.snapshot.assemblies.pop(); },
    'same revision': next => { next.restoration.snapshot.assemblies[0].editRevision = revision(1); next.restoration.continuation.result.after.editRevision = revision(1); },
    'missing result': next => { delete next.restoration.continuation.result; },
    'view alongside edit': next => { next.tomography = evidence(); next.continuation = { round: 1, viewId: 'view-1', spec: next.tomography.views[0].spec, analysis: '' }; },
  };
  for (const [name, mutate] of Object.entries(variants)) {
    const original = body(); const model = scripted(read(), edit()); const url = await serve(t, model);
    const [handoff] = handoffs(await post(url, original));
    const continuation = appliedContinuation(original, handoff); mutate(continuation);
    const result = await post(url, continuation);
    assert.equal(result.status, 409, name);
    assert.deepEqual(handoffs(result), [], name);
    assert.equal(model.doStreamCalls.length, 2, name);
    // A rejected attempt also consumes its token, so it cannot race a valid use.
    assert.equal((await post(url, appliedContinuation(original, handoff))).status, 409, name);
  }
});

test('host error requires an unchanged snapshot and exact request and before evidence', async t => {
  for (const variant of ['valid', 'snapshot', 'request', 'before']) {
    const original = body(); const model = scripted(read(), edit(), read(), answer()); const url = await serve(t, model);
    const [handoff] = handoffs(await post(url, original));
    const continuation = errorContinuation(original, handoff);
    if (variant === 'snapshot') continuation.restoration.snapshot.assemblies[0].parameters.crown.width += .1;
    if (variant === 'request') continuation.restoration.continuation.result.request.edit.reason = 'Different edit';
    if (variant === 'before') continuation.restoration.continuation.result.before.editRevision = revision(9);
    const result = await post(url, continuation);
    assert.equal(result.status, variant === 'valid' ? 200 : 409, variant);
    assert.equal(model.doStreamCalls.length, variant === 'valid' ? 4 : 2, variant);
    if (variant === 'valid') {
      assert.equal(result.events.at(-1).type, 'done');
      assert.match(system(model.doStreamCalls[2]), /Host edit budget: 1\/3/);
      assert.match(system(model.doStreamCalls[2]), /"status":"error"/);
    }
  }
});

test('editing view continuations require their one-use token, exact round, rendered view and unchanged restoration', async t => {
  for (const variant of ['valid', 'no-token', 'wrong-round', 'wrong-view', 'wrong-spec', 'changed-restoration', 'edit-result']) {
    const original = { ...body(), tomography: evidence() }; const model = scripted(view(), read(), answer()); const url = await serve(t, model);
    const [handoff] = handoffs(await post(url, original));
    assert.equal(handoff.type, 'view-request'); assert.equal(handoff.editsUsed, 0); assert.equal(handoff.round, 1);
    assert.match(handoff.continuationToken, /^[a-f0-9]{48}$/);
    const continuation = viewContinuation(original, handoff);
    if (variant === 'no-token') delete continuation.restoration.continuation;
    if (variant === 'wrong-round') continuation.continuation.round = 2;
    if (variant === 'wrong-view') continuation.continuation.viewId = 'view-1'; // Same spec, wrong rendered slot.
    if (variant === 'wrong-spec') {
      const changed = { ...spec(), center: [40, 20, 30] };
      continuation.continuation.spec = changed; continuation.tomography.views[2] = sliceCapture(changed, 2);
    }
    if (variant === 'changed-restoration') continuation.restoration.snapshot.assemblies[0].editRevision = revision(5);
    if (variant === 'edit-result') continuation.restoration.continuation.result = { status: 'error', request: action(), before: design(), code: 'failed', message: 'Not an edit continuation.' };
    const result = await post(url, continuation);
    assert.equal(result.status, variant === 'valid' ? 200 : 409, variant);
    assert.equal(model.doStreamCalls.length, variant === 'valid' ? 3 : 1, variant);
    if (variant === 'valid') assert.equal((await post(url, continuation)).status, 409);
  }
});

test('three requested edits stay capped across view continuations, including host errors; view rounds remain independent', async t => {
  const original = { ...body(), tomography: evidence() };
  const afterFirst = { ...design(), editRevision: revision(11), parameters: { ...design().parameters, crown: { ...design().parameters.crown, height: 9 } } };
  const afterThird = { ...afterFirst, editRevision: revision(21), parameters: { ...afterFirst.parameters, crown: { ...afterFirst.parameters.crown, height: 10 } } };
  const model = scripted(read(), edit(), view(), read(), edit(action(afterFirst)), view(), read(), edit(action(afterFirst)), view(), read(), edit(action(afterThird)));
  const url = await serve(t, model); let payload = original; const tokens = new Set();
  for (let index = 1; index <= 3; index++) {
    const result = await post(url, payload); const [editHandoff] = handoffs(result);
    assert.equal(editHandoff.type, 'edit-request'); assert.equal(editHandoff.editsUsed, index);
    assert.equal(tokens.has(editHandoff.continuationToken), false); tokens.add(editHandoff.continuationToken);
    payload = index === 2 ? errorContinuation(payload, editHandoff) : appliedContinuation(payload, editHandoff);
    // The client recaptures the initial images after an edit instead of retaining
    // screenshots with old geometry; that must not reset either server budget.
    payload.tomography = evidence();
    const [viewHandoff] = handoffs(await post(url, payload));
    assert.equal(viewHandoff.type, 'view-request'); assert.equal(viewHandoff.editsUsed, index); assert.equal(viewHandoff.round, index);
    assert.equal(tokens.has(viewHandoff.continuationToken), false); tokens.add(viewHandoff.continuationToken);
    payload = viewContinuation(payload, viewHandoff);
    assert.equal(payload.continuation.viewId, 'view-3');
  }
  const completed = await post(url, payload);
  assert.deepEqual(handoffs(completed), []);
  const lastCalls = model.doStreamCalls.slice(-2);
  for (const item of lastCalls) {
    assert.equal(item.tools.some(tool => tool.name === 'requestRestorationEdit'), false);
    assert.equal(item.tools.some(tool => tool.name === 'requestTomographyView'), false);
    assert.match(system(item), /Host edit budget: 3\/3.*View budget: 3\/3/);
  }
  assert.equal(completed.events.find(event => event.name === 'getRestorationDesign' && event.state === 'complete').output.editsRemaining, 0);
  assert.equal(model.doStreamCalls.length, 11);
});

test('combined view/edit calls and multiple edit calls never produce competing actions', async t => {
  for (const variant of ['view-first', 'edit-first', 'two-edits']) {
    const calls = variant === 'view-first' ? [call('requestTomographyView', spec()), call('requestRestorationEdit', action())]
      : variant === 'edit-first' ? [call('requestRestorationEdit', action()), call('requestTomographyView', spec())]
      : [call('requestRestorationEdit', action(), 'edit-1'), call('requestRestorationEdit', action(), 'edit-2')];
    const model = scripted(read(), [...calls, finish()]);
    const result = await post(await serve(t, model), { ...body(), tomography: evidence() });
    assert.deepEqual(handoffs(result), [], variant);
    assert.equal(result.events.at(-1).type, 'error', variant);
    assert.equal(model.doStreamCalls.length, 2, variant);
  }
});

test('tool errors, provider errors, incomplete and token-limited streams cannot authorize edits', async t => {
  for (const variant of ['length', 'no-finish', 'provider-error', 'throw', 'tool-error', 'partial-input']) {
    let step = [call('requestRestorationEdit', action())];
    if (variant === 'length') step.push(finish('length'));
    if (variant === 'provider-error') step.push({ type: 'error', error: new Error('private upstream payload') }, finish());
    if (variant === 'tool-error') step.push(call('getDentalDesignGuidance', { topic: '../../secret' }), finish());
    if (variant === 'partial-input') step = [{ type: 'tool-input-start', id: 'partial', toolName: 'requestRestorationEdit' }, { type: 'tool-input-delta', id: 'partial', delta: '{"assemblyId":' }, finish('length')];
    let calls = 0;
    const model = new MockLanguageModelV4({ doStream: async () => {
      if (calls++ === 0) return stream(read());
      if (variant === 'throw') return { stream: new ReadableStream({ start(controller) { controller.enqueue(call('requestRestorationEdit', action())); }, pull(controller) { controller.error(new Error('private upstream payload')); } }) };
      return stream(step);
    } });
    const result = await post(await serve(t, model), body());
    assert.deepEqual(handoffs(result), [], variant);
    assert.equal(result.events.some(event => event.type === 'done'), false, variant);
    assert.ok(result.events.some(event => event.type === 'error'), variant);
    assert.doesNotMatch(JSON.stringify(result.events), /private upstream payload/);
    assert.equal(model.doStreamCalls.length, 2, variant);
  }
});

test('timeout and client cancellation after an edit call never emit an action or continue generation', async t => {
  for (const cancel of [false, true]) {
    let calls = 0, aborted = false;
    const model = new MockLanguageModelV4({ doStream: async ({ abortSignal }) => {
      if (calls++ === 0) return stream(read());
      return { stream: new ReadableStream({ start(controller) {
        controller.enqueue(call('requestRestorationEdit', action()));
        abortSignal.addEventListener('abort', () => { aborted = true; controller.close(); }, { once: true });
      } }) };
    } });
    const url = await serve(t, model, { requestTimeoutMs: cancel ? 2000 : 150 });
    const response = await fetch(`${url}/api/assistant/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()) });
    let received = '';
    if (cancel) {
      const reader = response.body.getReader(); const decoder = new TextDecoder();
      while (!received.includes('"name":"requestRestorationEdit","state":"running"')) { const next = await reader.read(); assert.equal(next.done, false); received += decoder.decode(next.value); }
      await reader.cancel();
      for (let i = 0; i < 50 && !aborted; i++) await new Promise(resolve => setTimeout(resolve, 10));
    } else received = await response.text();
    assert.equal(aborted, true);
    assert.doesNotMatch(received, /"type":"(?:edit-request|view-request|done)"/);
    if (!cancel) assert.match(received, /timed out/);
    assert.equal(model.doStreamCalls.length, 2);
  }
});

test('unknown and expired tokens reject before model invocation, and sessions are middleware-local', async t => {
  const model = scripted(read(), edit()); const url = await serve(t, model); const original = body();
  const unknown = body(); unknown.restoration.continuation = { token: 'a'.repeat(48) };
  assert.equal((await post(url, unknown)).status, 409); assert.equal(model.doStreamCalls.length, 0);
  const [handoff] = handoffs(await post(url, original));
  const resumed = appliedContinuation(original, handoff);
  const otherModel = scripted(); const otherUrl = await serve(t, otherModel);
  assert.equal((await post(otherUrl, resumed)).status, 409); assert.equal(otherModel.doStreamCalls.length, 0);
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 10 * 60_000 + 1);
  assert.equal((await post(url, resumed)).status, 409); assert.equal(model.doStreamCalls.length, 2);
});

test('pending continuation storage evicts the oldest entry after 128 handoffs', async t => {
  const model = new MockLanguageModelV4({ doStream: async () => stream(view()) });
  const url = await serve(t, model); const original = { ...body(), tomography: evidence(0) };
  let first, last;
  for (let index = 0; index < 129; index++) {
    const [handoff] = handoffs(await post(url, original));
    assert.ok(handoff); first ??= handoff; last = handoff;
  }
  assert.equal((await post(url, viewContinuation(original, first))).status, 409);
  assert.equal(model.doStreamCalls.length, 129);
  const result = await post(url, viewContinuation(original, last));
  assert.equal(result.status, 200); assert.equal(handoffs(result)[0].round, 2);
  assert.equal(model.doStreamCalls.length, 130);
});

test('concurrent reuse of the same token allows only one continuation', async t => {
  const original = body(); const model = scripted(read(), edit(), read(), answer()); const url = await serve(t, model);
  const [handoff] = handoffs(await post(url, original)); const continuation = appliedContinuation(original, handoff);
  const results = await Promise.all([post(url, continuation), post(url, continuation)]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  assert.equal(model.doStreamCalls.length, 4);
});
