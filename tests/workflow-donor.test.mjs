import test from 'node:test';
import assert from 'node:assert/strict';
import { Vector3 } from 'three';
import { withPatientDonor } from '../src/workflow-geometry.ts';
import { templateShape, buildCrownMesh, placeCrown, donorShape } from '../src/crown-anatomy.ts';
import { generateRestoration } from '../src/restoration-geometry.ts';

function fixture() {
  const spec = { version: 'implant-assembly/v1', fdi: 36, parentPartId: 'target', frame: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], up: [0, 0, 1] }, anatomicalSigns: { mesial: 1, buccal: -1 },
    parameters: { fixture: { radius: 1, length: 5, depth: .5, taper: .2 }, abutment: { radius: .8, height: 2, emergenceRadius: 1.2, angleX: 0, angleY: 0 }, crown: { width: 5.2, depth: 4.6, height: 3.5, cuspHeight: .5, rotation: 0 } }, anatomy: 'molar', provenance: 'hypothesized', units: 'file units (u)', source: 'Synthetic site' };
  const origin = [10, 20, 30], axes = { mesial: [0, 1, 0], buccal: [-1, 0, 0], occlusal: [0, 0, 1] };
  const mesh = buildCrownMesh(templateShape('lower', 6), [5.2, 4.6, 4]);
  const placed = placeCrown(mesh, { origin, ...axes });
  const faces = Uint32Array.from({ length: placed.positions.length / 9 }, (_, index) => index);
  const tooth = { id: 2, fdi: 46, faces, centroid: [10, 20, 32], top: [10, 20, 34], axis: axes.occlusal, s: [0, 4], sCenter: 2, mdWidth: 5.2, blWidth: 4.6, height: 4, cervicalLevel: 30, peaks: 5, crownScore: .95, kind: 'crown', flags: [] };
  // Whole-scan u/v deliberately disagree with tooth axes. Using them would swap
  // the donor's MD/BL extents and rotate its asymmetric cusp configuration.
  const source = { partId: 'donor', scan: { frame: { origin: [0, 0, 0], up: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] }, candidates: [] },
    analysis: { frame: { origin: [0, 0, 0], up: [0, 0, 1], e1: [1, 0, 0], e2: [0, 1, 0] }, teeth: [tooth], curve: { s: [0, 2, 4], tangent: [[0, 1, 0], [0, 1, 0], [0, 1, 0]], lingual: [[1, 0, 0], [1, 0, 0], [1, 0, 0]] }, anterior: { apexS: 10 }, lingualConfidence: .95 }, numbering: null };
  const site = { arch: 'lower', mesialSign: 1, buccalSign: -1, contralateral: { toothId: 2, fdi: 46, partId: 'donor', centroid: tooth.centroid, confidence: .95 } };
  const part = { id: 'donor', role: 'lower', positions: placed.positions, normals: placed.normals, triangles: placed.positions.length / 9 };
  return { spec, site, source, part, origin, axes };
}

test('patient donor uses tooth-local tangent/lingual axes and cervical reference, then generates actual crown geometry', () => {
  const { spec, site, source, part, origin, axes } = fixture();
  const before = structuredClone({ spec, source, part });
  const adapted = withPatientDonor(spec, site, [source], [part]);
  assert.equal(adapted.crownShape?.source.kind, 'patient-donor');
  assert.equal(adapted.crownShape.source.mirrored, true);
  assert.equal(adapted.crownShape.source.donorFdi, 46);
  assert.equal(adapted.parameters.crown.cuspHeight, 0, 'the procedural relief must not be applied again to measured donor anatomy');
  assert.equal(adapted.parameters.crown.height, spec.parameters.crown.height + spec.parameters.crown.cuspHeight);
  assert.deepEqual(adapted.crownShape.source.selection.faces, Array.from(source.analysis.teeth[0].faces));
  assert.deepEqual(adapted.crownShape.source.selection.frame, { origin, ...axes });
  assert.match(adapted.crownShape.source.provenance, /Initial MD\/BL\/height scales/);
  assert.deepEqual({ spec, source, part }, before);
  const expected = donorShape(part.positions, source.analysis.teeth[0].faces, { origin, ...axes }, { arch: 'lower', digit: 6, donorFdi: 46, donorPartId: 'donor', donorToothId: 2, mirrored: true });
  for (const field of ['dims', 'rim', 'rimZ', 'wall', 'occlusal', 'apex']) assert.deepEqual(adapted.crownShape[field], expected[field]);
  assert.match(adapted.crownShape.source.provenance, /cervical.*estimated|cervical cut datum is estimated/);
  const original = generateRestoration(spec), donor = generateRestoration(adapted);
  assert.notDeepEqual(donor[2].positions, original[2].positions);
  assert.deepEqual(donor[0].positions, original[0].positions);
  assert.deepEqual(donor[1].positions, original[1].positions);
  assert.equal(donor[2].closed, true);
});

test('donor extraction is invariant to source rigid coordinates and does not apply display poses twice', () => {
  const initial = fixture(), baseline = withPatientDonor(initial.spec, initial.site, [initial.source], [initial.part]);
  assert.ok(baseline.crownShape);
  const changed = fixture(), up = [0, -1, 0];
  const point = ([x, y, z]) => [50 + x, -9 - z, 7 + y];
  const direction = ([x, y, z]) => [x, -z, y];
  for (let i = 0; i < changed.part.positions.length; i += 3) changed.part.positions.set(point(Array.from(changed.part.positions.slice(i, i + 3))), i);
  const tooth = changed.source.analysis.teeth[0];
  tooth.centroid = point(tooth.centroid); tooth.top = point(tooth.top); tooth.axis = direction(tooth.axis);
  tooth.cervicalLevel = new Vector3(...point(changed.origin)).dot(new Vector3(...up));
  changed.source.analysis.frame.up = up;
  changed.source.analysis.curve.tangent = changed.source.analysis.curve.tangent.map(direction);
  changed.source.analysis.curve.lingual = changed.source.analysis.curve.lingual.map(direction);
  // This is display registration only; extraction uses each donor's source coordinates.
  changed.part.pose = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 200, 300, 1];
  const adapted = withPatientDonor(changed.spec, changed.site, [changed.source], [changed.part]);
  assert.ok(adapted.crownShape);
  for (const field of ['dims', 'rim', 'rimZ', 'wall', 'occlusal']) {
    const a = baseline.crownShape[field], b = adapted.crownShape[field];
    assert.equal(a.length, b.length);
    for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-4, `${field}[${i}] changed under a rigid frame`);
  }
});

test('uncertain, wrong-side, restoration-like, flagged, and disproportionate donors retain the explicit fallback', () => {
  for (const edit of [
    f => { f.site.contralateral.confidence = .79; },
    f => { f.site.contralateral.fdi = 47; },
    f => { f.source.analysis.teeth[0].kind = 'restoration-like'; },
    f => { f.source.analysis.teeth[0].flags = ['Unusually long crown segment; adjacent crowns may be merged.']; },
    f => { f.source.analysis.lingualConfidence = .4; },
    f => { f.source.analysis.teeth[0].axis = [0, 1, 0]; },
    f => { f.spec.parameters.crown.width = 50; },
    f => { f.spec.anatomicalSigns = { mesial: 1, buccal: 1 }; },
  ]) {
    const f = fixture(); edit(f);
    assert.equal(withPatientDonor(f.spec, f.site, [f.source], [f.part]), f.spec);
  }
});
