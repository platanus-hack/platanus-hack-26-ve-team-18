import { z } from 'zod';
import type { RestorationQualityContext, RestorationQualityReport } from './restoration-quality.ts';
import type { RestorationFitMeasurement, RestorationSpec } from './restoration-types.ts';

/**
 * Numeric actual-vs-bound rows derived only from an existing quality report
 * (its measured fields, emitted extents and tolerances). Pure: no geometry is
 * measured here and no unit conversion is made. Rows whose evidence is absent
 * keep `actual`/bounds null and status `unknown`.
 */
const finite = z.number().finite();
const component = z.enum(['fixture', 'abutment', 'crown']);
const control = z.enum(['fixture.radius', 'abutment.radius', 'abutment.height', 'abutment.emergenceRadius', 'abutment.angleX', 'abutment.angleY',
  'crown.width', 'crown.depth', 'crown.height']);
export const restorationFeedbackRowSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9.-]{0,99}$/), label: z.string().max(200), component,
  actual: finite.nullable(), lower: finite.nullable(), upper: finite.nullable(),
  /** Nominal target when supplied (e.g. a sampled gap); lower/upper define acceptance. */
  target: finite.nullable().default(null), exclusiveUpper: z.boolean().default(false),
  /** Signed distance outside the nearest bound in `units`; 0 inside; null when not computable. */
  error: finite.nullable(),
  units: z.enum(['file units (u)', 'ratio', 'fraction', 'degrees', 'count', 'mm']),
  status: z.enum(['pass', 'fail', 'unknown']),
  source: z.enum(['quality', 'fit-measurement', 'clinical-case-feedback']),
  /** Generic engineering parameters that move this row; empty for clinical/placement rows. */
  controls: z.array(control).max(9),
  /** Generated from typed numbers and fixed language, never patient/source text. */
  feedback: z.string().max(1000),
});
export type RestorationFeedbackRow = z.infer<typeof restorationFeedbackRowSchema>;
export type RestorationFeedbackControl = z.infer<typeof control>;
type Parameters = RestorationSpec['parameters'];
type Status = RestorationFeedbackRow['status'];

const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const mul = (a: number | null, b: number | null) => a === null || b === null ? null : a * b;
type FeedbackContext = Pick<RestorationQualityContext, 'bitePoseVerified'>;
type RowInput = Omit<RestorationFeedbackRow, 'error' | 'status' | 'feedback' | 'target' | 'exclusiveUpper'> & {
  target?: number | null; exclusiveUpper?: boolean;
};
const outside = (actual: number | null, lower: number | null, upper: number | null, exclusiveUpper = false) => actual !== null
  && (lower !== null && actual < lower || upper !== null && (actual > upper || exclusiveUpper && actual === upper));

function numericRow(input: RowInput, canPass: boolean, missing?: string, unavailable = false): RestorationFeedbackRow {
  const row = { ...input, target: input.target ?? null, exclusiveUpper: input.exclusiveUpper ?? false };
  const error = feedbackError(row.actual, row.lower, row.upper, row.exclusiveUpper);
  const status: Status = unavailable || error === null ? 'unknown' : outside(row.actual, row.lower, row.upper, row.exclusiveUpper) ? 'fail' : canPass ? 'pass' : 'unknown';
  const bound = `${row.lower === null ? '' : `>= ${row.lower}`}${row.lower !== null && row.upper !== null ? ' and ' : ''}${row.upper === null ? '' : `${row.exclusiveUpper ? '<' : '<='} ${row.upper}`} ${row.units}`;
  const feedback = status === 'fail'
    ? `Actual ${row.actual} ${row.units}; required ${bound}; signed bound error ${error} ${row.units}. Review ${row.controls.join(', ') || 'the missing evidence'}, regenerate and remeasure this row and every target before another edit.`
    : status === 'unknown' ? missing ?? 'Missing, incomplete or unverified evidence; obtain a current measurement and resolve the evaluator unknowns before claiming this target is met.'
      : `Within ${bound} for this engineering measurement only. Remeasure after every geometry edit; this is not clinical acceptance.`;
  return restorationFeedbackRowSchema.parse({ ...row, error, status, feedback });
}

