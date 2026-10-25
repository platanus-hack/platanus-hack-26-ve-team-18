import test from 'node:test';
import assert from 'node:assert/strict';
import { specForHypothesis, withPatientDonor } from '../src/workflow-geometry.ts';
import { generateRestoration } from '../src/restoration-geometry.ts';
import { templateShape, buildCrownMesh, placeCrown } from '../src/crown-anatomy.ts';

const measure = value => ({ value, unit: 'file units (u)', provenance: 'measured', method: 'Synthetic surface envelope.' });
function site(fdi = 36, scale = 1) {
  const frame = { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], up: [0, 0, 1] };
  return { id: 'synthetic-gap', fdi, arch: fdi < 30 ? 'upper' : 'lower', partId: 'arch', status: 'proposed-missing',
    anchor: { partId: 'arch', face: 0, point: frame.origin }, frame, frameBasis: 'Synthetic ridge datum.',
    mesialSign: 1, buccalSign: -1, slot: { index: 0, count: 1, s: [0, 4 * scale] },
    opposing: { partId: 'opponent', teeth: [], poseVerified: false },
    space: { mesiodistal: measure(4 * scale), proximalGap: measure(3 * scale), buccolingual: measure(4 * scale), crownHeight: measure(5 * scale), vertical: measure(2 * scale) } };
}
function bounds(mesh, frame) {
  const out = [[Infinity, -Infinity], [Infinity, -Infinity], [Infinity, -Infinity]];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const d = frame.origin.map((value, axis) => mesh.positions[i + axis] - value);
    for (const [axis, basis] of [frame.u, frame.v, frame.up].entries()) {
      const value = d.reduce((sum, x, k) => sum + x * basis[k], 0);
      out[axis][0] = Math.min(out[axis][0], value); out[axis][1] = Math.max(out[axis][1], value);
    }
  }
  return out;
}

test('every template budgets emitted cusp top plus abutment within provisional headroom', () => {
  for (const fdi of [11, 12, 13, 14, 15, 16, 17, 18, 31, 32, 33, 34, 35, 36, 37, 38]) {
    const input = site(fdi), before = structuredClone(input), spec = specForHypothesis(input, []);
    const crown = generateRestoration(spec).find(mesh => mesh.component === 'crown');
    const b = bounds(crown, spec.frame), headroom = input.space.vertical.value, width = input.space.proximalGap.value;
    assert.ok(b[2][1] <= headroom && b[2][1] > .999 * headroom, `FDI ${fdi}: actual top ${b[2][1]}`);
    assert.ok(b[0][0] >= -width / 2 && b[0][1] <= width / 2, `FDI ${fdi}: actual footprint ${b[0]}`);
    assert.ok((b[0][1] - b[0][0]) / width > .9, `FDI ${fdi}: crown still occupies measured gap`);
    assert.equal(spec.parameters.crown.cuspHeight, 0, 'complete template anatomy needs no extra initial relief');
    assert.equal(spec.parameters.fixture.depth, 0); assert.equal(spec.parameters.fixture.length, 5);
    assert.match(spec.source, /provisionally; bite pose is unverified/);
    assert.deepEqual(input, before);
  }
});

test('missing headroom stays unknown; nonpositive measured headroom or gap cannot produce a fit', () => {
  const input = site(); input.space.vertical.value = null;
  let spec = specForHypothesis(input, []);
  const crown = generateRestoration(spec).find(mesh => mesh.component === 'crown');
  assert.ok(bounds(crown, spec.frame)[2][1] <= input.space.crownHeight.value);
  assert.match(spec.source, /No measured antagonist headroom/);
  for (const field of ['vertical', 'proximalGap']) for (const value of [0, -1, NaN, Infinity]) {
    const invalid = site(); invalid.space[field].value = value;
    assert.equal(specForHypothesis(invalid, []), null, `${field}: ${value}`);
  }
  input.space.proximalGap = { ...measure(.1), method: 'Minimum sampled distance between face centroids.' };
  spec = specForHypothesis(input, []);
  assert.match(spec.source, /Arc-span fallback/);
  assert.ok(spec.parameters.crown.width > 3, 'legacy centroid distance is not repurposed as a usable width');
});

test('envelope dimensions scale in file units and remain source-frame equivariant', () => {
  const base = site(), spec = specForHypothesis(base, []), initial = generateRestoration(spec);
  for (const scale of [1e-8, 1, 1e4]) {
    const input = site(36, scale);
    const point = ([x, y, z]) => [10 * scale - y, 20 * scale + z, 30 * scale - x];
    const direction = ([x, y, z]) => [-y, z, -x];
    input.frame.origin = point([0, 0, 0]); input.anchor.point = input.frame.origin;
    for (const axis of ['u', 'v', 'up']) input.frame[axis] = direction(input.frame[axis]);
    const changed = specForHypothesis(input, []), meshes = generateRestoration(changed);
    for (let component = 0; component < meshes.length; component++) {
      const a = initial[component].positions, b = meshes[component].positions;
      for (let i = 0; i < a.length; i += 3) {
        const expected = point(Array.from(a.slice(i, i + 3), value => value * scale));
        for (let k = 0; k < 3; k++) assert.ok(Math.abs(b[i + k] - expected[k]) <= scale * 4e-6);
      }
    }
    const b = bounds(meshes.find(mesh => mesh.component === 'crown'), input.frame);
    assert.ok(b[2][1] <= input.space.vertical.value + scale * 2e-6);
  }
});

test('a patient donor cannot reopen the measured initial top or width envelope', () => {
  const input = site(), origin = [10, 20, 30];
  input.space.vertical.value = 4; input.space.proximalGap.value = 5.2; input.space.buccolingual.value = 4.6;
  const spec = specForHypothesis(input, []);
  const axes = { mesial: [0, 1, 0], buccal: [-1, 0, 0], occlusal: [0, 0, 1] };
  const placed = placeCrown(buildCrownMesh(templateShape('lower', 6), [5.2, 4.6, 4]), { origin, ...axes });
  const tooth = { id: 2, fdi: 46, faces: Uint32Array.from({ length: placed.positions.length / 9 }, (_, i) => i), centroid: [10, 20, 32], axis: axes.occlusal, sCenter: 2, cervicalLevel: 30, crownScore: .95, kind: 'crown', flags: [] };
  const source = { partId: 'donor', analysis: { frame: { up: axes.occlusal }, teeth: [tooth], curve: { s: [0, 2, 4], tangent: [axes.mesial, axes.mesial, axes.mesial], lingual: [[1, 0, 0], [1, 0, 0], [1, 0, 0]] }, anterior: { apexS: 10 }, lingualConfidence: .95 } };
  const part = { id: 'donor', role: 'lower', positions: placed.positions };
  input.contralateral = { toothId: 2, fdi: 46, partId: 'donor', confidence: .95 };
  const adapted = withPatientDonor(spec, input, [source], [part]);
  assert.equal(adapted.crownShape?.source.kind, 'patient-donor');
  const b = bounds(generateRestoration(adapted).find(mesh => mesh.component === 'crown'), adapted.frame);
  assert.ok(b[2][1] <= input.space.vertical.value);
  assert.ok(b[0][0] >= -input.space.proximalGap.value / 2 && b[0][1] <= input.space.proximalGap.value / 2);
  assert.deepEqual(adapted.parameters.fixture, spec.parameters.fixture);
  assert.deepEqual(adapted.parameters.abutment, spec.parameters.abutment);
});
