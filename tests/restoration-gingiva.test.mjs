import test from 'node:test';
import assert from 'node:assert/strict';
import { generateRestoration } from '../src/restoration-geometry.ts';
import { measureAbutmentGingiva, measureFixtureGingiva } from '../src/restoration-gingiva.ts';
import { abutmentGingivaSchema } from '../src/restoration-gingiva-schema.ts';

const control = { yieldControl: async () => {} };
function spec(depth = .4) {
  return { version: 'implant-assembly/v1', fdi: 36, parentPartId: 'synthetic',
    frame: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], up: [0, 0, 1] },
    parameters: { fixture: { radius: 1, length: 4, depth, taper: .25 },
      abutment: { radius: .8, height: 2, emergenceRadius: 1.2, angleX: 0, angleY: 0 },
      crown: { width: 5, depth: 4, height: 3, cuspHeight: .5, rotation: 0 } },
    anatomy: 'molar', provenance: 'hypothesized', units: 'file units (u)', source: 'Synthetic envelope test' };
}
function rect(x0, y0, x1, y1, height = () => 0) {
  return [x0, y0, height(x0, y0), x1, y0, height(x1, y0), x1, y1, height(x1, y1),
    x0, y0, height(x0, y0), x1, y1, height(x1, y1), x0, y1, height(x0, y1)];
}
const transform = (points, frame) => Float32Array.from(points, (_, i) => {
  const start = i - i % 3, axis = i % 3;
  return frame.origin[axis] + points[start] * frame.u[axis] + points[start + 1] * frame.v[axis] + points[start + 2] * frame.up[axis];
});
const tissue = (values, s = spec(), id = 'visible-ridge-patch') => ({ id, role: 'tissue', positions: transform(values, s.frame) });
const close = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected} within ${tolerance}`);
const run = (s, surfaces, options = {}, ctl = control) => measureFixtureGingiva({ spec: s, components: generateRestoration(s), surfaces, options }, ctl);
const bounded = { maxDepthIncrease: 2 };

test('zero, exposed and deeper fixtures use signed emitted-vertex elevations and preserve the frame/crown', async () => {
  const s = spec(0), patch = tissue(rect(-4, -4, 4, 4), s);
  const zero = await run(s, [patch], bounded);
  assert.equal(zero.version, 'fixture-gingiva/v1'); assert.equal(zero.units, 'file units (u)');
  assert.equal(zero.status, 'pass'); close(zero.maxExposure, 0); assert.equal(zero.requiredDepthIncrease, 0);
  assert.equal(zero.samples, generateRestoration(s)[0].vertices); assert.equal(zero.knownSamples, zero.samples); assert.equal(zero.coverage, 1);
  assert.equal(zero.sampleMeasurements.length, zero.samples);
  assert.ok(zero.sampleMeasurements.some(sample => sample.exposure === -4));
  assert.ok(zero.sampleMeasurements.every(sample => sample.status === 'known'));
  assert.equal(new Set(zero.sampleMeasurements.map(sample => sample.point.join(','))).size, zero.samples);
  assert.deepEqual(Object.values(zero.clinicalChecks), ['unknown', 'unknown', 'unknown', 'unknown']);

  const below = tissue(rect(-4, -4, 4, 4, () => -1), s), before = structuredClone(s), meshes = generateRestoration(s);
  const copies = meshes.map(mesh => mesh.positions.slice()), patchCopy = below.positions.slice();
  const exposed = await measureFixtureGingiva({ spec: s, components: meshes, surfaces: [below], options: bounded }, control);
  assert.equal(exposed.status, 'fail'); close(exposed.maxExposure, 1);
  assert.ok(exposed.requiredDepthIncrease > 1 && exposed.requiredDepthIncrease < 1.001);
  const deeper = structuredClone(s); deeper.parameters.fixture.depth += exposed.requiredDepthIncrease;
  const resolved = await run(deeper, [below], bounded);
  assert.equal(resolved.status, 'pass'); assert.ok(resolved.maxExposure < 0);
  assert.deepEqual(generateRestoration(deeper)[2].positions, meshes[2].positions);
  assert.deepEqual(deeper.frame, before.frame); assert.deepEqual(s, before);
  meshes.forEach((mesh, i) => assert.deepEqual(mesh.positions, copies[i])); assert.deepEqual(below.positions, patchCopy);
  assert.deepEqual(await run(s, [below], bounded), exposed, 'Deterministic sample order and complete report.');
});

test('sloped planes measure the local envelope, including lower rings rather than the datum alone', async () => {
  const s = spec(.4), height = (x, y) => -.5 + .7 * x - .2 * y;
  const result = await run(s, [tissue(rect(-4, -4, 4, 4, height), s)], bounded);
  assert.equal(result.status, 'fail'); assert.equal(result.coverage, 1);
  const expected = Math.max(...result.sampleMeasurements.map(({ point }) => point[2] - height(point[0], point[1])));
  close(result.maxExposure, expected, 3e-7);
  result.sampleMeasurements.forEach(({ point, exposure }) => close(exposure, point[2] - height(point[0], point[1]), 3e-7));
  const deeper = structuredClone(s); deeper.parameters.fixture.depth += result.requiredDepthIncrease;
  assert.equal((await run(deeper, [tissue(rect(-4, -4, 4, 4, height), s)], bounded)).status, 'pass');

  // The top centre and rim are buried, but a narrow depression under an inner
  // ring is exposed. Full emitted rings supply evidence that top-only misses.
  const depression = (x, y) => Math.abs(x - .75) < .05 && Math.abs(y) < .05 ? -6 : 0;
  const patches = [];
  for (let ix = 0; ix < 80; ix++) for (let iy = 0; iy < 80; iy++) {
    const x = -2 + ix / 20, y = -2 + iy / 20;
    patches.push(...rect(x, y, x + .05, y + .05, depression));
  }
  const ringResult = await run(s, [tissue(patches, s)], bounded);
  assert.equal(ringResult.status, 'fail');
  assert.ok(ringResult.sampleMeasurements.some(sample => sample.exposure > .5 && sample.point[2] < -3));
});

test('missing patches, holes, misses and partial exposed coverage never pass or propose', async () => {
  const s = spec(), missing = await run(s, [], bounded);
  assert.equal(missing.status, 'unknown'); assert.equal(missing.maxExposure, null); assert.equal(missing.coverage, 0);
  assert.equal(missing.requiredDepthIncrease, null); assert.equal(missing.missedSamples, missing.samples);
  assert.match(missing.limits.join(' '), /No visible tissue patch supplied/);
  const irrelevant = { ...tissue(rect(-4, -4, 4, 4)), role: 'adjacent' };
  assert.equal((await run(s, [irrelevant], bounded)).status, 'unknown');
  const far = await run(s, [tissue(rect(10, 10, 12, 12))], bounded);
  assert.equal(far.status, 'unknown'); assert.equal(far.knownSamples, 0);
  const hole = z => tissue([
    ...rect(-4, -4, -.1, 4, () => z), ...rect(.1, -4, 4, 4, () => z),
    ...rect(-.1, -4, .1, -.1, () => z), ...rect(-.1, .1, .1, 4, () => z),
  ], s);
  const covered = await run(s, [hole(0)], bounded);
  assert.equal(covered.status, 'unknown'); assert.equal(covered.missedSamples, 2); assert.ok(covered.coverage > .99);
  assert.equal(covered.requiredDepthIncrease, null);
  const partialExposure = await run(s, [hole(-1)], bounded);
  assert.equal(partialExposure.status, 'fail'); assert.equal(partialExposure.missedSamples, 2);
  assert.ok(partialExposure.maxExposure > .5); assert.equal(partialExposure.requiredDepthIncrease, null);
  assert.match(partialExposure.limits.join(' '), /Incomplete or ambiguous tissue-ray coverage/);
});

test('same-side layers are ambiguous across surfaces/blocks; prototype tolerance cannot erase ambiguity', async () => {
  const s = spec(), bottom = tissue(rect(-4, -4, 4, 4, () => -8), s, 'bottom');
  const top = tissue(rect(-4, -4, 4, 4, () => -6), s, 'top');
  const result = await run(s, [top, bottom], { ...bounded, exposureTolerance: 100 });
  assert.equal(result.status, 'unknown'); assert.equal(result.ambiguousSamples, result.samples);
  assert.equal(result.knownSamples, 0); assert.equal(result.maxExposure, null); assert.equal(result.requiredDepthIncrease, null);
  const partial = tissue(rect(.1, -4, 4, 4, () => -8), s);
  const mixed = await run(s, [top, partial], bounded);
  assert.equal(mixed.status, 'fail'); assert.ok(mixed.knownSamples > 0 && mixed.ambiguousSamples > 0);
  assert.equal(mixed.requiredDepthIncrease, null);

  const many = Array.from({ length: 2049 }, () => rect(-4, -4, 4, 4, () => -6)).flat();
  many.push(...rect(-4, -4, 4, 4, () => -8));
  const blocked = await run(s, [tissue(many, s)], bounded);
  assert.equal(blocked.status, 'unknown'); assert.equal(blocked.ambiguousSamples, blocked.samples);
});

test('full large crossing triangles, reversed winding and coincident duplicates keep one known envelope', async () => {
  const s = spec(), face = [-20, -20, -.7, 20, -20, -.7, 0, 20, -.7];
  const duplicate = [...face, ...face.slice(6), ...face.slice(3, 6), ...face.slice(0, 3)];
  const result = await run(s, [tissue(duplicate, s)], bounded);
  assert.equal(result.status, 'fail'); assert.equal(result.coverage, 1); close(result.maxExposure, .3);
  const degenerate = tissue([...face, 0, 0, 0, 0, 0, 0, 0, 0, 0], s);
  const deeper = spec(1), incomplete = await run(deeper, [degenerate], bounded);
  assert.equal(incomplete.coverage, 1); assert.equal(incomplete.status, 'unknown'); assert.equal(incomplete.requiredDepthIncrease, null);
});

test('ray-coplanar gum folds remain ambiguous regardless of triangle order, surface grouping or BVH blocks', async () => {
  const s = spec(0), horizontal = rect(-1, -4, 4, 4);
  const vertical = [-1, -4, 0, -1, 4, 0, -1, 4, 1, -1, -4, 0, -1, 4, 1, -1, -4, 1];
  const variants = [[tissue([...horizontal, ...vertical], s)], [tissue([...vertical, ...horizontal], s)],
    [tissue(horizontal, s, 'top'), tissue(vertical, s, 'fold')],
    [tissue([...Array.from({ length: 2048 }, () => horizontal).flat(), ...vertical], s)]];
  for (const surfaces of variants) {
    const report = await run(s, surfaces, bounded);
    assert.equal(report.status, 'unknown'); assert.equal(report.requiredDepthIncrease, null);
    const boundary = report.sampleMeasurements.find(sample => sample.point[0] === -1 && Math.abs(sample.point[1]) < 1e-8 && sample.point[2] === 0);
    assert.equal(boundary.status, 'ambiguous'); assert.equal(boundary.exposure, null);
  }
});

test('rotated/translated/scaled frames preserve directional semantics without a 1u tolerance floor', async () => {
  for (const scale of [1e-6, 1, 1e6]) for (const rotated of [false, true]) {
    const s = spec(.4);
    if (rotated) s.frame = { origin: [11 * scale, -7 * scale, 23 * scale], u: [2 / 3, 2 / 3, -1 / 3], v: [-1 / 3, 2 / 3, 2 / 3], up: [2 / 3, -1 / 3, 2 / 3] };
    for (const [part, names] of [[s.parameters.fixture, ['radius', 'length', 'depth']], [s.parameters.abutment, ['radius', 'height', 'emergenceRadius']], [s.parameters.crown, ['width', 'depth', 'height', 'cuspHeight']]]) for (const name of names) part[name] *= scale;
    const patch = tissue(rect(-4 * scale, -4 * scale, 4 * scale, 4 * scale, x => -.5 * scale + .3 * x), s);
    const result = await run(s, [patch], { maxDepthIncrease: 2 * scale });
    assert.equal(result.status, 'fail', `${scale}, rotated=${rotated}`); assert.equal(result.coverage, 1);
    close(result.maxExposure / scale, .4, 1e-5);
    assert.ok(result.numericTolerance < .001 * scale);
    const deeper = structuredClone(s); deeper.parameters.fixture.depth += result.requiredDepthIncrease;
    assert.equal((await run(deeper, [patch], bounded)).status, 'pass');
  }
});

test('prototype tolerance is explicit and proposals require a sufficient nonnegative bound', async () => {
  const s = spec(), patch = tissue(rect(-4, -4, 4, 4, () => -.5), s);
  const ordinary = await run(s, [patch]);
  assert.equal(ordinary.status, 'fail'); assert.equal(ordinary.requiredDepthIncrease, null);
  assert.equal((await run(s, [patch], { maxDepthIncrease: .05 })).requiredDepthIncrease, null);
  assert.equal((await run(s, [patch], { maxDepthIncrease: 0 })).requiredDepthIncrease, null);
  const explicit = await run(s, [patch], { exposureTolerance: .2, maxDepthIncrease: 0 });
  assert.equal(explicit.status, 'pass'); assert.equal(explicit.exposureTolerance, .2); assert.equal(explicit.requiredDepthIncrease, 0);
  assert.ok(explicit.maxExposure > 0);
  for (const name of ['exposureTolerance', 'maxDepthIncrease']) for (const bad of [-1, NaN, Infinity, null, '1']) {
    await assert.rejects(run(s, [patch], { [name]: bad }), /finite nonnegative/);
  }
  const wrongSpec = spec(2);
  const mismatch = await measureFixtureGingiva({ spec: wrongSpec, components: generateRestoration(s), surfaces: [patch], options: bounded }, control);
  assert.equal(mismatch.status, 'fail'); assert.equal(mismatch.requiredDepthIncrease, null);
});

test('near-parallel, degenerate, missing and bounded-out geometry cannot become a pass', async () => {
  const s = spec(0), nearParallel = tissue(rect(-.00001, -4, .00001, 4, x => x * 1e6), s);
  const grazing = await run(s, [nearParallel], bounded);
  assert.equal(grazing.status, 'unknown'); assert.ok(grazing.ambiguousSamples > 0);
  const empty = await measureFixtureGingiva({ spec: s, components: [], surfaces: [] }, control);
  assert.equal(empty.status, 'unknown'); assert.equal(empty.samples, 0);
  const invalid = { ...tissue(rect(-4, -4, 4, 4)), positions: Float32Array.of(NaN, 0, 0, 1, 0, 0, 0, 1, 0) };
  await assert.rejects(run(s, [invalid]), /finite positions/);
  await assert.rejects(run(s, [{ ...invalid, positions: Float32Array.of(0, 0) }]), /complete Float32/);
  const mesh = generateRestoration(s)[0], huge = { ...mesh, positions: new Float32Array(10001 * 9) };
  const capped = await measureFixtureGingiva({ spec: s, components: [huge], surfaces: [] }, control);
  assert.equal(capped.status, 'unknown'); assert.equal(capped.requiredDepthIncrease, null); assert.match(capped.limits.join(' '), /measurement bound/);
  const distant = tissue(rect(1e9, 1e9, 1e9 + 1024, 1e9 + 1024));
  const unresolved = await run(s, [tissue(rect(-4, -4, 4, 4, () => -1)), distant], bounded);
  assert.equal(unresolved.status, 'unknown', 'A precision bound larger than the fixture cannot excuse exposure.');
  assert.equal(unresolved.requiredDepthIncrease, null);
});

test('caller errors propagate unchanged and cancellation yields during target preparation and ray traversal', async () => {
  const s = spec(), patch = tissue(rect(-4, -4, 4, 4)), components = generateRestoration(s);
  const input = { spec: s, components, surfaces: [patch], options: bounded }, sentinel = new Error('caller goal deadline');
  await assert.rejects(measureFixtureGingiva(input, { check: () => { throw sentinel; } }), error => error === sentinel);
  let yields = 0;
  await assert.rejects(measureFixtureGingiva(input, {
    check: () => { if (yields === 5) throw sentinel; }, yieldControl: async () => { yields++; },
  }), error => error === sentinel);
  assert.equal(yields, 5);
  let cancelled = false;
  setTimeout(() => { cancelled = true; }, 0);
  await assert.rejects(measureFixtureGingiva(input, { checkCancelled: () => cancelled }), /cancelled/);
  const many = tissue(Array.from({ length: 4097 }, () => rect(-4, -4, 4, 4)).flat());
  yields = 0;
  await assert.rejects(measureFixtureGingiva({ ...input, surfaces: [many] }, {
    check: () => { if (yields === 3) throw sentinel; }, yieldControl: async () => { yields++; },
  }), error => error === sentinel);
  assert.equal(yields, 3);
});

const runAbutment = (s, surfaces, components = generateRestoration(s), ctl = control) =>
  measureAbutmentGingiva({ spec: s, components, surfaces }, ctl);

test('transgingival pilar vertices may cross the gum when every exposed sample has actual crown support', async () => {
  const s = spec(2), patch = tissue(rect(-4, -4, 4, 4), s), meshes = generateRestoration(s);
  const input = { spec: s, components: meshes, surfaces: [patch] }, before = structuredClone(input);
  const report = await measureAbutmentGingiva(input, control);
  assert.equal(report.status, 'pass'); assert.equal(report.coverage, 1);
  assert.equal(report.samples, meshes[1].vertices);
  assert.ok(report.exposedSamples > 0 && report.exposedSamples < report.samples);
  assert.equal(report.supportedSamples, report.exposedSamples);
  assert.equal(report.unsupportedSamples, 0); assert.equal(report.unknownSupportSamples, 0);
  assert.equal(report.maxUnsupportedExposure, null);
  assert.deepEqual(Object.values(report.clinicalChecks), ['unknown', 'unknown', 'unknown', 'unknown']);
  assert.deepEqual(input, before); assert.deepEqual(await measureAbutmentGingiva(input, control), report);
  assert.deepEqual(abutmentGingivaSchema.parse(JSON.parse(JSON.stringify(report))), report);
  assert.match(report.limits.join(' '), /No contact area/);
});

test('gum below the site datum reveals unsupported lower pilar vertices that z > 0 checks omit', async () => {
  const s = spec(2), patch = tissue(rect(-4, -4, 4, 4, () => -2), s);
  const report = await runAbutment(s, [patch]);
  assert.equal(report.status, 'fail'); assert.equal(report.coverage, 1);
  assert.ok(report.unsupportedSamples > 0); close(report.maxUnsupportedExposure, 1);
  const witnesses = report.sampleMeasurements.filter(sample => sample.crownSupport === 'unsupported');
  assert.ok(witnesses.every(sample => sample.status === 'known' && sample.point[2] < 0 && sample.exposure > sample.exposureTolerance));
  assert.ok(witnesses.every(sample => sample.crownDistance > report.crownTolerance));
  assert.equal(abutmentGingivaSchema.safeParse(report).success, true);
});

test('actual crown displacement and emitted pilar displacement fail despite unchanged nominal controls', async () => {
  const s = spec(), patch = tissue(rect(-4, -4, 4, 4), s), original = generateRestoration(s);
  for (const moved of ['crown', 'abutment']) {
    const meshes = structuredClone(original), mesh = meshes.find(mesh => mesh.component === moved);
    for (let i = 0; i < mesh.positions.length; i += 3) mesh.positions[i] += 2.5;
    const report = await runAbutment(s, [patch], meshes);
    assert.equal(report.status, 'fail', moved); assert.ok(report.unsupportedSamples > 0, moved);
    assert.equal(abutmentGingivaSchema.safeParse(report).success, true);
  }
  assert.equal((await runAbutment(s, [patch], original)).status, 'pass');
});

test('a narrowed cervical collar exposes shoulder vertices according to gum height, not the nominal site plane', async () => {
  const s = spec(); s.parameters.fixture.radius = 1.1; s.parameters.abutment.emergenceRadius = 1.3;
  s.parameters.abutment.height = 2.1; s.parameters.crown = { width: 5.2, depth: 4.6, height: 3.5, cuspHeight: 1.1, rotation: 0 };
  // Avoid a support ray grazing an occlusal edge: this fixture isolates gum
  // height and collar exposure, rather than ambiguous crown containment.
  s.parameters.crown.rotation = 7;
  s.contour = { cervicalScale: .5 };
  const meshes = generateRestoration(s);
  const low = await runAbutment(s, [tissue(rect(-4, -4, 4, 4, () => -.2), s)], meshes);
  assert.equal(low.status, 'fail'); assert.ok(low.unsupportedSamples > 0);
  assert.ok(low.sampleMeasurements.some(sample => sample.crownSupport === 'unsupported' && sample.point[2] === 0));
  const high = await runAbutment(s, [tissue(rect(-4, -4, 4, 4, () => .2), s)], meshes);
  assert.equal(high.status, 'pass'); assert.equal(high.unsupportedSamples, 0); assert.equal(high.unknownSupportSamples, 0);
});

test('missing, partial and multilayer gum stays unknown; a measured unsupported witness still fails', async () => {
  const s = spec(2), low = tissue(rect(-4, -4, 4, 4, () => -2), s);
  for (const surfaces of [[], [tissue(rect(10, 10, 12, 12), s)],
    [low, tissue(rect(-4, -4, 4, 4, () => -1), s)]]) {
    const report = await runAbutment(s, surfaces);
    assert.equal(report.status, 'unknown'); assert.equal(report.knownSamples, 0);
    assert.equal(report.unsupportedSamples, 0); assert.equal(report.maxUnsupportedExposure, null);
    assert.equal(abutmentGingivaSchema.safeParse(report).success, true);
  }
  const half = tissue(rect(-4, -4, -.1, 4, () => -2), s);
  const failed = await runAbutment(s, [half]);
  assert.equal(failed.status, 'fail'); assert.ok(failed.missedSamples > 0 && failed.unsupportedSamples > 0);
  const unknown = await runAbutment(s, [tissue(rect(-4, -4, -.1, 4), s)]);
  assert.equal(unknown.status, 'unknown'); assert.ok(unknown.knownSamples > 0 && unknown.missedSamples > 0);
});

test('crown closure flags and nearest normals cannot substitute for a complete support surface', async () => {
  const s = spec(), patch = tissue(rect(-4, -4, 4, 4), s), meshes = generateRestoration(s);
  for (const variant of ['missing', 'open-flag', 'false-closed', 'degenerate', 'inconsistent-winding']) {
    let changed = structuredClone(meshes), crown = changed[2];
    if (variant === 'missing') changed = changed.slice(0, 2);
    if (variant === 'open-flag') crown.closed = false;
    if (variant === 'false-closed') crown.positions = crown.positions.slice(9);
    if (variant === 'degenerate') crown.positions.set(crown.positions.slice(0, 3), 3);
    if (variant === 'inconsistent-winding') {
      const corner = crown.positions.slice(0, 3); crown.positions.set(crown.positions.slice(3, 6), 0); crown.positions.set(corner, 3);
    }
    const report = await runAbutment(s, [patch], changed);
    assert.equal(report.status, 'unknown', variant); assert.equal(report.supportedSamples, 0, variant);
    assert.equal(report.unknownSupportSamples, report.exposedSamples, variant);
    assert.equal(abutmentGingivaSchema.safeParse(report).success, true, variant);
  }
  // Parity is independent of whether the complete closed mesh winds in or out.
  const reversed = structuredClone(meshes);
  for (let i = 0; i < reversed[2].positions.length; i += 9) {
    const corner = reversed[2].positions.slice(i, i + 3);
    reversed[2].positions.set(reversed[2].positions.slice(i + 3, i + 6), i);
    reversed[2].positions.set(corner, i + 3);
  }
  assert.equal((await runAbutment(s, [patch], reversed)).status, 'pass');
});

test('degenerate gum or emitted pilar and unresolved coordinate precision prevent a no-witness pass', async () => {
  const s = spec(), patch = tissue(rect(-4, -4, 4, 4), s);
  const gum = { ...patch, positions: new Float32Array([...patch.positions, ...new Float32Array(9)]) };
  assert.equal((await runAbutment(s, [gum])).status, 'unknown');
  const meshes = generateRestoration(s);
  meshes[1].positions = new Float32Array([...meshes[1].positions, ...new Float32Array(9)]);
  assert.equal((await runAbutment(s, [patch], meshes)).status, 'unknown');
  const huge = tissue(rect(1e9, 1e9, 1e9 + 1024, 1e9 + 1024), s);
  assert.equal((await runAbutment(s, [patch, huge])).status, 'unknown');
});

test('pilar evidence preserves rotated/translated/scaled source coordinates and units', async () => {
  for (const scale of [1e-6, 1, 1e6]) {
    const s = spec(2);
    s.frame = { origin: [11 * scale, -7 * scale, 23 * scale], u: [2 / 3, 2 / 3, -1 / 3], v: [-1 / 3, 2 / 3, 2 / 3], up: [2 / 3, -1 / 3, 2 / 3] };
    for (const [part, names] of [[s.parameters.fixture, ['radius', 'length', 'depth']], [s.parameters.abutment, ['radius', 'height', 'emergenceRadius']], [s.parameters.crown, ['width', 'depth', 'height', 'cuspHeight']]]) for (const name of names) part[name] *= scale;
    const report = await runAbutment(s, [tissue(rect(-4 * scale, -4 * scale, 4 * scale, 4 * scale, () => -2 * scale), s)]);
    assert.equal(report.status, 'fail'); assert.ok(report.unsupportedSamples > 0);
    close(report.maxUnsupportedExposure / scale, 1, 1e-4);
    assert.ok(report.crownTolerance < scale * .001);
    assert.equal(report.units, 'file units (u)');
    assert.equal(abutmentGingivaSchema.safeParse(report).success, true);
  }
});

test('pilar support yields to cancellation/deadline and schema rejects fabricated summaries or clinical claims', async () => {
  const s = spec(), surfaces = [tissue(rect(-4, -4, 4, 4), s)], input = { spec: s, components: generateRestoration(s), surfaces };
  let yields = 0;
  const report = await measureAbutmentGingiva(input, { yieldControl: async () => { yields++; } });
  const total = yields, sentinel = new Error('support deadline'); yields = 0;
  await assert.rejects(measureAbutmentGingiva(input, { check: () => { if (yields >= total - 1) throw sentinel; },
    yieldControl: async () => { yields++; } }), error => error === sentinel);
  await assert.rejects(measureAbutmentGingiva(input, { checkCancelled: () => true }), /cancelled/);
  for (const change of [value => { value.exposedSamples++; }, value => { value.coverage = 0; },
    value => { value.status = 'fail'; }, value => { value.maxUnsupportedExposure = 1; },
    value => { value.clinicalChecks.containment = 'pass'; },
    value => { value.sampleMeasurements.find(sample => sample.crownSupport === 'supported').crownSupport = 'not-required'; }]) {
    const changed = structuredClone(report); change(changed);
    assert.equal(abutmentGingivaSchema.safeParse(changed).success, false);
  }
});
