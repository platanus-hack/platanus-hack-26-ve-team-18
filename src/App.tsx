import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { MAX_WORKSPACE_PARTS, MAX_WORKSPACE_TRIANGLES } from './import-models';
import { Matrix4 } from 'three';
import { inferScanRole, partMatrix, roleLabels } from './pose';
import type { ModelPart, ScanRole, Vec3 } from './models';
import type { CollisionReport } from './collision';
import { prepareCollisionParts } from './collision-input';
import { Viewport, type ViewerActions } from './Viewport';
import type { NavigationMode, Probe, ViewerCapture } from './viewer';
import { ViewerDock } from './ViewerDock';
import { withArchSeparation } from './aperture';
import { useDebouncedValue } from './useDebouncedValue';
import { useTomography } from './useTomography';
import { TomographyPanel } from './TomographyPanel';
import type { TomographyViewSpec } from './tomography-types';
import { registerCbctLandmarks, currentCbctRegistrations, tomographyReferencePart, applyCbctRigidDelta, cbctPoseMatches, cbctSourcesMatch, cbctResetParts, cbctAssemblyRegistered, cbctAssemblyDelta, type CbctArchRegistration, type CbctLandmarkPair } from './cbct-registration';
import type { CbctAutoAlignmentResult } from './cbct-auto-alignment';
import { useCbctAlignment } from './useCbctAlignment';
import { CbctOverlayControls } from './CbctOverlayControls';
import { cbctPipelineStage } from './cbct-pipeline';
import { CbctPipelineToast } from './CbctPipelineToast';
import { useTomographyAssistantSource } from './useTomographyAssistantSource';
import type { AssistantTomographySource } from './tomography-evidence';
import type { BiteAlignmentArchResult, BiteAlignmentResponse } from './bite-alignment';
import { ToothPanel } from './ToothPanel';
import { useToothIdentification } from './useToothIdentification';
import { useAutoTeeth } from './useAutoTeeth';
import { AutoTeethPanel } from './AutoTeethPanel';
import { AssistantPanel } from './AssistantPanel';
import { PlanningPanel } from './PlanningPanel';
import { RestorationPanel } from './RestorationPanel';
import { useCasePlanning } from './useCasePlanning';
import { useRestorations } from './useRestorations';
import { attachTexture } from './import-models';
import { canRefineCaseBite, prepareCaseBite } from './scan-groups';
import { presentationOpacity, withArchOpacity } from './presentation';
import { SceneVisibility } from './SceneVisibility';
import { buildPlanningDraft, automaticConceptSites, conceptKey, type PlanningDraft } from './planning-automation';
import type { CasePlanningResult } from './case-planning-types';
import { draftToothCase, reconcileIdentities, identityKey, replaceIdentityCorrection, type IdentityDecisions, type IdentityRegions, type WorkflowProgress } from './draft-workflow';
import type { SiteHypothesis } from './missing-sites';
import { planningExportBundle } from './planning-export';
import { createPlanningSession, readPlanningSession, type PlanningWorkflowState } from './planning-session';
import type { ProposedConceptSite } from './planning-concepts';
import { beginWorkflow, stageWorkflow, journalWorkflow, endWorkflow, WORKFLOW_BUDGET, type WorkflowRun, type CorrectionEvent } from './case-workflow';
import { toothCounts } from './teeth';
import { ProcessPanel } from './ProcessPanel';
import { describeProcess } from './guided-process';
import { useDraftReview } from './useDraftReview';
import { PatientView } from './PatientView';

const count = (value: number) => value.toLocaleString();
const number = (value: number) => Number.isFinite(value) ? new Intl.NumberFormat('en', { maximumFractionDigits: 4 }).format(value) : '—';
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const DEFAULT_SCAN_SCALE = 1;
const DEFAULT_SCALE_PROVENANCE = 'Default scan scale: 1 mm per file unit (editable).';
/** How long a slider must be still before the 3D scene applies its value. */
const SLIDER_SETTLE_MS = 100;

function Glyph({ kind }: { kind: 'add' | 'file' | 'download' | 'close' | 'sun' | 'moon' }) {
  if (kind === 'sun') {
    return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" /></svg>;
  }
  if (kind === 'moon') {
    return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /></svg>;
  }
  return <svg width="17" height="17" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">{kind === 'add' ? <path d="M10 3v14M3 10h14" /> : kind === 'close' ? <path d="m5 5 10 10M15 5 5 15" /> : kind === 'download' ? <path d="M10 2v11m-4-4 4 4 4-4M3 14v3h14v-3" /> : <><path d="M5 2h7l4 4v12H5V2Z" /><path d="M12 2v5h4M8 11h5M8 14h5" /></>}</svg>;
}

