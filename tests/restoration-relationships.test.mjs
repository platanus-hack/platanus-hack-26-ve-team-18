import test from 'node:test';
import assert from 'node:assert/strict';
import { measureRestorationRelationships, RestorationRelationshipsCancelled } from '../src/restoration-relationships.ts';
import { generateRestoration } from '../src/restoration-geometry.ts';
import { createFitIntersectionQuery } from '../src/restoration-fit-intersections.ts';
import { MAX_VERIFIED_TARGET_FACES } from '../src/restoration-fit-verification.ts';
import { restorationRelationshipsSchema } from '../src/restoration-relationships-schema.ts';

const spec = () => ({ version: 'implant-assembly/v1', fdi: 36, parentPartId: 'synthetic',
  frame: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], up: [0, 0, 1] },
  parameters: { fixture: { radius: 1.1, length: 5, depth: .4, taper: .3 },
    abutment: { radius: .8, height: 2.1, emergenceRadius: 1.3, angleX: 0, angleY: 0 },
    crown: { width: 5.2, depth: 4.6, height: 3.5, cuspHeight: 1.1, rotation: 0 } },
  anatomy: 'molar', provenance: 'hypothesized', units: 'file units (u)', source: 'Synthetic relationship tests; no patient data' });
const face = (z = 0, x = 0) => Float32Array.of(x - 1, -1, z, x + 1, -1, z, x, 1, z);
const mesh = (component, positions) => ({ component, positions, normals: new Float32Array(positions.length),
  triangles: positions.length / 9, vertices: positions.length / 3, closed: false, dimensions: [2, 2, 0] });
const join = (...positions) => {
  const result = new Float32Array(positions.reduce((sum, array) => sum + array.length, 0));
  let offset = 0;
  for (const array of positions) { result.set(array, offset); offset += array.length; }
  return result;
};
const repeated = (positions, count) => {
  const result = new Float32Array(positions.length * count);
  for (let i = 0; i < count; i++) result.set(positions, positions.length * i);
  return result;
};
const input = (fixture = face(1), abutment = face(0), crown = face(3), surfaces = []) => ({
  spec: spec(), components: [mesh('fixture', fixture), mesh('abutment', abutment), mesh('crown', crown)], surfaces,
  options: { maxDurationMs: 10_000 },
});
const fastControl = { yieldControl: async () => {} };
const measure = value => measureRestorationRelationships(value, fastControl);
const pair = (report, id = 'fixture-to-abutment') => report.relationships.find(row => row.id === id);
const close = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);

test('reports directional triangle-barycentre min/median/p95 and every requested component/adjacent pair', async () => {
  const source = join(...Array.from({ length: 20 }, (_, index) => face(index + 1)));
  const value = input(source, face(), face(30), [
    { id: 'scanned-left', role: 'adjacent', side: 'mesial', positions: face(-2) },
    { id: 'scanned-right', role: 'adjacent', side: 'distal', positions: face(-4) },
    { id: 'opposing', role: 'antagonist', positions: face(50) },
  ]);
  const before = structuredClone(value), report = await measure(value), row = pair(report);
  assert.deepEqual(value, before);
  assert.equal(report.termination, 'complete');
  assert.equal(report.relationships.length, 7);
  assert.equal(report.units, 'file units (u)');
  assert.equal(row.status, 'measured');
  assert.equal(row.samples, 20);
  close(row.sampledMinDistance, 1); close(row.sampledMedianDistance, 10); close(row.sampledP95Distance, 19);
  assert.equal(row.intersectionComplete, true);
  assert.equal(row.surfaceEvidence, 'none-observed');
  assert.equal(row.intersectingTriangles, 0);
  close(pair(report, 'fixture-to-adjacent:scanned-left').sampledMinDistance, 3);
  close(pair(report, 'abutment-to-adjacent:scanned-right').sampledMinDistance, 4);
  assert.equal(pair(report, 'fixture-to-adjacent:scanned-left').side, 'mesial');
  assert.equal(report.sampling.requestedPerRelationship, 128);
  assert.equal(report.sampling.fullResolutionDistanceTargets, true);
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  assert.match(report.limits.join(' '), /upper bound.*not contact area.*root clearance/s);
});

