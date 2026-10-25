import test from 'node:test';
import assert from 'node:assert/strict';
import { Box3, Group, Matrix4, PerspectiveCamera, Vector3 } from 'three';
import { MeshViewer } from '../src/viewer.ts';
import { placeFloatingControls, projectMeshBounds } from '../src/viewport-projection.ts';

const box = (min, max, matrixWorld = new Matrix4()) => ({ bounds: new Box3(new Vector3(...min), new Vector3(...max)), matrixWorld });
const square = box([-1, -1, 0], [1, 1, 0]);
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} vs ${expected}`);
function cameraAt(x = 0, y = 0, z = 10, aspect = 1) {
  const camera = new PerspectiveCamera(90, aspect, 1, 100);
  camera.position.set(x, y, z);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

test('projected bounds follow orbit, pan, zoom and viewport aspect/size', () => {
  const camera = cameraAt();
  let projected = projectMeshBounds([square], camera, 1000, 1000);
  close(projected.left, 450); close(projected.right, 550);
  camera.position.x = 2;
  camera.updateMatrixWorld(true);
  projected = projectMeshBounds([square], camera, 1000, 1000);
  close(projected.left, 350); close(projected.right, 450);
  camera.position.set(0, 0, 5); camera.updateMatrixWorld(true);
  projected = projectMeshBounds([square], camera, 1000, 1000);
  close(projected.left, 400); close(projected.right, 600);
  camera.aspect = 2; camera.updateProjectionMatrix();
  projected = projectMeshBounds([square], camera, 1200, 600);
  close(projected.left, 540); close(projected.right, 660);
  close(projected.top, 240); close(projected.bottom, 360);
  const orbited = projectMeshBounds([square], cameraAt(10, 0, 0), 1000, 1000);
  close(orbited.left, 500); close(orbited.right, 500);
  assert.ok(orbited.bottom > orbited.top);
});

test('behind-camera, fully offscreen, far-clipped, empty and invalid targets fall back', () => {
  const camera = cameraAt();
  for (const target of [box([-1, -1, 11], [1, 1, 12]), box([30, -1, 0], [32, 1, 0]), box([-1, -1, -200], [1, 1, -150]), { bounds: new Box3(), matrixWorld: new Matrix4() }, box([NaN, 0, 0], [1, 1, 1])]) {
    assert.equal(projectMeshBounds([target], camera, 1000, 1000), null);
  }
  assert.equal(projectMeshBounds([], camera, 1000, 1000), null);
  assert.equal(projectMeshBounds([square], camera, 0, 1000), null);
  assert.equal(projectMeshBounds([square], camera, NaN, 1000), null);
  // Two invisible meshes straddling the screen must not create a visible union.
  assert.equal(projectMeshBounds([box([-40, 0, 0], [-30, 1, 0]), box([30, 0, 0], [40, 1, 0])], camera, 1000, 1000), null);
});

test('near-plane crossings and partially offscreen bounds stay finite and clipped to the canvas', () => {
  const camera = cameraAt();
  assert.deepEqual(projectMeshBounds([box([-2, -2, 8], [2, 2, 12])], camera, 800, 600), { left: 0, top: 0, right: 800, bottom: 600 });
  const partial = projectMeshBounds([box([9, -1, 0], [12, 1, 0])], camera, 1000, 1000);
  close(partial.left, 950); close(partial.right, 1000);
});

test('viewer anchors use normalized partMatrix transforms, actual visibility and displayed bounds without mutating sources', () => {
  const instance = Object.create(MeshViewer.prototype);
  Object.assign(instance, {
    root: new Group(), meshes: new Map(), sources: new Map(), textures: new Map(),
    report: null, heatmap: true, tolerance: 0.5, opacities: {}, toothView: null,
    disposed: false, cancelGesture() {}, rebuildAnnotations() {}, updateBounds() {}, fit() {}, draw() {},
    camera: cameraAt(), renderer: { getSize: size => size.set(1000, 1000) },
  });
  const source = {
    id: 'fixture', name: 'fixture', fileName: 'fixture.stl',
    positions: new Float32Array([0, 0, 0, 4, 0, 0, 0, 2, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    closed: false, visible: true, offset: [3, 4, 0], rotation: [0, 0, 90],
    pose: new Matrix4().makeTranslation(100, 200, 0).toArray(),
    triangles: 1, vertices: 3, dimensions: [4, 2, 0],
  };
  const original = structuredClone(source);
  instance.setParts([source]);
  instance.root.updateMatrixWorld(true);
  let projected;
  instance.setProjectionTarget(['fixture'], bounds => { projected = bounds; });
  instance.updateProjectionTarget();
  close(projected.left, 450); close(projected.right, 550);
  close(projected.top, 400); close(projected.bottom, 600);
  // A pose-only update must move the anchor without changing source arrays or recentering.
  instance.setParts([{ ...source, offset: [5, 4, 0] }]);
  instance.root.updateMatrixWorld(true);
  instance.updateProjectionTarget();
  close(projected.left, 550); close(projected.right, 650);
  const mesh = instance.meshes.get('fixture');
  mesh.visible = false; instance.updateProjectionTarget(); assert.equal(projected, null);
  mesh.visible = true; mesh.material.opacity = 0; instance.updateProjectionTarget(); assert.equal(projected, null);
  mesh.material.opacity = 1; mesh.userData.displayBounds = new Box3();
  instance.updateProjectionTarget(); assert.equal(projected, null);
  delete mesh.userData.displayBounds;
  instance.setProjectionTarget(['missing'], bounds => { projected = bounds; });
  instance.updateProjectionTarget(); assert.equal(projected, null);
  instance.setProjectionTarget([], null);
  assert.equal(instance.projectionTarget, null);
  assert.deepEqual(source, original);
});

test('multiple visible assembly parts share one projected target', () => {
  const projected = projectMeshBounds([square, box([2, -2, 0], [4, 0, 0])], cameraAt(), 1000, 1000);
  close(projected.left, 450); close(projected.right, 700);
  close(projected.top, 450); close(projected.bottom, 600);
});

test('placement flips beside the assembly, reserves affordances and shrinks for minimized content', () => {
  const available = { left: 12, top: 60, right: 988, bottom: 510 };
  assert.deepEqual(placeFloatingControls({ left: 400, right: 500, top: 200, bottom: 300 }, available, 320, 400), { x: 514, y: 60 });
  assert.deepEqual(placeFloatingControls({ left: 800, right: 900, top: 200, bottom: 300 }, available, 320, 400), { x: 466, y: 60 });
  assert.deepEqual(placeFloatingControls(null, available, 320, 400), { x: 668, y: 60 });
  assert.deepEqual(placeFloatingControls({ left: 800, right: 900, top: 480, bottom: 500 }, available, 70, 32), { x: 914, y: 474 });
  const tiny = { left: 12, top: 54, right: 328, bottom: 210 };
  assert.deepEqual(placeFloatingControls(null, tiny, 316, 156), { x: 12, y: 54 });
  assert.deepEqual(placeFloatingControls({ left: NaN, right: Infinity, top: 0, bottom: 100 }, tiny, 316, 156), { x: 12, y: 54 });
});
