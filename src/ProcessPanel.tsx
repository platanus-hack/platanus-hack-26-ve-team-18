import { useId } from 'react';
import { AnthropicModelSelect } from './AnthropicModelSelect';
import { AIActivity } from './AIActivity';
import type { CasePlanningResult } from './case-planning-types';
import type { PlanningActivity } from './planning-events';
import type { ProcessState } from './guided-process';
import './process-panel.css';

export interface ProcessPanelProps {
  state: ProcessState;
  aiConfigured: boolean | null;
  model: string;
  defaultModel?: string;
  modelLabel: string;
  modelLocked: boolean;
  onModel: (model: string) => void;
  scanCount: number;
  cbctLoaded: boolean;
  cbctShared: boolean;
  onCbctShared: (value: boolean) => void;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onLocal: () => void;
  onImport: () => void;
  onReview: () => void;
  onEvidence: () => void;
  onSave: () => void;
  onExport: () => void;
  onSettings: () => void;
  sessionBusy: boolean;
  canPause?: boolean;
  review?: { text: string; model: string };
  alignmentNotice?: string;
  aiActivity?: PlanningActivity[];
  assessment?: CasePlanningResult | null;
}

const STATUS_LABELS: Record<ProcessState['status'], string> = {
  empty: 'Your next case',
  preparing: 'Preparing',
  ready: 'Ready',
  running: 'In progress',
  paused: 'Paused',
  'needs-input': 'Needs your attention',
  error: 'Workflow stopped',
  review: 'Draft available',
};

const STEP_LABELS: Record<ProcessState['steps'][number]['status'], string> = {
  pending: 'Pending',
  running: 'In progress',
  complete: 'Complete',
  attention: 'Needs review',
  skipped: 'Skipped',
};