test('subsamples only the source and keeps every full target face across BVH blocks', async () => {
  const target = join(repeated(face(100), 4096), face());
  const value = input(join(face(1), face(2), face(3), face(4)), target);
  value.options.samplesPerRelationship = 2;
  let yields = 0;
  const report = await measureRestorationRelationships(value, { yieldControl: async () => { yields++; } });
  const row = pair(report);
  assert.equal(row.samples, 2);
  close(row.sampledMinDistance, 2); close(row.sampledP95Distance, 2);
  assert.equal(row.targetTriangles, 4097);
  assert.equal(row.intersectionComplete, true);
  assert.equal(row.intersectionTestedTriangles, 4097);
  assert.ok(yields > 10, 'Preparation and measurement yield across bounded face/query blocks.');
});

test('crossing and coplanar contact evidence remain distinct from positive sampled distance', async () => {
  const crossing = Float32Array.of(0, 0, -1, 0, 0, 1, 0, .5, 0);
  const crossed = pair(await measure(input(face(), crossing)));
  assert.ok(crossed.sampledMinDistance > .3);
  assert.equal(crossed.surfaceEvidence, 'transverse-crossing');
  assert.equal(crossed.transverseCrossingTriangles, 2);
  assert.equal(crossed.intersectionComplete, true);
  const touching = pair(await measure(input(face(), face())));
  assert.equal(touching.surfaceEvidence, 'touching-or-ambiguous');
  assert.equal(touching.transverseCrossingTriangles, 0);
  assert.equal(touching.touchingOrAmbiguousTriangles, 2);
  close(touching.sampledMinDistance, 0);
});

test('affected-face counts match the existing audit without counting source faces twice', async () => {
  const source = face(), target = join(face(), face(0, .1), Float32Array.of(0, 0, -1, 0, 0, 1, 0, .5, 0));
  const actual = pair(await measure(input(source, target)));
  const expected = createFitIntersectionQuery(target, 3, () => {}, actual.intersectionTolerance).test(source);
  for (const [key, value] of Object.entries(expected)) assert.equal(actual[key], value, key);
  assert.equal(actual.intersectingTriangles, 4);
  assert.ok(actual.transverseCrossingTriangles + actual.touchingOrAmbiguousTriangles > actual.intersectingTriangles,
    'One face can participate in both categories.');
});

test('missing, empty, malformed, nonfinite and oversized geometry stays explicit and JSON safe', async () => {
  const missing = await measure({ spec: spec(), components: [], surfaces: [] });
  assert.equal(missing.relationships.length, 3);
  assert.ok(missing.relationships.every(row => row.status === 'unknown' && row.sampledMinDistance === null && row.intersectingTriangles === null));
  assert.ok(missing.interfaces.every(row => row.status === 'unknown' && row.signedAxialGap === null));
  assert.match(missing.limits.join(' '), /No adjacent scanned targets/);
  for (const positions of [new Float32Array(), Float32Array.of(1, 2), Float32Array.of(NaN, 0, 0, 1, 0, 0, 0, 1, 0)]) {
    const report = await measure(input(face(), positions));
    const row = pair(report);
    assert.equal(row.status, 'unknown'); assert.equal(row.samples, 0);
    assert.equal(row.sampledMinDistance, null); assert.equal(row.intersectionComplete, false);
    assert.equal(row.surfaceEvidence, 'unknown'); assert.equal(row.intersectingTriangles, null);
    assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  }
  const oversized = input(face(), join(face(), face(1)));
  oversized.options.maxMeshTriangles = 1;
  assert.equal(pair(await measure(oversized)).reason, 'target:mesh-triangle-budget');
});

