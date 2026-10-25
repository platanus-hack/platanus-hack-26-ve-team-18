import test from 'node:test';
import assert from 'node:assert/strict';
import { Euler, Matrix4, SphereGeometry, Vector3 } from 'three';
import { alignOpticalScansToCbct } from '../src/cbct-auto-alignment.ts';
import { extractTomographySurface } from '../src/tomography-geometry.ts';

const crowns = [
  [15, 16, 16, 2.3, 3.2, 3.3], [15.5, 24, 17, 2.2, 3, 3.1],
  [20, 31, 17.5, 2.4, 2.8, 2.8], [26, 35, 18, 2.4, 2, 3],
  [32, 35.5, 17, 2.5, 2, 2.6], [38, 33, 16.5, 2.3, 2.5, 2.8],
  [42, 27, 16, 2.2, 3, 3.2], [43, 19, 15, 2.7, 3.5, 3.5],
];
const identity = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const oblique = [
  [1 / Math.sqrt(2), 1 / Math.sqrt(2), 0],
  [-1 / Math.sqrt(6), 1 / Math.sqrt(6), 2 / Math.sqrt(6)],
  [1 / Math.sqrt(3), -1 / Math.sqrt(3), 1 / Math.sqrt(3)],
];

// Disconnected crowns form an intentionally asymmetric dental arch. Lower-density
// bone well away from that band must not attract the fit to a whole-skull center.
function dentalVolume({ extraCrowns = [], ...overrides } = {}) {
  const allCrowns = [...crowns, ...extraCrowns];
  const dimensions = [102, 88, 64], spacing = [.6, .65, .55];
  const voxels = new Float32Array(dimensions.reduce((a, b) => a * b));
  for (let z = 0; z < dimensions[2]; z++) for (let y = 0; y < dimensions[1]; y++) for (let x = 0; x < dimensions[0]; x++) {
    const p = [x * spacing[0], y * spacing[1], z * spacing[2]];
    let value = 0;
    if (z < 9 && x > 10 && x < 90 && y > 8 && y < 80) value = 500;
    for (const c of allCrowns) if (c.slice(0, 3).reduce((sum, v, i) => sum + ((p[i] - v) / c[i + 3]) ** 2, 0) < 1) { value = 2000; break; }
    voxels[x + dimensions[0] * (y + dimensions[1] * z)] = value;
  }
  return {
    id: 'synthetic-dental-volume', dimensions, spacing, origin: [0, 0, 0], directions: identity,
    voxels, range: [0, 2000], missingSlices: [], complete: true, quantitativeMeasurementsAllowed: true, warnings: [],
    provenance: { source: 'local-dicom', sourceSlices: dimensions[2], expectedSlices: dimensions[2], duplicateSlices: 0,
      transferSyntaxes: [], rescaled: true, intensityUnits: 'rescaled values', paddingVoxels: 0,
      missingDataPolicy: 'reject', interpolated: false },
    ...overrides,
  };
}

function positionsFor(volume, delta, mmPerUnit = 1) {
  const surface = extractTomographySurface(volume, { threshold: 1250, stride: 1 });
  const inverse = delta.clone().invert(), point = new Vector3();
  const positions = new Float64Array(surface.positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    point.fromArray(surface.positions, i).add(new Vector3(...volume.origin)).multiplyScalar(1 / mmPerUnit).applyMatrix4(inverse).toArray(positions, i);
  }
  return positions;
}

function independentOpticalPositions(delta, shapes = crowns) {
  const sphere = new SphereGeometry(1, 24, 16).toNonIndexed();
  const points = sphere.getAttribute('position'), inverse = delta.clone().invert();
  const positions = new Float64Array(points.count * 3 * shapes.length);
  let offset = 0;
  for (const crown of shapes) for (let i = 0; i < points.count; i++) {
    new Vector3(points.getX(i) * crown[3] + crown[0], points.getY(i) * crown[4] + crown[1], points.getZ(i) * crown[5] + crown[2])
      .applyMatrix4(inverse).toArray(positions, offset); offset += 3;
  }
  sphere.dispose();
  return positions;
}

