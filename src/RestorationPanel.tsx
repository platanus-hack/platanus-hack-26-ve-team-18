import { useId, useState } from 'react';
import type { RestorationComponentKind, RestorationParameters, RestorationPanelProps } from './restoration-types';
import type { RestorationEdit } from './restoration-edit';
import type { RestorationGuardrailReport, RestorationPlacementFeedback } from './restoration-guardrails';
import { toothArch } from './teeth';
import './restoration-panel.css';

const COMPONENTS: RestorationComponentKind[] = ['fixture', 'abutment', 'crown'];
const LABELS = { fixture: 'Implant (fixture)', abutment: 'Abutment (pilar)', crown: 'Crown' };
const QUALITY_LABELS: Record<string, string> = { 'relative-width': 'Width vs neighbors', 'relative-depth': 'Depth vs neighbors', 'relative-height': 'Height vs neighbors', 'space-occupancy': 'Available space', 'proximal-contacts': 'Neighbor contacts', 'occlusal-contact': 'Static bite', interference: 'Surface interference', 'conflicting-targets': 'Conflicting requirements', anatomy: 'Anatomy and proportions', 'component-presentation': 'Component proportions' };
type Field = { key: string; label: string; unit: string; min?: number; max?: number; positive?: boolean };
const FIELDS: Record<RestorationComponentKind, Field[]> = {
  fixture: [
    { key: 'radius', label: 'Radius', unit: 'u', positive: true },
    { key: 'length', label: 'Length', unit: 'u', positive: true },
    { key: 'depth', label: 'Platform depth below site surface', unit: 'u', min: 0 },
    { key: 'taper', label: 'Apical taper fraction', unit: 'fraction', min: 0, max: 0.95 },
  ],
  abutment: [
    { key: 'radius', label: 'Top radius', unit: 'u', positive: true },
    { key: 'height', label: 'Crown base above site surface', unit: 'u', positive: true },
    { key: 'emergenceRadius', label: 'Emergence radius', unit: 'u', positive: true },
    { key: 'angleX', label: 'X angle', unit: 'degrees', min: -80, max: 80 },
    { key: 'angleY', label: 'Y angle', unit: 'degrees', min: -80, max: 80 },
  ],
  crown: [
    { key: 'width', label: 'Width', unit: 'u', positive: true },
    { key: 'depth', label: 'Depth', unit: 'u', positive: true },
    { key: 'height', label: 'Height', unit: 'u', positive: true },
    { key: 'cuspHeight', label: 'Cusp / ridge relief', unit: 'u', min: 0 },
    { key: 'rotation', label: 'Rotation about up', unit: 'degrees', min: -360, max: 360 },
  ],
};
const NOTES = {
  fixture: 'Platform depth is measured below the selected scan surface, not a bone crest. Changing it moves the fixture and extends the abutment below the site; the crown stays in place. Zero is an unassessed placeholder, not a recommended implant depth.',
  abutment: 'Starts at the fixture platform, bridging the depth to the site origin with a generic envelope. Angles slope the centreline while preserving upward height. Emergence is a shape control, not a fitted tissue margin.',
  crown: 'Procedural exterior with an artificial basal cap. Relief controls cusp or ridge shape, not a measured anatomical apex height or material thickness.',
};

function Dimensions({ component, parameters, disabled, editing, onApply }: {
  component: RestorationComponentKind; parameters: RestorationParameters; disabled: boolean; editing: boolean;
  onApply: (parameters: RestorationParameters) => void;
}) {
  const id = useId(), [error, setError] = useState('');
  return <details className="restoration-adjust" open={editing}>
    <summary>Adjust dimensions<span className="restoration-sr-only"> for {LABELS[component]}</span></summary>
    <form key={JSON.stringify(parameters[component])} onSubmit={event => {
      event.preventDefault();
      const form = new FormData(event.currentTarget), values: Record<string, number> = {};
      for (const field of FIELDS[component]) {
        const value = Number(form.get(field.key));
        if (!Number.isFinite(value) || (field.positive && value <= 0) || value < (field.min ?? -Infinity) || value > (field.max ?? Infinity)) {
          setError(`Enter a valid ${field.label.toLowerCase()}.`); return;
        }
        values[field.key] = value;
      }
      setError('');
      onApply({ fixture: { ...parameters.fixture }, abutment: { ...parameters.abutment }, crown: { ...parameters.crown },
        [component]: { ...parameters[component], ...values } });
    }}>
      <fieldset disabled={disabled}>
        <legend>{LABELS[component]} dimensions</legend>
        <div className="restoration-fields">
          {FIELDS[component].map(field => <label key={field.key} htmlFor={`${id}-${field.key}`}>
            <span>{field.label} <small>{field.unit}</small></span>
            <input id={`${id}-${field.key}`} name={field.key} type="number" required step="any"
              aria-label={`${LABELS[component]} ${field.label} (${field.unit})`}
              min={field.positive ? Number.MIN_VALUE : field.min} max={field.max}
              defaultValue={(parameters[component] as unknown as Record<string, number>)[field.key]} />
          </label>)}
        </div>
        <p>{NOTES[component]}</p>
        <button type="submit">Apply {LABELS[component]} dimensions</button>
      </fieldset>
      {error && <p className="restoration-error" role="alert">{error}</p>}
    </form>
  </details>;
}

