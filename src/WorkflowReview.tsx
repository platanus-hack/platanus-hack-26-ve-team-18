import { useState } from 'react';
import { AIActivity, type AIActivityProps } from './AIActivity';
import type { CasePlanningResult } from './case-planning-types';
import type { PlanningActivity } from './planning-events';
import type { PreparedIdentity } from './case-preparation-types';
import type { SiteHypothesis, SiteNeighbour } from './missing-sites';
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
  aiActivity?: PlanningActivity[];
  assessment?: CasePlanningResult | null;
}

const percent = (value: number) => `${Math.round(value * 100)}%`;
const length = (value: number | null) => value === null ? 'Unknown' : `${value.toFixed(2)} u`;
const toothReference = (tooth: SiteNeighbour | null | undefined) => !tooth ? 'Unresolved' : tooth.fdi === null ? 'Unnumbered crown' : `FDI ${tooth.fdi}${tooth.confidence < .8 ? ' (provisional)' : ''}`;

function IdentityException({ identity, onIdentity }: { identity: PreparedIdentity; onIdentity?: WorkflowReviewProps['onIdentity'] }) {
  const [fdi, setFdi] = useState(identity.fdi ?? identity.alternatives[0] ?? 0);
  const suggested = identity.fdi ?? identity.alternatives[0];
  const choices = suggested ? FDI_TEETH.filter(code => toothArch(code) === toothArch(suggested)) : FDI_TEETH;
  return <li className="workflow-exception"><div className="planning-row"><strong>Region C{identity.candidateId}</strong><span>{percent(identity.confidence)} evidence score</span></div><p>{identity.reason}</p>
    <div className="workflow-exception-actions"><select aria-label={`Identity for ${identity.partId} region C${identity.candidateId}`} value={fdi} onChange={event => setFdi(Number(event.target.value))}><option value={0}>Unresolved</option>{choices.map(code => <option value={code} key={code}>FDI {code}</option>)}</select>
      <button type="button" disabled={!fdi} onClick={() => onIdentity?.(identity, fdi)}>Use in draft</button><button type="button" onClick={() => onIdentity?.(identity, null)}>Skip</button></div></li>;
}

function SiteException({ site, onSite, onSelect, threshold, onFocus, onGenerate }: { site: SiteHypothesis; onSite?: WorkflowReviewProps['onSite']; onSelect: (fdi: number) => void; threshold: number; onFocus?: (site: SiteHypothesis) => void; onGenerate?: (fdi: number) => void }) {
  const [fdi, setFdi] = useState(site.fdi ?? 0);
  const choices = FDI_TEETH.filter(code => toothArch(code) === site.arch);
  const canUse = site.kind !== 'terminal' && site.anchor && site.frame && !['not-scanned', 'segmentation-unresolved'].includes(site.status);
  const automaticDraft = !!canUse && !!site.draftIdentity;
  const label = site.kind === 'terminal' ? `${site.arch === 'upper' ? 'Upper' : 'Lower'} terminal ridge` : site.draftIdentity || site.fdi === null ? `${site.arch === 'upper' ? 'Upper' : 'Lower'} draft site` : `Space FDI ${site.fdi}`;
  return <li className="workflow-exception"><div className="planning-row"><button className="planning-tooth" type="button" onClick={() => { if (onFocus) onFocus(site); else if (site.fdi !== null && !site.draftIdentity) onSelect(site.fdi); }}>{label}</button><span>{percent(site.confidence)} evidence score</span></div>
    <p>{automaticDraft ? 'Automatic draft available · anatomical identity unresolved' : site.status.replaceAll('-', ' ')} · {site.kind === 'bounded' ? 'Bounded by scanned crowns' : site.kind === 'distal-extension' ? 'Tentative free-end slot · clinical review required' : 'Coverage needs review'}</p>
    {site.kind === 'terminal' && <p className="planning-muted">Scanned surface beyond the last crown needs review. Confirm coverage, tooth history and position before selecting a replacement; this region does not trigger an automatic implant concept.</p>}
    {automaticDraft && <p className="planning-muted">This localized space can generate and fit automatically. Its crown template illustrates anatomy; it does not establish patient side or an FDI identity. No identity approval is needed to continue.</p>}
    <dl className="workflow-space"><div><dt>Along arch</dt><dd>{length(site.space.mesiodistal.value)}</dd></div><div><dt>Across arch</dt><dd>{length(site.space.buccolingual.value)}</dd></div><div><dt>Current-pose height</dt><dd>{length(site.space.vertical.value)}</dd></div></dl>
    <dl className="workflow-space"><div><dt>Mesial neighbour</dt><dd>{toothReference(site.adjacent?.mesial)}</dd></div><div><dt>Distal neighbour</dt><dd>{toothReference(site.adjacent?.distal)}</dd></div><div><dt>Opposing crowns</dt><dd>{site.opposing?.teeth.length ? site.opposing.teeth.map(toothReference).join(', ') : 'None established'}{site.opposing && ` · ${site.opposing.poseVerified ? 'reviewed static pose' : 'bite unverified'}`}</dd></div></dl>
    <details><summary>Why this space · evidence and limits</summary><p>{site.frameBasis}</p><ul>{[...site.evidence.supporting, ...site.evidence.conflicting, ...site.questions].map((text, index) => <li key={index}>{text}</li>)}</ul><p>{site.space.mesiodistal.method} {site.space.vertical.method}</p></details>
    {canUse && (site.draftIdentity || site.confidence < threshold || site.status === 'identity-unresolved') && <details><summary>Optional identity correction & skip</summary>
      {site.draftIdentity && <p>Illustrative crown template: FDI {site.draftIdentity.templateFdi}. {site.draftIdentity.basis}{site.draftIdentity.alternatives.length > 0 && ` Alternative anatomy templates: ${site.draftIdentity.alternatives.join(', ')}.`} These are hypotheses, separate from reviewed chart records.</p>}
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
    <p className="planning-muted">{props.unitsProvenance} {props.mmPerUnit ? 'Restoration dimension controls show mm at this scale; meshes keep their source file units (u).' : 'Restoration dimension controls use source file units (u) until a scale is set.'}</p>
    {!!props.mmPerUnit && <button type="button" disabled={props.disabled} onClick={() => props.onUnits?.(null, 'Physical calibration withdrawn; source file units only.')}>Return to unconfirmed file units</button>}
  </details>;
}

export function WorkflowReview(props: WorkflowReviewProps & { onSelect: (fdi: number) => void }) {
  const identities = props.identities ?? [], sites = props.sites ?? [];
  const exceptions = identities.filter(identity => identity.needsReview && !identity.reason.startsWith('Skipped'));
  return <section className="planning-section workflow-review"><div className="planning-row"><h3>Draft findings & optional corrections</h3><span className="planning-badge">{exceptions.length} identity notes</span></div>
    <AIActivity aiActivity={props.aiActivity} assessment={props.assessment} status={activityStatus(props)} />
    <p>{identities.filter(identity => !identity.needsReview).length} identities prefilled as drafts. Saved labels and clinical records stay protected.</p>
    <p className="planning-muted">Findings and review annotations do not require approval to generate supported drafts. Missing scan geometry and failed preparation remain explicit.</p>
    {!!exceptions.length && <details><summary>Optional identity corrections · {exceptions.length}</summary><ul className="workflow-exceptions">{exceptions.map(identity => <IdentityException key={`${identity.partId}:${identity.candidateId}`} identity={identity} onIdentity={props.onIdentity} />)}</ul></details>}
    {!exceptions.length && <p className="planning-muted">No tooth identity exceptions at this threshold.</p>}
    {!!sites.length && <><h3>Localized spaces</h3><ul className="workflow-exceptions">{[...sites].sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.priority] - { high: 0, medium: 1, low: 2 }[b.priority])).map(site => <SiteException key={site.id} site={site} onSite={props.onSite} onSelect={props.onSelect} onFocus={props.onFocusSite} onGenerate={props.onGenerateSite} threshold={props.confidenceThreshold ?? .8} />)}</ul></>}
    {!!props.timings?.length && <details><summary>Recorded preparation time</summary>{props.timings.map((timing, index) => <p key={index}>{timing.stage}: {(timing.durationMs / 1000).toFixed(1)} s</p>)}<p className="planning-muted">Measured in this session. No manual baseline or clinical accuracy is inferred.</p></details>}
  </section>;
}

