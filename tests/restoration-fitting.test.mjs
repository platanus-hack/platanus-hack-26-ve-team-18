import test from 'node:test';
import assert from 'node:assert/strict';
import { fitRestoration, RestorationFitCancelled } from '../src/restoration-fitting.ts';
import { createFitIntersectionQuery } from '../src/restoration-fit-intersections.ts';
import { generateRestoration, restorationCrownShape } from '../src/restoration-geometry.ts';
import { createNearestSurfaceQuery } from '../src/collision.ts';
import { Vector3 } from 'three';

function spec() {
  return { version: 'implant-assembly/v1', fdi: 36, parentPartId: 'synthetic', frame: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], up: [0, 0, 1] },
    parameters: { fixture: { radius: 1.1, length: 5, depth: .4, taper: .3 }, abutment: { radius: .8, height: 2.1, emergenceRadius: 1.3, angleX: 0, angleY: 0 }, crown: { width: 5.2, depth: 4.6, height: 3.5, cuspHeight: 1.1, rotation: 0 } },
    anatomy: 'molar', provenance: 'hypothesized', units: 'file units (u)', source: 'Synthetic fitting fixture, no patient data' };
}
function plane(axis, value) {
  const point = (x, y) => { const values = [x, y]; values.splice(axis, 0, value); return values; };
  return Float32Array.from([point(-10, -10), point(10, -10), point(10, 10), point(-10, -10), point(10, 10), point(-10, 10)].flat());
}
const targets = () => [
  { id: 'mesial:original-region', role: 'adjacent', side: 'mesial', positions: plane(0, 2.55), targetGap: .1 },
  { id: 'distal:original-region', role: 'adjacent', side: 'distal', positions: plane(0, -2.55), targetGap: .1 },
  { id: 'opposing:original-region', role: 'antagonist', positions: plane(2, 6.4), targetGap: .1 },
  { id: 'tissue:original-region', role: 'tissue', positions: plane(2, .3), targetGap: 0 },
];

test('an exact-edit baseline can explicitly retain complete full-target crossing evidence', async () => {
  for (const height of [4, 10]) {
    const positions = plane(2, height), input = { spec: spec(), surfaces: [{ id:'opposing', role:'antagonist', positions }], options: { maxCandidates:1, maxIntersectionTriangles:1, samplesPerSurface:32 } };
    const capped = await fitRestoration(input);
    assert.equal(capped.report.after.surfaces[0].intersectionComplete, false);
    const full = await fitRestoration({ ...input, options:{ ...input.options, verifyBaselineIntersections:true } });
    const measured = full.report.after.surfaces[0], crown = full.components.find(mesh=>mesh.component==='crown');
    const expected = createFitIntersectionQuery(positions,2,()=>{}).test(crown.positions);
    assert.equal(measured.intersectionComplete, true);
    assert.equal(measured.intersectionTestedTriangles,2);
    assert.equal(measured.transverseCrossingTriangles,expected.transverseCrossingTriangles);
    assert.equal(measured.intersectingTriangles,expected.intersectingTriangles);
    assert.equal(full.history.length,1);
  }
  await assert.rejects(fitRestoration({ spec:spec(), surfaces:[], options:{verifyBaselineIntersections:1} }),/boolean/);
});
const close = (a, b, e = 1e-8) => assert.ok(Math.abs(a - b) < e, `${a} != ${b}`);

test('fit results retain independent unmodified anatomy for later parameter edits', async () => {
  const initial = spec();
  const result = await fitRestoration({ spec: initial, surfaces: [], options: { maxCandidates: 1 } });
  assert.equal(initial.crownShape, undefined);
  assert.equal(result.spec.crownShape.source.kind, 'procedural-template');
  assert.equal(Math.max(...result.spec.crownShape.occlusal), 1, 'Store base anatomy before additive relief.');
  assert.deepEqual(generateRestoration(result.spec), result.components);
  // A supplied shape is authoritative even if its declared tooth digit differs
  // within the same arch/class. Editing an abutment must not replace its form.
  const edited = structuredClone(result.spec);
  edited.crownShape.occlusal[100] *= 0.9;
  edited.parameters.abutment.height += 0.2;
  const measured = await fitRestoration({ spec: edited, surfaces: [], options: { maxCandidates: 1 } });
  assert.deepEqual(measured.spec.crownShape, edited.crownShape);
  assert.notEqual(measured.spec.crownShape.occlusal.buffer, edited.crownShape.occlusal.buffer);
  assert.deepEqual(generateRestoration(measured.spec), measured.components);
});

