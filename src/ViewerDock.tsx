import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Axis3d, Camera, Expand, Eye, Focus, Maximize2, MoreHorizontal, Move, Orbit, Palette, Shrink, Tags, UnfoldVertical, ZoomIn } from "lucide-react";
import "dockbar";
import type { NavigationMode } from './viewer';
import './viewer-dock.css';

type PanelKey = 'nav' | 'zoom' | 'display' | 'opening' | 'scene' | 'axis';

/** Small floating panel anchored above a dock item, portaled to the body so
 *  dockbar's hover magnification never distorts it. */
function DockPopover({ anchor, onClose, className = '', children }: {
  anchor: HTMLElement | null;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  const popRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const pop = popRef.current;
    if (!pop || !anchor) return;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      const p = pop.getBoundingClientRect();
      const left = Math.min(Math.max(8, a.left + a.width / 2 - p.width / 2), window.innerWidth - p.width - 8);
      let top = a.top - p.height - 10;
      if (top < 8) top = a.bottom + 10;
      pop.style.left = `${Math.round(left)}px`;
      pop.style.top = `${Math.round(top)}px`;
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    };
    const onDown = (event: MouseEvent) => {
      if (popRef.current?.contains(event.target as Node) || anchor?.contains(event.target as Node)) return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown, true);
    };
  }, [onClose, anchor]);
  return createPortal(
    <div ref={popRef} className={`modeldock-popover${className ? ` ${className}` : ''}`}>{children}</div>,
    document.body,
  );
}

