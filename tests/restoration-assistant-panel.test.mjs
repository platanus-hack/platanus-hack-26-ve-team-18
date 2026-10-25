import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { transformWithOxc } from 'vite';
import { buildRestorationAssistantSnapshot } from '../src/restoration-assistant.ts';
import { restorationEditRevision } from '../src/restoration-edit.ts';

// Compile and execute the actual panel with a controlled hook host. No DOM,
// copied implementation, external provider or new dependency is involved.
const require = createRequire(import.meta.url), url = new URL('../src/AssistantPanel.tsx', import.meta.url);
const source = (await readFile(url, 'utf8')).replace(/^import '\.\/[^']+\.css';\s*$/gm, '');
let code = (await transformWithOxc(source, url.pathname, { jsx: { runtime: 'automatic' } })).code;
code = code.replace(/import\s*\{([^}]+)\}\s*from\s*['"]react['"];?/, 'const {$1} = globalThis.__assistantPanelHooks;');
code = code.replace(/from (['"])([^'"]+)\1/g, (_, quote, specifier) => `from ${JSON.stringify(specifier === './AnthropicModelSelect'
  ? 'data:text/javascript,export const AnthropicModelSelect=()=>null'
  : specifier.startsWith('./') ? new URL(specifier.endsWith('.ts') ? specifier : `${specifier}.ts`, url).href : pathToFileURL(require.resolve(specifier)).href)}`);
let sequence = 0;
const children = node => Array.isArray(node) ? node : node?.props ? [node.props.children] : [];
const nodes = tree => [tree, ...children(tree).flatMap(nodes)].filter(node => node && typeof node === 'object' && !Array.isArray(node));
const text = tree => typeof tree === 'string' || typeof tree === 'number' ? String(tree) : children(tree).map(text).join(' ');
const ndjson = events => new Response(events.map(event => JSON.stringify(event)).join('\n') + '\n', { headers: { 'Content-Type': 'application/x-ndjson' } });
const done = () => ndjson([{ type: 'text', text: 'Actual revision reviewed; clinical evidence remains unknown.' }, { type: 'done' }]);
const pause = () => new Promise(resolve => setImmediate(resolve));
async function until(check, label = 'condition') { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 2)); } assert.fail(`Timed out waiting for ${label}`); }
function original() {
  const spec = { version: 'implant-assembly/v1', fdi: 36, parentPartId: 'source', source: 'Synthetic', frame: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], up: [0, 0, 1] },
    anatomy: 'molar', provenance: 'hypothesized', units: 'file units (u)', parameters: { fixture: { radius: 1, length: 5, depth: 0, taper: .2 }, abutment: { radius: 1, height: 2, emergenceRadius: 1, angleX: 0, angleY: 0 }, crown: { width: 4, depth: 5, height: 3, cuspHeight: .5, rotation: 0 } } };
  return { id: 'local-assembly', spec, createdAt: 'initial', warnings: [], parts: ['fixture', 'abutment', 'crown'].map(component => ({ id: component, name: component, fileName: `${component}.ply`, role: 'model', positions: new Float32Array(9), normals: new Float32Array(9), offset: [0, 0, 0], visible: true, triangles: 1, vertices: 3, dimensions: [4, 5, 3], closed: true, restoration: { assemblyId: 'local-assembly', component, parentPartId: 'source' } })) };
}
function revised(before, patch) {
  const after = structuredClone(before); after.createdAt = 'updated';
  Object.assign(after.spec.parameters.crown, patch.parameters?.crown);
  after.parts.find(part => part.id === 'crown').dimensions = [after.spec.parameters.crown.width * .93, 5, 3];
  return after;
}
function handoff(body, extra = []) {
  const request = { assemblyId: 'restoration-1', expectedRevision: body.restoration.snapshot.assemblies[0].editRevision,
    edit: { reason: 'Bounded generic width correction.', parameters: { crown: { width: 4.2 } } } };
  return ndjson([{ type: 'tool', id: 'edit-1', name: 'requestRestorationEdit', state: 'complete', output: { status: 'requested', request, applied: false } },
    { type: 'edit-request', id: 'edit-1', request, continuationToken: 'a'.repeat(48), editsUsed: 1 }, ...extra]);
}
async function host(t, chat, applyEdit) {
  const slots = [], pending = [], calls = [], applyCalls = [];
  let cursor = 0, dirty = false, tree, AssistantPanel, active = true;
  const initial = original();
  const h = { calls, applyCalls, props: { context: { parts: initial.parts, selected: null, probe: null, report: null, tolerance: .5, analysisState: 'unavailable', teeth: {}, counts: {}, fitSummary: [], fitRadius: null },
    restoration: { assemblies: [initial], sourceRevision: 'external-1', busy: false, applyEdit: async (...args) => { applyCalls.push(args); return applyEdit(h, ...args); } } },
    render(patch = {}, flush = true) {
      Object.assign(h.props, patch); cursor = 0; dirty = false; tree = AssistantPanel(h.props);
      if (flush) h.flush(); return tree;
    },
    flush() {
      for (let pass = 0; pass < 20; pass++) {
        for (const slot of pending.splice(0)) { slot.cleanup?.(); slot.cleanup = slot.effect(); }
        if (!dirty) return;
        h.render({}, false);
      }
      throw new Error('Panel failed to settle');
    },
    find(type, match = () => true) { const node = nodes(tree).find(node => node.type === type && match(node)); assert.ok(node, `Missing ${type}`); return node; },
    get text() { return text(tree).replace(/\s+/g, ' '); },
    checkbox(label) { return nodes(h.find('label', node => text(node).includes(label))).find(node => node.type === 'input'); },
    commit(after) { h.render({ restoration: { ...h.props.restoration, assemblies: [after] }, context: { ...h.props.context, parts: after.parts } }); },
    ask() { h.find('textarea').props.onChange({ target: { value: 'Improve this generic crown.' } }); h.render(); h.find('form').props.onSubmit({ preventDefault() {} }); h.render(); },
  };
  const changed = (a, b) => !a || !b || a.length !== b.length || a.some((value, i) => value !== b[i]);
  const hooks = {
    useState(initial) { const index = cursor++, slot = slots[index] ??= { value: typeof initial === 'function' ? initial() : initial }; return [slot.value, update => {
      const value = typeof update === 'function' ? update(slot.value) : update;
      if (!Object.is(value, slot.value)) { slot.value = value; dirty = true; queueMicrotask(() => { if (active && dirty) h.render(); }); }
    }]; },
    useRef(initial) { return (slots[cursor++] ??= { value: { current: initial } }).value; },
    useMemo(factory, deps) { const index = cursor++; if (changed(slots[index]?.deps, deps)) slots[index] = { deps, value: factory() }; return slots[index].value; },
    useEffect(effect, deps) { const index = cursor++, previous = slots[index]; if (changed(previous?.deps, deps)) { const slot = slots[index] = { effect, deps, cleanup: previous?.cleanup }; pending.push(slot); } },
  };
  hooks.useLayoutEffect = hooks.useEffect;
  globalThis.__assistantPanelHooks = hooks;
  ({ AssistantPanel } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${++sequence}`));
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/status')) return Response.json({ configured: true, model: 'claude-haiku-5-5' });
    const body = JSON.parse(options.body); calls.push(body); return chat(body, options.signal, h);
  });
  t.after(() => { active = false; slots.forEach(slot => slot.cleanup?.()); delete globalThis.__assistantPanelHooks; });
  h.render(); h.find('button', node => text(node).includes('Open assistant')).props.onClick(); h.render(); await pause(); h.render();
  return h;
}
const enabled = h => { assert.equal(h.checkbox('Allow agent edits').props.checked, false); h.checkbox('Allow agent edits').props.onChange({ target: { checked: true } }); h.render(); };