/** Signed error outside [lower, upper]; `strictUpper` treats actual === upper as outside. */
export function feedbackError(actual: number | null, lower: number | null, upper: number | null, strictUpper = false): number | null {
  if (actual === null || !Number.isFinite(actual) || lower === null && upper === null
    || lower !== null && !Number.isFinite(lower) || upper !== null && !Number.isFinite(upper) || lower !== null && upper !== null && lower > upper) return null;
  if (lower !== null && actual < lower) return actual - lower;
  if (upper !== null && (actual > upper || strictUpper && actual >= upper)) return actual - upper;
  return 0;
}

export function restorationFeedbackRows(report: RestorationQualityReport | null | undefined, parameters?: Parameters | null,
  measurement?: RestorationFitMeasurement | null, context?: FeedbackContext | null): RestorationFeedbackRow[] {
  if (!report) return [];
  const t = report.tolerances, extents = report.crownExtents, rows: RestorationFeedbackRow[] = [];
  const criterion = (id: string) => report.criteria.find(item => item.id === id);
  const add = (criterionId: string, row: Omit<RowInput, 'source'> & { strictUpper?: boolean }) => {
    const { strictUpper, ...rest } = row;
    // Inside a numeric bound is only a pass when the evaluator's whole criterion passed
    // (e.g. hypothesized neighbour evidence or an unverified bite can never pass).
    rows.push(numericRow({ ...rest, exclusiveUpper: strictUpper, source: 'quality' }, criterion(criterionId)?.status === 'pass', undefined,
      criterionId === 'occlusal-contact' && criterion(criterionId)?.status === 'unknown'));
  };
  const measured = (id: string, key: string) => num(criterion(id)?.measured[key]);

  for (const [id, label, ratio, extentKey, controls] of [
    ['relative-width', 'Crown mesiodistal extent vs neighbour mean', t.widthToNeighbor, 'mesiodistal', ['crown.width']],
    ['relative-depth', 'Crown buccolingual extent vs neighbour mean', t.depthToNeighbor, 'buccolingual', ['crown.depth']],
    ['relative-height', 'Crown top above site vs neighbour mean height', t.heightToNeighbor, 'top', ['crown.height', 'abutment.height']],
  ] as const) {
    const neighbor = measured(id, 'neighborMean');
    add(id, { id, label, component: 'crown', actual: measured(id, 'emitted') ?? num(extents?.[extentKey]), lower: mul(neighbor, ratio[0]), upper: mul(neighbor, ratio[1]), units: 'file units (u)', controls: [...controls] });
  }
  const gap = measured('space-occupancy', 'gapWidth'), headroom = measured('space-occupancy', 'availableHeight');
  add('space-occupancy', { id: 'space-occupancy.mesiodistal', label: 'Crown mesiodistal extent vs gap envelope', component: 'crown', actual: num(extents?.mesiodistal),
    lower: mul(gap, t.gapOccupancy[0]), upper: mul(gap, t.gapOccupancy[1]), units: 'file units (u)', controls: ['crown.width'] });
  add('space-occupancy', { id: 'space-occupancy.vertical', label: 'Crown top vs sampled antagonist headroom', component: 'crown', actual: num(extents?.top),
    lower: null, upper: mul(headroom, t.heightOccupancyMax), units: 'file units (u)', controls: ['crown.height', 'abutment.height'] });
  for (const side of ['mesial', 'distal'] as const) {
    const excess = measured('proximal-contacts', `${side}Excess`);
    add('proximal-contacts', { id: `proximal-contacts.${side}`, label: `Sampled ${side} distance beyond target gap (not contact area)`, component: 'crown', actual: excess,
      lower: null, upper: mul(num(extents?.mesiodistal), t.proximalOpenFraction), units: 'file units (u)', controls: ['crown.width'] });
  }
  add('occlusal-contact', { id: 'occlusal-contact.coverage', label: 'Occlusal ray hit fraction on antagonist (static, sampled)', component: 'crown',
    actual: measured('occlusal-contact', 'occlusalCoverage'), lower: t.minOcclusalCoverage, upper: null, units: 'fraction', controls: ['crown.height'] });
  add('occlusal-contact', { id: 'occlusal-contact.gap', label: 'Smallest sampled occlusal ray gap (target gap not projected)', component: 'crown',
    actual: measured('occlusal-contact', 'sampledOcclusalGap'), lower: null, upper: null, units: 'file units (u)', controls: ['crown.height'] });
  add('interference', { id: 'interference.crossings', label: 'Transverse triangle crossings with target surfaces', component: 'crown',
    actual: measured('interference', 'crossingTriangles'), lower: null, upper: 0, units: 'count', controls: ['crown.width', 'crown.depth', 'crown.height'] });
  add('anatomy', { id: 'anatomy.donor-anisotropy', label: 'Donor axis-scale anisotropy', component: 'crown',
    actual: measured('anatomy', 'donorAnisotropy'), lower: null, upper: t.maxAnisotropy, units: 'ratio', controls: ['crown.width', 'crown.depth', 'crown.height'] });
  add('anatomy', { id: 'anatomy.proportion-skew', label: 'Crown MD/BL proportion vs neighbours', component: 'crown',
    actual: measured('anatomy', 'proportionSkew'), lower: 1 / t.maxProportionSkew, upper: t.maxProportionSkew, units: 'ratio', controls: ['crown.width', 'crown.depth'] });
  const footprint = measured('component-presentation', 'crownHalfFootprint');
  const support = criterion('component-support');
  const supportRow = numericRow({ id: 'component-support.pilar-enclosure',
    label: 'Pilar support samples outside crown (sampled enclosure only)', component: 'abutment', source: 'quality',
    actual: measured('component-support', 'supportSamples') ? measured('component-support', 'outsideSamples') : null,
    lower: null, upper: 0, units: 'count', controls: ['abutment.radius', 'abutment.emergenceRadius', 'abutment.height', 'abutment.angleX', 'abutment.angleY'] },
  support?.status === 'pass', support?.reasons.join(' ').slice(0, 1000)
    ?? 'No current independent emitted pilar/crown-support measurement; obtain a fresh audit. Gum evidence is separate.');
  // Keep the complete audit status/reasons, including a positive witness in an
  // otherwise incomplete audit; a numeric zero alone never establishes support.
  supportRow.feedback = (support?.reasons.join(' ') ?? supportRow.feedback).slice(0, 1000);
  rows.push(supportRow);
  add('component-presentation', { id: 'component-presentation.pilar-protrusion', label: 'Observed pilar protrusion (sampled, not wall thickness)', component: 'abutment',
    actual: measured('component-presentation', 'sampledPilarProtrusion'), lower: null, upper: 0, units: 'file units (u)', controls: ['abutment.radius', 'abutment.emergenceRadius'] });
  add('component-presentation', { id: 'component-presentation.abutment-slope', label: 'Generic abutment slope (prototype tolerance)', component: 'abutment',
    actual: measured('component-presentation', 'abutmentSlope'), lower: null, upper: t.maxAbutmentAngle, units: 'degrees', controls: ['abutment.angleX', 'abutment.angleY'] });
  for (const [id, label, componentKind, value, controls] of [
    ['abutment-radius', 'Nominal abutment top radius vs emitted crown half-footprint', 'abutment', parameters?.abutment.radius, ['abutment.radius', 'crown.width', 'crown.depth']],
    ['emergence-radius', 'Nominal emergence radius vs emitted crown half-footprint', 'abutment', parameters?.abutment.emergenceRadius, ['abutment.emergenceRadius', 'crown.width', 'crown.depth']],
    ['fixture-radius', 'Nominal generic fixture radius vs emitted crown half-footprint', 'fixture', parameters?.fixture.radius, ['fixture.radius', 'crown.width', 'crown.depth']],
  ] as const) add('component-presentation', { id: `component-presentation.${id}`, label, component: componentKind, actual: num(value), lower: null,
    upper: id === 'emergence-radius' && measured('component-presentation', 'transgingivalBaseExcluded') === 1 ? null : footprint,
    units: 'file units (u)', controls: [...controls], strictUpper: id !== 'fixture-radius' });
  add('component-presentation', { id: 'component-presentation.fixture-diameter', label: 'Nominal generic fixture diameter vs gap envelope (not root clearance)', component: 'fixture',
    actual: mul(num(parameters?.fixture.radius), 2), lower: null, upper: gap, units: 'file units (u)', controls: ['fixture.radius'], strictUpper: true });
  add('conflicting-targets', { id: 'conflicting-targets.width', label: 'Crown mesiodistal extent vs combined admissible range', component: 'crown', actual: num(extents?.mesiodistal),
    lower: measured('conflicting-targets', 'widthLow'), upper: measured('conflicting-targets', 'widthHigh'), units: 'file units (u)', controls: ['crown.width'] });
  add('conflicting-targets', { id: 'conflicting-targets.top', label: 'Crown top vs combined admissible range', component: 'crown', actual: num(extents?.top),
    lower: measured('conflicting-targets', 'topLow'), upper: measured('conflicting-targets', 'topHigh'), units: 'file units (u)', controls: ['crown.height', 'abutment.height'] });

  rows.push(...restorationFitFeedbackRows(report, measurement, context));

  // Clinical placement targets stay millimetre case feedback; v1 never measures them and
  // never converts file units, so actual remains null and status unknown. No editable controls.
  for (const issue of report.guardrails?.issues ?? []) {
    if (issue.id !== 'subcrestal-placement' && issue.id !== 'adjacent-root-clearance') continue;
    const target = issue.target.units === 'mm' ? num(issue.target.value) : null;
    rows.push(numericRow({ id: `guardrail.${issue.id}`, label: issue.id === 'subcrestal-placement' ? 'Implant platform depth below reviewed bone crest' : 'Implant outer surface clearance to each adjacent root',
      component: 'fixture', actual: null, lower: target, upper: null, target, units: 'mm', source: 'clinical-case-feedback', controls: [] }, false,
    issue.id === 'subcrestal-placement'
      ? 'Verify physical scale and registration, review the bone crest and platform/axis, and measure signed platform depth below that crest. The site origin, gingiva and nominal fixture.depth are not bone-crest measurements.'
      : 'Verify physical scale and registration and review EACH adjacent root. Measure the current fixture outer surface to every root separately. Visible tooth/crown gaps and fixture-axis distances cannot establish root clearance.'));
  }
  return rows.map(row => restorationFeedbackRowSchema.parse(row));
}

