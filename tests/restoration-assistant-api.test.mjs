import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { MockLanguageModelV4 } from 'ai/test';
import { APICallError, RetryError, StreamProviderError, ToolChoiceViolationError, simulateReadableStream } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createAssistantMiddleware } from '../server/assistant.ts';
import { buildAssistantSnapshot } from '../src/assistant-context.ts';
import { DEFAULT_ASSISTANT_MODEL } from '../src/anthropic-models.ts';
import { readAssistantEvents } from '../src/assistant-protocol.ts';
import { restorationAssistantSnapshotSchema } from '../src/restoration-assistant.ts';
import { compareRestorationFeedback } from '../src/restoration-feedback.ts';
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
      assert.match(instructions, /at most 8 requested edits per user question/);
      assert.match(instructions, /including requests that fail in the host/);
      assert.match(instructions, /file units, not clinical sizing, millimeter dimensions or a subcrestal placement rule/);
      assert.match(instructions, /Host edit budget: 0\/8/);
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

test('measurement follow-up accepts scan inventory before restoration measurements for every offered model', async t => {
  for (const modelId of ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']) {
    const model = scripted([call('getModelInventory'), finish()], read(), answer());
    const payload = body(); payload.model = modelId; payload.restoration.mode = 'measurement-follow-up';
    const result = await post(await serve(t, model), payload);
    assert.equal(result.events.at(-1).type, 'done', modelId);
    assert.equal(result.events.some(event => event.type === 'error'), false, modelId);
    assert.deepEqual(result.events.filter(event => event.name === 'getModelInventory').map(event => event.state), ['running', 'complete']);
    assert.equal(model.doStreamCalls[0].toolChoice.type, 'auto');
  }
});

test('measurement review uses supported native Anthropic settings and executes scan inventory instead of rejecting it', async t => {
  for (const modelId of ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']) {
    const requests = [];
    const provider = createAnthropic({ apiKey: 'PRIVATE_TEST_KEY', fetch: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      assert.ok(requests.length <= 3);
      const name = requests.length === 1 ? 'getModelInventory' : requests.length === 2 ? 'getRestorationDesign' : null;
      const records = [
        { type: 'message_start', message: { id: `message-${requests.length}`, role: 'assistant', model: modelId, usage: { input_tokens: 10 } } },
        ...(name ? [
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `read-${requests.length}`, name, input: {} } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
        ] : [
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Current measured component evidence remains provisional.' } },
        ]),
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: name ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      ];
      return new Response(records.map(record => `event: ${record.type}\ndata: ${JSON.stringify(record)}\n\n`).join(''),
        { headers: { 'Content-Type': 'text/event-stream' } });
    } });
    const payload = body(); payload.model = modelId; payload.restoration.mode = 'measurement-follow-up';
    const result = await post(await serve(t, provider(modelId)), payload);
    assert.equal(result.events.at(-1).type, 'done', modelId);
    assert.deepEqual(result.events.filter(event => event.name === 'getModelInventory').map(event => event.state), ['running', 'complete']);
    assert.equal(requests.length, 3);
    assert.equal(requests[0].tool_choice.type, 'auto');
    assert.equal(requests[0].max_tokens, 2500);
    if (modelId.includes('haiku')) assert.equal(requests[0].thinking.type, 'disabled');
    if (modelId.includes('sonnet')) assert.equal(requests[0].thinking.type, 'between_tools');
    if (modelId.includes('opus')) assert.equal(requests[0].output_config.effort, 'low');
    assert.doesNotMatch(JSON.stringify(result.events), /PRIVATE_TEST_KEY/);
  }
});

test('measurement follow-up supplies current measurements before the model can answer or choose a wrong alias', async t => {
  const payload = body(); payload.restoration.mode = 'measurement-follow-up';
  const model = scripted([call('getRestorationDesign', { assemblyId: 'restoration-64' }), finish()], answer());
  const result = await post(await serve(t, model), payload);
  const seed = result.events.find(event => event.name === 'getRestorationDesign' && event.state === 'complete');
  assert.deepEqual(seed.output.assemblies, payload.restoration.snapshot.assemblies);
  const supplied = model.doStreamCalls[0].prompt.filter(message => message.role === 'tool').flatMap(message => message.content)
    .find(part => part.toolName === 'getRestorationDesign');
  assert.deepEqual(supplied.output.value.assemblies, payload.restoration.snapshot.assemblies);
  const unavailable = result.events.find(event => event.name === 'getRestorationDesign' && event.output?.status === 'unavailable');
  assert.deepEqual(unavailable.output.availableAssemblyIds, ['restoration-1', 'restoration-2']);
  assert.match(unavailable.output.reason, /alias/);
  assert.equal(result.events.at(-1).type, 'done');
  assert.deepEqual(handoffs(result), []);
});