test('actual panel opts in, awaits commit, survives its own exact transition and sends fresh actual evidence', async t => {
  let resolveEdit;
  const h = await host(t, (body, _signal, h) => h.calls.length === 1 ? handoff(body) : done(), async (h, id, edit, revision, signal) => {
    assert.equal(id, 'local-assembly'); assert.equal(revision, restorationEditRevision(h.props.restoration.assemblies[0])); assert.equal(signal.aborted, false);
    return new Promise(resolve => { resolveEdit = () => { const after = revised(h.props.restoration.assemblies[0], edit); h.commit(after); resolve(after); }; });
  });
  enabled(h); h.ask(); await until(() => h.applyCalls.length === 1);
  assert.equal(h.calls.length, 1); resolveEdit();
  await until(() => h.calls.length === 2); await pause(); h.render();
  const result = h.calls[1].restoration.continuation.result;
  assert.equal(result.status, 'applied'); assert.equal(result.after.parameters.crown.width, 4.2);
  assert.deepEqual(result.after.meshes.find(part => part.component === 'crown').dimensions, [4.2 * .93, 5, 3]);
  assert.deepEqual(h.calls[1].restoration.snapshot, buildRestorationAssistantSnapshot(h.props.restoration.assemblies));
  assert.equal(h.calls[1].snapshot.collision, null); assert.equal(h.calls[1].snapshot.analysisState, 'unavailable');
  assert.match(h.text, /Applied revision/); assert.match(h.text, /Actual revision reviewed/); assert.doesNotMatch(h.text, /previous conversation was cleared/);
});

test('partial/error/duplicate handoffs never start an edit', async t => {
  for (const extra of [[{ type: 'error', message: 'Failed after validation' }], [{ type: 'done' }]]) {
    const h = await host(t, body => handoff(body, extra), async () => assert.fail('No worker from incomplete handoff'));
    enabled(h); h.ask(); await until(() => h.text.includes('invalid handoff'));
    assert.equal(h.applyCalls.length, 0);
  }
});

