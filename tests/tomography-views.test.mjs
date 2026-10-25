import test from 'node:test';
import assert from 'node:assert/strict';
import { generateRestoration } from '../src/restoration-geometry.ts';
import {
  buildTomographyContours, getSliceFrame, initialTomographyWindow, intersectMeshPlane, intersectTrianglePlane,
  patientToPixel, pixelToPatient, projectSegmentToSlice, resliceVolume, transformPartToPatient,
} from '../src/tomography-views.ts';

const close = (actual, expected, tolerance = 1e-9) => assert.ok(
  Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance,
  `${actual} differs from ${expected} by more than ${tolerance}`,
);
function closeVector(actual, expected, tolerance = 1e-9) {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, index) => close(value, expected[index], tolerance));
}
const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const pointClose = (a, b, tolerance) => a.length === b.length && a.every((value, index) => Math.abs(value - b[index]) <= tolerance);
function closeSegments(actual, expected, tolerance = 1e-9) {
  assert.equal(actual.length, expected.length, 'segment count');
  const remaining = expected.slice();
  for (const segment of actual) {
    const index = remaining.findIndex(candidate =>
      pointClose(segment[0], candidate[0], tolerance) && pointClose(segment[1], candidate[1], tolerance)
      || pointClose(segment[0], candidate[1], tolerance) && pointClose(segment[1], candidate[0], tolerance));
    assert.notEqual(index, -1, `Unexpected segment ${JSON.stringify(segment)}`);
    remaining.splice(index, 1);
  }
}
const nativeAxes = {
  axial: { right: [1, 0, 0], up: [0, -1, 0], normal: [0, 0, -1] },
  coronal: { right: [1, 0, 0], up: [0, 0, 1], normal: [0, -1, 0] },
  sagittal: { right: [0, 1, 0], up: [0, 0, 1], normal: [1, 0, 0] },
};

test('initial presentation window suppresses sparse metal outliers without assuming HU', () => {
  const voxels = new Float32Array(1000);
  for (let i = 0; i < voxels.length; i++) voxels[i] = i - 500;
  voxels[999] = 15000;
  const volume = { dimensions: [10, 10, 10], voxels, missingSlices: [], range: [-500, 15000] };
  const window = initialTomographyWindow(volume);
  assert.equal(window.method, 'sampled-1-99-percentiles');
  assert.equal(window.sampleCount, 1000);
  assert.ok(window.windowWidth < 1000 && window.windowWidth > 900);
  assert.deepEqual(initialTomographyWindow(volume), window);
  assert.equal(volume.voxels[999], 15000);
});

test('initial window skips unavailable data and has a bounded finite fallback', () => {
  const volume = { dimensions: [2, 2, 2], voxels: Float32Array.of(0, 0, 0, 0, NaN, NaN, NaN, NaN), missingSlices: [1], range: [0, 0] };
  assert.deepEqual(initialTomographyWindow(volume), { windowCenter: 0, windowWidth: 1, method: 'volume-range', sampleCount: 4 });
  const large = { dimensions: [100, 100, 10], voxels: new Float32Array(100000).fill(1), missingSlices: [], range: [0, 2] };
  assert.equal(initialTomographyWindow(large).sampleCount, 8192);
});
const tiltedAxes = [[2 / 3, 2 / 3, -1 / 3], [-1 / 3, 2 / 3, 2 / 3], [2 / 3, -1 / 3, 2 / 3]];
const spec = (overrides = {}) => ({ plane: 'axial', center: [0, 0, 0], widthMm: 8, heightMm: 9, windowCenter: 50, windowWidth: 400, ...overrides });

