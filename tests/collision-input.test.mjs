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

test('only explicit generated assembly identities separate internal and external comparisons', () => {
  const generated = (id, assemblyId, component, offset) => ({ ...part(id, 0, offset),
    restoration: { assemblyId, component, parentPartId: 'scan' } });
  const components = [generated('fixture', 'one', 'fixture', [0, 0, 0]),
    generated('abutment', 'one', 'abutment', [.2, .1, .1]), generated('crown', 'one', 'crown', [.3, .2, .2])];
  const before = components.map(p => p.positions.slice());
  const input = prepareCollisionParts(components), internal = analyzeCollisions(structuredClone(input), 0);
  assert.ok(input.every(p => p.assemblyId === 'one'));
  assert.equal(internal.pairs.length, 0);
  assert.equal(internal.assemblyPairs.length, 3);
  assert.ok(internal.assemblyPairs.some(p => p.penetratingVertices > 0 && p.crossingTriangles > 0));
  assert.ok(internal.parts.every(p => p.distances.every(d => d === Infinity) && p.intersectingTriangles === 0));
  const external = generated('other-crown', 'two', 'crown', [.1, .1, .1]);
  const report = analyzeCollisions(prepareCollisionParts([...components, external, { ...part('scan', 0), sourceFileId: 'one' }]), 0);
  assert.ok(report.pairs.some(p => p.a === 'fixture' && p.b === external.id && p.crossingTriangles > 0));
  assert.ok(report.pairs.some(p => p.a === 'crown' && p.b === 'scan'), 'the parent scan is still a collision target');
  assert.ok(report.parts.find(p => p.id === 'crown').intersectingTriangles > 0);
  assert.deepEqual(components.map(p => p.positions), before);
});

test('bite references and stale generated parts stay out of collision input', () => {
  assert.deepEqual(prepareCollisionParts([{ ...part('bite', 0), role: 'bite' },
    { ...part('stale', 0), restoration: { assemblyId: 'one', component: 'crown', parentPartId: 'scan', stale: true } }]), []);
});
