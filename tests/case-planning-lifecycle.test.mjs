import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { emptyToothCase } from '../src/tooth-session.ts';

// Exercise the real hook and snapshot builder, replacing only React's host and
// the browser/worker boundaries, as in case-planning-model-selection.test.mjs.
const moduleUrl = new URL('../src/useCasePlanning.ts?lifecycle-tests', import.meta.url).href;
const dataModule = code => `data:text/javascript,${encodeURIComponent(code)}`;
const react = dataModule(['useState', 'useRef', 'useCallback', 'useEffect'].map(name =>
  `export const ${name} = (...args) => globalThis.__casePlanningLifecycleHooks.${name}(...args);`).join('\n'));
const views = dataModule(`
  export const renderToothViews = (...args) => globalThis.__casePlanningLifecycleViews.tooth(...args);
  export const renderCasePlanningViews = (...args) => globalThis.__casePlanningLifecycleViews.whole(...args);
`);
const loader = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === moduleUrl) {
    if (specifier === 'react') return { url: react, shortCircuit: true };
    if (specifier === './auto-tooth-views' || specifier === './case-planning-views') return { url: views, shortCircuit: true };
    if (specifier.startsWith('./')) return next(new URL(`${specifier}.ts`, moduleUrl).href, context);
  }
  return next(specifier, context);
} });
let useCasePlanning;
try { ({ useCasePlanning } = await import(moduleUrl)); } finally { loader.deregister(); }

function hookHost(initial) {
  const slots = [];
  let input = initial, cursor = 0, dirty = false, pending = [];
  const changed = (a, b) => !a || a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]));
  const hooks = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { value: initial };
      return [slots[i].value, value => {
        const next = typeof value === 'function' ? value(slots[i].value) : value;
        if (!Object.is(next, slots[i].value)) { slots[i].value = next; dirty = true; }
      }];
    },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useCallback(callback, deps) {
      const i = cursor++;
      if (changed(slots[i]?.deps, deps)) slots[i] = { deps, value: callback };
      return slots[i].value;
    },
    useEffect(effect, deps) {
      const i = cursor++, previous = slots[i];
      if (changed(previous?.deps, deps)) {
        const slot = { deps, cleanup: previous?.cleanup }; slots[i] = slot;
        pending.push(() => { slot.cleanup?.(); slot.cleanup = effect(); });
      }
    },
  };
  return {
    render(next = {}) {
      input = { ...input, ...next };
      for (let pass = 0; pass < 20; pass++) {
        globalThis.__casePlanningLifecycleHooks = hooks;
        cursor = 0; dirty = false;
        const view = useCasePlanning(input.parts, input.context, input.blocked ?? false, input.reviewedLabels ?? {});
        const queued = pending; pending = []; queued.forEach(effect => effect());
        if (!dirty) return view;
      }
      throw new Error('The planning hook did not settle.');
    },
    dispose() { slots.forEach(slot => slot.cleanup?.()); },
  };
}

const settled = () => new Promise(resolve => setImmediate(resolve));
const images = label => [0, 1].map(index => ({ label: `${label}-${index}`, mediaType: 'image/jpeg', base64: 'AA==' }));
const part = (id = 'upper') => ({
  id, name: 'Synthetic arch', fileName: 'synthetic.ply', role: 'upper',
  positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  closed: false, visible: true, offset: [0, 0, 0], triangles: 1, vertices: 3, dimensions: [2, 2, 0],
});
const contextFor = parts => ({
  parts, selected: null, probe: null, report: null, tolerance: 0.5, analysisState: 'unavailable',
  teeth: emptyToothCase().teeth, counts: {}, fitSummary: [], fitRadius: null,
});
const scan = () => ({
  frame: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], up: [0, 0, 1] },
  candidates: [{ id: 1, faces: new Uint32Array([0]), seed: { face: 0, point: [0, 0, 0] }, centroid: [0, 0, 0], area: 2, height: 1, warnings: [] }],
  method: 'local', warnings: [], unassignedTriangles: 0,
});
const assessment = request => ({
  revision: request.payload.revision, model: 'claude-sonnet-5-5', summary: 'Synthetic assessment.',
  mappings: [], findings: [], actions: [], designs: [], limitations: [],
});

