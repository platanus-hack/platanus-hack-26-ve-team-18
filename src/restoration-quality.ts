import type { ArchToothSegment } from './arch-analysis';
import type { SiteHypothesis } from './missing-sites';
import type { RestorationFitMeasurement, RestorationMesh, RestorationSpec, RestorationSurfaceFitMeasurement } from './restoration-types';
import { crownSupportRegion, crownTissueRegions } from './restoration-geometry.ts';
import { measureClosedCrownPoints } from './restoration-gingiva.ts';
import type { FixtureGingivaControl } from './restoration-gingiva.ts';
import type { Vec3 } from './models';
import { Vector3 } from 'three';
import { createNearestSurfaceQuery } from './collision.ts';
import { toothClassOf } from './crown-anatomy.ts';
import { restorationCrownShape } from './restoration-geometry.ts';
import { evaluateRestorationGuardrails } from './restoration-guardrails.ts';
import type { RestorationGuardrailReport, RestorationPlacementFeedback } from './restoration-guardrails';

/**
 * Independent restoration quality evaluator.
 *
 * Deterministic and pure: it reads a generated spec/mesh, an optional existing
 * fit measurement and optional explicitly measured neighbour/space evidence,
 * and reports pass/fail/unknown per rule. It never reads or trusts the fit
 * optimizer's score. Missing evidence is `unknown`, never `pass`. Tolerances
 * are unitless engineering prototype ratios, not clinical limits; raw values
 * stay in file units.
 */
export const RESTORATION_QUALITY_VERSION = 'restoration-quality/v1' as const;
export const RESTORATION_QUALITY_CONTEXT_VERSION = 'restoration-quality-context/v1' as const;
export type QualityStatus = 'pass' | 'fail' | 'unknown';
export type QualityRuleId = 'relative-width' | 'relative-depth' | 'relative-height' | 'space-occupancy'
  | 'proximal-contacts' | 'occlusal-contact' | 'interference' | 'conflicting-targets' | 'anatomy' | 'component-presentation' | 'component-support';
export const QUALITY_RULES: readonly QualityRuleId[] = ['relative-width', 'relative-depth', 'relative-height', 'space-occupancy',
  'proximal-contacts', 'occlusal-contact', 'interference', 'conflicting-targets', 'anatomy', 'component-presentation', 'component-support'];
export type QualityProvenance = 'measured' | 'hypothesized';
export interface QualityEvidenceValue { value: number; method: string; provenance: QualityProvenance }
export interface QualityNeighborEvidence {
  id: string;
  side?: 'mesial' | 'distal';
  /** File units; null when unavailable. Compared with EMITTED crown extents along the site frame. */
  mesiodistal: number | null;
  buccolingual: number | null;
  /** Crown relief above the neighbour's cervical estimate, compared with the restoration's top above the site origin. */
  height: number | null;
  method: string;
  provenance: QualityProvenance;
}
/** JSON-safe; suitable for persisting with a spec for later retries. */
export interface RestorationQualityContext {
  version: typeof RESTORATION_QUALITY_CONTEXT_VERSION;
  units: 'file units (u)';
  neighbors: QualityNeighborEvidence[];
  /** Surface-derived mesiodistal envelope at the site (never a centroid or arc span). */
  gapWidth: QualityEvidenceValue | null;
  /** Sampled antagonist headroom above the site origin along `up`. */
  availableHeight: QualityEvidenceValue | null;
  /** Sides expected to carry a proximal contact. Absent means both. Empty means none identified (unknown). */
  expectedProximalSides?: ('mesial' | 'distal')[];
  /** False when bite/headroom evidence comes from an unverified pose; such a bite can never pass. */
  bitePoseVerified?: boolean;
  /** Optional case feedback (wording may be confirmed), reported only; never a fitting objective or clinical verification. */
  placementFeedback?: RestorationPlacementFeedback;
}
export interface RestorationQualityTolerances {
  /** Emitted MD extent / mean neighbour MD. */
  widthToNeighbor: [number, number];
  /** Emitted BL extent / mean neighbour BL. */
  depthToNeighbor: [number, number];
  /** Restoration top above site / mean neighbour height. */
  heightToNeighbor: [number, number];
  /** Emitted MD extent / measured gap envelope. */
  gapOccupancy: [number, number];
  /** Maximum restoration top / measured available height. */
  heightOccupancyMax: number;
  /** Maximum (sampled proximal distance − target gap) / emitted MD extent before a contact counts as open. */
  proximalOpenFraction: number;
  /** Maximum (sampled occlusal ray gap − target gap) / emitted crown occlusal extent. */
  occlusalOpenFraction: number;
  /** Minimum occlusal ray hit fraction for antagonist coverage. */
  minOcclusalCoverage: number;
  /** Maximum ratio between the largest and smallest donor axis scale. */
  maxAnisotropy: number;
  /** Maximum MD/BL proportion skew relative to the neighbours' mean proportion. */
  maxProportionSkew: number;
  /** Maximum √(angleX² + angleY²) for the generic abutment slope, degrees (construction prototype, not a screw-channel rule). */
  maxAbutmentAngle: number;
  /** Maximum relative change of one revision for a length parameter. */
  maxRevisionStep: number;
  /** Maximum change of one revision for an angle parameter, degrees. */
  maxRevisionAngle: number;
  maxRevisions: number;
}
export const DEFAULT_QUALITY_TOLERANCES: Readonly<RestorationQualityTolerances> = Object.freeze({
  widthToNeighbor: [0.7, 1.35], depthToNeighbor: [0.8, 1.2], heightToNeighbor: [0.75, 1.15],
  gapOccupancy: [0.9, 1.0], heightOccupancyMax: 1.0,
  proximalOpenFraction: 0.03, occlusalOpenFraction: 0.05, minOcclusalCoverage: 0.25,
  maxAnisotropy: 1.3, maxProportionSkew: 1.25, maxAbutmentAngle: 25,
  maxRevisionStep: 0.1, maxRevisionAngle: 3, maxRevisions: 6,
}) as Readonly<RestorationQualityTolerances>;
export interface RestorationQualityInput {
  spec: RestorationSpec;
  /** Components generated from exactly `spec`. */
  components: RestorationMesh[];
  /** Fit measurement for exactly these components; its score is ignored. */
  measurement?: RestorationFitMeasurement | null;
  context?: RestorationQualityContext | null;
  tolerances?: Partial<RestorationQualityTolerances>;
}
/** Emitted crown vertices projected onto the site frame, file units. */
export interface CrownExtents { mesiodistal: number; buccolingual: number; occlusal: number; base: number; top: number }
export interface QualityCriterion { id: QualityRuleId; status: QualityStatus; reasons: string[]; measured: Record<string, number | null> }
export type QualityParameter = 'crown.width' | 'crown.depth' | 'crown.height' | 'abutment.height' | 'abutment.radius'
  | 'abutment.emergenceRadius' | 'abutment.angleX' | 'abutment.angleY' | 'fixture.radius';
