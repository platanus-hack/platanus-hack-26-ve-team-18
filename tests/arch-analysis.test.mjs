import test from 'node:test';
import assert from 'node:assert/strict';
import { ArchModel } from '../src/arch-analysis.ts';
import { numberArch, crownLikelihood } from '../src/tooth-numbering.ts';

function surfaceModel(triangles) {
  const positions = new Float32Array(triangles.flat());
  return new ArchModel({ scale: 1, reference: [0, 0, 0], n: triangles.length }, positions, [0, 0, 1], [1, 0, 0], [0, 1, 0], { x0: 0, y0: 0, cell: 1, nx: 5, ny: 5 });
}

test('surface localization prefers the projected ridge over a nearby taller crown and supports face restrictions', () => {
  const model = surfaceModel([[0, 0, 0, 1, 0, 0, 0, 1, 0], [1, 0, 20, 2, 0, 20, 1, 1, 20]]);
  model.F[0] = 0; model.H[0] = 0; model.occupied[0] = 1;
  model.F[1] = 1; model.H[1] = 20; model.occupied[1] = 1;
  const found = model.surfaceAt(.2, .2, 2);
  assert.equal(found.face, 0); assert.deepEqual(found.point, [.2, .2, 0]); assert.equal(found.planDistance, 0);
  assert.equal(model.surfaceAt(.2, .2, 2, face => face === 1).face, 1);
  assert.equal(model.surfaceAt(.2, .2, 2, () => false), null);
  assert.equal(model.surfaceAt(100, 100, 2), null);
});

test('surface localization returns the closest projected edge point without extrapolating a triangle', () => {
  const model = surfaceModel([[0, 0, 0, 4, 0, 4, 0, 1, 0]]);
  model.F[1] = 0; model.H[1] = 1; model.occupied[1] = 1;
  const found = model.surfaceAt(2, 1, 2);
  assert.ok(Math.abs(found.point[0] - 32 / 17) < 1e-10);
  assert.ok(Math.abs(found.point[1] - 9 / 17) < 1e-10);
  assert.ok(Math.abs(found.point[2] - 32 / 17) < 1e-10);
  assert.ok(found.planDistance > 0);
});

const atom = (index, extra = {}) => ({ index, start: index, end: index, s0: index, s1: index + 1, crownFrac: 0, lowFrac: 1, unscannedFrac: 0, steep: .3, promRel: .2, topRel: .1, peaks: 0, tissue: null, blMid: 2, startCut: .1, ...extra });
const numberingOptions = { arch: 'upper', orientation: 1, apexS: null, apexWeight: 0 };

test('sequence fitting can explain tissue-only and unscanned surfaces without inventing a tooth', () => {
  for (const extra of [{}, { lowFrac: 0, unscannedFrac: 1 }]) {
    const result = numberArch({ atoms: Array.from({ length: 4 }, (_, i) => atom(i, extra)) }, numberingOptions);
    assert.ok(result.groups.length);
    assert.ok(result.groups.every(group => group.kind !== 'tooth' && group.kind !== 'gap'));
    assert.deepEqual(result.skipped, []);
  }
});

test('unscanned coverage cannot become high-confidence crown evidence from steepness or colour', () => {
  assert.equal(crownLikelihood({ crownFrac: 1, lowFrac: 0, unscannedFrac: .9, steep: 100, promRel: 5, peaks: 3, tissue: 0, atEnd: false }), .01);
  assert.throws(() => numberArch({ atoms: [atom(0, { s1: 0 })] }, numberingOptions), /positive arc spans/);
});
