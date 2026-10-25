import { useId } from 'react';
import { FDI_TEETH, emptyToothRecord, toothArch, toothName } from './teeth';
import type { RestorationIntent, ToothPanelProps, ToothStatus, ToothTool } from './tooth-types';
import './tooth-panel.css';

const STATUS: Record<ToothStatus, string> = {
  unreviewed: 'Unreviewed', present: 'Present', missing: 'Missing', 'not-scanned': 'Not scanned',
};
const MARK: Record<ToothStatus, string> = { unreviewed: '?', present: 'P', missing: '×', 'not-scanned': '/' };
const TOOLS: { value: ToothTool; label: string }[] = [
  { value: 'inspect', label: 'Navigate' }, { value: 'auto', label: 'Auto pick' }, { value: 'paint', label: 'Add brush' },
  { value: 'erase', label: 'Erase' }, { value: 'exclude', label: 'Exclude gum' },
  { value: 'boundary', label: 'Boundary' }, { value: 'seed', label: 'Crown seed' },
  { value: 'site', label: 'Mark site' },
];
const QUADRANTS = [1, 2, 4, 3].map(quadrant => FDI_TEETH
  .filter(tooth => Math.floor(tooth / 10) === quadrant)
  .sort((a, b) => quadrant === 1 || quadrant === 4 ? b - a : a - b));
const count = (value: number) => value.toLocaleString();
const coordinate = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 3 });
const compatibleIntent = (status: ToothStatus, intent: RestorationIntent) =>
  intent === 'crown' ? status === 'present' : intent === 'implant' ? status === 'missing' : true;
const intentLabel = (intent: RestorationIntent, site: boolean) => intent === 'implant'
  ? site ? 'Implant site (dentist marked)' : 'Implant review'
  : intent === 'crown' ? 'Crown review' : 'No restoration intent';

