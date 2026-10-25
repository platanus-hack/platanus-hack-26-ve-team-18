import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Vector3 } from 'three';
import { partMatrix } from './pose';
import { buildAssistantSnapshot, type AssistantSnapshotInput } from './assistant-context';
import { renderToothViews } from './auto-tooth-views';
import { renderCasePlanningViews } from './case-planning-views';
import type { AutoToothView } from './auto-tooth-types';
import type { CasePlanningRequest, CasePlanningResult } from './case-planning-types';
import type { ModelPart } from './models';
import type { CasePreparationResult, CasePreparationRequest, CasePreparationResponse, PreparedCaseSource } from './case-preparation-types';
import { localPlanningResult, type IdentityDecisions, type IdentityRegions } from './draft-workflow';
import { planningPreparationEvidence } from './planning-preparation';
import { casePlanningOutputSchema, planningExecutionSchema } from './case-planning-schema';
import { ANTHROPIC_MODELS, DEFAULT_IDENTIFICATION_MODEL, isAnthropicModelId } from './anthropic-models';
import { prepareTomographyEvidence, type AssistantTomographySource } from './tomography-evidence';
import { readPlanningEvents, type PlanningActivity } from './planning-events';

export type { PreparedCaseSource } from './case-preparation-types';
export interface PreparedEvidence {
  sources: PreparedCaseSource[];
  views: CasePlanningRequest['views'];
  revision: string;
}
const readable = (error: unknown) => error instanceof Error ? error.message : String(error);
/** Concepts do not change the original arch-pair observations used by assessment. */
const collisionEvidenceKey = (context: AssistantSnapshotInput) => {
  const ids = new Set(context.parts.filter(part => !part.restoration).map(part => part.id));
  const pairs = context.report?.pairs.filter(pair => ids.has(pair.a) && ids.has(pair.b));
  return JSON.stringify([context.tolerance, context.fitRadius, context.fitSummary, pairs ?? null]);
};

