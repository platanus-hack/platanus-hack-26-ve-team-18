import test from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry, PlaneGeometry } from 'three';
import { analyzeCollisions } from '../src/collision.ts';

const near = (actual, expected, epsilon = 1e-6) => assert.ok(
  Math.abs(actual - expected) <= epsilon, `${actual} should be within ${epsilon} of ${expected}`);
function fromGeometry(id, geometry, closed) {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry;
  const positions = new Float32Array(flat.getAttribute('position').array);
  flat.dispose();
  if (flat !== geometry) geometry.dispose();
  return { id, positions, closed };
}
const box = (id, size = [2, 2, 2], position = [0, 0, 0]) => fromGeometry(
  id, new BoxGeometry(...size).translate(...position), true);
const face = (id, points, closed = false) => ({ id, positions: new Float32Array(points.flat()), closed });

test('empty/single parts have no targets, preserve inputs and return correctly sized buffers', () => {
  const empty = analyzeCollisions([], 0.1);
  assert.deepEqual(empty.parts, []);
  const part = box('solo'), before = part.positions.slice();
  const report = analyzeCollisions([part, face('empty', [])], 0.1);
  assert.equal(report.parts[0].distances.length, part.positions.length / 3);
  assert.equal(report.parts[0].intersecting.length, part.positions.length / 9);
  assert.ok(report.parts[0].distances.every(d => d === Infinity));
  assert.deepEqual(part.positions, before);
  assert.deepEqual(report.pairs, []);
  assert.ok(Number.isFinite(report.durationMs) && report.durationMs >= 0);
});

test('separated boxes retain surface distances but do not create irrelevant pairs', () => {
  const report = analyzeCollisions([box('a'), box('b', [2, 2, 2], [4, 0, 0])], 0.1);
  assert.deepEqual(report.pairs, []);
  for (const p of report.parts) {
    near(Math.min(...p.distances), 2);
    near(Math.max(...p.distances), 4);
    assert.equal(p.penetratingVertices + p.nearbyVertices + p.intersectingTriangles, 0);
  }
});

test('nearby planes measure the nearest triangle interior rather than the nearest vertex', () => {
  const plane = fromGeometry('plane', new PlaneGeometry(20, 20), false);
  const small = face('small', [[-0.2, -0.1, 0.125], [0.3, -0.1, 0.125], [0, 0.4, 0.125]]);
  const report = analyzeCollisions([plane, small], 0.13);
  assert.equal(report.pairs.length, 1);
  assert.equal(report.parts[1].nearbyVertices, 3);
  assert.ok(report.parts[1].distances.every(d => d === 0.125));
  assert.equal(report.pairs[0].intersectingTriangles, 0);
  near(report.pairs[0].minDistance, 0.125);
});

test('intersecting closed boxes report penetration, contact faces, and maximum depth', () => {
  const report = analyzeCollisions([box('a'), box('b', [2, 2, 2], [1, 0.3, 0.2])], 0.05);
  assert.equal(report.pairs.length, 1);
  assert.ok(report.pairs[0].penetratingVertices > 0);
  assert.ok(report.pairs[0].intersectingTriangles > 0);
  assert.equal(report.pairs[0].minDistance, 0);
  near(report.pairs[0].maxDepth, 0.2);
  for (const p of report.parts) {
    assert.ok(p.penetratingVertices > 0);
    assert.equal(p.intersectingTriangles, p.intersecting.reduce((a, b) => a + b, 0));
    assert.ok(p.distances.some(d => d < 0));
  }
});

test('fully contained meshes have negative distances without surface intersections', () => {
  const report = analyzeCollisions([box('outer', [6, 6, 6]), box('inner')], 0.05);
  const [outer, inner] = report.parts;
  assert.ok(inner.distances.every(d => d === -2));
  assert.equal(inner.penetratingVertices, inner.distances.length);
  assert.equal(inner.nearbyVertices, 0);
  near(inner.maxDepth, 2);
  assert.ok(outer.distances.every(d => d > 0));
  assert.equal(outer.penetratingVertices, 0);
  assert.equal(report.pairs[0].intersectingTriangles, 0);
  near(report.pairs[0].minDistance, 2);
  near(report.pairs[0].maxDepth, 2);
});