export interface QualityRevision {
  parameter: QualityParameter;
  current: number;
  /** Bounded by maxRevisionStep/maxRevisionAngle; callers still clamp to their own global bounds. */
  proposed: number;
  rules: QualityRuleId[];
  reason: string;
}
export interface RestorationQualityReport {
  version: typeof RESTORATION_QUALITY_VERSION;
  /** pass only when every rule passes; any fail => fail; otherwise unknown. */
  status: QualityStatus;
  units: 'file units (u)';
  tolerances: RestorationQualityTolerances;
  crownExtents: CrownExtents | null;
  criteria: QualityCriterion[];
  revisions: QualityRevision[];
  /** Parameters for which rules requested opposite directions; no revision is proposed for them. */
  unresolvedRevisionConflicts: string[];
  limits: string[];
  /** Additive v1 extension. Absent in older saves; fresh evaluations always populate it.
   * Kept separate so missing clinical evidence does not change fitting selection/revisions. */
  guardrails?: RestorationGuardrailReport;
}

/** Additive required check. Old reports remain readable but never acquire a
 * support pass merely because the former presentation heuristics passed. */
export function unmeasuredPilarCrownSupport(reason = 'The independent emitted pilar/crown-support audit has not completed for this geometry.'): QualityCriterion {
  return { id: 'component-support', status: 'unknown', reasons: [reason], measured: {
    supportSamples: null, enclosedSamples: null, outsideSamples: null, unknownSamples: null,
    sampledMinInternalClearance: null, sampledMaxOutsideDistance: null, numericTolerance: null,
    seatingDatum: null, supportTop: null,
  } };
}

/** Worker-only cooperative measurement. No gum, nominal radius or nearest
 * normal substitutes for containment of the actual emitted support samples. */
export async function measurePilarCrownSupport(input: Pick<RestorationQualityInput, 'spec' | 'components'>,
  control: FixtureGingivaControl = {}): Promise<QualityCriterion> {
  const result = unmeasuredPilarCrownSupport();
  const pillars = input.components.filter(mesh => mesh.component === 'abutment');
  const crowns = input.components.filter(mesh => mesh.component === 'crown');
  const pillar = pillars.length === 1 ? pillars[0] : undefined;
  if (!pillar?.closed || !pillar.positions.length || pillar.positions.length % 9 || !pillar.positions.every(Number.isFinite)) {
    result.reasons = ['Missing, open, duplicate or invalid emitted pilar; support is unknown.']; return result;
  }
  const region = crownSupportRegion(input.spec, pillar);
  const points: Vec3[] = [];
  for (let i = 0; i < region.positions.length; i += 3) points.push([region.positions[i], region.positions[i + 1], region.positions[i + 2]]);
  const measured = await measureClosedCrownPoints(crowns.length === 1 ? crowns[0] : undefined, points, control, region.numericTolerance);
  const enclosed = measured.samples.filter(sample => sample.status === 'enclosed');
  const outside = measured.samples.filter(sample => sample.status === 'outside');
  const unknown = measured.samples.length - enclosed.length - outside.length;
  result.status = outside.length ? 'fail' : points.length && !unknown ? 'pass' : 'unknown';
  result.measured = { supportSamples: points.length, enclosedSamples: enclosed.length, outsideSamples: outside.length, unknownSamples: unknown,
    sampledMinInternalClearance: enclosed.length ? Math.min(...enclosed.map(sample => sample.distance!)) : null,
    sampledMaxOutsideDistance: outside.length ? Math.max(...outside.map(sample => sample.distance!)) : null,
    numericTolerance: measured.numericTolerance === null ? region.numericTolerance : Math.max(region.numericTolerance, measured.numericTolerance),
    seatingDatum: region.seatingDatum, supportTop: region.supportTop };
  result.reasons = [
    `${outside.length} outside, ${enclosed.length} enclosed and ${unknown} unknown of ${points.length} distinct emitted pilar vertices strictly above the crown seating datum ${region.seatingDatum} u. The transgingival base is excluded; gum evidence is not required.`,
    ...measured.limits,
    'Actual closed, consistently joined, nondegenerate crown triangles; unsigned nearest-boundary distance and three agreeing non-edge ray parities. Boundary proximity, grazing, open/numeric/timeout evidence stays unknown. Intended same-assembly overlap is separate from external tooth/tissue crossings.',
    'These are sampled enclosure and internal sample clearances only: not continuous enclosure, wall thickness, contact area, overlap volume, seating, intaglio, hardware compatibility or clinical emergence.',
  ];
  return result;
}

/** Attach only the audit measured for the caller's current emitted candidate. */
export function applyPilarCrownSupport(report: RestorationQualityReport, support: QualityCriterion): RestorationQualityReport {
  if (support.id !== 'component-support') throw new Error('Expected an independent pilar crown-support criterion.');
  const criteria = [...report.criteria.filter(row => row.id !== support.id).map(row => row.id === 'component-presentation'
    && row.measured.transgingivalBaseExcluded === 1 ? { ...row, measured: { ...row.measured,
      sampledPilarProtrusion: support.status === 'pass' ? 0 : support.measured.sampledMaxOutsideDistance } } : row), support];
  return { ...report, criteria, status: criteria.some(row => row.status === 'fail') ? 'fail'
    : criteria.every(row => row.status === 'pass') ? 'pass' : 'unknown' };
}

type Range = [number, number];
const UNITS = 'file units (u)' as const;
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const fmt = (value: number) => Number(value.toPrecision(4)).toString();
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const combine = (statuses: QualityStatus[]): QualityStatus => statuses.includes('fail') ? 'fail' : statuses.length && statuses.every(status => status === 'pass') ? 'pass' : 'unknown';
const dot3 = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function tolerancesOf(overrides: Partial<RestorationQualityTolerances> = {}): RestorationQualityTolerances {
  const result = { ...DEFAULT_QUALITY_TOLERANCES, ...overrides } as RestorationQualityTolerances;
  for (const key of ['widthToNeighbor', 'depthToNeighbor', 'heightToNeighbor', 'gapOccupancy'] as const) {
    const range = result[key];
    if (!Array.isArray(range) || range.length !== 2 || !positive(range[0]) || !positive(range[1]) || range[0] > range[1]) throw new Error(`Quality tolerance ${key} must be a positive [low, high] ratio.`);
    result[key] = [range[0], range[1]];
  }
  for (const key of ['heightOccupancyMax', 'proximalOpenFraction', 'occlusalOpenFraction', 'maxAnisotropy', 'maxProportionSkew', 'maxAbutmentAngle', 'maxRevisionStep', 'maxRevisionAngle'] as const) {
    if (!positive(result[key])) throw new Error(`Quality tolerance ${key} must be positive and finite.`);
  }
  if (result.maxAnisotropy < 1 || result.maxProportionSkew < 1) throw new Error('Anisotropy and proportion skew tolerances must be at least 1.');
  if (result.maxRevisionStep >= 1) throw new Error('Quality tolerance maxRevisionStep must be below 1.');
  if (!(Number.isFinite(result.minOcclusalCoverage) && result.minOcclusalCoverage >= 0 && result.minOcclusalCoverage <= 1)) throw new Error('Quality tolerance minOcclusalCoverage must be in [0, 1].');
  if (!Number.isSafeInteger(result.maxRevisions) || result.maxRevisions < 0 || result.maxRevisions > 16) throw new Error('Quality tolerance maxRevisions must be an integer in [0, 16].');
  return result;
}

