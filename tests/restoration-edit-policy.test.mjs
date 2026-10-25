import test from 'node:test';
import assert from 'node:assert/strict';
import { generateRestoration } from '../src/restoration-geometry.ts';
import { evaluateRestorationQuality, measureCrownExtents } from '../src/restoration-quality.ts';
import { assertAgentEditPreservesEvidence, RestorationEditRejected } from '../src/restoration-edit-policy.ts';
import { fitRestorationToGoals } from '../src/restoration-goal-fitting.ts';

function spec() {
  const s = { version: 'implant-assembly/v1', fdi: 36, parentPartId: 'synthetic',
    frame: { origin: [0,0,0], u: [1,0,0], v: [0,1,0], up: [0,0,1] },
    parameters: { fixture: { radius: 1, length: 4, depth: 0, taper: .1 }, abutment: { radius: .8, height: 1, emergenceRadius: 1, angleX: 0, angleY: 0 }, crown: { width: 5, depth: 5, height: 4, cuspHeight: 0, rotation: 0 } },
    anatomy: 'molar', provenance: 'hypothesized', units: 'file units (u)', source: 'Synthetic policy case' };
  const e = measureCrownExtents(s, generateRestoration(s));
  s.qualityContext = { version: 'restoration-quality-context/v1', units: 'file units (u)', bitePoseVerified: true,
    neighbors: ['mesial','distal'].map(side => ({ id: side, side, mesiodistal: e.mesiodistal, buccolingual: e.buccolingual, height: e.top, provenance: 'measured', method: 'synthetic' })),
    gapWidth: { value: e.mesiodistal / .95, provenance: 'measured', method: 'synthetic' }, availableHeight: { value: e.top * 1.05, provenance: 'measured', method: 'synthetic' } };
  return s;
}
const surface = (id, side, gap = .1) => ({ id, role: 'adjacent', side, targetGap: .05, weight: 1, targetTriangles: 2, samples: 100, sampledMinDistance: gap, sampledRmsGapError: gap,
  nearSamples: 0, intersectingTriangles: 0, transverseCrossingTriangles: 0, touchingOrAmbiguousTriangles: 0, intersectionComplete: true, intersectionTestedTriangles: 2 });
function result(s, surfaces, score = 1) {
  const components = generateRestoration(s), measurement = { score, objectiveScore: score, morphologyPenalty: 0, surfaces };
  const quality = evaluateRestorationQuality({ spec: s, components, measurement, context: s.qualityContext });
  return { spec: s, components, history: [], report: { before: measurement, after: measurement, quality: { initial: quality, final: quality } } };
}
const revision = r => ({ spec: r.spec, fit: r.report, createdAt: '2026-10-24', warnings: [] });

test('an appearance-only exact edit does not need a lower score and preserves input', () => {
  const s = spec(), baseline = result(s, [surface('a','mesial'), surface('b','distal')]);
  const after = result({ ...s, appearance: { crown: { color: '#ddddcc', roughness: .3 } } }, baseline.report.after.surfaces);
  const saved = structuredClone(baseline);
  assert.doesNotThrow(() => assertAgentEditPreservesEvidence(revision(baseline), after));
  assert.deepEqual(baseline, saved);
});

test('a lower score cannot hide a larger deficit inside an already failing contact check', () => {
  const s = spec(), baseline = result(s, [surface('PRIVATE-A','mesial', .8), surface('PRIVATE-B','distal', .8)], 10);
  const after = result(s, [surface('PRIVATE-A','mesial', .9), surface('PRIVATE-B','distal', .7)], 1);
  assert.throws(() => assertAgentEditPreservesEvidence(revision(baseline), after), error => {
    assert.ok(error instanceof RestorationEditRejected);
    assert.ok(error.reasons.some(reason => /numerical error increased/.test(reason)));
    assert.doesNotMatch(error.reasons.join(' '), /PRIVATE/);
    assert.equal(error.candidate.measurement.score, 1); return true;
  });
});

test('targets may reorder but cannot disappear or lose complete touch-only evidence', () => {
  const s = spec(), a = surface('a','mesial'), b = surface('b','distal');
  a.intersectingTriangles = a.touchingOrAmbiguousTriangles = 4;
  const baseline = result(s, [a,b]);
  assert.doesNotThrow(() => assertAgentEditPreservesEvidence(revision(baseline), result(s, [b,a])));
  for (const surfaces of [[a], [{ ...a, intersectionComplete: false }, b], [{ ...a, transverseCrossingTriangles: 2 }, b]]) {
    assert.throws(() => assertAgentEditPreservesEvidence(revision(baseline), result(s, surfaces, .1)), RestorationEditRejected);
  }
});

