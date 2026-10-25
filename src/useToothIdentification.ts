import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ModelPart } from './models';
import { applyTriangleLabels, isFdiTooth, toothArch, toothCounts } from './teeth';
import { createToothSession, emptyToothCase, readToothSession, reconcileToothCase } from './tooth-session';
import type { SurfaceAnchor, ToothBoundaryPath, ToothCase, ToothDraft, ToothEditEvent, ToothRecord, ToothTool, ToothViewState } from './tooth-types';
import { applyAutoAssignments, type AutoAssignment } from './auto-tooth-assignments';

type History = { present: ToothCase; past: ToothCase[]; future: ToothCase[] };
type Action = { type: 'edit'; update: (state: ToothCase) => ToothCase } | { type: 'reconcile'; parts: ModelPart[] } | { type: 'undo' } | { type: 'redo' };
function reducer(state: History, action: Action): History {
  if (action.type === 'undo') return state.past.length ? { present: state.past[state.past.length - 1], past: state.past.slice(0, -1), future: [state.present, ...state.future].slice(0, 20) } : state;
  if (action.type === 'redo') return state.future.length ? { present: state.future[0], past: [...state.past, state.present].slice(-20), future: state.future.slice(1) } : state;
  if (action.type === 'reconcile') {
    const next = reconcileToothCase(state.present, action.parts);
    return next === state.present && !state.past.length && !state.future.length ? state : { present: next, past: [], future: [] };
  }
  const next = action.update(state.present);
  return next === state.present ? state : { present: next, past: [...state.past, state.present].slice(-20), future: [] };
}

const readable = (error: unknown) => error instanceof Error ? error.message : String(error);
type SelectionResult = { faces: Uint32Array; boundary?: Float32Array };

