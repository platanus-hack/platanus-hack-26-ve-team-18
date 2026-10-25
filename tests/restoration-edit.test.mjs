import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRestorationEdit, restorationEditSchema, restorationEditRevision } from '../src/restoration-edit.ts';
import { generateRestoration, restorationCrownShape, restorationReferencePlanes } from '../src/restoration-geometry.ts';
import { fitRestoration } from '../src/restoration-fitting.ts';
import { withQualityContext } from '../src/workflow-geometry.ts';

function spec() {
  return { version: 'implant-assembly/v1', fdi: 36, parentPartId: 'lower', frame: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], up: [0, 0, 1] },
    parameters: { fixture: { radius: 1, length: 4, depth: 0.4, taper: 0.2 }, abutment: { radius: 0.8, height: 2, emergenceRadius: 1, angleX: 0, angleY: 0 }, crown: { width: 4, depth: 4, height: 3, cuspHeight: 0.5, rotation: 0 } },
    anatomy: 'molar', provenance: 'hypothesized', units: 'file units (u)', source: 'Synthetic editable hypothesis.' };
}
const change = { reason: 'Inspect the cervical contour.', contour: { cervicalScale: 0.8 } };

test('strict shared edit schema rejects empty, arbitrary, clinical and unbounded edits', () => {
  for (const value of [ {}, { reason: ' ' }, { reason: 'inspect' }, { reason: 'inspect', parameters: { crown: {} } }, { ...change, pose: [1] }, { ...change, fdi: 35 }, { ...change, clinicalApproval: true },
    { ...change, qualityContext: {} }, { ...change, placementFeedback: {} }, { ...change, parameters: { fixture: { depth: -1 } } }, { ...change, parameters: { crown: { width: Infinity } } },
    { ...change, parameters: { crown: { width: 1e12 } } }, { ...change, parameters: { fixture: { unknown: 1 } } }, { ...change, contour: { cervicalScale: 1.51 } },
    { ...change, appearance: { crown: { roughness: NaN } } }, { ...change, appearance: { crown: { color: 'red' } } }, { ...change, appearance: { implant: { color: '#aaaaaa' } } }, { ...change, reason: 'x'.repeat(501) } ]) {
    assert.equal(restorationEditSchema.safeParse(value).success, false, JSON.stringify(value));
  }
  assert.equal(restorationEditSchema.safeParse({ reason: 'Exact manual values.', parameters: { fixture: { depth: 0 }, crown: { rotation: -360 } }, appearance: { crown: { roughness: 0, color: '#ABCDEF' } } }).success, true);
});

test('edits preserve untouched parameters and patient donor, use absolute controls and bounded actor provenance', () => {
  const original = spec(); original.crownShape = restorationCrownShape(original);
  original.crownShape.source = { ...original.crownShape.source, kind: 'patient-donor', donorPartId: 'lower', donorToothId: 3, faceCount: 100, donorFdi: 37 };
  const before = structuredClone(original), edited = applyRestorationEdit(original, change, 'agent');
  assert.deepEqual(original, before);
  assert.deepEqual(edited.crownShape, original.crownShape);
  assert.deepEqual(edited.parameters, original.parameters);
  assert.equal(edited.provenance, 'hypothesized'); assert.deepEqual(edited.editProvenance, { actor: 'agent', reason: change.reason });
  const next = applyRestorationEdit(edited, { reason: 'Set absolute scale.', contour: { cervicalScale: 1.2 } }, 'manual');
  assert.equal(next.contour.cervicalScale, 1.2); assert.equal(next.provenance, 'clinician-entered');
  assert.throws(() => applyRestorationEdit(next, { reason: 'No change.', contour: { cervicalScale: 1.2 } }, 'manual'), /does not change/);
  assert.throws(() => applyRestorationEdit(spec(), { reason: 'Default is unchanged.', contour: { cervicalScale: 1 } }, 'agent'), /does not change/);
  assert.throws(() => applyRestorationEdit(spec(), { reason: 'Default color.', appearance: { crown: { color: '#F4EAD7' } } }, 'agent'), /does not change/);
});

test('anatomy switch explicitly replaces donor with a template without changing site or chart identity', () => {
  const original = spec(); original.crownShape = restorationCrownShape(original);
  original.draftIdentity = { siteId: 'site-a', templateFdi: 36, alternatives: [35, 36], basis: 'Unresolved draft.' };
  const edited = applyRestorationEdit(original, { reason: 'Compare premolar anatomy.', anatomy: 'premolar' }, 'manual');
  assert.equal(edited.crownShape.source.kind, 'procedural-template'); assert.equal(edited.crownShape.toothClass, 'premolar');
  assert.equal(edited.fdi, 36); assert.deepEqual(edited.draftIdentity, original.draftIdentity); assert.deepEqual(edited.frame, original.frame);
  assert.deepEqual(edited.parameters, original.parameters);
});

