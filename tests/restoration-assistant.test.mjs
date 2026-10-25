import test from 'node:test';
import assert from 'node:assert/strict';
import { generateRestoration } from '../src/restoration-geometry.ts';
import { evaluateRestorationQuality } from '../src/restoration-quality.ts';
import { applyRestorationEdit, restorationEditRevision } from '../src/restoration-edit.ts';
import { applyAssistantRestorationEdit, buildRestorationAssistantSnapshot, createRestorationAssistantTools, restorationAssistantSnapshotSchema } from '../src/restoration-assistant.ts';
import { measureRestorationRelationships } from '../src/restoration-relationships.ts';

function assembly() {
  const spec = { version: 'implant-assembly/v1', fdi: 36, parentPartId: 'PRIVATE_SOURCE_ID', source: 'PRIVATE_SOURCE_FILENAME.ply',
    frame: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], up: [0, 0, 1] }, anatomy: 'molar', provenance: 'hypothesized', units: 'file units (u)',
    parameters: { fixture: { radius: 1, length: 4, depth: .5, taper: .2 }, abutment: { radius: .8, height: 2, emergenceRadius: 1, angleX: 0, angleY: 0 }, crown: { width: 4, depth: 5, height: 3, cuspHeight: .4, rotation: 90 } },
    qualityContext: { version: 'restoration-quality-context/v1', units: 'file units (u)', neighbors: [], gapWidth: null, availableHeight: null,
      placementFeedback: { provenance: 'unconfirmed-case-feedback', source: 'PRIVATE_PATIENT_FEEDBACK', subcrestalDepthMm: 1.5, adjacentToothClearanceMm: 1.5 } } };
  return make(spec);
}
function make(spec) {
  const components = generateRestoration(spec), report = evaluateRestorationQuality({ spec, components, context: spec.qualityContext });
  return { id: 'PRIVATE_ASSEMBLY_ID', spec, createdAt: '2026-10-24', warnings: [], fit: { quality: { final: report } },
    parts: components.map(mesh => ({ ...mesh, id: `PRIVATE_${mesh.component}`, fileName: 'PRIVATE_FILE.ply', name: 'PRIVATE_NAME', visible: true, offset: [0, 0, 0], role: 'model',
      restoration: { assemblyId: 'PRIVATE_ASSEMBLY_ID', component: mesh.component, parentPartId: spec.parentPartId } })) };
}
const action = snapshot => ({ assemblyId: 'restoration-1', expectedRevision: snapshot.assemblies[0].editRevision, edit: { reason: 'Review generic crown width against measured bounds.', parameters: { crown: { width: 4.2 } } } });

test('a rotated generated draft with near-zero interface offsets builds its render-time review snapshot', async () => {
  const spec = assembly().spec;
  spec.frame = { origin: [22.4, -3.7, 5.9], u: [2/3, 2/3, -1/3], v: [-1/3, 2/3, 2/3], up: [2/3, -1/3, 2/3] };
  const original = make(spec);
  original.fit.relationships = await measureRestorationRelationships({ spec, components: generateRestoration(spec), surfaces: [],
    options: { samplesPerRelationship: 8, maxDurationMs: 10_000 } }, { yieldControl: async () => {} });
  const snapshot = buildRestorationAssistantSnapshot([original]);
  const platform = snapshot.assemblies[0].relationships.interfaces[0];
  assert.equal(platform.status, 'measured');
  assert.ok(Math.abs(platform.sourceAxialOffset) < 1e-5);
  assert.ok(Math.abs(platform.targetAxialOffset) < 1e-5);
  assert.equal(restorationAssistantSnapshotSchema.safeParse(snapshot).success, true);
});

