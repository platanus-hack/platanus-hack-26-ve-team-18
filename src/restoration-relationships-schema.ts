import { z } from 'zod';
import { abutmentGingivaSchema } from './restoration-gingiva-schema.ts';

const finite = z.number().finite(), nonnegative = finite.min(0), count = nonnegative.int().max(4_000_000);
const text = z.string().max(2000), id = z.string().min(1).max(500), vec = z.tuple([finite, finite, finite]);
const distance = nonnegative.nullable();
const relationship = z.strictObject({
  id, source: z.enum(['fixture', 'abutment']), target: z.enum(['abutment', 'crown', 'adjacent']), targetId: id,
  side: z.enum(['mesial', 'distal']).optional(), status: z.enum(['measured', 'unknown']), reason: text.nullable(),
  sourceTriangles: count.nullable(), targetTriangles: count.nullable(), samples: count,
  sampledMinDistance: distance, sampledMedianDistance: distance, sampledP95Distance: distance,
  intersectionComplete: z.boolean(), intersectingTriangles: count.nullable(), transverseCrossingTriangles: count.nullable(), touchingOrAmbiguousTriangles: count.nullable(),
  intersectionTestedTriangles: count, intersectionPairTests: count.max(200_000), intersectionTolerance: distance,
  surfaceEvidence: z.enum(['unknown', 'none-observed', 'touching-or-ambiguous', 'transverse-crossing']), intersectionReason: text.nullable(),
}).refine(value => value.status === 'measured' ? value.samples > 0 && value.sampledMinDistance !== null && value.sampledMedianDistance !== null && value.sampledP95Distance !== null
  && value.sampledMinDistance <= value.sampledMedianDistance && value.sampledMedianDistance <= value.sampledP95Distance
  : value.samples === 0 && value.sampledMinDistance === null && value.sampledMedianDistance === null && value.sampledP95Distance === null,
  'Relationship sample statistics must describe completed measurements only.')
  .refine(value => {
    const hits = value.intersectingTriangles, crossing = value.transverseCrossingTriangles, touching = value.touchingOrAmbiguousTriangles;
    if (hits === null || crossing === null || touching === null) return hits === null && crossing === null && touching === null
      && !value.intersectionComplete && value.intersectionTestedTriangles === 0 && value.intersectionPairTests === 0 && value.intersectionTolerance === null && value.surfaceEvidence === 'unknown';
    if (crossing > hits || touching > hits || hits > crossing + touching || value.intersectionTolerance === null) return false;
    const expected = crossing > 0 ? 'transverse-crossing' : touching > 0 ? 'touching-or-ambiguous' : value.intersectionComplete ? 'none-observed' : 'unknown';
    return value.surfaceEvidence === expected;
  },
  'Relationship surface evidence must match its intersection audit.');
const nominalInterface = z.strictObject({
  id: z.enum(['fixture-platform', 'crown-base']), source: z.enum(['fixture', 'abutment']), target: z.enum(['abutment', 'crown']),
  status: z.enum(['measured', 'unknown']), reason: text.nullable(), nominalOrigin: vec, nominalNormal: vec,
  sourceAxialOffset: finite.nullable(), targetAxialOffset: finite.nullable(), signedAxialGap: finite.nullable(),
  sourceDistanceToNominalOrigin: distance, targetDistanceToNominalOrigin: distance,
}).refine(value => {
  const values = [value.sourceAxialOffset, value.targetAxialOffset, value.signedAxialGap, value.sourceDistanceToNominalOrigin, value.targetDistanceToNominalOrigin];
  if (value.status === 'unknown') return values.every(item => item === null);
  if (values.some(item => item === null)) return false;
  const expected = value.targetAxialOffset! - value.sourceAxialOffset!;
  const scale = Math.max(Math.abs(value.sourceAxialOffset!), Math.abs(value.targetAxialOffset!), Number.MIN_VALUE);
  return Math.abs(value.signedAxialGap! - expected) <= scale * 1e-12;
}, 'Measured interfaces require finite values and a consistent signed axial gap; unknown interfaces have null values.');
export const restorationRelationshipsSchema = z.strictObject({
  version: z.literal('restoration-relationships/v1'), units: z.literal('file units (u)'), termination: z.enum(['complete', 'time-budget']), durationMs: nonnegative,
  relationships: z.array(relationship).min(3).max(259), interfaces: z.array(nominalInterface).length(2),
  abutmentGingiva: abutmentGingivaSchema.optional(),
  sampling: z.strictObject({ method: z.literal('deterministic-triangle-barycentres'), direction: z.literal('source-to-target'), requestedPerRelationship: count,
    fullResolutionDistanceTargets: z.literal(true), maximumMeshTriangles: count, maximumVerificationRegionTriangles: count, maxDurationMs: positiveBudget() }),
  limits: z.array(text).max(32),
}).refine(value => new Set(value.relationships.map(item => item.id)).size === value.relationships.length && new Set(value.interfaces.map(item => item.id)).size === 2,
  'Relationship and interface identities must be unique.')
  .refine(value => value.relationships.every(item => item.samples <= value.sampling.requestedPerRelationship && item.samples <= (item.sourceTriangles ?? 0)
    && item.intersectionTestedTriangles <= (item.targetTriangles ?? 0)
    && (!item.intersectionComplete || item.intersectionTestedTriangles === item.targetTriangles)
    && (item.intersectingTriangles ?? 0) <= (item.sourceTriangles ?? 0) + (item.targetTriangles ?? 0)),
  'Relationship counts exceed their mesh or sampling bounds.');
function positiveBudget() { return finite.gt(0).max(60000); }
