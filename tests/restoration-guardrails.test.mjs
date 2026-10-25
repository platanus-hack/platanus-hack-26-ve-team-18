import test from 'node:test';
import assert from 'node:assert/strict';
import { generateRestoration } from '../src/restoration-geometry.ts';
import { evaluateRestorationQuality, compareQualityReports } from '../src/restoration-quality.ts';
import { RESTORATION_GUARDRAIL_IDS, measureRestorationComponentExtents } from '../src/restoration-guardrails.ts';
import { restorationQualitySchema, restorationQualityContextSchema, restorationGuardrailsSchema } from '../src/restoration-quality-schema.ts';

const spec = () => ({ version: 'implant-assembly/v1', fdi: 36, parentPartId: 'synthetic',
  frame: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], up: [0, 0, 1] },
  parameters: { fixture: { radius: 1.1, length: 5, depth: .4, taper: .3 },
    abutment: { radius: .8, height: 2.1, emergenceRadius: 1.3, angleX: 0, angleY: 0 },
    crown: { width: 5.2, depth: 4.6, height: 3.5, cuspHeight: 1.1, rotation: 0 } },
  anatomy: 'molar', provenance: 'hypothesized', units: 'file units (u)', source: 'Synthetic guardrail regression; no patient data' });
const context = () => ({ version: 'restoration-quality-context/v1', units: 'file units (u)', neighbors: [], gapWidth: null, availableHeight: null });
const evaluate = (s = spec(), extra = {}) => evaluateRestorationQuality({ spec: s, components: generateRestoration(s), ...extra });
const issue = (report, id) => report.guardrails.issues.find(value => value.id === id);

test('all dentist feedback domains return components, actual/target evidence and nonautomatic actions', () => {
  const report = evaluate();
  assert.deepEqual(report.guardrails.issues.map(value => value.id), RESTORATION_GUARDRAIL_IDS);
  assert.equal(report.guardrails.status, 'unknown');
  for (const item of report.guardrails.issues) {
    assert.ok(item.components.length && Object.keys(item.actual).length && item.target.description && item.missingEvidence.length);
    assert.equal(item.status, 'unknown', item.id);
    for (const action of item.suggestions) {
      assert.equal(action.automatic, false);
      assert.equal(Object.hasOwn(action, 'proposed'), false);
    }
  }
  for (const id of ['subcrestal-placement', 'adjacent-root-clearance']) assert.equal(issue(report, id).target.value, null);
  assert.equal(restorationQualitySchema.safeParse(report).success, true);
});

test('both ambiguous 1.5 mm case targets stay unknown and cannot affect fitter rankings or revisions', () => {
  const s = spec(), c = context(), baseline = evaluate(s, { context: c });
  const feedback = { provenance: 'unconfirmed-case-feedback', source: 'Ambiguous dentist feedback; meaning/applicability unconfirmed', subcrestalDepthMm: 1.5, adjacentToothClearanceMm: 1.5 };
  const report = evaluate(s, { context: { ...c, placementFeedback: feedback } });
  assert.equal(restorationQualityContextSchema.safeParse({ ...c, placementFeedback: feedback }).success, true);
  assert.deepEqual(report.criteria, baseline.criteria);
  assert.deepEqual(report.revisions, baseline.revisions);
  assert.equal(compareQualityReports(report, baseline), 0);
  for (const id of ['subcrestal-placement', 'adjacent-root-clearance']) {
    const value = issue(report, id);
    assert.equal(value.status, 'unknown');
    assert.deepEqual([value.target.value, value.target.units, value.target.provenance], [1.5, 'mm', 'unconfirmed-case-feedback']);
    assert.equal(value.actual.verifiedMmPerUnit, null);
    assert.match(value.missingEvidence.join(' '), /scale/i);
    assert.ok(value.suggestions.every(item => item.kind === 'collect-evidence' && !item.automatic));
  }
  assert.equal(issue(report, 'subcrestal-placement').actual.measuredSubcrestalDepthMm, null);
  assert.equal(issue(report, 'adjacent-root-clearance').actual.measuredFixtureToRootClearanceMm, null);
  assert.equal(s.parameters.fixture.depth, .4);
  assert.equal(restorationQualityContextSchema.safeParse({ ...c, placementFeedback: { ...feedback, provenance: 'confirmed' } }).success, false);
  assert.equal(restorationQualityContextSchema.safeParse({ ...c, placementFeedback: { ...feedback, subcrestalDepthMm: -1 } }).success, false);
});