function transformError(actual, expected, positions) {
  let squares = 0, count = 0;
  for (let i = 0; i < positions.length; i += 39) {
    const p = new Vector3().fromArray(positions, i);
    squares += p.clone().applyMatrix4(actual).distanceToSquared(p.applyMatrix4(expected)); count++;
  }
  return Math.sqrt(squares / count);
}

function assertRigid(matrix) {
  const e = matrix.elements;
  assert.ok(Math.abs(matrix.determinant() - 1) < 1e-8, 'proper rigid rotation, without reflection or scale');
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const dot = e[i * 4] * e[j * 4] + e[i * 4 + 1] * e[j * 4 + 1] + e[i * 4 + 2] * e[j * 4 + 2];
    assert.ok(Math.abs(dot - Number(i === j)) < 1e-8);
  }
  assert.deepEqual([e[3], e[7], e[11], e[15]], [0, 0, 0, 1]);
}

const volume = dentalVolume();

test('multistart dense-band fit recovers large translation and moderate rotation without rescaling', () => {
  const expected = new Matrix4().makeRotationFromEuler(new Euler(.24, -.31, .42)).setPosition(135, -92, 71);
  const positions = independentOpticalPositions(expected), before = positions.slice(), voxelsBefore = volume.voxels.slice();
  // Separate sources already share a pose. One rigid delta must preserve their bite relationship.
  const split = Math.floor(positions.length / 18) * 9;
  const sources = [{ id: 'upper', positions: positions.slice(0, split) }, { id: 'lower-and-bite', positions: positions.slice(split) }];
  const result = alignOpticalScansToCbct({ volume, sources, mmPerUnit: 1 });
  const actual = new Matrix4().fromArray(result.matrix);
  assertRigid(actual);
  assert.ok(transformError(actual, expected, positions) < .35, JSON.stringify(result));
  assert.ok(result.coverage > .9);
  assert.ok(result.medianMm < .3 && result.rmsMm < .3);
  assert.ok(result.samples >= 100 && result.durationMs < 20_000);
  assert.ok(result.threshold > 500 && result.threshold < 2000, 'target excludes lower-density bone');
  const a = new Vector3().fromArray(sources[0].positions), b = new Vector3().fromArray(sources[1].positions);
  const gap = a.distanceTo(b);
  assert.ok(Math.abs(a.applyMatrix4(actual).distanceTo(b.applyMatrix4(actual)) - gap) < 1e-9);
  assert.deepEqual(positions, before);
  assert.deepEqual(volume.voxels, voxelsBefore);
});

test('anisotropic oblique DICOM with nonzero origin and explicit non-mm units retains the correct absolute patient frame', () => {
  const oriented = { ...volume, origin: [148.5, -72.3, 57.1], directions: oblique };
  const expected = new Matrix4().makeRotationFromEuler(new Euler(-.23, .33, -.29)).setPosition(-38, 56, -24);
  const mmPerUnit = 2.5, positions = positionsFor(oriented, expected, mmPerUnit);
  const result = alignOpticalScansToCbct({ volume: oriented, sources: [{ id: 'posed-arch', positions }], mmPerUnit });
  const actual = new Matrix4().fromArray(result.matrix);
  assertRigid(actual);
  assert.ok(transformError(actual, expected, positions) * mmPerUnit < .35, JSON.stringify(result));
  assert.ok(result.coverage > .9 && result.medianMm < .3);
});