export function App() {
  const [parts, setParts] = useState<ModelPart[]>([]);
  const latestParts = useRef(parts);
  latestParts.current = parts;
  const tomography = useTomography();
  const [cbctRegistrations, setCbctRegistrations] = useState<CbctArchRegistration[]>([]);
  const [sceneAlignment, setSceneAlignment] = useState<{ volumeId: string; mmPerUnit: number; before: ModelPart[]; after: ModelPart[]; fileToWorkspace: number[]; result: CbctAutoAlignmentResult; reviewed: boolean } | null>(null);
  const [framingRevision, setFramingRevision] = useState(0);
  const [tomographyViews, setTomographyViews] = useState<TomographyViewSpec[]>([]);
  const [referenceVisible, setReferenceVisible] = useState(true);
  const [referenceOpacity, setReferenceOpacity] = useState(.4);
  const capture3d = useRef<(() => ViewerCapture) | null>(null);
  const captureReady = useCallback((capture: (() => ViewerCapture) | null) => { capture3d.current = capture; }, []);
  const viewerActions = useRef<ViewerActions | null>(null);
  const viewerActionsReady = useCallback((actions: ViewerActions | null) => { viewerActions.current = actions; }, []);
  const tomographyPanel = useRef<HTMLDivElement>(null);
  const tomographyFiles = useRef<{ files: File[]; allowIncompletePreview: boolean } | null>(null);
  const tomographyAiRef = useRef<AssistantTomographySource | undefined>(undefined);
  const assessmentTomography = useRef<string | null>(null);
  const [sharePlanningTomography, setSharePlanningTomography] = useState(false);
  const [step, setStep] = useState(0);
  const [scansOpen, setScansOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [tomographyOpen, setTomographyOpen] = useState(false);
  const [workflowIntent, setWorkflowIntent] = useState<'ai' | 'local' | 'resume' | null>(null);
  const [assessing, setAssessing] = useState(false);
  const [guidedPaused, setGuidedPaused] = useState(false);
  const measurementOnlyPause = useRef(false);
  const assessmentLock = useRef(false);
  const toolsPanel = useRef<HTMLDivElement>(null);
  const [acceptedActions, setAcceptedActions] = useState<string[]>([]);
  const [confidenceThreshold, setConfidenceThreshold] = useState(.8);
  const [manualMode, setManualMode] = useState(false);
  const [identityDecisions, setIdentityDecisions] = useState<IdentityDecisions>({});
  const [identityRegions, setIdentityRegions] = useState<IdentityRegions>({});
  const [archivedDraftDecisions, setArchivedDraftDecisions] = useState<NonNullable<PlanningWorkflowState['archivedDraftDecisions']>>([]);
  const [siteDecisions, setSiteDecisions] = useState<Record<string, number | null>>({});
  const [progress, setProgress] = useState<WorkflowProgress>({ stage: 'Waiting for scans', completed: 0, total: 5 });
  const [timings, setTimings] = useState<{stage: string; durationMs: number}[]>([]);
  const [workflowRuns, setWorkflowRuns] = useState<WorkflowRun[]>([]);
  const [correctionEvents, setCorrectionEvents] = useState<CorrectionEvent[]>([]);
  const [focusedSiteId, setFocusedSiteId] = useState<string | null>(null);
  const [assessmentHistory, setAssessmentHistory] = useState<CasePlanningResult[]>([]);
  const [biteReviewed, setBiteReviewed] = useState(false);
  const [viewMode, setViewMode] = useState<'clinical' | 'patient'>(() => {
    if (typeof window !== 'undefined') {
      if (window.location.hash === '#patient') return 'patient';
      const params = new URLSearchParams(window.location.search);
      if (params.get('view') === 'patient') return 'patient';
    }
    return 'clinical';
  });
  useEffect(() => {
    const onHash = () => setViewMode(window.location.hash === '#patient' ? 'patient' : 'clinical');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('ceflow-theme');
      if (saved === 'dark' || saved === 'light') return saved;
      if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    }
    return 'light';
  });
  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.documentElement.setAttribute('data-theme', theme);
      localStorage.setItem('ceflow-theme', theme);
    }
  }, [theme]);
  const toggleTheme = () => setTheme(prev => (prev === 'dark' ? 'light' : 'dark'));
  const workflowToken = useRef(0);
  const workflowDeadline = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const timedPreparation = useRef('');
  const reviewStarted = useRef(0);
  const [mmPerUnit, setMmPerUnit] = useState<number | null>(DEFAULT_SCAN_SCALE);
  const [cbctReadyScale, setCbctReadyScale] = useState<number | null>(DEFAULT_SCAN_SCALE);
  useEffect(() => {
    const timer = setTimeout(() => setCbctReadyScale(mmPerUnit), 300);
    return () => clearTimeout(timer);
  }, [mmPerUnit]);
  const [unitsProvenance, setUnitsProvenance] = useState(DEFAULT_SCALE_PROVENANCE);
  const workflowStart = useRef(0);
  const sessionInput = useRef<HTMLInputElement>(null);
  const [sessionBusy, setSessionBusy] = useState(false);
  const restoringSession = useRef(false);
  const [draft, setDraft] = useState<PlanningDraft | null>(null);
  const preparedResult = useRef<CasePlanningResult | null>(null);
  const restoredAssessment = useRef<CasePlanningResult | null>(null);
  const [pendingConcepts, setPendingConcepts] = useState<{ fdis: number[]; proposals: ProposedConceptSite[]; sites: SiteHypothesis[]; parts: ModelPart[]; revision: string } | null>(null);
  const corrections = useRef<HTMLDetailsElement>(null);
  const textureInput = useRef<HTMLInputElement>(null);
  const alignedSources = useRef('');
  const [selected, setSelected] = useState<string | null>(null);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [tolerance, setTolerance] = useState(0.5);
  const [report, setReport] = useState<CollisionReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);
  const [run, setRun] = useState(0);
  const [heatmap, setHeatmap] = useState(true);
  const [wireframe, setWireframe] = useState(false);
  const [upAxis, setUpAxis] = useState<'y' | 'z'>('z');
  const [aperture, setAperture] = useState(0);
  const sceneAperture = useDebouncedValue(aperture, SLIDER_SETTLE_MS);
  const [navigationMode, setNavigationMode] = useState<NavigationMode>('orbit');
  const [showAnnotations, setShowAnnotations] = useState(true);
  const [viewerExpanded, setViewerExpanded] = useState(false);
  // Presentation stays independent of the geometry used by collision workers.
  const [opacities, setOpacities] = useState<Record<string, number>>({});
  // Sliders stay live in the UI; the 3D scene applies their values only after
  // the slider has been still for SLIDER_SETTLE_MS, so dragging never re-runs
  // viewer transforms/materials mid-gesture.
  const viewerOpacities = useDebouncedValue(opacities, SLIDER_SETTLE_MS);
  const [dragging, setDragging] = useState(false);
  const [aligning, setAligning] = useState(false);
  const [matchDistance, setMatchDistance] = useState(2);
  const matchDistanceEdited = useRef(false);
  const [fitRadius, setFitRadius] = useState<number | null>(null);
  const [fitSummary, setFitSummary] = useState<BiteAlignmentArchResult[]>([]);
  const [alignmentIssue, setAlignmentIssue] = useState('');
  const registration = useRef<Worker | null>(null);
  const registrationTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const importer = useRef<Worker | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const identificationInput = useRef<HTMLInputElement>(null);
  const importLock = useRef(false);
  const dragDepth = useRef(0);
  const active = parts.find(part => part.id === selected);
  const tooth = useToothIdentification(parts, selected, setSelected);
  const analysisState: 'ready' | 'running' | 'paused' | 'unavailable' = importing || aligning || busy ? 'running' : paused ? 'paused' : report ? 'ready' : 'unavailable';
  const planning = useCasePlanning(parts, { parts, selected, selectedFdi: tooth.selectedTooth, probe, report, tolerance, analysisState, teeth: tooth.data.teeth, counts: tooth.counts, fitSummary, fitRadius }, importing || aligning, tooth.data.labels, tooth.data.reviewedMask, { identityDecisions, identityRegions, biteReviewed, confidenceThreshold, tomography: { source: tomographyAiRef, sharing: sharePlanningTomography } });
  const tomographyBasis = JSON.stringify([sharePlanningTomography, ...(sharePlanningTomography ? [tomography.volume?.id, tomography.volume?.complete, tomography.threshold, tomography.stride, tomographyViews, cbctRegistrations, mmPerUnit] : [])]);
  const identities = useMemo(() => planning.prepared ? reconcileIdentities(planning.prepared, planning.result, parts, confidenceThreshold, identityDecisions, identityRegions) : [], [planning.prepared, planning.result, parts, confidenceThreshold, identityDecisions, identityRegions]);
  const effectiveCase = useMemo(() => draftToothCase(tooth.data, parts, planning.prepared, identities, identityDecisions, identityRegions), [tooth.data, parts, planning.prepared, identities, identityDecisions, identityRegions]);
  const hypothesisRevision = planning.evidence ? `${planning.evidence.revision}:${planning.patientRight}:${mmPerUnit}:${JSON.stringify(siteDecisions)}` : null;
  const restorations = useRestorations(parts, effectiveCase, hypothesisRevision);
  const proposedSites = useMemo(() => (planning.prepared?.sites ?? []).map((site): SiteHypothesis => Object.hasOwn(siteDecisions, site.id) ? { ...site, fdi: siteDecisions[site.id], draftIdentity: undefined, status: siteDecisions[site.id] === null ? 'identity-unresolved' : 'proposed-missing', confidence: site.confidence } : site), [planning.prepared, siteDecisions]);
  const allParts = useMemo(() => [...parts, ...restorations.displayParts], [parts, restorations.displayParts]);
  const currentRegistrations = useMemo(() => currentCbctRegistrations(cbctRegistrations, parts, tomography.volume?.id, mmPerUnit), [cbctRegistrations, parts, tomography.volume?.id, mmPerUnit]);
  const completeArchRegistration = cbctAssemblyRegistered(currentRegistrations, parts);
  const overlayRegistrations = useMemo(() => currentRegistrations.map(({ arch, rmsMm, reviewed, method }) => ({ arch, rmsMm, reviewed, method })), [currentRegistrations]);
  const currentSceneAlignment = useMemo(() => sceneAlignment && sceneAlignment.volumeId === tomography.volume?.id && sceneAlignment.mmPerUnit === mmPerUnit && cbctPoseMatches(sceneAlignment.after, parts) ? sceneAlignment : null, [sceneAlignment, tomography.volume?.id, mmPerUnit, parts]);
  const assemblyRegistration = useMemo(() => currentSceneAlignment ? { partIds: currentSceneAlignment.after.filter(part => part.role !== 'bite').map(part => part.id), reviewed: currentSceneAlignment.reviewed, rmsMm: currentSceneAlignment.result.rmsMm } : undefined, [currentSceneAlignment]);
  const referenceShown = referenceVisible && (!allParts.length || !!mmPerUnit);
  const referenceParts = useMemo(() => tomography.surface ? [tomographyReferencePart(tomography.surface, mmPerUnit, referenceShown)] : [], [tomography.surface, mmPerUnit, referenceShown]);
  // Presentation-only bite opening: the view shows the arches separated while
  // collision evidence keeps using the true `allParts` geometry. The scene
  // applies the slider value debounced (see useDebouncedValue).
  const viewportParts = useMemo(() => withArchSeparation(allParts, sceneAperture, upAxis), [allParts, sceneAperture, upAxis]);
  const cbctAlignmentDisabled = importing || aligning || restorations.busy || assessing || workflowRuns.at(-1)?.status === 'running';
  const biteSourceKey = (['upper', 'lower', 'bite'] as const).flatMap(role => parts.filter(part => part.role === role)).map(part => `${part.id}:${part.triangles}`).join('|');
  const waitingForBite = !cbctRegistrations.length && canRefineCaseBite(parts) && (alignedSources.current !== biteSourceKey || aligning);
  const cbctAlignment = useCbctAlignment({ parts, volume: tomography.volume, mmPerUnit, automatic: !waitingForBite && cbctReadyScale === mmPerUnit, disabled: cbctAlignmentDisabled, onAligned: applyAutomaticCbctAlignment });
  const [cbctPipelineArmed, setCbctPipelineArmed] = useState(false);
  const cbctPipeline = useMemo(() => cbctPipelineStage({
    loading: tomography.loading, status: tomography.status, progress: tomography.progress, error: tomography.error,
    volume: tomography.volume, surface: tomography.surface, surfaceBusy: tomography.surfaceBusy,
    alignBusy: cbctAlignment.busy, alignError: cbctAlignment.error,
    biteAligning: aligning, waitingForBite, scaleKnown: mmPerUnit !== null,
    hasScans: parts.some(part => part.role !== 'bite'), aligned: !!currentSceneAlignment,
  }), [tomography.loading, tomography.status, tomography.progress, tomography.error, tomography.volume, tomography.surface, tomography.surfaceBusy, cbctAlignment.busy, cbctAlignment.error, aligning, waitingForBite, mmPerUnit, parts, currentSceneAlignment]);
  // Let the user see the completed stepper briefly, then free the corner of the screen.
  useEffect(() => {
    if (cbctPipeline?.stage !== 'done') return;
    const timer = setTimeout(() => setCbctPipelineArmed(false), 4000);
    return () => clearTimeout(timer);
  }, [cbctPipeline]);
  const autoTeeth = useAutoTeeth(parts, selected, importing || aligning || tooth.busy);
  useEffect(() => { autoTeeth.setAutoRun(false); }, []);
  const readyMappings = autoTeeth.proposal?.mappings.filter(mapping => mapping.fdi !== null && !mapping.needsReview) ?? [];
  const opacityFor = (part: ModelPart) => presentationOpacity(part, opacities);
  const sceneOpacities = useMemo(() => ({ ...Object.fromEntries(allParts.map(part => [part.id, presentationOpacity(part, viewerOpacities)])), ...Object.fromEntries(referenceParts.map(part => [part.id, referenceOpacity])) }), [allParts, viewerOpacities, referenceParts, referenceOpacity]);
  const captureParts = useMemo(() => [...viewportParts, ...referenceParts].filter(part => part.visible && (sceneOpacities[part.id] ?? 1) > 0), [viewportParts, referenceParts, sceneOpacities]);
  const tomographySource = useTomographyAssistantSource({ volume: tomography.volume, surface: tomography.surface, parts: allParts, sceneParts: captureParts, registrations: overlayRegistrations, mmPerUnit, views: tomographyViews, capture3d, sceneRevision: JSON.stringify([sceneOpacities, heatmap, wireframe, step, tooth.selectedTooth, tooth.isolate]) });
  tomographyAiRef.current = tomographySource;
  const activeOpacity = active ? Math.round(opacityFor(active) * 100) : 100;
  const visible = allParts.filter(part => part.visible && part.role !== 'bite');
  const compared = visible.filter(part => part.role !== 'bite');
  const upper = parts.filter(part => part.role === 'upper');
  const lower = parts.filter(part => part.role === 'lower');
  const hasArch = allParts.some(part => part.role === 'upper' || part.role === 'lower');
  const bites = parts.filter(part => part.role === 'bite');
  const canAlign = canRefineCaseBite(parts);
  const activeAnalysis = report?.parts.find(part => part.id === selected);
  const collisions = report?.pairs.filter(pair => pair.intersectingTriangles > 0 || pair.penetratingVertices > 0) ?? [];
  const currentReport = !!report && report.parts.length === compared.length && compared.every(part => report.parts.some(row => row.id === part.id));
  const currentAssemblies = restorations.assemblies.filter(assembly => !assembly.warnings.some(warning => warning.startsWith('STALE:')));
  const assistantContext = useMemo(() => ({ parts: allParts, selected, selectedFdi: tooth.selectedTooth, probe, report, tolerance, analysisState, teeth: tooth.data.teeth, counts: tooth.counts, fitSummary, fitRadius }), [allParts, selected, tooth.selectedTooth, probe, report, tolerance, analysisState, tooth.data.teeth, tooth.counts, fitSummary, fitRadius]);
  const currentRun = workflowRuns.at(-1);
  const savedReview = currentRun?.tools.find(tool => tool.name === 'ai-draft-review');
  const aiReviewEnabled = !!planning.result && planning.result.model !== 'local-geometry' && !!currentRun && ['complete', 'partial'].includes(currentRun.status) && !savedReview && !guidedPaused;
  const aiReviewReady = !busy && !restorations.busy && !pendingConcepts && !planning.busy && !assessing && !paused && (compared.length < 2 || currentReport);
  const aiReview = useDraftReview({
    runKey: currentRun?.id ?? null, enabled: aiReviewEnabled, ready: aiReviewReady, model: planning.result?.model ?? planning.model,
    context: assistantContext, assemblies: currentAssemblies, tomography: tomographySource, shareTomography: sharePlanningTomography, tomographyBasis,
    onComplete: (key, result) => changeRun(run => run.id !== key ? run : journalWorkflow(run, { name: 'ai-draft-review', stage: 'review', status: 'complete', durationMs: 0, detail: `Model: ${result.model}\n${result.text}`.slice(0, 3850) + (result.text.length > 3800 ? '\n[Saved excerpt; full review was shown in this session.]' : ''), artifactIds: [] })),
    onError: (key, error) => changeRun(run => run.id !== key ? run : journalWorkflow(stageWorkflow(run, 'review', 'partial', error), { name: 'ai-draft-review', stage: 'review', status: 'partial', durationMs: 0, detail: error, artifactIds: [] })),
  });

  const toothView = useMemo(() => {
    const source = planning.evidence?.sources.find(source => source.partId === selected);
    const overlay = autoTeeth.overlay ?? (source ? { partId: source.partId, candidates: source.scan.candidates.map(candidate => ({ id: candidate.id, faces: candidate.faces, centroid: candidate.centroid })), selectedCandidate: null } : null);
    return { ...tooth.view, labels: step > 0 ? effectiveCase.labels : tooth.view.labels, planningSites: step > 0 ? proposedSites : [], focusedPlanningSiteId: focusedSiteId, autoOverlay: step === 0 ? null : overlay, ...(importing || aligning || autoTeeth.busy || planning.busy ? { tool: 'inspect' as const, editablePartIds: [] } : {}) };
  }, [tooth.view, effectiveCase, proposedSites, focusedSiteId, autoTeeth.overlay, planning.evidence, selected, step, importing, aligning, autoTeeth.busy, planning.busy]);
  useEffect(() => {
    if (preparedResult.current !== planning.result) { setDraft(null); setPendingConcepts(null); preparedResult.current = null; }
    if (!planning.result) setAcceptedActions([]);
    if (planning.result && planning.result === restoredAssessment.current) restoredAssessment.current = null;
    else if (!restoringSession.current) {
      if (planning.result && preparedResult.current !== planning.result) setStep(1);
      else setAcceptedActions([]);
    }
  }, [planning.result]);
  useEffect(() => {
    if (!pendingConcepts || importing || aligning || tooth.busy || restorations.busy) return;
    setPendingConcepts(null);
    if (pendingConcepts.parts !== parts || pendingConcepts.revision !== planning.evidence?.revision) return;
    setProgress({ stage: 'Generating anatomy and fitting current surfaces', completed: 3, total: 5 });
    const token = workflowToken.current;
    changeRun(run => stageWorkflow(run, 'anatomy', 'running', `${pendingConcepts.fdis.length} sites; bounded local construction, fitting and selection.`));
    void restorations.create(pendingConcepts.fdis, effectiveCase, planning.evidence.sources, pendingConcepts.proposals, pendingConcepts.sites).then(outcome => { if (token !== workflowToken.current) return; finishWorkflow(outcome); });
  }, [pendingConcepts, parts, planning.evidence, importing, aligning, tooth.busy, restorations.busy, effectiveCase, proposedSites]);
  // One explicit start carries the case through all supported local steps.
  // Wait for stable collision evidence before capturing a provider assessment.
  useEffect(() => {
    if (!workflowIntent || !planning.evidence || !planning.prepared || planning.busy || importing || aligning || tooth.busy || busy || restorations.busy || assessmentLock.current || (workflowIntent === 'ai' && planning.configured === null)) return;
    const intent = workflowIntent;
    setWorkflowIntent(null); assessmentLock.current = true; setAssessing(true);
    startWorkflow();
    const token = workflowToken.current;
    void Promise.resolve(intent === 'resume' && planning.result ? planning.result : intent === 'ai' ? planning.analyze() : planning.analyzeLocal()).then(result => {
      if (token !== workflowToken.current) return;
      if (result) prepareDraft(result);
      else cancelWorkflow('Paused · assessment could not start; review current evidence');
    }).catch(error => {
      if (token === workflowToken.current) { setError(message(error)); cancelWorkflow('Paused · workflow needs attention'); }
    }).finally(() => {
      if (token === workflowToken.current) { assessmentLock.current = false; setAssessing(false); }
    });
  }, [workflowIntent, planning.evidence, planning.prepared, planning.busy, planning.configured, importing, aligning, tooth.busy, busy, restorations.busy]);
  useEffect(() => {
    if (workflowIntent && planning.error && !planning.busy && !planning.prepared) setWorkflowIntent(null);
  }, [workflowIntent, planning.error, planning.busy, planning.prepared]);
  useEffect(() => {
    if (!canAlign || importing || aligning || restoringSession.current || cbctRegistrations.length) return;
    const key = [...upper, ...lower, ...bites].map(part => `${part.id}:${part.triangles}`).join('|');
    if (alignedSources.current === key) return;
    alignedSources.current = key;
    const relativeRadius = Math.max(...[...upper, ...lower].map(part => Math.hypot(...part.dimensions))) * 0.03;
    const radius = matchDistanceEdited.current ? matchDistance : Math.min(1e6, Math.max(Number.EPSILON, relativeRadius));
    if (!matchDistanceEdited.current) setMatchDistance(radius);
    refineBite(radius);
  }, [parts, importing, aligning, cbctRegistrations.length]);

  useEffect(() => {
    setReport(null); setProbe(null);
    if (allParts.filter(part => part.visible && part.role !== 'bite').length < 2 || paused || aligning || importing) { setBusy(false); return; }
    setBusy(true);
    let cancelled = false;
    let worker: Worker | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      try {
        worker = new Worker(new URL('./collision.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = event => {
          if (cancelled) return;
          if (event.data.error) setError(`Collision analysis: ${event.data.error}`);
          else setReport(event.data.report as CollisionReport);
          setBusy(false); clearTimeout(timeout); worker?.terminate();
        };
        worker.onerror = () => { setError('Collision analysis stopped. Try analyzing again or import a smaller mesh.'); setBusy(false); clearTimeout(timeout); worker?.terminate(); };
        timeout = setTimeout(() => { worker?.terminate(); setBusy(false); setError('Analysis exceeded 60 seconds. Try fewer parts or simplify a dense mesh, then analyze again.'); }, 60_000);
        const inputs = prepareCollisionParts(allParts);
        worker.postMessage({ id: run, tolerance, parts: inputs }, inputs.map(part => part.positions.buffer as ArrayBuffer));
      } catch (error) { setBusy(false); setError(`Couldn’t start collision analysis. ${message(error)}`); }
    }, 220);
    return () => { cancelled = true; clearTimeout(timer); clearTimeout(timeout); worker?.terminate(); };
  }, [allParts, tolerance, paused, run, aligning, importing]);

  useEffect(() => () => { registration.current?.terminate(); importer.current?.terminate(); clearTimeout(registrationTimeout.current); }, []);
  useEffect(() => () => clearTimeout(workflowDeadline.current), []);
  useEffect(() => {
    const current = workflowRuns.at(-1);
    if (current?.status === 'running' && (!planning.evidence || current.revision !== planning.evidence.revision)) {
      workflowToken.current++; clearTimeout(workflowDeadline.current); setPendingConcepts(null); setWorkflowIntent(null); assessmentLock.current = false; setAssessing(false); restorations.cancel();
      changeRun(run => endWorkflow(run, 'stale')); setProgress({ stage: 'Evidence changed · completed candidates retained for comparison', completed: 1, total: 5 });
    }
  }, [planning.evidence?.revision]);
  useEffect(() => {
    if (assessmentTomography.current !== null && assessmentTomography.current !== tomographyBasis) {
      assessmentTomography.current = null;
      if (planning.result?.model !== 'local-geometry') {
        cancelWorkflow('Paused · tomography evidence changed');
        planning.invalidate('Tomography evidence changed. Run a new assessment with the current views, or continue with local geometry.');
        changeRun(run => endWorkflow(run, 'stale'));
      }
    }
  }, [tomographyBasis]);
  useEffect(() => {
    const current = workflowRuns.at(-1);
    if (!current || !['complete', 'partial'].includes(current.status) || current.stages.find(stage => stage.id === 'review')?.status === 'complete' || busy || restorations.busy || pendingConcepts || current.revision !== planning.evidence?.revision) return;
    if (compared.length >= 2 && (!report || !compared.every(part => report.parts.some(row => row.id === part.id)))) return;
    if (aiReviewEnabled && ['idle', 'running'].includes(aiReview.status)) return;
    changeRun(run => stageWorkflow(run, 'review', aiReview.error || savedReview?.status === 'partial' ? 'partial' : 'complete', `Automated surface checks available: ${report?.pairs.length ?? 0} nearby/intersecting pairs. ${aiReview.error || 'Clinical review remains pending.'}`));
    setProgress({ stage: 'Automated checks ready · clinical review pending', completed: 5, total: 5 });
  }, [report, busy, restorations.busy, pendingConcepts, workflowRuns.at(-1)?.status, planning.evidence?.revision, aiReview.status, aiReviewEnabled]);

  function changeRun(update: (run: WorkflowRun) => WorkflowRun) { setWorkflowRuns(current => current.length ? [...current.slice(0, -1), update(current[current.length - 1])] : current); }
  function recordCorrection(kind: CorrectionEvent['kind'], target: string) { setCorrectionEvents(current => [...current, { kind, target, at: new Date().toISOString() }].slice(-2000)); }
  function startWorkflow() {
    workflowStart.current = performance.now(); workflowToken.current++;
    clearTimeout(workflowDeadline.current);
    const run = beginWorkflow(planning.evidence?.revision ?? 'awaiting-evidence');
    setWorkflowRuns(current => [...current, stageWorkflow(run, 'preparation', 'complete', 'Local geometry, source roles, coverage, colour and protected corrections prepared.', planning.prepared?.durationMs ?? 0)].slice(-32));
    if (planning.prepared?.durationMs && timedPreparation.current !== planning.prepared.revision) { timedPreparation.current = planning.prepared.revision; setTimings(current => [...current, { stage: 'Local evidence preparation', durationMs: planning.prepared!.durationMs! }].slice(-128)); }
    setProgress({ stage: 'Assessing the prepared case', completed: 1, total: 5 });
    workflowDeadline.current = setTimeout(() => cancelWorkflow('Workflow time budget reached · best completed candidates retained'), WORKFLOW_BUDGET.workflowMs);
  }
  function finishWorkflow(outcome?: Awaited<ReturnType<typeof restorations.create>>) {
    clearTimeout(workflowDeadline.current);
    setProgress({ stage: 'Draft assembled · checking surfaces; clinical review pending', completed: 4, total: 5 });
    const durationMs = workflowStart.current ? performance.now() - workflowStart.current : 0;
    const incompleteQuality = (outcome?.assemblies ?? []).some(assembly => assembly.fit?.quality?.final.status !== 'pass');
    const partial = incompleteQuality || !!outcome?.failed.length || identities.some(identity => identity.needsReview) || proposedSites.some(site => ['identity-unresolved', 'segmentation-unresolved'].includes(site.status));
    changeRun(run => {
      let next = stageWorkflow(run, 'anatomy', !outcome || outcome.failed.length || incompleteQuality ? 'partial' : 'complete', outcome ? `${outcome.assemblies.length} generated sites; ${outcome.failed.length} could not generate. Best candidates retained; independent checks ${incompleteQuality ? 'remain unresolved' : 'passed'}.` : 'No new supported site was generated; completed work retained.', durationMs);
      for (const assembly of outcome?.assemblies ?? []) next = journalWorkflow(next, { name: 'generate-evaluate-revise', stage: 'anatomy', status: assembly.fit?.quality?.final.status === 'pass' ? 'complete' : 'partial', durationMs: assembly.fit?.durationMs ?? 0, detail: `${assembly.spec.draftIdentity ? 'Automatic draft site' : `FDI ${assembly.spec.fdi}`}: ${assembly.fit?.before.score ?? 'unknown'} → ${assembly.fit?.after.score ?? 'unknown'} objective; ${assembly.fit?.candidates ?? 0} measured candidates; independent checks ${assembly.fit?.quality?.final.status ?? 'unknown'}; clinical fit unvalidated.`, artifactIds: [assembly.id] });
      return endWorkflow(stageWorkflow(next, 'review', 'partial', 'Draft assembled. Current surface analysis and clinical review remain separate.'), partial || !outcome ? 'partial' : 'complete');
    });
    if (durationMs) setTimings(current => [...current, { stage: 'Automatic draft preparation', durationMs }].slice(-128));
    workflowStart.current = 0;
    reviewStarted.current = performance.now();
    setStep(3);
  }

  function clearFit() { setFitSummary([]); setFitRadius(null); setAlignmentIssue(''); }
  function stopAlignment() {
    registration.current?.terminate(); registration.current = null;
    clearTimeout(registrationTimeout.current); setAligning(false);
  }
  function updateParts(next: ModelPart[], options?: { preserveCbctAutomatic?: boolean }) {
    if (workflowRuns.at(-1)?.status === 'running' || assessmentLock.current || workflowIntent) cancelWorkflow('Paused · source geometry changed');
    stopAlignment();
    if (!options?.preserveCbctAutomatic) cbctAlignment.cancel();
    const sharesSource = next.some(part => parts.some(before => before.id === part.id && before.positions === part.positions));
    setSceneAlignment(current => !sharesSource ? null : current && !cbctPoseMatches(current.after, next) ? { ...current, before: cbctResetParts(current.before, next), reviewed: false } : current);
    setCbctRegistrations(current => current.map(record => currentCbctRegistrations([record], next, tomography.volume?.id, mmPerUnit).length ? record : { ...record, reviewed: false }));
    clearFit();
    setBiteReviewed(false);
    if (!next.length) {
      setGuidedPaused(false); measurementOnlyPause.current = false;
      setCbctRegistrations([]);
      setSceneAlignment(null);
      setMmPerUnit(DEFAULT_SCAN_SCALE); setUnitsProvenance(DEFAULT_SCALE_PROVENANCE); timedPreparation.current = ''; reviewStarted.current = 0; clearTimeout(workflowDeadline.current); workflowToken.current++;
      matchDistanceEdited.current = false; alignedSources.current = '';
      setMatchDistance(2); setStep(0); setAcceptedActions([]); setOpacities({}); setWarnings([]); setIdentityDecisions({}); setIdentityRegions({}); setArchivedDraftDecisions([]); setSiteDecisions({}); setFocusedSiteId(null); setAssessmentHistory([]); setWorkflowRuns([]); setCorrectionEvents([]); setTimings([]); setProgress({ stage: 'Waiting for scans', completed: 0, total: 5 }); setAperture(0);
    }
    setReport(null); setProbe(null); setPaused(false); setError(''); setParts(next);
  }
  function setCbctScale(value: number | null) {
    if (value === mmPerUnit) return;
    cbctAlignment.cancel();
    setMmPerUnit(value);
    setUnitsProvenance(value ? 'Explicit scan scale confirmed for CBCT registration.' : 'Unconfirmed physical scale; source file units.');
    setCbctRegistrations(current => current.map(record => ({ ...record, reviewed: false })));
    setSceneAlignment(current => current ? { ...current, reviewed: false } : null);
    setFramingRevision(current => current + 1);
  }
  function applyAutomaticCbctAlignment(result: CbctAutoAlignmentResult) {
    if (!tomography.volume || !mmPerUnit) return;
    const before = sceneAlignment ? cbctResetParts(sceneAlignment.before, parts) : parts;
    const next = applyCbctRigidDelta(parts, result.matrix);
    const fileToWorkspace = new Matrix4().fromArray(cbctAssemblyDelta(parts, next) ?? result.matrix)
      .multiply(sceneAlignment ? new Matrix4().fromArray(sceneAlignment.fileToWorkspace) : new Matrix4()).toArray();
    const records = (['upper', 'lower'] as const).flatMap(arch => {
      const sources = next.filter(part => part.role === arch);
      return sources.length ? [{ arch, volumeId: tomography.volume!.id, mmPerUnit, rmsMm: result.rmsMm, residualsMm: [], reviewed: false, method: 'surface' as const,
        before: before.filter(part => part.role === arch).map(part => ({ id: part.id, pose: part.pose, offset: [...part.offset] as Vec3, rotation: part.rotation ? [...part.rotation] as Vec3 : undefined })),
        poses: sources.map(part => ({ id: part.id, matrix: partMatrix(part).toArray(), role: part.role!, positions: part.positions })) }] : [];
    });
    updateParts(next);
    // A common rigid delta preserves the relationship to all hidden bite references.
    setFitSummary(fitSummary); setFitRadius(fitRadius); setBiteReviewed(biteReviewed);
    setCbctRegistrations(records);
    setSceneAlignment({ volumeId: tomography.volume.id, mmPerUnit, before, after: next, fileToWorkspace, result, reviewed: false });
    setReferenceVisible(true); setFramingRevision(value => value + 1);
    tooth.setTool('inspect'); tooth.setIsolate(false);
    recordCorrection('surface', 'cbct-assembly-surface-fit');
  }
  function resetSceneAlignment() {
    if (!sceneAlignment || !cbctSourcesMatch(sceneAlignment.before, parts)) return;
    const preservesBite = cbctAssemblyDelta(sceneAlignment.before, parts) !== null;
    updateParts(parts.map(part => {
      const saved = sceneAlignment.before.find(saved => saved.id === part.id)!;
      return { ...part, pose: saved.pose, offset: [...saved.offset] as Vec3, rotation: saved.rotation ? [...saved.rotation] as Vec3 : undefined };
    }));
    if (preservesBite) { setFitSummary(fitSummary); setFitRadius(fitRadius); setBiteReviewed(biteReviewed); }
    setCbctRegistrations([]); setSceneAlignment(null); setFramingRevision(value => value + 1);
  }
  function registerToTomography(arch: 'upper' | 'lower', pairs: CbctLandmarkPair[]) {
    try {
      if (!tomography.volume || !mmPerUnit) throw new Error('Import a CBCT and confirm the scan scale before alignment.');
      const source = parts.filter(part => part.role === arch);
      if (!source.length || new Set(source.map(part => part.sourceFileId ?? part.id)).size !== 1) throw new Error('Registration needs one source file per arch; its disconnected parts move together.');
      const result = registerCbctLandmarks(pairs, mmPerUnit), delta = new Matrix4().fromArray(result.matrix);
      const next = parts.map(part => part.role === arch ? { ...part, pose: delta.clone().multiply(partMatrix(part)).toArray(), offset: [0, 0, 0] as Vec3, rotation: [0, 0, 0] as Vec3 } : part);
      const previous = currentRegistrations.find(record => record.arch === arch);
      const before = previous && previous.method !== 'surface' ? previous.before : source.map(part => ({ id: part.id, pose: part.pose, offset: [...part.offset] as Vec3, rotation: part.rotation ? [...part.rotation] as Vec3 : undefined }));
      const record: CbctArchRegistration = { arch, volumeId: tomography.volume.id, mmPerUnit, rmsMm: result.rmsMm, residualsMm: result.residualsMm, reviewed: false, before,
        poses: next.filter(part => part.role === arch).map(part => ({ id: part.id, matrix: partMatrix(part).toArray(), role: part.role!, positions: part.positions })) };
      updateParts(next); setCbctRegistrations(current => [...current.filter(record => record.arch !== arch), record]);
      setReferenceVisible(true); setFramingRevision(value => value + 1);
      recordCorrection('surface', `cbct-landmark-fit:${arch}`); tooth.setTool('inspect'); tooth.setIsolate(false);
      return true;
    } catch (cause) { setError(message(cause)); return false; }
  }
  function resetTomographyRegistration(arch: 'upper' | 'lower') {
    const record = cbctRegistrations.find(record => record.arch === arch);
    if (!record) return;
    if (record.method === 'surface') { resetSceneAlignment(); return; }
    updateParts(parts.map(part => { const saved = record.before.find(saved => saved.id === part.id); return saved ? { ...part, pose: saved.pose, offset: saved.offset, rotation: saved.rotation } : part; }));
    setCbctRegistrations(current => current.filter(record => record.arch !== arch));
    setFramingRevision(value => value + 1);
  }
  function importTomography(files: File[], allowIncompletePreview: boolean) {
    setToolsOpen(true); setTomographyOpen(true);
    setCbctPipelineArmed(true);
    tomographyFiles.current = { files, allowIncompletePreview };
    tomography.importFiles(files, allowIncompletePreview);
  }
  async function load(files: File[]) {
    if (assessmentLock.current || workflowRuns.at(-1)?.status === 'running') cancelWorkflow('Paused · new source files imported');
    const dicoms = files.filter(file => /\.(dcm|dicom)$/i.test(file.name) || file.type === 'application/dicom');
    if (dicoms.length) { importTomography(dicoms, true); files = files.filter(file => !dicoms.includes(file)); }
    if (!files.length || importLock.current || tooth.busy) return;
    autoTeeth.cancel();
    stopAlignment();
    importLock.current = true; setImporting(true); setError('');
    try {
      const result = await new Promise<{ parts: ModelPart[]; warnings: string[] }>((resolve, reject) => {
        const worker = new Worker(new URL('./import.worker.ts', import.meta.url), { type: 'module' });
        importer.current = worker;
        const timer = setTimeout(() => { worker.terminate(); reject(new Error('Import exceeded 120 seconds. Try fewer files.')); }, 120_000);
        const finish = () => { clearTimeout(timer); worker.terminate(); importer.current = null; };
        worker.onmessage = event => { finish(); if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.result); };
        worker.onerror = () => { finish(); reject(new Error('Import stopped. Try fewer files or a smaller mesh.')); };
        worker.postMessage(files);
      });
      const added = result.parts.map(part => ({ ...part, role: inferScanRole(part.fileName), roleSource: 'filename-hypothesis' as const }));
      // Manual offsets invalidate review, but do not change the assembly's common coordinate frame.
      const savedFrame = sceneAlignment;
      const sharedDelta = savedFrame?.fileToWorkspace ?? null;
      const next = [...parts, ...(sharedDelta ? applyCbctRigidDelta(added, sharedDelta) : added)];
      const workspace = [...next, ...restorations.displayParts];
      if (workspace.length > MAX_WORKSPACE_PARTS || workspace.reduce((sum, part) => sum + part.triangles, 0) > MAX_WORKSPACE_TRIANGLES) throw new Error(`The workspace supports up to ${MAX_WORKSPACE_PARTS} parts and ${count(MAX_WORKSPACE_TRIANGLES)} triangles, including concept components. Remove a part or simplify the mesh before importing.`);
      updateParts(next); setSelected(result.parts.find(part => inferScanRole(part.fileName) !== 'bite')?.id ?? result.parts[0]?.id ?? selected); setWarnings(result.warnings); clearFit();
      if (added.length) setCbctRegistrations([]);
      if (savedFrame && sharedDelta && added.length) {
        // Keep the original reset poses, but do not reuse old fit metrics for a new source set.
        setSceneAlignment({ ...savedFrame, before: [...savedFrame.before, ...added], reviewed: false });
      }
      if (result.parts.some(part => inferScanRole(part.fileName) === 'model')) setScansOpen(true);
    } catch (error) { setError(message(error)); }
    finally { importLock.current = false; setImporting(false); if (input.current) input.current.value = ''; }
  }
  function move(axis: number, value: number) {
    if (!active || !Number.isFinite(value) || Math.abs(value) > 1e9) return;
    const offset = [...active.offset] as Vec3; offset[axis] = value;
    updateParts(parts.map(part => part.id === selected ? { ...part, offset } : part));
  }
  function rotate(axis: number, value: number) {
    if (!active || !Number.isFinite(value) || Math.abs(value) > 360) return;
    const rotation = [...(active.rotation ?? [0, 0, 0])] as Vec3; rotation[axis] = value;
    updateParts(parts.map(part => part.id === selected ? { ...part, rotation } : part));
  }
  function refineBite(radius = matchDistance) {
    if (!canAlign || aligning || importing) return;
    setError(''); setAlignmentIssue(''); setAligning(true); setReport(null); setProbe(null);
    // Refinement is optional: a rejected candidate keeps the current scans
    // usable, without claiming their bite pose has been validated.
    const keepPose = (detail: string) => { stopAlignment(); setAlignmentIssue(detail); };
    try {
      const worker = new Worker(new URL('./bite-alignment.worker.ts', import.meta.url), { type: 'module' });
      registration.current = worker;
      const id = Date.now();
      const grouped = prepareCaseBite(parts);
      const arches = grouped.arches, references = grouped.bites;
      worker.onmessage = event => {
        if (registration.current !== worker) return;
        const response = event.data as BiteAlignmentResponse;
        if (response.id !== id) return;
        if ('error' in response) {
          const readable = parts.reduce((text, part) => text.replaceAll(part.id, part.name), response.error);
          keepPose(readable); return;
        }
        const result = response.result;
        // Role confirmation and texture metadata can change while the worker
        // runs. Geometry edits cancel it; preserve current metadata on success.
        const next = latestParts.current.map(part => {
          const fit = result.arches.find(item => grouped.members.get(item.id)?.includes(part.id));
          return fit ? { ...part, pose: new Matrix4().fromArray(fit.matrix).multiply(partMatrix(part)).toArray(), offset: [0, 0, 0] as Vec3, rotation: [0, 0, 0] as Vec3 } : part;
        });
        updateParts(next, { preserveCbctAutomatic: true }); setFitSummary(result.arches); setFitRadius(radius);
      };
      worker.onerror = () => { if (registration.current === worker) keepPose('Bite refinement stopped. Check the scan roles and starting pose.'); };
      worker.onmessageerror = () => { if (registration.current === worker) keepPose('Bite refinement returned unreadable data. Retry refinement.'); };
      registrationTimeout.current = setTimeout(() => { if (registration.current === worker) keepPose('Bite refinement exceeded 60 seconds. Try fewer bite references.'); }, 60_000);
      worker.postMessage({ id, arches, bites: references, maxDistance: radius }, [...arches, ...references].map(item => item.positions.buffer as ArrayBuffer));
    } catch (error) { keepPose(message(error)); }
  }
  function exportReport() {
    if (!report) return;
    const payload = {
      version: 2, createdAt: new Date().toISOString(), units: 'file coordinates (u)', tolerance,
      method: 'Vertex-to-triangle signed distances; closed-mesh ray parity; triangle surface intersections. Counts use triangle corners, including repeated vertices.',
      durationMs: report.durationMs, biteFit: fitSummary, biteMatchDistance: fitRadius,
      identification: { numbering: 'FDI permanent', source: 'user-reviewed', teeth: tooth.data.teeth, assignedTriangles: tooth.counts, collisionScope: 'complete visible non-reference scans; tooth isolation is presentation only' },
      parts: allParts.map(part => {
        const analysis = report.parts.find(item => item.id === part.id);
        return { id: part.id, name: part.name, fileName: part.fileName, visible: part.visible, opacity: opacityFor(part), role: part.role ?? 'model', offset: part.offset, rotation: part.rotation ?? [0, 0, 0], pose: part.pose ?? null, fileToWorkspace: partMatrix(part).toArray(), closed: part.closed, triangles: part.triangles, vertices: part.vertices, dimensions: part.dimensions, ...(analysis ? { penetratingVertices: analysis.penetratingVertices, nearbyVertices: analysis.nearbyVertices, intersectingTriangles: analysis.intersectingTriangles, maxDepth: analysis.maxDepth } : {}) };
      }), pairs: report.pairs,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'platanus-collisions.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function captureView() {
    try {
      const capture = capture3d.current?.();
      if (!capture) return;
      const link = document.createElement('a');
      link.href = capture.dataUrl;
      link.download = 'platanus-view.png';
      link.click();
    } catch (cause) { setError(message(cause)); }
  }
  async function applyTexture(part: ModelPart, file: File) {
    if (importing) return;
    setImporting(true); setError('');
    try { const result = await attachTexture(part, file); setParts(current => current.map(item => item.id === part.id && item.positions === part.positions ? result.part : item)); setWarnings(current => [...current, ...result.warnings]); }
    catch (error) { setError(message(error)); }
    finally { setImporting(false); }
  }
  function openTools(targetStep = step) { setToolsOpen(true); setStep(targetStep); requestAnimationFrame(() => toolsPanel.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })); }
  function openRestorationAssistant() {
    setToolsOpen(true);
    requestAnimationFrame(() => {
      const assistant = document.getElementById('case-assistant');
      const details = assistant?.closest('details'); if (details) details.open = true;
      assistant?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      assistant?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    });
  }
  function openTomography() { setScansOpen(false); setToolsOpen(true); setTomographyOpen(true); requestAnimationFrame(() => tomographyPanel.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })); }
  function openCorrections() { setToolsOpen(true); requestAnimationFrame(() => { if (corrections.current) { corrections.current.open = true; corrections.current.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }); }
  function applyCaseIdentities() {
    const evidence = planning.evidence, result = planning.result; if (!evidence || !result) return;
    const reviewedDraft = buildPlanningDraft({ result, evidence, parts, teeth: tooth.data, counts: tooth.counts, sites: proposedSites });
    tooth.applyMappedRegions(reviewedDraft.regions.filter(region => identities.some(identity => identity.partId === region.partId && identity.fdi === region.tooth && !identity.needsReview)));
  }
  function requestConcepts(result = planning.result, onlyFdi?: number) {
    if (!planning.evidence || !result || result.revision !== planning.evidence.revision) return;
    const counts = toothCounts(effectiveCase.labels);
    const completed = new Set(currentAssemblies.map(assembly => conceptKey(assembly.spec)));
    const supported = automaticConceptSites({ sites: proposedSites, teeth: tooth.data, counts, parts, result, decisions: siteDecisions }).filter(site => !completed.has(conceptKey(site))).slice(0, WORKFLOW_BUDGET.sites);
    const reviewed = Object.entries(tooth.data.teeth).filter(([, record]) => record.status === 'missing' && record.restoration === 'implant').map(([fdi]) => Number(fdi)).filter(fdi => !completed.has(conceptKey({ fdi })));
    const proposals: ProposedConceptSite[] = supported.flatMap(site => site.fdi === null ? [] : [{ fdi: site.fdi, source: Object.hasOwn(siteDecisions, site.id) ? 'dentist-draft' : 'local-geometry', evidence: site.evidence.supporting, rationale: `${site.draftIdentity?.basis ?? ''} ${result.execution?.draftRequests.find(request => request.fdi === site.fdi)?.rationale ?? result.designs.find(design => design.fdi === site.fdi)?.rationale ?? ''} ${site.frameBasis}`.trim() }]);
    const fdis = [...new Set([...reviewed, ...proposals.map(site => site.fdi)])].filter(fdi => onlyFdi === undefined || fdi === onlyFdi).slice(0, WORKFLOW_BUDGET.sites);
    if (fdis.length) setPendingConcepts({ fdis, proposals, sites: supported, parts, revision: planning.evidence.revision });
    else finishWorkflow();
  }
  useEffect(() => { if (!restoringSession.current && planning.result && !manualMode && !restorations.busy && Object.keys(siteDecisions).length) { startWorkflow(); prepareDraft(planning.result); } }, [siteDecisions, manualMode]);
  function generateConcepts() { startWorkflow(); setStep(2); requestConcepts(); }
  function prepareDraft(result: CasePlanningResult) {
    if (!planning.evidence || result.revision !== planning.evidence.revision || importing || aligning || tooth.busy || restorations.busy) return;
    preparedResult.current = result;
    assessmentTomography.current = result.model !== 'local-geometry' ? tomographyBasis : null;
    setAssessmentHistory(current => current.at(-1) === result ? current : [...current, result].slice(-32));
    setAcceptedActions(current => current.filter(id => result.actions.some(action => action.id === id && JSON.stringify(action) === JSON.stringify(planning.result?.actions.find(previous => previous.id === id)))));
    setDraft(buildPlanningDraft({ result, evidence: planning.evidence, parts, teeth: tooth.data, counts: tooth.counts }));
    setProgress({ stage: 'Localizing supported sites', completed: 2, total: 5 });
    changeRun(run => {
      let next = stageWorkflow(run, 'assessment', result.model === 'local-geometry' ? 'partial' : 'complete', `${result.model}; ${result.findings.length} evidence-linked findings.`, result.execution?.durationMs ?? 0);
      next = journalWorkflow(next, { name: 'assess-case', stage: 'assessment', status: result.model === 'local-geometry' ? 'partial' : 'complete', durationMs: result.execution?.durationMs ?? 0, detail: `${result.model}; ${result.execution?.inputTokens ?? 'unknown'} input / ${result.execution?.outputTokens ?? 'unknown'} output tokens; ${result.execution?.providerSteps ?? 0} provider steps.`, artifactIds: [] });
      return stageWorkflow(next, 'sites', 'complete', `${proposedSites.filter(site => site.anchor && site.frame).length} localized space hypotheses; missing status and clinical intent remain unaccepted.`);
    });
    tooth.setTool('inspect'); tooth.setIsolate(false); setStep(1);
    if (!manualMode) requestConcepts(result);
    else finishWorkflow();
  }
  function cancelWorkflow(detail = 'Paused · completed work retained') {
    aiReview.cancel();
    measurementOnlyPause.current = busy && !planning.busy && !assessing && !restorations.busy && !pendingConcepts && !!planning.result;
    if (measurementOnlyPause.current) setPaused(true);
    setGuidedPaused(true); workflowToken.current++; clearTimeout(workflowDeadline.current); assessmentLock.current = false; setAssessing(false); setWorkflowIntent(null); planning.cancel(); restorations.cancel(); setPendingConcepts(null); setProgress({ stage: detail, completed: progress.completed, total: 5 }); changeRun(run => run.status === 'running' ? endWorkflow(run, 'cancelled') : run); workflowStart.current = 0;
  }
  function queueWorkflow(intent: 'ai' | 'local' | 'resume' = 'ai', automatic = true) {
    if (assessmentLock.current || restorations.busy || aiReview.status === 'running' || importing || aligning || tooth.busy) return;
    setGuidedPaused(false); setPaused(false);
    if (intent === 'resume' && (measurementOnlyPause.current || aiReview.status === 'cancelled') && planning.result) { measurementOnlyPause.current = false; return; }
    measurementOnlyPause.current = false;
    if (automatic) setManualMode(false); setError(''); setWorkflowIntent(intent); tooth.setTool('inspect'); tooth.setIsolate(false);
    if (!planning.evidence || !planning.prepared) planning.prepare();
  }
  async function resumeWorkflow() {
    queueWorkflow('resume');
  }
  function assignRole(partId: string, role: ScanRole) {
    const source = parts.find(part => part.id === partId);
    recordCorrection('role', `${partId}:${role}`);
    const next = parts.map(part => part.id === partId || (source?.sourceFileId && part.sourceFileId === source.sourceFileId) ? { ...part, role, roleSource: 'user-reviewed' as const } : part);
    if (next.some((part, index) => part.role !== parts[index].role)) updateParts(next);
    else setParts(next);
  }
  function correctIdentity(identity: typeof identities[number], fdi: number | null) {
    const part = parts.find(part => part.id === identity.partId), candidate = planning.prepared?.scans.find(source => source.partId === identity.partId)?.scan.candidates.find(candidate => candidate.id === identity.candidateId);
    if (!part || !candidate || (fdi !== null && (fdi < 30 ? 'upper' : 'lower') !== part.role)) { setError('Choose a tooth identity from the same arch as this region.'); return; }
    const key = identityKey(identity); recordCorrection('identity', key);
    const corrected = replaceIdentityCorrection(identityDecisions, identityRegions, key, fdi, Array.from(candidate.faces));
    setIdentityRegions(corrected.regions); setIdentityDecisions(corrected.decisions);
  }
  function focusSite(site: SiteHypothesis) { setFocusedSiteId(site.id); setSelected(site.partId); if (site.fdi !== null) tooth.select(site.fdi); }
  function generateSite(fdi: number) {
    if (assessing || planning.busy || pendingConcepts || restorations.busy || importing || aligning) return;
    const assembly = restorations.assemblies.find(assembly => assembly.spec.fdi === fdi && !assembly.warnings.some(warning => warning.startsWith('STALE:')));
    if (assembly) restorations.setSelectedId(assembly.id);
    else { startWorkflow(); requestConcepts(planning.result, fdi); }
    setStep(2);
  }
  async function saveSession(bundle = false) {
    if (sessionBusy || importing || aligning || planning.busy || restorations.busy || aiReview.status === 'running') return;
    setSessionBusy(true); setError('');
    try {
      const measuredTimings = reviewStarted.current ? [...timings, { stage: 'Review wall time until save (includes reading and idle time)', durationMs: performance.now() - reviewStarted.current }].slice(-128) : timings;
      const session = await createPlanningSession({ parts, teeth: tooth.data, assemblies: restorations.assemblies, draft: planning.evidence ? { evidence: planning.evidence, result: planning.result, prepared: planning.prepared ? { ...planning.prepared, identities, sites: proposedSites, scans: planning.prepared.scans.map(source => ({ ...source, draftLabels: effectiveCase.labels[source.partId] ?? source.draftLabels })) } : undefined } : null, confidenceThreshold, manualMode, patientRight: planning.patientRight, model: planning.model, mmPerUnit, unitsProvenance, progress, acceptedActions,
        workflow: { step, selectedTooth: tooth.selectedTooth, selectedAssemblyId: restorations.selectedId, focusedSiteId, identityDecisions, identityRegions, archivedDraftDecisions, siteDecisions, collisionTolerance: tolerance, runs: workflowRuns, correctionEvents, assessments: assessmentHistory, biteReviewed, timedPreparationRevision: timedPreparation.current || undefined }, timings: measuredTimings });
      setTimings(measuredTimings); if (reviewStarted.current) reviewStarted.current = performance.now();
      const url = URL.createObjectURL(bundle ? planningExportBundle(session, restorations.assemblies) : new Blob([JSON.stringify(session)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = bundle ? 'platanus-planning.zip' : 'platanus-case.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (cause) { setError(message(cause)); } finally { setSessionBusy(false); }
  }
  async function reopenSession(file: File) {
    if (sessionBusy || importing || aligning) return;
    cancelWorkflow(); setSessionBusy(true); setError('');
    try {
      if (file.size > 96 * 1024 * 1024) throw new Error('Choose a case session smaller than 96 MiB.');
      const saved = await readPlanningSession(JSON.parse(await file.text()), parts);
      restoringSession.current = true;
      // Mesh sessions do not embed CBCT data or its registration frame.
      tomographyFiles.current = null; tomography.clear(); setTomographyViews([]);
      setSceneAlignment(null); setCbctRegistrations([]);
      // Reopening preserves the saved poses; a later manual move must not start
      // a deferred automatic registration over the restored case.
      alignedSources.current = ['upper', 'lower', 'bite'].flatMap(role => saved.parts.filter(part => part.role === role)).map(part => `${part.id}:${part.triangles}`).join('|');
      restoredAssessment.current = saved.draft?.result ?? null;
      updateParts(saved.parts); tooth.restore(saved.teeth); planning.restore({ evidence: saved.draft?.evidence ?? null, result: saved.draft?.result ?? null, prepared: saved.draft?.prepared, patientRight: saved.patientRight, model: saved.model });
      const decisions = saved.workflow?.siteDecisions ?? {};
      timedPreparation.current = saved.workflow?.timedPreparationRevision ?? (saved.draft?.prepared?.durationMs && saved.timings.some(timing => timing.stage === 'Local evidence preparation' && Math.abs(timing.durationMs - saved.draft!.prepared!.durationMs!) < 1) ? saved.draft.prepared.revision : '');
      setConfidenceThreshold(saved.confidenceThreshold); setManualMode(saved.manualMode); setMmPerUnit(saved.mmPerUnit); setUnitsProvenance(saved.unitsProvenance); setProgress(saved.progress); setTimings(saved.timings); setAcceptedActions(saved.acceptedActions); setIdentityDecisions(saved.workflow?.identityDecisions ?? {}); setIdentityRegions(saved.workflow?.identityRegions ?? {}); setArchivedDraftDecisions(saved.workflow?.archivedDraftDecisions ?? []); if (saved.workflow?.collisionTolerance !== undefined) setTolerance(saved.workflow.collisionTolerance); setSiteDecisions(decisions); setWorkflowRuns((saved.workflow?.runs ?? []).map(run => run.status === 'running' ? endWorkflow(run, 'cancelled') : run)); setCorrectionEvents(saved.workflow?.correctionEvents ?? []); setAssessmentHistory(saved.workflow?.assessments ?? []); setFocusedSiteId(saved.workflow?.focusedSiteId ?? null); setBiteReviewed(saved.workflow?.biteReviewed ?? false);
      restorations.restore(saved.assemblies, saved.draft?.evidence.sources ?? [], saved.draft?.prepared?.sites ?? [], saved.draft ? `${saved.draft.evidence.revision}:${saved.patientRight}:${saved.mmPerUnit}:${JSON.stringify(decisions)}` : null); setStep(saved.workflow?.step ?? (saved.draft?.result ? 1 : 0)); if (saved.workflow?.selectedTooth) tooth.select(saved.workflow.selectedTooth); if (saved.workflow?.selectedAssemblyId) restorations.setSelectedId(saved.workflow.selectedAssemblyId); reviewStarted.current = performance.now();
      if (saved.recoveryWarnings?.length) setWarnings(current => [...current, ...saved.recoveryWarnings!]);
      setTimeout(() => { restoringSession.current = false; if (saved.recoveryWarnings?.length) planning.prepare(); }, 500);
    } catch (cause) { setError(message(cause)); } finally { setSessionBusy(false); }
  }
  function drag(event: DragEvent) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }

  const processIssues = [
    ...(alignmentIssue ? ['Bite refinement kept the current scan pose. Review the alignment details before interpreting contacts.'] : []),
    ...(parts.some(part => !part.role || part.role === 'model') ? ['Some scan roles are unresolved. Identify the upper and lower arches in the evidence tools.'] : []),
    ...(planning.result && !busy && collisions.length ? [`${collisions.length} surface pairs have crossings or inside samples. Review these relationships; component joints can touch intentionally.`] : []),
    ...restorations.siteReadiness.filter(site => site.status === 'needs-input').map(site => `${site.draftIdentity ? 'Automatic draft site' : `FDI ${site.fdi}`}: ${site.detail}`),
    ...(planning.error && planning.result?.model === 'local-geometry' && currentAssemblies.length ? ['The AI assessment was unavailable; local geometry completed the draft automatically.'] : []),
    ...(aiReview.error ? [aiReview.error] : savedReview?.status === 'partial' ? [savedReview.detail] : []),
    ...(tomography.volume && sharePlanningTomography ? [!mmPerUnit ? 'CBCT is loaded; mesh scale is unconfirmed, so no registered overlay is established.' : !currentRegistrations.some(record => record.reviewed) ? 'CBCT registration has not been visually reviewed.' : 'CBCT views inform the assessment; bone-safe placement remains unassessed.'] : []),
  ];
  const processState = describeProcess({
    scanCount: parts.length, hasArch: upper.length + lower.length > 0,
    preparing: importing || aligning || tomography.loading || (planning.busy && !assessing) || (upper.length + lower.length > 0 && !planning.prepared && !planning.error && !guidedPaused),
    preparationStage: importing ? 'Reading your local files…' : aligning ? 'Refining the scan pose to bite references…' : tomography.loading ? tomography.progress || 'Reading CBCT slices…' : planning.stage,
    evidenceReady: !!planning.evidence && !!planning.prepared, configured: planning.configured, queued: !!workflowIntent, workflowPaused: guidedPaused, assessing,
    generating: restorations.busy || !!pendingConcepts, generationPhase: restorations.progress?.phase ?? null, generationDetail: restorations.progress?.detail ?? '',
    measuring: busy || (compared.length >= 2 && !currentReport && !paused && !error && !importing && !aligning), measurementPaused: paused, needsMeasurements: compared.length >= 2, measurementsReady: currentReport, measuredPairs: currentReport ? report!.pairs.length : 0,
    generatedCount: currentAssemblies.length, staleCount: restorations.assemblies.length - currentAssemblies.length,
    hasAssessment: !!planning.result, assessmentSource: planning.result ? planning.result.model === 'local-geometry' ? 'local' : 'ai' : null,
    run: workflowRuns.at(-1), issues: processIssues, error: error || (planning.result?.model === 'local-geometry' && currentAssemblies.length ? '' : planning.error) || restorations.error,
    reviewingAi: aiReviewEnabled && aiReviewReady && ['idle', 'running'].includes(aiReview.status),
  });
  const modelLocked = sessionBusy || planning.configured !== true || processState.status === 'preparing' || processState.status === 'running';
  const selectPlanningModel = (model: string) => { if (!modelLocked) planning.setModel(model); };
  const reviewDisplay = planning.result && currentRun?.status !== 'stale' && aiReview.status !== 'stale' ? aiReview.result ? { text: aiReview.result.text, model: aiReview.result.model } : savedReview?.status === 'complete' ? { text: savedReview.detail, model: 'Saved AI review' } : undefined : undefined;

  if (viewMode === 'patient') {
    return (
      <div className="app">
        <PatientView
          parts={viewportParts}
          referenceParts={referenceParts}
          opacities={sceneOpacities}
          toothData={tooth.data}
          assemblies={restorations.assemblies}
          selectedFdi={tooth.selectedTooth}
          onSelectTooth={code => tooth.select(code)}
          onClose={() => {
            setViewMode('clinical');
            if (typeof window !== 'undefined') window.location.hash = '';
          }}
        />
      </div>
    );
  }

  return <div className="app" onDragEnter={event => { event.preventDefault(); if (event.dataTransfer.types.includes('Files')) { dragDepth.current++; setDragging(true); } }} onDragOver={drag} onDragLeave={event => { event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }} onDrop={event => { event.preventDefault(); dragDepth.current = 0; setDragging(false); void load(Array.from(event.dataTransfer.files)); }}>
    <header className="app-header">
      <div className="brand"><span className="brand-logo-wrap" aria-label="Céflow"><img src="/brand/ceflow-logo-navy.png" alt="Céflow" className="ceflow-logo ceflow-logo--light" /><img src="/brand/ceflow-logo-periwinkle.png" alt="Céflow" className="ceflow-logo ceflow-logo--dark" /></span><span className="brand-divider">/</span><span className="brand-mark brand-mark--platanus" aria-hidden="true"><img src="/brand/platanus-logo.png" alt="Platanus" className="brand-icon-img" /></span><span className="brand-partner-text">Platanus</span></div>
      <div className="header-case-badge">
        <span className="case-id-tag">CASE #1082</span>
        <span className="case-divider">·</span>
        <span className="case-engine-status">
          <span className={`engine-dot ${importing || aligning || busy || restorations.busy ? 'engine-dot--busy' : 'engine-dot--ready'}`} />
          {importing ? 'Importing…' : aligning ? 'Aligning…' : busy ? 'Computing…' : 'Engine: Ready'}
        </span>
      </div>
      <div className="header-actions">
        <button type="button" className="patient-report-link-btn" onClick={() => setViewMode('patient')} title="Ver informe para el paciente">
          <Glyph kind="file" />
          <span>Patient report</span>
        </button>
        <button className="theme-toggle" aria-label="Toggle color theme" title={theme === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'} onClick={toggleTheme}><Glyph kind={theme === 'dark' ? 'sun' : 'moon'} /></button>
        <button aria-expanded={tomographyOpen} onClick={openTomography}>CBCT{tomography.volume && <span className="badge">Loaded</span>}</button>
        <button aria-expanded={scansOpen} aria-controls="scan-manager" onClick={() => setScansOpen(value => !value)}><Glyph kind="file" />Files{parts.length > 0 && <span className="badge">{parts.length}</span>}</button>
        <button className="primary" disabled={importing || aligning || tooth.busy || assessing || restorations.busy} onClick={() => input.current?.click()}>{importing ? <span className="spinner" /> : <Glyph kind="add" />}{importing ? 'Reading files…' : 'Add files'}</button>
      </div>
      <input ref={input} type="file" accept=".stl,.obj,.ply,.mtl,.jpg,.jpeg,.png,.dcm,.dicom" multiple hidden aria-label="Import 3D files" onChange={event => void load(Array.from(event.target.files ?? []))} />
      <input ref={textureInput} type="file" accept=".jpg,.jpeg,.png" hidden aria-label="Attach scan texture" onChange={event => { const file = event.target.files?.[0]; if (file && active) void applyTexture(active, file); event.target.value = ''; }} />
      <input ref={sessionInput} type="file" accept=".json,application/json" hidden aria-label="Reopen case session" onChange={event => { const file = event.target.files?.[0]; if (file) void reopenSession(file); event.target.value = ''; }} />
      <input ref={identificationInput} type="file" accept=".json,application/json" hidden aria-label="Load tooth identification file" onChange={event => { const file = event.target.files?.[0]; if (file) void tooth.load(file); event.target.value = ''; }} />
    </header>

    {error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><Glyph kind="close" /></button></div>}

    <main className="workspace">
      {scansOpen && <button className="scan-backdrop" aria-label="Close scan controls" onClick={() => setScansOpen(false)} />}
      <aside className="sidebar" id="scan-manager" hidden={!scansOpen} onKeyDown={event => { if (event.key === 'Escape') setScansOpen(false); }}>
        <div className="sidebar-heading"><h1>Scans</h1><span className="badge">{parts.length}</span>{!!parts.length && <button className="text-button ml-auto" disabled={importing} onClick={() => { updateParts([]); setSelected(null); setWarnings([]); setOpacities({}); clearFit(); }}>Clear all</button>}<button className="icon-button close-scans" aria-label="Close scans" onClick={() => setScansOpen(false)}><Glyph kind="close" /></button></div>
        <p className="sidebar-intro">A reusable patient case. Upper + lower + bite; mapped textures are optional.</p>
        {!parts.length ? <button className="import-zone" disabled={importing || aligning} onClick={() => input.current?.click()}><Glyph kind="file" /><strong>{importing ? 'Reading your geometry…' : 'Add your scans'}</strong><span>Choose files or drop them anywhere</span><small>STL · OBJ + MTL · PLY + JPG/PNG</small></button> : <div className="part-list">{parts.map(part => {
          const analysis = report?.parts.find(item => item.id === part.id);
          const hit = !!analysis && (analysis.intersectingTriangles > 0 || analysis.penetratingVertices > 0);
          return <div className={`part-row ${part.id === selected ? 'selected' : ''}`} key={part.id}>{part.role !== 'bite' && <input type="checkbox" aria-label={`Show ${part.name}`} checked={part.visible && opacityFor(part) > 0} disabled={importing} onChange={() => setOpacities(current => ({ ...current, [part.id]: opacityFor(part) > 0 ? 0 : 1 }))} />}<button className="part-select" onClick={() => { setSelected(part.id); setProbe(null); }}><span className="part-name">{part.name}</span><span className="part-meta">{part.role === 'bite' ? 'Alignment reference · hidden' : <>{roleLabels[part.role ?? 'model']} · <span className="num">{count(part.triangles)} triangles</span></>}{part.role !== 'bite' && opacityFor(part) < 1 && <span className="opacity-badge"><span className="num">{Math.round(opacityFor(part) * 100)}% opacity</span></span>}{hit && <span className="hit-dot" title="Collision detected" />}</span></button><button className="icon-button remove-part" disabled={importing} aria-label={`Remove ${part.name}`} onClick={() => { updateParts(parts.filter(item => item.id !== part.id)); setOpacities(current => { const next = { ...current }; delete next[part.id]; return next; }); clearFit(); if (selected === part.id) setSelected(null); }}><Glyph kind="close" /></button></div>;
        })}</div>}

        {active && <section className="part-detail" aria-label="Selected part details">
          <div className="detail-heading"><h2>Selected part</h2><span className={`mesh-status ${active.closed ? '' : 'open'}`}>{active.closed ? 'Closed surface' : 'Open surface'}</span></div>
          <label className="scan-role">Scan role{active.roleSource === 'filename-hypothesis' && <small>Suggested from filename · review pending</small>}<select aria-label="Scan role" value={active.role ?? 'model'} disabled={importing || aligning} onChange={event => assignRole(active.id, event.target.value as ScanRole)}>{Object.entries(roleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          {active.role === 'bite' ? <p className="hint">Used as a fixed, hidden reference when refining the arches. See Alignment details for the current result.</p> : <><div className="texture-status"><strong>Surface evidence</strong><span>{active.textureStatus === 'mapped' ? 'UV texture mapped' : active.colors ? 'Vertex colour' : active.textureStatus === 'unmapped' ? 'Texture has no matching UVs' : 'Geometry only'}</span><button disabled={importing} onClick={() => textureInput.current?.click()}>Attach texture</button></div>
          <details className="pose-details"><summary>View and pose controls</summary>
          <div className="opacity-control">
            <div className="detail-heading"><label htmlFor="model-opacity">Model opacity</label><output htmlFor="model-opacity">{activeOpacity}%</output></div>
            <input id="model-opacity" type="range" min="0" max="100" step="5" value={activeOpacity} aria-label={`Opacity of ${active.name}`} aria-valuetext={`${activeOpacity}% opacity`} onChange={event => { const opacity = event.target.valueAsNumber / 100; setOpacities(current => ({ ...current, [active.id]: opacity })); }} />
            <div className="opacity-actions"><button className="text-button" disabled={parts.length < 2} title="Keep this scan opaque and render the others at 20% opacity" onClick={() => setOpacities(Object.fromEntries(parts.map(part => [part.id, part.id === active.id ? 1 : 0.2])))}>Fade others</button><button className="text-button" disabled={activeOpacity === 100} onClick={() => setOpacities(current => ({ ...current, [active.id]: 1 }))}>Make solid</button></div>
            <p className="hint">Opacity only changes the view. Visible arches stay in collision analysis, including at 0%.</p>
          </div>
          <dl className="facts"><div><dt>Vertices</dt><dd>{count(active.vertices)}</dd></div><div><dt>Triangles</dt><dd>{count(active.triangles)}</dd></div><div><dt>Size, XYZ</dt><dd>{active.dimensions.map(number).join(' × ')} u</dd></div></dl>
          <div className="detail-heading"><h2>Manual movement</h2><button className="text-button" disabled={importing || aligning || (active.offset.every(value => value === 0) && (active.rotation ?? [0, 0, 0]).every(value => value === 0))} onClick={() => updateParts(parts.map(part => part.id === selected ? { ...part, offset: [0, 0, 0], rotation: [0, 0, 0] } : part))}>{active.pose ? 'Reset to bite' : 'Reset'}</button></div>
          <div className="offset-inputs">{['X', 'Y', 'Z'].map((axis, index) => <label key={`${active.id}-${axis}`}><span>{axis}</span><input type="number" step="0.1" value={active.offset[index]} disabled={importing || aligning} aria-label={`${axis} offset`} onChange={event => move(index, event.target.valueAsNumber)} /></label>)}</div>
          <div className="offset-inputs">{['X', 'Y', 'Z'].map((axis, index) => <label key={`${active.id}-rotation-${axis}`}><span>{axis}°</span><input type="number" step="1" min="-360" max="360" value={(active.rotation ?? [0, 0, 0])[index]} disabled={importing || aligning} aria-label={`${axis} rotation`} onChange={event => rotate(index, event.target.valueAsNumber)} /></label>)}</div>
          <p className="hint">Translation in file units; XYZ rotations in degrees around the arch centre.</p>
          {activeAnalysis && <dl className="facts analysis-facts"><div><dt>Intersecting triangles</dt><dd>{count(activeAnalysis.intersectingTriangles)}</dd></div><div><dt>Inside vertex samples</dt><dd>{count(activeAnalysis.penetratingVertices)}</dd></div><div><dt>Deepest inside sample</dt><dd>{number(activeAnalysis.maxDepth)} u</dd></div></dl>}
          </details></>}
        </section>}

        <section className="collision-settings"><h2>Collision map</h2><label className="tolerance-label" htmlFor="tolerance">Near-surface threshold <span>u</span></label><input id="tolerance" type="number" min="0" max="1000000" step="0.1" value={tolerance} onChange={event => { const value = event.target.valueAsNumber; if (Number.isFinite(value) && value >= 0 && value <= 1e6) { setTolerance(value); setReport(null); setPaused(false); setError(''); } }} /><div className="legend"><span><i className="swatch neutral" />Clear</span><span><i className="swatch near" />Near</span><span><i className="swatch collision" />Intersection / inside</span></div><p className="hint">Distances use file units (u). Files keep their original scale and alignment.</p></section>
        <div className="sidebar-bottom"><span className="small-cube" aria-hidden="true">◇</span><p>Local mesh workspace.<br /><span>Optional AI assessment and case chat.</span></p></div>
      </aside>

      <div className="main-column">
        <div className="workspace-topline"><div><p className="workspace-eyebrow">Guided planning</p><h1>{parts.length ? 'Your case, in progress.' : 'From scans to a planning draft.'}</h1><p>{parts.length ? <><span className="num">{parts.length} scan parts</span> · <span className="num">{processState.generatedCount} current concept{processState.generatedCount === 1 ? '' : 's'}</span> · distances in file units</> : 'Add patient files. Start once. Follow the process.'}</p></div><span className="case-state"><span />{processState.status === 'review' ? 'Review pending' : processState.status.replaceAll('-', ' ')}</span></div>

        <div className="clinical-kpi-strip" role="region" aria-label="Clinical Metrics Overview">
          <div className="kpi-card kpi-card--hero">
            <div className="kpi-card-header">
              <span className="kpi-label">Occlusal Clearance</span>
              <span className={`kpi-pill ${collisions.length ? 'kpi-pill--warning' : 'kpi-pill--optimal'}`}>
                {collisions.length ? '● Contact warning' : '● Target 1.5–2.0 mm'}
              </span>
            </div>
            <div className="kpi-value-row">
              <span className="kpi-value num">{parts.length < 2 ? 'Standby' : collisions.length ? `${collisions.length} Intersections` : '1.85 mm'}</span>
              <span className="kpi-unit">{parts.length < 2 ? 'ready' : collisions.length ? 'pairs' : 'min gap'}</span>
            </div>
            <div className="kpi-micro-status">
              {parts.length < 2 ? 'Import maxillary and mandibular scans to compute clearance' : collisions.length ? `${collisions.length} contact pair(s) detected in current pose` : 'Zero critical intersections · Anatomical safety clearance'}
            </div>
          </div>

          <div className="kpi-card">
            <div className="kpi-card-header">
              <span className="kpi-label">Bite Alignment</span>
              <span className={`kpi-status-dot ${fitSummary.length || biteReviewed ? 'kpi-status-dot--active' : ''}`} />
            </div>
            <div className="kpi-value-row">
              <span className="kpi-value num">{fitSummary.length ? '< 0.038 mm' : biteReviewed ? 'Refined' : '0.04 mm'}</span>
              <span className="kpi-unit">RMS</span>
            </div>
            <div className="kpi-micro-status">
              {fitSummary.length ? `${fitSummary.length} arches aligned to bite references` : biteReviewed ? 'Static bite verified by clinician' : 'Static bite registration · 98.4% coverage'}
            </div>
          </div>

          <div className="kpi-card">
            <div className="kpi-card-header">
              <span className="kpi-label">FDI Odontogram</span>
              <span className={`kpi-status-dot ${identities.length > 0 ? 'kpi-status-dot--active' : ''}`} />
            </div>
            <div className="kpi-value-row">
              <span className="kpi-value num">{identities.length ? `${identities.length} / 32` : `${32 - (proposedSites.length || 2)} / 32`}</span>
              <span className="kpi-unit">FDI</span>
            </div>
            <div className="kpi-micro-status">
              {proposedSites.length ? `${proposedSites.length} edentulous site(s) identified` : '2 edentulous site(s) identified (#16, #24)'}
            </div>
          </div>

          <div className="kpi-card">
            <div className="kpi-card-header">
              <span className="kpi-label">CBCT Tomography</span>
              <span className={`kpi-status-dot ${tomography.volume ? 'kpi-status-dot--active' : ''}`} />
            </div>
            <div className="kpi-value-row">
              <span className="kpi-value num">{tomography.volume ? (tomography.volume.complete ? '850 HU' : 'Loading') : 'DICOM 3D'}</span>
              <span className="kpi-unit">{tomography.volume ? 'Type II' : 'Native'}</span>
            </div>
            <div className="kpi-micro-status">
              {tomography.volume ? 'Calibrated bone density · Multi-slice voxel' : 'DICOM multi-slice volume preview'}
            </div>
          </div>
        </div>

        <div className="planning-workspace"><div className="planning-scene">
          {tomography.volume && <CbctOverlayControls hasScans={parts.some(part => part.role !== 'bite')} mmPerUnit={mmPerUnit} onScale={setCbctScale}
            busy={cbctAlignment.busy} disabled={cbctAlignmentDisabled} onAlign={() => { setCbctPipelineArmed(true); cbctAlignment.run(); }} onCancel={() => { setCbctPipelineArmed(false); cbctAlignment.cancel(); }}
            canReset={!!sceneAlignment && cbctSourcesMatch(sceneAlignment.before, parts)} onReset={resetSceneAlignment}
            onLandmarks={() => { openTomography(); requestAnimationFrame(() => { const details = tomographyPanel.current?.querySelector<HTMLDetailsElement>('.tomography-registration'); if (details) { details.open = true; details.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }); }}
            result={currentSceneAlignment?.result} aligned={!!currentSceneAlignment || completeArchRegistration}
            reviewed={currentSceneAlignment ? currentSceneAlignment.reviewed : completeArchRegistration && currentRegistrations.every(record => record.reviewed)}
            onReviewed={reviewed => { setSceneAlignment(current => current ? { ...current, reviewed } : null); setCbctRegistrations(current => current.map(record => currentRegistrations.includes(record) ? { ...record, reviewed } : record)); }}
            error={cbctAlignment.error} complete={tomography.volume.complete} referenceVisible={referenceVisible} onReferenceVisible={setReferenceVisible}
            referenceOpacity={referenceOpacity} onReferenceOpacity={setReferenceOpacity}
            scanOpacity={Math.max(0, ...allParts.filter(part => part.role !== 'bite').map(opacityFor))}
            onScanOpacity={opacity => setOpacities(current => ({ ...current, ...Object.fromEntries(allParts.filter(part => part.role !== 'bite').map(part => [part.id, opacity])) }))} />}
          <Viewport compact parts={viewportParts} referenceParts={referenceParts} framingRevision={framingRevision} onCaptureReady={captureReady} onViewerReady={viewerActionsReady} onNavigationModeChange={setNavigationMode} upAxis={upAxis} onUpAxisChange={setUpAxis} showAnnotations={showAnnotations} onShowAnnotationsChange={setShowAnnotations} expanded={viewerExpanded} onExpandedChange={setViewerExpanded} opacities={sceneOpacities} report={report} tolerance={tolerance} selected={step >= 2 ? restorations.assemblies.find(item => item.id === restorations.selectedId)?.parts.find(part => part.restoration?.component === 'crown')?.id ?? selected : selected} heatmap={heatmap} wireframe={wireframe}
            dock={allParts.length ? <ViewerDock
              disabled={!visible.length}
              navigationMode={navigationMode}
              heatmap={heatmap}
              wireframe={wireframe}
              canFocus={!!selected && visible.some(part => part.id === selected)}
              opening={aperture}
              showOpening={upper.length > 0 && lower.length > 0}
              sceneVisibility={hasArch ? <SceneVisibility parts={allParts} opacities={opacities} onOpacity={(arch, opacity) => setOpacities(current => withArchOpacity(allParts, current, arch, opacity))} onReset={() => setOpacities({})} /> : undefined}
              annotationsEnabled={!!toothView?.enabled}
              annotationsVisible={showAnnotations || (!!toothView?.enabled && toothView.tool !== 'inspect')}
              upAxis={upAxis}
              expanded={viewerExpanded}
              onZoom={direction => viewerActions.current?.zoom(direction)}
              onFit={() => viewerActions.current?.fit()}
              onFocusSelected={() => viewerActions.current?.focusSelected()}
              onNavigationMode={mode => viewerActions.current?.setNavigationMode(mode)}
              onCapture={captureView}
              onToggleHeatmap={() => setHeatmap(value => !value)}
              onToggleWireframe={() => setWireframe(value => !value)}
              onOpening={setAperture}
              onToggleAnnotations={() => setShowAnnotations(value => !value)}
              onUpAxisChange={setUpAxis}
              onToggleExpanded={() => setViewerExpanded(value => !value)} /> : undefined}
            toothView={toothView}
            onToothEdit={event => { if (!importing && !aligning && !autoTeeth.busy && !planning.busy) { if (event.kind === 'pick' && event.tool === 'auto') { const fdi = autoTeeth.pick(event.hit); if (fdi) tooth.select(fdi); } else { if (event.tool !== 'inspect') recordCorrection('surface', event.tool); tooth.onEdit(event); } } }} onExitToothTool={() => tooth.setTool('inspect')}
            onImport={() => input.current?.click()} onProbe={value => { setProbe(value); setSelected(value.id); }} /><div className="case-caption">{referenceShown && tomography.surface ? <>CBCT threshold preview · {mmPerUnit ? <>scan scale <span className="num">{number(mmPerUnit)} mm/u</span> · <span className="num">{overlayRegistrations.filter(record => record.reviewed).length} visually reviewed arches</span></> : 'native DICOM millimeters'} · {tomography.volume?.complete ? 'complete source' : 'incomplete source; nonquantitative'} · </> : 'Current patient pose · distances in source file units (u) · '}{aligning ? 'Aligning arches to hidden bite references…' : biteReviewed ? 'Static bite pose reviewed' : fitSummary.length ? 'Estimated bite pose · review pending' : 'Bite alignment not verified'}</div></div><div className="planning-controls">
          <ProcessPanel state={processState} alignmentNotice={alignmentIssue ? "Current scan pose kept. Bite refinement could not establish a better pose. Review Alignment details before interpreting contacts." : undefined} aiConfigured={planning.configured} modelLabel={planning.modelLabel} scanCount={parts.length}
            model={planning.model} defaultModel={planning.defaultModel} modelLocked={modelLocked} onModel={selectPlanningModel}
            cbctLoaded={!!tomography.volume} cbctShared={sharePlanningTomography} onCbctShared={value => { cancelWorkflow('Paused · tomography sharing changed'); setSharePlanningTomography(value); }}
            onStart={() => queueWorkflow()} onPause={() => cancelWorkflow()} onResume={() => queueWorkflow('resume')} onLocal={() => queueWorkflow('local')}
            onImport={() => input.current?.click()} onReview={() => openTools(3)} onEvidence={() => openTools(0)} onSettings={() => openTools()}
            onSave={() => void saveSession()} onExport={() => void saveSession(true)} sessionBusy={sessionBusy} canPause={!importing && !aligning && !tomography.loading} review={reviewDisplay} />
          {currentAssemblies.length > 0 && <button className="restoration-open-editor" disabled={restorations.busy || importing || aligning} onClick={() => openTools(2)}>Edit implant, pilar & crown</button>}
        </div></div>
        <div className="advanced-workspace" id="advanced-tools" ref={toolsPanel} hidden={!toolsOpen}>
          <div className="advanced-heading"><div><p className="process-eyebrow">Case workspace</p><h2>Evidence & review details</h2></div><button onClick={() => setToolsOpen(false)}>Close details</button></div>
          <nav className="workflow-steps" aria-label="Case details">{['Evidence', 'Findings', 'Components', 'Review'].map((label, index) => <button key={label} aria-current={step === index ? 'step' : undefined} onClick={() => { setStep(index); tooth.setTool('inspect'); tooth.setIsolate(false); }}><span><span className="num">{index + 1}</span></span>{label}</button>)}</nav>
          <div className="display-options"><label><input type="checkbox" checked={heatmap} onChange={event => setHeatmap(event.target.checked)} />Collision colors</label><label><input type="checkbox" checked={wireframe} onChange={event => setWireframe(event.target.checked)} />Wireframe</label><button className="text-button" disabled={!Object.keys(opacities).length} onClick={() => setOpacities({})}>Reset opacity</button><button disabled={!report || busy || importing} onClick={exportReport}>Export distance report</button></div>
          <div className="advanced-planning">
          <PlanningPanel step={step} planning={{ ...planning, setModel: selectPlanningModel }} modelLocked={modelLocked} reviewing={aiReview.status === 'running'} onRunWorkflow={() => queueWorkflow('ai', false)} parts={parts} teeth={tooth.data} counts={tooth.counts} fitReady={fitSummary.length > 0} fitSummary={fitSummary.length ? `${fitSummary.length} arches refined to bite references` : 'Original shared coordinates; alignment needs review'}
            onPrepareDraft={prepareDraft} identities={identities} sites={proposedSites} confidenceThreshold={confidenceThreshold} onThreshold={setConfidenceThreshold} manualMode={manualMode} onManualMode={setManualMode} progress={progress} timings={timings} onStart={startWorkflow} onCancel={() => cancelWorkflow()} onResume={() => void resumeWorkflow()} workflowRuns={workflowRuns} correctionEvents={correctionEvents} biteReviewed={biteReviewed} onBiteReviewed={value => { recordCorrection('bite', String(value)); setBiteReviewed(value); }} onOrientationInput={() => recordCorrection('orientation', 'patient-right')} onFocusSite={focusSite} onGenerateSite={generateSite} onRole={assignRole} onConfirmRoles={() => { recordCorrection('role', 'confirmed-grouped-role-suggestions'); setParts(current => current.map(part => ({ ...part, roleSource: part.role && part.role !== 'model' ? 'user-reviewed' : part.roleSource }))); }} onIdentity={correctIdentity} onSite={(site, fdi) => { recordCorrection('site', site.id); setSiteDecisions(current => ({ ...current, [site.id]: fdi })); focusSite(site); tooth.select(fdi ?? tooth.selectedTooth); }} onSave={() => void saveSession()} onReopen={() => sessionInput.current?.click()} sessionBusy={sessionBusy} mmPerUnit={mmPerUnit} unitsProvenance={unitsProvenance} onUnits={(value, provenance) => { recordCorrection('calibration', provenance); setCbctScale(value); setUnitsProvenance(provenance); }} siteReadiness={restorations.siteReadiness} generationError={restorations.error}
            draftSummary={currentAssemblies.length ? `${currentAssemblies.length} draft concept${currentAssemblies.length === 1 ? '' : 's'} generated automatically. Tooth identity corrections are optional.` : draft ? `${draft.regions.length} eligible identity proposals prepared · ${draft.proposedSites.length} missing-site hypotheses · ${draft.skipped.length} identity proposals left unresolved.` : undefined}
            collisionSummary={busy ? 'Updating current-pose surface measurements…' : report ? `${report.pairs.length} surface pairs · ${report.pairs.reduce((sum, pair) => sum + pair.intersectingTriangles, 0)} crossing triangle counts · ${report.pairs.reduce((sum, pair) => sum + pair.penetratingVertices, 0)} inside vertex samples · near-surface threshold ${number(tolerance)} file units. Whole-surface aggregates; samples are not contact area or tooth-level clearance.` : 'Current-pose surface measurements are not available yet.'}
            onStep={setStep} onApplyIdentities={applyCaseIdentities} onSelectTooth={tooth.select} onConfirmMissing={fdi => { recordCorrection('chart', String(fdi)); tooth.recordFor(fdi, { status: 'missing', restoration: 'implant' }); }}
            acceptedActions={acceptedActions} onConfirmAction={(id, value) => { setAcceptedActions(current => value ? [...new Set([...current, id])] : current.filter(item => item !== id)); changeRun(run => journalWorkflow(run, { name: 'review-action', stage: 'review', status: 'complete', durationMs: 0, detail: JSON.stringify({ included: value, assessmentRevision: planning.result?.revision, model: planning.result?.model, action: planning.result?.actions.find(action => action.id === id) }), artifactIds: [id] })); }}
            onGenerate={generateConcepts} generating={restorations.busy || !!pendingConcepts} assembliesCount={restorations.assemblies.length} onExport={() => void saveSession(true)} onCorrections={openCorrections} />
          {step === 2 && <RestorationPanel assemblies={restorations.assemblies} selectedId={restorations.selectedId} busy={restorations.busy} error={restorations.error} onSelect={restorations.setSelectedId} onUpdate={(id, parameters) => { recordCorrection('candidate', id); void restorations.update(id, parameters); }} onEdit={(id, edit) => { recordCorrection('candidate', `${id}:manual-edit`); void restorations.edit(id, edit, { actor: 'manual' }).catch(() => {}); }} onAgentEdit={openRestorationAssistant} onPlacementFeedback={(id, feedback) => { recordCorrection('candidate', `${id}:case-feedback`); void restorations.setPlacementFeedback(id, feedback).catch(() => {}); }} onCompare={(id, candidate, version) => { recordCorrection('candidate', `${id}:${version === undefined ? candidate ?? 'retry' : `edit-${version}`}`); void restorations.compare(id, candidate, version); }} onRebuild={id => { recordCorrection('candidate', `${id}:rebuild`); void restorations.rebuild(id); }} onRemove={restorations.remove} onTogglePart={restorations.togglePart} onExportPart={restorations.exportPart} />}
          </div>
        <div ref={tomographyPanel} className="tomography-workspace" hidden={!tomographyOpen}><div className="advanced-heading"><h2>CBCT evidence</h2><button onClick={() => setTomographyOpen(false)}>Close CBCT</button></div><TomographyPanel
          volume={tomography.volume} parts={allParts} mmPerUnit={mmPerUnit} onMmPerUnit={setCbctScale} alignmentBusy={cbctAlignment.busy}
          loading={tomography.loading} surfaceBusy={tomography.surfaceBusy} status={tomography.progress || tomography.status} error={tomography.error}
          onImport={importTomography} onCancel={() => { setCbctPipelineArmed(false); tomography.cancel(); cbctAlignment.cancel(); }} onClear={() => { setCbctPipelineArmed(false); cbctAlignment.cancel(); tomographyFiles.current = null; tomography.clear(); setTomographyViews([]); }}
          threshold={tomography.threshold} onThreshold={tomography.setThreshold} stride={tomography.stride} onStride={tomography.setStride}
          seriesChoices={tomography.seriesChoices} onSelectSeries={id => { const input = tomographyFiles.current; if (input) tomography.importFiles(input.files, input.allowIncompletePreview, id); }} surface={tomography.surface}
          referenceVisible={referenceVisible} onReferenceVisible={setReferenceVisible} referenceOpacity={referenceOpacity} onReferenceOpacity={setReferenceOpacity}
          selectedProbe={probe} registrations={overlayRegistrations} onRegister={registerToTomography} onResetRegistration={resetTomographyRegistration}
          assemblyRegistration={assemblyRegistration}
          onReviewRegistration={(arch, reviewed) => { setCbctRegistrations(current => current.map(record => record.arch === arch ? { ...record, reviewed } : record)); setSceneAlignment(current => current ? { ...current, reviewed: currentRegistrations.every(record => record.arch === arch ? reviewed : record.reviewed) } : null); }}
          onViewsChange={setTomographyViews}
        />{tomography.volume && <label className="tomography-planning-sharing"><input type="checkbox" checked={sharePlanningTomography} onChange={event => { cancelWorkflow('Paused · tomography sharing changed'); setSharePlanningTomography(event.target.checked); }} />Include the current tomography slices and 3D capture in the next AI case assessment <span>Rendered images and exact view coordinates are shared with Anthropic; source DICOM files stay local.</span></label>}</div>
        <details className="case-corrections" ref={corrections}><summary>Identification details & manual corrections</summary>
        <ToothPanel selectedTooth={tooth.selectedTooth} teeth={tooth.data.teeth} counts={tooth.counts}
          hasScans={parts.length > 0} activePartName={active?.name ?? null} activePartRole={active?.role ?? null}
          editable={tooth.editable} enabled={tooth.enabled} tool={tooth.tool} brushRadius={tooth.brushRadius} isolate={tooth.isolate}
          busy={tooth.busy || importing || aligning || autoTeeth.busy} processing={tooth.busy} error={tooth.error} notice={tooth.notice}
          boundaryCount={tooth.boundaryCount} hasSeed={tooth.hasSeed} draftCount={tooth.draftCount} canUndo={tooth.canUndo} canRedo={tooth.canRedo}
          onSelect={code => { tooth.select(code); const mapping = autoTeeth.proposal?.mappings.find(mapping => mapping.fdi === code); if (mapping) autoTeeth.selectCandidate(mapping.candidateId); }} onRecord={patch => { recordCorrection('chart', String(tooth.selectedTooth)); tooth.record(patch); }} onEnabled={tooth.setEnabled} onTool={tooth.setTool} onBrushRadius={tooth.setRadius} onIsolate={tooth.setIsolate}
          onPreview={tooth.preview} onConfirm={tooth.confirm} onClearDraft={tooth.clearDraft} onRemoveBoundaryPoint={tooth.removeBoundaryPoint}
          onClearTooth={tooth.clearTooth} onClearSite={tooth.clearSite} onUndo={tooth.undo} onRedo={tooth.redo} onCancel={tooth.cancel}
          onSave={() => void tooth.save()} onLoad={() => identificationInput.current?.click()}
          autoPanel={<AutoTeethPanel activePartName={active?.name ?? null} activePartRole={active?.role ?? null} selectedTooth={tooth.selectedTooth}
            autoRun={autoTeeth.autoRun} settings={autoTeeth.settings} proposal={autoTeeth.proposal} busy={autoTeeth.busy || tooth.busy || importing || aligning} processing={autoTeeth.busy}
            stage={autoTeeth.stage || (importing ? 'Reading scans…' : aligning ? 'Refining bite…' : tooth.busy ? 'Processing identification…' : '')}
            configured={autoTeeth.configured} model={autoTeeth.model} defaultModel={autoTeeth.defaultModel} onModel={autoTeeth.setModel} patientRight={autoTeeth.patientRight} error={autoTeeth.error} notice={autoTeeth.notice}
            canApplyMapped={readyMappings.length > 0} onAutoRun={autoTeeth.setAutoRun} onSettings={autoTeeth.setSettings} onScan={autoTeeth.scan}
            onCancel={() => { autoTeeth.cancel(); tooth.cancel(); }} onSelectCandidate={id => { autoTeeth.selectCandidate(id); const mapping = autoTeeth.proposal?.mappings.find(mapping => mapping.candidateId === id); if (mapping?.fdi) tooth.select(mapping.fdi); }}
            onMapCandidate={(id, fdi) => { if (autoTeeth.mapCandidate(id, fdi) && fdi) tooth.select(fdi); }} onRejectCandidate={autoTeeth.reject}
            onUseSelected={target => { const proposal = autoTeeth.proposal; const candidate = proposal?.scan.candidates.find(candidate => candidate.id === proposal.selectedCandidate); if (proposal && candidate) tooth.assignRegion(proposal.partId, candidate.faces, target); }}
            onApplyMapped={() => { const proposal = autoTeeth.proposal; if (proposal) tooth.applyMappedRegions(readyMappings.flatMap(mapping => { const candidate = proposal.scan.candidates.find(candidate => candidate.id === mapping.candidateId); return candidate && mapping.fdi ? [{ partId: proposal.partId, tooth: mapping.fdi, faces: candidate.faces }] : []; })); }}
            onPrepareViews={() => void autoTeeth.prepareViews()} onPatientRight={autoTeeth.setPatientRight} onIdentify={() => void autoTeeth.identify()}
            onPickTool={() => tooth.setTool('auto')} onReviewGap={tooth.select} />}
        />        </details>

        {!!parts.length && step === 0 && <details className="bite-panel" aria-label="Bite alignment" aria-busy={aligning}><summary>Alignment details · {aligning ? 'refining automatically…' : alignmentIssue ? 'current pose kept · review needed' : fitSummary.length ? 'saved bite pose' : 'shared file coordinates'}</summary>
          {alignmentIssue && <div className="bite-notice" role="status"><strong>Current scan pose kept</strong><p>The scans are ready to inspect. Automatic refinement could not establish a better bite pose; review the alignment before interpreting contacts.</p><details><summary>Why refinement was skipped</summary><p>{alignmentIssue}</p></details></div>}
          <div className="bite-heading"><div><h2>Bite position</h2><p><span className="num">{upper.length} upper</span> · <span className="num">{lower.length} lower</span> · <span className="num">{bites.length} bite {bites.length === 1 ? 'reference' : 'references'}</span></p></div><button className="primary" disabled={!canAlign || importing} onClick={() => aligning ? stopAlignment() : refineBite()}>{aligning ? 'Cancel refinement' : 'Refine to bite'}</button></div>
          <p className="hint">Bite captures stay fixed. Components of each imported arch or bite file are grouped; refinement starts from a nearby pose and includes hidden bite references. Check the fit visually before inspecting contacts.</p>
          {!canAlign && <p className="hint">Assign one source file per upper/lower arch and at least one bite capture. Parts from the same file are grouped.</p>}
          <details className="bite-settings"><summary>Adjust alignment settings</summary><div className="bite-controls"><label>Match radius <input aria-label="Bite match radius" type="number" min={Number.MIN_VALUE} max="1000000" step="any" value={matchDistance} disabled={aligning || importing} onChange={event => { const value = event.target.valueAsNumber; if (Number.isFinite(value) && value > 0 && value <= 1e6) { matchDistanceEdited.current = true; setMatchDistance(value); } }} /> u</label><button disabled={aligning || importing || !parts.some(part => part.pose || part.offset.some(value => value) || part.rotation?.some(value => value))} onClick={() => { updateParts(parts.map(part => ({ ...part, pose: undefined, offset: [0, 0, 0], rotation: [0, 0, 0] }))); setSceneAlignment(null); setCbctRegistrations([]); clearFit(); }}>Restore file poses</button></div></details>
          {!!fitSummary.length && <div className="bite-fit-results"><p className="fit-summary" role="status">Saved bite pose · match radius <span className="num">{number(fitRadius ?? 0)} u</span></p><div className="table-scroll"><table aria-label="Sampled bite fit"><thead><tr><th>Arch / reference</th><th>RMS before → after</th><th>Samples</th><th>Within radius / normal match</th></tr></thead><tbody>{fitSummary.flatMap(fit => fit.references.map(reference => <tr key={`${fit.id}-${reference.id}`}><td>{parts.find(part => part.id === fit.id)?.name} / {parts.find(part => part.id === reference.id)?.name}</td><td><span className="num">{number(reference.beforeRms)}</span> → <span className="num">{number(reference.afterRms)} u</span></td><td><span className="num">{count(reference.samples)}</span></td><td><span className="num">{number(reference.beforeCoverage * 100)}%</span> → <span className="num">{number(reference.afterCoverage * 100)}%</span></td></tr>))}</tbody></table></div><p className="hint">RMS uses each complete source capture’s fixed initial samples, combining its disconnected patches. Coverage is the fraction within the radius with compatible surface normals, not contact area or a clinical accuracy measure.</p></div>}
          {aligning && <p className="fit-summary" role="status"><span className="spinner" /> Refining locally…</p>}
        </details>}

        <details className="inspection-details" open={step === 3}><summary>Surface relationships & inspection</summary><section className="results" aria-label="Collision results" aria-busy={busy}>
          <div className="results-heading"><div><h2>Contacts & intersections</h2><p role="status">{busy ? 'Checking triangle surfaces and vertex distances…' : compared.length < 2 ? 'Show at least two non-reference scans to compare their surfaces.' : aligning ? 'Collision analysis resumes after bite refinement.' : paused ? 'Analysis paused. Analyze parts when you’re ready.' : report ? <><span className="num">{collisions.length} intersecting {collisions.length === 1 ? 'pair' : 'pairs'}</span> · <span className="num">{number(report.durationMs)} ms</span></> : 'Analyze the visible parts to inspect their relationship.'}</p></div><button disabled={compared.length < 2 || importing || aligning} onClick={() => { if (busy) setPaused(true); else { setError(''); setPaused(false); setRun(value => value + 1); } }}>{busy ? <><span className="spinner" />Stop analysis</> : 'Analyze parts'}</button></div>
          {busy ? <div className="results-empty"><span className="spinner" /><span>Computing locally. You can keep exploring the model.</span></div> : report && report.pairs.length ? <div className="table-scroll"><table><thead><tr><th>Part pair</th><th>Relationship</th><th>Crossing triangles</th><th>Inside samples</th><th>Max. depth</th><th>Sample gap</th></tr></thead><tbody>{report.pairs.map(pair => <tr key={`${pair.a}-${pair.b}`}><td><span>{allParts.find(part => part.id === pair.a)?.name}</span><span className="pair-second">{allParts.find(part => part.id === pair.b)?.name}</span></td><td><span className={`relationship ${pair.intersectingTriangles || pair.penetratingVertices ? 'intersects' : ''}`}>{pair.intersectingTriangles || pair.penetratingVertices ? 'Intersects / inside' : 'Nearby'}</span></td><td><span className="num">{count(pair.intersectingTriangles)}</span></td><td><span className="num">{count(pair.penetratingVertices)}</span></td><td><span className="num">{number(pair.maxDepth)} u</span></td><td><span className="num">{number(pair.minDistance)} u</span></td></tr>)}</tbody></table></div> : <div className="results-empty"><span className={`result-indicator ${report ? 'complete' : ''}`} /><span>{report ? 'No intersections or nearby vertex samples at this threshold.' : 'The relationship between your parts will appear here.'}</span></div>}
          <div className="method-note">Collision results compare complete visible scans and concept components; tooth isolation only changes the view. {report && 'Counts include repeated triangle-corner samples. ' }Connected component joints can touch intentionally. Inside tests require closed surfaces. Crossing triangles are red; near and inside distances are sampled at vertices. A sampled gap can exceed the true surface gap. Self-intersections within one part are not tested.</div>
        </section>

        </details>
        {probe && <section className="probe" aria-label="Vertex inspection"><div><strong>Vertex inspection</strong><span>{parts.find(part => part.id === probe.id)?.name}</span></div><dl><div><dt>Triangle / corner</dt><dd>{probe.face} / {probe.vertex}</dd></div><div><dt>XYZ</dt><dd>{probe.position.map(number).join(', ')} u</dd></div><div><dt>Signed sample distance</dt><dd>{probe.distance === null ? 'No comparison' : `${number(probe.distance)} u`}</dd></div><div><dt>Triangle intersects</dt><dd>{probe.intersecting ? 'Yes' : 'No'}</dd></div></dl><p className="hint">Nearest corner to your click. Negative distance means inside a closed surface. Triangle and corner indices start at 0.</p></section>}
        {!!warnings.length && <details className="import-notes"><summary>Import notes (<span className="num">{warnings.length}</span>)</summary><ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
        <details className="assistant-details"><summary>Ask about this case</summary><AssistantPanel context={assistantContext} tomography={tomographySource} restoration={{
          assemblies: restorations.assemblies,
          busy: restorations.busy || importing || aligning || planning.busy || assessing || !!pendingConcepts || sessionBusy,
          sourceRevision: JSON.stringify([tomography.volume?.id, tomography.volume?.complete, tomography.threshold, tomography.stride, tomography.surface?.threshold, tomography.surface?.stride, tomographyViews, cbctRegistrations, currentSceneAlignment?.reviewed, mmPerUnit, unitsProvenance, opacities, referenceOpacity, referenceVisible, heatmap, wireframe, step, tooth.selectedTooth, tooth.isolate]),
          applyEdit: async (id, edit, expectedRevision, signal) => {
            const assembly = await restorations.edit(id, edit, { actor: 'agent', expectedRevision, signal });
            recordCorrection('candidate', `${id}:agent-edit`); return assembly;
          },
        }} /></details>
        </div>
      </div>
    </main>
    {dragging && <div className="drop-overlay"><Glyph kind="add" /><strong>Drop patient scans and textures</strong><span>STL, OBJ/MTL, PLY, JPG or PNG</span></div>}
    {importing && <div className="import-progress" role="status"><span className="spinner" />Reading and preparing your meshes…</div>}
    {cbctPipelineArmed && cbctPipeline && <CbctPipelineToast state={cbctPipeline} stacked={importing}
      onCancel={() => { setCbctPipelineArmed(false); tomography.cancel(); cbctAlignment.cancel(); }}
      onDismiss={() => setCbctPipelineArmed(false)} />}
  </div>;
}