function activityStatus(props: WorkflowReviewProps): AIActivityProps['status'] {
  if (!props.aiActivity?.length && !props.assessment?.execution) return undefined;
  const status = props.workflowRuns?.at(-1)?.status;
  return status === 'partial' || status === 'stale' ? 'incomplete' : status;
}

export function WorkflowJournal(props: WorkflowReviewProps & { step?: number }) {
  const run = props.workflowRuns?.at(-1), effort = effortSummary(props.correctionEvents ?? [], props.timings ?? []);
  // PlanningPanel renders this on every step. The findings step already includes
  // the same activity view in WorkflowReview; all other steps keep it here.
  return <>
    {props.step !== 1 && <AIActivity aiActivity={props.aiActivity} assessment={props.assessment} status={activityStatus(props)} />}
    {run && <details className="planning-section planning-secondary"><summary>Workflow record · {run.status} · {effort.correctionSteps} corrections</summary>
    <ol className="workflow-stage-record">{run.stages.map(stage => <li key={stage.id}><strong>{WORKFLOW_STAGE_LABELS[stage.id]}</strong> · {stage.status}<p>{stage.detail}</p></li>)}</ol>
    {['cancelled', 'stale', 'partial'].includes(run.status) && <button type="button" onClick={props.onResume}>Resume local draft</button>}
    <p>{effort.correctionSteps} explicit correction actions recorded. Measured preparation: {(effort.measuredMs / 1000).toFixed(1)} s. No equivalent manual baseline is recorded; time saved and clinical accuracy are unknown.</p>
    <p>Per run: {WORKFLOW_BUDGET.providerRequests} provider requests (planning, measured follow-up and final review), up to {WORKFLOW_BUDGET.providerSteps} model steps, {WORKFLOW_BUDGET.toolCalls} tool calls and {WORKFLOW_BUDGET.outputTokensPerStep.toLocaleString()} output tokens per step; {WORKFLOW_BUDGET.sites} sites, {WORKFLOW_BUDGET.candidatesPerSite} fit candidates/site, {WORKFLOW_BUDGET.fitMsPerSite / 1000} s fitting/site, {WORKFLOW_BUDGET.workflowMs / 1000} s for planning/generation plus {WORKFLOW_BUDGET.reviewMs / 1000} s for the final AI review. Provider charges depend on the account; failed requests may still incur usage.</p>
    <details><summary>Local tool results · {run.tools.length}</summary>{run.tools.map((tool, index) => <p key={index}><strong>{tool.name}</strong> · {tool.status} · {tool.detail}</p>)}</details>
  </details>}
  </>;
}