test('invalid scale, empty, malformed and degenerate optical sources fail explicitly', () => {
  const positions = positionsFor(volume, new Matrix4());
  for (const mmPerUnit of [0, -1, NaN, Infinity, 1e7]) assert.throws(() => alignOpticalScansToCbct({ volume, sources: [{ id: 'scan', positions }], mmPerUnit }), /scale|unit/i);
  assert.throws(() => alignOpticalScansToCbct({ volume, sources: [], mmPerUnit: 1 }), /source/i);
  for (const bad of [new Float64Array(), new Float64Array(8), new Float64Array(90), new Float64Array([NaN, 0, 0, 1, 0, 0, 0, 1, 0])]) {
    assert.throws(() => alignOpticalScansToCbct({ volume, sources: [{ id: 'scan', positions: bad }], mmPerUnit: 1 }), /triangle|surface|finite/i);
  }
});

test('constant, malformed, tiny and unsuitable volumes fail rather than inventing a registration', () => {
  const positions = positionsFor(volume, new Matrix4()), input = { sources: [{ id: 'scan', positions }], mmPerUnit: 1 };
  for (const bad of [
    { ...volume, voxels: new Float32Array(volume.voxels.length) },
    { ...volume, missingSlices: [-1] },
    { ...volume, spacing: [0, .5, .5] },
    { ...volume, directions: [[1, 0, 0], [0, 2, 0], [0, 0, 1]] },
    { ...volume, dimensions: [1, 2, 3], voxels: new Float32Array(6) },
  ]) assert.throws(() => alignOpticalScansToCbct({ ...input, volume: bad }), /volume|contrast|spacing|direction/i);
});

test('poor full-surface support and wrong confirmed physical scale are rejected', () => {
  const positions = positionsFor(volume, new Matrix4());
  const huge = positions.map((v, i) => (v - [29, 26, 17][i % 3]) * 4);
  assert.throws(() => alignOpticalScansToCbct({ volume, sources: [{ id: 'unsuitable-scan', positions: huge }], mmPerUnit: 1 }), /support|extent|time/i);
  assert.throws(() => alignOpticalScansToCbct({ volume, sources: [{ id: 'wrong-scale', positions }], mmPerUnit: .2 }), /support|extent|time/i);
});

test('a well-supported large source cannot hide an unrelated smaller source', () => {
  const positions = positionsFor(volume, new Matrix4());
  const small = positions.slice(0, Math.floor(positions.length / 90) * 9);
  for (let i = 0; i < small.length; i += 3) { small[i] += 100; small[i + 2] -= 60; }
  assert.throws(() => alignOpticalScansToCbct({ volume, sources: [{ id: 'arch', positions }, { id: 'unrelated-bite', positions: small }], mmPerUnit: 1 }), /support|ambiguous/i);
});

test('cooperative cancellation rejects before CPU work', () => {
  const controller = new AbortController(); controller.abort();
  assert.throws(() => alignOpticalScansToCbct({ volume, sources: [], mmPerUnit: 1 }, controller.signal), { name: 'AbortError' });
});

test('isotropic dense objects and flat optical patches do not count as supported dental alignment', () => {
  const dimensions = [35, 35, 35], voxels = new Float32Array(35 ** 3);
  for (let z = 0; z < 35; z++) for (let y = 0; y < 35; y++) for (let x = 0; x < 35; x++) {
    if ((x - 17) ** 2 + (y - 17) ** 2 + (z - 17) ** 2 < 7 ** 2) voxels[x + 35 * (y + 35 * z)] = 2000;
  }
  const spherical = { ...volume, dimensions, voxels, spacing: [1, 1, 1] };
  assert.throws(() => alignOpticalScansToCbct({ volume: spherical, sources: [{ id: 'sphere', positions: positionsFor(spherical, new Matrix4()) }], mmPerUnit: 1 }), /band|dentition|ambiguous/i);
  const flat = new Float64Array([0, 0, 0, 30, 0, 0, 0, 30, 0]);
  assert.throws(() => alignOpticalScansToCbct({ volume, sources: [{ id: 'plane', positions: flat }], mmPerUnit: 1 }), /extent|support/i);
});

