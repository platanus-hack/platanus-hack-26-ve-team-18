import type { CbctPipelineState } from './cbct-pipeline';
import './cbct-pipeline-toast.css';

interface Props {
  state: CbctPipelineState;
  /** Raise the toast above the mesh import indicator when both are visible. */
  stacked?: boolean;
  onCancel: () => void;
  onDismiss: () => void;
}

const STEPS = ['Loading CBCT', 'Rendering', 'Aligning', 'Done'] as const;
const STEP_INDEX: Record<CbctPipelineState['stage'], number> = { loading: 0, series: 0, rendering: 1, aligning: 2, done: 3, error: -1 };

function Check() {
  return <svg viewBox="0 0 14 14" width="13" height="13" aria-hidden="true" className="cbct-check-icon"><circle cx="7" cy="7" r="6.4" className="cbct-check-circle" /><path d="M4.2 7.2l2 2 3.8-4" fill="none" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="cbct-check-path" /></svg>;
}

export function CbctPipelineToast({ state, stacked, onCancel, onDismiss }: Props) {
  const cancellable = state.stage === 'loading' || state.stage === 'rendering' || state.stage === 'aligning';
  const dismissible = state.stage === 'error' || state.stage === 'done' || state.stage === 'series';
  return <section className={`cbct-pipeline-toast${stacked ? ' above-import' : ''}`} aria-label="CBCT import progress">
    <div className="cbct-pipeline-heading"><strong>CBCT superimposition</strong></div>
    {state.stage === 'error' ? <p className="cbct-pipeline-error" role="alert">{state.detail}</p> : <ol className="cbct-pipeline-steps">
      {STEPS.map((label, index) => {
        const current = STEP_INDEX[state.stage];
        const done = state.stage === 'done' || index < current;
        const active = index === current && state.stage !== 'done';
        return <li key={label} className={`cbct-pipeline-step${done ? ' done' : ''}${active ? ' active' : ''}`}>
          <span className="step-marker">{done ? <Check /> : active ? <span className="spinner" /> : <span className="step-dot" />}</span>{label}</li>;
      })}
    </ol>}
    <p className="cbct-pipeline-detail" role="status" aria-live="polite">{state.detail}</p>
    {state.stage === 'series' && <p className="cbct-pipeline-hint">Pick the series in the CBCT panel to continue.</p>}
    {(cancellable || dismissible) && <div className="cbct-pipeline-actions">
      {cancellable && <button onClick={onCancel}>Cancel</button>}
      {dismissible && <button className="primary" onClick={onDismiss}>{state.stage === 'done' ? 'Done' : 'Dismiss'}</button>}
    </div>}
  </section>;
}
