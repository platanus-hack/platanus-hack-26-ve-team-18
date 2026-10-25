import type { AssistantSnapshot } from './assistant-context';
import type { AnthropicModelId } from './anthropic-models';
import type { AutoToothView } from './auto-tooth-types';
import type { TomographyEvidence } from './tomography-evidence';
import type { RestorationGenerationDesign } from './restoration-generation';
import type { PlanningRegionReview, PlanningSiteReview } from './planning-decisions';
export interface PlanningSource {
  id: string; arch: 'upper' | 'lower'; triangles: number;
  texture: 'mapped' | 'vertex-colors' | 'unmapped' | 'none';
  patientRight: 'image-left' | 'image-right' | null;
  roleConfirmed?: boolean;
  candidates: { id: number; triangles: number; area: number; height: number; warnings: string[] }[];
}
export interface CasePlanningRequest {
  model?: AnthropicModelId;
  revision: string; snapshot: AssistantSnapshot; sources: PlanningSource[];
  views: (AutoToothView & { id: string; sourceId: string | null; context: 'arch' | 'occlusion' })[];
  /** Only explicitly shared, locally rendered images; never source DICOM or voxels. */
  tomography?: TomographyEvidence;
  /** Bounded local worker findings; no raw meshes, file names or arbitrary notes. */
  preparation?: PlanningPreparationEvidence;
  measurementContext?: { mmPerUnit: number | null; scaleStatus: 'unconfirmed' | 'clinician-entered'; scaleSource: string; biteReviewed: boolean;
    ruler?: { distance: number; units: 'file units (u)'; sourceIds: string[]; method: 'picked-point-straight-line' } };
}
export interface PlanningPreparationEvidence {
  threshold?: number;
  sources: { sourceId: string; method: string; crownRegions: number; unresolvedTriangles: number; boundaryFaces: number | null; colourAvailable: boolean }[];
  regions?: { sourceId: string; candidateId: number; fdi: number | null; confidence: number; needsReview: boolean;
    kind: string; dimensions: { mesiodistal: number | null; buccolingual: number | null; height: number | null };
    peaks: number | null; flags: string[]; protectedTriangles: number; neighbors: number[] }[];
  sites: { id: string; sourceId: string; fdi: number | null; status: string; confidence: number; localized: boolean; supporting: string[]; conflicting: string[]; questions: string[];
    kind?: 'bounded' | 'terminal' | 'distal-extension' | 'chart';
    slotCount?: number;
    /** Local surface eligibility, independent of confidence in tooth identity. */
    geometricDraftEligible?: boolean;
    relationships?: {
      adjacent: { mesial: PlanningToothReference | null; distal: PlanningToothReference | null };
      contralateral: PlanningToothReference | null;
      opposing: { sourceId: string; teeth: PlanningToothReference[]; poseVerified: boolean } | null;
    };
    space?: { unit: 'file units (u)'; mesiodistal: number | null; buccolingual: number | null; sampledVertical: number | null; verticalMethod: string;
      crownHeight?: number | null; proximalGap?: number | null; widthMethod?: string; heightMethod?: string };
  }[];
}
export interface PlanningToothReference { sourceId: string; candidateId: number; fdi: number | null; confidence: number }
export interface PlanningExecutionEvidence {
  requestedModel: string; actualModel: string; provider: string;
  inputTokens: number | null; outputTokens: number | null; providerSteps: number; durationMs: number;
  limits: { providerSteps: number; toolCalls: number; outputTokensPerStep: number };
  toolResults: { name: string; input: unknown; output: unknown; origin?: 'structured-command' }[];
  regionReviews?: PlanningRegionReview[];
  siteReviews?: PlanningSiteReview[];
  draftRequests: { siteId: string; fdi: number; anatomy: 'incisor' | 'canine' | 'premolar' | 'molar'; rationale: string;
    /** Absent only on legacy saved intentions, which cannot drive AI generation. */
    design?: RestorationGenerationDesign }[];
}
export interface CaseFinding {
  id: string; fdi: number | null;
  category: 'identity' | 'possible-missing' | 'surface-observation' | 'restoration-review' | 'hygiene-review' | 'occlusion-review' | 'data-quality';
  title: string; detail: string; evidence: string[]; needsClinicalReview: boolean;
}
export interface CasePlanAction {
  id: string; fdi: number | null;
  kind: 'clinical-review' | 'hygiene-review' | 'restoration-review' | 'implant-review';
  title: string; rationale: string; evidence: string[]; prerequisites: string[];
}
export interface CasePlanningResult {
  revision: string; model: string; summary: string;
  mappings: { sourceId: string; candidateId: number; fdi: number | null; needsReview: boolean; reason: string }[];
  findings: CaseFinding[]; actions: CasePlanAction[];
  designs: { fdi: number; anatomy: 'incisor' | 'canine' | 'premolar' | 'molar'; rationale: string }[];
  limitations: string[];
  execution?: PlanningExecutionEvidence;
}
