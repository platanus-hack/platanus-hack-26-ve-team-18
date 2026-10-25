import test from 'node:test';
import assert from 'node:assert/strict';
import { Box3, Group, Matrix4, PerspectiveCamera, Raycaster, Vector3 } from 'three';
import { formatMeasurement, lengthFromDisplay, lengthToDisplay, measurementLabel, resolveMeasurement, scanScale } from '../src/measurement.ts';
import { MeshViewer } from '../src/viewer.ts';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} vs ${expected}`);
const closePoint = (actual, expected) => {
  assert.equal(actual.length, expected.length);
  actual.forEach((value, i) => close(value, expected[i]));
};
const triangleAt = (x = 0, y = 0, z = 0) => [x, y, z, x + 4, y, z, x, y + 4, z];
function part(id = 'upper', overrides = {}) {
  const positions = overrides.positions ?? new Float32Array(triangleAt());
  return {
    id, name: id, fileName: `${id}.stl`, positions,
    normals: Float32Array.from(positions, (_, i) => i % 3 === 2 ? 1 : 0),
    triangles: positions.length / 9, vertices: positions.length / 3,
    dimensions: new Box3().setFromArray(positions).getSize(new Vector3()).toArray(),
    closed: false, visible: true, role: 'upper', offset: [0, 0, 0], ...overrides,
  };
}
const anchor = (source, point = [1, 1, 0], face = 0) => ({ partId: source.id, face, point, sourcePositions: source.positions });
const sources = (...parts) => new Map(parts.map(source => [source.id, source]));
const toothView = (source, overrides = {}) => ({
  enabled: true, tool: 'inspect', activeTooth: 11, isolate: false,
  labels: {}, draft: null, sites: [], boundary: [], editablePartIds: [source.id], ...overrides,
});

// Follow viewport-projection.test.mjs: exercise real mesh/pose/measurement methods
// without creating a WebGL context. Only DOM annotations, framing and RAF are stubbed.
function viewer(t, parts) {
  const instance = Object.create(MeshViewer.prototype);
  const states = [], attributes = new Map();
  const camera = new PerspectiveCamera(90, 1, 1, 1000);
  camera.position.set(0, 0, 100);
  camera.lookAt(0, 0, 0);
  Object.assign(instance, {
    root: new Group(), annotations: new Group(), bounds: new Box3(), radius: 1,
    meshes: new Map(), sources: new Map(), textures: new Map(),
    report: null, heatmap: true, tolerance: 0.5, wireframe: false, opacities: {},
    toothView: null, editablePartIds: new Set(), disposed: false,
    rulerEnabled: false, rulerAnchors: [], measurement: { points: [], distance: null },
    rulerCleared: false, rulerSnapshot: '', onRulerChange: state => states.push(state),
    camera, controls: { target: new Vector3() }, navigationMode: 'orbit',
    renderer: { getSize: size => size.set(1000, 1000), domElement: {
      style: {}, setAttribute: (key, value) => attributes.set(key, value),
    } },
    cancelGesture() {}, rebuildAnnotations() {}, updateLimits() {}, fit() {},
    replaceControls(target) { this.controls.target.copy(target); this.configureNavigation(); },
    draw() { this.root.updateMatrixWorld(true); this.camera.updateMatrixWorld(true); this.updateRuler(); },
  });
  t.after(() => {
    for (const mesh of instance.meshes.values()) { mesh.geometry.dispose(); mesh.material.dispose(); }
  });
  instance.setParts(parts);
  return { instance, states, attributes, state: () => states.at(-1) };
}
function measure(instance, anchors) {
  instance.rulerAnchors = anchors;
  instance.refreshMeasurement();
  instance.draw();
}
function rayHit(mesh, localPoint) {
  const origin = new Vector3(...localPoint).add(new Vector3(0, 0, 20)).applyMatrix4(mesh.matrixWorld);
  const direction = new Vector3(0, 0, -1).transformDirection(mesh.matrixWorld);
  const hit = new Raycaster(origin, direction).intersectObject(mesh, false)[0];
  assert.ok(hit, 'the ray must intersect the triangle interior');
  return hit;
}

test('surface anchors preserve actual triangle-interior hits through pose and isolation index remapping', t => {
  const source = part('arch', {
    positions: new Float32Array([...triangleAt(), ...triangleAt(10), ...triangleAt(20)]),
    pose: new Matrix4().makeTranslation(100, 200, 30).toArray(),
    rotation: [30, 20, 90], offset: [3, 4, 12],
  });
  const before = structuredClone(source);
  const { instance } = viewer(t, [source]);
  const mesh = instance.meshes.get(source.id);
  for (const isolated of [false, true]) {
    instance.setToothView(toothView(source, { isolate: isolated, labels: { arch: new Uint8Array([0, 0, 11]) } }));
    const hit = rayHit(mesh, [21, 1, 0]);
    const hitPoint = hit.point.clone();
    assert.equal(hit.faceIndex, isolated ? 0 : 2);
    if (isolated) assert.deepEqual([...mesh.geometry.index.array], [6, 7, 8]);
    const picked = instance.surfaceAnchor(hit);
    assert.equal(picked.partId, source.id);
    assert.equal(picked.face, 2);
    closePoint(picked.point, [21, 1, 0]);
    assert.deepEqual(hit.point, hitPoint, 'reading the anchor must not alter the ray intersection');
    assert.equal(instance.surfaceAnchor({ ...hit, faceIndex: null }), undefined);
  }
  assert.deepEqual(source, before);
});

test('same-part and cross-part distances use the 3D Euclidean metric in unchanged file units', () => {
  const upper = part('upper', { positions: new Float32Array([...triangleAt(), ...triangleAt(3, 4, 12)]) });
  const lower = part('lower', { positions: new Float32Array(triangleAt(3, 4, 12)), role: 'lower' });
  const first = anchor(upper);
  for (const second of [anchor(upper, [4, 5, 12], 1), anchor(lower, [4, 5, 12])]) {
    const result = resolveMeasurement([first, second], sources(upper, lower));
    assert.equal(result.distance, 13);
    assert.deepEqual(result.points.map(point => point.position), [[1, 1, 0], [4, 5, 12]]);
  }
  const moved = { ...upper, pose: new Matrix4().makeRotationX(Math.PI / 2).setPosition(100, -20, 5).toArray(),
    rotation: [20, -35, 90], offset: [3, 4, 12],
  };
  close(resolveMeasurement([first, anchor(upper, [4, 5, 12], 1)], sources(moved)).distance, 13);
  assert.deepEqual(resolveMeasurement([], sources(upper)), { points: [], distance: null });
  assert.equal(resolveMeasurement([first], sources(upper)).distance, null);
  assert.equal(resolveMeasurement([first, first], sources(upper)).distance, 0);
});

test('measurement follows registration, rotation about the posed centre, offset and reset without changing source geometry', t => {
  const upper = part(), lower = part('lower', { role: 'lower' });
  const original = structuredClone(upper);
  const anchors = [anchor(upper), anchor(lower)];
  const { instance, state } = viewer(t, [upper, lower]);
  measure(instance, anchors);
  assert.equal(state().distance, 0);
  // Registration rotates about the file origin; manual rotation uses the posed
  // bounds centre (8, 22, 30). These expectations are independent of partMatrix.
  const pose = new Matrix4().makeRotationZ(Math.PI / 2).setPosition(10, 20, 30).toArray();
  const registered = { ...upper, pose };
  const rotated = { ...registered, rotation: [0, 0, 90] };
  const moved = { ...rotated, offset: [3, 4, 12] };
  const reset = { ...moved, rotation: [0, 0, 0], offset: [0, 0, 0] };
  for (const [updated, expected] of [
    [registered, [9, 21, 30]], [rotated, [9, 23, 30]],
    [moved, [12, 27, 42]], [reset, [9, 21, 30]], [upper, [1, 1, 0]],
  ]) {
    instance.setParts([updated, lower]);
    closePoint(state().points[0].position, expected);
    close(state().distance, Math.hypot(expected[0] - 1, expected[1] - 1, expected[2]));
    assert.equal(instance.rulerAnchors, anchors);
    assert.equal(state().cleared, false);
  }
  assert.deepEqual(upper, original);
  assert.deepEqual(anchors.map(point => point.point), [[1, 1, 0], [1, 1, 0]]);
});

test('adding an unrelated part recentres the display without changing measured workspace coordinates or distance', t => {
  const upper = part(), lower = part('lower', { offset: [3, 4, 12] });
  const { instance, state } = viewer(t, [upper, lower]);
  measure(instance, [anchor(upper), anchor(lower)]);
  const before = structuredClone(state());
  const rootBefore = instance.root.position.clone();
  const farAway = part('unrelated', { offset: [1000, 2000, 0] });
  instance.setParts([upper, lower, farAway]);
  assert.notDeepEqual(instance.root.position, rootBefore);
  assert.notDeepEqual(state().screenPoints, before.screenPoints);
  assert.deepEqual(state().points, before.points);
  assert.equal(state().distance, 13);
  instance.setParts([upper, lower]);
  assert.deepEqual(state().points, before.points);
  assert.equal(state().distance, 13);
});

test('appearance and normal updates retain anchors while names and rendered appearance refresh', t => {
  const source = part('arch', { positions: new Float32Array([...triangleAt(), ...triangleAt(3, 4, 12)]) });
  const original = structuredClone(source);
  const anchors = [anchor(source), anchor(source, [4, 5, 12], 1)];
  const { instance, state } = viewer(t, [source]);
  measure(instance, anchors);
  const updated = { ...source, name: 'Renamed arch', presentationColor: '#93c5fd',
    colors: new Float32Array(source.positions.length).fill(0.5),
    uvs: new Float32Array(source.vertices * 2), normals: source.normals.slice(),
  };
  instance.setParts([updated]);
  instance.setAppearance(false, true, source.id);
  instance.setOpacities({ arch: 0.35 });
  assert.equal(instance.rulerAnchors, anchors);
  assert.equal(state().distance, 13);
  assert.deepEqual(state().points.map(point => point.name), ['Renamed arch', 'Renamed arch']);
  assert.equal(state().cleared, false);
  assert.ok(state().screenPoints.every(Boolean));
  assert.deepEqual(source, original);
});

test('same-ID source positions replacement or part removal clears both endpoints and reports invalidation', t => {
  for (const change of ['replace', 'remove', 'remove-all']) {
    const upper = part(), lower = part('lower', { offset: [3, 4, 12] });
    const { instance, state } = viewer(t, [upper, lower]);
    instance.setRulerEnabled(true);
    measure(instance, [anchor(upper), anchor(lower)]);
    instance.setParts(change === 'replace' ? [{ ...upper, positions: upper.positions.slice() }, lower]
      : change === 'remove' ? [lower] : []);
    assert.deepEqual(instance.rulerAnchors, [], change);
    assert.deepEqual(state().points, [], change);
    assert.deepEqual(state().screenPoints, [], change);
    assert.equal(state().distance, null, change);
    assert.equal(state().cleared, true, change);
    assert.equal(state().enabled, change !== 'remove-all', change);
    instance.clearMeasurement();
    assert.equal(state().cleared, false, 'explicit clear acknowledges the invalidation');
  }
});

test('missing sources, stale revisions, invalid faces/points and reference geometry cannot resolve a measurement', () => {
  const source = part(), valid = anchor(source);
  for (const invalid of [
    { ...valid, partId: 'missing' }, { ...valid, sourcePositions: source.positions.slice() },
    ...[-1, 0.5, source.triangles, NaN].map(face => ({ ...valid, face })),
    ...[NaN, Infinity, -Infinity].map(value => ({ ...valid, point: [1, value, 0] })),
  ]) assert.equal(resolveMeasurement([valid, invalid], sources(source)), null);
  for (const changed of [{ ...source, reference: 'tomography' }, { ...source, role: 'bite' }, { ...source, offset: [Infinity, 0, 0] }]) {
    assert.equal(resolveMeasurement([valid], sources(changed)), null);
  }
});

test('hidden, transparent and isolated surfaces hide only their projected endpoints and preserve measurement', t => {
  const source = part('arch', { positions: new Float32Array([...triangleAt(), ...triangleAt(3, 4, 12)]) });
  const anchors = [anchor(source), anchor(source, [4, 5, 12], 1)];
  const { instance, state } = viewer(t, [source]);
  measure(instance, anchors);
  const positions = structuredClone(state().points);
  const shown = () => {
    assert.equal(instance.rulerAnchors, anchors);
    assert.deepEqual(state().points, positions);
    assert.equal(state().distance, 13);
    assert.equal(state().cleared, false);
    return state().screenPoints.map(Boolean);
  };
  assert.deepEqual(shown(), [true, true]);
  instance.setParts([{ ...source, visible: false }]);
  assert.deepEqual(shown(), [false, false]);
  instance.setParts([source]);
  instance.setOpacities({ arch: 0 });
  assert.deepEqual(shown(), [false, false]);
  instance.setOpacities({ arch: 0.25 });
  assert.deepEqual(shown(), [true, true]);
  const isolated = toothView(source, { isolate: true, labels: { arch: new Uint8Array([11, 12]) } });
  instance.setToothView(isolated);
  assert.deepEqual(shown(), [true, false]);
  instance.setToothView({ ...isolated, draft: { partId: 'arch', faces: new Uint32Array([1]) } });
  assert.deepEqual(shown(), [true, true], 'visible draft triangles retain their endpoint');
  instance.setToothView({ ...isolated, activeTooth: 12 });
  assert.deepEqual(shown(), [false, true], 'isolation checks the original face, not compact face zero');
  instance.setToothView({ ...isolated, activeTooth: 13 });
  assert.deepEqual(shown(), [false, false]);
  instance.setToothView(null);
  assert.deepEqual(shown(), [true, true]);
});

test('camera projection and clipping change screen endpoints without changing measurement or emitting duplicate states', t => {
  const source = part('arch', { positions: new Float32Array([...triangleAt(), ...triangleAt(3, 4, 12)]) });
  const { instance, state, states } = viewer(t, [source]);
  measure(instance, [anchor(source), anchor(source, [4, 5, 12], 1)]);
  const initial = structuredClone(state());
  const count = states.length;
  instance.draw();
  assert.equal(states.length, count);
  instance.camera.position.z = 50;
  instance.draw();
  assert.notDeepEqual(state().screenPoints, initial.screenPoints);
  instance.camera.far = 10;
  instance.camera.updateProjectionMatrix();
  instance.draw();
  assert.deepEqual(state().screenPoints, [null, null]);
  instance.camera.far = 1000;
  instance.camera.position.z = -100;
  instance.camera.lookAt(0, 0, -200);
  instance.camera.updateProjectionMatrix();
  instance.draw();
  assert.deepEqual(state().screenPoints, [null, null]);
  instance.camera.lookAt(0, 0, 0);
  instance.draw();
  assert.ok(state().screenPoints.every(Boolean));
  assert.deepEqual(state().points, initial.points);
  assert.equal(state().distance, 13);
});

test('enabling the ruler leaves tooth editing, stopping retains endpoints, and explicit clear resets measurement', t => {
  const source = part();
  const { instance, state, attributes } = viewer(t, [source]);
  instance.setToothView(toothView(source, { tool: 'paint' }));
  assert.equal(instance.editing, true);
  instance.setRulerEnabled(true);
  assert.equal(instance.editing, false);
  assert.equal(instance.toothView.tool, 'inspect');
  assert.equal(state().enabled, true);
  assert.equal(instance.renderer.domElement.style.cursor, 'crosshair');
  assert.match(attributes.get('aria-label'), /scan scale/);
  measure(instance, [anchor(source), anchor(source, [2, 1, 0])]);
  instance.setRulerEnabled(false);
  assert.equal(state().enabled, false);
  assert.equal(state().distance, 1);
  instance.setRulerEnabled(true);
  instance.setToothView(toothView(source, { tool: 'paint' }));
  assert.equal(state().enabled, false, 'tooth editing stops ruler picking');
  assert.equal(state().distance, 1);
  instance.clearMeasurement();
  assert.deepEqual(state().points, []);
  assert.deepEqual(state().screenPoints, []);
  assert.equal(state().distance, null);
  assert.equal(state().cleared, false);
});

test('measurement formatting preserves small nonzero file-unit distances and large magnitudes', () => {
  for (const value of [0, 13, 0.0000123, 10000000]) {
    close(Number(formatMeasurement(value)), value);
  }
  assert.notEqual(Number(formatMeasurement(0.0000123)), 0);
});

test('ruler labels convert file distances to mm with the case scale, and fall back when scale is unset', () => {
  assert.equal(measurementLabel(13, 1), '13.000 mm');
  assert.equal(measurementLabel(13, 10), '130.000 mm');
  assert.equal(measurementLabel(0.013, 1000), '13.000 mm');
  assert.equal(measurementLabel(13, 0.1), '1.300 mm');
  assert.equal(measurementLabel(0, 10), '0.000 mm');
  for (const scale of [null, 0, -1, NaN, Infinity]) assert.equal(measurementLabel(13, scale), '13.000 file units');
});

test('edited lengths convert between file units and mm only through an explicit scan scale', () => {
  assert.equal(scanScale(25.4), 25.4);
  for (const scale of [null, undefined, 0, -1, NaN, Infinity]) {
    assert.equal(scanScale(scale), null);
    assert.equal(lengthToDisplay(1.9, scale), 1.9);
    assert.equal(lengthFromDisplay(1.9, scale), 1.9);
  }
  // Binary noise is trimmed in both directions (3 × 0.1 and 0.3 / 0.1).
  assert.equal(lengthToDisplay(3, 0.1), 0.3);
  assert.equal(lengthFromDisplay(0.3, 0.1), 3);
  assert.equal(lengthToDisplay(10, 25.4), 254);
  assert.equal(lengthFromDisplay(254, 25.4), 10);
  assert.equal(lengthToDisplay(1.9, 1), 1.9);
  // Displayed mm are rounded to micrometres; tiny nonzero values never read as 0.
  assert.equal(lengthToDisplay(6.874242715849283, 1), 6.874);
  assert.equal(lengthToDisplay(0.00043, 1), 0.00043);
  assert.equal(lengthToDisplay(0, 1), 0);
});
