import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewDraft } from '../src/draft-review.ts';
import { assistantSnapshotSchema, buildAssistantSnapshot } from '../src/assistant-context.ts';
import { emptyToothCase } from '../src/tooth-session.ts';
import { evidence } from './tomography-fixtures.mjs';

function snapshot() {
  const result = buildAssistantSnapshot({ parts: [], selected: null, probe: null, report: null, tolerance: 0.5, analysisState: 'unavailable', teeth: emptyToothCase().teeth, counts: {}, fitSummary: [], fitRadius: null });
  result.parts = Array.from({ length: 3 }, (_, i) => ({
    id: `scan-${i + 1}`, role: 'model', visible: true, closed: false, triangles: 12, vertices: 8,
    dimensions: [1, 2, 3], dimensionsBasis: 'original file-axis bounds', offset: [0, 0, 0],
    rotationDegrees: [0, 0, 0], hasSavedBitePose: false, hasManualMovement: false,
  }));
  return assistantSnapshotSchema.parse(result);
}
const concept = () => ({
  fdi: 36, components: [{ id: 'scan-1', kind: 'fixture' }, { id: 'scan-2', kind: 'abutment' }, { id: 'scan-3', kind: 'crown' }],
  beforeScore: 2.5, afterScore: 1.5, fitStatus: 'improved', limits: ['Sampled distances do not establish clinical clearance.'],
});
const input = (changes = {}) => ({ snapshot: snapshot(), model: 'claude-sonnet-5-5', concepts: [concept()], signal: new AbortController().signal, ...changes });
const text = value => ({ type: 'text', text: value });
const done = { type: 'done' };
const encoder = new TextEncoder();
function response(events = [text('Review pending clinician assessment.'), done], options = {}) {
  const serialized = events.map(event => typeof event === 'string' ? event : JSON.stringify(event)).join('\n') + (options.noNewline ? '' : '\n');
  const bytes = encoder.encode(serialized);
  return new Response(new ReadableStream({ start(controller) {
    if (options.splitUtf8) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    else controller.enqueue(bytes);
    controller.close();
  } }), { status: options.status ?? 200, headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', ...options.headers } });
}
const summaryFrom = payload => JSON.parse(payload.messages[0].content.split('Draft summary:\n')[1]);

test('sends one bounded user message and only known anonymous metadata without reading private fields', async () => {
  const request = input({ tomography: evidence(1) });
  const forbidden = () => assert.fail('Private local fields must never be read');
  for (const object of [request, request.snapshot, request.snapshot.parts[0], request.snapshot.teeth[0], request.concepts[0], request.concepts[0].components[0]]) {
    for (const key of ['fileName', 'positions', 'normals', 'spec', 'source', 'toJSON']) Object.defineProperty(object, key, { get: forbidden, enumerable: true });
  }
  request.snapshot.notesIncluded = true;
  Object.defineProperty(request.snapshot.teeth[0], 'note', { get: forbidden, enumerable: true });
  Object.defineProperty(request.concepts[0], 'notes', { get: forbidden, enumerable: true });
  let calls = 0;
  const result = await reviewDraft(request, async (url, options) => {
    calls++;
    assert.equal(url, '/api/assistant/chat');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.equal(options.signal, request.signal);
    const payload = JSON.parse(options.body);
    assert.deepEqual(Object.keys(payload).sort(), ['messages', 'model', 'snapshot', 'tomography']);
    assert.equal(payload.messages.length, 1);
    assert.equal(payload.messages[0].role, 'user');
    assert.ok(payload.messages[0].content.length <= 8000);
    assert.equal(payload.model, request.model);
    assert.equal(payload.snapshot.notesIncluded, false);
    assert.ok(payload.snapshot.teeth.every(tooth => !Object.hasOwn(tooth, 'note')));
    assert.deepEqual(assistantSnapshotSchema.parse(payload.snapshot), payload.snapshot);
    assert.deepEqual(summaryFrom(payload).concepts[0].components, concept().components);
    assert.equal(payload.tomography.canRequestViews, false);
    assert.equal(request.tomography.canRequestViews, true, 'caller evidence is unchanged');
    assert.match(payload.messages[0].content, /read-only tools.*CURRENT surface evidence/);
    assert.match(payload.messages[0].content, /crossings\/intersections/);
    assert.match(payload.messages[0].content, /CBCT registration uncertainty/);
    assert.match(payload.messages[0].content, /clinician review requirements/);
    assert.match(payload.messages[0].content, /not exact contact area or overlap volume/);
    assert.doesNotMatch(options.body, /fileName|positions|normals|"note"|"notes"|toJSON/);
    return response();
  });
  assert.equal(calls, 1);
  assert.ok(result.text);
});

test('bounds escaped summary, concepts, component fields and per-site limits after formatting', async () => {
  const concepts = Array.from({ length: 40 }, (_, i) => ({
    ...concept(), fdi: 11 + i,
    components: Array.from({ length: 20 }, (_, i) => ({ id: `scan-${i + 1}`, kind: '\\"\n'.repeat(100) })),
    fitStatus: 'status'.repeat(100), limits: Array(4).fill('\\"\n'.repeat(300)),
  }));
  await reviewDraft(input({ concepts }), async (_url, options) => {
    const payload = JSON.parse(options.body), message = payload.messages[0].content;
    const rawSummary = message.split('Draft summary:\n')[1], summary = JSON.parse(rawSummary);
    assert.ok(message.length <= 8000);
    assert.ok(rawSummary.length <= 5000);
    assert.ok(summary.concepts.length > 0 && summary.concepts.length <= 16);
    assert.equal(summary.omittedConcepts, concepts.length - summary.concepts.length);
    for (const site of summary.concepts) {
      assert.ok(site.components.length <= 8);
      assert.equal(site.omittedComponents, 12);
      assert.ok(site.components.every(component => component.kind.length <= 40));
      assert.ok(site.fitStatus.length <= 80);
      assert.ok(site.limits.length <= 3 && site.limits.every(limit => limit.length <= 160));
    }
    return response();
  });
  await reviewDraft(input({ concepts: Array.from({ length: 17 }, () => ({ ...concept(), components: [], limits: [] })) }), async (_url, options) => {
    const summary = summaryFrom(JSON.parse(options.body));
    assert.equal(summary.concepts.length, 16);
    assert.equal(summary.omittedConcepts, 1);
    return response();
  });
});

test('decodes split UTF-8 and final records without newline, attributes actual model, and retains only tool name/state', async () => {
  const result = await reviewDraft(input(), async () => response([
    { type: 'tool', id: 'collision', name: 'getCollisionReport', state: 'running', input: { private: 'DO_NOT_RETAIN' } },
    { type: 'tool', id: 'collision', name: 'getCollisionReport', state: 'complete', output: { geometry: 'DO_NOT_RETAIN' } },
    text('  Révision 🦷: '), text('crossings require clinician review.  '), done,
  ], { splitUtf8: true, noNewline: true, headers: { 'X-Assistant-Model': 'server-custom-model' } }));
  assert.equal(result.text, 'Révision 🦷: crossings require clinician review.');
  assert.equal(result.model, 'server-custom-model');
  assert.equal(new Date(result.completedAt).toISOString(), result.completedAt);
  assert.deepEqual(result.tools, [{ name: 'getCollisionReport', state: 'complete' }]);
  assert.deepEqual(Object.keys(result).sort(), ['completedAt', 'model', 'text', 'tools']);
  assert.doesNotMatch(JSON.stringify(result), /DO_NOT_RETAIN|geometry|collision"/);
});

test('custom selected model is omitted from request and missing/blank attribution falls back to selection', async () => {
  for (const headers of [{}, { 'X-Assistant-Model': ' ' }]) {
    const result = await reviewDraft(input({ model: 'server-custom-default' }), async (_url, options) => {
      const payload = JSON.parse(options.body);
      assert.equal(Object.hasOwn(payload, 'model'), false);
      assert.deepEqual(Object.keys(payload).sort(), ['messages', 'snapshot']);
      return response(undefined, { headers });
    });
    assert.equal(result.model, 'server-custom-default');
  }
});

test('non-OK, missing body, incorrect MIME type, and failed fetch reject without leaking provider data', async () => {
  for (const fetcher of [
    async () => new Response('PRIVATE_PROVIDER_BODY', { status: 503 }),
    async () => new Response(null, { headers: { 'Content-Type': 'application/x-ndjson' } }),
    async () => new Response('PRIVATE_PROVIDER_BODY', { headers: { 'Content-Type': 'text/html' } }),
    async () => response(undefined, { headers: { 'Content-Type': 'text/plain; unexpected=application/x-ndjson' } }),
    async () => { throw new Error('PRIVATE_PROVIDER_BODY'); },
  ]) await assert.rejects(reviewDraft(input(), fetcher), error => {
    assert.doesNotMatch(error.message, /PRIVATE_PROVIDER_BODY/);
    return true;
  });
});

test('partial, blank, error, malformed, requested-view and post-done events never complete a review', async () => {
  for (const events of [
    [], [text('Partial')], [done], [text(' \n\t '), done],
    [text('Partial'), { type: 'error', message: 'PRIVATE_PROVIDER_BODY' }, done],
    [text('Partial'), { type: 'view-request', id: 'view', round: 1, spec: {} }, done],
    [text('Complete?'), done, { type: 'error', message: 'PRIVATE_PROVIDER_BODY' }],
    [text('Complete?'), done, text('Extra')], [text('Partial'), '{INVALID PRIVATE_PROVIDER_BODY'],
    [text('Partial'), { type: 'text', text: 123 }, done],
    [text('Partial'), { type: 'unknown' }, done], [text('Partial'), null, done],
    [text('Partial'), { type: 'tool', id: 'tool', name: 'getCollisionReport', state: 'error' }, done],
    [text('Partial'), { type: 'tool', id: 'tool', name: 123, state: 'complete' }, done],
  ]) {
    let calls = 0;
    await assert.rejects(reviewDraft(input(), async () => { calls++; return response(events); }), error => {
      assert.doesNotMatch(error.message, /PRIVATE_PROVIDER_BODY|Partial|Complete\?/);
      return true;
    });
    assert.equal(calls, 1, 'no continuation request');
  }
});

test('output and tool event caps reject rather than returning truncated completion', async () => {
  for (const events of [
    [text('x'.repeat(16001)), done], [text('x'.repeat(8000)), text('x'.repeat(8001)), done],
    [...Array.from({ length: 65 }, (_, i) => ({ type: 'tool', id: `${i}`, name: 'getModelInventory', state: 'complete' })), text('Review'), done],
  ]) await assert.rejects(reviewDraft(input(), async () => response(events)), /incomplete/);
  const result = await reviewDraft(input(), async () => response([text('x'.repeat(16000)), done]));
  assert.equal(result.text.length, 16000);
});

test('rejected streams are cancelled, including an oversized unfinished record', async () => {
  for (const chunks of [
    [JSON.stringify(text('Partial')) + '\n', JSON.stringify({ type: 'view-request' }) + '\n'],
    [JSON.stringify({ type: 'error', message: 'PRIVATE_PROVIDER_BODY' }) + '\n'],
    [JSON.stringify(text('x'.repeat(16001))) + '\n'],
    ['x'.repeat(4 * 1024 * 1024 + 1)],
  ]) {
    let cancelled = false, index = 0;
    const body = new ReadableStream({
      pull(controller) { if (index < chunks.length) controller.enqueue(encoder.encode(chunks[index++])); },
      cancel() { cancelled = true; },
    });
    await assert.rejects(reviewDraft(input(), async () => new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } })));
    assert.equal(cancelled, true);
  }
});

