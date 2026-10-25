import assert from 'node:assert/strict';
import test from 'node:test';
import { Matrix4 } from 'three';
import { createPlanningSession, readPlanningSession } from '../src/planning-session.ts';
import { emptyToothCase, geometrySignature } from '../src/tooth-session.ts';
import { generateRestoration } from '../src/restoration-geometry.ts';
import { partMatrix } from '../src/pose.ts';

function source(id = 'original-upper', role = 'upper', height = 0) {
  return { id, name: role, fileName: `${role}.ply`, role, positions: new Float32Array([0,0,height, 4,0,height, 0,4,height, 4,0,height,4,4,height,0,4,height]),
    normals: new Float32Array([0,0,1,0,0,1,0,0,1,0,0,1,0,0,1,0,0,1]), triangles: 2, vertices: 4, dimensions: [4,4,0], offset: [2,3,4], rotation: [0,0,20], pose: new Matrix4().makeTranslation(1,0,0).toArray(), closed: false, visible: true };
}
function fixture() {
  const upper = source(), lower = source('original-lower', 'lower', 10), bite = source('original-bite', 'bite', 20);
  const parts = [upper, lower, bite], teeth = emptyToothCase();
  teeth.labels[upper.id] = new Uint8Array([16, 0]);
  teeth.teeth[16] = { status: 'present', restoration: 'none', note: 'Reviewed upper crown.' };
  teeth.teeth[15] = { status: 'missing', restoration: 'implant', note: 'Reviewed missing site.', site: { partId: upper.id, face: 1, point: [2,2,0] } };
  const spec = { version: 'implant-assembly/v1', fdi: 15, parentPartId: upper.id,
    frame: { origin: [2,2,0], u: [1,0,0], v: [0,1,0], up: [0,0,1] },
    parameters: { fixture: { radius: .6, length: 2, depth: 0, taper: .1 }, abutment: { radius: .5, height: 1, emergenceRadius: .7, angleX: 0, angleY: 0 }, crown: { width: 2, depth: 2, height: 2, cuspHeight: .4, rotation: 0 } },
    anatomy: 'premolar', provenance: 'hypothesized', units: 'file units (u)', source: 'Explicit procedural planning hypothesis.',
    siteEvidence: { method: 'reviewed-surface', partIds: [upper.id, lower.id], fdis: [15,16], surface: { partId: upper.id, face: 1, point: [2,2,0] } } };
  const id = 'assembly-one';
  const assembly = { id, spec, parts: generateRestoration(spec).map(mesh => ({ ...mesh, id: `${id}-${mesh.component}`, name: mesh.component, fileName: `${mesh.component}.ply`, offset: [0,0,0], visible: true, role: 'model', restoration: { assemblyId: id, component: mesh.component, parentPartId: upper.id } })), createdAt: '2026-10-24T12:00:00.000Z', warnings: ['Clinical fit unvalidated.'] };
  const scan = { frame: spec.frame, candidates: [{ id: 1, faces: new Uint32Array([0]), seed: { face: 0, point: [1,1,0] }, centroid: [1,1,0], area: 8, height: 1, warnings: [] }], warnings: [], unassignedTriangles: 1, method: 'Test geometry hypothesis' };
  const evidence = { revision: 'case-revision-1', sources: [{ partId: upper.id, scan }], views: [{ id: 'view-1', sourceId: 'scan-1', context: 'arch', label: 'Overview', mediaType: 'image/jpeg', base64: '/9j/2Q==' }] };
  const result = { revision: evidence.revision, model: 'test-model', summary: 'Unvalidated surface hypothesis.', mappings: [{ sourceId: 'scan-1', candidateId: 1, fdi: 16, needsReview: true, reason: 'Draft only.' }], findings: [{ id: 'finding-one', fdi: 15, category: 'possible-missing', title: 'Gap hypothesis', detail: 'Review gap.', evidence: ['view-1'], needsClinicalReview: true }], actions: [{ id: 'action-one', fdi: 15, kind: 'implant-review', title: 'Review possible concept', rationale: 'Hypothesis.', evidence: ['scan-1:C1', 'view-1'], prerequisites: ['Professional review.'] }], designs: [], limitations: ['Bone unknown.'] };
  return { parts, teeth, assemblies: [assembly], draft: { evidence, result }, mmPerUnit: .5, unitsProvenance: 'Clinician-confirmed calibration reference.', confidenceThreshold: .8, patientRight: 'image-left', model: 'test-model', manualMode: false, progress: { stage: 'Review', completed: 4, total: 4 }, timings: [{ stage: 'Preparation', durationMs: 1234 }], acceptedActions: ['action-one'] };
}
const roundtrip = value => JSON.parse(JSON.stringify(value));

test('independent quality checks and rejected candidates survive save/reopen without becoming a pass', async () => {
  const { fitRestoration } = await import('../src/restoration-fitting.ts');
  const input = fixture(), assembly = input.assemblies[0];
  const result = await fitRestoration({ spec: assembly.spec, surfaces: [], options: { maxCandidates: 1 } });
  Object.assign(assembly, { spec: result.spec, fit: result.report, candidateHistory: result.history });
  const saved = roundtrip(await createPlanningSession(input));
  const loaded = await readPlanningSession(saved, input.parts.map((part,index) => ({ ...part, id: `quality-${index}` })));
  assert.equal(loaded.assemblies[0].fit.quality.final.status, 'unknown');
  assert.deepEqual(loaded.assemblies[0].fit.quality.final, loaded.assemblies[0].candidateHistory[0].quality);
  for (const mutate of [
    value => { value.assemblies[0].fit.quality.final.status = 'pass'; },
    value => { delete value.assemblies[0].candidateHistory[0].quality; },
    value => { const a = value.assemblies[0]; for (const q of [a.fit.quality.initial, a.fit.quality.final, a.candidateHistory[0].quality]) { q.status = 'pass'; q.criteria.forEach(c => { c.status = 'pass'; }); } },
  ]) { const invalid = roundtrip(saved); mutate(invalid); await assert.rejects(readPlanningSession(invalid, input.parts)); }
});