// Independent fixture construction: DICOM column/row/stack axes have physical spacing.
function patientPoint(volume, index) {
  return volume.origin.map((origin, axis) => origin + index.reduce(
    (sum, value, voxelAxis) => sum + value * volume.spacing[voxelAxis] * volume.directions[voxelAxis][axis], 0,
  ));
}
function volumeFixture(overrides = {}, intensity = (x, y, z) => x + 10 * y + 100 * z) {
  const volume = {
    id: 'synthetic-local-volume', dimensions: [3, 3, 3], spacing: [1, 1, 1], origin: [0, 0, 0],
    directions: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], range: [0, 2000], missingSlices: [],
    complete: true, quantitativeMeasurementsAllowed: true, warnings: [],
    provenance: { source: 'local-dicom', sourceSlices: 3, expectedSlices: 3, duplicateSlices: 0,
      transferSyntaxes: [], rescaled: true, intensityUnits: 'HU', paddingVoxels: 0,
      missingDataPolicy: 'reject', interpolated: false },
    ...overrides,
  };
  if (!volume.voxels) {
    const [nx, ny, nz] = volume.dimensions;
    volume.voxels = new Float32Array(nx * ny * nz);
    for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      volume.voxels[x + nx * (y + ny * z)] = intensity(x, y, z, patientPoint(volume, [x, y, z]));
    }
  }
  return volume;
}
function sampleAtIndex(volume, index, view = {}) {
  return resliceVolume(volume, spec({ center: patientPoint(volume, index), ...view }), 1, 1)[0];
}
function partFixture(overrides = {}) {
  return { id: 'scan', name: 'Synthetic scan', fileName: 'synthetic.stl',
    positions: Float32Array.of(0, 0, -1, 2, 0, 1, 0, 2, 1), normals: new Float32Array(9),
    offset: [0, 0, 0], visible: true, closed: false, triangles: 1, vertices: 3, dimensions: [2, 2, 2],
    ...overrides };
}

test('numeric view exports import in Node without DOM globals', () => {
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(typeof globalThis.window, 'undefined');
  for (const numeric of [getSliceFrame, pixelToPatient, patientToPixel, resliceVolume, intersectTrianglePlane,
    intersectMeshPlane, projectSegmentToSlice, transformPartToPatient, buildTomographyContours]) assert.equal(typeof numeric, 'function');
});

for (const [plane, axes] of Object.entries(nativeAxes)) {
  test(`${plane} uses the declared LPS signs and a right-handed frame`, () => {
    const input = spec({ plane, center: [12, -4, 35], widthMm: 21, heightMm: 13 }), before = structuredClone(input);
    const frame = getSliceFrame(input);
    for (const axis of ['right', 'up', 'normal']) closeVector(frame[axis], axes[axis]);
    closeVector(cross(frame.up, frame.normal), frame.right);
    closeVector(cross(frame.right, frame.up), frame.normal);
    closeVector(frame.center, input.center);
    assert.notEqual(frame.center, input.center);
    assert.equal(frame.widthMm, 21); assert.equal(frame.heightMm, 13);
    assert.deepEqual(input, before);
  });
}

test('oblique directions form an orthonormal frame with right = up cross normal', () => {
  const frame = getSliceFrame(spec({ plane: 'oblique', normal: tiltedAxes[2], up: tiltedAxes[1] }));
  closeVector(frame.right, tiltedAxes[0]);
  closeVector(frame.up, tiltedAxes[1]);
  closeVector(frame.normal, tiltedAxes[2]);
  for (const axis of [frame.right, frame.up, frame.normal]) close(Math.hypot(...axis), 1);
  close(dot(frame.right, frame.up), 0); close(dot(frame.right, frame.normal), 0); close(dot(frame.up, frame.normal), 0);
  closeVector(cross(frame.up, frame.normal), frame.right);
});

