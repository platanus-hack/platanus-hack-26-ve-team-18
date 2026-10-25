import { z } from 'zod';
import { isFdiTooth } from './teeth.ts';

const sourceId = z.string().regex(/^scan-(?:[1-9]|[1-5]\d|6[0-4])$/);
const evidence = z.array(z.string().min(1).max(160)).min(1).max(12);
export const planningRegionReviewSchema = z.strictObject({
  sourceId, candidateId: z.number().int().min(0).max(10_000_000),
  classification: z.enum(['tooth', 'mixed', 'non-tooth', 'unresolved']),
  decision: z.enum(['use', 'needs-boundary-review', 'exclude']).describe('Use a geometrically supported tooth region even when identity is uncertain (fdi:null). Reserve needs-boundary-review for observed mixed, merged, partial or incorrect surface boundaries; uncertain numbering alone is not a boundary defect.'),
  fdi: z.number().int().refine(isFdiTooth).nullable().describe('Supported identity hypothesis or null. Unknown identity does not by itself make the crown geometry unusable.'),
  rationale: z.string().trim().min(1).max(600), evidence: evidence.describe('Exact source-specific arch view IDs or this candidate reference, such as view-1 or scan-1:C1. Use only supplied handles.'),
});
export type PlanningRegionReview = z.infer<typeof planningRegionReviewSchema>;
export const planningSiteReviewSchema = z.strictObject({
  siteId: z.string().min(1).max(160), decision: z.enum(['design', 'defer', 'exclude']),
  rationale: z.string().trim().min(1).max(600), evidence: evidence.describe('Include this prepared siteId or a source-specific arch view from evidenceReferences.siteDecisions. Known adjacent candidate references attached to this exact site may supplement that context; candidate-only, unrelated, cross-source, chart or invented references are invalid.'),
  missingEvidence: z.array(z.string().max(300)).max(12),
});
export type PlanningSiteReview = z.infer<typeof planningSiteReviewSchema>;