test('abort rejects before fetch, after headers, during a stalled stream, and after stream completion', async () => {
  const before = new AbortController(); before.abort();
  await assert.rejects(reviewDraft(input({ signal: before.signal }), async () => assert.fail('aborted request must not fetch')), { name: 'AbortError' });
  const afterHeaders = new AbortController();
  await assert.rejects(reviewDraft(input({ signal: afterHeaders.signal }), async () => { afterHeaders.abort(); return response(); }), { name: 'AbortError' });
  const during = new AbortController();
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(JSON.stringify(text('Partial')) + '\n')); }, cancel() { cancelled = true; } });
  const pending = reviewDraft(input({ signal: during.signal }), async () => new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } }));
  await new Promise(resolve => setImmediate(resolve));
  during.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, true);
  const atEnd = new AbortController();
  const finalBody = new ReadableStream({ pull(controller) {
    controller.enqueue(encoder.encode(JSON.stringify(text('Review')) + '\n' + JSON.stringify(done) + '\n'));
    controller.close(); atEnd.abort();
  } });
  await assert.rejects(reviewDraft(input({ signal: atEnd.signal }), async () => new Response(finalBody, { headers: { 'Content-Type': 'application/x-ndjson' } })), { name: 'AbortError' });
});

test('invalid tomography or a nonanonymous component alias never reaches fetch', async () => {
  const tomography = evidence(1); tomography.summary.fileName = 'PRIVATE.dcm';
  await assert.rejects(reviewDraft(input({ tomography }), async () => assert.fail('private evidence must not fetch')), /incomplete/);
  const invalid = concept(); invalid.components[0].id = 'PRIVATE.stl';
  await assert.rejects(reviewDraft(input({ concepts: [invalid] }), async () => assert.fail('raw identifiers must not fetch')), /incomplete/);
});
