import { z } from 'zod';
import type { AbutmentGingivaReport, FixtureGingivaReport } from './restoration-gingiva';

const finite = z.number().finite(), nonnegative = finite.nonnegative();
// Match the measurement's bounded set of emitted fixture vertices.
const count = nonnegative.int().max(5000);
const sample = z.strictObject({
  point: z.tuple([finite, finite, finite]),
  status: z.enum(['known', 'missed', 'ambiguous']), exposure: finite.nullable(),
  numericTolerance: nonnegative, exposureTolerance: nonnegative,
}).superRefine((value, ctx) => {
  if ((value.status === 'known') !== (value.exposure !== null)) {
    ctx.addIssue({ code: 'custom', path: ['exposure'], message: 'Known samples require signed exposure; missed and ambiguous samples require null.' });
  }
  if (value.exposureTolerance < value.numericTolerance) {
    ctx.addIssue({ code: 'custom', path: ['exposureTolerance'], message: 'Exposure allowance cannot be smaller than the numerical allowance.' });
  }
});

/** Validates recorded envelope evidence, not geometry or clinical suitability. */
export const fixtureGingivaSchema = z.strictObject({
  version: z.literal('fixture-gingiva/v1'), status: z.enum(['pass', 'fail', 'unknown']),
  maxExposure: finite.nullable(), knownSamples: count, samples: count, coverage: finite.min(0).max(1),
  missedSamples: count, ambiguousSamples: count, sampleMeasurements: z.array(sample).max(5000),
  numericTolerance: nonnegative, exposureTolerance: nonnegative, requiredDepthIncrease: nonnegative.nullable(),
  units: z.literal('file units (u)'),
  clinicalChecks: z.strictObject({
    boneDepth: z.literal('unknown'), rootClearance: z.literal('unknown'),
    containment: z.literal('unknown'), clinicalSafety: z.literal('unknown'),
  }),
  limits: z.array(z.string().max(2000)).max(32),
}).superRefine((value, ctx) => {
  const issue = (path: keyof FixtureGingivaReport, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  let known = 0, missed = 0, ambiguous = 0, maxExposure: number | null = null;
  let numericTolerance = 0, exposureTolerance = 0, prototypeAllowance = 0, correction = 0, exposed = false;
  for (const entry of value.sampleMeasurements) {
    if (entry.status === 'known') {
      known++;
      if (entry.exposure !== null) {
        maxExposure = Math.max(maxExposure ?? -Infinity, entry.exposure);
        // Classification uses each sample's allowance, never the aggregate maximum.
        exposed ||= entry.exposure > entry.exposureTolerance;
        correction = Math.max(correction, entry.exposure + 2 * entry.numericTolerance);
      }
    } else if (entry.status === 'missed') missed++;
    else ambiguous++;
    numericTolerance = Math.max(numericTolerance, entry.numericTolerance);
    exposureTolerance = Math.max(exposureTolerance, entry.exposureTolerance);
    if (entry.exposureTolerance > entry.numericTolerance) prototypeAllowance = Math.max(prototypeAllowance, entry.exposureTolerance);
  }
  if (value.samples !== value.sampleMeasurements.length) issue('samples', 'Sample count must match the recorded measurements.');
  if (value.knownSamples !== known) issue('knownSamples', 'Known count must match sample statuses.');
  if (value.missedSamples !== missed) issue('missedSamples', 'Missed count must match sample statuses.');
  if (value.ambiguousSamples !== ambiguous) issue('ambiguousSamples', 'Ambiguous count must match sample statuses.');
  const coverage = value.samples === 0 ? 0 : known / value.samples;
  if (value.coverage !== coverage) issue('coverage', 'Coverage must be the known sample fraction, or zero for no samples.');
  // These aggregates select recorded numbers; no file-unit epsilon or rounding is needed.
  if (value.maxExposure !== maxExposure) issue('maxExposure', 'Maximum exposure must be the signed maximum of known samples, or null when none are known.');
  if (value.numericTolerance !== numericTolerance) issue('numericTolerance', 'Numerical allowance must be the maximum across all samples, or zero for no samples.');
  if (value.exposureTolerance < value.numericTolerance ||
      (value.sampleMeasurements.length > 0 && value.exposureTolerance !== exposureTolerance)) {
    issue('exposureTolerance', 'Exposure allowance must include the numerical allowance and equal the maximum across recorded samples.');
  }
  if (value.sampleMeasurements.some(entry => entry.exposureTolerance !== Math.max(entry.numericTolerance, prototypeAllowance))) {
    issue('sampleMeasurements', 'Sample exposure allowances must combine their numerical allowance with one shared prototype allowance.');
  }
  const allKnown = value.samples > 0 && known === value.samples;
  if ((value.status === 'fail') !== exposed) issue('status', 'Observed exposure beyond any sample allowance must fail, and failure requires observed exposure.');
  if (value.status === 'pass' && !allKnown) issue('status', 'A pass requires nonempty, entirely known sample coverage.');
  // All-known unknown reports are valid: degenerate tissue can prevent completeness.
  // The report cannot independently prove absence of degeneracy, a nominal-spec
  // match, or the external depth bound. A proposal establishes no clinical checks.
  if (value.requiredDepthIncrease !== null) {
    if (value.status === 'unknown' || !allKnown) {
      issue('requiredDepthIncrease', 'Unknown or incomplete envelope evidence cannot support a depth proposal.');
    } else if (value.requiredDepthIncrease !== (value.status === 'pass' ? 0 : correction)) {
      issue('requiredDepthIncrease', 'A proposal must be zero for a pass or the full exposure correction including twice each sample numerical allowance.');
    }
  }
}) satisfies z.ZodType<FixtureGingivaReport>;

export const restorationGingivaSchema = fixtureGingivaSchema;

export const abutmentGingivaSchema = z.strictObject({
  version: z.literal('abutment-gingiva/v1'), status: z.enum(['pass', 'fail', 'unknown']),
  samples: count, knownSamples: count, missedSamples: count, ambiguousSamples: count,
  coverage: finite.min(0).max(1), exposedSamples: count, supportedSamples: count,
  unsupportedSamples: count, unknownSupportSamples: count, maxUnsupportedExposure: finite.nullable(),
  numericTolerance: nonnegative, crownTolerance: nonnegative.nullable(),
  sampleMeasurements: z.array(sample.safeExtend({
    crownSupport: z.enum(['not-required', 'supported', 'unsupported', 'unknown']),
    crownDistance: nonnegative.nullable(),
  })).max(5000),
  units: z.literal('file units (u)'),
  clinicalChecks: z.strictObject({ boneDepth: z.literal('unknown'), rootClearance: z.literal('unknown'),
    containment: z.literal('unknown'), clinicalSafety: z.literal('unknown') }),
  limits: z.array(z.string().max(2000)).max(32),
}).superRefine((value, ctx) => {
  const issue = (path: keyof AbutmentGingivaReport, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  let known = 0, missed = 0, ambiguous = 0, exposed = 0, supported = 0, unsupported = 0, unknown = 0;
  let maxExposure: number | null = null, tolerance = 0;
  for (const entry of value.sampleMeasurements) {
    if (entry.status === 'known') known++;
    else if (entry.status === 'missed') missed++;
    else ambiguous++;
    tolerance = Math.max(tolerance, entry.numericTolerance);
    if (entry.status === 'known' && entry.exposure! > entry.exposureTolerance) {
      exposed++;
      if (entry.crownSupport === 'supported') supported++;
      else if (entry.crownSupport === 'unsupported') { unsupported++; maxExposure = Math.max(maxExposure ?? -Infinity, entry.exposure!); }
      else if (entry.crownSupport === 'unknown') unknown++;
      else issue('sampleMeasurements', 'Observed exposure requires a crown support result, including explicit unknowns.');
      if (['supported', 'unsupported'].includes(entry.crownSupport) && (entry.crownDistance === null || value.crownTolerance === null)) issue('sampleMeasurements', 'Known crown support requires a measured distance and numerical allowance.');
    } else if (entry.crownSupport !== 'not-required' || entry.crownDistance !== null) issue('sampleMeasurements', 'Only known exposed samples can claim crown support evidence.');
  }
  const expected = { samples: value.sampleMeasurements.length, knownSamples: known, missedSamples: missed,
    ambiguousSamples: ambiguous, exposedSamples: exposed, supportedSamples: supported,
    unsupportedSamples: unsupported, unknownSupportSamples: unknown,
    coverage: value.samples ? known / value.samples : 0, maxUnsupportedExposure: maxExposure };
  for (const key of Object.keys(expected) as (keyof typeof expected)[]) if (value[key] !== expected[key]) issue(key, 'Aggregate must match the recorded samples.');
  if (value.sampleMeasurements.length && value.numericTolerance !== tolerance) issue('numericTolerance', 'Numerical allowance must match the maximum recorded sample allowance.');
  if ((value.status === 'fail') !== (unsupported > 0)) issue('status', 'Failure requires observed exposure outside emitted crown support; every such witness fails.');
  if (value.status === 'pass' && (!value.samples || known !== value.samples || unknown)) issue('status', 'Pass requires nonempty known gum coverage and support for every exposed vertex.');
}) satisfies z.ZodType<AbutmentGingivaReport>;
