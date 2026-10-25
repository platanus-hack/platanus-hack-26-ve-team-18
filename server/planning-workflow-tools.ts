import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { CasePlanningRequest, PlanningExecutionEvidence } from '../src/case-planning-types.ts';
import { WORKFLOW_BUDGET } from '../src/case-workflow.ts';
import { toothClassOf } from '../src/crown-anatomy.ts';
import { checkClinicalNumbers } from '../src/case-planning-schema.ts';
import { restorationGenerationDesignSchema, type RestorationGenerationDesign } from '../src/restoration-generation.ts';
import { isFdiTooth, toothArch } from '../src/teeth.ts';
import { planningRegionReviewSchema, planningSiteReviewSchema } from '../src/planning-decisions.ts';

const anatomyClasses = ['incisor', 'canine', 'premolar', 'molar'] as const;
const neutralTemplateDigit: Record<RestorationGenerationDesign['anatomy'], number> = { incisor: 1, canine: 3, premolar: 4, molar: 6 };
const finitePositive = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;

/** Complete model-authored commands can also accompany the structured assessment. */
export const planningWorkflowOutputSchema = z.strictObject({
  regionReviews: z.array(planningRegionReviewSchema).max(128),
  sites: z.array(planningSiteReviewSchema.extend({ design: restorationGenerationDesignSchema.nullable() }).refine(
    site => (site.decision === 'design') === (site.design !== null),
    'A design decision requires a complete design; deferred/excluded sites must have design:null.',
  )).max(WORKFLOW_BUDGET.sites),
});

