import { useId, useState } from 'react';
import type { CasePlanningResult } from './case-planning-types';
import type { PlanningActivity } from './planning-events';
import './workflow-review.css';

export interface AIActivityProps {
  aiActivity?: PlanningActivity[];
  assessment?: CasePlanningResult | null;
  status?: 'running' | 'complete' | 'error' | 'cancelled' | 'incomplete';
}

const MAX_RECORDS = 16;
const MAX_DETAIL_BYTES = 3000;
const TOOL_LABELS: Record<string, string> = {
  inspectPreparedCase: 'Inspect prepared scans',
  evaluateMissingSite: 'Inspect site evidence',
  chooseAnatomicalCandidate: 'Inspect anatomy options',
  requestDraftComponents: 'Queue component design',
  inspectToothRegion: 'Inspect tooth region settings',
  reviewToothRegions: 'Review region settings',
  reviewRestorationSite: 'Review restoration site choice',
  inspectPlacementRules: 'Audit placement rules',
  getRestorationDesign: 'Read current design measurements',
  requestRestorationEdit: 'Request local design revision',
  getDentalDesignGuidance: 'Read design guidance',
  getModelInventory: 'Inspect scan inventory',
  getToothChart: 'Read tooth chart',
  inspectImplantSite: 'Inspect site marker',
  getCollisionReport: 'Read surface measurements',
  getBiteFitReport: 'Read bite alignment',
  inspectSurfaceProbe: 'Inspect selected surface',
  measureSiteDistance: 'Measure site distance',
  inspectTomographyView: 'Inspect shared CBCT view',
  requestTomographyView: 'Request CBCT view',
  reviewMeasuredRestoration: 'Review generated component measurements',
  measurementFollowUp: 'Complete measurement follow-up',
  applyAndMeasureRestorationEdit: 'Build and measure design revision',
};