function preparedResponse(payload) {
  return {
    id: payload.id, revision: payload.revision, sites: [], warnings: [],
    scans: payload.sources.map(source => ({ partId: source.id, scan: scan(), analysis: null, numbering: null, draftLabels: new Uint8Array(source.positions.length / 9), warnings: [] })),
    identities: payload.sources.map(source => ({ partId: source.id, candidateId: 1, fdi: payload.patientRight?.[source.id] ? source.arch === 'upper' ? 11 : 41 : null, confidence: payload.patientRight?.[source.id] ? .9 : 0, alternatives: [], needsReview: !payload.patientRight?.[source.id], reason: 'Synthetic geometry.', source: 'geometry' })),
  };
}
function setup(t) {
  const saved = Object.fromEntries(['Worker', 'fetch', '__casePlanningLifecycleHooks', '__casePlanningLifecycleViews']
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const workers = [], requests = [];
  const parts = [part()], context = contextFor(parts);
  const host = hookHost({ parts, context });
  t.after(() => {
    host.dispose();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.__casePlanningLifecycleViews = {
    tooth: source => images(source.id), whole: () => images('whole'),
  };
  globalThis.Worker = class {
    constructor() { workers.push(this); }
    postMessage(message) { this.payload = structuredClone(message); }
    terminate() { this.terminated = true; }
    reply(patch = {}) { return this.onmessage({ data: { ...preparedResponse(this.payload), ...patch } }); }
  };
  globalThis.fetch = (path, options) => {
    if (path === '/api/planning/status') return Promise.resolve({ ok: true, json: async () => ({ configured: true, model: 'claude-sonnet-5-5' }) });
    assert.equal(path, '/api/planning/analyze');
    // Resolve headers first, but hold JSON completion until after invalidation.
    // This tests the hook's stale-result guard independently of transport abort.
    let complete;
    const body = new Promise(resolve => { complete = resolve; });
    requests.push({ signal: options.signal, payload: JSON.parse(options.body), complete });
    return Promise.resolve({ ok: true, json: () => body });
  };
  return {
    host, parts, context, workers, requests,
    async prepare() {
      host.render(); await settled();
      t.mock.timers.tick(450); host.render();
      await workers.at(-1).reply();
      return host.render();
    },
    async confirm(side = 'image-right') {
      host.render().setPatientRight(side); host.render();
      t.mock.timers.tick(450); host.render();
      await workers.at(-1).reply();
      return host.render();
    },
  };
}

test('local preparation uses a dependency-bound typed envelope and stays usable without patient laterality or provider calls', async t => {
  const { host, prepare, parts, context, workers, requests } = setup(t);
  const view = await prepare(), payload = workers[0].payload;
  assert.ok(Number.isInteger(payload.id)); assert.ok(payload.revision);
  assert.equal(payload.sources[0].arch, 'upper'); assert.deepEqual(payload.sources[0].pose, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  assert.deepEqual(payload.sources[0].positions, parts[0].positions);
  assert.deepEqual(payload.chart, context.teeth); assert.equal(payload.poseVerified, false);
  assert.equal(view.prepared.id, payload.id); assert.equal(view.evidence.revision, payload.revision);
  assert.equal(view.patientRight, null); assert.ok(view.prepared.identities.every(item => item.fdi === null));
  const local = await view.analyzeLocal(); assert.equal(local.model, 'local-geometry'); assert.equal(local.revision, payload.revision);
  assert.equal(requests.length, 0, 'unconfirmed laterality must not silently start an external named assessment');
  assert.equal(host.render().result.model, 'local-geometry');
});

test('a deliberate external assessment can inspect a partial case without patient laterality', async t => {
  const { prepare, requests } = setup(t);
  const view = await prepare();
  const operation = view.analyze(); await settled();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].payload.sources[0].patientRight, null);
  assert.equal(requests[0].payload.preparation.sources[0].sourceId, 'scan-1');
  requests[0].complete(assessment(requests[0]));
  assert.ok(await operation);
});

test('one explicit patient-right confirmation re-prepares identities before an external assessment', async t => {
  const { host, prepare, confirm, workers, requests } = setup(t);
  const initial = await prepare();
  initial.setPatientRight('image-right'); let view = host.render();
  assert.equal(view.evidence, null); assert.equal(view.prepared, null); assert.equal(await view.analyze(), null);
  t.mock.timers.tick(450); host.render();
  assert.equal(workers.length, 2); assert.equal(workers[1].payload.patientRight.upper, 'image-right');
  await workers[1].reply(); view = host.render();
  assert.equal(view.patientRight, 'image-right'); assert.notEqual(view.evidence.revision, initial.evidence.revision);
  assert.equal(requests.length, 0, 'confirming orientation prepares locally; provider assessment remains explicit');
  const operation = view.analyze(); await settled(); assert.equal(requests.length, 1);
  requests[0].complete(assessment(requests[0])); assert.ok(await operation);
});

test('replacing geometry under the same identifier clears confirmation of the previous overview', async t => {
  const { host, prepare, confirm, parts, context, workers } = setup(t);
  await prepare(); const prior = await confirm();
  const replacement = [{ ...parts[0], positions: new Float32Array([0, 0, 0, 4, 0, 0, 0, 3, 0]) }];
  let view = host.render({ parts: replacement, context: { ...context, parts: replacement } });
  assert.equal(view.patientRight, null, 'a source id is not evidence that the new image has the same anatomical side');
  assert.equal(view.result, null); assert.equal(view.prepared, null); assert.equal(view.evidence, null);
  t.mock.timers.tick(450); host.render(); await workers.at(-1).reply(); view = host.render();
  assert.notEqual(view.evidence.revision, prior.evidence.revision);
  assert.ok(view.prepared.identities.every(item => item.fdi === null));
});

for (const change of ['retry preparation', 'block preparation']) {
  test(`${change} cancels the old job and re-prepares the same geometry without another side question`, async t => {
    const { host, prepare, confirm, workers, requests } = setup(t);
    await prepare(); let view = await confirm(); const firstRevision = view.evidence.revision;
    const operation = view.analyze(); await settled(); const old = requests[0];
    if (change === 'retry preparation') { view.prepare(); view = host.render(); }
    else { view = host.render({ blocked: true }); assert.equal(view.evidence, null); view = host.render({ blocked: false }); }
    assert.equal(old.signal.aborted, true); assert.equal(view.result, null); assert.equal(view.evidence, null);
    t.mock.timers.tick(450); host.render();
    old.complete(assessment(old)); assert.equal(await operation, null);
    await workers.at(-1).reply(); view = host.render();
    assert.notEqual(view.evidence.revision, firstRevision);
    assert.equal(view.patientRight, 'image-right');
    assert.equal(workers.at(-1).payload.patientRight.upper, 'image-right', 'confirmed geometry must retain its explicit side through transient blocking');
    assert.ok(view.prepared.identities.some(item => item.fdi !== null));
  });
}

test('a late worker body from an obsolete source cannot publish prepared state or interrupt its replacement', async t => {
  const { host, context, workers } = setup(t);
  host.render(); await settled(); t.mock.timers.tick(450); host.render(); const old = workers[0];
  const replacement = [part('replacement')]; host.render({ parts: replacement, context: { ...context, parts: replacement } });
  assert.equal(old.terminated, true);
  t.mock.timers.tick(450); let view = host.render(); const stage = view.stage;
  await old.reply(); view = host.render();
  assert.equal(view.prepared, null); assert.equal(view.evidence, null); assert.equal(view.stage, stage);
  await workers.at(-1).reply(); view = host.render(); assert.equal(view.prepared.scans[0].partId, 'replacement');
});

test('a worker body with a mismatching dependency revision cannot publish prepared state', async t => {
  const { host, workers } = setup(t);
  host.render(); await settled(); t.mock.timers.tick(450); host.render();
  await workers[0].reply({ revision: 'stale-source-pose-chart' }); const view = host.render();
  assert.equal(view.prepared, null); assert.equal(view.evidence, null);
  assert.equal(view.busy, false, 'a rejected response must not leave a permanent preparation spinner');
});

test('a late API body from a replaced source cannot publish a result or stop new preparation', async t => {
  const { host, prepare, confirm, context, requests, workers } = setup(t);
  await prepare(); let view = await confirm();
  const operation = view.analyze(); await settled(); const old = requests[0];
  const replacement = [part('replacement')];
  view = host.render({ parts: replacement, context: { ...context, parts: replacement } });
  assert.equal(old.signal.aborted, true);
  t.mock.timers.tick(450); view = host.render(); const activeStage = view.stage;
  old.complete(assessment(old)); await operation; view = host.render();
  assert.equal(view.result, null); assert.equal(view.error, ''); assert.equal(view.stage, activeStage);
  await workers.at(-1).reply(); view = host.render();
  assert.equal(view.evidence.sources[0].partId, 'replacement'); assert.notEqual(view.evidence.revision, old.payload.revision); assert.equal(view.patientRight, null);
});

for (const field of ['teeth', 'counts']) {
  test(`changing ${field} cancels provider work and re-prepares against the new annotations`, async t => {
    const { host, prepare, confirm, context, requests, workers } = setup(t);
    await prepare(); const view = await confirm(); const operation = view.analyze(); await settled();
    const changed = field === 'teeth' ? { ...context.teeth, 11: { ...context.teeth[11], status: 'missing', restoration: 'implant' } } : { 11: 1 };
    let next = host.render({ context: { ...context, [field]: changed } });
    assert.equal(requests[0].signal.aborted, true); assert.equal(next.evidence, null); assert.equal(next.prepared, null);
    requests[0].complete(assessment(requests[0])); assert.equal(await operation, null); assert.equal(host.render().result, null);
    t.mock.timers.tick(450); host.render(); await workers.at(-1).reply(); next = host.render();
    assert.equal(workers.length, 3); assert.notEqual(next.prepared.revision, view.prepared.revision);
    if (field === 'teeth') assert.deepEqual(workers.at(-1).payload.chart, changed);
  });
}

for (const field of ['report', 'tolerance', 'analysisState', 'fitSummary', 'fitRadius']) {
  test(`a provider result cannot publish after ${field} changes during the request`, async t => {
    const { host, prepare, confirm, context, requests } = setup(t);
    await prepare(); let view = await confirm(); const evidence = view.evidence;
    const operation = view.analyze(); await settled();
    const changed = { report: { pairs: [] }, tolerance: .1, analysisState: 'running', fitSummary: [], fitRadius: 2 }[field];
    host.render({ context: { ...context, [field]: changed } }); requests[0].complete(assessment(requests[0])); await operation; view = host.render();
    assert.notEqual(view.result?.model, 'claude-sonnet-5-5'); assert.match(view.error, /Case evidence changed during assessment/);
    assert.equal(view.evidence, evidence); assert.equal(view.busy, false);
    assert.equal(view.result.model, 'local-geometry', 'a failed remote assessment may retain independent local geometry');
  });
}

test('cancel discards a late API body while retaining locally prepared evidence', async t => {
  const { host, prepare, confirm, requests } = setup(t);
  await prepare(); let view = await confirm(); const evidence = view.evidence, prepared = view.prepared;
  const operation = view.analyze(); await settled(); view.cancel(); view = host.render();
  assert.equal(requests[0].signal.aborted, true); requests[0].complete(assessment(requests[0])); assert.equal(await operation, null); view = host.render();
  assert.equal(view.result, null); assert.equal(view.evidence, evidence); assert.equal(view.prepared, prepared); assert.equal(view.error, ''); assert.equal(view.busy, false);
});

test('an explicit assessment returns its fresh result and a synchronous duplicate cannot start another upload', async t => {
  const { host, prepare, confirm, requests } = setup(t);
  await prepare(); const view = await confirm();
  const operation = view.analyze(); assert.equal(await view.analyze(), null); await settled(); assert.equal(requests.length, 1);
  const result = assessment(requests[0]); requests[0].complete(result); assert.deepEqual(await operation, result); assert.deepEqual(host.render().result, result);
});

test('changing orientation rejects a late body and re-prepares mirrored identities before another request', async t => {
  const { host, prepare, confirm, requests } = setup(t);
  await prepare(); let view = await confirm(); const operation = view.analyze(); await settled();
  view.setPatientRight('image-left'); view = host.render(); assert.equal(requests[0].signal.aborted, true);
  requests[0].complete(assessment(requests[0])); assert.equal(await operation, null); assert.equal(host.render().result, null);
  view = await confirm('image-left'); const next = view.analyze(); await settled();
  assert.equal(requests[1].payload.sources[0].patientRight, 'image-left'); requests[1].complete(assessment(requests[1])); assert.ok(await next);
});

test('cancelling a deferred image render aborts its signal and prevents all subsequent renders', async t => {
  const { host, workers } = setup(t); const calls = []; let finish;
  globalThis.__casePlanningLifecycleViews = {
    tooth: (_part, _scan, signal) => { calls.push({ kind: 'tooth', signal }); return new Promise(resolve => { finish = resolve; }); },
    whole: (_parts, signal) => { calls.push({ kind: 'whole', signal }); return images('whole'); },
  };
  host.render(); await settled(); t.mock.timers.tick(450); host.render(); const pending = workers[0].reply(); await settled();
  assert.equal(calls.length, 1); assert.ok(calls[0].signal instanceof AbortSignal);
  host.render().cancel(); host.render(); assert.equal(calls[0].signal.aborted, true);
  finish(images('late')); await pending; assert.equal(calls.length, 1); assert.equal(host.render().evidence.views.length, 0); assert.ok(host.render().prepared, 'completed local geometry survives image cancellation');
});

test('cancel before the preparation debounce prevents a worker from starting or stranding loading', async t => {
  const { host, workers } = setup(t);
  host.render(); await settled(); host.render().cancel(); host.render();
  t.mock.timers.tick(450); const view = host.render();
  assert.equal(workers.length, 0); assert.equal(view.busy, false); assert.equal(view.evidence, null);
});

test('a completed external assessment is invalidated when its measurement threshold changes without a provider retry', async t => {
  const { host, prepare, confirm, context, requests } = setup(t);
  await prepare(); const view = await confirm(), operation = view.analyze(); await settled();
  requests[0].complete(assessment(requests[0])); await operation; assert.ok(host.render().result);
  context.tolerance = .1; const updated = host.render();
  assert.equal(updated.result, null); assert.match(updated.error, /measurements changed/); assert.ok(updated.prepared);
  assert.equal(requests.length, 1, 'source re-evaluation never silently spends another provider request');
});

test('restoring a verified result rebinds the first fresh source-pair report rather than clearing the saved assessment', async t => {
  const {host,prepare,confirm,parts,context,requests}=setup(t);
  parts.push({...part('lower'),role:'lower'}); context.parts=parts;
  await prepare();let view=await confirm();
  const report={parts:[],pairs:[],durationMs:1};context.report=report;context.analysisState='ready';view=host.render();
  const operation=view.analyze();await settled();requests[0].complete(assessment(requests[0]));await operation;view=host.render();
  const saved={evidence:view.evidence,result:view.result,prepared:view.prepared,patientRight:view.patientRight};
  view.restore(saved);context.report=null;context.analysisState='running';view=host.render();
  assert.equal(view.result,saved.result); assert.equal(view.error,'');
  context.report=report;context.analysisState='ready';view=host.render();
  assert.equal(view.result,saved.result); assert.equal(requests.length,1);
});
