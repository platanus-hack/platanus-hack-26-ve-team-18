import test from 'node:test';
import assert from 'node:assert/strict';
import { Box3, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { fitCameraToBounds, InspectionCamera } from '../src/camera.ts';

const closeVector = (actual, expected, tolerance = 1e-9) => assert.ok(actual.distanceTo(expected) < tolerance, `${actual.toArray()} vs ${expected.toArray()}`);
const closeOrientation = (actual, expected) => assert.ok(1 - Math.abs(actual.dot(expected)) < 1e-12);
const corners = bounds => [bounds.min.x, bounds.max.x].flatMap(x => [bounds.min.y, bounds.max.y].flatMap(y => [bounds.min.z, bounds.max.z].map(z => new Vector3(x, y, z))));

function cameraFor(aspect, up = new Vector3(0, 0, 1)) {
  const camera = new InspectionCamera(40, aspect, 1e-5, 1e7);
  camera.up.copy(up);
  camera.position.set(8, -12, 5);
  camera.aimAt(new Vector3());
  camera.updateProjectionMatrix();
  return camera;
}

test('fit preserves viewing direction and contains every projected corner across aspect ratios', () => {
  const bounds = new Box3(new Vector3(140, -60, 20), new Vector3(250, -35, 85));
  const original = bounds.clone();
  for (const aspect of [0.45, 1, 2.8]) {
    const camera = cameraFor(aspect);
    const orientation = camera.quaternion.clone();
    const fit = fitCameraToBounds(camera, bounds);
    closeOrientation(camera.quaternion, orientation);
    closeVector(fit.target, bounds.getCenter(new Vector3()));
    for (const corner of corners(bounds)) {
      const projected = corner.project(camera);
      assert.ok(Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1, `${aspect}: ${projected.toArray()}`);
      assert.ok(projected.z > -1 && projected.z < 1);
    }
    const occupied = Math.max(...corners(bounds).flatMap(point => {
      point.project(camera);
      return [Math.abs(point.x), Math.abs(point.y)];
    }));
    assert.ok(occupied > 0.75, `fit should use the canvas: ${occupied}`);
  }
  assert.deepEqual(bounds, original);
});

test('a flat arch fills a wide canvas more tightly than a bounding sphere', () => {
  const camera = cameraFor(2);
  camera.position.set(0, -30, 0);
  camera.aimAt(new Vector3());
  const bounds = new Box3(new Vector3(-10, -0.2, -2), new Vector3(10, 0.2, 2));
  const fit = fitCameraToBounds(camera, bounds);
  const horizontalFov = 2 * Math.atan(Math.tan(camera.fov * Math.PI / 360) * camera.aspect);
  const oldSphereDistance = fit.radius / Math.sin(Math.min(camera.fov * Math.PI / 180, horizontalFov) / 2) * 1.2;
  assert.ok(fit.distance < oldSphereDistance * 0.6);
});

test('empty bounds leave the camera unchanged and tiny geometry still fits', () => {
  const camera = cameraFor(0.7);
  const position = camera.position.clone();
  const orientation = camera.quaternion.clone();
  assert.equal(fitCameraToBounds(camera, new Box3()), null);
  closeVector(camera.position, position);
  closeOrientation(camera.quaternion, orientation);
  const bounds = new Box3(new Vector3(-1e-5, 0, -1e-5), new Vector3(1e-5, 1e-5, 1e-5));
  const result = fitCameraToBounds(camera, bounds);
  assert.ok(Number.isFinite(result.distance) && result.distance > 0);
});

test('an off-centre surface pivot preserves position, orientation, and the rendered frame through control updates', () => {
  const camera = cameraFor(1.6);
  const controls = new OrbitControls(camera);
  const position = camera.position.clone();
  const orientation = camera.quaternion.clone();
  camera.updateMatrixWorld(true);
  const landmark = new Vector3(2, 1, -1);
  const projectedBefore = landmark.clone().project(camera);
  const pivot = new Vector3(3, -1, 2);
  camera.preservePoseAtPivot(pivot);
  controls.target.copy(pivot);
  for (let i = 0; i < 12; i++) controls.update();
  camera.updateMatrixWorld(true);
  closeVector(camera.position, position);
  closeOrientation(camera.quaternion, orientation);
  closeVector(landmark.clone().project(camera), projectedBefore);
  const radius = camera.position.distanceTo(pivot);
  controls.rotateLeft(0.3);
  assert.ok(camera.position.distanceTo(position) > 1);
  assert.ok(Math.abs(camera.position.distanceTo(pivot) - radius) < 1e-9);
  closeVector(controls.target, pivot);
});

test('fresh controls orbit around the selected Y-up or Z-up axis and fit retains the resulting orientation', () => {
  for (const up of [new Vector3(0, 1, 0), new Vector3(0, 0, 1)]) {
    const camera = cameraFor(1.4, up);
    const target = new Vector3();
    const controls = new OrbitControls(camera);
    controls.target.copy(target);
    const height = camera.position.dot(up);
    const radius = camera.position.length();
    controls.rotateLeft(Math.PI / 2);
    assert.ok(Math.abs(camera.position.dot(up) - height) < 1e-9);
    assert.ok(Math.abs(camera.position.length() - radius) < 1e-9);
    const orientation = camera.quaternion.clone();
    const fit = fitCameraToBounds(camera, new Box3(new Vector3(-4, -3, -2), new Vector3(4, 3, 2)));
    controls.target.copy(fit.target);
    controls.update();
    closeOrientation(camera.quaternion, orientation);
  }
});
