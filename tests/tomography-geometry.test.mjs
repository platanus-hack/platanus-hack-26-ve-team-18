import test from 'node:test';
import assert from 'node:assert/strict';
import {
  voxelToPatient, patientToVoxel, sampleVolume, volumeCenter, extractTomographySurface,
} from '../src/tomography-geometry.ts';

const identity = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const oblique = [
  [1 / Math.sqrt(2), 1 / Math.sqrt(2), 0],
  [-1 / Math.sqrt(6), 1 / Math.sqrt(6), 2 / Math.sqrt(6)],
  [1 / Math.sqrt(3), -1 / Math.sqrt(3), 1 / Math.sqrt(3)],
];
const close = (actual, expected, tolerance = 1e-10) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
};
const closeVector = (actual, expected, tolerance = 1e-10) => actual.forEach((value, i) => close(value, expected[i], tolerance));
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const index = (volume, x, y, z) => x + volume.dimensions[0] * (y + volume.dimensions[1] * z);

function makeVolume(dimensions = [3, 3, 3], value = (x, y, z) => x + y + z, overrides = {}) {
  const [nx, ny, nz] = dimensions;
  const voxels = new Float32Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    voxels[x + nx * (y + ny * z)] = value(x, y, z);
  }
  return {
    id: 'test-volume', dimensions, spacing: [1, 1, 1], origin: [0, 0, 0], directions: identity,
    voxels, range: [-1000, 1000], missingSlices: [], complete: true,
    quantitativeMeasurementsAllowed: true, warnings: [],
    provenance: {
      source: 'local-dicom', sourceSlices: nz, expectedSlices: nz, duplicateSlices: 0,
      transferSyntaxes: [], rescaled: true, intensityUnits: 'rescaled values', paddingVoxels: 0,
      missingDataPolicy: 'reject', interpolated: false,
    },
    ...overrides,
  };
}

function checkNormalsAndWinding(surface, expected) {
  assert.equal(surface.positions.length, surface.triangles * 9);
  assert.equal(surface.normals.length, surface.positions.length);
  for (let i = 0; i < surface.positions.length; i += 9) {
    const p = surface.positions, n = [...surface.normals.subarray(i, i + 3)];
    close(Math.hypot(...n), 1, 1e-6);
    if (expected) closeVector(n, expected, 2e-6);
    closeVector([...surface.normals.subarray(i + 3, i + 6)], n);
    closeVector([...surface.normals.subarray(i + 6, i + 9)], n);
    const u = [p[i + 3] - p[i], p[i + 4] - p[i + 1], p[i + 5] - p[i + 2]];
    const v = [p[i + 6] - p[i], p[i + 7] - p[i + 1], p[i + 8] - p[i + 2]];
    const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    assert.ok(dot(cross, n) > 0, 'winding must agree with the outward normal');
  }
}

test('anisotropic oblique affine uses direction columns, patient origin, and sample-center bounds', () => {
  const volume = makeVolume([4, 5, 3], undefined, { spacing: [2, 3, 4], origin: [130, -60, 42], directions: oblique });
  const voxel = [1.25, 2.5, 0.75];
  const expected = volume.origin.map((value, axis) => value
    + oblique[0][axis] * 2.5 + oblique[1][axis] * 7.5 + oblique[2][axis] * 3);
  closeVector(voxelToPatient(volume, voxel), expected);
  closeVector(patientToVoxel(volume, expected), voxel);
  closeVector(volumeCenter(volume), voxelToPatient(volume, [1.5, 2, 1]));
  closeVector(volumeCenter(makeVolume([1, 1, 1], undefined, { origin: [4, 5, 6] })), [4, 5, 6]);
});

test('trilinear sampling reproduces an analytic linear field in oblique patient coordinates', () => {
  const volume = makeVolume([4, 5, 3], (x, y, z) => 10 + 2 * x - 3 * y + 4 * z,
    { spacing: [0.6, 1.4, 2.1], origin: [-83, 41, 25], directions: oblique });
  for (const voxel of [[1.25, 2.5, 0.75], [0, 0, 0], [3, 4, 2], [3, 1.25, 1], [0, 2.5, 2]]) {
    close(sampleVolume(volume, voxelToPatient(volume, voxel)), 10 + 2 * voxel[0] - 3 * voxel[1] + 4 * voxel[2]);
  }
  for (const voxel of [[-0.01, 0, 0], [3.01, 1, 1], [1, 4.01, 1], [1, 1, -0.01], [1, 1, 2.01]]) {
    assert.ok(Number.isNaN(sampleVolume(volume, voxelToPatient(volume, voxel))));
  }
  assert.ok(Number.isNaN(sampleVolume(volume, [NaN, 0, 0])));
  assert.ok(Number.isNaN(sampleVolume(volume, [Infinity, 0, 0])));
});