test('degenerate source faces cannot fabricate samples or complete intersection evidence', async () => {
  const degenerate = new Float32Array(9), source = join(face(1), degenerate);
  const partial = pair(await measure(input(source)));
  assert.equal(partial.samples, 1); close(partial.sampledMinDistance, 1);
  assert.equal(partial.intersectionComplete, false); assert.equal(partial.surfaceEvidence, 'unknown');
  const all = pair(await measure(input(degenerate)));
  assert.equal(all.status, 'unknown'); assert.equal(all.samples, 0); assert.equal(all.sampledMinDistance, null);
  assert.equal(all.intersectionComplete, false); assert.equal(all.surfaceEvidence, 'unknown');
  const degenerateTarget = pair(await measure(input(face(1), degenerate)));
  assert.equal(degenerateTarget.status, 'measured');
  assert.equal(degenerateTarget.intersectionComplete, false);
  assert.deepEqual(JSON.parse(JSON.stringify(degenerateTarget)), degenerateTarget);
});

test('retained-target and pair caps preserve distance evidence without claiming completeness', async () => {
  const retained = pair(await measure(input(face(), repeated(face(), MAX_VERIFIED_TARGET_FACES + 1))));
  assert.equal(retained.status, 'measured'); close(retained.sampledMinDistance, 0);
  assert.equal(retained.intersectionComplete, false); assert.equal(retained.surfaceEvidence, 'unknown');
  assert.equal(retained.intersectingTriangles, null);
  assert.equal(retained.intersectionReason, 'retained-target-triangle-budget');
  const sourceCapped = pair(await measure(input(repeated(face(), MAX_VERIFIED_TARGET_FACES + 1), face())));
  assert.equal(sourceCapped.status, 'measured');
  assert.equal(sourceCapped.intersectionComplete, false); assert.equal(sourceCapped.surfaceEvidence, 'unknown');
  assert.equal(sourceCapped.intersectionReason, 'source-triangle-budget');
  const dense = repeated(face(), 450), capped = pair(await measure(input(dense, dense)));
  assert.equal(capped.intersectionPairTests, 200_000);
  assert.equal(capped.intersectionComplete, false);
  assert.equal(capped.surfaceEvidence, 'touching-or-ambiguous');
  assert.ok(capped.touchingOrAmbiguousTriangles > 0);
});

test('nominal interface measurements expose moved meshes and do not imply lateral overlap', async () => {
  const value = spec();
  value.parameters.abutment.angleX = 13; value.parameters.abutment.angleY = -19;
  value.frame = { origin: [100, -20, 30], u: [0, 1, 0], v: [0, 0, 1], up: [1, 0, 0] };
  const components = generateRestoration(value);
  const report = await measure({ spec: value, components, surfaces: [], options: { samplesPerRelationship: 8, maxDurationMs: 10_000 } });
  for (const item of report.interfaces) {
    assert.equal(item.status, 'measured');
    const enclosed = item.id === 'crown-base';
    close(item.sourceAxialOffset, enclosed ? value.parameters.abutment.height + value.parameters.abutment.emergenceRadius * .5 : 0, 1e-5);
    close(item.targetAxialOffset, 0, 1e-5);
    close(item.signedAxialGap, enclosed ? -value.parameters.abutment.height - value.parameters.abutment.emergenceRadius * .5 : 0, 1e-5);
    assert.ok(Number.isFinite(item.sourceDistanceToNominalOrigin));
    close(item.targetDistanceToNominalOrigin, 0, 1e-5);
  }
  const moved = structuredClone(components);
  // Move only crown along up, retaining the original nominal spec.
  for (let i = 0; i < moved[2].positions.length; i += 3) moved[2].positions[i] += 2;
  const displaced = await measure({ spec: value, components: moved, surfaces: [], options: { samplesPerRelationship: 8, maxDurationMs: 10_000 } });
  close(displaced.interfaces[1].signedAxialGap, 2 - value.parameters.abutment.height - value.parameters.abutment.emergenceRadius * .5, 1e-5);
  close(displaced.interfaces[1].targetDistanceToNominalOrigin, 2, 1e-5);
  assert.deepEqual(displaced.interfaces[1].nominalOrigin, report.interfaces[1].nominalOrigin);

  const lateral = input(face(-.4), face(-.4, 10));
  const item = (await measure(lateral)).interfaces[0];
  close(item.signedAxialGap, 0);
  assert.ok(item.targetDistanceToNominalOrigin > 9);
  assert.match(report.limits.join(' '), /do not establish lateral footprint overlap/);
});

