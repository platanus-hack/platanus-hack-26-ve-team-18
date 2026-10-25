import type { CasePreparationResult } from './case-preparation-types';
import type { CasePlanningResult } from './case-planning-types';
import type { ModelPart } from './models';
import type { SiteHypothesis } from './missing-sites';
import type { ToothCase } from './tooth-types';
import { draftToothCase, reconcileIdentities, type IdentityDecisions, type IdentityRegions } from './draft-workflow.ts';
import { applyAIRegionReviews } from './planning-regions.ts';
import { toothCounts } from './teeth.ts';

/** An identity correction cannot clear segmentation, coverage or other structural blocks. */
export function applySiteDecisions(sites: SiteHypothesis[], decisions: Record<string, number | null>): SiteHypothesis[] {
  return sites.map(site => {
    if (!Object.hasOwn(decisions, site.id)) return site;
    const fdi = decisions[site.id];
    return { ...site, fdi, draftIdentity: undefined,
      status: ['proposed-missing', 'identity-unresolved', 'dentist-confirmed-missing'].includes(site.status)
        ? fdi === null ? 'identity-unresolved' : 'proposed-missing' : site.status };
  });
}

/** Incoming assessments can precede React state; derive all eligibility inputs from that result. */
export function projectPlanningAssessment({ prepared, result, parts, reviewed, confidenceThreshold, identityDecisions, identityRegions, siteDecisions }: {
  prepared: CasePreparationResult; result: CasePlanningResult; parts: ModelPart[]; reviewed: ToothCase;
  confidenceThreshold: number; identityDecisions: IdentityDecisions; identityRegions: IdentityRegions;
  siteDecisions: Record<string, number | null>;
}) {
  const fresh = applyAIRegionReviews(prepared, result, parts, reviewed)!;
  const identities = reconcileIdentities(fresh, result, parts, confidenceThreshold, identityDecisions, identityRegions);
  const teeth = draftToothCase(reviewed, parts, fresh, identities, identityDecisions, identityRegions);
  return { prepared: fresh, identities, teeth, counts: toothCounts(teeth.labels), sites: applySiteDecisions(fresh.sites, siteDecisions) };
}