type EditorProps = RestorationPanelProps & {
  onEdit?: (id: string, edit: RestorationEdit) => void;
  onAgentEdit?: () => void;
  onPlacementFeedback?: (id: string, feedback: RestorationPlacementFeedback | null) => void;
};
const GUARDRAIL_LABELS: Record<string, string> = {
  anatomy: 'Tooth anatomy', dimensions: 'Size & dimensions', 'cervical-emergence': 'Cervical contour & emergence',
  'surface-integrity': 'Surface integrity', shade: 'Color & shade', 'subcrestal-placement': 'Implant depth reference', 'adjacent-root-clearance': 'Adjacent tooth / root clearance',
};

function GuardrailReview({ report }: { report: RestorationGuardrailReport | undefined }) {
  return <details className="restoration-adjust restoration-guardrails" open><summary>Dentist feedback guardrails · {report?.status === 'fail' ? 'revision needed' : 'evidence incomplete'}</summary>
    <p>Geometry checks and missing clinical evidence stay separate. An unknown result requires evidence or review; it cannot be fixed by improving a fitting score.</p>
    {report ? report.issues.map(issue => <details key={issue.id} className={`restoration-guardrail restoration-guardrail--${issue.status}`}>
      <summary><span>{issue.status === 'fail' ? 'Needs revision' : 'Unknown'}</span> {GUARDRAIL_LABELS[issue.id]}</summary>
      <p>{issue.summary}</p><p><strong>Target:</strong> {issue.target.value === null ? '' : `${issue.target.value} ${issue.target.units} · `}{issue.target.description}</p>
      {issue.missingEvidence.length > 0 && <><p><strong>Evidence needed</strong></p><ul>{issue.missingEvidence.map(item => <li key={item}>{item}</li>)}</ul></>}
      <p><strong>Next steps</strong></p><ul>{issue.suggestions.map((suggestion, index) => <li key={index}><strong>{LABELS[suggestion.component]}:</strong> {suggestion.action}{suggestion.parameters.length > 0 && <small className="restoration-guardrail-controls">Controls: {suggestion.parameters.join(', ')}</small>}</li>)}</ul>
      <details><summary>Observed values & limits</summary><dl className="restoration-guardrail-values">{Object.entries(issue.actual).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value === null ? 'Unmeasured' : typeof value === 'number' ? Number(value.toPrecision(6)) : String(value)}</dd></div>)}</dl></details>
    </details>) : <p>No current dentist-feedback evaluation is available. Apply an edit or retry fitting to measure this concept again.</p>}
  </details>;
}

