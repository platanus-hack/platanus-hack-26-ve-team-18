import { z } from 'zod';

const finite = z.number().finite(), positive = finite.positive(), nonnegative = finite.nonnegative();
const text = z.string().max(4000), strings = z.array(text).max(128);
const side = z.enum(['mesial', 'distal']), provenance = z.enum(['measured', 'hypothesized']);
const evidence = z.strictObject({ value: positive, method: text, provenance });
export const restorationPlacementFeedbackSchema = z.strictObject({
  provenance: z.enum(['unconfirmed-case-feedback', 'clinician-entered-case-feedback']), source: z.string().min(1).max(4000),
  subcrestalDepthMm: nonnegative.nullable(), adjacentToothClearanceMm: nonnegative.nullable(),
});
export const restorationQualityContextSchema = z.strictObject({
  version: z.literal('restoration-quality-context/v1'), units: z.literal('file units (u)'),
  neighbors: z.array(z.strictObject({ id: z.string().min(1).max(200), side: side.optional(), mesiodistal: positive.nullable(), buccolingual: positive.nullable(), height: positive.nullable(), method: text, provenance })).max(16),
  gapWidth: evidence.nullable(), availableHeight: evidence.nullable(), expectedProximalSides: z.array(side).max(2).optional(), bitePoseVerified: z.boolean().optional(),
  placementFeedback: restorationPlacementFeedbackSchema.optional(),
});
const rule = z.enum(['relative-width', 'relative-depth', 'relative-height', 'space-occupancy', 'proximal-contacts', 'occlusal-contact', 'interference', 'conflicting-targets', 'anatomy', 'component-presentation']);
const status = z.enum(['pass', 'fail', 'unknown']);
const ratio = z.tuple([positive, positive]);
const component = z.enum(['fixture', 'abutment', 'crown']);
const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
const extents = z.strictObject({ mesiodistal: nonnegative, buccolingual: nonnegative, occlusal: nonnegative, base: finite, top: finite })
  .refine(value => value.top >= value.base && near(value.occlusal, value.top - value.base), 'Extents must agree with their measured base and top.');
