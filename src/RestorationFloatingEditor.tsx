import { useId, useState } from 'react';
import type { RestorationAssembly, RestorationComponentKind } from './restoration-types';
import type { RestorationEdit } from './restoration-edit';
import { AppearanceEditor, Dimensions, ShapeEditor } from './RestorationPanel';
import { scanScale } from './measurement';
import { toothArch } from './teeth';
import './restoration-floating-editor.css';

const COMPONENTS = ['fixture', 'abutment', 'crown'] as const;
const LABELS = { fixture: 'Implant', abutment: 'Pilar', crown: 'Crown' };
const siteLabel = (assembly: RestorationAssembly) => assembly.spec.draftIdentity
  ? `${toothArch(assembly.spec.draftIdentity.templateFdi) === 'upper' ? 'Upper' : 'Lower'} draft` : `FDI ${assembly.spec.fdi}`;

interface Props {
  assembly: RestorationAssembly;
  assemblies: RestorationAssembly[];
  component: RestorationComponentKind;
  /** Case scan scale for displayed lengths; null keeps file units. */
  mmPerUnit: number | null;
  busy: boolean;
  error: string;
  minimized: boolean;
  onExpand: () => void;
  onComponent: (component: RestorationComponentKind) => void;
  onSelect: (id: string) => void;
  onEdit: (id: string, edit: RestorationEdit) => void;
  onMinimize: () => void;
  onAgentEdit: () => void;
  onReview: () => void;
  onRecheck: (id: string) => void;
  onFit: (id: string) => void;
}

