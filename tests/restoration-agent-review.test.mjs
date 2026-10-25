import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { MockLanguageModelV4 } from 'ai/test';
import { simulateReadableStream } from 'ai';
import { createAssistantMiddleware } from '../server/assistant.ts';
import { reviewAndRefineDraft, DRAFT_REFINEMENT_BUDGET } from '../src/restoration-agent-review.ts';
import { buildAssistantSnapshot, assistantSnapshotSchema } from '../src/assistant-context.ts';
import { buildRestorationAssistantSnapshot, createRestorationAssistantTools, restorationAssistantRequestSchema, restorationContinuationSchema } from '../src/restoration-assistant.ts';
import { applyRestorationEdit, restorationEditRevision } from '../src/restoration-edit.ts';
import { RestorationEditRejected } from '../src/restoration-edit-policy.ts';
import { generateRestoration } from '../src/restoration-geometry.ts';
import { evaluateRestorationQuality } from '../src/restoration-quality.ts';
import { fitRestorationToGoals } from '../src/restoration-goal-fitting.ts';
import { emptyToothCase } from '../src/tooth-session.ts';
import { WORKFLOW_BUDGET } from '../src/case-workflow.ts';
import { evidence } from './tomography-fixtures.mjs';

const encoder = new TextEncoder();
const settled = () => new Promise(resolve => setImmediate(resolve));
const spec = () => ({
  version: 'implant-assembly/v1', fdi: 36, parentPartId: 'PRIVATE_SCAN', source: 'PRIVATE_FILE.ply',
  frame: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], up: [0, 0, 1] },
  anatomy: 'molar', provenance: 'hypothesized', units: 'file units (u)',
  parameters: { fixture: { radius: 1, length: 4, depth: .5, taper: .2 },
    abutment: { radius: .8, height: 2, emergenceRadius: 1, angleX: 0, angleY: 0 },
    crown: { width: 4, depth: 5, height: 3, cuspHeight: .4, rotation: 0 } },
});
let serial = 0;
function make(value = spec(), id = 'PRIVATE_ASSEMBLY', measured) {
  const components = measured?.components ?? generateRestoration(value);
  const measurement = { score: 1, objectiveScore: 1, morphologyPenalty: 0, surfaces: [] };
  const fit = measured?.report ?? { before: measurement, after: measurement, status: 'unchanged', limits: [],
    quality: { final: evaluateRestorationQuality({ spec: value, components }) } };
  return { id, spec: value, createdAt: `2026-10-25T00:00:${String(++serial % 60).padStart(2, '0')}.000Z`, warnings: [], fit,
    parts: components.map(mesh => ({ ...mesh, id: `${id}-${mesh.component}`, name: 'PRIVATE_NAME', fileName: 'PRIVATE_FILE.ply',
      role: 'model', visible: true, offset: [0, 0, 0], restoration: { assemblyId: id, component: mesh.component, parentPartId: value.parentPartId } })),
  };
}
const originalPart = () => ({ id: 'PRIVATE_SCAN', name: 'PRIVATE_NAME', fileName: 'PRIVATE_FILE.ply', role: 'lower', visible: true,
  positions: new Float32Array([0, 0, 0, 4, 0, 0, 0, 4, 0]), normals: new Float32Array(9),
  triangles: 1, vertices: 3, dimensions: [4, 4, 0], closed: false, offset: [0, 0, 0] });
const contextFor = (assemblies, source = originalPart()) => ({ parts: [source, ...assemblies.flatMap(assembly => assembly.parts)],
  selected: null, probe: null, report: null, tolerance: .5, analysisState: 'unavailable',
  teeth: emptyToothCase().teeth, counts: {}, fitSummary: [], fitRadius: null });