test('measurement follow-up rejects an empty inventory without spending a provider request', async t => {
  const payload = body(); payload.restoration.mode = 'measurement-follow-up'; payload.restoration.snapshot = inventory(0);
  const model = scripted();
  const result = await post(await serve(t, model), payload);
  assert.equal(result.events.at(-1).code, 'no-restorations');
  assert.equal(model.doStreamCalls.length, 0); assert.deepEqual(handoffs(result), []);
});

test('an edit continuation receives newly measured context before inspecting scans or requesting a revision', async t => {
  const model = scripted(read(), edit(), [call('getModelInventory'), finish()], answer());
  const url = await serve(t, model), payload = body(); payload.restoration.mode = 'measurement-follow-up';
  const [handoff] = handoffs(await post(url, payload));
  const next = appliedContinuation(payload, handoff);
  const result = await post(url, next);
  assert.equal(result.events.at(-1).type, 'done');
  assert.deepEqual(result.events.filter(event => event.name === 'getModelInventory').map(event => event.state), ['running', 'complete']);
  const supplied = model.doStreamCalls[2].prompt.filter(message => message.role === 'tool').flatMap(message => message.content)
    .find(part => part.toolName === 'getRestorationDesign');
  assert.deepEqual(supplied.output.value.assemblies, next.restoration.snapshot.assemblies);
  assert.deepEqual(handoffs(result), []);
});

test('ordinary edit continuation supplies actual component profile and support rows before an answer', async t => {
  const payload = body(), assembly = payload.restoration.snapshot.assemblies[0];
  assembly.componentDesign = 'nested-support/v1';
  assembly.quality.feedbackRows = [{ id: 'component-support.pilar-enclosure', label: 'Pilar support vertices outside crown', component: 'abutment',
    actual: 0, lower: null, upper: 0, target: 0, exclusiveUpper: false, error: 0, units: 'count', status: 'pass', source: 'quality',
    controls: ['abutment.radius', 'abutment.height', 'crown.width', 'crown.depth', 'crown.height'], feedback: 'Within the emitted support envelope check only.' }];
  const model = scripted(read(), edit(), answer()), url = await serve(t, model);
  const [handoff] = handoffs(await post(url, payload));
  const next = appliedContinuation(payload, handoff), result = await post(url, next);
  assert.equal(result.events.at(-1).type, 'done');
  const seed = model.doStreamCalls[2].prompt.filter(message => message.role === 'tool').flatMap(message => message.content)
    .find(part => part.toolName === 'getRestorationDesign');
  assert.deepEqual(seed.output.value.assemblies, next.restoration.snapshot.assemblies);
  assert.equal(seed.output.value.assemblies[0].componentDesign, 'nested-support/v1');
  assert.equal(seed.output.value.assemblies[0].quality.feedbackRows[0].actual, 0);
  assert.match(system(model.doStreamCalls[2]), /internal clearance is sampled envelope evidence, never actual wall thickness/);
  assert.match(system(model.doStreamCalls[2]), /no edit tool can change componentDesign/);
  assert.equal(model.doStreamCalls.length, 3);
});