test('local anatomy revisions retain baseline and selected shape across session persistence', async () => {
  const { fitRestoration } = await import('../src/restoration-fitting.ts');
  const input = fixture(), assembly = input.assemblies[0];
  const lower = input.parts[1];
  for (let i = 2; i < lower.positions.length; i += 3) lower.positions[i] = 3.2;
  const result = await fitRestoration({ spec: assembly.spec, surfaces: [{ id: `${lower.id}:opposing`, role: 'antagonist', positions: lower.positions, targetGap: .03 }], options: { maxCandidates: 2, samplesPerSurface: 32 } });
  assert.equal(result.report.anatomyCandidates.length, 2, 'The localized cut is an explicit alternative anatomy.');
  assert.equal(result.history[0].anatomyCandidate, 0);
  assert.equal(result.history[1].anatomyCandidate, 1);
  assert.equal(result.report.quality.rounds, 1);
  Object.assign(assembly, { spec: result.spec, fit: result.report, candidateHistory: result.history, parts: result.components.map(mesh => ({ ...assembly.parts.find(part => part.restoration.component === mesh.component), ...mesh })) });
  const saved = roundtrip(await createPlanningSession(input));
  const loaded = await readPlanningSession(saved, input.parts);
  for (let i = 0; i < 2; i++) assert.deepEqual(loaded.assemblies[0].fit.anatomyCandidates[i], result.report.anatomyCandidates[i]);
  const invalid = roundtrip(saved); invalid.assemblies[0].candidateHistory[1].anatomyCandidate = 3;
  await assert.rejects(readPlanningSession(invalid, input.parts));
  for (const key of ['rim', 'rimZ', 'wall', 'dims']) {
    const changed = roundtrip(saved), alternative = changed.assemblies[0].fit.anatomyCandidates[1];
    alternative[key][0] *= .99;
    await assert.rejects(readPlanningSession(changed, input.parts), /shape|anatomy|contour|dimension|mesh/i);
  }
});

test('reopen rejects changed texture, UV, colour, tissue and original file byte evidence', async () => {
  const input = fixture();
  input.parts[0].sourceByteSha256 = 'a'.repeat(64);
  input.parts[0].colors = new Float32Array(input.parts[0].positions.length).fill(.2);
  input.parts[0].tissueScores = Float32Array.of(.05, .05);
  const file = await createPlanningSession(input);
  for (const change of [
    part => { part.colors = new Float32Array(part.positions.length).fill(.8); },
    part => { part.tissueScores = Float32Array.of(.95, .95); },
    part => { part.uvs = new Float32Array(12).fill(.5); },
    part => { part.texture = { fileName: 'changed.png', mimeType: 'image/png', bytes: Uint8Array.of(1,2,3) }; },
    part => { part.sourceByteSha256 = 'b'.repeat(64); },
  ]) {
    const imported = input.parts.map(part => ({ ...part })); change(imported[0]);
    await assert.rejects(readPlanningSession(roundtrip(file), imported), /evidence differs|byte hash differs/);
  }
});

test('legacy sessions restore reviewed work but cannot reactivate unverified appearance-dependent drafts or fits', async () => {
  const input = fixture(); input.workflow={identityDecisions:{'original-upper:C1':16},siteDecisions:{'upper-original-upper-gap-1':15}};
  const legacy = roundtrip(await createPlanningSession(input));
  for (const source of legacy.sources) { delete source.appearanceSha256; delete source.sourceByteSha256; }
  const changed = input.parts.map(part => ({ ...part, colors: new Float32Array(part.positions.length).fill(.8) }));
  const loaded = await readPlanningSession(legacy, changed);
  assert.equal(loaded.draft, null); assert.deepEqual(loaded.teeth.teeth, input.teeth.teeth);
  assert.ok(loaded.assemblies.every(assembly => assembly.warnings.some(warning => warning.startsWith('STALE:'))));
  assert.ok(loaded.recoveryWarnings.length); assert.equal(loaded.acceptedActions.length, 0);
  assert.equal(loaded.patientRight,null); assert.deepEqual(loaded.workflow.identityDecisions,{}); assert.deepEqual(loaded.workflow.identityRegions,{}); assert.deepEqual(loaded.workflow.siteDecisions,{});
  assert.equal(loaded.workflow.archivedDraftDecisions[0].identityDecisions['original-upper:C1'],16);
  assert.equal(loaded.workflow.assessments.at(-1).model, input.draft.result.model);
  assert.match(loaded.workflow.assessments.at(-1).limitations.join(' '), /Historically included conditional review actions: action-one/);
});

