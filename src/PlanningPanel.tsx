import { useId, useRef, useState } from 'react';
import type { CasePlanningRequest, CasePlanningResult } from './case-planning-types';
import type { ModelPart, ScanRole } from './models';
import type { ToothCase } from './tooth-types';
import type { useCasePlanning } from './useCasePlanning';
import { AnthropicModelSelect } from './AnthropicModelSelect';
import { WorkflowReview, WorkflowSettings, WorkflowJournal, type WorkflowReviewProps } from './WorkflowReview';
import './planning-panel.css';

export interface PlanningSiteReadiness {
  fdi: number;
  siteId?: string;
  draftIdentity?: { templateFdi: number; alternatives: number[]; basis: string; siteId?: string };
  status: 'ready' | 'needs-input' | 'generated';
  detail: string;
}
export interface PlanningPanelProps extends WorkflowReviewProps {
  step: number;
  planning: ReturnType<typeof useCasePlanning>;
  parts: ModelPart[];
  teeth: ToothCase;
  counts: Record<number, number>;
  fitReady: boolean;
  fitSummary: string;
  onStep: (step: number) => void;
  onApplyIdentities: () => void;
  onSelectTooth: (fdi: number) => void;
  onConfirmMissing: (fdi: number) => void;
  onConfirmAction: (id: string, value: boolean) => void;
  acceptedActions: string[];
  onGenerate: () => void;
  generating: boolean;
  reviewing?: boolean;
  modelLocked?: boolean;
  assembliesCount: number;
  onExport: () => void;
  onCorrections: () => void;
  /** Called after the explicit upload/assessment action, with a fresh result. */
  onPrepareDraft?: (result: CasePlanningResult) => void | Promise<void>;
  onRunWorkflow?: () => void;
  draftSummary?: string;
  siteReadiness?: PlanningSiteReadiness[];
  generationError?: string;
  collisionSummary?: string;
  onRole?: (partId: string, role: ScanRole) => void;
  onConfirmRoles?: () => void;
}

type PreparedView = CasePlanningRequest['views'][number];
const imageSource = (view: PreparedView) => `data:${view.mediaType};base64,${view.base64}`;
const count = (value: number) => value.toLocaleString();
const readable = (value: string) => value.replaceAll('-', ' ');
const TITLES = ['Prepare the case', 'Review your draft', 'Concepts & site readiness', 'Review & export'];

function EvidenceReferences({ references, views }: { references: string[]; views: PreparedView[] }) {
  if (!references.length) return <p className="planning-muted">No supporting references supplied.</p>;
  return <details className="planning-details planning-evidence"><summary>Supporting evidence · {references.length}</summary>
    <div className="planning-references">{references.map(reference => {
      const view = views.find(item => item.id === reference);
      return view ? <figure key={reference}><img src={imageSource(view)} alt={`${reference}: ${view.label}`} loading="lazy" />
        <figcaption>{reference} · {view.label} · {view.sourceId ?? 'Current-pose arches'}</figcaption></figure>
        : <p className="planning-muted" key={reference}><code>{reference}</code> · {reference === 'collision-report' ? 'Aggregate sampled geometry report; no tooth-level contact measurement' : 'Local candidate region; identity is a hypothesis'}</p>;
    })}</div>
  </details>;
}