test('measured rejection feeds a revised candidate and identical geometry cannot evade it by changing its reason', async t => {
  const payload = body(), duplicate = action(); duplicate.edit.reason = 'A different explanation for exactly the same geometry.';
  const revised = action(); revised.edit.parameters.crown.height = 7;
  revised.edit.parameters.abutment = { radius: .8, emergenceRadius: 1.4 };
  revised.edit.reason = 'Reduce the measured unsupported pilar envelope and remeasure every preserved contact target.';
  const later = action(); later.expectedRevision = revision(11);
  const model = scripted(read(), edit(), edit(duplicate), edit(revised), edit(later), read(), edit());
  const url = await serve(t, model), [first] = handoffs(await post(url, payload));
  const rejected = errorContinuation(payload, first), outcome = rejected.restoration.continuation.result;
  outcome.code = 'rejected'; outcome.message = 'Measured support guardrail rejected this candidate.';
  const rows = [{ id: 'component-support.pilar-enclosure', label: 'Pilar support vertices outside crown', component: 'abutment',
    actual: 12, lower: null, upper: 0, target: 0, exclusiveUpper: false, error: 12, units: 'count', status: 'fail', source: 'quality',
    controls: ['abutment.radius', 'abutment.height', 'crown.width', 'crown.depth', 'crown.height'], feedback: 'Twelve emitted support vertices remain outside the crown envelope.' }];
  outcome.rejectedCandidate = { rows, changes: compareRestorationFeedback(outcome.before.quality.feedbackRows, rows),
    failureFeedback: ['The candidate lost pilar enclosure; preserve all external target contact bands while correcting support.'] };
  const result = await post(url, rejected), [second] = handoffs(result);
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.ok(second, JSON.stringify(result));
  assert.deepEqual(second.request, revised); assert.equal(second.editsUsed, 2);
  const refusal = result.events.find(event => event.name === 'requestRestorationEdit' && event.state === 'complete' && event.output.status === 'error');
  assert.equal(refusal.output.code, 'invalid'); assert.match(refusal.output.message, /already measured and rejected at this revision/);
  const prompt = system(model.doStreamCalls[2]);
  assert.ok(prompt.includes(JSON.stringify(outcome.rejectedCandidate)));
  assert.match(prompt, /Previously measured rejected edits/);
  const seed = model.doStreamCalls[2].prompt.filter(message => message.role === 'tool').flatMap(message => message.content)
    .find(part => part.toolName === 'getRestorationDesign');
  assert.deepEqual(seed.output.value.assemblies, payload.restoration.snapshot.assemblies, 'rejected geometry never replaces current inventory');

  const applied = appliedContinuation(rejected, second), changed = await post(url, applied);
  assert.deepEqual(handoffs(changed)[0].request, later, 'a genuinely changed current revision permits a new measured trial');
  assert.doesNotMatch(system(model.doStreamCalls[4]), /Previously measured rejected edits/);

  // A new user question on the same server is independent of the old session.
  const fresh = await post(url, payload);
  assert.deepEqual(handoffs(fresh)[0].request, action());
  assert.equal(handoffs(fresh)[0].editsUsed, 1);
  assert.doesNotMatch(system(model.doStreamCalls[5]), /Previously measured rejected edits/);
});

test('local tool-choice failures and actual provider status codes have distinct safe diagnostics', async t => {
  const apiError = status => new APICallError({ message: 'PRIVATE_UPSTREAM', url: 'https://private.invalid',
    requestBodyValues: { secret: 'PRIVATE_KEY', case: 'PRIVATE_PATIENT' }, statusCode: status, responseBody: 'PRIVATE_PAYLOAD' });
  const choice = reason => new ToolChoiceViolationError({ toolChoice: { type: 'tool', toolName: 'getRestorationDesign' },
    finishReason: reason, provider: 'anthropic.messages', modelId: DEFAULT_ASSISTANT_MODEL, content: [{ type: 'text', text: 'PRIVATE_PATIENT' }] });
  const cases = [[choice('tool-calls'), 'tool-choice'], [choice('length'), 'output-limit'],
    ...[[401, 'authentication'], [403, 'model-access'], [404, 'model-unavailable'], [400, 'provider-request'], [413, 'provider-request'],
      [408, 'timeout'], [429, 'rate-limit'], [500, 'provider-unavailable']].map(([status, code]) => [apiError(status), code]),
    [new StreamProviderError({ message: 'PRIVATE_STREAM', statusCode: 429, data: { payload: 'PRIVATE_PATIENT' } }), 'rate-limit'],
    [new RetryError({ message: 'PRIVATE_RETRY', reason: 'maxRetriesExceeded', errors: [apiError(429)] }), 'rate-limit']];
  for (const [error, code] of cases) {
    const model = scripted([{ type: 'error', error }, finish('error')]);
    const result = await post(await serve(t, model), body());
    assert.equal(result.events.find(event => event.type === 'error').code, code);
    assert.equal(result.events.some(event => event.type === 'done'), false);
    assert.deepEqual(handoffs(result), []);
    assert.doesNotMatch(JSON.stringify(result.events), /PRIVATE|private\.invalid/);
    if (code === 'tool-choice') assert.doesNotMatch(JSON.stringify(result.events), /API key|quota/);
  }
});

