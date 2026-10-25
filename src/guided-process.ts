import type { WorkflowRun } from './case-workflow';

export type ProcessStepStatus = 'pending' | 'running' | 'complete' | 'attention' | 'skipped';
export interface ProcessState {
  status: 'empty' | 'preparing' | 'ready' | 'running' | 'paused' | 'needs-input' | 'error' | 'review';
  title: string;
  detail: string;
  steps: { id: string; label: string; detail: string; status: ProcessStepStatus }[];
  canStart: boolean;
  canResume: boolean;
  canUseLocal: boolean;
  issues: string[];
  generatedCount: number;
  measuredPairs: number;
  measurementsReady: boolean;
  assessmentSource: 'ai' | 'local' | null;
}

export interface ProcessInput {
  scanCount: number;
  hasArch: boolean;
  preparing: boolean;
  preparationStage: string;
  evidenceReady: boolean;
  configured: boolean | null;
  queued: boolean;
  workflowPaused: boolean;
  assessing: boolean;
  generating: boolean;
  generationPhase: 'creating' | 'fitting' | null;
  generationDetail: string;
  measuring: boolean;
  measurementPaused: boolean;
  needsMeasurements: boolean;
  measurementsReady: boolean;
  measuredPairs: number;
  generatedCount: number;
  staleCount: number;
  hasAssessment: boolean;
  assessmentSource: 'ai' | 'local' | null;
  run?: WorkflowRun;
  issues: string[];
  error: string;
  reviewingAi?: boolean;
}