test('an open static bite approaches observed opposing geometry without creating crossings', async () => {
  const initial = spec();
  const result = await fitRestoration({ spec: initial,
    surfaces: [{ id: 'open-bite', role: 'antagonist', positions: plane(2, 7.3), targetGap: .1 }],
    options: { maxCandidates: 32, samplesPerSurface: 128 } });
  const before = result.report.before.surfaces[0], after = result.report.after.surfaces[0];
  assert.equal(before.intersectingTriangles, 0);
  assert.equal(after.intersectingTriangles, 0);
  assert.ok(before.sampledOcclusalGap > .5);
  assert.ok(after.sampledOcclusalGap < before.sampledOcclusalGap * .7);
  assert.ok(after.sampledOcclusalGapError < before.sampledOcclusalGapError);
  assert.equal(after.occlusalRayHits, after.occlusalRaySamples);
  assert.deepEqual(result.spec.parameters.fixture, initial.parameters.fixture);
});

test('opposing geometry behind or beside the crown cannot attract it as an occlusal contact', async () => {
  for (const positions of [plane(2, -4), plane(0, 8)]) {
    const initial = spec();
    const result = await fitRestoration({ spec: initial,
      surfaces: [{ id: 'not-facing', role: 'antagonist', positions, targetGap: .1 }],
      options: { maxCandidates: 8, samplesPerSurface: 32 } });
    assert.equal(result.report.after.surfaces[0].occlusalRayHits, 0);
    assert.equal(result.report.after.surfaces[0].sampledOcclusalGap, null);
    assert.deepEqual(result.spec.parameters, initial.parameters);
  }
});

test('losing a small observed opposing patch cannot improve the accepted fit', async () => {
  // This narrow strip intersects the current area-stratified occlusal samples;
  // trial dimensions can still lose it entirely, which must be rejected.
  const strip = Float32Array.from([1.5,-10,10, 1.58,-10,10, 1.58,10,10, 1.5,-10,10, 1.58,10,10, 1.5,10,10]);
  const result = await fitRestoration({ spec: spec(), surfaces: [{ id: 'narrow-opponent', role: 'antagonist', positions: strip, targetGap: .1 }],
    options: { maxCandidates: 16, samplesPerSurface: 32 } });
  assert.ok(result.report.before.surfaces[0].occlusalRayHits > 0);
  assert.ok(result.report.after.surfaces[0].occlusalRayHits > 0);
  const coverage = entry => entry.measurement.surfaces[0].occlusalRayHits / entry.measurement.surfaces[0].occlusalRaySamples;
  const accepted = result.history.filter(entry => entry.accepted);
  for (let i = 1; i < accepted.length; i++) assert.ok(coverage(accepted[i]) >= coverage(accepted[i - 1]));
  assert.ok(result.history.some(entry => !entry.accepted && entry.measurement.surfaces[0].occlusalRayHits === 0), 'Lost-evidence trials are measured and rejected.');
});

test('surface rays return the nearest forward hit, preserve winding independence and honour maximum range', () => {
  const p = new Vector3(), direction = new Vector3(0, 0, 1);
  const query = createNearestSurfaceQuery(Float32Array.from([...plane(2, -2), ...plane(2, 7), ...plane(2, 3)]));
  close(query.rayDistance(p, direction), 3);
  assert.equal(query.rayDistance(p, direction, 2.9), Infinity);
  close(query.rayDistance(p, direction, 3), 3);
  close(query.rayDistance(p, direction.clone().negate()), 2);
});

