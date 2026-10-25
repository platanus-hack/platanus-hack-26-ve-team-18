import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { crownEnamel, withCrownEnamel } from '../src/crown-enamel.ts';
import { tissueScoresFromColors } from '../src/texture-evidence.ts';
import { MeshViewer, createPartMaterial, surfaceColor } from '../src/viewer.ts';
import { prepareCollisionParts } from '../src/collision-input.ts';

const spec = () => ({ parentPartId: 'lower', frame: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], up: [0, 0, 1] },
  parameters: { crown: { rotation: 0 } } });
function crown() {
  const geometry = new THREE.BoxGeometry(4, 4, 6).toNonIndexed().translate(0, 0, 3);
  const positions = geometry.getAttribute('position').array, normals = geometry.getAttribute('normal').array;
  geometry.dispose();
  return { id: 'crown', name: 'Crown', fileName: 'crown.ply', positions, normals, closed: true, visible: true, offset: [0, 0, 0],
    triangles: positions.length / 9, vertices: 8, dimensions: [4, 4, 6], role: 'model', presentationColor: '#f4ead7',
    restoration: { assemblyId: 'a', component: 'crown', parentPartId: 'lower' } };
}
function scan(hex = '#bcb7a7', overrides = {}) {
  const positions = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    const y = -1.2 + i * .8, z = 1 + j;
    positions.push(3, y, z, 3, y + .3, z, 3, y, z + .3);
  }
  const rgb = new THREE.Color(hex).toArray(), colors = Float32Array.from(positions, (_, i) => rgb[i % 3]);
  return { id: 'lower', name: 'Lower scan', fileName: 'lower.ply', role: 'lower', positions: Float32Array.from(positions),
    normals: new Float32Array(positions.length), colors, tissueScores: tissueScoresFromColors(colors), textureStatus: 'vertex-colors',
    triangles: positions.length / 9, vertices: positions.length / 3, closed: false, visible: true, offset: [0, 0, 0], dimensions: [0, 2.7, 3.3], ...overrides };
}
const closeArrays = (a, b, epsilon = 1e-5) => {
  assert.equal(a.length, b.length);
  a.forEach((value, i) => assert.ok(Math.abs(value - b[i]) < epsilon, `${i}: ${value} != ${b[i]}`));
};
function viewer() {
  const instance = Object.create(MeshViewer.prototype);
  Object.assign(instance, { root: new THREE.Group(), meshes: new Map(), sources: new Map(), textures: new Map(), report: null, heatmap: true,
    tolerance: .5, opacities: {}, toothView: null, disposed: false, cancelGesture() {}, rebuildAnnotations() {}, updateBounds() {}, fit() {}, draw() {} });
  return instance;
}

test('nearby linear scan colors drive enamel, with gentle variation and immutable evidence', () => {
  const source = scan(), raw = crown(), before = structuredClone([source, raw]);
  const displayed = withCrownEnamel(raw, spec(), [source]), enamel = crownEnamel(displayed);
  assert.equal(enamel.source, 'nearby-scan-colors');
  assert.equal(enamel.baseColor, '#bcb7a7');
  assert.equal(enamel.samples, 16);
  assert.equal(displayed.positions, raw.positions);
  assert.equal(displayed.normals, raw.normals);
  assert.deepEqual([source, raw], before);
  assert.deepEqual(prepareCollisionParts([displayed]), prepareCollisionParts([raw]));
  assert.ok(new Set(enamel.colors).size > 6, 'enamel has local colour variation');
  const base = new THREE.Color(enamel.baseColor).toArray();
  enamel.colors.forEach((value, i) => assert.ok(Math.abs(value / base[i % 3] - 1) < .07, 'variation remains gentle'));
  assert.equal(crownEnamel(withCrownEnamel({ ...raw, visible: false }, spec(), [source])), enamel, 'visibility changes reuse appearance buffers');
});

