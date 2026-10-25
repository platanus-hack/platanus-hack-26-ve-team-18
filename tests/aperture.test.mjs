import test from 'node:test';
import assert from 'node:assert/strict';
import { withArchSeparation } from '../src/aperture.ts';

// Only the fields the helper reads: role, dimensions, offset, restoration.
// Dimensions [30, 40, 0] give radius = hypot / 2 = 25, so delta at 100% = 25 * 0.36 = 9.
const part = (id, role, dimensions = [30, 40, 0], extra = {}) => ({ id, role, dimensions, offset: [0, 0, 0], ...extra });
const upper = () => part('upper-1', 'upper');
const lower = () => part('lower-1', 'lower');

test('zero aperture returns the same array untouched', () => {
  const parts = [upper(), lower()];
  assert.equal(withArchSeparation(parts, 0, 'y'), parts);
  assert.equal(withArchSeparation(parts, -5, 'y'), parts);
});

test('both arches are required before anything moves', () => {
  const onlyUpper = [upper()];
  assert.equal(withArchSeparation(onlyUpper, 50, 'y'), onlyUpper);
  const bite = [part('bite-1', 'bite'), upper()];
  assert.equal(withArchSeparation(bite, 50, 'y'), bite);
});

test('upper and lower separate symmetrically along the chosen up axis', () => {
  const parts = [upper(), lower()];
  const opened = withArchSeparation(parts, 100, 'y');
  assert.equal(opened[0].offset[1], 9);
  assert.equal(opened[1].offset[1], -9);
  assert.equal(opened[0].offset[0], 0);
  assert.equal(opened[0].offset[2], 0);
  const openedZ = withArchSeparation(parts, 100, 'z');
  assert.equal(openedZ[0].offset[2], 9);
  assert.equal(openedZ[1].offset[2], -9);
  assert.equal(openedZ[0].offset[1], 0);
});

test('half aperture moves half the distance and preserves existing offsets', () => {
  const parts = [part('upper-1', 'upper', [30, 40, 0], { offset: [1, 2, 3] }), lower()];
  const opened = withArchSeparation(parts, 50, 'y');
  assert.equal(opened[0].offset[1], 2 + 4.5);
  assert.equal(opened[0].offset[0], 1);
  assert.equal(opened[0].offset[2], 3);
  assert.equal(opened[1].offset[1], -4.5);
});

test('separation scales with model size', () => {
  const small = withArchSeparation([upper(), lower()], 100, 'y');
  const large = withArchSeparation([part('u', 'upper', [60, 80, 0]), part('l', 'lower', [60, 80, 0])], 100, 'y');
  assert.equal(large[0].offset[1], small[0].offset[1] * 2);
});

test('non-arch parts stay put and restoration parts follow their parent arch', () => {
  const crown = part('crown-1', 'model', [2, 2, 2], { restoration: { assemblyId: 'a', component: 'crown', parentPartId: 'upper-1' } });
  const bite = part('bite-1', 'bite');
  const parts = [upper(), lower(), crown, bite];
  const opened = withArchSeparation(parts, 100, 'y');
  assert.equal(opened[2].offset[1], opened[0].offset[1]);
  assert.equal(opened[3], bite);
});