test('actual component dimensions follow emitted vertices and the construction frame, not control names', () => {
  const s = spec();
  s.parameters.crown.rotation = 90;
  s.parameters.abutment.angleY = 20;
  s.frame = { origin: [12, -4, 20], u: [0, 1, 0], v: [0, 0, 1], up: [1, 0, 0] };
  const report = evaluate(s), actual = issue(report, 'dimensions').actual;
  assert.ok(Math.abs(actual['crown.mesiodistal'] - 4.6) < .05);
  assert.ok(Math.abs(actual['crown.buccolingual'] - 5.2) < .05);
  assert.equal(actual['nominal.crown.width'], 5.2);
  assert.ok(Math.abs(actual['fixture.base'] - (-5.4)) < 1e-5);
  assert.ok(Math.abs(actual['fixture.top'] - (-.4)) < 1e-5);
  assert.ok(Math.abs(actual['abutment.occlusal'] - 2.5) < 1e-5);
  assert.equal(actual.verifiedMmPerUnit, null);
  assert.deepEqual(report.guardrails.componentExtents.find(item => item.component === 'crown').extents, report.crownExtents);
  assert.equal(measureRestorationComponentExtents(s), null);
});

test('confirmed dentist wording records case targets without measuring or applying clinical placement', () => {
  const s = spec(), c = context(), baseline = evaluate(s, { context: c });
  c.placementFeedback = { provenance: 'clinician-entered-case-feedback', source: 'Dentist wording confirmed by user for this synthetic case', subcrestalDepthMm: 1.5, adjacentToothClearanceMm: 1.5 };
  assert.equal(restorationQualityContextSchema.safeParse(c).success, true);
  const report = evaluate(s, { context: c });
  assert.deepEqual(report.criteria, baseline.criteria);
  assert.deepEqual(report.revisions, baseline.revisions);
  for (const id of ['subcrestal-placement', 'adjacent-root-clearance']) {
    const value = issue(report, id);
    assert.equal(value.target.provenance, 'clinician-entered-case-feedback');
    assert.equal(value.target.value, 1.5);
    assert.equal(value.status, 'unknown');
    assert.equal(value.actual.verifiedMmPerUnit, null);
    assert.match(value.missingEvidence.join(' '), /applicability/);
  }
  assert.equal(issue(report, 'subcrestal-placement').actual.measuredSubcrestalDepthMm, null);
  assert.equal(issue(report, 'adjacent-root-clearance').actual.measuredFixtureToRootClearanceMm, null);
  assert.equal(s.parameters.fixture.depth, .4);
  assert.equal(restorationQualitySchema.safeParse(report).success, true);
});

test('basic surface defects fail per-component checks while valid closure leaves self-intersection unknown', () => {
  const s = spec(), components = generateRestoration(s);
  let report = evaluate(s, { components });
  assert.equal(issue(report, 'surface-integrity').status, 'unknown');
  assert.equal(issue(report, 'surface-integrity').actual.selfIntersection, 'untested');
  const fixture = components.find(item => item.component === 'fixture');
  fixture.positions.fill(0, 0, 9);
  report = evaluate(s, { components });
  assert.equal(issue(report, 'surface-integrity').status, 'fail');
  assert.ok(issue(report, 'surface-integrity').actual['fixture.degenerateTriangles'] >= 1);
  const crown = components.find(item => item.component === 'crown');
  crown.positions[0] = NaN;
  report = evaluate(s, { components });
  assert.equal(issue(report, 'surface-integrity').actual['crown.nonfiniteCoordinates'], 1);
  assert.equal(issue(report, 'dimensions').actual['crown.mesiodistal'], null);
  assert.equal(restorationQualitySchema.safeParse(report).success, true);
  report = evaluate(s, { components: components.filter(item => item.component !== 'abutment') });
  assert.equal(issue(report, 'surface-integrity').actual['abutment.present'], false);
  assert.equal(issue(report, 'dimensions').status, 'fail');
});

test('cervical overcontour is actionable without inventing tissue fit or clinical emergence angle', () => {
  const s = spec();
  s.parameters.abutment.emergenceRadius = 3;
  s.contour = { cervicalScale: 1.1, occlusalScale: .9 };
  const report = evaluate(s), cervical = issue(report, 'cervical-emergence');
  assert.equal(cervical.status, 'fail');
  assert.equal(cervical.actual.nominalEmergenceRadius, 3);
  assert.equal(cervical.actual.clinicalEmergenceAngleDegrees, null);
  assert.equal(cervical.actual.tissueCompression, null);
  assert.equal(cervical.actual.nominalCervicalScale, 1.1);
  assert.ok(cervical.suggestions.some(item => item.parameters.includes('contour.cervicalScale')));
  assert.ok(issue(report, 'anatomy').suggestions.some(item => item.parameters.includes('contour.occlusalScale')));
});

test('sampled adjacent/tissue surfaces cannot become root or bone measurements', () => {
  const surface = (role, id) => ({ id, role, targetGap: 0, weight: 1, targetTriangles: 2, samples: 2, sampledMinDistance: 1.5,
    sampledRmsGapError: 1.5, nearSamples: 0, intersectingTriangles: 0, intersectionTestedTriangles: 2, intersectionComplete: true, transverseCrossingTriangles: 0 });
  const measurement = { score: 0, objectiveScore: 0, morphologyPenalty: 0, surfaces: [surface('tissue', 'gingiva'), { ...surface('adjacent', 'neighbor'), side: 'mesial' }] };
  const report = evaluate(spec(), { measurement });
  assert.equal(issue(report, 'cervical-emergence').actual.sampledTissueMinDistance, 1.5);
  assert.equal(issue(report, 'cervical-emergence').status, 'unknown');
  assert.equal(issue(report, 'subcrestal-placement').actual.reviewedBoneCrest, null);
  assert.equal(issue(report, 'adjacent-root-clearance').actual.measuredFixtureToRootClearanceMm, null);
  assert.equal(issue(report, 'adjacent-root-clearance').status, 'unknown');
});