/** Local detection is automatic. External assessment is one explicit patient-case operation. */
export function useCasePlanning(parts: ModelPart[], context: AssistantSnapshotInput, blocked: boolean, reviewedLabels: Record<string, Uint8Array> = {}, reviewedMask: Record<string, Uint8Array> = {}, options: { identityDecisions?: IdentityDecisions; identityRegions?: IdentityRegions; biteReviewed?: boolean; confidenceThreshold?: number; measurementContext?: CasePlanningRequest['measurementContext']; tomography?: { source: RefObject<AssistantTomographySource | undefined>; sharing: boolean } } = {}) {
  const [evidence, setEvidence] = useState<PreparedEvidence | null>(null);
  const [prepared, setPrepared] = useState<CasePreparationResult | null>(null);
  const [result, setResult] = useState<CasePlanningResult | null>(null);
  const [stage, setStage] = useState('');
  const [activity, setActivity] = useState<PlanningActivity[]>([]);
  const [error, setError] = useState('');
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [model, setModel] = useState<string>(DEFAULT_IDENTIFICATION_MODEL);
  const [defaultModel, setDefaultModel] = useState<string>(DEFAULT_IDENTIFICATION_MODEL);
  const modelChosen = useRef(false);
  const modelLabel = ANTHROPIC_MODELS.find(option => option.id === model)?.label ?? model;
  const [patientRight, setPatientRight] = useState<'image-left' | 'image-right' | null>(null);
  const [retry, setRetry] = useState(0);
  const worker = useRef<Worker | null>(null);
  const request = useRef<AbortController | null>(null);
  const assessmentBasis = useRef<string | null>(null);
  const restoredBasisResult = useRef<CasePlanningResult | null>(null);
  const imageRequest = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const buffers = useRef(new WeakMap<object, number>());
  const bufferId = (value: object | undefined) => { if (!value) return 0; const known = buffers.current.get(value); if (known) return known; const id = ++bufferCounter.current; buffers.current.set(value, id); return id; };
  const bufferCounter = useRef(0);
  const sourceKey = parts.map(part => JSON.stringify([part.id, part.role, part.roleSource, bufferId(part.positions), bufferId(part.tissueScores), bufferId(part.colors), bufferId(part.uvs), part.textureStatus, bufferId(part.texture?.bytes), part.pose, part.offset, part.rotation])).join('|');
  const sourceIds = parts.map(part => part.id).join('|');
  const orientationKey = parts.filter(part => part.role === 'upper' || part.role === 'lower').map(part => `${part.id}:${part.role}:${bufferId(part.positions)}`).join('|');
  const previousOrientation = useRef(orientationKey);
  const orientationEvidence = useRef<PreparedCaseSource[]>([]);
  const orientationOverviewPartId = useRef<string | null>(null);
  const previousIds = useRef(sourceIds);
  const annotationKey = JSON.stringify(context.teeth) + Object.entries(reviewedLabels).map(([id, labels]) => `${id}:${bufferId(labels)}`).join('|') + Object.entries(reviewedMask).map(([id, labels]) => `${id}:${bufferId(labels)}`).join('|') + Object.entries(context.counts).map(([fdi, count]) => `${fdi}:${count}`).join('|') + JSON.stringify(options.identityDecisions ?? {}) + Object.entries(options.identityRegions ?? {}).map(([key, faces]) => `${key}:${bufferId(faces)}`).join('|') + !!options.biteReviewed;
  const restoring = useRef<{ evidence: PreparedEvidence | null; result: CasePlanningResult | null; prepared?: CasePreparationResult | null; model?: string; patientRight: 'image-left' | 'image-right' | null } | null>(null);
  const measurementKey = JSON.stringify(options.measurementContext ?? null);
  const latest = useRef({ parts, context, measurementKey }); latest.current = { parts, context, measurementKey };
  const cancel = useCallback(() => { generation.current++; worker.current?.terminate(); worker.current = null; request.current?.abort(); request.current = null; imageRequest.current?.abort(); imageRequest.current = null; setStage(''); setActivity(current => current.map(item => item.phase === 'running' ? { ...item, phase: 'error', output: { status: 'cancelled', reason: 'Work cancelled or evidence changed.' } } : item)); }, []);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/planning/status', { signal: controller.signal }).then(response => response.ok ? response.json() : null).then(status => {
      if (controller.signal.aborted) return;
      setConfigured(status?.configured === true);
      if (typeof status?.model === 'string' && status.model) {
        setDefaultModel(status.model);
        if (!modelChosen.current) setModel(status.model);
      }
    }).catch(() => { if (!controller.signal.aborted) setConfigured(false); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    cancel();
    if (restoring.current) { const saved = restoring.current; if (patientRight === saved.patientRight) restoring.current = null; setEvidence(saved.evidence); setResult(saved.result); setPrepared(saved.prepared ?? null); setPatientRight(saved.patientRight); if (saved.model && (isAnthropicModelId(saved.model) || saved.model === defaultModel)) { modelChosen.current = true; setModel(saved.model); } previousOrientation.current = orientationKey; orientationEvidence.current = saved.evidence?.sources ?? []; const overview = saved.evidence?.views[0]; orientationOverviewPartId.current = overview?.context === 'arch' && overview.sourceId ? parts[Number(overview.sourceId.slice(5)) - 1]?.id ?? null : null; setError(''); return; }
    restoredBasisResult.current = null; assessmentBasis.current = null; setEvidence(null); setResult(null); setPrepared(null); setError(''); setActivity([]);
    if (previousOrientation.current !== orientationKey) { previousOrientation.current = orientationKey; orientationEvidence.current = []; orientationOverviewPartId.current = null; previousIds.current = sourceIds; setPatientRight(null); }
    if (blocked || !parts.some(part => part.role === 'upper' || part.role === 'lower')) return;
    const current = generation.current;
    const expectedRevision = `case-${crypto.randomUUID()}`;
    let disposed = false;
    const timer = setTimeout(() => {
      if (disposed || current !== generation.current) return;
      const preparationStarted = performance.now();
      setStage('Scanning tooth geometry and mapped colour…');
      const instance = new Worker(new URL('./case-evidence.worker.ts', import.meta.url), { type: 'module' }); worker.current = instance;
      const timeout = setTimeout(() => { instance.terminate(); if (!disposed && current === generation.current) { setError('Detection exceeded its local time budget. Split or simplify the scans and retry.'); setStage(''); } }, 90_000);
      const finish = () => { clearTimeout(timeout); instance.terminate(); if (worker.current === instance) worker.current = null; };
      instance.onerror = () => { finish(); if (!disposed && current === generation.current) { setError('Local detection stopped. Try a smaller scan.'); setStage(''); } };
      instance.onmessage = async event => {
        finish();
        if (disposed || current !== generation.current) return;
        if (event.data.error) { setError(event.data.error); setStage(''); return; }
        try {
          const rendering = new AbortController(); imageRequest.current = rendering;
          setStage('Preparing mapped surface and bite views…');
          const response: CasePreparationResponse = event.data;
          if ('error' in response) throw new Error(response.error);
          if (response.id !== current || response.revision !== expectedRevision) throw new Error('Local preparation returned stale dependency evidence. Retry preparation.');
          const sources = response.scans;
          // Geometry is useful even if a WebGL image renderer fails. Keep it locally.
          setPrepared({ ...response, durationMs: performance.now() - preparationStarted }); setEvidence({ sources, views: [], revision: response.revision });
          orientationEvidence.current = sources;
          orientationOverviewPartId.current = null;
          const views: CasePlanningRequest['views'] = [];
          const renderedBySource = new Map<string, AutoToothView[]>();
          // Cover both arches before spending the image budget on extra components.
          const firstPerArch = ['upper', 'lower'].flatMap(arch => {
            const source = sources.find(source => parts.find(part => part.id === source.partId)?.role === arch);
            return source ? [source] : [];
          });
          const viewSources = [...firstPerArch, ...sources.filter(source => !firstPerArch.includes(source))];
          // One overview per source first. The bound prevents giant, unreviewable uploads.
          for (const source of viewSources.slice(0, 6)) {
            if (disposed || current !== generation.current) return;
            const part = parts.find(part => part.id === source.partId)!;
            const rendered = await renderToothViews(part, source.scan, rendering.signal);
            if (disposed || current !== generation.current || rendering.signal.aborted) return;
            renderedBySource.set(source.partId, rendered);
            const sourceId = `scan-${parts.indexOf(part) + 1}`;
            if (rendered[0]) views.push({ ...rendered[0], label: `Surface overview · ${rendered[0].label}`.slice(0, 80), id: `view-${views.length + 1}`, sourceId, context: 'arch' });
          }
          const whole = await renderCasePlanningViews(parts, rendering.signal);
          if (disposed || current !== generation.current || rendering.signal.aborted) return;
          for (const view of whole.slice(0, 2)) if (views.length < 8) views.push({ ...view, label: `Posed arches · ${view.label}`.slice(0, 80), id: `view-${views.length + 1}`, sourceId: null, context: 'occlusion' });
          // The two oblique sides expose posterior regions hidden from +u alone.
          for (const viewIndex of [1, 2]) for (const source of viewSources) {
            if (views.length >= 8) break;
            const part = parts.find(part => part.id === source.partId)!;
            const rendered = renderedBySource.get(source.partId);
            if (rendered?.[viewIndex]) views.push({ ...rendered[viewIndex], label: `Candidate regions · ${rendered[viewIndex].label}`.slice(0, 80), id: `view-${views.length + 1}`, sourceId: `scan-${parts.indexOf(part) + 1}`, context: 'arch' });
          }
          if (disposed || current !== generation.current) return;
          if (imageRequest.current === rendering) imageRequest.current = null;
          const overview = views[0];
          orientationOverviewPartId.current = overview?.context === 'arch' && overview.sourceId ? parts[Number(overview.sourceId.slice(5)) - 1]?.id ?? null : null;
          setPrepared({ ...response, durationMs: performance.now() - preparationStarted }); setEvidence({ sources, views, revision: response.revision }); setStage('');
        } catch (error) { if (!disposed && current === generation.current) { setError(readable(error)); setStage(''); } }
      };
      // Confirmation refers to the displayed overview, which can differ from import order.
      const first = orientationEvidence.current.find(source => source.partId === orientationOverviewPartId.current);
      const firstPart = parts.find(part => part.id === first?.partId);
      const right = first && first.scan.method !== 'unavailable' && firstPart && patientRight ? new Vector3(...first.scan.frame.u).transformDirection(partMatrix(firstPart)).multiplyScalar(patientRight === 'image-right' ? 1 : -1) : null;
      const sides: CasePreparationRequest['patientRight'] = {};
      for (const source of orientationEvidence.current) {
        const part = parts.find(part => part.id === source.partId);
        const alignment = part && right ? new Vector3(...source.scan.frame.u).transformDirection(partMatrix(part)).dot(right) : 0;
        sides[source.partId] = Math.abs(alignment) > .5 ? alignment > 0 ? 'image-right' : 'image-left' : null;
      }
      const sources: CasePreparationRequest['sources'] = parts.flatMap(part => {
        if (part.role !== 'upper' && part.role !== 'lower') return [];
        const labels = reviewedLabels[part.id]?.slice() ?? new Uint8Array(part.triangles), mask = reviewedMask[part.id]?.slice() ?? new Uint8Array(part.triangles);
        const identityCorrections: NonNullable<CasePreparationRequest['sources'][number]['identityCorrections']> = [];
        for (const [key, fdi] of Object.entries(options.identityDecisions ?? {})) {
          if (!key.startsWith(`${part.id}:C`)) continue;
          const faces = options.identityRegions ? options.identityRegions[key] : orientationEvidence.current.find(source => source.partId === part.id)?.scan.candidates.find(candidate => key === `${part.id}:C${candidate.id}`)?.faces;
          if (faces?.length) identityCorrections.push({ fdi, faces: [...faces] });
        }
        return [{ id: part.id, arch: part.role, roleConfirmed: part.roleSource !== 'filename-hypothesis', positions: part.positions.slice(), tissueScores: part.tissueScores?.slice(), pose: partMatrix(part).toArray(), reviewedLabels: labels, reviewedMask: mask, identityCorrections }];
      });
      const payload: CasePreparationRequest = { id: current, revision: expectedRevision, sources, patientRight: sides, chart: context.teeth, poseVerified: options.biteReviewed === true, confidenceThreshold: options.confidenceThreshold };
      instance.postMessage(payload);
    }, 450);
    return () => { disposed = true; clearTimeout(timer); cancel(); };
  }, [sourceKey, annotationKey, blocked, retry, patientRight, cancel]);
  useEffect(() => () => cancel(), [cancel]);
  useEffect(() => {
    if (restoredBasisResult.current) {
      if (result !== restoredBasisResult.current) return;
      if (!context.report && parts.filter(part => part.visible && part.role !== 'bite').length >= 2) return;
      assessmentBasis.current = collisionEvidenceKey(context); restoredBasisResult.current = null; return;
    }
    if (!result || result.model === 'local-geometry') { assessmentBasis.current = null; return; }
    const key = collisionEvidenceKey(context);
    if (assessmentBasis.current === null) { assessmentBasis.current = key; return; }
    // Wait for the replacement report during an ordinary analysis update.
    if (!context.report && context.analysisState === 'running') return;
    if (assessmentBasis.current !== key) { setResult(null); assessmentBasis.current = null; setError('Assessment measurements changed. The prior assessment remains in case history; resume locally or explicitly run a new AI assessment.'); }
  }, [result, context.report, context.tolerance, context.fitRadius, context.fitSummary, context.analysisState]);

  async function analyze(): Promise<CasePlanningResult | null> {
    if (!evidence || !prepared || stage || request.current || blocked) return null;
    if (configured !== true || !evidence.views.length) { setError(configured !== true ? 'AI generation is unavailable. Configure the planning provider or choose Start local workflow.' : 'AI generation needs current scan views. Retry preparation or choose Start local workflow.'); return null; }
    const current = generation.current;
    const captured = latest.current;
    setError(''); setActivity([]); setStage(`${modelLabel} is identifying surfaces and drafting the patient plan…`);
    const controller = new AbortController(); request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 95_000);
    try {
      const tomographySource = options.tomography?.sharing ? options.tomography.source.current : undefined;
      const tomographyRevision = tomographySource?.revision;
      const tomographyEvidence = tomographySource ? await prepareTomographyEvidence(tomographySource, true, controller.signal) : undefined;
      const firstView = evidence.views[0];
      const firstPart = firstView?.context === 'arch' && firstView.sourceId ? parts[Number(firstView.sourceId.slice(5)) - 1] : undefined;
      const first = evidence.sources.find(source => source.partId === firstPart?.id);
      if (!first || !firstPart || first.scan.method === 'unavailable') throw new Error('The first overview has no usable arch orientation. Retry local preparation or correct the scan role.');
      const right = patientRight ? new Vector3(...first.scan.frame.u).transformDirection(partMatrix(firstPart)).multiplyScalar(patientRight === 'image-right' ? 1 : -1) : null;
      const sources: CasePlanningRequest['sources'] = evidence.sources.map(source => {
        const part = parts.find(part => part.id === source.partId)!;
        const hasView = evidence.views.some(view => view.sourceId === `scan-${parts.indexOf(part) + 1}`);
        const direction = !right || !hasView || source.scan.method === 'unavailable' || first.scan.method === 'unavailable' ? 0 : new Vector3(...source.scan.frame.u).transformDirection(partMatrix(part)).dot(right);
        return { id: `scan-${parts.indexOf(part) + 1}`, arch: part.role as 'upper' | 'lower', roleConfirmed: part.roleSource !== 'filename-hypothesis', triangles: part.triangles, texture: part.textureStatus ?? (part.colors ? 'vertex-colors' : 'none'), patientRight: Math.abs(direction) > 0.5 ? direction > 0 ? 'image-right' : 'image-left' : null, candidates: source.scan.candidates.map(candidate => ({ id: candidate.id, triangles: candidate.faces.length, area: candidate.area, height: candidate.height, warnings: candidate.warnings.slice(0, 8).map(warning => warning.slice(0, 240)) })) };
      });
      const payload: CasePlanningRequest = { ...(isAnthropicModelId(model) ? { model } : {}), revision: evidence.revision, snapshot: buildAssistantSnapshot(captured.context), sources, views: evidence.views, ...(tomographyEvidence ? { tomography: tomographyEvidence } : {}),
        preparation: planningPreparationEvidence(prepared, parts, options.confidenceThreshold, { labels: reviewedLabels, reviewedMask, teeth: captured.context.teeth }),
        ...(options.measurementContext ? { measurementContext: options.measurementContext } : {}) };
      const response = await fetch('/api/planning/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify(payload), signal: controller.signal });
      let body: any;
      if (response.ok && response.headers?.get('content-type')?.includes('application/x-ndjson')) {
        if (!response.body) throw new Error('AI process stream is unavailable.');
        let complete = false;
        await readPlanningEvents(response.body, event => {
          if (controller.signal.aborted || current !== generation.current) return;
          if (event.type === 'started' && event.revision !== evidence.revision) throw new Error('AI process belongs to older evidence.');
          if (event.type === 'tool') {
            setActivity(items => [...items.filter(item => item.id !== event.activity.id), event.activity].slice(-96));
            setStage(`${modelLabel} · ${event.activity.name} · ${event.activity.phase === 'running' ? 'working' : event.activity.phase === 'error' ? 'needs review' : 'returned evidence'}`);
          }
          if (event.type === 'error') throw new Error(event.error);
          if (event.type === 'result') { body = event.result; complete = true; }
        }, controller.signal);
        if (!complete) throw new Error('AI process ended before returning a complete plan.');
      } else body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Case assessment failed.');
      if (controller.signal.aborted || current !== generation.current) return null;
      if (captured.parts !== latest.current.parts || ['teeth', 'counts', 'report', 'analysisState', 'tolerance', 'fitSummary', 'fitRadius'].some(key => captured.context[key as keyof AssistantSnapshotInput] !== latest.current.context[key as keyof AssistantSnapshotInput])) throw new Error('Case evidence changed during assessment. Review the latest evidence and run again.');
      if (captured.measurementKey !== latest.current.measurementKey) throw new Error('Ruler, calibration or bite-review evidence changed during assessment. Review the latest measurements and run again.');
      if (tomographyRevision !== (options.tomography?.sharing ? options.tomography.source.current?.revision : undefined)) throw new Error('Tomography views or registration changed during assessment. Retry with the current views.');
      if (body.revision !== evidence.revision) throw new Error('The assessment belongs to an older case revision.');
      const validated = casePlanningOutputSchema.parse({ summary: body.summary, mappings: body.mappings, findings: body.findings, actions: body.actions, designs: body.designs, limitations: body.limitations });
      if (typeof body.model !== 'string') throw new Error('Assessment model attribution is missing.');
      const assessment: CasePlanningResult = { ...validated, revision: evidence.revision, model: body.model, ...(body.execution ? { execution: planningExecutionSchema.parse(body.execution) } : {}) };
      assessmentBasis.current = collisionEvidenceKey(captured.context);
      setResult(assessment);
      return assessment;
    } catch (error) { if (current === generation.current) { setError(controller.signal.aborted ? 'AI assessment timed out. Existing work is retained; retry AI or choose Start local workflow.' : `${readable(error)} Existing work is retained; retry AI or choose Start local workflow.`); } return null; }
    finally { clearTimeout(timeout); if (request.current === controller) { request.current = null; setStage(''); } }
  }
  return {
    evidence, prepared, result, activity, stage, busy: !!stage, error, configured, model, defaultModel, modelLabel,
    setModel: (value: string) => {
      if (stage || request.current || blocked || (!isAnthropicModelId(value) && value !== defaultModel)) return;
      modelChosen.current = true; setModel(value); setError('');
    },
    patientRight, setPatientRight: (value: 'image-left' | 'image-right' | null) => {
      if (request.current) { generation.current++; request.current.abort(); request.current = null; setStage(''); }
      setPatientRight(value); setResult(null); setError('');
    }, analyze, analyzeLocal: () => { if (!prepared || blocked || request.current || stage) return null; const local = localPlanningResult(prepared, parts); setError(''); setActivity([]); setResult(local); return local; }, cancel, invalidate: (reason: string) => { cancel(); setResult(null); setError(reason); }, restore: (saved: { evidence: PreparedEvidence | null; result: CasePlanningResult | null; prepared?: CasePreparationResult | null; model?: string; patientRight: 'image-left' | 'image-right' | null }) => { restoring.current = saved; assessmentBasis.current = null; restoredBasisResult.current = saved.result; cancel(); setActivity([]); setRetry(value => value + 1); }, prepare: () => setRetry(value => value + 1),
  };
}
