import { isFdiTooth, toothArch } from './teeth.ts';
import type { AutoToothMapping, AutoToothOverlay } from './auto-tooth-types';
import type { ToothViewState } from './tooth-types';

/** Display provenance only; never changes a region ID, assignment, or chart record. */
export interface ToothDisplayIdentity {
  fdi: number | null;
  status: 'recorded' | 'reviewed-mapping' | 'draft' | 'uncertain';
}
export interface ToothDisplay {
  label: string;
  marker: string;
  note: string;
  description: string;
}
export type ToothDisplayCandidate = AutoToothOverlay['candidates'][number] & { displayIdentity?: ToothDisplayIdentity };
export type ToothDisplayViewState = ToothViewState & {
  /** Saved assignments, separately from the viewport's mixed saved/draft labels. */
  recordedLabels?: Record<string, Uint8Array>;
  autoOverlay?: (AutoToothOverlay & { candidates: ToothDisplayCandidate[] }) | null;
};
type Arch = 'upper' | 'lower' | null;
const validIdentity = (fdi: unknown, arch?: Arch): fdi is number =>
  isFdiTooth(fdi) && (arch === undefined || (arch !== null && toothArch(fdi) === arch));

export function mappingDisplayIdentity(mapping?: AutoToothMapping): ToothDisplayIdentity | undefined {
  return mapping && { fdi: mapping.fdi, status: mapping.needsReview ? 'uncertain' : mapping.source === 'user' ? 'reviewed-mapping' : 'draft' };
}

export function toothDisplay(identity: ToothDisplayIdentity | undefined, fallback = '?', arch?: Arch): ToothDisplay {
  if (!identity || !validIdentity(identity.fdi, arch)) return {
    label: fallback === '?' ? 'FDI unknown' : `Region ${fallback}`, marker: fallback, note: 'unknown', description: 'FDI unknown',
  };
  const uncertain = identity.status === 'uncertain';
  const marker = `${identity.fdi}${uncertain ? '?' : ''}`;
  const note = identity.status === 'recorded' ? '' : identity.status === 'reviewed-mapping' ? 'reviewed' : 'draft';
  const description = identity.status === 'recorded' ? 'Recorded surface identity'
    : identity.status === 'reviewed-mapping' ? 'Mapping reviewed · clinical record unchanged'
      : uncertain ? 'Draft identity · needs review' : 'Draft identity · not reviewed';
  return { label: `FDI ${marker}`, marker, note, description };
}

/** A partial or mixed region cannot borrow the identity of one of its triangles. */
function uniformFdi(faces: Uint32Array, labels?: Uint8Array, arch?: Arch): number | null {
  if (!faces.length || !labels) return null;
  const fdi = labels[faces[0]];
  return validIdentity(fdi, arch) && faces.every(face => labels[face] === fdi) ? fdi : null;
}

export function candidateToothDisplay(
  candidate: Pick<ToothDisplayCandidate, 'id' | 'faces' | 'displayIdentity'>,
  options: { labels?: Uint8Array; recordedLabels?: Uint8Array; arch?: Arch } = {},
): ToothDisplay {
  const { labels, recordedLabels, arch } = options;
  const fallback = `C${candidate.id}`;
  const recorded = uniformFdi(candidate.faces, recordedLabels, arch);
  if (recorded !== null) return toothDisplay({ fdi: recorded, status: 'recorded' }, fallback, arch);
  // Partially recorded regions (including excluded tissue) require boundary review.
  if (candidate.faces.some(face => !!recordedLabels?.[face])) return toothDisplay(undefined, fallback, arch);
  if (candidate.displayIdentity !== undefined) return toothDisplay(candidate.displayIdentity, fallback, arch);
  const fdi = uniformFdi(candidate.faces, labels, arch);
  // Existing view labels include automatic proposals, so absence of provenance never implies review.
  return toothDisplay(fdi === null ? undefined : { fdi, status: 'draft' }, fallback, arch);
}
