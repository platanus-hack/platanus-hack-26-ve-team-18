import test from 'node:test';
import assert from 'node:assert/strict';
import { generateRestoration, restorationCrownShape } from '../src/restoration-geometry.ts';
import {
  DEFAULT_QUALITY_TOLERANCES, QUALITY_RULES, compareQualityReports, evaluateRestorationQuality, measureCrownExtents,
  qualityContextFromSite, qualityNeighborFromSegment,
} from '../src/restoration-quality.ts';

function spec(crown = {}, abutment = {}) {
  return { version: 'implant-assembly/v1', fdi: 36, parentPartId: 'synthetic', frame: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], up: [0, 0, 1] },
    parameters: { fixture: { radius: 1.1, length: 5, depth: .4, taper: .3 },
      abutment: { radius: .8, height: 2.1, emergenceRadius: 1.3, angleX: 0, angleY: 0, ...abutment },
      crown: { width: 5.2, depth: 4.6, height: 3.5, cuspHeight: 1.1, rotation: 0, ...crown } },
    anatomy: 'molar', provenance: 'hypothesized', units: 'file units (u)', source: 'Synthetic quality fixture, no patient data' };
}
/** Donor anatomy whose source dimensions equal the requested scales (isotropic). */
function donorSpec(crown = {}, abutment = {}) {
  const result = spec(crown, abutment);
  const shape = restorationCrownShape(result);
  shape.source = { ...shape.source, kind: 'patient-donor', donorFdi: 46, donorPartId: 'synthetic', donorToothId: 1, mirrored: true, faceCount: 120 };
  shape.dims = [5.2, 4.6, 3.5];
  return { ...result, crownShape: shape };
}
const neighbor = (side, md = 5.2, bl = 4.6, height = 6.7) => ({ id: `T-${side}`, side, mesiodistal: md, buccolingual: bl, height, method: 'synthetic segment', provenance: 'measured' });
function context(overrides = {}) {
  return { version: 'restoration-quality-context/v1', units: 'file units (u)', neighbors: [neighbor('mesial'), neighbor('distal')],
    gapWidth: { value: 5.2 / .97, method: 'synthetic surface envelope', provenance: 'measured' },
    availableHeight: { value: 6.7 / .98, method: 'synthetic headroom', provenance: 'measured' },
    expectedProximalSides: ['mesial', 'distal'], bitePoseVerified: true, ...overrides };
}
const surface = (id, role, extra = {}) => ({ id, role, targetGap: .05, weight: 1, targetTriangles: 2, samples: 100, sampledMinDistance: .06, sampledRmsGapError: .01, nearSamples: 1,
  intersectingTriangles: 0, intersectionTestedTriangles: 2, intersectionComplete: true, transverseCrossingTriangles: 0, touchingOrAmbiguousTriangles: 0, ...extra });
const antagonist = (id = 'opposing', extra = {}) => surface(id, 'antagonist', { occlusalRaySamples: 100, occlusalRayHits: 80, sampledOcclusalGap: .1, ...extra });
function measurement(surfaces, score = 1) {
  return { score, objectiveScore: score, morphologyPenalty: 0, surfaces: surfaces ?? [
    surface('mesial', 'adjacent', { side: 'mesial' }), surface('distal', 'adjacent', { side: 'distal' }), antagonist(),
    surface('tissue', 'tissue', { targetGap: 0, sampledMinDistance: .01 }),
  ] };
}
const evaluate = (s, m, c, tolerances) => evaluateRestorationQuality({ spec: s, components: generateRestoration(s), measurement: m, context: c, tolerances });
const rule = (report, id) => report.criteria.find(criterion => criterion.id === id);
const revision = (report, parameter) => report.revisions.find(item => item.parameter === parameter);

test('emitted crown extents are measured in the site frame, not read from parameter names', () => {
  const s = spec({ rotation: 90 });
  const extents = measureCrownExtents(s, generateRestoration(s));
  // A 90° rotation swaps the emitted footprint even though width/depth parameters are unchanged.
  assert.ok(Math.abs(extents.mesiodistal - 4.6) < .05 && Math.abs(extents.buccolingual - 5.2) < .05, JSON.stringify(extents));
  assert.ok(Math.abs(extents.base + s.parameters.abutment.emergenceRadius * .5) < 1e-5 && extents.top > extents.base);
  assert.equal(measureCrownExtents(s, []), null);
});

