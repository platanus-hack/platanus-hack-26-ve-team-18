import test from 'node:test';
import assert from 'node:assert/strict';
import { CylinderGeometry, Euler, Matrix4, Quaternion, SphereGeometry, Vector3 } from 'three';
import { refineBiteAlignment } from '../src/bite-alignment.ts';
import { createNearestSurfaceQuery } from '../src/collision.ts';

function surface(z, sign = 1, flat = false) {
  const triangles = [], patches = [];
  const vertex = (x, y) => [x, y, z + (flat ? 0 : sign * (0.6 * Math.sin(x * 0.85) + 0.45 * Math.cos(y * 1.2) + 0.22 * Math.sin(x * 0.4 + y)))];
  for (let x = -6; x < 6 - 0.1; x += 0.4) for (let y = -4; y < 4 - 0.1; y += 0.4) {
    const a = vertex(x, y), b = vertex(x + 0.4, y), c = vertex(x + 0.4, y + 0.4), d = vertex(x, y + 0.4);
    const faces = [...a, ...b, ...c, ...a, ...c, ...d];
    triangles.push(...faces);
    // Two disjoint, asymmetric patches; most of the arch is absent from the bite scan.
    if ((x < -2 && y < 0.5 && y > -3.5) || (x > 1 && x < 4.6 && y > -0.5 && y < 3.1)) patches.push(...faces);
  }
  return { full: new Float64Array(triangles), partial: new Float64Array(patches) };
}

function transform(positions, matrix) {
  const output = positions.slice(), point = new Vector3();
  for (let i = 0; i < output.length; i += 3) point.fromArray(positions, i).applyMatrix4(matrix).toArray(output, i);
  return output;
}

function pose(center, euler, shift) {
  return new Matrix4().makeTranslation(...center).multiply(new Matrix4().makeRotationFromQuaternion(
    new Quaternion().setFromEuler(new Euler(...euler)),
  )).multiply(new Matrix4().makeTranslation(...center.map(x => -x))).premultiply(new Matrix4().makeTranslation(...shift));
}

function fixture({ aligned = false, scale = 1, origin = [0, 0, 0], flat = false } = {}) {
  const upper = surface(4, 1, flat), lower = surface(-4, -1, flat);
  const current = aligned ? [new Matrix4(), new Matrix4()] : [
    pose([0, 0, 4], [0.018, -0.022, 0.025], [0.12, -0.08, 0.16]),
    pose([0, 0, -4], [-0.024, 0.016, -0.021], [-0.11, 0.09, -0.13]),
  ];
  const world = new Matrix4().makeScale(scale, scale, scale).setPosition(...origin);
  const originals = [upper.full, lower.full].map(p => transform(p, world));
  const matrices = current.map(m => world.clone().multiply(m).multiply(world.clone().invert()));
  return {
    arches: originals.map((p, i) => ({ id: i ? 'lower' : 'upper', role: i ? 'lower' : 'upper', positions: transform(p, matrices[i]) })),
    // A single bite reference can contain patches of both arches.
    bites: [{ id: 'bite', positions: transform(new Float64Array([...upper.partial, ...lower.partial]), world) }],
    maxDistance: 0.8 * scale,
    originals,
    expected: matrices.map(m => m.clone().invert()),
  };
}

function maxPointError(positions, expected, actual) {
  const a = new Vector3(), b = new Vector3();
  let worst = 0;
  for (let i = 0; i < positions.length; i += 9) {
    a.fromArray(positions, i); b.copy(a);
    worst = Math.max(worst, a.applyMatrix4(actual).distanceTo(b.applyMatrix4(expected)));
  }
  return worst;
}

