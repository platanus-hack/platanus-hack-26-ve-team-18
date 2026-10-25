import test from 'node:test';
import assert from 'node:assert/strict';
import { presentationOpacity, withArchOpacity } from '../src/presentation.ts';
import { prepareCollisionParts } from '../src/collision-input.ts';

const part = (id, role, restoration) => ({ id, role, restoration, visible: true, closed: false, offset: [0, 0, 0], positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0) });

test('jaw opacity includes its components without changing geometry or collision membership', () => {
  const upper = part('upper', 'upper'), lower = part('lower', 'lower'), bite = part('bite', 'bite');
  const crown = part('crown', 'model', { parentPartId: upper.id, component: 'crown' });
  const parts = [upper, lower, bite, crown], before = prepareCollisionParts(parts);
  const opacities = withArchOpacity(parts, {}, 'upper', 0);
  assert.equal(presentationOpacity(upper, opacities), 0);
  assert.equal(presentationOpacity(crown, opacities), 0);
  assert.equal(presentationOpacity(lower, opacities), 1);
  assert.equal(presentationOpacity(bite, { bite: 1 }), 0);
  assert.deepEqual(prepareCollisionParts(parts), before);
  assert.deepEqual(parts.map(part => part.visible), [true, true, true, true]);
  const later = part('new-fixture', 'model', { parentPartId: upper.id, component: 'fixture' });
  assert.equal(presentationOpacity(later, opacities), 0, 'new concepts inherit the hidden parent');
  assert.equal(presentationOpacity(crown, withArchOpacity(parts, opacities, 'upper', .35)), .35);
});
