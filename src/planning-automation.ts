import type { CasePlanningResult, CasePlanningRequest } from './case-planning-types.ts';
import type { ModelPart } from './models.ts';
import type { ToothCase } from './tooth-types.ts';
import type { PreparedCaseSource } from './useCasePlanning.ts';
import { isFdiTooth, toothArch } from './teeth.ts';
import type { SiteHypothesis } from './missing-sites.ts';
import type { CasePreparationResult } from './case-preparation-types.ts';
import { restorationGenerationDesignSchema, type RestorationGenerationRequest } from './restoration-generation.ts';
import { toothClassOf } from './crown-anatomy.ts';
import type { RestorationAssembly } from './restoration-types';

export interface ProposedPlanningSite {
  fdi: number;
  evidence: string[];
  rationale: string;
  provenance: 'hypothesized';
}
export interface PlanningDraft {
  regions: { partId: string; tooth: number; faces: Uint32Array }[];
  proposedSites: ProposedPlanningSite[];
  reviewedSites: number[];
  skipped: { fdi: number | null; reason: string }[];
}

/** A neutral template selects a shape; only its geometric site identifies the concept. */
export function conceptKey(site: {
  fdi: number | null; id?: string; siteId?: string;
  draftIdentity?: { siteId?: string; templateFdi?: number };
}): string {
  return site.draftIdentity
    ? `site:${site.draftIdentity.siteId ?? site.siteId ?? site.id}`
    : `fdi:${site.fdi}`;
}

/** A provider proposal can request local geometry, never bypass local site evidence. */
export function assessmentSupportsSite(result: CasePlanningResult, fdi: number): boolean {
  if (result.model === 'local-geometry') return true;
  if (result.mappings.some(mapping => mapping.fdi === fdi)) return false;
  return !!result.execution?.draftRequests.some(request => request.fdi === fdi)
    || result.findings.some(finding => finding.fdi === fdi && finding.category === 'possible-missing');
}

/** Localized visual drafts do not require a reviewed anatomical identity. */
export function automaticConceptSites({ sites, teeth, counts, parts, result, decisions = {} }: {
  sites: SiteHypothesis[]; teeth: ToothCase; counts: Record<number, number>; parts: ModelPart[];
  result: CasePlanningResult; decisions?: Record<string, number | null>;
}): SiteHypothesis[] {
  const eligible = sites.flatMap(site => {
    if (Object.hasOwn(decisions, site.id) && decisions[site.id] === null) return [];
    const distalDraft = site.kind === 'distal-extension' && site.fdi === null && !!site.draftIdentity
      && site.status === 'identity-unresolved' && site.slot.count === 1 && !!site.adjacent.mesial && !site.adjacent.distal;
    if (site.kind !== 'bounded' && !distalDraft || !site.anchor || !site.frame || !site.patchFaces.length
      || !['proposed-missing', 'identity-unresolved', 'dentist-confirmed-missing'].includes(site.status)) return [];
    const part = parts.find(part => part.id === site.partId);
    if (!part || part.role !== site.arch || site.patchFaces.some(face => face >= part.triangles || face < 0
      || !!teeth.labels[part.id]?.[face] || !!teeth.reviewedMask?.[part.id]?.[face])) return [];
    if ([site.space.mesiodistal, site.space.buccolingual, site.space.crownHeight].some(measure => measure.value === null || !Number.isFinite(measure.value) || measure.value <= 0)) return [];
    const candidates = site.fdi === null ? [site.draftIdentity?.templateFdi, ...(site.draftIdentity?.alternatives ?? [])] : [site.fdi];
    const fdi = candidates.find((code): code is number => code !== undefined && isFdiTooth(code) && toothArch(code) === site.arch
      && !(counts[code] > 0) && !['present', 'not-scanned'].includes(teeth.teeth[code]?.status)
      && !result.mappings.some(mapping => mapping.fdi === code));
    if (fdi === undefined) return [];
    return [{ ...site, fdi, status: 'proposed-missing' as const,
      ...(site.fdi === null && site.draftIdentity ? { draftIdentity: { ...site.draftIdentity, templateFdi: fdi } } : {}) }];
  });
  return eligible.filter(site => !eligible.some(other => {
    if (other === site) return false;
    if (other.id === site.id || conceptKey(other) === conceptKey(site)) return true;
    if (other.partId !== site.partId) return false;
    // Distinct templates must not duplicate a ridge region either. Keep all
    // conflicting definitions out rather than choosing one by input order.
    const patch = new Set(site.patchFaces);
    return other.patchFaces.some(face => patch.has(face))
      || !!(site.anchor && other.anchor && site.anchor.face === other.anchor.face
        && site.anchor.point.every((value, index) => value === other.anchor!.point[index]));
  }));
}