/** Opaque, stable target key; reordering/removing a target must not compare different surfaces. */
export function restorationFeedbackTargetId(id: string): string {
  let a = 2166136261, b = 3335557771;
  for (let i = 0; i < id.length; i++) { a = Math.imul(a ^ id.charCodeAt(i), 16777619); b = Math.imul(b ^ id.charCodeAt(i), 2246822519); }
  return `target-${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}

/** Each named surface is judged separately; minima across surfaces cannot hide a failure. */
export function restorationFitFeedbackRows(report: RestorationQualityReport | null | undefined, measurement?: RestorationFitMeasurement | null,
  context?: FeedbackContext | null): RestorationFeedbackRow[] {
  if (!report || !measurement) return [];
  const rows: RestorationFeedbackRow[] = [], t = report.tolerances, extents = report.crownExtents;
  const biteVerified = context?.bitePoseVerified ?? (report.criteria.find(item => item.id === 'occlusal-contact')?.status === 'pass');
  measurement.surfaces.forEach((surface, index) => {
    const key = `${restorationFeedbackTargetId(surface.id)}.${surface.role}.${surface.side ?? 'unsided'}`;
    const label = `Target ${index + 1} (${surface.role}${surface.side ? `, ${surface.side}` : ''}${surface.sourceRegion ? ', crown body' : ''})`;
    const transverse = num(surface.transverseCrossingTriangles);
    const forbiddenTouch = ['tissue', 'other-tooth', 'source-arch'].includes(surface.role);
    const crossings = transverse ?? (forbiddenTouch && surface.intersectingTriangles > 0 ? num(surface.intersectingTriangles) : null);
    const tested = surface.intersectionComplete && transverse !== null;
    const controls: RestorationFeedbackControl[] = surface.role === 'antagonist' ? ['crown.height', 'abutment.height']
      : surface.role === 'adjacent' ? ['crown.width', 'abutment.angleY'] : ['crown.width', 'crown.depth', 'crown.height', 'abutment.height'];
    const base = { component: 'crown' as const, source: 'fit-measurement' as const, controls };
    rows.push(numericRow({ ...base, id: `${key}.crossings`, label: `${label}: transverse crossing triangles`, actual: crossings,
      target: 0, lower: null, upper: 0, units: 'count' }, tested,
    'The intersection check is capped or lacks a transverse-crossing classification. Finish and classify the target test; no observed crossing is not clearance.'));
    if (surface.role === 'adjacent') {
      const actual = surface.samples > 0 ? num(surface.sampledMinDistance) : null, target = num(surface.targetGap);
      const tolerance = mul(num(extents?.mesiodistal), t.proximalOpenFraction);
      rows.push(numericRow({ ...base, id: `${key}.proximal-gap`, label: `${label}: minimum sampled proximal distance`, actual,
        target, lower: null, upper: target === null || tolerance === null ? null : target + tolerance, units: 'file units (u)' },
      !!surface.side && tested && crossings === 0, !surface.side ? 'Review this target as mesial or distal before using it as proximal-contact evidence.'
        : 'Resolve this target crossing audit and minimum sampled gap. A close minimum is not broad contact fit, contact area or evidence for another target.', !surface.side));
    }
    if (surface.role === 'antagonist') {
      const samples = num(surface.occlusalRaySamples), hits = num(surface.occlusalRayHits);
      const validRays = samples !== null && samples > 0 && hits !== null && hits >= 0 && hits <= samples;
      const coverage = validRays ? hits! / samples! : null;
      const gap = validRays && hits! > 0 ? num(surface.sampledOcclusalGap) : null, target = num(surface.targetGap);
      const tolerance = mul(num(extents?.occlusal), t.occlusalOpenFraction);
      const missing = gap === null ? 'No valid forward-ray hit and finite gap for this antagonist. Misses are unknown, never clearance; review target coverage and remeasure.'
        : 'Verify the static bite pose and complete crossing tests for this antagonist before claiming its contact target is met.';
      const canPass = biteVerified && tested && crossings === 0 && !!extents;
      rows.push(numericRow({ ...base, id: `${key}.occlusal-coverage`, label: `${label}: forward occlusal ray hit fraction`, actual: coverage,
        lower: t.minOcclusalCoverage, upper: null, units: 'fraction' }, canPass, missing, gap === null));
      rows.push(numericRow({ ...base, id: `${key}.occlusal-gap`, label: `${label}: sampled forward occlusal gap`, actual: gap,
        target, lower: null, upper: target === null || tolerance === null ? null : target + tolerance, units: 'file units (u)' }, canPass, missing));
    }
  });
  return rows;
}

const observation = restorationFeedbackRowSchema.pick({ actual: true, error: true, status: true, lower: true, upper: true,
  target: true, units: true, exclusiveUpper: true });
export const restorationFeedbackChangeSchema = z.strictObject({
  id: restorationFeedbackRowSchema.shape.id, before: observation.nullable(), after: observation.nullable(),
  actualDelta: finite.nullable(), errorDelta: finite.nullable(),
  trend: z.enum(['improved', 'worsened', 'unchanged', 'unknown']),
});
export type RestorationFeedbackChange = z.infer<typeof restorationFeedbackChangeSchema>;

/** Display deltas, not an acceptance policy. Changed bounds/evidence never imply improvement. */
export function compareRestorationFeedback(before: readonly RestorationFeedbackRow[], after: readonly RestorationFeedbackRow[], epsilon = 1e-9): RestorationFeedbackChange[] {
  const ids = [...new Set([...before.map(row => row.id), ...after.map(row => row.id)])];
  const pick = (row?: RestorationFeedbackRow) => row ? { actual: row.actual, error: row.error, status: row.status,
    lower: row.lower, upper: row.upper, target: row.target, units: row.units, exclusiveUpper: row.exclusiveUpper } : null;
  return ids.map(id => {
    const a = before.find(row => row.id === id), b = after.find(row => row.id === id);
    let trend: RestorationFeedbackChange['trend'] = 'unknown';
    const sameBasis = !!a && !!b && a.units === b.units && a.lower === b.lower && a.upper === b.upper && a.target === b.target && a.exclusiveUpper === b.exclusiveUpper;
    const actualDelta = a?.actual != null && b?.actual != null && a.units === b.units ? num(b.actual - a.actual) : null;
    const errorDelta = sameBasis && a.error !== null && b.error !== null ? num(b.error - a.error) : null;
    if (sameBasis && a.error !== null && b.error !== null && a.status !== 'unknown' && b.status !== 'unknown') {
      const delta = Math.abs(b.error) - Math.abs(a.error);
      trend = delta < -epsilon ? 'improved' : delta > epsilon ? 'worsened' : a.status === b.status ? 'unchanged' : b.status === 'fail' ? 'worsened' : a.status === 'fail' ? 'improved' : 'unchanged';
    }
    return { id, before: pick(a), after: pick(b), actualDelta, errorDelta, trend };
  });
}