test('manual colour and contour edits cannot confirm tooth identity, shade or clinical morphology', () => {
  const s = spec();
  s.provenance = 'clinician-entered';
  s.appearance = { crown: { color: '#aabbcc', roughness: .3 } };
  const report = evaluate(s), shade = issue(report, 'shade');
  assert.equal(issue(report, 'anatomy').actual.toothIdentityReviewed, null);
  assert.equal(issue(report, 'anatomy').actual.demonstratedCuspCount, null);
  assert.equal(shade.actual.displayColorOverride, '#aabbcc');
  assert.equal(shade.actual.displayRoughnessOverride, .3);
  assert.equal(shade.actual.measuredShade, null);
  assert.equal(shade.actual.shadeMatch, null);
  assert.equal(shade.status, 'unknown');
});

test('legacy tissue intersections retain unknown crossing classification instead of a fabricated zero', () => {
  const s = spec(), measurement = { score: 0, objectiveScore: 0, morphologyPenalty: 0, surfaces: [{ id: 'legacy-tissue', role: 'tissue', targetGap: 0,
    weight: 1, targetTriangles: 2, samples: 2, sampledMinDistance: 0, sampledRmsGapError: 0, nearSamples: 2,
    intersectingTriangles: 2, intersectionTestedTriangles: 2, intersectionComplete: true }] };
  const report = evaluate(s, { measurement }), cervical = issue(report, 'cervical-emergence');
  assert.equal(cervical.actual.tissueCrossingObserved, null);
  assert.equal(cervical.actual.unclassifiedTissueIntersectingTriangles, 2);
  assert.match(cervical.summary, /unclassified/);
  assert.equal(cervical.status, 'unknown');
  assert.equal(report.criteria.find(item => item.id === 'interference').status, 'fail');
  assert.equal(restorationQualitySchema.safeParse(report).success, true);
});

test('schema deliberately reads legacy v1 and new reports but rejects automatic or fabricated clinical passes', () => {
  const report = evaluate(), legacy = structuredClone(report);
  delete legacy.guardrails;
  assert.deepEqual(restorationQualitySchema.parse(legacy), legacy);
  assert.deepEqual(restorationQualitySchema.parse(JSON.parse(JSON.stringify(report))), report);
  const pass = structuredClone(report.guardrails);
  pass.issues.find(item => item.id === 'subcrestal-placement').status = 'pass';
  assert.equal(restorationGuardrailsSchema.safeParse(pass).success, false);
  const automatic = structuredClone(report.guardrails);
  automatic.issues[0].suggestions[0].automatic = true;
  assert.equal(restorationGuardrailsSchema.safeParse(automatic).success, false);
  const missing = structuredClone(report.guardrails);
  missing.issues[6] = missing.issues[5];
  assert.equal(restorationGuardrailsSchema.safeParse(missing).success, false);
});

test('schema rejects fabricated clinical fields, invalid clinical targets and contradictory dimensions', () => {
  const report = evaluate();
  for (const [id, key, value] of [['shade', 'shadeMatch', true], ['anatomy', 'toothIdentityReviewed', true],
    ['subcrestal-placement', 'measuredSubcrestalDepthMm', 1.5], ['adjacent-root-clearance', 'verifiedMmPerUnit', 1], ['anatomy', 'identityConfirmed', true]]) {
    const changed = structuredClone(report);
    issue(changed, id).actual[key] = value;
    assert.equal(restorationQualitySchema.safeParse(changed).success, false, `${id}.${key}`);
  }
  for (const target of [{ value: -1, units: 'mm', provenance: 'unconfirmed-case-feedback' },
    { value: 1.5, units: 'file units (u)', provenance: 'unconfirmed-case-feedback' },
    { value: 1.5, units: 'mm', provenance: 'engineering-prototype' }, { value: 1.5, units: 'mm', provenance: 'not-established' }]) {
    const changed = structuredClone(report);
    Object.assign(issue(changed, 'subcrestal-placement').target, target);
    assert.equal(restorationQualitySchema.safeParse(changed).success, false, JSON.stringify(target));
  }
  for (const mutate of [
    value => { value.guardrails.componentExtents[0].extents.base = 100; },
    value => { value.guardrails.componentExtents[1].extents.occlusal = 99; },
    value => { issue(value, 'dimensions').actual['crown.mesiodistal'] = 99; },
    value => { value.crownExtents.mesiodistal = 99; },
  ]) {
    const changed = structuredClone(report); mutate(changed);
    assert.equal(restorationQualitySchema.safeParse(changed).success, false);
  }
});