test('consistent donor geometry passes the former checks but awaits the independent emitted support audit', () => {
  const report = evaluate(donorSpec(), measurement(), context());
  assert.deepEqual(report.criteria.map(criterion => [criterion.id, criterion.status]), QUALITY_RULES.map(id => [id, id === 'component-support' ? 'unknown' : 'pass']));
  assert.equal(report.status, 'unknown');
  // Engineering success does not pass clinical/anatomical dentist feedback.
  assert.equal(report.guardrails.status, 'unknown');
  assert.equal(report.guardrails.issues.find(issue => issue.id === 'anatomy').status, 'unknown');
  assert.deepEqual(report.revisions, []);
  assert.equal(report.units, 'file units (u)');
  assert.deepEqual(report.tolerances, { ...DEFAULT_QUALITY_TOLERANCES });
});

test('missing evidence is unknown, never pass', () => {
  const report = evaluate(donorSpec(), null, null);
  assert.equal(report.status, 'unknown');
  for (const id of ['relative-width', 'relative-depth', 'relative-height', 'space-occupancy', 'proximal-contacts', 'occlusal-contact', 'interference', 'conflicting-targets', 'component-presentation']) {
    assert.equal(rule(report, id).status, 'unknown', id);
  }
  assert.ok(report.limits.some(limit => /No neighbour\/space evidence/.test(limit)));
  // A procedural template never demonstrates realistic anatomy on its own.
  const template = evaluate(spec(), measurement(), context());
  assert.equal(rule(template, 'anatomy').status, 'unknown');
  assert.equal(template.status, 'unknown');
});

test('a low optimizer score cannot buy quality: skewed widths/depths and open contacts fail', () => {
  const s = donorSpec({ width: 7.2, depth: 3.4 });
  const m = measurement([surface('mesial', 'adjacent', { side: 'mesial', sampledMinDistance: .6 }), surface('distal', 'adjacent', { side: 'distal', sampledMinDistance: .6 }), antagonist()], 0);
  const report = evaluate(s, m, context());
  assert.equal(report.status, 'fail');
  for (const id of ['relative-width', 'relative-depth', 'space-occupancy', 'anatomy', 'proximal-contacts']) assert.equal(rule(report, id).status, 'fail', id);
  assert.match(rule(report, 'relative-width').reasons[0], /×the mean|× the mean/);
  assert.ok(rule(report, 'anatomy').reasons.some(reason => /proportion/.test(reason)));
  assert.ok(rule(report, 'anatomy').reasons.some(reason => /distort/.test(reason)));
  // Open contacts beyond the space ceiling are a preserved conflict; the width revision only narrows.
  const width = revision(report, 'crown.width');
  assert.ok(width.proposed < width.current && width.proposed >= width.current * .9 - 1e-12);
  assert.ok(!width.rules.includes('proximal-contacts'));
  assert.ok(rule(report, 'conflicting-targets').reasons.some(reason => /open while the mesiodistal extent/.test(reason)));
  const depth = revision(report, 'crown.depth');
  assert.ok(depth.proposed > depth.current && depth.proposed <= depth.current * 1.1 + 1e-12);
});

test('both open proximal contacts propose a bounded width increase capped by measured space', () => {
  const s = donorSpec({ width: 4.9 });
  const m = measurement([surface('mesial', 'adjacent', { side: 'mesial', sampledMinDistance: .3 }), surface('distal', 'adjacent', { side: 'distal', sampledMinDistance: .3 }), antagonist()]);
  const report = evaluate(s, m, context());
  assert.equal(rule(report, 'proximal-contacts').status, 'fail');
  assert.match(rule(report, 'proximal-contacts').reasons.join(' '), /mesial contact open/);
  const width = revision(report, 'crown.width');
  assert.ok(width.proposed > width.current && width.proposed <= width.current * 1.1 + 1e-12);
  const gap = 5.2 / .97;
  assert.ok(width.proposed * report.crownExtents.mesiodistal / width.current <= gap + 1e-6);
  // At the space ceiling, the same open contacts are a preserved conflict instead.
  const full = donorSpec({ width: 5.2 / .97 * .999 });
  const blocked = evaluate(full, m, context({ gapWidth: { value: measureCrownExtents(full, generateRestoration(full)).mesiodistal, method: 'synthetic', provenance: 'measured' } }));
  assert.equal(rule(blocked, 'conflicting-targets').status, 'fail');
  assert.ok(rule(blocked, 'conflicting-targets').reasons.some(reason => /ceiling/.test(reason)));
  assert.ok(!blocked.revisions.some(item => item.parameter === 'crown.width' && item.proposed > item.current));
});