test('bounded fitting of explicit legacy anatomy improves adjacent and antagonist crossings and preserves inputs/fixture', async () => {
  // Pin this known, satisfiable fitting scenario to the stored per-angle
  // relief behavior. Reopening historical anatomy must not change its fit.
  const initial = spec(); initial.crownShape = restorationCrownShape(initial);
  delete initial.crownShape.reliefDatum;
  const input = { spec: initial, surfaces: targets(), options: { maxCandidates: 32, maxDurationMs: 20_000, samplesPerSurface: 128 } };
  const before = structuredClone(input), result = await fitRestoration(input);
  assert.deepEqual(input, before);
  assert.equal(result.report.status, 'improved');
  assert.ok(result.report.after.score < result.report.before.score * .4);
  for (const surface of result.report.after.surfaces.filter(surface => surface.role !== 'tissue')) {
    const original = result.report.before.surfaces.find(s => s.id === surface.id);
    assert.ok(original.intersectingTriangles > 0);
    assert.equal(surface.intersectingTriangles, 0);
    assert.equal(surface.intersectionComplete, true);
    assert.equal(surface.targetTriangles, 2);
    // The bounded solver improves the observed shortfall; it does not promise
    // an arbitrary absolute sampled clearance in file units.
    assert.ok(surface.sampledMaxGapDeficit < original.sampledMaxGapDeficit);
    assert.ok(surface.sampledRmsGapError < original.sampledRmsGapError);
    assert.ok(surface.sampledMedianDistance >= surface.sampledMinDistance);
    assert.ok(surface.sampledP95Distance >= surface.sampledMedianDistance);
    assert.ok(surface.sampledRegionTriangles >= surface.samples);
    assert.ok(surface.sampledRegionArea > 0);
    assert.equal(surface.sampledMaxGapDeficit, Math.max(0, surface.targetGap - surface.sampledMinDistance));
    assert.ok(surface.intersectionTolerance > 0);
    assert.ok(surface.intersectionPairTests >= 0);
  }
  assert.equal(result.report.after.surfaces.at(-1).role, 'tissue');
  assert.ok(result.report.after.surfaces.at(-1).intersectingTriangles > 0, 'trans-site tissue conflict stays visible');
  assert.deepEqual(result.spec.parameters.fixture, input.spec.parameters.fixture);
  assert.deepEqual(result.components[0].positions, generateRestoration(input.spec)[0].positions);
  // A lower score may now be rejected for creating a new target-gap deficit
  // or failing an independent quality rule. Retain the best admissible trial.
  const minimum = Math.min(...result.history.filter(entry => entry.accepted).map(entry => entry.measurement.score));
  close(result.report.after.score, minimum);
  const accepted = result.history.filter(entry => entry.accepted);
  for (let i = 1; i < accepted.length; i++) for (const previous of accepted[i - 1].measurement.surfaces) {
    const next = accepted[i].measurement.surfaces.find(surface => surface.id === previous.id);
    assert.ok(next.transverseCrossingTriangles <= previous.transverseCrossingTriangles, 'No accepted step may increase observed crossings.');
    if (previous.intersectionComplete) assert.equal(next.intersectionComplete, true);
    assert.ok(next.sampledMaxGapDeficit <= previous.sampledMaxGapDeficit + 1e-9);
  }
  assert.deepEqual(result.spec.parameters, accepted.at(-1).parameters);
  assert.ok(result.history.some(entry => !entry.accepted && entry.measurement.score > result.report.after.score), 'inferior trials must not overwrite the better candidate');
  assert.equal(result.history.length, 32);
  assert.equal(result.spec.frame.origin[0], 0);
  assert.ok(result.spec.parameters.crown.width >= input.spec.parameters.crown.width * .82);
  assert.ok(result.spec.parameters.crown.height >= input.spec.parameters.crown.height * .72);
  assert.match(result.report.limits.join(' '), /no distance error bound|no.*error bound/);
  assert.match(result.report.limits.join(' '), /unvalidated/);
});