function setup(assemblies = [make()]) {
  const original = originalPart(), activities = [];
  let source, caseRevision = 'case-original';
  const controller = new AbortController();
  let hostCalls = 0;
  const applyEdit = async (id, edit, revision, signal) => {
    hostCalls++; signal.throwIfAborted();
    const before = source.assemblies.find(assembly => assembly.id === id);
    assert.equal(revision, restorationEditRevision(before));
    const updated = make(applyRestorationEdit(before.spec, edit, 'agent'), id);
    source = { ...source, assemblies: source.assemblies.map(assembly => assembly.id === id ? updated : assembly) };
    return updated;
  };
  source = { assemblies, busy: false, selectedId: assemblies[0]?.id ?? null, sourceRevision: 'original-source', applyEdit };
  const getSnapshot = () => buildAssistantSnapshot(contextFor(source.assemblies, original));
  return {
    input: { snapshot: getSnapshot(), getSnapshot, getSource: () => source, getCaseRevision: () => caseRevision,
      signal: controller.signal, model: 'claude-sonnet-5-5', onActivity: activity => activities.push(activity) },
    activities, controller, original,
    get source() { return source; }, set source(next) { source = next; },
    get hostCalls() { return hostCalls; }, set caseRevision(next) { caseRevision = next; },
  };
}
function response(events, { noNewline = false, splitUtf8 = false } = {}) {
  const bytes = encoder.encode(events.map(event => typeof event === 'string' ? event : JSON.stringify(event)).join('\n') + (noNewline ? '' : '\n'));
  return new Response(new ReadableStream({ start(controller) {
    if (splitUtf8) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    else controller.enqueue(bytes);
    controller.close();
  } }), { headers: { 'Content-Type': 'application/x-ndjson', 'X-Assistant-Model': 'actual-server-model' } });
}
function inventory(payload) {
  const tools = createRestorationAssistantTools(payload.restoration.snapshot, { allowEdits: true });
  return tools.getRestorationDesign.execute({});
}
function handoff(payload, count = 1, edit = { reason: 'Adjust the measured generic crown footprint.', parameters: { crown: { width: 4.2 } } }) {
  const current = payload.restoration.snapshot.assemblies[0];
  const request = { assemblyId: current.id, expectedRevision: current.editRevision, edit };
  const tools = createRestorationAssistantTools(payload.restoration.snapshot, { allowEdits: true, editsUsed: count - 1 });
  const inspected = tools.getRestorationDesign.execute({});
  const output = tools.requestRestorationEdit.execute(request);
  assert.equal(output.status, 'requested', 'Fixture uses real tool/schema revision and prior-read invariants.');
  return [
    { type: 'tool', id: 'design', name: 'getRestorationDesign', state: 'running', input: {} },
    { type: 'tool', id: 'design', name: 'getRestorationDesign', state: 'complete', output: inspected },
    { type: 'text', text: 'A bounded measured concept revision is pending.' },
    { type: 'tool', id: 'edit', name: 'requestRestorationEdit', state: 'running', input: request },
    { type: 'tool', id: 'edit', name: 'requestRestorationEdit', state: 'complete', output },
    { type: 'edit-request', id: 'edit', request, editsUsed: count, continuationToken: count.toString(16).padStart(48, 'a') },
  ];
}
function final(payload) {
  return [
    { type: 'tool', id: 'final-design', name: 'getRestorationDesign', state: 'complete', output: inventory(payload) },
    { type: 'text', text: 'Révision 🦷: remaining clinical evidence is unknown; clinician review is required.' },
    { type: 'done' },
  ];
}
const payloadFor = s => ({ restoration: { snapshot: buildRestorationAssistantSnapshot(s.source.assemblies) } });

test('normal token-sized text fragments do not exhaust the tool-event budget', async () => {
  for (const editFirst of [false, true]) {
    const s = setup(); let calls = 0;
    const text = 'Current measurements remain provisional; clinical evidence is still required. '.repeat(12);
    const result = await reviewAndRefineDraft(s.input, async (_url, options) => {
      const payload = JSON.parse(options.body); calls++;
      const fragments = [...text].map(text => ({ type: 'text', text }));
      return response(editFirst && calls === 1
        ? [...fragments, ...handoff(payload)]
        : [...final(payload).slice(0, 1), ...fragments, { type: 'done' }]);
    });
    assert.equal(result.text, text.trim());
    assert.equal(calls, editFirst ? 2 : 1);
    assert.equal(s.hostCalls, editFirst ? 1 : 0);
  }
});

test('follow-up preserves the selected restoration alias in a multi-concept inventory', async () => {
  const s = setup([make(), make(spec(), 'PRIVATE_SECOND')]);
  s.source = { ...s.source, selectedId: s.source.assemblies[1].id };
  await reviewAndRefineDraft(s.input, async (_url, options) => {
    const payload = JSON.parse(options.body);
    assert.equal(payload.restoration.snapshot.selectedAssemblyId, 'restoration-2');
    assert.equal(inventory(payload).selectedAssemblyId, 'restoration-2');
    return response(final(payload));
  });
  assert.equal(s.hostCalls, 0);
});

test('HTTP and coded stream failures retain actionable private diagnostics in recorded activity', async () => {
  const cases = [
    { build: () => new Response('PRIVATE_HTTP_BODY', { status: 429 }), code: 'http-429', detail: /busy|rate limit/i },
    { build: () => response([{ type: 'error', code: 'output-limit', message: 'PRIVATE_PROVIDER_PAYLOAD' }]), code: 'output-limit', detail: /output limit/i },
    { build: () => response([{ type: 'error', code: 'provider', message: 'PRIVATE_PROVIDER_PAYLOAD' }]), code: 'provider', detail: /response could not be completed/i },
    { build: () => response([{ type: 'error', code: '__proto__', message: 'PRIVATE_PROVIDER_PAYLOAD' }]), code: 'invalid-stream', detail: /incomplete/i },
    { build: () => response([{ type: 'text', text: 'Partial answer.' }]), code: 'invalid-stream', detail: /incomplete/i },
  ];
  for (const { build, code, detail } of cases) {
    const s = setup(), before = s.source.assemblies[0];
    await assert.rejects(reviewAndRefineDraft(s.input, async () => build()), error => {
      assert.equal(error.code, code); assert.match(error.message, detail);
      assert.doesNotMatch(error.message, /PRIVATE/); return true;
    });
    const errors = s.activities.filter(activity => activity.phase === 'error');
    assert.ok(errors.some(activity => activity.name === 'reviewMeasuredRestoration'));
    for (const activity of errors) {
      assert.equal(activity.output.code, code); assert.match(activity.output.message, detail);
      assert.doesNotMatch(JSON.stringify(activity), /PRIVATE/);
    }
    assert.equal(s.source.assemblies[0], before); assert.equal(s.hostCalls, 0);
  }
});