test('Stop propagates the same AbortSignal to pending worker and prevents continuation', async t => {
  let rejectWork;
  const h = await host(t, body => handoff(body), async (_h, _id, _edit, _revision, signal) => new Promise((_, reject) => {
    rejectWork = reject; signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  enabled(h); h.ask(); await until(() => h.applyCalls.length === 1);
  h.find('button', node => text(node) === 'Stop answer').props.onClick(); h.render(); await pause();
  assert.equal(h.applyCalls[0][3].aborted, true); assert.equal(h.calls.length, 1); assert.match(h.text, /Request stopped/);
  rejectWork(new Error('late result')); await pause(); assert.equal(h.calls.length, 1);
});

test('external source change cancels in-flight work, including before layout effects flush', async t => {
  let complete;
  const h = await host(t, body => handoff(body), async () => new Promise(resolve => { complete = resolve; }));
  enabled(h); h.ask(); await until(() => h.applyCalls.length === 1);
  const after = revised(h.props.restoration.assemblies[0], h.applyCalls[0][1]);
  h.render({ restoration: { ...h.props.restoration, sourceRevision: 'changed-registration' } }, false);
  complete(after); await pause(); h.flush(); await pause();
  assert.equal(h.applyCalls[0][3].aborted, true); assert.equal(h.calls.length, 1);
  assert.match(h.text, /previous conversation was cleared/);
});

test('manual assembly changes during pending agent work are not exempted by the edit fence', async t => {
  let complete;
  const h = await host(t, body => handoff(body), async () => new Promise(resolve => { complete = resolve; }));
  enabled(h); h.ask(); await until(() => h.applyCalls.length === 1);
  const before = h.props.restoration.assemblies[0], manual = revised(before, { parameters: { crown: { width: 5 } } });
  h.commit(manual); complete(revised(before, h.applyCalls[0][1])); await pause(); h.render();
  assert.equal(h.calls.length, 1); assert.match(h.text, /previous conversation was cleared/);
});

test('local worker rejection is sent as an error result without claiming an applied revision', async t => {
  const h = await host(t, (body, _signal, h) => h.calls.length === 1 ? handoff(body) : done(), async () => { throw new Error('worker rejected'); });
  enabled(h); h.ask(); await until(() => h.calls.length === 2); await pause(); h.render();
  assert.equal(h.calls[1].restoration.continuation.result.status, 'error'); assert.match(h.text, /Rejected revision/); assert.doesNotMatch(h.text, /Applied revision/);
});

test('reopened zero rotations and regenerated omitted rotations are the same effective workspace pose', async t => {
  const h = await host(t, (body, _signal, h) => h.calls.length === 1 ? handoff(body) : done(), async (h, _id, edit) => {
    const after = revised(h.props.restoration.assemblies[0], edit);
    after.parts.forEach(part => { delete part.rotation; });
    h.commit(after); return after;
  });
  const reopened = structuredClone(h.props.restoration.assemblies[0]); reopened.parts.forEach(part => { part.rotation = [0, 0, 0]; }); h.commit(reopened);
  enabled(h); h.ask(); await until(() => h.calls.length === 2); await pause(); h.render();
  assert.equal(h.calls[1].restoration.continuation.result.status, 'applied'); assert.doesNotMatch(h.text, /previous conversation was cleared/);
});

test('changing the selected restoration cancels an in-flight answer', async t => {
  let release;
  const h = await host(t, () => new Promise(resolve => { release = resolve; }), async () => assert.fail('No edit was requested'));
  enabled(h); h.ask(); await until(() => h.calls.length === 1);
  h.render({ restoration: { ...h.props.restoration, selectedId: 'local-assembly' } });
  release(done()); await pause(); h.render();
  assert.equal(h.calls.length, 1); assert.equal(h.applyCalls.length, 0); assert.match(h.text, /previous conversation was cleared/);
});

test('manual selection change immediately aborts the worker during a pending authorized edit', async t => {
  let complete;
  const h = await host(t, body => handoff(body), async () => new Promise(resolve => { complete = resolve; }));
  enabled(h); h.ask(); await until(() => h.applyCalls.length === 1);
  h.render({ restoration: { ...h.props.restoration, selectedId: 'local-assembly' } });
  assert.equal(h.applyCalls[0][3].aborted, true);
  complete(revised(h.props.restoration.assemblies[0], h.applyCalls[0][1])); await pause(); h.render();
  assert.equal(h.calls.length, 1); assert.match(h.text, /previous conversation was cleared/);
});

test('automatic probe clearing during collision regeneration does not invalidate an own edit', async t => {
  const h = await host(t, (body, _signal, h) => h.calls.length === 1 ? handoff(body) : done(), async (h, _id, edit) => {
    const after = revised(h.props.restoration.assemblies[0], edit);
    h.props.context = { ...h.props.context, probe: null }; h.commit(after); return after;
  });
  h.render({ context: { ...h.props.context, probe: { id: 'crown', face: 0, vertex: 0, position: [0, 0, 0], distance: null, intersecting: false } } });
  enabled(h); h.ask(); await until(() => h.calls.length === 2); await pause(); h.render();
  assert.equal(h.calls[1].snapshot.probe, null); assert.doesNotMatch(h.text, /previous conversation was cleared/);
});