test('local refinement recovers independent modest rigid deltas from partial fixed bite patches', () => {
  const input = fixture(), sourceCopies = [...input.arches, ...input.bites].map(m => m.positions.slice());
  const result = refineBiteAlignment(input);
  assert.deepEqual(result.arches.map(a => a.id), ['upper', 'lower']);
  assert.ok(Number.isFinite(result.durationMs) && result.durationMs >= 0);
  for (let i = 0; i < result.arches.length; i++) {
    const arch = result.arches[i], matrix = new Matrix4().fromArray(arch.matrix);
    assert.equal(arch.matrix.length, 16);
    assert.ok(arch.samples >= 40 && arch.samples <= 3200);
    assert.ok(arch.beforeRms > 0.03);
    assert.ok(arch.afterRms < arch.beforeRms * 0.02, `${arch.id}: ${arch.beforeRms} -> ${arch.afterRms}`);
    assert.equal(arch.references.length, 1);
    assert.equal(arch.references[0].id, 'bite');
    assert.equal(arch.references[0].samples, arch.samples);
    assert.equal(arch.references[0].beforeRms, arch.beforeRms);
    assert.equal(arch.references[0].afterRms, arch.afterRms);
    assert.ok(arch.references[0].beforeCoverage >= 0.95);
    assert.ok(arch.references[0].afterCoverage >= 0.95);
    assert.ok(Math.abs(matrix.determinant() - 1) < 1e-10);
    assert.ok(maxPointError(input.arches[i].positions, input.expected[i], matrix) < 0.002);
  }
  [...input.arches, ...input.bites].forEach((m, i) => assert.deepEqual(m.positions, sourceCopies[i]));
});

test('adequately constrained already-aligned scans return identity without moving the bite', () => {
  const input = fixture({ aligned: true }), bite = input.bites[0].positions.slice();
  const result = refineBiteAlignment(input);
  for (const arch of result.arches) {
    assert.deepEqual(arch.matrix, new Matrix4().toArray());
    assert.ok(arch.beforeRms < 1e-10);
    assert.equal(arch.beforeRms, arch.afterRms);
  }
  assert.deepEqual(input.bites[0].positions, bite);
});

test('file scaling and a large shared origin preserve the local world-space delta', () => {
  for (const scale of [0.001, 100]) {
    const input = fixture({ scale, origin: [1e6 * scale, -2e6 * scale, 3e6 * scale] });
    const result = refineBiteAlignment(input);
    for (let i = 0; i < result.arches.length; i++) {
      const arch = result.arches[i], matrix = new Matrix4().fromArray(arch.matrix);
      assert.ok(arch.afterRms / scale < 0.002);
      assert.ok(maxPointError(input.arches[i].positions, input.expected[i], matrix) / scale < 0.004);
    }
  }
});

test('far-away bite geometry and missing coverage of either arch reject atomically', () => {
  const far = fixture();
  far.bites[0].positions = transform(far.bites[0].positions, new Matrix4().makeTranslation(100, 0, 0));
  assert.throws(() => refineBiteAlignment(far), /insufficient nearby.*move both arches/i);
  const one = fixture();
  one.bites[0].positions = surface(4).partial;
  const copies = one.arches.map(a => a.positions.slice());
  assert.throws(() => refineBiteAlignment(one), /lower arch: insufficient nearby/i);
  one.arches.forEach((a, i) => assert.deepEqual(a.positions, copies[i]));
  // The first arch can refine successfully while the second fails its support gate.
  const laterFailure = fixture(), flatLower = surface(-4, -1, true);
  laterFailure.arches[1].positions = flatLower.full;
  laterFailure.bites[0].positions = new Float64Array([...surface(4).partial, ...flatLower.partial]);
  const originalUpper = laterFailure.arches[0].positions.slice();
  assert.throws(() => refineBiteAlignment(laterFailure), /lower arch:.*support/);
  assert.deepEqual(laterFailure.arches[0].positions, originalUpper);
});

