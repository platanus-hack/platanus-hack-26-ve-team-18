import test from 'node:test';
import assert from 'node:assert/strict';
import { compactPlanningValue, MAX_PLANNING_EVENT_BYTES, MAX_PLANNING_EVENTS, readPlanningEvents } from '../src/planning-events.ts';

const encoder = new TextEncoder();
const started = { type: 'started', revision: 'case-1', model: 'local-mock' };
const result = { type: 'result', result: { revision: 'case-1', summary: 'Review café surfaces.' } };
const encoded = events => encoder.encode(events.map(event => JSON.stringify(event)).join('\n') + '\n');
function streamChunks(chunks, options = {}) {
  return new ReadableStream({
    start(controller) { for (const chunk of chunks) controller.enqueue(chunk); if (!options.open) controller.close(); },
    cancel: options.cancel,
  });
}

test('planning events handle arbitrary UTF-8 chunk boundaries, CRLF and multiple records', async () => {
  const progress = { type: 'tool', activity: { id: 'call-1', name: 'inspectToothRegion', phase: 'running', input: { candidateId: 1 } } };
  const completed = { type: 'tool', activity: { ...progress.activity, phase: 'complete', output: { status: 'reviewed' }, durationMs: 12.5 } };
  const bytes = encoder.encode([started, progress, completed, result].map(event => JSON.stringify(event)).join('\r\n') + '\r\n');
  const seen = [];
  const value = await readPlanningEvents(streamChunks(Array.from(bytes, byte => Uint8Array.of(byte))), event => seen.push(event));
  assert.deepEqual(seen, [started, progress, completed, result]);
  assert.deepEqual(value, result.result);
});

test('progress is live but a result is withheld until the stream closes cleanly', async () => {
  let controller;
  const seen = [];
  const stream = new ReadableStream({ start(value) { controller = value; } });
  const pending = readPlanningEvents(stream, event => seen.push(event));
  controller.enqueue(encoded([started, result]));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(seen, [started]);
  controller.close();
  assert.deepEqual(await pending, result.result);
  assert.deepEqual(seen, [started, result]);
});

test('incomplete, malformed or repeated terminal records never deliver a result', async () => {
  for (const bytes of [
    new Uint8Array(), encoded([started]),
    encoder.encode(`${JSON.stringify(started)}\n${JSON.stringify(result)}`),
    encoded([result]), encoded([started, started, result]),
    encoded([started, result, result]),
    encoded([started, result, { type: 'error', error: 'Later error.' }]),
    encoder.encode(`${JSON.stringify(started)}\n${JSON.stringify(result)}\nPRIVATE malformed\n`),
    encoder.encode(`${JSON.stringify(started)}\n{"type":"result","result":`),
    encoded([started, { type: 'tool', activity: { id: 'bad', name: 'x', phase: 'invented' } }, result]),
    encoded([started, { type: 'tool', activity: { id: 'bad', name: 'x', phase: 'complete', durationMs: -1 } }, result]),
    encoded([started, { type: 'reasoning', text: 'PRIVATE reasoning' }, result]),
    encoded([started, { type: 'result' }]),
  ]) {
    const seen = [];
    await assert.rejects(readPlanningEvents(streamChunks([bytes]), event => seen.push(event)), /planning/i);
    assert.equal(seen.some(event => event.type === 'result'), false);
  }
});

test('invalid UTF-8 and a transport error after a result are rejected without applying it', async () => {
  const invalid = new Uint8Array([...encoded([started]), 0xff, 10]);
  await assert.rejects(readPlanningEvents(streamChunks([invalid]), () => {}), /Invalid planning event/);
  let controller;
  const seen = [];
  const pending = readPlanningEvents(new ReadableStream({ start(value) { controller = value; } }), event => seen.push(event));
  controller.enqueue(encoded([started, result]));
  await new Promise(resolve => setImmediate(resolve));
  controller.error(new Error('Connection closed.'));
  await assert.rejects(pending, /Connection closed/);
  assert.deepEqual(seen, [started]);
});

test('planning event lines are bounded in bytes and oversize input cancels the reader', async () => {
  let cancelled = false;
  const oversized = encoder.encode('é'.repeat(MAX_PLANNING_EVENT_BYTES / 2 + 1));
  const stream = streamChunks([encoded([started]), oversized], { open: true, cancel() { cancelled = true; } });
  await assert.rejects(readPlanningEvents(stream, () => {}), /1 MiB limit/);
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
  const line = JSON.stringify(result);
  const padded = encoder.encode(line + ' '.repeat(MAX_PLANNING_EVENT_BYTES - encoder.encode(line).length) + '\n');
  assert.deepEqual(await readPlanningEvents(streamChunks([encoded([started]), padded]), () => {}), result.result);
});