const guardrailId = z.enum(['anatomy', 'dimensions', 'cervical-emergence', 'surface-integrity', 'shade', 'subcrestal-placement', 'adjacent-root-clearance']);
const unsupportedClinicalFields = {
  anatomy: ['toothIdentityReviewed', 'demonstratedCuspCount'], dimensions: ['verifiedMmPerUnit'],
  'cervical-emergence': ['clinicalEmergenceAngleDegrees', 'tissueCompression'], 'surface-integrity': ['physicalSurfaceFinish'],
  shade: ['measuredShade', 'shadeMatch'],
  'subcrestal-placement': ['measuredSubcrestalDepthMm', 'verifiedMmPerUnit', 'reviewedBoneCrest'],
  'adjacent-root-clearance': ['measuredFixtureToRootClearanceMm', 'measuredFixtureToAdjacentToothClearanceMm', 'reviewedNeighborRoots', 'verifiedMmPerUnit'],
} as const;
/** Separate versioned extension; v1 reports without guardrails remain readable. */
export const restorationGuardrailsSchema = z.strictObject({
  version: z.literal('restoration-guardrails/v1'), status: z.enum(['fail', 'unknown']), units: z.literal('file units (u)'),
  componentExtents: z.array(z.strictObject({ component, extents: extents.nullable() })).length(3),
  issues: z.array(z.strictObject({
    id: guardrailId, components: z.array(component).min(1).max(3), status: z.enum(['fail', 'unknown']), summary: text,
    actual: z.record(z.string().max(100), z.union([text, finite, z.boolean(), z.null()])),
    target: z.strictObject({ description: text, value: finite.nullable(), units: z.enum(['file units (u)', 'mm', 'not-established']), provenance: z.enum(['engineering-prototype', 'unconfirmed-case-feedback', 'clinician-entered-case-feedback', 'not-established']) }),
    missingEvidence: strings,
    suggestions: z.array(z.strictObject({ component, kind: z.enum(['parameter', 'anatomy', 'appearance', 'inspect', 'collect-evidence']), parameters: z.array(z.string().max(100)).max(16), action: text, automatic: z.literal(false) })).max(16),
  })).length(7), limits: strings,
}).refine(value => new Set(value.componentExtents.map(item => item.component)).size === 3
  && new Set(value.issues.map(item => item.id)).size === 7
  && value.status === (value.issues.some(item => item.status === 'fail') ? 'fail' : 'unknown')
  && value.issues.filter(item => ['shade', 'subcrestal-placement', 'adjacent-root-clearance'].includes(item.id)).every(item => item.status === 'unknown'),
  'Guardrails must retain independent checks and unassessed clinical evidence.')
  .superRefine((value, ctx) => {
    for (const [index, issue] of value.issues.entries()) {
      for (const key of unsupportedClinicalFields[issue.id]) if (issue.actual[key] !== null) ctx.addIssue({ code: 'custom', path: ['issues', index, 'actual', key], message: 'This v1 evaluator does not measure or verify this clinical field; it must remain null.' });
      if (issue.id === 'surface-integrity' && (issue.actual.selfIntersection !== 'untested' || issue.actual.cervicalContinuity !== 'unassessed')) ctx.addIssue({ code: 'custom', path: ['issues', index, 'actual'], message: 'Self-intersection and cervical continuity are not evaluated by v1.' });
      const placement = issue.id === 'subcrestal-placement' || issue.id === 'adjacent-root-clearance';
      if (placement && (issue.target.units !== 'mm' || issue.target.value !== null && (issue.target.value < 0 || !['unconfirmed-case-feedback', 'clinician-entered-case-feedback'].includes(issue.target.provenance)))) ctx.addIssue({ code: 'custom', path: ['issues', index, 'target'], message: 'A placement value must be nonnegative millimetre case feedback; it is never an engineering default.' });
      if (!placement && (issue.target.value !== null || issue.target.provenance !== 'not-established' || issue.target.units !== 'not-established')) ctx.addIssue({ code: 'custom', path: ['issues', index, 'target'], message: 'V1 supplies no clinical acceptance target for this domain.' });
    }
    const dimensions = value.issues.find(issue => issue.id === 'dimensions');
    for (const item of value.componentExtents) for (const key of ['mesiodistal', 'buccolingual', 'occlusal', 'base', 'top'] as const) {
      const expected = item.extents?.[key] ?? null, actual = dimensions?.actual[`${item.component}.${key}`];
      if (expected === null ? actual !== null : typeof actual !== 'number' || !near(actual, expected)) ctx.addIssue({ code: 'custom', path: ['componentExtents'], message: 'Actual dimension evidence must agree with emitted component extents.' });
    }
  });
export const restorationQualitySchema = z.strictObject({
  version: z.literal('restoration-quality/v1'), status, units: z.literal('file units (u)'),
  tolerances: z.strictObject({ widthToNeighbor: ratio, depthToNeighbor: ratio, heightToNeighbor: ratio, gapOccupancy: ratio, heightOccupancyMax: positive, proximalOpenFraction: positive, occlusalOpenFraction: positive, minOcclusalCoverage: nonnegative.max(1), maxAnisotropy: positive, maxProportionSkew: positive, maxAbutmentAngle: positive, maxRevisionStep: positive, maxRevisionAngle: positive, maxRevisions: z.number().int().min(0).max(32) }),
  crownExtents: extents.nullable(),
  criteria: z.array(z.strictObject({ id: rule, status, reasons: strings, measured: z.record(z.string().max(100), finite.nullable()) })).length(10),
  revisions: z.array(z.strictObject({ parameter: z.enum(['crown.width', 'crown.depth', 'crown.height', 'abutment.height', 'abutment.radius', 'abutment.emergenceRadius', 'abutment.angleX', 'abutment.angleY', 'fixture.radius']), current: finite, proposed: finite, rules: z.array(rule).max(10), reason: text })).max(32),
  unresolvedRevisionConflicts: strings, limits: strings, guardrails: restorationGuardrailsSchema.optional(),
}).refine(value => new Set(value.criteria.map(item => item.id)).size === 10
  && value.status === (value.criteria.some(item => item.status === 'fail') ? 'fail' : value.criteria.every(item => item.status === 'pass') ? 'pass' : 'unknown'), 'Quality status must reflect all independent criteria.');
