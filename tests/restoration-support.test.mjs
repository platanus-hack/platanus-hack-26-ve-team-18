import test from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry, Ray } from 'three';
import { crownSupportRegion, generateRestoration } from '../src/restoration-geometry.ts';
import { applyPilarCrownSupport, evaluateRestorationQuality, measurePilarCrownSupport } from '../src/restoration-quality.ts';
import { measureClosedCrownPoints } from '../src/restoration-gingiva.ts';
import { restorationQualitySchema } from '../src/restoration-quality-schema.ts';
import { restorationFeedbackRows } from '../src/restoration-feedback.ts';

const control = { yieldControl: async () => {} };
const spec = () => ({ version: 'implant-assembly/v1', componentDesign: 'nested-support/v1', fdi: 36, parentPartId: 'synthetic',
  frame: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], up: [0, 0, 1] },
  parameters: { fixture: { radius: 1, length: 5, depth: 0, taper: .1 },
    abutment: { radius: 1.5, height: 1, emergenceRadius: 1.1, angleX: 0, angleY: 0 },
    crown: { width: 4, depth: 4, height: 3, cuspHeight: 0, rotation: 0 } },
  anatomy: 'molar', provenance: 'hypothesized', units: 'file units (u)', source: 'Synthetic support regression' });
const row = report => restorationFeedbackRows(report).find(item => item.id === 'component-support.pilar-enclosure');
const measured = async (s, components = generateRestoration(s)) => {
  const support = await measurePilarCrownSupport({ spec: s, components }, control);
  return applyPilarCrownSupport(evaluateRestorationQuality({ spec: s, components }), support);
};

test('required emitted support is independent of gum and excludes the transgingival base', async () => {
  const s = spec(), components = generateRestoration(s), before = structuredClone(components);
  const report = await measured(s, components), support = report.criteria.find(item => item.id === 'component-support');
  assert.equal(support.status, 'pass'); assert.equal(row(report).status, 'pass'); assert.equal(row(report).actual, 0);
  assert.ok(support.measured.supportSamples > 0); assert.equal(support.measured.enclosedSamples, support.measured.supportSamples);
  assert.ok(support.measured.sampledMinInternalClearance > support.measured.numericTolerance);
  assert.deepEqual(components, before); assert.equal(restorationQualitySchema.safeParse(report).success, true);
  assert.match(row(report).feedback, /not continuous enclosure, wall thickness/);
  // Move only emitted base/neck samples far outside the crown. The core sample
  // region stays exactly identical; no gum or nominal footprint can replace it.
  const pilar = components.find(item => item.component === 'abutment');
  for (let i = 0; i < pilar.positions.length; i += 3) if (pilar.positions[i + 2] <= s.parameters.abutment.height) pilar.positions[i] += 10;
  const region = crownSupportRegion(s, pilar);
  assert.ok(region.positions.every((value, i) => i % 3 !== 2 || value > region.seatingDatum + region.numericTolerance));
  assert.equal((await measurePilarCrownSupport({ spec: s, components }, control)).status, 'pass');
});

test('actual displaced/narrowed crowns fail despite unchanged nominal parameters and complete gum absence', async () => {
  const s = spec(), components = generateRestoration(s), crown = components.find(item => item.component === 'crown');
  for (let i = 0; i < crown.positions.length; i += 3) crown.positions[i] *= .55;
  const report = await measured(s, components), support = report.criteria.find(item => item.id === 'component-support');
  assert.equal(support.status, 'fail'); assert.ok(support.measured.outsideSamples > 0);
  assert.ok(support.measured.sampledMaxOutsideDistance > 0); assert.equal(row(report).status, 'fail');
  assert.equal(row(report).upper, 0); assert.equal(restorationQualitySchema.safeParse(report).success, true);
});