test('the real SDK endpoint supplies measurements, applies a bounded edit and finishes a fragmented answer', async t => {
  const s = setup(), design = buildRestorationAssistantSnapshot(s.source.assemblies).assemblies[0];
  const action = { assemblyId: design.id, expectedRevision: design.editRevision,
    edit: { reason: 'Compare the measured crown footprint.', parameters: { crown: { width: 4.2 } } } };
  const finish = reason => ({ type: 'finish', finishReason: { unified: reason, raw: reason },
    usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } } });
  let callId = 0;
  const call = (toolName, input = {}) => [{ type: 'tool-call', toolCallId: `${toolName}-${++callId}`, toolName, input: JSON.stringify(input) }, finish('tool-calls')];
  const text = 'Current measurements remain provisional. Clinical evidence is still required. '.repeat(3);
  // The endpoint supplies real measurement context before the model requests an
  // edit. Its continuation must supply the freshly committed revision instead.
  const steps = [call('getModelInventory'), call('requestRestorationEdit', action), call('getRestorationDesign'),
    [{ type: 'text-start', id: 'answer' }, ...[...text].map(delta => ({ type: 'text-delta', id: 'answer', delta })),
      { type: 'text-end', id: 'answer' }, finish('stop')]];
  const model = new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({
    chunks: steps.shift(), initialDelayInMs: null, chunkDelayInMs: null,
  }) }) });
  const middleware = createAssistantMiddleware({ languageModel: model });
  const server = createServer((req, res) => void middleware(req, res, () => { res.statusCode = 404; res.end(); }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const result = await reviewAndRefineDraft(s.input, (url, options) => fetch(new URL(url, base), options));
  assert.equal(result.text, text.trim()); assert.equal(s.hostCalls, 1); assert.equal(steps.length, 0);
  assert.deepEqual(model.doStreamCalls[0].toolChoice, { type: 'auto' });
  assert.ok(s.activities.some(activity => activity.name === 'applyAndMeasureRestorationEdit' && activity.output?.status === 'applied'));
  const supplied = index => model.doStreamCalls[index].prompt.filter(message => message.role === 'tool').flatMap(message => message.content)
    .find(part => part.toolName === 'getRestorationDesign').output.value.assemblies[0];
  assert.equal(supplied(0).parameters.crown.width, 4);
  assert.equal(supplied(2).parameters.crown.width, 4.2);
  assert.equal(s.activities.some(activity => activity.name === 'measurementFollowUp' && activity.phase === 'error'), false);
});

test('an actual applied mesh edit is committed before fresh goal measurements and the one-use continuation are sent', async () => {
  const initial = await fitRestorationToGoals({ spec: spec(), surfaces: [], options: { maxCandidates: 1, samplesPerSurface: 16 } });
  const s = setup([make(initial.spec, 'PRIVATE_ASSEMBLY', initial)]), before = s.source.assemblies[0];
  const initialSnapshot = s.input.snapshot;
  initialSnapshot.analysisState = 'ready';
  initialSnapshot.collision = { scope: 'complete visible non-reference scans', durationMs: 2,
    comparedPartIds: initialSnapshot.parts.map(part => part.id), pairs: [] };
  s.input.tomography = evidence(1);
  // An intentionally stale aggregate collision report remains in the getter; the loop must clear it.
  s.input.getSnapshot = () => ({ ...buildAssistantSnapshot(contextFor(s.source.assemblies, s.original)), analysisState: 'ready', collision: initialSnapshot.collision });
  s.source = { ...s.source, applyEdit: async (id, edit, revision, signal) => {
    assert.equal(revision, restorationEditRevision(before)); signal.throwIfAborted();
    const updatedSpec = applyRestorationEdit(before.spec, edit, 'agent');
    const measured = await fitRestorationToGoals({ spec: updatedSpec, surfaces: [], goalContract: before.fit.goal, options: { maxCandidates: 1, samplesPerSurface: 16 } });
    const updated = make(measured.spec, id, measured);
    setTimeout(() => { s.source = { ...s.source, assemblies: [updated] }; }, 25);
    return updated;
  } };
  const calls = [];
  const result = await reviewAndRefineDraft(s.input, async (url, options) => {
    assert.equal(url, '/api/assistant/chat'); assert.equal(options.signal, s.controller.signal);
    const payload = JSON.parse(options.body); calls.push(payload);
    assert.deepEqual(assistantSnapshotSchema.parse(payload.snapshot), payload.snapshot);
    assert.deepEqual(restorationAssistantRequestSchema.parse(payload.restoration), payload.restoration);
    assert.doesNotMatch(options.body, /PRIVATE_|"positions"|"normals"|"note"/);
    if (calls.length === 1) {
      assert.equal(payload.restoration.snapshot.assemblies[0].goal.after.rows.length, before.fit.goal.after.rows.length);
      assert.equal(payload.tomography.canRequestViews, false);
      assert.match(payload.messages[0].content, /REQUIRED.*contacts/);
      assert.match(payload.messages[0].content, /1\.5 mm.*UNKNOWN/);
      assert.match(payload.messages[0].content, /FIVE provider requests/);
      return response(handoff(payload));
    }
    const current = buildRestorationAssistantSnapshot(s.source.assemblies, s.source.selectedId);
    assert.notEqual(s.source.assemblies[0], before, 'React committed the exact returned assembly before another fetch.');
    assert.deepEqual(payload.restoration.snapshot, current);
    assert.deepEqual(payload.messages, calls[0].messages, 'Server continuation messages cannot change.');
    const continuation = restorationContinuationSchema.parse(payload.restoration.continuation);
    assert.equal(continuation.result.status, 'applied');
    assert.deepEqual(continuation.result.after, current.assemblies[0]);
    assert.equal(payload.snapshot.collision, null); assert.equal(payload.snapshot.analysisState, 'unavailable');
    assert.equal(payload.snapshot.parts[3].dimensions[0], s.source.assemblies[0].parts[2].dimensions[0]);
    assert.equal('tomography' in payload, false, 'Old rendered generated geometry is never reused.');
    return response(final(payload), { splitUtf8: true });
  });
  assert.equal(calls.length, 2); assert.equal(result.model, 'actual-server-model');
  assert.match(result.text, /Révision 🦷/);
  assert.equal(before.spec.parameters.crown.width, 4); assert.equal(s.source.assemblies[0].spec.parameters.crown.width, 4.2);
  const host = s.activities.filter(activity => activity.name === 'applyAndMeasureRestorationEdit');
  assert.deepEqual(host.map(activity => activity.phase), ['running', 'complete']);
  assert.equal(host[1].output.status, 'applied'); assert.ok(host[1].durationMs >= 0);
  assert.ok(s.activities.some(activity => activity.name === 'requestRestorationEdit' && activity.output?.applied === false));
  assert.equal(s.input.tomography.canRequestViews, true, 'Caller evidence is unchanged.');
});