test('pixel centers have independent physical expectations and inverse coordinates', () => {
  const frame = getSliceFrame(spec({ center: [10, 20, 30] }));
  closeVector(pixelToPatient(frame, 0, 0, 4, 3), [7, 17, 30]);
  closeVector(pixelToPatient(frame, 3, 2, 4, 3), [13, 23, 30]);
  closeVector(patientToPixel(frame, [10, 20, 30], 4, 3), [1.5, 1]);
  closeVector(patientToPixel(frame, [7, 17, 30], 4, 3), [0, 0]);
  closeVector(patientToPixel(frame, [13, 23, 30], 4, 3), [3, 2]);
  closeVector(pixelToPatient(frame, -.5, -.5, 4, 3), [6, 15.5, 30]);
});

test('pixel round trips preserve fractional coordinates and anisotropic millimeters in every frame', () => {
  for (const view of [
    ...Object.keys(nativeAxes).map(plane => ({ plane })),
    { plane: 'oblique', normal: tiltedAxes[2], up: tiltedAxes[1] },
  ]) {
    const frame = getSliceFrame(spec({ ...view, center: [100, -33, 21], widthMm: 35, heightMm: 12 }));
    for (const pixel of [[0, 0], [6, 3], [3, 1.5], [2.25, .75], [-.5, -.5], [6.5, 3.5]]) {
      closeVector(patientToPixel(frame, pixelToPatient(frame, ...pixel, 7, 4), 7, 4), pixel);
    }
    const a = pixelToPatient(frame, 1, 1, 7, 4), b = pixelToPatient(frame, 2, 1, 7, 4), c = pixelToPatient(frame, 1, 2, 7, 4);
    close(Math.hypot(...a.map((value, index) => value - b[index])), 5);
    close(Math.hypot(...a.map((value, index) => value - c[index])), 3);
    closeVector(pixelToPatient(frame, 3, 1.5, 7, 4), frame.center);
  }
});

test('patient-to-pixel projection discards only the normal component', () => {
  const frame = getSliceFrame(spec({ plane: 'oblique', normal: tiltedAxes[2], up: tiltedAxes[1], center: [13, -8, 7] }));
  const point = pixelToPatient(frame, 1.25, 2.5, 8, 6);
  closeVector(patientToPixel(frame, point.map((value, index) => value + 17 * frame.normal[index]), 8, 6), [1.25, 2.5]);
});

test('reslices reproduce an analytic patient-space scalar field with tilted acquisition axes, origin and spacing', () => {
  const scalar = ([x, y, z]) => 2 * x - 3 * y + 5 * z + 7;
  const volume = volumeFixture({ dimensions: [5, 4, 4], spacing: [1.5, 2.5, 4], origin: [11, -7, 19], directions: tiltedAxes },
    (_x, _y, _z, point) => scalar(point));
  const before = volume.voxels.slice(), center = patientPoint(volume, [2, 1.5, 1.25]);
  const views = [
    ...Object.entries(nativeAxes).map(([plane, axes]) => ({ plane, ...axes })),
    { plane: 'oblique', right: tiltedAxes[0], up: tiltedAxes[1], normal: tiltedAxes[2] },
  ];
  for (const { plane, right, up, normal } of views) {
    const pixels = resliceVolume(volume, spec({ plane, normal, up, center, widthMm: 2, heightMm: 2 }), 5, 3);
    assert.ok(pixels instanceof Float32Array); assert.equal(pixels.length, 15);
    for (let y = 0; y < 3; y++) for (let x = 0; x < 5; x++) {
      const dx = ((x + .5) / 5 - .5) * 2, dy = (.5 - (y + .5) / 3) * 2;
      const point = center.map((value, axis) => value + right[axis] * dx + up[axis] * dy);
      close(pixels[y * 5 + x], scalar(point), 3e-5);
    }
  }
  assert.deepEqual(volume.voxels, before);
});