/** Crown parameters are template scales; only emitted vertices give actual extents. */
export function measureCrownExtents(spec: RestorationSpec, components: RestorationMesh[]): CrownExtents | null {
  const crown = components?.find(component => component.component === 'crown');
  const { origin, u, v, up } = spec.frame;
  if (!crown || !crown.positions.length) return null;
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity], delta = [0, 0, 0];
  for (let i = 0; i < crown.positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) delta[axis] = crown.positions[i + axis] - origin[axis];
    const local = [dot3(delta, u), dot3(delta, v), dot3(delta, up)];
    for (let axis = 0; axis < 3; axis++) { low[axis] = Math.min(low[axis], local[axis]); high[axis] = Math.max(high[axis], local[axis]); }
  }
  if (![...low, ...high].every(Number.isFinite)) return null;
  return { mesiodistal: high[0] - low[0], buccolingual: high[1] - low[1], occlusal: high[2] - low[2], base: low[2], top: high[2] };
}

/** Map a measured arch tooth segment into neighbour evidence. */
export function qualityNeighborFromSegment(segment: Pick<ArchToothSegment, 'id' | 'fdi' | 'mdWidth' | 'blWidth' | 'height'>, side?: 'mesial' | 'distal', partId = ''): QualityNeighborEvidence {
  const value = (number: number) => positive(number) ? number : null;
  return { id: `${partId ? `${partId}:` : ''}T${segment.id}${segment.fdi ? `:FDI-${segment.fdi}` : ''}`, ...(side ? { side } : {}),
    mesiodistal: value(segment.mdWidth), buccolingual: value(segment.blWidth), height: value(segment.height),
    method: 'Arch segment crown arc span, mid-crown cross-section width and relief above the estimated cervical level.', provenance: 'measured' };
}

/** Builds evidence from a site hypothesis. Centroid gaps and nonpositive envelopes are not used as space evidence; only explicitly measured values (and headroom in a verified pose) are labeled measured. */
export function qualityContextFromSite(site: SiteHypothesis, neighbors: QualityNeighborEvidence[]): RestorationQualityContext {
  const gap = site.space?.proximalGap, vertical = site.space?.vertical;
  const gapWidth = gap && positive(gap.value) && !/centroid/i.test(gap.method) ? { value: gap.value, method: gap.method, provenance: gap.provenance === 'measured' ? 'measured' as const : 'hypothesized' as const } : null;
  const availableHeight = vertical && positive(vertical.value) ? { value: vertical.value, method: vertical.method, provenance: vertical.provenance === 'measured' && site.opposing?.poseVerified ? 'measured' as const : 'hypothesized' as const } : null;
  return { version: RESTORATION_QUALITY_CONTEXT_VERSION, units: UNITS, neighbors: neighbors.map(neighbor => ({ ...neighbor })), gapWidth, availableHeight,
    expectedProximalSides: (['mesial', 'distal'] as const).filter(side => !!site.adjacent?.[side]),
    bitePoseVerified: !!site.opposing?.poseVerified };
}

/** Fewer failures first, then fewer unknowns. 0 means quality cannot separate them. */
export function compareQualityReports(a: RestorationQualityReport, b: RestorationQualityReport): number {
  const count = (report: RestorationQualityReport, status: QualityStatus) => report.criteria.filter(criterion => criterion.status === status).length;
  return (count(a, 'fail') - count(b, 'fail')) || (count(a, 'unknown') - count(b, 'unknown'));
}

interface Proposal { parameter: QualityParameter; current: number; target: number; rule: QualityRuleId; reason: string; angle?: boolean }