export function ViewerDock({ disabled, navigationMode, heatmap, wireframe, canFocus, opening, showOpening, sceneVisibility, annotationsEnabled, annotationsVisible, upAxis, expanded, onZoom, onFit, onFocusSelected, onNavigationMode, onCapture, onToggleHeatmap, onToggleWireframe, onOpening, onToggleAnnotations, onUpAxisChange, onToggleExpanded }: {
  disabled: boolean;
  navigationMode: NavigationMode;
  heatmap: boolean;
  wireframe: boolean;
  canFocus: boolean;
  opening: number;
  showOpening: boolean;
  sceneVisibility?: ReactNode;
  annotationsEnabled: boolean;
  annotationsVisible: boolean;
  upAxis: 'y' | 'z';
  expanded: boolean;
  onZoom: (direction: 'in' | 'out') => void;
  onFit: () => void;
  onFocusSelected: () => void;
  onNavigationMode: (mode: NavigationMode) => void;
  onCapture: () => void;
  onToggleHeatmap: () => void;
  onToggleWireframe: () => void;
  onOpening: (value: number) => void;
  onToggleAnnotations: () => void;
  onUpAxisChange: (axis: 'y' | 'z') => void;
  onToggleExpanded: () => void;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [openPanel, setOpenPanel] = useState<PanelKey | null>(null);
  const openPanelRef = useRef<PanelKey | null>(null);
  openPanelRef.current = openPanel;
  const [tip, setTip] = useState<{ text: string; anchor: HTMLElement } | null>(null);
  const [needsScroll, setNeedsScroll] = useState(false);
  const dockRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Partial<Record<PanelKey, HTMLElement>>>({});
  const itemCallbacks = useRef<Partial<Record<PanelKey, (instance: unknown) => void>>>({});
  const collapseTimer = useRef<number | undefined>(undefined);
  const openedAtRef = useRef(0);
  const openingId = useId();

  // The scroll container that enables horizontal scrolling on narrow screens
  // also clips magnification. Only enable it when the bar really overflows;
  // otherwise let content bleed freely above the pill.
  useEffect(() => {
    const dock = dockRef.current;
    const bar = dock?.querySelector<Element>("dock-wrapper");
    if (!dock || !bar) return;
    const update = () => setNeedsScroll(bar.scrollWidth > dock.clientWidth + 1);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(dock);
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);

  const setItemRef = (key: PanelKey) => {
    itemCallbacks.current[key] ??= (instance: unknown) => {
      if (instance) itemRefs.current[key] = instance as HTMLElement;
    };
    return itemCallbacks.current[key]!;
  };

  // JS-driven tooltips: they dismiss on click, and clamp inside the viewport
  // instead of being clipped by the canvas container's overflow.
  const itemTip = (text: string) => ({
    onPointerEnter: (event: unknown) => setTip({ text, anchor: (event as { currentTarget: HTMLElement }).currentTarget }),
    onPointerLeave: () => setTip(null),
    onFocus: (event: unknown) => setTip({ text, anchor: (event as { currentTarget: HTMLElement }).currentTarget }),
    onBlur: () => setTip(null),
    onClickCapture: () => setTip(null),
  });

  const open = () => {
    window.clearTimeout(collapseTimer.current);
    openedAtRef.current = Date.now();
    setIsExpanded(true);
  };
  const scheduleCollapse = () => {
    window.clearTimeout(collapseTimer.current);
    collapseTimer.current = window.setTimeout(() => {
      if (openPanelRef.current) return;
      setOpenPanel(null);
      setIsExpanded(false);
    }, 250);
  };
  // A tap fires pointerenter and click in the same gesture; only a deliberate
  // later click on the three-dots item may collapse the dock again.
  const toggle = () => {
    if (Date.now() - openedAtRef.current < 350) return;
    window.clearTimeout(collapseTimer.current);
    setOpenPanel(null);
    setIsExpanded((value) => !value);
  };
  const togglePanel = (key: PanelKey) => setOpenPanel((current) => (current === key ? null : key));
  const closePanel = () => {
    setOpenPanel(null);
    if (!dockRef.current?.matches(':hover')) scheduleCollapse();
  };

  return (
    <div
      ref={dockRef}
      className={`modeldock${isExpanded ? " modeldock-open" : ""}${needsScroll ? "" : " modeldock-noscroll"}`}
    >
      <dock-wrapper
        class="modeldock-bar"
        position="bottom"
        size={34}
        gap={5}
        padding={6}
        maxScale={1.6}
        maxRange={150}
        role="toolbar"
        aria-label="3D viewer tools"
        onPointerEnter={open}
        onPointerLeave={scheduleCollapse}
        onFocus={open}
        onBlur={(event) => {
          if (!(event.currentTarget as unknown as HTMLElement).contains(event.relatedTarget as Node | null)) scheduleCollapse();
        }}
      >
        <dock-item {...itemTip(isExpanded ? "Hide viewer tools" : "Viewer tools")} class="modeldock-item">
          <button
            type="button"
            className="modeldock-tool"
            aria-expanded={isExpanded}
            aria-label={isExpanded ? "Hide 3D viewer tools" : "Show 3D viewer tools"}
            onClick={toggle}
          >
            <MoreHorizontal size={15} aria-hidden="true" />
          </button>
        </dock-item>
        {isExpanded && (
          <>
            <dock-separator class="modeldock-sep" />
            <dock-item {...itemTip("Fit all")} class="modeldock-item">
              <button type="button" className="modeldock-tool" disabled={disabled} aria-label="Fit all" onClick={onFit}>
                <Maximize2 size={15} aria-hidden="true" />
              </button>
            </dock-item>
            <dock-item {...itemTip("Focus selected")} class="modeldock-item">
              <button type="button" className="modeldock-tool" disabled={disabled || !canFocus} aria-label="Focus selected" onClick={onFocusSelected}>
                <Focus size={15} aria-hidden="true" />
              </button>
            </dock-item>
            <dock-separator class="modeldock-sep" />
            <dock-item ref={setItemRef('nav')} {...itemTip("Navigation mode")} class="modeldock-item">
              <button
                type="button"
                className="modeldock-tool"
                disabled={disabled}
                aria-haspopup="dialog"
                aria-expanded={openPanel === 'nav'}
                aria-label={navigationMode === 'orbit' ? 'Navigation mode: orbit' : 'Navigation mode: pan'}
                onClick={() => togglePanel('nav')}
              >
                {navigationMode === 'orbit' ? <Orbit size={15} aria-hidden="true" /> : <Move size={15} aria-hidden="true" />}
              </button>
            </dock-item>
            {openPanel === 'nav' && (
              <DockPopover anchor={itemRefs.current.nav ?? null} onClose={closePanel}>
                <div className="modeldock-popnav" role="group" aria-label="Navigation mode">
                  <button type="button" aria-pressed={navigationMode === 'orbit'} onClick={() => { onNavigationMode('orbit'); setOpenPanel(null); }}>Orbit</button>
                  <button type="button" aria-pressed={navigationMode === 'pan'} onClick={() => { onNavigationMode('pan'); setOpenPanel(null); }}>Pan</button>
                </div>
              </DockPopover>
            )}
            <dock-item ref={setItemRef('zoom')} {...itemTip("Zoom")} class="modeldock-item">
              <button
                type="button"
                className="modeldock-tool"
                disabled={disabled}
                aria-haspopup="dialog"
                aria-expanded={openPanel === 'zoom'}
                aria-label="Zoom"
                onClick={() => togglePanel('zoom')}
              >
                <ZoomIn size={15} aria-hidden="true" />
              </button>
            </dock-item>
            {openPanel === 'zoom' && (
              <DockPopover anchor={itemRefs.current.zoom ?? null} onClose={closePanel}>
                <div className="modeldock-popzoom">
                  <button type="button" disabled={disabled} aria-label="Zoom out" onClick={() => onZoom('out')}>−</button>
                  <span>Zoom</span>
                  <button type="button" disabled={disabled} aria-label="Zoom in" onClick={() => onZoom('in')}>+</button>
                </div>
              </DockPopover>
            )}
            <dock-separator class="modeldock-sep" />
            <dock-item {...itemTip("Capture image")} class="modeldock-item">
              <button type="button" className="modeldock-tool" disabled={disabled} aria-label="Capture image" onClick={onCapture}>
                <Camera size={15} aria-hidden="true" />
              </button>
            </dock-item>
            <dock-item ref={setItemRef('display')} {...itemTip("Surface display")} class="modeldock-item">
              <button
                type="button"
                className="modeldock-tool"
                aria-haspopup="dialog"
                aria-expanded={openPanel === 'display'}
                aria-label="Surface display"
                onClick={() => togglePanel('display')}
              >
                <Palette size={15} aria-hidden="true" />
              </button>
            </dock-item>
            {openPanel === 'display' && (
              <DockPopover anchor={itemRefs.current.display ?? null} onClose={closePanel}>
                <div className="modeldock-popnav" role="group" aria-label="Surface display">
                  <button type="button" aria-pressed={heatmap} onClick={onToggleHeatmap}>Heatmap</button>
                  <button type="button" aria-pressed={wireframe} onClick={onToggleWireframe}>Wireframe</button>
                </div>
              </DockPopover>
            )}
            <dock-separator class="modeldock-sep" />
            {showOpening && (
              <>
                <dock-item ref={setItemRef('opening')} {...itemTip("Opening between arches")} class="modeldock-item">
                  <button
                    type="button"
                    className="modeldock-tool"
                    aria-haspopup="dialog"
                    aria-expanded={openPanel === 'opening'}
                    aria-label="Opening between arches"
                    onClick={() => togglePanel('opening')}
                  >
                    <UnfoldVertical size={15} aria-hidden="true" />
                  </button>
                </dock-item>
                {openPanel === 'opening' && (
                  <DockPopover anchor={itemRefs.current.opening ?? null} onClose={closePanel}>
                    <div className="modeldock-popslider">
                      <label htmlFor={openingId}>
                        Opening <strong>{Math.round(opening)}%</strong>
                      </label>
                      <input
                        id={openingId}
                        type="range"
                        min="0"
                        max="100"
                        value={Math.round(opening)}
                        aria-label="Visual opening between the arches"
                        onChange={(event) => onOpening(Number(event.target.value))}
                      />
                    </div>
                  </DockPopover>
                )}
              </>
            )}
            {sceneVisibility && (
              <>
                <dock-item ref={setItemRef('scene')} {...itemTip("Arch visibility")} class="modeldock-item">
                  <button
                    type="button"
                    className="modeldock-tool"
                    aria-haspopup="dialog"
                    aria-expanded={openPanel === 'scene'}
                    aria-label="Arch visibility"
                    onClick={() => togglePanel('scene')}
                  >
                    <Eye size={15} aria-hidden="true" />
                  </button>
                </dock-item>
                {openPanel === 'scene' && (
                  <DockPopover anchor={itemRefs.current.scene ?? null} onClose={closePanel} className="modeldock-popscene">
                    <div className="modeldock-scene">{sceneVisibility}</div>
                  </DockPopover>
                )}
              </>
            )}
            <dock-separator class="modeldock-sep" />
            {annotationsEnabled && (
              <dock-item {...itemTip(annotationsVisible ? "Hide annotations" : "Show annotations")} class="modeldock-item">
                <button
                  type="button"
                  className="modeldock-tool"
                  aria-pressed={annotationsVisible}
                  aria-label={annotationsVisible ? "Hide tooth annotations" : "Show tooth annotations"}
                  onClick={onToggleAnnotations}
                >
                  <Tags size={15} aria-hidden="true" />
                </button>
              </dock-item>
            )}
            <dock-item ref={setItemRef('axis')} {...itemTip("View up axis")} class="modeldock-item">
              <button
                type="button"
                className="modeldock-tool"
                aria-haspopup="dialog"
                aria-expanded={openPanel === 'axis'}
                aria-label={`View up axis: ${upAxis === 'y' ? 'Y up' : 'Z up'}`}
                onClick={() => togglePanel('axis')}
              >
                <Axis3d size={15} aria-hidden="true" />
              </button>
            </dock-item>
            {openPanel === 'axis' && (
              <DockPopover anchor={itemRefs.current.axis ?? null} onClose={closePanel}>
                <div className="modeldock-popnav" role="group" aria-label="View up axis">
                  <button type="button" aria-pressed={upAxis === 'z'} onClick={() => { onUpAxisChange('z'); setOpenPanel(null); }}>Z up</button>
                  <button type="button" aria-pressed={upAxis === 'y'} onClick={() => { onUpAxisChange('y'); setOpenPanel(null); }}>Y up</button>
                </div>
              </DockPopover>
            )}
            <dock-item {...itemTip(expanded ? "Exit expanded view" : "Expand viewer")} class="modeldock-item">
              <button
                type="button"
                className="modeldock-tool"
                aria-pressed={expanded}
                aria-label={expanded ? "Exit expanded view" : "Expand viewer"}
                onClick={onToggleExpanded}
              >
                {expanded ? <Shrink size={15} aria-hidden="true" /> : <Expand size={15} aria-hidden="true" />}
              </button>
            </dock-item>
          </>
        )}
      </dock-wrapper>
      {tip && (
        <DockPopover anchor={tip.anchor} onClose={() => setTip(null)} className="modeldock-tooltip">
          {tip.text}
        </DockPopover>
      )}
    </div>
  );
}