function PlacementFeedback({ feedback, disabled, onApply }: { feedback?: RestorationPlacementFeedback; disabled: boolean; onApply: (feedback: RestorationPlacementFeedback | null) => void }) {
  const id = useId();
  return <details className="restoration-adjust"><summary>Case-specific placement feedback</summary>
    <p>The confirmed dentist feedback is 1.5 mm subcrestal and at least 1.5 mm from each adjacent tooth. Record it only for the relevant case. These targets never move geometry; the reference surfaces and clinical applicability still need review.</p>
    <form key={JSON.stringify(feedback)} onSubmit={event => {
      event.preventDefault(); const data = new FormData(event.currentTarget);
      const read = (name: string) => String(data.get(name) ?? '').trim() ? Number(data.get(name)) : null;
      onApply({ provenance: data.get('provenance') as RestorationPlacementFeedback['provenance'], source: String(data.get('source')).trim(), subcrestalDepthMm: read('subcrestalDepthMm'), adjacentToothClearanceMm: read('adjacentToothClearanceMm') });
    }}><fieldset disabled={disabled}><legend>Case targets · millimeters</legend><div className="restoration-fields">
      <label htmlFor={`${id}-depth`}><span>Subcrestal depth <small>mm</small></span><input id={`${id}-depth`} name="subcrestalDepthMm" type="number" min="0" step="any" placeholder="Unconfirmed" defaultValue={feedback ? feedback.subcrestalDepthMm ?? '' : 1.5} /></label>
      <label htmlFor={`${id}-clearance`}><span>Minimum adjacent clearance <small>mm</small></span><input id={`${id}-clearance`} name="adjacentToothClearanceMm" type="number" min="0" step="any" placeholder="Unconfirmed" defaultValue={feedback ? feedback.adjacentToothClearanceMm ?? '' : 1.5} /></label>
      <label htmlFor={`${id}-provenance`}><span>Feedback wording</span><select id={`${id}-provenance`} name="provenance" defaultValue={feedback?.provenance ?? 'clinician-entered-case-feedback'}><option value="clinician-entered-case-feedback">Confirmed clinician feedback</option><option value="unconfirmed-case-feedback">Unconfirmed transcript</option></select></label>
      <label htmlFor={`${id}-source`}><span>Feedback source / clinical context</span><input id={`${id}-source`} name="source" type="text" required maxLength={1000} defaultValue={feedback?.source ?? 'User-confirmed dentist feedback: 1.5 mm subcrestal and at least 1.5 mm from each adjacent tooth. Clinical applicability unassessed.'} /></label>
    </div><p>A calibrated scale, reviewed bone crest and adjacent root surfaces are needed for a clinical comparison. Mesh editing continues to use file units.</p><button type="submit">Record case targets</button>{feedback && <button type="button" onClick={() => onApply(null)}>Clear case targets</button>}</fieldset></form>
  </details>;
}
const DISPLAY_DEFAULTS = {
  fixture: { color: '#94a3b8', roughness: .48 },
  abutment: { color: '#c4a46b', roughness: .36 },
  crown: { color: '#f4ead7', roughness: .42 },
};

function ShapeEditor({ spec, disabled, onApply }: {
  spec: RestorationPanelProps['assemblies'][number]['spec']; disabled: boolean; onApply: (edit: RestorationEdit) => void;
}) {
  const id = useId();
  return <form className="restoration-adjust" key={JSON.stringify([spec.anatomy, spec.contour])} onSubmit={event => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const anatomy = data.get('anatomy') as typeof spec.anatomy;
    onApply({ reason: 'Manual crown anatomy and cervical contour adjustment.', ...(anatomy !== spec.anatomy ? { anatomy } : {}),
      contour: { cervicalScale: Number(data.get('cervicalScale')), occlusalScale: Number(data.get('occlusalScale')) } });
  }}>
    <fieldset disabled={disabled}>
      <legend>Crown anatomy & cervical contour</legend>
      <div className="restoration-fields">
        <label htmlFor={`${id}-anatomy`}><span>Anatomy hypothesis</span><select id={`${id}-anatomy`} name="anatomy" defaultValue={spec.anatomy}>
          {(['incisor', 'canine', 'premolar', 'molar'] as const).map(value => <option key={value} value={value}>{value}</option>)}
        </select></label>
        <label htmlFor={`${id}-cervical`}><span>Cervical contour <small>×</small></span><input id={`${id}-cervical`} aria-label="Crown cervical contour scale" name="cervicalScale" type="number" min="0.5" max="1.5" step="any" required defaultValue={spec.contour?.cervicalScale ?? 1} /></label>
        <label htmlFor={`${id}-occlusal`}><span>Occlusal anatomy relief <small>×</small></span><input id={`${id}-occlusal`} aria-label="Crown occlusal relief scale" name="occlusalScale" type="number" min="0.5" max="1.5" step="any" required defaultValue={spec.contour?.occlusalScale ?? 1} /></label>
      </div>
      <p>1× retains the starting contour. Cervical contour changes the crown neck; pilar emergence is edited separately. Changing anatomy replaces the current donor/template with a procedural hypothesis and keeps the recorded tooth identity unchanged.</p>
      <button type="submit">Apply crown shape</button>
    </fieldset>
  </form>;
}

