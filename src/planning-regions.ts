import type { CasePreparationResult, PreparedIdentity } from './case-preparation-types';
import type { CasePlanningResult } from './case-planning-types';
import type { PlanningRegionReview } from './planning-decisions';
import type { ModelPart } from './models';
import type { SiteNeighbour } from './missing-sites';
import type { ToothCase } from './tooth-types';
import { isFdiTooth, toothArch } from './teeth.ts';
import { identityKey } from './draft-workflow.ts';

const usable = (review: PlanningRegionReview) => review.classification === 'tooth' && review.decision === 'use';
const block = (identity: PreparedIdentity, reasons: string[]): PreparedIdentity => ({
  ...identity, fdi: null, needsReview: true,
  blockingReasons: [...new Set([...(identity.blockingReasons ?? []), ...reasons])],
  reason: reasons.join(' '),
});

/** Apply bounded AI hypotheses to existing regions only. Source coordinates,
 * face selections, reviewed masks and the saved clinical chart stay local and
 * unchanged. The numbering solver remains evidence, never a new absence map.
 */
export function applyAIRegionReviews(prepared: CasePreparationResult | null, result: CasePlanningResult | null, parts: ModelPart[], reviewed: ToothCase): CasePreparationResult | null {
  if (!prepared || !result || result.revision !== prepared.revision || !result.execution?.regionReviews?.length) return prepared;
  const reviews = new Map<string, PlanningRegionReview[]>();
  for (const review of result.execution.regionReviews) {
    const alias = /^scan-([1-9]\d*)$/.exec(review.sourceId);
    const part = alias ? parts[Number(alias[1]) - 1] : undefined;
    const source = prepared.scans.find(source => source.partId === part?.id);
    if (!part || !source || !source.scan.candidates.slice(0, 32).some(candidate => candidate.id === review.candidateId)
      || source.scan.candidates.filter(candidate => candidate.id === review.candidateId).length !== 1
      || prepared.identities.filter(identity => identity.partId === part.id && identity.candidateId === review.candidateId).length !== 1) continue;
    const key = identityKey({ partId: part.id, candidateId: review.candidateId });
    reviews.set(key, [...(reviews.get(key) ?? []), review]);
  }
  if (!reviews.size) return prepared;
  const savedFdis = new Set<number>();
  for (const labels of Object.values(reviewed.labels)) for (const fdi of new Set(labels)) if (isFdiTooth(fdi)) savedFdis.add(fdi);
  const changed = new Set<string>(), boundaryBlocked = new Set<string>();
  let identities = prepared.identities.map(identity => {
    const key = identityKey(identity), rows = reviews.get(key);
    if (!rows) return identity;
    const part = parts.find(part => part.id === identity.partId)!;
    const source = prepared.scans.find(source => source.partId === part.id)!;
    const candidate = source.scan.candidates.find(candidate => candidate.id === identity.candidateId)!;
    // Explicit draft corrections include skips. Saved tooth labels are also
    // authoritative even if a caller has not yet reconciled its identity rows.
    if (identity.source === 'reviewed') return identity;
    const saved = new Set<number>();
    for (const face of candidate.faces) {
      const fdi = reviewed.labels[part.id]?.[face];
      if (fdi && isFdiTooth(fdi)) saved.add(fdi);
    }
    if (saved.size) {
      changed.add(key);
      return saved.size === 1 ? { ...identity, fdi: [...saved][0], source: 'reviewed' as const, reason: 'Saved human tooth labels preserved above the AI region hypothesis.' }
        : { ...block(identity, ['This region intersects conflicting saved human tooth labels.']), source: 'reviewed' as const };
    }
    changed.add(key);
    const review = rows[0], reasons: string[] = [];
    if (rows.length !== 1) reasons.push('Conflicting AI reviews of the same candidate require region review.');
    if (!usable(review)) reasons.push(`AI region hypothesis: ${review.classification}, ${review.decision}. ${review.rationale} Review the existing boundary; rejecting a tooth does not establish a ridge or absent tooth.`);
    const tooth = source.analysis?.teeth.find(tooth => tooth.id === identity.candidateId);
    if (candidate.faces.length < 12 || candidate.faces.some(face => face >= part.triangles)
      || !tooth || tooth.kind !== 'crown' || ![tooth.mdWidth, tooth.blWidth, tooth.height].every(value => Number.isFinite(value) && value > 0)
      || tooth.faces.length !== candidate.faces.length || tooth.faces.some((face, index) => face !== candidate.faces[index])) reasons.push('The candidate lacks adequate matching whole-crown geometry.');
    const boundaryReview = reasons.length > 0;
    if (identity.blockingReasons?.length) reasons.push('Existing local review reasons remain unresolved; AI cannot clear their evidence requirements.');
    if (tooth?.flags.length || candidate.warnings.length) reasons.push('Existing structural region flags remain unresolved; AI cannot repair mesh boundaries.');
    const protectedCorrection = candidate.faces.some(face => !!reviewed.labels[part.id]?.[face] || !!reviewed.reviewedMask?.[part.id]?.[face]);
    if (protectedCorrection) reasons.push('This region intersects a protected exclusion or erased human correction.');
    const structuralReview = boundaryReview || !!tooth?.flags.length || candidate.warnings.length > 0 || protectedCorrection;
    const fdi = review.fdi;
    if (fdi === null || !isFdiTooth(fdi)) reasons.push('The AI tooth identity is unresolved.');
    else {
      if (!source.numbering || ![1, -1].includes(source.numbering.orientation) || source.numbering.arch !== toothArch(fdi)
        || part.role !== toothArch(fdi) || part.roleSource === 'filename-hypothesis') reasons.push('Confirmed source arch and patient-side numbering are required for an AI FDI hypothesis.');
      if (identity.fdi !== null && Math.floor(identity.fdi / 10) !== Math.floor(fdi / 10)) reasons.push('The AI hypothesis conflicts with the candidate’s established patient side.');
      if (['missing', 'not-scanned'].includes(reviewed.teeth[fdi]?.status)) reasons.push('The AI identity conflicts with a saved missing/not-scanned chart record.');
      if (savedFdis.has(fdi)) reasons.push('The proposed FDI is already assigned to a saved human surface region.');
    }
    if (reasons.length) {
      if (structuralReview) boundaryBlocked.add(key);
      return block(identity, reasons);
    }
    return { ...identity, fdi, source: 'ai' as const,
      // Preserve the local score and threshold decision. AI supplies no new
      // calibrated confidence and cannot clear an existing exception.
      needsReview: identity.needsReview,
      reason: `AI tooth identity hypothesis on the existing local region; human review remains separate. ${review.rationale}` };
  });

  // Across every source, keep a unique saved human correction authoritative;
  // never choose competing automatic FDIs by source or provider order.
  const byFdi = new Map<number, PreparedIdentity[]>();
  for (const identity of identities) if (identity.fdi !== null) byFdi.set(identity.fdi, [...(byFdi.get(identity.fdi) ?? []), identity]);
  identities = identities.map(identity => {
    const duplicates = identity.fdi === null ? [] : byFdi.get(identity.fdi)!;
    if (duplicates.length < 2) return identity;
    if (identity.source === 'reviewed' && duplicates.filter(item => item.source === 'reviewed').length === 1) return identity;
    const reason = `Conflicting FDI ${identity.fdi} assignments across candidate regions require review.`;
    const key = identityKey(identity); changed.add(key);
    return identity.source === 'reviewed' ? { ...identity, needsReview: true, blockingReasons: [...(identity.blockingReasons ?? []), reason], reason }
      : block(identity, [reason]);
  });
  if (!changed.size) return prepared;
  const byKey = new Map(identities.map(identity => [identityKey(identity), identity]));
  const previous = new Map(prepared.identities.map(identity => [identityKey(identity), identity]));
  const identityChanged = (partId: string, candidateId: number | null) => {
    if (candidateId === null) return false;
    const key = identityKey({ partId, candidateId });
    return previous.get(key)?.fdi !== byKey.get(key)?.fdi;
  };
  const scans = prepared.scans.map(source => {
    if (!identities.some(identity => identity.partId === source.partId && changed.has(identityKey(identity)))) return source;
    const draftLabels = source.draftLabels.slice();
    const candidates = source.scan.candidates.map(candidate => {
      const key = identityKey({ partId: source.partId, candidateId: candidate.id }), identity = byKey.get(key);
      if (!changed.has(key) || !identity) return candidate;
      for (const face of candidate.faces) {
        if (reviewed.labels[source.partId]?.[face] || reviewed.reviewedMask?.[source.partId]?.[face]) draftLabels[face] = reviewed.labels[source.partId]?.[face] ?? 0;
        else draftLabels[face] = identity.needsReview ? 0 : identity.fdi ?? 0;
      }
      return identity.blockingReasons?.length ? { ...candidate, warnings: [...new Set([...candidate.warnings, ...identity.blockingReasons])] } : candidate;
    });
    const analysis = source.analysis ? { ...source.analysis,
      // Gap identities depend on their immediate flanks. Retain the measured
      // span and patch evidence without reusing the superseded FDI sequence.
      gaps: source.analysis.gaps.map(gap => [gap.before, gap.after].some(candidateId => identityChanged(source.partId, candidateId)
        || candidateId !== null && boundaryBlocked.has(identityKey({ partId: source.partId, candidateId }))) ? { ...gap, positions: [] } : gap),
      teeth: source.analysis.teeth.map(tooth => {
      const key = identityKey({ partId: source.partId, candidateId: tooth.id }), identity = byKey.get(key);
      if (!changed.has(key) || !identity) return tooth;
      // "mixed" and "non-tooth" are review hypotheses, not new anatomical
      // tissue classes. Keep the geometric kind and flag it without carving
      // triangles, claiming margins, or converting a rejected crown to ridge.
      return { ...tooth, fdi: identity.fdi, flags: [...new Set([...tooth.flags, ...(identity.blockingReasons ?? [])])] };
    }) } : null;
    return { ...source, scan: { ...source.scan, candidates }, analysis, draftLabels };
  });
  const keyFor = (neighbor: SiteNeighbour) => identityKey({ partId: neighbor.partId, candidateId: neighbor.toothId });
  const current = (neighbor: SiteNeighbour | null): SiteNeighbour | null => {
    if (!neighbor) return null;
    const identity = byKey.get(keyFor(neighbor));
    return identity && changed.has(keyFor(neighbor)) ? { ...neighbor, fdi: identity.fdi, confidence: identity.needsReview ? 0 : identity.confidence } : neighbor;
  };
  const sites = prepared.sites.map(site => {
    const flanks = [site.adjacent.mesial, site.adjacent.distal].filter((neighbor): neighbor is SiteNeighbour => !!neighbor);
    const affected = [...flanks, ...(site.opposing?.teeth ?? []), ...(site.contralateral ? [site.contralateral] : [])].some(neighbor => changed.has(keyFor(neighbor)));
    if (!affected) return site;
    const flankChanged = flanks.some(neighbor => identityChanged(neighbor.partId, neighbor.toothId));
    const blocked = flanks.some(neighbor => boundaryBlocked.has(keyFor(neighbor)));
    const reason = blocked ? 'An immediate flank has an unresolved or excluded AI region hypothesis; review segmentation before using this site.'
      : flankChanged ? 'An immediate flank identity changed after AI region review; the existing space remains localized, but its old FDI sequence is unverified.' : '';
    const contralateral = site.contralateral && !changed.has(keyFor(site.contralateral)) && !byKey.get(keyFor(site.contralateral))?.needsReview ? site.contralateral : null;
    const next = { ...site, adjacent: { mesial: current(site.adjacent.mesial), distal: current(site.adjacent.distal) },
      opposing: site.opposing ? { ...site.opposing, teeth: site.opposing.teeth.map(neighbor => current(neighbor)!) } : null,
      contralateral: flankChanged || blocked ? null : contralateral };
    if (!reason) return next;
    const template = site.draftIdentity?.templateFdi ?? site.fdi;
    return { ...next, fdi: null, alternatives: [], confidence: 0,
      status: blocked ? 'segmentation-unresolved' as const : site.status === 'not-scanned' || site.status === 'segmentation-unresolved' ? site.status : 'identity-unresolved' as const,
      draftIdentity: !blocked && (site.kind === 'bounded' || site.kind === 'distal-extension') && site.anchor && site.frame && template !== null && isFdiTooth(template) && toothArch(template) === site.arch
        ? { templateFdi: template, alternatives: [...new Set([template, ...(site.draftIdentity?.alternatives ?? []), ...site.alternatives])], basis: `${reason} FDI ${template} selects illustrative anatomy only; no new absent tooth is asserted.` } : undefined,
      evidence: { supporting: site.evidence.supporting.map(text => text.replace(/FDI \d+/g, 'unverified identity')), conflicting: [...site.evidence.conflicting.map(text => text.replace(/FDI \d+/g, 'unverified identity')), reason] },
      questions: [...site.questions.map(text => text.replace(/FDI \d+/g, 'unverified identity')), 'Review the immediate flank regions and site numbering.'],
    };
  });
  return { ...prepared, identities, scans, sites };
}
