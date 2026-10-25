import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MeshViewer, createInspectionMaterial, createSurfaceTexture, hasSurfaceTexture, surfaceColor } from '../src/viewer.ts';
import { renderToothViews } from '../src/auto-tooth-views.ts';

function part(overrides = {}) {
  return {
    id: 'surface', name: 'surface', fileName: 'surface.obj',
    positions: new Float32Array([10, 20, 30, 12, 20, 30, 10, 22, 30]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    colors: new Float32Array([0.2, 0.4, 0.6, 0.3, 0.5, 0.7, 0.1, 0.2, 0.3]),
    texture: { fileName: 'texture.png', mimeType: 'image/png', bytes: new Uint8Array([1, 2, 3]) },
    textureStatus: 'mapped', closed: false, visible: true, offset: [2, -3, 4],
    triangles: 1, vertices: 3, dimensions: [2, 2, 0], role: 'upper', ...overrides,
  };
}

// Exercise the real cache/paint code without a WebGL context or DOM event wiring.
function viewer() {
  const instance = Object.create(MeshViewer.prototype);
  Object.assign(instance, {
    root: new THREE.Group(), meshes: new Map(), sources: new Map(), textures: new Map(),
    report: null, heatmap: true, tolerance: 0.5, opacities: {}, toothView: null,
    disposed: false, cancelGesture() {}, rebuildAnnotations() {}, updateBounds() {},
    fit() {}, draw() {},
  });
  return instance;
}

function mockGlobal(t, name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
}

const settled = () => new Promise(resolve => setImmediate(resolve));

test('bite references allocate no render geometry and changing a role releases the previous mesh', () => {
  const instance = viewer();
  const source = part({ texture: undefined });
  instance.setParts([source, part({ id: 'bite', role: 'bite', texture: undefined })]);
  assert.deepEqual([...instance.meshes.keys()], ['surface']);
  assert.equal(instance.sources.has('bite'), false);
  let disposals = 0;
  instance.meshes.get(source.id).geometry.addEventListener('dispose', () => disposals++);
  instance.setParts([{ ...source, role: 'bite' }]);
  assert.equal(instance.meshes.size, 0);
  assert.equal(instance.root.children.length, 0);
  assert.equal(disposals, 1);
});

test('surface appearance respects mapping status, natural linear colors, and generated restoration colors', () => {
  const source = part();
  assert.equal(hasSurfaceTexture(source), true);
  for (const overrides of [{ uvs: undefined }, { uvs: new Float32Array(4) }, { textureStatus: 'unmapped' }, { textureStatus: 'vertex-colors' }, { presentationColor: '#f0c080' }]) {
    assert.equal(hasSurfaceTexture({ ...source, ...overrides }), false);
  }
  const color = new THREE.Color();
  assert.deepEqual(surfaceColor(source, 1, false, color).toArray(), Array.from(source.colors.slice(3, 6)));
  assert.deepEqual(surfaceColor(source, 1, true, color).toArray(), [1, 1, 1]);
  const restoration = { ...source, presentationColor: '#f0c080' };
  assert.deepEqual(surfaceColor(restoration, 1, true, color), new THREE.Color('#f0c080'));
});

test('same-id UV/color changes refresh attributes without recentering, replacing source geometry, or changing pose', () => {
  const source = part({ texture: undefined });
  const originalPositions = source.positions.slice();
  const instance = viewer();
  instance.setParts([source]);
  const mesh = instance.meshes.get(source.id);
  const geometry = mesh.geometry;
  const rootPosition = instance.root.position.clone();
  const matrix = mesh.matrix.clone();
  let fits = 0;
  instance.fit = () => fits++;
  const updated = { ...source, uvs: Float32Array.from(source.uvs, value => value / 2), colors: Float32Array.from(source.colors, value => value / 2) };
  instance.setParts([updated]);
  assert.equal(mesh.geometry, geometry);
  assert.equal(geometry.getAttribute('position').array, source.positions);
  assert.equal(geometry.getAttribute('uv').array, updated.uvs);
  assert.deepEqual(Array.from(geometry.getAttribute('color').array), Array.from(updated.colors));
  assert.deepEqual(instance.root.position, rootPosition);
  assert.deepEqual(mesh.matrix, matrix);
  assert.deepEqual(source.positions, originalPositions);
  assert.equal(fits, 0);
  instance.setParts([{ ...updated, uvs: undefined }]);
  assert.equal(geometry.getAttribute('uv'), undefined);
  instance.setParts([]);
});

test('collision and label overlays stay independent of natural colors and clear back to natural appearance', () => {
  const source = part({ texture: undefined });
  const instance = viewer();
  instance.setParts([source]);
  const geometry = instance.meshes.get(source.id).geometry;
  instance.setAnalysis({ parts: [{ id: source.id, distances: new Float32Array([0, 2, 2]), intersecting: new Uint8Array(1), maxDepth: 1 }] }, 0.5);
  const overlay = geometry.getAttribute('inspectionOverlay');
  assert.equal(overlay.getW(0), 1);
  assert.equal(overlay.getW(1), 0);
  const contact = new THREE.Color('#e8ac44');
  assert.ok(Math.abs(overlay.getX(0) - contact.r) < 1e-6);
  assert.deepEqual(Array.from(geometry.getAttribute('color').array), Array.from(source.colors));
  instance.toothView = { enabled: true, tool: 'paint', activeTooth: 11, labels: { [source.id]: new Uint8Array([11]) } };
  instance.paint();
  assert.ok(Math.abs(overlay.getZ(0) - new THREE.Color('#3987df').b) < 1e-6);
  assert.equal(overlay.getW(2), 1);
  instance.toothView = null;
  instance.setAnalysis(null, 0.5);
  assert.equal(overlay.getW(0), 0);
  instance.setParts([]);
});

test('inspection composites after texture and lighting while preserving model opacity', () => {
  const material = createInspectionMaterial();
  const shader = { vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  material.onBeforeCompile(shader, {});
  const composite = shader.fragmentShader.indexOf('outgoingLight = mix(outgoingLight, vInspectionOverlay.rgb, vInspectionOverlay.a)');
  assert.ok(composite > shader.fragmentShader.indexOf('#include <map_fragment>'));
  assert.ok(composite > shader.fragmentShader.indexOf('#include <lights_fragment_end>'));
  assert.ok(composite < shader.fragmentShader.indexOf('#include <opaque_fragment>'));
  assert.match(shader.fragmentShader, /diffuseColor\.a = mix\(diffuseColor\.a, opacity, vInspectionOverlay\.a\)/);
  assert.doesNotMatch(shader.fragmentShader, /max\(diffuseColor\.a, vInspectionOverlay\.a\)/);
  material.dispose();
});

test('mapped contacts win over tooth labels during inspection and toggle back to the same texture', async t => {
  mockGlobal(t, 'createImageBitmap', async () => ({ close() {} }));
  const source = part();
  const instance = viewer();
  instance.setParts([source]);
  instance.toothView = { enabled: true, tool: 'inspect', activeTooth: 11, labels: { [source.id]: new Uint8Array([11]) } };
  instance.setAnalysis({ parts: [{ id: source.id, distances: new Float32Array([0, 0.5, -0.5]), intersecting: new Uint8Array(1), maxDepth: 0.5 }] }, 0.5);
  await settled();
  const mesh = instance.meshes.get(source.id);
  const map = mesh.material.map;
  assert.ok(map, 'exercise contacts after asynchronous image attachment');
  const overlay = mesh.geometry.getAttribute('inspectionOverlay');
  const assertColor = (vertex, hex) => {
    const expected = new THREE.Color(hex);
    for (const [channel, value] of [[0, expected.r], [1, expected.g], [2, expected.b]]) assert.ok(Math.abs(overlay.array[vertex * 4 + channel] - value) < 1e-6);
    assert.equal(overlay.getW(vertex), 1);
  };
  assertColor(0, '#e8ac44');
  assertColor(1, '#e8ac44');
  assertColor(2, '#8e2438');
  instance.toothView.tool = 'paint';
  instance.paint();
  assertColor(0, '#3987df');
  instance.toothView.tool = 'inspect';
  instance.setAnalysis({ parts: [{ id: source.id, distances: new Float32Array([Infinity, Infinity, Infinity]), intersecting: new Uint8Array([1]), crossing: new Uint8Array([0]), maxDepth: 0 }] }, 0.5);
  for (let vertex = 0; vertex < 3; vertex++) assertColor(vertex, '#e8ac44');
  instance.setAnalysis({ parts: [{ id: source.id, distances: new Float32Array([Infinity, Infinity, Infinity]), intersecting: new Uint8Array([1]), crossing: new Uint8Array([1]), maxDepth: 0 }] }, 0.5);
  for (let vertex = 0; vertex < 3; vertex++) assertColor(vertex, '#d84d45');
  instance.setAppearance(false, false, source.id);
  assertColor(0, '#3987df');
  instance.toothView = null;
  instance.paint();
  for (let vertex = 0; vertex < 3; vertex++) assert.equal(overlay.getW(vertex), 0);
  assert.equal(mesh.material.map, map);
  assert.deepEqual(Array.from(mesh.geometry.getAttribute('color').array), Array(9).fill(1));
  instance.setAppearance(true, false, source.id);
  assertColor(0, '#d84d45');
  instance.setParts([]);
});

test('replaced and removed same-id image loads cannot attach late and every bitmap/texture is released', async t => {
  const pending = [];
  mockGlobal(t, 'createImageBitmap', (_blob, options) => {
    assert.equal(options.imageOrientation, 'flipY');
    return new Promise(resolve => pending.push(resolve));
  });
  const instance = viewer();
  const source = part();
  instance.setParts([source]);
  const first = instance.textures.get(source.id).load.texture;
  let firstDisposals = 0;
  first.addEventListener('dispose', () => firstDisposals++);
  const updated = { ...source, texture: { ...source.texture, bytes: new Uint8Array([4, 5, 6]) } };
  instance.setParts([updated]);
  let staleCloses = 0, activeCloses = 0;
  pending[0]({ close: () => staleCloses++ });
  pending[1]({ close: () => activeCloses++ });
  await settled();
  const mesh = instance.meshes.get(source.id);
  assert.notEqual(mesh.material.map, first);
  assert.equal(mesh.material.map, instance.textures.get(source.id).load.texture);
  assert.equal(mesh.material.map.colorSpace, THREE.SRGBColorSpace);
  assert.equal(mesh.material.map.flipY, false);
  assert.equal(mesh.material.map.wrapS, THREE.ClampToEdgeWrapping);
  assert.equal(mesh.material.map.wrapT, THREE.ClampToEdgeWrapping);
  assert.equal(firstDisposals, 1);
  assert.equal(staleCloses, 1);
  assert.deepEqual(Array.from(mesh.geometry.getAttribute('color').array), Array(9).fill(1));
  const active = mesh.material.map;
  let activeDisposals = 0;
  active.addEventListener('dispose', () => activeDisposals++);
  instance.setParts([{ ...updated, uvs: Float32Array.from(updated.uvs, value => value / 2) }]);
  assert.equal(mesh.material.map, active);
  instance.setParts([]);
  assert.equal(activeCloses, 1);
  assert.equal(activeDisposals, 1);
  assert.equal(instance.textures.size, 0);
});

test('image fallback revokes local object URLs on success and cancellation', async t => {
  mockGlobal(t, 'createImageBitmap', undefined);
  const images = [], revoked = [];
  mockGlobal(t, 'Image', class {
    constructor() { images.push(this); }
    removeAttribute(name) { assert.equal(name, 'src'); }
  });
  t.mock.method(URL, 'createObjectURL', () => `blob:local-${images.length}`);
  t.mock.method(URL, 'revokeObjectURL', url => revoked.push(url));
  const success = createSurfaceTexture(part().texture);
  images[0].onload();
  await success.ready;
  assert.equal(success.texture.image, images[0]);
  assert.deepEqual(revoked, ['blob:local-1']);
  success.dispose();
  const cancelled = createSurfaceTexture(part().texture);
  cancelled.dispose();
  await assert.rejects(cancelled.ready, /cancelled/);
  assert.deepEqual(revoked, ['blob:local-1', 'blob:local-2']);
  assert.equal(images[1].onload, null);
});

test('offscreen view preparation honors cancellation before allocating browser resources', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(renderToothViews(part(), { candidates: [] }, controller.signal), { name: 'AbortError' });
});
