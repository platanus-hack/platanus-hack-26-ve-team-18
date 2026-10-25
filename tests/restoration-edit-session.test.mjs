import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { createPlanningSession, planningSessionSchema, readPlanningSession } from '../src/planning-session.ts';
import { restorationAppearance } from '../src/restoration-appearance.ts';
import { fitRestoration } from '../src/restoration-fitting.ts';
import { generateRestoration } from '../src/restoration-geometry.ts';
import { evaluateRestorationQuality } from '../src/restoration-quality.ts';
import { emptyToothCase } from '../src/tooth-session.ts';
import { MeshViewer, createPartMaterial } from '../src/viewer.ts';

const copy = value => JSON.parse(JSON.stringify(value));
const defaultColors = { fixture: '#94a3b8', abutment: '#c4a46b', crown: '#f4ead7' };
const defaultRoughness = { fixture: .48, abutment: .36, crown: .42 };

function fixture(edited = true) {
  const source = {
    id: 'original-upper', name: 'upper', fileName: 'upper.ply', role: 'upper',
    positions: Float32Array.of(0, 0, 0, 4, 0, 0, 0, 4, 0),
    normals: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1),
    triangles: 1, vertices: 3, dimensions: [4, 4, 0], offset: [0, 0, 0], closed: false, visible: true,
  };
  const spec = {
    version: 'implant-assembly/v1', fdi: 15, parentPartId: source.id,
    frame: { origin: [1, 1, 0], u: [1, 0, 0], v: [0, 1, 0], up: [0, 0, 1] },
    parameters: {
      fixture: { radius: .6, length: 2, depth: 0, taper: .1 },
      abutment: { radius: .5, height: 1, emergenceRadius: .7, angleX: 0, angleY: 0 },
      crown: { width: 2, depth: 2, height: 2, cuspHeight: .4, rotation: 0 },
    },
    anatomy: 'premolar', provenance: 'hypothesized', units: 'file units (u)', source: 'Unvalidated procedural concept.',
    ...(edited ? {
      contour: { cervicalScale: .5, occlusalScale: 1.5 },
      appearance: {
        fixture: { color: '#123456', roughness: 0 },
        abutment: { color: '#ABCDEF', roughness: 1 },
        crown: { color: '#fEeDcC', roughness: .23 },
      },
      editProvenance: { actor: 'agent', reason: 'Proposed display and contour changes for review.' },
    } : {}),
  };
  const id = 'edited-assembly', createdAt = '2026-10-24T12:00:00.000Z';
  const assembly = {
    id, spec, createdAt, warnings: ['Clinical fit unvalidated.'],
    parts: generateRestoration(spec).map(mesh => ({
      ...mesh, id: `${id}-${mesh.component}`, name: mesh.component, fileName: `${mesh.component}.ply`,
      offset: [0, 0, 0], visible: true, role: 'model',
      presentationColor: spec.appearance?.[mesh.component]?.color ?? defaultColors[mesh.component],
      ...(spec.appearance?.[mesh.component]?.roughness !== undefined ? { presentationRoughness: spec.appearance[mesh.component].roughness } : {}),
      restoration: { assemblyId: id, component: mesh.component, parentPartId: source.id },
    })),
  };
  assembly.previousVersions = [{
    spec: edited ? { ...copy(spec), contour: { cervicalScale: 1.1 }, appearance: { crown: { color: '#AABBCC' }, fixture: { roughness: .7 } },
      provenance: 'clinician-entered', editProvenance: { actor: 'manual', reason: 'm'.repeat(500) } } : copy(spec),
    createdAt, warnings: ['Historical concept, not clinical validation.'],
  }];
  return { parts: [source], assemblies: [assembly], teeth: emptyToothCase() };
}

async function measuredFixture() {
  const input = fixture(), assembly = input.assemblies[0];
  assembly.spec.qualityContext = {
    version: 'restoration-quality-context/v1', units: 'file units (u)', neighbors: [], gapWidth: null, availableHeight: null,
    placementFeedback: { provenance: 'unconfirmed-case-feedback', source: 'Unconfirmed case note.', subcrestalDepthMm: .8, adjacentToothClearanceMm: 2.4 },
  };
  for (const revision of [assembly, ...assembly.previousVersions]) {
    const fitted = await fitRestoration({ spec: revision.spec, surfaces: [], options: { maxCandidates: 1 } });
    revision.spec = fitted.spec;
    revision.fit = fitted.report;
    revision.candidateHistory = fitted.history;
    if (revision === assembly) assembly.parts = fitted.components.map(mesh => ({
      ...assembly.parts.find(part => part.restoration.component === mesh.component), ...mesh,
    }));
  }
  return input;
}

