import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import * as THREE from 'three';

// Keep the real geometry, materials, pose math and local image decoder. Only the
// WebGL boundary is replaced so the submitted scene can be inspected in Node.
const moduleUrl = new URL('../src/case-planning-views.ts?texture-tests', import.meta.url).href;
const threeShim = `data:text/javascript,${encodeURIComponent(`
  export * from ${JSON.stringify(import.meta.resolve('three'))};
  export class WebGLRenderer {
    constructor(options) { return new globalThis.__caseViewsTestRenderer(options); }
  }
`)}`;
const loader = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === moduleUrl && specifier === 'three') return { url: threeShim, shortCircuit: true };
  return next(specifier, context);
} });
let renderCasePlanningViews;
try { ({ renderCasePlanningViews } = await import(moduleUrl)); } finally { loader.deregister(); }

function part(overrides = {}) {
  return {
    id: 'upper', name: 'synthetic', fileName: 'synthetic.obj', role: 'upper',
    positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    texture: { fileName: 'synthetic.png', mimeType: 'image/png', bytes: new Uint8Array([1, 2, 3]) },
    textureStatus: 'mapped', closed: false, visible: true, offset: [0, 0, 0],
    triangles: 1, vertices: 3, dimensions: [2, 2, 0], ...overrides,
  };
}

function mockGlobal(t, name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
}

function browser(t, options = {}) {
  const state = {
    canvases: [], frames: [], decodeCalls: [], bitmaps: [],
    contexts: 0, renderers: 0, rendererDisposals: 0, contextLosses: 0,
    geometryDisposals: 0, materialDisposals: 0, textureDisposals: 0,
  };
  for (const [prototype, counter] of [
    [THREE.BufferGeometry.prototype, 'geometryDisposals'],
    [THREE.MeshStandardMaterial.prototype, 'materialDisposals'],
    [THREE.Texture.prototype, 'textureDisposals'],
  ]) {
    const dispose = prototype.dispose;
    t.mock.method(prototype, 'dispose', function () { state[counter]++; return dispose.call(this); });
  }
  mockGlobal(t, 'createImageBitmap', (blob, decodeOptions) => {
    state.decodeCalls.push({ blob, options: decodeOptions });
    const bitmap = { width: 2, height: 2, closes: 0, close() { this.closes++; } };
    state.bitmaps.push(bitmap);
    return options.decode ? options.decode(bitmap, state.decodeCalls.length) : Promise.resolve(bitmap);
  });
  mockGlobal(t, 'document', { createElement(tag) {
    assert.equal(tag, 'canvas');
    const context = {
      isContextLost: () => options.contextLost?.(state) ?? false,
      getExtension(name) {
        assert.equal(name, 'WEBGL_lose_context');
        return { loseContext() { state.contextLosses++; } };
      },
    };
    const canvas = {
      width: 300, height: 150,
      getContext(type) { assert.equal(type, 'webgl2'); state.contexts++; return context; },
      toDataURL(type) { assert.equal(type, 'image/jpeg'); return options.dataUrl ?? 'data:image/jpeg;base64,AA=='; },
    };
    state.canvases.push(canvas);
    return canvas;
  } });
  mockGlobal(t, '__caseViewsTestRenderer', class {
    constructor({ canvas }) {
      state.renderers++;
      if (options.constructorError) throw new Error('synthetic constructor failure');
      this.canvas = canvas;
    }
    setPixelRatio() {}
    setSize(width, height) { this.canvas.width = width; this.canvas.height = height; }
    setClearColor() {}
    render(scene, camera) {
      state.frames.push({ meshes: scene.children.filter(child => child.isMesh), camera });
      if (options.renderError) throw new Error('synthetic render failure');
    }
    dispose() { state.rendererDisposals++; }
    forceContextLoss() { state.contextLosses++; }
  });
  return state;
}

function assertReleased(state, parts, textures, rendererDisposals = 1) {
  assert.equal(state.geometryDisposals, parts);
  assert.equal(state.materialDisposals, parts);
  assert.equal(state.textureDisposals, textures);
  assert.equal(state.rendererDisposals, rendererDisposals);
  assert.equal(state.contextLosses, state.contexts);
  for (const bitmap of state.bitmaps) assert.equal(bitmap.closes, 1);
  for (const canvas of state.canvases) assert.deepEqual([canvas.width, canvas.height], [0, 0]);
}

const settled = () => new Promise(resolve => setImmediate(resolve));

test('whole-case views await mapped UV textures without sampled colors before opening WebGL', async t => {
  const pending = [];
  const state = browser(t, { decode: bitmap => new Promise(resolve => pending.push(() => resolve(bitmap))) });
  const upper = part();
  const lower = part({ id: 'lower', role: 'lower', visible: false, offset: [0, 0, -4] });
  const operation = renderCasePlanningViews([upper, lower]);
  assert.equal(state.decodeCalls.length, 1);
  assert.equal(state.contexts, 0);
  pending[0]();
  await settled();
  assert.equal(state.decodeCalls.length, 2);
  assert.equal(state.contexts, 0, 'all local decoding precedes the disposable context');
  pending[1]();
  const views = await operation;
  assert.deepEqual(views.map(view => view.label), ['3D', '+X', '-Y', '+Z']);
  assert.ok(views.every(view => view.mediaType === 'image/jpeg' && view.base64 === 'AA=='));
  assert.equal(state.frames.length, 4);
  for (const { meshes } of state.frames) {
    assert.equal(meshes.length, 2, 'hidden arch components remain whole-case evidence');
    for (const [i, mesh] of meshes.entries()) {
      assert.equal(mesh.geometry.getAttribute('uv').array, [upper, lower][i].uvs);
      assert.equal(mesh.geometry.getAttribute('color'), undefined);
      assert.equal(mesh.material.vertexColors, false);
      assert.deepEqual(mesh.material.color.toArray(), [1, 1, 1]);
      assert.equal(mesh.material.map.image, state.bitmaps[i]);
      assert.equal(mesh.material.map.colorSpace, THREE.SRGBColorSpace);
      assert.equal(mesh.material.map.flipY, false);
    }
  }
  assert.equal(state.decodeCalls[0].options.imageOrientation, 'flipY');
  assertReleased(state, 2, 2);
});