test('a measured host rejection counts as an edit and returns fresh retained inventory and rejected measurements', async () => {
  const s = setup(), before = s.source.assemblies[0];
  s.source = { ...s.source, applyEdit: async () => { throw new RestorationEditRejected(['Required contact regressed.'], {
    quality: before.fit.quality.final, parameters: before.spec.parameters, measurement: before.fit.after,
  }); } };
  let calls = 0;
  const result = await reviewAndRefineDraft(s.input, async (_url, options) => {
    const payload = JSON.parse(options.body);
    if (++calls === 1) return response(handoff(payload));
    assert.equal(payload.restoration.continuation.result.code, 'rejected');
    assert.ok(payload.restoration.continuation.result.rejectedCandidate.rows.length);
    assert.deepEqual(payload.restoration.snapshot, buildRestorationAssistantSnapshot([before], s.source.selectedId));
    return response(final(payload));
  });
  assert.equal(calls, 2); assert.equal(s.source.assemblies[0], before); assert.ok(result.text);
  assert.ok(s.activities.some(activity => activity.name === 'applyAndMeasureRestorationEdit' && activity.phase === 'error' && activity.output.code === 'rejected'));
});

test('incomplete, errored, ambiguous, mismatched and postterminal handoffs never apply a queued edit', async () => {
  const original = make();
  const variants = [
    events => events.slice(0, -1),
    events => [...events, { type: 'done' }],
    events => [...events, { type: 'error', message: 'PRIVATE_PROVIDER' }],
    events => [...events, events.at(-1)],
    events => [...events, { type: 'text', text: 'After terminal.' }],
    events => [...events.slice(0, -1), { ...events.at(-1), editsUsed: 2 }],
    events => [...events.slice(0, -1), { ...events.at(-1), continuationToken: 'bad' }],
    events => [...events.slice(0, -1), { ...events.at(-1), id: 'other-tool' }],
    events => [...events.slice(0, -1), { ...events.at(-1), request: { ...events.at(-1).request, edit: { reason: 'Mismatched', contour: { cervicalScale: .9 } } } }],
    events => [...events.slice(0, -2), events.at(-1)],
    events => [...events.slice(0, -1), { type: 'done' }],
    events => [...events.slice(0, -1), { type: 'tool', id: 'extra', name: 'requestRestorationEdit', state: 'complete', output: events.at(-2).output }, events.at(-1)],
    events => [...events.slice(0, -1), { type: 'tool', id: 'unfinished', name: 'getModelInventory', state: 'running' }, events.at(-1)],
    events => [...events.slice(0, -1), { type: 'tool', id: 'failed', name: 'getModelInventory', state: 'error' }, events.at(-1)],
    events => [...events.slice(0, -1), { type: 'view-request', id: 'view', round: 1, spec: {} }],
    events => [...events, '{PRIVATE malformed'],
  ];
  for (const mutate of variants) {
    const s = setup([original]); let calls = 0;
    await assert.rejects(reviewAndRefineDraft(s.input, async (_url, options) => {
      calls++; return response(mutate(handoff(JSON.parse(options.body))));
    }), error => { assert.doesNotMatch(error.message, /PRIVATE|Mismatched|After terminal/); return true; });
    assert.equal(s.hostCalls, 0); assert.equal(calls, 1); assert.equal(s.source.assemblies[0], original);
  }
  const s = setup([original]);
  await assert.rejects(reviewAndRefineDraft(s.input, async () => response(handoff(payloadFor(s)), { noNewline: true })), /incomplete/);
  assert.equal(s.hostCalls, 0);
});

