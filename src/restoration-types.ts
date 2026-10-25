import type { ModelPart, Vec3 } from './models';
import type { SurfaceAnchor } from './tooth-types';
import type { CrownShape } from './crown-anatomy';
import type { RestorationQualityContext, RestorationQualityReport } from './restoration-quality';
import type { RestorationRelationshipsReport } from './restoration-relationships';
import type { RestorationGoalReport } from './restoration-goals';
import type { AbutmentGingivaReport, FixtureGingivaReport } from './restoration-gingiva';
export type RestorationComponentKind = 'fixture' | 'abutment' | 'crown';
export interface RestorationParameters {
  fixture: { radius: number; length: number; depth: number; taper: number };
  abutment: { radius: number; height: number; emergenceRadius: number; angleX: number; angleY: number };
  crown: { width: number; depth: number; height: number; cuspHeight: number; rotation: number };
}
export interface RestorationSpec {
  version: 'implant-assembly/v1'; fdi: number; parentPartId: string;
  /** Host-owned construction profile. Absent preserves exact legacy component geometry. */
  componentDesign?: 'nested-support/v1';
  /** fdi selects shape only for this site; it is not an anatomical tooth assignment. */
  draftIdentity?: { siteId: string; templateFdi: number; alternatives: number[]; basis: string };
  frame: { origin: Vec3; u: Vec3; v: Vec3; up: Vec3 };
  parameters: RestorationParameters;
  anatomy: 'incisor' | 'canine' | 'premolar' | 'molar';
  /** Absolute engineering scales, default 1. Applied once to the saved base anatomy. */
  contour?: { cervicalScale?: number; occlusalScale?: number };
  /** Display only; never a dental shade match or material/manufacturing specification. */
  appearance?: Partial<Record<RestorationComponentKind, { color?: string; roughness?: number }>>;
  /** One bounded edit record per retained revision, never a clinical approval. */
  editProvenance?: { actor: 'manual' | 'agent'; reason: string };
  /** Explicit editable anatomy; absent means a labeled procedural template. */
  crownShape?: CrownShape;
  /** Explicit local evidence for independent quality checks, retained for retries. */
  qualityContext?: RestorationQualityContext;
  /** Relates anatomical mesial/buccal to the right-handed construction frame. */
  anatomicalSigns?: { mesial: 1 | -1; buccal: 1 | -1 };
  provenance: 'hypothesized' | 'clinician-entered'; units: 'file units (u)'; source: string;
  /** Snapshot dependencies for localization, including competing source imports. Not clinical evidence. */
  siteEvidence?: {
    method: 'reviewed-surface' | 'bounded-gap' | 'distal-extension'; partIds: string[]; fdis: number[]; surface: SurfaceAnchor;
    bounds?: [number, number]; slot?: { index: number; count: number };
  };
}
export interface RestorationMesh {
  /** Constructed crown-body face prefix; collar faces follow. Not inferred from coordinates. */
  crownBodyTriangles?: number;
  component: RestorationComponentKind; positions: Float32Array; normals: Float32Array;
  triangles: number; vertices: number; closed: boolean; dimensions: Vec3;
}
export interface RestorationRevision { spec: RestorationSpec; createdAt: string; warnings: string[]; fit?: RestorationFitReport; candidateHistory?: RestorationFitHistoryEntry[] }
export interface RestorationAssembly extends RestorationRevision { id: string; parts: ModelPart[]; draftSite?: boolean; previousVersions?: RestorationRevision[] }
export interface RestorationPanelProps {
  assemblies: RestorationAssembly[]; selectedId: string | null; busy: boolean; error: string;
  onSelect: (id: string) => void;
  onUpdate: (id: string, parameters: RestorationParameters) => void;
  onRemove: (id: string) => void; onTogglePart: (id: string) => void; onExportPart: (id: string) => void;
  onCompare?: (id: string, candidate?: number, version?: number) => void;
  onRebuild?: (id: string) => void;
}