test('flat support, tiny concentrated patches, and ambiguous ownership fail safely', () => {
  assert.throws(() => refineBiteAlignment(fixture({ flat: true, aligned: true })), /support|flat|degenerate/);
  const small = fixture({ aligned: true });
  small.bites[0].positions = new Float64Array([
    0, 0, 4, 0.01, 0, 4, 0, 0.01, 4,
    0, 0, -4, 0.01, 0, -4, 0, 0.01, -4,
  ]);
  assert.throws(() => refineBiteAlignment(small), /support/);
  const ambiguous = fixture({ aligned: true });
  ambiguous.arches[1].positions = ambiguous.arches[0].positions.slice();
  ambiguous.bites[0].positions = surface(4).partial;
  assert.throws(() => refineBiteAlignment(ambiguous), /unambiguous/);
});

test('bounded refinement rejects an implausible shift even with a large capture radius', () => {
  const input = fixture({ aligned: true });
  for (const arch of input.arches) arch.positions = transform(arch.positions, new Matrix4().makeTranslation(3, 0, 0));
  input.maxDistance = 4;
  assert.throws(() => refineBiteAlignment(input), /local|improvement|residual|converge/);
});

test('trimmed surface registration tolerates a minority of unmatched bite fragments', () => {
  const input = fixture();
  const upper = surface(4).partial, lower = surface(-4, -1).partial;
  const fragment = (p, offset) => transform(p.slice(0, Math.floor(p.length * 0.13 / 9) * 9), new Matrix4().makeTranslation(0, 0, offset));
  input.bites[0].positions = new Float64Array([...input.bites[0].positions, ...fragment(upper, 0.55), ...fragment(lower, -0.55)]);
  const result = refineBiteAlignment(input);
  for (let i = 0; i < result.arches.length; i++) {
    const delta = new Matrix4().fromArray(result.arches[i].matrix);
    assert.ok(result.arches[i].afterRms < result.arches[i].beforeRms);
    // Validation includes the outliers excluded from fitting: its raw RMS stays honest.
    assert.ok(result.arches[i].references[0].afterRms > 0.1);
    assert.ok(maxPointError(input.arches[i].positions, input.expected[i], delta) < 0.02);
  }
});

test('backtracking preserves frozen per-capture RMS when trimmed fitting excludes unmatched fragments', () => {
  const input = fixture({ aligned: true });
  for (const arch of input.arches) arch.positions = transform(arch.positions, new Matrix4().makeTranslation(0, 0, -0.08));
  input.bites.push({ id: 'clean-capture', positions: input.bites[0].positions.slice() });
  const fragment = positions => transform(
    positions.slice(0, Math.floor(positions.length * 0.13 / 9) * 9), new Matrix4().makeTranslation(0, 0, -0.55),
  );
  // Both captures share the main patches. A minority of unmatched fragments
  // makes the full trimmed-fit step regress the first capture's raw RMS.
  input.bites[0].positions = new Float64Array([
    ...input.bites[0].positions, ...fragment(surface(4).partial), ...fragment(surface(-4, -1).partial),
  ]);
  const copies = [...input.arches, ...input.bites].map(mesh => mesh.positions.slice());
  const result = refineBiteAlignment(input);
  for (const [i, arch] of result.arches.entries()) {
    assert.ok(arch.afterRms < arch.beforeRms * 0.95, `${arch.id}: ${arch.beforeRms} → ${arch.afterRms}`);
    assert.deepEqual(arch.references.map(reference => reference.id), ['bite', 'clean-capture']);
    assert.equal(arch.samples, i ? 1599 : 1601);
    assert.deepEqual(arch.references.map(reference => reference.samples), [i ? 799 : 801, 800]);
    for (const reference of arch.references) {
      assert.ok(reference.afterRms <= reference.beforeRms * 1.02, `${arch.id}/${reference.id}: ${reference.beforeRms} → ${reference.afterRms}`);
      assert.equal(reference.afterCoverage, 1);
    }
    assert.ok(arch.references[0].afterRms > 0.16, 'raw RMS must include unmatched fragments');
    assert.ok(arch.references[1].afterRms < arch.references[1].beforeRms * 0.4);
    // A feasible intermediate pose is preferable to the full robust-fit step.
    const shift = new Vector3().fromArray(input.arches[i].positions).applyMatrix4(new Matrix4().fromArray(arch.matrix)).z - input.arches[i].positions[2];
    assert.ok(shift > 0.02 && shift < 0.075, `accepted shift: ${shift}`);
  }
  [...input.arches, ...input.bites].forEach((mesh, i) => assert.deepEqual(mesh.positions, copies[i]));
});

