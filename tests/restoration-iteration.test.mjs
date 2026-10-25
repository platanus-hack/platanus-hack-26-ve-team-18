import test from 'node:test';
import assert from 'node:assert/strict';
import { fitRestoration } from '../src/restoration-fitting.ts';
import { acceptsFitCandidate } from '../src/restoration-fit-selection.ts';
import { planOcclusalAdaptation } from '../src/restoration-adaptation.ts';
import { generateRestoration } from '../src/restoration-geometry.ts';

const spec = () => ({ version: 'implant-assembly/v1', fdi: 36, parentPartId: 'lower', frame: { origin: [0,0,0], u: [1,0,0], v: [0,1,0], up: [0,0,1] }, parameters: { fixture: { radius: 1, length: 5, depth: 0, taper: .1 }, abutment: { radius: .8, emergenceRadius: 1.1, height: 1, angleX: 0, angleY: 0 }, crown: { width: 4, depth: 4, height: 3, cuspHeight: 0, rotation: 0 } }, anatomy: 'molar', provenance: 'hypothesized', units: 'file units (u)', source: 'Synthetic bounded iteration regression', qualityContext: { version: 'restoration-quality-context/v1', units: 'file units (u)', neighbors: [{ id: 'lower:T1', mesiodistal: 5, buccolingual: 5, height: 5, method: 'Synthetic dimensions', provenance: 'measured' }], gapWidth: { value: 5, method: 'Synthetic facing envelope', provenance: 'measured' }, availableHeight: { value: 6, method: 'Synthetic headroom', provenance: 'measured' }, bitePoseVerified: true } });
const plane = (axis, value) => { const p=(a,b)=>{const v=[a,b];v.splice(axis,0,value);return v;}; return Float32Array.from([p(-10,-10),p(10,-10),p(10,10),p(-10,-10),p(10,10),p(-10,10)].flat()); };

test('removing capped touch-only evidence triggers a complete follow-up before candidate acceptance', async () => {
  const initial = spec(); delete initial.qualityContext;
  const crown = generateRestoration(initial).find(mesh => mesh.component === 'crown');
  let top = -Infinity;
  for (let i = 2; i < crown.positions.length; i += 3) top = Math.max(top, crown.positions[i]);
  const triangle = [-100, -100, top, 100, -100, top, 0, 100, top];
  const result = await fitRestoration({ spec: initial, surfaces: [{ id: 'opposing', role: 'antagonist', positions: Float32Array.from([...triangle, ...triangle]), targetGap: .1 }], options: { maxCandidates: 2, maxIntersectionTriangles: 1, samplesPerSurface: 32 } });
  const before = result.report.before.surfaces[0], after = result.report.after.surfaces[0];
  assert.equal(before.intersectionComplete, false);
  assert.ok(before.intersectingTriangles > 0);
  assert.equal(before.transverseCrossingTriangles, 0);
  assert.equal(result.history[1].accepted, true);
  assert.equal(after.intersectingTriangles, 0);
  assert.equal(after.intersectionComplete, true);
  assert.equal(after.verificationRetainedTriangles, 0);
  assert.equal(after.intersectionTestedTriangles, 2);
});

test('retrying locally adapted anatomy preserves its cut instead of stacking another distortion allowance', async () => {
  const initial = spec(); delete initial.qualityContext;
  const surfaces = [{ id: 'opposing', role: 'antagonist', positions: plane(2, 3.2), targetGap: .05 }];
  const proposal = await planOcclusalAdaptation(initial, surfaces);
  assert.equal(proposal.report.status, 'adapted');
  const retry = await fitRestoration({ spec: proposal.spec, surfaces: [{ ...surfaces[0], positions: plane(2, 3.15) }], options: { maxCandidates: 24, samplesPerSurface: 32 } });
  assert.equal(retry.report.anatomyCandidates.length, 1);
  assert.deepEqual(retry.spec.crownShape, proposal.spec.crownShape);
  assert.ok(retry.history.every(entry => entry.anatomyCandidate === 0));
  assert.ok(retry.report.limits.some(limit => limit.includes('do not stack further cuts')));
  assert.ok(retry.report.candidateAttempts <= 24);
});

