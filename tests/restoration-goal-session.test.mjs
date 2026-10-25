import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlanningSession, planningSessionSchema, readPlanningSession } from '../src/planning-session.ts';
import { fixtureGingivaSchema } from '../src/restoration-gingiva-schema.ts';
import { fitRestorationToGoals, goalEvidenceRevision } from '../src/restoration-goal-fitting.ts';
import { restorationGoalSnapshot, summarizeGoalRows } from '../src/restoration-goals.ts';
import { restorationFeedbackTargetId } from '../src/restoration-feedback.ts';
import { measureFixtureGingiva } from '../src/restoration-gingiva.ts';
import { emptyToothCase } from '../src/tooth-session.ts';
import { applyRestorationEdit } from '../src/restoration-edit.ts';

const copy = value => JSON.parse(JSON.stringify(value));
const control = { yieldControl: async () => {} };
const rect = (a, b, c, d) => Float32Array.from([...a, ...b, ...c, ...a, ...c, ...d]);
const floor = z => rect([-4, -4, z], [4, -4, z], [4, 4, z], [-4, 4, z]);
function source(id, role, positions) {
  return { id, name: role, fileName: `${role}.ply`, role, positions, normals: new Float32Array(positions.length),
    triangles: positions.length / 9, vertices: positions.length / 3, dimensions: [8, 8, 0], offset: [0, 0, 0], closed: false, visible: true };
}
async function fixture(maxCandidates = 1) {
  const tissue = floor(-.4), neighbor = rect([1.3, -3, 0], [1.3, 3, 0], [1.3, 3, 4], [1.3, -3, 4]);
  const parts = [source('original-upper', 'upper', Float32Array.from([...tissue, ...neighbor])), source('original-lower', 'lower', floor(4.5))];
  const spec = { version: 'implant-assembly/v1', fdi: 15, parentPartId: parts[0].id,
    frame: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], up: [0, 0, 1] },
    parameters: { fixture: { radius: .6, length: 2, depth: 0, taper: .1 },
      abutment: { radius: .5, height: 1, emergenceRadius: .7, angleX: 0, angleY: 0 },
      crown: { width: 2, depth: 2, height: 2, cuspHeight: .4, rotation: 0 } },
    anatomy: 'premolar', provenance: 'hypothesized', units: 'file units (u)', source: 'Synthetic planning persistence test; no patient geometry.',
  };
  const surfaces = [{ id: 'original-upper:tissue', role: 'tissue', positions: tissue },
    { id: 'original-upper:mesial', role: 'adjacent', side: 'mesial', positions: neighbor },
    { id: 'original-lower:antagonist', role: 'antagonist', positions: parts[1].positions }];
  const result = await fitRestorationToGoals({ spec, surfaces, options: { maxCandidates, samplesPerSurface: 24 } }, control);
  const id = 'goal-assembly', createdAt = '2026-10-25T00:00:00.000Z';
  const assembly = { id, spec: result.spec, fit: result.report, candidateHistory: result.history, createdAt, warnings: [],
    parts: result.components.map(mesh => ({ ...mesh, id: `${id}-${mesh.component}`, name: mesh.component, fileName: `${mesh.component}.ply`,
      offset: [0, 0, 0], role: 'model', visible: true, restoration: { assemblyId: id, component: mesh.component, parentPartId: parts[0].id } })),
    previousVersions: [{ spec: structuredClone(result.spec), fit: structuredClone(result.report), candidateHistory: structuredClone(result.history), createdAt, warnings: [] }],
  };
  const input = { parts, teeth: emptyToothCase(), assemblies: [assembly] };
  return { input, result, surfaces, saved: copy(await createPlanningSession(input)) };
}
let prepared;
const setup = () => prepared ??= fixture();
const snapshots = goal => [goal.before, goal.after, goal.contract, ...goal.attempts.map(attempt => attempt.snapshot)];
const scopeMeasurements = assembly => [assembly.fit.before, assembly.fit.after, ...assembly.candidateHistory.map(entry => entry.measurement)];

