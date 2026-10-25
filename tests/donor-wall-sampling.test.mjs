import test from 'node:test';
import assert from 'node:assert/strict';
import { donorShape, buildCrownMesh, auditCrownMesh, CROWN_THETA, CROWN_WALL } from '../src/crown-anatomy.ts';

const frame = { origin: [0, 0, 0], mesial: [1, 0, 0], buccal: [0, 1, 0], occlusal: [0, 0, 1] };
const info = { arch: 'lower', digit: 6, donorFdi: 36, donorPartId: 'analytic-frustum', donorToothId: 1, mirrored: false };
// The side is one planar strip per angular sector. Extra height subdivisions
// carry no new geometry; extraction must not invent a cervical bulge between them.
function frustum(levels, missingSector = () => false) {
  const positions = [], n = CROWN_THETA;
  const at = (a, z) => [(0.55 + 0.45 * z) * Math.cos(a * 2 * Math.PI / n), (0.55 + 0.45 * z) * Math.sin(a * 2 * Math.PI / n), z];
  for (let a = 0; a < n; a++) {
    const b = (a + 1) % n;
    if (!missingSector(a)) for (let j = 0; j < levels; j++) {
      const p = at(a, j / levels), q = at(b, j / levels), r = at(a, (j + 1) / levels), s = at(b, (j + 1) / levels);
      positions.push(...p, ...q, ...r, ...q, ...s, ...r);
    }
    positions.push(...at(a, 1), ...at(b, 1), 0, 0, 1);
  }
  const p = Float32Array.from(positions);
  return { p, faces: Array.from({ length: p.length / 9 }, (_, i) => i) };
}
const convert = input => donorShape(input.p, input.faces, frame, info);

test('measured donor walls follow triangle interiors even without intermediate source vertices', () => {
  for (const levels of [1, 4, 13]) {
    const shape = convert(frustum(levels));
    for (let j = 0; j < CROWN_WALL - 1; j++) for (let a = 0; a < CROWN_THETA; a++) {
      const z = j / (CROWN_WALL - 1) * shape.rimZ[a] * shape.dims[2];
      assert.ok(Math.abs(shape.wall[j * CROWN_THETA + a] - (0.55 + 0.45 * z)) < 2e-6, `level ${j}, angle ${a}: source sidewall distorted`);
    }
    assert.match(shape.source.provenance, /Wall coverage: 1248\/1248.*triangle intersections/);
    const audit = auditCrownMesh(buildCrownMesh(shape, shape.dims));
    assert.equal(audit.closed, true);
    assert.equal(audit.degenerate, 0);
  }
});

test('unseen donor sidewall sectors are disclosed as interpolated rather than measured', () => {
  const shape = convert(frustum(1, a => a >= 8 && a <= 13));
  const match = shape.source.provenance.match(/Wall coverage: (\d+)\/1248.*; (\d+) wall heights interpolated/);
  assert.ok(match, shape.source.provenance);
  assert.ok(Number(match[1]) < 1248);
  assert.equal(Number(match[1]) + Number(match[2]), 1248);
  assert.equal(auditCrownMesh(buildCrownMesh(shape, shape.dims)).closed, true);
});

test('triangle-intersection tolerance does not impose a minimum file-unit scale', () => {
  const input = frustum(13), original = convert(input);
  for (const scale of [2 ** -20, 2 ** 20]) {
    // Power-of-two scaling is exact in these Float32 inputs: anatomy must be
    // identical, even though the file's numerical unit has changed.
    const scaled = convert({ ...input, p: input.p.map(value => value * scale) });
    for (const key of ['rim', 'rimZ', 'wall', 'occlusal']) assert.deepEqual(scaled[key], original[key], key);
    assert.deepEqual(scaled.dims.map(value => value / scale), original.dims);
  }
});

test('a noncircular measured margin survives a rigid pose and Float32 rounding', () => {
  const positions = [], n = CROWN_THETA;
  const at = (a, t) => {
    const angle = a * 2 * Math.PI / n, basal = 0.55 + 0.15 * Math.cos(3 * angle), radius = basal + (1 - basal) * t;
    return [radius * Math.cos(angle), radius * Math.sin(angle), 0.1 + t];
  };
  for (let a = 0; a < n; a++) {
    const b = (a + 1) % n;
    for (let j = 0; j < 13; j++) {
      const p = at(a, j / 13), q = at(b, j / 13), r = at(a, (j + 1) / 13), s = at(b, (j + 1) / 13);
      positions.push(...p, ...q, ...r, ...q, ...s, ...r);
    }
    positions.push(...at(a, 1), ...at(b, 1), 0, 0, 1.1, ...at(b, 0), ...at(a, 0), 0, 0, 0.1);
  }
  const original = { p: Float32Array.from(positions), faces: Array.from({ length: positions.length / 9 }, (_, i) => i) };
  const movedFrame = { origin: [17.125, -8.25, 2.5], mesial: [2/3, 2/3, -1/3], buccal: [-1/3, 2/3, 2/3], occlusal: [2/3, -1/3, 2/3] };
  const moved = new Float32Array(original.p.length);
  for (let i = 0; i < moved.length; i += 3) for (let axis = 0; axis < 3; axis++) moved[i + axis] = movedFrame.origin[axis] + original.p[i] * movedFrame.mesial[axis] + original.p[i + 1] * movedFrame.buccal[axis] + original.p[i + 2] * movedFrame.occlusal[axis];
  const a = convert(original), b = donorShape(moved, original.faces, movedFrame, info);
  assert.ok(Math.max(...b.wall.slice(0, n)) - Math.min(...b.wall.slice(0, n)) > 0.29, 'Measured basal shape must not collapse to one circular radius.');
  for (const key of ['wall', 'rim', 'rimZ', 'occlusal']) for (let i = 0; i < a[key].length; i++) assert.ok(Math.abs(a[key][i] - b[key][i]) < 1e-5, `${key}[${i}] changed after rigid pose`);
  assert.equal(auditCrownMesh(buildCrownMesh(b, b.dims)).closed, true);
});