/** Presentation of observed work only. A missing artifact is never a completed step. */
export function describeProcess(input: ProcessInput): ProcessState {
  const { generatedCount, measuredPairs, assessmentSource } = input;
  const step = (id: string, label: string, detail: string) => ({ id, label, detail, status: 'pending' as ProcessStepStatus });
  const steps = [
    step('evidence', 'Prepare evidence', 'Read scans, geometry and available CBCT.'),
    step('plan', 'Create the plan', 'Locate scanned spaces and prepare a draft automatically.'),
    step('create', 'Create implant concepts', 'Build fixture, abutment and crown concepts.'),
    step('fit', 'Place & fit concepts', 'Fit supported sites to the current scan pose.'),
    step('review', 'Check the draft', 'Report sampled distances, findings and unresolved questions automatically.'),
  ];
  const cancelled = input.workflowPaused || input.run?.status === 'cancelled';
  const continuing = input.run?.status === 'running' && !cancelled && !input.error;
  const working = input.preparing || input.assessing || input.generating || input.reviewingAi
    || ((input.queued || continuing) && !cancelled && !input.error);
  const stale = input.run?.status === 'stale' || input.staleCount > 0;
  const finished = !!input.run && ['complete', 'partial'].includes(input.run.status);
  const hasDraft = input.hasAssessment || generatedCount > 0;
  const measurementsReady = !input.needsMeasurements || input.measurementsReady;
  const issues = [...new Set(input.issues)];
  if (stale) issues.unshift('Evidence changed. Prepare a current draft; older concepts remain available for comparison.');
  if (finished && !generatedCount) issues.push('No concept was generated. Review the site evidence; the app will not invent an implant position.');
  if (input.measurementPaused && hasDraft) issues.push('Surface analysis is paused. Current distances are unchecked; analysis can be resumed in the draft details.');
  if (input.error) issues.unshift(input.error);
  const state: ProcessState = {
    status: 'empty', title: 'Start with patient files', detail: 'Add scans to prepare a case. The process will appear here.',
    steps, canStart: false, canResume: false, canUseLocal: false, issues,
    generatedCount, measuredPairs, measurementsReady, assessmentSource,
  };
  steps[0].status = input.evidenceReady ? 'complete' : input.preparing ? 'running' : 'pending';
  if (input.hasAssessment) { steps[1].status = 'complete'; steps[1].detail = assessmentSource === 'local' ? 'Local geometry assessment available.' : 'AI assessment available.'; }
  if (generatedCount) {
    steps[2].status = steps[3].status = 'complete';
    steps[2].detail = `${generatedCount} concept ${generatedCount === 1 ? 'assembly' : 'assemblies'} built.`;
    steps[3].detail = 'Local fitting completed; clinical fit remains unvalidated.';
  }
  if (!input.scanCount && !input.preparing && !input.error) return state;
  if ((input.preparing || input.queued) && !cancelled && !input.error) {
    state.status = 'preparing'; state.title = 'Preparing the case';
    state.detail = input.preparationStage || 'Reading geometry and preparing current evidence.';
    if (!input.evidenceReady) steps[0].status = 'running';
  } else if (input.assessing) {
    state.status = 'running'; state.title = 'Creating the plan';
    state.detail = input.preparationStage || 'Assessing the prepared evidence.'; steps[1].status = 'running';
  } else if (input.generating) {
    state.status = 'running'; state.title = input.generationPhase === 'fitting' ? 'Placing & fitting concepts' : 'Creating implant concepts';
    state.detail = input.generationDetail || 'Building editable concepts in detected gaps.';
    steps[2].status = input.generationPhase === 'fitting' ? 'complete' : 'running';
    steps[3].status = input.generationPhase === 'fitting' ? 'running' : 'pending';
  } else if (input.reviewingAi) {
    state.status = 'running'; state.title = 'AI is reviewing the draft';
    state.detail = 'Reviewing placed concepts, current surface measurements and shared evidence automatically. Findings are annotations; clinical fit remains unvalidated.';
    steps[4].status = 'running'; steps[4].detail = 'Preparing an evidence-based review of the completed local work.';
  } else if (cancelled && !input.error) {
    state.status = 'paused'; state.title = 'Workflow paused'; state.detail = 'Completed work is retained. Continue locally without another AI request.';
    state.canResume = input.hasArch;
  } else if (input.error && !hasDraft) {
    state.status = 'error'; state.title = 'Preparation needs attention'; state.detail = 'Review the evidence, then retry the workflow.';
    steps[input.evidenceReady ? 1 : 0].status = 'attention';
    state.canResume = input.hasArch;
  } else if (!input.hasArch) {
    state.status = 'needs-input'; state.title = 'Arch geometry is unavailable'; state.detail = 'Add a usable upper or lower arch scan, or correct its role in Advanced tools.'; steps[0].status = 'attention';
  } else if (hasDraft && (finished || !input.run || stale || !!input.error)) {
    if (!measurementsReady && input.measuring && !stale && !input.error) {
      state.status = 'running'; state.title = 'Checking surface relationships'; state.detail = 'Measuring current surfaces in the background. Samples do not establish clinical clearance.'; steps[4].status = 'running';
    } else {
      // Findings annotate a completed draft. Only unavailable work needs recovery;
      // uncertain identity and clinical review never become approval gates.
      const needsRecovery = stale || !!input.error || !generatedCount;
      state.status = needsRecovery ? 'needs-input' : 'review'; state.title = needsRecovery ? 'Draft needs attention' : 'Draft ready to inspect';
      state.detail = generatedCount ? 'Concepts are in the scene. Findings and fitting limits are available to inspect; no approval is needed to finish the draft.' : 'The assessment is available. Supported site geometry is needed before concepts can be created.';
      steps[2].status = steps[3].status = generatedCount ? 'complete' : 'skipped';
      if (!generatedCount) { steps[2].detail = 'No supported concept generated.'; steps[3].detail = 'No concept placed.'; }
      steps[4].status = needsRecovery || !measurementsReady ? 'attention' : 'complete';
      steps[4].detail = measurementsReady ? `${measuredPairs} nearby or intersecting pairs reported. Clinical fit remains unvalidated.` : 'Current surface measurements are unavailable; the concepts remain inspectable.';
      state.canResume = stale && input.hasArch;
    }
  } else if (continuing) {
    state.status = 'running'; state.title = 'Continuing the draft';
    state.detail = 'The automatic workflow is moving to the next stage. No approval is needed between planning, generation, fitting and checks.';
  } else {
    state.status = 'ready'; state.title = 'Ready to begin'; state.detail = 'Start once. Concepts, fitting and checks continue automatically.';
  }
  state.canStart = input.hasArch && input.evidenceReady && input.configured !== null && !working && !input.measuring;
  state.canUseLocal = input.hasArch && input.evidenceReady && !working && (input.error !== '' || cancelled);
  return state;
}
