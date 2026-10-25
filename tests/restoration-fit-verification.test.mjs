import test from 'node:test';
import assert from 'node:assert/strict';
import { createFitIntersectionQuery } from '../src/restoration-fit-intersections.ts';
import { verifyFitIntersections, MAX_VERIFIED_TARGET_FACES } from '../src/restoration-fit-verification.ts';

const complete = (source, target) => createFitIntersectionQuery(target, target.length / 9, () => {}).test(source);
const verify = async (...args) => {
  const result = await verifyFitIntersections(...args);
  if (!result) return result;
  const { verificationRetainedTriangles, ...measured } = result;
  assert.ok(Number.isSafeInteger(verificationRetainedTriangles) && verificationRetainedTriangles <= measured.intersectionTestedTriangles);
  return measured;
};
const transform = (values, scale, offset = [0, 0, 0]) => Float32Array.from(values, (value, i) => (value + offset[i % 3]) * scale);
function random(seed) {
  let state = seed >>> 0;
  return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
function soup(count, next, center, spread, size) {
  const out = new Float32Array(count * 9);
  for (let face = 0; face < count; face++) {
    const base = [0, 1, 2].map(axis => center[axis] + (next() - .5) * spread);
    for (let vertex = 0; vertex < 3; vertex++) for (let axis = 0; axis < 3; axis++) out[face * 9 + vertex * 3 + axis] = base[axis] + (next() - .5) * size;
  }
  return out;
}
const join = (...parts) => {
  const out = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};

test('matches the complete query for crossings, touches, misses and degenerate sources at any scale and pose', async () => {
  for (const scale of [1e-10, 1, 1e10]) for (const offset of [[0, 0, 0], [37, -12, 250]]) {
    const target = transform([-1, -1, 0, 1, -1, 0, 0, 1, 0], scale, offset);
    const cases = {
      crossed: transform([0, 0, -1, 0, 0, 1, 0, .5, 0], scale, offset),
      touched: target,
      missed: transform([-1, -1, .5, 1, -1, .5, 0, 1, .5], scale, offset),
      degenerate: transform([0, 0, 0, 0, 0, 0, 0, 0, 0], scale, offset),
      empty: new Float32Array(),
    };
    for (const [name, source] of Object.entries(cases)) {
      const verified = await verify(source, target);
      assert.deepEqual(verified, complete(source, target), `${name} at ${scale} ${offset}`);
    }
    assert.equal((await verify(cases.crossed, target)).transverseCrossingTriangles, 2);
    assert.equal((await verify(cases.touched, target)).touchingOrAmbiguousTriangles, 2);
    assert.equal((await verify(cases.missed, target)).intersectionComplete, true);
    assert.equal((await verify(cases.degenerate, target)).intersectionComplete, false);
    assert.equal((await verify(cases.empty, target)).intersectionComplete, true);
  }
});

test('matches the complete query at the tolerance boundary', async () => {
  const target = Float32Array.of(-1, -1, 0, 1, -1, 0, 0, 1, 0);
  const tolerance = complete(target, target).intersectionTolerance;
  const lifted = z => Float32Array.of(-1, -1, z, 1, -1, z, 0, 1, z);
  const inside = await verify(lifted(tolerance * .5), target);
  const outside = await verify(lifted(tolerance * 4), target);
  assert.equal(inside.intersectionTolerance, tolerance);
  assert.equal(inside.touchingOrAmbiguousTriangles, 2);
  assert.equal(outside.intersectingTriangles, 0);
  assert.deepEqual(inside, complete(lifted(tolerance * .5), target));
  assert.deepEqual(outside, complete(lifted(tolerance * 4), target));
});

test('matches the complete query on random scaled and translated soups without mutating inputs', async () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const next = random(seed), scale = [1e-6, 1, 1e6][seed % 3], offset = [seed * 101, -seed * 7, seed * 33];
    const target = transform(soup(400, next, [0, 0, 0], 10, 2), scale, offset);
    const source = transform(soup(60, next, [1, 0, 0], 4, 1.5), scale, offset);
    const [targetCopy, sourceCopy] = [target.slice(), source.slice()];
    const verified = await verify(source, target);
    assert.deepEqual(verified, complete(source, target), `seed ${seed}`);
    assert.ok(verified.intersectingTriangles > 0, `seed ${seed} exercises hits`);
    assert.deepEqual(target, targetCopy);
    assert.deepEqual(source, sourceCopy);
  }
});

