import { useState } from 'react';
import type { PreparedIdentity } from './case-preparation-types';
import type { SiteHypothesis } from './missing-sites';
import type { WorkflowProgress } from './draft-workflow';
import { WORKFLOW_STAGE_LABELS, WORKFLOW_BUDGET, effortSummary, type WorkflowRun, type CorrectionEvent } from './case-workflow';
import { FDI_TEETH, toothArch } from './teeth';
import './workflow-review.css';

export interface WorkflowReviewProps {
  identities?: PreparedIdentity[]; sites?: SiteHypothesis[];
  confidenceThreshold?: number; onThreshold?: (threshold: number) => void;
  manualMode?: boolean; onManualMode?: (value: boolean) => void;
  progress?: WorkflowProgress; timings?: { stage: string; durationMs: number }[];
  onStart?: () => void; onCancel?: () => void;
  onIdentity?: (identity: PreparedIdentity, fdi: number | null) => void;
  onSite?: (site: SiteHypothesis, fdi: number | null) => void;
  onSave?: () => void; onReopen?: () => void; sessionBusy?: boolean;
  mmPerUnit?: number | null; unitsProvenance?: string;
  onUnits?: (value: number | null, provenance: string) => void;
  workflowRuns?: WorkflowRun[]; correctionEvents?: CorrectionEvent[];
  onResume?: () => void;
  onFocusSite?: (site: SiteHypothesis) => void;
  onGenerateSite?: (fdi: number) => void;
  biteReviewed?: boolean; onBiteReviewed?: (value: boolean) => void;
  onOrientationInput?: () => void;
}

const percent = (value: number) => `${Math.round(value * 100)}%`;
const length = (value: number | null) => value === null ? 'Unknown' : `${value.toFixed(2)} u`;

function IdentityException({ identity, onIdentity }: { identity: PreparedIdentity; onIdentity?: WorkflowReviewProps['onIdentity'] }) {
  const [fdi, setFdi] = useState(identity.fdi ?? identity.alternatives[0] ?? 0);
  const suggested = identity.fdi ?? identity.alternatives[0];
  const choices = suggested ? FDI_TEETH.filter(code => toothArch(code) === toothArch(suggested)) : FDI_TEETH;
  return <li className="workflow-exception"><div className="planning-row"><strong>Region C{identity.candidateId}</strong><span><span className="num">{percent(identity.confidence)}</span> evidence score</span></div><p>{identity.reason}</p>
    <div className="workflow-exception-actions"><select aria-label={`Identity for ${identity.partId} region C${identity.candidateId}`} value={fdi} onChange={event => setFdi(Number(event.target.value))}><option value={0}>Unresolved</option>{choices.map(code => <option value={code} key={code}>FDI {code}</option>)}</select>
      <button type="button" disabled={!fdi} onClick={() => onIdentity?.(identity, fdi)}>Use in draft</button><button type="button" onClick={() => onIdentity?.(identity, null)}>Skip</button></div></li>;
}