test('pink, magenta, unknown/transparent atlas faces, shadows and clipped white never become enamel', () => {
  const raw = crown();
  const rejected = ['#d88491', '#e6ccd9', '#20201c', '#ffffff', '#4433bb'].map(hex => scan(hex));
  rejected.push(scan('#bcb7a7', { tissueScores: new Float32Array(16).fill(-1) }), scan('#bcb7a7', { tissueScores: undefined }));
  const mixed = scan();
  // A face's average cue can hide one pink corner; each corner must also pass.
  for (let face = 0; face < mixed.triangles; face++) mixed.colors.set(new THREE.Color('#dc8290').toArray(), face * 9);
  mixed.tissueScores.fill(0);
  rejected.push(mixed);
  for (const source of rejected) {
    const enamel = crownEnamel(withCrownEnamel(raw, spec(), [source]));
    assert.equal(enamel.source, 'illustrative-fallback');
    assert.equal(enamel.baseColor, '#d7d4c9');
    assert.equal(enamel.samples, 0);
  }
  const excluded = crownEnamel(withCrownEnamel(raw, spec(), [scan()], { lower: new Uint8Array(16).fill(255) }));
  assert.equal(excluded.source, 'illustrative-fallback');
});

test('matching rejects other arches, restorations, remote surfaces and insufficient spatial evidence', () => {
  const raw = crown(), parent = scan('#d88491');
  const candidates = [
    scan('#bcb7a7', { id: 'other', role: 'upper' }), scan('#bcb7a7', { id: 'other', role: 'bite' }),
    scan('#bcb7a7', { id: 'other', restoration: raw.restoration }), scan('#bcb7a7', { id: 'other', reference: 'tomography' }),
    scan('#bcb7a7', { id: 'other', offset: [100, 0, 0] }),
  ];
  for (const candidate of candidates) assert.equal(crownEnamel(withCrownEnamel(raw, spec(), [parent, candidate])).source, 'illustrative-fallback');
  const repeated = scan();
  for (let i = 9; i < repeated.positions.length; i += 9) repeated.positions.set(repeated.positions.subarray(0, 9), i);
  assert.equal(crownEnamel(withCrownEnamel(raw, spec(), [repeated])).source, 'illustrative-fallback', 'one repeated patch is not twelve independent samples');
});

test('scan offsets and registration are resolved into the parent frame for color sampling', () => {
  const raw = crown(), parent = scan('#d88491', { offset: [10, 20, 30] });
  const neighbor = scan('#ada999', { id: 'separate-tooth', offset: [30, 20, 30] });
  for (let i = 0; i < neighbor.positions.length; i += 3) neighbor.positions[i] -= 20;
  const enamel = crownEnamel(withCrownEnamel(raw, spec(), [parent, neighbor]));
  assert.equal(enamel.source, 'nearby-scan-colors');
  assert.equal(enamel.baseColor, '#ada999');
});

test('accepted scan color spread strengthens bounded fragment mottling and updates an existing material', () => {
  const raw = crown(), input = spec(), uniform = scan(), varied = scan();
  for (let face = 0; face < varied.triangles; face++) {
    const scale = .7 + face / (varied.triangles - 1) * .6;
    for (let i = face * 9; i < face * 9 + 9; i++) varied.colors[i] *= scale;
  }
  varied.tissueScores = tissueScoresFromColors(varied.colors);
  const plain = withCrownEnamel(raw, input, [uniform]), mottled = withCrownEnamel(raw, input, [varied]);
  assert.equal(crownEnamel(plain).variation, .055);
  assert.equal(crownEnamel(mottled).variation, .095, 'scan variation reaches the visible, bounded amplitude');
  const instance = viewer();
  instance.setParts([plain]);
  const material = instance.meshes.get(raw.id).material;
  const shader = { vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader };
  material.onBeforeCompile(shader, {});
  assert.equal(shader.uniforms.enamelVariation.value, .055);
  instance.setParts([mottled]);
  assert.equal(instance.meshes.get(raw.id).material, material);
  assert.equal(shader.uniforms.enamelVariation.value, .095, 'live evidence updates the compiled material uniform');
  assert.match(shader.fragmentShader, /enamelMottle = clamp/);
  assert.match(shader.fragmentShader, /clamp\(enamelTint, vec3\(-0\.1\), vec3\(0\.1\)\)/);
  instance.setParts([]);
});

