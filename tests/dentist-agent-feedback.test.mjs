import test from 'node:test';
import assert from 'node:assert/strict';
import { generateRestoration } from '../src/restoration-geometry.ts';
import { evaluateRestorationQuality } from '../src/restoration-quality.ts';
import { restorationFeedbackRows, restorationFitFeedbackRows, compareRestorationFeedback, feedbackError, restorationFeedbackTargetId } from '../src/restoration-feedback.ts';
import { applyAssistantRestorationEdit, buildRestorationAssistantSnapshot, compareRestorationRelationships, createRestorationAssistantTools, MAX_ASSISTANT_EDITS, projectRestorationRelationships } from '../src/restoration-assistant.ts';
import { RestorationEditRejected } from '../src/restoration-edit-policy.ts';
import { applyRestorationEdit } from '../src/restoration-edit.ts';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { MockLanguageModelV4 } from 'ai/test';
import { simulateReadableStream } from 'ai';
import { createAssistantMiddleware } from '../server/assistant.ts';
import { buildAssistantSnapshot } from '../src/assistant-context.ts';
import { emptyToothCase } from '../src/tooth-session.ts';

function spec() {
  return { version: 'implant-assembly/v1', fdi: 36, parentPartId: 'PRIVATE_SOURCE', source: 'PRIVATE_SCAN.ply',
    frame: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], up: [0, 0, 1] }, anatomy: 'molar', provenance: 'hypothesized', units: 'file units (u)',
    parameters: { fixture: { radius: 1, length: 4, depth: .5, taper: .2 }, abutment: { radius: .8, height: 2, emergenceRadius: 1, angleX: 0, angleY: 0 }, crown: { width: 4, depth: 5, height: 3, cuspHeight: .4, rotation: 90 } },
    qualityContext: { version: 'restoration-quality-context/v1', units: 'file units (u)',
      neighbors: [{ id: 'PRIVATE_NEIGHBOR', mesiodistal: 5, buccolingual: 4, height: 6, method: 'PRIVATE_METHOD', provenance: 'measured' }],
      gapWidth: { value: 8, method: 'Measured envelope', provenance: 'measured' }, availableHeight: { value: 9, method: 'Measured headroom', provenance: 'measured' }, bitePoseVerified: true,
      placementFeedback: { provenance: 'clinician-entered-case-feedback', source: 'PRIVATE_PATIENT_FEEDBACK', subcrestalDepthMm: 1.5, adjacentToothClearanceMm: 1.5 } } };
}
const surface = (id, role = 'adjacent', overrides = {}) => ({ id, role, ...(role === 'adjacent' ? { side: 'mesial' } : {}), targetGap: .1, targetProvenance: 'PRIVATE_TARGET_PROVENANCE', weight: 1,
  targetTriangles: 2, samples: 10, sampledMinDistance: .1, sampledRmsGapError: 0, nearSamples: 10,
  intersectingTriangles: 0, intersectionTestedTriangles: 2, intersectionComplete: true, transverseCrossingTriangles: 0,
  ...(role === 'antagonist' ? { occlusalRaySamples: 10, occlusalRayHits: 10, sampledOcclusalGap: .1 } : {}), ...overrides });
const measurement = surfaces => ({ score: 0, objectiveScore: 0, morphologyPenalty: 0, surfaces });
function make(input = spec(), fit = measurement([]), relationships) {
  const components = generateRestoration(input), quality = evaluateRestorationQuality({ spec: input, components, measurement: fit, context: input.qualityContext });
  return { id: 'PRIVATE_ASSEMBLY', spec: input, createdAt: '2026-10-24', warnings: [], fit: { before: fit, after: fit, relationships, quality: { final: quality } },
    parts: components.map(mesh => ({ ...mesh, id: `PRIVATE_${mesh.component}`, name: 'PRIVATE_NAME', fileName: 'PRIVATE_FILENAME.ply',
      restoration: { assemblyId: 'PRIVATE_ASSEMBLY', parentPartId: input.parentPartId, component: mesh.component } })) };
}
const rowsOf = item => restorationFeedbackRows(item.fit.quality.final, item.spec.parameters, item.fit.after, item.spec.qualityContext);
const get = (rows, id) => { const row = rows.find(row => row.id === id); assert.ok(row, id); return row; };
const targetRow = (rows, id, suffix) => { const row = rows.find(row => row.id.startsWith(restorationFeedbackTargetId(id)) && row.id.endsWith(suffix)); assert.ok(row, `${id} ${suffix}`); return row; };
const editFor = item => ({ assemblyId: 'restoration-1', expectedRevision: buildRestorationAssistantSnapshot([item]).assemblies[0].editRevision,
  edit: { reason: 'Reevaluate measured crown width.', parameters: { crown: { width: 4.2 } } } });

