import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptsFitCandidate } from '../src/restoration-fit-selection.ts';

// Composite interference already fails because of an unrelated target, so the
// rule-level comparison cannot see per-target evidence changes.
const failing = { criteria: [{ id: 'interference', status: 'fail' }], crownExtents: null, tolerances: { proximalOpenFraction: .03, occlusalOpenFraction: .05 } };
const unknown = { ...failing, criteria: [{ id: 'interference', status: 'unknown' }] };
const target = (extra = {}) => ({ id: 'target', role: 'tissue', targetGap: 0, sampledMinDistance: 0, intersectingTriangles: 0,
  transverseCrossingTriangles: 0, intersectionComplete: true, ...extra });
const crossedElsewhere = { id: 'other', role: 'other-tooth', targetGap: 0, sampledMinDistance: 0, intersectingTriangles: 5, transverseCrossingTriangles: 5, intersectionComplete: true };
const fit = (score, surface) => ({ score, surfaces: [surface, crossedElsewhere] });

test('a capped zero-crossing candidate cannot discard complete zero-crossing evidence on a target', () => {
  for (const [label, best] of [['clear', target()], ['touching', target({ intersectingTriangles: 4 })]]) {
    for (const next of [target({ intersectionComplete: false }), target({ intersectingTriangles: 4, intersectionComplete: false })]) {
      assert.equal(acceptsFitCandidate(fit(1, next), fit(2, best), failing, failing), false, label);
      assert.equal(acceptsFitCandidate(fit(1, next), fit(2, best), unknown, unknown), false, label);
      // Legacy selection only rejects a new raw intersection on a previously untouched target.
      assert.equal(acceptsFitCandidate(fit(1, next), fit(2, best)), !(best.intersectingTriangles === 0 && next.intersectingTriangles > 0), `${label}: legacy selection is unchanged`);
    }
  }
  // Complete evidence may be replaced by complete evidence.
  assert.equal(acceptsFitCandidate(fit(1, target({ intersectingTriangles: 2 })), fit(2, target({ intersectingTriangles: 4 })), failing, failing), true);
  // Incomplete baseline evidence is not lost by another incomplete test.
  assert.equal(acceptsFitCandidate(fit(1, target({ intersectingTriangles: 2, intersectionComplete: false })),
    fit(2, target({ intersectingTriangles: 3, intersectionComplete: false })), failing, failing), true);
});

test('a capped test cannot turn an observed transverse crossing into zero crossings, even with touches', () => {
  const best = fit(2, target({ intersectingTriangles: 6, transverseCrossingTriangles: 6 }));
  for (const next of [target({ intersectingTriangles: 4, transverseCrossingTriangles: 0, intersectionComplete: false }),
    target({ intersectingTriangles: 0, transverseCrossingTriangles: 0, intersectionComplete: false })]) {
    assert.equal(acceptsFitCandidate(fit(1, next), best, failing, failing), false);
    assert.equal(acceptsFitCandidate(fit(1, next), best), false, 'Observed crossings need complete follow-up evidence even without a quality report.');
  }
  // Even an observed reduction cannot discard a previously complete audit.
  assert.equal(acceptsFitCandidate(fit(1, target({ intersectingTriangles: 3, transverseCrossingTriangles: 3, intersectionComplete: false })), best, failing, failing), false);
  // A lower capped count cannot establish improvement over observed crossings.
  assert.equal(acceptsFitCandidate(fit(1, target({ intersectingTriangles: 3, transverseCrossingTriangles: 3, intersectionComplete: false })),
    fit(2, { ...best.surfaces[0], intersectionComplete: false }), failing, failing), false);
  // A complete test may establish removal of the crossing.
  assert.equal(acceptsFitCandidate(fit(1, target({ intersectingTriangles: 4 })), best, failing, failing), true);
});

test('a lower score cannot buy extra crossings on a target that already fails', () => {
  const best = target({ intersectingTriangles: 140, transverseCrossingTriangles: 120 });
  const next = target({ intersectingTriangles: 200, transverseCrossingTriangles: 180 });
  for (const report of [failing, unknown]) {
    assert.equal(acceptsFitCandidate(fit(1, next), fit(100, best), report, report), false);
    assert.equal(acceptsFitCandidate(fit(1, { ...best, transverseCrossingTriangles: 119 }), fit(100, best), report, report), true);
    assert.equal(acceptsFitCandidate(fit(1, { ...best, transverseCrossingTriangles: undefined }), fit(100, best), report, report), false);
  }
});

test('candidate targets retain their original side, gap and audited component region', () => {
  const before = target({ side: 'mesial', role: 'adjacent', targetGap: .1, sampledMinDistance: .2, sourceComponents: ['crown'] });
  for (const change of [{ side: 'distal' }, { targetGap: .01 }, { sourceRegion: 'crown-body' }, { sourceComponents: ['crown', 'abutment'] }]) {
    assert.equal(acceptsFitCandidate(fit(1, { ...before, ...change }), fit(2, before), failing, failing), false);
  }
});

test('a composite space failure cannot hide worsening crown overfill on either axis', () => {
  const report = (md, vertical) => ({ ...failing, tolerances: { gapOccupancy: [.9, 1], heightOccupancyMax: 1 },
    criteria: [{ id: 'space-occupancy', status: 'fail', measured: { mesiodistalOccupancy: md, verticalOccupancy: vertical } }] });
  const baseline = fit(10, target()), next = fit(1, target());
  assert.equal(acceptsFitCandidate(next, baseline, report(1.2, 1.1), report(.98, 1.4)), false);
  assert.equal(acceptsFitCandidate(next, baseline, report(1.3, 1.1), report(1.2, 1.4)), false);
  assert.equal(acceptsFitCandidate(next, baseline, report(1.1, 1.2), report(1.2, 1.4)), true);
});

test('growing the crown cannot relax a previously satisfied contact bound', () => {
  for (const role of ['adjacent', 'antagonist']) {
    const quality = size => ({ ...failing, crownExtents: { mesiodistal: size, occlusal: size } });
    const previous = target({ role, targetGap: .05, sampledMinDistance: .19, sampledOcclusalGap: .29,
      occlusalRayHits: 20, occlusalRaySamples: 20 });
    const next = { ...previous, sampledMinDistance: .205, sampledOcclusalGap: .305 };
    assert.equal(acceptsFitCandidate(fit(1, next), fit(2, previous), quality(5.2), quality(5)), false, role);
  }
});

test('an existing sampled clearance shortfall cannot worsen while another target improves the score', () => {
  const previous = target({ targetGap: .05, sampledMinDistance: .04 });
  for (const [distance, accepted] of [[.001, false], [.04, true], [.049, true]]) {
    assert.equal(acceptsFitCandidate(fit(1, { ...previous, sampledMinDistance: distance }), fit(2, previous), failing, failing), accepted);
  }
});
