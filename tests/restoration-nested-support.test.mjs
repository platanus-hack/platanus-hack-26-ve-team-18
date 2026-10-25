import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Ray, Triangle, Vector3 } from 'three';
import { crownSupportRegion, crownTissueRegions, generateRestoration, restorationCrownShape, restorationReferencePlanes, restorationSupportDatum } from '../src/restoration-geometry.ts';
import { specForAIGeneration, specForHypothesis, withAIGenerationDesign } from '../src/workflow-geometry.ts';
import { inspectMesh } from '../skills/dental-restoration-design/scripts/dental-concept.mjs';

const profile = 'nested-support/v1';
function spec(fdi = 36, anatomy = 'molar', angled = false) {
  const result = { version: 'implant-assembly/v1', fdi, parentPartId: 'synthetic-lower',
    frame: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], up: [0, 0, 1] },
    parameters: { fixture: { radius: 1.1, length: 5, depth: .4, taper: .3 },
      abutment: { radius: .8, height: 2.1, emergenceRadius: 1.3, angleX: 0, angleY: 0 },
      crown: { width: 5.2, depth: 4.6, height: 3.5, cuspHeight: 1.1, rotation: 0 } },
    anatomy, provenance: 'hypothesized', units: 'file units (u)', source: 'Synthetic geometry; no patient data.' };
  // Explicit saved anatomy, including the older relief construction branch.
  result.crownShape = restorationCrownShape(result);
  if (angled) {
    Object.assign(result.parameters.abutment, { angleX: 13, angleY: -19 });
    result.parameters.fixture.depth = 0; result.parameters.crown.rotation = 27;
    result.anatomicalSigns = { mesial: -1, buccal: 1 };
    result.contour = { cervicalScale: .9, occlusalScale: 1.1 };
    result.frame = { origin: [12, -4, 7], u: [2/3, 2/3, -1/3], v: [-1/3, 2/3, 2/3], up: [2/3, -1/3, 2/3] };
    delete result.crownShape.reliefDatum;
  }
  return result;
}
const hash = mesh => createHash('sha256').update(new Uint8Array(mesh.positions.buffer)).update(new Uint8Array(mesh.normals.buffer)).digest('hex');
// Captured from the dirty shared checkout BEFORE the profile implementation.
// Positions, normals, face order and topology remain bound to the old branch.
const legacyHashes = [
  [11, 'incisor', '14230f8d43ac85ee099edc2744e6c70370932c5656edaf757bfd5f663baae8b4', 'f460f224aaf7da5b130c1a53bb0f83fdff331dd6e1220ded35c8c95ba0efec56'],
  [23, 'canine', 'd4201ec0993dc2cbf0f2650137a7863abb35910258e80762affe75edcae1711c', '1333f45416dd7d274f38d1f8163f48019bcd26d7c6f5f7e9109fca2239432af5'],
  [35, 'premolar', 'b0d29fc5b2f7b442fa5d8b4328c19d34d1f8448c0e612365c3ea7892463bc9f0', '30bae8a492651b059a01df4ebcca14d34a6a66a26b7ef90b4785d7ca395135b9'],
  [36, 'molar', '5d890e56828fa7258d1bcaaec2f77832214d402382b5fd71bb9f2926d42797fb', '71fa49cf39bd6bc865f5dd4949ee3b540076058edb837544fa02a17e03445e61'],
];
test('absent construction profile retains the pre-change legacy geometry exactly', () => {
  for (const [fdi, anatomy, straight, angled] of legacyHashes) for (const rotated of [false, true]) {
    const meshes = generateRestoration(spec(fdi, anatomy, rotated));
    assert.deepEqual(meshes.map(hash), rotated ? [
      'f7b04c9aa876920163d50cb270c95b3901b75e1442f7a4517673c0289e8a8f71',
      'e3f73b1ff53592b2b103599aa6f90a96691728b6482ffb00fa5ad2ca3859a18a', angled,
    ] : [
      'b9c76226e15cd4445bc47ee6de94a7834b9d92b3475a0a84ad301e50962a3d4e',
      'be2b7ee6bce0231c0a92dc839206446967d7dff02d050d42172afbc99107af30', straight,
    ]);
  }
});

