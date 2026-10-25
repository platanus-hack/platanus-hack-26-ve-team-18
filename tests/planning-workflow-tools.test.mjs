import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlanningWorkflowTools, boundedPlanningTools } from '../server/planning-workflow-tools.ts';

const request = () => ({ revision: 'source-current', snapshot: { teeth: [{ fdi: 16, status: 'unreviewed', assignedTriangles: 0 }] }, sources: [{ id: 'scan-1', arch: 'upper', patientRight: 'image-left', roleConfirmed: true }], preparation: { sources: [], sites: [{ id: 'site-1', sourceId: 'scan-1', fdi: 16, status: 'proposed-missing', localized: true, confidence: .9, supporting: ['Scanned ridge between crown boundaries'], conflicting: [], questions: [] }] } });
const execute = (tools, name, input) => tools[name].execute(input, { toolCallId: 'test-call', messages: [] });

test('LLM draft commands resolve only supported local evidence and remain idempotent, unaccepted hypotheses', async () => {
  const { tools, draftRequests } = createPlanningWorkflowTools(request());
  assert.equal((await execute(tools, 'chooseAnatomicalCandidate', { siteId: 'site-1' })).anatomy, 'molar');
  for (let i = 0; i < 2; i++) assert.equal((await execute(tools, 'requestDraftComponents', { siteId: 'site-1', rationale: 'Evaluate a reversible spatial hypothesis.' })).queued, true);
  assert.equal(draftRequests.length, 1);
  assert.equal(draftRequests[0].fdi, 16);
  assert.equal((await execute(tools, 'requestDraftComponents', { siteId: 'invented', rationale: 'Unsupported.' })).queued, false);
});

test('unknown side, role hints, unscanned coverage and conflicting chart states block only that operation', async () => {
  for (const edit of [r => { r.sources[0].patientRight = null; }, r => { r.sources[0].roleConfirmed = false; }, r => { r.preparation.sites[0].status = 'not-scanned'; }, r => { r.snapshot.teeth[0].assignedTriangles = 5; }]) {
    const input = request(); edit(input); const { tools, draftRequests } = createPlanningWorkflowTools(input);
    assert.equal((await execute(tools, 'requestDraftComponents', { siteId: 'site-1', rationale: 'Hypothesis.' })).queued, false);
    assert.equal((await execute(tools, 'inspectPreparedCase', {})).revision, input.revision);
    assert.equal(draftRequests.length, 0);
  }
});

test('parallel structured tools share one request-wide call budget', async () => {
  const { tools } = createPlanningWorkflowTools(request()); const bounded = boundedPlanningTools(tools);
  const results = await Promise.all(Array.from({ length: 20 }, () => execute(bounded, 'inspectPreparedCase', {})));
  assert.equal(results.filter(result => result.status === 'budget-reached').length, 4);
});