function freshGuardrails(assembly) {
  return evaluateRestorationQuality({
    spec: assembly.spec, components: assembly.parts.map(part => ({ ...part, component: part.restoration.component })),
    measurement: assembly.fit.after, context: assembly.spec.qualityContext, tolerances: assembly.fit.quality.final.tolerances,
  }).guardrails;
}

function staleGuardrails(quality, marker) {
  quality.guardrails = copy(quality.guardrails);
  quality.guardrails.componentExtents[0].extents.mesiodistal += 100;
  quality.guardrails.issues.find(issue => issue.id === 'subcrestal-placement').target.value = 99;
  quality.guardrails.limits = [marker];
}

test('reopening replaces independently stale current guardrails without changing historical revisions', async () => {
  const input = await measuredFixture(), saved = copy(await createPlanningSession(input));
  const expected = freshGuardrails(input.assemblies[0]);
  for (const targets of [['final'], ['initial'], ['history'], ['final', 'initial', 'history']]) {
    const file = copy(saved), assembly = file.assemblies[0];
    for (const target of targets) staleGuardrails(target === 'history' ? assembly.candidateHistory[0].quality : assembly.fit.quality[target], target);
    staleGuardrails(assembly.previousVersions[0].fit.quality.final, 'Historical revision only.');
    const untouched = copy(file);
    assert.equal(planningSessionSchema.safeParse(file).success, true);
    const loaded = (await readPlanningSession(file, input.parts)).assemblies[0];
    assert.deepEqual(loaded.fit.quality.final.guardrails, expected);
    assert.deepEqual(loaded.fit.quality.initial.guardrails, expected);
    assert.deepEqual(loaded.candidateHistory[0].quality.guardrails, expected);
    assert.deepEqual(loaded.previousVersions[0].fit.quality.final.guardrails, assembly.previousVersions[0].fit.quality.final.guardrails);
    assert.deepEqual(loaded.spec.parameters, input.assemblies[0].spec.parameters);
    assert.deepEqual(loaded.parts.map(part => part.positions), input.assemblies[0].parts.map(part => part.positions));
    assert.deepEqual(file, untouched, 'Reopening must not rewrite the supplied file.');
  }
});

test('legacy reports gain fresh current guardrails and remain consistent after save and reopen', async () => {
  const input = await measuredFixture(), saved = copy(await createPlanningSession(input));
  for (const assembly of [saved.assemblies[0], ...saved.assemblies[0].previousVersions]) {
    for (const quality of [assembly.fit.quality.initial, assembly.fit.quality.final, ...assembly.candidateHistory.map(entry => entry.quality)]) delete quality.guardrails;
  }
  const reopened = await readPlanningSession(saved, [{ ...input.parts[0], id: 'reimported-upper' }]);
  const current = reopened.assemblies[0], expected = freshGuardrails(current);
  assert.deepEqual(current.fit.quality.final.guardrails, expected);
  assert.deepEqual(current.fit.quality.initial.guardrails, expected);
  assert.deepEqual(current.candidateHistory[0].quality.guardrails, expected);
  for (const quality of [current.previousVersions[0].fit.quality.initial, current.previousVersions[0].fit.quality.final, current.previousVersions[0].candidateHistory[0].quality]) {
    assert.equal(quality.guardrails, undefined, 'A historical revision must not acquire current guardrails.');
  }
  const resaved = copy(await createPlanningSession({ parts: reopened.parts, teeth: reopened.teeth, assemblies: reopened.assemblies }));
  const loadedAgain = (await readPlanningSession(resaved, reopened.parts)).assemblies[0];
  assert.deepEqual(loadedAgain.fit.quality, current.fit.quality);
  assert.deepEqual(loadedAgain.candidateHistory, current.candidateHistory);
});

test('without candidate history, initial guardrails refresh only for the same single measured candidate', async () => {
  const input = await measuredFixture(), saved = copy(await createPlanningSession(input));
  for (const sameInitial of [true, false]) {
    const file = copy(saved), assembly = file.assemblies[0];
    delete assembly.candidateHistory;
    staleGuardrails(assembly.fit.quality.final, 'Stale final.');
    staleGuardrails(assembly.fit.quality.initial, 'Historical initial.');
    if (!sameInitial) assembly.fit.quality.initial.limits.push('A different historical assessment.');
    const current = (await readPlanningSession(file, input.parts)).assemblies[0], expected = freshGuardrails(current);
    assert.deepEqual(current.fit.quality.final.guardrails, expected);
    assert.deepEqual(current.fit.quality.initial.guardrails, sameInitial ? expected : assembly.fit.quality.initial.guardrails);
    assert.equal(current.candidateHistory, undefined);
  }
});

