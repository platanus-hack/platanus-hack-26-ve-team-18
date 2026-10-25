import { useEffect, useMemo, useRef, useState } from 'react';
import { partMatrix } from './pose';
import type { ModelPart } from './models';
import type { RestorationAssembly, RestorationMesh, RestorationParameters, RestorationSpec, RestorationFitResult } from './restoration-types';
import type { ToothCase } from './tooth-types';
import type { PreparedCaseSource } from './useCasePlanning';
import { MAX_WORKSPACE_PARTS, MAX_WORKSPACE_TRIANGLES } from './import-models';
import { toothArch } from './teeth';
import type { SiteHypothesis } from './missing-sites';
import { specForAIGeneration, specForHypothesis } from './workflow-geometry';
import type { RestorationGenerationDesign, RestorationGenerationRequest } from './restoration-generation';
import { planningConceptCase, type ProposedConceptSite } from './planning-concepts';
import { WORKFLOW_BUDGET } from './case-workflow';
import { conceptKey } from './planning-automation';
import { restorationPly } from './restoration-export';
import { applyRestorationEdit, restorationEditRevision, type RestorationEdit } from './restoration-edit';
import { restorationCrownShape, validateRestorationSpec } from './restoration-geometry';
import { restorationPlacementFeedbackSchema } from './restoration-quality-schema';
import type { RestorationPlacementFeedback } from './restoration-guardrails';
import { assertAgentEditPreservesEvidence } from './restoration-edit-policy';
import { generatedCrownTargetId, generatedFitTargetIds, restorationCrownParts, restorationFitParts, type GeneratedCrownPart } from './restoration-fit-targets';
import { withCrownEnamel } from './crown-enamel.ts';