test('one open side with an opposite crossing proposes a bounded abutment slope shift', () => {
  const m = measurement([surface('mesial', 'adjacent', { side: 'mesial', sampledMinDistance: .5 }),
    surface('distal', 'adjacent', { side: 'distal', sampledMinDistance: 0, intersectingTriangles: 6, transverseCrossingTriangles: 4 }), antagonist()]);
  const report = evaluate(donorSpec(), m, context());
  assert.equal(rule(report, 'interference').status, 'fail');
  assert.equal(rule(report, 'proximal-contacts').status, 'fail');
  const shift = revision(report, 'abutment.angleY');
  assert.ok(shift.proposed > 0 && shift.proposed <= DEFAULT_QUALITY_TOLERANCES.maxRevisionAngle);
  // A mirrored mesial sign reverses the slope direction.
  const mirrored = evaluate({ ...donorSpec(), anatomicalSigns: { mesial: -1, buccal: 1 } }, m, context());
  assert.ok(revision(mirrored, 'abutment.angleY').proposed < 0);
});

test('occlusal pass requires an explicitly verified bite pose', () => {
  for (const c of [context({ bitePoseVerified: false }), context({ bitePoseVerified: undefined })]) {
    const report = evaluate(donorSpec(), measurement(), c);
    assert.equal(rule(report, 'occlusal-contact').status, 'unknown');
    assert.notEqual(report.status, 'pass');
  }
  assert.equal(rule(evaluate(donorSpec(), measurement(), null), 'occlusal-contact').status, 'unknown');
});

test('each antagonist target is judged on its own rays', () => {
  const surfaces = (second) => [surface('mesial', 'adjacent', { side: 'mesial' }), surface('distal', 'adjacent', { side: 'distal' }), antagonist('a'), antagonist('b', second)];
  // One good target does not hide another target with no ray hits.
  const missed = evaluate(donorSpec(), measurement(surfaces({ occlusalRayHits: 0, sampledOcclusalGap: null })), context());
  assert.equal(rule(missed, 'occlusal-contact').status, 'unknown');
  // Pooled coverage would be 0.45; the low-coverage target still fails.
  const sparse = evaluate(donorSpec(), measurement(surfaces({ occlusalRayHits: 10, sampledOcclusalGap: .1 })), context());
  assert.equal(rule(sparse, 'occlusal-contact').status, 'fail');
  assert.match(rule(sparse, 'occlusal-contact').reasons.join(' '), /b: antagonist coverage underfill/);
  assert.equal(rule(sparse, 'occlusal-contact').measured.occlusalCoverage, .1);
  // A close gap on one target does not satisfy an open gap on another.
  const open = evaluate(donorSpec({ height: 3.2 }), measurement(surfaces({ sampledOcclusalGap: 1 })), context());
  assert.equal(rule(open, 'occlusal-contact').status, 'fail');
  const height = revision(open, 'crown.height');
  assert.ok(height.proposed > height.current && height.proposed <= height.current * 1.1 + 1e-12);
});