test('worker contract echoes IDs and reports a clear failure before recovering on a valid request', async () => {
  const previousMessage = globalThis.onmessage, previousPost = globalThis.postMessage;
  const messages = [];
  globalThis.postMessage = message => messages.push(message);
  try {
    await import('../src/cbct-alignment.worker.ts');
    globalThis.onmessage({ data: { id: 41, volume, sources: [], mmPerUnit: 0 } });
    assert.equal(messages[0].id, 41);
    assert.match(messages[0].error, /scale|unit/i);
    assert.equal(messages[0].result, undefined);
    const positions = positionsFor(volume, new Matrix4());
    globalThis.onmessage({ data: { id: 42, volume, sources: [{ id: 'scan', positions }], mmPerUnit: 1 } });
    assert.equal(messages[1].id, 42);
    assert.equal(messages[1].error, undefined);
    assert.ok(messages[1].result.coverage > .9);
    assertRigid(new Matrix4().fromArray(messages[1].result.matrix));
    globalThis.onmessage({ data: { id: 43, volume, sources: [{ id: 'scan', positions }], mmPerUnit: 1 } });
    assert.equal(messages[2].id, 43);
    const { durationMs: durationA, ...first } = messages[1].result;
    const { durationMs: durationB, ...second } = messages[2].result;
    assert.deepEqual(first, second, 'frozen deterministic samples produce the same fit and metrics');
  } finally {
    if (previousMessage === undefined) delete globalThis.onmessage; else globalThis.onmessage = previousMessage;
    if (previousPost === undefined) delete globalThis.postMessage; else globalThis.postMessage = previousPost;
  }
});

test('distinct similarly supported poses are rejected as ambiguous instead of being hidden by duplicate starts', () => {
  const extraCrowns = crowns.map(c => [29 - (c[1] - 26), 26 + (c[0] - 29), c[2], c[4], c[3], c[5]]);
  const ambiguousVolume = dentalVolume({ extraCrowns });
  const positions = independentOpticalPositions(new Matrix4());
  assert.throws(() => alignOpticalScansToCbct({ volume: ambiguousVolume, sources: [{ id: 'ambiguous-arch', positions }], mmPerUnit: 1 }), /ambiguous|different poses/i);
});


test('valid circular FOV NaN padding supports a preview fit even with less than 80 percent global finite voxels', () => {
  const voxels = volume.voxels.slice(), [nx, ny, nz] = volume.dimensions;
  let finite = 0;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const i = x + nx * (y + ny * z);
    if (Math.hypot(x * volume.spacing[0] - 30.3, y * volume.spacing[1] - 28.3) > 27.8) voxels[i] = NaN; else finite++;
  }
  assert.ok(finite / voxels.length < .8);
  const padded = { ...volume, voxels, complete: false, quantitativeMeasurementsAllowed: false };
  const before = voxels.slice(), positions = independentOpticalPositions(new Matrix4());
  const result = alignOpticalScansToCbct({ volume: padded, sources: [{ id: 'arch', positions }], mmPerUnit: 1 });
  assert.ok(result.coverage > .9 && result.medianMm < .3);
  assert.ok(transformError(new Matrix4().fromArray(result.matrix), new Matrix4(), positions) < .35);
  assert.equal(padded.complete, false);
  assert.equal(padded.quantitativeMeasurementsAllowed, false);
  assert.deepEqual(voxels, before, 'NaN padding remains unavailable and is never filled');
});

