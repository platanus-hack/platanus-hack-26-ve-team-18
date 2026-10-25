import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { posedPositions } from '../src/pose.ts';

// Run the real hook/pose/grouping code with a controlled React host, following
// case-planning-lifecycle.test.mjs. Keep render and layout separate so stale
// browser callbacks can be delivered in between; no DOM dependency is needed.
const moduleUrl = new URL('../src/useCbctAlignment.ts?automatic-lifecycle-tests', import.meta.url).href;
const react = `data:text/javascript,${encodeURIComponent(['useState', 'useRef', 'useCallback', 'useLayoutEffect'].map(name =>
  `export const ${name} = (...args) => globalThis.__cbctAlignmentHooks.${name}(...args);`).join('\n'))}`;
const loader = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === moduleUrl) {
    if (specifier === 'react') return { url: react, shortCircuit: true };
    if (specifier.startsWith('./')) return next(new URL(`${specifier}.ts`, moduleUrl).href, context);
  }
  return next(specifier, context);
} });
let useCbctAlignment;
try { ({ useCbctAlignment } = await import(moduleUrl)); } finally { loader.deregister(); }

function hookHost(initial) {
  const slots = [], pending = new Map();
  let input = initial, cursor = 0, dirty = false, view;
  const changed = (a, b) => !a || !b || a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]));
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
    useLayoutEffect(effect, deps) {
      const i = cursor++, previous = slots[i];
      if (changed(previous?.deps, deps)) {
        slots[i] = { effect, deps, cleanup: previous?.cleanup };
        pending.set(i, slots[i]);
      }
    },
  };
  const host = {
    renderOnly(next = {}) {
      input = { ...input, ...next };
      globalThis.__cbctAlignmentHooks = hooks;
      cursor = 0; dirty = false;
      return view = useCbctAlignment(input);
    },
    flush() {
      for (let pass = 0; pass < 20; pass++) {
        const queued = [...pending.values()]; pending.clear();
        queued.forEach(slot => { slot.cleanup?.(); slot.cleanup = slot.effect(); });
        if (!dirty) return view;
        host.renderOnly();
      }
      throw new Error('The CBCT hook did not settle.');
    },
    render(next = {}) { host.renderOnly(next); return host.flush(); },
    replayEffects() {
      const effects = slots.filter(slot => slot.effect);
      effects.forEach(slot => { slot.cleanup?.(); slot.cleanup = undefined; });
      effects.forEach(slot => { slot.cleanup = slot.effect(); });
      return host.render();
    },
    dispose() { pending.clear(); slots.forEach(slot => { slot.cleanup?.(); slot.cleanup = undefined; }); },
  };
  return host;
}

