import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlanningDraft } from '../src/planning-automation.ts';
import { emptyToothCase } from '../src/tooth-session.ts';

function fixture() {
  const parts = [{ id: 'upper', role: 'upper', triangles: 4 }, { id: 'lower', role: 'lower', triangles: 2 }];
  const scan = ids => ({ method: 'local', candidates: ids.map((id, i) => ({ id, faces: new Uint32Array([i]) })) });
  const views = [{ id: 'view-1', sourceId: 'scan-1', context: 'arch' }, { id: 'view-2', sourceId: 'scan-2', context: 'arch' }];
  const evidence = { revision: 'current', sources: [{ partId: 'upper', scan: scan([1, 2, 3]) }, { partId: 'lower', scan: scan([1]) }], views };
  const result = {
    revision: 'current', model: 'test', summary: 'Reviewable hypotheses.',
    mappings: [{ sourceId: 'scan-1', candidateId: 1, fdi: 11, needsReview: false }, { sourceId: 'scan-1', candidateId: 2, fdi: 13, needsReview: false }],
    findings: [12, 14].map(fdi => ({ id: `gap-${fdi}`, category: 'possible-missing', fdi, detail: 'Visible space needs clinical review.', evidence: ['view-1', 'scan-1:C1'] })),
    actions: [], designs: [], limitations: [],
  };
  return { parts, evidence, result, teeth: emptyToothCase(), counts: {} };
}

test('prepares multiple identity and gap hypotheses without changing the saved chart or labels', () => {
  const input = fixture();
  const chart = structuredClone(input.teeth);
  const draft = buildPlanningDraft(input);
  assert.deepEqual(draft.regions.map(region => [region.partId, region.tooth, [...region.faces]]), [['upper', 11, [0]], ['upper', 13, [1]]]);
  assert.deepEqual(draft.proposedSites.map(site => site.fdi), [12, 14]);
  assert.equal(draft.proposedSites.every(site => site.provenance === 'hypothesized'), true);
  assert.deepEqual(input.teeth, chart, 'draft preparation must not convert proposals into reviewed chart status or implant intent');
  assert.deepEqual(draft.reviewedSites, []);
  draft.proposedSites[0].evidence.push('local-change');
  assert.deepEqual(input.result.findings[0].evidence, ['view-1', 'scan-1:C1']);
});

test('stale assessment returns no operations, including no reviewed-site requests', () => {
  const input = fixture(); input.result.revision = 'older'; input.teeth.teeth[15] = { status: 'missing', restoration: 'implant' };
  const draft = buildPlanningDraft(input);
  assert.deepEqual(draft.regions, []); assert.deepEqual(draft.proposedSites, []); assert.deepEqual(draft.reviewedSites, []);
  assert.match(draft.skipped[0].reason, /older evidence/);
});

test('preserves existing labels, exclusions and explicit missing/not-scanned chart records', () => {
  for (const conflict of ['label', 'exclusion', 'assigned', 'missing', 'not-scanned']) {
    const input = fixture();
    if (conflict === 'label' || conflict === 'exclusion') input.teeth.labels.upper = new Uint8Array([conflict === 'label' ? 21 : 255, 0, 0, 0]);
    else if (conflict === 'assigned') input.counts[11] = 20;
    else input.teeth.teeth[11].status = conflict;
    const draft = buildPlanningDraft(input);
    assert.equal(draft.regions.some(region => region.tooth === 11), false, conflict);
    assert.ok(draft.skipped.some(item => item.fdi === 11 && item.reason));
    assert.equal(draft.regions.some(region => region.tooth === 13), true);
  }
});