test('measurement follow-up permits four host attempts and removes editing from the fifth final review', async t => {
  const model = scripted(...Array.from({ length: 4 }, () => [read(), edit()]).flat(), read(), answer());
  const url = await serve(t, model);
  let payload = body(); payload.restoration.mode = 'measurement-follow-up';
  for (let count = 1; count <= 4; count++) {
    const result = await post(url, payload);
    const [handoff] = handoffs(result);
    assert.equal(handoff.editsUsed, count);
    const inventory = result.events.find(event => event.name === 'getRestorationDesign' && event.state === 'complete').output;
    assert.equal(inventory.editsRemaining, 5 - count);
    assert.match(system(model.doStreamCalls[(count - 1) * 2]), /at most 4 requested edits/);
    payload = errorContinuation(payload, handoff);
  }
  const result = await post(url, payload);
  assert.equal(result.events.at(-1).type, 'done'); assert.deepEqual(handoffs(result), []);
  assert.equal(result.events.find(event => event.name === 'getRestorationDesign' && event.state === 'complete').output.editsRemaining, 0);
  assert.equal(model.doStreamCalls[8].tools.some(tool => tool.name === 'requestRestorationEdit'), false);
  assert.match(system(model.doStreamCalls[8]), /Host edit budget: 4\/4/);
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
  assert.equal(readOutput.editsRemaining, 7);
  const prompt = system(model.doStreamCalls[2]);
  assert.match(prompt, /Host edit budget: 1\/8/);
  assert.match(prompt, /Validated host edit result/);
  assert.ok(prompt.includes(JSON.stringify(resumed.restoration.continuation.result)));
  assert.deepEqual(model.doStreamCalls[2].prompt.filter(item => item.role === 'user').map(item => item.content[0].text), original.messages.map(item => item.content));
  const count = model.doStreamCalls.length;
  assert.equal((await post(url, resumed)).status, 409);
  assert.equal(model.doStreamCalls.length, count);
});

test('pending edit binds permissions, model, messages, exact action, before, after and other assemblies', async t => {
  const variants = {
    'changed workflow mode': next => { next.restoration.mode = 'measurement-follow-up'; },
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
      assert.match(system(model.doStreamCalls[2]), /Host edit budget: 1\/8/);
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

test('eight requested edits stay capped across view continuations, including host errors; view rounds remain independent', async t => {
  const original = { ...body(), tomography: evidence() };
  const steps = []; let current = design();
  for (let index = 1; index <= 8; index++) {
    steps.push(read(), edit(action(current)));
    if (index !== 2) current = { ...current, editRevision: revision(Number.parseInt(current.editRevision.slice(9), 16) + 10),
      parameters: { ...current.parameters, crown: { ...current.parameters.crown, height: current.parameters.crown.height + 1 } } };
    if (index <= 3) steps.push(read(), view()); // Every edit result first requires a fresh design read.
  }
  steps.push(read(), answer());
  const model = scripted(...steps), url = await serve(t, model); let payload = original; const tokens = new Set();
  for (let index = 1; index <= 8; index++) {
    const result = await post(url, payload); const [editHandoff] = handoffs(result);
    assert.equal(editHandoff.type, 'edit-request'); assert.equal(editHandoff.editsUsed, index);
    assert.equal(tokens.has(editHandoff.continuationToken), false); tokens.add(editHandoff.continuationToken);
    payload = index === 2 ? errorContinuation(payload, editHandoff) : appliedContinuation(payload, editHandoff);
    // Recapturing initial images does not reset either server budget.
    payload.tomography = evidence();
    if (index <= 3) {
      const [viewHandoff] = handoffs(await post(url, payload));
      assert.equal(viewHandoff.type, 'view-request'); assert.equal(viewHandoff.editsUsed, index); assert.equal(viewHandoff.round, index);
      assert.equal(tokens.has(viewHandoff.continuationToken), false); tokens.add(viewHandoff.continuationToken);
      payload = viewContinuation(payload, viewHandoff);
      assert.equal(payload.continuation.viewId, 'view-3');
    }
  }
  const completed = await post(url, payload);
  assert.deepEqual(handoffs(completed), []);
  for (const item of model.doStreamCalls.slice(-2)) {
    assert.equal(item.tools.some(tool => tool.name === 'requestRestorationEdit'), false);
    assert.equal(item.tools.some(tool => tool.name === 'requestTomographyView'), false);
    assert.match(system(item), /Host edit budget: 8\/8.*View budget: 3\/3/);
  }
  assert.equal(completed.events.find(event => event.name === 'getRestorationDesign' && event.state === 'complete').output.editsRemaining, 0);
  assert.equal(model.doStreamCalls.length, 24);
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
    if (variant === 'length' || variant === 'partial-input') assert.ok(result.events.some(event => event.code === 'output-limit'), variant);
    if (variant === 'provider-error') assert.ok(result.events.some(event => event.code === 'provider'), variant);
    if (variant === 'throw') assert.ok(result.events.some(event => event.code === 'request'), variant);
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