test('clean EOF is required after a handoff; disconnect and abort discard pending actions and cancel stalled readers', async () => {
  for (const failure of ['disconnect', 'abort']) {
    const s = setup(); let streamController, cancelled = false;
    const body = new ReadableStream({ start(controller) { streamController = controller; }, cancel() { cancelled = true; } });
    const pending = reviewAndRefineDraft(s.input, async (_url, options) => {
      streamController.enqueue(encoder.encode(handoff(JSON.parse(options.body)).map(event => JSON.stringify(event)).join('\n') + '\n'));
      return new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } });
    });
    await settled(); assert.equal(s.hostCalls, 0);
    if (failure === 'disconnect') streamController.error(new Error('PRIVATE_DISCONNECT'));
    else s.controller.abort();
    await assert.rejects(pending, failure === 'abort' ? { name: 'AbortError' } : /incomplete/);
    assert.equal(s.hostCalls, 0); if (failure === 'abort') assert.equal(cancelled, true);
  }
});

test('stale source, case, missing source and unrelated assembly changes cannot be continued or blessed', async () => {
  for (const change of [
    s => { s.source = { ...s.source, sourceRevision: 'changed-source' }; },
    s => { s.caseRevision = 'changed-annotation-or-pose'; },
    s => { s.input.getSource = () => undefined; },
    s => { s.source = { ...s.source, assemblies: [s.source.assemblies[0], { ...s.source.assemblies[1] }] }; },
  ]) {
    const s = setup([make(), make(spec(), 'PRIVATE_OTHER')]); let calls = 0;
    await assert.rejects(reviewAndRefineDraft(s.input, async (_url, options) => {
      calls++; const events = handoff(JSON.parse(options.body)); change(s); return response(events);
    }), /changed/);
    assert.equal(calls, 1); assert.equal(s.hostCalls, 0);
  }
  for (const transition of ['unrelated', 'unexpected-target', 'source-revision', 'different-parent', 'unrequested-values', 'mutated-other', 'mutated-source-frame']) {
    const s = setup([make(), make(spec(), 'PRIVATE_OTHER')]); let calls = 0;
    s.source = { ...s.source, applyEdit: async (id, edit) => {
      const updated = make(applyRestorationEdit(s.source.assemblies[0].spec, edit, 'agent'), id);
      if (transition === 'different-parent') updated.spec.parentPartId = 'UNEXPECTED_SOURCE';
      if (transition === 'unrequested-values') updated.spec.parameters.abutment.height += .1;
      if (transition === 'mutated-other') s.source.assemblies[1].spec.frame.origin[0] = 1;
      if (transition === 'mutated-source-frame') { s.source.assemblies[0].spec.frame.origin[0] = 1; updated.spec.frame.origin[0] = 1; }
      s.source = { ...s.source, sourceRevision: transition === 'source-revision' ? 'changed' : s.source.sourceRevision,
        assemblies: [transition === 'unexpected-target' ? { ...updated } : updated,
          transition === 'unrelated' ? { ...s.source.assemblies[1] } : s.source.assemblies[1]] };
      return updated;
    } };
    await assert.rejects(reviewAndRefineDraft(s.input, async (_url, options) => { calls++; return response(handoff(JSON.parse(options.body))); }), /changed/);
    assert.equal(calls, 1, 'Never continue after a different assembly/source transition.');
  }
});

test('an uncommitted own edit times out after the bounded five-second React wait', async t => {
  const s = setup(); let now = 0, calls = 0;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(performance, 'now', () => now);
  s.source = { ...s.source, applyEdit: async (id, edit) => make(applyRestorationEdit(s.source.assemblies[0].spec, edit, 'agent'), id) };
  const pending = reviewAndRefineDraft(s.input, async (_url, options) => { calls++; return response(handoff(JSON.parse(options.body))); });
  await settled(); assert.equal(calls, 1);
  now = DRAFT_REFINEMENT_BUDGET.commitMs + 1; t.mock.timers.tick(16);
  await assert.rejects(pending, /changed/); assert.equal(calls, 1);
});

test('a reused continuation token is rejected without applying or retrying a second action', async () => {
  const s = setup(); let calls = 0;
  s.source = { ...s.source, applyEdit: async () => { throw new Error('Host failed.'); } };
  await assert.rejects(reviewAndRefineDraft(s.input, async (_url, options) => {
    const payload = JSON.parse(options.body); calls++;
    const events = handoff(payload, calls, { reason: 'Measured generic footprint.', parameters: { crown: { width: 4 + calls / 10 } } });
    events.at(-1).continuationToken = 'a'.repeat(47) + '1';
    return response(events);
  }), /incomplete/);
  assert.equal(calls, 2);
});

test('unexpected HTTP, UTF-8, oversized records, partial finals and tool errors fail privately with no geometry edit', async () => {
  for (const build of [
    () => new Response('PRIVATE_RESPONSE', { status: 500 }),
    () => new Response('PRIVATE_RESPONSE', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response(null, { headers: { 'Content-Type': 'application/x-ndjson' } }),
    () => { throw new Error('PRIVATE_FETCH'); },
    () => response([{ type: 'text', text: 'x'.repeat(16001) }, { type: 'done' }]),
    () => response([{ type: 'text', text: 'Partial' }]),
    () => response([{ type: 'text', text: ' ' }, { type: 'done' }]),
    () => response([{ type: 'text', text: 'Partial' }, { type: 'done', continuationToken: 'invalid' }]),
    () => new Response(new Uint8Array([0xff, 10]), { headers: { 'Content-Type': 'application/x-ndjson' } }),
  ]) {
    const s = setup();
    await assert.rejects(reviewAndRefineDraft(s.input, async () => build()), error => { assert.doesNotMatch(error.message, /PRIVATE/); return true; });
    assert.equal(s.hostCalls, 0);
  }
  const s = setup(); let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(encoder.encode('x'.repeat(1024 * 1024 + 1))); }, cancel() { cancelled = true; } });
  await assert.rejects(reviewAndRefineDraft(s.input, async () => new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } })), /incomplete/);
  assert.equal(cancelled, true);
  const failed = setup();
  await assert.rejects(reviewAndRefineDraft(failed.input, async () => response([
    { type: 'tool', id: 'failed', name: 'getRestorationDesign', state: 'running', input: {} },
    { type: 'tool', id: 'failed', name: 'getRestorationDesign', state: 'error' },
  ])), /incomplete/);
  assert.ok(failed.activities.some(activity => activity.name === 'getRestorationDesign' && activity.phase === 'error' && activity.durationMs >= 0));
});