test('zero-depth unequal radii retain nominal continuity without a compatible interface claim', async () => {
  const value = spec(); value.parameters.fixture.depth = 0;
  const report = await measure({ spec: value, components: generateRestoration(value), surfaces: [],
    options: { samplesPerRelationship: 8, maxDurationMs: 10_000 } });
  close(report.interfaces[0].signedAxialGap, 0);
  assert.notEqual(value.parameters.fixture.radius, value.parameters.abutment.emergenceRadius);
  assert.match(report.limits.join(' '), /connection compatibility/);
});

test('relationship reports measure visible unsupported pilar vertices and preserve legacy schema compatibility', async () => {
  const value = spec(); value.parameters.fixture.depth = 2;
  const gum = { id: 'gum', role: 'tissue', positions: Float32Array.of(-4, -4, -2, 4, -4, -2, 4, 4, -2, -4, -4, -2, 4, 4, -2, -4, 4, -2) };
  const report = await measure({ spec: value, components: generateRestoration(value), surfaces: [gum],
    options: { samplesPerRelationship: 8, maxDurationMs: 10_000 } });
  assert.equal(report.termination, 'complete');
  assert.equal(report.abutmentGingiva.status, 'fail'); assert.ok(report.abutmentGingiva.unsupportedSamples > 0);
  assert.equal(restorationRelationshipsSchema.safeParse(report).success, true);
  const legacy = structuredClone(report); delete legacy.abutmentGingiva;
  assert.equal(restorationRelationshipsSchema.safeParse(legacy).success, true);
});

test('time budget returns completed rows and explicit unknowns, never partially measured statistics', async () => {
  const value = input(); value.options.maxDurationMs = 200;
  let yields = 0;
  const report = await measureRestorationRelationships(value, { yieldControl: async () => {
    if (++yields === 4) await new Promise(resolve => setTimeout(resolve, 220));
  } });
  assert.equal(report.termination, 'time-budget');
  assert.equal(report.abutmentGingiva.status, 'unknown');
  assert.equal(report.abutmentGingiva.samples, 0);
  assert.equal(report.abutmentGingiva.maxUnsupportedExposure, null);
  assert.equal(restorationRelationshipsSchema.safeParse(report).success, true);
  assert.equal(report.sampling.maxDurationMs, 200);
  assert.equal(pair(report).status, 'measured'); close(pair(report).sampledMinDistance, 1);
  assert.equal(pair(report).intersectionComplete, false);
  assert.equal(pair(report).intersectionReason, 'time-budget');
  const unfinished = pair(report, 'abutment-to-crown');
  assert.equal(unfinished.reason, 'time-budget'); assert.equal(unfinished.samples, 0);
  assert.equal(unfinished.sampledMinDistance, null);
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
});

test('cancellation rejects on entry, during yielded preparation and after the last audit', async () => {
  await assert.rejects(measureRestorationRelationships(input(), { checkCancelled: () => true }), RestorationRelationshipsCancelled);
  const large = input(face(), repeated(face(20), 4097)), before = structuredClone(large);
  let yields = 0;
  await assert.rejects(measureRestorationRelationships(large, {
    checkCancelled: () => yields >= 4, yieldControl: async () => { yields++; },
  }), RestorationRelationshipsCancelled);
  assert.equal(yields, 4); assert.deepEqual(large, before);
  let totalYields = 0;
  await measureRestorationRelationships(input(), { yieldControl: async () => { totalYields++; } });
  let lastYields = 0;
  await assert.rejects(measureRestorationRelationships(input(), {
    checkCancelled: () => lastYields === totalYields, yieldControl: async () => { lastYields++; },
  }), RestorationRelationshipsCancelled);
});