test('full spec validation happens before an otherwise valid edit is returned', () => {
  for (const damage of [ s => { s.frame.u = [0, 0, 0]; }, s => { s.parameters.fixture.length = NaN; }, s => { s.parameters.crown.hiddenApproval = true; }, s => { s.qualityContext = { bad: true }; } ]) {
    const invalid = spec(); damage(invalid); assert.throws(() => applyRestorationEdit(invalid, change, 'manual'));
  }
});

test('unit contour defaults are bit-identical; cervical and relief controls change their intended regions once', async () => {
  const original = spec(), baseline = generateRestoration(original);
  assert.deepEqual(generateRestoration({ ...original, contour: { cervicalScale: 1, occlusalScale: 1 } }), baseline);
  const cervical = applyRestorationEdit(original, change, 'manual'), relief = applyRestorationEdit(original, { reason: 'Reduce relief.', contour: { occlusalScale: 0.6 } }, 'manual');
  const cervicalMeshes = generateRestoration(cervical), reliefMeshes = generateRestoration(relief);
  assert.deepEqual(cervicalMeshes.slice(0, 2), baseline.slice(0, 2)); assert.deepEqual(reliefMeshes.slice(0, 2), baseline.slice(0, 2));
  const marginRadius = mesh => { let radius = 0; for (let i = 0; i < mesh.positions.length; i += 3) if (Math.abs(mesh.positions[i + 2] - 2) < 1e-6) radius = Math.max(radius, Math.hypot(mesh.positions[i], mesh.positions[i + 1])); return radius; };
  assert.ok(Math.abs(marginRadius(cervicalMeshes[2]) / marginRadius(baseline[2]) - 0.8) < 1e-6);
  assert.equal(marginRadius(reliefMeshes[2]), marginRadius(baseline[2]));
  assert.ok(reliefMeshes[2].dimensions[2] < baseline[2].dimensions[2]);
  const fitted = await fitRestoration({ spec: cervical, surfaces: [], options: { maxCandidates: 1 } });
  assert.deepEqual(fitted.components, generateRestoration(fitted.spec), 'pinning fitter anatomy must not compound contour');
  assert.deepEqual(fitted.spec.crownShape, restorationCrownShape(original));
  assert.deepEqual(restorationReferencePlanes(cervical), restorationReferencePlanes(original));
  for (const cervicalScale of [0.5, 1.5]) for (const occlusalScale of [0.5, 1.5]) assert.ok(generateRestoration({ ...original, contour: { cervicalScale, occlusalScale } }).every(mesh => mesh.closed));
});

test('opaque revision tokens bind spec, generation time and stale warnings, excluding presentation visibility', () => {
  const original = spec(), assembly = { id: 'a', spec: original, createdAt: '2026-10-24T10:00:00.000Z', warnings: [], parts: [] };
  const token = restorationEditRevision(assembly);
  assert.ok(token.length < 100); assert.equal(token, restorationEditRevision(structuredClone(assembly)));
  assert.notEqual(token, restorationEditRevision({ ...assembly, spec: applyRestorationEdit(original, change, 'agent') }));
  assert.notEqual(token, restorationEditRevision({ ...assembly, createdAt: '2026-10-24T10:00:00.001Z' }));
  assert.notEqual(token, restorationEditRevision({ ...assembly, warnings: ['STALE: source evidence changed'] }));
  assert.equal(token, restorationEditRevision({ ...assembly, spec: Object.fromEntries(Object.entries(original).reverse()) }));
});

test('refreshing site-derived quality evidence retains only explicitly entered placement feedback', () => {
  const original = spec(), site = { adjacent: {}, space: { proximalGap: { value: 4, method: 'Surface envelope.', provenance: 'measured' } } };
  const ordinary = withQualityContext(original, site, []);
  assert.equal(ordinary.qualityContext.placementFeedback, undefined);
  const feedback = { provenance: 'unconfirmed-case-feedback', source: 'Manual review for this case.', subcrestalDepthMm: 1.5, adjacentToothClearanceMm: null };
  original.qualityContext = { ...ordinary.qualityContext, gapWidth: { value: 99, method: 'Old gap.', provenance: 'hypothesized' }, placementFeedback: feedback };
  const refreshed = withQualityContext(original, site, []);
  assert.equal(refreshed.qualityContext.gapWidth.value, 4);
  assert.deepEqual(refreshed.qualityContext.placementFeedback, feedback);
  assert.deepEqual(refreshed.parameters, original.parameters);
  assert.equal(original.qualityContext.gapWidth.value, 99);
});
