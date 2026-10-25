import test from 'node:test';
import assert from 'node:assert/strict';
import { Matrix4, Vector3 } from 'three';
import { inferScanRole, partMatrix, posedPositions } from '../src/pose.ts';
import { prepareCollisionParts } from '../src/collision-input.ts';

const triangle = () => ({ id: 'arch', positions: new Float32Array([10, 0, 0, 12, 0, 0, 10, 2, 0]), visible: true, closed: false, offset: [0, 0, 0] });
const close = (actual, expected) => actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-9, `${value} vs ${expected[i]}`));

test('standard arch and bite filenames suggest roles without guessing arbitrary names', () => {
  assert.equal(inferScanRole('upper.PLY'), 'upper');
  assert.equal(inferScanRole('lower.stl'), 'lower');
  assert.equal(inferScanRole('bite1.ply'), 'bite');
  assert.equal(inferScanRole('bite_2.ply'), 'bite');
  assert.equal(inferScanRole('ambite.ply'), 'model');
});

test('saved registration, manual rotation about posed centre, and translation compose in shared coordinates', () => {
  const part = { ...triangle(), pose: new Matrix4().makeTranslation(5, 3, 0).toArray(), rotation: [0, 0, 90], offset: [1, 2, 0] };
  const original = part.positions.slice();
  const transformed = posedPositions(part);
  close(Array.from(transformed), [18, 5, 0, 18, 7, 0, 16, 5, 0]);
  close(new Vector3(10, 0, 0).applyMatrix4(partMatrix(part)).toArray(), [18, 5, 0]);
  assert.deepEqual(part.positions, original);
  const reset = { ...part, offset: [0, 0, 0], rotation: [0, 0, 0] };
  close(Array.from(posedPositions(reset).slice(0, 3)), [15, 3, 0]);
});

test('collision inputs apply the same rigid pose and always exclude bite references', () => {
  const a = { ...triangle(), role: 'upper' };
  const b = { ...triangle(), id: 'lower', role: 'lower', pose: new Matrix4().makeTranslation(0, 0, 4).toArray() };
  const bite = { ...triangle(), id: 'bite', role: 'bite' };
  const result = prepareCollisionParts([a, b, bite]);
  assert.deepEqual(result.map(part => part.id), ['arch', 'lower']);
  close(Array.from(result[1].positions.slice(0, 3)), [0, 0, 4]);
  assert.deepEqual(prepareCollisionParts([bite]), []);
});
