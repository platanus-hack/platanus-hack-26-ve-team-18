import test from 'node:test';
import assert from 'node:assert/strict';
import { beginWorkflow, stageWorkflow, journalWorkflow, endWorkflow, workflowRunSchema, effortSummary } from '../src/case-workflow.ts';
import { reconcileIdentities, draftToothCase, replaceIdentityCorrection } from '../src/draft-workflow.ts';
import { emptyToothCase } from '../src/tooth-session.ts';

test('cancelled workflows retain completed evidence and artifact history and validate for reopening', () => {
  const original = beginWorkflow('source-revision', 'run-one', '2026-10-24T12:00:00.000Z');
  const measured = journalWorkflow(stageWorkflow(original, 'anatomy', 'running', 'Fitting site A'), { name: 'generate-fit', stage: 'anatomy', status: 'complete', durationMs: 1500, detail: 'Best retained with unresolved tissue crossings', artifactIds: ['best-candidate'] });
  const stopped = endWorkflow(measured, 'cancelled', '2026-10-24T12:00:10.000Z');
  assert.equal(workflowRunSchema.parse(stopped).status, 'cancelled');
  assert.equal(stopped.stages[0].status, 'complete');
  assert.equal(stopped.stages.find(stage => stage.id === 'anatomy').status, 'cancelled');
  assert.deepEqual(stopped.tools[0].artifactIds, ['best-candidate']);
  assert.equal(original.tools.length, 0, 'transitions never mutate prior journal snapshots');
});

test('measured correction effort never fabricates a manual baseline, time saved or accuracy', () => {
  const event = { kind: 'identity', target: 'scan:C1', at: '2026-10-24T12:00:00.000Z' };
  const result = effortSummary([event, { ...event, kind: 'site' }], [{ stage: 'Preparation', durationMs: 2700 }]);
  assert.equal(result.correctionSteps, 2); assert.equal(result.byKind.identity, 1); assert.equal(result.measuredMs, 2700);
  assert.equal(result.manualBaselineMs, null); assert.equal(result.timeSavedMs, null); assert.equal(result.clinicalAccuracy, null);
});

test('reused candidate IDs cannot move a draft identity correction onto different triangles', () => {
  const part = {id:'upper',role:'upper',triangles:3,positions:new Float32Array(27),normals:new Float32Array(27)};
  const identity = {partId:'upper',candidateId:1,fdi:null,confidence:0,alternatives:[],needsReview:true,blockingReasons:['Identity unresolved'],reason:'New surface region.',source:'geometry'};
  const prepared = {revision:'new-region',identities:[identity],scans:[{partId:'upper',scan:{candidates:[{id:1,faces:Uint32Array.of(1)}]}}]};
  const decisions={'upper:C1':11}, regions={'upper:C1':[0]};
  const reconciled = reconcileIdentities(prepared,null,[part],.8,decisions,regions);
  assert.equal(reconciled[0].fdi,null); assert.equal(reconciled[0].needsReview,true);
  const reviewed=emptyToothCase();reviewed.labels.upper=Uint8Array.of(0,0,255);reviewed.reviewedMask={upper:Uint8Array.of(0,0,1)};
  const draft = draftToothCase(reviewed,[part],prepared,reconciled,decisions,regions);
  assert.deepEqual(draft.labels.upper,Uint8Array.of(11,0,255),'the original corrected face stays selected, while fresh C1 remains unknown');
  assert.deepEqual(reviewed.labels.upper,Uint8Array.of(0,0,255)); assert.equal(reviewed.teeth[11].status,'unreviewed');
});

test('conflicting correction aliases cannot make an identity eligible or overwrite faces by insertion order', () => {
  const part = { id: 'upper', role: 'upper', triangles: 3, positions: new Float32Array(27), normals: new Float32Array(27) };
  const identity = { partId: 'upper', candidateId: 1, fdi: 12, confidence: 1, alternatives: [], needsReview: true, reason: 'Conflicting corrections', source: 'reviewed' };
  const prepared = { revision: 'same-faces', identities: [identity], scans: [{ partId: 'upper', scan: { candidates: [{ id: 1, faces: Uint32Array.of(0, 1) }] } }] };
  const regions = { 'upper:C1': [0, 1], 'upper:C8': [0, 1] };
  for (const decisions of [{ 'upper:C1': 12, 'upper:C8': 11 }, { 'upper:C8': 11, 'upper:C1': 12 }]) {
    const rows = reconcileIdentities(prepared, null, [part], .8, decisions, regions);
    assert.equal(rows[0].needsReview, true);
    const reviewed = emptyToothCase(); reviewed.labels.upper = new Uint8Array(3);
    assert.deepEqual(draftToothCase(reviewed, [part], prepared, rows, decisions, regions).labels.upper, new Uint8Array(3));
  }
});

test('a fresh explicit review can replace a renamed and changed region without blocking itself', () => {
  const decisions = { 'upper:C1': 11, 'upper:C3': 13, 'lower:C1': 41 };
  const regions = { 'upper:C1': [0, 1], 'upper:C3': [4], 'lower:C1': [0] };
  const corrected = replaceIdentityCorrection(decisions, regions, 'upper:C8', 12, [0, 1, 2]);
  assert.deepEqual(corrected.decisions, { 'upper:C3': 13, 'lower:C1': 41, 'upper:C8': 12 });
  assert.deepEqual(corrected.regions['upper:C8'], [0, 1, 2]);
  const prepared = { identities: [{ partId: 'upper', candidateId: 8, fdi: null, confidence: 0, needsReview: true, source: 'geometry' }], scans: [{ partId: 'upper', scan: { candidates: [{ id: 8, faces: Uint32Array.of(0, 1, 2) }] } }] };
  const [row] = reconcileIdentities(prepared, null, [{ id: 'upper' }], .8, corrected.decisions, corrected.regions);
  assert.equal(row.fdi, 12); assert.equal(row.needsReview, false);
  assert.deepEqual(regions['upper:C1'], [0, 1]); assert.equal(decisions['upper:C1'], 11);
  const partial = replaceIdentityCorrection({ 'upper:C1': 11 }, { 'upper:C1': [0, 1, 3] }, 'upper:C8', 12, [0, 1, 2]);
  assert.deepEqual(partial.regions, { 'upper:C1': [3], 'upper:C8': [0, 1, 2] }, 'prior corrected faces outside the new review remain protected as draft choices');
  assert.equal(reconcileIdentities(prepared, null, [{ id: 'upper' }], .8, partial.decisions, partial.regions)[0].needsReview, false);
});
