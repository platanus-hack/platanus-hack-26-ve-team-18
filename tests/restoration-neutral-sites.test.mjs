import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { emptyToothCase } from '../src/tooth-session.ts';
import { fitRestoration } from '../src/restoration-fitting.ts';

// Use the same minimal hook scheduler as restoration-state.test.mjs: exercise
// the real hook and executor while controlling only React effects and workers.
const hookUrl = new URL('../src/useRestorations.ts', import.meta.url);
const hookSource = stripTypeScriptTypes(await readFile(hookUrl, 'utf8'))
  .replace(/import\s*\{([^}]+)\}\s*from\s*['"]react['"];?/, 'const {$1} = globalThis.__neutralRestorationTest.hooks;\nconst {Worker, setTimeout, clearTimeout} = globalThis.__neutralRestorationTest;')
  .replace(/from\s*(['"])(\.\/[^'"]+)\1/g, (_, quote, relative) => `from ${JSON.stringify(new URL(relative.endsWith('.ts') ? relative : `${relative}.ts`, hookUrl).href)}`)
  .replaceAll('import.meta.url', JSON.stringify(hookUrl.href));
let moduleNumber = 0;
const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
const microtasks = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const settlesImmediately = work => Promise.race([work.then(() => true), new Promise(resolve => setImmediate(() => resolve(false)))]);
const isStale = assembly => assembly.warnings.some(warning => warning.startsWith('STALE:'));
const siteId = assembly => assembly.spec.draftIdentity?.siteId;
const assemblyAt = (h, id) => h.api.assemblies.find(assembly => siteId(assembly) === id);
const readiness = h => new Map(h.api.siteReadiness.map(site => [site.siteId, site.status]));

function sourcePart() {
  // Two genuinely disjoint square ridge patches in one imported coordinate
  // system. Each site has its own anchor triangle and two patch faces.
  const positions = Float32Array.from([0, 20].flatMap(x => [
    x - 3, -2, 0, x + 3, -2, 0, x + 3, 2, 0,
    x - 3, -2, 0, x + 3, 2, 0, x - 3, 2, 0,
  ]));
  return { id: 'lower-ridge', sourceFileId: 'ridge-import', role: 'lower', name: 'Disjoint ridge patches', fileName: 'ridge.ply',
    positions, normals: Float32Array.from({ length: positions.length }, (_, i) => i % 3 === 2 ? 1 : 0),
    triangles: 4, vertices: 12, closed: false, visible: true, dimensions: [26, 4, 0], offset: [0, 0, 0] };
}
function neutralSites() {
  const measure = value => ({ value, unit: 'file units (u)', method: 'Synthetic surface measurement', provenance: 'measured' });
  return ['ridge-a', 'ridge-b'].map((id, index) => {
    const origin = [index * 20, 0, 0];
    return { id, arch: 'lower', partId: 'lower-ridge', fdi: 36,
      draftIdentity: { templateFdi: 36, alternatives: [35, 37], basis: 'Shape template only; anatomical identity unresolved.' },
      alternatives: [], status: 'proposed-missing', confidence: .8, priority: 'medium', kind: 'bounded',
      slot: { index: 0, count: 1, s: [index * 20 - 3, index * 20 + 3] },
      evidence: { supporting: [`${id}:surface`], conflicting: [] },
      anchor: { partId: 'lower-ridge', face: index * 2, point: [...origin] },
      patchFaces: Uint32Array.of(index * 2, index * 2 + 1),
      frame: { origin, u: [1, 0, 0], v: [0, 1, 0], up: [0, 0, 1] }, frameBasis: 'Independent bounded ridge patch.',
      mesialSign: 1, buccalSign: 1, adjacent: { mesial: null, distal: null }, opposing: null, contralateral: null,
      space: { mesiodistal: measure(4), proximalGap: measure(4), buccolingual: measure(4), vertical: measure(3), crownHeight: measure(3) }, questions: [],
    };
  });
}

async function harness(t) {
  const slots = [], effects = [], workers = [], timers = new Set();
  let cursor = 0, dirty = false, api, useRestorations;
  const teeth = emptyToothCase();
  teeth.labels['lower-ridge'] = new Uint8Array(4);
  teeth.reviewedMask = { 'lower-ridge': new Uint8Array(4) };
  teeth.teeth[11] = { status: 'present', restoration: 'none', note: 'Reviewed chart record preserved.' };
  const h = { parts: [sourcePart()], teeth, hypothesisRevision: 'assessment-a',
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
    takeWorker() { assert.ok(workers.length, 'Expected a pending neutral-site fitting request'); return workers.shift(); },
    dispose() {
      api?.cancel();
      for (const slot of slots) if (slot.kind === 'effect') slot.cleanup?.();
      for (const timer of timers) clearTimeout(timer);
    },
  };
  const runtime = { hooks: {
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
      if (!previous || !sameDeps(previous.deps, deps)) effects.push(slots[index] = { kind: 'effect', effect, deps, cleanup: previous?.cleanup });
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
  const previous = globalThis.__neutralRestorationTest;
  globalThis.__neutralRestorationTest = runtime;
  try { ({ useRestorations } = await import(`data:text/javascript;base64,${Buffer.from(hookSource).toString('base64')}#${++moduleNumber}`)); }
  finally { if (previous === undefined) delete globalThis.__neutralRestorationTest; else globalThis.__neutralRestorationTest = previous; }
  h.render(); t.after(() => h.dispose()); return h;
}
async function replyFit(worker) {
  assert.equal(worker.request.type, 'prepare-fit');
  assert.ok(worker.url.endsWith('/restoration-fit.worker.ts'));
  if (worker.request.spec.draftIdentity) assert.equal(worker.request.site.id, worker.request.spec.draftIdentity.siteId, 'Each fit uses its own geometric site.');
  else assert.equal(worker.request.site.fdi, worker.request.spec.fdi, 'A named fit retains the authorized site identity.');
  const result = await fitRestoration({ spec: worker.request.spec, surfaces: [], options: worker.request.options });
  worker.reply({ type: 'result', result });
  return result;
}
async function createSites(h, sites = neutralSites(), failed = new Set()) {
  // sites is the fifth argument, proposals is the fourth. No anatomical tooth
  // proposals are needed to fit these already-localized disposable site copies.
  const work = h.api.create([36], h.teeth, [], [], sites);
  const jobs = [];
  for (let i = 0; i < sites.length; i++) {
    const worker = h.takeWorker(); jobs.push(worker.request.spec.draftIdentity?.siteId);
    if (failed.has(worker.request.spec.draftIdentity?.siteId)) worker.reply({ type: 'error', error: 'Synthetic site fit failed.' });
    else await replyFit(worker);
    await microtasks();
  }
  const result = await work; h.render();
  assert.equal(h.queuedWorkerCount, 0);
  return { result, jobs };
}

test('one shape-selector FDI creates every neutral site with independent assemblies, visible parts and readiness', async t => {
  const h = await harness(t), sites = neutralSites(), chart = structuredClone(h.teeth), evidence = structuredClone(sites);
  const { result, jobs } = await createSites(h, sites);
  assert.deepEqual(jobs, ['ridge-a', 'ridge-b']);
  assert.equal(h.api.assemblies.length, 2);
  assert.equal(new Set(h.api.assemblies.map(assembly => assembly.id)).size, 2);
  assert.deepEqual(new Set(h.api.assemblies.map(siteId)), new Set(['ridge-a', 'ridge-b']));
  assert.equal(h.api.displayParts.length, 6);
  assert.equal(new Set(h.api.displayParts.map(part => part.id)).size, 6);
  assert.ok(h.api.displayParts.every(part => part.visible), 'Independent sites sharing a template must both be visible.');
  assert.deepEqual(readiness(h), new Map([['ridge-a', 'generated'], ['ridge-b', 'generated']]));
  assert.deepEqual(new Set(result.assemblies.map(siteId)), new Set(['ridge-a', 'ridge-b']));
  assert.deepEqual(result.failed, []);
  for (const assembly of h.api.assemblies) {
    assert.equal(assembly.spec.fdi, 36);
    assert.equal(assembly.spec.draftIdentity.templateFdi, 36);
    assert.deepEqual(assembly.spec.frame.origin, sites.find(site => site.id === siteId(assembly)).frame.origin);
    assert.ok(assembly.parts.every(part => part.restoration.assemblyId === assembly.id));
  }
  assert.deepEqual(h.teeth, chart, 'Automatic visual concepts must not change reviewed chart records, labels or implant intent.');
  assert.deepEqual(sites, evidence, 'Generator input copies remain unmodified.');
});

test('a failed neutral site is reported even when another site with the same template succeeds, and can be retried', async t => {
  for (const failedSite of ['ridge-a', 'ridge-b']) await t.test(failedSite, async t => {
    const h = await harness(t), sites = neutralSites();
    const { result } = await createSites(h, sites, new Set([failedSite]));
    const survivor = h.api.assemblies[0];
    assert.equal(result.assemblies.length, 1); assert.notEqual(siteId(survivor), failedSite);
    assert.deepEqual(result.assemblies.map(assembly => assembly.id), [survivor.id]);
    assert.equal(result.failed.length, 1, 'Success at a different neutral site must not conceal this failure.');
    assert.equal(readiness(h).get(failedSite), 'needs-input');
    assert.equal(readiness(h).get(siteId(survivor)), 'generated');
    const retryWork = h.api.create([36], h.teeth, [], [], sites), retryWorker = h.takeWorker();
    assert.equal(retryWorker.request.spec.draftIdentity.siteId, failedSite, 'A full batch retry only fits its unfinished site.');
    await replyFit(retryWorker); await microtasks();
    const retry = await retryWork; h.render();
    assert.equal(h.queuedWorkerCount, 0);
    assert.deepEqual(retry.failed, []); assert.deepEqual(retry.assemblies.map(siteId), [failedSite]);
    assert.strictEqual(assemblyAt(h, siteId(survivor)), survivor);
    assert.deepEqual(readiness(h), new Map([['ridge-a', 'generated'], ['ridge-b', 'generated']]));
  });
});

test('selecting and removing one assembly by ID preserves the other neutral site and its readiness', async t => {
  const h = await harness(t); await createSites(h);
  const a = assemblyAt(h, 'ridge-a'), b = assemblyAt(h, 'ridge-b');
  h.api.setSelectedId(a.id); h.render();
  assert.equal(h.api.selectedId, a.id);
  assert.equal(h.api.displayParts.filter(part => part.visible).length, 6);
  h.api.remove(a.id); h.render();
  assert.deepEqual(h.api.assemblies, [b]);
  assert.notEqual(h.api.selectedId, a.id, 'Removal must not retain a dangling selection.');
  assert.deepEqual(readiness(h), new Map([['ridge-b', 'generated']]));
  assert.deepEqual(h.api.displayParts.map(part => part.id), b.parts.map(part => part.id));
  assert.ok(h.api.displayParts.every(part => part.visible));
});

test('sequential site requests retain each assembly fitting geometry through tuning and comparison', async t => {
  const h = await harness(t), sites = neutralSites();
  await createSites(h, [sites[0]]);
  const a = assemblyAt(h, 'ridge-a');
  await createSites(h, [sites[1]]);
  const b = assemblyAt(h, 'ridge-b');
  const tuning = h.api.update(a.id, { ...a.spec.parameters, crown: { ...a.spec.parameters.crown, width: a.spec.parameters.crown.width * 1.01 } }), fit = h.takeWorker();
  assert.equal(fit.request.site.id, 'ridge-a', 'A later request for another site cannot replace the saved fitting geometry.');
  await replyFit(fit); await tuning; h.render();
  const tuned = assemblyAt(h, 'ridge-a');
  const comparison = h.api.compare(tuned.id), retry = h.takeWorker();
  assert.equal(retry.request.site.id, 'ridge-a');
  await replyFit(retry); await comparison; h.render();
  const compared = h.api.assemblies.find(assembly => siteId(assembly) === 'ridge-a' && assembly.id !== a.id);
  assert.ok(compared); assert.strictEqual(assemblyAt(h, 'ridge-b'), b);
  assert.equal(h.api.displayParts.filter(part => part.visible).length, 6);
  h.api.setSelectedId(tuned.id); h.render();
  assert.ok(h.api.displayParts.filter(part => part.visible).every(part => [tuned.id, b.id].includes(part.restoration.assemblyId)));
  h.api.remove(compared.id); h.render();
  assert.deepEqual(readiness(h), new Map([['ridge-a', 'generated'], ['ridge-b', 'generated']]));
  assert.strictEqual(assemblyAt(h, 'ridge-b'), b);
});

test('tuning and regenerating one neutral site retain its ID/history without overwriting its neighbour', async t => {
  const h = await harness(t), sites = neutralSites(), chart = structuredClone(h.teeth); await createSites(h, sites);
  const a = assemblyAt(h, 'ridge-a'), b = assemblyAt(h, 'ridge-b');
  const parameters = structuredClone(a.spec.parameters); parameters.crown.width *= .95;
  const tuning = h.api.update(a.id, parameters), pending = h.takeWorker();
  assert.equal(pending.request.spec.draftIdentity.siteId, 'ridge-a');
  await replyFit(pending); await tuning; h.render();
  const tuned = assemblyAt(h, 'ridge-a');
  assert.equal(tuned.id, a.id); assert.equal(tuned.previousVersions.length, 1);
  assert.deepEqual(tuned.previousVersions[0].spec, a.spec);
  assert.deepEqual(tuned.previousVersions[0].candidateHistory, a.candidateHistory);
  assert.strictEqual(assemblyAt(h, 'ridge-b'), b);
  assert.deepEqual(h.teeth, chart);

  h.render({ parts: h.parts.map(part => ({ ...part, positions: part.positions.slice() })) });
  assert.ok(h.api.assemblies.every(isStale));
  const retainedB = assemblyAt(h, 'ridge-b');
  const { result } = await createSites(h, [sites[0]]);
  const regenerated = assemblyAt(h, 'ridge-a');
  assert.equal(regenerated.id, a.id); assert.equal(isStale(regenerated), false);
  assert.equal(regenerated.previousVersions.length, 2);
  assert.deepEqual(regenerated.previousVersions[1].spec, tuned.spec);
  assert.strictEqual(assemblyAt(h, 'ridge-b'), retainedB);
  assert.deepEqual(retainedB.candidateHistory, b.candidateHistory);
  assert.equal(isStale(retainedB), true);
  assert.deepEqual(result.assemblies.map(siteId), ['ridge-a']); assert.deepEqual(result.failed, []);
  assert.deepEqual(readiness(h), new Map([['ridge-a', 'generated'], ['ridge-b', 'needs-input']]));
  assert.deepEqual(h.teeth, chart);
});

const evidenceChanges = [
  ['geometry', h => ({ parts: h.parts.map(part => ({ ...part, positions: part.positions.slice() })) })],
  ['reviewed labels', h => ({ teeth: { ...h.teeth, labels: { ...h.teeth.labels, 'lower-ridge': Uint8Array.of(255, 0, 0, 0) } } })],
  ['reviewed zero mask', h => ({ teeth: { ...h.teeth, reviewedMask: { ...h.teeth.reviewedMask, 'lower-ridge': Uint8Array.of(1, 0, 0, 0) } } })],
  ['assessment revision', () => ({ hypothesisRevision: 'assessment-b' })],
  ['cleared assessment', () => ({ hypothesisRevision: null })],
];

test('evidence and revision changes mark both completed same-template sites stale with distinct readiness', async t => {
  for (const [name, change] of evidenceChanges) await t.test(name, async t => {
    const h = await harness(t); await createSites(h);
    const ids = h.api.assemblies.map(assembly => assembly.id), histories = h.api.assemblies.map(assembly => assembly.candidateHistory);
    h.render(change(h));
    assert.deepEqual(h.api.assemblies.map(assembly => assembly.id), ids);
    assert.ok(h.api.assemblies.every(isStale));
    assert.deepEqual(h.api.assemblies.map(assembly => assembly.candidateHistory), histories);
    assert.deepEqual(readiness(h), new Map([['ridge-a', 'needs-input'], ['ridge-b', 'needs-input']]));
    assert.equal(h.api.selectedId, null);
    for (const assembly of h.api.assemblies) await h.api.update(assembly.id, assembly.spec.parameters);
    assert.equal(h.queuedWorkerCount, 0, 'Stale concepts cannot be tuned.');
  });
});

test('stale evidence and revision changes immediately cancel neutral generation or tuning and suppress late results', async t => {
  for (const [name, change] of evidenceChanges) for (const stage of ['first fit', 'second fit', 'tuning']) await t.test(`${name}: ${stage}`, async t => {
    const h = await harness(t), sites = neutralSites();
    let work, pending;
    if (stage === 'tuning') {
      await createSites(h, sites); const a = assemblyAt(h, 'ridge-a');
      work = h.api.update(a.id, { ...a.spec.parameters, crown: { ...a.spec.parameters.crown, width: a.spec.parameters.crown.width * 1.01 } }); pending = h.takeWorker();
    } else {
      work = h.api.create([36], h.teeth, [], [], sites); pending = h.takeWorker();
      if (stage === 'second fit') { await replyFit(pending); await microtasks(); pending = h.takeWorker(); }
    }
    h.render(); const completed = h.api.assemblies.length;
    h.render(change(h));
    assert.equal(pending.terminated, true);
    assert.equal(await settlesImmediately(work), true, 'Cancellation must settle without the worker timeout.');
    await replyFit(pending); await microtasks(); h.render();
    assert.equal(h.api.busy, false); assert.equal(h.queuedWorkerCount, 0);
    assert.equal(h.api.assemblies.length, completed, 'Late worker responses cannot publish a cancelled candidate.');
    assert.ok(h.api.assemblies.every(isStale));
    assert.equal(readiness(h).get('ridge-a'), 'needs-input');
    assert.equal(readiness(h).get('ridge-b'), 'needs-input');
  });
});

test('neutral automatic copies require the current revision even without anatomical proposals', async t => {
  for (const oldCallback of [false, true]) await t.test(oldCallback ? 'old create callback' : 'no assessment', async t => {
    const h = await harness(t), create = h.api.create, chart = structuredClone(h.teeth);
    h.render({ hypothesisRevision: oldCallback ? 'assessment-b' : null });
    const work = (oldCallback ? create : h.api.create)([36], h.teeth, [], [], neutralSites());
    assert.equal(h.queuedWorkerCount, 0);
    assert.equal(await settlesImmediately(work), true); h.render();
    assert.equal(h.api.assemblies.length, 0); assert.equal(h.api.busy, false);
    assert.deepEqual(h.teeth, chart);
  });
});

const aiDesign = (width = 3.1) => ({ anatomy: 'molar', anatomySource: 'procedural-template',
  parameters: { fixture: { radius: .91, length: 4.2, depth: .37, taper: .19 },
    abutment: { radius: .79, height: .72, emergenceRadius: 1.1, angleX: 6, angleY: -4 },
    crown: { width, depth: 2.2, height: 2.3, cuspHeight: .21, rotation: 17 } },
  contour: { cervicalScale: .83, occlusalScale: 1.17 } });
const aiRequests = sites => sites.map((site, i) => ({ siteId: site.id, fdi: site.fdi, rationale: `Independent design at ${site.id}.`, design: aiDesign(3.1 - i * .4) }));

test('AI designs sharing an FDI execute independently by exact local site ID and preserve every requested value', async t => {
  const h = await harness(t), sites = neutralSites(), requests = aiRequests(sites), before = structuredClone({ sites, requests, teeth: h.teeth });
  const work = h.api.create([36], h.teeth, [], [], sites, requests);
  for (const request of requests) {
    const pending = h.takeWorker();
    assert.equal(pending.request.site.id, request.siteId);
    assert.equal(pending.request.spec.draftIdentity.siteId, request.siteId);
    assert.deepEqual(pending.request.generationDesign, request.design);
    assert.deepEqual(pending.request.spec.parameters, request.design.parameters);
    assert.deepEqual(pending.request.spec.contour, request.design.contour);
    assert.equal(pending.request.options.maxCandidates, 1);
    assert.equal(pending.request.options.verifyBaselineIntersections, true);
    assert.match(pending.request.spec.source, /AI-directed design/);
    assert.ok(pending.request.spec.source.includes('skills/dental-restoration-design/SKILL.md'));
    assert.ok(pending.request.spec.source.includes(request.rationale));
    await replyFit(pending); await microtasks();
  }
  const result = await work; h.render();
  assert.equal(h.queuedWorkerCount, 0); assert.deepEqual(result.failedSites, []);
  for (const request of requests) {
    const assembly = assemblyAt(h, request.siteId);
    assert.deepEqual(assembly.spec.parameters, request.design.parameters);
    assert.deepEqual(assembly.spec.contour, request.design.contour);
    assert.deepEqual(assembly.spec.frame, sites.find(site => site.id === request.siteId).frame);
    assert.equal(assembly.candidateHistory.length, 1);
    assert.equal(assembly.fit.quality.stopReason, 'measurement-only');
  }
  assert.notDeepEqual(assemblyAt(h, 'ridge-a').spec.parameters, assemblyAt(h, 'ridge-b').spec.parameters);
  assert.deepEqual({ sites, requests, teeth: h.teeth }, before);
});

test('AI mode never authorizes a different neutral site from a shared FDI or falls back to local defaults', async t => {
  for (const [name, requestsFor] of [
    ['no authorized designs', () => []],
    ['transport alias', sites => [{ ...aiRequests(sites)[0], siteId: 'site-1' }]],
    ['wrong FDI', sites => [{ ...aiRequests(sites)[0], fdi: 35 }]],
    ['duplicate designs', sites => [aiRequests(sites)[0], aiRequests(sites)[0]]],
    ['incomplete design', sites => [{ ...aiRequests(sites)[0], design: { ...aiDesign(), parameters: { crown: aiDesign().parameters.crown } } }]],
  ]) await t.test(name, async t => {
    const h = await harness(t), sites = neutralSites();
    const result = await h.api.create([36], h.teeth, [], [], sites, requestsFor(sites)); h.render();
    assert.equal(h.queuedWorkerCount, 0, 'No localization worker or implicit default fit is authorized.');
    assert.equal(h.api.assemblies.length, 0);
    assert.deepEqual(result.failedSites.map(site => site.siteId), sites.map(site => site.id));
    assert.ok(h.api.siteReadiness.every(site => site.status === 'needs-input'));
  });
  await t.test('one authorized site cannot supply its design to the other', async t => {
    const h = await harness(t), sites = neutralSites(), requests = aiRequests(sites).slice(0, 1);
    const work = h.api.create([36], h.teeth, [], [], sites, requests);
    await replyFit(h.takeWorker()); await microtasks();
    const result = await work; h.render();
    assert.equal(h.queuedWorkerCount, 0);
    assert.deepEqual(result.assemblies.map(siteId), ['ridge-a']);
    assert.deepEqual(result.failedSites.map(site => site.siteId), ['ridge-b']);
    assert.match(h.api.siteReadiness.find(site => site.siteId === 'ridge-b').detail, /No authorized AI design/);
  });
  await t.test('no exact local site cannot start anatomical localization', async t => {
    const h = await harness(t);
    const result = await h.api.create([36], h.teeth, [], [], [], aiRequests(neutralSites())); h.render();
    assert.equal(h.queuedWorkerCount, 0); assert.deepEqual(result.failed, [36]); assert.equal(h.api.assemblies.length, 0);
  });
});

test('AI executor rejects worker changes to the exact design and retains independent site failures', async t => {
  for (const [name, change] of [
    ['parameters', result => { result.spec.parameters.crown.width *= .9; }],
    ['contour', result => { result.spec.contour.cervicalScale = 1; }],
    ['anatomy', result => { result.spec.anatomy = 'premolar'; }],
    ['frame', result => { result.spec.frame.origin[0] += 1; }],
    ['site identity', result => { result.spec.draftIdentity.siteId = 'ridge-b'; }],
    ['anatomical signs', result => { result.spec.anatomicalSigns.mesial *= -1; }],
    ['anatomy source', result => { result.spec.crownShape.source.kind = 'patient-donor'; }],
    ['template cut', result => { result.spec.crownShape.occlusal[0] *= .8; }],
    ['candidate history', result => { result.history.push(structuredClone(result.history[0])); }],
  ]) await t.test(name, async t => {
    const h = await harness(t), sites = neutralSites().slice(0, 1), requests = aiRequests(sites);
    const work = h.api.create([36], h.teeth, [], [], sites, requests), pending = h.takeWorker();
    const result = await fitRestoration({ spec: pending.request.spec, surfaces: [], options: { maxCandidates: 1 } });
    change(result); pending.reply({ type: 'result', result });
    const outcome = await work; h.render();
    assert.equal(h.api.assemblies.length, 0); assert.deepEqual(outcome.failedSites.map(site => site.siteId), ['ridge-a']);
    assert.match(h.api.error, /authorized design/);
  });
});

test('AI generation remains assessment-bound for named sites without anatomical proposals', async t => {
  for (const stage of ['pending', 'completed', 'old callback']) await t.test(stage, async t => {
    const h = await harness(t), sites = neutralSites().slice(0, 1).map(({ draftIdentity: _draft, ...site }) => site), requests = aiRequests(sites);
    const create = h.api.create;
    if (stage === 'old callback') h.render({ hypothesisRevision: 'assessment-b' });
    const work = create([36], h.teeth, [], [], sites, requests);
    if (stage === 'old callback') {
      assert.equal(h.queuedWorkerCount, 0); await work; return;
    }
    const pending = h.takeWorker();
    if (stage === 'completed') { await replyFit(pending); await work; h.render(); assert.equal(h.api.assemblies.length, 1); }
    h.render({ hypothesisRevision: 'assessment-b' });
    if (stage === 'pending') {
      assert.equal(pending.terminated, true); assert.equal(await settlesImmediately(work), true);
      await replyFit(pending); await microtasks(); h.render(); assert.equal(h.api.assemblies.length, 0);
    } else assert.ok(h.api.assemblies.every(isStale));
    assert.equal(h.api.busy, false); assert.equal(h.queuedWorkerCount, 0);
    assert.ok(h.api.siteReadiness.every(site => site.status === 'needs-input'));
  });
});

test('AI exact generation cancels on source, pose, labels and assessment changes and discards late responses', async t => {
  const changes = [...evidenceChanges, ['source pose', h => ({ parts: h.parts.map(part => ({ ...part, offset: [1, 0, 0] })) })]];
  for (const [name, change] of changes) await t.test(name, async t => {
    const h = await harness(t), sites = neutralSites(), work = h.api.create([36], h.teeth, [], [], sites, aiRequests(sites)), pending = h.takeWorker();
    h.render(change(h));
    assert.equal(pending.terminated, true); assert.equal(await settlesImmediately(work), true);
    await replyFit(pending); await microtasks(); h.render();
    assert.equal(h.api.assemblies.length, 0); assert.equal(h.queuedWorkerCount, 0); assert.equal(h.api.busy, false);
    assert.ok(h.api.siteReadiness.every(site => site.status === 'needs-input'));
  });
});
