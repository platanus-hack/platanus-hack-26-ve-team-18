import { useId, useState } from 'react';
import { FDI_TEETH, isFdiTooth, toothArch } from './teeth';
import type { AutoTeethPanelProps, AutoToothDirection, AutoToothIdentificationRequest, AutoToothView } from './auto-tooth-types';
import { ANTHROPIC_MODELS, isAnthropicModelId } from './anthropic-models';
import { AnthropicModelSelect } from './AnthropicModelSelect';
import './auto-teeth-panel.css';

const count = (value: number) => value.toLocaleString();
const imageSource = (view: AutoToothView) => `data:${view.mediaType};base64,${view.base64}`;
const DIRECTIONS: AutoToothDirection[] = ['auto', '+x', '-x', '+y', '-y', '+z', '-z'];

function Warnings({ label, warnings }: { label: string; warnings: string[] }) {
  return warnings.length > 0 ? <details className="auto-teeth-warnings">
    <summary>{label} (<span className="num">{warnings.length}</span>)</summary>
    <ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
  </details> : null;
}

export function AutoTeethPanel(props: AutoTeethPanelProps) {
  const id = useId();
  const [showRawPayload, setShowRawPayload] = useState(false);
  const modelLabel = ANTHROPIC_MODELS.find(model => model.id === props.model)?.label ?? props.model;
  const arch = props.activePartRole === 'upper' || props.activePartRole === 'lower' ? props.activePartRole : null;
  const canScan = !!props.activePartName && arch !== null && !props.busy;
  const proposal = props.proposal;
  const candidates = proposal?.scan.candidates ?? [];
  const selected = candidates.find(candidate => candidate.id === proposal?.selectedCandidate);
  const mapping = proposal?.mappings.find(item => item.candidateId === selected?.id);
  const allowedTeeth = FDI_TEETH.filter(tooth => toothArch(tooth) === arch);
  const mappedFdi = mapping?.fdi != null && allowedTeeth.some(tooth => tooth === mapping.fdi) ? mapping.fdi : '';
  const targetTooth = mappedFdi === '' ? props.selectedTooth : Number(mappedFdi);
  const canUse = canScan && !!selected && isFdiTooth(targetTooth) && toothArch(targetTooth) === arch;
  const views = proposal?.views ?? [];
  const overview = views[0];
  const viewsReady = views.length === 4 && views.every(view => !!view.base64);
  const geometrySummary = candidates.map(candidate => ({
    id: candidate.id, triangles: candidate.faces.length, area: candidate.area,
    height: candidate.height, warnings: candidate.warnings,
  }));
  const request: AutoToothIdentificationRequest | null = arch && props.patientRight && viewsReady
    ? { arch, patientRight: props.patientRight, views, candidates: geometrySummary, ...(isAnthropicModelId(props.model) ? { model: props.model } : {}) } : null;
  const canIdentify = canScan && candidates.length > 0 && props.configured === true && request !== null;

  return <section className="auto-teeth-panel" aria-labelledby={`${id}-heading`}>
    <div className="auto-teeth-heading">
      <div><h3 id={`${id}-heading`}>Automatic tooth selection</h3>
        <p>Detect regions locally, review them, then apply. Manual tools are available below for corrections.</p></div>
      <button className="auto-teeth-primary" type="button" disabled={!canScan} onClick={props.onScan}>
        {proposal ? 'Rerun' : 'Scan arch'}
      </button>
      {props.canApplyMapped && <button className="auto-teeth-primary" type="button" disabled={!canScan} onClick={props.onApplyMapped}>Apply mapped teeth</button>}
    </div>
    <label className="auto-teeth-check"><input type="checkbox" checked={props.autoRun} disabled={props.busy}
      onChange={event => props.onAutoRun(event.currentTarget.checked)} />Scan imported arches automatically</label>
    <p className="auto-teeth-hint">Automatic scans stay on this device. Images are sent only when you choose Identify FDI with {modelLabel}.</p>
    <p className="auto-teeth-context">{props.activePartName
      ? `${props.activePartName} · ${arch ? `${arch} arch` : 'set the scan role to Upper or Lower to scan'}`
      : 'Import an intraoral scan and select its Upper or Lower role to begin.'}</p>

    <details className="auto-teeth-settings">
      <summary>Detection settings</summary>
      <div className="auto-teeth-fields">
        <label>Occlusal direction<select value={props.settings.direction} disabled={props.busy}
          onChange={event => props.onSettings({ direction: event.currentTarget.value as AutoToothDirection })}>
          {DIRECTIONS.map(direction => <option key={direction} value={direction}>{direction === 'auto' ? 'Auto' : direction.toUpperCase()}</option>)}
        </select></label>
        <label>Sensitivity · <span className="num">{props.settings.sensitivity}</span><input type="range" min="0.5" max="1.5" step="0.05"
          value={props.settings.sensitivity} disabled={props.busy}
          onChange={event => props.onSettings({ sensitivity: event.currentTarget.valueAsNumber })} /></label>
      </div>
      <p className="auto-teeth-hint">Rerun to use changed settings. Geometry proposals can include gum or split a tooth; review the boundaries.</p>
    </details>

    {proposal ? <details className="auto-teeth-proposals" open={!!proposal.model}>
      <summary>Detected regions · <span className="num">{count(candidates.length)}</span> · review or correct</summary>
      <div className="auto-teeth-row"><h4>Candidate regions · <span className="num">{count(candidates.length)}</span></h4>
        <button type="button" disabled={!canScan || candidates.length === 0} onClick={props.onPickTool}>Pick detected tooth</button></div>
      <p className="auto-teeth-hint"><span className="num">{count(proposal.scan.unassignedTriangles)} unassigned triangles</span>. Candidate IDs are geometry labels, not FDI numbers.</p>
      {candidates.length > 0 ? <>
        <div className="auto-teeth-candidates" role="group" aria-label="Detected candidate regions">
          {candidates.map(candidate => <button key={candidate.id} type="button" disabled={!canScan}
            aria-pressed={candidate.id === proposal.selectedCandidate} onClick={() => props.onSelectCandidate(candidate.id)}>
            <strong>C{candidate.id}</strong><span><span className="num">{count(candidate.faces.length)} triangles</span></span>
            {candidate.warnings.length > 0 && <span><span className="num">{candidate.warnings.length} warning{candidate.warnings.length === 1 ? '' : 's'}</span></span>}
          </button>)}
        </div>
        {selected ? <div className="auto-teeth-selected">
          <label>Assign FDI for C{selected.id}<select value={mappedFdi} disabled={!canScan}
            onChange={event => props.onMapCandidate(selected.id, event.currentTarget.value === '' ? null : Number(event.currentTarget.value))}>
            <option value="">Unknown</option>
            {allowedTeeth.map(tooth => <option key={tooth} value={tooth}>FDI <span className="num">{tooth}</span></option>)}
          </select></label>
          {mapping ? <p><strong>{mapping.needsReview ? 'Needs review' : 'No review flag'}</strong> · {mapping.reason || 'No mapping reason provided.'}</p>
            : <p>Unmapped. Choose an FDI number or leave Unknown.</p>}
          {mapping?.fdi != null && mappedFdi === '' && <p className="auto-teeth-warning">Proposed FDI <span className="num">{mapping.fdi}</span> is outside the active arch and cannot be used here.</p>}
          <Warnings label={`C${selected.id} warnings`} warnings={selected.warnings} />
          <div className="auto-teeth-actions">
            <button type="button" disabled={!canUse} onClick={() => props.onUseSelected(targetTooth)}>Use region for FDI <span className="num">{targetTooth}</span></button>
            <button type="button" disabled={!canScan} onClick={() => props.onRejectCandidate(selected.id)}>Reject region</button>
          </div>
          <p className="auto-teeth-hint">Use region applies C{selected.id} to its displayed FDI target. Existing assignments stay protected.
            {!canUse && !props.busy && ' Select a chart tooth in the active arch first.'}</p>
        </div> : <p className="auto-teeth-empty">Choose a candidate above or use Pick detected tooth in the 3D view.</p>}
        <p className="auto-teeth-hint">Applies eligible mappings together. Uncertain mappings and protected existing assignments are skipped.</p>
      </> : <p className="auto-teeth-empty">No regions detected. Adjust direction or sensitivity and rerun, or use the manual correction tools.</p>}
      <Warnings label="Scan warnings" warnings={proposal.scan.warnings} />
    </details> : <p className="auto-teeth-empty">Imported arches scan locally when automatic scanning is on. You can also choose Scan arch.</p>}

    <div className="auto-teeth-remote">
      <h4>FDI identification</h4>
      <AnthropicModelSelect label="FDI identification model" value={props.model} defaultModel={props.defaultModel} disabled={props.busy} onChange={props.onModel} />
      <p className="auto-teeth-hint">Prepare scan views renders locally. Review the images and confirm patient right before sending.</p>
      <button type="button" disabled={!canScan || candidates.length === 0} onClick={props.onPrepareViews}>Prepare scan views</button>
      {overview?.base64 && <figure className="auto-teeth-overview">
        <img src={imageSource(overview)} alt={`First rendered arch overview (${overview.label}); confirm patient right using image left or image right.`} />
        <figcaption>First rendered overview · {overview.label}. Use this image to confirm patient right.</figcaption>
      </figure>}
      <fieldset className="auto-teeth-orientation" disabled={props.busy || !overview?.base64} aria-describedby={`${id}-orientation-help`}>
        <legend>Patient right · required</legend>
        <label><input type="radio" name={`${id}-patient-right`} value="image-left" checked={props.patientRight === 'image-left'}
          onChange={() => props.onPatientRight('image-left')} />Patient right is image left</label>
        <label><input type="radio" name={`${id}-patient-right`} value="image-right" checked={props.patientRight === 'image-right'}
          onChange={() => props.onPatientRight('image-right')} />Patient right is image right</label>
      </fieldset>
      <p className="auto-teeth-hint" id={`${id}-orientation-help`}>Choose from the first overview above. Patient right is not inferred from file axes or camera direction.</p>
      {views.length > 0 && <details className="auto-teeth-payload">
        <summary>Review exact upload payload · <span className="num">{views.length} rendered views</span></summary>
        <div className="auto-teeth-thumbnails">{views.map((view, index) => <figure key={index}>
          <a href={imageSource(view)} target="_blank" rel="noreferrer" aria-label={`Open rendered view ${index + 1}: ${view.label}`}>
            <img src={imageSource(view)} alt={`Rendered arch view ${index + 1}: ${view.label}`} /></a>
          <figcaption><span className="num">{index + 1}.</span> {view.label} · {view.mediaType}</figcaption>
        </figure>)}</div>
        <p className="auto-teeth-hint">These exact images and the anonymous geometry summary below form the request. Area uses squared file units; height uses file units.</p>
        <pre aria-label="Arch, orientation and anonymous candidate geometry summary">{JSON.stringify({ arch, patientRight: props.patientRight, candidates: geometrySummary }, null, 2)}</pre>
        {request && <details onToggle={event => setShowRawPayload(event.currentTarget.open)}>
          <summary>Full request JSON, including image data</summary>
          {showRawPayload && <pre>{JSON.stringify(request, null, 2)}</pre>}
        </details>}
      </details>}
      {views.length > 0 && !viewsReady && <p className="auto-teeth-warning">Prepare all four scan views before identifying FDI.</p>}
      {props.configured === false && <p className="auto-teeth-context">Set ANTHROPIC_API_KEY in .env.local and restart to enable AI identification. Local detection stays available.</p>}
      {props.configured === null && <p className="auto-teeth-hint">AI configuration has not been confirmed. Local detection stays available.</p>}
      <p className="auto-teeth-hint" id={`${id}-upload`}>Choosing Identify FDI with {modelLabel} deliberately sends exactly the rendered arch views and anonymous candidate geometry summary to Anthropic. Results remain proposals; tooth status and restoration fields stay unchanged until Apply.</p>
      <button type="button" disabled={!canIdentify} aria-describedby={`${id}-upload`} onClick={props.onIdentify}>Identify FDI with {modelLabel}</button>
      {proposal?.model && <p className="auto-teeth-hint">Identification model: {proposal.model}</p>}
    </div>

    {!!proposal?.possibleMissing.length && <div className="auto-teeth-gaps">
      <h4>Possible missing / unsegmented</h4>
      <p className="auto-teeth-hint">Suggestions for chart review only. Reviewing does not mark a tooth Missing or set implant intent.</p>
      <ul>{proposal.possibleMissing.map((gap, index) => <li key={index}>
        <button type="button" disabled={props.busy} onClick={() => props.onReviewGap(gap.fdi)}>Review FDI <span className="num">{gap.fdi}</span></button><span>{gap.reason}</span>
      </li>)}</ul>
    </div>}
    {(props.processing ?? props.busy) && <div className="auto-teeth-busy"><span role="status">{props.stage || 'Processing automatic tooth selection…'}</span>
      <button type="button" onClick={props.onCancel}>Cancel</button></div>}
    {props.error && <p className="auto-teeth-error" role="alert">{props.error}</p>}
    {props.notice && <p className="auto-teeth-notice" role="status">{props.notice}</p>}
  </section>;
}