test('candidate zero retains fresh initial guardrails when later candidates were rejected', async () => {
  const input = await measuredFixture(), saved = copy(await createPlanningSession(input)), assembly = saved.assemblies[0];
  const rejected = { ...copy(assembly.candidateHistory[0]), candidate: 1, accepted: false };
  rejected.parameters.crown.height += .1;
  rejected.measurement.score += 1;
  rejected.measurement.objectiveScore += 1;
  staleGuardrails(rejected.quality, 'Rejected candidate history.');
  assembly.candidateHistory.push(rejected);
  assembly.fit.candidates = assembly.fit.candidateAttempts = 2;
  staleGuardrails(assembly.fit.quality.final, 'Stale selected candidate.');
  const current = (await readPlanningSession(saved, input.parts)).assemblies[0], expected = freshGuardrails(current);
  assert.equal(current.fit.bestCandidate, 0);
  assert.deepEqual(current.fit.quality.initial.guardrails, expected);
  assert.deepEqual(current.fit.quality.final.guardrails, expected);
  assert.deepEqual(current.candidateHistory[0].quality.guardrails, expected);
  assert.deepEqual(current.candidateHistory[1].quality.guardrails, rejected.quality.guardrails);
});

test('a later winning candidate refreshes its guardrails while earlier candidates remain historical', async () => {
  const input = await measuredFixture(), saved = copy(await createPlanningSession(input)), assembly = saved.assemblies[0];
  const initial = assembly.candidateHistory[0], chosen = { ...copy(initial), candidate: 1 };
  initial.measurement.score = initial.measurement.objectiveScore = 1;
  initial.parameters.crown.height -= .1;
  staleGuardrails(initial.quality, 'Initial candidate history.');
  assembly.fit.before = copy(initial.measurement);
  assembly.fit.quality.initial = copy(initial.quality);
  const rejected = { ...copy(initial), candidate: 2, accepted: false };
  staleGuardrails(rejected.quality, 'Rejected candidate history.');
  assembly.candidateHistory.push(chosen, rejected);
  assembly.fit.candidates = assembly.fit.candidateAttempts = 3;
  assembly.fit.bestCandidate = 1;
  assembly.fit.status = 'improved';
  staleGuardrails(assembly.fit.quality.final, 'Stale final.');
  delete chosen.quality.guardrails;
  const current = (await readPlanningSession(saved, input.parts)).assemblies[0], expected = freshGuardrails(current);
  assert.deepEqual(current.fit.quality.final.guardrails, expected);
  assert.deepEqual(current.candidateHistory[1].quality.guardrails, expected);
  assert.deepEqual(current.fit.quality.initial.guardrails, initial.quality.guardrails);
  assert.deepEqual(current.candidateHistory[0].quality.guardrails, initial.quality.guardrails);
  assert.deepEqual(current.candidateHistory[2].quality.guardrails, rejected.quality.guardrails);
});

test('fresh current placement guardrails use saved unconfirmed feedback including zero, null and removal', async () => {
  const input = await measuredFixture(), saved = copy(await createPlanningSession(input));
  for (const feedback of [
    { provenance: 'unconfirmed-case-feedback', source: 'Updated unconfirmed note.', subcrestalDepthMm: 0, adjacentToothClearanceMm: 3.2 },
    { provenance: 'unconfirmed-case-feedback', source: 'Targets not supplied.', subcrestalDepthMm: null, adjacentToothClearanceMm: null },
    null,
  ]) {
    const file = copy(saved);
    if (feedback) file.assemblies[0].spec.qualityContext.placementFeedback = feedback;
    else delete file.assemblies[0].spec.qualityContext.placementFeedback;
    const current = (await readPlanningSession(file, input.parts)).assemblies[0];
    for (const [id, key] of [['subcrestal-placement', 'subcrestalDepthMm'], ['adjacent-root-clearance', 'adjacentToothClearanceMm']]) {
      const issue = current.fit.quality.final.guardrails.issues.find(issue => issue.id === id);
      assert.equal(issue.target.value, feedback?.[key] ?? null);
      assert.equal(issue.target.provenance, feedback ? 'unconfirmed-case-feedback' : 'not-established');
      assert.equal(issue.actual.feedbackSource, feedback?.source ?? null);
      assert.equal(issue.status, 'unknown');
    }
    assert.deepEqual(current.fit.quality.final.guardrails, freshGuardrails(current));
    assert.deepEqual(current.candidateHistory[0].quality.guardrails, current.fit.quality.final.guardrails);
    assert.deepEqual(current.spec.parameters, input.assemblies[0].spec.parameters);
  }
});