function relationships() {
  return { version: 'restoration-relationships/v1', units: 'file units (u)', termination: 'complete', durationMs: 1,
    relationships: [{ id: 'PRIVATE_RELATIONSHIP', source: 'fixture', target: 'adjacent', targetId: 'PRIVATE_ROOT_OR_TOOTH', side: 'mesial', status: 'measured', reason: 'PRIVATE_REASON',
      sourceTriangles: 12, targetTriangles: 20, samples: 12, sampledMinDistance: .5, sampledMedianDistance: 1, sampledP95Distance: 2,
      intersectionComplete: true, intersectingTriangles: 0, transverseCrossingTriangles: 0, touchingOrAmbiguousTriangles: 0,
      intersectionTestedTriangles: 20, intersectionPairTests: 240, intersectionTolerance: .0001, surfaceEvidence: 'none-observed', intersectionReason: 'PRIVATE_INTERSECTION_REASON' }],
    interfaces: [{ id: 'fixture-platform', source: 'fixture', target: 'abutment', status: 'measured', reason: 'PRIVATE_INTERFACE_REASON', nominalOrigin: [100, 200, 300], nominalNormal: [0, 0, 1],
      sourceAxialOffset: .1, targetAxialOffset: -.1, signedAxialGap: -.2, sourceDistanceToNominalOrigin: .3, targetDistanceToNominalOrigin: .4 }], limits: ['PRIVATE_LIMIT'] };
}

test('rows use actual evaluator keys and emitted geometry, with explicit units and controls', () => {
  const item = make(), report = item.fit.quality.final, rows = rowsOf(item);
  for (const [id, extent, ratio] of [['relative-width', 'mesiodistal', 'widthToNeighbor'], ['relative-depth', 'buccolingual', 'depthToNeighbor'], ['relative-height', 'top', 'heightToNeighbor']]) {
    const row = get(rows, id), measured = report.criteria.find(rule => rule.id === id).measured;
    assert.equal(row.actual, measured.emitted); assert.equal(row.actual, report.crownExtents[extent]);
    assert.equal(row.lower, measured.neighborMean * report.tolerances[ratio][0]); assert.equal(row.upper, measured.neighborMean * report.tolerances[ratio][1]);
    assert.equal(row.units, 'file units (u)'); assert.ok(row.controls.length); assert.ok(row.feedback);
  }
  assert.notEqual(get(rows, 'relative-width').actual, item.spec.parameters.crown.width);
  assert.equal(get(rows, 'component-presentation.abutment-slope').actual, 0);
  assert.equal(get(rows, 'component-presentation.abutment-radius').upper, report.criteria.find(rule => rule.id === 'component-presentation').measured.crownHalfFootprint);
  assert.equal(get(rows, 'space-occupancy.mesiodistal').lower, 8 * report.tolerances.gapOccupancy[0]);
  assert.equal(get(rows, 'space-occupancy.vertical').upper, 9 * report.tolerances.heightOccupancyMax);
});

test('strict upper-bound equality fails even though its signed numeric error is zero', () => {
  const item = make(), report = item.fit.quality.final, p = structuredClone(item.spec.parameters);
  const footprint = report.criteria.find(rule => rule.id === 'component-presentation').measured.crownHalfFootprint;
  p.abutment.radius = footprint; p.abutment.emergenceRadius = footprint; p.fixture.radius = 4;
  const rows = restorationFeedbackRows(report, p);
  for (const id of ['component-presentation.abutment-radius', 'component-presentation.emergence-radius', 'component-presentation.fixture-diameter']) {
    const row = get(rows, id); assert.equal(row.status, 'fail'); assert.equal(row.error, 0); assert.equal(row.exclusiveUpper, true); assert.match(row.feedback, /required </);
  }
  assert.equal(feedbackError(null, 1, 2), null); assert.equal(feedbackError(1, 2, 1), null); assert.equal(feedbackError(NaN, 0, 1), null);
});

