import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MeshViewer, type NavigationMode, type Probe, type View, type ViewerCapture } from './viewer';
import type { ModelPart } from './models';
import type { CollisionReport } from './collision';
import type { ToothEditEvent, ToothViewState } from './tooth-types';
import { placeFloatingControls, type ScreenBounds } from './viewport-projection';
import { emptyRuler } from './measurement';
import { RulerOverlay, RulerReadout } from './Ruler';
import './viewport-floating.css';

export type ViewerActions = Pick<MeshViewer, 'setView' | 'zoom' | 'fit' | 'focusSelected' | 'setNavigationMode'>;

interface Props {
  parts: ModelPart[];
  mmPerUnit?: number | null;
  compact?: boolean;
  referenceParts?: ModelPart[];
  framingRevision?: number;
  onCaptureReady?: (capture: (() => ViewerCapture) | null) => void;
  onMeasurement?: (distance: number | null, partIds: string[]) => void;
  measurementDisabled?: boolean;
  onViewerReady?: (actions: ViewerActions | null) => void;
  onNavigationModeChange?: (mode: NavigationMode) => void;
  upAxis?: 'y' | 'z';
  onUpAxisChange?: (axis: 'y' | 'z') => void;
  showAnnotations?: boolean;
  onShowAnnotationsChange?: (value: boolean) => void;
  expanded?: boolean;
  onExpandedChange?: (value: boolean) => void;
  dock?: ReactNode;
  report: CollisionReport | null;
  tolerance: number;
  selected: string | null;
  heatmap: boolean;
  wireframe: boolean;
  opacities: Readonly<Record<string, number>>;
  onProbe: (probe: Probe) => void;
  onImport: () => void;
  toothView?: ToothViewState;
  onToothEdit?: (event: ToothEditEvent) => void;
  onExitToothTool?: () => void;
  visibilityControls?: ReactNode;
  floatingControls?: { partIds: string[]; content: ReactNode | ((exitExpanded: () => void) => ReactNode) };
}

