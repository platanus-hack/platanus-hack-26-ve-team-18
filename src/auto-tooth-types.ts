import type { Vec3 } from './models';
import type { SurfaceAnchor } from './tooth-types';
import type { AnthropicModelId } from './anthropic-models';

/** Candidate IDs describe geometry; they are deliberately independent of FDI numbers. */
export interface AutoToothCandidate {
  id: number;
  faces: Uint32Array;
  seed: { face: number; point: Vec3 };
  centroid: Vec3;
  area: number;
  height: number;
  /** Local heuristic support, never a tooth identity or clinical confidence. */
  evidence?: {
    /** Sum of absolute projected triangle areas in file units squared; folds may overlap. */
    shoulderProjectedArea: number;
    /** Projected-area mean of strong color penalties, not a tissue probability. */
    shoulderTissueCost: number;
    reliefReference: 'merge-saddle' | 'estimated-base';
  };
  warnings: string[];
}
export interface AutoToothFrame { origin: Vec3; up: Vec3; u: Vec3; v: Vec3 }
export interface AutoToothScan {
  frame: AutoToothFrame;
  candidates: AutoToothCandidate[];
  warnings: string[];
  unassignedTriangles: number;
  method: string;
}
export type AutoToothDirection = 'auto' | '+x' | '-x' | '+y' | '-y' | '+z' | '-z';
export interface AutoToothSettings { direction: AutoToothDirection; sensitivity: number }
export interface AutoToothView { label: string; mediaType: 'image/jpeg'; base64: string }
export interface AutoToothIdentificationRequest {
  model?: AnthropicModelId;
  arch: 'upper' | 'lower';
  patientRight: 'image-left' | 'image-right';
  views: AutoToothView[];
  candidates: { id: number; triangles: number; area: number; height: number; warnings: string[] }[];
}
export interface AutoToothMapping {
  source?: 'model' | 'haiku' | 'user';
  candidateId: number;
  fdi: number | null;
  needsReview: boolean;
  reason: string;
}
export interface AutoToothIdentification {
  mappings: AutoToothMapping[];
  possibleMissing: { fdi: number; reason: string }[];
  warnings: string[];
  model: string;
}
export interface AutoToothProposalState {
  partId: string;
  scan: AutoToothScan;
  selectedCandidate: number | null;
  mappings: AutoToothMapping[];
  possibleMissing: { fdi: number; reason: string }[];
  model: string | null;
  views: AutoToothView[];
}
export interface AutoToothOverlay {
  partId: string;
  candidates: { id: number; faces: Uint32Array; centroid: Vec3 }[];
  selectedCandidate: number | null;
}
export interface AutoPick { candidateId: number; anchor: SurfaceAnchor }

export interface AutoTeethPanelProps {
  activePartName: string | null;
  activePartRole: string | null;
  selectedTooth: number;
  autoRun: boolean;
  settings: AutoToothSettings;
  proposal: AutoToothProposalState | null;
  busy: boolean;
  processing?: boolean;
  stage: string;
  configured: boolean | null;
  model: string;
  defaultModel: string;
  patientRight: 'image-left' | 'image-right' | null;
  error: string;
  notice: string;
  canApplyMapped: boolean;
  onAutoRun: (value: boolean) => void;
  onSettings: (patch: Partial<AutoToothSettings>) => void;
  onScan: () => void;
  onCancel: () => void;
  onSelectCandidate: (id: number) => void;
  onMapCandidate: (id: number, fdi: number | null) => void;
  onRejectCandidate: (id: number) => void;
  onUseSelected: (tooth: number) => void;
  onApplyMapped: () => void;
  onPrepareViews: () => void;
  onPatientRight: (side: 'image-left' | 'image-right') => void;
  onIdentify: () => void;
  onModel: (model: string) => void;
  onPickTool: () => void;
  onReviewGap: (fdi: number) => void;
}