test('every proximal and antagonist target exposes its failure even when aggregate minima look good', () => {
  const item = make(spec(), measurement([surface('PRIVATE_PROXIMAL_GOOD'), surface('PRIVATE_PROXIMAL_OPEN', 'adjacent', { sampledMinDistance: 2 }),
    surface('PRIVATE_BITE_GOOD', 'antagonist'), surface('PRIVATE_BITE_OPEN', 'antagonist', { sampledOcclusalGap: 2 })]));
  const rows = rowsOf(item), report = item.fit.quality.final;
  assert.equal(report.criteria.find(row => row.id === 'proximal-contacts').measured.mesialExcess, 1.9);
  assert.equal(report.criteria.find(row => row.id === 'occlusal-contact').measured.sampledOcclusalGap, .1);
  for (const [id, suffix] of [['PRIVATE_PROXIMAL_OPEN', '.proximal-gap'], ['PRIVATE_BITE_OPEN', '.occlusal-gap']]) {
    const row = targetRow(rows, id, suffix); assert.equal(row.actual, 2); assert.equal(row.target, .1); assert.ok(row.error > 0); assert.equal(row.status, 'fail');
  }
  assert.equal(targetRow(rows, 'PRIVATE_BITE_GOOD', '.occlusal-gap').status, 'pass');
  assert.equal(targetRow(rows, 'PRIVATE_PROXIMAL_GOOD', '.proximal-gap').status, 'pass');
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_/);
});

test('ray misses, incomplete intersections, unsided adjacency and unverified bites never pass', () => {
  const missed = make(spec(), measurement([surface('miss', 'antagonist', { occlusalRayHits: 0, sampledOcclusalGap: null })]));
  assert.equal(targetRow(rowsOf(missed), 'miss', '.occlusal-coverage').actual, 0);
  assert.equal(targetRow(rowsOf(missed), 'miss', '.occlusal-coverage').status, 'unknown');
  assert.equal(targetRow(rowsOf(missed), 'miss', '.occlusal-gap').actual, null);
  assert.equal(get(rowsOf(missed), 'occlusal-contact.coverage').status, 'unknown');
  for (const [id, role, overrides, suffix] of [['capped', 'adjacent', { intersectionComplete: false }, '.proximal-gap'],
    ['legacy', 'adjacent', { transverseCrossingTriangles: undefined }, '.crossings'], ['unsided', 'adjacent', { side: undefined }, '.proximal-gap']]) {
    assert.equal(targetRow(rowsOf(make(spec(), measurement([surface(id, role, overrides)]))), id, suffix).status, 'unknown');
  }
  const unverified = spec(); unverified.qualityContext.bitePoseVerified = false;
  assert.equal(targetRow(rowsOf(make(unverified, measurement([surface('bite', 'antagonist')]))), 'bite', '.occlusal-gap').status, 'unknown');
  const crossed = make(spec(), measurement([surface('crossed', 'antagonist', { transverseCrossingTriangles: 2, intersectionComplete: false })]));
  assert.equal(targetRow(rowsOf(crossed), 'crossed', '.crossings').status, 'fail');
});

test('clinical minima retain the reviewed bone-crest/platform and EACH-root/outer-surface datums as unknown', () => {
  const item = make(), rows = rowsOf(item);
  for (const id of ['guardrail.subcrestal-placement', 'guardrail.adjacent-root-clearance']) {
    const row = get(rows, id); assert.equal(row.lower, 1.5); assert.equal(row.target, 1.5); assert.equal(row.upper, null);
    assert.equal(row.actual, null); assert.equal(row.error, null); assert.equal(row.status, 'unknown'); assert.equal(row.units, 'mm'); assert.deepEqual(row.controls, []);
  }
  assert.match(get(rows, 'guardrail.subcrestal-placement').feedback, /bone crest/);
  assert.match(get(rows, 'guardrail.adjacent-root-clearance').feedback, /EACH adjacent root/);
  const malformed = structuredClone(item.fit.quality.final);
  malformed.guardrails.issues.find(issue => issue.id === 'subcrestal-placement').actual.measuredSubcrestalDepthMm = 3;
  assert.equal(get(restorationFeedbackRows(malformed, item.spec.parameters), 'guardrail.subcrestal-placement').actual, null);
});