test('vertical overfill and antagonist crossings reduce height; incomplete zero intersections stay unknown', () => {
  const report = evaluate(donorSpec(), measurement([surface('mesial', 'adjacent', { side: 'mesial' }), surface('distal', 'adjacent', { side: 'distal' }),
    antagonist('opposing', { transverseCrossingTriangles: 3, intersectingTriangles: 3 })]), context({ availableHeight: { value: 6, method: 'synthetic', provenance: 'measured' } }));
  assert.equal(rule(report, 'space-occupancy').status, 'fail');
  assert.equal(rule(report, 'occlusal-contact').status, 'fail');
  assert.ok(revision(report, 'crown.height').proposed < report.revisions.find(r => r.parameter === 'crown.height').current);
  const capped = evaluate(donorSpec(), measurement([surface('mesial', 'adjacent', { side: 'mesial' }), surface('distal', 'adjacent', { side: 'distal' }), antagonist(),
    surface('other', 'other-tooth', { intersectionComplete: false })]), context());
  assert.equal(rule(capped, 'interference').status, 'unknown');
  const touched = evaluate(donorSpec(), measurement([surface('mesial', 'adjacent', { side: 'mesial' }), surface('distal', 'adjacent', { side: 'distal' }), antagonist(),
    surface('other', 'other-tooth', { intersectingTriangles: 2, touchingOrAmbiguousTriangles: 2 })]), context());
  assert.equal(rule(touched, 'interference').status, 'fail');
});

test('space and neighbour ranges that cannot overlap are reported as conflicting targets', () => {
  const report = evaluate(donorSpec(), measurement(), context({ gapWidth: { value: 2, method: 'synthetic', provenance: 'measured' } }));
  assert.equal(rule(report, 'conflicting-targets').status, 'fail');
  assert.match(rule(report, 'conflicting-targets').reasons[0], /do not overlap/);
  assert.equal(rule(report, 'component-presentation').status, 'fail');
  const tall = evaluate(donorSpec(), measurement(), context({ neighbors: [neighbor('mesial', 5.2, 4.6, 12), neighbor('distal', 5.2, 4.6, 12)] }));
  assert.ok(rule(tall, 'conflicting-targets').reasons.some(reason => /height floor/.test(reason)));
});

test('pillar presentation keeps abutment and emergence inside the crown footprint', () => {
  const report = evaluate(donorSpec({}, { radius: 2.5, emergenceRadius: 2.6, angleY: 30 }), measurement(), context());
  const presentation = rule(report, 'component-presentation');
  assert.equal(presentation.status, 'fail');
  assert.equal(presentation.reasons.length, 4);
  assert.ok(revision(report, 'abutment.radius').proposed < 2.5);
  assert.ok(revision(report, 'abutment.emergenceRadius').proposed < 2.6);
  assert.ok(report.revisions.length <= DEFAULT_QUALITY_TOLERANCES.maxRevisions);
});

test('a broad body footprint cannot excuse pilar protrusion through cervical narrowing', () => {
  for (const input of [spec({}, { radius: 2 }), { ...spec({}, { radius: 1.2 }), contour: { cervicalScale: .5 } }]) {
    const report = evaluate(input, measurement(), context());
    const presentation = rule(report, 'component-presentation');
    assert.equal(presentation.status, 'fail');
    assert.ok(presentation.measured.sampledPilarProtrusion > 0);
    assert.match(presentation.reasons.join(' '), /protrude.*cervical\/collar/);
  }
});

test('tolerances are disclosed, configurable and validated', () => {
  const strict = evaluate(donorSpec(), measurement(), context(), { widthToNeighbor: [1.05, 1.2] });
  assert.equal(rule(strict, 'relative-width').status, 'fail');
  assert.deepEqual(strict.tolerances.widthToNeighbor, [1.05, 1.2]);
  assert.throws(() => evaluate(donorSpec(), null, null, { gapOccupancy: [1.1, .9] }), /gapOccupancy/);
  assert.throws(() => evaluate(donorSpec(), null, null, { maxRevisions: 99 }), /maxRevisions/);
});

test('evaluation is deterministic and ranks reports by failures then unknowns', () => {
  const a = evaluate(donorSpec(), measurement(), context());
  assert.deepEqual(evaluate(donorSpec(), measurement(), context()), a);
  const b = evaluate(donorSpec({ width: 7.2 }), measurement(), context());
  const c = evaluate(donorSpec(), null, null);
  assert.ok(compareQualityReports(a, b) < 0 && compareQualityReports(b, a) > 0);
  assert.ok(compareQualityReports(a, c) < 0);
  assert.equal(compareQualityReports(a, a), 0);
});