test('guardrail refresh still rejects tampered engineering quality and malformed extensions', async () => {
  const input = await measuredFixture(), saved = copy(await createPlanningSession(input));
  const inconsistent = copy(saved);
  inconsistent.assemblies[0].candidateHistory[0].quality.criteria[0].measured.emitted += 1;
  await assert.rejects(readPlanningSession(inconsistent, input.parts), /Quality history/);
  const forged = copy(saved), assembly = forged.assemblies[0];
  for (const quality of [assembly.fit.quality.initial, assembly.fit.quality.final, assembly.candidateHistory[0].quality]) {
    quality.criteria[0].measured.emitted += 1;
  }
  await assert.rejects(readPlanningSession(forged, input.parts), /Saved quality checks/);
  const malformed = copy(saved);
  malformed.assemblies[0].fit.quality.final.guardrails.issues.pop();
  await assert.rejects(readPlanningSession(malformed, input.parts), /Invalid planning session/);
});

test('session roundtrip retains contour, component finish and actor provenance for current and previous revisions', async () => {
  const input = fixture(), original = input.assemblies[0];
  const saved = copy(await createPlanningSession(input));
  const reopened = await readPlanningSession(saved, [{ ...input.parts[0], id: 'reimported-upper' }]);
  const restored = reopened.assemblies[0];
  assert.equal(restored.spec.parentPartId, 'reimported-upper');
  assert.equal(restored.previousVersions[0].spec.parentPartId, 'reimported-upper');
  for (const [before, after] of [[original, restored], [original.previousVersions[0], restored.previousVersions[0]]]) {
    for (const key of ['contour', 'appearance', 'editProvenance', 'provenance']) assert.deepEqual(after.spec[key], before.spec[key]);
  }
  assert.equal(restored.spec.provenance, 'hypothesized');
  assert.equal(restored.previousVersions[0].spec.provenance, 'clinician-entered');
  for (const part of restored.parts) {
    const expected = original.parts.find(item => item.restoration.component === part.restoration.component);
    assert.equal(part.presentationColor, expected.presentationColor);
    assert.equal(part.presentationRoughness, expected.presentationRoughness);
    assert.equal(restorationAppearance(part).roughness, expected.presentationRoughness);
    assert.deepEqual(part.positions, expected.positions);
  }
  const resaved = copy(await createPlanningSession({ parts: reopened.parts, teeth: reopened.teeth, assemblies: reopened.assemblies }));
  assert.deepEqual(resaved.assemblies, saved.assemblies);
  assert.equal(input.assemblies[0].spec.parentPartId, 'original-upper', 'Saving and reopening leave the live source untouched.');
});

test('legacy revisions retain absent edit fields and their original material defaults', async () => {
  const input = fixture(false);
  input.assemblies[0].parts[0].presentationColor = 'slategray';
  const saved = copy(await createPlanningSession(input));
  const loaded = await readPlanningSession(saved, input.parts);
  for (const revision of [loaded.assemblies[0], ...loaded.assemblies[0].previousVersions]) {
    assert.equal(revision.spec.contour, undefined);
    assert.equal(revision.spec.appearance, undefined);
    assert.equal(revision.spec.editProvenance, undefined);
  }
  assert.equal(loaded.assemblies[0].parts[0].presentationColor, 'slategray');
  for (const part of loaded.assemblies[0].parts) {
    assert.equal(part.presentationRoughness, undefined);
    assert.equal(restorationAppearance(part).roughness, defaultRoughness[part.restoration.component]);
  }
});