test('comparisons match stable anonymous targets, give numeric deltas and never call lost evidence an improvement', () => {
  const a = make(spec(), measurement([surface('a'), surface('b', 'adjacent', { sampledMinDistance: 2 })]));
  const b = make(spec(), measurement([surface('b', 'adjacent', { sampledMinDistance: 3 }), surface('a')]));
  const rows = rowsOf(a), changes = compareRestorationFeedback(rows, rowsOf(b));
  const id = targetRow(rows, 'b', '.proximal-gap').id, delta = get(changes, id);
  assert.equal(delta.actualDelta, 1); assert.equal(delta.errorDelta, 1); assert.equal(delta.trend, 'worsened');
  const old = get(rows, id);
  assert.equal(compareRestorationFeedback([old], [{ ...old, status: 'unknown', error: 0 }])[0].trend, 'unknown');
  assert.equal(compareRestorationFeedback([old], [{ ...old, upper: old.upper + 1, error: old.error - 1 }])[0].errorDelta, null);
  assert.equal(compareRestorationFeedback([old], [])[0].trend, 'unknown');
  assert.deepEqual(restorationFitFeedbackRows(a.fit.quality.final, a.fit.after, a.spec.qualityContext), rows.filter(row => row.source === 'fit-measurement'));
});

test('snapshot projection includes safe failures and component relationships without patient IDs, free text or nominal positions', () => {
  const item = make(spec(), measurement([surface('PRIVATE_OPEN', 'antagonist', { sampledOcclusalGap: 3 })]), relationships());
  const snapshot = buildRestorationAssistantSnapshot([item]), design = snapshot.assemblies[0], encoded = JSON.stringify(snapshot);
  assert.doesNotMatch(encoded, /PRIVATE_|nominalOrigin|nominalNormal|"positions"|"targetId"|intersectionReason/);
  assert.ok(design.quality.feedbackRows.length); assert.ok(design.quality.failureFeedback.some(text => text.includes('signed bound error')));
  const pair = design.relationships.relationships[0]; assert.equal(pair.source, 'fixture'); assert.equal(pair.sampledMinDistance, .5); assert.equal(pair.status, 'measured');
  assert.equal(pair.intersectionComplete, true); assert.equal(pair.transverseCrossingTriangles, 0);
  assert.equal(design.relationships.interfaces[0].signedAxialGap, -.2);
  assert.match(design.relationships.limits.join(' '), /not reviewed roots/); assert.equal('targetGap' in pair, false);
  assert.equal(projectRestorationRelationships(undefined), null);
});

test('relationship deltas preserve per-pair counts, signed interfaces and missing evidence', () => {
  const before = relationships(), after = structuredClone(before);
  after.relationships[0].sampledMinDistance = .75; Object.assign(after.relationships[0], { transverseCrossingTriangles: 2, intersectingTriangles: 2, surfaceEvidence: 'transverse-crossing' });
  after.interfaces[0].signedAxialGap = -.1; after.interfaces[0].targetAxialOffset = 0;
  const delta = compareRestorationRelationships(projectRestorationRelationships(before), projectRestorationRelationships(after));
  assert.equal(delta.relationships[0].minDistanceDelta, .25); assert.equal(delta.relationships[0].transverseCrossingsDelta, 2); assert.equal(delta.interfaces[0].signedAxialGapDelta, .1);
  assert.equal(compareRestorationRelationships(projectRestorationRelationships(before), null).relationships[0].after, null);
});

test('anonymous relationships cannot fabricate complete audits or use probe magnitude to hide an invalid axial gap', () => {
  const invalidAudit = relationships();
  Object.assign(invalidAudit.relationships[0], { intersectionComplete: true, intersectionTestedTriangles: 0 });
  assert.throws(() => projectRestorationRelationships(invalidAudit));
  const invalidGap = relationships();
  Object.assign(invalidGap.interfaces[0], { sourceAxialOffset: 0, targetAxialOffset: 0, sourceDistanceToNominalOrigin: 1e13, signedAxialGap: 5 });
  assert.throws(() => projectRestorationRelationships(invalidGap));
});

test('anonymous relationship projection rejects false measured claims and inconsistent signed axial gaps', () => {
  for (const change of [row => { row.sourceAxialOffset = null; }, row => { row.signedAxialGap = 5; }, row => { row.status = 'unknown'; }]) {
    const report = relationships(); change(report.interfaces[0]); assert.throws(() => projectRestorationRelationships(report));
  }
  for (const change of [row => { row.samples = 0; }, row => { row.sampledMedianDistance = .1; }, row => { row.intersectionComplete = false; }, row => { row.transverseCrossingTriangles = 2; }]) {
    const report = relationships(); change(report.relationships[0]); assert.throws(() => projectRestorationRelationships(report));
  }
  const unknown = relationships(); Object.assign(unknown.interfaces[0], { status: 'unknown', sourceAxialOffset: null, targetAxialOffset: null,
    signedAxialGap: null, sourceDistanceToNominalOrigin: null, targetDistanceToNominalOrigin: null });
  assert.equal(projectRestorationRelationships(unknown).interfaces[0].status, 'unknown');
});