/** Model-facing IDs resolve only to evidence in this request. Geometry never leaves the browser. */
export function createPlanningWorkflowTools(request: CasePlanningRequest) {
  const draftRequests: PlanningExecutionEvidence['draftRequests'] = [];
  const regionReviews: NonNullable<PlanningExecutionEvidence['regionReviews']> = [];
  const siteReviews: NonNullable<PlanningExecutionEvidence['siteReviews']> = [];
  const sites = request.preparation?.sites ?? [];
  const siteInput = z.strictObject({ siteId: z.string().min(1).max(160) });
  // Legacy saved execution evidence may omit design; a live model request never may.
  const requestInput = siteInput.extend({ rationale: z.string().min(1).max(600), design: restorationGenerationDesignSchema });
  const evaluate = (siteId: string) => {
    const site = sites.find(site => site.id === siteId);
    const source = request.sources.find(source => source.id === site?.sourceId);
    // Check only the source identity, never a neutral illustrative template against the chart.
    const chart = request.snapshot.teeth.find(tooth => site?.fdi !== null && tooth.fdi === site?.fdi);
    const neutral = !!site && !!source && (site.fdi === null || source.patientRight === null);
    const confidenceSupported = !!site && Number.isFinite(site.confidence) && site.confidence >= (request.preparation?.threshold ?? .8);
    const identitySupported = !!site && !!source && (site.fdi === null || isFdiTooth(site.fdi) && toothArch(site.fdi) === source.arch);
    const distalDraft = site?.kind === 'distal-extension' && site.fdi === null && site.status === 'identity-unresolved'
      && site.slotCount === 1
      && !!site.relationships?.adjacent.mesial && !site.relationships.adjacent.distal;
    const statusSupported = !!site && (neutral
      ? site.geometricDraftEligible === true && (site.kind === 'bounded' || distalDraft) && ['proposed-missing', 'identity-unresolved'].includes(site.status) && (site.fdi === null || confidenceSupported)
        && finitePositive(site.slotCount) && finitePositive(site.space?.mesiodistal) && finitePositive(site.space?.buccolingual) && finitePositive(site.space?.crownHeight)
      : site.fdi !== null && ['proposed-missing', 'dentist-confirmed-missing'].includes(site.status)
        && site.kind !== 'distal-extension' && (site.kind !== 'terminal' || site.status === 'dentist-confirmed-missing')
        && (site.status === 'dentist-confirmed-missing' || confidenceSupported));
    // An unreviewed filename role can support a labeled geometric placeholder,
    // never a named anatomical assertion. Preparation clears its FDI first.
    const roleSupported = source?.roleConfirmed !== false || !!site && neutral && site.fdi === null && site.geometricDraftEligible === true;
    const blockedFlanks = [site?.relationships?.adjacent.mesial, site?.relationships?.adjacent.distal].filter(Boolean)
      .filter(reference => regionReviews.some(review => review.sourceId === reference!.sourceId && review.candidateId === reference!.candidateId
        && (review.decision !== 'use' || review.classification !== 'tooth')));
    const selected = siteReviews.find(review => review.siteId === siteId);
    const supported = !!site && !!source && roleSupported && site.localized && identitySupported && statusSupported
      && chart?.status !== 'present' && chart?.status !== 'not-scanned' && !(chart?.assignedTriangles! > 0)
      && !blockedFlanks.length && (!selected || selected.decision === 'design');
    return { status: site ? 'available' : 'unavailable', site: site ?? null, draftEligible: supported, neutralIdentity: neutral,
      review: selected ?? null, blockedFlanks,
      limitations: ['A localized space is a geometric hypothesis, not confirmed absence or implant indication.', 'An unconfirmed FDI or patient side remains unresolved; a draft FDI selects an illustrative template only and never changes the saved chart.', 'The client revalidates identity, source, pose and site dependencies before construction.'] };
  };
  const inspectInput = z.strictObject({});
  const regionInput = z.strictObject({ sourceId: z.string().regex(/^scan-(?:[1-9]|[1-5]\d|6[0-4])$/), candidateId: z.number().int().min(0).max(10_000_000) });
  const reviewsInput = z.strictObject({ reviews: z.array(planningRegionReviewSchema).min(1).max(64) });
  const evidenceFor = (refs: string[], sourceId: string, candidateId?: number) => refs.every(ref => candidateId !== undefined && ref === `${sourceId}:C${candidateId}`
    || sites.some(site => site.id === ref && site.sourceId === sourceId)
    || request.views?.some(view => view.id === ref && view.context === 'arch' && view.sourceId === sourceId));
  const siteEvidenceFor = (refs: string[], site: typeof sites[number]) => {
    const contextual = (ref: string) => ref === site.id || request.views.some(view => view.id === ref && view.context === 'arch' && view.sourceId === site.sourceId);
    const neighbors = [site.relationships?.adjacent.mesial, site.relationships?.adjacent.distal].filter(reference => reference?.sourceId === site.sourceId
      && request.sources.find(source => source.id === site.sourceId)?.candidates.some(candidate => candidate.id === reference.candidateId));
    return refs.some(contextual) && refs.every(ref => contextual(ref) || neighbors.some(reference => ref === `${reference!.sourceId}:C${reference!.candidateId}`));
  };
  const tools = {
    inspectToothRegion: tool({ description: 'Inspect one supplied local tooth-region candidate: measured spans/height, peaks, boundary flags, protected triangles and neighboring candidate handles. This exposes actual local evidence, not invented boundaries or a diagnosis.', inputSchema: regionInput,
      execute: input => {
        const parsed = regionInput.parse(input), source = request.sources.find(source => source.id === parsed.sourceId), candidate = source?.candidates.find(candidate => candidate.id === parsed.candidateId);
        return { status: candidate ? 'available' : 'unavailable', sourceId: parsed.sourceId, candidate: candidate ?? null,
          region: request.preparation?.regions?.find(region => region.sourceId === parsed.sourceId && region.candidateId === parsed.candidateId) ?? null,
          reviewedInterpretation: regionReviews.find(review => review.sourceId === parsed.sourceId && review.candidateId === parsed.candidateId) ?? null,
          patientSideConfirmed: !!source && source.patientRight !== null, units: 'file units (u)',
          limits: ['Candidate boundaries are local surface proposals, not clinical margins.', 'Protected labels and explicit human corrections take precedence over AI draft settings. Missing identity is not missing geometry.'] };
      } }),
    reviewToothRegions: tool({ description: 'Record a batch of reversible AI region settings: use a supported tooth region with an unreviewed FDI hypothesis, flag a mixed/partial region for boundary correction, or exclude an unreliable candidate from automatic design. Supply source-specific evidence. This never overwrites saved labels, changes raw triangles or turns an excluded crown into a missing tooth.', inputSchema: reviewsInput,
      execute: input => {
        const { reviews } = reviewsInput.parse(input), keys = new Set<string>();
        const newReviews = reviews.filter(review => !regionReviews.some(item => item.sourceId === review.sourceId && item.candidateId === review.candidateId));
        if (regionReviews.length + newReviews.length > 128) return { recorded: false, reason: 'Region review budget reached. Retain the recorded regions and leave the rest unresolved.' };
        for (const review of reviews) {
          const source = request.sources.find(source => source.id === review.sourceId), candidate = source?.candidates.find(candidate => candidate.id === review.candidateId), key = `${review.sourceId}:${review.candidateId}`;
          checkClinicalNumbers(review.rationale);
          if (!candidate || keys.has(key) || !evidenceFor(review.evidence, review.sourceId, review.candidateId)) return { recorded: false, reason: 'Use distinct supplied candidates with evidence from that source.' };
          keys.add(key);
          if (review.decision === 'use' && review.classification !== 'tooth' || review.classification !== 'tooth' && review.fdi !== null) return { recorded: false, reason: 'Only a tooth interpretation can request use or carry a draft FDI.' };
          if (review.fdi !== null && (source!.patientRight === null || source!.roleConfirmed === false || toothArch(review.fdi) !== source!.arch
            || request.snapshot.teeth.some(tooth => tooth.fdi === review.fdi && ['missing', 'not-scanned'].includes(tooth.status)))) return { recorded: false, reason: 'The proposed tooth identity conflicts with source orientation, arch or saved coverage/status.' };
          const previous = regionReviews.find(item => item.sourceId === review.sourceId && item.candidateId === review.candidateId);
          if (previous && JSON.stringify(previous) !== JSON.stringify(review)) return { recorded: false, reason: 'A different interpretation is already recorded for that exact region.' };
          if (review.fdi !== null && [...regionReviews, ...reviews].some(other => other !== review && other.fdi === review.fdi && (other.sourceId !== review.sourceId || other.candidateId !== review.candidateId))) return { recorded: false, reason: 'One FDI cannot identify two separate regions.' };
          if (draftRequests.some(command => {
            const site = sites.find(site => site.id === command.siteId);
            return [site?.relationships?.adjacent.mesial, site?.relationships?.adjacent.distal].some(ref => ref?.sourceId === review.sourceId && ref.candidateId === review.candidateId);
          }) && review.decision !== 'use') return { recorded: false, reason: 'Review the supporting regions before queuing a design. This change would invalidate an already queued site.' };
        }
        for (const review of reviews) if (!regionReviews.some(item => item.sourceId === review.sourceId && item.candidateId === review.candidateId)) regionReviews.push(review);
        return { recorded: true, reviews, operation: 'reversible-draft-region-settings', appliedToReviewedChart: false, limits: ['The client rechecks exact region/source revisions and protected corrections before using these settings.', 'Mixed regions need a local boundary correction; this tool does not invent a tooth margin.'] };
      } }),
    reviewRestorationSite: tool({ description: 'Choose whether a measured scanned-space hypothesis should receive a visual design or remain deferred/excluded. Cite the local site or source arch views; give the measurement/anatomical basis and missing evidence. This decides a draft site, not a diagnosis or implant indication.', inputSchema: planningSiteReviewSchema,
      execute: input => {
        const review = planningSiteReviewSchema.parse(input), site = sites.find(site => site.id === review.siteId);
        checkClinicalNumbers(review.rationale);
        for (const missing of review.missingEvidence) checkClinicalNumbers(missing);
        if (!site || !siteEvidenceFor(review.evidence, site)) return { recorded: false, reason: 'Site review requires its supplied site or source arch view; only its known adjacent candidates may supplement that context.' };
        if (draftRequests.some(command => command.siteId === review.siteId) && review.decision !== 'design') return { recorded: false, reason: 'The site already has a queued design. Review sites before queuing construction.' };
        const previous = siteReviews.find(item => item.siteId === review.siteId);
        if (previous && JSON.stringify(previous) !== JSON.stringify(review)) return { recorded: false, reason: 'A conflicting site decision is already recorded.' };
        if (!previous) siteReviews.push(review);
        return { recorded: true, review, draftEligible: evaluate(review.siteId).draftEligible, appliedToReviewedChart: false };
      } }),
    inspectPlacementRules: tool({ description: 'Read the existing placement/measurement rules against one site: available surface envelopes, calibrated-unit status, bite review, and separate clinical datum requirements. Numeric clinical actuals stay null without reviewed bone/root measurements. Use this before choosing visual fixture depth, pilar height/slope and crown proportions.', inputSchema: siteInput,
      execute: input => {
        const evidence = evaluate(siteInput.parse(input).siteId);
        return { ...evidence, measurementContext: request.measurementContext ?? { mmPerUnit: null, scaleStatus: 'unconfirmed', scaleSource: 'Not supplied', biteReviewed: false },
          surfaceObjectives: { units: 'file units (u)', space: evidence.site?.space ?? null,
            neighbors: evidence.site?.relationships ?? null, fixtureDepthDatum: 'Local selected surface origin; not reviewed bone crest',
            componentDesign: 'nested-support/v1',
            componentDatums: { crownSeating: 'Abutment body height along the local construction axis; abutment.height remains the crown seating/body datum.',
              retentionSupport: 'A tapered generic pilar post extends above the seating datum inside the crown envelope. Its top is not the crown seating plane.' },
            constructionEvidence: { status: 'not-constructed', contacts: null, externalCrossings: null, pilarEnclosure: null,
              reason: 'Available MD/BL, neighboring crown height and sampled vertical space are preparation evidence. Actual contact bands, crossings, emitted support and gum exposure require worker geometry and a fresh restoration review.' },
            constraints: ['Choose coordinated crown width/depth/height/rotation and cervical contour from the recorded MD/BL, crown-height and sampled vertical evidence; unavailable headroom stays unknown.',
              'Crown base is positioned by pilar height and slope; changing fixture.depth alone does not move the crown. Review abutment radius/emergenceRadius/height/angles together with crown footprint and measured headroom.',
              'Close facing contact regions use each recorded target band in file units; do not impose universal zero distance or contact across whole surfaces.',
              'After construction inspect every target contact band and external crossing, required component-support.pilar-enclosure, gum-exposure and unknown clinical-emergence rows before revising. Preserve the target contract and remeasure all targets after every edit.',
              'Expected same-assembly pilar nesting is separate from external collision. Enclosure does not establish a manufactured connection, intaglio or wall thickness; a lower score or exploded-view separation is insufficient.'] },
          rulerLimit: 'The picked-point ruler is a direct straight-line distance in file units. It is not a minimum surface gap, root clearance, bone depth or a reviewed anatomical datum; an editable display scale does not verify calibration.',
          clinicalRules: [
            { id: 'subcrestal-platform', minimum: 1.5, units: 'mm', actual: null, error: null, status: 'unknown', provenance: 'Case-specific confirmed feedback in repository skill; applicability still requires review', datum: 'Implant platform below reviewed bone crest', missingEvidence: ['Verified scale', 'Reviewed crest and platform datums', 'Registered cross-sectional assessment'] },
            { id: 'adjacent-root-clearance', minimum: 1.5, units: 'mm', actual: null, error: null, status: 'unknown', provenance: 'Case-specific confirmed feedback in repository skill; applicability still requires review', datum: 'Fixture outer surface from each adjacent root', missingEvidence: ['Verified scale', 'Reviewed complete root surfaces', 'Registered fixture/root surface measurement'] },
          ], diagnosis: { status: 'clinical-review-required', evidence: 'Optical surface geometry and optional shared views support review hypotheses only.', notEstablished: ['Disease diagnosis', 'Bone-safe implant trajectory', 'Manufacturer connection fit', 'Clinical suitability'] } };
      } }),
    inspectPreparedCase: tool({ description: 'Inspect local preparation quality, candidate counts, unresolved coverage and available localized site evidence. This reads completed browser worker results; it does not segment or upload raw meshes.', inputSchema: inspectInput,
      execute: input => { inspectInput.parse(input); return { revision: request.revision, preparation: request.preparation ?? null,
        archReviews: request.sources.map(source => {
          const local = sites.filter(site => site.sourceId === source.id);
          return { sourceId: source.id, arch: source.arch, siteIds: local.map(site => site.id), terminalSiteIds: local.filter(site => site.kind === 'terminal').map(site => site.id),
            imageIds: (request.views ?? []).filter(view => view.context === 'arch' && view.sourceId === source.id).map(view => view.id),
            review: local.length ? 'Review every bounded and terminal region, including unresolved identities.' : 'No localized site was found; inspect scan coverage and posterior ends. This does not establish a complete dentition.' };
        }), regionReviews, siteReviews, units: 'file units (u)', missingEvidence: { patientSide: request.sources.some(source => source.patientRight === null), physicalUnits: request.measurementContext?.scaleStatus !== 'clinician-entered', motion: true, bone: true } }; } }),
    evaluateMissingSite: tool({ description: 'Inspect one local missing-space hypothesis and its conflicting evidence. Never interprets segmentation failure or unscanned coverage as absence.', inputSchema: siteInput,
      execute: input => evaluate(siteInput.parse(input).siteId) }),
    chooseAnatomicalCandidate: tool({ description: 'Inspect morphology evidence, identity-constrained allowed tooth classes, potential donor evidence and numerical site space. The model must explicitly choose anatomy and anatomySource in its complete design; this read-only tool chooses neither. Optional when the supplied case already contains the needed evidence.', inputSchema: siteInput,
      execute: input => {
        const evidence = evaluate(siteInput.parse(input).siteId), site = evidence.site;
        const knownAnatomy = site && isFdiTooth(site.fdi) ? toothClassOf(site.fdi) : null;
        const siteSource = request.sources.find(source => source.id === site?.sourceId);
        const donor = site?.relationships?.contralateral ?? null;
        const donorSource = request.sources.find(source => source.id === donor?.sourceId);
        return { ...evidence,
          // Compatibility field: a known-identity constraint, never a class choice for a null FDI.
          anatomy: evidence.draftEligible ? knownAnatomy : null,
          allowedAnatomies: knownAnatomy ? [knownAnatomy] : [...anatomyClasses],
          anatomySourceChoices: ['procedural-template', 'patient-donor'], donorChoice: 'model-required',
          morphologyEvidence: { identity: { fdi: site?.fdi ?? null, classConstraint: knownAnatomy, patientSideConfirmed: !!siteSource && siteSource.patientRight !== null },
            relationships: site?.relationships ?? null, space: site?.space ?? null,
            contralateralCandidate: donor ? { reference: donor, candidate: donorSource?.candidates?.find(candidate => candidate.id === donor.candidateId) ?? null } : null },
          provenance: 'Anatomical hypotheses only. Compare whole-arch sequence and contralateral evidence; width alone does not choose a class. The model chooses the source; the worker validates actual donor suitability without silently substituting another source.' };
      } }),
    requestDraftComponents: tool({ description: 'Queue a complete AI-authored design for reversible fixture, abutment and crown concepts at an evidence-supported site. Explicit anatomy, anatomySource, every component parameter and both contour scales are required; no hidden defaults or automatic fitting/optimization. Local workers construct and measure the exact design. A queued request is not an artifact, confirmed absence or clinical prescription. May be called directly using supplied evidence without prior tool dependencies.', inputSchema: requestInput,
      execute: input => { const parsed = requestInput.parse(input), evidence = evaluate(parsed.siteId);
        checkClinicalNumbers(parsed.rationale);
        if (!evidence.draftEligible) return { ...evidence, queued: false, reason: 'Only supported localized sites or locally eligible bounded neutral spaces with positive numerical space/height and no known chart conflict can be constructed.' };
        const site = evidence.site!;
        if (site.fdi !== null && toothClassOf(site.fdi) !== parsed.design.anatomy) return { queued: false, siteId: parsed.siteId, code: 'anatomy-mismatch', reason: 'Design anatomy must match the source site FDI tooth class, including when patient side is unknown.' };
        const previous = draftRequests.find(item => item.siteId === parsed.siteId);
        if (previous && JSON.stringify(previous.design) !== JSON.stringify(parsed.design)) return { queued: false, siteId: parsed.siteId, code: 'conflicting-duplicate', reason: 'A different design is already queued for this site. The conflicting duplicate was rejected; the queued design was retained.' };
        const source = request.sources.find(source => source.id === site.sourceId)!;
        const fdi = site.fdi ?? (source.arch === 'upper' ? 10 : 30) + neutralTemplateDigit[parsed.design.anatomy];
        if (!previous) {
          if (draftRequests.length >= WORKFLOW_BUDGET.sites) return { queued: false, reason: 'Draft site budget reached; retained previously queued sites.' };
          draftRequests.push({ siteId: parsed.siteId, fdi, anatomy: parsed.design.anatomy, rationale: parsed.rationale, design: parsed.design });
        }
        return { queued: true, siteId: parsed.siteId, siteFdi: site.fdi, templateFdi: fdi, design: parsed.design, idempotent: !!previous,
          operation: 'local-construct-measure', optimization: false, artifactStatus: 'pending-worker',
          units: 'file units (u)', provenance: 'hypothesized',
          measurementReview: { status: 'pending-worker', required: ['Every recorded target contact band and external crossing check', 'component-support.pilar-enclosure', 'Gum exposure and separate unknown clinical emergence'],
            next: 'Await actual worker artifacts and measurements. In an enabled restoration review use fresh getRestorationDesign evidence before an authorized bounded repair; do not revise by conflicting duplicate requests here or claim success from this queue.' },
          budget: { candidates: 1, constructionMs: WORKFLOW_BUDGET.fitMsPerSite }, clinicalState: 'draft hypothesis; unaccepted' };
      } }),
  };
  return { tools, draftRequests, regionReviews, siteReviews };
}

/** A malicious/accidental parallel tool burst cannot evade the request-wide budget. */
export function boundedPlanningTools<T extends ToolSet>(tools: T): T {
  let calls = 0;
  return Object.fromEntries(Object.entries(tools).map(([name, definition]) => [name, { ...definition, ...(definition.execute ? { execute: async (...args: Parameters<NonNullable<typeof definition.execute>>) => {
    if (++calls > WORKFLOW_BUDGET.toolCalls) return { status: 'budget-reached', reason: 'Tool-call budget reached. Use the evidence already returned and produce a partial result.' };
    return definition.execute!(...args);
  } } : {}) }])) as T;
}