test('modest missing-plane gaps support a preview fit without interpolation or changing validity flags', () => {
  const missingSlices = [4, 11, 28, 34, 52, 60], voxels = volume.voxels.slice();
  const plane = volume.dimensions[0] * volume.dimensions[1];
  // One explicitly missing plane still has stored finite values: the index list
  // must make it unavailable just as surely as NaN-marked missing planes.
  for (const z of missingSlices.slice(1)) voxels.fill(NaN, z * plane, (z + 1) * plane);
  const preview = { ...volume, voxels, missingSlices, complete: false, quantitativeMeasurementsAllowed: false };
  const before = voxels.slice(), positions = independentOpticalPositions(new Matrix4());
  const result = alignOpticalScansToCbct({ volume: preview, sources: [{ id: 'arch', positions }], mmPerUnit: 1 });
  assert.ok(result.coverage > .6 && result.medianMm < .5, JSON.stringify(result));
  assert.ok(transformError(new Matrix4().fromArray(result.matrix), new Matrix4(), positions) < .5);
  assert.equal(preview.complete, false);
  assert.equal(preview.quantitativeMeasurementsAllowed, false);
  assert.deepEqual(preview.missingSlices, missingSlices);
  assert.deepEqual(voxels, before, 'missing samples are never interpolated');
});

test('severe missing dental-region coverage is rejected even when the remaining region has finite voxels', () => {
  const voxels = volume.voxels.slice(), [nx, ny, nz] = volume.dimensions;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    if (x * volume.spacing[0] < 34) voxels[x + nx * (y + ny * z)] = NaN;
  }
  const preview = { ...volume, voxels, complete: false, quantitativeMeasurementsAllowed: false };
  const positions = independentOpticalPositions(new Matrix4());
  assert.throws(() => alignOpticalScansToCbct({ volume: preview, sources: [{ id: 'arch', positions }], mmPerUnit: 1 }), /support|coverage|dentition|ambiguous/i);
});


// A real native-resolution crown surface above the old private 160k face cap,
// populated within crown bounding boxes so fixture construction stays cheap.
function highDensityDentalVolume() {
  const dimensions = [341, 273, 128], spacing = [.1175, .1175, .1175], origin = [9, 9, 9];
  const voxels = new Float32Array(dimensions.reduce((a, b) => a * b));
  for (const crown of crowns) {
    const lo = crown.slice(0, 3).map((c, axis) => Math.max(0, Math.floor((c - crown[axis + 3] - origin[axis]) / spacing[axis])));
    const hi = crown.slice(0, 3).map((c, axis) => Math.min(dimensions[axis] - 1, Math.ceil((c + crown[axis + 3] - origin[axis]) / spacing[axis])));
    for (let z = lo[2]; z <= hi[2]; z++) for (let y = lo[1]; y <= hi[1]; y++) for (let x = lo[0]; x <= hi[0]; x++) {
      if (((origin[0] + x * spacing[0] - crown[0]) / crown[3]) ** 2
        + ((origin[1] + y * spacing[1] - crown[1]) / crown[4]) ** 2
        + ((origin[2] + z * spacing[2] - crown[2]) / crown[5]) ** 2 < 1) voxels[x + dimensions[0] * (y + dimensions[1] * z)] = 2000;
    }
  }
  return { ...volume, dimensions, spacing, origin, voxels };
}