/** Resolve anonymous provider site handles against their original preparation,
 * then recheck local surface eligibility. An advisory design is never executable. */
export function aiGenerationPlan({ result, prepared, sites, teeth, counts, parts, decisions = {} }: {
  result: CasePlanningResult; prepared: CasePreparationResult; sites: SiteHypothesis[];
  teeth: ToothCase; counts: Record<number, number>; parts: ModelPart[]; decisions?: Record<string, number | null>;
}): { sites: SiteHypothesis[]; requests: RestorationGenerationRequest[]; skipped: string[] } {
  const plan: ReturnType<typeof aiGenerationPlan> = { sites: [], requests: [], skipped: [] };
  if (result.revision !== prepared.revision || result.model === 'local-geometry') return plan;
  const requests = result.execution?.draftRequests ?? [];
  const duplicateIds = new Set(requests.filter((request, index) => requests.findIndex(other => other.siteId === request.siteId) !== index).map(request => request.siteId));
  const eligible = automaticConceptSites({ sites, teeth, counts, parts, result, decisions });
  for (const request of requests) {
    const match = /^site-([1-9]\d*)$/.exec(request.siteId);
    const original = match ? prepared.sites[Number(match[1]) - 1] : undefined;
    const site = original && eligible.find(site => site.id === original.id && site.partId === original.partId);
    const parsed = restorationGenerationDesignSchema.safeParse(request.design);
    const siteReview = result.execution?.siteReviews?.find(review => review.siteId === request.siteId);
    if (!site || !parsed.success || duplicateIds.has(request.siteId) || siteReview && siteReview.decision !== 'design' || !isFdiTooth(request.fdi)
      || toothArch(request.fdi) !== site.arch || request.anatomy !== parsed.data.anatomy
      || toothClassOf(request.fdi) !== parsed.data.anatomy || (!site.draftIdentity && site.fdi !== request.fdi)) {
      plan.skipped.push(`${request.siteId}: AI design is incomplete, conflicting or no longer supported by the current site evidence.`);
      continue;
    }
    const selected = site.draftIdentity ? { ...site, fdi: request.fdi,
      draftIdentity: { ...site.draftIdentity, templateFdi: request.fdi,
        basis: `AI-selected ${parsed.data.anatomy} template for a localized visual draft; patient tooth identity remains unresolved. ${request.rationale}` } } : site;
    plan.sites.push(selected);
    plan.requests.push({ siteId: selected.id, fdi: request.fdi, rationale: request.rationale, design: parsed.data });
  }
  return plan;
}

/** Design decisions also invalidate work when the preparation revision is unchanged. */
export function planningDesignRevision(result: CasePlanningResult | null): string {
  return JSON.stringify([result?.model ?? null, result?.execution?.draftRequests ?? [], result?.execution?.regionReviews ?? [], result?.execution?.siteReviews ?? []]);
}

/** A just-returned assessment can precede React's stale-assembly effect. Older
 * designs must not suppress its replacement merely because the site exists. */
export function completedConceptKeys(assemblies: RestorationAssembly[], current: CasePlanningResult | null, incoming = current): Set<string> {
  if (planningDesignRevision(current) !== planningDesignRevision(incoming)) return new Set();
  return new Set(assemblies.filter(assembly => !assembly.warnings.some(warning => warning.startsWith('STALE:'))).map(assembly => conceptKey(assembly.spec)));
}

