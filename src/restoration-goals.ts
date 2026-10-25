import { z } from 'zod';
import { feedbackError, restorationFeedbackRows } from './restoration-feedback.ts';
import type { RestorationFitResult, RestorationParameters } from './restoration-types';
import type { FixtureGingivaReport } from './restoration-gingiva';

const finite = z.number().finite(), nullable = finite.nullable();
export const goalRowSchema = z.strictObject({
  id: z.string().max(120), label: z.string().max(200),
  priority: z.enum(['required', 'preference', 'clinical']),
  actual: nullable, lower: nullable, upper: nullable, error: nullable,
  exclusiveUpper: z.boolean().default(false),
  units: z.enum(['file units (u)', 'ratio', 'fraction', 'degrees', 'count', 'mm']),
  status: z.enum(['pass', 'fail', 'unknown']), reason: z.string().max(1000),
});
export type RestorationGoalRow = z.infer<typeof goalRowSchema>;
export const goalSnapshotSchema = z.strictObject({
  status: z.enum(['satisfied', 'unmet', 'unknown']), rows: z.array(goalRowSchema).max(128),
  requiredError: finite.nonnegative(), preferenceError: finite.nonnegative(),
});
export type RestorationGoalSnapshot = z.infer<typeof goalSnapshotSchema>;
export const restorationGoalSchema = z.strictObject({
  version: z.literal('restoration-goal/v1'),
  evidenceRevision: z.string().regex(/^goal-[a-f0-9]{16}$/),
  targetGaps: z.record(z.string(), finite.nonnegative()),
  status: goalSnapshotSchema.shape.status,
  termination: z.enum(['satisfied', 'needs-evidence', 'candidate-budget', 'time-budget', 'stalled', 'measurement-only']),
  before: goalSnapshotSchema, after: goalSnapshotSchema,
  contract: goalSnapshotSchema,
  selectedAttempt: z.number().int().min(0).max(16),
  attempts: z.array(z.strictObject({ attempt: z.number().int().min(0).max(16), accepted: z.boolean(), reason: z.string().max(1000), snapshot: goalSnapshotSchema })).min(1).max(17),
  durationMs: finite.nonnegative(), maxAttempts: z.number().int().min(1).max(17),
  bounds: z.record(z.string(), z.tuple([finite, finite])).refine(value => {
    const keys = ['crown.width', 'crown.depth', 'crown.height', 'abutment.height', 'abutment.angleY', 'fixture.depth', 'cervicalScale'];
    const optional = ['abutment.radius', 'abutment.emergenceRadius', 'abutment.angleX'];
    return keys.every(key => value[key]) && Object.keys(value).every(key => [...keys, ...optional].includes(key)
      && value[key][0] <= value[key][1]);
  }, 'Goal bounds must contain every supported parameter with an ordered finite range.'),
  limits: z.array(z.string().max(1000)).max(20),
  emergence: z.array(z.strictObject({ target: z.string().regex(/^target-[a-f0-9]{16}$/),
    transverseCrossingTriangles: finite.nonnegative().nullable(), touchingOrAmbiguousTriangles: finite.nonnegative().nullable(),
    intersectionComplete: z.boolean() })).max(16).optional(),
}).refine(value => value.status === value.after.status && value.attempts.length <= value.maxAttempts
  && value.attempts.every((item, i) => item.attempt === i)
  && value.attempts[value.selectedAttempt]?.accepted === true
  && JSON.stringify(value.attempts[0].snapshot) === JSON.stringify(value.before)
  && JSON.stringify(value.attempts[value.selectedAttempt].snapshot) === JSON.stringify(value.after), 'Goal history must identify its selected measurements.');
export type RestorationGoalReport = z.infer<typeof restorationGoalSchema>;

/** Absolute bounds are frozen from the first measured design, not recomputed
 * around each candidate. Neighbour ratios are preferences, not clinical laws. */
