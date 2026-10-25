import type { Vec3 } from './models';
import type { SurfaceAnchor, ToothRecord } from './tooth-types';
import type { ArchAnalysis, ArchModel, ArchToothSegment } from './arch-analysis.ts';
import { REFERENCE_MD, type ArchNumbering } from './tooth-numbering.ts';

/**
 * Missing-site hypotheses from tooth-level arch analyses.
 *
 * A site is a SPACE hypothesis on scanned ridge surface. One-flank terminal
 * regions are review candidates, not absent-tooth hypotheses. A separately
 * supported distal-extension slot is an illustrative draft, with unknown FDI.
 * A site is never
 * a clinical finding, never an implant indication,
 * and never changes the saved chart. Unscanned stretches, segmentation failures
 * and ambiguous identities are reported with their own statuses instead of
 * being turned into "missing" teeth.
 */
export type SiteStatus = 'proposed-missing' | 'dentist-confirmed-missing' | 'not-scanned' | 'segmentation-unresolved' | 'identity-unresolved';
export interface MeasuredValue { value: number | null; unit: 'file units (u)'; method: string; provenance?: 'measured' | 'hypothesized' | 'unknown'; sampleCount?: number }
/** Confidence is tooth identity confidence, not a probability of occlusal contact. */
export interface SiteNeighbour { toothId: number; fdi: number | null; partId: string; centroid: Vec3; confidence: number }
export interface SiteHypothesis {
  id: string;
  arch: 'upper' | 'lower';
  partId: string;
  fdi: number | null;
  /** Shape selection for an automatic visual draft; never asserts anatomical identity. */
  draftIdentity?: { templateFdi: number; alternatives: number[]; basis: string };
  alternatives: number[];
  status: SiteStatus;
  confidence: number;
  priority: 'high' | 'medium' | 'low';
  kind: 'bounded' | 'terminal' | 'distal-extension' | 'chart';
  slot: { index: number; count: number; s: [number, number] };
  evidence: { supporting: string[]; conflicting: string[] };
  anchor: SurfaceAnchor | null;
  patchFaces: Uint32Array;
  frame: { origin: Vec3; u: Vec3; v: Vec3; up: Vec3 } | null;
  frameBasis: string;
  /** Anatomical signs remain hypotheses even when the geometric frame is usable. */
  frameEvidence?: { status: 'hypothesized' | 'unavailable'; mesial: 'hypothesized' | 'unknown'; buccal: 'hypothesized' | 'unknown'; limitations: string[] };
  /** +1 when the frame's u axis points mesially (toward the midline). */
  mesialSign: 1 | -1;
  /** +1 when the frame's v axis points buccally. */
  buccalSign: 1 | -1;
  /** Immediate scanned neighbours only; internal consecutive-slot boundaries have none. */
  adjacent: { mesial: SiteNeighbour | null; distal: SiteNeighbour | null };
  opposing: { partId: string; teeth: SiteNeighbour[]; poseVerified: boolean } | null;
  contralateral: SiteNeighbour | null;
  space: { mesiodistal: MeasuredValue; proximalGap: MeasuredValue; buccolingual: MeasuredValue; vertical: MeasuredValue; crownHeight: MeasuredValue };
  questions: string[];
}
export interface SiteArchInput {
  partId: string;
  arch: 'upper' | 'lower';
  model: ArchModel;
  roleConfirmed?: boolean;
  analysis: ArchAnalysis;
  numbering: ArchNumbering;
  /** Column-major file-to-workspace rigid matrix; invalid poses disable cross-arch measurements. */
  pose: number[];
  identityConfidence: number;
  /** False for latent grouping without explicit patient-right confirmation. */
  identityConfirmed?: boolean;
  /** Original-order reviewed corrections; nonzero labels and protected zeros cannot support an automatic ridge. */
  reviewedLabels?: Uint8Array;
  reviewedMask?: Uint8Array;
  /** Per-candidate identities after applying reviewed corrections and conflicts. */
  identities?: Record<number, { fdi: number | null; confidence: number }>;
}
export interface SiteOptions {
  chart: Record<number, ToothRecord>;
  poseVerified: boolean;
}

type V = [number, number, number];
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: ArrayLike<number>): V => { const l = Math.hypot(a[0], a[1], a[2]); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1]; };
const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value));
const round = (value: number, digits = 3) => Number(value.toFixed(digits));
const UNIT = 'file units (u)' as const;
const measured = (value: number | null, method: string, provenance: 'measured' | 'hypothesized' = 'measured'): MeasuredValue => ({ value: value === null || !Number.isFinite(value) ? null : value, unit: UNIT, method, provenance: value === null || !Number.isFinite(value) ? 'unknown' : provenance });
const validFdi = (fdi: number) => Number.isInteger(fdi) && fdi % 10 >= 1 && fdi % 10 <= 8 && [1, 2, 3, 4].includes(Math.floor(fdi / 10));
function slotSpan(positions: (number | null)[], s0: number, s1: number, slot: number, arch: 'upper' | 'lower'): [number, number] {
  const widths = positions.map(fdi => fdi === null ? 1 : REFERENCE_MD[arch][fdi % 10 - 1]);
  const total = widths.reduce((sum, width) => sum + width, 0);
  const start = s0 + (s1 - s0) * widths.slice(0, slot).reduce((sum, width) => sum + width, 0) / total;
  return [start, start + (s1 - s0) * widths[slot] / total];
}