test('workflow journal and correction decisions remap with sources while measured effort stays explicit', async () => {
  const { beginWorkflow, endWorkflow } = await import('../src/case-workflow.ts');
  const input = fixture();
  input.workflow = { step: 2, selectedTooth: 15, selectedAssemblyId: 'assembly-one', focusedSiteId: 'upper-original-upper-gap-1', identityDecisions: { 'original-upper:C1': 16 }, siteDecisions: { 'upper-original-upper-gap-1': 15 }, runs: [endWorkflow(beginWorkflow(input.draft.evidence.revision), 'partial')], correctionEvents: [{kind:'site',at:'2026-10-24T12:00:00.000Z',target:'explicit draft site'}], assessments: [input.draft.result] };
  const saved = await createPlanningSession(input);
  assert.equal(saved.workflow.identityDecisions['scan-1:C1'], 16);
  const loaded = await readPlanningSession(roundtrip(saved), input.parts.map((part,index) => ({...part,id:`reopened-${index}`})));
  assert.equal(loaded.workflow.identityDecisions['reopened-0:C1'], 16);
  assert.equal(loaded.workflow.siteDecisions['upper-reopened-0-gap-1'], 15);
  assert.equal(loaded.workflow.runs[0].status, 'partial');
  assert.equal(loaded.workflow.correctionEvents.length, 1);
});

test('previous editable design revisions preserve typed anatomy, measurements and source references', async () => {
  const { templateShape } = await import('../src/crown-anatomy.ts');
  const input = fixture(), assembly = input.assemblies[0];
  assembly.previousVersions = [{ spec:{...assembly.spec,crownShape:templateShape('upper',5)},createdAt:assembly.createdAt,warnings:['Historical unvalidated concept.']}];
  const file = await createPlanningSession(input);
  const loaded = await readPlanningSession(roundtrip(file), input.parts.map((part,index)=>({...part,id:`revision-${index}`})));
  const version = loaded.assemblies[0].previousVersions[0];
  assert.equal(version.spec.parentPartId, 'revision-0'); assert.ok(version.spec.crownShape.rim instanceof Float32Array);
  assert.deepEqual(version.spec.parameters, assembly.spec.parameters);
});

 test('session roundtrip restores all roles/rigid poses and reviewed chart without storing original scans', async () => {
  const input = fixture(), file = roundtrip(await createPlanningSession(input));
  assert.equal(file.format, 'platanus-planning-session');
  assert.equal(file.sources.length, 3);
  assert.equal(file.sources[0].positions, undefined);
  assert.equal(file.sources[0].normals, undefined);
  assert.equal(file.sources[2].role, 'bite');
  assert.equal(file.sources[0].geometrySha256, await geometrySignature(input.parts[0].positions));
  const current = input.parts.map((part, index) => ({ ...part, id: `reimport-${index}`, role: 'model', offset: [0,0,0], rotation: [0,0,0], pose: undefined }));
  const original = current.map(part => ({ ...part }));
  const restored = await readPlanningSession(file, current);
  assert.deepEqual(restored.parts.map(part => part.role), ['upper','lower','bite']);
  assert.deepEqual(partMatrix(restored.parts[0]).toArray(), partMatrix(input.parts[0]).toArray());
  assert.deepEqual(restored.teeth.labels['reimport-0'], new Uint8Array([16,0]));
  assert.equal(restored.teeth.teeth[15].site.partId, 'reimport-0');
  assert.equal(restored.assemblies[0].spec.parentPartId, 'reimport-0');
  assert.equal(restored.assemblies[0].parts[0].restoration.parentPartId, 'reimport-0');
  assert.deepEqual(restored.assemblies[0].parts[2].positions, input.assemblies[0].parts[2].positions);
  assert.equal(restored.mmPerUnit, .5);
  assert.equal(restored.unitsProvenance, input.unitsProvenance);
  assert.deepEqual(restored.timings, input.timings);
  assert.deepEqual(restored.acceptedActions, ['action-one']);
  assert.deepEqual(current, original);
});

test('reordered imports remap part dependencies and transport aliases without changing reviewed teeth', async () => {
  const input = fixture(), file = await createPlanningSession(input);
  const current = [input.parts[2], input.parts[1], input.parts[0]].map((part,index) => ({ ...part, id: `new-${index}`, role: 'model' }));
  const loaded = await readPlanningSession(roundtrip(file), current);
  assert.equal(loaded.draft.evidence.sources[0].partId, 'new-2');
  assert.equal(loaded.draft.evidence.views[0].sourceId, 'scan-3');
  assert.equal(loaded.draft.result.mappings[0].sourceId, 'scan-3');
  assert.deepEqual(loaded.draft.result.actions[0].evidence, ['scan-3:C1', 'view-1']);
  assert.equal(loaded.teeth.teeth[16].status, 'present');
  assert.equal(loaded.draft.result.mappings[0].needsReview, true);
  assert.equal(loaded.teeth.labels['new-0'], undefined);
  assert.deepEqual(loaded.assemblies[0].spec.siteEvidence.partIds, ['new-2','new-1']);
});

test('defaults retain unknown scale, orientation and an empty separate draft', async () => {
  const input = fixture(); input.assemblies = []; delete input.draft;
  delete input.mmPerUnit; delete input.unitsProvenance; delete input.patientRight; delete input.acceptedActions;
  const loaded = await readPlanningSession(await createPlanningSession(input), input.parts);
  assert.equal(loaded.mmPerUnit, null);
  assert.equal(loaded.patientRight, null);
  assert.equal(loaded.draft, null);
  assert.deepEqual(loaded.acceptedActions, []);
});