function AppearanceEditor({ component, appearance, disabled, onApply }: {
  component: RestorationComponentKind; appearance: { color?: string; roughness?: number } | undefined;
  disabled: boolean; onApply: (edit: RestorationEdit) => void;
}) {
  const id = useId(), values = { ...DISPLAY_DEFAULTS[component], ...appearance };
  return <form className="restoration-adjust" key={JSON.stringify(values)} onSubmit={event => {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    onApply({ reason: `Manual ${component} display color and finish adjustment.`, appearance: { [component]: { color: String(data.get('color')), roughness: Number(data.get('roughness')) } } });
  }}>
    <fieldset disabled={disabled}><legend>Display color & finish</legend><div className="restoration-fields">
      <label htmlFor={`${id}-color`}><span>Display color</span><input id={`${id}-color`} type="color" name="color" aria-label={`${LABELS[component]} display color`} defaultValue={values.color} /></label>
      <label htmlFor={`${id}-roughness`}><span>Surface roughness <small>0–1</small></span><input id={`${id}-roughness`} type="number" name="roughness" aria-label={`${LABELS[component]} display roughness`} min="0" max="1" step="any" required defaultValue={values.roughness} /></label>
    </div><p>Display only. Color is not a calibrated dental shade, and visual smoothness does not repair the mesh or establish a suitable material surface.</p><button type="submit">Apply {LABELS[component]} appearance</button></fieldset>
  </form>;
}