test('open/nonmanifold/numerically unresolved crowns and legacy absent posts cannot manufacture support', async () => {
  const s = spec(), components = generateRestoration(s);
  const legacy = structuredClone(s); delete legacy.componentDesign;
  const historical = await measured(legacy);
  assert.equal(row(historical).status, 'unknown'); assert.equal(row(historical).actual, null);
  for (const mutate of [crown => { crown.closed = false; }, crown => { crown.positions = crown.positions.slice(9); },
    crown => { crown.positions[0] = NaN; }, crown => { crown.positions.set(crown.positions.slice(0, 3), 3); }]) {
    const copy = structuredClone(components); mutate(copy.find(item => item.component === 'crown'));
    const report = await measured(s, copy), support = report.criteria.find(item => item.id === 'component-support');
    assert.equal(support.status, 'unknown'); assert.equal(support.measured.outsideSamples, 0);
    assert.equal(support.measured.unknownSamples, support.measured.supportSamples); assert.equal(row(report).status, 'unknown');
  }
  const legacyReport = evaluateRestorationQuality({ spec: s, components });
  legacyReport.criteria = legacyReport.criteria.filter(item => item.id !== 'component-support');
  assert.equal(restorationQualitySchema.safeParse(legacyReport).success, true);
  assert.equal(row(legacyReport).status, 'unknown'); assert.equal(row(legacyReport).actual, null);
});

test('boundary and edge rays stay unknown; resolved points retain actual unsigned distances and cancellation', async () => {
  const geometry = new BoxGeometry(2, 2, 2).toNonIndexed();
  const crown = { component: 'crown', positions: Float32Array.from(geometry.attributes.position.array), closed: true };
  const result = await measureClosedCrownPoints(crown, [[.13, .27, .31], [2, .27, .31], [1, .27, .31]], control);
  assert.deepEqual(result.samples.map(sample => sample.status), ['enclosed', 'outside', 'unknown']);
  assert.ok(Math.abs(result.samples[0].distance - .69) < 1e-6); assert.equal(result.samples[1].distance, 1);
  assert.ok(result.samples[2].distance < result.numericTolerance); assert.match(result.limits.join(' '), /Boundary proximity/);
  const cancelled = new Error('Caller cancellation'); let yields = 0;
  await assert.rejects(measureClosedCrownPoints(crown, [[.1, .2, .3]], {
    check: () => { if (yields) throw cancelled; }, yieldControl: async () => { yields++; },
  }), error => error === cancelled);
  geometry.dispose();
});

test('support checks the full bounded ray pool before accepting agreeing clean parities', async t => {
  const geometry = new BoxGeometry(2, 2, 2).toNonIndexed();
  const crown = { component: 'crown', positions: Float32Array.from(geometry.attributes.position.array), closed: true };
  const directions = new Set(), setRay = Ray.prototype.set;
  t.mock.method(Ray.prototype, 'set', function (origin, direction) {
    directions.add(direction.toArray().join(','));
    return setRay.call(this, origin, direction);
  });
  const result = await measureClosedCrownPoints(crown, [[.13, .27, .31]], control);
  assert.equal(result.samples[0].status, 'enclosed');
  assert.equal(directions.size, 7);
  geometry.dispose();
});

test('bounded timeout retains completed outside witnesses and every unfinished sample as unknown', async t => {
  const geometry = new BoxGeometry(2, 2, 2).toNonIndexed();
  const crown = { component: 'crown', positions: Float32Array.from(geometry.attributes.position.array), closed: true };
  let elapsed = 0, yields = 0;
  t.mock.method(performance, 'now', () => elapsed);
  const points = Array.from({ length: 20 }, () => [2, .27, .31]);
  const result = await measureClosedCrownPoints(crown, points, {
    yieldControl: async () => { if (++yields === 3) elapsed = 4100; },
  });
  assert.equal(result.samples.length, points.length);
  assert.equal(result.samples.filter(sample => sample.status === 'outside').length, 16);
  assert.equal(result.samples.filter(sample => sample.status === 'unknown').length, 4);
  assert.match(result.limits.join(' '), /timed out/);
  geometry.dispose();
});

test('support schema rejects erased unknowns, fabricated passes and calling internal sample distances thickness', async () => {
  const report = await measured(spec()), index = report.criteria.findIndex(item => item.id === 'component-support');
  for (const mutate of [m => { m.unknownSamples = 1; }, m => { m.sampledMinInternalClearance = 0; },
    m => { delete m.supportSamples; }, m => { m.outsideSamples = 2; }]) {
    const changed = structuredClone(report); mutate(changed.criteria[index].measured);
    assert.equal(restorationQualitySchema.safeParse(changed).success, false);
  }
  assert.match(report.criteria[index].reasons.join(' '), /not continuous enclosure, wall thickness/);
});