test('site and segment helpers keep only surface-derived space evidence', () => {
  const measured = (value, method) => ({ value, unit: 'file units (u)', method, provenance: 'measured' });
  const site = { adjacent: { mesial: { toothId: 1 }, distal: null }, opposing: { partId: 'lower', teeth: [], poseVerified: false },
    space: { proximalGap: measured(5, 'Centroid distance (legacy)'), vertical: measured(6, 'sampled headroom'), mesiodistal: measured(7, 'arc'), buccolingual: measured(4, 'bl'), crownHeight: measured(5, 'height') } };
  const n = qualityNeighborFromSegment({ id: 3, fdi: 35, mdWidth: 5, blWidth: 0, height: 4 }, 'mesial', 'upper');
  assert.deepEqual([n.id, n.mesiodistal, n.buccolingual, n.height], ['upper:T3:FDI-35', 5, null, 4]);
  const c = qualityContextFromSite(site, [n]);
  assert.equal(c.gapWidth, null);
  assert.equal(c.availableHeight.provenance, 'hypothesized');
  assert.deepEqual(c.expectedProximalSides, ['mesial']);
  assert.equal(c.bitePoseVerified, false);
  assert.ok(JSON.parse(JSON.stringify(c)));
  const surfaceGap = qualityContextFromSite({ ...site, space: { ...site.space, proximalGap: measured(5, 'Symmetric surface envelope') } }, []);
  assert.equal(surfaceGap.gapWidth.value, 5);
});

test('hypothesized neighbour or space evidence cannot upgrade any rule to pass, but failures still fail', () => {
  const hypothesized = (value) => ({ ...value, provenance: 'hypothesized' });
  const c = context({ neighbors: [hypothesized(neighbor('mesial')), hypothesized(neighbor('distal'))],
    gapWidth: hypothesized(context().gapWidth), availableHeight: hypothesized(context().availableHeight) });
  const report = evaluate(donorSpec(), measurement(), c);
  assert.equal(report.status, 'unknown');
  for (const id of ['relative-width', 'relative-depth', 'relative-height', 'space-occupancy', 'anatomy', 'conflicting-targets', 'component-presentation']) {
    assert.equal(rule(report, id).status, 'unknown', id);
  }
  // Evidence that does not depend on neighbours/space still passes on its own.
  for (const id of ['proximal-contacts', 'occlusal-contact', 'interference']) assert.equal(rule(report, id).status, 'pass', id);
  // One hypothesized neighbour among measured ones still blocks a pass.
  const mixed = evaluate(donorSpec(), measurement(), context({ neighbors: [neighbor('mesial'), hypothesized(neighbor('distal'))] }));
  assert.equal(rule(mixed, 'relative-width').status, 'unknown');
  assert.equal(rule(mixed, 'space-occupancy').status, 'pass');
  // A missing provenance label is not treated as measured.
  const unlabeled = evaluate(donorSpec(), measurement(), context({ gapWidth: { value: 5.2 / .97, method: 'legacy' } }));
  assert.equal(rule(unlabeled, 'space-occupancy').status, 'unknown');
  // Hypothesized evidence that is violated still fails.
  const skewed = evaluate(donorSpec({ width: 7.2, depth: 3.4 }), measurement(), c);
  for (const id of ['relative-width', 'relative-depth', 'space-occupancy', 'anatomy']) assert.equal(rule(skewed, id).status, 'fail', id);
  assert.equal(skewed.status, 'fail');
});

test('site context labels only explicitly measured surface evidence as measured', () => {
  const value = (provenance, method = 'Symmetric surface envelope') => ({ value: 5, unit: 'file units (u)', method, ...(provenance ? { provenance } : {}) });
  const site = (gap, vertical, poseVerified) => ({ adjacent: { mesial: { toothId: 1 }, distal: { toothId: 2 } }, opposing: { partId: 'lower', teeth: [], poseVerified },
    space: { proximalGap: gap, vertical, mesiodistal: value('measured'), buccolingual: value('hypothesized'), crownHeight: value('hypothesized') } });
  for (const provenance of [undefined, 'unknown', 'hypothesized']) {
    const c = qualityContextFromSite(site(value(provenance), value(provenance), true), []);
    assert.equal(c.gapWidth.provenance, 'hypothesized', String(provenance));
    assert.equal(c.availableHeight.provenance, 'hypothesized', String(provenance));
  }
  const measured = qualityContextFromSite(site(value('measured'), value('measured'), true), []);
  assert.deepEqual([measured.gapWidth.provenance, measured.availableHeight.provenance, measured.bitePoseVerified], ['measured', 'measured', true]);
  assert.equal(qualityContextFromSite(site(value('measured'), value('measured'), false), []).availableHeight.provenance, 'hypothesized');
});

