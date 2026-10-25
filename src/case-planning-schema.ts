import { z } from 'zod';
import { assistantSnapshotSchema } from './assistant-context.ts';
import { anthropicModelIdSchema } from './anthropic-models.ts';
import type { CasePlanningRequest, CasePlanningResult } from './case-planning-types.ts';
import { isFdiTooth, toothArch } from './teeth.ts';
import { tomographyEvidenceSchema } from './tomography-evidence.ts';
import { restorationGenerationDesignSchema } from './restoration-generation.ts';
import { planningRegionReviewSchema, planningSiteReviewSchema } from './planning-decisions.ts';
import type { PlanningRegionReview } from './planning-decisions.ts';

export const MAX_PLANNING_VIEWS = 8;
export const MAX_PLANNING_IMAGE_BYTES = 1.5 * 1024 * 1024;
export const MAX_PLANNING_IMAGE_BASE64_LENGTH = 4 * Math.ceil(MAX_PLANNING_IMAGE_BYTES / 3);
const boundedEvidenceStrings = z.array(z.string().max(600)).max(12);
const scanId = z.string().regex(/^scan-(?:[1-9]|[1-5]\d|6[0-4])$/);
const viewId = z.string().regex(/^view-[1-8]$/);
const candidateId = z.number().int().min(0).max(10_000_000);
const preparedToothReference = z.strictObject({ sourceId: scanId, candidateId, fdi: z.number().int().refine(isFdiTooth).nullable(), confidence: z.number().finite().min(0).max(1) });
const preparedSiteRelationships = z.strictObject({
  adjacent: z.strictObject({ mesial: preparedToothReference.nullable(), distal: preparedToothReference.nullable() }),
  contralateral: preparedToothReference.nullable(),
  opposing: z.strictObject({ sourceId: scanId, teeth: z.array(preparedToothReference).max(32), poseVerified: z.boolean() }).nullable(),
});
export const planningExecutionSchema = z.strictObject({
  requestedModel: z.string().max(160), actualModel: z.string().max(160), provider: z.string().max(160),
  inputTokens: z.number().int().nonnegative().nullable(), outputTokens: z.number().int().nonnegative().nullable(), providerSteps: z.number().int().min(0).max(6), durationMs: z.number().finite().nonnegative(),
  limits: z.strictObject({ providerSteps: z.number().int().min(1).max(6), toolCalls: z.number().int().min(1).max(48), outputTokensPerStep: z.number().int().min(1).max(8192) }),
  toolResults: z.array(z.strictObject({ name: z.string().max(100), input: z.unknown(), output: z.unknown(), origin: z.literal('structured-command').optional() })).max(48),
  regionReviews: z.array(planningRegionReviewSchema).max(128).optional(), siteReviews: z.array(planningSiteReviewSchema).max(128).optional(),
  draftRequests: z.array(z.strictObject({ siteId: z.string().min(1).max(160), fdi: z.number().int().refine((value): boolean => isFdiTooth(value)), anatomy: z.enum(['incisor', 'canine', 'premolar', 'molar']), rationale: z.string().max(600), design: restorationGenerationDesignSchema.optional() })).max(16),
});

/** A single linear pass, including canonical padding bits; no recursive/backtracking regex. */
export function isPlanningBase64(value: string): boolean {
  if (!value.length || value.length > MAX_PLANNING_IMAGE_BASE64_LENGTH || value.length % 4 !== 0) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const digit = (code: number) => code >= 65 && code <= 90 ? code - 65
    : code >= 97 && code <= 122 ? code - 71 : code >= 48 && code <= 57 ? code + 4
      : code === 43 ? 62 : code === 47 ? 63 : -1;
  for (let i = 0; i < value.length - padding; i++) if (digit(value.charCodeAt(i)) < 0) return false;
  const last = digit(value.charCodeAt(value.length - padding - 1));
  return padding === 2 ? (last & 15) === 0 : padding === 1 ? (last & 3) === 0 : true;
}