const download = (content: string, name: string, type: string) => { const url = URL.createObjectURL(new Blob([content], { type })); const link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
type SiteIdentity = { fdi: number; siteId?: string; draftIdentity?: RestorationSpec['draftIdentity'] };
type SiteReadiness = SiteIdentity & { status: 'ready' | 'needs-input' | 'generated'; detail: string };
interface PartEvidence {
  id: string; positions: Float32Array; normals: Float32Array; labels: Uint8Array | undefined; reviewedMask: Uint8Array | undefined; tissue: Float32Array | undefined;
  role: ModelPart['role']; sourceFileId: string | undefined; triangles: number; vertices: number; pose: number[]; transform: string;
  targetId: string | undefined;
}
interface EvidenceSnapshot {
  fdis: number[]; sourceIds: string[]; parts: PartEvidence[]; record: string; parentId?: string;
  targetIds: string[];
  targetAssessmentRevision?: string | null;
}
interface ConceptBasis { evidence: EvidenceSnapshot; hypothesisRevision: string | null; site?: SiteHypothesis }
interface Generation {
  token: number; fdis: number[]; keys: string[]; hypotheses: Set<string>; hypothesisRevision: string | null;
  evidence: EvidenceSnapshot; jobKeys: string[];
  edit?: { id: string; expectedRevision: string; signal?: AbortSignal; operation: 'edit' | 'recheck' };
}
const siteIdentity = (spec: RestorationSpec): SiteIdentity => ({ fdi: spec.fdi,
  ...(spec.draftIdentity ? { siteId: spec.draftIdentity.siteId, draftIdentity: spec.draftIdentity } : {}) });
const EVIDENCE_CHANGED = 'Concept evidence changed. Review the latest surfaces and generate again.';
const HYPOTHESIS_CHANGED = 'The AI assessment or orientation changed. Prepare a current draft before generating this hypothesis.';
const recordKey = (fdis: number[], teeth: ToothCase) => JSON.stringify(Object.entries(teeth.teeth).filter(([code]) => fdis.some(fdi => toothArch(Number(code)) === toothArch(fdi))).map(([code, record]) => [code, record.status, record.restoration, record.site ?? null]));
const sourceParts = (parts: ModelPart[], _fdis: number[]) => parts.filter(part => !part.restoration && (part.role === 'upper' || part.role === 'lower'));
const transformKey = (part: ModelPart) => JSON.stringify([part.pose ?? null, part.rotation ?? null, part.offset]);
const sameMatrix = (a: number[], b: number[]) => a.length === b.length && a.every((value, index) => Number.isFinite(value) && Number.isFinite(b[index]) && Math.abs(value - b[index]) <= 1e-9 * Math.max(1, Math.abs(value), Math.abs(b[index])));

function snapshotEvidence(parts: ModelPart[], teeth: ToothCase, fdis: number[], partIds?: string[], parentId?: string, targetIds?: string[], assessmentRevision: string | null = null): EvidenceSnapshot {
  // Geometry and reviewed label buffers are immutable. Completed concepts compare
  // poses relative to their parent; pending jobs compare absolute request poses.
  const sources = sourceParts(parts, fdis), ids = new Set(partIds ?? sources.map(part => part.id));
  if (parentId) ids.add(parentId);
  if (targetIds) for (const part of parts) if (targetIds.includes(generatedCrownTargetId(part) ?? '')) ids.add(part.id);
  const crowns = parts.filter(part => ids.has(part.id) && generatedCrownTargetId(part)) as GeneratedCrownPart[];
  // A target crown also depends on its own arch's chart and, where applicable,
  // assessment. Stale pair reports alone do not invalidate unchanged geometry.
  fdis = [...new Set([...fdis, ...crowns.map(part => part.fitTarget.fdi
    ?? (parts.find(source => source.id === part.restoration!.parentPartId)?.role === 'upper' ? 11 : 31))])];
  const parent = parentId ? parts.find(part => part.id === parentId) : undefined;
  const inverse = parent ? partMatrix(parent).invert() : null;
  return {
    fdis, sourceIds: sources.map(part => part.id).sort(), record: recordKey(fdis, teeth), parentId,
    targetIds: targetIds ?? parts.filter(part => ids.has(part.id)).flatMap(part => generatedCrownTargetId(part) ?? []),
    ...(crowns.some(part => part.fitTarget.hypothesisDependent) ? { targetAssessmentRevision: assessmentRevision } : {}),
    parts: parts.filter(part => ids.has(part.id)).map(part => ({
      id: part.id, positions: part.positions, normals: part.normals, labels: teeth.labels[part.id], reviewedMask: teeth.reviewedMask?.[part.id], tissue: part.tissueScores,
      role: part.role, sourceFileId: part.sourceFileId, triangles: part.triangles, vertices: part.vertices,
      targetId: generatedCrownTargetId(part),
      pose: inverse ? inverse.clone().multiply(partMatrix(part)).toArray() : partMatrix(part).toArray(), transform: transformKey(part),
    })),
  };
}
function matchesEvidence(basis: EvidenceSnapshot, parts: ModelPart[], teeth: ToothCase, assessmentRevision: string | null): boolean {
  if (basis.targetAssessmentRevision !== undefined && basis.targetAssessmentRevision !== assessmentRevision) return false;
  if (basis.record !== recordKey(basis.fdis, teeth)) return false;
  const sourceIds = sourceParts(parts, basis.fdis).map(part => part.id).sort();
  if (sourceIds.length !== basis.sourceIds.length || sourceIds.some((id, index) => id !== basis.sourceIds[index])) return false;
  const targetIds = new Set(parts.filter(part => (part as Partial<GeneratedCrownPart>).fitTarget?.current).map(generatedCrownTargetId));
  if (basis.targetIds.some(id => !targetIds.has(id))) return false;
  const parent = basis.parentId ? parts.find(part => part.id === basis.parentId) : undefined;
  if (basis.parentId && !parent) return false;
  let poseChanged = false;
  for (const saved of basis.parts) {
    const part = parts.find(part => part.id === saved.id);
    if (!part || generatedCrownTargetId(part) !== saved.targetId || part.positions !== saved.positions || part.normals !== saved.normals || teeth.labels[part.id] !== saved.labels || teeth.reviewedMask?.[part.id] !== saved.reviewedMask || part.tissueScores !== saved.tissue || part.role !== saved.role || part.sourceFileId !== saved.sourceFileId || part.triangles !== saved.triangles || part.vertices !== saved.vertices) return false;
    if (saved.transform !== transformKey(part)) poseChanged = true;
  }
  // Note and presentation edits need no mesh-bound traversal for rotation pivots.
  if (!poseChanged) return true;
  const inverse = parent ? partMatrix(parent).invert() : null;
  return basis.parts.every(saved => {
    const part = parts.find(part => part.id === saved.id)!;
    const pose = inverse ? inverse.clone().multiply(partMatrix(part)).toArray() : partMatrix(part).toArray();
    return sameMatrix(saved.pose, pose);
  });
}
function selectTargetEvidence(basis: EvidenceSnapshot, sourceFdis: number[], targetIds: string[], parts: ModelPart[]): EvidenceSnapshot {
  const ids = new Set(targetIds), crowns = parts.filter(part => ids.has(generatedCrownTargetId(part) ?? '')) as GeneratedCrownPart[];
  const fdis = [...new Set([...sourceFdis, ...crowns.map(part => part.fitTarget.fdi
    ?? (parts.find(source => source.id === part.restoration!.parentPartId)?.role === 'upper' ? 11 : 31))])];
  const records = JSON.parse(basis.record) as [string, ...unknown[]][];
  return { ...basis, fdis, targetIds,
    record: JSON.stringify(records.filter(([code]) => fdis.some(fdi => toothArch(Number(code)) === toothArch(fdi)))),
    parts: basis.parts.filter(part => !part.targetId || ids.has(part.targetId)),
    targetAssessmentRevision: crowns.some(part => part.fitTarget.hypothesisDependent) ? basis.targetAssessmentRevision : undefined,
  };
}
const mergeReadiness = (current: SiteReadiness[], updates: SiteReadiness[]) => [...current.filter(site => !updates.some(update => conceptKey(update) === conceptKey(site))), ...updates].sort((a, b) => a.fdi - b.fdi || conceptKey(a).localeCompare(conceptKey(b)));

export function useRestorations(parts: ModelPart[], teeth: ToothCase, hypothesisRevision: string | null = null) {
  const [assemblies, setAssemblies] = useState<RestorationAssembly[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ phase: 'creating' | 'fitting'; detail: string } | null>(null);
  const [error, setError] = useState('');
  const [siteReadiness, setSiteReadiness] = useState<SiteReadiness[]>([]);
  const [restoreEpoch, setRestoreEpoch] = useState(0);
  const worker = useRef<Worker | null>(null), revision = useRef(0);
  const latest = useRef({ parts, assemblies, teeth, hypothesisRevision }); latest.current = { parts, assemblies, teeth, hypothesisRevision };
  const bases = useRef(new Map<string, ConceptBasis>());
  const active = useRef<Generation | null>(null);
  const restoringAssemblies = useRef<{assemblies: RestorationAssembly[]; hypothesisRevision: string | null} | null>(null);
  const currentSites = useRef<SiteHypothesis[]>([]);
  const currentScans = useRef<PreparedCaseSource[]>([]);
  const abortPending = useRef<((reason?: string) => void) | null>(null);
  const cancel = (reason = 'Concept generation cancelled. Generate again when ready.') => {
    const pending = active.current;
    revision.current++; active.current = null; abortPending.current?.(reason); worker.current?.terminate(); worker.current = null; setBusy(false);
    if (pending) {
      setError(reason);
      setSiteReadiness(current => current.map(site => pending.keys.includes(conceptKey(site)) && site.status !== 'generated' ? { ...site, status: 'needs-input', detail: reason } : site));
    }
  };
  const evidenceParts = () => [...latest.current.parts, ...restorationCrownParts(latest.current.parts, latest.current.assemblies)];
  const validBasis = (basis: ConceptBasis) => (basis.hypothesisRevision === null || basis.hypothesisRevision === latest.current.hypothesisRevision) && matchesEvidence(basis.evidence, evidenceParts(), latest.current.teeth, latest.current.hypothesisRevision);
  useEffect(() => {
    if (restoringAssemblies.current) {
      if (restoringAssemblies.current.hypothesisRevision !== hypothesisRevision) return;
      if (restoringAssemblies.current.assemblies.some(assembly => !parts.some(part => part.id === assembly.spec.parentPartId))) return;
      for (const assembly of restoringAssemblies.current.assemblies.filter(assembly => !assembly.warnings.some(warning => warning.startsWith('STALE:')))) {
        bases.current.set(assembly.id, {
          evidence: snapshotEvidence(evidenceParts(), teeth, [assembly.spec.fdi], sourceParts(parts, [assembly.spec.fdi]).map(part => part.id), assembly.spec.parentPartId, generatedFitTargetIds(assembly.fit), hypothesisRevision),
          hypothesisRevision: assembly.draftSite || assembly.spec.draftIdentity || assembly.warnings.some(warning => warning.startsWith('AI-proposed missing-site hypothesis.')) || assembly.spec.source.startsWith('AI-proposed missing-site hypothesis.') ? restoringAssemblies.current.hypothesisRevision : null,
          site: currentSites.current.find(site => conceptKey(site) === conceptKey(assembly.spec)),
        });
      }
      restoringAssemblies.current = null;
    }
    const pending = active.current;
    if (pending && !matchesEvidence(pending.evidence, evidenceParts(), teeth, hypothesisRevision)) cancel(EVIDENCE_CHANGED);
    else if (pending?.hypotheses.size && pending.hypothesisRevision !== hypothesisRevision) {
      setSiteReadiness(current => current.map(site => pending.hypotheses.has(conceptKey(site)) ? { ...site, status: 'needs-input', detail: HYPOTHESIS_CHANGED } : site));
      if (pending.keys.every(key => pending.hypotheses.has(key))) cancel(HYPOTHESIS_CHANGED);
      else if (pending.jobKeys.length && pending.jobKeys.every(key => pending.hypotheses.has(key))) abortPending.current?.(HYPOTHESIS_CHANGED);
    }
    const invalid = new Map<string, string>();
    for (const assembly of latest.current.assemblies) {
      const basis = bases.current.get(assembly.id);
      if (basis && !validBasis(basis)) {
        invalid.set(assembly.id, basis && basis.hypothesisRevision !== null && basis.hypothesisRevision !== hypothesisRevision ? HYPOTHESIS_CHANGED : EVIDENCE_CHANGED);
        bases.current.delete(assembly.id);
      }
    }
    if (!invalid.size) return;
    const invalidSites = new Map(latest.current.assemblies.filter(assembly => invalid.has(assembly.id)).map(assembly => [conceptKey(assembly.spec), invalid.get(assembly.id)!]));
    setSiteReadiness(current => current.map(site => invalidSites.has(conceptKey(site)) ? { ...site, status: 'needs-input', detail: invalidSites.get(conceptKey(site))! } : site));
    const retained = latest.current.assemblies.map(assembly => invalid.has(assembly.id) ? { ...assembly, warnings: [...assembly.warnings.filter(warning => !warning.startsWith('STALE:')), `STALE: ${invalid.get(assembly.id)}`] } : assembly);
    latest.current.assemblies = retained; setAssemblies(retained);
    setSelectedId(current => current && invalid.has(current) ? null : current);
  }, [parts, teeth, hypothesisRevision, restoreEpoch, assemblies]);
  useEffect(() => () => { revision.current++; abortPending.current?.(); worker.current?.terminate(); bases.current.clear(); }, []);
  const displayParts = useMemo(() => {
    const shown = new Map<string, string>();
    for (const assembly of assemblies) if (!assembly.warnings.some(warning => warning.startsWith('STALE:'))) shown.set(conceptKey(assembly.spec), assembly.id);
    const selected = assemblies.find(assembly => assembly.id === selectedId);
    if (selected) shown.set(conceptKey(selected.spec), selected.id);
    return assemblies.flatMap(assembly => {
      const parent = parts.find(part => part.id === assembly.spec.parentPartId), stale = assembly.warnings.some(warning => warning.startsWith('STALE:'));
      return parent ? assembly.parts.map(part => ({ ...withCrownEnamel(part, assembly.spec, parts, teeth.labels), visible: part.visible && shown.get(conceptKey(assembly.spec)) === assembly.id, restoration: part.restoration ? { ...part.restoration, stale } : undefined, pose: partMatrix(parent).toArray() })) : [];
    });
  }, [assemblies, parts, selectedId, teeth.labels]);
  function assertCurrent(token: number, key?: string) {
    const pending = active.current;
    if (token !== revision.current || pending?.token !== token) throw new Error('Concept generation cancelled.');
    if (!matchesEvidence(pending.evidence, evidenceParts(), latest.current.teeth, latest.current.hypothesisRevision)) throw new Error(EVIDENCE_CHANGED);
    if (key !== undefined && pending.hypotheses.has(key) && pending.hypothesisRevision !== latest.current.hypothesisRevision) throw new Error(HYPOTHESIS_CHANGED);
    if (pending.edit) {
      if (pending.edit.signal?.aborted) throw new DOMException('Restoration edit cancelled.', 'AbortError');
      const assembly = latest.current.assemblies.find(item => item.id === pending.edit!.id);
      if (!assembly || restorationEditRevision(assembly) !== pending.edit.expectedRevision) throw new Error('The restoration revision changed. Read the current assembly before editing.');
    }
  }
  function runWorker<T>(createWorker: () => Worker, payload: object, token: number, bindTargets?: (ids: string[]) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      const instance = createWorker(); worker.current = instance;
      let settled = false;
      const finish = () => { settled = true; clearTimeout(timeout); instance.terminate(); if (worker.current === instance) worker.current = null; if (abortPending.current === abort) abortPending.current = null; };
      const abort = (reason = EVIDENCE_CHANGED) => { finish(); reject(new Error(reason)); };
      abortPending.current = abort;
      const timeout = setTimeout(() => { finish(); reject(new Error('Concept geometry timed out.')); }, 45_000);
      instance.onerror = () => { finish(); reject(new Error('Concept geometry stopped.')); };
      instance.onmessage = event => {
        if (settled || event.data.id !== token) return;
        if (event.data.type === 'targets') {
          try {
            if (!bindTargets || !Array.isArray(event.data.targetIds) || event.data.targetIds.some((id: unknown) => typeof id !== 'string')) throw new Error('Invalid fitting target evidence.');
            bindTargets(event.data.targetIds); assertCurrent(token);
          } catch (error) { finish(); reject(error); }
          return;
        }
        if (event.data.type === 'progress') {
          try { assertCurrent(token); } catch (error) { finish(); reject(error); return; }
          const site = currentSites.current.find(site => active.current?.jobKeys.includes(conceptKey(site)));
          const label = site?.draftIdentity ? `${site.arch === 'upper' ? 'Upper' : 'Lower'} draft site` : `FDI ${event.data.fdi}`;
          if (event.data.id === token) setProgress({ phase: event.data.phase, detail: `${label} · ${event.data.phase === 'creating' ? 'Constructing fixture, abutment and crown envelopes.' : 'Measuring bounded candidates against current surfaces.'}` });
          return;
        }
        finish(); try {
          if (event.data.type === 'result' && bindTargets) bindTargets(generatedFitTargetIds(event.data.result?.report));
          assertCurrent(token);
        } catch (error) { reject(error); return; } if (event.data.error) reject(new Error(event.data.error)); else if (event.data.type === 'cancelled') reject(new Error('Fitting cancelled.')); else resolve(event.data.result ?? event.data);
      };
      try { instance.postMessage({ id: token, ...payload }); } catch (error) { finish(); reject(error); }
    });
  }
  async function generate(spec: RestorationSpec, id: string, token: number, hypothesisRevision: string | null = null, candidateLimit: number = WORKFLOW_BUDGET.candidatesPerSite, savedSite?: SiteHypothesis, generationDesign?: RestorationGenerationDesign, goalContract?: import('./restoration-goals').RestorationGoalReport) {
    assertCurrent(token, conceptKey(spec));
    validateRestorationSpec(spec);
    setProgress({ phase: 'creating', detail: `${spec.draftIdentity ? `${spec.fdi < 30 ? 'Upper' : 'Lower'} draft site` : `FDI ${spec.fdi}`} · Preparing component geometry and target surfaces.` });
    const parent = latest.current.parts.find(part => part.id === spec.parentPartId);
    if (!parent || parent.role !== toothArch(spec.fdi)) throw new Error('The concept parent no longer matches its FDI arch.');
    const fitParts = restorationFitParts(spec, id, latest.current.parts, latest.current.assemblies);
    const requestTeeth = latest.current.teeth, requestAssessment = latest.current.hypothesisRevision, requestFdis = active.current!.fdis;
    const dependencyIds = fitParts.map(part => part.id);
    const requestEvidence = snapshotEvidence(fitParts, requestTeeth, requestFdis, dependencyIds, undefined, undefined, requestAssessment);
    const conceptEvidence = snapshotEvidence(fitParts, requestTeeth, [spec.fdi], dependencyIds, parent.id, undefined, requestAssessment);
    // Supplying a crown is not evidence that the worker's local crop uses it.
    // Keep scan fences active while preparation determines the actual targets.
    active.current!.evidence = selectTargetEvidence(requestEvidence, requestFdis, [], fitParts);
    const site = savedSite ?? currentSites.current.find(site => conceptKey(site) === conceptKey(spec));
    const basis: ConceptBasis = { evidence: selectTargetEvidence(conceptEvidence, [spec.fdi], [], fitParts), hypothesisRevision, site };
    if (!validBasis(basis)) throw new Error(HYPOTHESIS_CHANGED);
    active.current!.jobKeys = [conceptKey(spec)];
    const measuredTargets = new Set<string>();
    const bindTargets = (ids: string[]) => {
      if (active.current?.token !== token) throw new Error('Concept generation cancelled.');
      for (const targetId of ids) if (targetId.includes(':generated-crown:')) measuredTargets.add(targetId);
      // Always bind to the original request, even if the assessment changed
      // before preparation replied. Never bless an old target with a new token.
      active.current.evidence = selectTargetEvidence(requestEvidence, requestFdis, [...measuredTargets], fitParts);
      basis.evidence = selectTargetEvidence(conceptEvidence, [spec.fdi], [...measuredTargets], fitParts);
      if (!validBasis(basis)) throw new Error(EVIDENCE_CHANGED);
    };
    let editBaseline = active.current?.edit ? latest.current.assemblies.find(assembly => assembly.id === id) : undefined;
    if (editBaseline && active.current?.edit?.operation !== 'recheck' && spec.editProvenance?.actor === 'agent'
      && (!editBaseline.fit?.quality || !editBaseline.fit.goal || !editBaseline.fit.abutmentGingiva
        || !editBaseline.fit.goal.contract.rows.some(row => row.id === 'abutment-gingiva') || editBaseline.fit.after.surfaces.some(surface => !surface.intersectionComplete
        || surface.role === 'tissue' && (JSON.stringify(surface.sourceComponents) !== '["crown"]' || surface.sourceRegion !== 'crown-body')))) {
      // Missing or capped legacy evidence needs the same full-target audit as
      // the exact edit. Measure without committing or changing its anatomy.
      const baselineSpec = { ...editBaseline.spec, crownShape: restorationCrownShape(editBaseline.spec) };
      const baseline = await runWorker<RestorationFitResult>(() => new Worker(new URL('./restoration-fit.worker.ts', import.meta.url), { type: 'module' }),
        { type: 'prepare-fit', spec: baselineSpec, site, parts: fitParts, teeth: latest.current.teeth, scans: currentScans.current,
          goalContract: editBaseline.fit?.goal,
          options: { maxCandidates: 1, maxDurationMs: WORKFLOW_BUDGET.fitMsPerSite, samplesPerSurface: 120 } }, token, bindTargets);
      if (baseline.spec.componentDesign !== baselineSpec.componentDesign || baseline.history.length !== 1 || baseline.components.some(mesh => {
        const old = editBaseline!.parts.find(part => part.restoration?.component === mesh.component);
        return !old || old.positions.length !== mesh.positions.length || old.positions.some((value, index) => value !== mesh.positions[index]);
      })) throw new Error('The saved geometry differs from its current construction. Rebuild a comparison before agent editing.');
      editBaseline = { ...editBaseline, spec: baseline.spec, fit: baseline.report };
    }
    const result = await runWorker<RestorationFitResult>(() => new Worker(new URL('./restoration-fit.worker.ts', import.meta.url), { type: 'module' }), { type: 'prepare-fit', spec, site, parts: fitParts, teeth: requestTeeth, scans: currentScans.current, goalContract: goalContract ?? (spec.editProvenance?.actor === 'agent' ? editBaseline?.fit?.goal : undefined),
      ...(generationDesign ? { generationDesign } : {}), options: { maxCandidates: generationDesign ? 1 : candidateLimit, ...(generationDesign ? { verifyBaselineIntersections: true } : {}), maxDurationMs: WORKFLOW_BUDGET.fitMsPerSite, samplesPerSurface: 120 } }, token, bindTargets);
    if (result.spec.componentDesign !== spec.componentDesign) throw new Error('The worker changed the component construction profile.');
    if (active.current?.edit && (result.history.length !== 1
      || ['parameters', 'anatomy', 'contour', 'appearance', 'editProvenance', 'provenance', 'frame', 'fdi', 'parentPartId', 'draftIdentity', 'anatomicalSigns'].some(key => JSON.stringify(result.spec[key as keyof RestorationSpec]) !== JSON.stringify(spec[key as keyof RestorationSpec]))
      || (spec.crownShape && JSON.stringify(result.spec.crownShape) !== JSON.stringify(spec.crownShape))
      || JSON.stringify(result.spec.qualityContext?.placementFeedback) !== JSON.stringify(spec.qualityContext?.placementFeedback))) throw new Error('The edit worker changed requested values instead of measuring the exact candidate.');
    if (generationDesign && (result.history.length !== 1 || result.report.candidates !== 1 || result.report.candidateAttempts !== 1
      || JSON.stringify(result.history[0]?.parameters) !== JSON.stringify(spec.parameters)
      || ['parameters', 'anatomy', 'contour', 'appearance', 'editProvenance', 'provenance', 'frame', 'fdi', 'parentPartId', 'draftIdentity', 'anatomicalSigns', 'siteEvidence', 'units', 'version', 'source'].some(key => JSON.stringify(result.spec[key as keyof RestorationSpec]) !== JSON.stringify(spec[key as keyof RestorationSpec]))
      || result.spec.crownShape?.source.kind !== generationDesign.anatomySource
      || (spec.crownShape && JSON.stringify(result.spec.crownShape) !== JSON.stringify(spec.crownShape))
      || JSON.stringify(result.spec.qualityContext?.placementFeedback) !== JSON.stringify(spec.qualityContext?.placementFeedback))) throw new Error('The AI generation worker changed the authorized design instead of measuring the exact candidate.');
    spec = result.spec;
    validateRestorationSpec(spec);
    assertCurrent(token, conceptKey(spec));
    if (!validBasis(basis)) throw new Error(EVIDENCE_CHANGED);
    if (active.current?.edit?.operation === 'recheck' && result.components.some(mesh => {
      const old = editBaseline?.parts.find(part => part.restoration?.component === mesh.component);
      return !old || old.positions.length !== mesh.positions.length || old.positions.some((value, index) => value !== mesh.positions[index]);
    })) throw new Error('The current geometry no longer matches its construction. Rebuild a comparison before rechecking.');
    if (active.current?.edit?.operation === 'edit' && spec.editProvenance?.actor === 'agent') {
      if (!editBaseline) throw new Error('The restoration being edited is no longer available.');
      assertAgentEditPreservesEvidence(editBaseline, result);
    }
    const others = latest.current.assemblies.filter(assembly => assembly.id !== id);
    if (latest.current.parts.length + others.reduce((sum, assembly) => sum + assembly.parts.length, 0) + result.components.length > MAX_WORKSPACE_PARTS || latest.current.parts.reduce((sum, part) => sum + part.triangles, 0) + others.flatMap(assembly => assembly.parts).reduce((sum, part) => sum + part.triangles, 0) + result.components.reduce((sum, part) => sum + part.triangles, 0) > MAX_WORKSPACE_TRIANGLES) throw new Error('The workspace geometry budget is full. Remove a concept or simplify scans.');
    const label = spec.draftIdentity ? `${spec.fdi < 30 ? 'Upper' : 'Lower'} draft site` : `FDI ${spec.fdi}`;
    const previous = latest.current.assemblies.find(assembly => assembly.id === id);
    const meshParts: ModelPart[] = result.components.map(mesh => ({ id: `${id}-${mesh.component}`, fileName: `${spec.draftIdentity ? `draft-${id}` : `FDI-${spec.fdi}`}-${mesh.component}.ply`, name: `${label} · ${mesh.component === 'abutment' ? 'abutment / pilar' : mesh.component}`, positions: mesh.positions, normals: mesh.normals, triangles: mesh.triangles, vertices: mesh.vertices, closed: mesh.closed, dimensions: mesh.dimensions, offset: [0, 0, 0], visible: previous?.parts.find(part => part.restoration?.component === mesh.component)?.visible ?? true, role: 'model', presentationColor: spec.appearance?.[mesh.component]?.color ?? (mesh.component === 'fixture' ? '#94a3b8' : mesh.component === 'abutment' ? '#c4a46b' : '#f4ead7'), ...(spec.appearance?.[mesh.component]?.roughness !== undefined ? { presentationRoughness: spec.appearance[mesh.component]!.roughness } : {}), restoration: { assemblyId: id, component: mesh.component, parentPartId: spec.parentPartId } }));
    const previousVersions = previous ? [...(previous.previousVersions ?? []), { spec: previous.spec, fit: previous.fit, candidateHistory: previous.candidateHistory, createdAt: previous.createdAt, warnings: previous.warnings }].slice(-16) : undefined;
    const assembly: RestorationAssembly = { id, spec, draftSite: hypothesisRevision !== null, ...(previousVersions ? { previousVersions } : {}), parts: meshParts, fit: result.report, candidateHistory: result.history, createdAt: new Date(Math.max(Date.now(), previous ? Date.parse(previous.createdAt) + 1 : 0)).toISOString(), warnings: [...(hypothesisRevision !== null ? [`${spec.source.split('. ')[0]}. Saved tooth status and implant intent are unchanged.`] : []), 'Visual planning concept. Bone, manufacturer connection, internal fit, screw channel and manufacturing suitability remain unassessed.', 'Crown color approximates nearby scan colors when available, with illustrative enamel variation; this is not a calibrated dental shade match.', ...(spec.appearance ? ['Component color and roughness are display only; no dental shade matching or material selection is implied.'] : [])] };
    // Completed dependencies use the same captured request as pending work.
    basis.evidence = selectTargetEvidence(conceptEvidence, [spec.fdi], generatedFitTargetIds(result.report), fitParts);
    bases.current.set(id, basis);
    const retainOrder = (current: RestorationAssembly[]) => current.some(item => item.id === id)
      ? current.map(item => item.id === id ? assembly : item) : [...current, assembly];
    setAssemblies(retainOrder);
    // Editing a named component must not silently change the user's selection;
    // selection is independent evidence in the assistant's concurrency fence.
    if (!active.current?.edit) setSelectedId(id);
    // Update the budget reference between sequential sites without waiting for React.
    latest.current.assemblies = retainOrder(latest.current.assemblies);
    return assembly;
  }
  async function create(fdis: number[], teeth: ToothCase, scans: PreparedCaseSource[], proposals: ProposedConceptSite[] = [], sites: SiteHypothesis[] = [], aiDesigns?: RestorationGenerationRequest[]) {
    if (active.current) return;
    currentSites.current = sites; currentScans.current = scans;
    const requests = new Map<string, { identity: SiteIdentity; site?: SiteHypothesis }>();
    for (const fdi of new Set(fdis)) {
      const matching = sites.filter(site => site.fdi === fdi);
      if (!matching.length) requests.set(conceptKey({ fdi }), { identity: { fdi } });
      for (const site of matching) {
        const identity: SiteIdentity = { fdi, siteId: site.id,
          ...(site.draftIdentity ? { draftIdentity: { ...site.draftIdentity, siteId: site.id } } : {}) };
        requests.set(conceptKey(identity), { identity, site });
      }
    }
    const unique = [...requests.values()].filter(({ identity }) => !latest.current.assemblies.some(assembly => conceptKey(assembly.spec) === conceptKey(identity) && !assembly.warnings.some(warning => warning.startsWith('STALE:'))));
    if (!unique.length) return;
    const proposalMap = new Map(proposals.filter(proposal => unique.some(({ identity }) => identity.fdi === proposal.fdi)).map(proposal => [proposal.fdi, proposal]));
    // Keep both anatomical proposals and neutral geometry bound to the render
    // that supplied their assessment token. Templates never identify a site.
    const proposalRevision = hypothesisRevision;
    const isHypothesis = (identity: SiteIdentity) => aiDesigns !== undefined || !!identity.draftIdentity || proposalMap.has(identity.fdi);
    const eligible = unique.filter(({ identity }) => !isHypothesis(identity) || (proposalRevision !== null && proposalRevision === latest.current.hypothesisRevision));
    const eligibleKeys = new Set(eligible.map(({ identity }) => conceptKey(identity)));
    const label = (identity: SiteIdentity) => identity.draftIdentity ? `${toothArch(identity.fdi) === 'upper' ? 'Upper' : 'Lower'} draft site` : `FDI ${identity.fdi}`;
    const warnings = unique.filter(({ identity }) => !eligibleKeys.has(conceptKey(identity))).map(({ identity }) => `${label(identity)}: ${HYPOTHESIS_CHANGED}`);
    setError(warnings.join(' '));
    setSiteReadiness(current => mergeReadiness(current, unique.map(({ identity }) => ({ ...identity, status: eligibleKeys.has(conceptKey(identity)) ? 'ready' : 'needs-input', detail: eligibleKeys.has(conceptKey(identity)) ? 'Localizing the site from current surface evidence.' : HYPOTHESIS_CHANGED }))));
    if (!eligible.length) return;
    const token = ++revision.current, eligibleFdis = [...new Set(eligible.map(({ identity }) => identity.fdi))];
    const pending: Generation = { token, fdis: eligibleFdis, keys: [...eligibleKeys], hypotheses: new Set(eligible.filter(({ identity }) => isHypothesis(identity)).map(({ identity }) => conceptKey(identity))), hypothesisRevision: proposalRevision, evidence: snapshotEvidence(latest.current.parts, teeth, eligibleFdis), jobKeys: [...eligibleKeys] };
    active.current = pending; setBusy(true); setProgress({ phase: 'creating', detail: `Localizing ${eligible.length} supported ${eligible.length === 1 ? 'site' : 'sites'} from the current geometry.` });
    try {
      assertCurrent(token);
      const generationDesigns = new Map<string, RestorationGenerationDesign>();
      const generationErrors = new Map<string, string>();
      let response: { specs: RestorationSpec[]; warnings: string[] };
      if (aiDesigns !== undefined) {
        response = { specs: [], warnings: [] };
        for (const { identity, site } of eligible) {
          try {
            const matches = site ? aiDesigns.filter(request => request.siteId === site.id && request.fdi === identity.fdi) : [];
            if (!site || matches.length !== 1) throw new Error(matches.length > 1
              ? 'Conflicting AI designs for this exact local site and FDI.' : 'No authorized AI design matches this exact local site and FDI.');
            const request = structuredClone(matches[0]);
            response.specs.push(specForAIGeneration(site, scans, request.design, request.rationale));
            generationDesigns.set(conceptKey(identity), request.design);
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            generationErrors.set(conceptKey(identity), detail); response.warnings.push(`${label(identity)}: ${detail}`);
          }
        }
      } else {
        const input = planningConceptCase(teeth, [...proposalMap.values()].filter(proposal => eligibleFdis.includes(proposal.fdi)));
        const direct = eligible.flatMap(({ site }) => { const spec = site ? specForHypothesis(site, scans) : null; return spec ? [spec] : []; });
        const directKeys = new Set(direct.map(conceptKey));
        // A neutral site cannot fall back to an anatomical FDI localization job.
        const remaining = eligible.filter(({ identity }) => !identity.draftIdentity && !directKeys.has(conceptKey(identity)));
        pending.jobKeys = remaining.map(({ identity }) => conceptKey(identity));
        const localized = remaining.length ? await runWorker<{ specs: RestorationSpec[]; warnings: string[] }>(() => new Worker(new URL('./restoration-site.worker.ts', import.meta.url), { type: 'module' }), { fdis: [...new Set(remaining.map(({ identity }) => identity.fdi))], teeth: input, scans, parts: latest.current.parts.filter(part => part.role === 'upper' || part.role === 'lower') }, token) : { specs: [], warnings: [] };
        response = { specs: [...new Map([...direct, ...localized.specs].filter(spec => eligibleKeys.has(conceptKey(spec))).map(spec => [conceptKey(spec), spec])).values()], warnings: localized.warnings };
      }
      warnings.push(...response.warnings);
      const readiness: SiteReadiness[] = eligible.map(({ identity }) => {
        const key = conceptKey(identity), stale = pending.hypotheses.has(key) && proposalRevision !== latest.current.hypothesisRevision;
        const localized = response.specs.some(spec => conceptKey(spec) === key);
        return { ...identity, status: localized && !stale ? 'ready' : 'needs-input', detail: stale ? HYPOTHESIS_CHANGED : localized ? 'Surface hypothesis localized; creating components.' : generationErrors.get(key) ?? response.warnings.find(warning => warning.includes(`FDI ${identity.fdi}:`)) ?? 'Site could not be localized. Review the surrounding tooth labels or mark a surface site.' };
      });
      setSiteReadiness(current => mergeReadiness(current, readiness));
      for (const spec of response.specs) {
        if (token !== revision.current) return;
        const key = conceptKey(spec), proposal = spec.draftIdentity || aiDesigns !== undefined ? undefined : proposalMap.get(spec.fdi);
        try {
          const id = latest.current.assemblies.find(assembly => conceptKey(assembly.spec) === key)?.id ?? crypto.randomUUID();
          await generate(proposal ? { ...spec, source: `${proposal.source === 'dentist-draft' ? 'Dentist-selected draft site hypothesis.' : proposal.source === 'local-geometry' ? 'Local geometry missing-site hypothesis.' : 'AI-proposed missing-site hypothesis.'} ${proposal.source ? `Source: ${proposal.source}. ` : ''}${proposal.rationale} ${spec.source}` } : spec, id, token, pending.hypotheses.has(key) ? proposalRevision : null, WORKFLOW_BUDGET.candidatesPerSite, undefined, generationDesigns.get(key));
          setSiteReadiness(current => current.map(site => conceptKey(site) === key ? { ...site, status: 'generated', detail: spec.draftIdentity ? 'Three editable components · tooth identity unresolved; chart unchanged.' : proposal ? 'Three editable components · automatic site hypothesis; chart unchanged.' : 'Three editable components · reviewed site.' } : site));
        } catch (error) {
          if (token !== revision.current) return;
          const detail = error instanceof Error ? error.message : String(error);
          warnings.push(`${label(spec)}: ${detail}`);
          setSiteReadiness(current => current.map(site => conceptKey(site) === key ? { ...site, status: 'needs-input', detail } : site));
        }
      }
      if (token === revision.current) setError(warnings.join(' '));
    } catch (error) { if (token === revision.current) { const detail = error instanceof Error ? error.message : String(error); setError([...warnings, detail].join(' ')); setSiteReadiness(current => mergeReadiness(current, eligible.map(({ identity }) => ({ ...identity, status: 'needs-input', detail })))); } }
    finally { if (token === revision.current) { active.current = null; setBusy(false); } }
    const completed = latest.current.assemblies.filter(assembly => eligibleKeys.has(conceptKey(assembly.spec)) && !assembly.warnings.some(warning => warning.startsWith('STALE:')));
    const failedSites = eligible.filter(({ identity }) => !completed.some(assembly => conceptKey(assembly.spec) === conceptKey(identity))).map(({ identity }) => identity);
    return { requested: eligible.map(({ identity }) => identity.fdi), requestedSites: eligible.map(({ identity }) => identity), assemblies: completed, failed: failedSites.map(site => site.fdi), failedSites };
  }
  async function revise(id: string, transform: (spec: RestorationSpec) => RestorationSpec, options: { expectedRevision?: string; signal?: AbortSignal; operation?: 'recheck' } = {}): Promise<RestorationAssembly> {
    let token: number | undefined;
    const abort = () => { if (token !== undefined && active.current?.token === token) cancel('Restoration edit cancelled.'); };
    try {
      if (options.signal?.aborted) throw new DOMException('Restoration edit cancelled.', 'AbortError');
      if (active.current) throw new Error('Another restoration operation is active. Wait for it or cancel it before editing.');
      const assembly = latest.current.assemblies.find(item => item.id === id), basis = bases.current.get(id);
      if (!assembly) throw new Error('The restoration no longer exists.');
      const expectedRevision = restorationEditRevision(assembly);
      if (options.expectedRevision !== undefined && options.expectedRevision !== expectedRevision) throw new Error('The restoration revision changed. Read the current assembly before editing.');
      if (!basis || !validBasis(basis) || assembly.warnings.some(warning => warning.startsWith('STALE:'))) throw new Error(EVIDENCE_CHANGED);
      const spec = transform(assembly.spec);
      validateRestorationSpec(spec);
      token = ++revision.current;
      active.current = { token, fdis: [spec.fdi], keys: [conceptKey(spec)], hypotheses: new Set(basis.hypothesisRevision === null ? [] : [conceptKey(spec)]), hypothesisRevision: basis.hypothesisRevision, evidence: snapshotEvidence(latest.current.parts, latest.current.teeth, [spec.fdi]), jobKeys: [conceptKey(spec)], edit: { id, expectedRevision, signal: options.signal, operation: options.operation ?? 'edit' } };
      setBusy(true); setError('');
      options.signal?.addEventListener('abort', abort, { once: true });
      // Exact edits keep the original absolute requirements. Rebuilding from
      // a measured site is the separate operation that establishes new ones.
      return await generate(spec, id, token, basis.hypothesisRevision, 1, basis.site, undefined,
        spec.editProvenance?.actor === 'agent' && options.operation !== 'recheck' ? undefined : assembly.fit?.goal);
    } catch (cause) {
      const failure = options.signal?.aborted ? new DOMException('Restoration edit cancelled.', 'AbortError') : cause;
      if (token === undefined || token === revision.current) setError(failure instanceof Error ? failure.message : String(failure));
      throw failure;
    } finally {
      options.signal?.removeEventListener('abort', abort);
      if (token !== undefined && token === revision.current) { active.current = null; setBusy(false); }
    }
  }
  function edit(id: string, change: RestorationEdit, options: { actor?: 'manual' | 'agent'; expectedRevision?: string; signal?: AbortSignal } = {}): Promise<RestorationAssembly> {
    return revise(id, spec => applyRestorationEdit(spec, change, options.actor ?? 'manual'), options);
  }
  /** Refresh every local check without optimizing or changing geometry. Uses
   * the same cancellation, revision and source fences as an exact edit. */
  function recheck(id: string): Promise<RestorationAssembly> {
    return revise(id, original => ({ ...structuredClone(original), crownShape: restorationCrownShape(original) }), { operation: 'recheck' });
  }
  /** Manually recorded case feedback only. It is deliberately outside the
   * agent edit schema and never converts mm feedback into file-unit geometry. */
  function setPlacementFeedback(id: string, feedback: RestorationPlacementFeedback | null): Promise<RestorationAssembly> {
    return revise(id, original => {
      const value = feedback === null ? undefined : restorationPlacementFeedbackSchema.parse(feedback);
      if (JSON.stringify(original.qualityContext?.placementFeedback) === JSON.stringify(value)) throw new Error('Placement feedback has not changed.');
      const spec = structuredClone(original);
      spec.qualityContext ??= { version: 'restoration-quality-context/v1', units: 'file units (u)', neighbors: [], gapWidth: null, availableHeight: null };
      if (value) spec.qualityContext.placementFeedback = value;
      else delete spec.qualityContext.placementFeedback;
      spec.provenance = 'clinician-entered';
      spec.editProvenance = { actor: 'manual', reason: value
        ? `Recorded manual, ${value.provenance === 'clinician-entered-case-feedback' ? 'clinician-entered' : 'unconfirmed'} case placement feedback; dimensions unchanged.`
        : 'Cleared manually recorded case placement feedback; dimensions unchanged.' };
      return spec;
    });
  }
  async function update(id: string, parameters: RestorationParameters) {
    // Legacy UI callback exposes errors through hook state; the shared edit API
    // itself rejects so assistant callers can stop/evaluate their bounded loop.
    try { return await edit(id, { reason: 'Manual component parameter edit.', parameters }); }
    catch { return undefined; }
  }
  async function compare(id: string, candidate?: number, version?: number, rebuild = false) {
    if (active.current) return;
    const assembly = latest.current.assemblies.find(item => item.id === id), basis = bases.current.get(id);
    const entry = assembly?.candidateHistory?.find(entry => entry.candidate === candidate);
    const historical = version === undefined ? undefined : assembly?.previousVersions?.[version];
    if (!assembly || !basis || !validBasis(basis) || (candidate !== undefined && !entry) || (version !== undefined && !historical)) return;
    const token = ++revision.current;
    active.current = { token, fdis: [assembly.spec.fdi], keys: [conceptKey(assembly.spec)], hypotheses: new Set(basis.hypothesisRevision === null ? [] : [conceptKey(assembly.spec)]), hypothesisRevision: basis.hypothesisRevision, evidence: snapshotEvidence(latest.current.parts, latest.current.teeth, [assembly.spec.fdi]), jobKeys: [conceptKey(assembly.spec)] };
    setBusy(true); setError('');
    const rebuilt = rebuild && basis.site ? specForHypothesis({ ...basis.site, fdi: assembly.spec.fdi,
      status: basis.site.status === 'dentist-confirmed-missing' ? basis.site.status : 'proposed-missing',
      ...(assembly.spec.draftIdentity ? { draftIdentity: assembly.spec.draftIdentity } : {}) }, currentScans.current) : null;
    const selectedSpec = rebuilt ?? historical?.spec ?? assembly.spec;
    const chosenSpec = entry?.anatomyCandidate === undefined ? selectedSpec : { ...selectedSpec, crownShape: assembly.fit?.anatomyCandidates?.[entry.anatomyCandidate] ?? selectedSpec.crownShape };
    try {
      if (rebuild && !rebuilt) throw new Error('A current measured site is needed to rebuild the initial crown. Prepare the site first; the existing concept is retained.');
      await generate({ ...chosenSpec, parameters: entry?.parameters ?? chosenSpec.parameters, source: `${rebuild ? 'Rebuilt from current site' : version !== undefined ? `Comparison of prior edit ${version + 1}` : candidate === undefined ? 'Fit retry' : `Comparison of measured candidate ${candidate}`} from assembly ${assembly.id}. ${chosenSpec.source}`.slice(0, 3900) }, crypto.randomUUID(), token, basis.hypothesisRevision, candidate === undefined && version === undefined ? WORKFLOW_BUDGET.candidatesPerSite : 1, basis.site, undefined, rebuild ? undefined : historical?.fit?.goal ?? assembly.fit?.goal);
    }
    catch (cause) { if (token === revision.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (token === revision.current) { active.current = null; setBusy(false); } }
  }
  function exportPart(id: string) {
    const part = displayParts.find(part => part.id === id); if (!part || assemblies.find(assembly => assembly.id === part.restoration?.assemblyId)?.warnings.some(warning => warning.startsWith('STALE:'))) return;
    // Export source coordinates with a separate current-pose manifest; original geometry remains immutable.
    download(restorationPly(part), part.fileName, 'application/octet-stream');
  }
  function exportPlan(result: unknown) { download(JSON.stringify({ version: 'dental-planning/v1', createdAt: new Date().toISOString(), units: 'file units (u)', assessment: result, assemblies: assemblies.map(({ id, spec, warnings }) => ({ id, spec, warnings, fileToWorkspace: displayParts.find(part => part.restoration?.assemblyId === id)?.pose })) }, null, 2), 'dental-planning-concepts.json', 'application/json'); }
  function restore(saved: RestorationAssembly[], scans: PreparedCaseSource[] = [], sites: SiteHypothesis[] = [], savedRevision: string | null = null) {
    cancel(); bases.current.clear(); currentScans.current = scans; currentSites.current = sites;
    restoringAssemblies.current = { assemblies: saved, hypothesisRevision: savedRevision };
    setRestoreEpoch(current => current + 1);
    latest.current.assemblies = saved; setAssemblies(saved);
    setSelectedId(saved.find(assembly => !assembly.warnings.some(warning => warning.startsWith('STALE:')))?.id ?? null);
    const readiness = new Map<string, SiteReadiness>();
    for (const assembly of saved) {
      const stale = assembly.warnings.some(warning => warning.startsWith('STALE:')), key = conceptKey(assembly.spec);
      if (stale && readiness.get(key)?.status === 'generated') continue;
      readiness.set(key, { ...siteIdentity(assembly.spec), status: stale ? 'needs-input' : 'generated', detail: stale ? 'Historical candidate retained; regenerate against current evidence.' : 'Reopened after scan hash and geometry validation.' });
    }
    setSiteReadiness([...readiness.values()]);
  }
  function remove(id: string) {
    const removed = latest.current.assemblies.find(assembly => assembly.id === id);
    if (!removed) return;
    cancel(); bases.current.delete(id);
    const remaining = latest.current.assemblies.filter(assembly => assembly.id !== id);
    latest.current.assemblies = remaining; setAssemblies(remaining);
    setSelectedId(current => current === id ? null : current);
    if (!remaining.some(assembly => conceptKey(assembly.spec) === conceptKey(removed.spec))) setSiteReadiness(current => current.filter(site => conceptKey(site) !== conceptKey(removed.spec)));
  }
  function togglePart(id: string) {
    const next = latest.current.assemblies.map(assembly => ({ ...assembly, parts: assembly.parts.map(part => part.id === id ? { ...part, visible: !part.visible } : part) }));
    latest.current.assemblies = next; setAssemblies(next);
  }
  return { assemblies, displayParts, selectedId, setSelectedId, busy, progress: busy ? progress : null, error, siteReadiness, create, edit, recheck, setPlacementFeedback, update, compare, rebuild: (id: string) => compare(id, undefined, undefined, true), cancel, restore, exportPart, exportPlan, remove, togglePart };
}