test('texture coordinates and colors follow crown-local rotation, translation and file scale', () => {
  const raw = crown(), input = spec(), original = crownEnamel(withCrownEnamel(raw, input, []));
  const transformed = { ...raw, positions: raw.positions.slice() }, moved = spec();
  // Rotate 90 degrees about construction up, then rotate the entire file frame.
  moved.parameters.crown.rotation = 90;
  moved.frame = { origin: [30, -20, 10], u: [0, 1, 0], v: [0, 0, 1], up: [1, 0, 0] };
  for (let i = 0; i < raw.positions.length; i += 3) {
    const [x, y, z] = raw.positions.slice(i, i + 3);
    transformed.positions.set([30 + z * 7, -20 - y * 7, 10 + x * 7], i);
  }
  const changed = crownEnamel(withCrownEnamel(transformed, moved, []));
  closeArrays(changed.coordinates, original.coordinates);
  closeArrays(changed.colors, original.colors);
  const posed = withCrownEnamel({ ...raw, offset: [40, 9, 3], rotation: [90, 0, 20] }, input, []);
  assert.equal(crownEnamel(posed), original, 'pose edits do not regenerate the pattern');
});

test('explicit display color and roughness survive matching and restoration metadata is required', () => {
  const raw = crown(), input = { ...spec(), appearance: { crown: { color: '#bbccdd', roughness: .7 } } };
  const displayed = withCrownEnamel({ ...raw, presentationRoughness: .7 }, input, [scan()]);
  assert.equal(crownEnamel(displayed).source, 'manual-display-color');
  assert.equal(displayed.presentationColor, '#bbccdd');
  const material = createPartMaterial(displayed);
  assert.equal(material.roughness, .7);
  assert.equal(material.map, null, 'procedural detail allocates no image/texture resources');
  material.dispose();
  const imported = { ...displayed, restoration: undefined };
  assert.equal(crownEnamel(imported), undefined);
  assert.equal(withCrownEnamel(imported, input, [scan()]), imported);
});

test('same-id recoloring and inspection toggles preserve buffers, overrides and material cleanup', () => {
  const raw = crown(), input = spec(), source = scan(), instance = viewer();
  const displayed = withCrownEnamel(raw, input, [source]);
  instance.setParts([displayed]);
  const mesh = instance.meshes.get(raw.id), geometry = mesh.geometry, material = mesh.material;
  assert.equal(geometry.getAttribute('enamelCoordinate').array, crownEnamel(displayed).coordinates);
  const updated = withCrownEnamel(raw, input, [scan('#aaa394')]);
  instance.setParts([updated]);
  assert.equal(mesh.geometry, geometry);
  assert.equal(mesh.material, material);
  assert.equal(crownEnamel(updated).coordinates, crownEnamel(displayed).coordinates);
  assert.equal(material.userData.presentation.colorSource, 'nearby-scan-colors');
  closeArrays(geometry.getAttribute('color').array, crownEnamel(updated).colors);
  instance.setAnalysis({ parts: [{ id: raw.id, distances: new Float32Array(raw.positions.length / 3), intersecting: new Uint8Array(raw.triangles), maxDepth: 0 }] }, .5);
  const overlay = geometry.getAttribute('inspectionOverlay');
  assert.equal(overlay.getW(0), 1);
  closeArrays(Array.from(overlay.array.slice(0, 3)), new THREE.Color('#e8ac44').toArray());
  instance.setAppearance(false, true, raw.id);
  assert.equal(overlay.getW(0), 0);
  assert.equal(mesh.material.wireframe, true);
  closeArrays(geometry.getAttribute('color').array, crownEnamel(updated).colors);
  closeArrays(surfaceColor(updated, 1, false, new THREE.Color()).toArray(), crownEnamel(updated).colors.slice(3, 6));
  const shader = { vertexShader: THREE.ShaderLib.physical.vertexShader, fragmentShader: THREE.ShaderLib.physical.fragmentShader };
  material.onBeforeCompile(shader, {});
  assert.match(shader.vertexShader, /attribute vec3 enamelCoordinate/);
  assert.ok(shader.fragmentShader.indexOf('outgoingLight = mix') > shader.fragmentShader.indexOf('roughnessFactor = clamp'));
  assert.doesNotMatch(shader.fragmentShader, /worldPosition|gl_FragCoord/);
  let disposals = 0;
  material.addEventListener('dispose', () => disposals++);
  instance.setParts([{ ...updated, presentationRoughness: .8 }]);
  assert.equal(disposals, 1);
  assert.equal(mesh.material.roughness, .8);
  assert.equal(mesh.material.wireframe, true);
  let geometryDisposals = 0;
  geometry.addEventListener('dispose', () => geometryDisposals++);
  instance.setParts([]);
  assert.equal(geometryDisposals, 1);
  assert.equal(instance.textures.size, 0);
});
