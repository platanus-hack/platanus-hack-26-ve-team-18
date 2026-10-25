import test from 'node:test';
import assert from 'node:assert/strict';
import { describeProcess } from '../src/guided-process.ts';
import { beginWorkflow, endWorkflow } from '../src/case-workflow.ts';

const base = () => ({
  scanCount: 2, hasArch: true, preparing: false, preparationStage: '', evidenceReady: true,
  configured: true, queued: false, workflowPaused: false, assessing: false, generating: false, generationPhase: null,
  generationDetail: '', measuring: false, measurementPaused: false, needsMeasurements: true,
  measurementsReady: true, measuredPairs: 0, generatedCount: 0, staleCount: 0,
  hasAssessment: false, assessmentSource: null, issues: [], error: '',
});
const completeRun = () => endWorkflow(beginWorkflow('current', 'run'), 'complete');

test('starts empty without inventing a draft or background activity', () => {
  const state = describeProcess({ ...base(), scanCount: 0, hasArch: false, evidenceReady: false });
  assert.equal(state.status, 'empty');
  assert.equal(state.canStart, false);
  assert.ok(state.steps.every(step => step.status === 'pending'));
});

test('waiting for local preparation and AI configuration cannot start an assessment', () => {
  assert.equal(describeProcess({ ...base(), preparing: true, evidenceReady: false }).status, 'preparing');
  assert.equal(describeProcess({ ...base(), preparing: true }).canStart, false);
  assert.equal(describeProcess({ ...base(), configured: null }).canStart, false);
  assert.equal(describeProcess({ ...base(), measuring: true }).canStart, false);
  assert.equal(describeProcess({ ...base(), configured: false }).canStart, true);
});

test('filename roles and unresolved side are context notes, not prerequisites to start', () => {
  const state = describeProcess({ ...base(), issues: [
    'Filename scan roles are hypotheses.',
    'Patient side is unresolved; template FDI selects illustrative anatomy only.',
    'Bite pose has not been reviewed.',
  ] });
  assert.equal(state.status, 'ready');
  assert.equal(state.canStart, true);
  assert.equal(state.issues.length, 3);
  assert.match(state.detail, /Start once/);
  assert.match(state.detail, /continue automatically/);
  assert.match(state.steps[1].detail, /prepare a draft automatically/);
  assert.match(state.steps[2].detail, /fixture, abutment and crown/);
});

test('an active workflow cannot expose a second Start between automatic phases', () => {
  for (const hasAssessment of [false, true]) {
    const state = describeProcess({ ...base(), hasAssessment, run: beginWorkflow('current', 'run'),
      issues: ['Patient-side FDI remains unresolved.'] });
    assert.equal(state.status, 'running');
    assert.equal(state.canStart, false);
    assert.equal(state.canResume, false);
    assert.match(state.detail, /No approval is needed between/);
    assert.equal(state.steps[2].status, 'pending');
  }
});

test('observes real assessment and fitting phases without completing the final review', () => {
  const assessing = describeProcess({ ...base(), assessing: true, preparationStage: 'Assessing current views' });
  assert.equal(assessing.status, 'running');
  assert.equal(assessing.detail, 'Assessing current views');
  assert.equal(assessing.steps[1].status, 'running');
  assert.equal(assessing.canStart, false);
  const fitting = describeProcess({ ...base(), hasAssessment: true, generating: true, generationPhase: 'fitting' });
  assert.equal(fitting.steps[2].status, 'complete');
  assert.equal(fitting.steps[3].status, 'running');
  assert.equal(fitting.steps[4].status, 'pending');
});

test('generation is not review completion while current distances are being recomputed', () => {
  const state = describeProcess({ ...base(), hasAssessment: true, generatedCount: 1, run: completeRun(), measuring: true, measurementsReady: false });
  assert.equal(state.status, 'running');
  assert.equal(state.steps[4].status, 'running');
  assert.equal(state.canStart, false);
});

test('a completed report with zero nearby pairs is valid evidence, not an absent report', () => {
  const state = describeProcess({ ...base(), hasAssessment: true, generatedCount: 1, run: completeRun() });
  assert.equal(state.status, 'review');
  assert.equal(state.measuredPairs, 0);
  assert.equal(state.steps[4].status, 'complete');
  assert.match(state.steps[4].detail, /Clinical fit remains unvalidated/);
});

test('finished drafts retain findings without requiring an approval or recovery action', () => {
  const findings = [
    'Patient-side FDI is unresolved; a bounded-gap concept was generated.',
    'Two surface pairs have crossings or inside samples.',
    'CBCT registration has not been visually reviewed.',
    'Patient-side FDI is unresolved; a bounded-gap concept was generated.',
  ];
  const state = describeProcess({ ...base(), hasAssessment: true, generatedCount: 1, run: completeRun(), issues: findings });
  assert.equal(state.status, 'review');
  assert.equal(state.steps[4].status, 'complete');
  assert.equal(state.canResume, false);
  assert.equal(state.canUseLocal, false);
  assert.deepEqual(state.issues, [...new Set(findings)]);
  assert.match(state.detail, /no approval is needed/);
});