test('cancelled in-flight host work and cancelled commit waits never request another provider round', async () => {
  for (const commitFirst of [false, true]) {
    const s = setup(); let release, calls = 0;
    s.source = { ...s.source, applyEdit: (id, edit) => new Promise(resolve => {
      const updated = make(applyRestorationEdit(s.source.assemblies[0].spec, edit, 'agent'), id);
      release = () => resolve(updated);
      if (commitFirst) release();
    }) };
    const pending = reviewAndRefineDraft(s.input, async (_url, options) => { calls++; return response(handoff(JSON.parse(options.body))); });
    await settled(); assert.ok(release); s.controller.abort(); release();
    await assert.rejects(pending, { name: 'AbortError' }); assert.equal(calls, 1);
  }
  const s = setup(); s.controller.abort();
  await assert.rejects(reviewAndRefineDraft(s.input, async () => assert.fail('No aborted fetch.')), { name: 'AbortError' });
});

test('duplicate and unchanged requests consume the four-attempt budget without rerunning the host', async () => {
  const s = setup(); let calls = 0, hostCalls = 0;
  s.source = { ...s.source, applyEdit: async () => { hostCalls++; throw new Error('PRIVATE_WORKER_FAILURE'); } };
  const widths = [4.2, 4.2, 4, 4.3];
  const result = await reviewAndRefineDraft(s.input, async (_url, options) => {
    const payload = JSON.parse(options.body); calls++;
    if (calls > 1) {
      assert.equal(payload.restoration.continuation.result.status, 'error');
      assert.equal(payload.restoration.continuation.result.code, calls === 3 || calls === 4 ? 'invalid' : 'failed');
      assert.deepEqual(payload.restoration.snapshot, buildRestorationAssistantSnapshot(s.source.assemblies, s.source.selectedId));
    }
    if (calls === 5) return response(final(payload));
    return response(handoff(payload, calls, { parameters: { crown: { width: widths[calls - 1] }, ...(calls === 2 ? { fixture: {} } : {}) },
      ...(calls === 2 ? { contour: { cervicalScale: 1 } } : {}), reason: `Measured attempt ${calls}.` }));
  });
  assert.ok(result.text); assert.equal(calls, 5); assert.equal(hostCalls, 2);
  assert.equal(s.source.assemblies[0].spec.parameters.crown.width, 4);
  assert.equal(DRAFT_REFINEMENT_BUDGET.providerRequests + 1, WORKFLOW_BUDGET.providerRequests);
});

test('a fifth handoff is never applied or retried; four completed edits remain visible and incomplete', async () => {
  const s = setup(); let calls = 0;
  await assert.rejects(reviewAndRefineDraft(s.input, async (_url, options) => {
    const payload = JSON.parse(options.body); calls++;
    return response(handoff(payload, calls, { reason: 'Bounded footprint measurement.', parameters: { crown: { width: 4 + calls / 10 } } }));
  }), /bounded budget/);
  assert.equal(calls, 5); assert.equal(s.hostCalls, 4); assert.equal(s.source.assemblies[0].spec.parameters.crown.width, 4.4);
  assert.ok(s.activities.some(activity => activity.name === 'measurementFollowUp' && activity.output.status === 'budget'));
});

test('a failed final provider response retains the actual applied geometry and exposes incomplete activity', async () => {
  const s = setup(); let calls = 0;
  await assert.rejects(reviewAndRefineDraft(s.input, async (_url, options) => {
    if (++calls === 1) return response(handoff(JSON.parse(options.body)));
    return response([{ type: 'text', text: 'PRIVATE_PARTIAL' }]);
  }), /incomplete/);
  assert.equal(s.source.assemblies[0].spec.parameters.crown.width, 4.2);
  assert.ok(s.activities.some(activity => activity.name === 'applyAndMeasureRestorationEdit' && activity.output?.status === 'applied'));
  assert.equal(s.activities.at(-1).phase, 'error');
});