export function RestorationFloatingEditor(props: Props) {
  const id = useId();
  const [section, setSection] = useState<'dimensions' | 'shape' | 'appearance'>('dimensions');
  // Drafts belong to the assembly and the values they were based on. Tab changes
  // and minimizing preserve them; an applied revision supersedes older values.
  const [drafts, setDrafts] = useState<Record<string, { basis: string; values: Record<string, string> }>>({});
  const { assembly, component } = props;
  const scale = scanScale(props.mmPerUnit);
  const activeSection = section === 'shape' && component !== 'crown' ? 'dimensions' : section;
  const stale = assembly.warnings.some(warning => warning.startsWith('STALE:'));
  const disabled = props.busy || stale;
  const goal = assembly.fit?.goal;
  const failures = goal?.after.rows.filter(row => row.priority !== 'preference' && row.status === 'fail') ?? [];
  const unknowns = goal?.after.rows.filter(row => row.priority !== 'preference' && row.status === 'unknown') ?? [];
  const apply = (edit: RestorationEdit) => props.onEdit(assembly.id, edit);
  const sections = component === 'crown' ? ['dimensions', 'shape', 'appearance'] as const : ['dimensions', 'appearance'] as const;
  const draftKey = `${assembly.id}:${component}:${activeSection}`;
  // Dimension drafts are typed in display units, so a scale change discards them.
  const basis = JSON.stringify(activeSection === 'dimensions' ? [assembly.spec.parameters[component], scale]
    : activeSection === 'shape' ? [assembly.spec.anatomy, assembly.spec.contour] : assembly.spec.appearance?.[component]) ?? '';
  const draftValues = drafts[draftKey]?.basis === basis ? drafts[draftKey].values : undefined;
  if (props.minimized) return <button className="restoration-floating-reopen" onClick={props.onExpand}>Edit restoration</button>;
  return <section className="restoration-panel restoration-floating-editor" aria-label="Edit selected restoration" aria-busy={props.busy}>
    <header className="restoration-floating-header">
      <div><strong>Edit restoration</strong><span>{siteLabel(assembly)} · {scale === null ? 'file units (u) · scan scale unset' : `mm · scan scale ${scale} mm/u`}</span></div>
      <button type="button" onClick={props.onMinimize} aria-label="Minimize restoration controls" title="Minimize controls">−</button>
    </header>
    {props.assemblies.length > 1 && <select className="restoration-floating-selection" aria-label="Restoration to edit" value={assembly.id} disabled={props.busy} onChange={event => props.onSelect(event.target.value)}>
      {props.assemblies.map((item, index) => <option key={item.id} value={item.id}>{siteLabel(item)} · proposal {index + 1}</option>)}
    </select>}
    <div className="restoration-floating-tabs" role="group" aria-label="Component to edit">
      {COMPONENTS.map(value => <button key={value} type="button" aria-pressed={value === component} onClick={() => props.onComponent(value)}>{LABELS[value]}</button>)}
    </div>
    <div className="restoration-floating-sections" role="group" aria-label={`${LABELS[component]} controls`}>
      {sections.map(value => <button key={value} type="button" aria-pressed={value === activeSection} aria-controls={`${id}-fields`} onClick={() => setSection(value)}>{value === 'shape' ? 'Anatomy & contour' : value === 'appearance' ? 'Color & finish' : 'Dimensions'}</button>)}
    </div>
    <div className="restoration-floating-fields" id={`${id}-fields`} key={`${draftKey}:${basis}`} onChangeCapture={event => {
      const input = event.target;
      if (!(input instanceof HTMLInputElement || input instanceof HTMLSelectElement) || !input.name) return;
      const name = input.name, value = input.value;
      setDrafts(current => ({ ...current, [draftKey]: { basis, values: { ...(current[draftKey]?.basis === basis ? current[draftKey].values : {}), [name]: value } } }));
    }}>
      {activeSection === 'dimensions' && <Dimensions compact draftValues={draftValues} component={component} parameters={assembly.spec.parameters} mmPerUnit={props.mmPerUnit} disabled={disabled} editing onApply={parameters => apply({ reason: `Manual ${component} dimension adjustment.`, parameters: { [component]: parameters[component] } })} />}
      {activeSection === 'shape' && <ShapeEditor compact draftValues={draftValues} spec={assembly.spec} disabled={disabled} onApply={apply} />}
      {activeSection === 'appearance' && <AppearanceEditor compact draftValues={draftValues} component={component} appearance={assembly.spec.appearance?.[component]} disabled={disabled} onApply={apply} />}
    </div>
    <details className="restoration-floating-checks">
      <summary>{stale ? 'Checks need refreshing' : !goal ? 'Geometry checks unavailable' : `${failures.length} failed · ${unknowns.length} unresolved checks`}</summary>
      {stale ? <p>Rebuild against the current source before using these measurements.</p> : !goal ? <p>Recheck geometry to measure the current design.</p> : <>
        <ul>{[...failures, ...unknowns].map(row => <li key={row.id}><strong>{row.status === 'fail' ? 'Needs adjustment' : 'Unknown'}: {row.label}</strong><span>{row.reason}</span></li>)}</ul>
        {!failures.length && !unknowns.length && <p>The recorded requirements are met within their measurement limits.</p>}
        <p>Distances use file units. Samples do not measure contact area or tissue pressure.</p>
      </>}
    </details>
    <div className="restoration-floating-fit-actions">
      <button type="button" disabled={disabled} onClick={() => props.onRecheck(assembly.id)}>Recheck geometry</button>
      <button type="button" disabled={disabled} onClick={() => props.onFit(assembly.id)}>Fit to mouth requirements</button>
    </div>
    <div className="restoration-floating-feedback" role="status">{props.busy ? 'Applying & rechecking…' : stale ? 'Source changed. Rebuild this concept before editing.' : `${assembly.previousVersions?.length ? `Edit ${assembly.previousVersions.length} measured` : 'Apply to update & recheck'} · clinical fit unassessed`}</div>
    {props.error && <p className="restoration-error" role="alert">{props.error}</p>}
    <footer className="restoration-floating-actions"><button type="button" disabled={disabled} onClick={props.onAgentEdit}>Edit with agent</button><button type="button" onClick={props.onReview}>Guardrails & history</button></footer>
  </section>;
}
