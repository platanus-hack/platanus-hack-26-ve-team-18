import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ModelPart } from './models.ts';
import type { Probe } from './viewer.ts';
import type { TomographySeriesChoice, TomographySurface, TomographyViewSpec, TomographyVolume, Vec3 } from './tomography-types.ts';
import { sampleVolume, volumeCenter, voxelToPatient } from './tomography-geometry.ts';
import { partMatrix } from './pose.ts';
import { getSliceFrame, initialTomographyWindow, pixelToPatient, renderTomographyView, transformPartToPatient, type OverlayRegistration, type TomographyMeasurement, type TomographyOverlayOptions } from './tomography-views.ts';
import './tomography-panel.css';

export interface TomographyLandmarkPair { source: Vec3; target: Vec3 }
export interface TomographyPanelProps {
  volume: TomographyVolume | null;
  parts: ModelPart[];
  mmPerUnit: number | null;
  onMmPerUnit: (value: number | null) => void;
  loading: boolean;
  surfaceBusy: boolean;
  alignmentBusy?: boolean;
  status: string;
  error: string | null;
  onImport: (files: File[], allowIncompletePreview: boolean) => void;
  onCancel: () => void;
  onClear: () => void;
  threshold: number;
  onThreshold: (value: number) => void;
  stride: number;
  onStride: (value: number) => void;
  surface?: TomographySurface | null;
  seriesChoices?: TomographySeriesChoice[];
  onSelectSeries?: (id: string) => void;
  referenceVisible: boolean;
  onReferenceVisible: (value: boolean) => void;
  referenceOpacity: number;
  onReferenceOpacity: (value: number) => void;
  selectedProbe?: Probe | null;
  registrations?: OverlayRegistration[];
  assemblyRegistration?: TomographyOverlayOptions['assemblyRegistration'];
  /** Return true after a successful fit, false on failure. Legacy void callbacks also clear on pose change. */
  onRegister?: (arch: 'upper' | 'lower', pairs: TomographyLandmarkPair[]) => boolean | void;
  onResetRegistration?: (arch: 'upper' | 'lower') => void;
  onReviewRegistration?: (arch: 'upper' | 'lower', reviewed: boolean) => void;
  /** Exact displayed LPS plane/window specs, shared with the evidence capture path. */
  onViewsChange?: (specs: TomographyViewSpec[]) => void;
}

type Arch = 'upper' | 'lower';
type MeasurementState = { plane: TomographyViewSpec['plane']; normal: Vec3; a: Vec3; b?: Vec3 };
const ARCHES: Arch[] = ['upper', 'lower'];
const EMPTY_REGISTRATIONS: OverlayRegistration[] = [];
const formatPoint = (p: Vec3) => p.map(v => v.toFixed(2)).join(', ');
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

function patientBounds(volume: TomographyVolume): [Vec3, Vec3] {
  const corners = [0, 1].flatMap(x => [0, 1].flatMap(y => [0, 1].map(z => voxelToPatient(volume,
    [x * (volume.dimensions[0] - 1), y * (volume.dimensions[1] - 1), z * (volume.dimensions[2] - 1)]))));
  return [0, 1].map(side => [0, 1, 2].map(axis => (side ? Math.max : Math.min)(...corners.map(p => p[axis]))) as Vec3) as [Vec3, Vec3];
}

/** Distinct, noncollinear landmarks are required in both coordinate systems. */
function usablePairs(pairs: TomographyLandmarkPair[]): boolean {
  if (pairs.length < 3) return false;
  return (['source', 'target'] as const).every(key => {
    const a = pairs[0][key];
    for (let i = 1; i < pairs.length; i++) for (let j = i + 1; j < pairs.length; j++) {
      const b = pairs[i][key].map((v, k) => v - a[k]), c = pairs[j][key].map((v, k) => v - a[k]);
      const cross = [b[1] * c[2] - b[2] * c[1], b[2] * c[0] - b[0] * c[2], b[0] * c[1] - b[1] * c[0]];
      if (Math.hypot(...b) > 1e-6 && Math.hypot(...c) > 1e-6 && Math.hypot(...cross) / (Math.hypot(...b) * Math.hypot(...c)) > 1e-4) return true;
    }
    return false;
  });
}