test('NaN corners with zero weight cannot poison valid planes, lines, or single sample volumes', () => {
  for (let axis = 0; axis < 3; axis++) {
    const volume = makeVolume([2, 2, 2], (x, y, z) => [x, y, z][axis] === 1 ? NaN : 7,
      { spacing: [0.6, 1.4, 2.1], origin: [-83, 41, 25], directions: oblique });
    const voxel = [0.25, 0.5, 0.75];
    voxel[axis] = 0;
    close(sampleVolume(volume, voxelToPatient(volume, voxel)), 7);
    voxel[axis] = 0.1;
    assert.ok(Number.isNaN(sampleVolume(volume, voxelToPatient(volume, voxel))));
  }
  const line = makeVolume([2, 2, 2], () => NaN);
  line.voxels[index(line, 0, 0, 0)] = 4;
  line.voxels[index(line, 1, 0, 0)] = 8;
  close(sampleVolume(line, [0.5, 0, 0]), 6);
  close(sampleVolume(makeVolume([1, 1, 1], () => 17), [0, 0, 0]), 17);
});

test('explicit missing slices override finite values and prevent interpolation on either side', () => {
  const volume = makeVolume([2, 2, 3], (_x, _y, z) => z + 10, { missingSlices: [1], complete: false });
  close(sampleVolume(volume, [0.25, 0.5, 0]), 10);
  close(sampleVolume(volume, [0.25, 0.5, 2]), 12);
  for (const z of [0.01, 0.5, 1, 1.5, 1.99]) assert.ok(Number.isNaN(sampleVolume(volume, [0.25, 0.5, z])));
  const invalid = makeVolume([2, 2, 2], () => 1);
  invalid.voxels[7] = Infinity;
  assert.ok(Number.isNaN(sampleVolume(invalid, [0.5, 0.5, 0.5])));
  close(sampleVolume(invalid, [0, 0, 0]), 1);
});

test('large patient origins preserve representable fractional samples and outside points', () => {
  const volume = makeVolume([2, 1, 1], x => 8 * x, { origin: [1e14, 0, 0] });
  close(sampleVolume(volume, [1e14 + 0.25, 0, 0]), 2);
  close(sampleVolume(volume, [1e14 + 0.5, 0, 0]), 4);
  assert.ok(Number.isNaN(sampleVolume(volume, [1e14 - 0.25, 0, 0])));
  assert.ok(Number.isNaN(sampleVolume(volume, [1e14 + 1.25, 0, 0])));
});

test('threshold plane has local oblique positions, outward unit normals, and honest metadata', () => {
  const volume = makeVolume([4, 3, 3], x => x, {
    spacing: [2, 3, 4], origin: [1e12, -2e12, 3e12], directions: oblique,
    warnings: ['Source warning'],
  });
  const surface = extractTomographySurface(volume, { threshold: 1.25, stride: 1 });
  assert.equal(surface.triangles, 8);
  assert.ok(surface.positions instanceof Float32Array);
  assert.ok(surface.normals instanceof Float32Array);
  for (let i = 0; i < surface.positions.length; i += 3) {
    const p = [...surface.positions.subarray(i, i + 3)];
    close(dot(p, oblique[0]), 2.5, 1e-6);
    assert.ok(dot(p, oblique[1]) >= -1e-6 && dot(p, oblique[1]) <= 6 + 1e-6);
    assert.ok(dot(p, oblique[2]) >= -1e-6 && dot(p, oblique[2]) <= 8 + 1e-6);
  }
  checkNormalsAndWinding(surface, oblique[0].map(value => -value));
  assert.equal(surface.volumeId, volume.id);
  assert.equal(surface.threshold, 1.25);
  assert.equal(surface.stride, 1);
  assert.deepEqual(surface.effectiveSpacing, [2, 3, 4]);
  assert.deepEqual(surface.origin, volume.origin);
  assert.notEqual(surface.origin, volume.origin);
  assert.equal(surface.complete, true);
  assert.equal(surface.quantitativeMeasurementsAllowed, false);
  assert.equal(surface.method, 'threshold-isosurface');
  assert.ok(surface.warnings.includes('Source warning'));
  assert.match(surface.warnings.join(' '), /not anatomical segmentation/i);
  assert.deepEqual(volume.warnings, ['Source warning']);
});