test('invalid budgets and duplicate target/component identities fail explicitly', async () => {
  for (const options of [{ samplesPerRelationship: 0 }, { maxDurationMs: Infinity }, { maxMeshTriangles: NaN }]) {
    await assert.rejects(measure({ ...input(), options }), /budget must be an integer/);
  }
  const value = input(); value.components[1] = value.components[0];
  await assert.rejects(measure(value), /unique/);
  const target = { id: 'same', role: 'adjacent', positions: face() };
  await assert.rejects(measure(input(face(), face(), face(), [target, target])), /unique/);
});

test('Float32-rounded platform caps stay touching and crown enclosure stays explicit across rigid poses and scales', async () => {
  const frames = [spec().frame,
    { origin: [22.4, -3.7, 5.9], u: [2/3, 2/3, -1/3], v: [-1/3, 2/3, 2/3], up: [2/3, -1/3, 2/3] },
    { origin: [-39.3, 100.2, -70.4], u: [-1/3, 2/3, 2/3], v: [2/3, -1/3, 2/3], up: [2/3, 2/3, -1/3] }];
  for (const frame of frames) for (const depth of [0, .4]) {
    let referenceTolerances;
    for (const scale of [1, 2 ** -20, 2 ** 20]) {
      const value = spec(); value.frame = { ...frame, origin: frame.origin.map(x => x * scale) };
      value.parameters.fixture.depth = depth;
      value.parameters.abutment.angleX = 13; value.parameters.abutment.angleY = -19;
      for (const [kind, keys] of Object.entries({ fixture: ['radius', 'length', 'depth'], abutment: ['radius', 'height', 'emergenceRadius'], crown: ['width', 'depth', 'height', 'cuspHeight'] })) {
        for (const key of keys) value.parameters[kind][key] *= scale;
      }
      const report = await measure({ spec: value, components: generateRestoration(value), surfaces: [],
        options: { samplesPerRelationship: 8, maxDurationMs: 10_000 } });
      const rows = report.relationships.slice(0, 1);
      assert.equal(report.interfaces[1].status, 'measured');
      close(report.interfaces[1].signedAxialGap / scale, -(value.parameters.abutment.height + value.parameters.abutment.emergenceRadius * .5) / scale, 1e-4);
      assert.ok(['transverse-crossing', 'touching-or-ambiguous', 'none-observed'].includes(report.relationships[1].surfaceEvidence));
      for (const row of rows) {
        assert.equal(row.intersectionComplete, true);
        assert.equal(row.surfaceEvidence, 'touching-or-ambiguous', `${row.id}, depth ${depth}, scale ${scale}, origin ${frame.origin}`);
        assert.equal(row.transverseCrossingTriangles, 0);
        assert.ok(row.touchingOrAmbiguousTriangles > 0);
      }
      if (scale === 1) referenceTolerances = rows.map(row => row.intersectionTolerance);
      rows.forEach((row, index) => assert.ok(Math.abs(row.intersectionTolerance / scale - referenceTolerances[index]) < referenceTolerances[index] * 1e-12,
        'Numeric tolerance scales with actual coordinates; no 1-unit minimum.'));
      assert.match(report.limits.join(' '), /Float32 rounding.*numeric, not clinical.*measured vertex extrema/s);
    }
  }
});