function SliceCanvas({ volume, spec, overlays, measurement, measuring, onPick }: {
  volume: TomographyVolume; spec: TomographyViewSpec; overlays: TomographyOverlayOptions;
  measurement: TomographyMeasurement | null; measuring: boolean;
  onPick: (point: Vec3, spec: TomographyViewSpec) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null), [error, setError] = useState('');
  const [renderedKey, setRenderedKey] = useState('');
  const key = JSON.stringify([volume.id, spec, overlays.mmPerUnit, overlays.registrations, overlays.assemblyRegistration, overlays.scans, overlays.restorations, measurement]);
  useEffect(() => {
    const controller = new AbortController();
    // Debounce input bursts and cancel superseded work before it starts.
    const timer = window.setTimeout(() => {
      if (!canvasRef.current) return;
      try {
        renderTomographyView(volume, spec, { canvas: canvasRef.current, width: 384, height: 384, overlays, measurement, signal: controller.signal });
        setError(''); setRenderedKey(key);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Slice rendering failed.');
      }
    }, 40);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [volume, spec, overlays, measurement, key]);
  return <div className="tomography-slice-stage" aria-busy={renderedKey !== key && !error}>
    <canvas ref={canvasRef} width={384} height={384} role="img" tabIndex={0}
      aria-label={`${spec.plane} LPS slice. ${measuring ? 'Click two points for a manual distance.' : 'Click to move the shared crosshair.'} Arrow keys move the crosshair by one displayed pixel.`}
      onClick={event => {
        if (renderedKey !== key || error) return;
        const canvas = event.currentTarget, bounds = canvas.getBoundingClientRect();
        const point = pixelToPatient(getSliceFrame(spec), (event.clientX - bounds.left) / bounds.width * canvas.width - .5,
          (event.clientY - bounds.top) / bounds.height * canvas.height - .5, canvas.width, canvas.height);
        onPick(point, spec);
      }}
      onKeyDown={event => {
        if (renderedKey !== key || error) return;
        const move: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
        const offset = move[event.key];
        if (!offset) return;
        event.preventDefault();
        const canvas = event.currentTarget;
        onPick(pixelToPatient(getSliceFrame(spec), (canvas.width - 1) / 2 + offset[0] * (event.shiftKey ? 10 : 1),
          (canvas.height - 1) / 2 + offset[1] * (event.shiftKey ? 10 : 1), canvas.width, canvas.height), spec);
      }} />
    {error ? <p className="tomography-slice-error" role="alert">{error}</p> : renderedKey !== key && <span className="tomography-rendering" role="status">Preparing slice…</span>}
  </div>;
}

function LoadedTomography(props: TomographyPanelProps & { volume: TomographyVolume }) {
  const { volume } = props, [center, setCenter] = useState<Vec3>(() => volumeCenter(volume));
  const bounds = useMemo(() => patientBounds(volume), [volume]);
  const initialSpan = Math.max(...bounds[1].map((max, i) => max - bounds[0][i]), Math.max(...volume.spacing)) * 1.05;
  const initialWindow = useMemo(() => initialTomographyWindow(volume), [volume]);
  const [span, setSpan] = useState(initialSpan), [windowCenter, setWindowCenter] = useState(initialWindow.windowCenter);
  const [windowWidth, setWindowWidth] = useState(initialWindow.windowWidth);
  const [oblique, setOblique] = useState(false), [yaw, setYaw] = useState(0), [pitch, setPitch] = useState(0);
  const [scans, setScans] = useState(true), [restorations, setRestorations] = useState(true);
  const [measuring, setMeasuring] = useState(false), [measurement, setMeasurement] = useState<MeasurementState | null>(null);
  const [pairs, setPairs] = useState<Record<Arch, TomographyLandmarkPair[]>>({ upper: [], lower: [] });
  const [arch, setArch] = useState<Arch>('upper'), [notice, setNotice] = useState('');
  const registrations = props.registrations ?? EMPTY_REGISTRATIONS;
  const sourceSnapshots = useMemo(() => ARCHES.map(a => ({ arch: a, scale: props.mmPerUnit, sources: props.parts
    .filter(part => part.role === a && !part.reference && !part.restoration)
    .map(part => ({ id: part.id, positions: part.positions, matrix: partMatrix(part).toArray().join(',') })) })), [props.parts, props.mmPerUnit]);
  const previousSources = useRef(sourceSnapshots);
  useEffect(() => {
    const stale = sourceSnapshots.filter((snapshot, i) => {
      const old = previousSources.current[i];
      return old.scale !== snapshot.scale || old.sources.length !== snapshot.sources.length || snapshot.sources.some((part, index) => {
        const before = old.sources[index];
        return !before || before.id !== part.id || before.positions !== part.positions || before.matrix !== part.matrix;
      });
    }).map(snapshot => snapshot.arch);
    previousSources.current = sourceSnapshots;
    if (stale.length) {
      setPairs(previous => ({ upper: stale.includes('upper') ? [] : previous.upper, lower: stale.includes('lower') ? [] : previous.lower }));
      setNotice('Captured landmarks were cleared because the scan source, pose, or scale changed. Pick fresh 3D landmarks.');
    }
  }, [sourceSnapshots]);
  const scaleKnown = props.mmPerUnit !== null && Number.isFinite(props.mmPerUnit) && props.mmPerUnit > 0;
  const quantitative = volume.complete && volume.quantitativeMeasurementsAllowed !== false;
  const specs = useMemo(() => {
    const common = { center, widthMm: span, heightMm: span, windowCenter, windowWidth };
    const result: TomographyViewSpec[] = (['axial', 'coronal', 'sagittal'] as const).map(plane => ({ ...common, plane }));
    if (oblique) {
      const y = yaw * Math.PI / 180, p = pitch * Math.PI / 180;
      // Rotation about LPS S (yaw), then about the rotated right axis (pitch).
      const normal: Vec3 = [Math.sin(y) * Math.cos(p), -Math.cos(y) * Math.cos(p), Math.sin(p)];
      const up: Vec3 = [-Math.sin(y) * Math.sin(p), Math.cos(y) * Math.sin(p), Math.cos(p)];
      result.push({ ...common, plane: 'oblique', normal, up });
    }
    return result;
  }, [center, span, windowCenter, windowWidth, oblique, yaw, pitch]);
  const onViewsChangeRef = useRef(props.onViewsChange);
  onViewsChangeRef.current = props.onViewsChange;
  useEffect(() => { onViewsChangeRef.current?.(specs.map(spec => ({ ...spec, center: [...spec.center] }))); }, [specs]);
  const overlays = useMemo<TomographyOverlayOptions>(() => ({ parts: props.parts, mmPerUnit: props.mmPerUnit,
    registrations, scans, restorations, assemblyRegistration: props.assemblyRegistration, previewScans: true, excludedPartIds: props.parts.filter(p => p.reference === 'tomography').map(p => p.id) }),
  [props.parts, props.mmPerUnit, registrations, props.assemblyRegistration, scans, restorations]);
  const probePart = props.parts.find(part => part.id === props.selectedProbe?.id);
  const probeValid = !!props.selectedProbe && probePart?.role === arch && !probePart.restoration && !probePart.reference;
  const crosshairValid = Number.isFinite(sampleVolume(volume, center));
  const selectedRegistration = registrations.find(item => item.arch === arch);
  const distance = measurement?.b && quantitative ? Math.hypot(...measurement.a.map((v, i) => v - measurement.b![i])) : null;
  const focusOptions = useMemo(() => props.parts.filter(part => part.restoration?.component === 'fixture'), [props.parts]);
  const busy = props.loading || props.surfaceBusy || props.alignmentBusy;
  function pick(point: Vec3, spec: TomographyViewSpec) {
    if (!Number.isFinite(sampleVolume(volume, point))) { setNotice('That point has no source voxel data. Choose a point inside a readable slice.'); return; }
    setNotice('');
    if (measuring && quantitative) {
      const normal = getSliceFrame(spec).normal;
      if (!measurement || measurement.b || measurement.plane !== spec.plane || normal.some((v, i) => Math.abs(v - measurement.normal[i]) > 1e-6)) {
        setMeasurement({ plane: spec.plane, normal, a: point });
      } else setMeasurement({ ...measurement, b: point });
    } else { setCenter(point); setMeasurement(null); }
  }
  function focus(partId: string) {
    const fixture = props.parts.find(part => part.id === partId), parent = props.parts.find(part => part.id === fixture?.restoration?.parentPartId);
    if (!fixture?.restoration || !scaleKnown || !registrations.some(record => record.arch === parent?.role && record.reviewed)) return;
    const components = props.parts.filter(part => part.restoration?.assemblyId === fixture.restoration!.assemblyId);
    const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const part of components) {
      const positions = transformPartToPatient(part, props.mmPerUnit!);
      for (let i = 0; i < positions.length; i += 3) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], positions[i + a]); max[a] = Math.max(max[a], positions[i + a]); }
    }
    const point = min.map((v, i) => (v + max[i]) / 2) as Vec3;
    if (!point.every(Number.isFinite)) return;
    setCenter(point); setSpan(Math.max(20, ...max.map((v, i) => (v - min[i]) * 2))); setMeasurement(null);
    setNotice('Crosshair centered on the posed restoration assembly bounds.');
  }
  return <>
    <div className="tomography-volume-summary"><strong>{volume.complete ? 'Local volume' : 'Incomplete local preview'}</strong>
      <span>{volume.dimensions.join(' × ')} voxels · spacing {volume.spacing.map(v => v.toFixed(3)).join(' × ')} mm</span>
    </div>
    {!volume.complete && <p className="tomography-warning">Missing source slices: {volume.missingSlices.length}. Blue checkerboard marks unavailable data. Quantitative measurements are disabled. Preview alignment only; incomplete data remains nonquantitative.</p>}
    {volume.warnings.length > 0 && <details className="tomography-warnings"><summary>Import limits ({volume.warnings.length})</summary><ul>{volume.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
    <div className="tomography-controls">
      <fieldset><legend>Grayscale & slices</legend>
        <div className="tomography-fields">
          <label>Window center<input type="number" step="any" value={windowCenter} onChange={event => { const v = event.currentTarget.valueAsNumber; if (Number.isFinite(v)) setWindowCenter(v); }} /></label>
          <label>Window width<input type="number" min="0.001" step="any" value={windowWidth} onChange={event => { const v = event.currentTarget.valueAsNumber; if (Number.isFinite(v) && v > 0) setWindowWidth(v); }} /></label>
          <label>View span (mm)<input type="number" min="0.1" step="any" value={Number(span.toFixed(3))} onChange={event => { const v = event.currentTarget.valueAsNumber; if (Number.isFinite(v) && v > 0) setSpan(v); }} /></label>
        </div>
        <p>Window and threshold use rescaled grayscale intensities. HU is not assumed. Initial contrast uses {initialWindow.method === 'sampled-1-99-percentiles' ? 'sampled 1st–99th percentiles' : 'the volume range'} for presentation only.</p>
        <label className="tomography-check"><input type="checkbox" checked={oblique} onChange={event => setOblique(event.currentTarget.checked)} />Additional oblique LPS plane</label>
        {oblique && <div className="tomography-fields">
          <label>Oblique yaw (°)<input type="range" min="-180" max="180" value={yaw} onChange={event => { setYaw(Number(event.currentTarget.value)); setMeasurement(null); }} /><output>{yaw}°</output></label>
          <label>Oblique pitch (°)<input type="range" min="-89" max="89" value={pitch} onChange={event => { setPitch(Number(event.currentTarget.value)); setMeasurement(null); }} /><output>{pitch}°</output></label>
        </div>}
        <p>Views are anatomical LPS reslices, independent of the acquisition stack. Oblique views are labeled by their actual direction vectors.</p>
      </fieldset>
      <fieldset><legend>3D skull reference</legend>
        <label>Threshold (grayscale intensity)<input type="number" step="any" value={props.threshold} disabled={props.loading} onChange={event => { const v = event.currentTarget.valueAsNumber; if (Number.isFinite(v)) props.onThreshold(v); }} /></label>
        <label>Preview stride<select value={props.stride} disabled={props.loading} onChange={event => props.onStride(Number(event.currentTarget.value))}>{[1, 2, 3, 4, 6, 8].map(value => <option value={value} key={value}>{value} voxel{value > 1 ? 's' : ''}</option>)}</select></label>
        <p>Requested grid spacing: {volume.spacing.map(value => (value * props.stride).toFixed(3)).join(' × ')} mm. This threshold surface is a visual reference, not bone segmentation.</p>
        {props.surface && <p>Displayed surface: threshold {props.surface.threshold}, stride {props.surface.stride}, spacing {props.surface.effectiveSpacing.map(value => value.toFixed(3)).join(' × ')} mm · {props.surface.triangles.toLocaleString()} triangles.</p>}
        <label className="tomography-check"><input type="checkbox" checked={props.referenceVisible} onChange={event => props.onReferenceVisible(event.currentTarget.checked)} />Show skull reference in 3D</label>
        <label>Reference opacity<input type="range" min="0.05" max="1" step="0.05" value={props.referenceOpacity} onChange={event => props.onReferenceOpacity(Number(event.currentTarget.value))} /><output>{Math.round(props.referenceOpacity * 100)}%</output></label>
      </fieldset>
      <fieldset><legend>Posed mesh contours</legend>
        <label>Millimeters per mesh file unit<input type="number" min="0" step="any" value={props.mmPerUnit ?? ''} placeholder="Explicit scale required" onChange={event => { const v = event.currentTarget.valueAsNumber; props.onMmPerUnit(Number.isFinite(v) && v > 0 ? v : null); setMeasurement(null); }} /></label>
        <label className="tomography-check"><input type="checkbox" checked={restorations} disabled={!scaleKnown || !registrations.some(r => r.reviewed)} onChange={event => setRestorations(event.currentTarget.checked)} />Restoration contours</label>
        <label className="tomography-check"><input type="checkbox" checked={scans} disabled={!scaleKnown || (!registrations.length && !props.assemblyRegistration)} onChange={event => setScans(event.currentTarget.checked)} />Scan contours · amber while review is pending</label>
        <div className="tomography-legend"><span className="tomography-fixture">Fixture</span><span className="tomography-abutment">Pilar</span><span className="tomography-crown">Crown</span></div>
        <p>Solid lines intersect the plane using the current 3D pose and explicit scale. Amber scan contours preview an unreviewed alignment. Restoration contours require reviewed registration. Bite and CBCT reference meshes are excluded.</p>
        {focusOptions.length > 0 && <label>Focus restoration<select defaultValue="" disabled={!scaleKnown || !registrations.some(r => r.reviewed)} onChange={event => { focus(event.currentTarget.value); event.currentTarget.value = ''; }}>
          <option value="">Choose an assembly…</option>{focusOptions.map(part => {
            const parent = props.parts.find(p => p.id === part.restoration?.parentPartId);
            return <option key={part.id} value={part.id} disabled={!registrations.some(r => r.arch === parent?.role && r.reviewed)}>{part.name}</option>;
          })}</select></label>}
      </fieldset>
    </div>
    <div className="tomography-crosshair-controls">
      <strong>Crosshair · LPS mm</strong>
      {(['L', 'P', 'S'] as const).map((label, axis) => <label key={label}>{label}<input aria-label={`Crosshair ${label} (mm)`} type="number" step="0.1" value={Number(center[axis].toFixed(3))} onChange={event => {
        const v = event.currentTarget.valueAsNumber; if (Number.isFinite(v)) { setCenter(previous => previous.map((p, i) => i === axis ? v : p) as Vec3); setMeasurement(null); }
      }} /></label>)}
      <button type="button" onClick={() => { setCenter(volumeCenter(volume)); setSpan(initialSpan); setMeasurement(null); }}>Reset crosshair & zoom</button>
    </div>
    <div className="tomography-measure-toolbar">
      <button type="button" aria-pressed={!measuring} onClick={() => setMeasuring(false)}>Move crosshair</button>
      <button type="button" aria-pressed={measuring} disabled={!quantitative} onClick={() => { setMeasuring(true); setMeasurement(null); }}>Measure manual distance</button>
      {measurement && <button type="button" onClick={() => setMeasurement(null)}>Clear measurement</button>}
      <span>{distance !== null ? `Manual distance ${distance.toFixed(2)} mm` : measuring ? 'Pick two points in one plane.' : 'Click any slice to position all planes.'}</span>
    </div>
    {measuring && <p className="tomography-note">Calibrated manual picked-point distance in mm. This does not estimate bone depth, bone quality, nerve clearance, or clinical safety.</p>}
    <div className="tomography-slices">{specs.map(spec => {
      const axis = spec.plane === 'axial' ? 2 : spec.plane === 'coronal' ? 1 : 0;
      const planeMeasurement = measurement?.plane === spec.plane && measurement.b ? { a: measurement.a, b: measurement.b } : null;
      return <section className={`tomography-slice tomography-slice--${spec.plane}`} aria-label={`${spec.plane} slice`} key={spec.plane}>
        <h3>{spec.plane[0].toUpperCase() + spec.plane.slice(1)} <small>LPS{spec.plane === 'oblique' ? ` · yaw ${yaw}° / pitch ${pitch}°` : ''}</small></h3>
        <SliceCanvas volume={volume} spec={spec} overlays={overlays} measurement={planeMeasurement} measuring={measuring} onPick={pick} />
        {spec.plane !== 'oblique' ? <label className="tomography-slice-position">{['L', 'P', 'S'][axis]} {center[axis].toFixed(2)} mm<input type="range"
          aria-label={`${spec.plane} LPS position (mm)`} min={bounds[0][axis]} max={bounds[1][axis]} step={Math.min(...volume.spacing) / 2}
          value={clamp(center[axis], bounds[0][axis], bounds[1][axis])} onChange={event => { const v = Number(event.currentTarget.value); setCenter(previous => previous.map((p, i) => i === axis ? v : p) as Vec3); setMeasurement(null); }} /></label>
          : <p className="tomography-slice-position">Centered at shared crosshair · true plane, no slab projection</p>}
      </section>;
    })}</div>
    <details className="tomography-registration"><summary>Register scan landmarks to CBCT</summary>
      <p>Pick the same shared tooth landmark in the 3D scan and at the slice crosshair. Capture at least three distinct, noncollinear pairs per arch, fit, then review the alignment before enabling restoration contours.</p>
      <div className="tomography-registration-bar"><label>Arch<select value={arch} onChange={event => setArch(event.currentTarget.value as Arch)}>{ARCHES.map(a => <option key={a} value={a}>{a === 'upper' ? 'Upper' : 'Lower'}</option>)}</select></label>
        <button type="button" disabled={busy || !scaleKnown || !probeValid || !crosshairValid || !props.onRegister || pairs[arch].length >= 32} onClick={() => {
          if (!props.selectedProbe || !probeValid || !crosshairValid) return;
          const pair = { source: [...props.selectedProbe.position] as Vec3, target: [...center] as Vec3 };
          if (pairs[arch].some(item => Math.hypot(...item.source.map((v, i) => v - pair.source[i])) < 1e-6 || Math.hypot(...item.target.map((v, i) => v - pair.target[i])) < 1e-6)) {
            setNotice('Choose a distinct source and target landmark for each pair.'); return;
          }
          setPairs(previous => ({ ...previous, [arch]: [...previous[arch], pair] })); setNotice('');
          props.onReviewRegistration?.(arch, false);
        }}>Capture 3D probe → crosshair pair</button>
      </div>
      <p>3D source: {probeValid && props.selectedProbe ? `${formatPoint(props.selectedProbe.position)} file units` : `Select a ${arch} scan point in the 3D viewer.`}<br />CBCT target: {formatPoint(center)} LPS mm{!crosshairValid ? ' · unavailable source data' : ''}</p>
      {pairs[arch].length > 0 && <div className="tomography-pairs"><table><thead><tr><th>Pair</th><th>Source (file units)</th><th>Target (LPS mm)</th><th><span className="tomography-sr-only">Action</span></th></tr></thead><tbody>{pairs[arch].map((pair, index) => <tr key={index}>
        <td>{index + 1}</td><td>{formatPoint(pair.source)}</td><td>{formatPoint(pair.target)}</td><td><button type="button" disabled={busy} aria-label={`Remove landmark pair ${index + 1}`} onClick={() => { setPairs(previous => ({ ...previous, [arch]: previous[arch].filter((_, i) => i !== index) })); props.onReviewRegistration?.(arch, false); }}>Remove</button></td>
      </tr>)}</tbody></table></div>}
      <div className="tomography-registration-bar">
        <button type="button" disabled={busy || !scaleKnown || !usablePairs(pairs[arch]) || !props.onRegister} onClick={() => {
          const success = props.onRegister?.(arch, pairs[arch].map(pair => ({ source: [...pair.source], target: [...pair.target] })));
          if (success === true) setPairs(previous => ({ ...previous, [arch]: [] }));
        }}>Fit {arch} {volume.complete ? 'rigid registration' : 'visual preview alignment'}</button>
        <button type="button" disabled={busy || !props.onResetRegistration} onClick={() => { props.onResetRegistration?.(arch); setPairs(previous => ({ ...previous, [arch]: [] })); }}>{selectedRegistration?.method === 'surface' ? 'Reset whole alignment' : `Reset ${arch} registration`}</button>
        {selectedRegistration && <span>{selectedRegistration.method === 'surface' ? 'Assembly sampled surface' : 'Landmark fit'} RMS: {selectedRegistration.rmsMm.toFixed(3)} mm{!volume.complete ? ' · preview alignment only' : ''}</span>}
      </div>
      {pairs[arch].length >= 3 && !usablePairs(pairs[arch]) && <p className="tomography-warning">Landmarks must be noncollinear in both scans and CBCT.</p>}
      <div className="tomography-registration-reviews">{ARCHES.map(a => {
        const registration = registrations.find(record => record.arch === a);
        return <label className="tomography-check" key={a}><input type="checkbox" checked={registration?.reviewed ?? false} disabled={busy || !scaleKnown || !registration || !Number.isFinite(registration.rmsMm) || !props.onReviewRegistration}
          onChange={event => props.onReviewRegistration?.(a, event.currentTarget.checked)} />{a === 'upper' ? 'Upper' : 'Lower'} {volume.complete ? 'registration reviewed' : 'VISUAL preview alignment reviewed'}{registration ? ` · ${registration.method === 'surface' ? 'assembly sampled surface' : 'landmark fit'} RMS ${registration.rmsMm.toFixed(3)} mm` : ' · not fitted'}</label>;
      })}</div>
      <p>RMS describes the fitted landmarks or sampled surfaces, not alignment accuracy everywhere. Changing mesh pose, scale, or landmarks requires a new review.</p>
    </details>
    {notice && <p className="tomography-notice" role="status">{notice}</p>}
  </>;
}

/** Independent local-only panel; loading, surface extraction and registration belong to the parent. */
export function TomographyPanel(props: TomographyPanelProps) {
  const id = useId(), [allowIncompletePreview, setAllowIncompletePreview] = useState(false);
  const filesRef = useRef<HTMLInputElement>(null), folderRef = useRef<HTMLInputElement>(null);
  const busy = props.loading || props.surfaceBusy || props.alignmentBusy;
  const previousVolume = useRef(props.volume);
  const viewsCallback = useRef(props.onViewsChange); viewsCallback.current = props.onViewsChange;
  useEffect(() => { if (!props.volume && previousVolume.current) viewsCallback.current?.([]); previousVolume.current = props.volume; }, [props.volume]);
  function importFiles(input: HTMLInputElement) {
    const files = Array.from(input.files ?? []); if (files.length) props.onImport(files, allowIncompletePreview); input.value = '';
  }
  return <section className="tomography-panel" aria-labelledby={`${id}-heading`} aria-busy={busy}>
    <div className="tomography-header"><div><h2 id={`${id}-heading`}>Local CBCT tomography</h2><p>Skull reference, calibrated slices & posed restoration contours</p></div>
      <div className="tomography-import-actions">
        <button type="button" disabled={busy} onClick={() => filesRef.current?.click()}>Import DICOM files</button>
        <button type="button" disabled={busy} onClick={() => folderRef.current?.click()}>Import folder</button>
        {busy && <button type="button" onClick={props.onCancel}>Cancel</button>}
        {Boolean(props.volume || props.error || props.seriesChoices?.length) && <button type="button" onClick={props.onClear}>Clear tomography</button>}
      </div>
    </div>
    <input ref={filesRef} type="file" multiple hidden aria-label="Local DICOM files" onChange={event => importFiles(event.currentTarget)} />
    <input ref={folderRef} type="file" multiple hidden aria-label="Local DICOM folder" {...{ webkitdirectory: '', directory: '' }} onChange={event => importFiles(event.currentTarget)} />
    <label className="tomography-check tomography-preview-option"><input type="checkbox" disabled={busy} checked={allowIncompletePreview} onChange={event => setAllowIncompletePreview(event.currentTarget.checked)} />Allow incomplete preview (gaps stay unavailable; quantitative measurements disabled)</label>
    {props.status && <p className="tomography-status" role="status">{props.status}{props.surfaceBusy ? ' · Building threshold surface…' : ''}</p>}
    {props.error && <p className="tomography-error" role="alert">{props.error}</p>}
    {(props.seriesChoices?.length ?? 0) > 1 && <label className="tomography-series-select">Choose a local series<select defaultValue="" disabled={busy || !props.onSelectSeries} onChange={event => { if (event.currentTarget.value) props.onSelectSeries?.(event.currentTarget.value); }}>
      <option value="">Select series…</option>{props.seriesChoices!.map(series => <option key={series.id} value={series.id}>{series.label} · {series.slices} slices · {series.dimensions.join(' × ')}</option>)}
    </select></label>}
    {props.volume ? <LoadedTomography key={props.volume.id} {...props} volume={props.volume} /> : <div className="tomography-empty">
      <strong>{props.loading ? 'Reading local tomography…' : 'No tomography loaded'}</strong>
      <p>Import a local DICOM series or folder to inspect the skull and axial, coronal, sagittal, or oblique slices. Nothing loads automatically.</p>
    </div>}
  </section>;
}