test('dense native CBCT above 160k triangles uses bounded registration samples and recovers the rigid crown pose', () => {
  const dense = highDensityDentalVolume(), voxelsBefore = dense.voxels.slice();
  assert.throws(() => extractTomographySurface(dense, { threshold: 1000, stride: 1, maxTriangles: 160_000 }), /160,000 triangle limit/);
  const expected = new Matrix4().makeRotationFromEuler(new Euler(.18, -.24, .37)).setPosition(82, -54, 31);
  const positions = independentOpticalPositions(expected), positionsBefore = positions.slice();
  const result = alignOpticalScansToCbct({ volume: dense, sources: [{ id: 'dense-arch', positions }], mmPerUnit: 1 });
  const actual = new Matrix4().fromArray(result.matrix);
  assertRigid(actual);
  assert.ok(transformError(actual, expected, positions) < .35, JSON.stringify(result));
  assert.ok(result.coverage > .9 && result.medianMm < .3, JSON.stringify(result));
  assert.ok(result.durationMs < 18_000);
  assert.equal(result.registrationTarget.method, 'spatially-sampled-native-isosurface');
  assert.ok(result.registrationTarget.nativeTriangles > 160_000);
  assert.ok(result.registrationTarget.samples <= 48_000);
  assert.ok(result.registrationTarget.samples < result.registrationTarget.nativeTriangles);
  assert.ok(result.registrationTarget.samplingCellMm > .125, 'adaptive sample coarsening is explicitly reported');
  assert.deepEqual(result.registrationTarget.voxelSpacingMm, dense.spacing, 'native voxel resolution is retained');
  assert.deepEqual(dense.voxels, voxelsBefore);
  assert.deepEqual(positions, positionsBefore);
  assert.equal(dense.complete, true);
  assert.equal(dense.provenance.interpolated, false);

  const wrong = positions.map((v, i) => v * (i % 3 === 2 ? 4 : 2));
  assert.throws(() => alignOpticalScansToCbct({ volume: dense, sources: [{ id: 'poor-support', positions: wrong }], mmPerUnit: 1 }), /support|extent|time/);
});

test('the current shared pose remains a candidate when another jaw displaces the target center', () => {
  const extraCrowns = crowns.map(c => [c[0] + 5, c[1] - 5, c[2] + 10, c[3] * 1.25, c[4] * 1.25, c[5]]);
  const twoJaws = dentalVolume({ extraCrowns });
  const expected = new Matrix4().makeRotationFromEuler(new Euler(.015, -.02, .01)).setPosition(.2, -.15, .1);
  const positions = independentOpticalPositions(expected);
  const result = alignOpticalScansToCbct({ volume: twoJaws, sources: [{ id: 'already-near-jaw', positions }], mmPerUnit: 1 });
  const actual = new Matrix4().fromArray(result.matrix);
  assertRigid(actual);
  assert.ok(transformError(actual, expected, positions) < .35, JSON.stringify(result));
  assert.ok(result.coverage > .9);
});

test('large absolute origins preserve oriented precision and the one unscaled shared delta', () => {
  const oriented = { ...volume, origin: [1e9 + .125, -3e8 + .25, 4e8 + .375], directions: oblique };
  const expected = new Matrix4().makeRotationFromEuler(new Euler(-.12, .24, -.18)).setPosition(37, -26, 15);
  const mmPerUnit = 2.5, positions = positionsFor(oriented, expected, mmPerUnit), before = positions.slice();
  const result = alignOpticalScansToCbct({ volume: oriented, sources: [{ id: 'large-origin', positions }], mmPerUnit });
  const actual = new Matrix4().fromArray(result.matrix);
  assertRigid(actual);
  assert.ok(transformError(actual, expected, positions) * mmPerUnit < .35, JSON.stringify(result));
  assert.deepEqual(positions, before);
  assert.deepEqual(oriented.origin, [1e9 + .125, -3e8 + .25, 4e8 + .375]);
  assert.deepEqual(oriented.directions, oblique);
});

test('an exhausted target-construction deadline and mid-work cancellation stay explicit', () => {
  const positions = independentOpticalPositions(new Matrix4());
  const original = performance.now;
  let ticks = 0;
  try {
    performance.now = () => ++ticks * 1000;
    assert.throws(() => alignOpticalScansToCbct({ volume, sources: [{ id: 'bounded-time', positions }], mmPerUnit: 1 }), /bounded search time/);
  } finally {
    performance.now = original;
  }
  let checks = 0;
  const signal = { get aborted() { return ++checks > 20; } };
  assert.throws(() => alignOpticalScansToCbct({ volume, sources: [{ id: 'cancelled', positions }], mmPerUnit: 1 }, signal), { name: 'AbortError' });
});