test('a workspace with unassigned mesh roles can save and reopen before preparation', async () => {
  const part = { ...source(), role: 'model' };
  const file = await createPlanningSession({ parts: [part], teeth: emptyToothCase(), assemblies: [] });
  assert.deepEqual(file.reviewed.parts, []);
  const restored = await readPlanningSession(roundtrip(file), [{ ...part, id: 'reimported' }]);
  assert.equal(restored.parts[0].role, 'model');
  assert.deepEqual(restored.teeth, emptyToothCase());
});

test('optional workflow state preserves the current editing step and selections with legacy defaults', async () => {
  const input = fixture();
  input.workflow = { step:2, selectedTooth:15, selectedAssemblyId:input.assemblies[0].id };
  const file = await createPlanningSession(input);
  const restored = await readPlanningSession(roundtrip(file),input.parts);
  assert.deepEqual(restored.workflow,input.workflow);
  for (const mutate of [
    file => { file.workflow.step = 4; },
    file => { file.workflow.selectedTooth = 19; },
    file => { file.workflow.selectedAssemblyId = 'missing'; },
  ]) { const invalid = roundtrip(file); mutate(invalid); await assert.rejects(readPlanningSession(invalid,input.parts)); }
  delete file.workflow;
  assert.equal((await readPlanningSession(file,input.parts)).workflow,undefined);
});

test('component manifest poses follow source registration and remain stable after reopen and resave', async () => {
  const input = fixture();
  const file = await createPlanningSession(input);
  for (const part of file.assemblies[0].parts) assert.deepEqual(part.fileToWorkspace, file.sources[0].fileToWorkspace);
  const restored = await readPlanningSession(roundtrip(file), input.parts);
  const savedAgain = await createPlanningSession(restored);
  assert.deepEqual(savedAgain.assemblies[0].parts.map(part => part.fileToWorkspace), file.assemblies[0].parts.map(part => part.fileToWorkspace));
  assert.deepEqual(input.assemblies[0].parts[0].offset, [0,0,0]);
  assert.equal(input.assemblies[0].parts[0].pose, undefined);
});

test('changed geometry, triangle order, missing sources and duplicate ambiguous scans fail atomically', async () => {
  const input = fixture(), file = await createPlanningSession(input);
  const changed = { ...input.parts[0], positions: input.parts[0].positions.slice() }; changed.positions[0] += .1;
  await assert.rejects(readPlanningSession(file, [changed,...input.parts.slice(1)]), /geometry is missing/);
  const swapped = { ...input.parts[0], positions: new Float32Array([...input.parts[0].positions.slice(9),...input.parts[0].positions.slice(0,9)]) };
  await assert.rejects(readPlanningSession(file, [swapped,...input.parts.slice(1)]), /triangle order/);
  await assert.rejects(readPlanningSession(file, input.parts.slice(1)), /same patient/);
  const duplicate = { ...input.parts[0], id: 'duplicate' };
  await assert.rejects(createPlanningSession({ ...input, parts: [...input.parts,duplicate] }), /ambiguous|Duplicate/);
  assert.deepEqual(input.parts[0].offset,[2,3,4]);
});

test('strict JSON rejects unsupported fields, nonfinite/oversize/malformed mesh arrays and invalid transforms', async () => {
  const input = fixture(), original = await createPlanningSession(input);
  const cases = [
    file => { file.extra = true; },
    file => { file.sources[0].positions = []; },
    file => { file.sources[0].fileToWorkspace[0] = 2; },
    file => { file.sources[0].fileToWorkspace[12] = Infinity; },
    file => { file.assemblies[0].parts[0].positions[0] = NaN; },
    file => { file.assemblies[0].parts[0].positions[0] = 1e300; },
    file => { file.assemblies[0].parts[0].normals.pop(); },
    file => { file.assemblies[0].parts[0].triangles = 2_000_001; },
    file => { file.confidenceThreshold = 80; },
    file => { file.mmPerUnit = 0; },
    file => { file.unitsProvenance = ''; },
    file => { file.progress.completed = 99; },
  ];
  for (const mutate of cases) { const file = roundtrip(original); mutate(file); await assert.rejects(readPlanningSession(file,input.parts), /Invalid planning session/); }
});

test('stale/missing dependencies and invalid reviewed anchors reject the complete restoration', async () => {
  const input = fixture(), original = await createPlanningSession(input);
  const cases = [
    file => { file.draft.result.revision = 'old'; },
    file => { file.draft.evidence.sources[0].partId = 'gone'; },
    file => { file.draft.evidence.sources[0].scan.candidates[0].faces = [500]; },
    file => { file.draft.evidence.sources[0].scan.candidates[0].seed.point = [200,200,0]; },
    file => { file.draft.result.actions[0].evidence = ['view-absent']; },
    file => { file.acceptedActions = ['unavailable']; },
    file => { file.assemblies[0].spec.parentPartId = 'scan-2'; },
    file => { file.assemblies[0].spec.siteEvidence.partIds.push('missing'); },
    file => { file.reviewed.teeth.find(tooth => tooth.fdi === 15).site.point = [100,100,0]; },
    file => { file.reviewed.parts[0].fileToWorkspace[12] += 1; },
    file => { file.assemblies[0].parts[0].positions[0] += 1; },
    file => { file.assemblies[0].parts[0].dimensions[0] += 1; },
    file => { file.assemblies[0].parts[1].component = 'fixture'; },
  ];
  for (const mutate of cases) {
    const file = roundtrip(original); mutate(file);
    const before = input.parts.map(part => part.role);
    await assert.rejects(readPlanningSession(file,input.parts));
    assert.deepEqual(input.parts.map(part => part.role), before);
    assert.equal(input.teeth.teeth[16].status,'present');
  }
});