/** Notes are never part of this visual planning flow, including explicitly opted-in chat notes. */
const planningSnapshot = assistantSnapshotSchema.refine(
  value => !value.notesIncluded && value.teeth.every(tooth => tooth.note === undefined),
  'Planning snapshots must exclude notes.',
);

export const casePlanningRequestSchema = z.strictObject({
  model: anthropicModelIdSchema.optional(),
  tomography: tomographyEvidenceSchema.optional(),
  measurementContext: z.strictObject({ mmPerUnit: z.number().finite().positive().nullable(), scaleStatus: z.enum(['unconfirmed', 'clinician-entered']), scaleSource: z.string().max(300), biteReviewed: z.boolean(),
    ruler: z.strictObject({ distance: z.number().finite().nonnegative(), units: z.literal('file units (u)'), sourceIds: z.array(scanId).min(1).max(2), method: z.literal('picked-point-straight-line') }).optional() }).optional(),
  revision: z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/),
  snapshot: planningSnapshot,
  sources: z.array(z.strictObject({
    id: scanId,
    arch: z.enum(['upper', 'lower']),
    triangles: z.number().int().min(1).max(10_000_000),
    texture: z.enum(['mapped', 'vertex-colors', 'unmapped', 'none']),
    patientRight: z.enum(['image-left', 'image-right']).nullable(),
    roleConfirmed: z.boolean().optional(),
    candidates: z.array(z.strictObject({
      id: candidateId,
      triangles: z.number().int().min(1).max(10_000_000),
      area: z.number().finite().nonnegative(),
      height: z.number().finite().nonnegative(),
      warnings: z.array(z.string().max(240)).max(8),
    })).max(32),
  })).min(1).max(64),
  views: z.array(z.strictObject({
    id: viewId,
    sourceId: scanId.nullable(),
    context: z.enum(['arch', 'occlusion']),
    label: z.string().max(80),
    mediaType: z.literal('image/jpeg'),
    base64: z.string().max(MAX_PLANNING_IMAGE_BASE64_LENGTH).refine(isPlanningBase64, 'Use canonical padded base64.'),
  })).min(1).max(MAX_PLANNING_VIEWS),
  preparation: z.strictObject({
    threshold: z.number().finite().min(0).max(1).optional(),
    sources: z.array(z.strictObject({ sourceId: scanId, method: z.string().max(160), crownRegions: z.number().int().min(0).max(128), unresolvedTriangles: z.number().int().min(0).max(10_000_000), boundaryFaces: z.number().int().min(0).max(10_000_000).nullable(), colourAvailable: z.boolean() })).max(64),
    regions: z.array(z.strictObject({ sourceId: scanId, candidateId, fdi: z.number().int().refine(isFdiTooth).nullable(), confidence: z.number().finite().min(0).max(1), needsReview: z.boolean(),
      kind: z.string().max(80), dimensions: z.strictObject({ mesiodistal: z.number().finite().nonnegative().nullable(), buccolingual: z.number().finite().nonnegative().nullable(), height: z.number().finite().nonnegative().nullable() }),
      peaks: z.number().int().nonnegative().nullable(), flags: boundedEvidenceStrings, protectedTriangles: z.number().int().min(0).max(10_000_000), neighbors: z.array(candidateId).max(2) })).max(2048).optional(),
    sites: z.array(z.strictObject({ id: z.string().min(1).max(160), sourceId: scanId, fdi: z.number().int().refine(isFdiTooth).nullable(), status: z.enum(['proposed-missing', 'dentist-confirmed-missing', 'not-scanned', 'segmentation-unresolved', 'identity-unresolved']), confidence: z.number().finite().min(0).max(1), localized: z.boolean(), supporting: boundedEvidenceStrings, conflicting: boundedEvidenceStrings, questions: boundedEvidenceStrings,
      kind: z.enum(['bounded', 'terminal', 'distal-extension', 'chart']).optional(), slotCount: z.number().int().min(0).max(32).optional(), geometricDraftEligible: z.boolean().optional(), relationships: preparedSiteRelationships.optional(),
      space: z.strictObject({ unit: z.literal('file units (u)'), mesiodistal: z.number().finite().nullable(), buccolingual: z.number().finite().nullable(), sampledVertical: z.number().finite().nullable(), verticalMethod: z.string().max(600),
        crownHeight: z.number().finite().nullable().optional(), proximalGap: z.number().finite().nullable().optional(), widthMethod: z.string().max(600).optional(), heightMethod: z.string().max(600).optional() }).optional(),
    })).max(128),
  }).optional(),
}).superRefine((request, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  const sources = new Set(request.sources.map(source => source.id));
  if (request.measurementContext?.ruler?.sourceIds.some(id => !sources.has(id))) issue('Ruler evidence must reference supplied source scans.');
  if (sources.size !== request.sources.length) issue('Source identifiers must be unique.');
  if (request.preparation) {
    if (new Set(request.preparation.sites.map(site => site.id)).size !== request.preparation.sites.length) issue('Prepared site identifiers must be unique.');
    for (const item of [...request.preparation.sources, ...request.preparation.sites]) if (!sources.has(item.sourceId)) issue('Prepared evidence must reference a supplied source.');
    const regionIds = new Set<string>();
    for (const region of request.preparation.regions ?? []) {
      const source = request.sources.find(source => source.id === region.sourceId), key = `${region.sourceId}:${region.candidateId}`;
      if (!source?.candidates.some(candidate => candidate.id === region.candidateId) || regionIds.has(key)) issue('Region evidence must reference distinct supplied candidates.');
      regionIds.add(key);
      if (region.fdi !== null && source?.arch !== toothArch(region.fdi)) issue('Region identity must match its source arch.');
      if (region.neighbors.some(id => !source?.candidates.some(candidate => candidate.id === id))) issue('Region neighbors must reference candidates on the same source.');
    }
    for (const site of request.preparation.sites) if (site.fdi !== null && request.sources.find(source => source.id === site.sourceId)?.arch !== toothArch(site.fdi)) issue('Prepared site FDI must match its source arch.');
    for (const site of request.preparation.sites) {
      const relations = site.relationships, arch = request.sources.find(source => source.id === site.sourceId)?.arch;
      if (!relations) continue;
      for (const tooth of [relations.adjacent.mesial, relations.adjacent.distal, relations.contralateral, ...(relations.opposing?.teeth ?? [])]) {
        if (!tooth) continue;
        const source = request.sources.find(source => source.id === tooth.sourceId);
        if (!source || !source.candidates.some(candidate => candidate.id === tooth.candidateId)) issue('Tooth relationships must reference supplied crown candidates.');
        if (tooth.fdi !== null && source?.arch !== toothArch(tooth.fdi)) issue('Relationship FDI must match its source arch.');
      }
      for (const tooth of [relations.adjacent.mesial, relations.adjacent.distal, relations.contralateral]) {
        if (tooth && request.sources.find(source => source.id === tooth.sourceId)?.arch !== arch) issue('Adjacent and contralateral teeth must belong to the same arch.');
      }
      if (relations.opposing) {
        const opponent = request.sources.find(source => source.id === relations.opposing!.sourceId);
        if (!opponent || opponent.arch === arch || relations.opposing.teeth.some(tooth => tooth.sourceId !== opponent.id)) issue('Opposing relationships must reference the opposite arch source.');
        if (new Set(relations.opposing.teeth.map(tooth => tooth.candidateId)).size !== relations.opposing.teeth.length) issue('Opposing crown references must be unique.');
      }
    }
  }
  for (const source of request.sources) {
    const part = request.snapshot.parts.find(part => part.id === source.id);
    if (!part || part.role !== source.arch || part.triangles !== source.triangles) issue('Sources must match the snapshot arch and triangle count.');
    if (new Set(source.candidates.map(candidate => candidate.id)).size !== source.candidates.length) issue('Candidate identifiers must be unique within each source.');
    if (source.candidates.some(candidate => candidate.triangles > source.triangles)) issue('A candidate cannot exceed its source.');
  }
  if (new Set(request.views.map(view => view.id)).size !== request.views.length) issue('View identifiers must be unique.');
  for (const view of request.views) {
    if (view.sourceId !== null && !sources.has(view.sourceId)) issue('Views must reference a known source.');
    if ((view.context === 'arch') !== (view.sourceId !== null)) issue('Arch views need a source; occlusion views show the shared case.');
  }
});