function ArrowIcon() {
  return <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M3.25 8h9.5m-4-4 4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

function CheckIcon() {
  return <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="m4 8 2.5 2.5L12 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

export function ProcessPanel(props: ProcessPanelProps) {
  const id = useId();
  const { state, aiConfigured, sessionBusy } = props;
  const working = state.status === 'preparing' || state.status === 'running';
  const needsAttention = state.status === 'needs-input' || state.status === 'error';
  const reviewing = state.status === 'review';
  const hasDraft = state.assessmentSource !== null || state.generatedCount > 0;
  const issues = state.issues.slice(0, 3);
  const remainingIssues = state.issues.length - issues.length;
  const activeIndex = state.steps.findIndex(step => step.status === 'running' || step.status === 'attention');
  const currentIndex = state.status === 'empty' ? -1 : reviewing ? state.steps.length - 1
    : activeIndex >= 0 ? activeIndex : state.steps.findIndex(step => step.status === 'pending');
  const startLabel = aiConfigured ? 'Start AI workflow' : 'Start local workflow';
  const canStart = state.canStart && aiConfigured !== null && !sessionBusy;
  const hasAIActivity = !!props.aiActivity?.length || !!props.assessment?.execution;
  const hasAIContext = hasAIActivity || aiConfigured === true && state.assessmentSource !== 'local' && state.steps[0]?.status === 'complete';
  const waitingForAI = state.status === 'running' && state.steps.some(step => step.status === 'running'
    && (step.id === 'plan' || step.id === 'review' && state.assessmentSource === 'ai'));

  const primaryAction = state.status === 'empty' || (needsAttention && !hasDraft && props.scanCount === 0)
    ? { label: 'Add patient files', onClick: props.onImport, disabled: sessionBusy }
    : state.status === 'ready'
      ? { label: startLabel, onClick: props.onStart, disabled: !canStart }
      : state.status === 'paused'
        ? { label: 'Resume workflow', onClick: props.onResume, disabled: !state.canResume || sessionBusy }
        : needsAttention
          ? { label: hasDraft ? 'Inspect draft details' : 'Inspect scan evidence', onClick: hasDraft ? props.onReview : props.onEvidence, disabled: sessionBusy }
          : reviewing
            ? { label: 'Inspect draft details', onClick: props.onReview, disabled: sessionBusy }
            : null;

  return <section className="process-panel" aria-labelledby={`${id}-title`} data-status={state.status}>
    <header className="process-panel__header">
      <p className="process-panel__eyebrow">Case workflow</p>
      <span className="process-panel__scan-count">{props.scanCount.toLocaleString()} {props.scanCount === 1 ? 'scan' : 'scans'}</span>
    </header>

    <div className="process-panel__hero" role="status" aria-live="polite" aria-atomic="true">
      <p className="process-panel__status">
        <span className={`process-panel__indicator${working ? ' process-panel__indicator--busy' : ''}`} aria-hidden="true" />
        {STATUS_LABELS[state.status]}
      </p>
      <h2 id={`${id}-title`}>{state.title}</h2>
      <p className="process-panel__detail">{state.detail}</p>
    </div>

    <ol className="process-panel__timeline" aria-label="Workflow stages" role="list">
      {state.steps.map((step, index) => <li
        key={step.id}
        className="process-panel__step"
        data-status={step.status}
        data-active={index === currentIndex || undefined}
        data-working={working && step.status === 'running' || undefined}
        aria-current={index === currentIndex ? 'step' : undefined}
      >
        <span className="process-panel__step-marker" aria-hidden="true">
          {step.status === 'complete' ? <CheckIcon /> : step.status === 'attention' ? '!' : step.status === 'skipped' ? '–' : index + 1}
        </span>
        <div className="process-panel__step-copy">
          <p className="process-panel__step-label">{step.label}<span className="process-panel__sr-only"> · {step.status === 'running' && !working ? STATUS_LABELS[state.status] : STEP_LABELS[step.status]}</span></p>
          <p className="process-panel__step-detail">{step.detail}</p>
        </div>
      </li>)}
    </ol>

    <AIActivity aiActivity={props.aiActivity} assessment={props.assessment}
      status={!hasAIContext ? undefined
        : state.status === 'paused' ? 'cancelled' : state.status === 'error' ? 'error'
          : state.status === 'needs-input' ? 'incomplete' : reviewing ? hasAIActivity ? 'complete' : undefined
            : waitingForAI || working && hasAIActivity ? 'running' : undefined} />

    {(reviewing || (needsAttention && hasDraft)) && <div className="process-panel__review">
    <p className="process-panel__source">{state.assessmentSource === 'ai' ? 'AI-directed design' : state.assessmentSource === 'local' ? 'Local geometry assessment' : 'Case summary'}</p>
      <dl className="process-panel__metrics">
        <div><dt>{state.generatedCount === 1 ? 'Concept created' : 'Concepts created'}</dt><dd>{state.generatedCount.toLocaleString()}</dd></div>
        <div><dt>Surface {state.measuredPairs === 1 ? 'pair' : 'pairs'} reported</dt><dd>{state.measurementsReady ? state.measuredPairs.toLocaleString() : '—'}</dd></div>
      </dl>
      {!state.measurementsReady ? <p className="process-panel__note">Current surface measurements are unavailable.</p>
        : state.measuredPairs === 0 && <p className="process-panel__note">No nearby or intersecting surface pairs reported.</p>}
    </div>}
    {!working && props.review && <section className="process-panel__ai-review" aria-label="AI draft review">
      <h3>AI draft review <span>· {props.review.model}</span></h3>
      <p>{props.review.text.slice(0, 260)}{props.review.text.length > 260 ? '…' : ''}</p>
      {props.review.text.length > 260 && <details><summary>Read full review</summary><p>{props.review.text}</p></details>}
      <small>AI revisions are measured locally and retained only when the host accepts them. Clinical fit remains unvalidated.</small>
    </section>}

    {(needsAttention || reviewing) && issues.length > 0 && <div className="process-panel__issues" aria-labelledby={`${id}-issues`}>
      <h3 id={`${id}-issues`}>{needsAttention ? 'Workflow details' : 'Draft findings'}</h3>
      <ul>{issues.map((issue, index) => <li key={`${index}-${issue}`}>{issue}</li>)}</ul>
      {remainingIssues > 0 && <p className="process-panel__note"><span className="num">{remainingIssues}</span> more {remainingIssues === 1 ? 'item' : 'items'} in the draft details.</p>}
      {reviewing && <p className="process-panel__note">These findings do not pause draft generation or require approval.</p>}
    </div>}

    {state.status === 'ready' && props.alignmentNotice && <p className="process-panel__note" role="status">{props.alignmentNotice}</p>}
    {state.status === 'ready' && issues.length > 0 && <p className="process-panel__note"><span className="num">{issues.length}</span> scan context {issues.length === 1 ? 'note' : 'notes'} available in Advanced tools. You can start the draft now.</p>}

    <AnthropicModelSelect label="Workflow model" value={props.model} defaultModel={props.defaultModel}
      disabled={props.modelLocked} onChange={props.onModel} />

    {state.status !== 'empty' && state.status !== 'paused' && !reviewing && <div className="process-panel__provider" id={`${id}-provider`}>
      <p className="process-panel__provider-label">{aiConfigured === null ? 'Checking AI availability' : aiConfigured ? `Anthropic${props.modelLabel ? ` · ${props.modelLabel}` : ''}` : 'Local workflow'}</p>
      <p>{aiConfigured === null ? 'Provider availability must be resolved before starting.' : aiConfigured
        ? 'AI uses the repository design skill to review regions, choose sites and design implant, pilar and crown parameters. Local tools build and measure those choices. Up to 6 bounded AI requests share rendered views and measurements for planning, measured follow-up and final review; raw mesh files stay local. Requested revisions remain pending until local work returns an applied result.'
        : 'AI is not configured. The workflow uses local geometry.'}</p>
    </div>}

    {props.cbctLoaded && <label className="process-panel__sharing">
      <input
        type="checkbox"
        checked={props.cbctShared}
        disabled={working || sessionBusy || aiConfigured !== true}
        onChange={event => props.onCbctShared(event.currentTarget.checked)}
        aria-describedby={`${id}-cbct-note`}
      />
      <span><span className="process-panel__sharing-label">Include CBCT views with AI</span>
        <span className="process-panel__sharing-note" id={`${id}-cbct-note`}>Optional · rendered views shared with Anthropic.</span>
      </span>
    </label>}

    <div className="process-panel__actions">
      {primaryAction && <button
        type="button"
        className="process-panel__primary"
        onClick={primaryAction.onClick}
        disabled={primaryAction.disabled}
        aria-describedby={state.status === 'ready' ? `${id}-provider` : undefined}
      >{primaryAction.label}<ArrowIcon /></button>}

      {working && props.canPause !== false && <button type="button" className="process-panel__pause" onClick={props.onPause} disabled={sessionBusy}>
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5.5 4v8m5-8v8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        Pause workflow
      </button>}

      {needsAttention && (!hasDraft || state.canUseLocal) && (state.canStart || state.canUseLocal) && <div className="process-panel__alternatives">
        {state.canStart && <button type="button" onClick={props.onStart} disabled={!canStart} aria-describedby={`${id}-provider`}>Retry {aiConfigured ? 'AI' : 'local'} workflow</button>}
        {state.canUseLocal && <button type="button" onClick={props.onLocal} disabled={sessionBusy}>Continue locally</button>}
      </div>}
      {needsAttention && state.canResume && <button type="button" onClick={props.onResume} disabled={sessionBusy}>Resume local workflow</button>}

      {(reviewing || (needsAttention && hasDraft)) && <>
        <div className="process-panel__session-actions" aria-busy={sessionBusy}>
          <button type="button" onClick={props.onSave} disabled={sessionBusy}>Save session</button>
          <button type="button" onClick={props.onExport} disabled={sessionBusy}>Export</button>
        </div>
        <p className="process-panel__session-status" role="status">{sessionBusy ? 'Session operation in progress…' : ''}</p>
      </>}
    </div>

    <footer className="process-panel__footer">
      <button type="button" className="process-panel__advanced" onClick={props.onSettings} disabled={sessionBusy}>
        Advanced tools<ArrowIcon />
      </button>
      <p>Role, side and bite corrections are optional in Advanced tools. Concepts require clinical review. Distances are sampled in file units; contact area and overlap volume are not measured.</p>
    </footer>
  </section>;
}