test('filters many distant target triangles, yields every 8192 faces, and honours cancellation', async () => {
  const next = random(9);
  const far = soup(60_000, next, [500, 500, 500], 100, 1);
  const near = soup(50, next, [0, 0, 0], 3, 1);
  const target = join(far, near);
  const source = soup(30, next, [0, 0, 0], 3, 1);
  let yields = 0, checks = 0;
  const verified = await verify(source, target, { check: () => { checks++; }, yieldControl: async () => { yields++; } });
  assert.deepEqual(verified, complete(source, target));
  assert.equal(verified.intersectionComplete, true);
  assert.equal(verified.intersectionTestedTriangles, 60_050);
  assert.ok((await verifyFitIntersections(source, target)).verificationRetainedTriangles <= 50);
  assert.ok(yields >= 2 * Math.floor(60_049 / 8192), `yielded ${yields}`);
  assert.ok(checks >= yields);

  let calls = 0;
  await assert.rejects(verify(source, target, { check: () => { if (++calls === 4) throw new Error('cancelled'); } }), /cancelled/);
  let paused = 0;
  await assert.rejects(verify(source, target, {
    check: () => { if (paused === 2) throw new Error('cancelled'); },
    yieldControl: async () => { paused++; },
  }), /cancelled/);
  assert.equal(paused, 2);
});

test('returns null instead of sorting more than the retained-face limit', async () => {
  const next = random(11);
  const target = soup(MAX_VERIFIED_TARGET_FACES + 1, next, [0, 0, 5], 8, .1);
  const source = Float32Array.of(-5, -5, 0, 5, -5, 0, 0, 5, 10);
  assert.equal(await verify(source, target), null);
  // Distant extra faces do not count toward the limit.
  const filtered = join(target.subarray(0, 100 * 9), soup(MAX_VERIFIED_TARGET_FACES + 1, next, [1000, 0, 0], 8, .1));
  assert.deepEqual(await verify(source, filtered), complete(source, filtered));
});

test('keeps the pair cap and degenerate targets incomplete', async () => {
  const next = random(13);
  const patch = soup(600, next, [0, 0, 0], .2, 1);
  const capped = await verify(patch, patch);
  assert.equal(capped.intersectionComplete, false);
  assert.equal(capped.intersectionPairTests, 200_000);
  assert.deepEqual(capped, complete(patch, patch));

  const flat = Float32Array.of(0, 0, 0, 1, 1, 1, 2, 2, 2);
  const source = Float32Array.of(-1, -1, 0, 1, -1, 0, 0, 1, 0);
  const allDegenerate = await verify(source, flat);
  assert.deepEqual(allDegenerate, complete(source, flat));
  assert.equal(allDegenerate.intersectionComplete, false);
  assert.equal(allDegenerate.intersectionTestedTriangles, 0);
  const partly = join(source, flat);
  const mixed = await verify(source, partly);
  assert.deepEqual(mixed, complete(source, partly));
  assert.equal(mixed.intersectionComplete, false);
  assert.equal(mixed.touchingOrAmbiguousTriangles, 2);

  await assert.rejects(verify(source, new Float32Array()), /nonempty/);
  await assert.rejects(verify(source, Float32Array.of(NaN, 0, 0, 1, 0, 0, 0, 1, 0)), /finite/);
  await assert.rejects(verify(Float32Array.of(0, 0), flat), /complete triangles/);
});

test('checks cancellation on entry and exit even for tiny disjoint meshes', async () => {
  const target = Float32Array.of(-1, -1, 0, 1, -1, 0, 0, 1, 0);
  const source = Float32Array.of(9, 9, 9, 10, 9, 9, 9, 10, 9);
  let checks = 0;
  const measured = await verifyFitIntersections(source, target, { check: () => { checks++; } });
  assert.equal(measured.intersectionComplete, true);
  assert.equal(measured.verificationRetainedTriangles, 0);
  assert.ok(checks >= 2);
  await assert.rejects(verifyFitIntersections(source, target, { check: () => { throw new Error('cancelled'); } }), /cancelled/);
  let calls = 0;
  await assert.rejects(verifyFitIntersections(source, target, { check: () => { if (++calls === 2) throw new Error('late'); } }), /late/);
});

test('sampled query tolerance floor is validated and only ever widens the tolerance', () => {
  const target = Float32Array.of(-1, -1, 0, 1, -1, 0, 0, 1, 0);
  const base = createFitIntersectionQuery(target, 1, () => {}).test(target).intersectionTolerance;
  assert.equal(createFitIntersectionQuery(target, 1, () => {}, base / 2).test(target).intersectionTolerance, base);
  assert.equal(createFitIntersectionQuery(target, 1, () => {}, 1e-3).test(target).intersectionTolerance, 1e-3);
  for (const bad of [-1, NaN, Infinity]) assert.throws(() => createFitIntersectionQuery(target, 1, () => {}, bad), /minimum tolerance/);
});
