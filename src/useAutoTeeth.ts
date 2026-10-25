import { useEffect, useMemo, useRef, useState } from 'react';
import type { ModelPart } from './models';
import type { SurfaceAnchor } from './tooth-types';
import type { AutoToothIdentificationRequest, AutoToothOverlay, AutoToothProposalState, AutoToothScan, AutoToothSettings } from './auto-tooth-types';
import { isFdiTooth, toothArch } from './teeth';
import { renderToothViews } from './auto-tooth-views';
import { validateIdentification } from './tooth-identification-schema';
import { mergeToothMappings } from './auto-tooth-mappings';
import { ANTHROPIC_MODELS, DEFAULT_IDENTIFICATION_MODEL, isAnthropicModelId } from './anthropic-models';

const readable = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const isArch = (part: ModelPart | undefined): part is ModelPart & { role: 'upper' | 'lower' } => part?.role === 'upper' || part?.role === 'lower';
// Imported buffers are immutable inputs. Presentation transforms do not change
// local detection, but replacing any image/color/UV input invalidates its views.
const sourceInputs = (part: ModelPart | undefined) => [
  part?.positions, part?.normals, part?.uvs, part?.colors, part?.tissueScores,
  part?.texture?.bytes, part?.texture?.mimeType, part?.texture?.fileName,
  part?.texture?.width, part?.texture?.height, part?.textureStatus,
] as const;
type SourceInputs = ReturnType<typeof sourceInputs>;
const sameInputs = (a: SourceInputs, b: SourceInputs) => a.every((value, index) => value === b[index]);