test('paused surface checks annotate an available draft without demanding approval', () => {
  const state = describeProcess({ ...base(), hasAssessment: true, generatedCount: 1, run: completeRun(),
    measurementsReady: false, measurementPaused: true });
  assert.equal(state.status, 'review');
  assert.equal(state.steps[4].status, 'attention');
  assert.equal(state.measurementsReady, false);
  assert.match(state.steps[4].detail, /measurements are unavailable/);
  assert.match(state.issues.join(' '), /Surface analysis is paused/);
  assert.equal(state.canResume, false);
});

test('missing arch geometry and malformed scan errors still require recovery', () => {
  const missing = describeProcess({ ...base(), hasArch: false });
  assert.equal(missing.status, 'needs-input');
  assert.equal(missing.steps[0].status, 'attention');
  assert.equal(missing.canStart, false);
  const malformed = describeProcess({ ...base(), evidenceReady: false, error: 'Malformed scan: no usable triangles.' });
  assert.equal(malformed.status, 'error');
  assert.equal(malformed.steps[0].status, 'attention');
  assert.ok(malformed.issues.includes('Malformed scan: no usable triangles.'));
  const rejectedImport = describeProcess({ ...base(), scanCount: 0, hasArch: false, evidenceReady: false,
    error: 'Malformed scan: no usable triangles.' });
  assert.equal(rejectedImport.status, 'error');
  assert.ok(rejectedImport.issues.includes('Malformed scan: no usable triangles.'));
});

test('no eligible site does not claim an implant was created or inserted', () => {
  const state = describeProcess({ ...base(), hasAssessment: true, assessmentSource: 'local', run: completeRun() });
  assert.equal(state.status, 'needs-input');
  assert.equal(state.steps[2].status, 'skipped');
  assert.equal(state.steps[3].status, 'skipped');
  assert.equal(state.generatedCount, 0);
  assert.match(state.issues.join(' '), /No concept was generated/);
});

test('pause retains completed steps and supports local resume', () => {
  const state = describeProcess({ ...base(), hasAssessment: true, generatedCount: 1, run: endWorkflow(beginWorkflow('current', 'run'), 'cancelled') });
  assert.equal(state.status, 'paused');
  assert.equal(state.canResume, true);
  assert.equal(state.steps[2].status, 'complete');
  assert.match(state.detail, /without another AI request/);
});

test('stale artifacts and paused or failed measurements remain explicit review exceptions', () => {
  const stale = describeProcess({ ...base(), hasAssessment: true, staleCount: 1, run: completeRun() });
  assert.equal(stale.status, 'needs-input');
  assert.equal(stale.canResume, true);
  assert.equal(stale.generatedCount, 0);
  const failed = describeProcess({ ...base(), hasAssessment: true, generatedCount: 1, run: completeRun(), measurementsReady: false, error: 'Collision analysis stopped.' });
  assert.equal(failed.status, 'needs-input');
  assert.equal(failed.steps[4].status, 'attention');
  assert.match(failed.issues.join(' '), /Collision analysis stopped/);
  const activeFailure = describeProcess({ ...base(), hasAssessment: true, generatedCount: 1,
    run: beginWorkflow('current', 'run'), measuring: true, measurementsReady: false, error: 'Collision analysis stopped.' });
  assert.equal(activeFailure.status, 'needs-input');
  assert.equal(activeFailure.steps[4].status, 'attention');
});


test('pausing preparation before the first run always exposes resume', () => {
  const state = describeProcess({ ...base(), evidenceReady: false, workflowPaused: true, queued: true });
  assert.equal(state.status, 'paused');
  assert.equal(state.canResume, true);
  assert.equal(state.canStart, false);
});

test('a failed preparation exposes recovery instead of an endless queued spinner', () => {
  const state = describeProcess({ ...base(), evidenceReady: false, queued: true, error: 'Detection stopped.' });
  assert.equal(state.status, 'error');
  assert.equal(state.canResume, true);
});


test('final AI review is a real active phase after surface measurements and prevents reentry', () => {
  const state = describeProcess({ ...base(), hasAssessment: true, generatedCount: 1, run: completeRun(), reviewingAi: true });
  assert.equal(state.status, 'running');
  assert.equal(state.title, 'AI is reviewing the draft');
  assert.equal(state.steps[4].status, 'running');
  assert.equal(state.canStart, false);
});