// Provider-facing structure; semantic checks and bounds below also apply to direct callers.
const fdi = z.number().int().nullable();
const evidence = z.array(z.string());
export const casePlanningOutputSchema = z.strictObject({
  summary: z.string(),
  mappings: z.array(z.strictObject({ sourceId: z.string(), candidateId: z.number().int(), fdi, needsReview: z.boolean(), reason: z.string() })),
  findings: z.array(z.strictObject({
    id: z.string(), fdi,
    category: z.enum(['identity', 'possible-missing', 'surface-observation', 'restoration-review', 'hygiene-review', 'occlusion-review', 'data-quality']),
    title: z.string(), detail: z.string(), evidence, needsClinicalReview: z.boolean(),
  })),
  actions: z.array(z.strictObject({
    id: z.string(), fdi, kind: z.enum(['clinical-review', 'hygiene-review', 'restoration-review', 'implant-review']),
    title: z.string(), rationale: z.string(), evidence, prerequisites: z.array(z.string()),
  })),
  designs: z.array(z.strictObject({ fdi: z.number().int(), anatomy: z.enum(['incisor', 'canine', 'premolar', 'molar']), rationale: z.string() })),
  limitations: z.array(z.string()),
});

export class CasePlanningError extends Error {
  constructor(message: string) { super(message); this.name = 'CasePlanningError'; }
}