test('applied host result carries fresh revisions and actual numeric and relationship deltas', async () => {
  const original = make(spec(), measurement([surface('target')]), relationships()), action = editFor(original);
  const actual = make(applyRestorationEdit(original.spec, action.edit, 'agent'), measurement([surface('target')]), relationships());
  const { result } = await applyAssistantRestorationEdit({ assemblies: [original], busy: false, applyEdit: async () => actual }, action, new AbortController().signal);
  assert.equal(result.status, 'applied'); assert.notEqual(result.before.editRevision, result.after.editRevision);
  const row = get(result.changes, 'relative-depth'); assert.notEqual(row.actualDelta, 0); assert.equal(row.actualDelta, row.after.actual - row.before.actual);
  assert.deepEqual(result.failureFeedback, result.after.quality.failureFeedback);
  assert.equal(result.relationshipChanges.relationships[0].minDistanceDelta, 0);
});

test('typed no-regression rejection returns rejected measurements and exact public reasons while retaining current assembly', async () => {
  const original = make(spec(), measurement([surface('PRIVATE_TARGET')]), relationships()), action = editFor(original);
  const candidate = make(applyRestorationEdit(original.spec, action.edit, 'agent'), measurement([surface('PRIVATE_TARGET', 'adjacent', { sampledMinDistance: 3, transverseCrossingTriangles: 2 })]), relationships());
  Object.assign(candidate.fit.relationships.relationships[0], { transverseCrossingTriangles: 4, intersectingTriangles: 4, surfaceEvidence: 'transverse-crossing' });
  const failure = new RestorationEditRejected(['Target 1: the numerical error increased against the previous target bounds.'],
    { quality: candidate.fit.quality.final, measurement: candidate.fit.after, parameters: candidate.spec.parameters, relationships: candidate.fit.relationships });
  const source = { assemblies: [original], busy: false, applyEdit: async () => { throw failure; } };
  const { result, assembly } = await applyAssistantRestorationEdit(source, action, new AbortController().signal);
  assert.equal(assembly, undefined); assert.equal(source.assemblies[0], original); assert.equal(result.status, 'error'); assert.equal(result.code, 'rejected');
  assert.equal(result.rejectedCandidate.failureFeedback[0], failure.reasons[0]);
  assert.equal(targetRow(result.rejectedCandidate.rows, 'PRIVATE_TARGET', '.proximal-gap').actual, 3);
  assert.ok(result.rejectedCandidate.changes.some(change => change.trend === 'worsened'));
  assert.equal(result.rejectedCandidate.relationshipChanges.relationships[0].transverseCrossingsDelta, 4);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
});

test('cancellation defeats rejection feedback and arbitrary worker diagnostics never leak', async () => {
  const original = make(), action = editFor(original), controller = new AbortController();
  await assert.rejects(applyAssistantRestorationEdit({ assemblies: [original], busy: false, applyEdit: async () => {
    controller.abort(); throw new RestorationEditRejected(['safe'], { quality: original.fit.quality.final, measurement: original.fit.after, parameters: original.spec.parameters });
  } }, action, controller.signal), { name: 'AbortError' });
  const failed = await applyAssistantRestorationEdit({ assemblies: [original], busy: false, applyEdit: async () => { throw new Error('PRIVATE_WORKER_PATIENT_PATH'); } }, action, new AbortController().signal);
  assert.equal(failed.result.code, 'failed'); assert.doesNotMatch(JSON.stringify(failed), /PRIVATE_WORKER/); assert.match(failed.result.message, /Read current measurements/);
});

test('eight-attempt budget exposes fresh evidence and explicit clinical datums without score-based acceptance', () => {
  const snapshot = buildRestorationAssistantSnapshot([make()]); assert.equal(MAX_ASSISTANT_EDITS, 8);
  const tools = createRestorationAssistantTools(snapshot, { allowEdits: true, editsUsed: 7 }), read = tools.getRestorationDesign.execute({});
  assert.equal(read.editsRemaining, 1); assert.ok(tools.requestRestorationEdit);
  const limits = read.limitations.join(' '); assert.match(limits, /REVIEWED BONE CREST/); assert.match(limits, /EACH ADJACENT ROOT/); assert.match(limits, /score.*never establishes success/);
  assert.equal(createRestorationAssistantTools(snapshot, { allowEdits: true, editsUsed: 8 }).requestRestorationEdit, undefined);
});