test('ambiguous crown/skull support fails instead of accepting a plausible outer-bone fit', () => {
  const jaw = { ...volume, voxels: volume.voxels.slice() }, [nx, ny, nz] = jaw.dimensions;
  for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const p = [x * jaw.spacing[0], y * jaw.spacing[1], z * jaw.spacing[2]], index = x + nx * (y + ny * z);
    const shell = ((p[0] - 29) / 26) ** 2 + ((p[1] - 26) / 23) ** 2 + ((p[2] - 8) / 6) ** 2;
    if (shell > .8 && shell < 1) jaw.voxels[index] = 2000;
    // Connected lower-density jaw tissue is not optical enamel; its location
    // must not turn a crown fit into projection onto an outer bone envelope.
    if (p[2] > 8 && p[2] < 13 && p[0] > 12 && p[0] < 46 && p[1] > 13 && p[1] < 39 && !jaw.voxels[index]) jaw.voxels[index] = 800;
  }
  const expected = new Matrix4().makeRotationFromEuler(new Euler(.07, -.11, .13)).setPosition(9, -7, 4);
  const opticalCrowns = independentOpticalPositions(expected);
  const gums = independentOpticalPositions(expected, crowns.map(c => [c[0], c[1], c[2] - 5.5, c[3] * .8, c[4] * .8, 1]));
  const positions = new Float64Array(opticalCrowns.length + gums.length);
  positions.set(opticalCrowns); positions.set(gums, opticalCrowns.length);
  assert.throws(() => alignOpticalScansToCbct({ volume: jaw, sources: [{ id: 'crowns-and-gingiva', positions }], mmPerUnit: 1 }), /ambiguous|support/i);
});

test('independent crown regions fit a gingiva/palate scan and keep full-pool metrics honest', () => {
  const expected = new Matrix4().makeRotationFromEuler(new Euler(.07, -.11, .13)).setPosition(9, -7, 4);
  const opticalCrowns = independentOpticalPositions(expected);
  const gums = independentOpticalPositions(expected, crowns.map(c => [c[0], c[1], c[2] - 5.5, c[3] * .8, c[4] * .8, 1]));
  const palate = new Float64Array([16, 15, 9, 42, 15, 9, 42, 35, 9, 16, 15, 9, 42, 35, 9, 16, 35, 9]);
  const inverse = expected.clone().invert();
  for (let i = 0; i < palate.length; i += 3) new Vector3().fromArray(palate, i).applyMatrix4(inverse).toArray(palate, i);
  const positions = new Float64Array(opticalCrowns.length + gums.length + palate.length);
  positions.set(opticalCrowns); positions.set(gums, opticalCrowns.length); positions.set(palate, opticalCrowns.length + gums.length);
  const result = alignOpticalScansToCbct({ volume, sources: [{ id: 'crowns-gingiva-palate', positions }], mmPerUnit: 1 });
  const actual = new Matrix4().fromArray(result.matrix);
  assertRigid(actual);
  assert.ok(transformError(actual, expected, opticalCrowns) < .35, JSON.stringify(result));
  // Check anterior and both posterior ends, rather than a matching center alone.
  for (const crown of [crowns[0], crowns[3], crowns[7]]) {
    assert.ok(new Vector3(...crown.slice(0, 3)).applyMatrix4(inverse).applyMatrix4(actual).distanceTo(new Vector3(...crown.slice(0, 3))) < .35);
  }
  assert.equal(result.registrationSupport.method, 'heuristic-crown-regions');
  assert.ok(result.registrationSupport.coverage > .9);
  assert.ok(result.coverage < .55, 'full optical pool is never relabelled as crown-only coverage');
  assert.ok(result.rmsMm > 2 && result.rmsMm > result.registrationSupport.inlierRmsMm * 5, 'unmatched palate contributes to the full RMS');
  const support = result.registrationSupport.perSource[0];
  assert.ok(support.regions >= 3 && support.supportedRegions >= 3 && support.coverage > .9);
});
