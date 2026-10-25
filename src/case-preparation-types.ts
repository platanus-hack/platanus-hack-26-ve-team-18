import type { AutoToothScan } from './auto-tooth-types';
import type { ArchAnalysis } from './arch-analysis';
import type { ArchNumbering } from './tooth-numbering';
import type { SiteHypothesis } from './missing-sites';
import type { ToothRecord } from './tooth-types';

export type PatientRight = 'image-left' | 'image-right';
/** Local arrays retain original triangle order and file coordinates. No inferred physical units. */
export interface PreparationSource {
  id: string;
  arch: 'upper' | 'lower';
  /** False when the role is only a filename/import hint; blocks anatomical identities and cross-arch evidence. */
  roleConfirmed?: boolean;
  positions: Float32Array;
  tissueScores?: Float32Array;
  /** Column-major file-to-workspace rigid matrix; scaling/reflection is unsupported. */
  pose?: number[];
  reviewedLabels?: Uint8Array;
  /** Optional protected-face mask; protects explicit zero/erasure corrections too. */
  reviewedMask?: Uint8Array;
  /** Draft decisions stay bound to these original faces; never clinical reviewed labels. */
  identityCorrections?: { fdi: number | null; faces: number[] }[];
}
/** The host binds revision to source hashes/order, poses, annotations, units and settings. */
export interface CasePreparationRequest {
  id: number;
  revision: string;
  sources: PreparationSource[];
  /** Explicit patient-right relative to each source's scan.frame.u image axis. Null means unknown. */
  patientRight?: Record<string, PatientRight | null>;
  chart?: Record<number, ToothRecord>;
  /** Evidence-score exception threshold, 0..1; default .8. Not calibrated clinical accuracy. */
  confidenceThreshold?: number;
  poseVerified?: boolean;
}
export interface PreparedIdentity {
  partId: string;
  candidateId: number;
  fdi: number | null;
  confidence: number;
  alternatives: number[];
  needsReview: boolean;
  /** Structural exceptions that remain blocking when the score threshold changes. */
  blockingReasons?: string[];
  reason: string;
  source: 'geometry' | 'reviewed';
}
export interface PreparedCaseSource {
  partId: string;
  /** Whole-tooth candidates usable even when FDI/laterality is unknown. */
  scan: AutoToothScan;
  analysis: ArchAnalysis | null;
  /** Null until patientRight explicitly establishes arc orientation. */
  numbering: ArchNumbering | null;
  /** Disposable hypotheses. Existing reviewed labels/protected corrections win. */
  draftLabels: Uint8Array;
  warnings: string[];
}
export interface CasePreparationResult {
  id: number;
  revision: string;
  scans: PreparedCaseSource[];
  sites: SiteHypothesis[];
  identities: PreparedIdentity[];
  warnings: string[];
  /** Host-observed local worker and rendered-view preparation time. */
  durationMs?: number;
}
export interface CasePreparationFailure { id: number; revision: string; error: string }
export type CasePreparationResponse = CasePreparationResult | CasePreparationFailure;