export function ToothPanel(props: ToothPanelProps) {
  const id = useId();
  const record = props.teeth[props.selectedTooth] ?? emptyToothRecord();
  const assigned = props.counts[props.selectedTooth] ?? 0;
  const arch = toothArch(props.selectedTooth);
  const compatibleScan = props.hasScans && !!props.activePartName && props.activePartRole === arch;
  const canEdit = compatibleScan && props.editable && props.enabled && !props.busy;
  const canSite = canEdit && record.status === 'missing';
  const canAssign = canEdit && record.status !== 'missing' && record.status !== 'not-scanned';
  const missing = FDI_TEETH.filter(tooth => props.teeth[tooth]?.status === 'missing');
  const restoration = compatibleIntent(record.status, record.restoration) ? record.restoration : 'none';
  const scanMessage = !props.hasScans
    ? `Import and select a scan for the ${arch} arch to identify this tooth.`
    : !compatibleScan
      ? `Select a scan with the ${arch} role for this tooth. Active scan: ${props.activePartName ?? 'none'} (role: ${props.activePartRole ?? 'unassigned'}).`
      : `${props.activePartName} · role: ${props.activePartRole} · ${props.editable ? 'compatible arch scan' : 'scan unavailable for editing'}.`;

  function setStatus(status: ToothStatus) {
    props.onRecord({ status, restoration: compatibleIntent(status, record.restoration) ? record.restoration : 'none' });
  }

  function slot(tooth: number) {
    const item = props.teeth[tooth] ?? emptyToothRecord();
    const triangles = props.counts[tooth] ?? 0;
    const selected = tooth === props.selectedTooth;
    const label = `FDI ${tooth}, ${toothName(tooth)}; ${STATUS[item.status]}, ${item.status === 'unreviewed' ? 'not yet reviewed' : item.status === 'present' ? 'recorded identity' : 'user reviewed'}; ${count(triangles)} assigned triangles; ${intentLabel(item.restoration, !!item.site)}; ${item.site ? 'site marked' : 'site not marked'}`;
    return <button key={tooth} type="button"
      className={`tooth-slot tooth-slot--${item.status}${selected ? ' tooth-slot--selected' : ''}${triangles > 0 ? ' tooth-slot--assigned' : ''}`}
      aria-label={label} title={label} aria-pressed={selected} disabled={props.busy} onClick={() => props.onSelect(tooth)}>
      <span className="tooth-slot-number">{tooth}</span>
      <span className="tooth-slot-mark" aria-hidden="true">{MARK[item.status]}</span>
      <span className="tooth-slot-count" aria-hidden="true">{triangles > 0 ? count(triangles) : '—'}</span>
    </button>;
  }

  return <section className="tooth-panel" aria-labelledby={`${id}-heading`}>
    <div className="tooth-header">
      <div><h2 id={`${id}-heading`}>Tooth identification</h2><p>Permanent teeth · FDI notation · patient perspective</p></div>
      <div className="tooth-file-actions">
        <button type="button" disabled={props.busy || !props.hasScans} onClick={props.onSave}>Save identification</button>
        <button type="button" disabled={props.busy || !props.hasScans} onClick={props.onLoad}>Load identification</button>
      </div>
    </div>

    <div className="tooth-chart-scroll" role="group" aria-label="Permanent odontogram; patient right is on the left">
      <div className="tooth-chart">
        <div className="tooth-orientation"><span>Patient right</span><span>Patient left</span></div>
        {['Upper', 'Lower'].map((name, row) => <div className="tooth-arch" key={name} role="group" aria-label={`${name} arch`}>
          <span className="tooth-arch-label">{name}</span>
          <div className="tooth-quadrant" role="group" aria-label={`${name} right quadrant`}>{QUADRANTS[row * 2].map(slot)}</div>
          <div className="tooth-quadrant" role="group" aria-label={`${name} left quadrant`}>{QUADRANTS[row * 2 + 1].map(slot)}</div>
        </div>)}
      </div>
    </div>
    <div className="tooth-legend" aria-label="Odontogram legend">
      <span><i className="tooth-key tooth-key--selected" />Selected</span>
      <span><i className="tooth-key tooth-key--assigned" />Assigned triangles</span>
      <span><b>P</b>Present</span><span><b>×</b>Missing</span><span><b>/</b>Not scanned</span><span><b>?</b>Unreviewed</span>
    </div>

    <div className="tooth-workbench">
      {props.viewport && <div className="tooth-scan">{props.viewport}</div>}
      {props.autoPanel && <div className="tooth-automation">{props.autoPanel}</div>}
      <div className="tooth-record">
        <div className="tooth-selected-heading"><strong>FDI {props.selectedTooth}</strong><span className="num">{count(assigned)} assigned triangles</span></div>
        <h3>{toothName(props.selectedTooth)}</h3>
        <div className="tooth-fields">
          <label>Review status<select aria-label="Review status" value={record.status} disabled={!compatibleScan || props.busy} onChange={event => setStatus(event.currentTarget.value as ToothStatus)}>
            <option value="unreviewed">Unreviewed</option><option value="present">Present · recorded identity</option>
            <option value="missing">Missing · user reviewed</option><option value="not-scanned">Not scanned · user reviewed</option>
          </select></label>
          <label>Restoration intent<select aria-label="Restoration intent" value={restoration} disabled={!compatibleScan || props.busy} onChange={event => props.onRecord({ restoration: event.currentTarget.value as RestorationIntent })}>
            <option value="none">None</option><option value="crown" disabled={record.status !== 'present'}>Crown review · present only</option>
            <option value="implant" disabled={record.status !== 'missing'}>Implant review · missing only</option>
          </select></label>
        </div>
        <p className="tooth-hint">Statuses record your review, not a diagnosis. Zero triangles does not mean missing.</p>
        <label className="tooth-note">Note (optional)<textarea aria-label="Note (optional)" rows={2} maxLength={2000} value={record.note} disabled={!compatibleScan || props.busy} onChange={event => props.onRecord({ note: event.currentTarget.value })} /></label>
        <div className="tooth-site-detail">
          <span>{record.site ? <><strong>Site marked</strong> · <span className="num">{record.site.point.map(coordinate).join(', ')} file units</span> (original scan)</> : 'Site not marked'}</span>
          {record.site && <button type="button" disabled={props.busy} onClick={props.onClearSite}>Remove site</button>}
        </div>
        <button className="tooth-clear-labels" type="button" disabled={assigned === 0 || props.busy} onClick={props.onClearTooth}>Clear labels for FDI <span className="num">{props.selectedTooth}</span></button>
      </div>

      <div className="tooth-editor">
        <p className="tooth-scan-message" id={`${id}-scan`} role="status">{scanMessage}</p>
        <div className="tooth-options">
          <label><input type="checkbox" checked={props.enabled} disabled={props.busy} onChange={event => props.onEnabled(event.currentTarget.checked)} />Show tooth labels</label>
          <label><input type="checkbox" checked={props.isolate} disabled={!props.hasScans || !props.enabled || props.busy || assigned + props.draftCount === 0} onChange={event => props.onIsolate(event.currentTarget.checked)} />Isolate tooth / preview</label>
        </div>
        <details className="tooth-corrections">
        <summary>Correction tools · brush, boundary & site</summary>
        <div className="tooth-tools" role="group" aria-label="Identification tools" aria-describedby={`${id}-scan ${id}-guidance`}>
          {TOOLS.map(item => <button key={item.value} type="button" aria-pressed={props.tool === item.value}
            disabled={item.value === 'inspect' ? props.busy : item.value === 'site' ? !canSite : ['paint', 'boundary', 'seed'].includes(item.value) ? !canAssign : !canEdit}
            onClick={() => props.onTool(item.value)}>{item.label}</button>)}
        </div>
        <div className="tooth-brush-history">
          <label>Brush radius<input aria-label="Brush radius" type="number" min="0.001" max="1000000" step="any" disabled={props.busy} value={props.brushRadius} onChange={event => {
            const radius = event.currentTarget.valueAsNumber;
            if (Number.isFinite(radius) && radius > 0) props.onBrushRadius(radius);
          }} /><span>file units</span></label>
          <div className="tooth-history"><button type="button" disabled={!props.canUndo || props.busy} onClick={props.onUndo}>Undo</button><button type="button" disabled={!props.canRedo || props.busy} onClick={props.onRedo}>Redo</button></div>
        </div>
        <div className="tooth-guidance" id={`${id}-guidance`}>
          <p><strong>Navigate</strong> to rotate. <strong>Boundary</strong>: place at least 3 points, add a <strong>Crown seed</strong>, then <strong>Preview region → Assign preview</strong>.</p>
          <p><strong>Add brush / Erase</strong> follow connected triangles within the radius; correct either pass with the other. Boundaries follow whole triangles.</p>
          {!props.enabled && <p>Turn on Show tooth labels to edit.</p>}
          {record.status === 'missing' ? <p><strong>Mark site</strong> places a dentist-marked point on the selected {arch} arch scan.</p> : <p>Mark site is available after you review a tooth as Missing.</p>}
        </div>
        <div className="tooth-boundary-status"><span className="num">{props.boundaryCount} boundary points</span> · Seed <span className="num">{props.hasSeed ? 'set' : 'not set'}</span> · <span className="num">{count(props.draftCount)} preview triangles</span></div>
        <div className="tooth-boundary-actions">
          <button type="button" disabled={!canEdit || props.boundaryCount === 0} onClick={props.onRemoveBoundaryPoint}>Remove last point</button>
          <button type="button" disabled={props.busy || !(props.boundaryCount || props.hasSeed || props.draftCount)} onClick={props.onClearDraft}>Clear boundary / preview</button>
          <button type="button" disabled={!canAssign || props.boundaryCount < 3 || !props.hasSeed} onClick={props.onPreview}>Preview region</button>
          <button className="tooth-confirm" type="button" disabled={!canAssign || props.draftCount === 0} onClick={props.onConfirm}>Assign preview</button>
        </div>
        </details>
      </div>
    </div>

    <div className="tooth-missing-sites">
      <h3>Missing sites <span className="num">{missing.length}</span></h3>
      {missing.length ? <ul>{missing.map(tooth => {
        const item = props.teeth[tooth];
        return <li key={tooth}><button type="button" disabled={props.busy} aria-pressed={tooth === props.selectedTooth} onClick={() => props.onSelect(tooth)}
          aria-label={`Select FDI ${tooth}, ${toothName(tooth)}; missing, user reviewed; ${count(props.counts[tooth] ?? 0)} assigned triangles; ${intentLabel(item.restoration, !!item.site)}; ${item.site ? 'site marked' : 'site not marked'}`}>
          <strong>FDI {tooth}</strong><span>{intentLabel(item.restoration, !!item.site)}</span><span className="tooth-site-tag">{item.site ? 'Site set' : 'Site not set'}</span>
        </button></li>;
      })}</ul> : <p>No teeth explicitly marked missing.</p>}
    </div>
    <div className="tooth-feedback">
      {(props.processing ?? props.busy) && <div className="tooth-busy"><span role="status">Processing identification…</span><button type="button" onClick={props.onCancel}>Cancel</button></div>}
      {props.error && <p className="tooth-error" role="alert">{props.error}</p>}
      {props.notice && <p className="tooth-notice" role="status">{props.notice}</p>}
    </div>
    <p className="tooth-save-hint">Keep saved identification with its original scans. This panel records identification and restoration intent.</p>
  </section>;
}
