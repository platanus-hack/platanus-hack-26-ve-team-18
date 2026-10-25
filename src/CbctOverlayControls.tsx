import { useRef } from 'react';
import type { CbctAutoAlignmentResult } from './cbct-auto-alignment';
import './cbct-overlay-controls.css';

interface Props {
  hasScans: boolean;
  mmPerUnit: number | null;
  onScale: (value: number | null) => void;
  busy: boolean;
  disabled: boolean;
  onAlign: () => void;
  onCancel: () => void;
  onReset: () => void;
  canReset: boolean;
  onLandmarks: () => void;
  result?: CbctAutoAlignmentResult;
  aligned: boolean;
  reviewed: boolean;
  onReviewed: (value: boolean) => void;
  error: string;
  complete: boolean;
  referenceVisible: boolean;
  onReferenceVisible: (value: boolean) => void;
  referenceOpacity: number;
  onReferenceOpacity: (value: number) => void;
  scanOpacity: number;
  onScanOpacity: (value: number) => void;
}

export function CbctOverlayControls(props: Props) {
  const scaleKnown = props.mmPerUnit !== null;
  const rememberedScale = useRef(props.mmPerUnit ?? 1);
  return <section className="cbct-overlay-controls" aria-label="3D model and CBCT overlay" aria-busy={props.busy}>
    <div className="cbct-overlay-heading"><strong>3D model + CBCT</strong><span role="status">{props.busy ? 'Aligning to CBCT jaw region…' : props.reviewed ? 'Visual alignment reviewed' : props.aligned ? 'Superimposed · review pending' : 'Alignment pending'}</span></div>
    {props.hasScans ? <>
      <div className="cbct-overlay-actions">
        <label className="cbct-overlay-toggle"><input type="checkbox" checked={scaleKnown} disabled={props.busy || props.disabled}
          onChange={event => props.onScale(event.currentTarget.checked ? rememberedScale.current : null)} />Scan</label>
        {scaleKnown && <label>Scan scale <span>mm per file unit · default <span className="num">1</span></span><input aria-label="Scan scale (mm per file unit)" type="number" step="any" min="0" max="1000000" placeholder="Set scale" value={props.mmPerUnit ?? ''} disabled={props.busy || props.disabled}
          onChange={event => { const value = event.currentTarget.valueAsNumber, valid = Number.isFinite(value) && value > 0 && value <= 1e6; if (valid) rememberedScale.current = value; props.onScale(valid ? value : null); }} /></label>}
        <button className="primary" disabled={props.disabled || (!props.busy && !scaleKnown)} onClick={props.busy ? props.onCancel : props.onAlign}>{props.busy ? 'Cancel alignment' : props.aligned ? 'Refine superposition' : 'Align model to CBCT'}</button>
        <button disabled={props.busy || props.disabled || !props.canReset} onClick={props.onReset}>Reset alignment</button>
        <button disabled={props.busy} onClick={props.onLandmarks}>Landmarks & slices</button>
      </div>
      {!scaleKnown && <p>Check Scan to apply the physical scale and show both layers together. The imported files keep their shared coordinates.</p>}
      {scaleKnown && !props.aligned && !props.busy && !props.error && <p>New imports align automatically to the CBCT jaw region.</p>}
      {scaleKnown && <div className="cbct-overlay-layers">
        <label className="cbct-overlay-toggle"><input type="checkbox" checked={props.referenceVisible} onChange={event => props.onReferenceVisible(event.currentTarget.checked)} />CBCT</label>
        <label className="cbct-overlay-opacity">CBCT opacity<input aria-label="CBCT overlay opacity" type="range" min="0.05" max="1" step="0.05" disabled={!props.referenceVisible} value={props.referenceOpacity} onChange={event => props.onReferenceOpacity(Number(event.currentTarget.value))} /><output>{Math.round(props.referenceOpacity * 100)}%</output></label>
        <label className="cbct-overlay-opacity">Model opacity<input aria-label="3D model overlay opacity" type="range" min="0" max="1" step="0.05" value={props.scanOpacity} onChange={event => props.onScanOpacity(Number(event.currentTarget.value))} /><output>{Math.round(props.scanOpacity * 100)}%</output></label>
      </div>}
      {props.result && <p>Sampled surface RMS <span className="num">{props.result.rmsMm.toFixed(2)} mm</span> · median <span className="num">{props.result.medianMm.toFixed(2)} mm</span> · <span className="num">{Math.round(props.result.coverage * 100)}%</span> compatible samples within 1 mm. Scan parts move together; check matching anatomy in the slices.</p>}
      {props.result?.registrationSupport?.method === 'heuristic-crown-regions' && <p>Heuristic crown support: <span className="num">{Math.round(props.result.registrationSupport.coverage * 100)}%</span> within 1 mm · inlier RMS <span className="num">{props.result.registrationSupport.inlierRmsMm.toFixed(2)} mm</span>. The fit uses these crown regions; whole-scan distances above also include gums and palate.</p>}
      {props.result?.registrationTarget && <p className="cbct-overlay-limit">Jaw-region fit target: <span className="num">{props.result.registrationTarget.samples.toLocaleString()} native surface samples</span> · <span className="num">{props.result.registrationTarget.samplingCellMm.toFixed(3)} mm sampling cells</span>. Display resolution stays independent.</p>}
      {props.aligned && <label className="cbct-overlay-review"><input type="checkbox" disabled={props.busy || props.disabled} checked={props.reviewed} onChange={event => props.onReviewed(event.currentTarget.checked)} />I reviewed the superposition in 3D and the CBCT slices</label>}
      <p className="cbct-overlay-limit">Threshold reconstruction and sampled fitting are visual estimates.{!props.complete ? ' Incomplete CBCT: preview only.' : ''}</p>
    </> : <p>CBCT reconstruction in native DICOM millimeters. Add local 3D scans to align and superimpose them.</p>}
    {props.error && <p className="cbct-overlay-error" role="alert">{props.error}</p>}
  </section>;
}
