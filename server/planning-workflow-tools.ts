import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { CasePlanningRequest, PlanningExecutionEvidence } from '../src/case-planning-types.ts';
import { WORKFLOW_BUDGET } from '../src/case-workflow.ts';
import { toothClassOf } from '../src/crown-anatomy.ts';
import { checkClinicalNumbers } from '../src/case-planning-schema.ts';

/** Model-facing IDs resolve only to evidence in this request. Geometry never leaves the browser. */
export function createPlanningWorkflowTools(request: CasePlanningRequest) {
  const draftRequests: PlanningExecutionEvidence['draftRequests'] = [];
  const sites = request.preparation?.sites ?? [];
  const siteInput = z.strictObject({ siteId: z.string().min(1).max(160) });
  const requestInput = siteInput.extend({ rationale: z.string().min(1).max(600) });
  const evaluate = (siteId: string) => {
    const site = sites.find(site => site.id === siteId);
    const source = request.sources.find(source => source.id === site?.sourceId);
    const chart = request.snapshot.teeth.find(tooth => tooth.fdi === site?.fdi);
    const supported = !!site && !!source && source.roleConfirmed !== false && site.localized && site.fdi !== null && source.patientRight !== null
      && ['proposed-missing', 'dentist-confirmed-missing'].includes(site.status)
      && (site.status === 'dentist-confirmed-missing' || site.confidence >= (request.preparation?.threshold ?? .8))
      && chart?.status !== 'present' && chart?.status !== 'not-scanned' && !(chart?.assignedTriangles! > 0);
    return { status: site ? 'available' : 'unavailable', site: site ?? null, draftEligible: supported,
      limitations: ['A localized space is a geometric hypothesis, not confirmed absence or implant indication.', 'The client revalidates identity, source, pose and site dependencies before construction.'] };
  };
  const inspectInput = z.strictObject({});
  const tools = {
    inspectPreparedCase: tool({ description: 'Inspect local preparation quality, candidate counts, unresolved coverage and available localized site evidence. This reads completed browser worker results; it does not segment or upload raw meshes.', inputSchema: inspectInput,
      execute: input => { inspectInput.parse(input); return { revision: request.revision, preparation: request.preparation ?? null, units: 'file units (u)', missingEvidence: { patientSide: request.sources.some(source => source.patientRight === null), physicalUnits: true, motion: true, bone: true } }; } }),
    evaluateMissingSite: tool({ description: 'Inspect one local missing-space hypothesis and its conflicting evidence. Never interprets segmentation failure or unscanned coverage as absence.', inputSchema: siteInput,
      execute: input => evaluate(siteInput.parse(input).siteId) }),
    chooseAnatomicalCandidate: tool({ description: 'Choose a supported tooth class for a localized draft site. The local worker prefers a suitable patient contralateral donor and records a procedural fallback when donor evidence is inadequate.', inputSchema: siteInput,
      execute: input => { const evidence = evaluate(siteInput.parse(input).siteId); return { ...evidence, anatomy: evidence.draftEligible ? toothClassOf(evidence.site!.fdi!) : null, donorChoice: 'local-worker-evidence-gated', provenance: 'anatomical hypothesis; donor identity is checked locally' }; } }),
    requestDraftComponents: tool({ description: 'Queue reversible fixture, abutment and anatomical crown concepts plus bounded local fitting for an evidence-supported site. This queues a browser worker command; it does not confirm missing status, accept clinical treatment or claim that artifacts already exist.', inputSchema: requestInput,
      execute: input => { const parsed = requestInput.parse(input), evidence = evaluate(parsed.siteId);
        checkClinicalNumbers(parsed.rationale);
        if (!evidence.draftEligible) return { ...evidence, queued: false, reason: 'Only supported localized sites with established identity can be constructed.' };
        if (!draftRequests.some(item => item.siteId === parsed.siteId)) {
          if (draftRequests.length >= WORKFLOW_BUDGET.sites) return { queued: false, reason: 'Draft site budget reached; retained previously queued sites.' };
          draftRequests.push({ siteId: parsed.siteId, fdi: evidence.site!.fdi!, anatomy: toothClassOf(evidence.site!.fdi!), rationale: parsed.rationale });
        }
        return { queued: true, siteId: parsed.siteId, operation: 'local-generate-fit-measure-select', budget: { candidates: WORKFLOW_BUDGET.candidatesPerSite, fittingMs: WORKFLOW_BUDGET.fitMsPerSite }, clinicalState: 'draft hypothesis; unaccepted' };
      } }),
  };
  return { tools, draftRequests };
}

/** A malicious/accidental parallel tool burst cannot evade the request-wide budget. */
export function boundedPlanningTools<T extends ToolSet>(tools: T): T {
  let calls = 0;
  return Object.fromEntries(Object.entries(tools).map(([name, definition]) => [name, { ...definition, ...(definition.execute ? { execute: async (...args: Parameters<NonNullable<typeof definition.execute>>) => {
    if (++calls > WORKFLOW_BUDGET.toolCalls) return { status: 'budget-reached', reason: 'Tool-call budget reached. Use the evidence already returned and produce a partial result.' };
    return definition.execute!(...args);
  } } : {}) }])) as T;
}