function SiteException({ site, onSite, onSelect, threshold, onFocus, onGenerate }: { site: SiteHypothesis; onSite?: WorkflowReviewProps['onSite']; onSelect: (fdi: number) => void; threshold: number; onFocus?: (site: SiteHypothesis) => void; onGenerate?: (fdi: number) => void }) {
  const [fdi, setFdi] = useState(site.fdi ?? 0);
  const choices = FDI_TEETH.filter(code => toothArch(code) === site.arch);
  const canUse = site.anchor && site.frame && !['not-scanned', 'segmentation-unresolved'].includes(site.status);
  const automaticDraft = !!canUse && !!site.draftIdentity;
  const label = site.draftIdentity || site.fdi === null ? `${site.arch === 'upper' ? 'Upper' : 'Lower'} draft site` : `Space FDI ${site.fdi}`;
  return <li className="workflow-exception"><div className="planning-row"><button className="planning-tooth" type="button" onClick={() => { onFocus?.(site); if (site.fdi !== null && !site.draftIdentity) onSelect(site.fdi); }}>{label}</button><span><span className="num">{percent(site.confidence)}</span> evidence score</span></div>
    <p>{automaticDraft ? 'Automatic draft available · anatomical identity unresolved' : site.status.replaceAll('-', ' ')} · {site.kind === 'bounded' ? 'Bounded by scanned crowns' : 'Coverage needs review'}</p>
    {automaticDraft && <p className="planning-muted">This localized space can generate and fit automatically. Its crown template illustrates anatomy; it does not establish patient side or an FDI identity. No identity approval is needed to continue.</p>}
    <dl className="workflow-space"><div><dt>Along arch</dt><dd>{length(site.space.mesiodistal.value)}</dd></div><div><dt>Across arch</dt><dd>{length(site.space.buccolingual.value)}</dd></div><div><dt>Current-pose height</dt><dd>{length(site.space.vertical.value)}</dd></div></dl>
    <details><summary>Why this space · evidence and limits</summary><p>{site.frameBasis}</p><ul>{[...site.evidence.supporting, ...site.evidence.conflicting, ...site.questions].map((text, index) => <li key={index}>{text}</li>)}</ul><p>{site.space.mesiodistal.method} {site.space.vertical.method}</p></details>
    {canUse && (site.draftIdentity || site.confidence < threshold || site.status === 'identity-unresolved') && <details><summary>Optional identity correction & skip</summary>
      {site.draftIdentity && <p>Illustrative crown template: FDI <span className="num">{site.draftIdentity.templateFdi}</span>. {site.draftIdentity.basis}{site.draftIdentity.alternatives.length > 0 && <> Alternative anatomy templates: <span className="num">{site.draftIdentity.alternatives.join(', ')}</span>.</>} These are hypotheses, separate from reviewed chart records.</p>}
      <div className="workflow-exception-actions"><select aria-label={`Draft identity for space ${site.id}`} value={fdi} onChange={event => setFdi(Number(event.target.value))}><option value={0}>Unresolved</option>{choices.map(code => <option value={code} key={code}>FDI {code}</option>)}</select><button type="button" disabled={!fdi} onClick={() => onSite?.(site, fdi)}>Use this hypothesis</button><button type="button" onClick={() => onSite?.(site, null)}>Skip</button></div>
    </details>}
    {canUse && site.fdi !== null && !site.draftIdentity && site.status !== 'identity-unresolved' && <details><summary>Optional generation tools</summary><button type="button" onClick={() => { onFocus?.(site); onGenerate?.(site.fdi!); }}>Generate / inspect this site</button></details>}
  </li>;
}

export function WorkflowSettings(props: WorkflowReviewProps & { disabled: boolean }) {
  return <details className="planning-section planning-secondary"><summary>Advanced automation & physical units</summary>
    <label className="workflow-setting">Highlight below evidence score <output>{percent(props.confidenceThreshold ?? .8)}</output><input type="range" min="0.5" max="0.99" step="0.01" value={props.confidenceThreshold ?? .8} disabled={props.disabled} onChange={event => props.onThreshold?.(event.currentTarget.valueAsNumber)} /></label>
    <p className="planning-muted">This is an uncalibrated geometry evidence score. Highlights invite optional corrections; routine findings do not pause the automatic draft. Higher scores stay editable hypotheses and do not become reviewed clinical records.</p>
    <label className="planning-check"><input type="checkbox" checked={props.manualMode ?? false} disabled={props.disabled} onChange={event => props.onManualMode?.(event.target.checked)} />I want to generate sites manually</label>
    <form onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); const value = Number(data.get('mmPerUnit')); const provenance = String(data.get('provenance') ?? '').trim(); if (value > 0 && Number.isFinite(value) && provenance) props.onUnits?.(value, provenance); }}><label className="workflow-setting">Confirmed millimetres per file unit<input name="mmPerUnit" type="number" min="0.000000001" step="any" defaultValue={props.mmPerUnit ?? ''} placeholder="Unconfirmed" disabled={props.disabled} /></label><label className="workflow-setting">Source of calibration<input name="provenance" defaultValue={props.mmPerUnit ? props.unitsProvenance : ''} placeholder="Scanner metadata or measured reference" disabled={props.disabled} /></label><button type="submit" disabled={props.disabled}>Record calibration</button></form>
    <p className="planning-muted">{props.unitsProvenance} Geometry controls continue to use source file units (u).</p>
    {!!props.mmPerUnit && <button type="button" disabled={props.disabled} onClick={() => props.onUnits?.(null, 'Physical calibration withdrawn; source file units only.')}>Return to unconfirmed file units</button>}
  </details>;
}