// Exercise the real hook, real refinement loop and schemas; replace only React's host.
const moduleUrl = new URL('../src/useDraftReview.ts?agent-review-tests', import.meta.url).href;
const react = `data:text/javascript,${encodeURIComponent(['useState', 'useRef', 'useEffect'].map(name => `export const ${name} = (...args) => globalThis.__draftReviewHooks.${name}(...args);`).join('\n'))}`;
const loader = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === moduleUrl) {
    if (specifier === 'react') return { url: react, shortCircuit: true };
    if (specifier.startsWith('./')) return next(new URL(`${specifier}.ts`, moduleUrl).href, context);
  }
  return next(specifier, context);
} });
let useDraftReview;
try { ({ useDraftReview } = await import(moduleUrl)); } finally { loader.deregister(); }
function hookHost(initial) {
  const slots = []; let input = initial, cursor = 0, dirty = false, pending = [], view;
  const changed = (a, b) => !a || a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]));
  const hooks = {
    useState(initial) {
      const i = cursor++; if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[i].value, value => {
        const next = typeof value === 'function' ? value(slots[i].value) : value;
        if (!Object.is(next, slots[i].value)) { slots[i].value = next; dirty = true; }
      }];
    },
    useRef(initial) { return slots[cursor++] ??= { current: initial }; },
    useEffect(effect, deps) {
      const i = cursor++, previous = slots[i];
      if (changed(previous?.deps, deps)) {
        const slot = { deps, cleanup: previous?.cleanup }; slots[i] = slot;
        pending.push(() => { slot.cleanup?.(); slot.cleanup = effect(); });
      }
    },
  };
  return {
    render(next = {}) {
      input = { ...input, ...next };
      for (let pass = 0; pass < 30; pass++) {
        globalThis.__draftReviewHooks = hooks; cursor = 0; dirty = false;
        view = useDraftReview(input); const queued = pending; pending = []; queued.forEach(effect => effect());
        if (!dirty) return view;
      }
      throw new Error('Review hook did not settle.');
    },
    get view() { return view; }, dispose() { slots.forEach(slot => slot.cleanup?.()); },
  };
}
function hookSetup(t, restoration = false, assemblies) {
  const s = setup(assemblies), completed = [], errors = [], requests = [];
  const host = hookHost({ runKey: 'run-one', enabled: true, ready: true, model: s.input.model,
    context: contextFor(s.source.assemblies, s.original), assemblies: s.source.assemblies,
    ...(restoration ? { restoration: s.source } : {}),
    shareTomography: false, tomographyBasis: 'tomography-one', onComplete: (...args) => completed.push(args), onError: (...args) => errors.push(args),
  });
  const saved = Object.getOwnPropertyDescriptor(globalThis, '__draftReviewHooks');
  t.after(() => { host.dispose(); if (saved) Object.defineProperty(globalThis, '__draftReviewHooks', saved); else delete globalThis.__draftReviewHooks; });
  t.mock.method(globalThis, 'fetch', (url, options) => new Promise(resolve => requests.push({ url, signal: options.signal, payload: JSON.parse(options.body), resolve })));
  return { s, host, requests, completed, errors };
}
async function flush(host, passes = 5) { for (let i = 0; i < passes; i++) { await settled(); host.render(); } }

test('a workflow with no constructed concepts reviews case evidence without requesting restoration measurements', async t => {
  const { host, requests, completed, errors } = hookSetup(t, true, []);
  host.render();
  assert.equal(requests.length, 1);
  assert.equal('restoration' in requests[0].payload, false);
  assert.match(requests[0].payload.messages[0].content, /No current restoration concepts were constructed/);
  requests[0].resolve(response([
    { type: 'tool', id: 'inventory', name: 'getModelInventory', state: 'complete', output: { status: 'available' } },
    { type: 'text', text: 'No restoration concepts were constructed; review the unresolved case evidence.' }, { type: 'done' },
  ]));
  await flush(host);
  assert.equal(host.view.status, 'complete'); assert.equal(completed.length, 1); assert.equal(errors.length, 0);
  assert.match(host.view.result.text, /No restoration concepts were constructed/);
});

test('direct measurement follow-up with an empty inventory stops before making a provider request', async () => {
  const s = setup([]); let calls = 0;
  await assert.rejects(reviewAndRefineDraft(s.input, async () => { calls++; throw new Error('Must not request measurements.'); }),
    error => error.code === 'no-restorations');
  assert.equal(calls, 0); assert.equal(s.hostCalls, 0);
});

test('legacy readonly lifecycle still waits for readiness, cancels and never repeats the same workflow attempt', async t => {
  const { host, requests, completed } = hookSetup(t);
  assert.equal(host.render({ ready: false }).status, 'idle'); assert.equal(requests.length, 0);
  assert.equal(host.render({ ready: true }).status, 'running'); assert.equal(requests.length, 1);
  assert.equal('restoration' in requests[0].payload, false);
  assert.equal(host.render({ ready: false }).status, 'cancelled'); assert.equal(requests[0].signal.aborted, true);
  requests[0].resolve(response([{ type: 'text', text: 'Late review.' }, { type: 'done' }]));
  await flush(host); host.render({ ready: true });
  assert.equal(requests.length, 1); assert.equal(completed.length, 0); assert.deepEqual(host.view.activity, []);
  host.render({ runKey: 'run-two' }); assert.equal(requests.length, 2);
  requests[1].resolve(response([{ type: 'text', text: 'Fresh readonly review.' }, { type: 'done' }]));
  await flush(host); assert.equal(host.view.status, 'complete'); assert.equal(completed.length, 1);
});

test('legacy readonly basis changes invalidate completed or in-flight evidence without another request', async t => {
  const { s, host, requests, completed } = hookSetup(t);
  host.render(); requests[0].resolve(response([{ type: 'text', text: 'Readonly review.' }, { type: 'done' }]));
  await flush(host); assert.equal(host.view.status, 'complete');
  host.render({ context: { ...contextFor(s.source.assemblies, s.original), tolerance: .7 } });
  assert.equal(host.view.status, 'stale'); assert.equal(host.view.result, null); assert.equal(requests.length, 1); assert.equal(completed.length, 1);
});