export function evaluateRestorationQuality(input: RestorationQualityInput): RestorationQualityReport {
  const tolerances = tolerancesOf(input.tolerances);
  const { spec } = input;
  const p = spec.parameters;
  const limits: string[] = [
    'Independent engineering prototype check; clinical fit, occlusal loading, tissue response and hardware compatibility remain unassessed.',
    'Tolerances are configurable unitless ratios, not clinical or manufacturer limits; raw measurements are file units, never assumed millimeters.',
    'The fit optimizer score is not read. A lower score does not imply any rule passes.',
    'Distances are sampled triangle-centroid measurements; they are not contact area, overlap volume or penetration depth.',
  ];
  const extents = measureCrownExtents(spec, input.components);
  const context = usableContext(input.context, limits);
  const measurement = input.measurement && Array.isArray(input.measurement.surfaces) ? input.measurement : null;
  if (!measurement) limits.push('No fit measurement was supplied; contact, bite and interference rules are unknown.');
  const proposals: Proposal[] = [];
  const criteria: QualityCriterion[] = [];
  const conflicts: string[] = [];

  const neighborMean = (key: 'mesiodistal' | 'buccolingual' | 'height') => {
    const used = (context?.neighbors ?? []).filter(neighbor => positive(neighbor[key]));
    // Anything not explicitly measured is a hypothesis and can never upgrade a rule to pass.
    return used.length ? { value: mean(used.map(neighbor => neighbor[key] as number)), count: used.length, measured: used.every(neighbor => neighbor.provenance === 'measured') } : null;
  };
  const md = neighborMean('mesiodistal'), bl = neighborMean('buccolingual'), nh = neighborMean('height');
  const gap = context?.gapWidth?.value ?? null, available = context?.availableHeight?.value ?? null;
  const gapMeasured = context?.gapWidth?.provenance === 'measured';
  const availableMeasured = context?.availableHeight?.provenance === 'measured' && context.bitePoseVerified === true;
  // Hard space bounds win over neighbour proportions when both are known.
  const intersect = (ranges: Range[]): Range | null => ranges.length ? [Math.max(...ranges.map(r => r[0])), Math.min(...ranges.map(r => r[1]))] : null;
  const mdRanges: Range[] = [], spaceMd = gap !== null ? [gap * tolerances.gapOccupancy[0], gap * tolerances.gapOccupancy[1]] as Range : null;
  if (spaceMd) mdRanges.push(spaceMd);
  if (md) mdRanges.push([md.value * tolerances.widthToNeighbor[0], md.value * tolerances.widthToNeighbor[1]]);
  let mdBounds = intersect(mdRanges);
  if (mdBounds && mdBounds[0] > mdBounds[1]) {
    conflicts.push(`Neighbour-relative width range and measured gap occupancy range do not overlap (gap ${fmt(gap!)} u, neighbour mean MD ${fmt(md!.value)} u); the space bound is used for revisions.`);
    mdBounds = spaceMd;
  }
  const topRanges: Range[] = [];
  if (available !== null) topRanges.push([0, available * tolerances.heightOccupancyMax]);
  if (nh) topRanges.push([nh.value * tolerances.heightToNeighbor[0], nh.value * tolerances.heightToNeighbor[1]]);
  let topBounds = intersect(topRanges);
  if (topBounds && topBounds[0] > topBounds[1]) {
    conflicts.push(`Neighbour-relative height floor ${fmt(nh!.value * tolerances.heightToNeighbor[0])} u exceeds measured available height ceiling ${fmt(available! * tolerances.heightOccupancyMax)} u.`);
    topBounds = [0, available! * tolerances.heightOccupancyMax];
  }
  const clampTo = (value: number, bounds: Range | null) => bounds ? Math.min(bounds[1], Math.max(bounds[0], value)) : value;
  // Targets sit slightly inside a violated bound so the next round is not on the edge.
  const inward = (value: number, range: Range) => value < range[0] ? range[0] + (range[1] - range[0]) * .25 : value > range[1] ? range[1] - (range[1] - range[0]) * .25 : value;
  const proposeWidth = (targetMd: number, rule: QualityRuleId, reason: string) => {
    if (!extents) return;
    proposals.push({ parameter: 'crown.width', current: p.crown.width, target: p.crown.width * clampTo(targetMd, mdBounds) / extents.mesiodistal, rule, reason });
  };
  const proposeTop = (targetTop: number, rule: QualityRuleId, reason: string) => {
    if (!extents || !(extents.occlusal > 0)) return;
    const occlusal = extents.occlusal + clampTo(targetTop, topBounds) - extents.top;
    if (occlusal > 0) proposals.push({ parameter: 'crown.height', current: p.crown.height, target: p.crown.height * occlusal / extents.occlusal, rule, reason });
  };

  // Relative neighbour ceilings and floors.
  const relative = (id: QualityRuleId, label: string, value: number | undefined, reference: { value: number; count: number; measured: boolean } | null, range: Range, propose: (target: number) => void): QualityCriterion => {
    const reasons: string[] = [];
    if (!extents || value === undefined) return { id, status: 'unknown' as const, reasons: ['No emitted crown geometry is available.'], measured: {} };
    if (!reference) return { id, status: 'unknown' as const, reasons: [`No measured neighbour ${label} is available; the crown ${label} is not judged.`], measured: { emitted: value, neighborMean: null, ratio: null } };
    const ratio = value / reference.value;
    let status: QualityStatus = 'pass';
    if (ratio < range[0] || ratio > range[1]) {
      status = 'fail';
      reasons.push(`Emitted ${label} ${fmt(value)} u is ${fmt(ratio)}× the mean of ${reference.count} neighbour value(s) (${fmt(reference.value)} u); allowed ${range[0]}–${range[1]}×.`);
      propose(inward(ratio, range) * reference.value);
    } else reasons.push(`Emitted ${label} is ${fmt(ratio)}× the neighbour mean, within ${range[0]}–${range[1]}×.`);
    if (status === 'pass' && !reference.measured) { status = 'unknown'; reasons.push(`Neighbour ${label} evidence is not entirely measured; a hypothesis cannot pass this rule.`); }
    return { id, status, reasons, measured: { emitted: value, neighborMean: reference.value, ratio } };
  };
  criteria.push(relative('relative-width', 'mesiodistal extent', extents?.mesiodistal, md, tolerances.widthToNeighbor,
    target => proposeWidth(target, 'relative-width', 'Bring mesiodistal extent toward the neighbour-relative range.')));
  criteria.push(relative('relative-depth', 'buccolingual extent', extents?.buccolingual, bl, tolerances.depthToNeighbor,
    target => extents && proposals.push({ parameter: 'crown.depth', current: p.crown.depth, target: p.crown.depth * target / extents.buccolingual, rule: 'relative-depth', reason: 'Bring buccolingual extent toward the neighbour-relative range.' })));
  criteria.push(relative('relative-height', 'height above the site', extents?.top, nh, tolerances.heightToNeighbor,
    target => proposeTop(target, 'relative-height', 'Bring the restoration top toward the neighbour-relative height range.')));

  // Space occupancy against measured envelopes.
  {
    const reasons: string[] = [], statuses: QualityStatus[] = [];
    const occupancy = extents && gap !== null ? extents.mesiodistal / gap : null;
    const vertical = extents && available !== null ? extents.top / available : null;
    if (!extents) { statuses.push('unknown'); reasons.push('No emitted crown geometry is available.'); }
    if (occupancy === null) { statuses.push('unknown'); reasons.push('No measured surface gap envelope; mesiodistal occupancy is unknown.'); }
    else if (occupancy < tolerances.gapOccupancy[0]) {
      statuses.push('fail'); reasons.push(`Mesiodistal underfill: emitted extent occupies ${fmt(occupancy)}× of the ${fmt(gap!)} u gap envelope (minimum ${tolerances.gapOccupancy[0]}×).`);
      proposeWidth(inward(occupancy, tolerances.gapOccupancy) * gap!, 'space-occupancy', 'Fill the measured gap envelope.');
    } else if (occupancy > tolerances.gapOccupancy[1]) {
      statuses.push('fail'); reasons.push(`Mesiodistal overfill: emitted extent is ${fmt(occupancy)}× the ${fmt(gap!)} u gap envelope (maximum ${tolerances.gapOccupancy[1]}×).`);
      proposeWidth(inward(occupancy, tolerances.gapOccupancy) * gap!, 'space-occupancy', 'Stay inside the measured gap envelope.');
    } else {
      statuses.push(gapMeasured ? 'pass' : 'unknown');
      reasons.push(`Mesiodistal occupancy ${fmt(occupancy)}× of the gap envelope${gapMeasured ? '' : '; the gap envelope is not measured, so this cannot pass'}.`);
    }
    if (vertical === null) { statuses.push('unknown'); reasons.push('No measured antagonist headroom; vertical occupancy is unknown.'); }
    else if (vertical > tolerances.heightOccupancyMax + 1e-9) {
      statuses.push('fail'); reasons.push(`Vertical overfill: top ${fmt(extents!.top)} u is ${fmt(vertical)}× the ${fmt(available!)} u sampled headroom.`);
      proposeTop(available! * tolerances.heightOccupancyMax * .98, 'space-occupancy', 'Stay below the sampled antagonist headroom.');
    } else {
      statuses.push(availableMeasured ? 'pass' : 'unknown');
      reasons.push(`Top uses ${fmt(vertical)}× of sampled headroom${availableMeasured ? '' : '; headroom is provisional, so this cannot pass'}.`);
    }
    criteria.push({ id: 'space-occupancy', status: combine(statuses), reasons, measured: { mesiodistalOccupancy: occupancy, verticalOccupancy: vertical, gapWidth: gap, availableHeight: available } });
  }

  // Proximal contacts.
  const surfaces = measurement?.surfaces ?? [];
  const crossing = (surface: RestorationSurfaceFitMeasurement) => (surface.transverseCrossingTriangles ?? 0) > 0;
  const sideOf = (side: 'mesial' | 'distal') => surfaces.filter(surface => surface.role === 'adjacent' && surface.side === side);
  const sideExcess: Record<'mesial' | 'distal', number | null> = { mesial: null, distal: null };
  const sideCrossing: Record<'mesial' | 'distal', boolean> = { mesial: false, distal: false };
  {
    const reasons: string[] = [], statuses: QualityStatus[] = [], measured: Record<string, number | null> = {};
    const expected = context ? context.expectedProximalSides ?? ['mesial', 'distal'] : ['mesial', 'distal'] as const;
    if (!measurement) { statuses.push('unknown'); reasons.push('No fit measurement.'); }
    else if (!extents) { statuses.push('unknown'); reasons.push('No emitted crown geometry is available.'); }
    else if (!expected.length) { statuses.push('unknown'); reasons.push('No flanking neighbour was identified; proximal contacts are unknown.'); }
    else for (const side of expected) {
      const targets = sideOf(side);
      if (!targets.length) { statuses.push('unknown'); reasons.push(`No ${side} adjacent target was measured.`); measured[`${side}Excess`] = null; continue; }
      const excess = Math.max(...targets.map(surface => surface.sampledMinDistance - surface.targetGap));
      sideExcess[side] = excess; sideCrossing[side] = targets.some(crossing);
      measured[`${side}Excess`] = excess; measured[`${side}OpenFraction`] = excess / extents.mesiodistal;
      if (sideCrossing[side]) { statuses.push('fail'); reasons.push(`${side} overcontact: transverse triangle crossings with the adjacent surface.`); }
      else if (excess > tolerances.proximalOpenFraction * extents.mesiodistal) {
        statuses.push('fail'); reasons.push(`${side} contact open: sampled distance exceeds the ${fmt(targets[0].targetGap)} u target by ${fmt(excess)} u (${fmt(excess / extents.mesiodistal)}× MD extent; maximum ${tolerances.proximalOpenFraction}×).`);
      } else if (targets.some(surface => !(surface.samples > 0) || !Number.isFinite(surface.sampledMinDistance)
        || !surface.intersectionComplete || surface.transverseCrossingTriangles === undefined)) {
        statuses.push('unknown'); reasons.push(`${side} proximity does not establish contact: samples or complete classified intersection evidence are missing.`);
      } else { statuses.push('pass'); reasons.push(`${side} contact within ${fmt(Math.max(0, excess))} u of the target gap (sampled, not contact area).`); }
    }
    for (const surface of surfaces) if (surface.role === 'adjacent' && !surface.side) reasons.push(`${surface.id} has no mesial/distal side and is not used as contact evidence.`);
    if (extents && measurement) {
      const open = (side: 'mesial' | 'distal') => sideExcess[side] !== null && !sideCrossing[side] && sideExcess[side]! > tolerances.proximalOpenFraction * extents.mesiodistal;
      const tight = (side: 'mesial' | 'distal') => sideCrossing[side] || (sideExcess[side] !== null && sideExcess[side]! <= 0);
      if (open('mesial') && open('distal')) {
        const target = extents.mesiodistal + sideExcess.mesial! + sideExcess.distal!;
        if (mdBounds && extents.mesiodistal >= mdBounds[1] * (1 - 1e-6)) conflicts.push('Both proximal contacts are open while the mesiodistal extent is already at its space/neighbour ceiling.');
        else proposeWidth(target, 'proximal-contacts', 'Close both open proximal contacts.');
      } else if (open('mesial') && tight('distal') || open('distal') && tight('mesial')) {
        const toward = open('mesial') ? 1 : -1;
        const shift = toward * sideExcess[toward > 0 ? 'mesial' : 'distal']! / 2;
        proposeShift(shift, 'Translate the crown toward the open contact via the generic abutment slope.');
      } else if (sideCrossing.mesial && sideCrossing.distal) proposeWidth(extents.mesiodistal * (1 - tolerances.maxRevisionStep / 2), 'proximal-contacts', 'Relieve crossings on both proximal sides.');
    }
    criteria.push({ id: 'proximal-contacts', status: combine(statuses), reasons, measured });
  }
  function proposeShift(shift: number, reason: string) {
    if (!(p.abutment.height > 0)) return;
    const mesial = spec.anatomicalSigns?.mesial ?? 1, angle = p.abutment.angleY * Math.PI / 180;
    const target = Math.atan((p.abutment.height * Math.tan(angle) + shift * mesial) / p.abutment.height) * 180 / Math.PI;
    proposals.push({ parameter: 'abutment.angleY', current: p.abutment.angleY, target, rule: 'proximal-contacts', reason, angle: true });
  }

  // Occlusal contact and antagonist coverage.
  {
    const reasons: string[] = [], statuses: QualityStatus[] = [];
    const antagonists = surfaces.filter(surface => surface.role === 'antagonist');
    let gapValue: number | null = null, coverage: number | null = null;
    if (!measurement) { statuses.push('unknown'); reasons.push('No fit measurement.'); }
    else if (!antagonists.length) { statuses.push('unknown'); reasons.push('No antagonist target was measured; the bite is unknown.'); }
    else if (!extents) { statuses.push('unknown'); reasons.push('No emitted crown geometry is available.'); }
    else {
      // Each antagonist target is judged on its own rays; a hit on one target
      // never earns coverage or contact for another.
      const openExcesses: number[] = [], gaps: number[] = [], coverages: number[] = [];
      for (const surface of antagonists) {
        const samples = surface.occlusalRaySamples ?? 0, hits = surface.occlusalRayHits ?? 0, value = surface.sampledOcclusalGap;
        const validRays = Number.isSafeInteger(samples) && samples > 0 && Number.isSafeInteger(hits) && hits >= 0 && hits <= samples;
        const coverageOf = validRays ? hits / samples : null;
        if (coverageOf !== null) coverages.push(coverageOf);
        if (crossing(surface)) { statuses.push('fail'); reasons.push(`${surface.id}: antagonist overcontact (transverse triangle crossings).`); continue; }
        if (!surface.intersectionComplete || surface.transverseCrossingTriangles === undefined) {
          statuses.push('unknown'); reasons.push(`${surface.id}: complete classified intersection evidence is missing; sampled proximity cannot pass contact.`);
        }
        if (coverageOf === null || hits === 0 || typeof value !== 'number' || !Number.isFinite(value)) {
          statuses.push('unknown'); reasons.push(`${surface.id}: no forward occlusal ray reached this antagonist; misses are unknown, not clearance.`); continue;
        }
        gaps.push(value);
        if (coverageOf < tolerances.minOcclusalCoverage) { statuses.push('fail'); reasons.push(`${surface.id}: antagonist coverage underfill, ${fmt(coverageOf)} of occlusal rays hit (minimum ${tolerances.minOcclusalCoverage}).`); }
        const excess = value - surface.targetGap;
        if (excess > tolerances.occlusalOpenFraction * extents.occlusal) {
          statuses.push('fail'); openExcesses.push(excess);
          reasons.push(`${surface.id}: occlusal underfill, sampled ray gap ${fmt(value)} u exceeds the ${fmt(surface.targetGap)} u target by ${fmt(excess)} u (maximum ${tolerances.occlusalOpenFraction}× crown occlusal extent).`);
        } else { statuses.push('pass'); reasons.push(`${surface.id}: sampled occlusal ray gap ${fmt(value)} u is within tolerance of the ${fmt(surface.targetGap)} u target.`); }
      }
      gapValue = gaps.length ? Math.min(...gaps) : null;
      coverage = coverages.length ? Math.min(...coverages) : null;
      if (antagonists.some(crossing)) proposeTop(extents.top - extents.occlusal * tolerances.maxRevisionStep / 2, 'occlusal-contact', 'Reduce occlusal height to relieve antagonist crossings.');
      else if (openExcesses.length) {
        if (topBounds && extents.top >= topBounds[1] * (1 - 1e-6)) conflicts.push('Occlusal contact is open while the restoration top is already at its headroom/neighbour ceiling.');
        else proposeTop(extents.top + Math.min(...openExcesses), 'occlusal-contact', 'Raise occlusal height toward the observed antagonist.');
      }
      if (context?.bitePoseVerified !== true) {
        statuses.push('unknown');
        reasons.push(context?.bitePoseVerified === false ? 'Bite pose is unverified; a static bite cannot pass.' : 'Bite pose verification was not supplied; a static bite cannot pass.');
      }
    }
    criteria.push({ id: 'occlusal-contact', status: combine(statuses), reasons, measured: { sampledOcclusalGap: gapValue, occlusalCoverage: coverage } });
  }

  // Interference.
  {
    const reasons: string[] = [], statuses: QualityStatus[] = [];
    let crossings = 0;
    if (!measurement) { statuses.push('unknown'); reasons.push('No fit measurement.'); }
    else if (!surfaces.length) { statuses.push('unknown'); reasons.push('No target surface was measured.'); }
    for (const surface of surfaces) {
      const transverse = surface.transverseCrossingTriangles;
      if (transverse !== undefined ? transverse > 0 : surface.intersectingTriangles > 0 && ['tissue', 'other-tooth', 'source-arch'].includes(surface.role)) {
        crossings += transverse ?? surface.intersectingTriangles;
        statuses.push('fail'); reasons.push(`${surface.id} (${surface.role}): ${transverse ?? surface.intersectingTriangles} crossing triangle(s).`);
        if (surface.role === 'tissue' || surface.role === 'source-arch') {
          if (topBounds && extents && extents.top >= topBounds[1] * (1 - 1e-6)) conflicts.push(`${surface.id} crossing cannot be relieved by raising the crown base: the top is at its ceiling.`);
          else proposals.push({ parameter: 'abutment.height', current: p.abutment.height, target: p.abutment.height * (1 + tolerances.maxRevisionStep / 2), rule: 'interference', reason: 'Raise the crown base away from crossed basal surface.' });
        }
      } else if (surface.intersectingTriangles > 0 && surface.role === 'other-tooth') {
        statuses.push('fail'); reasons.push(`${surface.id}: touches a non-flanking tooth.`);
      } else if (!surface.intersectionComplete) {
        // No crossing was observed in the capped test; touches do not prove the untested pairs are clear.
        statuses.push('unknown'); reasons.push(`${surface.id}: intersection test was capped with no observed transverse crossing; untested pairs are not clearance.`);
      } else if (surface.intersectingTriangles > 0 && transverse === undefined) {
        statuses.push('unknown'); reasons.push(`${surface.id}: legacy intersection count cannot separate contact from crossing.`);
      } else if (surface.intersectingTriangles > 0 && surface.role === 'source-arch') {
        statuses.push('unknown'); reasons.push(`${surface.id}: touching unclassified arch surface is ambiguous.`);
      } else statuses.push('pass');
    }
    if (statuses.length && statuses.every(s => s === 'pass')) reasons.push('No transverse crossings in the tested triangle pairs (not clinical clearance).');
    criteria.push({ id: 'interference', status: combine(statuses), reasons, measured: { crossingTriangles: measurement ? crossings : null } });
  }

  // Anatomy: class consistency, donor anisotropy and neighbour proportions.
  {
    const reasons: string[] = [], statuses: QualityStatus[] = [], measured: Record<string, number | null> = {};
    let shape: ReturnType<typeof restorationCrownShape> | null = null;
    try { shape = restorationCrownShape(spec); } catch { /* reported below */ }
    if (!shape) { statuses.push('unknown'); reasons.push('Crown anatomy could not be resolved.'); }
    else {
      if (!spec.draftIdentity && toothClassOf(spec.fdi) !== spec.anatomy) { statuses.push('fail'); reasons.push(`Anatomy class ${spec.anatomy} does not match FDI ${spec.fdi} (${toothClassOf(spec.fdi)}).`); }
      if (shape.source.kind === 'patient-donor') {
        const scales = [p.crown.width / shape.dims[0], p.crown.depth / shape.dims[1], p.crown.height / shape.dims[2]];
        const anisotropy = Math.max(...scales) / Math.min(...scales);
        measured.donorAnisotropy = anisotropy;
        if (anisotropy > tolerances.maxAnisotropy) {
          statuses.push('fail'); reasons.push(`Donor axis scales ${scales.map(fmt).join(' / ')} distort anatomy ${fmt(anisotropy)}× (maximum ${tolerances.maxAnisotropy}×).`);
          const centre = Math.sqrt(Math.max(...scales) * Math.min(...scales));
          const keys = ['crown.width', 'crown.depth', 'crown.height'] as const, values = [p.crown.width, p.crown.depth, p.crown.height];
          const index = scales.reduce((best, scale, i) => Math.abs(Math.log(scale / centre)) > Math.abs(Math.log(scales[best] / centre)) ? i : best, 0);
          proposals.push({ parameter: keys[index], current: values[index], target: values[index] * centre / scales[index], rule: 'anatomy', reason: 'Reduce donor axis-scale distortion.' });
        } else { statuses.push('pass'); reasons.push(`Patient donor anatomy with axis-scale anisotropy ${fmt(anisotropy)}×; resampled donor, not an exact reconstruction.`); }
      } else { statuses.push('unknown'); reasons.push('Procedural template anatomy: realistic anatomy is not demonstrated; review exported cusps/ridges/fossae or use a suitable donor.'); }
      if (extents && md && bl) {
        const skew = (extents.mesiodistal / extents.buccolingual) / (md.value / bl.value);
        measured.proportionSkew = skew;
        if (skew > tolerances.maxProportionSkew || skew < 1 / tolerances.maxProportionSkew) {
          statuses.push('fail'); reasons.push(`MD/BL proportion is ${fmt(skew)}× the neighbours' proportion (allowed ${fmt(1 / tolerances.maxProportionSkew)}–${tolerances.maxProportionSkew}×).`);
          const widthRatio = extents.mesiodistal / md.value, depthRatio = extents.buccolingual / bl.value;
          const target = Math.sqrt(widthRatio * depthRatio);
          if (Math.abs(Math.log(widthRatio / target)) >= Math.abs(Math.log(depthRatio / target))) proposeWidth(target * md.value, 'anatomy', 'Restore neighbour-like MD/BL proportion.');
          else proposals.push({ parameter: 'crown.depth', current: p.crown.depth, target: p.crown.depth * target * bl.value / extents.buccolingual, rule: 'anatomy', reason: 'Restore neighbour-like MD/BL proportion.' });
        } else if (!md.measured || !bl.measured) { statuses.push('unknown'); reasons.push('MD/BL proportion relies on hypothesized neighbour evidence; it cannot pass.'); }
      } else reasons.push('Neighbour MD/BL proportion is unavailable.');
    }
    criteria.push({ id: 'anatomy', status: combine(statuses), reasons, measured });
  }

  // Fixture/pillar presentation.
  {
    const reasons: string[] = [], statuses: QualityStatus[] = [];
    for (const kind of ['fixture', 'abutment', 'crown'] as const) {
      const component = input.components?.find(c => c.component === kind);
      if (!component) { statuses.push('fail'); reasons.push(`Missing separate ${kind} component.`); }
      else if (!component.closed) { statuses.push('fail'); reasons.push(`${kind} component is not closed.`); }
    }
    // A broad emergence collar must not inflate the body footprint and excuse
    // an oversized pilar. Measure the anatomical body independently.
    const crown = input.components?.find(component => component.component === 'crown');
    const bodyExtents = crown ? measureCrownExtents(spec, [{ ...crown, positions: crownTissueRegions(spec, crown).body }]) : null;
    const footprint = bodyExtents ? Math.min(bodyExtents.mesiodistal, bodyExtents.buccolingual) / 2 : null;
    if (footprint === null) { statuses.push('unknown'); reasons.push('No emitted crown footprint.'); }
    else {
      for (const [key, value, label] of [['abutment.radius', p.abutment.radius, 'Abutment top radius'], ['abutment.emergenceRadius', p.abutment.emergenceRadius, 'Emergence radius']] as const) {
        if (spec.componentDesign === 'nested-support/v1' && key === 'abutment.emergenceRadius') continue;
        if (value >= footprint) {
          statuses.push('fail'); reasons.push(`${label} ${fmt(value)} u reaches the crown half-footprint ${fmt(footprint)} u; the pillar would show or overcontour.`);
          proposals.push({ parameter: key, current: value, target: footprint * .85, rule: 'component-presentation', reason: `Keep the ${label.toLowerCase()} inside the crown footprint.` });
        }
      }
      if (p.fixture.radius > footprint) {
        statuses.push('fail'); reasons.push(`Fixture radius ${fmt(p.fixture.radius)} u exceeds the crown half-footprint ${fmt(footprint)} u.`);
        proposals.push({ parameter: 'fixture.radius', current: p.fixture.radius, target: footprint * .85, rule: 'component-presentation', reason: 'Keep the generic fixture envelope within the crown footprint.' });
      }
    }
    // Sample the emitted pillar against the actual cervical/collar surface.
    // Maximum MD/BL footprint alone misses a core emerging through a narrowed
    // cervical contour. This detects observed protrusion, not wall thickness.
    const pillar = input.components?.find(component => component.component === 'abutment');
    let sampledPilarProtrusion: number | null = null;
    if (spec.componentDesign !== 'nested-support/v1' && crown?.closed && pillar?.closed && crown.positions.length && pillar.positions.length
      && crown.positions.length % 9 === 0 && pillar.positions.length % 9 === 0
      && crown.positions.every(Number.isFinite) && pillar.positions.every(Number.isFinite)) {
      const nearest = createNearestSurfaceQuery(crown.positions), point = new Vector3(), hit = new Vector3(), normal = new Vector3();
      const tolerance = Math.max(...spec.frame.origin.map(Math.abs), ...crown.dimensions, p.abutment.height) * 2 ** -20;
      const seen = new Set<string>();
      for (let i = 0; i < pillar.positions.length; i += 3) {
        point.fromArray(pillar.positions, i);
        const z = (point.x - spec.frame.origin[0]) * spec.frame.up[0] + (point.y - spec.frame.origin[1]) * spec.frame.up[1] + (point.z - spec.frame.origin[2]) * spec.frame.up[2];
        if (z <= tolerance) continue;
        const key = `${point.x},${point.y},${point.z}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!Number.isFinite(nearest.nearestPoint(point, hit, normal))) continue;
        const outside = point.sub(hit).dot(normal);
        sampledPilarProtrusion = Math.max(sampledPilarProtrusion ?? 0, outside > tolerance ? outside : 0);
      }
      if (sampledPilarProtrusion !== null && sampledPilarProtrusion > 0) {
        statuses.push('fail'); reasons.push(`Emitted pilar samples protrude ${fmt(sampledPilarProtrusion)} u through the cervical/collar surface. Reduce the pilar or revise the cervical contour; the outer body footprint cannot establish enclosure.`);
        proposals.push({ parameter: 'abutment.radius', current: p.abutment.radius, target: p.abutment.radius * .85, rule: 'component-presentation', reason: 'Reduce observed pilar protrusion through the cervical/collar envelope.' });
      }
    }
    const slope = Math.hypot(p.abutment.angleX, p.abutment.angleY);
    if (slope > tolerances.maxAbutmentAngle) {
      statuses.push('fail'); reasons.push(`Generic abutment slope ${fmt(slope)}° exceeds the ${tolerances.maxAbutmentAngle}° prototype presentation tolerance.`);
      const scale = tolerances.maxAbutmentAngle * .9 / slope;
      for (const [key, value] of [['abutment.angleX', p.abutment.angleX], ['abutment.angleY', p.abutment.angleY]] as const) if (value) proposals.push({ parameter: key, current: value, target: value * scale, rule: 'component-presentation', reason: 'Reduce generic abutment slope.', angle: true });
    }
    if (gap === null) { statuses.push('unknown'); reasons.push('No gap envelope: fixture diameter relative to the space is unknown.'); }
    else if (2 * p.fixture.radius >= gap) { statuses.push('fail'); reasons.push(`Fixture diameter ${fmt(2 * p.fixture.radius)} u fills the ${fmt(gap)} u gap envelope.`); }
    else if (!gapMeasured) { statuses.push('unknown'); reasons.push('Fixture diameter fits only a hypothesized gap envelope; this cannot pass.'); }
    if (!statuses.length || statuses.every(s => s === 'pass')) { statuses.push('pass'); reasons.push(spec.componentDesign === 'nested-support/v1'
      ? 'Separate closed component envelopes and bounded nominal presentation. Core support is evaluated independently above the seating datum; the transgingival base need not be inside the crown.'
      : 'Separate closed component envelopes; no pilar protrusion observed at tested vertices. Unsampled enclosure, wall thickness, hardware compatibility and bone-safe placement remain unassessed.'); }
    criteria.push({ id: 'component-presentation', status: combine(statuses), reasons, measured: { crownHalfFootprint: footprint, abutmentSlope: slope, sampledPilarProtrusion,
      ...(spec.componentDesign === 'nested-support/v1' ? { transgingivalBaseExcluded: 1 } : {}) } });
  }

  // Conflicting targets.
  {
    const reasons = [...conflicts];
    for (const side of ['mesial', 'distal'] as const) if (sideOf(side).length > 1) {
      const values = sideOf(side).map(s => s.sampledMinDistance - s.targetGap);
      if (values.some(value => value <= 0) && extents && values.some(value => value > tolerances.proximalOpenFraction * extents.mesiodistal)) reasons.push(`Multiple ${side} targets disagree: one is in contact while another is open.`);
    }
    const evidence = !!extents && !!measurement && gap !== null && gapMeasured && available !== null && availableMeasured && !!md && md.measured;
    criteria.push({ id: 'conflicting-targets', status: reasons.length ? 'fail' : evidence ? 'pass' : 'unknown',
      reasons: reasons.length ? reasons : evidence ? ['Space, neighbour and measured targets admit a common bounded range.'] : ['Insufficient measured evidence to rule out conflicting targets (needs measured gap, headroom, neighbour widths and a fit measurement).'],
      measured: { widthLow: mdBounds?.[0] ?? null, widthHigh: mdBounds?.[1] ?? null, topLow: topBounds?.[0] ?? null, topHigh: topBounds?.[1] ?? null } });
  }

  const { revisions, unresolved } = mergeProposals(proposals, tolerances);
  // The independent worker audit is cooperative and must run on this exact
  // emitted candidate before a goal snapshot or agent admission. Synchronous
  // presentation heuristics cannot supply an enclosure pass.
  criteria.push(unmeasuredPilarCrownSupport());
  criteria.sort((a, b) => QUALITY_RULES.indexOf(a.id) - QUALITY_RULES.indexOf(b.id));
  return { version: RESTORATION_QUALITY_VERSION, status: combine(criteria.map(c => c.status)), units: UNITS, tolerances,
    crownExtents: extents, criteria, revisions, unresolvedRevisionConflicts: unresolved, limits,
    guardrails: evaluateRestorationGuardrails({ spec, components: input.components, criteria, measurement, placementFeedback: context?.placementFeedback }) };
}

function usableContext(context: RestorationQualityContext | null | undefined, limits: string[]): RestorationQualityContext | null {
  if (!context) { limits.push('No neighbour/space evidence was supplied; relative and occupancy rules are unknown.'); return null; }
  if (context.version !== RESTORATION_QUALITY_CONTEXT_VERSION || context.units !== UNITS || !Array.isArray(context.neighbors)) {
    limits.push('Quality context has an unsupported version or units and was ignored.'); return null;
  }
  const value = (evidence: QualityEvidenceValue | null) => {
    if (evidence === null || evidence === undefined) return null;
    if (positive(evidence.value)) return { ...evidence };
    limits.push('A nonpositive or nonfinite space measurement was ignored.'); return null;
  };
  const dimension = (number: number | null) => number === null || positive(number) ? number : null;
  return { ...context, gapWidth: value(context.gapWidth), availableHeight: value(context.availableHeight),
    neighbors: context.neighbors.map(neighbor => ({ ...neighbor, mesiodistal: dimension(neighbor.mesiodistal), buccolingual: dimension(neighbor.buccolingual), height: dimension(neighbor.height) })) };
}

function mergeProposals(proposals: Proposal[], tolerances: RestorationQualityTolerances) {
  const grouped = new Map<QualityParameter, Proposal[]>();
  for (const proposal of proposals) {
    if (!Number.isFinite(proposal.target) || Math.abs(proposal.target - proposal.current) <= 1e-9 * Math.max(1, Math.abs(proposal.current))) continue;
    grouped.set(proposal.parameter, [...(grouped.get(proposal.parameter) ?? []), proposal]);
  }
  const revisions: QualityRevision[] = [], unresolved: string[] = [];
  for (const [parameter, group] of grouped) {
    const current = group[0].current;
    const up = group.filter(g => g.target > current), down = group.filter(g => g.target < current);
    if (up.length && down.length) {
      unresolved.push(`${parameter}: ${[...new Set(up.map(g => g.rule))].join(', ')} request an increase while ${[...new Set(down.map(g => g.rule))].join(', ')} request a decrease.`);
      continue;
    }
    // The smallest requested change is the most conservative common step.
    const chosen = group.reduce((best, g) => Math.abs(g.target - current) < Math.abs(best.target - current) ? g : best);
    const proposed = chosen.angle
      ? current + Math.max(-tolerances.maxRevisionAngle, Math.min(tolerances.maxRevisionAngle, chosen.target - current))
      : current * Math.max(1 - tolerances.maxRevisionStep, Math.min(1 + tolerances.maxRevisionStep, chosen.target / current));
    revisions.push({ parameter, current, proposed, rules: [...new Set(group.map(g => g.rule))].sort((a, b) => QUALITY_RULES.indexOf(a) - QUALITY_RULES.indexOf(b)), reason: [...new Set(group.map(g => g.reason))].join(' ') });
  }
  revisions.sort((a, b) => QUALITY_RULES.indexOf(a.rules[0]) - QUALITY_RULES.indexOf(b.rules[0]) || a.parameter.localeCompare(b.parameter));
  return { revisions: revisions.slice(0, tolerances.maxRevisions), unresolved };
}