test('texture albedo takes precedence over sampled vertex colors', async t => {
  const state = browser(t);
  await renderCasePlanningViews([part({ colors: new Float32Array(9).fill(0.2) })]);
  const mesh = state.frames[0].meshes[0];
  assert.ok(mesh.material.map);
  assert.equal(mesh.material.vertexColors, false);
  assert.equal(mesh.geometry.getAttribute('color'), undefined);
  assert.deepEqual(mesh.material.color.toArray(), [1, 1, 1]);
  assertReleased(state, 1, 1);
});

for (const [name, overrides, failed] of [
  ['missing UVs', { uvs: undefined }, true],
  ['unmapped image', { textureStatus: 'unmapped' }, false],
  ['vertex-color source', { textureStatus: 'vertex-colors' }, false],
  ['non-finite UVs', { uvs: new Float32Array([NaN, 0, 1, 0, 0, 1]) }, true],
]) {
  test(`whole-case ${name} retains the linear vertex-color fallback`, async t => {
    const state = browser(t);
    const source = part({ colors: new Float32Array(9).fill(0.3), ...overrides });
    const views = await renderCasePlanningViews([source]);
    const mesh = state.frames[0].meshes[0];
    assert.equal(state.decodeCalls.length, 0);
    assert.equal(mesh.material.map, null);
    assert.equal(mesh.material.vertexColors, true);
    assert.equal(mesh.geometry.getAttribute('color').array, source.colors);
    assert.deepEqual(mesh.material.color.toArray(), [1, 1, 1]);
    assert.equal(views.every(view => view.label.includes('geometry only: texture map unavailable')), failed);
    assertReleased(state, 1, 0);
  });
}

test('shared CPU centering preserves small posed arch detail at large origins and rotates copied normals only', async t => {
  const state = browser(t);
  const pose = new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(1e9, -2e9, 3e9).toArray();
  const sources = [part({ pose }), part({ id: 'lower', role: 'lower', pose, offset: [0, 0, -4] })];
  const original = structuredClone(sources);
  await renderCasePlanningViews(sources);
  const meshes = state.frames[0].meshes;
  assert.deepEqual(Array.from(meshes[0].geometry.getAttribute('position').array), [-1, 0, 1, 1, 0, 1, -1, 0, 3]);
  assert.deepEqual(Array.from(meshes[1].geometry.getAttribute('position').array), [-1, 0, -3, 1, 0, -3, -1, 0, -1]);
  for (const mesh of meshes) {
    const normal = new THREE.Vector3().fromBufferAttribute(mesh.geometry.getAttribute('normal'), 0);
    assert.ok(normal.distanceTo(new THREE.Vector3(0, -1, 0)) < 1e-6);
    for (const { camera } of state.frames) {
      const positions = mesh.geometry.getAttribute('position');
      for (let i = 0; i < positions.count; i++) {
        const projected = new THREE.Vector3().fromBufferAttribute(positions, i).project(camera);
        assert.ok(Math.abs(projected.x) <= 0.92 + 1e-6 && Math.abs(projected.y) <= 0.92 + 1e-6);
      }
    }
  }
  assert.deepEqual(sources, original);
  assertReleased(state, 2, 2);
});

test('decode failure keeps usable geometry, labels every view honestly and releases all maps', async t => {
  const state = browser(t, { decode: (bitmap, index) => index === 2 ? Promise.reject(new Error('synthetic decode failure')) : Promise.resolve(bitmap) });
  const views = await renderCasePlanningViews([part(), part({ id: 'lower', role: 'lower', offset: [0, 0, -4] })]);
  assert.ok(views.every(view => view.label.includes('geometry only: texture map unavailable')));
  assert.ok(state.frames[0].meshes[0].material.map);
  const failed = state.frames[0].meshes[1];
  assert.equal(failed.material.map, null);
  assert.equal(failed.material.vertexColors, false);
  assert.deepEqual(failed.material.color.toArray(), new THREE.Color('#cdd5df').toArray());
  // The rejected decoder did not produce an image owned by createSurfaceTexture.
  state.bitmaps.pop();
  assertReleased(state, 2, 2);
});

for (const [name, options, expected, rendererDisposals] of [
  ['constructor failure', { constructorError: true }, /WebGL could not start/, 0],
  ['render failure', { renderError: true }, /synthetic render failure/, 1],
  ['context loss', { contextLost: state => state.frames.length > 0 }, /WebGL was interrupted/, 1],
  ['invalid JPEG export', { dataUrl: 'data:,' }, /could not export case planning images/, 1],
]) {
  test(`whole-case ${name} releases textures, geometry and its context`, async t => {
    const state = browser(t, options);
    await assert.rejects(renderCasePlanningViews([part()]), expected);
    assertReleased(state, 1, 1, rendererDisposals);
  });
}

test('cancellation while decoding closes a late image without opening WebGL', async t => {
  let complete;
  const state = browser(t, { decode: bitmap => new Promise(resolve => { complete = () => resolve(bitmap); }) });
  const controller = new AbortController();
  const operation = renderCasePlanningViews([part()], controller.signal);
  controller.abort();
  complete();
  await assert.rejects(operation, { name: 'AbortError' });
  assert.equal(state.contexts, 0);
  assertReleased(state, 0, 1, 0);
});