export function restorationGoalSnapshot(result: RestorationFitResult, gingiva: FixtureGingivaReport,
  contract?: RestorationGoalSnapshot): RestorationGoalSnapshot {
  const feedback = restorationFeedbackRows(result.report.quality?.final, result.spec.parameters, result.report.after, result.spec.qualityContext);
  const rows: RestorationGoalRow[] = feedback.filter(row => row.source === 'fit-measurement' || row.source === 'clinical-case-feedback'
    || row.id.startsWith('relative-') || row.id.startsWith('anatomy.') || row.id.startsWith('component-presentation.') || row.id.startsWith('component-support.') || row.id.startsWith('space-occupancy.'))
    .map(row => ({ id: row.id, label: row.label,
      priority: row.units === 'mm' ? 'clinical' : row.source === 'fit-measurement' || row.id.startsWith('component-presentation.') || row.id.startsWith('component-support.') || row.id.startsWith('space-occupancy.') ? 'required' : 'preference',
      actual: row.actual, lower: row.lower,
      upper: row.id.endsWith('.proximal-gap') && row.target !== null
        ? row.target + (result.report.quality!.final.crownExtents?.mesiodistal ?? result.spec.parameters.crown.width) * .005
        : row.id.endsWith('.occlusal-gap') && row.target !== null ? row.target + (result.report.quality!.final.crownExtents?.occlusal ?? result.spec.parameters.crown.height) * .01 : row.upper,
      exclusiveUpper: row.exclusiveUpper, error: row.error, units: row.units, status: row.status, reason: row.feedback }));
  if (!rows.some(row => row.id === 'component-support.pilar-enclosure')) rows.push({
    id: 'component-support.pilar-enclosure', label: 'Pilar support samples outside crown (sampled enclosure only)',
    priority: 'required', actual: null, lower: null, upper: 0, error: null, exclusiveUpper: false,
    units: 'count', status: 'unknown', reason: 'No current independent emitted pilar/crown-support audit. Missing gum is separate; restore component evidence and recheck the support region.',
  });
  for (const role of ['adjacent', 'antagonist'] as const) if (!result.report.after.surfaces.some(surface => surface.role === role)) {
    rows.push({ id: `missing-${role}`, label: `${role === 'adjacent' ? 'Neighbour' : 'Opposing-tooth'} contact evidence`, priority: 'required',
      actual: null, lower: null, upper: null, error: null, exclusiveUpper: false, units: 'file units (u)', status: 'unknown', reason: 'No supplied target establishes this contact requirement.' });
  }
  rows.push({ id: 'fixture-gingiva', label: 'Fixture exposure beyond each sampled gum allowance', priority: 'required',
    actual: gingiva.maxExposure === null ? null : Math.max(...gingiva.sampleMeasurements.filter(sample => sample.exposure !== null).map(sample => sample.exposure! - sample.exposureTolerance)), lower: null, upper: 0,
    error: gingiva.maxExposure === null ? null : Math.max(0, ...gingiva.sampleMeasurements.map(sample => sample.exposure === null ? 0 : sample.exposure - sample.exposureTolerance)),
    exclusiveUpper: false, units: 'file units (u)', status: gingiva.status,
    reason: `${gingiva.knownSamples}/${gingiva.samples} emitted-vertex rays measured. Maximum per-sample exposure minus its own allowance; another ray's uncertainty cannot excuse exposure. Directional visible-gum check only; missing rays, 3D containment and bone/root placement remain unresolved.` });
  rows.push({ id: 'pilar-emergence', label: 'Pilar emergence through the gingival boundary', priority: 'clinical', actual: null,
    lower: null, upper: null, error: null, exclusiveUpper: false, units: 'file units (u)', status: 'unknown',
    reason: 'The pilar and constructed crown collar bridge the gum surface. Their intersections are reported separately; crown-body crossings remain required checks. Emergence contour and tissue response need review.' });
  const abutment = result.report.abutmentGingiva ?? result.report.relationships?.abutmentGingiva;
  // Legacy reports have no emitted pilar audit. Once a contract includes this
  // check, loss of its report remains unknown instead of dropping the requirement.
  if (abutment || contract?.rows.some(row => row.id === 'abutment-gingiva')) {
    rows.push({ id: 'abutment-gingiva', label: 'Pilar samples above gum without crown support', priority: 'required',
      actual: abutment?.samples ? abutment.unsupportedSamples : null, lower: null, upper: 0,
      error: abutment?.samples ? abutment.unsupportedSamples : null, exclusiveUpper: false, units: 'count',
      status: abutment?.status ?? 'unknown',
      reason: abutment ? `${abutment.unsupportedSamples} emitted pilar vertices are above observed gum and outside the actual crown; ${abutment.knownSamples}/${abutment.samples} gum rays known, ${abutment.unknownSupportSamples} crown support tests unresolved. Adjust pilar height, slope or radii and remeasure all targets. This sampled check does not establish clinical emergence or tissue containment.`
        : 'The previous emitted pilar/gum audit is unavailable. Restore its surface evidence and recheck the current geometry.' });
  }
  for (const row of rows) {
    const original = contract?.rows.find(item => item.id === row.id);
    if (original && row.id !== 'fixture-gingiva') {
      row.lower = original.lower; row.upper = original.upper; row.exclusiveUpper = original.exclusiveUpper;
    }
    if (row.id !== 'fixture-gingiva') row.error = feedbackError(row.actual, row.lower, row.upper, row.exclusiveUpper);
    if (row.error !== null && (row.error !== 0 || row.exclusiveUpper && row.actual === row.upper) && row.id !== 'fixture-gingiva') row.status = 'fail';
    else if (row.status === 'fail' && row.actual !== null && original && original.status !== 'unknown' && row.id !== 'fixture-gingiva') row.status = 'pass';
    if (row.priority === 'required' && row.id !== 'fixture-gingiva' && !row.id.startsWith('component-support.') && row.error !== null) {
      row.reason = `Actual ${row.actual} ${row.units}; fixed requirement ${row.lower === null ? '' : `>= ${row.lower} `}${row.upper === null ? '' : `${row.exclusiveUpper ? '<' : '<='} ${row.upper}`} ${row.units}; signed error ${row.error}. ${row.status === 'unknown' ? 'The numeric comparison does not resolve missing or unverified evidence.' : 'Remeasure this requirement and all other targets after each edit.'}`;
    }
  }
  const scale = Math.max(Number.MIN_VALUE, contract?.rows.find(row => row.id === 'relative-width')?.actual ?? result.report.quality?.initial.crownExtents?.mesiodistal ?? result.spec.parameters.crown.width);
  return summarizeGoalRows(rows, scale);
}