function richPrepared(input) {
  const basic = input.draft.evidence.sources[0], partId = basic.partId;
  const analysis = { version: 2, method: 'Synthetic complete arch evidence', frame: { origin: [0,0,0], up: [0,0,1], e1: [1,0,0], e2: [0,1,0] },
    curve: { points: [[0,0,0],[1,0,0]], s: [0,1], tangent: [[1,0,0],[1,0,0]], lingual: [[0,1,0],[0,1,0]], crownLevel: [1,1], state: ['crown','low'] }, curveMode: 'linear', length: 1,
    teeth: [{ id: 1, fdi: 16, faces: new Uint32Array([0]), centroid: [1,1,0], top: [1,1,1], axis: [0,0,1], s: [0,.5], sCenter: .25, mdWidth: 1, blWidth: 1, height: 1, cervicalLevel: 0, peaks: 1, crownScore: .8, kind: 'crown', flags: [] }], gaps: [], classes: new Uint8Array([1,3]),
    classCounts: { unknown: 0, crown: 1, gingiva: 0, ridge: 1, 'outside-band': 0, boundary: 0, debris: 0, 'restoration-like': 0, 'soft-tissue-protrusion': 0 },
    coverage: { scannedFraction: 1, boundaryFaces: 2, openEdges: 4, components: 1, debrisComponents: 0 }, scale: { cell: .1, toothWidth: 1, crownProminence: 1, bandHalfWidth: 1, medianEdge: 1 }, anterior: { direction: [1,0,0], apexS: .5, confidence: .8, basis: 'Hypothesis.' }, lingualConfidence: .7, warnings: [] };
  const neighbour = { toothId: 1, fdi: 16, partId, centroid: [1,1,0], confidence: .9 };
  const measured = { value: 1, unit: 'file units (u)', method: 'Synthetic test.' };
  const site = { id: 'site-one', arch: 'upper', partId, fdi: 15, alternatives: [14], status: 'proposed-missing', confidence: .75, priority: 'medium', kind: 'bounded', slot: { index: 0, count: 1, s: [0,1] }, evidence: { supporting: ['Scanned ridge.'], conflicting: ['Identity uncertain.'] }, anchor: { partId, face: 1, point: [2,2,0] }, patchFaces: new Uint32Array([1]), frame: input.assemblies[0].spec.frame, frameBasis: 'Local tangent.', mesialSign: 1, buccalSign: -1, adjacent: { mesial: neighbour, distal: null }, opposing: null, contralateral: null,
    space: { mesiodistal: measured, proximalGap: measured, buccolingual: measured, vertical: { ...measured, value: null }, crownHeight: measured }, questions: ['Review identity.'] };
  return { id: 1, revision: input.draft.evidence.revision,
    scans: [{ ...basic, analysis, numbering: { arch: 'upper', orientation: 1, scale: 1, cost: .2, groups: [{ kind: 'tooth', start: 0, end: 0, fdi: 16, label: 'FDI 16 hypothesis', confidence: .9, alternatives: [17], cost: .2 }], sequence: [16], skipped: [], method: 'Synthetic hypothesis' }, draftLabels: new Uint8Array([16,0]), warnings: [] }],
    sites: [site], identities: [{ partId, candidateId: 1, fdi: 16, confidence: .9, alternatives: [17], needsReview: false, reason: 'Draft identity.', blockingReasons: [], source: 'geometry' }], warnings: ['Draft only.'] };
}
test('rich preparation preserves face arrays, confidence, identity alternatives and local site evidence separately from reviewed records', async () => {
  const input = fixture(); input.draft.prepared = richPrepared(input);
  const file = roundtrip(await createPlanningSession(input));
  const loaded = await readPlanningSession(file, input.parts.map((part,index) => ({ ...part, id: `rich-${index}` })));
  const prepared = loaded.draft.prepared;
  assert.ok(prepared.scans[0].analysis.classes instanceof Uint8Array);
  assert.ok(prepared.scans[0].analysis.teeth[0].faces instanceof Uint32Array);
  assert.ok(prepared.scans[0].draftLabels instanceof Uint8Array);
  assert.ok(prepared.sites[0].patchFaces instanceof Uint32Array);
  assert.equal(prepared.identities[0].partId,'rich-0');
  assert.equal(prepared.identities[0].confidence,.9);
  assert.deepEqual(prepared.identities[0].blockingReasons,[]);
  assert.deepEqual(prepared.identities[0].alternatives,[17]);
  assert.equal(prepared.sites[0].anchor.partId,'rich-0');
  assert.equal(prepared.sites[0].adjacent.mesial.partId,'rich-0');
  assert.equal(prepared.sites[0].status,'proposed-missing');
  assert.equal(loaded.teeth.teeth[17].status,'unreviewed');
  for (const mutate of [
    file => { file.draft.prepared.revision = 'stale'; },
    file => { file.draft.prepared.scans[0].draftLabels = [16]; },
    file => { file.draft.prepared.scans[0].analysis.classes = []; },
    file => { file.draft.prepared.scans[0].analysis.teeth[0].faces = [90]; },
    file => { file.draft.prepared.sites[0].adjacent.mesial.partId = 'absent'; },
    file => { file.draft.prepared.identities[0].candidateId = 99; },
  ]) { const invalid = roundtrip(file); mutate(invalid); await assert.rejects(readPlanningSession(invalid,input.parts)); }
});