test('anonymous restoration inventory preserves actual extents, independent guardrails and unknown clinical evidence', () => {
  const original = assembly(), snapshot = buildRestorationAssistantSnapshot([original]);
  const design = snapshot.assemblies[0], encoded = JSON.stringify(snapshot);
  assert.doesNotMatch(encoded, /PRIVATE_|"positions"|"normals"|donorPartId|placementFeedback/);
  assert.equal(design.id, 'restoration-1');
  assert.match(design.editRevision, /^revision-[a-f0-9]{16}$/);
  assert.equal(design.parameters.crown.width, 4);
  assert.deepEqual(design.meshes.find(part => part.component === 'crown').dimensions, original.parts.find(part => part.component === 'crown').dimensions);
  assert.notEqual(design.quality.crownExtents.mesiodistal, design.parameters.crown.width);
  assert.equal(design.quality.guardrails.issues.length, 7);
  for (const id of ['anatomy', 'shade', 'subcrestal-placement', 'adjacent-root-clearance']) {
    const issue = design.quality.guardrails.issues.find(item => item.id === id);
    assert.equal(issue.status, 'unknown'); assert.ok(issue.missingEvidence.length); assert.ok(issue.summary.length); assert.ok(issue.suggestions.length);
  }
  for (const id of ['subcrestal-placement', 'adjacent-root-clearance']) {
    const issue = design.quality.guardrails.issues.find(item => item.id === id);
    assert.equal(issue.actual.feedbackSource, null); assert.equal(issue.target.value, 1.5); assert.equal(issue.target.units, 'mm');
    assert.equal(issue.target.provenance, 'unconfirmed-case-feedback');
  }
  assert.equal(snapshot.units, 'file units');
  assert.ok(design.quality.unassessed.includes('clinical-shade-match'));
  assert.equal(restorationAssistantSnapshotSchema.safeParse({ ...snapshot, assemblies: [{ ...design, positions: [1, 2, 3] }] }).success, false);
  assert.throws(() => buildRestorationAssistantSnapshot(Array(65).fill(original)), /64/);
});

test('read-only/default/budget-exhausted modes never register requestRestorationEdit', () => {
  const snapshot = buildRestorationAssistantSnapshot([assembly()]);
  for (const options of [undefined, { allowEdits: false }, { allowEdits: true, editsUsed: 8 }]) {
    const tools = createRestorationAssistantTools(snapshot, options);
    assert.equal('requestRestorationEdit' in tools, false);
    assert.equal(tools.getRestorationDesign.execute({}).assemblies.length, 1);
  }
  assert.equal('requestRestorationEdit' in createRestorationAssistantTools(undefined, { allowEdits: true }), false);
  const empty = createRestorationAssistantTools(buildRestorationAssistantSnapshot([]), { allowEdits: true });
  assert.equal('requestRestorationEdit' in empty, false);
  const unavailable = empty.getRestorationDesign.execute({});
  assert.equal(unavailable.status, 'unavailable'); assert.deepEqual(unavailable.availableAssemblyIds, []);
  assert.match(unavailable.reason, /No current restoration concepts were constructed/);
});

test('edit request validates fresh known revisions, rejects malformed values, and emits one pending action only', () => {
  const snapshot = buildRestorationAssistantSnapshot([assembly()]);
  const tools = createRestorationAssistantTools(snapshot, { allowEdits: true }), edit = action(snapshot);
  assert.equal(tools.requestRestorationEdit.execute(edit).code, 'fresh-evidence-required');
  tools.getRestorationDesign.execute({ assemblyId: 'restoration-1' });
  assert.equal(tools.requestRestorationEdit.execute(edit, { messages: [], toolCallId: 'same-step' }).code, 'fresh-evidence-required');
  for (const bad of [ { ...edit, assemblyId: 'restoration-2' }, { ...edit, expectedRevision: 'revision-0000000000000000' },
    { ...edit, edit: { reason: 'invalid', parameters: { fixture: { radius: -1 } } } }, { ...edit, edit: { reason: 'unsupported', position: [1, 2, 3] } }, { ...edit, edit: { reason: 'no values' } } ]) {
    assert.equal(tools.requestRestorationEdit.execute(bad).status, 'error');
  }
  const result = tools.requestRestorationEdit.execute(edit);
  assert.equal(result.status, 'requested'); assert.equal(result.applied, false); assert.deepEqual(result.request, edit);
  assert.equal(tools.requestRestorationEdit.execute(edit).code, 'one-edit-per-snapshot');
});