function integrity(mesh) {
  const indices = [], vertices = [], seen = new Map();
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const point = Array.from(mesh.positions.subarray(i, i + 3)), key = point.join(',');
    if (!seen.has(key)) { seen.set(key, vertices.length / 3); vertices.push(...point); }
    indices.push(seen.get(key));
  }
  const report = inspectMesh({ positions: Float32Array.from(vertices), indices: Uint32Array.from(indices) });
  assert.equal(report.closed, true); assert.equal(report.consistentlyOriented, true);
  assert.equal(report.vertexManifold, true); assert.equal(report.degenerateTriangles, 0);
  assert.ok(report.signedVolume > 0);
  assert.ok(mesh.positions.every(Number.isFinite)); assert.ok(mesh.normals.every(Number.isFinite));
  for (let i = 0; i < mesh.normals.length; i += 3) assert.ok(Math.abs(Math.hypot(...mesh.normals.subarray(i, i + 3)) - 1) < 1e-6);
}
const near = (a, b, tolerance = 1e-5) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const project = (point, frame) => frame.up.reduce((sum, value, axis) => sum + value * (point[axis] - frame.origin[axis]), 0);
function enclosed(crown, point) {
  const ray = new Ray(new Vector3(...point), new Vector3(1, .127, .231).normalize()), triangle = new Triangle(), hit = new Vector3(), distances = [];
  for (let i = 0; i < crown.positions.length; i += 9) {
    triangle.a.fromArray(crown.positions, i); triangle.b.fromArray(crown.positions, i + 3); triangle.c.fromArray(crown.positions, i + 6);
    if (ray.intersectTriangle(triangle.a, triangle.b, triangle.c, false, hit)) distances.push(hit.distanceTo(ray.origin));
  }
  distances.sort((a, b) => a - b);
  return distances.filter((value, i) => !i || value - distances[i - 1] > 1e-6).length % 2 === 1;
}

test('new tapered rounded post is actually inside representative crowns while crown, fixture and datums stay fixed', () => {
  for (const [fdi, anatomy] of legacyHashes) {
    const legacy = spec(fdi, anatomy), input = { ...legacy, componentDesign: profile }, before = structuredClone(input);
    const old = generateRestoration(legacy), meshes = generateRestoration(input);
    meshes.forEach(integrity);
    assert.deepEqual(input, before);
    for (const index of [0, 2]) { assert.deepEqual(meshes[index].positions, old[index].positions); assert.deepEqual(meshes[index].normals, old[index].normals); }
    assert.deepEqual(restorationReferencePlanes(input), restorationReferencePlanes(legacy));
    assert.deepEqual(crownTissueRegions(input, meshes[2]), crownTissueRegions(legacy, old[2]));
    const datum = restorationSupportDatum(input), region = crownSupportRegion(input, meshes[1]);
    assert.deepEqual(datum.origin, [0, 0, input.parameters.abutment.height]);
    near(datum.postHeight, input.parameters.crown.height * .58);
    near(region.supportTop, region.seatingDatum + datum.postHeight);
    assert.ok(region.positions.length > 600);
    const emitted = new Set();
    for (let i = 0; i < meshes[1].positions.length; i += 3) emitted.add(meshes[1].positions.slice(i, i + 3).join(','));
    const selected = new Set();
    for (let i = 0; i < region.positions.length; i += 3) {
      const point = region.positions.slice(i, i + 3), key = point.join(',');
      assert.ok(emitted.has(key)); assert.ok(!selected.has(key)); selected.add(key);
      assert.ok(project(point, input.frame) > region.seatingDatum + region.numericTolerance);
      assert.ok(enclosed(meshes[2], point), `${anatomy} post vertex must lie inside actual crown triangles`);
    }
    assert.equal(crownSupportRegion(legacy, old[1]).positions.length, 0);
  }
});

test('post follows restorative up from the slanted seating centre in rigid and reflected anatomy frames', () => {
  for (const signs of [{ mesial: 1, buccal: 1 }, { mesial: -1, buccal: 1 }, { mesial: 1, buccal: -1 }]) {
    const input = { ...spec(36, 'molar', true), componentDesign: profile, anatomicalSigns: signs };
    const meshes = generateRestoration(input); meshes.forEach(integrity);
    const datum = restorationSupportDatum(input), region = crownSupportRegion(input, meshes[1]);
    const topPoints = [];
    for (let i = 0; i < region.positions.length; i += 3) {
      const point = Array.from(region.positions.subarray(i, i + 3));
      if (Math.abs(project(point, input.frame) - region.supportTop) < region.numericTolerance * 2) topPoints.push(point);
    }
    const expected = datum.origin.map((value, axis) => value + datum.normal[axis] * datum.postHeight);
    const average = [0, 1, 2].map(axis => topPoints.reduce((sum, point) => sum + point[axis], 0) / topPoints.length);
    average.forEach((value, axis) => near(value, expected[axis]));
    for (let i = 0; i < region.positions.length; i += 3) assert.ok(enclosed(meshes[2], region.positions.slice(i, i + 3)));
  }
  const invalid = { ...spec(), componentDesign: profile };
  invalid.frame.v = [0, -1, 0];
  assert.throws(() => generateRestoration(invalid), /right-handed/);
});