export function useToothIdentification(parts: ModelPart[], selected: string | null, selectPart: (id: string) => void) {
  const [history, dispatch] = useReducer(reducer, undefined, () => ({ present: emptyToothCase(), past: [], future: [] }));
  const [selectedTooth, setSelectedTooth] = useState(16);
  const [enabled, setEnabled] = useState(true);
  const [tool, setToolState] = useState<ToothTool>('inspect');
  const [brushRadius, setRadius] = useState(1);
  const [isolate, setIsolate] = useState(false);
  const [boundary, setBoundary] = useState<SurfaceAnchor[]>([]);
  const [seed, setSeed] = useState<SurfaceAnchor | null>(null);
  const [draft, setDraft] = useState<ToothDraft | null>(null);
  const [boundaryPath, setBoundaryPath] = useState<ToothBoundaryPath | null>(null);
  const [working, setWorking] = useState(false);
  const [ioBusy, setIoBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('Select a tooth, assign its surface, or explicitly record a missing position.');
  const worker = useRef<Worker | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const request = useRef(0);
  const revision = useRef(0);
  const ioRequest = useRef(0);
  const alive = useRef(true);
  const active = parts.find(part => part.id === selected);
  const arch = toothArch(selectedTooth);
  const editable = !!active && active.role === arch && active.visible;
  const counts = useMemo(() => toothCounts(history.present.labels), [history.present.labels]);
  const busy = working || ioBusy;
  const sourceKey = parts.map(part => `${part.id}:${part.role}:${part.triangles}`).join('|');

  const cancel = useCallback(() => {
    request.current++;
    worker.current?.terminate(); worker.current = null;
    clearTimeout(timer.current); setWorking(false);
  }, []);
  const clearDraft = useCallback(() => {
    cancel(); setBoundary([]); setSeed(null); setDraft(null); setBoundaryPath(null);
  }, [cancel]);

  useEffect(() => {
    revision.current++;
    dispatch({ type: 'reconcile', parts });
    clearDraft(); setIsolate(false); setToolState('inspect');
    // Rigid pose changes preserve original triangle identities and source anchors.
  }, [sourceKey]);
  useEffect(() => { clearDraft(); setToolState('inspect'); }, [selected, selectedTooth, clearDraft]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; worker.current?.terminate(); clearTimeout(timer.current); };
  }, []);

  function chooseTooth(code: number, partId?: string) {
    if (!isFdiTooth(code) || busy) return;
    clearDraft(); setSelectedTooth(code); setToolState('inspect'); setError(''); setIsolate(false);
    const compatible = parts.find(part => part.role === toothArch(code) && part.visible) ?? parts.find(part => part.role === toothArch(code));
    const exact = partId ? parts.find(part => part.id === partId && part.role === toothArch(code)) : undefined;
    if (exact) selectPart(exact.id);
    else if (active?.role !== toothArch(code) && compatible) selectPart(compatible.id);
  }
  function chooseTool(next: ToothTool) {
    if (busy) return;
    if (next !== 'inspect' && !editable) { setError(`Select a visible ${arch} scan to edit FDI ${selectedTooth}.`); return; }
    if (next === 'site' && history.present.teeth[selectedTooth].status !== 'missing') { setError('Record this position as missing before marking its site.'); return; }
    if (['paint', 'boundary', 'seed'].includes(next) && ['missing', 'not-scanned'].includes(history.present.teeth[selectedTooth].status)) { setError('Change the review status to Present or Unreviewed before assigning a tooth surface.'); return; }
    setToolState(next); setEnabled(true); setError('');
    if (next !== 'inspect') setIsolate(false);
  }

  function editRecord(patch: Partial<ToothRecord>, target = selectedTooth) {
    if (busy || !parts.some(part => part.role === toothArch(target))) return;
    const current = history.present.teeth[target];
    const next = { ...current, ...patch, note: (patch.note ?? current.note).slice(0, 2000) };
    if (next.status !== 'present' && counts[target]) { setError('Clear the assigned surface before marking this tooth unreviewed, missing, or not scanned.'); return; }
    if (next.status !== 'missing') { delete next.site; if (next.restoration === 'implant') next.restoration = 'none'; }
    if (next.status !== 'present' && next.restoration === 'crown') next.restoration = 'none';
    if (next.restoration === 'implant' && next.status !== 'missing') return;
    if (next.restoration === 'crown' && next.status !== 'present') return;
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    dispatch({ type: 'edit', update: data => ({ ...data, teeth: { ...data.teeth, [target]: next } }) });
    if (patch.status) { clearDraft(); setToolState('inspect'); setIsolate(false); }
    setError(''); setNotice(`FDI ${target}: ${next.status === 'missing' ? 'missing position recorded by you' : next.status.replace('-', ' ')}.`);
  }

  function applyFaces(part: ModelPart, faces: Uint32Array, label: number) {
    const current = history.present.labels[part.id];
    let changed = 0, protectedFaces = 0;
    for (const face of faces) {
      const value = current?.[face] ?? 0;
      const eligible = label === 0 ? value === selectedTooth || value === 255 : value === 0 || value === selectedTooth;
      if (!eligible) protectedFaces++;
      else if (value !== label) changed++;
    }
    if (!changed) {
      setError(''); setNotice(protectedFaces ? 'No labels changed: this region is protected by other tooth labels or explicit exclusions.' : 'No labels changed: the selected region already has this label.');
      return;
    }
    dispatch({ type: 'edit', update: data => {
      const before = data.labels[part.id] ?? new Uint8Array(part.triangles);
      const after = applyTriangleLabels(before, faces, label, selectedTooth);
      if (!after.some((value, i) => value !== before[i])) return data;
      const labels = { ...data.labels, [part.id]: after };
      const selectedCount = Object.values(labels).reduce((sum, values) => sum + values.reduce((n, value) => n + Number(value === selectedTooth), 0), 0);
      const record = data.teeth[selectedTooth];
      const hadAssigned = Object.values(data.labels).some(values => values.includes(selectedTooth));
      const nextRecord: ToothRecord = selectedCount ? { ...record, status: 'present', restoration: record.restoration === 'crown' ? 'crown' : 'none', site: undefined } : hadAssigned && record.status === 'present' ? { ...record, status: 'unreviewed', restoration: 'none', site: undefined } : record;
      const mask = data.reviewedMask?.[part.id]?.slice() ?? new Uint8Array(part.triangles);
      for (const face of faces) if ((before[face] === 0 || before[face] === selectedTooth || before[face] === 255)) mask[face] = 1;
      return { labels, reviewedMask: { ...data.reviewedMask, [part.id]: mask }, teeth: { ...data.teeth, [selectedTooth]: nextRecord } };
    } });
    setError('');
    setNotice(`${changed.toLocaleString()} triangle labels ${label === 0 ? 'erased' : label === 255 ? 'marked excluded' : `assigned to FDI ${selectedTooth}`}.${protectedFaces ? ` ${protectedFaces.toLocaleString()} protected triangles kept.` : ''}`);
  }

  function runSelection(part: ModelPart, payload: Record<string, unknown>, done: (result: SelectionResult) => void) {
    cancel(); setWorking(true); setError('');
    const id = ++request.current;
    try {
      const instance = new Worker(new URL('./tooth.worker.ts', import.meta.url), { type: 'module' });
      worker.current = instance;
      const finish = () => { instance.terminate(); if (worker.current === instance) worker.current = null; clearTimeout(timer.current); setWorking(false); };
      instance.onmessage = event => {
        if (request.current !== id || worker.current !== instance) return;
        finish();
        if (event.data.error) { setError(event.data.error); return; }
        done(event.data as SelectionResult);
      };
      instance.onerror = () => { if (request.current !== id) return; finish(); setError('Surface selection stopped. Try a smaller scan or a shorter boundary.'); };
      timer.current = setTimeout(() => { if (request.current !== id) return; finish(); setError('Selection exceeded 30 seconds. Simplify the scan or use a smaller brush region.'); }, 30_000);
      const positions = part.positions.slice();
      instance.postMessage({ id, positions, ...payload }, [positions.buffer]);
    } catch (cause) { cancel(); setError(readable(cause)); }
  }

  function onEdit(event: ToothEditEvent) {
    if (busy || !editable || !active) return;
    const validHit = (hit: SurfaceAnchor) => hit.partId === active.id && Number.isSafeInteger(hit.face) && hit.face >= 0 && hit.face < active.triangles && hit.point.length === 3 && hit.point.every(Number.isFinite);
    if (event.kind === 'stroke') {
      if (!['paint', 'erase', 'exclude'].includes(event.tool) || event.tool !== tool) return;
      const hits = event.hits.filter(validHit);
      if (!hits.length) return;
      setDraft(null); setBoundaryPath(null);
      runSelection(active, { operation: 'brush', hits, radius: brushRadius }, result => applyFaces(active, result.faces, event.tool === 'erase' ? 0 : event.tool === 'exclude' ? 255 : selectedTooth));
      return;
    }
    if (!validHit(event.hit) || event.tool !== tool) return;
    setError('');
    if (event.tool === 'site') {
      if (history.present.teeth[selectedTooth].status !== 'missing') return;
      dispatch({ type: 'edit', update: data => ({ ...data, teeth: { ...data.teeth, [selectedTooth]: { ...data.teeth[selectedTooth], site: event.hit } } }) });
      setToolState('inspect'); setNotice(`FDI ${selectedTooth} site point saved on the ${arch} scan. This point does not define an implant axis or dimensions.`);
    } else if (event.tool === 'seed') {
      setSeed(event.hit); setDraft(null); setBoundaryPath(null); setNotice('Crown seed set. Complete the boundary, then preview its region.');
    } else if (event.tool === 'boundary') {
      if (boundary.length >= 128) { setError('Use at most 128 boundary points.'); return; }
      if (boundary.some(hit => hit.partId !== event.hit.partId)) { setError('Trace one connected scan part at a time.'); return; }
      setBoundary(current => [...current, event.hit]); setDraft(null); setBoundaryPath(null);
      setNotice('Boundary point added. Navigate to rotate; trace both cheek and tongue sides. Preview closes the last point to the first.');
    }
  }

  function preview() {
    if (busy || !active || !editable) return;
    if (boundary.length < 3 || !seed) { setError('Add at least three boundary points and a crown seed before previewing.'); return; }
    setIsolate(false); setDraft(null); setBoundaryPath(null);
    runSelection(active, { operation: 'boundary', boundary, seed }, result => {
      const labels = history.present.labels[active.id];
      const eligible = result.faces.filter(face => !labels?.[face] || labels[face] === selectedTooth);
      if (!eligible.length) { setError('The boundary contains no assignable triangles. Other teeth and explicit exclusions are protected; erase the relevant label first to change it.'); return; }
      setDraft({ partId: active.id, faces: eligible });
      setBoundaryPath(result.boundary ? { partId: active.id, positions: result.boundary } : null);
      const protectedCount = result.faces.length - eligible.length;
      setToolState('inspect'); setNotice(`${eligible.length.toLocaleString()} assignable triangles in the preview.${protectedCount ? ` ${protectedCount.toLocaleString()} protected triangles omitted.` : ''} Inspect all sides before assigning.`);
    });
  }
  function confirm() {
    if (busy || !draft?.faces.length) return;
    const part = parts.find(item => item.id === draft.partId);
    if (!part || part.role !== arch) return;
    applyFaces(part, draft.faces, selectedTooth); clearDraft(); setToolState('inspect');
  }
  function clearTooth() {
    if (busy) return;
    dispatch({ type: 'edit', update: data => {
      const labels = Object.fromEntries(Object.entries(data.labels).map(([id, values]) => [id, values.map(value => value === selectedTooth ? 0 : value)]));
      const record = data.teeth[selectedTooth];
      const masks = { ...data.reviewedMask };
      for (const part of parts) { const mask = masks[part.id]?.slice() ?? new Uint8Array(part.triangles); data.labels[part.id]?.forEach((value, face) => { if (value === selectedTooth) mask[face] = 1; }); masks[part.id] = mask; }
      return { labels, reviewedMask: masks, teeth: { ...data.teeth, [selectedTooth]: record.status === 'present' ? { ...record, status: 'unreviewed', restoration: 'none' } : record } };
    } });
    clearDraft(); setIsolate(false); setNotice(`FDI ${selectedTooth} surface labels cleared. Review its status again.`);
  }
  function undoRedo(type: 'undo' | 'redo') { if (!busy) { clearDraft(); dispatch({ type }); setError(''); setIsolate(false); setToolState('inspect'); setNotice(type === 'undo' ? 'Undid the last identification edit.' : 'Restored the identification edit.'); } }

  async function save() {
    if (busy) return;
    setIoBusy(true); setError('');
    const operation = ++ioRequest.current;
    const version = revision.current;
    try {
      const file = await createToothSession(parts, history.present);
      if (!alive.current || ioRequest.current !== operation) return;
      if (revision.current !== version) throw new Error('The scans changed while identification was saving. Save again.');
      const url = URL.createObjectURL(new Blob([JSON.stringify(file)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = 'platanus-identification.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice('Identification saved locally. Reimport the original scans and load this file to resume.');
    } catch (cause) { if (alive.current && ioRequest.current === operation) setError(readable(cause)); }
    finally { if (alive.current && ioRequest.current === operation) setIoBusy(false); }
  }
  async function load(file: File) {
    if (busy) return;
    cancel(); setIoBusy(true); setError('');
    const operation = ++ioRequest.current;
    const version = revision.current;
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error('Identification files must be smaller than 8 MiB.');
      const next = await readToothSession(JSON.parse(await file.text()), parts);
      if (!alive.current || ioRequest.current !== operation) return;
      if (revision.current !== version) throw new Error('The scans changed while identification was loading. Load the file again.');
      dispatch({ type: 'edit', update: () => next }); clearDraft(); setIsolate(false); setToolState('inspect'); setEnabled(true);
      setNotice('Identification loaded after verifying original scan geometry, triangle labels, and site points.');
    } catch (cause) { if (alive.current && ioRequest.current === operation) setError(readable(cause)); }
    finally { if (alive.current && ioRequest.current === operation) setIoBusy(false); }
  }

  const siteEntries = Object.entries(history.present.teeth).flatMap(([tooth, record]) => record.site ? [{ tooth: Number(tooth), anchor: record.site }] : []);
  const siteKey = JSON.stringify(siteEntries);
  const sites = useMemo(() => siteEntries, [siteKey]);
  const effectiveTool = busy ? 'inspect' : tool;
  const editablePartId = editable && active ? active.id : null;
  const hasRegion = !!(counts[selectedTooth] || draft?.faces.length);
  // Notes and review text must not repaint every corner of a dense scan.
  const view: ToothViewState = useMemo(() => ({
    enabled, activeTooth: selectedTooth, tool: effectiveTool, brushRadius,
    isolate: isolate && enabled && hasRegion,
    labels: history.present.labels, draft, boundary, boundaryPath, seed,
    sites, editablePartIds: editablePartId ? [editablePartId] : [],
  }), [enabled, selectedTooth, effectiveTool, brushRadius, isolate, hasRegion, history.present.labels, draft, boundary, boundaryPath, seed, sites, editablePartId]);
  return {
    data: history.present, view, counts, selectedTooth, enabled, tool, brushRadius, isolate: view.isolate, busy, error, notice, editable,
    boundaryCount: boundary.length, hasSeed: !!seed, draftCount: draft?.faces.length ?? 0, canUndo: history.past.length > 0, canRedo: history.future.length > 0,
    select: chooseTooth, record: (patch: Partial<ToothRecord>) => editRecord(patch), recordFor: (target: number, patch: Partial<ToothRecord>) => { if (isFdiTooth(target)) editRecord(patch, target); }, setEnabled: (value: boolean) => { if (busy) return; setEnabled(value); if (!value) { setIsolate(false); setToolState('inspect'); } },
    setTool: chooseTool, setRadius: (value: number) => { if (Number.isFinite(value) && value > 0 && value <= 1e6) setRadius(value); },
    setIsolate: (value: boolean) => { setIsolate(value); if (value) { setEnabled(true); setToolState('inspect'); } },
    onEdit, preview, confirm, clearDraft, clearTooth,
    assignRegion: (partId: string, faces: Uint32Array, target = selectedTooth) => {
      if (busy) return;
      const part = parts.find(item => item.id === partId);
      if (!isFdiTooth(target) || !part || part.role !== toothArch(target) || ['missing', 'not-scanned'].includes(history.present.teeth[target].status)) { setError('Choose an available FDI position on the matching arch before assigning this region.'); return; }
      if (counts[target]) { setError(`FDI ${target} already has an assigned surface. Keep its corrections, or clear its labels before assigning a different automatic region.`); return; }
      const result = applyAutoAssignments(history.present, parts, [{ partId, tooth: target, faces }]);
      dispatch({ type: 'edit', update: () => result.data });
      setSelectedTooth(target); clearDraft(); setToolState('inspect'); setError('');
      setNotice(result.applied.length ? `${result.triangles.toLocaleString()} triangles assigned to FDI ${target}.` : 'No triangles changed: the region is protected or excluded.');
    },
    applyMappedRegions: (regions: AutoAssignment[]) => {
      if (busy) return;
      try {
        const result = applyAutoAssignments(history.present, parts, regions);
        dispatch({ type: 'edit', update: () => result.data });
        clearDraft(); setToolState('inspect'); setEnabled(true); setError('');
        setNotice(`${result.applied.length} mapped teeth applied (${result.triangles.toLocaleString()} triangles).${result.skipped.length ? ` ${result.skipped.length} existing, unavailable, or protected assignments preserved.` : ''}`);
      } catch (cause) { setError(readable(cause)); }
    },
    removeBoundaryPoint: () => { if (!busy) { setBoundary(current => current.slice(0, -1)); setDraft(null); setBoundaryPath(null); } },
    clearSite: () => editRecord({ site: undefined }), undo: () => undoRedo('undo'), redo: () => undoRedo('redo'),
    restore: (data: ToothCase) => { cancel(); dispatch({ type: 'edit', update: () => data }); clearDraft(); },
    cancel: () => { cancel(); ioRequest.current++; setIoBusy(false); setNotice('Identification operation cancelled. Existing labels are unchanged.'); }, save, load,
  };
}