test('fitting reports and bounded candidate history survive source remapping', async () => {
  const input = fixture(), assembly = input.assemblies[0];
  const measurement = { score: 1, objectiveScore: 1, morphologyPenalty: 0, surfaces: [{ id: `${input.parts[0].id}:mesial`, role: 'adjacent', side: 'mesial', targetGap: .05, weight: 1, targetTriangles: 2, samples: 2, sampledMinDistance: .02, sampledRmsGapError: .1, nearSamples: 1, intersectingTriangles: 0, intersectionTestedTriangles: 2, intersectionComplete: true }] };
  measurement.surfaces.push({ ...measurement.surfaces[0], id: `${input.parts[1].id}:opposing`, role: 'antagonist', side: undefined,
    occlusalRaySamples: 2, occlusalRayHits: 1, sampledOcclusalGap: .2, sampledOcclusalGapError: .15 });
  const plane = { origin: [0,0,0], normal: [0,0,1] };
  assembly.fit = { version: 'restoration-fit/v1', status: 'unchanged', termination: 'candidate-budget', before: measurement, after: measurement, candidates: 1, durationMs: 25, units: 'file units (u)', referencePlanes: { site: plane, fixturePlatform: plane, fixtureApex: plane, crownBase: plane, interpretation: 'generic-contiguous-envelopes; no compatible implant connection' }, sampling: { method: 'deterministic-area-stratified-triangle-barycentres', direction: 'restoration-to-target', requestedPerSurface: 2, fullResolutionDistanceTargets: true, maximumIntersectionTargetTriangles: 2 }, limits: ['Sampled metric only.'] };
  assembly.candidateHistory = [{ candidate: 0, parameters: assembly.spec.parameters, measurement, accepted: true }];
  const file = roundtrip(await createPlanningSession(input));
  const loaded = await readPlanningSession(file,input.parts.map((part,index) => ({ ...part, id: `fit-${index}` })));
  assert.equal(loaded.assemblies[0].candidateHistory[0].measurement.score,1);
  assert.equal(loaded.assemblies[0].fit.durationMs,25);
  assert.equal(loaded.assemblies[0].fit.after.surfaces[0].id,'fit-0:mesial');
  assert.equal(loaded.assemblies[0].fit.after.surfaces[1].id,'fit-1:opposing');
  assert.equal(loaded.assemblies[0].fit.after.surfaces[1].sampledOcclusalGap,.2);
  assert.equal(loaded.assemblies[0].candidateHistory[0].measurement.surfaces[1].occlusalRayHits,1);
  // A lower numerical score can correctly lose to a hard evidence constraint.
  assembly.fit.selectionPolicy = 'score-with-contact-evidence/v1';
  assembly.fit.candidates = 2;
  assembly.fit.bestCandidate = 0;
  const rejected = structuredClone(measurement);
  rejected.score = .5; rejected.objectiveScore = .5;
  rejected.surfaces[0].intersectingTriangles = 1;
  assembly.candidateHistory.push({ candidate: 1, parameters: assembly.spec.parameters, measurement: rejected, accepted: false });
  const constrained = await createPlanningSession(input);
  const reopened = await readPlanningSession(roundtrip(constrained), input.parts);
  assert.equal(reopened.assemblies[0].candidateHistory[1].accepted, false);
  assert.equal(reopened.assemblies[0].fit.bestCandidate, 0);
});

test('rich evidence alone remains compatible with the host restore seam', async () => {
  const input = fixture(), rich = richPrepared(input);
  input.draft.evidence.sources = rich.scans;
  const loaded = await readPlanningSession(roundtrip(await createPlanningSession(input)), input.parts);
  assert.equal(loaded.draft.evidence.sources[0].analysis.version,2);
  assert.ok(loaded.draft.evidence.sources[0].draftLabels instanceof Uint8Array);
  assert.ok(loaded.draft.evidence.sources[0].scan.candidates[0].faces instanceof Uint32Array);
  const minimal = fixture();
  const baseline = await readPlanningSession(await createPlanningSession(minimal), minimal.parts);
  assert.equal(baseline.draft.evidence.sources[0].analysis,null);
  assert.equal(baseline.draft.evidence.sources[0].numbering,null);
  assert.deepEqual(baseline.draft.evidence.sources[0].draftLabels,new Uint8Array(2));
});

test('oversized numeric arrays are rejected before element traversal and overlapping regions fail', async () => {
  const input = fixture(), file = await createPlanningSession(input);
  const invalid = roundtrip(file);
  invalid.assemblies[0].parts[0].positions = new Array(18_000_001);
  // Access would throw if validation visited even the first oversized mesh element.
  Object.defineProperty(invalid.assemblies[0].parts[0].positions, 0, { get() { throw new Error('Element should not be read.'); } });
  await assert.rejects(readPlanningSession(invalid,input.parts), /size limit/);
  const overlap = roundtrip(file);
  overlap.draft.evidence.sources[0].scan.candidates.push({ ...overlap.draft.evidence.sources[0].scan.candidates[0], id: 2 });
  await assert.rejects(readPlanningSession(overlap,input.parts), /overlap/);
});