test('mixed-axis threshold planes account for anisotropy and reflected direction frames', () => {
  for (const directions of [oblique, [oblique[0], oblique[1], oblique[2].map(value => -value)]]) {
    const volume = makeVolume([3, 3, 3], (x, y, z) => x + 2 * y + 3 * z,
      { spacing: [2, 3, 4], directions });
    const surface = extractTomographySurface(volume, { threshold: 2.5, stride: 1 });
    assert.ok(surface.triangles > 0);
    const gradient = [0, 1, 2].map(axis => directions[0][axis] / 2 + 2 * directions[1][axis] / 3 + 3 * directions[2][axis] / 4);
    const outward = gradient.map(value => -value / Math.hypot(...gradient));
    checkNormalsAndWinding(surface, outward);
    for (let i = 0; i < surface.positions.length; i += 3) {
      close(dot([...surface.positions.subarray(i, i + 3)], gradient), 2.5, 1e-6);
    }
  }
});

test('threshold equality stays finite and full/empty fields receive no artificial edge caps', () => {
  const plane = extractTomographySurface(makeVolume([3, 3, 3], (_x, _y, z) => z), { threshold: 1, stride: 1 });
  assert.equal(plane.triangles, 8);
  for (let i = 2; i < plane.positions.length; i += 3) assert.equal(plane.positions[i], 1);
  checkNormalsAndWinding(plane, [0, 0, -1]);
  for (const value of [-1, 0, 1]) {
    const result = extractTomographySurface(makeVolume([3, 3, 3], () => value), { threshold: 0, stride: 1 });
    assert.equal(result.triangles, 0);
    assert.equal(result.positions.length, 0);
    assert.equal(result.normals.length, 0);
  }
});

test('explicit stride preserves oblique mm spacing and includes narrower final boundary cells', () => {
  const volume = makeVolume([6, 6, 6], x => x, { spacing: [2, 3, 4], directions: oblique });
  const surface = extractTomographySurface(volume, { threshold: 1.5, stride: 3 });
  assert.equal(surface.stride, 3);
  assert.equal(surface.triangles, 8);
  assert.deepEqual(surface.effectiveSpacing, [6, 9, 12]);
  let maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < surface.positions.length; i += 3) {
    const p = [...surface.positions.subarray(i, i + 3)];
    close(dot(p, oblique[0]), 3, 2e-6);
    maxY = Math.max(maxY, dot(p, oblique[1]));
    maxZ = Math.max(maxZ, dot(p, oblique[2]));
  }
  close(maxY, 15, 2e-6);
  close(maxZ, 20, 2e-6);
  checkNormalsAndWinding(surface, oblique[0].map(value => -value));
});

test('missing slice inside an unsampled stride span is omitted without bridging or caps', () => {
  const volume = makeVolume([3, 3, 5], x => x, { missingSlices: [1], complete: false });
  const surface = extractTomographySurface(volume, { threshold: 0.5, stride: 2 });
  assert.equal(surface.triangles, 2);
  for (let i = 2; i < surface.positions.length; i += 3) assert.ok(surface.positions[i] >= 2);
  assert.equal(surface.complete, false);
  assert.match(surface.warnings.join(' '), /missing/i);
  const all = makeVolume([3, 3, 3], x => x, { missingSlices: [1] });
  assert.equal(extractTomographySurface(all, { threshold: 0.5, stride: 2 }).triangles, 0);
});

test('NaN source planes and interior padding skipped by stride are never filled', () => {
  const missingPlane = makeVolume([3, 3, 3], (x, _y, z) => z === 1 ? NaN : x);
  const surface = extractTomographySurface(missingPlane, { threshold: 0.5, stride: 2 });
  assert.equal(surface.triangles, 0);
  assert.equal(surface.complete, false);
  const padding = makeVolume([3, 3, 3], x => x);
  padding.voxels[index(padding, 1, 1, 1)] = NaN;
  assert.equal(extractTomographySurface(padding, { threshold: 0.5, stride: 2 }).triangles, 0);
  const adjacent = makeVolume([2, 2, 2], x => x);
  adjacent.voxels[7] = NaN;
  assert.equal(extractTomographySurface(adjacent, { threshold: 0.5, stride: 1 }).triangles, 0);
});