export function summarizeGoalRows(rows: RestorationGoalRow[], scale: number): RestorationGoalSnapshot {
  const deficit = (row: RestorationGoalRow) => Math.abs(row.error ?? 0) / (row.units === 'file units (u)' ? scale : 1);
  return { status: rows.some(row => row.priority !== 'preference' && row.status === 'fail') ? 'unmet'
      : rows.some(row => row.priority !== 'preference' && row.status === 'unknown') ? 'unknown' : 'satisfied', rows,
    requiredError: rows.filter(row => row.priority === 'required').reduce((sum, row) => sum + deficit(row), 0),
    preferenceError: rows.filter(row => row.priority === 'preference').reduce((sum, row) => sum + deficit(row), 0) };
}

/** Expanded fitting crops can introduce new requirements. Keep each existing
 * requirement unchanged and bind newly measured targets to their first bounds.
 * The caller separately rejects disappearing target surfaces. */
export function extendGoalContract(original: RestorationGoalSnapshot | undefined, measured: RestorationGoalSnapshot): RestorationGoalSnapshot {
  if (!original) return measured;
  const rows = measured.rows.map(row => original.rows.find(old => old.id === row.id) ?? row);
  if (rows.length === original.rows.length && rows.every(row => original.rows.includes(row))) return original;
  const scale = Math.max(Number.MIN_VALUE, original.rows.find(row => row.id === 'relative-width')?.actual ?? 1);
  return summarizeGoalRows(rows, scale);
}

/** Contact quality is judged per target against fixed bounds. A different set
 * of area samples may change hit fraction without losing the target; only a
 * lost target/hit set, failed coverage bound or incomplete audit is forbidden. */
export function acceptsGoalCandidate(candidate: RestorationFitResult, previous: RestorationFitResult,
  next: RestorationGoalSnapshot, before: RestorationGoalSnapshot): boolean {
  if (!preservesGoalEvidence(candidate, previous, next, before)) return false;
  return next.requiredError < before.requiredError - 1e-7
    || Math.abs(next.requiredError - before.requiredError) <= 1e-7 && next.preferenceError < before.preferenceError - 1e-7;
}