test('review flags, wrong arches, missing regions and sources without images never auto-apply', () => {
  for (const mutate of [
    input => { input.result.mappings[0].needsReview = true; },
    input => { input.result.mappings[0].fdi = 31; },
    input => { input.result.mappings[0].candidateId = 99; },
    input => { input.evidence.views = input.evidence.views.filter(view => view.sourceId !== 'scan-1'); },
    input => { input.evidence.sources[0].scan.method = 'unavailable'; },
    input => { input.evidence.sources[0].scan.candidates[0].faces = new Uint32Array([5]); },
  ]) {
    const input = fixture(); mutate(input);
    assert.equal(buildPlanningDraft(input).regions.some(region => region.tooth === input.result.mappings[0].fdi), false);
  }
});

test('conflicting identities and duplicate candidate pairs are held for review', () => {
  for (const duplicate of ['fdi', 'candidate']) {
    const input = fixture(); input.result.mappings.push({ ...input.result.mappings[0], ...(duplicate === 'fdi' ? { candidateId: 3 } : { fdi: 15 }) });
    assert.equal(buildPlanningDraft(input).regions.some(region => region.tooth === 11), false);
  }
});

test('design suggestions or implant-review actions alone cannot create missing-position proposals', () => {
  const input = fixture(); input.result.findings = [];
  input.result.designs = [{ fdi: 12, anatomy: 'incisor' }];
  input.result.actions = [{ fdi: 12, kind: 'implant-review' }];
  assert.deepEqual(buildPlanningDraft(input).proposedSites, []);
});

test('conflicting present teeth, unscanned regions and nonvisual evidence block proposed sites', () => {
  for (const conflict of ['present', 'not-scanned', 'assigned', 'mapped', 'candidate-only', 'other-arch']) {
    const input = fixture();
    if (conflict === 'assigned') input.counts[12] = 1;
    else if (conflict === 'mapped') input.result.mappings.push({ sourceId: 'scan-1', candidateId: 3, fdi: 12, needsReview: true });
    else if (conflict === 'candidate-only') input.result.findings[0].evidence = ['scan-1:C1'];
    else if (conflict === 'other-arch') input.result.findings[0].evidence = ['view-2'];
    else input.teeth.teeth[12].status = conflict;
    const draft = buildPlanningDraft(input);
    assert.equal(draft.proposedSites.some(site => site.fdi === 12), false, conflict);
    assert.equal(draft.proposedSites.some(site => site.fdi === 14), true);
    assert.ok(draft.skipped.some(item => item.fdi === 12 && item.reason));
  }
});

test('deduplicates gap hypotheses and keeps reviewed implant intent separate from absence', () => {
  const input = fixture(); input.result.findings.push({ ...input.result.findings[0], id: 'another-view' });
  input.teeth.teeth[15] = { status: 'missing', restoration: 'implant' };
  input.teeth.teeth[16] = { status: 'missing', restoration: 'none' };
  input.teeth.teeth[35] = { status: 'missing', restoration: 'implant' }; input.counts[35] = 2;
  assert.deepEqual(buildPlanningDraft(input).proposedSites.map(site => site.fdi), [12, 14]);
  assert.deepEqual(buildPlanningDraft(input).reviewedSites, [15]);
});

test('automatic AI concept requests require plan support and cannot contradict an identity mapping', async () => {
  const { assessmentSupportsSite } = await import('../src/planning-automation.ts');
  const result = { model: 'external-assessment', mappings: [], findings: [], execution: { draftRequests: [] } };
  assert.equal(assessmentSupportsSite(result, 15), false);
  assert.equal(assessmentSupportsSite({ ...result, findings: [{ fdi: 15, category: 'possible-missing' }] }, 15), true);
  assert.equal(assessmentSupportsSite({ ...result, execution: { draftRequests: [{ fdi: 15 }] } }, 15), true);
  assert.equal(assessmentSupportsSite({ ...result, findings: [{ fdi: 15, category: 'possible-missing' }], mappings: [{ fdi: 15, needsReview: true }] }, 15), false);
  assert.equal(assessmentSupportsSite({ ...result, model: 'local-geometry' }, 15), true);
});