test('trilinear reslicing preserves mixed corner terms at fractional acquisition indices', () => {
  const volume = volumeFixture({ dimensions: [2, 2, 2], origin: [10, 20, 30], spacing: [2, 3, 5],
    directions: [[3 / 5, 0, 4 / 5], [0, 1, 0], [-4 / 5, 0, 3 / 5]],
    voxels: Float32Array.of(0, 1, 10, 11, 100, 101, 110, 1111) });
  // f(i,j,k) = i + 10j + 100k + 1000ijk; (1/4,1/2,3/4) is [7.3,21.5,32.65] mm.
  const pixels = resliceVolume(volume, spec({ center: [7.3, 21.5, 32.65] }), 1, 1);
  close(pixels[0], 174, 1e-5);
});

for (const missingPolicy of ['NaN voxels', 'missingSlices metadata']) {
  test(`${missingPolicy} prevents reslice interpolation through unavailable planes`, () => {
    const volume = volumeFixture({ dimensions: [2, 2, 4], origin: [11, -7, 19], spacing: [1.5, 2.5, 4], directions: tiltedAxes,
      missingSlices: missingPolicy === 'missingSlices metadata' ? [1] : [], complete: false, quantitativeMeasurementsAllowed: false });
    if (missingPolicy === 'NaN voxels') volume.voxels.fill(NaN, 4, 8);
    for (const z of [.5, 1, 1.5]) assert.ok(Number.isNaN(sampleAtIndex(volume, [.25, .5, z])), `stack index ${z} must be unavailable`);
    for (const z of [0, 2, 2.5, 3]) close(sampleAtIndex(volume, [.25, .5, z]), .25 + 5 + 100 * z, 1e-5);
  });
}

test('NaN corners participate only with positive interpolation weight', () => {
  const volume = volumeFixture({ dimensions: [2, 2, 2] });
  volume.voxels[7] = NaN;
  assert.ok(Number.isNaN(sampleAtIndex(volume, [.5, .5, .5])));
  close(sampleAtIndex(volume, [0, 0, 0]), 0);
  close(sampleAtIndex(volume, [1, 0, 0]), 1);
  close(sampleAtIndex(volume, [.5, .5, 0]), 5.5);
});

test('reslices retain exact boundary centers, reject outside points and support singleton axes', () => {
  const volume = volumeFixture();
  close(sampleAtIndex(volume, [0, 0, 0]), 0); close(sampleAtIndex(volume, [2, 2, 2]), 222);
  for (const index of [[-.01, 1, 1], [2.01, 1, 1], [1, -.01, 1], [1, 2.01, 1], [1, 1, -.01], [1, 1, 2.01]]) {
    assert.ok(Number.isNaN(sampleAtIndex(volume, index)), `outside index ${index}`);
  }
  const single = volumeFixture({ dimensions: [1, 1, 1], origin: [10, -2, 8], voxels: Float32Array.of(42) });
  close(sampleAtIndex(single, [0, 0, 0]), 42);
  assert.ok(Number.isNaN(sampleAtIndex(single, [.1, 0, 0])));
});

test('a mean slab remains unavailable when any sampled source plane is missing', () => {
  const volume = volumeFixture({ dimensions: [2, 2, 5], missingSlices: [1], complete: false });
  assert.ok(Number.isNaN(sampleAtIndex(volume, [.5, .5, 2], { slabMm: 2 })));
  close(sampleAtIndex(volume, [.5, .5, 3], { slabMm: 2 }), 305.5);
});

test('triangle intersections locate analytic edge crossings independent of winding or normal sign', () => {
  const triangle = [[0, 0, -1], [2, 0, 1], [0, 2, 1]], expected = [[[1, 0, 0], [0, 1, 0]]];
  for (const normal of [[0, 0, 1], [0, 0, -1]]) for (const vertices of [triangle, triangle.toReversed()]) {
    closeSegments(intersectTrianglePlane(vertices, { center: [0, 0, 0], normal }), expected);
  }
  closeSegments(intersectTrianglePlane([[0, 0, 0], [2, 0, 0], [0, 2, 0]],
    { center: [.5, .5, 0], normal: [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)] }), expected);
});

