import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { ANTHROPIC_MODELS, DEFAULT_IDENTIFICATION_MODEL } from '../src/anthropic-models.ts';
import { emptyToothCase } from '../src/tooth-session.ts';

// Run the real request lifecycle with a small hook host and local view/worker
// doubles, following the existing automatic-identification hook tests.
const moduleUrl = new URL('../src/useCasePlanning.ts?model-selection-tests', import.meta.url).href;
const dataModule = code => `data:text/javascript,${encodeURIComponent(code)}`;
const react = dataModule(['useState', 'useRef', 'useCallback', 'useEffect'].map(name =>
  `export const ${name} = (...args) => globalThis.__casePlanningTestHooks.${name}(...args);`).join('\n'));
const views = dataModule('const views = () => [{label:"local",mediaType:"image/jpeg",base64:"AA=="}]; export {views as renderToothViews, views as renderCasePlanningViews};');
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

function hookHost(parts, context) {
  const slots = [];
  let cursor = 0, dirty = false, pending = [];
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
    render() {
      for (let pass = 0; pass < 20; pass++) {
        globalThis.__casePlanningTestHooks = hooks;
        cursor = 0; dirty = false;
        const view = useCasePlanning(parts, context, false);
        const queued = pending; pending = []; queued.forEach(effect => effect());
        if (!dirty) return view;
      }
      throw new Error('The planning hook did not settle.');
    },
    dispose() { slots.forEach(slot => slot.cleanup?.()); },
  };
}

for (const serverModel of ['claude-sonnet-5-5', 'configured-custom-model']) {
  test(`planning initializes from ${serverModel}, locks selection while busy and preserves result attribution`, async t => {
    const previous = { Worker: globalThis.Worker, fetch: globalThis.fetch, hooks: globalThis.__casePlanningTestHooks };
    const workers = [], requests = [];
    let host;
    t.after(() => {
      host?.dispose();
      globalThis.Worker = previous.Worker; globalThis.fetch = previous.fetch; globalThis.__casePlanningTestHooks = previous.hooks;
    });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    globalThis.Worker = class {
      constructor() { workers.push(this); }
      postMessage(payload) { this.payload = structuredClone(payload); }
      terminate() {}
      reply(scans) { return this.onmessage({ data: { id: this.payload.id, revision: this.payload.revision, scans, sites: [], identities: [], warnings: [] } }); }
    };
    globalThis.fetch = (path, options) => {
      if (path === '/api/planning/status') return Promise.resolve({ ok: true, json: async () => ({ configured: true, model: serverModel }) });
      assert.equal(path, '/api/planning/analyze');
      return new Promise(resolve => requests.push({ payload: JSON.parse(options.body), resolve }));
    };
    const part = {
      id: 'upper', name: 'PRIVATE', fileName: 'PRIVATE.ply', role: 'upper', positions: new Float32Array(9), normals: new Float32Array(9),
      closed: false, visible: true, offset: [0, 0, 0], triangles: 1, vertices: 3, dimensions: [1, 1, 1],
    };
    const parts = [part];
    const context = { parts, selected: null, probe: null, report: null, tolerance: 0.5, analysisState: 'unavailable', teeth: emptyToothCase().teeth, counts: {}, fitSummary: [], fitRadius: null };
    host = hookHost(parts, context);
    let view = host.render();
    assert.equal(view.model, DEFAULT_IDENTIFICATION_MODEL);
    await new Promise(resolve => setImmediate(resolve)); view = host.render();
    assert.equal(view.configured, true);
    assert.equal(view.model, serverModel);
    assert.equal(view.defaultModel, serverModel);

    t.mock.timers.tick(450); view = host.render();
    view.setModel('claude-opus-5-5'); view = host.render();
    assert.equal(view.model, serverModel, 'local preparation locks selection');
    const scan = { frame: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], up: [0, 0, 1] }, candidates: [{ id: 1, faces: new Uint32Array([0]), seed: { face: 0, point: [0, 0, 0] }, centroid: [0, 0, 0], area: 1, height: 1, warnings: [] }], method: 'local', warnings: [], unassignedTriangles: 0 };
    const preparedSource = { partId: part.id, scan, analysis: null, numbering: null, draftLabels: new Uint8Array(1), warnings: [] };
    await workers[0].reply([preparedSource]); view = host.render();
    assert.equal(view.busy, false);
    view.setPatientRight('image-right'); view = host.render();
    assert.equal(view.evidence, null, 'side confirmation re-prepares local numbering before provider work');
    t.mock.timers.tick(450); host.render();
    assert.equal(workers[1].payload.patientRight.upper, 'image-right');
    await workers[1].reply([preparedSource]); view = host.render();

    const assess = async (expectedModel, label, actualModel = expectedModel) => {
      const operation = view.analyze();
      // The ref guard also protects the interval before React renders busy state.
      view.setModel('claude-opus-5-5'); view = host.render();
      assert.equal(view.model, expectedModel);
      assert.match(view.stage, new RegExp(`^${label} is identifying`));
      const request = requests.at(-1);
      if (ANTHROPIC_MODELS.some(model => model.id === expectedModel)) assert.equal(request.payload.model, expectedModel);
      else assert.equal(Object.hasOwn(request.payload, 'model'), false, 'custom defaults are resolved only on the server');
      const result = { revision: request.payload.revision, model: actualModel, summary: 'Proposed review.', mappings: [], findings: [], actions: [], designs: [], limitations: [] };
      request.resolve({ ok: true, json: async () => result });
      await operation; view = host.render();
      assert.equal(view.result.model, actualModel);
      return view.result;
    };

    let prior = await assess(serverModel, ANTHROPIC_MODELS.find(model => model.id === serverModel)?.label ?? serverModel);
    for (const { id, label } of ANTHROPIC_MODELS) {
      view.setModel(id); view = host.render();
      assert.equal(view.result, prior, 'choosing the next model retains the old assessment');
      assert.equal(view.modelLabel, label);
      prior = await assess(id, label, `${id}-actual`);
    }
    view.setModel('arbitrary-request-model'); view = host.render();
    assert.equal(view.model, ANTHROPIC_MODELS.at(-1).id);
    view.setModel(serverModel); view = host.render();
    assert.equal(view.model, serverModel, 'the server default remains selectable after using a catalog model');
    assert.equal(workers.length, 2, 'model changes do not regenerate or invalidate case evidence');
  });
}