const part = (id = 'upper') => ({
  id, sourceFileId: 'optical-file', name: id, fileName: `${id}.ply`, role: 'upper',
  positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]), normals: new Float32Array(9),
  closed: false, visible: true, offset: [0, 0, 0], triangles: 1, vertices: 3, dimensions: [2, 2, 0],
});
const volume = () => ({ id: 'local-volume', voxels: Float32Array.of(0, 100, 200, 300), dimensions: [2, 2, 1] });
const result = () => ({ matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1], rmsMm: .5, medianMm: .4, coverage: .8, samples: 100, threshold: 200, durationMs: 1 });
function setup(t, overrides = {}) {
  const saved = Object.fromEntries(['Worker', '__cbctAlignmentHooks'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const workers = [], aligned = [], faults = {};
  const initial = { parts: [part()], volume: volume(), mmPerUnit: 1, disabled: false, automatic: true, onAligned: value => aligned.push(value), ...overrides };
  const host = hookHost(initial);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  globalThis.Worker = class {
    constructor() {
      workers.push(this);
      if (faults.construct) throw new Error('worker construction unavailable');
    }
    postMessage(message, transfer) {
      if (faults.post) throw new Error('worker transfer failed');
      this.transfer = transfer;
      this.payload = structuredClone(message, { transfer });
    }
    terminate() { this.terminated = true; }
    reply(patch = {}) { this.onmessage({ data: { id: this.payload.id, result: result(), ...patch } }); }
  };
  t.after(() => {
    host.dispose();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
  });
  return { host, initial, workers, aligned, faults };
}

test('automatic defaults to false and a manual fit consumes the automatic attempt but remains retryable', t => {
  const { host, workers, aligned } = setup(t, { automatic: undefined });
  let view = host.render(); assert.equal(workers.length, 0); assert.equal(view.busy, false);
  view.run(); view = host.render(); assert.equal(workers.length, 1); assert.equal(view.busy, true);
  workers[0].reply(); view = host.render({ automatic: true });
  assert.equal(aligned.length, 1); assert.equal(workers.length, 1); assert.equal(view.busy, false);
  view.run(); assert.equal(workers.length, 2);
});

test('missing inputs, invalid scale and both readiness gates defer quietly without consuming the first attempt', t => {
  const { host, initial, workers } = setup(t);
  for (const patch of [
    { parts: [], volume: null, mmPerUnit: null, disabled: true, automatic: false },
    { parts: initial.parts }, { volume: initial.volume }, { mmPerUnit: 1 },
    { automatic: true }, { disabled: false, mmPerUnit: 0 }, { mmPerUnit: -1 },
    { mmPerUnit: NaN }, { mmPerUnit: Infinity }, { mmPerUnit: null },
    { mmPerUnit: 1, automatic: false },
  ]) {
    const view = host.render(patch);
    assert.equal(workers.length, 0); assert.equal(view.error, ''); assert.equal(view.busy, false);
  }
  host.render({ automatic: true }); assert.equal(workers.length, 1);
  host.render({ automatic: false }); assert.equal(workers[0].terminated, undefined, 'automatic gates scheduling, not an already running fit');
});

for (const field of ['volume', 'voxels', 'scale', 'id', 'sourceFileId', 'positions', 'role', 'addition', 'removal', 'source eligibility']) {
  test(`a new ${field} schedules its own attempt once`, t => {
    const { host, initial, workers } = setup(t);
    if (field === 'removal') initial.parts.push({ ...part('component-2'), sourceFileId: 'second-file' });
    if (field === 'source eligibility') initial.parts.push({ ...part('previous-bite'), role: 'bite' });
    host.render(); workers[0].reply(); host.render();
    let patch;
    if (field === 'volume') patch = { volume: { ...initial.volume } };
    else if (field === 'voxels') { initial.volume.voxels = initial.volume.voxels.slice(); patch = {}; }
    else if (field === 'scale') patch = { mmPerUnit: .5 };
    else if (field === 'addition') patch = { parts: [...initial.parts, { ...part('component-2'), sourceFileId: 'second-file' }] };
    else if (field === 'removal') patch = { parts: initial.parts.slice(0, 1) };
    else if (field === 'source eligibility') patch = { parts: initial.parts.map(source => source.role === 'bite' ? { ...source, role: 'model' } : source) };
    else patch = { parts: [{ ...initial.parts[0], [field]: { id: 'new-id', sourceFileId: 'new-file', positions: initial.parts[0].positions.slice(), role: 'lower' }[field] }] };
    host.render(patch); assert.equal(workers.length, 2);
    workers[1].reply(); host.render(); host.render(); assert.equal(workers.length, 2);
  });
}

test('appearance, excluded meshes and reordered source sets keep active work and do not schedule after completion', t => {
  const parts = [part(), { ...part('lower'), role: 'lower', sourceFileId: 'lower-file' }];
  const { host, workers } = setup(t, { parts }); host.render();
  const changed = parts.toReversed().map(source => ({ ...source, name: 'renamed', visible: false, colors: new Float32Array(9), roleSource: 'user-reviewed' }));
  const extras = [{ ...part('reference'), reference: 'tomography' }, { ...part('crown'), restoration: { assemblyId: 'concept' } }];
  host.render({ parts: [...changed, ...extras] });
  assert.equal(workers[0].terminated, undefined); workers[0].reply();
  host.render({ parts: changed }); host.render({ parts: changed.toReversed() }); assert.equal(workers.length, 1);
});

test('adding a bite after CBCT alignment schedules a new fit once automatic bite registration settles', t => {
  const { host, initial, workers } = setup(t); host.render(); workers[0].reply();
  // Root calls public cancel before importing new sources, so only the old key
  // is suppressed. Its programmatic bite result must preserve the pending key.
  host.render().cancel();
  const bite = { ...part('bite'), role: 'bite', sourceFileId: 'bite-file' };
  const withBite = [...initial.parts, bite];
  host.render({ parts: withBite, automatic: false });
  host.render({ disabled: true }); assert.equal(workers.length, 1);
  const registered = withBite.map(source => source.role === 'bite' ? source : { ...source, pose: result().matrix });
  host.render({ parts: registered, automatic: false, disabled: false }); assert.equal(workers.length, 1);
  host.render({ automatic: true }); assert.equal(workers.length, 2);
  assert.deepEqual(workers[1].payload.sources.map(source => source.id), ['optical-file'], 'bite dependencies are never CBCT fit samples');
  assert.deepEqual(workers[1].payload.sources[0].positions, posedPositions(registered[0]));
  workers[1].reply(); host.render({ parts: registered.toReversed() });
  host.render({ parts: registered.map(source => source.role === 'bite' ? { ...source, offset: [10, 0, 0] } : source) });
  assert.equal(workers.length, 2, 'manual bite offsets cannot re-arm automatic CBCT alignment');
});

test('public cancel during pending bite registration suppresses that key even when automatic later becomes ready', t => {
  const { host, initial, workers } = setup(t); host.render(); workers[0].reply(); host.render().cancel();
  const withBite = [...initial.parts, { ...part('bite'), role: 'bite' }];
  host.render({ parts: withBite, automatic: false, disabled: true }).cancel();
  host.render({ parts: withBite.map(source => ({ ...source, pose: result().matrix })), automatic: true, disabled: false });
  assert.equal(workers.length, 1, 'programmatic pose application must not call public cancel if it should preserve pending scheduling');
});

for (const field of ['id', 'sourceFileId', 'positions', 'role', 'removal']) {
  test(`a bite ${field} change invalidates the running CBCT fit and schedules a new key without sampling the bite`, t => {
    const bite = { ...part('bite'), role: 'bite', sourceFileId: 'bite-file' };
    const { host, initial, workers, aligned } = setup(t, { parts: [part(), bite] }); host.render(); const old = workers[0];
    const patch = { id: 'new-bite', sourceFileId: 'new-bite-file', positions: bite.positions.slice(), role: 'model' };
    const parts = field === 'removal' ? initial.parts.slice(0, 1) : [initial.parts[0], { ...bite, [field]: patch[field] }];
    host.renderOnly({ parts, automatic: false }); old.reply(); host.flush();
    assert.equal(aligned.length, 0); assert.equal(workers.length, 1); assert.equal(old.terminated, true);
    host.render({ automatic: true }); assert.equal(workers.length, 2);
    if (field !== 'role') assert.equal(workers[1].payload.sources.length, 1);
  });
}

test('a bite alone quietly waits for optical meshes', t => {
  const { host, workers } = setup(t, { parts: [{ ...part('bite'), role: 'bite' }] });
  const view = host.render(); assert.equal(workers.length, 0); assert.equal(view.error, ''); assert.equal(view.busy, false);
});

test('applying an automatic result through public cancel and new poses cannot trigger another automatic fit', t => {
  const { host, initial, workers, aligned } = setup(t);
  let next;
  host.render({ onAligned(value) {
    aligned.push(value); host.renderOnly().cancel();
    next = initial.parts.map(source => ({ ...source, pose: value.matrix, offset: [0, 0, 0] }));
    host.renderOnly({ parts: next });
  } });
  workers[0].reply(); host.flush(); host.render();
  host.render({ parts: next.map(source => ({ ...source, offset: [20, 0, 0], rotation: [0, 0, 15] })) });
  host.render({ parts: initial.parts });
  assert.equal(aligned.length, 1); assert.equal(workers.length, 1);
});

for (const state of ['before layout', 'waiting for automatic', 'waiting for disabled', 'active']) {
  test(`public Cancel suppresses the current key ${state}, and a new source can still align`, t => {
    const { host, initial, workers } = setup(t, { automatic: state !== 'waiting for automatic', disabled: state === 'waiting for disabled' });
    const view = state === 'before layout' ? host.renderOnly() : host.render();
    view.cancel(); host.render({ automatic: true, disabled: false });
    const previousCount = state === 'active' ? 1 : 0;
    assert.equal(workers.length, previousCount);
    if (previousCount) assert.equal(workers[0].terminated, true);
    host.render({ parts: [{ ...initial.parts[0], positions: initial.parts[0].positions.slice() }] });
    assert.equal(workers.length, previousCount + 1);
  });
}

test('internal stale cleanup does not suppress new sources, and captured obsolete handlers cannot stop their replacement', t => {
  const { host, initial, workers, aligned } = setup(t); host.render();
  const old = workers[0], message = old.onmessage, error = old.onerror, unreadable = old.onmessageerror;
  host.render({ parts: [{ ...initial.parts[0], id: 'replacement' }] });
  assert.equal(old.terminated, true); assert.equal(workers.length, 2);
  message({ data: { id: old.payload.id, result: result() } }); error({ message: 'obsolete failure' }); unreadable();
  assert.equal(host.render().busy, true); assert.equal(host.render().error, ''); assert.equal(workers[1].terminated, undefined);
  workers[1].reply(); assert.equal(aligned.length, 1);
});

test('a response after source render but before layout is stale and leaves the new automatic key eligible', t => {
  const { host, initial, workers, aligned } = setup(t); host.render(); const old = workers[0];
  host.renderOnly({ volume: { ...initial.volume } }); old.reply();
  assert.equal(aligned.length, 0); host.flush(); assert.equal(workers.length, 2);
});

for (const field of ['pose', 'offset', 'rotation']) {
  test(`a ${field} changed and restored before effects still invalidates the worker without repeating auto`, t => {
    const { host, initial, workers, aligned } = setup(t); host.render(); const old = workers[0];
    const value = { pose: result().matrix, offset: [5, 0, 0], rotation: [0, 15, 0] }[field];
    host.renderOnly({ parts: [{ ...initial.parts[0], [field]: value }] });
    host.renderOnly({ parts: initial.parts }); old.reply(); host.flush();
    assert.equal(aligned.length, 0); assert.equal(workers.length, 1); assert.equal(host.render().busy, false);
  });
}

test('temporary disabled interruption resumes once, while completed work does not repeat after readiness toggles', t => {
  const { host, workers, aligned } = setup(t); host.render();
  assert.equal(host.render({ disabled: true }).busy, false); assert.equal(workers[0].terminated, true);
  host.render(); assert.equal(workers.length, 1);
  host.render({ disabled: false, automatic: false }); assert.equal(workers.length, 1);
  host.render({ automatic: true }); assert.equal(workers.length, 2);
  workers[1].reply(); host.render({ disabled: true }); host.render({ disabled: false });
  assert.equal(workers.length, 2); assert.equal(aligned.length, 1);
});

test('a manually started fit does not inherit automatic resumption when disabled interrupts it', t => {
  const { host, workers } = setup(t, { automatic: false }); host.render().run();
  host.render({ automatic: true, disabled: true }); assert.equal(workers[0].terminated, true);
  host.render({ disabled: false }); assert.equal(workers.length, 1); assert.equal(host.render().busy, false);
});

for (const event of ['success', 'worker error', 'returned error', 'unreadable', 'timeout', 'disabled roundtrip']) {
  test(`disabled interruption resumes even when ${event} arrives before layout cleanup`, t => {
    const { host, workers, aligned } = setup(t); host.render(); const old = workers[0];
    host.renderOnly({ disabled: true });
    if (event === 'disabled roundtrip') host.renderOnly({ disabled: false });
    if (event === 'worker error') old.onerror({ message: 'old crash' });
    else if (event === 'returned error') old.reply({ error: 'old failure' });
    else if (event === 'unreadable') old.onmessageerror();
    else if (event === 'timeout') t.mock.timers.tick(45_000);
    else old.reply();
    assert.equal(aligned.length, 0);
    const view = host.render({ disabled: false }); assert.equal(view.error, ''); assert.equal(workers.length, 2);
    workers[1].reply(); host.render(); assert.equal(aligned.length, 1); assert.equal(workers.length, 2);
  });
}

for (const interruption of ['Cancel', 'pose change', 'pose roundtrip']) {
  test(`${interruption} during disabled waiting revokes automatic resumption`, t => {
    const { host, initial, workers } = setup(t); host.render(); host.render({ disabled: true });
    if (interruption === 'Cancel') host.render().cancel();
    else {
      host.renderOnly({ parts: [{ ...initial.parts[0], offset: [10, 0, 0] }] });
      if (interruption === 'pose roundtrip') host.renderOnly({ parts: initial.parts });
    }
    host.render({ disabled: false }); assert.equal(workers.length, 1);
    host.render({ mmPerUnit: 2 }); assert.equal(workers.length, 2);
  });
}

for (const failure of ['construction', 'postMessage', 'returned error', 'worker error', 'unreadable', 'timeout', 'apply callback']) {
  test(`automatic ${failure} fails once, retains an error and permits a manual retry`, t => {
    const { host, workers, faults, aligned } = setup(t);
    if (failure === 'construction') faults.construct = true;
    if (failure === 'postMessage') faults.post = true;
    host.render(failure === 'apply callback' ? { onAligned() { throw new Error('apply failed'); } } : {});
    const old = workers[0];
    if (failure === 'returned error') old.reply({ error: 'alignment failed' });
    if (failure === 'worker error') old.onerror({ message: 'worker crashed' });
    if (failure === 'unreadable') old.onmessageerror();
    if (failure === 'timeout') {
      t.mock.timers.tick(44_999); assert.equal(host.render().busy, true);
      t.mock.timers.tick(1);
    }
    if (failure === 'apply callback') old.reply();
    let view = host.render(); assert.equal(view.busy, false); assert.ok(view.error); const error = view.error;
    host.render({ disabled: true, automatic: false }); view = host.render({ disabled: false, automatic: true });
    assert.equal(workers.length, 1); assert.equal(view.error, error);
    faults.construct = false; faults.post = false;
    view = host.render({ onAligned: value => aligned.push(value) }); view.run(); view = host.render();
    assert.equal(workers.length, 2); assert.equal(view.error, ''); assert.equal(view.busy, true);
    workers[1].reply(); assert.equal(host.render().busy, false); assert.equal(aligned.length, 1);
  });
}

test('manual run reads newly rendered inputs before effects and only the latest callback receives the result', t => {
  const { host, initial, workers, aligned } = setup(t, { automatic: false }); const previous = host.render(); previous.run();
  const newest = [{ ...initial.parts[0], id: 'newest', offset: [3, 4, 5] }];
  host.renderOnly({ parts: newest, onAligned: value => aligned.push(['latest', value]) }); previous.run();
  assert.equal(workers[0].terminated, true); assert.equal(workers.length, 2);
  assert.deepEqual(workers[1].payload.sources[0].positions, posedPositions(newest[0]));
  host.flush(); workers[1].reply(); assert.equal(aligned[0][0], 'latest');
});

test('worker transfers detach only disposable copies and group shared source files with their current poses', t => {
  const parts = [part(), { ...part('component-2'), visible: false, offset: [1, 2, 3] }, { ...part('lower'), role: 'lower', sourceFileId: undefined, rotation: [0, 0, 90] }];
  const { host, initial, workers } = setup(t, { parts });
  const positions = parts.map(source => source.positions.slice()), voxels = initial.volume.voxels.slice();
  host.render(); const first = workers[0];
  assert.deepEqual(first.payload.sources.map(source => source.id), ['optical-file', 'lower']);
  assert.deepEqual(first.payload.sources[0].positions, new Float64Array([...posedPositions(parts[0]), ...posedPositions(parts[1])]));
  assert.deepEqual(first.payload.sources[1].positions, posedPositions(parts[2]));
  assert.equal(first.transfer.length, 3); assert.equal(new Set(first.transfer).size, 3);
  assert.ok(first.transfer.every(buffer => buffer.byteLength === 0));
  assert.deepEqual(initial.volume.voxels, voxels); parts.forEach((source, index) => assert.deepEqual(source.positions, positions[index]));
  first.reply({ id: first.payload.id + 1 }); assert.equal(host.render().busy, true, 'a response for another job cannot finish the active fit');
  first.reply(); host.render().run(); assert.equal(workers.length, 2);
  assert.deepEqual(workers[1].payload.volume.voxels, voxels);
});

test('effect replay replaces an unfinished automatic job and never strands a consumed attempt', t => {
  const { host, workers, aligned } = setup(t); host.render();
  const late = workers[0].onmessage, oldId = workers[0].payload.id;
  assert.equal(host.replayEffects().busy, true); assert.equal(workers.length, 2); assert.equal(workers[0].terminated, true);
  late({ data: { id: oldId, result: result() } }); assert.equal(aligned.length, 0);
  workers[1].reply(); host.render(); host.replayEffects(); assert.equal(workers.length, 2); assert.equal(aligned.length, 1);
});

test('unmount clears the worker/timer, ignores captured callbacks and prevents manual work', t => {
  const { host, workers, aligned } = setup(t); const view = host.render();
  const old = workers[0], message = old.onmessage, error = old.onerror;
  host.dispose(); assert.equal(old.terminated, true); assert.equal(old.onmessage, null);
  message({ data: { id: old.payload.id, result: result() } }); error({ message: 'late' }); t.mock.timers.tick(45_000); view.run();
  assert.equal(aligned.length, 0); assert.equal(workers.length, 1);
});