test('real generated goals and gingiva save/reopen with named target remapping and no patient buffers', async () => {
  const { input, result, saved } = await setup(), original = copy(saved);
  assert.equal(planningSessionSchema.safeParse(saved).success, true);
  assert.equal(saved.version, 1);
  assert.equal(saved.assemblies[0].fit.gingiva.status, 'fail');
  for (const source of saved.sources) for (const key of ['positions', 'normals', 'surfaces', 'sampleMeasurements']) assert.equal(source[key], undefined);
  assert.deepEqual(Object.keys(saved.assemblies[0].fit.goal.targetGaps), ['scan-1:tissue', 'scan-1:mesial', 'scan-2:antagonist']);
  const reimported = input.parts.map((part, i) => ({ ...part, id: `reimported-${i}` }));
  const loaded = await readPlanningSession(saved, reimported), assembly = loaded.assemblies[0];
  assert.deepEqual(assembly.fit.goal.bounds, result.report.goal.bounds);
  assert.equal(assembly.fit.goal.evidenceRevision, result.report.goal.evidenceRevision, 'Opaque historical fingerprint is not claimed as freshly verified.');
  assert.deepEqual(assembly.fit.gingiva, result.report.gingiva);
  assert.deepEqual(assembly.parts.map(part => part.positions), input.assemblies[0].parts.map(part => part.positions));
  for (const revision of [assembly, ...assembly.previousVersions]) {
    assert.deepEqual(Object.keys(revision.fit.goal.targetGaps), ['reimported-0:tissue', 'reimported-0:mesial', 'reimported-1:antagonist']);
    assert.ok(snapshots(revision.fit.goal).every(snapshot => snapshot.rows.some(row => row.id.startsWith(restorationFeedbackTargetId('reimported-0:tissue')))));
    assert.deepEqual(revision.fit.goal.emergence?.map(item => item.target), [restorationFeedbackTargetId('reimported-0:tissue')]);
    for (const measured of scopeMeasurements(revision)) assert.deepEqual(measured.surfaces.find(surface => surface.role === 'tissue').sourceComponents, ['crown']);
  }
  assert.deepEqual(assembly.fit.goal.after, restorationGoalSnapshot({ spec: assembly.spec, components: result.components, report: assembly.fit, history: assembly.candidateHistory }, assembly.fit.gingiva, assembly.fit.goal.contract));
  assert.deepEqual(saved, original, 'Read must not mutate the supplied save.');
  const resaved = await createPlanningSession({ parts: loaded.parts, teeth: loaded.teeth, assemblies: loaded.assemblies });
  const reopened = await readPlanningSession(resaved, reimported);
  assert.deepEqual(reopened.assemblies[0].fit.goal, assembly.fit.goal);
});

test('legacy fit reports without the additive fields still reopen', async () => {
  const { input, saved } = await setup(), old = copy(saved);
  for (const revision of [old.assemblies[0], ...old.assemblies[0].previousVersions]) {
    delete revision.fit.goal; delete revision.fit.gingiva;
    for (const measured of scopeMeasurements(revision)) for (const surface of measured.surfaces) delete surface.sourceComponents;
  }
  const loaded = await readPlanningSession(old, input.parts);
  assert.equal(loaded.assemblies[0].fit.goal, undefined);
  assert.equal(loaded.assemblies[0].fit.gingiva, undefined);
  assert.equal(loaded.assemblies[0].fit.after.surfaces[0].sourceComponents, undefined);
});

test('an exact manual design outside automatic search bounds reopens with its original requirements', async () => {
  const { input, result, surfaces } = await setup();
  const spec = applyRestorationEdit(result.spec, { reason: 'Inspect an exact manual size outside automatic search bounds.', parameters: { crown: { width: 3 } } }, 'manual');
  const measured = await fitRestorationToGoals({ spec, surfaces, goalContract: result.report.goal, options: { maxCandidates: 1, samplesPerSurface: 24 } }, control);
  assert.ok(spec.parameters.crown.width > measured.report.goal.bounds['crown.width'][1]);
  const original = input.assemblies[0];
  const assembly = { ...original, spec: measured.spec, fit: measured.report, candidateHistory: measured.history,
    parts: measured.components.map(mesh => ({ ...original.parts.find(part => part.restoration.component === mesh.component), ...mesh })) };
  const saved = await createPlanningSession({ ...input, assemblies: [assembly] });
  const loaded = (await readPlanningSession(saved, input.parts)).assemblies[0];
  assert.equal(loaded.spec.parameters.crown.width, 3);
  assert.deepEqual(loaded.fit.goal.bounds, result.report.goal.bounds);
  assert.deepEqual(loaded.parts.map(part => part.positions), assembly.parts.map(part => part.positions));
});