test('host uses local engine revision, awaits actual output, and returns exact before/after', async () => {
  const original = assembly(), snapshot = buildRestorationAssistantSnapshot([original]), edit = action(snapshot), signal = new AbortController().signal;
  let complete; const pending = new Promise(resolve => { complete = resolve; });
  let calls = 0;
  const work = applyAssistantRestorationEdit({ assemblies: [original], busy: false, applyEdit: async (id, patch, revision, actualSignal) => {
    calls++; assert.equal(id, original.id); assert.equal(revision, restorationEditRevision(original)); assert.equal(actualSignal, signal); assert.deepEqual(patch, edit.edit);
    return pending;
  } }, edit, signal);
  let settled = false; work.then(() => { settled = true; }); await Promise.resolve(); assert.equal(settled, false);
  const actual = make(applyRestorationEdit(original.spec, edit.edit, 'agent')); complete(actual);
  const { result, assembly: returned } = await work;
  assert.equal(calls, 1); assert.equal(returned, actual); assert.equal(result.status, 'applied'); assert.deepEqual(result.before, snapshot.assemblies[0]);
  assert.deepEqual(result.after, buildRestorationAssistantSnapshot([actual]).assemblies[0]);
  assert.equal(result.after.parameters.crown.width, 4.2);
  assert.notEqual(result.after.editRevision, result.before.editRevision);
});

test('stale/busy edits start no worker; failures return structured errors and aborted work never reports success', async () => {
  const original = assembly(), snapshot = buildRestorationAssistantSnapshot([original]), edit = action(snapshot);
  const source = { assemblies: [original], busy: false, applyEdit: async () => assert.fail('Worker must not start') };
  assert.equal((await applyAssistantRestorationEdit(source, { ...edit, expectedRevision: 'revision-0000000000000000' }, new AbortController().signal)).result.code, 'stale');
  assert.equal((await applyAssistantRestorationEdit({ ...source, busy: true }, edit, new AbortController().signal)).result.code, 'busy');
  const failed = await applyAssistantRestorationEdit({ ...source, applyEdit: async () => { throw new Error('PRIVATE_DIAGNOSTIC'); } }, edit, new AbortController().signal);
  assert.equal(failed.result.status, 'error'); assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_DIAGNOSTIC/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(applyAssistantRestorationEdit(source, edit, controller.signal), { name: 'AbortError' });
  const active = new AbortController();
  await assert.rejects(applyAssistantRestorationEdit({ ...source, applyEdit: async () => { active.abort(); return original; } }, edit, active.signal), { name: 'AbortError' });
});

test('selection maps to a known anonymous alias and draft tooth templates remain distinct from recorded FDI', () => {
  const first = assembly(), second = { ...assembly(), id: 'PRIVATE_OTHER', draftSite: true };
  const snapshot = buildRestorationAssistantSnapshot([first, second], second.id);
  assert.equal(snapshot.selectedAssemblyId, 'restoration-2');
  assert.deepEqual(snapshot.assemblies[0].site, { identity: 'recorded-fdi', fdi: 36, templateFdi: null });
  assert.deepEqual(snapshot.assemblies[1].site, { identity: 'unreviewed-draft', fdi: null, templateFdi: 36 });
  assert.equal(createRestorationAssistantTools(snapshot).getRestorationDesign.execute({}).selectedAssemblyId, 'restoration-2');
  assert.equal(restorationAssistantSnapshotSchema.safeParse({ ...snapshot, selectedAssemblyId: 'restoration-3' }).success, false);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_/);
});
