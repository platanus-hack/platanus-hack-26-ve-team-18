import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { displayNormals, restorationAppearance, smoothDisplayNormals } from '../src/restoration-appearance.ts';
import { MeshViewer, createPartMaterial } from '../src/viewer.ts';
import { prepareCollisionParts } from '../src/collision-input.ts';

// A closed faceted prism: 12 side segments (30° apart) plus flat caps (90° edges).
function prism(segments = 12) {
  const out = [], ring = z => Array.from({ length: segments }, (_, i) => [Math.cos(i / segments * Math.PI * 2), Math.sin(i / segments * Math.PI * 2), z]);
  const low = ring(0), high = ring(2);
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    out.push(low[i], low[j], high[j], low[i], high[j], high[i], [0, 0, 2], high[i], high[j], [0, 0, 0], low[j], low[i]);
  }
  const positions = Float32Array.from(out.flat()), normals = new Float32Array(positions.length);
  for (let f = 0; f < positions.length / 9; f++) {
    const [a, b, c] = [0, 1, 2].map(k => new THREE.Vector3().fromArray(positions, f * 9 + k * 3));
    const n = b.clone().sub(a).cross(c.clone().sub(a)).normalize();
    for (let k = 0; k < 3; k++) n.toArray(normals, f * 9 + k * 3);
  }
  return { positions, normals };
}

const part = (overrides = {}) => {
  const { positions, normals } = prism();
  return { id: 'crown', name: 'crown', fileName: 'FDI-16-crown.ply', positions, normals, closed: true, visible: true, offset: [0, 0, 0],
    triangles: positions.length / 9, vertices: 26, dimensions: [2, 2, 2], role: 'model', presentationColor: '#f4ead7',
    restoration: { assemblyId: 'a', component: 'crown', parentPartId: 'upper' }, ...overrides };
};

test('only restoration metadata selects a concept finish; a reimported PLY stays a scan', () => {
  assert.equal(restorationAppearance(part()).finish, 'ceramic-concept');
  assert.equal(restorationAppearance(part({ restoration: { assemblyId: 'a', component: 'fixture', parentPartId: 'upper' } })).finish, 'metal-concept');
  const reimported = part({ restoration: undefined, presentationColor: undefined });
  assert.equal(restorationAppearance(reimported), null);
  assert.equal(displayNormals(reimported).normals, reimported.normals);
  assert.equal(displayNormals(reimported).mode, 'source');
  assert.equal(restorationAppearance(part({ reference: 'tomography' })), null);
});

test('display normals smooth facets, keep cap creases, and never mutate source arrays', () => {
  const source = part(), positions = source.positions.slice(), normals = source.normals.slice();
  const smooth = smoothDisplayNormals(source.positions, source.normals);
  assert.notEqual(smooth, source.normals);
  assert.deepEqual(source.positions, positions);
  assert.deepEqual(source.normals, normals);
  assert.equal(smoothDisplayNormals(source.positions, source.normals), smooth, 'cached per positions array');
  for (let c = 0; c < smooth.length / 3; c++) {
    const n = new THREE.Vector3().fromArray(smooth, c * 3);
    assert.ok(Math.abs(n.length() - 1) < 1e-5);
    const flat = new THREE.Vector3().fromArray(source.normals, c * 3);
    if (Math.abs(flat.z) > 0.99) assert.ok(n.z * flat.z > 0.9999, 'cap corners keep their flat normal across the 90° crease');
    else {
      assert.ok(Math.abs(n.z) < 1e-5, 'side corners stay horizontal');
      const p = new THREE.Vector3().fromArray(source.positions, c * 3).setZ(0).normalize();
      assert.ok(n.dot(p) > 0.9999, 'side corners use the averaged radial normal');
    }
  }
});

test('viewer shows concept finish and smooth normals without changing collision input or overlay dominance', () => {
  const instance = Object.create(MeshViewer.prototype);
  Object.assign(instance, { root: new THREE.Group(), meshes: new Map(), sources: new Map(), textures: new Map(), report: null, heatmap: true, tolerance: 0.5,
    opacities: {}, toothView: null, disposed: false, cancelGesture() {}, rebuildAnnotations() {}, updateBounds() {}, fit() {}, draw() {} });
  const crown = part(), scan = part({ id: 'upper', role: 'upper', restoration: undefined, presentationColor: undefined });
  const before = prepareCollisionParts([crown, scan]);
  instance.setParts([crown, scan]);
  const mesh = instance.meshes.get('crown'), scanMesh = instance.meshes.get('upper');
  assert.ok(mesh.material instanceof THREE.MeshPhysicalMaterial);
  assert.equal(mesh.material.userData.presentation.displayOnly, true);
  assert.equal(scanMesh.material instanceof THREE.MeshPhysicalMaterial, false);
  assert.equal(mesh.geometry.getAttribute('position').array, crown.positions);
  assert.notEqual(mesh.geometry.getAttribute('normal').array, crown.normals);
  assert.equal(scanMesh.geometry.getAttribute('normal').array, scan.normals);
  const geometry = mesh.geometry, material = mesh.material;
  instance.setParts([{ ...crown, visible: false }, scan]);
  assert.equal(mesh.geometry, geometry, 'smoothed normals do not force a rebuild on every update');
  assert.equal(mesh.material, material);
  assert.deepEqual(prepareCollisionParts([crown, scan]), before);
  // The overlay is composited after lighting, so contact colors replace the finish entirely.
  const shader = { vertexShader: '#include <common>\n#include <begin_vertex>', fragmentShader: '#include <common>\n#include <opaque_fragment>' };
  mesh.material.onBeforeCompile(shader);
  assert.match(shader.fragmentShader, /outgoingLight = mix\(outgoingLight, vInspectionOverlay\.rgb, vInspectionOverlay\.a\);\n.*\n#include <opaque_fragment>/);
  let disposed = false;
  material.addEventListener('dispose', () => { disposed = true; });
  instance.setParts([{ ...crown, restoration: undefined }, scan]);
  assert.ok(disposed, 'switching appearance disposes the old material');
  assert.equal(mesh.material instanceof THREE.MeshPhysicalMaterial, false);
  assert.equal(mesh.geometry.getAttribute('normal').array, crown.normals);
});

test('concept material keeps its vertex presentation color path and never carries a texture map', () => {
  const material = createPartMaterial(part());
  assert.equal(material.vertexColors, true);
  assert.equal(material.map, null);
  assert.equal(material.metalness, 0);
  assert.ok(createPartMaterial(part({ restoration: { assemblyId: 'a', component: 'abutment', parentPartId: 'upper' } })).metalness > 0);
});