export function Viewport({ compact = false, parts, mmPerUnit = null, referenceParts, framingRevision = 0, onCaptureReady, onMeasurement, measurementDisabled = false, onViewerReady, onNavigationModeChange, upAxis: upAxisProp, onUpAxisChange, showAnnotations: showAnnotationsProp, onShowAnnotationsChange, expanded: expandedProp, onExpandedChange, dock, report, tolerance, selected, heatmap, wireframe, opacities, onProbe, onImport, toothView, onToothEdit, onExitToothTool, visibilityControls, floatingControls }: Props) {
  const displayedParts = useMemo(() => referenceParts?.length ? [...parts, ...referenceParts] : parts, [parts, referenceParts]);
  const host = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const footer = useRef<HTMLDivElement>(null);
  const bottomControls = useRef<HTMLDivElement>(null);
  const floating = useRef<HTMLDivElement>(null);
  const viewer = useRef<MeshViewer | null>(null);
  const callback = useRef(onProbe);
  callback.current = onProbe;
  const toothCallback = useRef(onToothEdit);
  toothCallback.current = onToothEdit;
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [ready, setReady] = useState(false);
  const [navigationModeState, setNavigationModeState] = useState<NavigationMode>('orbit');
  const navigationModeCallback = useRef(onNavigationModeChange);
  navigationModeCallback.current = onNavigationModeChange;
  const setNavigationMode = (mode: NavigationMode) => {
    setNavigationModeState(mode);
    navigationModeCallback.current?.(mode);
  };
  const navigationMode = navigationModeState;
  // Presentation controls are liftable: hosts that omit them (the patient
  // portal) keep the viewport's own local state instead.
  const [upAxisState, setUpAxisState] = useState<'y' | 'z'>('z');
  const [expandedState, setExpandedState] = useState(false);
  const [annotationsState, setAnnotationsState] = useState(true);
  const upAxis = upAxisProp ?? upAxisState;
  const expanded = expandedProp ?? expandedState;
  const showAnnotations = showAnnotationsProp ?? annotationsState;
  const changeUpAxis = onUpAxisChange ?? setUpAxisState;
  const changeExpanded = onExpandedChange ?? setExpandedState;
  const changeShowAnnotations = onShowAnnotationsChange ?? setAnnotationsState;
  const [ruler, setRuler] = useState(emptyRuler);
  const measurementCallback = useRef(onMeasurement); measurementCallback.current = onMeasurement;
  const measurementKey = JSON.stringify([ruler.distance, ruler.points.map(point => [point.partId, point.face, point.position])]);
  useEffect(() => { measurementCallback.current?.(measurementDisabled ? null : ruler.distance, measurementDisabled ? [] : ruler.points.map(point => point.partId)); }, [measurementKey, measurementDisabled]);
  const showRuler = !measurementDisabled && (ruler.enabled || ruler.points.length > 0 || ruler.cleared);
  // Inspection appearance is local presentation state. Editing always restores
  // its labels/patches; hiding them never changes collision evidence or geometry.
  const editing = !!toothView?.enabled && toothView.tool !== 'inspect';
  const displayedToothView = useMemo(() => !showAnnotations && !editing && toothView
    ? { ...toothView, enabled: false, isolate: false } : toothView, [toothView, showAnnotations, editing]);

  useEffect(() => {
    if (!expanded) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') changeExpanded(false); };
    window.addEventListener('keydown', close);
    return () => { document.body.style.overflow = previous; window.removeEventListener('keydown', close); };
  }, [expanded, changeExpanded]);

  useEffect(() => {
    setError(''); setReady(false); setRuler(emptyRuler);
    try {
      viewer.current = new MeshViewer(host.current!, probe => callback.current(probe), setError, setNavigationMode, event => toothCallback.current?.(event), setRuler);
      setReady(true);
    } catch { setError('3D rendering is unavailable. Enable WebGL in your browser, then restart the view.'); }
    return () => { viewer.current?.dispose(); viewer.current = null; };
  }, [attempt]);
  useEffect(() => { if (ready) viewer.current?.setOpacities(opacities); }, [opacities, ready, attempt]);
  useEffect(() => { if (ready) viewer.current?.setParts(displayedParts); }, [displayedParts, ready, attempt]);
  useEffect(() => {
    if (!ready || !measurementDisabled) return;
    viewer.current?.setRulerEnabled(false);
    viewer.current?.clearMeasurement();
  }, [measurementDisabled, ready, attempt]);
  useEffect(() => {
    onCaptureReady?.(ready && !error ? () => { if (!viewer.current) throw new Error('The 3D view is unavailable.'); return viewer.current.capture(); } : null);
    return () => onCaptureReady?.(null);
  }, [ready, error, attempt, onCaptureReady]);
  useEffect(() => {
    onViewerReady?.(ready && !error && viewer.current ? {
      setView: view => { viewer.current?.setView(view); },
      zoom: direction => { viewer.current?.zoom(direction); },
      fit: () => { viewer.current?.fit(); },
      focusSelected: () => { viewer.current?.focusSelected(); },
      setNavigationMode: mode => { viewer.current?.setNavigationMode(mode); },
    } : null);
    return () => onViewerReady?.(null);
  }, [ready, error, attempt, onViewerReady]);
  useEffect(() => { if (ready) viewer.current?.setAnalysis(report, tolerance); }, [report, tolerance, ready, attempt]);
  useEffect(() => { if (ready) viewer.current?.setAppearance(heatmap, wireframe, selected); }, [heatmap, wireframe, selected, ready, displayedParts, attempt]);
  useEffect(() => { if (ready) viewer.current?.setToothView(displayedToothView ?? null); }, [displayedToothView, ready, parts, attempt]);
  useEffect(() => { if (ready && framingRevision > 0) viewer.current?.fit(); }, [framingRevision, ready, attempt]);

  useEffect(() => { if (ready) viewer.current?.setUpAxis(upAxis); }, [upAxis, ready, attempt]);

  const floatingPartIds = floatingControls ? JSON.stringify(floatingControls.partIds) : null;
  useEffect(() => {
    const meshViewer = viewer.current, element = floating.current, canvasHost = host.current;
    if (!ready || error || !meshViewer || !element || !canvasHost || floatingPartIds === null) return;
    let target: ScreenBounds | null = null;
    let available: ScreenBounds = { left: 12, top: 12, right: 12, bottom: 12 };
    let width = 0, height = 0;
    const place = () => {
      const { x, y } = placeFloatingControls(target, available, width, height);
      const transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      if (element.style.transform !== transform) element.style.transform = transform;
      element.dataset.anchor = target ? 'mesh' : 'corner';
    };
    // Measure only when layout changes. Orbit/pan/zoom callbacks only write the transform.
    // Toolbar children matter: mobile CSS can stretch the toolbar itself over the canvas.
    const topElements = [...toolbar.current?.children ?? [], ...toolbar.current?.querySelectorAll('.camera-tools') ?? []];
    const bottomElements = [...bottomControls.current?.children ?? [], ...(footer.current ? [footer.current] : [])];
    const rects = (elements: Element[]) => elements.filter(item => {
      const closed = item.closest('details:not([open])');
      return !closed || item === closed || item.tagName === 'SUMMARY';
    }).map(item => item.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0);
    const measure = () => {
      const viewport = canvasHost.getBoundingClientRect();
      const top = Math.max(12, ...rects(topElements).map(rect => rect.bottom - viewport.top + 10));
      const bottom = Math.min(viewport.height - 12, ...rects(bottomElements).map(rect => rect.top - viewport.top - 10));
      available = {
        left: Math.min(12, viewport.width), right: Math.max(12, viewport.width - 12),
        top: Math.max(0, Math.min(viewport.height - 12, top)), bottom: Math.max(0, bottom),
      };
      available.bottom = Math.max(available.top, available.bottom);
      const maxHeight = `${Math.floor(available.bottom - available.top)}px`;
      if (element.style.getPropertyValue('--viewport-floating-max-height') !== maxHeight) element.style.setProperty('--viewport-floating-max-height', maxHeight);
      const size = element.getBoundingClientRect();
      width = size.width; height = size.height;
      place();
    };
    const observer = new ResizeObserver(measure);
    for (const item of new Set([canvasHost, element, ...topElements, ...bottomElements])) observer.observe(item);
    toolbar.current?.addEventListener('toggle', measure, true);
    const currentToolbar = toolbar.current;
    measure();
    meshViewer.setProjectionTarget(JSON.parse(floatingPartIds) as string[], bounds => { target = bounds; place(); });
    return () => {
      observer.disconnect();
      currentToolbar?.removeEventListener('toggle', measure, true);
      meshViewer.setProjectionTarget([], null);
    };
  }, [floatingPartIds, ready, error, attempt, compact, visibilityControls, showRuler]);

  const sceneParts = displayedParts.filter(part => part.role !== 'bite');
  const hasVisibleParts = sceneParts.some(part => part.visible && (opacities[part.id] ?? 1) > 0);
  const hasMeasurableParts = sceneParts.some(part => !part.reference && part.visible && (opacities[part.id] ?? 1) > 0);
  const strokeTool = toothView && ['paint', 'erase', 'exclude'].includes(toothView.tool);
  const hasIsolatedFaces = !displayedToothView?.isolate || parts.some(part => part.visible && (part.role === 'upper' || part.role === 'lower') && (opacities[part.id] ?? 1) > 0 && (displayedToothView.labels[part.id]?.includes(displayedToothView.activeTooth) || (displayedToothView.draft?.partId === part.id && displayedToothView.draft.faces.length > 0)));
  const selectedPart = parts.find(part => part.id === selected);
  const canFocus = displayedToothView?.isolate ? hasIsolatedFaces : !!selectedPart?.visible && (opacities[selectedPart.id] ?? (selectedPart.role === 'bite' ? 0.35 : 1)) > 0;
  const cameraDisabled = !ready || !hasVisibleParts || !!error;
  const cameraAction = (action: (meshViewer: MeshViewer) => void) => {
    if (viewer.current) action(viewer.current);
    host.current?.querySelector('canvas')?.focus({ preventScroll: true });
  };
  const startRuler = () => {
    if (measurementDisabled) return;
    if (editing) onExitToothTool?.();
    cameraAction(meshViewer => meshViewer.setRulerEnabled(true));
  };
  const rulerButton = <button className="ruler-button" disabled={measurementDisabled || !ready || !!error || (!ruler.enabled && (!hasMeasurableParts || !hasIsolatedFaces || (editing && !onExitToothTool)))} aria-pressed={ruler.enabled}
    onClick={() => ruler.enabled ? cameraAction(meshViewer => meshViewer.setRulerEnabled(false)) : startRuler()}
    title={measurementDisabled ? 'Return jaw opening to zero to measure the recorded pose' : 'Click two surface points to measure their straight-line 3D distance using the current scan scale'}>{ruler.enabled ? 'Done measuring' : 'Measure'}</button>;

  // View presets stay visible at the viewport's top-left; everything else
  // lives in the dock (compact mode) or the full camera toolbar (standalone).
  const presetButtons = (
    <div className="view-buttons camera-views" role="group" aria-label="Camera views">
      {(['perspective', 'front', 'top', 'right'] as View[]).map(view => <button key={view} disabled={cameraDisabled} onClick={() => cameraAction(meshViewer => meshViewer.setView(view))}>{view === 'perspective' ? '3D' : view[0].toUpperCase() + view.slice(1)}</button>)}
    </div>
  );

  const cameraTools = (
      <div className="camera-tools">
        {!compact && <div className="view-buttons">{rulerButton}</div>}
        {toothView?.enabled && <div className="view-buttons"><button disabled={editing} aria-pressed={showAnnotations || editing} onClick={() => changeShowAnnotations(!showAnnotations)} title="Show or hide tooth labels and site patches. Collision colors are controlled separately.">{showAnnotations || editing ? 'Hide annotations' : 'Show annotations'}</button></div>}
        <div className="view-buttons"><button aria-pressed={expanded} onClick={() => changeExpanded(!expanded)} title={expanded ? 'Return to the planning workspace (Esc)' : 'Use the window for the 3D model'}>{expanded ? 'Exit expanded view' : 'Expand viewer'}</button></div>
        <div className="view-buttons navigation-mode" role="group" aria-label="Navigation mode">
          <button disabled={!ready || !!error} aria-pressed={navigationMode === 'orbit'} onClick={() => { if (editing) onExitToothTool?.(); cameraAction(meshViewer => meshViewer.setNavigationMode('orbit')); }} title="Drag or use one finger to orbit; right-drag or Shift+drag to pan">Orbit</button>
          <button disabled={!ready || !!error} aria-pressed={navigationMode === 'pan'} onClick={() => { if (editing) onExitToothTool?.(); cameraAction(meshViewer => meshViewer.setNavigationMode('pan')); }} title="Drag or use one finger to pan">Pan</button>
        </div>
        <div className="view-buttons camera-views" role="group" aria-label="Camera views">
          <select aria-label="View up axis" title="Camera up axis; file coordinates stay unchanged" disabled={!ready || !!error} value={upAxis} onChange={event => changeUpAxis(event.target.value as 'y' | 'z')}><option value="z">Z up</option><option value="y">Y up</option></select>
          {(['perspective', 'front', 'top', 'right'] as View[]).map(view => <button key={view} disabled={cameraDisabled} onClick={() => cameraAction(meshViewer => meshViewer.setView(view))}>{view === 'perspective' ? '3D' : view[0].toUpperCase() + view.slice(1)}</button>)}
        </div>
        <div className="view-buttons camera-actions" role="group" aria-label="Camera framing">
          <button disabled={cameraDisabled} onClick={() => cameraAction(meshViewer => meshViewer.zoom('in'))} aria-label="Zoom in" title="Zoom in">+</button>
          <button disabled={cameraDisabled} onClick={() => cameraAction(meshViewer => meshViewer.zoom('out'))} aria-label="Zoom out" title="Zoom out">−</button>
          <button disabled={cameraDisabled || !canFocus} onClick={() => cameraAction(meshViewer => meshViewer.focusSelected())} title="Frame the selected model or isolated tooth (Shift+F when the canvas is focused)">Focus selected</button>
          <button disabled={cameraDisabled} onClick={() => cameraAction(meshViewer => meshViewer.fit())} title="Frame all displayed triangles (F when the canvas is focused)">Fit all</button>
        </div>
      </div>
  );

  return <section className={`viewport${expanded ? ' viewport-expanded' : ''}${dock ? ' viewport-has-dock' : ''}`} aria-label="3D workspace" onKeyDownCapture={event => {
    if (ruler.enabled && event.key === 'Escape' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); event.stopPropagation();
      viewer.current?.setRulerEnabled(false);
      return;
    }
    if (editing && onExitToothTool && event.key === 'Escape' && event.target instanceof HTMLCanvasElement && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); event.stopPropagation();
      onExitToothTool();
      viewer.current?.setNavigationMode('orbit');
    }
  }}>
    <div ref={toolbar} className="viewport-toolbar">
      <div className="toolbar-left"><span className="view-label">3D workspace</span>{presetButtons}</div>
      {compact ? <div className="compact-camera">{rulerButton}</div> : cameraTools}
      {showRuler && !error && <div className="ruler-readout-row"><RulerReadout ruler={ruler} mmPerUnit={mmPerUnit} onClear={() => cameraAction(meshViewer => meshViewer.clearMeasurement())}
        onStart={() => { viewer.current?.clearMeasurement(); startRuler(); }} /></div>}
    </div>
    <div ref={host} className="canvas-host" />
    {!error && !measurementDisabled && <RulerOverlay ruler={ruler} mmPerUnit={mmPerUnit} />}
    {!sceneParts.length && !error && <div className="viewport-empty">
      <svg width="92" height="92" viewBox="0 0 92 92" fill="none" aria-hidden="true"><path d="M46 9 78 27v37L46 83 14 64V27L46 9Z" stroke="currentColor" strokeWidth="1.5"/><path d="m14 27 32 19 32-19M46 46v37M30 18l32 19v37M62 18 30 37v37M14 46l32 19 32-19" stroke="currentColor" strokeWidth="1" strokeDasharray="4 4"/></svg>
      <h2>Your scans, in focus.</h2><p>{parts.length ? 'Bite references are ready for alignment. Add an upper or lower scan to see the patient model.' : <>Drop upper and lower scans to begin.<br />Bite references align the arches automatically.</>}</p><button className="primary" onClick={onImport}>Import 3D files</button><span className="file-types">STL, OBJ, PLY · Multiple files welcome</span>
    </div>}
    {error && <div className="viewport-empty error-overlay" role="alert"><h2>The 3D view needs a restart.</h2><p>{error}</p><button onClick={() => setAttempt(value => value + 1)}>Restart 3D view</button></div>}
    {!!sceneParts.length && !hasVisibleParts && <div className="all-hidden">Both arches are hidden. Use Show all in the viewer tools below.</div>}
    {!!parts.length && hasVisibleParts && !hasIsolatedFaces && <div className="all-hidden">No visible triangles for this tooth. Turn off isolation to label a region, or select another tooth.</div>}
    {floatingControls && !error && <div ref={floating} className="viewport-floating-controls">{typeof floatingControls.content === 'function' ? floatingControls.content(() => changeExpanded(false)) : floatingControls.content}</div>}
    <div ref={bottomControls} className="viewport-bottom-controls">{visibilityControls}{dock}</div>
    <div ref={footer} className="viewport-footer"><span>{ruler.enabled ? 'Click / tap: measure · Drag: navigate' : editing ? `${strokeTool ? 'Left drag / 1 finger' : 'Click / tap'}: ${toothView!.tool} · Right drag: pan` : `Drag / 1 finger to ${navigationMode}`} <i /> Scroll to zoom <i /> 2 fingers pan + zoom</span><span>{ruler.enabled ? 'Pick A then B · Next click starts a new ruler · Esc done' : editing ? `Edit visible compatible scans · F fit · Shift+F focus${onExitToothTool ? ' · Esc inspect' : ''}` : 'Click: inspect · Double-click: pivot · Canvas keys: F fit · Shift+F focus · Esc orbit'}</span></div>
  </section>;
}