test('strict edit schemas reject invalid bounds, unknown keys and oversized provenance in every revision', async () => {
  const input = fixture(), saved = copy(await createPlanningSession(input));
  const invalidEdits = [
    ['small cervical scale', spec => { spec.contour = { cervicalScale: .499 }; }],
    ['large occlusal scale', spec => { spec.contour = { occlusalScale: 1.501 }; }],
    ['nonfinite contour', spec => { spec.contour = { cervicalScale: Infinity }; }],
    ['unknown contour', spec => { spec.contour = { width: 1 }; }],
    ['short color', spec => { spec.appearance = { crown: { color: '#fff' } }; }],
    ['invalid color', spec => { spec.appearance = { crown: { color: '#12345g' } }; }],
    ['CSS color', spec => { spec.appearance = { crown: { color: 'white' } }; }],
    ['negative roughness', spec => { spec.appearance = { fixture: { roughness: -.01 } }; }],
    ['large roughness', spec => { spec.appearance = { abutment: { roughness: 1.01 } }; }],
    ['nonfinite roughness', spec => { spec.appearance = { crown: { roughness: NaN } }; }],
    ['unknown component', spec => { spec.appearance = { implant: { color: '#123456' } }; }],
    ['unknown material field', spec => { spec.appearance = { crown: { metalness: .5 } }; }],
    ['unknown actor', spec => { spec.editProvenance = { actor: 'reviewer', reason: 'Review.' }; }],
    ['empty reason', spec => { spec.editProvenance.reason = ''; }],
    ['whitespace reason', spec => { spec.editProvenance.reason = ' \t\n '; }],
    ['oversized reason', spec => { spec.editProvenance.reason = 'a'.repeat(501); }],
    ['unknown provenance field', spec => { spec.editProvenance.approved = true; }],
  ];
  for (const revision of ['current', 'previous']) {
    for (const [label, mutate] of invalidEdits) {
      const invalid = copy(saved);
      mutate(revision === 'current' ? invalid.assemblies[0].spec : invalid.assemblies[0].previousVersions[0].spec);
      assert.equal(planningSessionSchema.safeParse(invalid).success, false, `${revision}: ${label}`);
    }
  }
  const invalid = copy(saved); invalid.assemblies[0].previousVersions[0].spec.contour.cervicalScale = 0;
  await assert.rejects(readPlanningSession(invalid, input.parts), /Invalid planning session/);
  input.assemblies[0].spec.editProvenance.reason = 'a'.repeat(501);
  await assert.rejects(createPlanningSession(input));
});

test('reopening rejects empty edit reasons and trims valid reasons in current and historical specs', async () => {
  const input = fixture(), saved = copy(await createPlanningSession(input));
  for (const revision of ['current', 'previous']) {
    for (const reason of ['', ' \t\n ']) {
      const invalid = copy(saved), assembly = invalid.assemblies[0];
      (revision === 'current' ? assembly.spec : assembly.previousVersions[0].spec).editProvenance.reason = reason;
      await assert.rejects(readPlanningSession(invalid, input.parts), /Invalid planning session/);
    }
    const valid = copy(saved), assembly = valid.assemblies[0];
    (revision === 'current' ? assembly.spec : assembly.previousVersions[0].spec).editProvenance.reason = '  Reviewed contour.  ';
    const restored = (await readPlanningSession(valid, input.parts)).assemblies[0];
    assert.equal((revision === 'current' ? restored.spec : restored.previousVersions[0].spec).editProvenance.reason, 'Reviewed contour.');
  }
});

test('reopening enforces shared numerical, site and metadata invariants for every revision', async () => {
  const input = fixture(), saved = copy(await createPlanningSession(input));
  const invalidSpecs = [
    [spec => { spec.parameters.fixture.radius = 1e-8; }, /Component proportions/],
    [spec => { spec.source = '   '; }, /source must be a bounded nonempty string/],
    [spec => { spec.siteEvidence = { method: 'bounded-gap', partIds: [spec.parentPartId], fdis: [],
      surface: { partId: spec.parentPartId, face: 0, point: [1, 1, 0] }, slot: { index: 1, count: 1 } }; }, /Invalid site slot/],
  ];
  for (const revision of ['current', 'previous']) {
    for (const [mutate, expected] of invalidSpecs) {
      const invalid = copy(saved), assembly = invalid.assemblies[0];
      mutate(revision === 'current' ? assembly.spec : assembly.previousVersions[0].spec);
      assert.equal(planningSessionSchema.safeParse(invalid).success, true, 'These invariants require the shared semantic validator.');
      await assert.rejects(readPlanningSession(invalid, input.parts), expected);
    }
  }
});