test('recorded pilar gum samples remain bound to emitted abutment vertices on reopen', async () => {
  const { input, saved } = await setup(), forged = copy(saved);
  const report = forged.assemblies[0].fit.abutmentGingiva;
  assert.ok(report.samples > 0);
  report.sampleMeasurements[0].point[0] += .2;
  await assert.rejects(readPlanningSession(forged, input.parts), /pilar gingiva samples/i);
});

test('older additive requirement sets reopen as historical checks pending a fresh audit', async () => {
  const { input, saved } = await setup(), older = copy(saved);
  for (const revision of [older.assemblies[0], ...older.assemblies[0].previousVersions]) {
    const goal = revision.fit.goal;
    const scale = goal.contract.rows.find(row => row.id === 'relative-width')?.actual ?? revision.spec.parameters.crown.width;
    for (const snapshot of snapshots(goal)) Object.assign(snapshot, summarizeGoalRows(snapshot.rows.filter(row => !row.id.startsWith('space-occupancy.')), scale));
    goal.status = goal.after.status;
  }
  const loaded = (await readPlanningSession(older, input.parts)).assemblies[0];
  assert.deepEqual(loaded.fit.goal.bounds, saved.assemblies[0].fit.goal.bounds);
  assert.ok(loaded.warnings.some(warning => /Recheck geometry/.test(warning)));
  assert.deepEqual(loaded.parts.map(part => part.positions), input.assemblies[0].parts.map(part => part.positions));
});

test('a retry may retain an out-of-search-bounds manual baseline without making its audit unsavable', async () => {
  const { input, result } = await setup();
  const initial = await fitRestorationToGoals({ spec: result.spec, surfaces: [], options: { maxCandidates: 1 } }, control);
  const spec = applyRestorationEdit(initial.spec, { reason: 'Inspect an oversized manual concept.', parameters: { crown: { width: 10 } } }, 'manual');
  const measured = await fitRestorationToGoals({ spec, surfaces: [], goalContract: initial.report.goal, options: { maxCandidates: 3 } }, control);
  assert.equal(measured.report.goal.selectedAttempt, 0);
  assert.equal(measured.report.goal.termination, 'needs-evidence');
  const original = input.assemblies[0], assembly = { ...original, spec: measured.spec, fit: measured.report, candidateHistory: measured.history,
    parts: measured.components.map(mesh => ({ ...original.parts.find(part => part.restoration.component === mesh.component), ...mesh })) };
  const saved = await createPlanningSession({ ...input, assemblies: [assembly] });
  assert.equal((await readPlanningSession(saved, input.parts)).assemblies[0].spec.parameters.crown.width, 10);
});

test('generated multi-attempt goals retain selected final evidence and their original before history', async () => {
  const { input, result, saved } = await fixture(3);
  assert.ok(result.report.goal.attempts.length > 1);
  assert.ok(result.report.goal.selectedAttempt > 0);
  const loaded = (await readPlanningSession(saved, input.parts)).assemblies[0];
  assert.deepEqual(loaded.fit.goal.before, result.report.goal.before);
  assert.deepEqual(loaded.fit.goal.after, result.report.goal.after);
  assert.deepEqual(loaded.fit.goal.attempts, result.report.goal.attempts);
  assert.deepEqual(loaded.fit.goal.bounds, result.report.goal.bounds);
});