const clip = (text: string, limit = 120) => text.length > limit ? `${text.slice(0, limit)}…` : text;
const duration = (ms?: number) => typeof ms === 'number' && Number.isFinite(ms) && ms >= 0
  ? ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s` : null;
const count = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value) && value >= 0
  ? Math.round(value).toLocaleString() : 'Unknown';
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : null;

// Bound traversal before serialization as well as the UTF-8 text sent to React.
// Tool payloads may be large, deeply nested, cyclic, or from a reopened session.
function preview(value: unknown) {
  const seen = new WeakSet<object>();
  let nodes = 0;
  function bound(item: unknown, depth: number): unknown {
    if (++nodes > 128) return '[Detail limit reached]';
    if (typeof item === 'string') return clip(item, 1800);
    if (item === null || typeof item === 'number' || typeof item === 'boolean') return item;
    if (typeof item !== 'object') return String(item);
    if (seen.has(item)) return '[Repeated reference]';
    if (depth >= 5) return '[Nested detail omitted]';
    seen.add(item);
    if (Array.isArray(item)) return [...item.slice(0, 16).map(child => bound(child, depth + 1)), ...(item.length > 16 ? ['[More items omitted]'] : [])];
    const result: Record<string, unknown> = Object.create(null);
    let keys = 0;
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue;
      if (++keys > 16) { result['…'] = '[More fields omitted]'; break; }
      if (/^(reasoning|thinking|chainOfThought|chain_of_thought)$/i.test(key)) { result[clip(key)] = '[Not part of tool evidence]'; continue; }
      try { result[clip(key)] = bound((item as Record<string, unknown>)[key], depth + 1); }
      catch { result[clip(key)] = '[Unavailable value]'; }
    }
    return result;
  }
  const text = JSON.stringify(bound(value, 0), null, 2);
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= MAX_DETAIL_BYTES) return text;
  const suffix = '\n… [truncated]';
  const prefix = new TextDecoder().decode(bytes.slice(0, MAX_DETAIL_BYTES - new TextEncoder().encode(suffix).length)).replace(/\uFFFD$/, '');
  return prefix + suffix;
}

function callState(call: PlanningActivity, interrupted: boolean) {
  const output = object(call.output);
  if (call.phase === 'error' || typeof output?.status === 'string' && ['error', 'failed', 'budget-reached'].includes(output.status)) return 'Error';
  if (call.phase === 'running') return interrupted ? 'Interrupted · no result recorded' : 'Running';
  if (output?.queued === true) return 'Queued · awaiting local construction';
  if (output?.queued === false) return 'Not queued';
  if (output?.status === 'requested' || call.name === 'requestRestorationEdit' && output?.applied === false) return 'Edit requested · awaiting local application';
  if (output?.status === 'applied' || output?.applied === true) return 'Local edit reported applied';
  if (output?.recorded === true) return 'Draft decision recorded';
  if (output?.recorded === false) return 'Decision not recorded';
  if (output?.status === 'unavailable') return 'Evidence unavailable';
  return call.output === undefined ? 'No result recorded' : 'Result received';
}

export function AIActivity({ aiActivity, assessment, status }: AIActivityProps) {
  const id = useId();
  const [historyCount, setHistoryCount] = useState(MAX_RECORDS);
  const execution = assessment?.execution;
  // Live records already include completed results. Use saved evidence only when
  // no live records exist, so the same call never appears twice.
  const calls: PlanningActivity[] = aiActivity?.length ? aiActivity : (execution?.toolResults ?? []).map((call, index) => ({
    ...call, id: `saved-${index}`, phase: 'complete',
  }));
  if (!calls.length && !execution && !status) return null;
  const missingResults = status === 'complete' && calls.some(call => call.phase === 'running');
  const interrupted = status === 'cancelled' || status === 'error' || status === 'incomplete' || missingResults;
  const running = calls.some(call => call.phase === 'running') && !interrupted;
  const hasError = calls.some(call => callState(call, interrupted) === 'Error');
  const heading = status === 'cancelled' ? 'Workflow paused · recorded activity retained'
    : status === 'error' ? 'Workflow stopped · AI assessment may be incomplete'
      : status === 'incomplete' ? 'Workflow needs attention · review recorded evidence'
        : missingResults ? 'Some tool results are missing · review recorded evidence'
          : running ? 'Tool call in progress'
          : execution ? 'AI assessment recorded'
            : status === 'running' ? 'AI request in progress'
              : 'Assessment incomplete · tool activity retained';
  const visible = calls.slice(-Math.min(historyCount, 192));

  return <section className="ai-activity" aria-labelledby={`${id}-title`} data-status={interrupted || hasError ? 'attention' : running || status === 'running' && !execution ? 'running' : 'complete'}>
    <div className="ai-activity__header"><h3 id={`${id}-title`}>AI tool activity</h3><span>{calls.length} {calls.length === 1 ? 'call' : 'calls'} recorded</span></div>
    <p className="ai-activity__status" role="status" aria-live="polite">{heading}</p>
    {hasError && <p className="ai-activity__notice">A tool reported an error. A returned result does not establish a complete assessment.</p>}
    {execution && <dl className="ai-activity__usage">
      <div><dt>Provider</dt><dd>{clip(execution.provider)}</dd></div>
      <div><dt>Model</dt><dd>{clip(execution.actualModel || assessment?.model || 'Unknown')}</dd></div>
      <div><dt>Model steps</dt><dd>{count(execution.providerSteps)}</dd></div>
      <div><dt>Input / output tokens</dt><dd>{count(execution.inputTokens)} / {count(execution.outputTokens)}</dd></div>
      {duration(execution.durationMs) && <div><dt>AI request time</dt><dd>{duration(execution.durationMs)}</dd></div>}
      {execution.requestedModel !== execution.actualModel && <div><dt>Requested model</dt><dd>{clip(execution.requestedModel)}</dd></div>}
    </dl>}
    {!calls.length && <p className="ai-activity__empty">{status === 'running' && !execution ? 'No tool calls recorded yet.' : !execution && interrupted ? 'No tool calls were recorded before the workflow stopped.' : 'No tool calls were recorded for this assessment.'}</p>}
    {!calls.length && execution && !execution.draftRequests.length && <p className="ai-activity__notice">This assessment did not queue any restoration construction.</p>}
    {calls.length > visible.length && <p className="ai-activity__notice">Showing the latest {visible.length} of {calls.length} recorded calls. {visible.length < 192 && <button type="button" onClick={() => setHistoryCount(current => Math.min(192, current + MAX_RECORDS))}>Show earlier calls</button>}</p>}
    {!!visible.length && <ol className="ai-activity__calls" aria-label="Recorded AI tool calls">{visible.map((call, index) => {
      const state = callState(call, interrupted);
      const errorMessage = object(call.output)?.message;
      const label = Object.hasOwn(TOOL_LABELS, call.name) ? TOOL_LABELS[call.name] : clip(call.name.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll(/[_-]/g, ' '), 80);
      return <li key={`${call.id}-${index}`} className="ai-activity__call" data-phase={state === 'Error' ? 'error' : call.phase === 'running' && !interrupted ? 'running' : 'complete'}>
        <div className="ai-activity__call-heading"><strong>{label}</strong>{duration(call.durationMs) && <span>{duration(call.durationMs)}</span>}</div>
        <p className="ai-activity__call-state">{state}</p>
        {call.origin === 'structured-command' && <p className="ai-activity__notice">AI decision · local validation</p>}
        {state === 'Error' && typeof errorMessage === 'string' && <p className="ai-activity__notice">{clip(errorMessage, 400)}</p>}
        {call.output === undefined && call.phase !== 'running' && <p className="ai-activity__notice">Completion was reported without returned evidence.</p>}
        {(call.input !== undefined || call.output !== undefined) && <details className="ai-activity__details"><summary>Inspect inputs & returned evidence</summary>
          <p className="ai-activity__tool-name">Tool: {clip(call.name)}</p>
          {call.input !== undefined && <><h4>Inputs</h4><pre>{preview(call.input)}</pre></>}
          {call.output !== undefined && <><h4>Returned evidence</h4><pre>{preview(call.output)}</pre></>}
          <p className="ai-activity__notice">Detail previews are bounded; long values and nested fields may be omitted.</p>
        </details>}
      </li>;
    })}</ol>}
    <p className="ai-activity__footnote">Queue and edit acknowledgments record requests. Applied revisions, constructed artifacts and measurements appear in the local workflow record.</p>
  </section>;
}