test('a capped intersection test with touches but no transverse crossings is unknown, not pass', () => {
  const flanks = [surface('mesial', 'adjacent', { side: 'mesial' }), surface('distal', 'adjacent', { side: 'distal' }), antagonist()];
  for (const role of ['adjacent', 'antagonist', 'tissue', 'source-arch']) {
    const touched = surface('target', role, { intersectingTriangles: 3, touchingOrAmbiguousTriangles: 3, transverseCrossingTriangles: 0, intersectionComplete: false });
    const report = evaluate(donorSpec(), measurement([...flanks, touched]), context());
    assert.equal(rule(report, 'interference').status, 'unknown', role);
    assert.ok(rule(report, 'interference').reasons.some(reason => /capped/.test(reason)), role);
  }
  // A complete adjacent touch is an expected contact and still passes.
  const complete = evaluate(donorSpec(), measurement([surface('mesial', 'adjacent', { side: 'mesial', intersectingTriangles: 3, touchingOrAmbiguousTriangles: 3 }),
    surface('distal', 'adjacent', { side: 'distal' }), antagonist()]), context());
  assert.equal(rule(complete, 'interference').status, 'pass');
  // Observed crossings and non-flanking touches still fail when the test was capped.
  const crossed = evaluate(donorSpec(), measurement([...flanks, surface('tissue', 'tissue', { intersectingTriangles: 2, transverseCrossingTriangles: 2, intersectionComplete: false })]), context());
  assert.equal(rule(crossed, 'interference').status, 'fail');
  const other = evaluate(donorSpec(), measurement([...flanks, surface('other', 'other-tooth', { intersectingTriangles: 2, touchingOrAmbiguousTriangles: 2, intersectionComplete: false })]), context());
  assert.equal(rule(other, 'interference').status, 'fail');
});

test('close sampled gaps cannot pass contacts with incomplete or unclassified crossing evidence', () => {
  for (const evidence of [{ intersectionComplete: false }, { transverseCrossingTriangles: undefined }, { samples: 0 }]) {
    const report = evaluate(donorSpec(), measurement([surface('mesial', 'adjacent', { side: 'mesial', ...evidence }),
      surface('distal', 'adjacent', { side: 'distal' }), antagonist()]), context());
    assert.equal(rule(report, 'proximal-contacts').status, 'unknown');
  }
  for (const evidence of [{ intersectionComplete: false }, { transverseCrossingTriangles: undefined },
    { occlusalRaySamples: 0 }, { occlusalRayHits: 101 }, { occlusalRaySamples: NaN }]) {
    const report = evaluate(donorSpec(), measurement([surface('mesial', 'adjacent', { side: 'mesial' }),
      surface('distal', 'adjacent', { side: 'distal' }), antagonist('opposing', evidence)]), context());
    assert.equal(rule(report, 'occlusal-contact').status, 'unknown');
    assert.notEqual(report.status, 'pass');
  }
});

test('a close patch on one same-side target cannot hide a second open target', () => {
  const report = evaluate(donorSpec(), measurement([surface('mesial-close', 'adjacent', { side: 'mesial', sampledMinDistance: .04 }),
    surface('mesial-open', 'adjacent', { side: 'mesial', sampledMinDistance: .8 }),
    surface('distal', 'adjacent', { side: 'distal' }), antagonist()]), context());
  assert.equal(rule(report, 'proximal-contacts').status, 'fail');
  assert.equal(rule(report, 'proximal-contacts').measured.mesialExcess, .75);
  assert.equal(rule(report, 'conflicting-targets').status, 'fail');
});