test('identical snapshots produce identical geometry, measured scores and candidate order', async () => {
  const input = { spec: spec(), surfaces: targets().slice(0, 3), options: { maxCandidates: 8, samplesPerSurface: 64 } };
  const a = await fitRestoration(input), b = await fitRestoration(input);
  assert.deepEqual(a.spec, b.spec);
  assert.deepEqual(a.history, b.history);
  assert.deepEqual(a.report.after, b.report.after);
  a.components.forEach((component, index) => assert.deepEqual(component.positions, b.components[index].positions));
});

test('no target never claims a fit; named partial intersection targets retain explicit incomplete evidence', async () => {
  const result = await fitRestoration({ spec: spec(), surfaces: [] });
  assert.equal(result.report.status, 'unchanged');
  assert.equal(result.report.termination, 'no-surfaces');
  assert.equal(result.history.length, 1);
  assert.deepEqual(result.report.after.surfaces, []);
  assert.match(result.report.limits.join(' '), /No antagonist target/);
  const partial = await fitRestoration({ spec: spec(), surfaces: [targets()[2]], options: { maxCandidates: 1, maxIntersectionTriangles: 1, samplesPerSurface: 32 } });
  const measured = partial.report.after.surfaces[0];
  assert.equal(measured.targetTriangles, 2);
  assert.equal(measured.intersectionTestedTriangles, 1);
  assert.equal(measured.intersectionComplete, false);
  assert.equal(partial.report.sampling.fullResolutionDistanceTargets, true);
});

test('local fitting is equivariant under a shared oblique source frame and respects mesial sign', async () => {
  const input = { spec: spec(), surfaces: [targets()[0]], options: { maxCandidates: 1, samplesPerSurface: 128 } };
  const local = await fitRestoration(input);
  const changed = structuredClone(input), theta = .72, c = Math.cos(theta), s = Math.sin(theta);
  changed.spec.frame = { origin: [17, -8, 4], u: [c, 0, s], v: [0, 1, 0], up: [-s, 0, c] };
  for (const surface of changed.surfaces) for (let i = 0; i < surface.positions.length; i += 3) {
    const [x, y, z] = surface.positions.slice(i, i + 3);
    surface.positions.set([17 + c * x - s * z, -8 + y, 4 + s * x + c * z], i);
  }
  const transformed = await fitRestoration(changed);
  const a = local.report.after.surfaces[0], b = transformed.report.after.surfaces[0];
  close(a.sampledMinDistance, b.sampledMinDistance, .0001);
  assert.equal(a.intersectingTriangles, b.intersectingTriangles);
  const mirrored = spec(); mirrored.anatomicalSigns = { mesial: -1, buccal: 1 };
  const negative = await fitRestoration({ spec: mirrored, surfaces: [{ ...targets()[0], positions: plane(0, -2.55) }], options: { maxCandidates: 1 } });
  assert.ok(negative.report.after.surfaces[0].sampledMinDistance < .1, 'mesial side follows the anatomical sign, not screen/frame x');
});

test('candidate time budget returns the measured best baseline; cancellation discards results', async () => {
  let yields = 0;
  const result = await fitRestoration({ spec: spec(), surfaces: [targets()[2]], options: { maxDurationMs: 200, samplesPerSurface: 32 } }, {
    yieldControl: async () => { if (++yields === 3) await new Promise(resolve => setTimeout(resolve, 220)); },
  });
  assert.equal(result.report.termination, 'time-budget');
  assert.equal(result.history.length, 1);
  assert.deepEqual(result.report.before, result.report.after);
  await assert.rejects(fitRestoration({ spec: spec(), surfaces: targets() }, { checkCancelled: () => true }), RestorationFitCancelled);
});

test('a failed trial construction does not discard the best valid candidate or exceed the attempt budget', async () => {
  const initial = spec();
  initial.parameters.fixture.radius = .001; initial.parameters.fixture.taper = 0; initial.parameters.crown.width = 9.99;
  const result = await fitRestoration({ spec: initial, surfaces: [targets()[2]], options: { maxCandidates: 8, samplesPerSurface: 32 } });
  assert.equal(result.report.status, 'improved');
  assert.ok(result.history.length < 8, 'invalid construction consumed a candidate attempt');
  assert.match(result.report.limits.join(' '), /Skipped 1 candidate constructions/);
  close(result.report.after.score, Math.min(...result.history.map(entry => entry.measurement.score)));
  assert.deepEqual(result.spec.parameters, result.history.filter(entry => entry.accepted).at(-1).parameters);
});

