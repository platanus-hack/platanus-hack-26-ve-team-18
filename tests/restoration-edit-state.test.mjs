import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { Matrix4 } from 'three';
import { partMatrix } from '../src/pose.ts';
import { emptyToothCase } from '../src/tooth-session.ts';
import { fitRestoration } from '../src/restoration-fitting.ts';
import { fitRestorationToGoals } from '../src/restoration-goal-fitting.ts';
import { fittingSurfaces } from '../src/workflow-geometry.ts';
import { crownEnamel } from '../src/crown-enamel.ts';

import { restorationEditRevision } from '../src/restoration-edit.ts';

const hookUrl = new URL('../src/useRestorations.ts', import.meta.url);
// This repository has no DOM/hook test dependency. Run the actual hook with a
// small state/effect scheduler and controlled workers; no production code copy.
const hookSource = stripTypeScriptTypes(await readFile(hookUrl, 'utf8'))
  .replace(/import\s*\{([^}]+)\}\s*from\s*['"]react['"];?/, 'const {$1} = globalThis.__restorationStateTest.hooks;\nconst {Worker, setTimeout, clearTimeout} = globalThis.__restorationStateTest;')
  .replace(/from\s*(['"])(\.\/[^'"]+)\1/g, (_, quote, relative) => `from ${JSON.stringify(new URL(relative.endsWith('.ts') ? relative : `${relative}.ts`, hookUrl).href)}`)
  .replaceAll('import.meta.url', JSON.stringify(hookUrl.href));
let moduleNumber = 0;
const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));

function sourcePart() {
  return { id: 'synthetic-lower', role: 'lower', name: 'Synthetic source', fileName: 'synthetic.ply',
    positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0), normals: new Float32Array(9),
    triangles: 1, vertices: 3, closed: false, visible: true, dimensions: [1, 1, 0], offset: [0, 0, 0] };
}
function concept(fdi = 36, partIds) {
  const spec = { version: 'implant-assembly/v1', fdi, parentPartId: 'synthetic-lower',
    frame: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], up: [0, 0, 1] },
    parameters: { fixture: { radius: 1, length: 4, depth: 0, taper: .1 },
      abutment: { radius: .8, height: 2, emergenceRadius: 1, angleX: 0, angleY: 0 },
      crown: { width: 4, depth: 4, height: 3, cuspHeight: .5, rotation: 0 } },
    anatomy: 'molar', provenance: 'hypothesized', units: 'file units (u)', source: 'Synthetic editable hypothesis; bone and interface unassessed.' };
  if (partIds) spec.siteEvidence = { method: 'reviewed-surface', partIds: [...partIds], fdis: [fdi - 1, fdi, fdi + 1],
    surface: { partId: spec.parentPartId, face: 0, point: [...spec.frame.origin] } };
  return spec;
}
function toothCase() {
  const data = emptyToothCase();
  data.labels['synthetic-lower'] = Uint8Array.of(0);
  for (const fdi of [36, 46]) data.teeth[fdi] = { status: 'missing', restoration: 'implant', note: '',
    site: { partId: 'synthetic-lower', face: 0, point: [0, 0, 0] } };
  return data;
}
async function harness(t) {
  const slots = [], effects = [], workers = [], timers = new Set();
  let cursor = 0, dirty = false, api, useRestorations;
  const h = { parts: [sourcePart()], teeth: toothCase(), hypothesisRevision: null,
    get api() { return api; }, get queuedWorkerCount() { return workers.length; },
    render(patch = {}) {
      Object.assign(h, patch);
      for (let pass = 0; pass < 12; pass++) {
        cursor = 0; dirty = false; api = useRestorations(h.parts, h.teeth, h.hypothesisRevision);
        for (const slot of effects.splice(0)) { slot.cleanup?.(); slot.cleanup = slot.effect(); }
        if (!dirty) return api;
      }
      throw new Error('Hook scheduler did not settle.');
    },
    takeWorker() { assert.ok(workers.length, 'Expected a pending worker request'); return workers.shift(); },
    dispose() {
      api?.cancel();
      for (const slot of slots) if (slot.kind === 'effect') slot.cleanup?.();
      for (const timer of timers) clearTimeout(timer);
    } };
  const runtime = {
    hooks: {
      useState(initial) {
        const index = cursor++, slot = slots[index] ??= { kind: 'state', value: typeof initial === 'function' ? initial() : initial };
        return [slot.value, update => { const next = typeof update === 'function' ? update(slot.value) : update; if (!Object.is(next, slot.value)) { slot.value = next; dirty = true; } }];
      },
      useRef(initial) { return (slots[cursor++] ??= { kind: 'ref', value: { current: initial } }).value; },
      useMemo(factory, deps) {
        const index = cursor++, previous = slots[index];
        if (!previous || !sameDeps(previous.deps, deps)) slots[index] = { kind: 'memo', deps, value: factory() };
        return slots[index].value;
      },
      useEffect(effect, deps) {
        const index = cursor++, previous = slots[index];
        if (!previous || !sameDeps(previous.deps, deps)) {
          const slot = slots[index] = { kind: 'effect', effect, deps, cleanup: previous?.cleanup };
          effects.push(slot);
        }
      },
    },
    Worker: class {
      constructor(url) { this.url = url.href; this.terminated = false; }
      postMessage(request) { this.request = structuredClone(request); workers.push(this); }
      terminate() { this.terminated = true; }
      reply(response) { this.onmessage({ data: { id: this.request.id, ...response } }); }
    },
    setTimeout(callback, delay) { const timer = setTimeout(() => { timers.delete(timer); callback(); }, delay); timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
  };
  const previous = globalThis.__restorationStateTest;
  globalThis.__restorationStateTest = runtime;
  try {
    ({ useRestorations } = await import(`data:text/javascript;base64,${Buffer.from(hookSource).toString('base64')}#${++moduleNumber}`));
  } finally {
    if (previous === undefined) delete globalThis.__restorationStateTest; else globalThis.__restorationStateTest = previous;
  }
  h.render(); t.after(() => h.dispose()); return h;
}
const microtasks = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
async function replyFit(worker, surfaces = []) {
  assert.equal(worker.request.type, 'prepare-fit');
  assert.ok(worker.url.endsWith('/restoration-fit.worker.ts'));
  assert.ok(worker.request.spec);
  assert.ok(Array.isArray(worker.request.parts));
  assert.ok(worker.request.options.maxCandidates > 0);
  // Geometry/result fixtures use the real executor, usually without targets;
  // this suite controls lifecycle, while fitter tests cover measurements.
  const result = await fitRestorationToGoals({ spec: worker.request.spec, surfaces, options: { maxCandidates: 1 }, goalContract: worker.request.goalContract });
  worker.reply({ type: 'result', result });
  return result;
}
const isStale = assembly => assembly.warnings.some(warning => warning.startsWith('STALE:'));
const currentAssemblies = h => h.api.assemblies.filter(assembly => !isStale(assembly));
function retainedStale(h, id) {
  const assembly = h.api.assemblies.find(assembly => id === undefined || assembly.id === id);
  assert.ok(assembly, 'A completed candidate must remain available after evidence changes.');
  assert.equal(isStale(assembly), true, 'Retained evidence must be visibly marked stale.');
  assert.notEqual(h.api.selectedId, assembly.id);
  assert.equal(h.api.siteReadiness.find(site => site.fdi === assembly.spec.fdi)?.status, 'needs-input');
  assert.doesNotThrow(() => h.api.exportPart(assembly.parts[0].id), 'Stale part exports must stop before touching the browser download API.');
  return assembly;
}

test('a rejected agent candidate never replaces geometry, revision or history; manual inspection stays available', async t => {
  const h = await harness(t), original = await createAssembly(h);
  const change = { reason: 'Synthetic oversized pilar regression.', parameters: { abutment: { radius: 8 } } };
  const pending = h.api.edit(original.id, change, { actor: 'agent', expectedRevision: restorationEditRevision(original) });
  const rejected = assert.rejects(pending, error => error.name === 'RestorationEditRejected' && error.candidate.quality.status === 'fail');
  await replyFit(h.takeWorker()); await rejected; h.render();
  assert.equal(h.api.assemblies[0], original);
  assert.equal(restorationEditRevision(h.api.assemblies[0]), restorationEditRevision(original));
  assert.equal(h.api.assemblies[0].previousVersions, original.previousVersions);
  const manual = h.api.edit(original.id, change, { actor: 'manual' });
  await replyFit(h.takeWorker()); const inspected = await manual; h.render();
  assert.equal(inspected.spec.parameters.abutment.radius, 8);
  assert.equal(inspected.fit.quality.final.status, 'fail');
  assert.equal(inspected.previousVersions.length, 1);
});

test('legacy assemblies are measured before agent edits without mutating their baseline', async t => {
  const h = await harness(t), original = await createAssembly(h);
  delete original.fit;
  const pending = h.api.edit(original.id, { reason: 'Legacy candidate requiring baseline.', parameters: { abutment: { radius: 8 } } }, { actor: 'agent' });
  const rejected = assert.rejects(pending, error => error.name === 'RestorationEditRejected');
  const baselineWorker = h.takeWorker();
  assert.equal(baselineWorker.request.spec.parameters.abutment.radius, original.spec.parameters.abutment.radius);
  await replyFit(baselineWorker); await microtasks();
  assert.equal(original.fit, undefined);
  const candidateWorker = h.takeWorker();
  assert.equal(candidateWorker.request.spec.parameters.abutment.radius, 8);
  await replyFit(candidateWorker); await rejected; h.render();
  assert.equal(h.api.assemblies[0], original);
  assert.equal(original.fit, undefined);
});

test('an out-of-bounds agent width is rejected atomically while the exact manual edit remains inspectable', async t => {
  const h = await harness(t), original = await createAssembly(h), saved = structuredClone(original);
  const revision = restorationEditRevision(original);
  assert.deepEqual(original.fit.goal.bounds['crown.width'], [3.4, 5.4]);
  const change = { reason: 'Inspect width below the inherited goal bound.', parameters: { crown: { width: 3.3 } } };
  const pending = h.api.edit(original.id, change, { actor: 'agent', expectedRevision: revision });
  const rejected = assert.rejects(pending, error => error.name === 'RestorationEditRejected'
    && error.reasons.some(reason => /outside.*original goal bounds/.test(reason)) && error.candidate.parameters.crown.width === 3.3);
  await replyFit(h.takeWorker()); await rejected; h.render();
  assert.equal(h.api.assemblies[0], original);
  assert.deepEqual(original, saved);
  assert.equal(restorationEditRevision(original), revision);
  const manual = h.api.edit(original.id, change, { actor: 'manual', expectedRevision: revision });
  await replyFit(h.takeWorker()); const inspected = await manual; h.render();
  assert.equal(inspected.spec.parameters.crown.width, 3.3);
  assert.equal(inspected.previousVersions.length, 1);
  assert.deepEqual(inspected.previousVersions[0].spec, original.spec);
});

test('refreshing an incomplete agent baseline forwards its original goal contract to both measurements', async t => {
  const surfaces = [{ id: 'synthetic-neighbor', role: 'adjacent', side: 'mesial', targetGap: .013,
    positions: Float32Array.of(5,-10,-10, 5,10,-10, 5,10,10, 5,-10,-10, 5,10,10, 5,-10,10) }];
  const h = await harness(t), initial = await createAssembly(h, concept(), [], surfaces);
  const firstEdit = h.api.edit(initial.id, { reason: 'Widen toward the supplied neighbor.', parameters: { crown: { width: 4.4 } } }, { actor: 'agent' });
  await replyFit(h.takeWorker(), surfaces); const original = await firstEdit; h.render();
  assert.deepEqual(original.fit.goal.bounds, initial.fit.goal.bounds);
  assert.deepEqual(original.fit.goal.contract, initial.fit.goal.contract);
  original.fit.after.surfaces[0].intersectionComplete = false;
  const saved = structuredClone(original), revision = restorationEditRevision(original);
  const pending = h.api.edit(original.id, { reason: 'Appearance review after refreshing a capped audit.', appearance: { crown: { color: '#ddddcc' } } }, { actor: 'agent', expectedRevision: revision });
  void pending.catch(() => {}); // Cleanup can cancel this request if a forwarding assertion fails.
  const baselineWorker = h.takeWorker();
  assert.equal(baselineWorker.request.spec.parameters.crown.width, 4.4);
  assert.deepEqual(baselineWorker.request.goalContract, saved.fit.goal);
  const baseline = await replyFit(baselineWorker, surfaces); await microtasks();
  assert.deepEqual(baseline.report.goal.bounds, initial.fit.goal.bounds);
  assert.deepEqual(baseline.report.goal.contract, initial.fit.goal.contract);
  assert.deepEqual(baseline.report.goal.targetGaps, initial.fit.goal.targetGaps);
  assert.equal(h.api.assemblies[0], original);
  assert.deepEqual(original, saved);
  assert.equal(restorationEditRevision(original), revision);
  const candidateWorker = h.takeWorker();
  assert.deepEqual(candidateWorker.request.goalContract, baseline.report.goal);
  await replyFit(candidateWorker, surfaces); const edited = await pending; h.render();
  assert.deepEqual(edited.fit.goal.bounds, initial.fit.goal.bounds);
  assert.deepEqual(edited.fit.goal.contract, initial.fit.goal.contract);
  assert.deepEqual(edited.fit.goal.targetGaps, initial.fit.goal.targetGaps);
  assert.equal(edited.previousVersions.length, 2);
  assert.deepEqual(original, saved);
});

async function createAssembly(h, spec = concept(), proposals = [], surfaces = []) {
  const work = h.api.create([spec.fdi], h.teeth, [], proposals);
  h.takeWorker().reply({ specs: [spec], warnings: [] });
  await microtasks();
  await replyFit(h.takeWorker(), surfaces);
  await work; h.render();
  const assembly = h.api.assemblies.find(item => item.spec.fdi === spec.fdi);
  assert.ok(assembly, `Expected generated assembly for FDI ${spec.fdi}`);
  return assembly;
}
const editRecord = (h, fdi, patch) => ({ ...h.teeth, teeth: { ...h.teeth.teeth, [fdi]: { ...h.teeth.teeth[fdi], ...patch } } });
const proposal = (fdi = 36) => ({ fdi, evidence: ['view-1'], rationale: 'Synthetic possible gap' });
const settlesImmediately = work => Promise.race([work.then(() => true), new Promise(resolve => setImmediate(() => resolve(false)))]);
const replacePart = (h, id, patch) => ({ parts: h.parts.map(part => part.id === id ? { ...part, ...patch(part) } : part) });

function withSiteEvidence(h) {
  // Localization can depend on disconnected parts of one file and on a competing import.
  const parts = [
    { ...h.parts[0], sourceFileId: 'source-a', tissueScores: Float32Array.of(.1) },
    { ...sourcePart(), id: 'supporting-lower', sourceFileId: 'source-a', offset: [3, 0, 0], tissueScores: Float32Array.of(.2) },
    { ...sourcePart(), id: 'competing-lower', sourceFileId: 'source-b', offset: [-3, 0, 0], tissueScores: Float32Array.of(.3) },
  ];
  h.render({ parts, teeth: { ...h.teeth, labels: { ...h.teeth.labels,
    'supporting-lower': Uint8Array.of(35), 'competing-lower': Uint8Array.of(37) } } });
  return concept(36, parts.map(part => part.id));
}


test('shared manual and agent edits measure one exact candidate and preserve visibility, chart and revisions', async t => {
  const h = await harness(t), original = await createAssembly(h), chart = structuredClone(h.teeth);
  const staleCallback = h.api.edit;
  const manual = h.api.edit(original.id, { reason: 'Review requested crown width.', parameters: { crown: { width: 4.4 } }, appearance: { crown: { color: '#bbccdd', roughness: 0.7 } } }, { expectedRevision: restorationEditRevision(original) });
  const worker = h.takeWorker();
  assert.equal(worker.request.options.maxCandidates, 1);
  assert.equal(worker.request.spec.parameters.crown.width, 4.4);
  h.api.togglePart(original.parts[0].id); // A toggle during work must survive commit.
  await replyFit(worker); const edited = await manual; h.render();
  assert.equal(edited.spec.provenance, 'clinician-entered');
  assert.equal(edited.parts[0].visible, false);
  assert.equal(edited.previousVersions.length, 1); assert.deepEqual(edited.previousVersions[0].spec, original.spec);
  assert.equal(edited.parts[2].presentationColor, '#bbccdd'); assert.equal(edited.parts[2].presentationRoughness, 0.7);
  const displayed = h.api.displayParts.find(part => part.restoration.component === 'crown');
  assert.equal(crownEnamel(displayed).source, 'manual-display-color');
  assert.equal(displayed.presentationColor, '#bbccdd'); assert.equal(displayed.presentationRoughness, 0.7);
  assert.deepEqual(h.teeth, chart);
  const agent = staleCallback(original.id, { reason: 'Inspect bounded contour change.', contour: { cervicalScale: 0.9 } }, { actor: 'agent', expectedRevision: restorationEditRevision(edited) });
  const nextWorker = h.takeWorker();
  assert.equal(nextWorker.request.spec.parameters.crown.width, 4.4, 'A callback captured before the manual edit uses current state.');
  assert.equal(nextWorker.request.options.maxCandidates, 1);
  await replyFit(nextWorker); const next = await agent; h.render();
  assert.equal(next.spec.provenance, 'hypothesized'); assert.equal(next.spec.editProvenance.actor, 'agent');
  assert.equal(next.previousVersions.length, 2); assert.equal(next.parts[0].visible, false);
  assert.deepEqual(next.spec.parameters, edited.spec.parameters);
  assert.notEqual(restorationEditRevision(next), restorationEditRevision(edited));
});

test('manual dimensions and measurement-only rechecks preserve the original absolute requirements', async t => {
  const h = await harness(t), initial = await createAssembly(h);
  const manual = h.api.edit(initial.id, { reason: 'Inspect a larger crown against the same requirements.', parameters: { crown: { width: 4.5 } } });
  const worker = h.takeWorker();
  assert.deepEqual(worker.request.goalContract, initial.fit.goal);
  await replyFit(worker); const edited = await manual; h.render();
  assert.deepEqual(edited.fit.goal.bounds, initial.fit.goal.bounds);
  assert.deepEqual(edited.fit.goal.contract, initial.fit.goal.contract);
  const recheck = h.api.recheck(edited.id), audit = h.takeWorker();
  assert.equal(audit.request.options.maxCandidates, 1);
  assert.deepEqual(audit.request.spec.parameters, edited.spec.parameters);
  assert.deepEqual(audit.request.goalContract, edited.fit.goal);
  await replyFit(audit); const checked = await recheck; h.render();
  assert.deepEqual(checked.spec.parameters, edited.spec.parameters);
  assert.deepEqual(checked.fit.goal.bounds, initial.fit.goal.bounds);
  assert.deepEqual(checked.fit.goal.contract, initial.fit.goal.contract);
  for (let i = 0; i < edited.parts.length; i++) assert.deepEqual(checked.parts[i].positions, edited.parts[i].positions);
  assert.equal(checked.previousVersions.length, 2);
});

test('geometry rechecks cancel on source changes and retain the previous revision', async t => {
  const h = await harness(t), original = await createAssembly(h);
  const pending = h.api.recheck(original.id);
  const rejected = assert.rejects(pending, /evidence changed/i), worker = h.takeWorker();
  h.render({ parts: h.parts.map(part => ({ ...part, positions: part.positions.slice() })) });
  assert.equal(worker.terminated, true);
  await rejected;
  await replyFit(worker); h.render();
  const retained = h.api.assemblies.find(item => item.id === original.id);
  assert.deepEqual(retained.spec, original.spec);
  assert.deepEqual(retained.previousVersions, original.previousVersions);
  assert.equal(isStale(retained), true);
});

test('rechecking an older agent design upgrades additive checks without an agent-edit rejection', async t => {
  const h = await harness(t), original = await createAssembly(h);
  original.spec.editProvenance = { actor: 'agent', reason: 'Earlier hypothetical design.' };
  delete original.fit.abutmentGingiva;
  for (const snapshot of [original.fit.goal.before, original.fit.goal.after, original.fit.goal.contract, ...original.fit.goal.attempts.map(attempt => attempt.snapshot)]) {
    snapshot.rows = snapshot.rows.filter(row => row.id !== 'abutment-gingiva' && !row.id.startsWith('space-occupancy.'));
  }
  const pending = h.api.recheck(original.id), worker = h.takeWorker();
  assert.equal(worker.request.options.maxCandidates, 1);
  await replyFit(worker); const checked = await pending; h.render();
  assert.ok(checked.fit.goal.after.rows.some(row => row.id === 'abutment-gingiva'));
  assert.deepEqual(checked.fit.goal.bounds, original.fit.goal.bounds);
  assert.deepEqual(checked.spec.parameters, original.spec.parameters);
  assert.deepEqual(checked.parts.map(part => part.positions), original.parts.map(part => part.positions));
});

test('copies of prior edits retain that revision\'s absolute fit requirements', async t => {
  const h = await harness(t), original = await createAssembly(h);
  for (const width of [4.5, 4.8]) {
    const pending = h.api.edit(original.id, { reason: 'Inspect a manual width.', parameters: { crown: { width } } });
    await replyFit(h.takeWorker()); await pending; h.render();
  }
  const current = h.api.assemblies[0], historical = current.previousVersions[1];
  const pending = h.api.compare(current.id, undefined, 1), worker = h.takeWorker();
  assert.equal(worker.request.spec.parameters.crown.width, 4.5);
  assert.deepEqual(worker.request.goalContract, historical.fit.goal);
  await replyFit(worker); await pending; h.render();
  assert.deepEqual(h.api.assemblies.at(-1).fit.goal.bounds, original.fit.goal.bounds);
});

test('display enamel follows local scan color updates and reopening without changing saved geometry or fit evidence', async t => {
  const h = await harness(t), positions = [];
  for (let y = -1.2; y < 1.3; y += .8) for (let z = 1; z <= 4; z++) positions.push(3, y, z, 3, y + .3, z, 3, y, z + .3);
  const colors = Float32Array.from(positions, (_, i) => [.5, .48, .42][i % 3]);
  const source = { ...h.parts[0], positions: Float32Array.from(positions), normals: new Float32Array(positions.length), colors,
    tissueScores: new Float32Array(positions.length / 9), triangles: positions.length / 9, vertices: positions.length / 3 };
  h.render({ parts: [source] });
  const original = await createAssembly(h), raw = original.parts.find(part => part.restoration.component === 'crown');
  const displayed = h.api.displayParts.find(part => part.restoration.component === 'crown');
  assert.equal(crownEnamel(displayed).source, 'nearby-scan-colors');
  assert.equal(displayed.positions, raw.positions);
  assert.equal(raw.colors, undefined, 'appearance buffers stay outside saved component geometry');
  const newColors = Float32Array.from(positions, (_, i) => [.4, .39, .35][i % 3]);
  h.render({ parts: [{ ...source, colors: newColors }] });
  const recolored = h.api.displayParts.find(part => part.restoration.component === 'crown');
  assert.notEqual(recolored.presentationColor, displayed.presentationColor);
  assert.equal(recolored.positions, raw.positions);
  assert.equal(h.api.assemblies[0], original, 'presentation updates do not revise or invalidate an assembly');
  assert.equal(isStale(original), false);
  h.api.restore(structuredClone(h.api.assemblies)); h.render();
  const reopened = h.api.displayParts.find(part => part.restoration.component === 'crown');
  assert.equal(reopened.presentationColor, recolored.presentationColor);
  assert.deepEqual(reopened.colors, recolored.colors);
  assert.equal(crownEnamel(reopened).source, 'nearby-scan-colors');
});

test('editing the first of multiple assemblies preserves inventory order and the untouched design', async t => {
  const h = await harness(t), first = await createAssembly(h, concept(36)), second = await createAssembly(h, concept(46));
  const ids = h.api.assemblies.map(item => item.id);
  assert.deepEqual(ids, [first.id, second.id]);
  assert.equal(h.api.selectedId, second.id);
  const pending = h.api.edit(first.id, { reason: 'Keep anonymous design aliases stable during a local edit.', parameters: { crown: { width: 4.2 } } }, { actor: 'agent', expectedRevision: restorationEditRevision(first) });
  await replyFit(h.takeWorker()); const edited = await pending; h.render();
  assert.deepEqual(h.api.assemblies.map(item => item.id), ids);
  assert.equal(h.api.assemblies[0], edited);
  assert.equal(h.api.assemblies[1], second);
  assert.equal(h.api.selectedId, second.id, 'Editing another named concept does not change user selection.');
  const again = h.api.edit(first.id, { reason: 'Continue editing the same anonymous design.', parameters: { crown: { width: 4.3 } } }, { actor: 'agent', expectedRevision: restorationEditRevision(edited) });
  await replyFit(h.takeWorker()); await again; h.render();
  assert.deepEqual(h.api.assemblies.map(item => item.id), ids);
  assert.equal(h.api.assemblies[1], second);
});

test('stale revisions, no-op and invalid edits reject before worker creation and expose errors', async t => {
  const h = await harness(t), original = await createAssembly(h);
  for (const [edit, options, pattern] of [
    [{ reason: 'Width.', parameters: { crown: { width: 4.3 } } }, { expectedRevision: 'stale' }, /revision changed/],
    [{ reason: 'No-op.', parameters: { crown: { width: 4 } } }, {}, /does not change/],
    [{ reason: 'Bad contour.', contour: { cervicalScale: 5 } }, {}, /1.5/],
    [{ reason: 'Forbidden.', parameters: { fixture: { boneDepth: 1.5 } } }, {}, /Unrecognized/],
  ]) {
    await assert.rejects(h.api.edit(original.id, edit, options), pattern); h.render();
    assert.match(h.api.error, pattern); assert.equal(h.queuedWorkerCount, 0); assert.equal(h.api.assemblies[0], original);
  }
});

test('conflicting edit rejects without terminating or replacing active work', async t => {
  const h = await harness(t), original = await createAssembly(h);
  const first = h.api.edit(original.id, { reason: 'First.', contour: { cervicalScale: 0.9 } });
  const worker = h.takeWorker();
  await assert.rejects(h.api.edit(original.id, { reason: 'Second.', contour: { cervicalScale: 0.8 } }), /operation is active/);
  assert.equal(worker.terminated, false); assert.equal(h.queuedWorkerCount, 0);
  await replyFit(worker); assert.equal((await first).spec.contour.cervicalScale, 0.9);
});

test('abort terminates workers and late responses cannot mutate assembly or history', async t => {
  const h = await harness(t), original = await createAssembly(h), controller = new AbortController();
  const work = h.api.edit(original.id, { reason: 'Cancelled edit.', contour: { occlusalScale: 0.8 } }, { signal: controller.signal });
  const rejected = assert.rejects(work, error => error.name === 'AbortError');
  const worker = h.takeWorker(); controller.abort(); await rejected;
  assert.equal(worker.terminated, true);
  await replyFit(worker); await microtasks(); h.render();
  assert.equal(h.api.assemblies[0], original); assert.equal(h.api.busy, false);
  await assert.rejects(h.api.edit(original.id, { reason: 'Already aborted.', contour: { cervicalScale: 0.8 } }, { signal: controller.signal }), error => error.name === 'AbortError');
  assert.equal(h.queuedWorkerCount, 0);
});

test('source changes invalidate pending edits and saved callbacks cannot edit stale source evidence', async t => {
  const h = await harness(t), original = await createAssembly(h), callback = h.api.edit;
  const work = callback(original.id, { reason: 'Pending.', contour: { cervicalScale: 0.9 } });
  const rejected = assert.rejects(work, /evidence changed/i), worker = h.takeWorker();
  h.render({ parts: [{ ...h.parts[0], positions: h.parts[0].positions.slice() }] });
  await rejected; assert.equal(worker.terminated, true);
  await replyFit(worker); await microtasks(); h.render();
  assert.equal(h.api.assemblies.length, 1); assert.equal(h.api.assemblies[0].previousVersions, undefined);
  assert.equal(isStale(h.api.assemblies[0]), true);
  await assert.rejects(callback(original.id, { reason: 'Outdated source.', contour: { cervicalScale: 0.9 } }), /evidence changed/i);
  assert.equal(h.queuedWorkerCount, 0);
});

test('the current assembly revision is checked again when a worker reply arrives', async t => {
  const h = await harness(t), original = await createAssembly(h);
  const work = h.api.edit(original.id, { reason: 'Pending.', contour: { cervicalScale: 0.9 } });
  const rejected = assert.rejects(work, /revision changed/), worker = h.takeWorker();
  // Simulate a newer state revision appearing before the worker callback.
  original.createdAt = '2026-10-24T20:00:00.000Z';
  await replyFit(worker); await rejected; h.render();
  assert.equal(h.api.assemblies[0], original); assert.equal(original.previousVersions, undefined);
});

test('worker failures reject atomically and keep the previously successful assembly', async t => {
  const h = await harness(t), original = await createAssembly(h);
  const work = h.api.edit(original.id, { reason: 'Geometry failure.', contour: { cervicalScale: 0.9 } });
  const rejected = assert.rejects(work, /synthetic geometry failure/);
  h.takeWorker().reply({ type: 'error', error: 'synthetic geometry failure' });
  await rejected; h.render();
  assert.equal(h.api.assemblies[0], original); assert.equal(h.api.busy, false); assert.match(h.api.error, /synthetic geometry failure/);
});

test('an edit result that silently optimizes the requested dimensions is rejected atomically', async t => {
  const h = await harness(t), original = await createAssembly(h);
  const work = h.api.edit(original.id, { reason: 'Exact requested width.', parameters: { crown: { width: 4.4 } } });
  const rejected = assert.rejects(work, /changed requested values/), worker = h.takeWorker();
  const result = await fitRestoration({ spec: worker.request.spec, surfaces: [], options: { maxCandidates: 1 } });
  result.spec.parameters.crown.width = 4.5;
  worker.reply({ type: 'result', result }); await rejected; h.render();
  assert.equal(h.api.assemblies[0], original); assert.equal(original.previousVersions, undefined);
});

test('manual placement feedback is case-specific, measured once and never changes geometry', async t => {
  const h = await harness(t), original = await createAssembly(h);
  assert.equal(original.spec.qualityContext?.placementFeedback, undefined);
  const feedback = { provenance: 'unconfirmed-case-feedback', source: 'Manual case review; unconfirmed.', subcrestalDepthMm: 1.5, adjacentToothClearanceMm: null };
  const work = h.api.setPlacementFeedback(original.id, feedback), worker = h.takeWorker();
  assert.equal(worker.request.options.maxCandidates, 1);
  assert.deepEqual(worker.request.spec.parameters, original.spec.parameters);
  await replyFit(worker); const recorded = await work; h.render();
  assert.deepEqual(recorded.spec.qualityContext.placementFeedback, feedback);
  assert.equal(recorded.spec.editProvenance.actor, 'manual');
  assert.equal(recorded.previousVersions.length, 1);
  recorded.parts.forEach((part, index) => assert.deepEqual(part.positions, original.parts[index].positions));
  assert.equal(recorded.fit.quality.final.guardrails.issues.find(issue => issue.id === 'subcrestal-placement').target.value, 1.5);
  const clear = h.api.setPlacementFeedback(original.id, null); await replyFit(h.takeWorker()); const cleared = await clear; h.render();
  assert.equal(cleared.spec.qualityContext.placementFeedback, undefined);
  assert.deepEqual(cleared.spec.parameters, original.spec.parameters);
  assert.equal(cleared.fit.quality.final.guardrails.issues.find(issue => issue.id === 'subcrestal-placement').target.value, null);
  const confirmedFeedback = { ...feedback, provenance: 'clinician-entered-case-feedback', adjacentToothClearanceMm: 1.5 };
  const confirmedWork = h.api.setPlacementFeedback(original.id, confirmedFeedback);
  await replyFit(h.takeWorker()); const confirmed = await confirmedWork; h.render();
  assert.match(confirmed.spec.editProvenance.reason, /clinician-entered/);
  assert.doesNotMatch(confirmed.spec.editProvenance.reason, /unconfirmed/);
  assert.equal(confirmed.fit.quality.final.guardrails.issues.find(issue => issue.id === 'subcrestal-placement').status, 'unknown');
  assert.equal(confirmed.fit.quality.final.guardrails.issues.find(issue => issue.id === 'adjacent-root-clearance').status, 'unknown');
  confirmed.parts.forEach((part, index) => assert.deepEqual(part.positions, original.parts[index].positions));
  await assert.rejects(h.api.edit(original.id, { reason: 'Cannot originate clinical feedback.', placementFeedback: feedback }, { actor: 'agent' }));
});

test('a restored assembly can be edited when its verified source inputs are already loaded', async t => {
  const h = await harness(t), original = await createAssembly(h), reopened = await harness(t);
  reopened.render({ parts: h.parts, teeth: h.teeth });
  reopened.api.restore([structuredClone(original)]); reopened.render();
  const work = reopened.api.edit(original.id, { reason: 'Edit reopened contour.', contour: { cervicalScale: 0.9 } });
  await replyFit(reopened.takeWorker()); const next = await work; reopened.render();
  assert.equal(next.previousVersions.length, 1); assert.equal(next.spec.contour.cervicalScale, 0.9);
  assert.equal(next.spec.parentPartId, original.spec.parentPartId);
});
