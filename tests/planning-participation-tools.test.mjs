import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlanningWorkflowTools } from '../server/planning-workflow-tools.ts';

const design = { anatomy: 'premolar', anatomySource: 'procedural-template',
  parameters: { fixture: { radius: .5, length: 2, depth: 0, taper: .1 }, abutment: { radius: .4, height: .5, emergenceRadius: .6, angleX: 0, angleY: 0 }, crown: { width: 3, depth: 2, height: 2, cuspHeight: 0, rotation: 0 } },
  contour: { cervicalScale: 1, occlusalScale: 1 } };
function fixture() {
  return { revision: 'r1', snapshot: { teeth: [] }, sources: [{ id: 'scan-1', arch: 'upper', patientRight: 'image-right', roleConfirmed: true, candidates: [{ id: 1, triangles: 100, area: 12, height: 2, warnings: [] }, { id: 2, triangles: 100, area: 12, height: 2, warnings: [] }] }],
    views: [{ id: 'view-1', sourceId: 'scan-1', context: 'arch' }], preparation: { sources: [], regions: [{ sourceId: 'scan-1', candidateId: 1, fdi: 13, protectedTriangles: 3, dimensions: { mesiodistal: 3, buccolingual: 2, height: 2 }, flags: ['Partial cervical boundary.'] }],
      sites: [{ id: 'site-1', sourceId: 'scan-1', fdi: 14, confidence: .9, status: 'proposed-missing', localized: true,
        relationships: { adjacent: { mesial: { sourceId: 'scan-1', candidateId: 1, fdi: 13 }, distal: { sourceId: 'scan-1', candidateId: 2, fdi: 15 } }, contralateral: null, opposing: null } }] } };
}
const execute = (tools, name, input) => tools[name].execute(input, { toolCallId: 'test', messages: [] });
const review = patch => ({ sourceId: 'scan-1', candidateId: 1, classification: 'tooth', decision: 'use', fdi: 13, rationale: 'Supported crown geometry in the arch view.', evidence: ['view-1', 'scan-1:C1'], ...patch });
const command = () => ({ siteId: 'site-1', rationale: 'Visual envelope from measured local space.', design });

test('AI inspects actual region evidence and records reversible settings without changing case inputs', async () => {
  const input = fixture(), before = structuredClone(input), { tools, regionReviews } = createPlanningWorkflowTools(input);
  const observed = await execute(tools, 'inspectToothRegion', { sourceId: 'scan-1', candidateId: 1 });
  assert.equal(observed.region.protectedTriangles, 3); assert.deepEqual(observed.region.dimensions, input.preparation.regions[0].dimensions);
  const result = await execute(tools, 'reviewToothRegions', { reviews: [review()] });
  assert.equal(result.recorded, true); assert.equal(result.appliedToReviewedChart, false); assert.equal(regionReviews.length, 1);
  assert.deepEqual(input, before);
});

test('mixed or excluded immediate flanks block automatic construction at the affected site', async () => {
  const { tools } = createPlanningWorkflowTools(fixture());
  assert.equal((await execute(tools, 'reviewToothRegions', { reviews: [review({ classification: 'mixed', decision: 'needs-boundary-review', fdi: null })] })).recorded, true);
  const result = await execute(tools, 'requestDraftComponents', command());
  assert.equal(result.queued, false); assert.equal(result.blockedFlanks.length, 1);
});

test('unknown identity, contradictory regions and invented evidence cannot become saved settings', async () => {
  for (const change of [
    input => { input.sources[0].patientRight = null; },
    input => { input.sources[0].roleConfirmed = false; },
    input => { input.snapshot.teeth = [{ fdi: 13, status: 'missing' }]; },
  ]) {
    const input = fixture(); change(input); const { tools, regionReviews } = createPlanningWorkflowTools(input);
    assert.equal((await execute(tools, 'reviewToothRegions', { reviews: [review()] })).recorded, false); assert.equal(regionReviews.length, 0);
  }
  const { tools, regionReviews } = createPlanningWorkflowTools(fixture());
  for (const patch of [{ evidence: ['made-up'] }, { candidateId: 999 }, { classification: 'non-tooth', fdi: 13 }, { decision: 'use', classification: 'mixed' }]) {
    assert.equal((await execute(tools, 'reviewToothRegions', { reviews: [review(patch)] })).recorded, false);
  }
  assert.equal(regionReviews.length, 0);
});

test('site decisions affect generation eligibility and cannot be contradicted after queuing', async () => {
  const { tools, siteReviews } = createPlanningWorkflowTools(fixture());
  const review = { siteId: 'site-1', decision: 'defer', rationale: 'The flank needs a boundary correction first.', evidence: ['site-1'], missingEvidence: ['Reviewed boundary.'] };
  assert.equal((await execute(tools, 'reviewRestorationSite', review)).recorded, true);
  assert.equal((await execute(tools, 'requestDraftComponents', command())).queued, false);
  assert.equal(siteReviews.length, 1);
  const other = createPlanningWorkflowTools(fixture());
  assert.equal((await execute(other.tools, 'requestDraftComponents', command())).queued, true);
  assert.equal((await execute(other.tools, 'reviewRestorationSite', review)).recorded, false);
});

test('site evidence accepts its known adjacent crowns alongside site or image context and rejects unrelated references', async () => {
  const review = { siteId: 'site-1', decision: 'design', rationale: 'Bounded space between the supplied adjacent crown regions.', missingEvidence: [] };
  for (const evidence of [['view-1', 'scan-1:C1', 'scan-1:C2'], ['site-1', 'scan-1:C1']]) {
    const { tools } = createPlanningWorkflowTools(fixture());
    assert.equal((await execute(tools, 'reviewRestorationSite', { ...review, evidence })).recorded, true);
    assert.equal((await execute(tools, 'requestDraftComponents', command())).queued, true);
  }
  for (const evidence of [['scan-1:C1', 'scan-1:C2'], ['view-1', 'scan-2:C1'], ['site-1', 'scan-1:C3'], ['site-1', 'chart']]) {
    const input = fixture(); input.sources[0].candidates.push({ id: 3, triangles: 100, area: 12, height: 2, warnings: [] });
    const { tools } = createPlanningWorkflowTools(input);
    assert.equal((await execute(tools, 'reviewRestorationSite', { ...review, evidence })).recorded, false);
  }
});

test('placement rules distinguish confirmed targets from unavailable clinical measurements and local units', async () => {
  const input = fixture(); input.measurementContext = { mmPerUnit: 1, scaleStatus: 'unconfirmed', scaleSource: 'Editable default, not calibration.', biteReviewed: false };
  const { tools } = createPlanningWorkflowTools(input);
  const rules = await execute(tools, 'inspectPlacementRules', { siteId: 'site-1' });
  assert.equal(rules.surfaceObjectives.units, 'file units (u)');
  assert.equal(rules.measurementContext.scaleStatus, 'unconfirmed');
  assert.ok(rules.clinicalRules.every(rule => rule.minimum === 1.5 && rule.actual === null && rule.error === null && rule.status === 'unknown'));
  assert.equal(rules.diagnosis.status, 'clinical-review-required');
});