export function WorkflowReview(props: WorkflowReviewProps & { onSelect: (fdi: number) => void }) {
  const identities = props.identities ?? [], sites = props.sites ?? [];
  const exceptions = identities.filter(identity => identity.needsReview && !identity.reason.startsWith('Skipped'));
  return <section className="planning-section workflow-review"><div className="planning-row"><h3>Draft findings & optional corrections</h3><span className="planning-badge"><span className="num">{exceptions.length}</span> identity notes</span></div>
    <p><span className="num">{identities.filter(identity => !identity.needsReview).length}</span> identities prefilled as drafts. Saved labels and clinical records stay protected.</p>
    <p className="planning-muted">Findings and review annotations do not require approval to generate supported drafts. Missing scan geometry and failed preparation remain explicit.</p>
    {!!exceptions.length && <details><summary>Optional identity corrections · <span className="num">{exceptions.length}</span></summary><ul className="workflow-exceptions">{exceptions.map(identity => <IdentityException key={`${identity.partId}:${identity.candidateId}`} identity={identity} onIdentity={props.onIdentity} />)}</ul></details>}
    {!exceptions.length && <p className="planning-muted">No tooth identity exceptions at this threshold.</p>}
    {!!sites.length && <><h3>Localized spaces</h3><ul className="workflow-exceptions">{[...sites].sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.priority] - { high: 0, medium: 1, low: 2 }[b.priority])).map(site => <SiteException key={site.id} site={site} onSite={props.onSite} onSelect={props.onSelect} onFocus={props.onFocusSite} onGenerate={props.onGenerateSite} threshold={props.confidenceThreshold ?? .8} />)}</ul></>}
    {!!props.timings?.length && <details><summary>Recorded preparation time</summary>{props.timings.map((timing, index) => <p key={index}>{timing.stage}: <span className="num">{(timing.durationMs / 1000).toFixed(1)} s</span></p>)}<p className="planning-muted">Measured in this session. No manual baseline or clinical accuracy is inferred.</p></details>}
  </section>;
}

export function WorkflowJournal(props: WorkflowReviewProps) {
  const run = props.workflowRuns?.at(-1), effort = effortSummary(props.correctionEvents ?? [], props.timings ?? []);
  if (!run) return null;
  return <details className="planning-section planning-secondary"><summary>Workflow record · {run.status} · <span className="num">{effort.correctionSteps}</span> corrections</summary>
    <ol className="workflow-stage-record">{run.stages.map(stage => <li key={stage.id}><strong>{WORKFLOW_STAGE_LABELS[stage.id]}</strong> · {stage.status}<p>{stage.detail}</p></li>)}</ol>
    {['cancelled', 'stale', 'partial'].includes(run.status) && <button type="button" onClick={props.onResume}>Resume local draft</button>}
    <p><span className="num">{effort.correctionSteps}</span> explicit correction actions recorded. Measured preparation: <span className="num">{(effort.measuredMs / 1000).toFixed(1)} s</span>. No equivalent manual baseline is recorded; time saved and clinical accuracy are unknown.</p>
    <p>Per run: <span className="num">{WORKFLOW_BUDGET.providerRequests} provider requests</span> (planning and final review), up to <span className="num">{WORKFLOW_BUDGET.providerSteps} model steps</span>, <span className="num">{WORKFLOW_BUDGET.toolCalls} tool calls</span> and <span className="num">{WORKFLOW_BUDGET.outputTokensPerStep.toLocaleString()} output tokens per step</span>; <span className="num">{WORKFLOW_BUDGET.sites} sites</span>, <span className="num">{WORKFLOW_BUDGET.candidatesPerSite} fit candidates/site</span>, <span className="num">{WORKFLOW_BUDGET.fitMsPerSite / 1000} s</span> fitting/site, <span className="num">{WORKFLOW_BUDGET.workflowMs / 1000} s</span> for planning/generation plus <span className="num">{WORKFLOW_BUDGET.reviewMs / 1000} s</span> for the final AI review. Provider charges depend on the account; failed requests may still incur usage.</p>
    <details><summary>Local tool results · <span className="num">{run.tools.length}</span></summary>{run.tools.map((tool, index) => <p key={index}><strong>{tool.name}</strong> · {tool.status} · {tool.detail}</p>)}</details>
  </details>;
}