test('current and historical actor provenance cannot be relabeled as the other entry source', async () => {
  const input = fixture(), saved = copy(await createPlanningSession(input));
  for (const revision of ['current', 'previous']) {
    const invalid = copy(saved);
    const spec = revision === 'current' ? invalid.assemblies[0].spec : invalid.assemblies[0].previousVersions[0].spec;
    spec.provenance = spec.editProvenance.actor === 'agent' ? 'clinician-entered' : 'hypothesized';
    await assert.rejects(readPlanningSession(invalid, input.parts), /edit provenance/);
  }
});

test('explicit appearance must match saved component metadata, including missing values and zero roughness', async () => {
  const input = fixture(), saved = copy(await createPlanningSession(input));
  const invalidMetadata = [
    part => { part.presentationColor = '#ffffff'; },
    part => { delete part.presentationColor; },
    part => { part.presentationRoughness = .5; },
    part => { delete part.presentationRoughness; },
    part => { part.presentationRoughness = -1; },
    part => { part.presentationRoughness = 2; },
    part => { part.presentationRoughness = Infinity; },
  ];
  for (const mutate of invalidMetadata) {
    const invalid = copy(saved);
    mutate(invalid.assemblies[0].parts.find(part => part.component === 'fixture'));
    await assert.rejects(readPlanningSession(invalid, input.parts), /Invalid planning session/);
  }
  const equivalent = copy(saved);
  equivalent.assemblies[0].parts.find(part => part.component === 'abutment').presentationColor = '#abcdef';
  assert.equal((await readPlanningSession(equivalent, input.parts)).assemblies[0].spec.appearance.abutment.color, '#ABCDEF');
  input.assemblies[0].parts.find(part => part.restoration.component === 'fixture').presentationRoughness = .2;
  await assert.rejects(createPlanningSession(input), /presentation color or roughness/);
});

test('concept material uses explicit roughness and keeps default finishes and imported scans unchanged', () => {
  const input = fixture(false);
  for (const part of input.assemblies[0].parts) {
    const initial = restorationAppearance(part);
    const explicitDefault = restorationAppearance({ ...part, presentationRoughness: defaultRoughness[part.restoration.component] });
    assert.deepEqual(explicitDefault, initial);
    for (const roughness of [0, .17, 1]) {
      const edited = { ...part, presentationRoughness: roughness }, appearance = restorationAppearance(edited);
      assert.equal(appearance.roughness, roughness);
      assert.notEqual(appearance.key, initial.key);
      const { key, roughness: actual, ...finish } = appearance;
      const { key: initialKey, roughness: original, ...defaultFinish } = initial;
      assert.deepEqual(finish, defaultFinish);
      const material = createPartMaterial(edited);
      assert.ok(material instanceof THREE.MeshPhysicalMaterial);
      assert.equal(material.roughness, roughness);
      material.dispose();
    }
    assert.equal(restorationAppearance({ ...part, restoration: undefined, presentationRoughness: 0 }), null);
    assert.equal(restorationAppearance({ ...part, reference: 'tomography', presentationRoughness: 0 }), null);
  }
});

test('viewer replaces changed finish material and restores defaults without replacing source geometry', () => {
  const viewer = Object.create(MeshViewer.prototype);
  Object.assign(viewer, {
    root: new THREE.Group(), meshes: new Map(), sources: new Map(), textures: new Map(), report: null,
    heatmap: true, tolerance: .5, opacities: {}, toothView: null, disposed: false,
    cancelGesture() {}, rebuildAnnotations() {}, updateBounds() {}, fit() {}, draw() {},
  });
  const crown = fixture(false).assemblies[0].parts.find(part => part.restoration.component === 'crown');
  viewer.setParts([crown]);
  const mesh = viewer.meshes.get(crown.id), geometry = mesh.geometry, original = mesh.material;
  let disposed = false;
  original.addEventListener('dispose', () => { disposed = true; });
  viewer.setParts([{ ...crown, presentationRoughness: 0 }]);
  assert.equal(disposed, true);
  assert.notEqual(mesh.material, original);
  assert.equal(mesh.material.roughness, 0);
  assert.equal(mesh.geometry, geometry);
  assert.equal(mesh.geometry.getAttribute('position').array, crown.positions);
  const edited = mesh.material;
  viewer.setParts([{ ...crown, presentationRoughness: 0 }]);
  assert.equal(mesh.material, edited, 'Unchanged roughness reuses the material.');
  viewer.setParts([crown]);
  assert.notEqual(mesh.material, edited);
  assert.equal(mesh.material.roughness, .42);
  assert.equal(mesh.geometry, geometry);
  viewer.setParts([]);
});