test('independent revision instructions generate measured candidates inside one original bound and preserve passed checks', async () => {
  const initial = spec(), original = structuredClone(initial);
  const result = await fitRestoration({ spec: initial, surfaces: [
    { id: 'lower:mesial', role: 'adjacent', side: 'mesial', positions: plane(0,2.6), targetGap: .1 },
    { id: 'lower:distal', role: 'adjacent', side: 'distal', positions: plane(0,-2.6), targetGap: .1 },
    { id: 'upper:antagonist', role: 'antagonist', positions: plane(2,6), targetGap: .1 },
  ], options: { maxCandidates: 24, samplesPerSurface: 32 } });
  assert.deepEqual(initial, original);
  assert.equal(result.report.selectionPolicy, 'quality-gated/v1');
  assert.ok(result.history.some(entry => entry.revision?.reason.includes('space-occupancy')));
  assert.ok(result.report.quality.rounds >= 1 && result.report.quality.rounds <= 4);
  assert.ok(result.report.candidateAttempts <= 24);
  assert.notEqual(result.report.quality.final.status, 'pass', 'A procedural hypothesis cannot claim verified anatomy.');
  let best = result.history[0];
  for (const entry of result.history) {
    assert.deepEqual(entry.parameters.fixture, initial.parameters.fixture);
    assert.ok(entry.parameters.crown.width >= 4*.82 && entry.parameters.crown.width <= 4*1.18);
    assert.ok(entry.parameters.crown.height >= 3*.72 && entry.parameters.crown.height <= 3*1.2);
    if (!entry.candidate) continue;
    assert.equal(entry.accepted, acceptsFitCandidate(entry.measurement, best.measurement, entry.quality, best.quality));
    if (entry.accepted) best = entry;
  }
  assert.deepEqual(result.report.quality.final, best.quality);
});

test('an improved objective cannot purchase a failed quality rule or a new sampled gap deficit', () => {
  const previous = { score: 2, surfaces: [{ id: 'x', role: 'adjacent', targetGap: .1, sampledMinDistance: .11, intersectingTriangles: 0 }] };
  const next = { score: 1, surfaces: [{ ...previous.surfaces[0] }] };
  const good = { criteria: [{ id: 'relative-width', status: 'pass' }] }, bad = { criteria: [{ id: 'relative-width', status: 'fail' }] };
  assert.equal(acceptsFitCandidate(next, previous, bad, good), false);
  assert.equal(acceptsFitCandidate(next, previous, good, good), true);
  next.surfaces[0].sampledMinDistance = .05;
  assert.equal(acceptsFitCandidate(next, previous, good, good), false);
  assert.equal(acceptsFitCandidate(next, previous), true, 'Legacy histories retain their original selection semantics.');
});

test('a composite failure cannot hide a new open contact on another side or opposing target', () => {
  const quality = { criteria: [{ id: 'proximal-contacts', status: 'fail' }, { id: 'occlusal-contact', status: 'fail' }], crownExtents: { mesiodistal: 5, occlusal: 4 }, tolerances: { proximalOpenFraction: .03, occlusalOpenFraction: .05 } };
  for (const role of ['adjacent', 'antagonist']) {
    const satisfactory = { id: 'satisfied-target', role, targetGap: .1, sampledMinDistance: .15, intersectingTriangles: 0, intersectionComplete: true, occlusalRayHits: 10, occlusalRaySamples: 10, sampledOcclusalGap: .2 };
    const failing = { ...satisfactory, id: 'already-open-target', sampledMinDistance: 1, sampledOcclusalGap: 1 };
    const best = { score: 2, surfaces: [satisfactory, failing] };
    const next = { score: 1, surfaces: [{ ...satisfactory, sampledMinDistance: .9, sampledOcclusalGap: 1.8 }, failing] };
    assert.equal(acceptsFitCandidate(next, best, quality, quality), false, role);
  }
  const best = { score: 2, surfaces: [{ id: 'tissue', role: 'tissue', targetGap: 0, sampledMinDistance: 0, intersectingTriangles: 12, intersectionComplete: true }] };
  const next = { score: 1, surfaces: [{ ...best.surfaces[0], intersectingTriangles: 0, intersectionComplete: false }] };
  assert.equal(acceptsFitCandidate(next, best, quality, quality), false, 'A capped zero result cannot erase observed interference.');
  const touching = { score: 2, surfaces: [{ id: 'mesial', role: 'adjacent', targetGap: 0, sampledMinDistance: 0, intersectingTriangles: 4, transverseCrossingTriangles: 0, intersectionComplete: true }] };
  const crossed = { score: 1, surfaces: [{ ...touching.surfaces[0], intersectingTriangles: 36, transverseCrossingTriangles: 36 }] };
  assert.equal(acceptsFitCandidate(crossed, touching, quality, quality), false, 'A touching contact cannot become a transverse crossing while the opposite side already fails.');
});