export function preservesGoalEvidence(candidate: Pick<RestorationFitResult, 'report'>, previous: Pick<RestorationFitResult, 'report'>,
  next: RestorationGoalSnapshot, before: RestorationGoalSnapshot): boolean {
  const completeGingiva = (report: FixtureGingivaReport | undefined) => report !== undefined && report.samples > 0
    && report.knownSamples === report.samples && report.missedSamples === 0 && report.ambiguousSamples === 0;
  // A lower exposure over fewer rays does not establish that the fixture was
  // buried. Preserve complete directional coverage even when both states fail.
  if (completeGingiva(previous.report.gingiva) && !completeGingiva(candidate.report.gingiva)) return false;
  const oldPilar = previous.report.abutmentGingiva ?? previous.report.relationships?.abutmentGingiva;
  const newPilar = candidate.report.abutmentGingiva ?? candidate.report.relationships?.abutmentGingiva;
  if (oldPilar && (!newPilar || newPilar.unsupportedSamples > oldPilar.unsupportedSamples
    || oldPilar.samples > 0 && oldPilar.knownSamples === oldPilar.samples
      && (newPilar.samples === 0 || newPilar.knownSamples !== newPilar.samples)
    || oldPilar.unknownSupportSamples === 0 && newPilar.unknownSupportSamples > 0
    || oldPilar.maxUnsupportedExposure !== null && newPilar.maxUnsupportedExposure !== null
      && newPilar.maxUnsupportedExposure > oldPilar.maxUnsupportedExposure + Math.max(oldPilar.numericTolerance, newPilar.numericTolerance))) return false;
  if (oldPilar && newPilar && oldPilar.unsupportedSamples > 0
    && (newPilar.unsupportedSamples < oldPilar.unsupportedSamples || newPilar.maxUnsupportedExposure === null)
    && !(newPilar.samples > 0 && newPilar.knownSamples === newPilar.samples && newPilar.unknownSupportSamples === 0)) return false;
  const oldSupport = previous.report.quality?.final.criteria.find(row => row.id === 'component-support');
  const newSupport = candidate.report.quality?.final.criteria.find(row => row.id === 'component-support');
  if (oldSupport && (oldSupport.measured.supportSamples ?? 0) > 0) {
    if (!newSupport || !(newSupport.measured.supportSamples! > 0)
      || (newSupport.measured.outsideSamples ?? Infinity) > (oldSupport.measured.outsideSamples ?? 0)
      || (newSupport.measured.unknownSamples ?? Infinity) > (oldSupport.measured.unknownSamples ?? 0)) return false;
    if ((oldSupport.measured.outsideSamples ?? 0) > (newSupport.measured.outsideSamples ?? 0)
      && newSupport.measured.unknownSamples !== 0) return false;
    if (oldSupport.measured.sampledMaxOutsideDistance !== null
      && (newSupport.measured.sampledMaxOutsideDistance ?? 0) > oldSupport.measured.sampledMaxOutsideDistance
        + Math.max(oldSupport.measured.numericTolerance ?? 0, newSupport.measured.numericTolerance ?? 0)) return false;
  }
  if (candidate.report.after.surfaces.length !== previous.report.after.surfaces.length) return false;
  for (const old of previous.report.after.surfaces) {
    const item = candidate.report.after.surfaces.find(row => row.id === old.id);
    if (!item || item.role !== old.role || item.side !== old.side || item.targetGap !== old.targetGap
      || JSON.stringify(item.sourceComponents) !== JSON.stringify(old.sourceComponents) || item.sourceRegion !== old.sourceRegion
      || old.intersectionComplete && !item.intersectionComplete) return false;
    const crossings = item.transverseCrossingTriangles, oldCrossings = old.transverseCrossingTriangles;
    if (oldCrossings !== undefined && (crossings === undefined || crossings > oldCrossings)) return false;
    const observed = oldCrossings ?? old.intersectingTriangles;
    const remaining = crossings ?? item.intersectingTriangles;
    if (oldCrossings === undefined && !item.intersectionComplete && remaining > observed) return false;
    if (observed > 0 && remaining < observed && !item.intersectionComplete) return false;
    if ((old.occlusalRayHits ?? 0) > 0 && !(item.occlusalRayHits! > 0)) return false;
  }
  for (const old of before.rows.filter(row => row.priority === 'required')) {
    const item = next.rows.find(row => row.id === old.id);
    if (!item || old.actual !== null && item.actual === null || old.status === 'pass' && item.status !== 'pass') return false;
    const allowance = Math.max(Number.MIN_VALUE, Math.abs(old.actual ?? 0), Math.abs(item.actual ?? 0),
      Math.abs(old.lower ?? 0), Math.abs(old.upper ?? 0)) * 1e-6;
    if (old.error != null && (item.error == null || Math.abs(item.error) > Math.abs(old.error) + allowance)) return false;
    // Unknown cannot be traded for a new measured failure; obtain a clean candidate.
    if (old.status === 'unknown' && item.status === 'fail') return false;
  }
  return true;
}

export function goalParameterBounds(parameters: RestorationParameters, contour?: { cervicalScale?: number; occlusalScale?: number }) {
  const p = parameters;
  return { 'crown.width': [p.crown.width * .85, p.crown.width * 1.35], 'crown.depth': [p.crown.depth * .85, p.crown.depth * 1.2],
    'crown.height': [p.crown.height * .8, p.crown.height * 1.15], 'abutment.height': [p.abutment.height * .5, p.abutment.height * 1.5],
    'abutment.angleY': [Math.max(-80, p.abutment.angleY - 8), Math.min(80, p.abutment.angleY + 8)],
    'abutment.angleX': [Math.max(-80, p.abutment.angleX - 8), Math.min(80, p.abutment.angleX + 8)],
    'abutment.radius': [p.abutment.radius * .65, p.abutment.radius * 1.1],
    'abutment.emergenceRadius': [p.abutment.emergenceRadius * .65, p.abutment.emergenceRadius * 1.1],
    'fixture.depth': [p.fixture.depth, p.fixture.depth + p.fixture.length * .35],
    'cervicalScale': [Math.max(.5, (contour?.cervicalScale ?? 1) * .65), Math.min(1.5, (contour?.cervicalScale ?? 1) * 1.1)] } as Record<string, [number, number]>;
}