test('the real preparation executor can save/reopen complete finite arch evidence', async () => {
  const { prepareCase } = await import('../src/case-preparation.ts');
  const radius = 4, step = .3, nx = 40, ny = 27;
  const centers = [0,1,2].map(i => { const angle = .12 + (Math.PI - .24) * i / 2; return [radius * Math.cos(angle),radius * Math.sin(angle)]; });
  const points = Array.from({length:ny+1},(_,y) => Array.from({length:nx+1},(_,x) => {
    const px = -6 + x * step, py = -2 + y * step;
    let h = 0;
    for (const [cx,cy] of centers) { const r = Math.hypot(px-cx,py-cy)/1.43; if (r < 1) h = Math.max(h,2.3*(.5+.5*Math.cos(Math.PI*r))); }
    return [px,py,h];
  }));
  const flat = [];
  for (let y=0;y<ny;y++) for(let x=0;x<nx;x++) { const a=points[y][x],b=points[y][x+1],c=points[y+1][x+1],d=points[y+1][x]; flat.push(...a,...b,...d,...b,...c,...d); }
  const positions = new Float32Array(flat), part = { ...source('real-arch'), positions, normals:new Float32Array(positions.length), triangles:positions.length/9, vertices:positions.length/3, dimensions:[12,8.1,2.3], offset:[0,0,0], rotation:[0,0,0],pose:undefined };
  const prepared = prepareCase({ id:1,revision:'real-revision',sources:[{id:part.id,arch:'upper',positions}],patientRight:{[part.id]:'image-right'} });
  assert.ok(prepared.scans[0].analysis);
  assert.ok(prepared.scans[0].scan.candidates.length >= 2);
  const file = await createPlanningSession({parts:[part],teeth:emptyToothCase(),assemblies:[],draft:{prepared,evidence:{revision:prepared.revision,sources:prepared.scans,views:[]},result:null}});
  const loaded = await readPlanningSession(roundtrip(file),[{...part,id:'new-real-arch'}]);
  assert.equal(loaded.draft.prepared.identities.length,prepared.identities.length);
  assert.equal(loaded.draft.prepared.scans[0].partId,'new-real-arch');
  assert.deepEqual(loaded.draft.prepared.scans[0].analysis.classes,prepared.scans[0].analysis.classes);
});

test('real fitter preserves selected crown shape, report and candidate parameters', async () => {
  const { fitRestoration } = await import('../src/restoration-fitting.ts');
  const input = fixture(), assembly = input.assemblies[0];
  const { templateShape } = await import('../src/crown-anatomy.ts');
  assembly.spec.crownShape = templateShape('upper',5);
  assembly.spec.anatomicalSigns = { mesial:-1,buccal:1 };
  const fitted = await fitRestoration({spec:assembly.spec,surfaces:[],options:{maxCandidates:2}});
  assembly.spec = fitted.spec;
  assembly.fit = fitted.report; assembly.candidateHistory = fitted.history;
  assembly.parts = fitted.components.map(mesh => ({ ...assembly.parts.find(part => part.restoration.component === mesh.component), ...mesh }));
  const file = await createPlanningSession(input);
  const loaded = await readPlanningSession(roundtrip(file),input.parts);
  assert.equal(loaded.assemblies[0].fit.termination,'no-surfaces');
  assert.equal(loaded.assemblies[0].fit.bestCandidate,0);
  assert.equal(loaded.assemblies[0].fit.candidateAttempts,1);
  assert.equal(loaded.assemblies[0].fit.invalidCandidates,0);
  assert.deepEqual(loaded.assemblies[0].spec.anatomicalSigns,{mesial:-1,buccal:1});
  assert.deepEqual(loaded.assemblies[0].candidateHistory,fitted.history);
  assert.ok(loaded.assemblies[0].spec.crownShape.rim instanceof Float32Array);
  assert.deepEqual(loaded.assemblies[0].spec.crownShape.occlusal,fitted.spec.crownShape.occlusal);
  for (const mutate of [
    file => { delete file.assemblies[0].fit; },
    file => { file.assemblies[0].fit.bestCandidate = 1; },
    file => { file.assemblies[0].fit.candidateAttempts = 0; },
    file => { file.assemblies[0].fit.invalidCandidates = 1; },
    file => { file.assemblies[0].candidateHistory[0].parameters.crown.width += 1; },
    file => {
      const assembly = file.assemblies[0];
      assembly.candidateHistory.push({...roundtrip(assembly.candidateHistory[0]),candidate:1,accepted:true});
      assembly.fit.candidates = 2; assembly.fit.candidateAttempts = 2; assembly.fit.bestCandidate = 1;
    },
  ]) { const invalid = roundtrip(file); mutate(invalid); await assert.rejects(readPlanningSession(invalid,input.parts), /Fitting/); }
});

test('partial legacy correction masks preserve other embedded arch protections and reject conflicts', async () => {
  const input = fixture();
  input.teeth.reviewedMask = { [input.parts[0].id]:new Uint8Array([0,1]), [input.parts[1].id]:new Uint8Array([1,0]) };
  const file = roundtrip(await createPlanningSession(input));
  file.correctionMasks = file.correctionMasks.slice(0,1);
  const restored = await readPlanningSession(file,input.parts);
  assert.deepEqual(restored.teeth.reviewedMask[input.parts[1].id],new Uint8Array([1,0]));
  file.correctionMasks[0].values = [1,1];
  await assert.rejects(readPlanningSession(file,input.parts), /conflict/);
});