export function useAutoTeeth(parts: ModelPart[], selected: string | null, suspended: boolean) {
  const active = parts.find(part => part.id === selected);
  const [autoRun, setAutoRun] = useState(true);
  const [settings, setSettings] = useState<AutoToothSettings>({ direction: 'auto', sensitivity: 1 });
  const [proposal, setProposal] = useState<AutoToothProposalState | null>(null);
  const currentProposal = useRef(proposal); currentProposal.current = proposal;
  const cache = useRef(new Map<string, { settings: string; role: string; inputs: SourceInputs; proposal: AutoToothProposalState }>());
  const [patientRight, setPatientRight] = useState<'image-left' | 'image-right' | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [model, setModel] = useState<string>(DEFAULT_IDENTIFICATION_MODEL);
  const [defaultModel, setDefaultModel] = useState<string>(DEFAULT_IDENTIFICATION_MODEL);
  const modelChosen = useRef(false);
  const modelLabel = ANTHROPIC_MODELS.find(option => option.id === model)?.label ?? model;
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('Imported arch scans are analyzed locally to propose tooth regions.');
  const worker = useRef<Worker | null>(null);
  const controller = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const request = useRef(0), alive = useRef(true);
  const settingsKey = `${settings.direction}:${settings.sensitivity}`;
  const inputs = sourceInputs(active);
  const latest = useRef({ active, inputs, settingsKey, suspended });
  latest.current = { active, inputs, settingsKey, suspended };

  function isCurrent(id: number) {
    const next = latest.current;
    return request.current === id && alive.current && !next.suspended && next.active?.id === active?.id && next.active?.role === active?.role && next.settingsKey === settingsKey && sameInputs(next.inputs, inputs);
  }

  function stop() {
    request.current++; worker.current?.terminate(); worker.current = null;
    controller.current?.abort(); controller.current = null; clearTimeout(timer.current);
    setBusy(false); setStage('');
  }
  function write(next: AutoToothProposalState | null) {
    currentProposal.current = next; setProposal(next);
    const source = next && parts.find(part => part.id === next.partId);
    if (next && source) cache.current.set(next.partId, { settings: settingsKey, role: source.role ?? 'model', inputs: sourceInputs(source), proposal: next });
  }

  useEffect(() => {
    const abort = new AbortController();
    fetch('/api/teeth/status', { signal: abort.signal }).then(response => response.ok ? response.json() : null).then(value => {
      if (abort.signal.aborted) return;
      setConfigured(value?.configured === true);
      if (typeof value?.model === 'string' && value.model && value.model.length <= 120) {
        setDefaultModel(value.model);
        if (!modelChosen.current) setModel(value.model);
      }
    }).catch(() => { if (!abort.signal.aborted) setConfigured(false); });
    return () => abort.abort();
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; request.current++; worker.current?.terminate(); controller.current?.abort(); clearTimeout(timer.current); };
  }, []);
  useEffect(() => {
    for (const [id, entry] of cache.current) {
      const source = parts.find(part => part.id === id);
      if (!isArch(source) || source.role !== entry.role || !sameInputs(entry.inputs, sourceInputs(source))) cache.current.delete(id);
    }
  }, [parts]);
  useEffect(() => {
    setPatientRight(null);
  }, [active?.id, active?.role, ...inputs, settingsKey]);
  useEffect(() => {
    stop(); setError('');
    const existing = active && cache.current.get(active.id);
    const matching = isArch(active) && existing?.settings === settingsKey && existing.role === active.role && sameInputs(existing.inputs, inputs) ? existing.proposal : null;
    currentProposal.current = matching; setProposal(matching);
    if (autoRun && !suspended && isArch(active) && !matching) scan();
  }, [active?.id, active?.role, ...inputs, settingsKey, autoRun, suspended]);

  function scan() {
    if (!isArch(active) || suspended) { setError('Select an upper or lower scan to run automatic tooth detection.'); return; }
    stop(); setBusy(true); setStage('Scanning mesh for crown regions…'); setError(''); setPatientRight(null);
    const id = ++request.current;
    try {
      const instance = new Worker(new URL('./auto-tooth.worker.ts', import.meta.url), { type: 'module' });
      worker.current = instance;
      const finish = () => { instance.terminate(); if (worker.current === instance) worker.current = null; clearTimeout(timer.current); setBusy(false); setStage(''); };
      instance.onmessage = event => {
        if (!isCurrent(id) || worker.current !== instance) return;
        finish();
        if (event.data.error) { setError(event.data.error); return; }
        const raw = event.data.scan as AutoToothScan;
        // C1…C32 are short aliases for this proposal only. Original seed faces
        // retain geometry identity; these aliases never supply FDI numbering.
        const result = { ...raw, candidates: raw.candidates.map((candidate, index) => ({ ...candidate, id: index + 1 })) };
        write({ partId: active.id, scan: result, selectedCandidate: result.candidates[0]?.id ?? null, mappings: [], possibleMissing: [], model: null, views: [] });
        setNotice(result.candidates.length ? `${result.candidates.length} candidate regions detected. Select a region to use it, or prepare views for AI to suggest FDI identities.` : 'No reliable crown regions found. Check the occlusal direction or use the correction tools on this scan.');
      };
      instance.onerror = () => { if (!isCurrent(id)) return; finish(); setError('Automatic detection stopped. Try a smaller scan or an explicit occlusal direction.'); };
      timer.current = setTimeout(() => { if (!isCurrent(id)) return; finish(); setError('Automatic detection exceeded 30 seconds. Simplify this scan before retrying.'); }, 30_000);
      const positions = active.positions.slice();
      const tissueScores = active.tissueScores?.slice();
      instance.postMessage({ id, positions, settings, tissueScores }, tissueScores ? [positions.buffer, tissueScores.buffer] : [positions.buffer]);
    } catch (cause) { stop(); setError(readable(cause)); }
  }
  function selectCandidate(id: number) {
    const current = currentProposal.current;
    if (!busy && current?.scan.candidates.some(candidate => candidate.id === id)) write({ ...current, selectedCandidate: id });
  }
  function pick(hit: SurfaceAnchor) {
    const current = currentProposal.current;
    if (!current || current.partId !== hit.partId || busy) return;
    const candidate = current.scan.candidates.find(candidate => candidate.faces.includes(hit.face));
    if (candidate) { selectCandidate(candidate.id); setNotice(`C${candidate.id} selected from the scan. No triangle labels changed.`); return current.mappings.find(mapping => mapping.candidateId === candidate.id)?.fdi ?? null; }
    else setNotice('That triangle is outside the detected crown regions. Pick a crown, adjust detection, or use a correction tool.');
  }
  function mapCandidate(id: number, fdi: number | null) {
    const current = currentProposal.current;
    if (busy || !isArch(active) || !current?.scan.candidates.some(candidate => candidate.id === id)) return;
    if (fdi !== null && (!isFdiTooth(fdi) || toothArch(fdi) !== active.role)) { setError('Choose an FDI number from the selected arch.'); return; }
    if (fdi !== null && current.mappings.some(mapping => mapping.candidateId !== id && mapping.fdi === fdi)) { setError(`FDI ${fdi} is already mapped to another candidate. Clear that mapping first.`); return; }
    write({ ...current, mappings: [...current.mappings.filter(mapping => mapping.candidateId !== id), { candidateId: id, fdi, needsReview: fdi === null, source: 'user', reason: 'Mapping reviewed by the user.' }] });
    setError('');
    return true;
  }
  function reject(id: number) {
    const current = currentProposal.current;
    if (busy || !current) return;
    const candidates = current.scan.candidates.filter(candidate => candidate.id !== id);
    write({ ...current, scan: { ...current.scan, candidates }, selectedCandidate: current.selectedCandidate === id ? candidates[0]?.id ?? null : current.selectedCandidate, mappings: current.mappings.filter(mapping => mapping.candidateId !== id), views: [], possibleMissing: [], model: null });
    setPatientRight(null); setNotice(`C${id} removed from the proposal. Reviewed surface labels are unchanged.`);
  }

  async function prepareViews() {
    const current = currentProposal.current;
    if (busy || suspended || !active || !current || current.partId !== active.id || !current.scan.candidates.length) return;
    stop(); const id = ++request.current, abort = new AbortController(); controller.current = abort;
    setBusy(true); setStage('Preparing scan views locally…'); setError('');
    try {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      if (!isCurrent(id)) return;
      const views = await renderToothViews(active, current.scan, abort.signal);
      if (!isCurrent(id)) return;
      write({ ...current, views });
      setNotice('Views prepared locally. Confirm patient right in the overview before requesting AI identification.');
    } catch (cause) { if (isCurrent(id)) setError(readable(cause)); }
    finally { if (isCurrent(id)) { controller.current = null; setBusy(false); setStage(''); } }
  }
  async function identify() {
    const current = currentProposal.current;
    if (busy || suspended || !isArch(active) || !current || current.partId !== active.id) return;
    if (!patientRight || !current.views.length) { setError('Prepare scan views and confirm which side is patient right before identification.'); return; }
    if (!configured) { setError('Configure ANTHROPIC_API_KEY on the local server to enable AI identification. Local region detection is available.'); return; }
    stop(); const id = ++request.current, abort = new AbortController(); controller.current = abort;
    setBusy(true); setStage(`${modelLabel} is reviewing the scan views…`); setError('');
    timer.current = setTimeout(() => abort.abort(), 90_000);
    const payload: AutoToothIdentificationRequest = {
      ...(isAnthropicModelId(model) ? { model } : {}),
      arch: active.role, patientRight, views: current.views,
      candidates: current.scan.candidates.map(candidate => ({ id: candidate.id, triangles: candidate.faces.length, area: candidate.area, height: candidate.height, warnings: candidate.warnings })),
    };
    try {
      const response = await fetch('/api/teeth/identify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: abort.signal });
      const value = await response.json();
      if (!isCurrent(id)) return;
      if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : 'AI identification failed.');
      const result = validateIdentification(value, payload);
      if (typeof value.model !== 'string' || !value.model || value.model.length > 120) throw new Error('The identification response has no usable model identifier.');
      const merged = mergeToothMappings(current.mappings, result);
      write({ ...current, mappings: merged.mappings, possibleMissing: merged.possibleMissing, model: value.model, scan: { ...current.scan, warnings: [...new Set([...current.scan.warnings, ...merged.warnings])] } });
      setNotice('AI identity suggestions are ready. Review the mapping, then apply mapped teeth. Possible gaps stay unreviewed until you record them.');
    } catch (cause) { if (isCurrent(id)) setError(abort.signal.aborted ? 'AI identification timed out or was cancelled. Existing labels are unchanged.' : readable(cause)); }
    finally { if (isCurrent(id)) { clearTimeout(timer.current); controller.current = null; setBusy(false); setStage(''); } }
  }

  const overlayCandidates = useMemo(() => proposal?.scan.candidates.map(candidate => ({ id: candidate.id, faces: candidate.faces, centroid: candidate.seed.point })) ?? [], [proposal?.scan]);
  const overlay: AutoToothOverlay | null = useMemo(() => proposal ? { partId: proposal.partId, candidates: overlayCandidates, selectedCandidate: proposal.selectedCandidate } : null, [proposal?.partId, proposal?.selectedCandidate, overlayCandidates]);
  return {
    proposal, overlay, busy, stage, error, notice, autoRun, settings, configured, patientRight, model, defaultModel,
    setModel: (value: string) => {
      if (busy || controller.current || suspended || (!isAnthropicModelId(value) && value !== defaultModel)) return;
      modelChosen.current = true; setModel(value); setError('');
    },
    setAutoRun, scan, selectCandidate, mapCandidate, reject, prepareViews, identify, pick,
    setSettings: (patch: Partial<AutoToothSettings>) => { if (!busy) setSettings(current => ({ ...current, ...patch })); },
    setPatientRight: (value: 'image-left' | 'image-right') => { if (!busy) { setPatientRight(value); const current = currentProposal.current; if (current) write({ ...current, mappings: current.mappings.filter(mapping => mapping.source === 'user'), possibleMissing: [], model: null }); } },
    cancel: () => { stop(); setNotice('Automatic operation cancelled. Reviewed labels are unchanged.'); },
  };
}
