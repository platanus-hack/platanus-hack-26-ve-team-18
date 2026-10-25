import type { CasePreparationResult, PreparedIdentity } from './case-preparation-types';
import type { CasePlanningResult } from './case-planning-types';
import type { ModelPart } from './models';
import type { ToothCase } from './tooth-types';
import { toothArch, isFdiTooth } from './teeth.ts';
import { toothClassOf } from './crown-anatomy.ts';
import { applyAutoAssignments } from './auto-tooth-assignments.ts';

export type IdentityDecisions = Record<string, number | null>;
export type IdentityRegions = Record<string, number[]>;
export const identityKey = (identity: Pick<PreparedIdentity, 'partId' | 'candidateId'>) => `${identity.partId}:C${identity.candidateId}`;

/** A fresh explicit region review supersedes earlier overlapping draft choices. */
export function replaceIdentityCorrection(decisions: IdentityDecisions, regions: IdentityRegions, key: string, fdi: number | null, faces: number[]) {
  const prefix = `${key.slice(0, key.lastIndexOf(':C'))}:C`, selected = new Set(faces);
  const nextDecisions = { ...decisions }, nextRegions = { ...regions };
  for (const [other, original] of Object.entries(regions)) if (other !== key && other.startsWith(prefix)) {
    const remaining = original.filter(face => !selected.has(face));
    if (remaining.length) nextRegions[other] = remaining;
    else { delete nextRegions[other]; delete nextDecisions[other]; }
  }
  nextDecisions[key] = fdi; nextRegions[key] = [...faces];
  return { decisions: nextDecisions, regions: nextRegions };
}

/** Local geometric findings remain usable when an external model is unavailable. */
export function localPlanningResult(prepared: CasePreparationResult, parts: ModelPart[]): CasePlanningResult {
  const sourceId = (partId: string) => `scan-${parts.findIndex(part => part.id === partId) + 1}`;
  const sites = prepared.sites.filter(site => site.status === 'proposed-missing' || site.status === 'identity-unresolved');
  return {
    revision: prepared.revision, model: 'local-geometry',
    summary: `${prepared.scans.length} scans prepared, ${prepared.identities.filter(identity => identity.fdi !== null).length} tooth identity hypotheses and ${sites.length} scanned-space hypotheses. ${prepared.identities.filter(identity => identity.needsReview).length} regions need identity review. Review exceptions; clinical decisions remain pending.`,
    mappings: prepared.identities.map(identity => ({ sourceId: sourceId(identity.partId), candidateId: identity.candidateId, fdi: identity.fdi, needsReview: identity.needsReview, reason: identity.reason })),
    findings: sites.map((site, index) => ({ id: `local-gap-${index + 1}`, fdi: site.fdi, category: 'possible-missing', title: site.fdi === null ? 'Scanned space · identity unresolved' : `Scanned space · FDI ${site.fdi}`, detail: [...site.evidence.supporting, ...site.evidence.conflicting].join(' '), evidence: [site.id], needsClinicalReview: true })),
    actions: [], designs: sites.flatMap(site => site.fdi === null ? [] : [{ fdi: site.fdi, anatomy: toothClassOf(site.fdi), rationale: site.frameBasis }]),
    limitations: ['Local confidence is an evidence score, not calibrated clinical accuracy.', 'Surface gaps do not establish absence or implant indication. Units, bite alignment and clinical suitability require their own evidence.'],
  };
}

