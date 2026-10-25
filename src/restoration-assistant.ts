import { tool, type ToolExecutionOptions } from 'ai';
import { z } from 'zod';
import type { RestorationAssembly } from './restoration-types.ts';
import { restorationEditSchema, restorationEditRevision, type RestorationEdit } from './restoration-edit.ts';
import { restorationQualitySchema, restorationGuardrailsSchema } from './restoration-quality-schema.ts';
import { restorationAppearance } from './restoration-appearance.ts';
import { compareRestorationFeedback, restorationFeedbackChangeSchema, restorationFeedbackRows, restorationFeedbackRowSchema, restorationFeedbackTargetId } from './restoration-feedback.ts';
import { RestorationEditRejected } from './restoration-edit-policy.ts';
import type { RestorationRelationshipsReport } from './restoration-relationships.ts';
import type { RestorationGoalReport, RestorationGoalRow, RestorationGoalSnapshot } from './restoration-goals.ts';

export const MAX_ASSISTANT_EDITS = 8;
export const MAX_MEASUREMENT_FOLLOW_UP_EDITS = 4;
const finite = z.number().finite(), positive = finite.positive();
const component = z.enum(['fixture', 'abutment', 'crown']);
const id = z.string().regex(/^restoration-(?:[1-9]|[1-5]\d|6[0-4])$/);
const revision = z.string().regex(/^revision-[a-f0-9]{16}$/);
const material = z.strictObject({ color: z.string().regex(/^#[a-fA-F0-9]{6}$/).nullable(), roughness: finite.min(0).max(1).nullable() });
const parameters = z.strictObject({
  fixture: z.strictObject({ radius: positive, length: positive, depth: finite.nonnegative(), taper: finite.min(0).max(.95) }),
  abutment: z.strictObject({ radius: positive, height: positive, emergenceRadius: positive, angleX: finite.min(-80).max(80), angleY: finite.min(-80).max(80) }),
  crown: z.strictObject({ width: positive, depth: positive, height: positive, cuspHeight: finite.nonnegative(), rotation: finite.min(-360).max(360) }),
});
const quality = restorationQualitySchema.shape;
const criterion = quality.criteria.element;
const proposal = quality.revisions.element;
const feedbackRows = z.array(restorationFeedbackRowSchema).max(128);
const feedbackChanges = z.array(restorationFeedbackChangeSchema).max(256);
const failureFeedback = z.array(z.string().max(1000)).max(128);
const count = finite.int().nonnegative(), distance = finite.nonnegative().nullable();
const relationshipAlias = z.string().regex(/^relationship-[a-f0-9]{16}$/);
const measuredStatus = z.enum(['measured', 'unknown']);
const relationship = z.strictObject({
  alias: relationshipAlias, source: z.enum(['fixture', 'abutment']), target: z.enum(['abutment', 'crown', 'adjacent']),
  targetAlias: z.string().regex(/^target-[a-f0-9]{16}$/).nullable(), side: z.enum(['mesial', 'distal']).nullable(), status: measuredStatus,
  sourceTriangles: count.nullable(), targetTriangles: count.nullable(), samples: count,
  sampledMinDistance: distance, sampledMedianDistance: distance, sampledP95Distance: distance,
  intersectionComplete: z.boolean(), intersectingTriangles: count.nullable(), transverseCrossingTriangles: count.nullable(), touchingOrAmbiguousTriangles: count.nullable(),
  intersectionTestedTriangles: count, intersectionPairTests: count, intersectionTolerance: distance,
  surfaceEvidence: z.enum(['unknown', 'none-observed', 'touching-or-ambiguous', 'transverse-crossing']),
}).refine(value => value.status === 'measured'
  ? value.samples > 0 && value.sampledMinDistance !== null && value.sampledMedianDistance !== null && value.sampledP95Distance !== null
    && value.sampledMinDistance <= value.sampledMedianDistance && value.sampledMedianDistance <= value.sampledP95Distance
  : value.samples === 0 && value.sampledMinDistance === null && value.sampledMedianDistance === null && value.sampledP95Distance === null,
  'Sample statistics require a completed measurement set.')
  .refine(value => value.surfaceEvidence === ((value.transverseCrossingTriangles ?? 0) > 0 ? 'transverse-crossing'
    : (value.touchingOrAmbiguousTriangles ?? 0) > 0 ? 'touching-or-ambiguous'
      : value.intersectionComplete && value.intersectingTriangles === 0 && value.transverseCrossingTriangles === 0 && value.touchingOrAmbiguousTriangles === 0 ? 'none-observed' : 'unknown'),
  'Surface evidence must agree with intersection measurements.')
  .refine(value => value.samples <= (value.sourceTriangles ?? 0) && value.intersectionTestedTriangles <= (value.targetTriangles ?? 0)
    && (!value.intersectionComplete || value.targetTriangles !== null && value.intersectionTestedTriangles === value.targetTriangles)
    && (value.transverseCrossingTriangles ?? 0) <= (value.intersectingTriangles ?? 0)
    && (value.touchingOrAmbiguousTriangles ?? 0) <= (value.intersectingTriangles ?? 0)
    && (value.intersectingTriangles ?? 0) <= (value.transverseCrossingTriangles ?? 0) + (value.touchingOrAmbiguousTriangles ?? 0),
  'Relationship counts must account for complete targets and agree with the supplied mesh sizes.');
const axialInterface = z.strictObject({
  kind: z.enum(['fixture-platform', 'crown-base']), source: z.enum(['fixture', 'abutment']), target: z.enum(['abutment', 'crown']), status: measuredStatus,
  sourceAxialOffset: finite.nullable(), targetAxialOffset: finite.nullable(), signedAxialGap: finite.nullable(),
  sourceDistanceToNominalOrigin: distance, targetDistanceToNominalOrigin: distance,
}).refine(value => {
  const values = [value.sourceAxialOffset, value.targetAxialOffset, value.signedAxialGap, value.sourceDistanceToNominalOrigin, value.targetDistanceToNominalOrigin];
  if (value.status === 'unknown') return values.every(number => number === null);
  if (values.some(number => number === null)) return false;
  return Math.abs(value.signedAxialGap! - (value.targetAxialOffset! - value.sourceAxialOffset!))
    <= 1e-12 * Math.max(Number.MIN_VALUE, Math.abs(value.sourceAxialOffset!), Math.abs(value.targetAxialOffset!));
}, 'Measured interface values must be finite and the signed gap must agree with the axial offsets; unknown values remain null.');
export const restorationAssistantRelationshipsSchema = z.strictObject({
  units: z.literal('file units (u)'), termination: z.enum(['complete', 'time-budget']), relationships: z.array(relationship).max(259), interfaces: z.array(axialInterface).max(2),
  limits: z.array(z.string().max(1000)).max(8),
});
type AssistantRelationships = z.infer<typeof restorationAssistantRelationshipsSchema>;

/** Explicit numerical projection: never source IDs, reasons, nominal positions or report text. */
export function projectRestorationRelationships(report?: RestorationRelationshipsReport | null): AssistantRelationships | null {
  if (!report) return null;
  return restorationAssistantRelationshipsSchema.parse({ units: report.units, termination: report.termination,
    relationships: report.relationships.map(row => ({ alias: restorationFeedbackTargetId(row.id).replace('target-', 'relationship-'), source: row.source, target: row.target,
      targetAlias: row.target === 'adjacent' ? restorationFeedbackTargetId(row.targetId) : null, side: row.side ?? null, status: row.status,
      sourceTriangles: row.sourceTriangles, targetTriangles: row.targetTriangles, samples: row.samples,
      sampledMinDistance: row.sampledMinDistance, sampledMedianDistance: row.sampledMedianDistance, sampledP95Distance: row.sampledP95Distance,
      intersectionComplete: row.intersectionComplete, intersectingTriangles: row.intersectingTriangles, transverseCrossingTriangles: row.transverseCrossingTriangles,
      touchingOrAmbiguousTriangles: row.touchingOrAmbiguousTriangles, intersectionTestedTriangles: row.intersectionTestedTriangles,
      intersectionPairTests: row.intersectionPairTests, intersectionTolerance: row.intersectionTolerance, surfaceEvidence: row.surfaceEvidence })),
    interfaces: report.interfaces.map(row => ({ kind: row.id, source: row.source, target: row.target, status: row.status,
      sourceAxialOffset: row.sourceAxialOffset, targetAxialOffset: row.targetAxialOffset, signedAxialGap: row.signedAxialGap,
      sourceDistanceToNominalOrigin: row.sourceDistanceToNominalOrigin, targetDistanceToNominalOrigin: row.targetDistanceToNominalOrigin })),
    limits: ['Distance samples are source-to-target triangle barycentres in file units, not exact minimum clearance, contact area or volume.',
      'No acceptance target is defined for these distances. Adjacent crown/tooth surfaces are not reviewed roots; fixture distances do not establish millimetre root clearance.',
      'Signed axial gaps compare extrema along the construction axis. They do not establish lateral overlap, manufactured connection fit or clinical seating.',
      'Unknown distance sets and incomplete intersection tests remain unknown. Zero observed crossings does not establish clearance.'],
  });
}

const relationshipChangesSchema = z.strictObject({
  relationships: z.array(z.strictObject({ alias: relationshipAlias, before: relationship.nullable(), after: relationship.nullable(),
    minDistanceDelta: finite.nullable(), medianDistanceDelta: finite.nullable(), p95DistanceDelta: finite.nullable(), transverseCrossingsDelta: finite.nullable() })).max(518),
  interfaces: z.array(z.strictObject({ kind: axialInterface.shape.kind, before: axialInterface.nullable(), after: axialInterface.nullable(), signedAxialGapDelta: finite.nullable() })).max(2),
});
export function compareRestorationRelationships(before?: AssistantRelationships | null, after?: AssistantRelationships | null): z.infer<typeof relationshipChangesSchema> {
  const delta = (a: number | null | undefined, b: number | null | undefined) => a == null || b == null ? null : b - a;
  return { relationships: [...new Set([...(before?.relationships ?? []).map(row => row.alias), ...(after?.relationships ?? []).map(row => row.alias)])].map(alias => {
    const a = before?.relationships.find(row => row.alias === alias) ?? null, b = after?.relationships.find(row => row.alias === alias) ?? null;
    return { alias, before: a, after: b, minDistanceDelta: delta(a?.sampledMinDistance, b?.sampledMinDistance),
      medianDistanceDelta: delta(a?.sampledMedianDistance, b?.sampledMedianDistance), p95DistanceDelta: delta(a?.sampledP95Distance, b?.sampledP95Distance),
      transverseCrossingsDelta: delta(a?.transverseCrossingTriangles, b?.transverseCrossingTriangles) };
  }), interfaces: [...new Set([...(before?.interfaces ?? []).map(row => row.kind), ...(after?.interfaces ?? []).map(row => row.kind)])].map(kind => {
    const a = before?.interfaces.find(row => row.kind === kind) ?? null, b = after?.interfaces.find(row => row.kind === kind) ?? null;
    return { kind, before: a, after: b, signedAxialGapDelta: delta(a?.signedAxialGap, b?.signedAxialGap) };
  }) };
}

const goalLabels = {
  'relative-width': 'Crown mesiodistal extent vs neighbour mean',
  'relative-depth': 'Crown buccolingual extent vs neighbour mean',
  'relative-height': 'Crown top above site vs neighbour mean height',
  'space-occupancy.mesiodistal': 'Crown width vs measured gap envelope',
  'space-occupancy.vertical': 'Crown top vs measured vertical headroom',
  'anatomy.donor-anisotropy': 'Donor axis-scale anisotropy',
  'anatomy.proportion-skew': 'Crown MD/BL proportion vs neighbours',
  'component-presentation.abutment-slope': 'Generic abutment slope',
  'component-presentation.pilar-protrusion': 'Emitted pilar protrusion beyond crown collar',
  'component-support.pilar-enclosure': 'Pilar support vertices outside crown',
  'component-presentation.abutment-radius': 'Abutment radius vs crown half-footprint',
  'component-presentation.emergence-radius': 'Emergence radius vs crown half-footprint',
  'component-presentation.fixture-radius': 'Fixture radius vs crown half-footprint',
  'component-presentation.fixture-diameter': 'Fixture diameter vs gap envelope',
  'guardrail.subcrestal-placement': 'Implant platform depth below reviewed bone crest',
  'guardrail.adjacent-root-clearance': 'Implant outer surface clearance to each adjacent root',
  'missing-adjacent': 'Neighbour contact evidence',
  'missing-antagonist': 'Opposing-tooth contact evidence',
  'fixture-gingiva': 'Fixture elevation above sampled gum envelope',
  'abutment-gingiva': 'Pilar samples above gum without crown support',
  'pilar-emergence': 'Pilar emergence through the gingival boundary',
} as const;
const targetGoalId = /^target-[a-f0-9]{16}\.(adjacent|antagonist|tissue|other-tooth|source-arch)\.(mesial|distal|unsided)\.(crossings|proximal-gap|occlusal-coverage|occlusal-gap)$/;
const goalMetricLabels: Record<string, string> = { crossings: 'transverse crossing triangles', 'proximal-gap': 'sampled proximal distance',
  'occlusal-coverage': 'forward occlusal ray hit fraction', 'occlusal-gap': 'sampled forward occlusal gap' };
const goalStatus = z.enum(['satisfied', 'unmet', 'unknown']);
const goalRow = z.strictObject({
  id: z.string().max(140).refine(value => Object.hasOwn(goalLabels, value) || targetGoalId.test(value) || /^requirement-[a-f0-9]{16}$/.test(value)),
  label: z.string().max(200), priority: z.enum(['required', 'preference', 'clinical']),
  actual: finite.nullable(), lower: finite.nullable(), upper: finite.nullable(), error: finite.nullable(),
  exclusiveUpper: z.boolean().default(false),
  units: restorationFeedbackRowSchema.shape.units, status: restorationFeedbackRowSchema.shape.status, reason: z.string().max(1000),
});
const goalSnapshot = z.strictObject({ status: goalStatus, rows: z.array(goalRow).max(128), requiredError: finite.nonnegative(), preferenceError: finite.nonnegative() });
const bound = z.tuple([finite, finite]).optional();
const goalBounds = z.strictObject({ 'crown.width': bound, 'crown.depth': bound, 'crown.height': bound, 'abutment.height': bound,
  'abutment.angleY': bound, 'abutment.angleX': bound, 'abutment.radius': bound, 'abutment.emergenceRadius': bound,
  'fixture.depth': bound, cervicalScale: bound });
/** Deliberately separate from the local goal schema: revisions, target maps and future metadata stay local. */
export const restorationAssistantGoalSchema = z.strictObject({
  version: z.literal('restoration-goal/v1'), status: goalStatus,
  termination: z.enum(['satisfied', 'needs-evidence', 'candidate-budget', 'time-budget', 'stalled', 'measurement-only']),
  before: goalSnapshot, after: goalSnapshot, selectedAttempt: count.max(16),
  attempts: z.array(z.strictObject({ attempt: count.max(16), accepted: z.boolean(), status: goalStatus,
    requiredError: finite.nonnegative(), preferenceError: finite.nonnegative() })).min(1).max(17),
  durationMs: finite.nonnegative(), maxAttempts: count.min(1).max(17), bounds: goalBounds,
  limits: z.array(z.string().max(1000)).max(8),
});

/** Fixed language and explicitly selected numeric fields, including in nested attempt history. */
export function projectRestorationGoal(report?: RestorationGoalReport | null): z.infer<typeof restorationAssistantGoalSchema> | null {
  if (!report) return null;
  const row = (item: RestorationGoalRow) => {
    const known = Object.hasOwn(goalLabels, item.id), target = item.id.match(targetGoalId);
    return { id: known || target ? item.id : restorationFeedbackTargetId(item.id).replace('target-', 'requirement-'),
      label: known ? goalLabels[item.id as keyof typeof goalLabels] : target ? `${target[1]} (${target[2]}): ${goalMetricLabels[target[3]]}` : 'Additional requirement',
      priority: item.priority, actual: item.actual, lower: item.lower, upper: item.upper, exclusiveUpper: item.exclusiveUpper ?? false, error: item.error, units: item.units, status: item.status,
      reason: item.status === 'unknown' ? 'Evidence is incomplete or unverified. Resolve the missing measurement or review before claiming this requirement is met.'
        : item.status === 'fail' ? 'This measured bound is unmet. Review the current numeric feedback controls, make a problem-directed edit and remeasure every required target.'
          : 'Within this measured check only. This does not establish clinical acceptance.' };
  };
  const snapshot = (item: RestorationGoalSnapshot) => ({ status: item.status, rows: item.rows.map(row), requiredError: item.requiredError, preferenceError: item.preferenceError });
  return restorationAssistantGoalSchema.parse({ version: report.version, status: report.status, termination: report.termination,
    before: snapshot(report.before), after: snapshot(report.after), selectedAttempt: report.selectedAttempt,
    attempts: report.attempts.map(item => ({ attempt: item.attempt, accepted: item.accepted, status: item.snapshot.status,
      requiredError: item.snapshot.requiredError, preferenceError: item.snapshot.preferenceError })),
    durationMs: report.durationMs, maxAttempts: report.maxAttempts,
    bounds: Object.fromEntries(Object.keys(goalBounds.shape).filter(key => Object.hasOwn(report.bounds, key)).map(key => [key, report.bounds[key]])),
    limits: ['Required contacts and no-crossing checks are assessed per target. Shape preferences cannot compensate for failed required checks.',
      'Unknown clinical evidence remains unresolved, including pilar emergence. Verified scale, registration, reviewed bone crest and each adjacent root are needed for clinical placement measurements.',
      'Search bounds stay fixed across attempts. An accepted attempt, lower error, unchanged model or generated geometry does not establish that requirements are met.',
      'Gaps and gum-envelope checks are sampled file-unit evidence, not exact contact area, overlap volume or clinical fit. Millimetre targets remain separate.'],
  });
}

/** Explicitly projected transport fields: no names, source IDs, raw meshes or donor metadata. */
export const restorationDesignSchema = z.strictObject({
  id, editRevision: revision, stale: z.boolean(), parameters,
  componentDesign: z.enum(['legacy', 'nested-support/v1']).default('legacy'),
  site: z.strictObject({ identity: z.enum(['recorded-fdi', 'unreviewed-draft']),
    fdi: z.number().int().refine(value => /^[1-4][1-8]$/.test(String(value))).nullable(),
    templateFdi: z.number().int().refine(value => /^[1-4][1-8]$/.test(String(value))).nullable(),
  }).optional(),
  anatomy: z.enum(['incisor', 'canine', 'premolar', 'molar']),
  contour: z.strictObject({ cervicalScale: positive, occlusalScale: positive }),
  appearance: z.strictObject({ fixture: material, abutment: material, crown: material }),
  meshes: z.array(z.strictObject({ component, dimensions: z.tuple([finite.nonnegative().nullable(), finite.nonnegative().nullable(), finite.nonnegative().nullable()]), closed: z.boolean(), triangles: z.number().int().nonnegative() })).max(3),
  relationships: restorationAssistantRelationshipsSchema.nullable().default(null),
  goal: restorationAssistantGoalSchema.nullable().default(null),
  quality: z.strictObject({ status: z.enum(['pass', 'fail', 'unknown']), crownExtents: quality.crownExtents,
    criteria: z.array(criterion).max(32), proposedLocalRevisions: z.array(proposal).max(32), guardrails: restorationGuardrailsSchema.nullable(),
    feedbackRows: feedbackRows.default([]), failureFeedback: failureFeedback.default([]),
    unassessed: z.array(z.string().max(100)).max(40) }),
});
export const restorationAssistantSnapshotSchema = z.strictObject({
  version: z.literal(1), units: z.literal('file units'), selectedAssemblyId: id.nullable().default(null), assemblies: z.array(restorationDesignSchema).max(64),
}).superRefine((value, ctx) => {
  if (value.assemblies.some((item, index) => item.id !== `restoration-${index + 1}`)) ctx.addIssue({ code: 'custom', message: 'Use sequential anonymous restoration identifiers.' });
  if (value.selectedAssemblyId && !value.assemblies.some(item => item.id === value.selectedAssemblyId)) ctx.addIssue({ code: 'custom', message: 'Selected restoration must belong to this inventory.' });
});
export type RestorationAssistantSnapshot = z.infer<typeof restorationAssistantSnapshotSchema>;
export type RestorationDesign = z.infer<typeof restorationDesignSchema>;

/** Opaque transport revision; the host retains the engine's full local revision. */
export function assistantRestorationRevision(assembly: RestorationAssembly): string {
  const value = restorationEditRevision(assembly);
  let a = 2166136261, b = 3335557771;
  for (let i = 0; i < value.length; i++) { a = Math.imul(a ^ value.charCodeAt(i), 16777619); b = Math.imul(b ^ value.charCodeAt(i), 2246822519); }
  return `revision-${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}

export function buildRestorationAssistantSnapshot(assemblies: readonly RestorationAssembly[], selectedId?: string | null): RestorationAssistantSnapshot {
  if (assemblies.length > 64) throw new Error('The assistant supports at most 64 restoration assemblies.');
  const selectedIndex = assemblies.findIndex(item => item.id === selectedId);
  return restorationAssistantSnapshotSchema.parse({ version: 1, units: 'file units', selectedAssemblyId: selectedIndex < 0 ? null : `restoration-${selectedIndex + 1}`, assemblies: assemblies.map((assembly, index) => {
    const spec = assembly.spec, report = assembly.fit?.quality?.final;
    const identifiers = [assembly.id, spec.parentPartId, spec.source, spec.crownShape?.source.donorPartId, spec.crownShape?.source.provenance,
      ...(assembly.fit?.after?.surfaces.flatMap(surface => [surface.id, surface.targetProvenance]) ?? []),
      ...(assembly.fit?.before?.surfaces.flatMap(surface => [surface.id, surface.targetProvenance]) ?? []),
      spec.qualityContext?.placementFeedback?.source, ...(spec.qualityContext?.neighbors.map(item => item.id) ?? []),
      ...assembly.parts.flatMap(part => [part.id, part.name, part.fileName, part.sourceFileId, part.texture?.fileName])]
      .filter((value): value is string => Boolean(value)).sort((a, b) => b.length - a.length);
    const redact = (value: string) => identifiers.reduce((text, identifier) => text.split(identifier).join('[redacted]'), value).slice(0, 4000);
    const rows = restorationFeedbackRows(report, spec.parameters, assembly.fit?.after, spec.qualityContext);
    const failures = [
      ...rows.filter(row => row.status === 'fail').map(row => `${row.label}: ${row.feedback}`),
      ...(report?.criteria.filter(item => item.status === 'fail').flatMap(item => item.reasons.map(reason => `${item.id}: ${redact(reason)} Review this criterion and remeasure after the next edit.`)) ?? []),
    ].map(value => value.slice(0, 1000)).slice(0, 128);
    const guardrails = report?.guardrails ? restorationGuardrailsSchema.parse({ ...report.guardrails,
      issues: report.guardrails.issues.map(issue => ({ ...issue, summary: redact(issue.summary),
        actual: Object.fromEntries(Object.entries(issue.actual).map(([key, value]) => [key, key === 'feedbackSource' ? null : typeof value === 'string' ? redact(value) : value])),
        target: { ...issue.target, description: redact(issue.target.description) }, missingEvidence: issue.missingEvidence.map(redact),
        suggestions: issue.suggestions.map(suggestion => ({ ...suggestion, action: redact(suggestion.action) })) })), limits: report.guardrails.limits.map(redact),
    }) : null;
    const appearance = Object.fromEntries((['fixture', 'abutment', 'crown'] as const).map(kind => {
      const part = assembly.parts.find(part => part.restoration?.component === kind);
      return [kind, { color: spec.appearance?.[kind]?.color ?? part?.presentationColor ?? null,
        roughness: spec.appearance?.[kind]?.roughness ?? part?.presentationRoughness ?? (part ? restorationAppearance(part)?.roughness : null) ?? null }];
    }));
    return { id: `restoration-${index + 1}`, editRevision: assistantRestorationRevision(assembly),
      site: spec.draftIdentity || assembly.draftSite ? { identity: 'unreviewed-draft', fdi: null, templateFdi: spec.draftIdentity?.templateFdi ?? spec.fdi }
        : { identity: 'recorded-fdi', fdi: spec.fdi, templateFdi: null },
      stale: assembly.warnings.some(value => value.startsWith('STALE:')) || assembly.parts.some(part => part.restoration?.stale),
      parameters: spec.parameters, componentDesign: spec.componentDesign ?? 'legacy', anatomy: spec.anatomy,
      contour: { cervicalScale: spec.contour?.cervicalScale ?? 1, occlusalScale: spec.contour?.occlusalScale ?? 1 }, appearance,
      relationships: projectRestorationRelationships(assembly.fit?.relationships),
      goal: projectRestorationGoal(assembly.fit?.goal),
      meshes: assembly.parts.filter(part => part.restoration).map(part => ({ component: part.restoration!.component,
        dimensions: part.dimensions.map(value => Number.isFinite(value) && value >= 0 ? value : null), closed: part.closed, triangles: part.triangles })),
      quality: { status: report?.status ?? 'unknown', crownExtents: report?.crownExtents ?? null,
        feedbackRows: rows, failureFeedback: failures,
        criteria: report?.criteria.map(({ id, status, measured, reasons }) => ({ id, status, measured, reasons: reasons.map(redact) })) ?? [],
        proposedLocalRevisions: report?.revisions.map(({ parameter, current, proposed, rules, reason }) => ({ parameter, current, proposed, rules, reason: redact(reason) })) ?? [], guardrails,
        unassessed: [...new Set([...(report?.criteria.filter(item => item.status === 'unknown').map(item => item.id) ?? ['quality-evaluation']),
          'patient-specific-anatomy', 'clinical-shade-match', 'bone-and-surgical-clearance'])] },
    };
  }) });
}

export const restorationEditRequestSchema = z.strictObject({ assemblyId: id, expectedRevision: revision, edit: restorationEditSchema });
export type RestorationAssistantEditRequest = z.infer<typeof restorationEditRequestSchema>;
export const restorationEditRefusalSchema = z.strictObject({
  status: z.literal('error'), code: z.enum(['invalid', 'unknown-assembly', 'stale', 'fresh-evidence-required', 'one-edit-per-snapshot']),
  message: z.string().min(1).max(300),
});
export const restorationEditResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('applied'), request: restorationEditRequestSchema, before: restorationDesignSchema, after: restorationDesignSchema,
    changes: feedbackChanges.optional(), failureFeedback: failureFeedback.optional(), relationshipChanges: relationshipChangesSchema.optional() }),
  z.strictObject({ status: z.literal('error'), request: restorationEditRequestSchema, before: restorationDesignSchema,
    code: z.enum(['stale', 'busy', 'invalid', 'failed', 'rejected']), message: z.string().max(300),
    rejectedCandidate: z.strictObject({ rows: feedbackRows, changes: feedbackChanges, failureFeedback,
      relationships: restorationAssistantRelationshipsSchema.nullable().optional(), relationshipChanges: relationshipChangesSchema.optional() }).optional() }),
]);
export type RestorationAssistantEditResult = z.infer<typeof restorationEditResultSchema>;
export const restorationContinuationSchema = z.strictObject({ token: z.string().regex(/^[a-f0-9]{48}$/), result: restorationEditResultSchema.optional() });
export const restorationAssistantRequestSchema = z.strictObject({
  snapshot: restorationAssistantSnapshotSchema, allowEdits: z.boolean(), continuation: restorationContinuationSchema.optional(),
  mode: z.literal('measurement-follow-up').optional(),
});

export const restorationAssistantLimits = [
  'These are generic local implant, abutment/pilar and crown concepts, not patient-specific surgical prescriptions or compatible manufactured hardware.',
  'Mesh dimensions are emitted file-axis extents in file units; crown parameter scales need not equal actual crown dimensions. Never copy a millimetre target into a file-unit parameter.',
  'Clinical case feedback concerns minimum PLATFORM depth below the REVIEWED BONE CREST and minimum FIXTURE OUTER SURFACE distance from EACH ADJACENT ROOT. These stay unknown until verified scale, registration and reviewed bone/root evidence support those exact datums. Gingiva, site origin, visible tooth gaps and fixture axes cannot substitute.',
  'Quality checks and proposed local revisions are engineering guardrails. Unknown anatomy, shade, bone, tissue, occlusion and clinical clearance remain unassessed; appearance is display-only.',
  'Sampled gaps and triangle tests are not exact contact area, overlap volume, occlusal force, or clinical fit. Closed mesh geometry does not establish anatomical validity.',
  'relationships reports fixture/abutment-to-component and adjacent-surface samples and signed axial interfaces. No clinical acceptance bound is supplied; report distances, crossings and incomplete evidence separately without inventing a pass threshold.',
  'componentDesign identifies legacy construction or nested-support/v1. For nested support, abutment.height is the crown seating datum; the emitted retention post extends inside the crown above it. Read component-support.pilar-enclosure and its emitted sample coverage independently of gum exposure. Intended same-assembly nesting is not an external collision or proof of a manufactured seat. Legacy geometry requires a fresh construction comparison to add this post; parameter edits preserve its profile.',
  'goal reports mouth-fit requirements: selected before/after numeric rows, fixed search bounds and attempt summaries. Use failed required contacts/no-crossings to direct edits through existing feedback controls; consider shape preferences only while preserving required checks. Clinical unknowns need evidence, not invented parameter fixes. A missing or stale goal is not achieved.',
  'Read goal.after and selectedAttempt, not the last rejected attempt. Accepted, unchanged or generated geometry never means achieved. Only goal.status satisfied with current evidence means the recorded requirements are met, and even that is not clinical acceptance. Report remaining failures and unknowns, including clinical rows; never relabel budget exhaustion or a stalled search as success.',
  'A requested edit is pending until the local host returns an applied result with fresh before/after measurements. The host reports the remaining edit budget; rejected and failed edits count toward it.',
  'After every host handoff, read the fresh revision and remeasure/review every numeric feedback row, target and remaining failure before another edit. A lower score, a changed parameter or a nicer appearance never establishes success; unknown evidence remains unknown.',
] as const;

/** One successful request per snapshot; read fresh evidence in a PRIOR SDK step. No geometry executes here. */
export function createRestorationAssistantTools(snapshot: RestorationAssistantSnapshot | undefined, options: { allowEdits?: boolean; editsUsed?: number; maxEdits?: number } = {}) {
  const current = snapshot ? restorationAssistantSnapshotSchema.parse(snapshot) : undefined;
  const maxEdits = options.maxEdits ?? MAX_ASSISTANT_EDITS;
  const inspected = new Set<string>(); let requested: RestorationAssistantEditRequest | undefined;
  const readSchema = z.strictObject({ assemblyId: id.describe('Anonymous restoration alias from this inventory, not an FDI number or scan alias. Omit to read all current designs.').optional() });
  const read = (input: z.infer<typeof readSchema>) => {
    const { assemblyId } = readSchema.parse(input);
    const assemblies = current?.assemblies.filter(item => !assemblyId || item.id === assemblyId) ?? [];
    for (const item of assemblies) inspected.add(item.id);
    return { status: assemblies.length ? 'available' : 'unavailable', units: 'file units', selectedAssemblyId: current?.selectedAssemblyId ?? null, assemblies,
      availableAssemblyIds: current?.assemblies.map(item => item.id) ?? [],
      ...(!assemblies.length ? { reason: current?.assemblies.length
        ? 'This restoration alias is not in the current inventory. Use an availableAssemblyId or omit assemblyId to read all current designs.'
        : 'No current restoration concepts were constructed. Review the unresolved case evidence before requesting measurements or edits.' } : {}),
      editsRemaining: options.allowEdits ? Math.max(0, maxEdits - (options.editsUsed ?? 0)) : 0, limitations: restorationAssistantLimits };
  };
  const requestEdit = (input: unknown, execution?: ToolExecutionOptions<{}>) => {
    const parsed = restorationEditRequestSchema.safeParse(input);
    const error = (code: z.infer<typeof restorationEditRefusalSchema>['code'], message: string) => ({ status: 'error' as const, code, message });
    if (!parsed.success) return error('invalid', 'Use only validated design values and a nonempty reason.');
    const action = parsed.data, design = current?.assemblies.find(item => item.id === action.assemblyId);
    if (!design) return error('unknown-assembly', 'Read an assembly in the current inventory.');
    if (design.stale || design.editRevision !== action.expectedRevision) return error('stale', 'This revision is stale. Obtain fresh local evidence.');
    const previouslyReturned = !execution || execution.messages.some(message => message.role === 'tool' && message.content.some(part => {
      if (part.type !== 'tool-result' || part.toolName !== 'getRestorationDesign' || part.output.type !== 'json') return false;
      const value = part.output.value as { assemblies?: unknown[] } | null;
      return value?.assemblies?.some(item => { const parsed = restorationDesignSchema.safeParse(item); return parsed.success && parsed.data.id === design.id && parsed.data.editRevision === design.editRevision; });
    }));
    if (!inspected.has(design.id) || !previouslyReturned) return error('fresh-evidence-required', 'Read getRestorationDesign in a prior step before requesting this revision.');
    if (requested) return error('one-edit-per-snapshot', 'One revision has already been requested. Await fresh host evidence.');
    requested = action;
    return { status: 'requested' as const, request: action, applied: false as const };
  };
  return {
    getRestorationDesign: Object.assign(tool({ title: 'Restoration design inventory', description: 'Read anonymous current implant, abutment/pilar and crown values, actual mesh extents/closure, numeric actual/target/bounds/error/control feedback for EVERY target, mouth-fit goal requirements with fixed bounds and attempt summaries, quality guardrails, actionable failures and unknown evidence. Read the fresh revision before each edit and after every applied/rejected result; use required failures for problem-directed edits and never infer achievement from unchanged/generated geometry, score or appearance.', inputSchema: readSchema, execute: read, metadata: { annotations: { readOnlyHint: true } } }), { execute: read, inputSchema: readSchema }),
    ...(current?.assemblies.length && options.allowEdits && (options.editsUsed ?? 0) < maxEdits ? {
      requestRestorationEdit: Object.assign(tool({ title: 'Request one bounded local design revision', description: 'Request one revision-bound edit of a known generic implant/crown/abutment concept using current evidence and a reason. Returns requested, never applied: stop for the host to build exactly one candidate, then evaluate actual before/after evidence. No placement, raw mesh, bone or clinical prescription tools.', inputSchema: restorationEditRequestSchema, execute: requestEdit, metadata: { annotations: { readOnlyHint: false } } }), { execute: requestEdit, inputSchema: restorationEditRequestSchema }),
    } : {}),
  };
}

/** Exported host contract. The callback receives LOCAL IDs and the engine's LOCAL revision. */
export interface AssistantRestorationSource {
  assemblies: RestorationAssembly[];
  selectedId?: string | null;
  busy: boolean;
  /** External image/registration/display inputs only; excludes generated restoration changes. */
  sourceRevision?: string;
  applyEdit: (id: string, edit: RestorationEdit, expectedRevision: string, signal: AbortSignal) => Promise<RestorationAssembly>;
}

/** Only called after a complete, successful handoff stream; rejects stale/unknown actions before worker startup. */
export async function applyAssistantRestorationEdit(source: AssistantRestorationSource, action: RestorationAssistantEditRequest, signal: AbortSignal): Promise<{ result: RestorationAssistantEditResult; assembly?: RestorationAssembly }> {
  signal.throwIfAborted();
  const request = restorationEditRequestSchema.parse(action);
  const inventory = buildRestorationAssistantSnapshot(source.assemblies);
  const index = inventory.assemblies.findIndex(item => item.id === request.assemblyId);
  const before = inventory.assemblies[index], assembly = source.assemblies[index];
  if (!before || !assembly) throw new Error('The requested restoration is no longer available.');
  const fail = (code: 'stale' | 'busy' | 'invalid' | 'failed', message: string) => ({ result: restorationEditResultSchema.parse({ status: 'error', request, before, code, message }) });
  if (before.stale || before.editRevision !== request.expectedRevision) return fail('stale', 'The local restoration revision changed; this edit was not applied.');
  if (source.busy) return fail('busy', 'Local restoration work is busy; this edit was not applied.');
  try {
    const updated = await source.applyEdit(assembly.id, request.edit, restorationEditRevision(assembly), signal);
    signal.throwIfAborted();
    if (updated.id !== assembly.id) return fail('invalid', 'The host returned a different assembly.');
    const after = buildRestorationAssistantSnapshot(source.assemblies.map((item, i) => i === index ? updated : item)).assemblies[index];
    if (after.editRevision === before.editRevision) return fail('invalid', 'The host did not return a new revision.');
    return { assembly: updated, result: restorationEditResultSchema.parse({ status: 'applied', request, before, after,
      changes: compareRestorationFeedback(before.quality.feedbackRows, after.quality.feedbackRows), failureFeedback: after.quality.failureFeedback,
      relationshipChanges: compareRestorationRelationships(before.relationships, after.relationships) }) };
  } catch (cause) {
    signal.throwIfAborted();
    if (cause instanceof RestorationEditRejected) {
      const rows = restorationFeedbackRows(cause.candidate.quality, cause.candidate.parameters, cause.candidate.measurement, assembly.spec.qualityContext);
      const relationships = projectRestorationRelationships(cause.candidate.relationships);
      // Only this typed host rejection carries public reasons. Arbitrary worker messages remain local.
      return { result: restorationEditResultSchema.parse({ status: 'error', request, before, code: 'rejected',
        message: 'Measured guardrails rejected this candidate. The current model was retained; review rejectedCandidate and remeasure a revised candidate.',
        rejectedCandidate: { rows, changes: compareRestorationFeedback(before.quality.feedbackRows, rows), relationships,
          relationshipChanges: compareRestorationRelationships(before.relationships, relationships),
          failureFeedback: [...cause.reasons, ...rows.filter(row => row.status === 'fail').map(row => `${row.label}: ${row.feedback}`)].map(value => value.slice(0, 1000)).slice(0, 128) } }) };
    }
    const message = cause instanceof Error ? cause.message : '';
    if (message === 'The edit does not change the restoration.') return fail('invalid', 'The requested values equal the current design. Read the current rows and choose an evidence-backed change, or stop.');
    if (message === 'The restoration revision changed. Read the current assembly before editing.' || message === 'Concept evidence changed. Review the latest surfaces and generate again.')
      return fail('stale', 'The revision or source evidence changed during this edit. Read fresh local evidence before retrying.');
    if (message === 'Another restoration operation is active. Wait for it or cancel it before editing.') return fail('busy', 'Another local operation is active. Wait for it to finish, then reread the restoration.');
    return fail('failed', 'The local worker could not complete this edit; no applied result was returned. Read current measurements and local worker diagnostics before retrying.');
  }
}