export function planningHasCollisionEvidence(request: CasePlanningRequest): boolean {
  const collision = request.snapshot.collision;
  return request.snapshot.analysisState === 'ready' && collision !== null && collision.pairs.some(pair => {
    const a = request.sources.find(source => source.id === pair.a), b = request.sources.find(source => source.id === pair.b);
    return a && b && a.arch !== b.arch && collision.comparedPartIds.includes(a.id) && collision.comparedPartIds.includes(b.id)
      && request.snapshot.parts.some(part => part.id === a.id && part.visible) && request.snapshot.parts.some(part => part.id === b.id && part.visible);
  });
}

const text = (value: string, max = 600) => value.replace(/\s+/g, ' ').trim().slice(0, max);
const fail = (message: string): never => { throw new CasePlanningError(message); };
const anatomyFor = (fdi: number) => fdi % 10 <= 2 ? 'incisor' : fdi % 10 === 3 ? 'canine' : fdi % 10 <= 5 ? 'premolar' : 'molar';

/** No numerical fixture/bone prescriptions may hide in otherwise data-only string fields. */
export function checkClinicalNumbers(value: string) {
  const withoutIds = value.replace(/\bFDI\s*\d{2}\b/gi, '').replace(/\b(?:scan-\d+(?::C\d+)?|view-\d+|C\d+)\b/g, '');
  const physicalDimension = /\b\d+(?:\.\d+)?\s*(?:mm\b|cm\b|millimet(?:er|re)s?\b|degrees?\b|°)/i;
  const surgical = /\b(?:implants?|fixtures?|bone|abutments?|screws?|osteotom(?:y|ies))\b/i;
  // Numeric tokens must end before a letter: “3D imaging” is evidence acquisition,
  // not a depth prescription. Physical dimensions are unsupported in file-unit inputs.
  const bareParameter = /\b(?:depth|deep|radius|diameter|length|angle|thickness|clearance|torque)\b[^.!?\n]{0,40}\b\d+(?:\.\d+)?(?!\w)(?!\.\d)/i;
  if (physicalDimension.test(withoutIds) || (surgical.test(withoutIds) && bareParameter.test(withoutIds))) {
    fail('Numerical bone or fixture prescriptions are unsupported.');
  }
  for (const clause of withoutIds.split(/[.!?;\n]/)) {
    const unsupported = /\b(?:bone[- ]safe|surgically safe|safe (?:implant |fixture )?(?:placement|trajectory|depth)|(?:implant |fixture )?trajectory (?:is |has been )?(?:safe|validated|verified)|(?:clinical fit|surgical clearance|surgical suitability) (?:is |has been )?(?:confirmed|validated|verified|approved))\b/i;
    const unresolved = /\b(?:not|no|cannot|can't|never|unknown|unassessed|unvalidated|unverified|unconfirmed|uncertain|unresolved|pending|doesn't|does not)\b/i;
    if (unsupported.test(clause) && !unresolved.test(clause)) fail('Bone-safe placement, surgical clearance and validated clinical fit are not established by surface evidence.');
  }
}

