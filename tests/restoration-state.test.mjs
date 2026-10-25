import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { Matrix4 } from 'three';
import { partMatrix } from '../src/pose.ts';
import { emptyToothCase } from '../src/tooth-session.ts';
import { fitRestoration } from '../src/restoration-fitting.ts';
import { fittingSurfaces } from '../src/workflow-geometry.ts';

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
async function replyFit(worker) {
  assert.equal(worker.request.type, 'prepare-fit');
  assert.ok(worker.url.endsWith('/restoration-fit.worker.ts'));
  assert.ok(worker.request.spec);
  assert.ok(Array.isArray(worker.request.parts));
  assert.ok(worker.request.options.maxCandidates > 0);
  // Geometry/result fixtures use the real executor with no audit targets; this
  // scheduler suite controls lifecycle, while fitter tests cover measurements.
  const result = await fitRestoration({ spec: worker.request.spec, surfaces: [] });
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
async function createAssembly(h, spec = concept(), proposals = []) {
  const work = h.api.create([spec.fdi], h.teeth, [], proposals);
  h.takeWorker().reply({ specs: [spec], warnings: [] });
  await microtasks();
  await replyFit(h.takeWorker());
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

const dependencyChanges = [
  ['positions', (h, id) => replacePart(h, id, part => ({ positions: part.positions.slice() }))],
  ['normals', (h, id) => replacePart(h, id, part => ({ normals: part.normals.slice() }))],
  ['reviewed labels', (h, id) => ({ teeth: { ...h.teeth, labels: { ...h.teeth.labels, [id]: Uint8Array.of(255) } } })],
  ['tissue evidence', (h, id) => replacePart(h, id, () => ({ tissueScores: Float32Array.of(.9) }))],
  ['arch role', (h, id) => replacePart(h, id, () => ({ role: 'model' }))],
  ['source import identity', (h, id) => replacePart(h, id, part => ({ sourceFileId: `${part.sourceFileId}-replacement` }))],
  ['removal', (h, id) => ({ parts: h.parts.filter(part => part.id !== id) })],
];
const additionalSource = h => ({ parts: [...h.parts,
  { ...sourcePart(), id: 'new-lower-source', sourceFileId: 'source-c' }] });
const poseChanges = [
  ['offset', () => ({ offset: [7, -2, 1] })],
  ['registration', () => ({ pose: [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 4, -2, 1, 1] })],
  ['manual rotation', () => ({ rotation: [0, 0, 30] })],
];

test('components follow the complete parent pose and reset without changing their source geometry', async t => {
  const h = await harness(t), assembly = await createAssembly(h), original = assembly.parts.map(part => part.positions.slice());
  const moved = { ...h.parts[0], pose: [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 40, -20, 15, 1], offset: [5, 6, 7], rotation: [15, 25, 35] };
  h.render({ parts: [moved] });
  assert.equal(h.api.assemblies.length, 1);
  h.api.displayParts.forEach((part, index) => { assert.deepEqual(part.pose, partMatrix(moved).toArray()); assert.deepEqual(part.positions, original[index]); });
  h.render({ parts: [sourcePartWithSameGeometry(h.parts[0])] });
  h.api.displayParts.forEach((part, index) => { assert.deepEqual(part.pose, partMatrix(h.parts[0]).toArray()); assert.deepEqual(part.positions, original[index]); });
});
function sourcePartWithSameGeometry(parent) { return { ...parent, pose: undefined, rotation: [0, 0, 0], offset: [0, 0, 0] }; }

test('changing parent arch, source geometry or reviewed evidence retains completed concepts as stale', async t => {
  const changes = [
    h => ({ parts: [{ ...h.parts[0], role: 'upper' }] }),
    h => ({ parts: [{ ...h.parts[0], positions: h.parts[0].positions.slice() }] }),
    h => ({ parts: [{ ...h.parts[0], normals: h.parts[0].normals.slice() }] }),
    h => ({ parts: [{ ...h.parts[0], sourceFileId: 'replacement-import' }] }),
    h => ({ teeth: { ...h.teeth, labels: { ...h.teeth.labels, 'synthetic-lower': Uint8Array.of(255) } } }),
    h => ({ parts: [{ ...h.parts[0], tissueScores: Float32Array.of(.9) }] }),
    h => ({ teeth: editRecord(h, 36, { status: 'present', restoration: 'none', site: undefined }) }),
    h => ({ teeth: editRecord(h, 36, { site: undefined }) }),
    h => ({ teeth: editRecord(h, 36, { site: { partId: 'synthetic-lower', face: 0, point: [.2, .2, 0] } }) }),
    h => ({ teeth: editRecord(h, 35, { status: 'present' }) }),
  ];
  for (const change of changes) {
    const h = await harness(t); await createAssembly(h); h.render(change(h));
    assert.equal(h.api.assemblies.length, 1); retainedStale(h);
  }
});

test('notes, unrelated tooth records and presentation changes preserve a valid concept', async t => {
  const h = await harness(t), assembly = await createAssembly(h);
  const assemblies = h.api.assemblies;
  h.render({ teeth: editRecord(h, 36, { note: 'Updated review note only' }) });
  assert.strictEqual(h.api.assemblies, assemblies);
  h.render({ teeth: editRecord(h, 11, { status: 'present', note: 'Unrelated arch tooth' }) });
  assert.strictEqual(h.api.assemblies, assemblies);
  h.render({ parts: [{ ...h.parts[0], visible: false, name: 'Renamed presentation', presentationColor: '#aabbcc' }] });
  assert.strictEqual(h.api.assemblies, assemblies);
  assert.equal(h.api.assemblies.length, 1); assert.strictEqual(h.api.assemblies[0], assembly);
});

test('evidence changes settle pending work immediately and suppress stale worker results at either stage', async t => {
  for (const stage of ['site', 'geometry']) {
    const h = await harness(t), work = h.api.create([36], h.teeth, []);
    let pending = h.takeWorker();
    if (stage === 'geometry') { pending.reply({ specs: [concept()], warnings: [] }); await microtasks(); pending = h.takeWorker(); }
    h.render({ teeth: editRecord(h, 36, { status: 'present', restoration: 'none', site: undefined }) });
    assert.equal(pending.terminated, true);
    const settled = await settlesImmediately(work);
    assert.equal(settled, true, `${stage} cancellation must not wait for the 30-second timeout`);
    if (stage === 'site') pending.reply({ specs: [concept()], warnings: [] }); else await replyFit(pending);
    await microtasks(); h.render();
    assert.equal(h.api.assemblies.length, 0); assert.equal(h.api.busy, false);
  }
});

test('a corrected site can be regenerated after stale geometry is invalidated', async t => {
  const h = await harness(t), first = await createAssembly(h);
  h.render({ teeth: editRecord(h, 36, { site: { partId: 'synthetic-lower', face: 0, point: [.2, .2, 0] } }) });
  assert.equal(h.api.assemblies.length, 1); retainedStale(h, first.id);
  const work = h.api.create([36], h.teeth, []), site = h.takeWorker(), corrected = concept();
  assert.deepEqual(site.request.fdis, [36]);
  corrected.frame.origin = [.2, .2, 0]; site.reply({ specs: [corrected], warnings: [] }); await microtasks();
  await replyFit(h.takeWorker()); await work; h.render();
  assert.equal(h.api.assemblies.length, 1); assert.equal(h.api.assemblies[0].id, first.id); assert.equal(isStale(h.api.assemblies[0]), false);
  assert.deepEqual(h.api.assemblies[0].spec.frame.origin, [.2, .2, 0]);
});

test('sequential sites share the combined part budget and preserve the first concept when the second exceeds it', async t => {
  const h = await harness(t), parent = h.parts[0];
  h.render({ parts: [parent, ...Array.from({ length: 58 }, (_, index) => ({ ...parent, id: `other-${index}`, role: 'model' }))] });
  const work = h.api.create([36, 46], h.teeth, []);
  h.takeWorker().reply({ specs: [concept(36), concept(46)], warnings: [] }); await microtasks();
  await replyFit(h.takeWorker()); await microtasks();
  await replyFit(h.takeWorker()); await work; h.render();
  assert.equal(h.api.assemblies.length, 1); assert.equal(h.api.assemblies[0].spec.fdi, 36);
  assert.equal(h.parts.length + h.api.displayParts.length, 62); assert.match(h.api.error, /budget.*full/i);
});

test('AI concepts preserve chart status, survive tuning and invalidate when reviewed evidence changes', async t => {
  const h = await harness(t);
  h.render({ hypothesisRevision: 'assessment-a', teeth: editRecord(h, 36, { status: 'unreviewed', restoration: 'none', site: undefined }) });
  const saved = structuredClone(h.teeth);
  const work = h.api.create([36], h.teeth, [], [{ fdi: 36, evidence: ['view-1'], rationale: 'Synthetic possible gap' }]);
  const site = h.takeWorker();
  assert.equal(site.request.teeth.teeth[36].status, 'missing');
  assert.deepEqual(h.teeth, saved);
  site.reply({ specs: [concept()], warnings: [] }); await microtasks();
  await replyFit(h.takeWorker()); await work; h.render();
  assert.equal(h.api.assemblies.length, 1);
  assert.match(h.api.assemblies[0].warnings[0], /AI-proposed/);
  assert.equal(h.api.siteReadiness[0].status, 'generated');
  const assembly = h.api.assemblies[0];
  const tuning = h.api.update(assembly.id, { ...assembly.spec.parameters, crown: { ...assembly.spec.parameters.crown, width: assembly.spec.parameters.crown.width * 1.01 } });
  await replyFit(h.takeWorker()); await tuning; h.render();
  assert.equal(h.api.assemblies.length, 1);
  assert.deepEqual(h.teeth, saved);
  h.render({ teeth: editRecord(h, 36, { status: 'present' }) });
  assert.equal(h.api.assemblies.length, 1); retainedStale(h, assembly.id);
});

test('AI proposals require a current hypothesis token before starting a worker', async t => {
  const h = await harness(t);
  h.render({ teeth: editRecord(h, 36, { status: 'unreviewed', restoration: 'none', site: undefined }) });
  const chart = structuredClone(h.teeth);
  const work = h.api.create([36], h.teeth, [], [proposal()]);
  assert.equal(h.queuedWorkerCount, 0, 'No AI site job may start without a current assessment token');
  assert.equal(await settlesImmediately(work), true);
  h.render();
  assert.equal(h.api.busy, false);
  assert.equal(h.api.assemblies.length, 0);
  assert.deepEqual(h.teeth, chart);
});

test('changing or clearing the hypothesis token retains stale AI concepts and preserves current manual concepts', async t => {
  for (const hypothesisRevision of ['assessment-b', null]) await t.test(String(hypothesisRevision), async t => {
    const h = await harness(t);
    h.render({ hypothesisRevision: 'assessment-a', teeth: editRecord(h, 46, { status: 'unreviewed', restoration: 'none', site: undefined }) });
    const manual = await createAssembly(h);
    const hypothesis = await createAssembly(h, concept(46), [proposal(46)]);
    assert.equal(h.api.assemblies.length, 2);
    assert.ok(hypothesis.warnings.some(warning => /AI-proposed/.test(warning)));
    h.render({ hypothesisRevision });
    assert.deepEqual(currentAssemblies(h).map(assembly => assembly.id), [manual.id]);
    retainedStale(h, hypothesis.id);
    assert.strictEqual(h.api.assemblies[0], manual);
    assert.equal(h.api.displayParts.length,6);
    assert.equal(h.teeth.teeth[46].status, 'unreviewed');
  });
});

test('hypothesis token changes immediately cancel AI localization, generation and tuning', async t => {
  for (const stage of ['site', 'geometry', 'tuning']) for (const hypothesisRevision of ['assessment-b', null]) {
    await t.test(`${stage}: ${hypothesisRevision}`, async t => {
      const h = await harness(t);
      h.render({ hypothesisRevision: 'assessment-a', teeth: editRecord(h, 36, { status: 'unreviewed', restoration: 'none', site: undefined }) });
      let work, pending;
      if (stage === 'tuning') {
        const assembly = await createAssembly(h, concept(), [proposal()]);
        work = h.api.update(assembly.id, { ...assembly.spec.parameters, crown: { ...assembly.spec.parameters.crown, width: assembly.spec.parameters.crown.width * 1.01 } });
        pending = h.takeWorker();
      } else {
        work = h.api.create([36], h.teeth, [], [proposal()]);
        pending = h.takeWorker();
        if (stage === 'geometry') {
          pending.reply({ specs: [concept()], warnings: [] }); await microtasks(); pending = h.takeWorker();
        }
      }
      h.render();
      assert.equal(h.api.busy, true);
      h.render({ hypothesisRevision });
      assert.equal(pending.terminated, true);
      assert.equal(await settlesImmediately(work), true, 'Cancellation must settle without the worker timeout');
      if (stage === 'site') pending.reply({ specs: [concept()], warnings: [] }); else await replyFit(pending);
      await microtasks(); h.render();
      assert.equal(h.queuedWorkerCount, 0, 'A stale response must not start another worker');
      assert.equal(h.api.busy, false);
      assert.equal(h.api.assemblies.length, stage === 'tuning' ? 1 : 0);
      if (stage === 'tuning') retainedStale(h);
    });
  }
});

test('manual jobs survive token-only changes while a completed AI hypothesis is invalidated', async t => {
  for (const stage of ['site', 'geometry', 'tuning']) for (const hypothesisRevision of ['assessment-b', null]) {
    await t.test(`${stage}: ${hypothesisRevision}`, async t => {
      const h = await harness(t);
      h.render({ hypothesisRevision: 'assessment-a', teeth: editRecord(h, 46, { status: 'unreviewed', restoration: 'none', site: undefined }) });
      const manual = stage === 'tuning' ? await createAssembly(h) : null;
      const hypothesis = await createAssembly(h, concept(46), [proposal(46)]);
      const work = stage === 'tuning' ? h.api.update(manual.id, { ...manual.spec.parameters, crown: { ...manual.spec.parameters.crown, width: manual.spec.parameters.crown.width * 1.01 } }) : h.api.create([36], h.teeth, []);
      let pending = h.takeWorker();
      if (stage === 'geometry') {
        pending.reply({ specs: [concept()], warnings: [] }); await microtasks(); pending = h.takeWorker();
      }
      h.render({ hypothesisRevision });
      assert.equal(pending.terminated, false);
      assert.equal(h.api.busy, true);
      assert.deepEqual(currentAssemblies(h).map(assembly => assembly.id), manual ? [manual.id] : [], 'Only the old AI concept becomes stale');
      retainedStale(h, hypothesis.id);
      assert.equal(await settlesImmediately(work), false, 'The manual request must keep waiting for its worker');
      if (stage === 'site') {
        pending.reply({ specs: [concept()], warnings: [] }); await microtasks(); pending = h.takeWorker();
      }
      await replyFit(pending); await work; h.render();
      assert.equal(h.api.busy, false);
      assert.deepEqual(currentAssemblies(h).map(assembly => assembly.spec.fdi), [36]);
      if (manual) assert.equal(currentAssemblies(h)[0].id, manual.id);
      assert.ok(currentAssemblies(h)[0].warnings.every(warning => !/AI-proposed/.test(warning)));
    });
  }
});

test('supporting and competing part evidence marks a retained completed concept stale', async t => {
  for (const id of ['supporting-lower', 'competing-lower']) for (const [name, change] of dependencyChanges) {
    await t.test(`${id}: ${name}`, async t => {
      const h = await harness(t), spec = withSiteEvidence(h);
      await createAssembly(h, spec);
      h.render(change(h, id));
      assert.equal(h.api.assemblies.length, 1); retainedStale(h);
    });
  }
});

test('a newly imported same-arch source invalidates a previously localized concept', async t => {
  const h = await harness(t), spec = withSiteEvidence(h);
  await createAssembly(h, spec);
  h.render(additionalSource(h));
  assert.equal(h.api.assemblies.length, 1); retainedStale(h);
});

test('independent parent, supporting or competing poses invalidate the localized concept', async t => {
  for (const id of ['synthetic-lower', 'supporting-lower', 'competing-lower']) for (const [name, patch] of poseChanges) {
    await t.test(`${id}: ${name}`, async t => {
      const h = await harness(t), spec = withSiteEvidence(h);
      await createAssembly(h, spec);
      h.render(replacePart(h, id, patch));
      assert.equal(h.api.assemblies.length, 1); retainedStale(h);
    });
  }
});

test('a common rigid transform preserves the assembly and its parent-relative evidence', async t => {
  const h = await harness(t), spec = withSiteEvidence(h), originals = h.parts;
  const assembly = await createAssembly(h, spec), geometry = assembly.parts.map(part => part.positions);
  const transforms = [
    new Matrix4().fromArray([0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 40, -20, 15, 1]),
    new Matrix4().makeRotationX(.37).multiply(new Matrix4().makeRotationY(.19)).setPosition(12.3, -4.7, 8.1),
  ];
  for (const rigid of transforms) {
    const transformed = originals.map(part => ({ ...part, pose: partMatrix(part).premultiply(rigid).toArray(),
      offset: [0, 0, 0], rotation: [0, 0, 0] }));
    h.render({ parts: transformed });
    assert.equal(h.api.assemblies.length, 1);
    assert.strictEqual(h.api.assemblies[0], assembly);
    h.api.displayParts.forEach((part, index) => {
      assert.deepEqual(part.pose, partMatrix(transformed[0]).toArray());
      assert.strictEqual(part.positions, geometry[index]);
    });
    h.render({ parts: originals });
    assert.strictEqual(h.api.assemblies[0], assembly);
    h.api.displayParts.forEach(part => assert.deepEqual(part.pose, partMatrix(originals[0]).toArray()));
  }
});

test('pending localization and geometry cancel immediately for changed dependency evidence', async t => {
  const changes = [
    ...dependencyChanges.map(([name, change]) => [`supporting ${name}`, h => change(h, 'supporting-lower')]),
    ...dependencyChanges.map(([name, change]) => [`competing ${name}`, h => change(h, 'competing-lower')]),
    ['new same-arch import', additionalSource],
    ['parent positions', h => replacePart(h, 'synthetic-lower', part => ({ positions: part.positions.slice() }))],
    ['parent normals', h => replacePart(h, 'synthetic-lower', part => ({ normals: part.normals.slice() }))],
    ...['synthetic-lower', 'supporting-lower', 'competing-lower'].flatMap(id => poseChanges.map(([name, patch]) =>
      [`${id} ${name}`, h => replacePart(h, id, patch)])),
  ];
  for (const stage of ['site', 'geometry']) for (const [name, change] of changes) {
    await t.test(`${stage}: ${name}`, async t => {
      const h = await harness(t), spec = withSiteEvidence(h);
      const work = h.api.create([36], h.teeth, []);
      let pending = h.takeWorker();
      if (stage === 'geometry') {
        pending.reply({ specs: [spec], warnings: [] }); await microtasks(); pending = h.takeWorker();
      }
      h.render(change(h));
      assert.equal(pending.terminated, true);
      assert.equal(await settlesImmediately(work), true, 'Changed evidence must settle the request without its timeout');
      if (stage === 'site') pending.reply({ specs: [spec], warnings: [] }); else await replyFit(pending);
      await microtasks(); h.render();
      assert.equal(h.queuedWorkerCount, 0, 'Stale evidence must not schedule a follow-on worker');
      assert.equal(h.api.assemblies.length, 0);
      assert.equal(h.api.busy, false);
    });
  }
});

test('notes and part presentation preserve active workers and completed assembly identity', async t => {
  for (const stage of ['site', 'geometry', 'tuning']) await t.test(stage, async t => {
    const h = await harness(t), spec = withSiteEvidence(h), assembly = await createAssembly(h, spec);
    const nextSpec = concept(46, spec.siteEvidence.partIds);
    const work = stage === 'tuning' ? h.api.update(assembly.id, { ...assembly.spec.parameters, crown: { ...assembly.spec.parameters.crown, width: assembly.spec.parameters.crown.width * 1.01 } }) : h.api.create([46], h.teeth, []);
    let pending = h.takeWorker();
    if (stage === 'geometry') {
      pending.reply({ specs: [nextSpec], warnings: [] }); await microtasks(); pending = h.takeWorker();
    }
    h.render();
    const assemblies = h.api.assemblies;
    const changes = [
      () => ({ teeth: editRecord(h, 36, { note: 'A note on the generated site' }) }),
      () => ({ teeth: editRecord(h, 46, { note: 'A note on the pending site' }) }),
      () => ({ parts: h.parts.map(part => ({ ...part, visible: !part.visible,
        name: `Reviewed presentation: ${part.id}`, presentationColor: '#aabbcc' })) }),
    ];
    for (const change of changes) {
      h.render(change());
      assert.equal(pending.terminated, false);
      assert.equal(h.api.busy, true);
      assert.strictEqual(h.api.assemblies, assemblies);
      assert.strictEqual(h.api.assemblies[0], assembly);
      assert.equal(h.queuedWorkerCount, 0);
    }
    assert.equal(await settlesImmediately(work), false, 'Presentation changes must leave the worker request pending');
    if (stage === 'site') {
      pending.reply({ specs: [nextSpec], warnings: [] }); await microtasks(); pending = h.takeWorker();
    }
    await replyFit(pending);
    await work; h.render();
    assert.equal(h.api.busy, false);
    if (stage === 'tuning') {
      assert.equal(h.api.assemblies.length, 1);
      assert.equal(h.api.assemblies[0].id, assembly.id);
    } else {
      assert.equal(h.api.assemblies.length, 2);
      assert.strictEqual(h.api.assemblies.find(item => item.id === assembly.id), assembly);
      assert.ok(h.api.assemblies.some(item => item.spec.fdi === 46));
    }
  });
});

test('retrying failed sites preserves generated readiness and the prior assembly', async t => {
  for (const failure of ['localization', 'geometry']) await t.test(failure, async t => {
    const h = await harness(t), firstSpec = concept(36), secondSpec = concept(46);
    const work = h.api.create([36, 46], h.teeth, []);
    h.takeWorker().reply({ specs: failure === 'geometry' ? [firstSpec, secondSpec] : [firstSpec],
      warnings: failure === 'localization' ? ['FDI 46: Synthetic site localization failed.'] : [] });
    await microtasks();
    await replyFit(h.takeWorker()); await microtasks();
    if (failure === 'geometry') h.takeWorker().reply({ type: 'error', error: 'Synthetic component generation failed.' });
    await work; h.render();
    assert.equal(h.api.assemblies.length, 1);
    const firstAssembly = h.api.assemblies[0];
    assert.deepEqual(new Map(h.api.siteReadiness.map(site => [site.fdi, site.status])), new Map([[36, 'generated'], [46, 'needs-input']]));

    const retry = h.api.create([36, 46], h.teeth, []), site = h.takeWorker();
    assert.deepEqual(site.request.fdis, [46]);
    site.reply({ specs: [secondSpec], warnings: [] }); await microtasks(); h.render();
    assert.equal(h.api.siteReadiness.find(site => site.fdi === 36)?.status, 'generated');
    assert.equal(h.api.siteReadiness.find(site => site.fdi === 46)?.status, 'ready');
    assert.strictEqual(h.api.assemblies[0], firstAssembly);
    await replyFit(h.takeWorker()); await retry; h.render();
    assert.deepEqual(new Map(h.api.siteReadiness.map(site => [site.fdi, site.status])), new Map([[36, 'generated'], [46, 'generated']]));
    assert.equal(h.api.assemblies.length, 2);
    assert.strictEqual(h.api.assemblies.find(item => item.id === firstAssembly.id), firstAssembly);
  });
});

test('an older create callback cannot bind its proposals to a newer assessment token', async t => {
  const h = await harness(t);
  h.render({ hypothesisRevision: 'assessment-a', teeth: editRecord(h, 36, { status: 'unreviewed', restoration: 'none', site: undefined }) });
  const createFromOldDraft = h.api.create;
  h.render({ hypothesisRevision: 'assessment-b' });
  await createFromOldDraft([36], h.teeth, [], [proposal()]); h.render();
  assert.equal(h.queuedWorkerCount, 0);
  assert.equal(h.api.assemblies.length, 0);
  assert.equal(h.api.siteReadiness[0].status, 'needs-input');
  assert.match(h.api.error, /assessment|draft/i);
});

test('a mixed request preserves its reviewed sites when its hypothesis token changes', async t => {
  for (const stage of ['site', 'hypothesis-components', 'manual-components']) await t.test(stage, async t => {
    const h = await harness(t);
    h.render({ hypothesisRevision: 'assessment-a', teeth: editRecord(h, 36, { status: 'unreviewed', restoration: 'none', site: undefined }) });
    const aiSpec = concept(36), manualSpec = concept(46);
    const work = h.api.create([36, 46], h.teeth, [], [proposal()]);
    let pending = h.takeWorker();
    if (stage !== 'site') {
      pending.reply({ specs: stage === 'manual-components' ? [manualSpec, aiSpec] : [aiSpec, manualSpec], warnings: [] });
      await microtasks(); pending = h.takeWorker();
    }
    h.render({ hypothesisRevision: null });
    assert.equal(pending.terminated, stage === 'hypothesis-components');
    if (stage === 'site') {
      pending.reply({ specs: [aiSpec, manualSpec], warnings: [] }); await microtasks(); pending = h.takeWorker();
    } else if (stage === 'hypothesis-components') {
      const stale = pending;
      await microtasks(); pending = h.takeWorker();
      await replyFit(stale);
    }
    assert.equal(pending.request.spec.fdi, 46);
    await replyFit(pending);
    await work; h.render();
    assert.deepEqual(h.api.assemblies.map(assembly => assembly.spec.fdi), [46]);
    assert.equal(h.api.siteReadiness.find(site => site.fdi === 36).status, 'needs-input');
    assert.equal(h.api.siteReadiness.find(site => site.fdi === 46).status, 'generated');
    assert.equal(h.queuedWorkerCount, 0);
    assert.equal(h.api.busy, false);
  });
});

test('moving the antagonist marks the completed best candidate stale and prevents tuning/export', async t => {
  const h = await harness(t);
  h.render({ parts: [...h.parts, { ...sourcePart(), id: 'synthetic-upper', role: 'upper', offset: [0,0,7] }] });
  const work = h.api.create([36],h.teeth,[]);
  h.takeWorker().reply({ specs:[concept()],warnings:[] }); await microtasks();
  const pending = h.takeWorker();
  const payload = pending.request;
  assert.ok(fittingSurfaces(payload.spec, payload.parts, payload.teeth, payload.site, payload.scans).some(surface => surface.role === 'antagonist'), 'The worker receives the evidence needed to evaluate the opposing arch.');
  const fitted = await replyFit(pending); await work; h.render();
  const assembly = h.api.assemblies[0];
  assert.deepEqual(assembly.fit,fitted.report);
  assert.deepEqual(assembly.candidateHistory,fitted.history);
  h.render(replacePart(h,'synthetic-upper',() => ({ offset:[0,0,7.5] })));
  const stale = retainedStale(h,assembly.id);
  assert.deepEqual(stale.parts,assembly.parts, 'Retain the best geometry for review.');
  assert.deepEqual(stale.candidateHistory,assembly.candidateHistory);
  await h.api.update(stale.id,stale.spec.parameters);
  assert.equal(h.queuedWorkerCount,0,'A stale candidate has no active evidence basis for tuning.');
});

test('an antagonist pose change immediately cancels active fitting and suppresses its late result', async t => {
  const h = await harness(t);
  h.render({ parts:[...h.parts,{ ...sourcePart(),id:'synthetic-upper',role:'upper',offset:[0,0,7] }] });
  const work = h.api.create([36],h.teeth,[]);
  h.takeWorker().reply({specs:[concept()],warnings:[]}); await microtasks();
  const pending = h.takeWorker();
  h.render(replacePart(h,'synthetic-upper',() => ({ offset:[0,0,7.5] })));
  assert.equal(pending.terminated,true,'Changing the measured antagonist must terminate its fitting worker immediately.');
  assert.equal(await settlesImmediately(work),true);
  await replyFit(pending); await microtasks(); h.render();
  assert.equal(h.api.assemblies.length,0);
  assert.equal(h.api.busy,false);
});

test('restoring a manual generic hypothesis keeps it independent of assessment revision', async t => {
  const h=await harness(t), assembly=await createAssembly(h);
  assert.match(assembly.spec.source,/hypothesis/);
  h.api.restore([assembly],[],[],'saved-assessment');
  h.render({parts:[...h.parts],hypothesisRevision:'saved-assessment'});
  h.render({hypothesisRevision:'new-assessment'});
  assert.equal(isStale(h.api.assemblies[0]),false,'The word hypothesis in a manual concept is not AI provenance.');
  const work=h.api.update(assembly.id, { ...assembly.spec.parameters, crown: { ...assembly.spec.parameters.crown, width: assembly.spec.parameters.crown.width * 1.01 } }),pending=h.takeWorker();
  await replyFit(pending);await work;h.render();
  assert.equal(isStale(h.api.assemblies[0]),false);
});

test('restoring an AI concept keeps its assessment dependency', async t => {
  const h=await harness(t);
  h.render({hypothesisRevision:'saved-assessment',teeth:editRecord(h,36,{status:'unreviewed',restoration:'none',site:undefined})});
  const assembly=await createAssembly(h,concept(),[proposal()]);
  h.api.restore([assembly],[],[],'saved-assessment');h.render({parts:[...h.parts]});
  h.render({hypothesisRevision:'new-assessment'});
  retainedStale(h,assembly.id);
});

test('restoring stale retained candidates leaves them unselected and without a tuning basis', async t => {
  const h=await harness(t),assembly=await createAssembly(h);
  h.render({teeth:editRecord(h,36,{site:{partId:'synthetic-lower',face:0,point:[.2,.2,0]}})});
  const stale=retainedStale(h,assembly.id);
  h.api.restore([stale]);h.render({parts:[...h.parts]});
  retainedStale(h,assembly.id);
  await h.api.update(stale.id,stale.spec.parameters);
  assert.equal(h.queuedWorkerCount,0,'Reopen must not reactivate stale evidence.');
});

test('candidate comparison evaluates a separate copy and preserves the original best through failures', async t => {
  const h = await harness(t), original = await createAssembly(h);
  const operation = h.api.compare(original.id, 0), pending = h.takeWorker();
  assert.equal(pending.request.options.maxCandidates, 1, 'inspect-copy evaluates the selected measured geometry without optimizing it again');
  await replyFit(pending); await operation; h.render();
  assert.equal(h.api.assemblies.length, 2); assert.equal(h.api.assemblies[0], original);
  const retry = h.api.compare(original.id), failed = h.takeWorker(); failed.reply({error:'Controlled fitting failure'});
  await retry; h.render(); assert.equal(h.api.assemblies.length, 2); assert.equal(h.api.assemblies[0], original);
});

test('successful parameter edits retain prior anatomy, fit and candidates for an independently evaluated copy', async t => {
  const h = await harness(t), original = await createAssembly(h);
  const parameters = structuredClone(original.spec.parameters); parameters.fixture.depth = .5;
  const update = h.api.update(original.id, parameters), updatedWorker = h.takeWorker();
  assert.equal(updatedWorker.request.options.maxCandidates, 1, 'Manual values are measured without automatic optimization.');
  await replyFit(updatedWorker); await update; h.render();
  const current = h.api.assemblies[0];
  assert.equal(current.spec.parameters.fixture.depth, .5);
  assert.equal(current.previousVersions.length, 1); assert.equal(current.previousVersions[0].spec, original.spec);
  assert.deepEqual(current.previousVersions[0].candidateHistory, original.candidateHistory);
  const compare = h.api.compare(current.id, undefined, 0), comparison = h.takeWorker();
  assert.deepEqual(comparison.request.spec.parameters, original.spec.parameters); assert.equal(comparison.request.options.maxCandidates, 1);
  await replyFit(comparison); await compare; h.render();
  assert.equal(h.api.assemblies.length, 2); assert.equal(h.api.assemblies[0], current);
  assert.equal(h.api.displayParts.filter(part => part.visible).length, 3, 'only the selected same-site alternative is shown and compared');
});