test('triangle intersections preserve a coplanar boundary and an exactly on-plane edge', () => {
  const plane = { center: [0, 0, 2], normal: [0, 0, 1] }, triangle = [[0, 0, 2], [2, 0, 2], [0, 3, 2]];
  closeSegments(intersectTrianglePlane(triangle, plane), [[triangle[0], triangle[1]], [triangle[1], triangle[2]], [triangle[2], triangle[0]]]);
  closeSegments(intersectTrianglePlane([triangle[0], triangle[1], [0, 3, 4]], plane), [[triangle[0], triangle[1]]]);
});

test('an on-plane vertex joins a true crossing while same-side triangles miss', () => {
  const plane = getSliceFrame(spec({ center: [0, 0, 2] }));
  closeSegments(intersectTrianglePlane([[0, 0, 2], [2, 0, 4], [0, 3, 0]], plane), [[[0, 0, 2], [1, 1.5, 2]]]);
  assert.deepEqual(intersectTrianglePlane([[0, 0, 3], [2, 0, 4], [0, 3, 5]], plane), []);
  assert.deepEqual(intersectTrianglePlane([[0, 0, 1], [2, 0, 0], [0, 3, -1]], plane), []);
});

test('intersection tolerance applies consistently to triangles and flat mesh positions', () => {
  const triangle = [[0, 0, 1e-8], [2, 0, 1e-8], [0, 3, 1e-8]], plane = { center: [0, 0, 0], normal: [0, 0, 1] };
  closeSegments(intersectTrianglePlane(triangle, plane, 1e-7), [[triangle[0], triangle[1]], [triangle[1], triangle[2]], [triangle[2], triangle[0]]]);
  assert.deepEqual(intersectTrianglePlane(triangle, plane, 1e-10), []);
  assert.equal(intersectMeshPlane(triangle.flat(), plane, 1e-7).length, 3);
  assert.deepEqual(intersectMeshPlane(triangle.flat(), plane, 1e-10), []);
});

test('flat triangle meshes produce exact crossing segments and coplanar exterior edges', () => {
  const plane = { center: [0, 0, 0], normal: [0, 0, 1] };
  const positions = Float64Array.of(0, 0, -1, 2, 0, 1, 0, 2, 1, 5, 5, 2, 6, 5, 2, 5, 6, 2);
  closeSegments(intersectMeshPlane(positions, plane), [[[1, 0, 0], [0, 1, 0]]]);
  // Two coplanar triangles share a diagonal; only the square boundary remains.
  closeSegments(intersectMeshPlane([0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 0, 0, 2, 2, 0, 0, 2, 0], plane), [
    [[0, 0, 0], [2, 0, 0]], [[2, 0, 0], [2, 2, 0]], [[2, 2, 0], [0, 2, 0]], [[0, 2, 0], [0, 0, 0]],
  ]);
});

test('segment projection shares the raster pixel-center convention without clipping endpoints', () => {
  const frame = getSliceFrame(spec({ center: [10, 20, 30] }));
  const projected = projectSegmentToSlice([[7, 17, 30], [13, 23, 30]], frame, 4, 3);
  closeVector(projected[0], [0, 0]); closeVector(projected[1], [3, 2]);
  const edges = projectSegmentToSlice([[6, 15.5, 30], [14, 24.5, 30]], frame, 4, 3);
  closeVector(edges[0], [-.5, -.5]); closeVector(edges[1], [3.5, 2.5]);
});

test('part conversion composes saved pose, manual rotation and offset before explicit scaling', () => {
  const part = partFixture({ positions: Float32Array.of(10, 0, 2, 12, 0, 2, 10, 2, 2),
    pose: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 3, 7, 1], rotation: [0, 0, 90], offset: [1, 2, -1] });
  const before = structuredClone(part), converted = transformPartToPatient(part, 2);
  assert.ok(converted instanceof Float64Array);
  closeVector(converted, [36, 10, 16, 36, 14, 16, 32, 10, 16]);
  assert.notEqual(converted.buffer, part.positions.buffer);
  assert.deepEqual(part, before);
});