test('reviewed zero-erasure correction masks persist by geometry identity and reject malformed dependencies', async () => {
  const input = fixture();
  input.teeth.reviewedMask = { [input.parts[0].id]:new Uint8Array([0,1]) };
  const file = roundtrip(await createPlanningSession(input));
  assert.deepEqual(file.correctionMasks,[{sourceKey:'scan-1',values:[0,1]}]);
  const loaded = await readPlanningSession(file,[...input.parts].reverse().map((part,index) => ({...part,id:`masked-${index}`})));
  assert.deepEqual(loaded.teeth.reviewedMask['masked-2'],new Uint8Array([0,1]));
  assert.equal(loaded.teeth.labels['masked-2'][1],0);
  for(const mutate of [
    file => { file.correctionMasks[0].values=[1]; },
    file => { file.correctionMasks[0].values=[0,255]; },
    file => { file.correctionMasks[0].sourceKey='scan-3'; },
    file => { file.correctionMasks.push({...file.correctionMasks[0]}); },
    file => { file.correctionMasks[0].sourceKey='missing'; },
  ]) {const invalid=roundtrip(file);mutate(invalid);await assert.rejects(readPlanningSession(invalid,input.parts));}
});

test('conflicting identity hypotheses remain saveable review exceptions without changing the chart', async () => {
  const input=fixture(), source=input.draft.evidence.sources[0];
  source.scan.candidates.push({...source.scan.candidates[0],id:2,faces:new Uint32Array([1]),seed:{face:1,point:[3,3,0]}});
  source.scan.unassignedTriangles=0;
  input.draft.result.mappings.push({...input.draft.result.mappings[0],candidateId:2,needsReview:true});
  const loaded=await readPlanningSession(roundtrip(await createPlanningSession(input)),input.parts);
  assert.deepEqual(loaded.draft.result.mappings.map(mapping=>[mapping.fdi,mapping.needsReview]),[[16,true],[16,true]]);
  assert.deepEqual(loaded.teeth.labels[input.parts[0].id],new Uint8Array([16,0]));
});

test('prepared sites reject absent tooth segments, bite neighbours and missing prepared source lists', async () => {
  const input=fixture();input.draft.prepared=richPrepared(input);
  const file=roundtrip(await createPlanningSession(input));
  for(const mutate of [
    file=>{file.draft.prepared.sites[0].adjacent.mesial.toothId=999;},
    file=>{file.draft.prepared.sites[0].adjacent.mesial.partId='scan-3';},
    file=>{file.draft.prepared.sites[0].opposing={partId:'scan-3',teeth:[],poseVerified:false};},
    file=>{file.draft.prepared.scans=[];},
  ]) {const invalid=roundtrip(file);mutate(invalid);await assert.rejects(readPlanningSession(invalid,input.parts),/dependenc|source|role|neighbour/);}
});

test('fitting measurement evidence requires a named compatible source dependency', async () => {
  const {fitRestoration}=await import('../src/restoration-fitting.ts');
  const input=fixture(), fitted=await fitRestoration({spec:input.assemblies[0].spec,surfaces:[]});
  input.assemblies[0].fit=fitted.report;
  const file=roundtrip(await createPlanningSession(input));
  const target={id:'missing-source:mesial',role:'adjacent',side:'mesial',targetGap:0,weight:1,targetTriangles:1,samples:1,sampledMinDistance:1,sampledRmsGapError:1,nearSamples:0,intersectingTriangles:0,intersectionTestedTriangles:1,intersectionComplete:true};
  for(const [id,role] of [['missing-source:mesial','adjacent'],['scan-3:reference','antagonist'],['scan-1:opposing','antagonist'],['scan-2:adjacent','adjacent']]) {
    const invalid=roundtrip(file);invalid.assemblies[0].fit.after.surfaces=[{...target,id,role}];
    await assert.rejects(readPlanningSession(invalid,input.parts),/fitting target source dependency/);
  }
});

test('patient donor provenance requires a source with enough faces and matching arch and anatomical class', async () => {
  const { templateShape } = await import('../src/crown-anatomy.ts');
  const input = fixture(), part = input.parts[0];
  part.positions = new Float32Array(Array.from({length:30},() => Array.from(part.positions)).flat());
  part.normals = new Float32Array(part.positions.length); part.triangles = 60; part.vertices = 180;
  input.teeth.labels[part.id] = new Uint8Array(60); input.teeth.labels[part.id][0] = 16;
  const shape = templateShape('upper',5);
  shape.source = { kind:'patient-donor', donorFdi:25, donorPartId:part.id, donorToothId:2, mirrored:true, faceCount:60, provenance:'Explicit donor resampling hypothesis.' };
  input.assemblies[0].spec.crownShape = shape;
  const file = await createPlanningSession(input);
  const loaded = await readPlanningSession(roundtrip(file),input.parts.map((part,index) => ({...part,id:`donor-${index}`})));
  assert.equal(loaded.assemblies[0].spec.crownShape.source.donorPartId,'donor-0');
  for (const mutate of [
    source => { source.donorPartId = 'scan-2'; },
    source => { source.faceCount = 61; },
    source => { source.donorFdi = 35; },
    source => { source.donorFdi = 26; },
  ]) { const invalid = roundtrip(file); mutate(invalid.assemblies[0].spec.crownShape.source); await assert.rejects(readPlanningSession(invalid,input.parts), /donor/); }
});
