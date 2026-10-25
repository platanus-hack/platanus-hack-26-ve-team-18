import test from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry } from 'three';
import { prepareCollisionParts } from '../src/collision-input.ts';
import { analyzeCollisions } from '../src/collision.ts';

function part(id, x, offset = [0, 0, 0]) {
  const geometry = new BoxGeometry(1, 1, 1).translate(x, 0, 0).toNonIndexed();
  const positions = new Float32Array(geometry.getAttribute('position').array);
  geometry.dispose();
  return { id, positions, closed: true, visible: true, offset };
}

test('large common offsets preserve clear geometry and sampled gaps', () => {
  const inputs = prepareCollisionParts([part('a', 0, [1e8, 0, 0]), part('b', 3, [1e8, 0, 0])]);
  assert.ok(inputs.every(part => part.positions instanceof Float64Array));
  const report = analyzeCollisions(inputs, 0.1);
  assert.deepEqual(report.pairs, []);
  assert.equal(Math.min(...report.parts[0].distances), 2);
});

test('distant clusters retain their own geometry, including real collisions', () => {
  const clear = [part('origin', -10), part('a', 0, [1e8, 0, 0]), part('b', 3, [1e8, 0, 0])];
  assert.deepEqual(analyzeCollisions(prepareCollisionParts(clear), 0.1).pairs, []);
  const intersecting = [...clear.slice(0, 2), part('b', 0.6, [1e8, 0, 0])];
  const report = analyzeCollisions(prepareCollisionParts(intersecting), 0.1);
  assert.equal(report.pairs.length, 1);
  assert.equal(report.pairs[0].a, 'a');
  assert.equal(report.pairs[0].b, 'b');
  assert.ok(report.pairs[0].intersectingTriangles > 0);
});

test('hidden parts are excluded without modifying source coordinates', () => {
  const a = part('a', 5), b = { ...part('b', 5), visible: false };
  const original = a.positions.slice();
  const inputs = prepareCollisionParts([a, b]);
  assert.deepEqual(inputs.map(part => part.id), ['a']);
  assert.deepEqual(a.positions, original);
  assert.deepEqual(prepareCollisionParts([]), []);
});