test('component halfspace evidence corrects rim tangencies but preserves genuine overlap and distinct-face counts', async () => {
  const value = spec(), components = generateRestoration(value);
  const options = { samplesPerRelationship: 8, maxDurationMs: 10_000 };
  const touching = pair(await measure({ spec: value, components, surfaces: [], options }));
  const raw = createFitIntersectionQuery(components[1].positions, components[1].triangles, () => {}, touching.intersectionTolerance).test(components[0].positions);
  assert.ok(raw.transverseCrossingTriangles > 0, 'The legacy plane-straddling test alone labels shared-rim tangency transverse.');
  assert.equal(touching.intersectingTriangles, raw.intersectingTriangles);
  assert.equal(touching.touchingOrAmbiguousTriangles, raw.intersectingTriangles);
  assert.equal(touching.transverseCrossingTriangles, 0);
  assert.equal(touching.intersectionReason, 'opposite-axial-halfspaces-within-numeric-tolerance');

  const moved = structuredClone(components), overlap = .01;
  for (let i = 2; i < moved[1].positions.length; i += 3) moved[1].positions[i] -= overlap;
  const crossedReport = await measure({ spec: value, components: moved, surfaces: [], options });
  const crossed = pair(crossedReport);
  assert.ok(overlap > 100 * crossed.intersectionTolerance);
  assert.ok(crossedReport.interfaces[0].signedAxialGap < -crossed.intersectionTolerance);
  assert.equal(crossed.surfaceEvidence, 'transverse-crossing');
  assert.ok(crossed.transverseCrossingTriangles > 0, 'Actual deeper overlap is retained even with the unchanged nominal spec.');
  // Nominal origins unrelated to the measured coordinates must not collapse
  // projected extrema through catastrophic subtraction and hide the overlap.
  const distantSpec = structuredClone(value); distantSpec.frame.origin = [1e20, 1e20, 1e20];
  const distant = pair(await measure({ spec: distantSpec, components: moved, surfaces: [], options }));
  assert.equal(distant.transverseCrossingTriangles, crossed.transverseCrossingTriangles);
  assert.equal(distant.intersectionTolerance, crossed.intersectionTolerance);

  const adjacent = { id: 'same-rim', role: 'adjacent', positions: components[1].positions };
  const observed = pair(await measure({ spec: value, components, surfaces: [adjacent], options }), 'fixture-to-adjacent:same-rim');
  assert.equal(observed.transverseCrossingTriangles, raw.transverseCrossingTriangles, 'The component-only halfspace reclassification does not alter adjacent scan evidence.');
});

test('numeric floor uses both full meshes, not source samples, filtered target subsets or nominal positions', async () => {
  const base = input(face(), face(2)); base.options.samplesPerRelationship = 1;
  const original = pair(await measure(base));
  const sourceFar = { ...base, components: [mesh('fixture', join(face(0, 1000), face())), ...base.components.slice(1)] };
  const sourceReport = pair(await measure(sourceFar));
  assert.ok(sourceReport.intersectionTolerance > 100 * original.intersectionTolerance, 'An unsampled source face changes the coordinate rounding bound.');
  close(sourceReport.sampledMinDistance, 2);
  const targetFar = input(face(), join(face(2), face(20, 1000)));
  const targetReport = pair(await measure(targetFar));
  assert.ok(targetReport.intersectionTolerance > 100 * original.intersectionTolerance, 'A broadphase-excluded target face also contributes.');
  close(targetReport.sampledMinDistance, 2);
  const reflected = input(targetFar.components[1].positions, targetFar.components[0].positions);
  close(pair(await measure(reflected)).intersectionTolerance / targetReport.intersectionTolerance, 1, 1e-12);
});

test('a distant nominal datum cannot turn actual platform overlap into a measured zero interface gap', async () => {
  const value = spec(), components = generateRestoration(value);
  for (let i = 2; i < components[1].positions.length; i += 3) components[1].positions[i] -= .01;
  const options = { samplesPerRelationship: 8, maxDurationMs: 10_000 };
  const ordinary = await measure({ spec: value, components, surfaces: [], options });
  close(ordinary.interfaces[0].signedAxialGap, -.01);
  value.frame.origin = [1e20, 1e20, 1e20];
  const unresolved = await measure({ spec: value, components, surfaces: [], options });
  assert.equal(unresolved.interfaces[0].status, 'unknown');
  assert.equal(unresolved.interfaces[0].signedAxialGap, null);
  assert.equal(unresolved.interfaces[0].reason, 'nominal-plane-offset-numerically-unresolved');
  assert.equal(pair(unresolved).transverseCrossingTriangles, pair(ordinary).transverseCrossingTriangles);
  assert.equal(restorationRelationshipsSchema.safeParse(unresolved).success, true);
});