test('contradictory bite captures cannot improve a pooled residual by sacrificing either reference', () => {
  const input = fixture({ aligned: true });
  input.bites.push({ id: 'contradictory', positions: transform(input.bites[0].positions, new Matrix4().makeTranslation(0, 0, 0.24)) });
  // Both captures have usable support and are individually solvable.
  for (const bite of input.bites) assert.equal(refineBiteAlignment({ ...input, bites: [bite] }).arches.length, 2);
  const copies = [...input.arches, ...input.bites].map(mesh => mesh.positions.slice());
  assert.throws(() => refineBiteAlignment(input), /reference "bite" worsened.*in a rejected step.*captures may conflict/);
  [...input.arches, ...input.bites].forEach((mesh, i) => assert.deepEqual(mesh.positions, copies[i]));
});

test('unequal reference areas receive balanced coverage and preserve the smaller capture', () => {
  const sparsePatches = positions => {
    const output = [];
    for (let i = 0; i < positions.length; i += 9 * 8) output.push(...positions.slice(i, i + 9));
    return output;
  };
  const sparse = new Float64Array([...sparsePatches(surface(4).partial), ...sparsePatches(surface(-4, -1).partial)]);
  const input = fixture();
  input.bites.push({ id: 'small-capture', positions: sparse });
  const result = refineBiteAlignment(input);
  const totals = new Map();
  for (const [i, arch] of result.arches.entries()) {
    assert.deepEqual(arch.references.map(reference => reference.id), ['bite', 'small-capture']);
    assert.ok(maxPointError(input.arches[i].positions, input.expected[i], new Matrix4().fromArray(arch.matrix)) < 0.002);
    for (const reference of arch.references) {
      assert.ok(reference.samples >= 40);
      assert.ok(reference.afterRms < reference.beforeRms * 0.02);
      assert.ok(reference.afterCoverage >= 0.95);
      totals.set(reference.id, (totals.get(reference.id) ?? 0) + reference.samples);
    }
  }
  assert.equal(totals.get('bite'), 1600);
  assert.equal(totals.get('small-capture'), 1600);

  const conflict = fixture({ aligned: true });
  conflict.bites[0].positions = transform(conflict.bites[0].positions, new Matrix4().makeTranslation(0, 0, 0.24));
  conflict.bites.push({ id: 'small-capture', positions: sparse });
  for (const bites of [conflict.bites, conflict.bites.toReversed()]) {
    assert.throws(() => refineBiteAlignment({ ...conflict, bites }), /reference "small-capture" worsened/);
  }
});

test('every assigned reference must support both arches, including additional unusable scans', () => {
  const input = fixture();
  input.bites.push({ id: 'upper-only', positions: surface(4).partial });
  assert.throws(() => refineBiteAlignment(input), /lower arch:.*reference "upper-only".*both arches/);
  input.bites[1] = { id: 'far-reference', positions: transform(input.bites[0].positions, new Matrix4().makeTranslation(100, 0, 0)) };
  assert.throws(() => refineBiteAlignment(input), /reference "far-reference".*remove the unusable reference/);
  input.bites = [{ id: 'upper-only', positions: surface(4).partial }, { id: 'lower-only', positions: surface(-4, -1).partial }];
  assert.throws(() => refineBiteAlignment(input), /upper arch:.*reference "lower-only".*both arches/);
});