test('construction preserves impossible radii as measurable protrusions and rejects unknown profiles', () => {
  const input = { ...spec(), componentDesign: profile };
  input.parameters.abutment.radius = 4;
  input.parameters.abutment.emergenceRadius = 5;
  const before = structuredClone(input), meshes = generateRestoration(input);
  meshes.forEach(integrity); assert.deepEqual(input, before);
  const pilar = meshes[1], region = crownSupportRegion(input, pilar), atDatum = [], atSite = [];
  for (let i = 0; i < pilar.positions.length; i += 3) {
    const point = pilar.positions.subarray(i, i + 3);
    if (Math.abs(point[2] - input.parameters.abutment.height) < 1e-6) atDatum.push(Math.hypot(point[0], point[1]));
    if (Math.abs(point[2]) < 1e-6) atSite.push(Math.hypot(point[0], point[1]));
  }
  near(Math.max(...atDatum), 4); near(Math.max(...atSite), 5);
  assert.ok(Array.from({ length: region.positions.length / 3 }, (_, i) => region.positions.slice(i * 3, i * 3 + 3)).some(point => !enclosed(meshes[2], point)));
  for (const componentDesign of [null, 'nested-support/v2', {}, true]) assert.throws(() => generateRestoration({ ...input, componentDesign }), /profile/);
  for (const depth of [0, .0001, .4]) {
    const candidate = { ...spec(), componentDesign: profile };
    candidate.parameters.fixture.depth = depth; candidate.parameters.abutment.radius = 1.4;
    generateRestoration(candidate).forEach(integrity);
  }
});

test('accepted frame error cannot promote seating vertices into a legacy or new support region', () => {
  const legacy = spec();
  legacy.frame.u = [1, 0, 9e-9];
  Object.assign(legacy.parameters.abutment, { height: .01, radius: 20, emergenceRadius: 20 });
  const oldPilar = generateRestoration(legacy)[1];
  assert.equal(crownSupportRegion(legacy, oldPilar).positions.length, 0);
  const nested = { ...legacy, componentDesign: profile, parameters: structuredClone(legacy.parameters) };
  nested.parameters.crown.height = .01;
  const pilar = generateRestoration(nested)[1], region = crownSupportRegion(nested, pilar);
  assert.ok(region.positions.length > 0);
  const elevations = [];
  for (let i = 0; i < region.positions.length; i += 3) elevations.push(project(region.positions.slice(i, i + 3), nested.frame));
  assert.ok(Math.min(...elevations) > nested.parameters.abutment.height + restorationSupportDatum(nested).postHeight * .1);
});

test('fresh local and AI sites opt into nested support without changing exact design choices or refit profiles', () => {
  const measure = value => ({ value, unit: 'file units (u)', provenance: 'measured', method: 'Synthetic surface envelope.' });
  const site = { id: 'test-site', fdi: 36, arch: 'lower', partId: 'arch', status: 'proposed-missing',
    frame: spec().frame, frameBasis: 'Synthetic site.', anchor: { partId: 'arch', face: 0, point: [0, 0, 0] },
    mesialSign: 1, buccalSign: 1, slot: { index: 0, count: 1, s: [0, 5] },
    space: { mesiodistal: measure(4), proximalGap: measure(4), buccolingual: measure(4), crownHeight: measure(5), vertical: measure(5) } };
  assert.equal(specForHypothesis(site, []).componentDesign, profile);
  const design = { anatomy: 'molar', anatomySource: 'procedural-template', parameters: spec().parameters, contour: { cervicalScale: .9, occlusalScale: 1.1 } };
  const ai = specForAIGeneration(site, [], design, 'Exact synthetic design.');
  assert.equal(ai.componentDesign, profile); assert.deepEqual(ai.parameters, design.parameters); assert.deepEqual(ai.contour, design.contour);
  const legacy = { ...ai }; delete legacy.componentDesign;
  assert.equal(withAIGenerationDesign(legacy, site, [], [], design).componentDesign, undefined, 'An anatomy resolver cannot upgrade a saved construction profile.');
});