test('containment is independent of face winding, including inconsistently oriented faces', () => {
  const outer = box('outer', [6, 6, 6]);
  for (let i = 0; i < outer.positions.length; i += 18) {
    for (let axis = 0; axis < 3; axis++) {
      const b = outer.positions[i + 3 + axis];
      outer.positions[i + 3 + axis] = outer.positions[i + 6 + axis];
      outer.positions[i + 6 + axis] = b;
    }
  }
  const report = analyzeCollisions([outer, box('inner')], 0);
  assert.ok(report.parts[1].distances.every(d => d === -2));
});

test('coplanar overlapping triangles, including reversed winding, flag both faces', () => {
  const a = face('a', [[0, 0, 0], [3, 0, 0], [0, 3, 0]]);
  const b = face('b', [[0.5, 0.5, 0], [0.5, 1.5, 0], [1.5, 0.5, 0]]);
  const report = analyzeCollisions([a, b], 0);
  assert.equal(report.pairs[0].intersectingTriangles, 2);
  assert.equal(report.pairs[0].penetratingVertices, 0);
  assert.equal(report.pairs[0].minDistance, 0);
  assert.deepEqual(report.parts.map(p => [...p.intersecting]), [[1], [1]]);
});

test('coplanar edges can cross even when all six corners are separated from the other face', () => {
  const a = face('a', [[-2, -1, 0], [2, -1, 0], [0, 2, 0]]);
  const b = face('b', [[-2, 1, 0], [0, -2, 0], [2, 1, 0]]);
  const report = analyzeCollisions([a, b], 0);
  assert.equal(report.pairs[0].intersectingTriangles, 2);
  assert.equal(report.pairs[0].nearbyVertices, 0);
  assert.ok(report.parts.every(p => p.distances.every(d => d > 0)));
});

test('overlapping AABBs do not imply coplanar or spatial triangle intersections', () => {
  const a = face('a', [[0, 0, 0], [2, 0, 0], [0, 2, 0]]);
  const b = face('b', [[2, 2, 0], [2, 0.6, 0], [0.6, 2, 0]]);
  assert.deepEqual(analyzeCollisions([a, b], 0).pairs, []);
  const skew = face('skew', [[1.5, 1.5, -1], [2, 1.5, 1], [1.5, 2, 1]]);
  assert.deepEqual(analyzeCollisions([a, skew], 0).pairs, []);
});

test('open surfaces never receive inside classifications', () => {
  const open = box('open');
  open.closed = false;
  open.positions = open.positions.slice(18); // Remove one complete side.
  const probe = face('probe', [[-0.1, 0, 0], [0.1, 0, 0], [0, 0.1, 0]]);
  const report = analyzeCollisions([open, probe], 0.05);
  assert.deepEqual(report.pairs, []);
  assert.ok(report.parts[1].distances.every(d => d > 0));
  assert.equal(report.parts[1].penetratingVertices, 0);
});

test('crossing rods flag intersections even when every vertex is outside', () => {
  const report = analyzeCollisions([box('x', [6, 0.5, 0.5]), box('y', [0.5, 6, 0.5])], 0.01);
  assert.equal(report.pairs.length, 1);
  assert.equal(report.pairs[0].penetratingVertices, 0);
  assert.equal(report.pairs[0].nearbyVertices, 0);
  assert.equal(report.pairs[0].minDistance, 0);
  assert.ok(report.parts.every(p => p.intersectingTriangles > 0 && p.distances.every(d => d > 0)));
});

test('noncoplanar triangle interior crossings do not need nearby corner samples', () => {
  const a = face('a', [[-2, -2, 0], [2, -2, 0], [0, 2, 0]]);
  const b = face('b', [[0, -1, -2], [0, -1, 2], [0, 3, 1]]);
  const report = analyzeCollisions([a, b], 0.01);
  assert.equal(report.pairs[0].intersectingTriangles, 2);
  assert.equal(report.pairs[0].nearbyVertices, 0);
  assert.equal(report.pairs[0].penetratingVertices, 0);
  assert.ok(report.parts.every(p => p.distances.every(d => d > 0.01)));
});