test('surface observability rejects unconstrained spherical and cylindrical patches', () => {
  for (const geometry of [new SphereGeometry(2, 128, 96), new CylinderGeometry(2, 2, 6, 64, 8, true)]) {
    const flat = geometry.toNonIndexed();
    const positions = new Float64Array(flat.getAttribute('position').array);
    const upper = transform(positions, new Matrix4().makeTranslation(0, 0, 5));
    const lower = transform(positions, new Matrix4().makeTranslation(0, 0, -5));
    flat.dispose(); geometry.dispose();
    const input = {
      arches: [{ id: 'upper', role: 'upper', positions: upper }, { id: 'lower', role: 'lower', positions: lower }],
      bites: [{ id: 'bite', positions: new Float64Array([...upper, ...lower]) }], maxDistance: 0.3,
    };
    assert.throws(() => refineBiteAlignment(input), /stable rigid pose|weak surface support/);
  }
});

test('a bounded wall-clock budget fails atomically with a useful reason', t => {
  let now = 0;
  t.mock.method(performance, 'now', () => { now += 1000; return now; });
  assert.throws(() => refineBiteAlignment(fixture()), /time budget/);
});

test('invalid requests reject with useful errors', () => {
  assert.throws(() => refineBiteAlignment({ ...fixture(), maxDistance: 0 }), /positive/);
  assert.throws(() => refineBiteAlignment({ ...fixture(), maxDistance: NaN }), /finite/);
  assert.throws(() => refineBiteAlignment({ ...fixture(), arches: [] }), /upper arch and one lower/);
  assert.throws(() => refineBiteAlignment({ ...fixture(), bites: [] }), /reference/);
  const invalid = fixture();
  invalid.arches[0].positions[0] = Infinity;
  assert.throws(() => refineBiteAlignment(invalid), /finite/);
  const wrongType = fixture();
  wrongType.arches[0].positions = new Float32Array(wrongType.arches[0].positions);
  assert.throws(() => refineBiteAlignment(wrongType), /Float64/);
});

test('reusable nearest-surface query preserves the winning point, interior matches, and degenerate faces', () => {
  const surface = createNearestSurfaceQuery(new Float64Array([
    -5, -5, 0, 5, -5, 0, 0, 5, 0,
    100, 0, 0, 101, 0, 0, 102, 0, 0,
  ]));
  const target = new Vector3(), normal = new Vector3();
  assert.equal(surface.nearestPoint(new Vector3(0, 0, 2), target, normal), 2);
  assert.deepEqual(target.toArray(), [0, 0, 0]);
  assert.equal(Math.abs(normal.z), 1);
  assert.equal(surface.nearestPoint(new Vector3(0, 0, 2), target, normal, 1), Infinity);
  assert.equal(surface.nearestPoint(new Vector3(101.5, 1, 0), target, normal), 1);
  assert.deepEqual(target.toArray(), [101.5, 0, 0]);
});

test('worker responds with the request ID, atomic deltas, and recoverable errors', async () => {
  const originalPost = globalThis.postMessage, originalHandler = globalThis.onmessage;
  let response;
  globalThis.postMessage = message => { response = structuredClone(message); };
  try {
    await import('../src/bite-alignment.worker.ts');
    const input = fixture({ aligned: true });
    globalThis.onmessage({ data: { id: 17, ...input } });
    assert.equal(response.id, 17);
    assert.equal(response.result.arches.length, 2);
    assert.ok(input.arches.every(a => a.positions.byteLength > 0));
    globalThis.onmessage({ data: { id: 18, ...input, maxDistance: -1 } });
    assert.equal(response.id, 18);
    assert.match(response.error, /positive/);
    assert.equal(response.result, undefined);
    globalThis.onmessage({ data: { id: 19, ...input } });
    assert.equal(response.id, 19);
    assert.equal(response.result.arches.length, 2);
  } finally {
    if (originalPost === undefined) delete globalThis.postMessage; else globalThis.postMessage = originalPost;
    if (originalHandler === undefined) delete globalThis.onmessage; else globalThis.onmessage = originalHandler;
  }
});