test('reopening an earlier snapshot of the same run drops later live follow-up evidence', async t => {
  const { host, requests, completed } = hookSetup(t, true);
  host.render();
  requests[0].resolve(response(final(requests[0].payload)));
  await flush(host);
  assert.equal(host.view.status, 'complete');
  assert.ok(host.view.activity.length);
  assert.equal(completed.length, 1);
  // Reopen pauses the workflow before replacing its saved state, even if its ID matches.
  const paused = host.render({ enabled: false });
  paused.reset();
  const reopened = host.render({ runKey: 'run-one', enabled: false });
  assert.equal(reopened.status, 'idle');
  assert.equal(reopened.result, null);
  assert.deepEqual(reopened.activity, [], 'App must fall back to the earlier saved trace, including an empty one');
  assert.equal(requests.length, 1, 'reopening must not make another provider request');
});

test('restore reset aborts an in-flight same-run review and ignores its late result', async t => {
  const { host, requests, completed, errors } = hookSetup(t, true);
  const running = host.render();
  running.reset();
  host.render({ enabled: false });
  assert.equal(requests[0].signal.aborted, true);
  requests[0].resolve(response(final(requests[0].payload)));
  await flush(host);
  assert.deepEqual(host.view.activity, []);
  assert.equal(host.view.result, null);
  assert.equal(completed.length, 0); assert.equal(errors.length, 0);
});

test('hook uses latest source/callback and survives its own busy/ready=false and exact committed assembly transition', async t => {
  const { s, host, requests, completed, errors } = hookSetup(t, true);
  host.render(); let latestCalls = 0, obsoleteCalls = 0, commit;
  s.source = { ...s.source, applyEdit: async (id, edit, revision, signal) => {
    latestCalls++; signal.throwIfAborted(); const before = s.source.assemblies[0];
    assert.equal(revision, restorationEditRevision(before));
    // The render during the worker must not cancel itself because ready=false.
    host.render({ ready: false, restoration: { ...s.source, busy: true } });
    const updated = make(applyRestorationEdit(before.spec, edit, 'agent'), id);
    commit = () => {
      s.source = { ...s.source, assemblies: [updated], busy: false };
      host.render({ restoration: s.source, assemblies: s.source.assemblies, context: contextFor(s.source.assemblies, s.original), ready: false });
    };
    return updated;
  } };
  // Source wrappers change every render; an earlier apply callback must not be retained.
  host.render({ restoration: { ...s.source, applyEdit: () => { obsoleteCalls++; throw new Error('Obsolete host callback.'); } } });
  host.render({ restoration: { ...s.source } });
  requests[0].resolve(response(handoff(requests[0].payload)));
  await flush(host); assert.equal(latestCalls, 1); assert.equal(obsoleteCalls, 0);
  assert.equal(requests[0].signal.aborted, false); assert.equal(host.view.status, 'running'); assert.equal(requests.length, 1);
  commit();
  await new Promise(resolve => setTimeout(resolve, 50)); await flush(host);
  assert.equal(requests.length, 2); assert.equal(requests[1].payload.restoration.continuation.result.status, 'applied');
  assert.equal(requests[1].payload.restoration.snapshot.assemblies[0].parameters.crown.width, 4.2);
  requests[1].resolve(response(final(requests[1].payload))); await flush(host);
  assert.equal(host.view.status, 'complete'); assert.equal(completed.length, 1); assert.equal(errors.length, 0);
  assert.ok(host.view.activity.some(activity => activity.name === 'applyAndMeasureRestorationEdit' && activity.phase === 'complete'));
  assert.equal(host.render({ enabled: false }).status, 'complete');
  // A subsequent manual comparison, even a cloned inventory, invalidates the saved review.
  host.render({ restoration: { ...s.source, assemblies: [{ ...s.source.assemblies[0] }] } });
  assert.equal(host.view.status, 'stale'); assert.equal(requests.length, 2);
});

test('hook aborts changed original buffers, annotation and tomography bases while refinement is running', async t => {
  const { s, host, requests, completed } = hookSetup(t, true);
  host.render();
  const replaced = { ...s.original, positions: s.original.positions.slice() };
  host.render({ context: contextFor(s.source.assemblies, replaced) });
  assert.equal(host.view.status, 'stale'); assert.equal(requests[0].signal.aborted, true);
  requests[0].resolve(response(handoff(requests[0].payload))); await flush(host);
  assert.equal(s.hostCalls, 0); assert.equal(completed.length, 0); assert.equal(requests.length, 1);
  host.render({ runKey: 'run-two' }); assert.equal(requests.length, 2);
  host.render({ tomographyBasis: 'changed-registration' }); assert.equal(host.view.status, 'stale'); assert.equal(requests[1].signal.aborted, true);
  requests[1].resolve(response(handoff(requests[1].payload))); await flush(host);
  host.render({ runKey: 'run-three' }); assert.equal(requests.length, 3);
  const context = contextFor(s.source.assemblies, replaced); context.teeth[36] = { ...context.teeth[36], status: 'missing' };
  host.render({ context }); assert.equal(host.view.status, 'stale'); assert.equal(requests[2].signal.aborted, true);
  requests[2].resolve(response(handoff(requests[2].payload))); await flush(host);
  assert.equal(completed.length, 0);
});