test('invalid target categories, regions, budgets, names and dimensions fail explicitly', async () => {
  for (const surface of [
    { ...targets()[0], role: 'bite' }, { ...targets()[0], role: 'tissue' }, { ...targets()[0], id: '' },
    { ...targets()[0], positions: Float32Array.of(1, 2) }, { ...targets()[0], positions: new Float32Array(9).fill(NaN) },
    { ...targets()[0], targetGap: -1 }, { ...targets()[0], weight: 0 },
  ]) await assert.rejects(fitRestoration({ spec: spec(), surfaces: [surface] }));
  await assert.rejects(fitRestoration({ spec: spec(), surfaces: [targets()[0], targets()[0]] }), /unique/);
  await assert.rejects(fitRestoration({ spec: spec(), surfaces: targets(), options: { maxTargetTriangles: 1 } }), /triangle budget/);
  await assert.rejects(fitRestoration({ spec: spec(), surfaces: [], options: { maxCandidates: 81 } }), /Candidate budget/);
});

test('bounded triangle SAT distinguishes crossing, touching and separated faces, and checks cancellation', () => {
  const target = Float32Array.of(-1, -1, 0, 1, -1, 0, 0, 1, 0);
  const query = createFitIntersectionQuery(target, 10, () => {});
  assert.equal(query.test(Float32Array.of(0, 0, -1, 0, 0, 1, 0, .5, 0)).intersectingTriangles, 2);
  assert.equal(query.test(target).intersectingTriangles, 2, 'coplanar contact counts');
  const raised = target.map((value, index) => index % 3 === 2 ? value + 1 : value);
  assert.equal(query.test(raised).intersectingTriangles, 0);
  assert.equal(query.test(raised).intersectionComplete, true);
  assert.throws(() => createFitIntersectionQuery(target, 10, () => { throw new Error('cancelled'); }), /cancelled/);
});