test('a generated component keeps its existing source frame and receives the viewer pose and scale once', () => {
  const [mesh] = generateRestoration({ version: 'implant-assembly/v1', fdi: 36, parentPartId: 'lower',
    frame: { origin: [100, -20, 30], u: [0, 1, 0], v: [0, 0, -1], up: [-1, 0, 0] },
    parameters: { fixture: { radius: 1.1, length: 5, depth: .4, taper: .3 },
      abutment: { radius: .8, height: 2.1, emergenceRadius: 1.3, angleX: 0, angleY: 0 },
      crown: { width: 5.2, depth: 4.6, height: 3.5, cuspHeight: 1.1, rotation: 0 } },
    anatomy: 'molar', provenance: 'hypothesized', units: 'file units (u)', source: 'Synthetic geometry test' });
  const part = partFixture({ ...mesh, id: 'generated-fixture', restoration: { assemblyId: 'assembly', component: 'fixture', parentPartId: 'lower' },
    pose: [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 5, 3, -2, 1], rotation: [90, 0, 0], offset: [-7, 11, 13] });
  const before = structuredClone(part), min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < part.positions.length; i++) { const axis = i % 3; min[axis] = Math.min(min[axis], part.positions[i]); max[axis] = Math.max(max[axis], part.positions[i]); }
  const cx = (min[0] + max[0]) / 2, cz = (min[2] + max[2]) / 2, converted = transformPartToPatient(part, .125);
  assert.ok(converted instanceof Float64Array); assert.equal(converted.length, part.positions.length);
  for (let i = 0; i < converted.length; i += 3) {
    const [x, y, z] = part.positions.subarray(i, i + 3);
    // Saved +90 Z rotation/translation, then +90 X about posed bounds center, then offset.
    closeVector(converted.subarray(i, i + 3), [-2 - y, 14 + cx - z + cz, 11 + cz + x - cx].map(value => value * .125));
  }
  assert.deepEqual(part, before);
});

function overlayFixture() {
  const upper = partFixture({ id: 'upper', role: 'upper' }), lower = partFixture({ id: 'lower', role: 'lower' });
  const generated = ['fixture', 'abutment', 'crown'].map(component => partFixture({ id: component,
    restoration: { assemblyId: 'assembly', component, parentPartId: 'upper' } }));
  return { parts: [upper, lower, ...generated,
    partFixture({ id: 'bite', role: 'bite' }), partFixture({ id: 'other', role: 'model' }),
    partFixture({ id: 'hidden', role: 'upper', visible: false }), partFixture({ id: 'derived-reference', role: 'upper' }),
    partFixture({ id: 'lower-crown', restoration: { assemblyId: 'other-assembly', component: 'crown', parentPartId: 'lower' } }),
    partFixture({ id: 'orphan', restoration: { assemblyId: 'missing', component: 'fixture', parentPartId: 'absent' } }),
  ], mmPerUnit: 2, registrations: [{ arch: 'upper', reviewed: true, rmsMm: .2 }, { arch: 'lower', reviewed: false, rmsMm: .1 }],
  excludedPartIds: ['derived-reference'] };
}

test('contours require explicit positive scale and a finite reviewed registration for their arch', () => {
  const frame = getSliceFrame(spec()), options = overlayFixture();
  for (const mmPerUnit of [null, 0, -1, NaN, Infinity]) assert.deepEqual(buildTomographyContours(frame, { ...options, mmPerUnit }), []);
  for (const registrations of [[], [{ arch: 'upper', reviewed: false, rmsMm: .2 }],
    [{ arch: 'lower', reviewed: true, rmsMm: .1 }], [{ arch: 'upper', reviewed: true, rmsMm: NaN }]]) {
    const parts = options.parts.filter(part => part.id !== 'lower' && part.id !== 'lower-crown');
    assert.deepEqual(buildTomographyContours(frame, { ...options, parts, registrations }), []);
  }
});