/** Named, pose-resolved target subset in the restoration parent's original file coordinates. */
export interface RestorationFitSurface {
  id: string;
  role: 'adjacent' | 'antagonist' | 'tissue' | 'source-arch' | 'other-tooth';
  positions: Float32Array;
  side?: 'mesial' | 'distal';
  /** Explicit illustrative gap in file units, not a clinical threshold. */
  targetGap?: number;
  targetProvenance?: string;
  weight?: number;
}
export interface RestorationFitOptions {
  /** Explicit gum-audit scope; legacy callers retain combined evidence. */
  tissueSource?: 'crown' | 'crown-and-abutment';
  /** Exact-edit audits screen full supplied targets before comparing revisions. */
  verifyBaselineIntersections?: boolean;
  maxCandidates?: number;
  maxDurationMs?: number;
  samplesPerSurface?: number;
  maxTargetTriangles?: number;
  maxIntersectionTriangles?: number;
}
export interface RestorationFitInput {
  goalContract?: RestorationGoalReport;
  spec: RestorationSpec;
  surfaces: RestorationFitSurface[];
  options?: RestorationFitOptions;
}
export interface RestorationSurfaceFitMeasurement {
  sourceComponents?: RestorationComponentKind[];
  /** Constructed emergence collar is measured separately against visible gum. */
  sourceRegion?: 'crown-body';
  id: string;
  role: RestorationFitSurface['role'];
  side?: RestorationFitSurface['side'];
  targetGap: number;
  targetProvenance?: string;
  weight: number;
  targetTriangles: number;
  samples: number;
  sampledMinDistance: number;
  sampledRmsGapError: number;
  nearSamples: number;
  /** Optional v1 audit detail; sample quantiles are not surface clearance bounds. */
  sampledMedianDistance?: number;
  sampledP95Distance?: number;
  sampledMaxGapDeficit?: number;
  /** Forward rays along the local occlusal axis; misses are unknown, never zero clearance. */
  occlusalRaySamples?: number;
  occlusalRayHits?: number;
  sampledOcclusalGap?: number | null;
  sampledOcclusalGapError?: number | null;
  sampledRegionTriangles?: number;
  /** Area of the eligible sampling region in squared file units, not contact area. */
  sampledRegionArea?: number;
  /** Triangle touch/crossing count in the explicitly bounded intersection test. */
  intersectingTriangles: number;
  intersectionTestedTriangles: number;
  /** Follow-up target faces retained after conservative broadphase screening. */
  verificationRetainedTriangles?: number;
  intersectionComplete: boolean;
  /** Faces summed across both meshes; categories may share faces. */
  transverseCrossingTriangles?: number;
  touchingOrAmbiguousTriangles?: number;
  intersectionPairTests?: number;
  intersectionTolerance?: number;
}
export interface RestorationFitMeasurement {
  score: number;
  objectiveScore: number;
  morphologyPenalty: number;
  surfaces: RestorationSurfaceFitMeasurement[];
}
export interface RestorationFitHistoryEntry {
  candidate: number;
  parameters: RestorationParameters;
  measurement: RestorationFitMeasurement;
  accepted: boolean;
  quality?: RestorationQualityReport;
  revision?: { round: number; reason: string };
  /** Index in report.anatomyCandidates; absent in parameter-only legacy fits. */
  anatomyCandidate?: number;
}
export interface RestorationReferencePlanes {
  site: { origin: Vec3; normal: Vec3 };
  fixturePlatform: { origin: Vec3; normal: Vec3 };
  fixtureApex: { origin: Vec3; normal: Vec3 };
  crownBase: { origin: Vec3; normal: Vec3 };
  interpretation: 'generic-contiguous-envelopes; no compatible implant connection';
}
export interface RestorationFitReport {
  version: 'restoration-fit/v1';
  /** Absent in legacy score-only histories. */
  selectionPolicy?: 'score-with-contact-evidence/v1' | 'quality-gated/v1';
  status: 'improved' | 'unchanged';
  termination: 'candidate-budget' | 'time-budget' | 'converged' | 'no-surfaces';
  before: RestorationFitMeasurement;
  after: RestorationFitMeasurement;
  candidates: number;
  /** Attempts include invalid constructions; candidate IDs index measured history. */
  candidateAttempts?: number;
  invalidCandidates?: number;
  bestCandidate?: number;
  durationMs: number;
  units: 'file units (u)';
  quality?: { initial: RestorationQualityReport; final: RestorationQualityReport; rounds: number; stopReason: 'checks-passed' | 'budget' | 'no-admissible-revision' | 'measurement-only' };
  /** Separate bounded audit of the selected meshes, never a clinical clearance verdict. */
  relationships?: RestorationRelationshipsReport;
  goal?: RestorationGoalReport;
  gingiva?: FixtureGingivaReport;
  abutmentGingiva?: AbutmentGingivaReport;
  /** Original anatomy and at most one bounded local occlusal revision. */
  anatomyCandidates?: CrownShape[];
  referencePlanes: RestorationReferencePlanes;
  sampling: {
    method: 'deterministic-area-stratified-triangle-barycentres';
    direction: 'restoration-to-target';
    requestedPerSurface: number;
    fullResolutionDistanceTargets: true;
    maximumIntersectionTargetTriangles: number;
    maximumVerificationRegionTriangles?: number;
  };
  limits: string[];
}
export interface RestorationFitResult {
  spec: RestorationSpec;
  components: RestorationMesh[];
  report: RestorationFitReport;
  history: RestorationFitHistoryEntry[];
}
export type RestorationFitWorkerRequest =
  | { type: 'fit'; id: number; input: RestorationFitInput }
  | { type: 'prepare-fit'; id: number; spec: RestorationSpec; parts: ModelPart[]; teeth: import('./tooth-types').ToothCase; scans: import('./case-preparation-types').PreparedCaseSource[]; site?: import('./missing-sites').SiteHypothesis; options?: RestorationFitOptions; goalContract?: RestorationGoalReport; generationDesign?: import('./restoration-generation').RestorationGenerationDesign }
  | { type: 'cancel'; id: number };
export type RestorationFitWorkerResponse =
  | { type: 'targets'; id: number; targetIds: string[] }
  | { type: 'progress'; id: number; phase: 'creating' | 'fitting'; fdi: number }
  | { type: 'result'; id: number; result: RestorationFitResult }
  | { type: 'error'; id: number; error: string }
  | { type: 'cancelled'; id: number };
