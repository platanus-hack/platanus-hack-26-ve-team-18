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
    assert.equal(acceptsFitCandidate(fit(1, next), best), true, 'Legacy selection is unchanged.');
  }
  // A capped test that still observes the crossing does not claim removal.
  assert.equal(acceptsFitCandidate(fit(1, target({ intersectingTriangles: 3, transverseCrossingTriangles: 3, intersectionComplete: false })), best, failing, failing), true);
  // A complete test may establish removal of the crossing.
  assert.equal(acceptsFitCandidate(fit(1, target({ intersectingTriangles: 4 })), best, failing, failing), true);
});