test('contours gate scan/restoration visibility and exclude bite, hidden, reference and unregistered parts', () => {
  const frame = getSliceFrame(spec()), options = overlayFixture(), before = structuredClone(options);
  const contours = buildTomographyContours(frame, options);
  assert.deepEqual(contours.map(contour => [contour.partId, contour.kind, contour.arch]), [
    ['fixture', 'fixture', 'upper'], ['abutment', 'abutment', 'upper'], ['crown', 'crown', 'upper'],
  ]);
  assert.equal(new Set(contours.map(contour => contour.color)).size, 3);
  for (const contour of contours) closeSegments(contour.segments, [[[2, 0, 0], [0, 2, 0]]]);
  assert.deepEqual(buildTomographyContours(frame, { ...options, scans: true, restorations: false }).map(contour => contour.partId), ['upper']);
  assert.deepEqual(buildTomographyContours(frame, { ...options, scans: false, restorations: false }), []);
  assert.deepEqual(buildTomographyContours(frame, { ...options, excludedPartIds: [...options.excludedPartIds, 'fixture'] }).map(contour => contour.partId), ['abutment', 'crown']);
  assert.deepEqual(options, before);
});

test('unreviewed scan contours can be previewed in amber without enabling restoration contours', () => {
  const frame = getSliceFrame(spec()), options = overlayFixture();
  const registrations = options.registrations.map(record => ({ ...record, reviewed: false }));
  const contours = buildTomographyContours(frame, { ...options, registrations, scans: true, previewScans: true });
  assert.deepEqual(contours.map(contour => contour.partId), ['upper', 'lower']);
  assert.ok(contours.every(contour => contour.kind === 'scan' && contour.color === '#fbbf24'));
  assert.deepEqual(buildTomographyContours(frame, { ...options, registrations, scans: true }), []);
  assert.deepEqual(buildTomographyContours(frame, { ...options, registrations: [], scans: true, previewScans: true }), []);
});

test('an assembly fit supports slice review of a generic mesh without inventing an arch role', () => {
  const frame = getSliceFrame(spec()), options = { ...overlayFixture(), registrations: [], scans: true };
  const assemblyRegistration = { partIds: ['other'], reviewed: false, rmsMm: .2 };
  const preview = buildTomographyContours(frame, { ...options, assemblyRegistration, previewScans: true });
  assert.deepEqual(preview.map(contour => [contour.partId, contour.arch, contour.color]), [['other', 'model', '#fbbf24']]);
  assert.deepEqual(buildTomographyContours(frame, { ...options, assemblyRegistration }), []);
  const reviewed = buildTomographyContours(frame, { ...options, assemblyRegistration: { ...assemblyRegistration, reviewed: true } });
  assert.deepEqual(reviewed.map(contour => contour.partId), ['other']);
  assert.equal(options.parts.find(part => part.id === 'other').role, 'model');
});

test('invalid frames, raster sizes and physical scales fail before numeric work', () => {
  for (const invalid of [{ widthMm: 0 }, { heightMm: Infinity }, { center: [NaN, 0, 0] },
    { plane: 'oblique' }, { plane: 'oblique', normal: [0, 0, 1], up: [0, 0, 2] }]) assert.throws(() => getSliceFrame(spec(invalid)));
  const volume = volumeFixture();
  for (const [width, height] of [[0, 1], [1, -1], [1.5, 2], [8193, 1]]) assert.throws(() => resliceVolume(volume, spec(), width, height));
  assert.throws(() => resliceVolume(volume, spec({ slabMm: -1 }), 1, 1));
  for (const scale of [0, -1, NaN, Infinity]) assert.throws(() => transformPartToPatient(partFixture(), scale));
});