/** External disagreement lowers automation eligibility; it cannot overwrite reviewed labels. */
export function reconcileIdentities(prepared: CasePreparationResult, result: CasePlanningResult | null, parts: ModelPart[], threshold: number, decisions: IdentityDecisions, regions?: IdentityRegions): PreparedIdentity[] {
  const rows = prepared.identities.map(identity => {
    const key = identityKey(identity);
    const currentFaces = prepared.scans.find(source => source.partId === identity.partId)?.scan.candidates.find(candidate => candidate.id === identity.candidateId)?.faces;
    const faceSet = new Set(currentFaces ?? []);
    const overlappingDecisions = Object.entries(regions ?? {}).filter(([originalKey, faces]) => originalKey.startsWith(`${identity.partId}:C`) && Object.hasOwn(decisions, originalKey) && faces.some(face => faceSet.has(face)));
    if (new Set(overlappingDecisions.map(([originalKey]) => decisions[originalKey])).size > 1) return { ...identity, needsReview: true, reason: 'Conflicting draft corrections overlap this region; review the original face selections.' };
    const changedCorrection = Object.entries(regions ?? {}).some(([originalKey, faces]) => originalKey.startsWith(`${identity.partId}:C`) && faces.some(face => faceSet.has(face)) && (faces.length !== faceSet.size || faces.some(face => !faceSet.has(face))));
    if (changedCorrection) return { ...identity, needsReview: true, reason: 'This region differs from the original draft correction faces; review its changed boundary.' };
    if (identity.source === 'reviewed' && !Object.hasOwn(decisions, key)) return identity;
    const bound = !regions || (!!regions[key] && !!currentFaces && regions[key].length === currentFaces.length && regions[key].every((face, index) => face === currentFaces[index]));
    if (Object.hasOwn(decisions, key) && bound) {
      const fdi = decisions[key];
      return { ...identity, fdi, needsReview: fdi === null, source: 'reviewed' as const, reason: fdi === null ? 'Skipped in the draft by you.' : 'Draft identity corrected by you; saved clinical records remain separate.' };
    }
    const sourceId = `scan-${parts.findIndex(part => part.id === identity.partId) + 1}`;
    const mapping = result?.model !== 'local-geometry' ? result?.mappings.find(mapping => mapping.sourceId === sourceId && mapping.candidateId === identity.candidateId) : undefined;
    const conflict = mapping && (mapping.fdi !== identity.fdi || mapping.needsReview);
    return { ...identity, needsReview: identity.fdi === null || identity.confidence < threshold || !!identity.blockingReasons?.length || !!conflict, reason: conflict ? `Geometry / model disagreement. ${identity.reason} Model: ${mapping.reason}` : identity.reason };
  });
  const seen = new Map<number, number>();
  for (const row of rows) if (row.fdi !== null) seen.set(row.fdi, (seen.get(row.fdi) ?? 0) + 1);
  return rows.map(row => row.fdi !== null && seen.get(row.fdi)! > 1 ? { ...row, needsReview: true, reason: `Conflicting FDI ${row.fdi} assignments need correction.` } : row);
}

/** Ephemeral generator/view input. Never writes automatic hypotheses into the reviewed chart. */
export function draftToothCase(reviewed: ToothCase, parts: ModelPart[], prepared: CasePreparationResult | null, identities: PreparedIdentity[], decisions: IdentityDecisions = {}, correctedRegions: IdentityRegions = {}): ToothCase {
  if (!prepared) return reviewed;
  const regions = identities.flatMap(identity => {
    const part = parts.find(part => part.id === identity.partId);
    const candidate = prepared.scans.find(source => source.partId === identity.partId)?.scan.candidates.find(candidate => candidate.id === identity.candidateId);
    return !identity.needsReview && identity.fdi !== null && isFdiTooth(identity.fdi) && part?.role === toothArch(identity.fdi) && candidate ? [{ partId: part.id, tooth: identity.fdi, faces: candidate.faces.filter(face => !reviewed.reviewedMask?.[part.id]?.[face]) }] : [];
  });
  const draft = applyAutoAssignments(reviewed, parts, regions).data, labels = { ...draft.labels };
  const faceDecisions = new Map<string, Map<number, number | null | 'conflict'>>();
  for (const [key, fdi] of Object.entries(decisions)) {
    const match = /^(.*):C\d+$/.exec(key), part = parts.find(part => part.id === match?.[1]), faces = correctedRegions[key];
    if (!part || !faces || (fdi !== null && (!isFdiTooth(fdi) || toothArch(fdi) !== part.role)) || faces.some(face => face < 0 || face >= part.triangles)) continue;
    const selected = faceDecisions.get(part.id) ?? new Map<number, number | null | 'conflict'>();
    for (const face of faces) selected.set(face, selected.has(face) && selected.get(face) !== fdi ? 'conflict' : fdi);
    faceDecisions.set(part.id, selected);
  }
  for (const [partId, selected] of faceDecisions) {
    const part = parts.find(part => part.id === partId)!;
    const next = (labels[part.id] ?? new Uint8Array(part.triangles)).slice();
    for (const [face, fdi] of selected) if (!reviewed.reviewedMask?.[part.id]?.[face] && !reviewed.labels[part.id]?.[face]) next[face] = fdi === 'conflict' ? 0 : fdi ?? 0;
    labels[part.id] = next;
  }
  return { ...draft, labels, reviewedMask: reviewed.reviewedMask };
}

export interface WorkflowProgress { stage: string; completed: number; total: number }
export const WORKFLOW_STAGES = ['Preparation', 'Assessment', 'Sites', 'Anatomy & fitting', 'Review'] as const;