function transform(matrix: number[], point: ArrayLike<number>): V {
  return [0, 1, 2].map(r => matrix[r] * point[0] + matrix[4 + r] * point[1] + matrix[8 + r] * point[2] + matrix[12 + r]) as V;
}
function rotate(matrix: number[], direction: ArrayLike<number>): V {
  return [0, 1, 2].map(r => matrix[r] * direction[0] + matrix[4 + r] * direction[1] + matrix[8 + r] * direction[2]) as V;
}
/** Scaling, shear, reflection and projective matrices cannot be treated as rigid poses. */
export function isRigidPose(matrix: readonly number[]): boolean {
  if (matrix.length !== 16 || !matrix.every(Number.isFinite)) return false;
  const tolerance = 1e-5;
  if (Math.abs(matrix[3]) > tolerance || Math.abs(matrix[7]) > tolerance || Math.abs(matrix[11]) > tolerance || Math.abs(matrix[15] - 1) > tolerance) return false;
  const x = matrix.slice(0, 3), y = matrix.slice(4, 7), z = matrix.slice(8, 11);
  return [x, y, z].every(axis => Math.abs(dot(axis, axis) - 1) < tolerance)
    && Math.abs(dot(x, y)) < tolerance && Math.abs(dot(x, z)) < tolerance && Math.abs(dot(y, z)) < tolerance
    && Math.abs(dot(cross(x, y), z) - 1) < tolerance;
}
/** Inverse of a validated rigid column-major matrix. */
export function invertRigid(matrix: number[]): number[] {
  if (!isRigidPose(matrix)) throw new Error('A finite, proper rigid pose is required; source scale, reflection and shear are not supported.');
  const out = [matrix[0], matrix[4], matrix[8], 0, matrix[1], matrix[5], matrix[9], 0, matrix[2], matrix[6], matrix[10], 0, 0, 0, 0, 1];
  for (let i = 0; i < 3; i++) out[12 + i] = -(out[i] * matrix[12] + out[4 + i] * matrix[13] + out[8 + i] * matrix[14]);
  return out;
}
export function multiply(a: number[], b: number[]): number[] {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
}
export const mirrorFdi = (fdi: number) => { const q = Math.floor(fdi / 10); return ({ 1: 2, 2: 1, 3: 4, 4: 3 } as Record<number, number>)[q] * 10 + fdi % 10; };

function neighbour(tooth: ArchToothSegment | undefined, partId: string, confidence: number): SiteNeighbour | null {
  return tooth ? { toothId: tooth.id, fdi: tooth.fdi, partId, centroid: tooth.centroid, confidence } : null;
}

/** Group-level identity confidence for a tooth segment, from the numbering result. */
function toothConfidence(input: SiteArchInput, tooth: ArchToothSegment): number {
  if (input.identities?.[tooth.id]) return input.identities[tooth.id].confidence;
  const group = input.numbering.groups.find(group => group.kind === 'tooth' && group.fdi === tooth.fdi);
  return group ? group.confidence * input.identityConfidence : 0;
}

/** Clip an original triangle in local coordinates; long crossing faces are retained. */
function clipPolygon(polygon: V[], planes: number[][]): V[] {
  for (const [axis, side, limit] of planes) {
    const clipped: V[] = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length];
      const da = side * a[axis] - limit, db = side * b[axis] - limit;
      if (da <= 0) clipped.push(a);
      if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
        const t = da / (da - db);
        clipped.push(a.map((value, k) => value + t * (b[k] - value)) as V);
      }
    }
    polygon = clipped;
    if (!polygon.length) break;
  }
  return polygon;
}

/** Finite projection-region membership, never contact area or closest clearance. */
function overlapsSite(model: ArchModel, tooth: ArchToothSegment, relative: number[], origin: Vec3, u: V, v: V, up: V, width: number, depth: number, height: number): boolean {
  if (![width, depth, height].every(value => Number.isFinite(value) && value > 0)) return false;
  const planes = [[0, 1, 0.6 * width], [0, -1, 0.6 * width], [1, 1, 0.6 * depth], [1, -1, 0.6 * depth], [2, -1, 0], [2, 1, 3 * height]];
  let projectedArea = 0;
  for (const face of new Set(tooth.faces)) {
    const triangle: V[] = [0, 1, 2].map(corner => {
      const point = transform(relative, model.positions.subarray(face * 9 + corner * 3, face * 9 + corner * 3 + 3));
      const delta = point.map((value, axis) => value - origin[axis]);
      return [dot(delta, u), dot(delta, v), dot(delta, up)];
    });
    if (triangle.some(point => !point.every(Number.isFinite)) || planes.some(([axis, side, limit]) => triangle.every(point => side * point[axis] > limit))) continue;
    const polygon = clipPolygon(triangle, planes);
    let twiceArea = 0;
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length];
      twiceArea += a[0] * b[1] - b[0] * a[1];
    }
    projectedArea += Math.abs(twiceArea) / 2;
    // Used only to reject numerical/edge touches. Summed projections are not
    // a union area, and must not become contact area or a confidence score.
    if (projectedArea > 1e-8 * width * depth) return true;
  }
  return false;
}

/** Facing extrema of the original flank triangles inside a local crown-sized
 * slab. Linear clipping retains long triangles and is independent of face order
 * or tessellation. This is an axial envelope, not closest-surface clearance. */
function flankBounds(model: ArchModel, before: ArchToothSegment, after: ArchToothSegment, origin: Vec3, u: V, v: V, up: V, depth: number, height: number): [number, number] | null {
  const extent = (tooth: ArchToothSegment, sign: 1 | -1) => {
    let best = -Infinity;
    for (const face of tooth.faces) {
      let polygon: V[] = [0, 1, 2].map(corner => {
        const delta = [0, 1, 2].map(axis => model.positions[face * 9 + corner * 3 + axis] - origin[axis]);
        return [dot(delta, u), dot(delta, v), dot(delta, up)];
      });
      if (polygon.some(point => !point.every(Number.isFinite))) continue;
      polygon = clipPolygon(polygon, [[1, 1, depth / 2], [1, -1, depth / 2], [2, 1, height], [2, -1, 0]]);
      for (const point of polygon) best = Math.max(best, sign * point[0]);
    }
    return sign * best;
  };
  const left = extent(before, 1), right = extent(after, -1);
  return Number.isFinite(left) && Number.isFinite(right) ? [left, right] : null;
}