/** Build reversible draft operations. Never change the saved chart or imply site geometry is ready. */
export function buildPlanningDraft({ result, evidence, parts, teeth, counts, sites = [] }: {
  result: CasePlanningResult;
  evidence: { revision: string; sources: PreparedCaseSource[]; views: CasePlanningRequest['views'] };
  parts: ModelPart[];
  teeth: ToothCase;
  counts: Record<number, number>;
  sites?: SiteHypothesis[];
}): PlanningDraft {
  const draft: PlanningDraft = { regions: [], proposedSites: [], reviewedSites: [], skipped: [] };
  if (result.revision !== evidence.revision) {
    draft.skipped.push({ fdi: null, reason: 'The assessment belongs to older evidence. Prepare a fresh draft.' });
    return draft;
  }
  const sourceFor = (id: string) => /^scan-[1-9]\d*$/.test(id) ? parts[Number(id.slice(5)) - 1] : undefined;
  const visualArch = (fdi: number, refs: string[]) => (result.model === 'local-geometry' && sites.some(site => site.fdi === fdi && site.anchor && site.frame && refs.includes(site.id)) && evidence.views.some(view => view.context === 'arch' && view.sourceId !== null && sourceFor(view.sourceId)?.role === toothArch(fdi))) || refs.some(ref => {
    const view = evidence.views.find(view => view.id === ref);
    return view?.context === 'arch' && view.sourceId !== null && sourceFor(view.sourceId)?.role === toothArch(fdi);
  });
  const identities = new Map<number, number>();
  const pairs = new Map<string, number>();
  for (const mapping of result.mappings) {
    if (mapping.fdi !== null) identities.set(mapping.fdi, (identities.get(mapping.fdi) ?? 0) + 1);
    const key = `${mapping.sourceId}:${mapping.candidateId}`;
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
  }
  for (const mapping of result.mappings) {
    const fdi = mapping.fdi;
    if (fdi === null || mapping.needsReview) continue;
    const part = sourceFor(mapping.sourceId);
    const source = evidence.sources.find(source => source.partId === part?.id);
    const candidate = source?.scan.candidates.find(candidate => candidate.id === mapping.candidateId);
    const record = teeth.teeth[fdi];
    let reason = '';
    if (!isFdiTooth(fdi) || part?.role !== toothArch(fdi) || !candidate?.faces.length || source?.scan.method === 'unavailable') reason = 'The proposed identity has no matching current arch region.';
    else if (!visualArch(fdi, evidence.views.filter(view => view.sourceId === mapping.sourceId).map(view => view.id))) reason = 'This source has no prepared arch image; identity needs review.';
    else if (identities.get(fdi) !== 1 || pairs.get(`${mapping.sourceId}:${mapping.candidateId}`) !== 1) reason = 'Conflicting identity proposals require review.';
    else if (!record || record.status === 'missing' || record.status === 'not-scanned') reason = 'The saved tooth status conflicts with this identity proposal.';
    else if (counts[fdi] > 0) reason = 'Existing tooth labels are preserved; review changes in correction tools.';
    else if (candidate.faces.some(face => face >= part!.triangles || (teeth.labels[part!.id]?.[face] ?? 0) !== 0)) reason = 'This region contains existing labels or exclusions; review it in correction tools.';
    if (reason) draft.skipped.push({ fdi, reason });
    else draft.regions.push({ partId: part!.id, tooth: fdi, faces: candidate!.faces });
  }
  const mappedFdi = new Set(result.mappings.flatMap(mapping => mapping.fdi === null ? [] : [mapping.fdi]));
  const proposed = new Set<number>();
  for (const finding of result.findings) {
    if (finding.category !== 'possible-missing') continue;
    const fdi = finding.fdi;
    let reason = '';
    if (fdi === null || !isFdiTooth(fdi)) reason = 'A visible gap has no resolved FDI identity.';
    else if (mappedFdi.has(fdi) || counts[fdi] > 0 || teeth.teeth[fdi]?.status === 'present') reason = 'The gap proposal conflicts with a present tooth or identity proposal.';
    else if (!teeth.teeth[fdi] || teeth.teeth[fdi].status === 'not-scanned') reason = 'Scan coverage is unresolved at this position.';
    else if (!visualArch(fdi, finding.evidence)) reason = 'A site proposal needs a prepared image of the corresponding arch.';
    if (reason) { draft.skipped.push({ fdi, reason }); continue; }
    if (!proposed.has(fdi!)) {
      proposed.add(fdi!);
      draft.proposedSites.push({ fdi: fdi!, evidence: [...finding.evidence], rationale: finding.detail, provenance: 'hypothesized' });
    }
  }
  draft.reviewedSites = Object.entries(teeth.teeth).filter(([code, record]) => {
    const fdi = Number(code);
    return isFdiTooth(fdi) && record.status === 'missing' && record.restoration === 'implant' && !(counts[fdi] > 0)
      && parts.some(part => part.role === toothArch(fdi));
  }).map(([fdi]) => Number(fdi));
  return draft;
}