/** Revision is copied from the submitted case, never authored by the model. */
export function validateCasePlanning(output: unknown, request: CasePlanningRequest, regionReviews: PlanningRegionReview[] = []): Omit<CasePlanningResult, 'model'> {
  const parsed = casePlanningOutputSchema.safeParse(output);
  if (!parsed.success) return fail('The planning response has an invalid shape.');
  const data = parsed.data;
  // Tool decisions are the canonical draft interpretation. The final prose
  // cannot silently restore a region the model excluded through its tool.
  for (const review of regionReviews) {
    const mapping = { sourceId: review.sourceId, candidateId: review.candidateId,
      fdi: review.classification === 'tooth' && review.decision === 'use' ? review.fdi : null,
      needsReview: review.decision !== 'use' || review.classification !== 'tooth' || review.fdi === null,
      reason: `AI region setting (${review.classification}; ${review.decision}): ${review.rationale}` };
    const index = data.mappings.findIndex(item => item.sourceId === review.sourceId && item.candidateId === review.candidateId);
    if (index < 0) data.mappings.push(mapping); else data.mappings[index] = mapping;
  }
  // Check original strings before clipping or semantic validation so prescriptions cannot hide beyond a display limit.
  for (const value of [data.summary, ...data.mappings.map(item => item.reason), ...data.findings.flatMap(item => [item.title, item.detail]),
    ...data.actions.flatMap(item => [item.title, item.rationale, ...item.prerequisites]), ...data.designs.map(item => item.rationale), ...data.limitations]) checkClinicalNumbers(value);
  for (const finding of data.findings) checkClinicalNumbers(`${finding.title} ${finding.detail}`);
  for (const action of data.actions) checkClinicalNumbers(`${action.kind} ${action.title} ${action.rationale} ${action.prerequisites.join(' ')}`);
  const sources = new Map(request.sources.map(source => [source.id, source]));
  const regions = new Set(request.sources.flatMap(source => source.candidates.map(candidate => `${source.id}:C${candidate.id}`)));
  const allowedEvidence = new Set([...request.views.map(view => view.id), ...(request.tomography?.views.map(view => `tomography:${view.id}`) ?? []), ...regions,
    ...(planningHasCollisionEvidence(request) ? ['collision-report'] : [])]);
  const totalCandidates = regions.size;
  if (data.mappings.length > totalCandidates || data.findings.length > 64 || data.actions.length > 64
    || data.designs.length > 32 || data.limitations.length > 16) return fail('The planning response exceeds its limits.');
  const allowedFdi = (fdi: number | null) => {
    if (fdi !== null && (!isFdiTooth(fdi) || !request.sources.some(source => source.arch === toothArch(fdi)))) fail('An FDI position is outside the supplied arches.');
  };
  const mappedRegions = new Map<string, number | null>();
  const archImage = (fdi: number, refs: string[]) => refs.some(ref => {
    const view = request.views.find(view => view.id === ref);
    return view?.context === 'arch' && view.sourceId !== null && sources.get(view.sourceId)?.arch === toothArch(fdi);
  });
  const checkEvidence = (refs: string[], fdi: number | null, toothSpecific = false, crossArch = false) => {
    if (!refs.length || refs.length > 16 || new Set(refs).size !== refs.length) fail('Evidence must contain distinct case references.');
    for (const ref of refs) {
      if (!allowedEvidence.has(ref)) fail('The response cites unavailable evidence.');
      const sourceId = ref.includes(':C') ? ref.split(':')[0] : request.views.find(view => view.id === ref)?.sourceId;
      if (fdi !== null && sourceId && !crossArch && sources.get(sourceId)?.arch !== toothArch(fdi)) fail('Evidence refers to a different arch.');
    }
    if (fdi !== null && toothSpecific && refs.some(ref => ref.includes(':C')) && !refs.some(ref => mappedRegions.get(ref) === fdi)) {
      fail('Tooth-specific observations cannot cite only other crown regions, even alongside a generic arch view.');
    }
    if (fdi !== null && toothSpecific && !refs.some(ref => {
      if (ref === 'collision-report') return false;
      if (ref.includes(':C')) return mappedRegions.get(ref) === fdi;
      const view = request.views.find(view => view.id === ref);
      return !!view && (view.sourceId === null || sources.get(view.sourceId)?.arch === toothArch(fdi));
    })) fail('Tooth-specific observations need evidence for that tooth, rather than only a different mapped crown.');
    return refs;
  };
  const seen = new Set<string>(), assigned = new Set<number>();
  const mappings: CasePlanningResult['mappings'] = data.mappings.map(mapping => {
    const source = sources.get(mapping.sourceId), key = `${mapping.sourceId}:C${mapping.candidateId}`;
    if (!source || !regions.has(key) || seen.has(key)) return fail('Unknown or repeated source/candidate mapping.');
    seen.add(key);
    if (mapping.fdi !== null) {
      if (!isFdiTooth(mapping.fdi) || toothArch(mapping.fdi) !== source.arch || assigned.has(mapping.fdi)) return fail('Conflicting FDI mapping.');
      assigned.add(mapping.fdi);
    }
    mappedRegions.set(key, mapping.fdi);
    const hasView = request.views.some(view => view.context === 'arch' && view.sourceId === source.id);
    const chart = request.snapshot.teeth.find(tooth => tooth.fdi === mapping.fdi);
    return { ...mapping, needsReview: mapping.fdi === null || source.patientRight === null || source.roleConfirmed === false || !hasView
      || chart?.status === 'missing' || chart?.status === 'not-scanned' || mapping.needsReview,
    reason: text(mapping.reason) || 'Identity requires review.' };
  });
  for (const source of request.sources) for (const candidate of source.candidates) {
    if (!seen.has(`${source.id}:C${candidate.id}`)) mappings.push({ sourceId: source.id, candidateId: candidate.id, fdi: null, needsReview: true, reason: 'No mapping returned; identity is unknown.' });
  }
  const ids = new Set<string>();
  const id = (value: string) => {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value) || ids.has(value)) return fail('Planning item identifiers must be distinct and bounded.');
    ids.add(value); return value;
  };
  const findings: CasePlanningResult['findings'] = data.findings.map(finding => {
    allowedFdi(finding.fdi);
    if (finding.category === 'possible-missing' && finding.fdi !== null) {
      if (!request.sources.some(source => source.arch === toothArch(finding.fdi!) && source.patientRight !== null && source.roleConfirmed !== false)) return fail('A named missing-position hypothesis requires confirmed patient laterality and scan role.');
      const chart = request.snapshot.teeth.find(tooth => tooth.fdi === finding.fdi);
      if (assigned.has(finding.fdi) || chart?.status === 'present' || chart?.status === 'not-scanned' || (chart?.assignedTriangles ?? 0) > 0) return fail('Missing-tooth hypothesis contradicts case evidence.');
      if (!archImage(finding.fdi, finding.evidence)) return fail('A missing-position proposal needs a visible image of the corresponding arch.');
    }
    if (finding.category === 'occlusion-review' && finding.fdi !== null && !finding.evidence.some(ref => ref !== 'collision-report')) {
      return fail('An aggregate collision report cannot establish a tooth-specific occlusion finding.');
    }
    return { ...finding, id: id(finding.id), title: text(finding.title, 160), detail: text(finding.detail), evidence: checkEvidence(finding.evidence, finding.fdi, ['identity', 'surface-observation', 'restoration-review', 'hygiene-review'].includes(finding.category), finding.category === 'occlusion-review'), needsClinicalReview: true };
  });
  const actions: CasePlanningResult['actions'] = data.actions.map(action => {
    allowedFdi(action.fdi);
    if (!action.prerequisites.length || action.prerequisites.length > 12) return fail('Review actions require bounded prerequisites.');
    if (action.kind === 'implant-review' && action.fdi !== null) {
      const chart = request.snapshot.teeth.find(tooth => tooth.fdi === action.fdi);
      const proposal = findings.some(finding => finding.category === 'possible-missing' && finding.fdi === action.fdi);
      if (chart?.status === 'present' || chart?.status === 'not-scanned' || (chart?.assignedTriangles ?? 0) > 0 || assigned.has(action.fdi)
        || (!proposal && chart?.status !== 'missing') || !archImage(action.fdi, action.evidence)) return fail('Implant review requires a supported missing-position proposal or reviewed chart site, with arch image evidence.');
    }
    return { ...action, id: id(action.id), title: text(action.title, 160), rationale: text(action.rationale), evidence: checkEvidence(action.evidence, action.fdi, action.kind === 'hygiene-review' || action.kind === 'restoration-review'), prerequisites: action.prerequisites.map(value => text(value, 300)) };
  });
  const designed = new Set<number>();
  const designs = data.designs.map(design => {
    allowedFdi(design.fdi);
    if (designed.has(design.fdi) || design.anatomy !== anatomyFor(design.fdi)) return fail('Design anatomy must match a unique permanent FDI position.');
    const chart = request.snapshot.teeth.find(tooth => tooth.fdi === design.fdi);
    const mapped = mappings.some(mapping => mapping.fdi === design.fdi && request.views.some(view => view.context === 'arch' && view.sourceId === mapping.sourceId));
    const proposal = findings.some(finding => finding.fdi === design.fdi && finding.category === 'possible-missing');
    const chartSite = chart?.status === 'missing' && request.views.some(view => view.context === 'arch' && view.sourceId && sources.get(view.sourceId)?.arch === toothArch(design.fdi));
    if (chart?.status === 'not-scanned' || (!mapped && !proposal && !chartSite)) return fail('Exterior design suggestions require a visible mapped tooth or supported site proposal.');
    designed.add(design.fdi);
    return { ...design, rationale: text(design.rationale) };
  });
  return {
    revision: request.revision, summary: text(data.summary, 1400), mappings, findings, actions, designs,
    limitations: [...new Set([
      ...data.limitations.map(value => text(value)).filter(Boolean),
      'Proposals and visual hypotheses require clinical review; they do not establish a diagnosis or treatment need.',
      'Unscanned regions and unlabeled geometry do not establish missing teeth. Distances use file units.',
      'Shared current-pose coordinates do not verify bite registration, complete scan coverage, or anatomical orientation.',
      'Static images and sampled mesh distances cannot establish exact contact area, overlap volume, dynamic bite, bone anatomy, or surgical clearance.',
      'Designs are editable exterior concepts; fixture placement, connection fit, tissue response, and fabrication remain unassessed.',
      ...(request.sources.some(source => source.texture === 'unmapped' || source.texture === 'none') ? ['Some sources lack mapped texture or vertex colors; unavailable surface appearance must remain unknown.'] : []),
    ])],
  };
}