test('intended component overlap is separate from external crossings without discarding relationship evidence', () => {
  const s = spec(), baseline = result(s, [surface('a', 'mesial'), surface('b', 'distal')]);
  for (const [source, target] of [['fixture', 'abutment'], ['fixture', 'crown'], ['abutment', 'crown'], ['abutment', 'adjacent']]) {
    const pair = { id: 'pair', source, target, targetId: target === 'adjacent' ? 'neighbor' : target,
      status: 'measured', intersectionComplete: true, transverseCrossingTriangles: 4 };
    const previous = structuredClone(baseline);
    previous.report.relationships = { relationships: [pair] };
    const candidate = structuredClone(previous);
    candidate.report.relationships.relationships[0].transverseCrossingTriangles = 8;
    if (target === 'adjacent') assert.throws(() => assertAgentEditPreservesEvidence(revision(previous), candidate), RestorationEditRejected);
    else assert.doesNotThrow(() => assertAgentEditPreservesEvidence(revision(previous), candidate));
    for (const patch of [{ intersectionComplete: false }, { transverseCrossingTriangles: null }, { target: 'crown', targetId: 'changed' }]) {
      const lost = structuredClone(candidate);
      Object.assign(lost.report.relationships.relationships[0], patch);
      assert.throws(() => assertAgentEditPreservesEvidence(revision(previous), lost), RestorationEditRejected);
    }
    previous.report.relationships.relationships[0].intersectionComplete = false;
    const erased = structuredClone(previous);
    erased.report.relationships.relationships[0].transverseCrossingTriangles = 1;
    assert.throws(() => assertAgentEditPreservesEvidence(revision(previous), erased), RestorationEditRejected);
  }
});

test('new dimension failure is rejected even when no contact targets are available', () => {
  const s = spec(), baseline = result(s, []), changed = structuredClone(s);
  changed.parameters.crown.width *= 2;
  assert.throws(() => assertAgentEditPreservesEvidence(revision(baseline), result(changed, [], .1)), RestorationEditRejected);
});

test('complete observed crossings cannot be replaced by a smaller capped crossing count', () => {
  const s = spec(), crossed = { ...surface('a','mesial'), intersectingTriangles: 6, transverseCrossingTriangles: 6 };
  const baseline = result(s, [crossed]), after = result(s, [{ ...crossed, intersectionComplete: false, intersectingTriangles: 3, transverseCrossingTriangles: 3 }], .1);
  assert.throws(() => assertAgentEditPreservesEvidence(revision(baseline), after), error => error instanceof RestorationEditRejected && error.reasons.some(reason => /complete target crossing audit became incomplete/.test(reason)));
});

test('missing old evaluation requires a baseline instead of silently accepting agent candidates', () => {
  const s = spec(), after = result(s, []);
  for (const fit of [undefined, { after: after.report.after }]) {
    assert.throws(() => assertAgentEditPreservesEvidence({ spec:s, fit }, after), error => error instanceof RestorationEditRejected && /measured baseline/.test(error.reasons[0]));
  }
});

async function goalBaseline() {
  const s = spec();
  s.parameters.crown.width = 4;
  delete s.qualityContext;
  return fitRestorationToGoals({ spec: s, surfaces: [], options: { maxCandidates: 1 } });
}

test('agent edits enforce inherited parameter bounds on the actual spec, including inclusive endpoints', async () => {
  const baseline = await goalBaseline(), saved = structuredClone(baseline);
  assert.deepEqual(baseline.report.goal.bounds['crown.width'], [3.4, 5.4]);
  for (const width of [3.4, 5.4, 3.3, 5.5]) {
    const changed = structuredClone(baseline.spec);
    changed.parameters.crown.width = width;
    const candidate = await fitRestorationToGoals({ spec: changed, surfaces: [], options: { maxCandidates: 1 }, goalContract: baseline.report.goal });
    if (width === 3.4 || width === 5.4) assert.doesNotThrow(() => assertAgentEditPreservesEvidence(revision(baseline), candidate));
    else assert.throws(() => assertAgentEditPreservesEvidence(revision(baseline), candidate), error => {
      assert.ok(error instanceof RestorationEditRejected);
      assert.ok(error.reasons.some(reason => /outside.*original goal bounds/.test(reason)));
      assert.equal(error.candidate.parameters.crown.width, width);
      return true;
    });
  }
  assert.deepEqual(baseline, saved);
});