export function RestorationPanel(props: EditorProps) {
  const id = useId(), selected = props.assemblies.find(assembly => assembly.id === props.selectedId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = !!selected && editingId === selected.id;
  const editDisabled = props.busy || !!selected?.warnings.some(warning => warning.startsWith('STALE:'));
  const siteLabel = (spec: RestorationPanelProps['assemblies'][number]['spec']) => spec.draftIdentity
    ? `${toothArch(spec.draftIdentity.templateFdi) === 'upper' ? 'Upper' : 'Lower'} draft site` : `FDI ${spec.fdi}`;
  return <section className="restoration-panel" aria-labelledby={`${id}-heading`} aria-busy={props.busy}>
    <div className="restoration-header"><h2 id={`${id}-heading`}>Restoration concepts</h2><span>{props.assemblies.length}</span></div>
    <p className="restoration-intro">Fixture, abutment and crown are separate editable planning concepts. Dimensions are file units (u).</p>
    {props.assemblies.length ? <div className="restoration-list" role="group" aria-label="Restoration concepts">
      {props.assemblies.map((assembly, index) => <button type="button" key={assembly.id} disabled={props.busy}
        aria-pressed={assembly.id === props.selectedId} onClick={() => props.onSelect(assembly.id)}>
        <strong>{siteLabel(assembly.spec)}</strong><span>{assembly.spec.anatomy} · proposal {index + 1} · 3 parts</span>
      </button>)}
    </div> : <p className="restoration-empty">No restoration concepts yet. Start the workflow to generate and fit supported local draft sites automatically. Manual site tools are available under Advanced tools.</p>}
    {selected ? <div className="restoration-selected" key={selected.id}>
      <div className="restoration-selected-title"><strong>{siteLabel(selected.spec)} · {selected.spec.anatomy}</strong>
        <button type="button" disabled={props.busy} onClick={() => props.onRemove(selected.id)}>Remove concept</button></div>
      <p className="restoration-provenance">{selected.spec.provenance === 'hypothesized' ? 'Hypothesized geometry' : 'Clinician-entered geometry'} · {selected.spec.source}</p>
      <div className="restoration-editor-toolbar" role="group" aria-label="Component edit mode">
        <button type="button" aria-pressed={editing} disabled={editDisabled} onClick={() => setEditingId(editing ? null : selected.id)}>{editing ? 'Finish manual editing' : 'Edit components manually'}</button>
        {props.onAgentEdit && <button type="button" disabled={editDisabled} onClick={props.onAgentEdit}>Edit with agent</button>}
      </div>
      <p className="restoration-edit-explanation">{editing ? 'Edit the values below. Each Apply regenerates those values and measures the result; prior versions are retained.' : 'Inspect current values below, or enter manual edit mode. Agent editing is enabled separately in the case assistant.'}</p>
      {selected.spec.draftIdentity && <details className="restoration-adjust"><summary>Draft identity & optional correction</summary><p>Anatomical FDI and patient side remain unresolved. FDI {selected.spec.draftIdentity.templateFdi} selects the illustrative crown template only.</p><p>{selected.spec.draftIdentity.basis}</p>{selected.spec.draftIdentity.alternatives.length > 0 && <p>Alternative anatomy templates: {selected.spec.draftIdentity.alternatives.join(', ')}.</p>}<p>Use Advanced tools → Localized spaces → Optional identity correction & skip to correct this hypothesis. Draft corrections stay separate from reviewed chart records.</p></details>}
      <button type="button" disabled={props.busy || selected.warnings.some(warning => warning.startsWith('STALE:'))} onClick={() => props.onCompare?.(selected.id)}>Retry fitting as a comparison</button>
      {props.onRebuild && <button type="button" disabled={props.busy || selected.warnings.some(warning => warning.startsWith('STALE:'))} onClick={() => props.onRebuild?.(selected.id)}>Rebuild from measured site</button>}
      {!!selected.previousVersions?.length && <details className="restoration-adjust"><summary>Prior edits · {selected.previousVersions.length}</summary><p>Prior parameters, anatomy, measured fits and candidate histories remain available. Inspect a copy to re-evaluate a previous edit.</p>{selected.previousVersions.map((version, index) => <p key={index}>Edit {index + 1} · {version.fit?.after.score.toFixed(4) ?? 'Unmeasured'} <button type="button" disabled={props.busy || selected.warnings.some(warning => warning.startsWith('STALE:'))} onClick={() => props.onCompare?.(selected.id, undefined, index)}>Inspect prior edit {index + 1}</button></p>)}</details>}
      <p className="restoration-limit">Compatibility, bone-safe depth, clinical fit and manufacturing readiness are unassessed. IOS surfaces cannot establish bone anatomy or manufacturer compatibility.</p>
      {selected.warnings.length > 0 && <ul className="restoration-warnings">{selected.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      <GuardrailReview report={selected.fit?.quality?.final.guardrails} />
      {props.onPlacementFeedback && <PlacementFeedback feedback={selected.spec.qualityContext?.placementFeedback} disabled={editDisabled} onApply={feedback => props.onPlacementFeedback?.(selected.id, feedback)} />}
      {selected.fit?.quality && <details className="restoration-adjust" open={!editing}><summary>Independent checks · {selected.fit.quality.final.status === 'pass' ? 'prototype checks passed' : 'needs revision or review'}</summary>
        <p>{selected.fit.quality.rounds} create–evaluate–revise rounds · {selected.fit.quality.stopReason.replaceAll('-', ' ')}. These checks use disclosed prototype tolerances. They do not establish clinical fit.</p>
        {selected.fit.quality.final.criteria.map(criterion => <details key={criterion.id}><summary>{criterion.status === 'pass' ? 'Pass' : criterion.status === 'fail' ? 'Needs revision' : 'Unknown'} · {QUALITY_LABELS[criterion.id]}</summary><ul>{criterion.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul></details>)}
        {!!selected.fit.quality.final.unresolvedRevisionConflicts.length && <ul>{selected.fit.quality.final.unresolvedRevisionConflicts.map(reason => <li key={reason}>{reason}</li>)}</ul>}
        <details><summary>Prototype tolerances</summary><p>Neighbor-relative width {selected.fit.quality.final.tolerances.widthToNeighbor.join('–')}×, depth {selected.fit.quality.final.tolerances.depthToNeighbor.join('–')}×, height {selected.fit.quality.final.tolerances.heightToNeighbor.join('–')}×. These engineering ratios are not clinical limits.</p></details>
      </details>}
      {selected.fit && <details className="restoration-adjust"><summary>Measured fitting · {selected.fit.status}</summary>
        <p>Objective score {selected.fit.before.score.toFixed(4)} → {selected.fit.after.score.toFixed(4)} · {selected.fit.candidates} candidates · {(selected.fit.durationMs / 1000).toFixed(1)} s · {selected.fit.termination.replaceAll('-', ' ')}.</p>
        <p>Illustrative geometric targets in file units, not clinical contact prescriptions. A lower objective does not mean the independent checks passed. Dimension edits are measured as entered; use Retry fitting to revise again.</p>
        {selected.fit.after.surfaces.filter(surface => surface.role === 'antagonist' && surface.occlusalRaySamples !== undefined).map(surface => <p key={`rays-${surface.id}`}>Forward bite gap: {surface.sampledOcclusalGap == null ? 'unmeasured' : `${surface.sampledOcclusalGap.toFixed(3)} u`} · {surface.occlusalRayHits}/{surface.occlusalRaySamples} rays met opposing geometry. Misses are unknown; this is a sampled static bite.</p>)}
        {selected.fit.after.surfaces.map(surface => { const before = selected.fit!.before.surfaces.find(item => item.id === surface.id); return <div key={surface.id}><strong>{surface.role === 'source-arch' ? 'Unclassified source-arch surroundings' : surface.role === 'other-tooth' ? 'Other scanned tooth · clearance context' : surface.role}{surface.side ? ` · ${surface.side}` : ''}</strong><p>Sample gap {before?.sampledMinDistance.toFixed(3) ?? '—'} → {surface.sampledMinDistance.toFixed(3)} u; target {surface.targetGap.toFixed(3)} u. Touch/crossing triangles {before?.intersectingTriangles ?? '—'} → {surface.intersectingTriangles}; transverse crossing evidence {surface.transverseCrossingTriangles ?? 'unavailable'}; {surface.samples} samples; {surface.intersectionComplete ? 'complete supplied target crossing test' : 'bounded crossing test'}. {surface.targetProvenance}</p></div>; })}
        <details><summary>Sampling limits & candidate history</summary><ul>{selected.fit.limits.map((limit, index) => <li key={index}>{limit}</li>)}</ul><p>Anatomical distortion penalty {selected.fit.after.morphologyPenalty.toFixed(4)}.</p><table><thead><tr><th>Candidate</th><th>Score</th><th>Compare</th></tr></thead><tbody>{selected.candidateHistory?.map(candidate => <tr key={candidate.candidate}><td>{candidate.candidate}{candidate.accepted ? ' · best at this step' : ''}</td><td>{candidate.measurement.score.toFixed(4)}</td><td><button type="button" disabled={props.busy || selected.warnings.some(warning => warning.startsWith('STALE:'))} onClick={() => props.onCompare?.(selected.id, candidate.candidate)}>Inspect copy</button></td></tr>)}</tbody></table><p>Comparisons retain the original best and create a separately editable candidate.</p></details>
      </details>}
      <div className="restoration-components">{COMPONENTS.map(component => {
        const part = selected.parts.find(part => part.restoration?.component === component);
        return <div className={`restoration-component restoration-component--${component}`} key={component}>
          <div className="restoration-component-header"><h3>{LABELS[component]}</h3>
            {part ? <div className="restoration-component-actions">
              <label><input type="checkbox" aria-label={`Show ${LABELS[component]}`} checked={part.visible} disabled={props.busy}
                onChange={() => props.onTogglePart(part.id)} />Visible</label>
              <button type="button" disabled={props.busy} onClick={() => props.onExportPart(part.id)}>Export {LABELS[component]}</button>
            </div> : <span className="restoration-pending">Geometry unavailable</span>}
          </div>
          <p className="restoration-component-values">{FIELDS[component].map(field => `${field.label}: ${Number((selected.spec.parameters[component] as unknown as Record<string, number>)[field.key].toPrecision(5))} ${field.unit}`).join(' · ')}</p>
          <Dimensions component={component}
            parameters={selected.spec.parameters} disabled={editDisabled || !editing} editing={editing}
            onApply={parameters => props.onUpdate(selected.id, parameters)} />
          {part && <p className="restoration-component-bounds">Emitted file-axis bounds: {part.dimensions.map(value => value.toFixed(3)).join(' × ')} u · {part.closed ? 'closed mesh' : 'open mesh'}.</p>}
          {props.onEdit && editing && component === 'crown' && <ShapeEditor spec={selected.spec} disabled={editDisabled} onApply={edit => props.onEdit?.(selected.id, edit)} />}
          {props.onEdit && editing && <AppearanceEditor component={component} appearance={selected.spec.appearance?.[component]} disabled={editDisabled} onApply={edit => props.onEdit?.(selected.id, edit)} />}
        </div>;
      })}</div>
    </div> : props.assemblies.length > 0 && <p className="restoration-empty">Select a concept to inspect its parts.</p>}
    {props.busy && <p className="restoration-status" role="status">Generating restoration concept…</p>}
    {props.error && <p className="restoration-error" role="alert">{props.error}</p>}
  </section>;
}