test('fitting worker cancels stale jobs, transfers six outputs, and recovers after errors', async () => {
  const oldPost = globalThis.postMessage, oldHandler = globalThis.onmessage;
  const responses = [];
  const waitFor = async (id, type) => {
    // The worker permits 30 s of goal work plus a separate relationship audit.
    const deadline = Date.now() + 35_000;
    while (!responses.some(({ data }) => data.id === id && data.type === type)) {
      assert.ok(Date.now() < deadline, `Worker did not send ${type} for ${id}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    return responses.find(({ data }) => data.id === id && data.type === type);
  };
  globalThis.postMessage = (data, options) => responses.push({ data: structuredClone(data, { transfer: options.transfer }), count: options.transfer.length });
  try {
    await import('../src/restoration-fit.worker.ts');
    globalThis.onmessage({ data: { type: 'fit', id: 10, input: { spec: spec(), surfaces: targets() } } });
    globalThis.onmessage({ data: { type: 'cancel', id: 10 } });
    globalThis.onmessage({ data: { type: 'fit', id: 11, input: { spec: spec(), surfaces: [] } } });
    await Promise.all([waitFor(10, 'cancelled'), waitFor(11, 'result')]);
    assert.equal(responses.some(({ data }) => data.id === 10 && data.type === 'result'), false);
    assert.equal(responses.some(({ data }) => data.id === 10 && data.type === 'cancelled'), true);
    const output = responses.find(({ data }) => data.id === 11 && data.type === 'result');
    assert.deepEqual((await waitFor(11, 'targets')).data.targetIds, []);
    assert.ok(responses.findIndex(({ data }) => data.id === 11 && data.type === 'targets') < responses.findIndex(({ data }) => data.id === 11 && data.type === 'progress'));
    assert.deepEqual(responses.filter(({ data }) => data.id === 11 && data.type === 'progress').map(({ data }) => [data.phase, data.fdi]), [['creating', 36], ['fitting', 36]]);
    assert.equal(output.count, 6);
    assert.equal(output.data.result.components.length, 3);
    assert.equal(new Set(output.data.result.components.flatMap(c => [c.positions.buffer, c.normals.buffer])).size, 6);
    globalThis.onmessage({ data: { type: 'fit', id: 12, input: { spec: { ...spec(), fdi: 99 }, surfaces: [] } } });
    assert.match((await waitFor(12, 'error')).data.error, /FDI/);
    const namedTargets = targets();
    globalThis.onmessage({ data: { type: 'fit', id: 13, input: { spec: spec(), surfaces: namedTargets } } });
    assert.deepEqual((await waitFor(13, 'targets')).data.targetIds, namedTargets.map(surface => surface.id));
    assert.equal((await waitFor(13, 'result')).data.type, 'result');
  } finally {
    if (oldPost === undefined) delete globalThis.postMessage; else globalThis.postMessage = oldPost;
    if (oldHandler === undefined) delete globalThis.onmessage; else globalThis.onmessage = oldHandler;
  }
});


test('baseline distance batches yield for cancellation and do not publish partial evidence', async () => {
  let cancelled = false, yields = 0;
  await assert.rejects(fitRestoration({ spec: spec(), surfaces: [targets()[2]], options: { samplesPerSurface: 256 } }, {
    yieldControl: async () => { if (++yields === 3) cancelled = true; },
    checkCancelled: () => cancelled,
  }), RestorationFitCancelled);
  assert.equal(yields, 3);
});

test('intersection audit separates transverse evidence from coplanar contact at any file-unit scale', () => {
  for (const scale of [1e-10, 1, 1e10]) {
    const scaled = values => Float32Array.from(values.map(value => value * scale));
    const target = scaled([-1, -1, 0, 1, -1, 0, 0, 1, 0]);
    const query = createFitIntersectionQuery(target, 10, () => {});
    const crossed = query.test(scaled([0, 0, -1, 0, 0, 1, 0, .5, 0]));
    assert.equal(crossed.transverseCrossingTriangles, 2);
    assert.equal(crossed.touchingOrAmbiguousTriangles, 0);
    const touched = query.test(target);
    assert.equal(touched.transverseCrossingTriangles, 0);
    assert.equal(touched.touchingOrAmbiguousTriangles, 2);
    assert.equal(touched.intersectionPairTests, 1);
    const degenerate = query.test(scaled([0, 0, 0, 0, 0, 0, 0, 0, 0]));
    assert.equal(degenerate.intersectingTriangles, 0);
    assert.equal(degenerate.intersectionComplete, false);
  }
});

test('long target extents cannot turn separated local faces into artificial contact', () => {
  const target = Float32Array.of(-1e9, -1e9, 0, 1e9, -1e9, 0, 0, 1e9, 0);
  const source = Float32Array.of(-1, -1, .1, 1, -1, .1, 0, 1, .1);
  const measured = createFitIntersectionQuery(target, 10, () => {}).test(source);
  assert.equal(measured.intersectingTriangles, 0);
  assert.equal(measured.intersectionComplete, true);
  assert.ok(measured.intersectionTolerance < .001);
  for (const limit of [0, NaN, .5]) assert.throws(() => createFitIntersectionQuery(target, limit, () => {}), /positive safe integer/);
});

test('bounded target preparation yields between exact BVH blocks and retains the nearest final block', async () => {
  const far = plane(2, 100), near = plane(2, 6.4);
  const positions = new Float32Array(8194 * 9);
  for (let offset = 0; offset < 8192 * 9; offset += far.length) positions.set(far, offset);
  positions.set(near, 8192 * 9);
  const options = { maxCandidates: 1, samplesPerSurface: 32, maxIntersectionTriangles: 1 };
  const target = { id: 'opposing', role: 'antagonist', targetGap: .1 };
  const exact = await fitRestoration({ spec: spec(), surfaces: [{ ...target, positions: near }], options });
  let yields = 0;
  const blocked = await fitRestoration({ spec: spec(), surfaces: [{ ...target, positions }], options }, { yieldControl: async () => { yields++; } });
  assert.equal(yields, 3, 'preparation yields before target, between blocks, then before baseline measurements');
  const a = exact.report.after.surfaces[0], b = blocked.report.after.surfaces[0];
  close(a.sampledMinDistance, b.sampledMinDistance);
  close(a.sampledRmsGapError, b.sampledRmsGapError);
  assert.equal(b.targetTriangles, 8194);
  assert.equal(blocked.report.sampling.fullResolutionDistanceTargets, true);
});

test('source-derived overfill repairs oversized crowns even when the target distance objective is already zero', async () => {
  const initial = spec();
  initial.parameters.crown.width = 7; initial.parameters.crown.depth = 6.5;
  initial.qualityContext = { version: 'restoration-quality-context/v1', units: 'file units (u)',
    neighbors: [{ id: 'scan-neighbor', mesiodistal: 5.2, buccolingual: 4.6, height: 6.7, method: 'Synthetic measured scan dimensions', provenance: 'measured' }],
    gapWidth: { value: 5.5, method: 'Synthetic facing surface gap', provenance: 'measured' },
    availableHeight: null, expectedProximalSides: [], bitePoseVerified: false };
  const input = { spec: initial, surfaces: [{ id: 'far-other-tooth', role: 'other-tooth', positions: plane(0, 20), targetGap: 0 }],
    options: { maxCandidates: 24, samplesPerSurface: 32 } };
  const original = structuredClone(input), result = await fitRestoration(input);
  assert.deepEqual(input, original);
  assert.equal(result.report.before.surfaces[0].intersectingTriangles, 0);
  assert.equal(result.report.before.surfaces[0].sampledRmsGapError, 0);
  assert.ok(result.spec.parameters.crown.width < initial.parameters.crown.width * .95);
  assert.ok(result.spec.parameters.crown.depth < initial.parameters.crown.depth * .95);
  assert.ok(result.history.some(entry => entry.accepted && entry.revision?.reason.startsWith('Coordinated crown dimension repair')));
  assert.ok(result.spec.parameters.crown.width >= initial.parameters.crown.width * .82);
  assert.ok(result.spec.parameters.crown.depth >= initial.parameters.crown.depth * .82);
  assert.deepEqual(result.spec.frame, initial.frame);
  assert.deepEqual(result.spec.parameters.fixture, initial.parameters.fixture);
  assert.notEqual(result.report.quality.final.status, 'pass', 'Bounded repair and missing evidence cannot claim success.');
  const hypothetical = structuredClone(input);
  hypothetical.spec.qualityContext.neighbors[0].provenance = 'hypothesized';
  hypothetical.spec.qualityContext.gapWidth.provenance = 'hypothesized';
  const unmeasured = await fitRestoration(hypothetical);
  assert.deepEqual(unmeasured.spec.parameters, initial.parameters, 'Hypothesized source size cannot supply a measured scale objective.');
});

test('large observed intersection counts retain a score gradient beyond the old saturation point', async () => {
  const measure = async copies => {
    const patch = plane(0, 2.4), positions = new Float32Array(copies * patch.length);
    for (let i = 0; i < copies; i++) positions.set(patch, i * patch.length);
    return fitRestoration({ spec: spec(), surfaces: [{ id: 'dense-flank', role: 'adjacent', side: 'mesial', positions, targetGap: .1 }],
      options: { maxCandidates: 1, samplesPerSurface: 32 } });
  };
  const a = await measure(80), b = await measure(160);
  assert.ok(a.report.before.surfaces[0].intersectingTriangles > 128);
  assert.ok(b.report.before.surfaces[0].intersectingTriangles > a.report.before.surfaces[0].intersectingTriangles);
  assert.ok(b.report.before.score > a.report.before.score);
  assert.notEqual(b.report.quality.final.status, 'pass');
});