test('touching faces and edge/vertex contacts count as intersections, not penetration', () => {
  for (const translation of [[2, 0, 0], [2, 2, 0], [2, 2, 2]]) {
    const report = analyzeCollisions([box('a'), box('b', [2, 2, 2], translation)], 0);
    assert.equal(report.pairs[0].minDistance, 0);
    assert.equal(report.pairs[0].penetratingVertices, 0);
    assert.ok(report.pairs[0].intersectingTriangles > 0);
  }
});

test('multiple targets preserve penetration priority without double-counting part corners', () => {
  const report = analyzeCollisions([
    box('inner'), box('outer', [6, 6, 6]), box('larger', [8, 8, 8]),
  ], 0.1);
  assert.ok(report.parts[0].distances.every(d => d === -3));
  assert.equal(report.parts[0].penetratingVertices, report.parts[0].distances.length);
  assert.equal(report.parts[0].maxDepth, 3);
  assert.equal(report.pairs.length, 3);
});

test('scale and translation do not change containment or triangle contact classification', () => {
  for (const scale of [1e-5, 1, 1e5]) {
    const origin = scale * 100;
    const report = analyzeCollisions([
      box('outer', [6 * scale, 6 * scale, 6 * scale], [origin, origin, origin]),
      box('inner', [2 * scale, 2 * scale, 2 * scale], [origin, origin, origin]),
    ], 0);
    assert.ok(report.parts[1].distances.every(d => d < 0));
    near(report.parts[1].maxDepth / scale, 2, 2e-4);
    assert.equal(report.pairs[0].intersectingTriangles, 0);
  }
});

test('degenerate faces have finite distances and do not invent separated segment contacts', () => {
  const segment = face('segment', [[0, 0, 0], [1, 1, 1], [0.5, 0.5, 0.5]]);
  const offset = face('offset', [[0.1, -0.1, 0], [1.1, 0.9, 1], [0.6, 0.4, 0.5]]);
  const report = analyzeCollisions([segment, offset], 0);
  assert.deepEqual(report.pairs, []);
  assert.ok(report.parts.every(p => p.distances.every(d => Number.isFinite(d) && d > 0)));
  const plane = face('plane', [[-2, -2, 0.5], [2, -2, 0.5], [0, 2, 0.5]]);
  assert.equal(analyzeCollisions([segment, plane], 0).pairs[0].intersectingTriangles, 2);
});

test('invalid inputs fail clearly instead of generating NaNs or corrupt BVHs', () => {
  assert.throws(() => analyzeCollisions([], -1), /Tolerance/);
  assert.throws(() => analyzeCollisions([], NaN), /Tolerance/);
  assert.throws(() => analyzeCollisions([box('a'), box('a')], 0), /unique/);
  assert.throws(() => analyzeCollisions([{ id: 'bad', positions: new Float32Array(4), closed: false }], 0), /complete/);
  assert.throws(() => analyzeCollisions([face('bad', [[NaN, 0, 0], [0, 1, 0], [1, 0, 0]])], 0), /finite/);
});

test('worker replies with matching IDs, transferable result buffers, and recoverable errors', async () => {
  const originalPost = globalThis.postMessage, originalHandler = globalThis.onmessage;
  let response, transferCount;
  globalThis.postMessage = (message, transfer) => {
    transferCount = transfer.length;
    response = structuredClone(message, { transfer });
  };
  try {
    await import('../src/collision.worker.ts');
    const source = box('a');
    globalThis.onmessage({ data: { id: 7, parts: [source, box('b')], tolerance: 0 } });
    assert.equal(response.id, 7);
    assert.equal(transferCount, 4);
    assert.ok(response.report.parts[0].distances instanceof Float32Array);
    assert.ok(response.report.parts[0].intersecting instanceof Uint8Array);
    assert.ok(source.positions.byteLength > 0);
    globalThis.onmessage({ data: { id: 8, parts: [], tolerance: -1 } });
    assert.equal(response.id, 8);
    assert.match(response.error, /Tolerance/);
    globalThis.onmessage({ data: { id: 9, parts: [], tolerance: 0 } });
    assert.equal(response.id, 9);
    assert.deepEqual(response.report.pairs, []);
  } finally {
    if (originalPost === undefined) delete globalThis.postMessage; else globalThis.postMessage = originalPost;
    if (originalHandler === undefined) delete globalThis.onmessage; else globalThis.onmessage = originalHandler;
  }
});