test('a 200-event stream is accepted and event 201 rejects the pending result', async () => {
  const progress = Array.from({ length: MAX_PLANNING_EVENTS - 2 }, (_, id) => ({ type: 'tool', activity: { id: String(id), name: 'inspectToothRegion', phase: 'complete' } }));
  assert.deepEqual(await readPlanningEvents(streamChunks([encoded([started, ...progress, result])]), () => {}), result.result);
  const seen = [];
  await assert.rejects(readPlanningEvents(streamChunks([encoded([started, ...progress, progress[0], result])]), event => seen.push(event)), /200-event limit/);
  assert.equal(seen.some(event => event.type === 'result'), false);
});

test('a masked error is delivered and rejects without requiring a result', async () => {
  const error = { type: 'error', error: 'The planning provider request failed.' }, seen = [];
  await assert.rejects(readPlanningEvents(streamChunks([encoded([started, error])]), event => seen.push(event)), { message: error.error });
  assert.deepEqual(seen, [started, error]);
});

test('abort cancels a stalled reader, preserves AbortError and discards a pending result', async () => {
  const controller = new AbortController(), seen = [];
  let cancelled = false;
  const stream = streamChunks([encoded([started, result])], { open: true, cancel() { cancelled = true; } });
  const pending = readPlanningEvents(stream, event => seen.push(event), controller.signal);
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(cancelled, true); assert.equal(stream.locked, false);
  assert.deepEqual(seen, [started]);
  const preaborted = new AbortController(); preaborted.abort();
  let cancelledBeforeRead = false;
  await assert.rejects(readPlanningEvents(streamChunks([], { open: true, cancel() { cancelledBeforeRead = true; } }), () => assert.fail('No events after abort.'), preaborted.signal), { name: 'AbortError' });
  assert.equal(cancelledBeforeRead, true);
});

test('compact planning summaries omit patient arrays, documents, binary data and reasoning', () => {
  const value = {
    design: { anatomy: 'premolar', parameters: { fixture: { radius: 1.2, length: 4 } }, contour: { cervicalScale: .95 } },
    teeth: [{ patient: 'PRIVATE_PATIENT', vertices: [123456] }], positions: [987654],
    content: 'PRIVATE_DOCUMENT', base64: 'PRIVATE_IMAGE', reasoning: 'PRIVATE_REASONING',
    bytes: new Uint8Array([1, 2, 3]), imageUrl: 'data:image/jpeg;base64,PRIVATE',
  };
  const compact = compactPlanningValue(value);
  assert.deepEqual(compact.design, value.design);
  assert.deepEqual(compact.teeth, { type: 'array', count: 1 });
  assert.deepEqual(compact.bytes, { type: 'buffer', byteLength: 3 });
  assert.doesNotMatch(JSON.stringify(compact), /PRIVATE|123456|987654/);
  assert.deepEqual(compactPlanningValue(new Array(1_000_000).fill(123456)), { type: 'array', count: 1_000_000 });
});

test('compact summaries have fixed 6000-character, depth and circularity bounds', () => {
  const circular = { status: 'ready' }; circular.self = circular;
  assert.deepEqual(compactPlanningValue(circular), { status: 'ready', self: { omitted: 'circular' } });
  const tree = depth => depth ? Object.fromEntries(Array.from({ length: 24 }, (_, id) => [`key-${id}`, tree(depth - 1)])) : '"\\\n'.repeat(1000);
  const inputs = [undefined, null, Infinity, 1n, tree(2), { text: 'PRIVATE'.repeat(1_000_000) }];
  let nested = {}; inputs.push(nested);
  for (let i = 0; i < 100; i++) nested = nested.child = {};
  for (const input of inputs) assert.ok(JSON.stringify(compactPlanningValue(input)).length <= 6000);
});

test('bounded decision and measurement arrays remain inspectable in the process trace', () => {
  const value = compactPlanningValue({ reviews: [{ sourceId: 'scan-1', candidateId: 2, decision: 'needs-boundary-review', fdi: null }],
    rows: [{ id: 'gap', actual: .3, lower: 0, upper: .1, units: 'u' }] });
  assert.equal(value.reviews.items[0].decision, 'needs-boundary-review');
  assert.equal(value.rows.items[0].actual, .3);
});