test('unknown zero-sample gingiva reports remain valid and never become proof', async () => {
  const { input, saved } = await setup();
  const unknown = await measureFixtureGingiva({ spec: input.assemblies[0].spec, components: [], surfaces: [] }, control);
  assert.equal(unknown.samples, 0);
  assert.equal(fixtureGingivaSchema.safeParse(unknown).success, true);
  const file = copy(saved), assembly = file.assemblies[0];
  delete assembly.fit.goal;
  assembly.fit.gingiva = unknown;
  assert.deepEqual((await readPlanningSession(file, input.parts)).assemblies[0].fit.gingiva, unknown);
});

test('gingiva schema rejects forged sample values, counts, coverage, status and clinical claims', async () => {
  const { saved } = await setup(), original = saved.assemblies[0].fit.gingiva;
  for (const mutate of [
    report => { report.maxExposure += 1; },
    report => { report.knownSamples--; },
    report => { report.samples++; },
    report => { report.missedSamples++; },
    report => { report.coverage = .5; },
    report => { report.status = 'pass'; },
    report => { report.status = 'unknown'; },
    report => { report.numericTolerance = -1; },
    report => { report.exposureTolerance = 0; },
    report => { report.sampleMeasurements[0].exposure = null; },
    report => { report.sampleMeasurements[0].exposure = Infinity; },
    report => { report.sampleMeasurements[0].status = 'missed'; },
    report => { report.sampleMeasurements[0].point[0] = NaN; },
    report => { report.sampleMeasurements[0].numericTolerance = -1; },
    report => { report.sampleMeasurements[0].exposureTolerance = 0; },
    report => { report.clinicalChecks.boneDepth = 'pass'; },
    report => { report.requiredDepthIncrease = -1; },
  ]) {
    const forged = copy(original); mutate(forged);
    assert.equal(fixtureGingivaSchema.safeParse(forged).success, false, mutate.toString());
  }
});

test('reopen rejects forged final goal rows even when selected history is forged consistently', async () => {
  const { input, saved } = await setup();
  for (const change of [
    row => { row.actual += .25; }, row => { row.status = 'pass'; }, row => { row.error = 99; }, row => { row.upper += 1; },
    row => { row.exclusiveUpper = !row.exclusiveUpper; },
  ]) {
    const file = copy(saved), goal = file.assemblies[0].fit.goal;
    for (const snapshot of [goal.before, goal.after, goal.attempts[0].snapshot]) change(snapshot.rows.find(row => row.id === 'fixture-gingiva'));
    await assert.rejects(readPlanningSession(file, input.parts), /goal|requirement|history|Invalid planning session/i);
  }
  const duplicate = copy(saved), goal = duplicate.assemblies[0].fit.goal;
  for (const snapshot of snapshots(goal)) snapshot.rows.push(copy(snapshot.rows[0]));
  await assert.rejects(readPlanningSession(duplicate, input.parts), /goal|requirement|Invalid planning session/i);
});

test('goal requirements follow IDs even when snapshot rows are reordered', async () => {
  const { input, saved } = await setup(), file = copy(saved), goal = file.assemblies[0].fit.goal;
  for (const snapshot of snapshots(goal)) snapshot.rows.reverse();
  const loaded = await readPlanningSession(file, input.parts);
  assert.equal(loaded.assemblies[0].fit.goal.after.rows[0].id, goal.after.rows[0].id);
});

test('reopen rejects wrong fixture samples, missing dependencies, scope, targets and selected parameter bounds', async () => {
  const { input, saved } = await setup();
  for (const mutate of [
    assembly => { assembly.fit.gingiva.sampleMeasurements[0].point[0] += .2; },
    assembly => { delete assembly.fit.gingiva; },
    assembly => { delete assembly.fit.quality; },
    assembly => { assembly.fit.goal.targetGaps['scan-1:tissue'] += 1; },
    assembly => { assembly.fit.goal.emergence[0].target = restorationFeedbackTargetId('wrong-target'); },
    assembly => { assembly.fit.goal.bounds['fixture.depth'] = [1, 2]; },
    assembly => { assembly.fit.goal.bounds['crown.width'] = [2, 1]; },
    assembly => { for (const measured of scopeMeasurements(assembly)) delete measured.surfaces.find(surface => surface.role === 'tissue').sourceComponents; },
    assembly => { for (const measured of scopeMeasurements(assembly)) measured.surfaces.find(surface => surface.role === 'tissue').sourceComponents = ['crown', 'abutment']; },
  ]) {
    const file = copy(saved); mutate(file.assemblies[0]);
    await assert.rejects(readPlanningSession(file, input.parts), /gingiva|quality|goal|bound|scope|fixture|Invalid planning session/i, mutate.toString());
  }
});