/**
 * Build site hypotheses for every analysed arch. Poses are only used to relate
 * arches to each other; all returned geometry stays in each part's source frame.
 */
export function proposeSites(arches: SiteArchInput[], options: SiteOptions): SiteHypothesis[] {
  const sites: SiteHypothesis[] = [];
  for (const input of arches) {
    const { model, analysis, numbering, arch } = input;
    const scale = model.scale, k = numbering.scale;
    const opposingCandidates = arches.filter(other => other.arch !== arch && other.roleConfirmed !== false);
    // Multiple opposite surfaces are ambiguous; never select an arbitrary component.
    const opposingCandidate = input.roleConfirmed !== false && opposingCandidates.length === 1 ? opposingCandidates[0] : undefined;
    const opposing = opposingCandidate && isRigidPose(input.pose) && isRigidPose(opposingCandidate.pose) ? opposingCandidate : undefined;
    const toothByFdi = new Map(analysis.teeth.filter(tooth => tooth.fdi !== null).map(tooth => [tooth.fdi!, tooth]));
    const sOrderIndex = (s: number) => model.sampleAt(s / scale);
    const apexS = analysis.anterior.apexS;
    const mesialSignAt = (s: number): 1 | -1 => {
      if (apexS !== null) return s < apexS ? 1 : -1;
      const anterior = analysis.anterior.direction;
      const tangent = analysis.curve.tangent[sOrderIndex(s)];
      return anterior && dot(anterior, tangent) < 0 ? -1 : 1;
    };
    const makeSite = (positions: (number | null)[], s0: number, s1: number, slotIndex: number, kind: 'bounded' | 'terminal' | 'distal-extension', groupConfidence: number, alternatives: number[], before: ArchToothSegment | undefined, after: ArchToothSegment | undefined) => {
      const fdi = positions[slotIndex];
      const [slot0, slot1] = slotSpan(positions, s0, s1, slotIndex, arch);
      const sc = (slot0 + slot1) / 2;
      const i = sOrderIndex(sc);
      const ridgeT = model.profile.topT[i];
      const [x, y] = model.at(sc / scale, ridgeT);
      const supporting: string[] = [], conflicting: string[] = [], questions: string[] = [];
      // Restorative axis: neighbours' occlusal axes when available, otherwise the arch occlusal axis.
      const usableAxis = (axis: Vec3) => axis.every(Number.isFinite) && Math.hypot(...axis) > 1e-6;
      const archUp = usableAxis(analysis.frame.up) ? unit(analysis.frame.up) : [0, 0, 0] as V;
      const axes = [before, after].filter((tooth): tooth is ArchToothSegment => !!tooth).map(tooth => tooth.axis).filter(axis => usableAxis(axis) && dot(unit(axis), archUp) >= 0.5);
      const summed = axes.reduce((sum, axis) => sum.map((value, k2) => value + unit(axis)[k2]) as V, [0, 0, 0] as V);
      const up = usableAxis(summed) ? unit(summed) : archUp;
      const tangent = analysis.curve.tangent[i];
      const projectedTangent = tangent.map((value, k2) => value - dot(tangent, up) * up[k2]);
      const validFrame = usableAxis(up) && projectedTangent.every(Number.isFinite) && Math.hypot(...projectedTangent) > 1e-6;
      const u = unit(projectedTangent);
      const v = cross(up, u);
      const lingual = analysis.curve.lingual[i];
      const buccalSign: 1 | -1 = dot(v, lingual) > 0 ? -1 : 1;
      const mesialSign = mesialSignAt(sc);
      // Ridge patch: non-crown faces inside the slot near the crest.
      const blNeighbours = [before, after].filter((tooth): tooth is ArchToothSegment => !!tooth).map(tooth => tooth.blWidth).filter(value => value > 0);
      const blEstimate = blNeighbours.length ? blNeighbours.reduce((a, b) => a + b, 0) / blNeighbours.length : analysis.scale.bandHalfWidth;
      const patch: number[] = [];
      const coveredBins = new Set<number>();
      let protectedFaces = 0;
      for (const f of model.mesh.valid) {
        const fs = model.faceS[f] * scale, ft = model.faceT[f] * scale;
        if (!(fs >= slot0 && (fs < slot1 || slotIndex === positions.length - 1 && fs <= slot1)) || Math.abs(ft - ridgeT * scale) > 0.6 * blEstimate) continue;
        if (input.reviewedLabels?.[f] || input.reviewedMask?.[f]) { protectedFaces++; continue; }
        // Only low ridge-like surface supports a site; boundary, debris and tooth faces do not.
        if (analysis.classes[f] !== 3) continue;
        patch.push(f);
        coveredBins.add(Math.min(4, Math.floor(5 * (fs - slot0) / (slot1 - slot0))));
      }
      const patchSet = new Set(patch);
      const found = model.surfaceAt(x, y, 3, face => patchSet.has(face));
      // Even a custom/test lookup must return an actual ridge face in this
      // slot. Surface lookup proximity alone does not establish ridge support.
      let surface = found && patchSet.has(found.face) ? found : null;
      // Scan edges, isolated scraps and elevated terminal tissue do not create
      // a review region. A terminal candidate needs a local low ridge patch.
      if (kind === 'terminal' && (!surface || patch.length < 3 || coveredBins.size < 3)) return;
      // A free-end illustration needs low ridge faces across the entire local
      // slot, not merely the three-bin threshold for a review region.
      if (kind === 'distal-extension' && (!surface || !validFrame || patch.length < 12 || coveredBins.size !== 5 || protectedFaces)) return;
      const neighbourHeights = [before, after].filter((tooth): tooth is ArchToothSegment => !!tooth).map(tooth => tooth.height).filter(value => value > 0 && Number.isFinite(value));
      const crownHeight = neighbourHeights.length ? neighbourHeights.reduce((a, b) => a + b, 0) / neighbourHeights.length : null;
      let proximalGap: number | null = null, surfaceCentered = false;
      if (surface && validFrame && before && after && positions.length === 1 && crownHeight !== null) {
        const bounds = flankBounds(model, before, after, surface.point, u, v, up, blEstimate, crownHeight);
        if (bounds) {
          if (bounds[1] > bounds[0]) {
            // Use the surface gap midpoint only when it can be localized to this
            // same ridge patch. A saved/chart anchor never passes through here.
            const midpoint = (bounds[0] + bounds[1]) / 2;
            const target = surface.point.map((value, axis) => value + midpoint * u[axis]) as V;
            const p = model.plan(target), candidate = model.surfaceAt(p[0], p[1], 3, face => patchSet.has(face));
            if (candidate && patchSet.has(candidate.face)) {
              const shift = dot(candidate.point.map((value, axis) => value - surface!.point[axis]), u);
              if (shift > bounds[0] && shift < bounds[1] && Math.abs(midpoint - shift) < Math.abs(midpoint)) {
                surface = candidate; surfaceCentered = true;
              }
            }
          }
          const finalBounds = flankBounds(model, before, after, surface.point, u, v, up, blEstimate, crownHeight);
          // Account for asymmetric room when the ridge projection cannot reach
          // the midpoint. The width is a symmetric envelope at the actual anchor.
          if (finalBounds) proximalGap = 2 * Math.min(-finalBounds[0], finalBounds[1]);
        }
      }
      if (protectedFaces) conflicting.push('Reviewed labels or protected corrections intersect this slot; they are excluded from automatic ridge evidence.');
      if (!validFrame) conflicting.push('The arch tangent is degenerate relative to the occlusal direction; no restorative frame is established.');
      // Measurements: arc span, neighbour cross-section width and vertical room to the opposing arch.
      const mdArc = slot1 - slot0;
      let vertical: number | null = null;
      let verticalSamples = 0;
      const opposingTeeth: SiteNeighbour[] = [];
      const oppositeAxis = opposing?.model.up ?? opposing?.analysis.frame.up;
      const alignment = opposing && oppositeAxis && usableAxis(oppositeAxis) ? -dot(rotate(multiply(invertRigid(opposing.pose), input.pose), up), unit(oppositeAxis)) : 0;
      const axesOpposed = alignment > 0.5;
      if (opposing && surface && validFrame && axesOpposed) {
        const relative = multiply(invertRigid(opposing.pose), input.pose);
        // Convert observed height-map points to heights above ONE site datum,
        // projected onto the restorative axis. This is a sampled envelope, not
        // a ray intersection or a guarantee between samples.
        let best = Infinity;
        for (const ds of [-0.3, 0, 0.3]) for (const dt of [-0.3, 0, 0.3]) {
          const target = surface.point.map((value, axis) => value + ds * (proximalGap !== null && proximalGap > 0 ? proximalGap : mdArc) * u[axis] + dt * blEstimate * v[axis]) as V;
          const [sx, sy] = model.plan(target);
          const sample = model.surfaceAt(sx, sy, 2, face => patchSet.has(face));
          if (!sample || !patchSet.has(sample.face)) continue;
          const p = opposing.model.plan(transform(relative, sample.point));
          const index = opposing.model.cellIndex(p[0], p[1]), h = opposing.model.H[index];
          // Interpolated height-map holes are useful for profiles but are not
          // observed antagonist surface samples.
          if (index >= 0 && (!opposing.model.occupied || opposing.model.occupied[index]) && Number.isFinite(h)) {
            const datum = dot(sample.point.map((value, axis) => value - surface!.point[axis]), up);
            best = Math.min(best, datum + (p[2] - h) * opposing.model.scale * alignment); verticalSamples++;
          }
        }
        vertical = Number.isFinite(best) ? best : null;
        const intoSite = multiply(invertRigid(input.pose), opposing.pose);
        const width = proximalGap !== null && proximalGap > 0 ? proximalGap : mdArc;
        const height = crownHeight !== null && crownHeight > 0 ? crownHeight : Math.max(width, blEstimate);
        for (const tooth of opposing.analysis.teeth) {
          if (!usableAxis(tooth.axis) || -dot(rotate(intoSite, unit(tooth.axis)), up) <= 0.5) continue;
          if (overlapsSite(opposing.model, tooth, intoSite, surface.point, u, v, up, width, blEstimate, height)) opposingTeeth.push(neighbour(tooth, opposing.partId, toothConfidence(opposing, tooth))!);
        }
      }
      if (opposing && !axesOpposed) conflicting.push('The proposed arch occlusal axes do not face each other in the current pose; vertical room is unavailable.');
      // Evidence.
      const expected = fdi === null ? null : k * REFERENCE_MD[arch][fdi % 10 - 1];
      const ratio = expected !== null && expected > 0 ? mdArc / expected : null;
      if (before && after) {
        const bounds = `crown segments ${before.fdi ? `FDI ${before.fdi}` : `T${before.id}`} and ${after.fdi ? `FDI ${after.fdi}` : `T${after.id}`}`;
        supporting.push(positions.length > 1 ? `Whole gap bounds are ${bounds}; they support aggregate sizing and frame context, not immediate contacts for every slot.` : `Bounded by ${bounds}.`);
      }
      else supporting.push(`Ridge continues ${mdArc.toFixed(2)} u beyond ${(before ?? after)?.fdi ? `FDI ${(before ?? after)!.fdi}` : 'the last crown'} with scanned surface.`);
      if (ratio !== null) supporting.push(`Arc span ${mdArc.toFixed(2)} u is ${ratio.toFixed(2)}× the proportion expected for FDI ${fdi} at this arch's fitted scale.`);
      if (surface) supporting.push(`Ridge surface found under the slot centre (${patch.length.toLocaleString('en-US')} ridge faces in the slot).`);
      else conflicting.push('No scanned surface under the slot centre.');
      if (opposingTeeth.length) supporting.push(`Candidate opposing crown segments ${opposingTeeth.map(tooth => tooth.fdi ? `FDI ${tooth.fdi}` : `T${tooth.toothId}`).join(', ')} have opposed axes and posed triangles intersecting the local projection region (0.6× width/depth either side and up to 3× the crown-height hypothesis above the ridge). This geometric filter does not establish contact or exact clearance; neighbour confidence describes identity only.`);
      else if (opposing) conflicting.push('No opposing crown segment met the local projection and axis bounds in this pose; this does not establish absence of an antagonist.');
      const contralateralTooth = fdi === null ? undefined : toothByFdi.get(mirrorFdi(fdi));
      if (contralateralTooth) supporting.push(`Contralateral FDI ${contralateralTooth.fdi} is a potential donor candidate; anatomy and segmentation suitability remain subject to review.`);
      if (ratio !== null && ratio < 0.6) conflicting.push('The space is much narrower than expected; neighbours may have drifted, or the identity may differ.');
      if (ratio !== null && ratio > 1.5) conflicting.push('The space is wider than one tooth; more than one position may be missing.');
      if (alternatives.length) { conflicting.push(`Alternative identities fit nearly as well: ${alternatives.map(value => `FDI ${value}`).join(', ')}.`); questions.push(`Which position is this space: ${[fdi, ...alternatives].map(value => `FDI ${value}`).join(' or ')}?`); }
      if (kind === 'terminal' || kind === 'distal-extension') {
        conflicting.push('Only one crown flank bounds this scanned terminal region. Retromolar/tuberosity tissue, incomplete segmentation or scan extent can explain it; this is insufficient evidence of a missing tooth or an implant indication.');
        if (fdi === null) conflicting.push('Terminal numbering is absent or unreliable; no absent FDI or tooth count is assigned.');
        supporting.push('Low review confidence describes localized ridge support, not the probability of tooth absence.');
        questions.push('Does this scanned terminal region represent a tooth-bearing ridge, retromolar/tuberosity tissue, or incomplete segmentation?', 'Does the scan cover the full region, and was a tooth previously present here?');
        if (fdi === null) questions.push('If a missing tooth is clinically confirmed, which position belongs to this region?');
      }
      if (!options.poseVerified && opposing) conflicting.push('The bite pose is not verified; opposing relationships are provisional.');
      if (!opposing && opposingCandidates.length) conflicting.push('Opposing relationships are unavailable: ambiguous sources or a non-rigid/invalid source pose.');
      if (positions.length > 1) supporting.push(`One of ${positions.length} hypothesized consecutive positions in this space (slot ${slotIndex + 1}).`);
      const chart = input.identityConfirmed === false || fdi === null ? undefined : options.chart[fdi];
      let status: SiteStatus = kind === 'terminal' || kind === 'distal-extension' ? 'identity-unresolved' : 'proposed-missing';
      if (chart?.status === 'missing' && kind === 'bounded') { status = 'dentist-confirmed-missing'; supporting.push('Dentist-recorded missing position.'); }
      if (chart?.status === 'present') { conflicting.push('The saved chart records this position as present.'); status = 'identity-unresolved'; }
      if (fdi !== null && analysis.teeth.some(tooth => tooth.fdi === fdi)) { conflicting.push('A crown region already carries this identity; the geometric sequence or reviewed correction conflicts with this gap.'); status = 'identity-unresolved'; }
      if (chart?.status === 'not-scanned') { status = 'not-scanned'; conflicting.push('The saved chart records this position as not scanned.'); }
      if (alternatives.length && groupConfidence < 0.5 && status === 'proposed-missing') status = 'identity-unresolved';
      const lengthFactor = ratio === null ? 1 : clamp(1 - Math.abs(Math.log(ratio)) / 1.2, 0.2, 1);
      let confidence = groupConfidence * lengthFactor * (surface ? 1 : 0.3) * input.identityConfidence;
      if (kind === 'terminal') confidence = Math.min(0.3, groupConfidence * lengthFactor);
      if (status === 'dentist-confirmed-missing') confidence = Math.max(confidence, 0.99);
      confidence = round(clamp(confidence));
      const thirdMolar = fdi !== null && fdi % 10 === 8;
      let priority: SiteHypothesis['priority'] = kind === 'terminal' || kind === 'distal-extension' || thirdMolar || status === 'not-scanned' ? 'low' : kind === 'bounded' && confidence >= 0.5 ? 'high' : 'medium';
      if (!surface || patch.length < 3 || coveredBins.size < 3 || protectedFaces > 0 || kind === 'bounded' && (!before || !after)) {
        if (status !== 'dentist-confirmed-missing' && status !== 'not-scanned') status = 'segmentation-unresolved';
        confidence = status === 'dentist-confirmed-missing' ? confidence : 0;
        if (status === 'segmentation-unresolved') priority = 'low';
        conflicting.push('Insufficient unconflicted ridge coverage across the slot; segmentation absence is not evidence of a missing tooth.');
      }
      const anchor: SurfaceAnchor | null = surface ? { partId: input.partId, face: surface.face, point: surface.point } : null;
      const contralateral = contralateralTooth ? neighbour(contralateralTooth, input.partId, toothConfidence(input, contralateralTooth)) : null;
      // Keep both flanks above for whole-gap geometry, but only the outer slots
      // touch scanned crowns. Slot order follows the curve, not numeric FDI order.
      const immediateBefore = slotIndex === 0 ? before : undefined;
      const immediateAfter = slotIndex === positions.length - 1 ? after : undefined;
      const [mesialTooth, distalTooth] = mesialSign === 1 ? [immediateAfter, immediateBefore] : [immediateBefore, immediateAfter];
      // An unreviewed filename role cannot establish cross-arch evidence, but
      // it can retain the same neutral local geometry draft as a bounded gap.
      // Keep the stronger opposing checks for an established source role.
      if (kind === 'distal-extension' && (!mesialTooth || distalTooth || input.roleConfirmed !== false
        && (!opposingTeeth.length || verticalSamples < 3 || vertical === null || vertical <= 0))) return;
      sites.push({
        id: `${arch}-${input.partId}-${kind === 'distal-extension' ? 'distal-draft' : 'gap'}-${s0.toPrecision(10)}-${s1.toPrecision(10)}-${slotIndex}`,
        arch, partId: input.partId, fdi, alternatives, status, confidence, priority, kind,
        slot: { index: slotIndex, count: positions.length, s: [slot0, slot1] },
        evidence: { supporting, conflicting }, anchor, patchFaces: Uint32Array.from(patch),
        frame: surface && validFrame ? { origin: surface.point, u, v, up } : null,
        frameBasis: `${axes.length ? `Restorative axis averaged from ${axes.length} neighbouring crown occlusal axes` : 'Arch occlusal axis'}; mesiodistal axis follows the fitted arch curve; origin uses the nearest projected ridge face from a bounded approximate height-map lookup${surfaceCentered ? ', toward the midpoint between facing flank surfaces' : ''}.`,
        frameEvidence: { status: surface && validFrame ? 'hypothesized' : 'unavailable', mesial: analysis.anterior.direction || apexS !== null ? 'hypothesized' : 'unknown', buccal: analysis.lingualConfidence >= 0.5 ? 'hypothesized' : 'unknown', limitations: ['Occlusal direction and ridge localization are geometric hypotheses; no fixture axis or bone-safe trajectory is established.', 'Mesial and buccal signs do not confirm patient laterality.'] },
        mesialSign, buccalSign,
        adjacent: { mesial: neighbour(mesialTooth, input.partId, mesialTooth ? toothConfidence(input, mesialTooth) : 0), distal: neighbour(distalTooth, input.partId, distalTooth ? toothConfidence(input, distalTooth) : 0) },
        opposing: opposing ? { partId: opposing.partId, teeth: opposingTeeth, poseVerified: options.poseVerified } : null,
        contralateral,
        space: {
          mesiodistal: measured(mdArc, kind === 'distal-extension' ? 'Illustrative distal-extension slot capped by the adjacent crown arc width and the first continuous low-ridge profile, leaving one profile cell before its end. Its outer boundary is hypothesized; not a tooth count, bounded restorative space or proximal surface clearance.' : kind === 'terminal' ? 'Scanned terminal review-region span along the fitted arch curve with one crown flank; not a tooth count, bounded restorative space or proximal surface clearance.' : positions.length === 1 ? 'Arc length along the fitted arch curve between flanking crown boundaries; not an exact proximal surface clearance.' : 'Hypothesized per-position partition of the overall measured arch-curve gap, using relative FDI crown proportions; internal slot boundaries are unobserved.', kind === 'distal-extension' || positions.length > 1 ? 'hypothesized' : 'measured'),
          proximalGap: measured(proximalGap, 'Symmetric mesiodistal envelope about the ridge anchor between facing extrema of original flank triangles clipped to the neighbouring-width band and the height hypothesis above the site. Nonpositive values mean no supported centered envelope; not closest-surface clearance or a clinical contact target.'),
          buccolingual: measured(blEstimate, blNeighbours.length ? 'Mean neighbouring crown cross-section width used as a site-width hypothesis; not a measured ridge width.' : 'Dental band half-width fallback; not a measured ridge width.', 'hypothesized'),
          vertical: { ...measured(vertical, `Minimum height above the site origin along the restorative axis of up to 9 observed opposing height-map samples in the current pose${options.poseVerified ? '' : ' (provisional; bite unverified)'}. Includes ridge-datum offsets and opposing-axis projection; repeated source faces are possible. This sampled envelope is not ray clearance and does not bound unobserved surface between samples.`), sampleCount: verticalSamples },
          crownHeight: measured(crownHeight, 'Mean neighbouring crown relief used as a height hypothesis; not measured available restorative room.', 'hypothesized'),
        },
        questions,
      });
    };
    // Bounded gaps from the alignment, one site per consumed position.
    for (const gap of analysis.gaps) {
      // The scan end is a coverage boundary, never an automatically missing tooth.
      if (gap.kind !== 'bounded' || !gap.positions.length || gap.positions.some(fdi => !validFdi(fdi) || (fdi < 30 ? 'upper' : 'lower') !== arch)) continue;
      const group = numbering.groups.find(candidate => candidate.kind === 'gap' && candidate.positions?.length === gap.positions.length && candidate.positions.every((value, index) => value === gap.positions[index]));
      const before = analysis.teeth.find(tooth => tooth.id === gap.before), after = analysis.teeth.find(tooth => tooth.id === gap.after);
      const notScanned = gap.support === 'not-scanned' || gap.coverage < 0.25;
      gap.positions.forEach((_, slot) => {
        // A saved site anchor is a correction, never replaced by localization.
        const chartRecord = input.identityConfirmed === false ? undefined : options.chart[gap.positions[slot]];
        if (chartRecord?.status === 'missing' && chartRecord.site) return;
        if (notScanned) {
          sites.push({
            id: `${arch}-${input.partId}-unscanned-${gap.positions[slot]}`, arch, partId: input.partId, fdi: gap.positions[slot], alternatives: [], status: 'not-scanned', confidence: 0, priority: 'low', kind: 'bounded',
            slot: { index: slot, count: gap.positions.length, s: slotSpan(gap.positions, gap.s[0], gap.s[1], slot, arch) }, evidence: { supporting: [], conflicting: ['No scanned surface covers this position; absence is not established.'] }, anchor: null, patchFaces: new Uint32Array(), frame: null,
            frameBasis: 'Not localized: no surface.', mesialSign: 1, buccalSign: 1, adjacent: { mesial: null, distal: null }, opposing: null, contralateral: null,
            space: { mesiodistal: measured(null, 'Unavailable without surface.'), proximalGap: measured(null, 'Unavailable.'), buccolingual: measured(null, 'Unavailable.'), vertical: measured(null, 'Unavailable.'), crownHeight: measured(null, 'Unavailable.') },
            questions: ['Rescan this region if it matters for planning.'],
          });
          return;
        }
        const first = sites.length;
        makeSite(gap.positions, gap.s[0], gap.s[1], slot, 'bounded', group?.confidence ?? 0.3, group?.alternatives ?? [], before, after);
        const site = sites[first];
        const unresolvedCrown = analysis.teeth.some(tooth => tooth.id !== gap.before && tooth.id !== gap.after && ((tooth.s[1] > site.slot.s[0] && tooth.s[0] < site.slot.s[1]) || (tooth.sCenter > site.slot.s[0] && tooth.sCenter < site.slot.s[1])));
        if (gap.support !== 'ridge' || gap.coverage < 0.75 || !before || !after || unresolvedCrown) {
          if (site.status !== 'dentist-confirmed-missing' && site.status !== 'not-scanned') site.status = 'segmentation-unresolved';
          if (site.status !== 'dentist-confirmed-missing') site.confidence = 0;
          site.evidence.conflicting.push('The bounded space has incomplete or mixed surface coverage; a missing tooth is unestablished.');
        }
      });
    }
    // Keep a scanned, one-flank terminal region available for review, without
    // inventing positions beyond the alignment or partitioning tissue into teeth.
    for (const gap of analysis.gaps) {
      if (gap.kind === 'bounded' || gap.support === 'not-scanned' || !Number.isFinite(gap.coverage) || gap.coverage < 0.5
        || !gap.s.every(Number.isFinite) || gap.s[1] <= gap.s[0]) continue;
      const before = analysis.teeth.find(tooth => tooth.id === gap.before), after = analysis.teeth.find(tooth => tooth.id === gap.after);
      if (gap.kind === 'terminal-start' ? before || !after : !before || after) continue;
      const flank = (before ?? after)!;
      const boundary = before ? gap.s[0] : gap.s[1], flankBoundary = before ? flank.s[1] : flank.s[0];
      // Do not collect remote scan margins, narrow collars, or tissue groups
      // separated from the crown by another unobserved stretch.
      if (!(flank.mdWidth > 0) || gap.s[1] - gap.s[0] < 0.5 * flank.mdWidth
        || Math.abs(boundary - flankBoundary) > Math.max(0.35 * flank.mdWidth, 2 * analysis.scale.cell)) continue;
      if (analysis.teeth.some(tooth => tooth.id !== flank.id && tooth.s[1] > gap.s[0] && tooth.s[0] < gap.s[1])) continue;
      const flankConfidence = toothConfidence(input, flank);
      const flankReliable = input.identityConfirmed === true && flank.fdi !== null && flankConfidence >= 0.6;
      const outward = apexS !== null && (before ? gap.s[0] >= apexS : gap.s[1] <= apexS);
      // A confidently identified distal second/third molar already ends the
      // supported tooth sequence. Do not turn its retromolar pad into a draft.
      if (flankReliable && outward && flank.fdi! % 10 >= 7) continue;
      const group = numbering.groups.find(candidate => candidate.kind === 'gap' && candidate.positions?.length === gap.positions.length && candidate.positions.every((value, index) => value === gap.positions[index]));
      const candidate = gap.positions.length === 1 ? gap.positions[0] : null;
      const flankIndex = numbering.sequence.indexOf(flank.fdi ?? -1);
      const consecutive = flankIndex >= 0 && numbering.sequence[flankIndex + (before ? 1 : -1)] === candidate;
      const reliable = candidate !== null && validFdi(candidate) && (candidate < 30 ? 'upper' : 'lower') === arch
        && input.identityConfirmed === true && input.identityConfidence >= 0.75 && flankReliable && consecutive
        && (group?.confidence ?? 0) >= 0.75 && !group?.alternatives.length;
      if (reliable && candidate % 10 === 8) continue;
      const fdi = reliable && !analysis.teeth.some(tooth => tooth.fdi === candidate) ? candidate : null;
      // Explicit chart entries remain chart sites, with their saved anchors.
      if (fdi !== null && ['missing', 'not-scanned'].includes(options.chart[fdi]?.status)) continue;
      const first = sites.length;
      makeSite([fdi], gap.s[0], gap.s[1], 0, 'terminal', 0.3 * gap.coverage, [], before, after);
      const site = sites[first];
      if (!site) continue;
      if (gap.support !== 'ridge' || gap.coverage < 0.75) {
        site.status = 'segmentation-unresolved'; site.confidence = Math.min(site.confidence, 0.15);
        site.evidence.conflicting.push('The terminal group contains mixed or tissue-like surface. Only its localized low ridge faces support this review region; tooth absence remains unestablished.');
      }
      // Preserve that whole terminal review region. Only a longer, low free-end
      // ridge can also support ONE tentative crown-sized illustration next to
      // the last sound crown. Numbering may label the whole group as tissue;
      // independent local profile and face evidence must support the sub-slot.
      if (!outward || gap.coverage < 0.9 || gap.support === 'mixed'
        || gap.ridgeHeight === null || !Number.isFinite(gap.ridgeHeight) || gap.ridgeHeight > 0
        || flank.kind !== 'crown' || flank.flags.length || flank.faces.length < 12 || flank.crownScore < 0.75
        || ![flank.mdWidth, flank.blWidth, flank.height].every(value => Number.isFinite(value) && value > 0)
        || flank.faces.some(face => input.reviewedLabels?.[face] === 255 || !!input.reviewedMask?.[face] && !input.reviewedLabels?.[face])
        || Math.abs(boundary - flankBoundary) > 2 * analysis.scale.cell
        || gap.s[1] - gap.s[0] < flank.mdWidth + Math.max(0.25 * flank.mdWidth, 2 * analysis.scale.cell)) continue;
      const samples = analysis.curve.s.map((s, index) => ({ s, state: analysis.curve.state[index] }))
        .filter(sample => sample.s >= gap.s[0] && sample.s <= gap.s[1]);
      if (!before) samples.reverse();
      // Stop at the FIRST elevated or unobserved sample. A remote low patch
      // past a retromolar/tuberosity rise must not enlarge this window.
      const breakAt = samples.findIndex(sample => sample.state !== 'low');
      const run = breakAt < 0 ? samples : samples.slice(0, breakAt);
      if (run.length < 5) continue;
      const width = Math.min(flank.mdWidth, Math.abs(run[run.length - 1].s - boundary) - analysis.scale.cell);
      if (!Number.isFinite(width) || width < 0.65 * flank.mdWidth) continue;
      const draftSpan: [number, number] = before ? [boundary, boundary + width] : [boundary - width, boundary];
      const draftIndex = sites.length;
      makeSite([null], draftSpan[0], draftSpan[1], 0, 'distal-extension', 0, [], before, after);
      const draft = sites[draftIndex];
      if (!draft) continue;
      // A neutral posterior shape selector, never an inferred absent FDI or
      // an invented second flank. The saved chart is untouched.
      draft.draftIdentity = { templateFdi: arch === 'lower' ? 36 : 16, alternatives: arch === 'lower' ? [46] : [26],
        basis: 'Illustrative posterior template on a locally supported distal-extension slot; tooth absence, FDI, patient side and implant indication remain unconfirmed. Clinical review is required.' };
      draft.evidence.supporting.push('One tentative slot next to the last crown has low ridge faces in all five local arc bins and a low observed crest profile. The remaining terminal region is not partitioned into teeth.');
      if (input.roleConfirmed === false) draft.evidence.conflicting.push('The arch role is unconfirmed; opposing relationships and vertical room are unavailable. This local geometric draft does not confirm arch identity or the bite.');
      draft.evidence.conflicting.push('The distal slot boundary and crown proportions are hypotheses. This draft is illustrative and requires review of coverage, tooth history, anatomy and placement; it is not a diagnosis or a treatment plan.');
    }
  }
  // Dentist-recorded missing positions without a geometric hypothesis remain visible as chart sites.
  for (const [code, record] of Object.entries(options.chart)) {
    const fdi = Number(code);
    if (!validFdi(fdi) || record.status !== 'missing' || sites.some(site => site.fdi === fdi && arches.some(input => input.partId === site.partId && input.identityConfirmed !== false))) continue;
    const arch = fdi < 30 ? 'upper' : 'lower';
    const input = arches.find(candidate => candidate.arch === arch);
    if (!input) continue;
    sites.push({
      id: `${arch}-chart-${fdi}`, arch, partId: record.site?.partId ?? input.partId, fdi, alternatives: [], status: 'dentist-confirmed-missing', confidence: 0.99, priority: 'high', kind: 'chart',
      slot: { index: 0, count: 1, s: [0, 0] }, evidence: { supporting: ['Dentist-recorded missing position.'], conflicting: record.site ? [] : ['No geometric space was localized automatically; mark the site on the scan.'] },
      anchor: record.site ?? null, patchFaces: new Uint32Array(), frame: null, frameBasis: record.site ? 'Dentist-marked surface point; frame derived during design.' : 'Not localized.',
      mesialSign: 1, buccalSign: 1, adjacent: { mesial: null, distal: null }, opposing: null, contralateral: null,
      space: { mesiodistal: measured(null, 'Not measured.'), proximalGap: measured(null, 'Not measured.'), buccolingual: measured(null, 'Not measured.'), vertical: measured(null, 'Not measured.'), crownHeight: measured(null, 'Not measured.') },
      questions: record.site ? [] : ['Mark the missing site on the scan to localize it.'],
    });
  }
  return sites.sort((a, b) => (a.priority === b.priority ? b.confidence - a.confidence : ['high', 'medium', 'low'].indexOf(a.priority) - ['high', 'medium', 'low'].indexOf(b.priority)));
}
