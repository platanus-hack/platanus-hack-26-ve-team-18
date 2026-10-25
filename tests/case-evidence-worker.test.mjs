import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const moduleUrl = new URL('../src/case-evidence.worker.ts?typed-worker-test', import.meta.url).href;
const loader = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === moduleUrl && specifier === './case-preparation') return next(new URL('../src/case-preparation.ts', import.meta.url).href, context);
  return next(specifier, context);
} });
const previous = Object.getOwnPropertyDescriptor(globalThis, 'self');
let handler;
try {
  globalThis.self = { postMessage() {} };
  await import(moduleUrl); handler = globalThis.self.onmessage;
} finally {
  loader.deregister();
  if (previous) Object.defineProperty(globalThis, 'self', previous); else delete globalThis.self;
}

test('worker echoes the exact job/revision, isolates a malformed source and transfers each owned result buffer once', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'self');
  t.after(() => { if (original) Object.defineProperty(globalThis, 'self', original); else delete globalThis.self; });
  let posted;
  globalThis.self = { postMessage(result, options) { posted = { result, transfer: options?.transfer ?? [] }; } };
  const request = { id: 13, revision: 'exact-source-pose-annotation-revision', sources: [{ id: 'opaque-source', arch: 'upper', positions: new Float32Array([NaN, 0, 0, 0, 1, 0, 1, 0, 0]) }] };
  handler({ data: request });
  assert.equal(posted.result.id, request.id); assert.equal(posted.result.revision, request.revision);
  assert.equal(posted.result.scans[0].scan.method, 'unavailable'); assert.equal(posted.result.scans[0].numbering, null);
  assert.ok(posted.result.scans[0].scan.frame.origin.every(Number.isFinite));
  assert.deepEqual(posted.result.sites, []); assert.deepEqual(posted.result.identities, []);
  assert.equal(new Set(posted.transfer).size, posted.transfer.length);
  assert.ok(posted.transfer.includes(posted.result.scans[0].draftLabels.buffer));
  const copy = structuredClone(posted.result, { transfer: posted.transfer });
  assert.equal(copy.scans[0].draftLabels.length, 1);
});

test('worker failures retain the request envelope and return no partial outputs', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'self');
  t.after(() => { if (original) Object.defineProperty(globalThis, 'self', original); else delete globalThis.self; });
  let result;
  globalThis.self = { postMessage(message) { result = message; } };
  handler({ data: { id: 24, revision: 'settings-revision', sources: [], confidenceThreshold: 1.5 } });
  assert.deepEqual(Object.keys(result).sort(), ['error', 'id', 'revision']);
  assert.equal(result.id, 24); assert.equal(result.revision, 'settings-revision'); assert.match(result.error, /threshold/);
});