test('retry after ID remapping keeps original absolute bounds', async () => {
  const { input, saved, surfaces } = await setup();
  const parts = input.parts.map((part, i) => ({ ...part, id: `again-${i}` }));
  const assembly = (await readPlanningSession(saved, parts)).assemblies[0];
  const mapped = surfaces.map(surface => ({ ...surface, id: surface.id.replace('original-upper', 'again-0').replace('original-lower', 'again-1') }));
  const retryInput = { spec: structuredClone(assembly.spec), surfaces: mapped, goalContract: assembly.fit.goal, options: { maxCandidates: 1, samplesPerSurface: 24 } };
  retryInput.spec.parameters.fixture.depth = .1;
  retryInput.spec.parameters.crown.height *= 1.1;
  retryInput.spec.parameters.crown.width *= 1.1;
  assert.notEqual(goalEvidenceRevision(retryInput), assembly.fit.goal.evidenceRevision);
  const retry = await fitRestorationToGoals(retryInput, control);
  assert.deepEqual(retry.report.goal.bounds, assembly.fit.goal.bounds, 'Retry must not shift absolute bounds around the current design after source-ID remapping.');
  assert.deepEqual(retry.report.goal.targetGaps, assembly.fit.goal.targetGaps, 'Remapped target identity must not increase the frozen gaps around edited dimensions.');
  assert.deepEqual(retry.report.goal.contract, assembly.fit.goal.contract);
  for (const row of assembly.fit.goal.after.rows.filter(row => row.id.endsWith('.proximal-gap') || row.id.endsWith('.occlusal-gap'))) {
    const next = retry.report.goal.after.rows.find(item => item.id === row.id);
    assert.equal(next.upper, row.upper); assert.equal(next.lower, row.lower);
  }
});

test('an expanded crop adds requirements without rebasing existing limits and remains savable',async()=>{
 const {input,result,surfaces}=await fixture(3);
 const extra=rect([10.5,-3,0],[10.5,3,0],[10.5,3,4],[10.5,-3,4]);
 // Both the initial save and retry reference the identical full source mesh;
 // only the fitting crop adds its distant tooth patch on the retry.
 input.parts[0].positions=Float32Array.from([...input.parts[0].positions,...extra]);
 input.parts[0].normals=new Float32Array(input.parts[0].positions.length);
 input.parts[0].triangles=input.parts[0].positions.length/9;input.parts[0].vertices=input.parts[0].positions.length/3;
 await createPlanningSession(input);
 const added={id:'original-upper:other-tooth-34',role:'other-tooth',positions:extra};
 const retry=await fitRestorationToGoals({spec:result.spec,surfaces:[...surfaces,added],goalContract:result.report.goal,options:{maxCandidates:1,samplesPerSurface:24}},control);
 const goal=retry.report.goal;
 assert.deepEqual(goal.bounds,result.report.goal.bounds);
 for(const row of result.report.goal.contract.rows) assert.deepEqual(goal.contract.rows.find(r=>r.id===row.id),row);
 assert.ok(goal.contract.rows.some(r=>r.id.startsWith(restorationFeedbackTargetId(added.id))));
 const old=input.assemblies[0];
 input.assemblies=[{...old,spec:retry.spec,fit:retry.report,candidateHistory:retry.history,
  parts:retry.components.map(mesh=>({...old.parts.find(p=>p.restoration.component===mesh.component),...mesh}))}];
 const saved=await createPlanningSession(input),loaded=await readPlanningSession(saved,input.parts);
 assert.deepEqual(loaded.assemblies[0].fit.goal,goal);
});