test('uniform coarse cells with unsampled NaNs still report incomplete source data', () => {
  const volume = makeVolume([3, 3, 3], () => -1);
  volume.voxels[index(volume, 1, 1, 1)] = NaN;
  for (const stride of [1, 2]) {
    const surface = extractTomographySurface(volume, { threshold: 0, stride });
    assert.equal(surface.triangles, 0);
    assert.equal(surface.complete, false);
    assert.match(surface.warnings.join(' '), /incomplete source data/i);
  }
});

test('a lone threshold-equal corner does not produce collapsed triangles', () => {
  const volume = makeVolume([2, 2, 2], () => -1);
  volume.voxels[0] = 0;
  assert.equal(extractTomographySurface(volume, { threshold: 0, stride: 1 }).triangles, 0);
});

test('maximum explicit stride remains eight and preserves narrower final cells', () => {
  const volume = makeVolume([10, 10, 10], x => x);
  const surface = extractTomographySurface(volume, { threshold: 8.5, stride: 8 });
  assert.equal(surface.stride, 8);
  assert.equal(surface.triangles, 8);
  assert.deepEqual(surface.effectiveSpacing, [8, 8, 8]);
  let maxY = 0, maxZ = 0;
  for (let i = 0; i < surface.positions.length; i += 3) {
    assert.equal(surface.positions[i], 8.5);
    maxY = Math.max(maxY, surface.positions[i + 1]);
    maxZ = Math.max(maxZ, surface.positions[i + 2]);
  }
  assert.equal(maxY, 9);
  assert.equal(maxZ, 9);
  checkNormalsAndWinding(surface, [-1, 0, 0]);
});

test('triangle capacity is inclusive and overflow throws without mutating input or increasing stride', () => {
  const volume = makeVolume([2, 2, 2], x => x);
  const original = volume.voxels.slice();
  const exact = extractTomographySurface(volume, { threshold: 0.5, stride: 1, maxTriangles: 2 });
  assert.equal(exact.triangles, 2);
  assert.throws(() => extractTomographySurface(volume, { threshold: 0.5, stride: 1, maxTriangles: 1 }), /1 triangle limit.*no partial surface/i);
  assert.deepEqual(volume.voxels, original);
  const largePlane = makeVolume([2, 550, 550], x => x);
  assert.throws(() => extractTomographySurface(largePlane, { threshold: 0.5, stride: 1 }), /600,000 triangle limit/i);
});

test('invalid sampling strides, thresholds, and triangle budgets fail explicitly', () => {
  const volume = makeVolume();
  for (const stride of [0, -1, 1.5, 9, NaN, Infinity]) {
    assert.throws(() => extractTomographySurface(volume, { threshold: 1, stride }), /stride.*integer.*1.*8/i);
  }
  for (const threshold of [NaN, Infinity, -Infinity]) {
    assert.throws(() => extractTomographySurface(volume, { threshold, stride: 1 }), /threshold.*finite/i);
  }
  for (const maxTriangles of [0, -1, 1.5, 1_000_001, NaN, Infinity]) {
    assert.throws(() => extractTomographySurface(volume, { threshold: 1, stride: 1, maxTriangles }), /triangle limit/i);
  }
});

test('invalid volume storage, spacing, directions, or missing indices cannot create unsafe geometry', () => {
  for (const overrides of [
    { dimensions: [0, 3, 3] }, { dimensions: [2.5, 3, 3] }, { voxels: new Float32Array(2) },
    { spacing: [1, 0, 1] }, { spacing: [1, Infinity, 1] }, { origin: [0, NaN, 0] },
    { directions: [[1, 0, 0], [1, 0, 0], [0, 0, 1]] }, { missingSlices: [3] }, { missingSlices: [0.5] },
  ]) {
    assert.throws(() => extractTomographySurface(makeVolume([3, 3, 3], undefined, overrides), { threshold: 1, stride: 1 }));
  }
  const thin = extractTomographySurface(makeVolume([1, 3, 3]), { threshold: 1, stride: 1 });
  assert.equal(thin.triangles, 0);
  assert.match(thin.warnings.join(' '), /two sample planes/i);
});

test('extraction cancellation is checked initially and during bounded chunks of work', () => {
  const volume = makeVolume([80, 80, 2], x => x);
  assert.throws(() => extractTomographySurface(volume, { threshold: 0.5, stride: 1, shouldCancel: () => true }), { name: 'AbortError' });
  let checks = 0;
  assert.throws(() => extractTomographySurface(volume, {
    threshold: 0.5, stride: 1, shouldCancel: () => ++checks >= 5,
  }), { name: 'AbortError' });
  assert.equal(checks, 5);
});