export function PlanningPanel(props: PlanningPanelProps) {
  const id = useId();
  const { planning, parts, teeth, counts } = props;
  const { evidence, result } = planning;
  const [preparingDraft, setPreparingDraft] = useState(false);
  const [draftError, setDraftError] = useState('');
  const running = useRef(false);
  const step = props.step >= 0 && props.step <= 3 ? props.step : 0;
  const views = evidence?.views ?? [];
  const overview = views[0];
  const scans = parts.filter(part => !part.restoration);
  const upper = scans.filter(part => part.role === 'upper');
  const lower = scans.filter(part => part.role === 'lower');
  const bites = scans.filter(part => part.role === 'bite');
  const unassigned = scans.filter(part => !part.role || part.role === 'model');
  const hasArch = upper.length + lower.length > 0;
  const viewsReady = !!evidence?.sources.length && overview?.context === 'arch' && views.every(view => !!view.base64);
  const editingDisabled = planning.busy || props.generating || props.reviewing || preparingDraft;
  const canAssess = !!planning.prepared && planning.configured !== null && !editingDisabled;
  const selectedActions = result?.actions.filter(action => props.acceptedActions.includes(action.id)) ?? [];
  const mappings = result?.mappings ?? [];
  const eligibleMappings = mappings.filter(mapping => mapping.fdi !== null && !mapping.needsReview);
  const missing = result?.findings.filter(finding => finding.category === 'possible-missing') ?? [];
  const otherFindings = result?.findings.filter(finding => finding.category !== 'possible-missing') ?? [];
  const recordedMissing = Object.entries(teeth.teeth).filter(([fdi, record]) => record.status === 'missing' && !(counts[Number(fdi)] > 0));
  const reviewedSites = recordedMissing.filter(([, record]) => record.restoration === 'implant').map(([fdi]) => Number(fdi));
  const proposedSites = missing.flatMap(finding => finding.fdi !== null && !(counts[finding.fdi] > 0) && !['present', 'not-scanned'].includes(teeth.teeth[finding.fdi]?.status) ? [finding.fdi] : []);
  const requestedSites = [...new Set([...reviewedSites, ...(props.onPrepareDraft ? proposedSites : [])])];
  const localizedSites = (props.sites ?? []).filter(site => site.anchor && site.frame && !['not-scanned', 'segmentation-unresolved'].includes(site.status) && (site.fdi !== null || site.draftIdentity));
  const requestedCount = new Set([...requestedSites.map(fdi => `FDI-${fdi}`), ...localizedSites.map(site => site.fdi === null || site.draftIdentity ? site.id : `FDI-${site.fdi}`)]).size;
  const readiness = props.siteReadiness ?? [];

  async function prepareDraft() {
    if (!canAssess || running.current) return;
    if (props.onRunWorkflow) { props.onRunWorkflow(); return; }
    props.onStart?.();
    running.current = true; setPreparingDraft(true); setDraftError('');
    try {
      const assessment = await planning.analyze();
      if (assessment && props.onPrepareDraft) await props.onPrepareDraft(assessment);
    } catch (error) { setDraftError(error instanceof Error ? error.message : String(error)); }
    finally { running.current = false; setPreparingDraft(false); }
  }
  const siteList = readiness.length > 0 && <ul className="planning-site-list">{readiness.map(site => {
    const draftSite = (props.sites ?? []).find(hypothesis => hypothesis.draftIdentity && (site.siteId || site.draftIdentity?.siteId ? hypothesis.id === (site.siteId ?? site.draftIdentity?.siteId) : hypothesis.draftIdentity.templateFdi === site.fdi || hypothesis.draftIdentity.alternatives.includes(site.fdi)));
    const draftIdentity = site.draftIdentity ?? draftSite?.draftIdentity;
    const label = draftIdentity ? `${(draftSite?.arch ?? (draftIdentity.templateFdi < 30 ? 'upper' : 'lower')) === 'upper' ? 'Upper' : 'Lower'} draft site` : `FDI ${site.fdi}`;
    return <li key={site.siteId ?? draftSite?.id ?? site.fdi}>
    <div className="planning-row"><button className="planning-tooth" type="button" onClick={() => { if (draftSite) props.onFocusSite?.(draftSite); else if (!draftIdentity) props.onSelectTooth(site.fdi); }}>{label}</button>
      <span className="planning-badge">{site.status === 'generated' ? 'Concept generated' : site.status === 'ready' ? 'Preparing concept' : 'Needs input'}</span></div>
    <p>{site.detail}</p>
    {draftIdentity && <p className="planning-muted">Anatomical FDI unresolved; the crown template is illustrative anatomy only.</p>}
  </li>; })}</ul>;
  const generationAction = <details className="planning-details" open={props.manualMode || undefined}><summary>Optional manual generation tools</summary>
    <p className="planning-muted">Start generates and fits supported draft sites automatically. These tools let you request another local pass or use manual mode.</p>
    <div className="planning-actions"><button className="planning-primary" type="button" disabled={editingDisabled || !evidence?.sources.length || !requestedCount} onClick={props.onGenerate}>
      {props.generating ? 'Generating concepts…' : props.assembliesCount ? 'Generate remaining concepts' : 'Generate draft concepts'}
    </button><span className="planning-muted">{requestedCount} draft / reviewed site{requestedCount === 1 ? '' : 's'}</span></div>
    {!requestedCount && <p className="planning-muted">No supported site is available yet. A concept needs localized scan geometry; use the evidence details to inspect coverage or optional site corrections.</p>}
  </details>;

  return <section className="planning-panel" aria-labelledby={`${id}-heading`}>
    <header className="planning-header"><div><p className="planning-eyebrow">Case draft · {step + 1} / 4</p><h2 id={`${id}-heading`}>{TITLES[step]}</h2></div><span className="planning-badge">Clinical review pending</span></header>
    {props.progress && <div className="workflow-progress" role="status">{planning.stage || (props.progress.stage === 'Waiting for scans' && planning.prepared ? 'Evidence prepared · start the workflow' : props.progress.stage)}<progress value={props.progress.completed} max={props.progress.total} aria-label="Case workflow progress" /></div>}
    {props.progress?.stage.startsWith('Paused') && !editingDisabled && <button type="button" onClick={props.onResume}>Resume local draft</button>}
    {props.generating && <div className="planning-status"><span>Fitting local candidates; completed sites remain available.</span><button type="button" onClick={props.onCancel}>Pause workflow</button></div>}
    {(planning.busy || preparingDraft) && <div className="planning-status"><span role="status">{planning.stage || 'Preparing the local concept draft…'}</span>
      {(planning.busy || props.generating) && <button type="button" onClick={props.onCancel ?? planning.cancel}>Cancel</button>}</div>}
    {(planning.error || draftError) && <div className="planning-error" role="alert"><p>{planning.error || draftError}</p><div className="planning-actions">
      {hasArch && <button type="button" disabled={editingDisabled} onClick={() => { setDraftError(''); planning.prepare(); }}>Retry local preparation</button>}
      {step !== 0 && <button type="button" onClick={() => props.onStep(0)}>Review evidence</button>}</div></div>}
    {props.generationError && <div className="planning-error" role="alert"><strong>Some concepts need attention</strong><p>{props.generationError}</p><p>Review the site details below; a failed site has no generated concept.</p></div>}

    {step === 0 && <>
      <section className="planning-section">
        <div className="planning-row"><h3>Your imported evidence</h3><span className="planning-badge">{evidence ? `${views.length} local views` : planning.busy ? 'Preparing locally' : 'Waiting for scans'}</span></div>
        <p>{upper.length} upper · {lower.length} lower · {bites.length} bite reference{bites.length === 1 ? '' : 's'}</p>
        {scans.some(part => part.role !== 'model' && part.roleSource === 'filename-hypothesis') && <p className="planning-muted">Arch/reference roles remain filename hypotheses. The automatic draft uses them without recording a user confirmation.</p>}
        {!scans.length && <p className="planning-empty">Import upper and/or lower scans to begin. Preparation runs on this device.</p>}
        {!!unassigned.length && <p className="planning-note">{unassigned.length} scan part{unassigned.length === 1 ? ' has' : 's have'} no arch/reference role.{hasArch ? ' Available arches can still progress.' : ' Assign an upper or lower scan in the advanced corrections below to prepare geometry.'}</p>}
        <p className="planning-muted">{props.fitSummary || 'Using original shared coordinates; clinical alignment is unvalidated.'} Bite scans support alignment only.</p>
      </section>
      <section className="planning-section planning-assessment">
        <h3>Start automatic planning & fitting</h3>
        <p>Start once to assess the case, generate supported local concepts and fit them to the scans. Findings stay visible without approval clicks.</p>
        {overview?.base64 ? <figure className="planning-overview"><img src={imageSource(overview)} alt={`Prepared overview: ${overview.label}`} />
          <figcaption>{overview.id} · {overview.label}. Patient side can remain unknown.</figcaption></figure>
          : <p className="planning-empty">{planning.busy ? 'Preparing an overview on this device…' : planning.prepared ? 'Local geometry is ready. A draft can proceed without rendered overview images.' : hasArch ? 'Geometry preparation is not ready. Check errors or retry local preparation below.' : 'An arch overview will appear after import.'}</p>}
        <p className="planning-disclosure" id={`${id}-upload`}>{planning.configured && views.length ? `Start sends ${views.length} rendered JPEG views, anonymous scan/candidate aliases, chart records, local site evidence and geometry/pose measurements to Anthropic (${planning.modelLabel}). Notes and original filenames are excluded; rendered surfaces can still contain patient information. Raw meshes stay on this device. An assessment coordinates reversible local drafts and fitting. A second read-only AI review follows current surface checks; up to two external requests are made.` : 'AI images are unavailable or the provider is unconfigured. Start prepares a local geometric draft and concepts; no provider request is made.'} Missing-site suggestions do not confirm tooth absence or implant need.</p>
        <div className="planning-actions"><button className="planning-primary" type="button" disabled={!canAssess} aria-describedby={`${id}-upload`} onClick={() => void prepareDraft()}>{planning.configured ? 'Start AI workflow' : 'Start local workflow'}</button>
          {result && <button type="button" disabled={editingDisabled} onClick={() => props.onStep(1)}>Review draft</button>}</div>
        {!planning.patientRight && <p className="planning-muted">Patient side is unresolved. Localized gaps can still produce Upper/Lower draft sites with illustrative anatomy; their anatomical FDI stays unknown.</p>}
        {planning.configured === null && <p className="planning-note">Checking AI configuration. Local evidence stays available.</p>}
        {planning.configured === false && <p className="planning-note">AI assessment is not configured. Automatic local preparation and concepts remain available.</p>}
        <details className="planning-details"><summary>Assessment model · {planning.modelLabel}</summary><AnthropicModelSelect label="Case assessment model" value={planning.model} defaultModel={planning.defaultModel} disabled={props.modelLocked || editingDisabled || planning.configured === null} onChange={planning.setModel} /></details>
      </section>
      {!!scans.length && <details className="planning-section planning-secondary"><summary>Advanced scan, side & bite corrections · optional</summary>
        <p className="planning-muted">Correct these hypotheses when you have supporting evidence. Routine drafts do not require role, patient-side or bite confirmation.</p>
        {scans.map(part => <label className="workflow-setting" key={part.id}>{part.name}<select aria-label={`Role for ${part.name}`} value={part.role ?? 'model'} disabled={editingDisabled} onChange={event => props.onRole?.(part.id, event.target.value as ScanRole)}><option value="model">Unresolved / other</option><option value="upper">Upper arch</option><option value="lower">Lower arch</option><option value="bite">Bite reference</option></select></label>)}
        <fieldset className="planning-orientation" disabled={editingDisabled || !viewsReady} aria-describedby={`${id}-orientation-help`}>
          <legend>Patient right appears on · when known</legend>
          <label><input type="radio" name={`${id}-patient-right`} checked={planning.patientRight === null} onChange={() => { props.onOrientationInput?.(); planning.setPatientRight(null); }} />Unknown</label>
          <label><input type="radio" name={`${id}-patient-right`} checked={planning.patientRight === 'image-left'} onChange={() => { props.onOrientationInput?.(); planning.setPatientRight('image-left'); }} />Image left</label>
          <label><input type="radio" name={`${id}-patient-right`} checked={planning.patientRight === 'image-right'} onChange={() => { props.onOrientationInput?.(); planning.setPatientRight('image-right'); }} />Image right</label>
        </fieldset>
        <p className="planning-muted" id={`${id}-orientation-help`}>File axes and the camera do not establish patient side. Leave this unknown without independent evidence; anatomy templates never confirm laterality.</p>
        {!!upper.length && !!lower.length && <label className="planning-check"><input type="checkbox" checked={props.biteReviewed ?? false} disabled={editingDisabled} onChange={event => props.onBiteReviewed?.(event.target.checked)} />I reviewed the current static bite pose</label>}
        <button className="planning-link" type="button" onClick={props.onCorrections}>Open correction tools</button>
      </details>}
      <WorkflowSettings {...props} disabled={editingDisabled} />
      <details className="planning-section planning-secondary"><summary>Evidence, measurements & limitations</summary>
        <p>{props.collisionSummary || 'No current collision metrics were supplied to this panel.'}</p>
        <p className="planning-muted">Local metrics include triangle counts, candidate surface area (squared file units) and smoothed peak relief (file units). They are not anatomical tooth height or bone measurements. Collision reports use sampled surface distances and triangle intersection flags; they do not measure exact contact area or overlap volume.</p>
        <p className="planning-muted">Partial scans, texture appearance and static bite views cannot establish diagnosis, bone-safe placement, surgical trajectory or dynamic occlusion.</p>
        {evidence?.sources.map(source => <div className="planning-local-summary" key={source.partId}><strong>{parts.find(part => part.id === source.partId)?.role} · {source.scan.candidates.length} candidate regions</strong><span>{count(source.scan.unassignedTriangles)} unassigned triangles; unassigned does not mean missing.</span>
          {!!source.scan.warnings.length && <ul>{source.scan.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}</div>)}
        <div className="planning-thumbnails">{views.map(view => <figure key={view.id}><img src={imageSource(view)} alt={`${view.id}: ${view.label}`} loading="lazy" /><figcaption>{view.id} · {view.label} · {view.sourceId ?? 'Current-pose arches'}</figcaption></figure>)}</div>
        <div className="planning-actions"><button type="button" disabled={!hasArch || editingDisabled} onClick={planning.prepare}>Retry local preparation</button><button className="planning-link" type="button" onClick={props.onCorrections}>Correction tools</button></div>
      </details>
    </>}

    {step === 1 && (result ? <>
      <WorkflowReview {...props} onSelect={props.onSelectTooth} />
      <section className="planning-section planning-assessment"><h3>{result.model === 'local-geometry' ? 'Local geometric draft' : 'AI planning proposal'}</h3><p>{result.summary}</p>
        {props.draftSummary && <p className="planning-note" role="status">{props.draftSummary}</p>}
        <p className="planning-muted">Hypotheses for review. A visible gap does not confirm a missing tooth, diagnosis or implant indication.</p>
        {result.execution && <details className="planning-details"><summary>Model attribution & structured tool evidence</summary><p>Requested {result.execution.requestedModel}; returned {result.execution.actualModel} ({result.execution.provider}). {result.execution.inputTokens ?? 'Unknown'} input / {result.execution.outputTokens ?? 'unknown'} output tokens across {result.execution.providerSteps} steps.</p>{result.execution.toolResults.map((tool, index) => <details key={index}><summary>{tool.name}</summary><pre className="planning-tool-result">{JSON.stringify({ input: tool.input, output: tool.output }, null, 2)}</pre></details>)}<p>Queued draft requests: {result.execution.draftRequests.length}. Local artifacts and fit reports are recorded separately after worker execution.</p></details>}
      </section>
      <section className="planning-section"><div className="planning-row"><h3>Possible missing positions</h3><span className="planning-badge">{missing.length} observations</span></div>
        <div className="planning-cards">{missing.map(finding => <article className="planning-card" key={finding.id}><div className="planning-row"><h4>{finding.title}</h4>{finding.fdi !== null && <button className="planning-tooth" type="button" onClick={() => props.onSelectTooth(finding.fdi!)}>FDI {finding.fdi}</button>}</div>
          <p>{finding.detail}</p><p className="planning-review-label">Proposed gap · absence and clinical indication unconfirmed</p><EvidenceReferences references={finding.evidence} views={views} />
          {finding.fdi !== null && <details className="planning-details"><summary>Record a reviewed chart position</summary><p className="planning-muted">Only after checking scan coverage and the clinical record. This records missing status and implant concept intent; suitability remains unassessed.</p>
            <button type="button" disabled={editingDisabled || (counts[finding.fdi] ?? 0) > 0 || teeth.teeth[finding.fdi]?.status === 'not-scanned' || teeth.teeth[finding.fdi]?.status === 'present' || reviewedSites.includes(finding.fdi)} onClick={() => props.onConfirmMissing(finding.fdi!)}>Record reviewed missing + concept intent</button></details>}
        </article>)}</div>
        {!missing.length && <p className="planning-empty">No visible missing-position proposals were returned. Unlabeled or unscanned regions do not establish absence.</p>}
        {siteList}{generationAction}
      </section>
      <details className="planning-section planning-secondary"><summary>Other observations & optional review actions · {otherFindings.length + result.actions.length}</summary>
        <div className="planning-cards">{otherFindings.map(finding => <article className="planning-card" key={finding.id}><span className="planning-category">{readable(finding.category)}{finding.fdi !== null ? ` · FDI ${finding.fdi}` : ''}</span><h4>{finding.title}</h4><p>{finding.detail}</p><p className="planning-review-label">Proposed · requires clinical review</p><EvidenceReferences references={finding.evidence} views={views} /></article>)}
          {result.actions.map(action => <article className="planning-card" key={action.id}><span className="planning-category">{readable(action.kind)}{action.fdi !== null ? ` · FDI ${action.fdi}` : ''}</span><h4>{action.title}</h4><p>{action.rationale}</p>
            <label className="planning-check"><input type="checkbox" checked={props.acceptedActions.includes(action.id)} disabled={editingDisabled} onChange={event => props.onConfirmAction(action.id, event.currentTarget.checked)} />Include review action · optional</label><p className="planning-muted">Including an action records planning intent. It does not approve findings or gate draft generation. Clinical prerequisites remain pending.</p><ul>{action.prerequisites.map((text, index) => <li key={index}>{text}</li>)}</ul><EvidenceReferences references={action.evidence} views={views} /></article>)}</div>
      </details>
      <details className="planning-section planning-secondary"><summary>Tooth identity proposals · {eligibleMappings.length} eligible / {mappings.length} regions</summary>
        <p className="planning-muted">Unknown and flagged regions need review. Existing labels, exclusions and chart conflicts must be preserved.</p>
        <div className="planning-table-wrap"><table><caption className="planning-sr-only">Proposed tooth identities</caption><thead><tr><th>Region</th><th>FDI</th><th>Review</th></tr></thead><tbody>{mappings.map(mapping => <tr key={`${mapping.sourceId}:C${mapping.candidateId}`}><th><code>{mapping.sourceId}:C{mapping.candidateId}</code></th><td>{mapping.fdi ?? 'Unknown'}</td><td>{mapping.needsReview ? 'Needs review. ' : 'Eligible proposal. '}{mapping.reason}</td></tr>)}</tbody></table></div>
        <div className="planning-actions"><button type="button" disabled={editingDisabled || !eligibleMappings.length} onClick={props.onApplyIdentities}>Apply eligible identities</button><button className="planning-link" type="button" onClick={props.onCorrections}>Correction tools</button></div>
      </details>
    </> : <div className="planning-empty"><h3>No planning draft yet</h3><p>Start this case’s planning workflow from the Evidence step.</p><button type="button" onClick={() => props.onStep(0)}>Review evidence</button></div>)}

    {step === 2 && <>
      <section className="planning-section"><div className="planning-row"><h3>Local planning concepts</h3><span className="planning-badge">{count(props.assembliesCount)} assemblies</span></div>
        {props.draftSummary && <p role="status">{props.draftSummary}</p>}
        <p>Each assembly has a separate fixture envelope, abutment and crown. Inspect or tune the components in the viewport controls.</p>
        <p className="planning-note">Planning concepts—clinical fit unvalidated. Bone, placement depth, surgical trajectory, implant connection and tissue fit remain unassessed. Dimensions use file units.</p>
        {siteList}
        {!readiness.length && <p className="planning-muted">{reviewedSites.length} reviewed chart positions; geometric site localization still needs to run. Missing-position status alone does not make a site ready.</p>}
        {generationAction}
        {props.generating && <p className="planning-muted" role="status">Local workers are localizing sites and constructing components. A requested site may still need a marker or corrected neighbours.</p>}
        <div className="planning-actions"><button className="planning-link" type="button" onClick={() => props.onStep(1)}>Review proposed sites</button><button className="planning-link" type="button" onClick={props.onCorrections}>Correct site / labels</button></div>
      </section>
      {!!result?.designs.length && <details className="planning-section planning-secondary"><summary>Exterior anatomy hypotheses</summary><ul>{result.designs.map(design => <li key={design.fdi}><strong>FDI {design.fdi} · {design.anatomy}</strong> — {design.rationale}</li>)}</ul><p className="planning-muted">Anatomy suggestions are not generated geometry or evidence of fit.</p></details>}
    </>}
    <WorkflowJournal {...props} />

    {step === 3 && <>
      <section className="planning-section"><h3>Current draft</h3><p>{result?.summary || 'Local planning state; no AI assessment recorded.'}</p>
        <dl className="planning-inputs"><div><dt>Review actions</dt><dd>{selectedActions.length}</dd></div><div><dt>Possible missing</dt><dd>{missing.length} proposals</dd></div><div><dt>Saved missing</dt><dd>{recordedMissing.length} positions</dd></div><div><dt>Generated</dt><dd>{count(props.assembliesCount)} assemblies</dd></div></dl>
        <p className="planning-muted">Export keeps the draft and its unresolved questions. It does not certify diagnosis, surgical suitability, clinical fit or manufacturing readiness.</p>
        <div className="planning-actions"><button className="planning-primary" type="button" disabled={editingDisabled || !scans.length || props.sessionBusy} onClick={props.onExport}>Export components & manifest</button><button type="button" disabled={editingDisabled || !scans.length || props.sessionBusy} onClick={props.onSave}>Save resumable case</button><button className="planning-link" type="button" onClick={props.onCorrections}>Correction tools</button></div>
      </section>
      <details className="planning-section planning-secondary"><summary>Evidence & clinical checks still pending</summary><ul><li>Review tooth numbering, scan coverage, patient side and proposed sites.</li><li>Verify alignment and bite. Static surface measurements do not assess jaw motion, force or pressure.</li><li>A clinical fixture plan requires clinical assessment, reviewed volumetric anatomy, reviewed surface-to-volume registration, the exact implant system/component catalog and clinician-selected placement constraints. These concepts establish none of those approvals.</li><li>A fitted crown interior requires selected abutment/Ti-base geometry and a registered frame, with reviewed clearance, access, retention and material constraints.</li><li>Review tissue margins, internal fit and manufacturing suitability separately.</li>{result?.limitations.map((text, index) => <li key={index}>{text}</li>)}</ul></details>
    </>}
    <div className="planning-section planning-actions"><button type="button" disabled={editingDisabled || props.sessionBusy || !scans.length} onClick={props.onSave}>Save case</button><button type="button" disabled={editingDisabled || props.sessionBusy || !scans.length} onClick={props.onReopen}>Reopen case</button><span className="planning-muted">Reimport the same scans to verify their hashes.</span></div>
  </section>;
}