test('goal bounds use default contour scales and reject malformed or nonfinite parameters safely', async () => {
  const baseline = await goalBaseline();
  // Keep reported measurements unchanged: bounds must inspect the actual spec.
  for (const key of ['cervicalScale', 'occlusalScale']) {
    const previous = structuredClone(baseline);
    previous.report.goal.bounds[key] = [.8, 1];
    const candidate = structuredClone(previous);
    delete candidate.spec.contour;
    assert.doesNotThrow(() => assertAgentEditPreservesEvidence(revision(previous), candidate));
    candidate.spec.contour = { [key]: .8 };
    assert.doesNotThrow(() => assertAgentEditPreservesEvidence(revision(previous), candidate));
    for (const value of [.79, 1.01, NaN, Infinity]) {
      candidate.spec.contour[key] = value;
      assert.throws(() => assertAgentEditPreservesEvidence(revision(previous), candidate), RestorationEditRejected);
    }
  }
  for (const [key, bounds] of [['crown.width.extra', [0, 10]], ['PRIVATE-unknown', [0, 10]], ['crown.width', [5.4, 3.4]], ['crown.width', [NaN, 5.4]], ['crown.width', [0, Infinity]]]) {
    const previous = structuredClone(baseline);
    previous.report.goal.bounds[key] = bounds;
    assert.throws(() => assertAgentEditPreservesEvidence(revision(previous), structuredClone(previous)), error => {
      assert.ok(error instanceof RestorationEditRejected);
      assert.doesNotMatch(error.reasons.join(' '), /PRIVATE/);
      return true;
    });
  }
  for (const width of [undefined, NaN, Infinity]) {
    const candidate = structuredClone(baseline);
    candidate.spec.parameters.crown.width = width;
    assert.throws(() => assertAgentEditPreservesEvidence(revision(baseline), candidate), RestorationEditRejected);
  }
});

test('an inherited goal contract cannot disappear or rebase even when reported measurements are unchanged', async () => {
  const baseline = await goalBaseline();
  baseline.report.goal.targetGaps = { 'PRIVATE-a': .05, 'PRIVATE-b': .1 };
  const reordered = structuredClone(baseline);
  reordered.report.goal.bounds = Object.fromEntries(Object.entries(reordered.report.goal.bounds).reverse());
  reordered.report.goal.targetGaps = Object.fromEntries(Object.entries(reordered.report.goal.targetGaps).reverse());
  reordered.report.goal.contract.rows.reverse();
  reordered.report.goal.evidenceRevision = 'goal-0000000000000000';
  reordered.report.goal.contract.rows[0].label = 'Updated presentation';
  reordered.report.goal.contract.rows[0].reason = 'Updated explanatory text';
  assert.doesNotThrow(() => assertAgentEditPreservesEvidence(revision(baseline), reordered));
  for (const change of [
    candidate => { delete candidate.report.goal; },
    candidate => { delete candidate.report.goal.contract; },
    candidate => { candidate.report.goal.bounds['crown.width'] = [3, 6]; },
    candidate => { delete candidate.report.goal.bounds['crown.width']; },
    candidate => { candidate.report.goal.targetGaps['PRIVATE-a'] = .2; },
    candidate => { delete candidate.report.goal.targetGaps['PRIVATE-a']; },
    candidate => { candidate.report.goal.contract.rows[0].upper = 100; },
    candidate => { candidate.report.goal.contract.rows[0].priority = 'clinical'; },
    candidate => { candidate.report.goal.contract.rows.pop(); },
  ]) {
    const candidate = structuredClone(baseline);
    change(candidate);
    assert.throws(() => assertAgentEditPreservesEvidence(revision(baseline), candidate), error => {
      assert.ok(error instanceof RestorationEditRejected);
      assert.ok(error.reasons.some(reason => /original goal contract/.test(reason)));
      assert.doesNotMatch(error.reasons.join(' '), /PRIVATE/);
      return true;
    });
  }
});