test('continuations validate applied/rejected numeric deltas, count the failed attempt, and require a fresh design read', async t => {
  const finish = (reason = 'tool-calls') => ({ type: 'finish', finishReason: { unified: reason, raw: reason }, usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } });
  const call = (toolName, input = {}) => ({ type: 'tool-call', toolName, toolCallId: toolName, input: JSON.stringify(input) });
  for (const kind of ['applied', 'rejected']) for (const tamper of [null, 'numeric', 'relationship']) {
    const original = make(spec(), measurement([surface('PRIVATE_TARGET')]), relationships()), action = editFor(original);
    const candidate = make(applyRestorationEdit(original.spec, action.edit, 'agent'), measurement([surface('PRIVATE_TARGET', 'adjacent', { sampledMinDistance: 2 })]), relationships());
    const steps = [[call('getRestorationDesign'), finish()], [call('requestRestorationEdit', action), finish()], [call('getRestorationDesign'), finish()],
      [{ type: 'text-start', id: 'answer' }, { type: 'text-delta', id: 'answer', delta: 'Fresh evidence retains the unresolved targets.' }, { type: 'text-end', id: 'answer' }, finish('stop')]];
    const model = new MockLanguageModelV4({ doStream: async () => { assert.ok(steps.length); return { stream: simulateReadableStream({ chunks: steps.shift(), initialDelayInMs: null, chunkDelayInMs: null }) }; } });
    const middleware = createAssistantMiddleware({ languageModel: model }), server = createServer((req, res) => void middleware(req, res, () => res.end()));
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
    const url = `http://127.0.0.1:${server.address().port}/api/assistant/chat`;
    const post = async body => {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, events: response.status === 200 ? (await response.text()).trim().split('\n').map(line => JSON.parse(line)) : [] };
    };
    const payload = { messages: [{ role: 'user', content: 'Review and revise this generic concept.' }],
      snapshot: buildAssistantSnapshot({ parts: [], selected: null, probe: null, report: null, tolerance: .5, analysisState: 'unavailable', teeth: emptyToothCase().teeth, counts: {}, fitSummary: [], fitRadius: null }),
      restoration: { allowEdits: true, snapshot: buildRestorationAssistantSnapshot([original]) } };
    const initial = await post(payload), handoff = initial.events.find(event => event.type === 'edit-request'); assert.ok(handoff);
    const outcome = await applyAssistantRestorationEdit({ assemblies: [original], busy: false, applyEdit: async () => {
      if (kind === 'applied') return candidate;
      throw new RestorationEditRejected(['Target 1: the error increased.'], { quality: candidate.fit.quality.final, measurement: candidate.fit.after,
        parameters: candidate.spec.parameters, relationships: candidate.fit.relationships });
    } }, handoff.request, new AbortController().signal);
    if (kind === 'applied') payload.restoration.snapshot = buildRestorationAssistantSnapshot([candidate]);
    const result = outcome.result;
    const numeric = kind === 'applied' ? result.changes : result.rejectedCandidate.changes;
    const relational = kind === 'applied' ? result.relationshipChanges : result.rejectedCandidate.relationshipChanges;
    if (tamper === 'numeric') numeric[0].actualDelta = 123;
    if (tamper === 'relationship') relational.relationships[0].minDistanceDelta = 123;
    payload.restoration.continuation = { token: handoff.continuationToken, result };
    const resumed = await post(payload);
    assert.equal(resumed.status, tamper ? 409 : 200, `${kind}/${tamper}`);
    if (tamper) { assert.equal(model.doStreamCalls.length, 2); continue; }
    const read = resumed.events.find(event => event.name === 'getRestorationDesign' && event.state === 'complete');
    assert.equal(read.output.editsRemaining, 7); assert.equal(read.output.assemblies[0].editRevision, payload.restoration.snapshot.assemblies[0].editRevision);
    assert.deepEqual(model.doStreamCalls[2].toolChoice, { type: 'auto' });
    const instructions = model.doStreamCalls[2].prompt.filter(message => message.role === 'system').map(message => message.content).join('\n');
    assert.match(instructions, /Host edit budget: 1\/8/); assert.match(instructions, /EVERY per-target/); assert.match(instructions, /EACH ADJACENT ROOT/);
    if (kind === 'rejected') assert.match(instructions, /Target 1: the error increased/);
    assert.equal((await post(payload)).status, 409);
  }
});
