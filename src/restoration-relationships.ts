import { Triangle, Vector3 } from 'three';
import { createNearestSurfaceQuery } from './collision.ts';
import type { NearestSurfaceQuery } from './collision.ts';
import { restorationReferencePlanes } from './restoration-geometry.ts';
import { MAX_VERIFIED_TARGET_FACES, verifyFitIntersections } from './restoration-fit-verification.ts';
import { measureAbutmentGingiva, unmeasuredAbutmentGingiva } from './restoration-gingiva.ts';
import type { AbutmentGingivaReport } from './restoration-gingiva';
import type { Vec3 } from './models';
import type { RestorationComponentKind, RestorationFitSurface, RestorationMesh, RestorationSpec } from './restoration-types';

export interface RestorationRelationshipsOptions {
  /** Defaults to 128; samples are source triangle barycentres, not area estimates. */
  samplesPerRelationship?: number;
  /** Separate from the fitter's budget. Defaults to 3000 ms. */
  maxDurationMs?: number;
  /** Oversized meshes produce unknown evidence; targets are never decimated. */
  maxMeshTriangles?: number;
}
export interface RestorationRelationshipsInput {
  spec: RestorationSpec;
  components: readonly RestorationMesh[];
  surfaces: readonly RestorationFitSurface[];
  options?: RestorationRelationshipsOptions;
}
export interface RestorationRelationshipsControl {
  checkCancelled?: () => boolean;
  yieldControl?: () => Promise<void>;
}
export class RestorationRelationshipsCancelled extends Error {
  constructor() { super('Restoration relationship measurement was cancelled.'); this.name = 'RestorationRelationshipsCancelled'; }
}
export interface RestorationRelationshipMeasurement {
  id: string;
  source: 'fixture' | 'abutment';
  target: 'abutment' | 'crown' | 'adjacent';
  targetId: string;
  side?: RestorationFitSurface['side'];
  /** Measured means the requested distance sample set completed, not clinical clearance. */
  status: 'measured' | 'unknown';
  reason: string | null;
  sourceTriangles: number | null;
  targetTriangles: number | null;
  samples: number;
  sampledMinDistance: number | null;
  sampledMedianDistance: number | null;
  sampledP95Distance: number | null;
  /** Complete only when all supplied source/target faces were accounted for. */
  intersectionComplete: boolean;
  /** Distinct affected faces summed across the two meshes, not pair counts or area. */
  intersectingTriangles: number | null;
  transverseCrossingTriangles: number | null;
  touchingOrAmbiguousTriangles: number | null;
  /** Number of nondegenerate target faces screened, including broadphase exclusions. */
  intersectionTestedTriangles: number;
  intersectionPairTests: number;
  intersectionTolerance: number | null;
  surfaceEvidence: 'unknown' | 'none-observed' | 'touching-or-ambiguous' | 'transverse-crossing';
  intersectionReason: string | null;
}
export interface RestorationInterfaceMeasurement {
  id: 'fixture-platform' | 'crown-base';
  source: 'fixture' | 'abutment';
  target: 'abutment' | 'crown';
  status: 'measured' | 'unknown';
  reason: string | null;
  nominalOrigin: Vec3;
  nominalNormal: Vec3;
  /** Coronal source extremum relative to the nominal plane, along frame.up. */
  sourceAxialOffset: number | null;
  /** Apical target extremum relative to the nominal plane, along frame.up. */
  targetAxialOffset: number | null;
  /** Target minimum minus source maximum. Does not establish lateral footprint overlap. */
  signedAxialGap: number | null;
  /** Full-surface distances from the spec's nominal interface centre, not mesh-to-mesh gaps. */
  sourceDistanceToNominalOrigin: number | null;
  targetDistanceToNominalOrigin: number | null;
}
export interface RestorationRelationshipsReport {
  version: 'restoration-relationships/v1';
  units: 'file units (u)';
  termination: 'complete' | 'time-budget';
  durationMs: number;
  relationships: RestorationRelationshipMeasurement[];
  interfaces: RestorationInterfaceMeasurement[];
  /** Optional for legacy reports; new audits always include an explicit result. */
  abutmentGingiva?: AbutmentGingivaReport;
  sampling: {
    method: 'deterministic-triangle-barycentres';
    direction: 'source-to-target';
    requestedPerRelationship: number;
    fullResolutionDistanceTargets: true;
    maximumMeshTriangles: number;
    maximumVerificationRegionTriangles: number;
    maxDurationMs: number;
  };
  limits: string[];
}

class RelationshipBudgetExceeded extends Error {}
const defaultYield = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const BLOCK_FACES = 4096;
const FLOAT32_UNIT_ROUNDOFF = 2 ** -24;
const FLOAT32_HALF_SUBNORMAL = 2 ** -150;
const integerOption = (value: number | undefined, fallback: number, maximum: number, name: string) => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new Error(`${name} must be an integer in [1, ${maximum}].`);
  return result;
};
const faceCount = (positions?: Float32Array) => positions instanceof Float32Array && positions.length % 9 === 0 ? positions.length / 9 : null;
const readTriangle = (positions: Float32Array, face: number, triangle: Triangle) => {
  triangle.a.fromArray(positions, face * 9);
  triangle.b.fromArray(positions, face * 9 + 3);
  triangle.c.fromArray(positions, face * 9 + 6);
  return triangle;
};
interface PreparedMesh {
  positions: Float32Array;
  nondegenerate: number;
  minAxial: number;
  maxAxial: number;
  /** World projections avoid cancellation against an unrelated nominal origin. */
  minProjection: number;
  maxProjection: number;
  coordinateMagnitude: Vec3;
  reason: string | null;
  blocks?: NearestSurfaceQuery[];
  samples?: Vector3[];
}

/**
 * For a stored Float32 coordinate x, a single round-to-nearest conversion has
 * error <= (2^-24 * |x| + 2^-150) / (1 - 2^-24). Per-axis maxima over EVERY
 * supplied vertex bound the Euclidean perturbation of any mesh point. The sum
 * of the two meshes' radii bounds their relative projection error on any fixed
 * unit SAT/axial plane normal. There is no arbitrary one-file-unit floor.
 * This does not reconstruct unrounded geometry or certify ill-conditioned
 * triangle normals; the independent axial halfspace check below uses frame.up.
 */
function coordinateRoundoff(mesh: PreparedMesh) {
  return Math.hypot(...mesh.coordinateMagnitude.map(value =>
    (FLOAT32_UNIT_ROUNDOFF * value + FLOAT32_HALF_SUBNORMAL) / (1 - FLOAT32_UNIT_ROUNDOFF)));
}

function projectionTolerance(source: PreparedMesh, target: PreparedMesh) {
  // Also allow Float64 dot/subtraction evaluation error from both full meshes.
  // This is small compared with Float32 rounding and uses no nominal origin.
  const evaluation = (Math.hypot(...source.coordinateMagnitude) + Math.hypot(...target.coordinateMagnitude)) * Number.EPSILON * 64;
  return coordinateRoundoff(source) + coordinateRoundoff(target) + evaluation;
}

/**
 * Call in a worker. Inputs must remain unchanged for the duration of this call.
 * Every completed distance queries every supplied target face; only source
 * barycentres are sampled. Time exhaustion returns completed evidence plus
 * explicit unknowns; cancellation rejects so a stale report cannot be accepted.
 */
export async function measureRestorationRelationships(input: RestorationRelationshipsInput,
  control: RestorationRelationshipsControl = {}): Promise<RestorationRelationshipsReport> {
  const started = performance.now();
  const cancelled = () => { if (control.checkCancelled?.()) throw new RestorationRelationshipsCancelled(); };
  cancelled();
  const options = {
    samplesPerRelationship: integerOption(input.options?.samplesPerRelationship, 128, 2048, 'Relationship sample budget'),
    maxDurationMs: integerOption(input.options?.maxDurationMs, 3000, 60_000, 'Relationship time budget'),
    maxMeshTriangles: integerOption(input.options?.maxMeshTriangles, 1_000_000, 2_000_000, 'Relationship mesh budget'),
  };
  const check = () => { cancelled(); if (performance.now() - started >= options.maxDurationMs) throw new RelationshipBudgetExceeded(); };
  const pause = async () => { check(); await (control.yieldControl ?? defaultYield)(); check(); };
  const planes = restorationReferencePlanes(input.spec);
  for (const plane of [planes.fixturePlatform, planes.crownBase]) {
    if (![...plane.origin, ...plane.normal].every(Number.isFinite)) throw new Error('Nominal relationship planes must be finite.');
  }
  if (!Array.isArray(input.components) || input.components.length > 3 || !Array.isArray(input.surfaces) || input.surfaces.length > 64) {
    throw new Error('Relationships require at most three components and 64 supplied surfaces.');
  }
  const components = new Map<RestorationComponentKind, RestorationMesh>();
  for (const mesh of input.components) {
    if (!['fixture', 'abutment', 'crown'].includes(mesh.component) || components.has(mesh.component)) throw new Error('Relationship component kinds must be known and unique.');
    components.set(mesh.component, mesh);
  }
  const adjacent = input.surfaces.filter(surface => surface.role === 'adjacent');
  const ids = new Set<string>();
  for (const surface of adjacent) {
    if (typeof surface.id !== 'string' || !surface.id.trim() || surface.id.length > 400 || ids.has(surface.id)) throw new Error('Adjacent relationship target IDs must be bounded, nonempty and unique.');
    if (surface.side !== undefined && !['mesial', 'distal'].includes(surface.side)) throw new Error('Unknown adjacent target side.');
    ids.add(surface.id);
  }
  const jobs: { row: RestorationRelationshipMeasurement; source?: Float32Array; target?: Float32Array }[] = [];
  function add(source: 'fixture' | 'abutment', target: RestorationRelationshipMeasurement['target'], targetId: string,
    positions?: Float32Array, side?: RestorationFitSurface['side']) {
    const sourcePositions = components.get(source)?.positions;
    jobs.push({ source: sourcePositions, target: positions, row: {
      id: `${source}-to-${target}${target === 'adjacent' ? `:${targetId}` : ''}`, source, target, targetId,
      ...(side ? { side } : {}), status: 'unknown', reason: 'not-measured',
      sourceTriangles: faceCount(sourcePositions), targetTriangles: faceCount(positions), samples: 0,
      sampledMinDistance: null, sampledMedianDistance: null, sampledP95Distance: null,
      intersectionComplete: false, intersectingTriangles: null, transverseCrossingTriangles: null,
      touchingOrAmbiguousTriangles: null, intersectionTestedTriangles: 0, intersectionPairTests: 0,
      intersectionTolerance: null, surfaceEvidence: 'unknown', intersectionReason: 'not-measured',
    } });
  }
  add('fixture', 'abutment', 'abutment', components.get('abutment')?.positions);
  add('abutment', 'crown', 'crown', components.get('crown')?.positions);
  add('fixture', 'crown', 'crown', components.get('crown')?.positions);
  for (const surface of adjacent) for (const source of ['fixture', 'abutment'] as const) add(source, 'adjacent', surface.id, surface.positions, surface.side);
  const makeInterface = (id: RestorationInterfaceMeasurement['id'], source: 'fixture' | 'abutment', target: 'abutment' | 'crown',
    plane: typeof planes.fixturePlatform): RestorationInterfaceMeasurement => ({
    id, source, target, status: 'unknown', reason: 'not-measured', nominalOrigin: [...plane.origin], nominalNormal: [...plane.normal],
    sourceAxialOffset: null, targetAxialOffset: null, signedAxialGap: null,
    sourceDistanceToNominalOrigin: null, targetDistanceToNominalOrigin: null,
  });
  const report: RestorationRelationshipsReport = {
    version: 'restoration-relationships/v1', units: 'file units (u)', termination: 'complete', durationMs: 0,
    relationships: jobs.map(job => job.row),
    interfaces: [makeInterface('fixture-platform', 'fixture', 'abutment', planes.fixturePlatform), makeInterface('crown-base', 'abutment', 'crown', planes.crownBase)],
    abutmentGingiva: unmeasuredAbutmentGingiva('Relationship budget or unusable source geometry prevented a completed abutment/gum audit.'),
    sampling: { method: 'deterministic-triangle-barycentres', direction: 'source-to-target',
      requestedPerRelationship: options.samplesPerRelationship, fullResolutionDistanceTargets: true,
      maximumMeshTriangles: options.maxMeshTriangles, maximumVerificationRegionTriangles: MAX_VERIFIED_TARGET_FACES,
      maxDurationMs: options.maxDurationMs },
    limits: [
      'Distances are unsigned source triangle-barycentre samples to the full supplied target surface, in file units (u); no millimetre scale is assumed.',
      'The sampled minimum is an upper bound on the true surface minimum, subject to numerical precision. Positive samples do not prove separation. Median and p95 describe the deterministic face sample, depend on tessellation, and are not area-weighted.',
      'Distances and affected triangle counts are not contact area, penetration depth, overlap volume, root clearance, bone clearance, or clinical safety. Adjacent targets are only the supplied scanned surfaces; unscanned anatomy is unknown.',
      'Complete intersection evidence covers supplied triangle surfaces within numerical tolerance, not solid containment. Touching includes coplanar, edge, vertex and ambiguous contacts. Counts sum affected faces across both meshes; crossing and touching categories can share faces.',
      'Relationship intersectionTolerance includes Float32 rounding of actual full source and target coordinates, propagated to unit-plane projections. It is numeric, not clinical, does not reconstruct unrounded geometry or certify ill-conditioned triangle normals, and has no one-file-unit minimum. Sampled distances are unchanged.',
      'For fully prepared component pairs, measured vertex extrema on frame.up can establish opposite axial halfspaces with overlap no greater than the numeric tolerance. Such observed hits are touching/ambiguous even if triangle-plane straddling labels shared-rim tangencies transverse. This uses all measured nondegenerate faces, not nominal interface intent; greater axial overlap keeps the SAT evidence.',
      'Unknown or incomplete intersection evidence never establishes an intersection-free surface. Each audit accepts at most 20000 source faces and 20000 retained target faces, with a 200000 triangle-pair cap; degenerate faces prevent completeness.',
      'Nominal interface planes come from the spec. Axial extrema gaps do not establish lateral footprint overlap, mating surface shape, seating, connection compatibility or manufacturing fit. Distances to nominal centres are separate point-to-surface probes; basal caps are artificial.',
      'Distance queries are prepared in 4096-face blocks with event-loop yields; intersection verification uses the existing bounded synchronous SAT audit between yields. The time budget is cooperative, not a hard real-time deadline.',
      ...(adjacent.length ? [] : ['No adjacent scanned targets were supplied; adjacent relationships are unknown.']),
    ],
  };
  const cache = new Map<Float32Array, PreparedMesh>();
  const origin = new Vector3(...input.spec.frame.origin), up = new Vector3(...input.spec.frame.up);
  const triangle = new Triangle();
  async function prepare(positions?: Float32Array): Promise<PreparedMesh | string> {
    check();
    if (!positions) return 'missing-geometry';
    if (!(positions instanceof Float32Array) || positions.length % 9) return 'invalid-triangle-geometry';
    if (!positions.length) return 'empty-geometry';
    if (positions.length / 9 > options.maxMeshTriangles) return 'mesh-triangle-budget';
    const cached = cache.get(positions);
    if (cached) return cached.reason ?? cached;
    const prepared: PreparedMesh = { positions, nondegenerate: 0, minAxial: Infinity, maxAxial: -Infinity,
      minProjection: Infinity, maxProjection: -Infinity, coordinateMagnitude: [0, 0, 0], reason: null };
    for (let face = 0; face < positions.length / 9; face++) {
      if (face && face % BLOCK_FACES === 0) await pause();
      for (let i = face * 9; i < face * 9 + 9; i++) {
        if (!Number.isFinite(positions[i])) { prepared.reason = 'nonfinite-geometry'; cache.set(positions, prepared); return prepared.reason; }
        prepared.coordinateMagnitude[i % 3] = Math.max(prepared.coordinateMagnitude[i % 3], Math.abs(positions[i]));
      }
      readTriangle(positions, face, triangle);
      if (!(triangle.getArea() > 0)) continue;
      prepared.nondegenerate++;
      for (const point of [triangle.a, triangle.b, triangle.c]) {
        const axial = (point.x - origin.x) * up.x + (point.y - origin.y) * up.y + (point.z - origin.z) * up.z;
        if (!Number.isFinite(axial)) { prepared.reason = 'nonfinite-axial-projection'; cache.set(positions, prepared); return prepared.reason; }
        prepared.minAxial = Math.min(prepared.minAxial, axial);
        prepared.maxAxial = Math.max(prepared.maxAxial, axial);
        const projected = point.dot(up);
        prepared.minProjection = Math.min(prepared.minProjection, projected);
        prepared.maxProjection = Math.max(prepared.maxProjection, projected);
      }
    }
    check(); cache.set(positions, prepared); return prepared;
  }
  async function samplesOf(mesh: PreparedMesh) {
    if (mesh.samples) return mesh.samples;
    const count = Math.min(options.samplesPerRelationship, mesh.nondegenerate), points: Vector3[] = [];
    if (!count) return points;
    let rank = 0;
    for (let face = 0; face < mesh.positions.length / 9 && points.length < count; face++) {
      if (face && face % BLOCK_FACES === 0) await pause();
      readTriangle(mesh.positions, face, triangle);
      if (!(triangle.getArea() > 0)) continue;
      if (rank === Math.floor((points.length + .5) * mesh.nondegenerate / count)) points.push(triangle.getMidpoint(new Vector3()));
      rank++;
    }
    check(); mesh.samples = points; return points;
  }
  async function distanceTo(mesh: PreparedMesh, point: Vector3) {
    if (!mesh.blocks) {
      const blocks: NearestSurfaceQuery[] = [];
      for (let start = 0; start < mesh.positions.length; start += BLOCK_FACES * 9) {
        await pause();
        blocks.push(createNearestSurfaceQuery(mesh.positions.subarray(start, start + BLOCK_FACES * 9), check));
      }
      check(); mesh.blocks = blocks;
    }
    const nearest = new Vector3();
    let best = Infinity;
    for (let i = 0; i < mesh.blocks.length; i++) {
      if (i && i % 8 === 0) await pause();
      check();
      best = Math.min(best, mesh.blocks[i].nearestPoint(point, nearest, undefined, best));
      if (best === 0) break;
    }
    check(); return best;
  }
  try {
    // Finish cheap useful distance evidence for all pairs before SAT work can
    // consume the remaining budget. No partially evaluated sample set is saved.
    for (const job of jobs) {
      await pause();
      const source = await prepare(job.source), target = await prepare(job.target);
      if (typeof source === 'string' || typeof target === 'string') {
        job.row.reason = typeof source === 'string' ? `source:${source}` : `target:${target}`;
        job.row.intersectionReason = job.row.reason;
        continue;
      }
      const samples = await samplesOf(source);
      if (!samples.length) { job.row.reason = 'no-nondegenerate-source-triangles'; continue; }
      const distances: number[] = [];
      for (let i = 0; i < samples.length; i++) {
        if (i && i % 16 === 0) await pause();
        distances.push(await distanceTo(target, samples[i]));
      }
      check();
      if (distances.some(value => !Number.isFinite(value))) { job.row.reason = 'no-finite-surface-distance'; continue; }
      distances.sort((a, b) => a - b);
      Object.assign(job.row, { status: 'measured', reason: null, samples: distances.length,
        sampledMinDistance: distances[0], sampledMedianDistance: distances[Math.floor((distances.length - 1) * .5)],
        sampledP95Distance: distances[Math.floor((distances.length - 1) * .95)] });
    }
    for (const item of report.interfaces) {
      await pause();
      const source = await prepare(components.get(item.source)?.positions), target = await prepare(components.get(item.target)?.positions);
      if (typeof source === 'string' || typeof target === 'string') { item.reason = typeof source === 'string' ? `source:${source}` : `target:${target}`; continue; }
      if (!source.nondegenerate || !target.nondegenerate) { item.reason = 'no-nondegenerate-interface-geometry'; continue; }
      const nominal = new Vector3(...item.nominalOrigin), nominalProjection = nominal.dot(up);
      const sourceDistance = await distanceTo(source, nominal), targetDistance = await distanceTo(target, nominal);
      // Actual separation cannot be obtained by subtracting offsets which may
      // already have lost all local detail against a distant nominal datum.
      const gap = target.minProjection - source.maxProjection;
      // Use the gap's projected extrema and one shared datum for both offsets.
      // Separately projecting origin-relative vertices adds roundoff that makes
      // near-zero platform offsets disagree with the independently measured gap.
      const sourceOffset = source.maxProjection - nominalProjection, targetOffset = target.minProjection - nominalProjection;
      const resolution = Math.max(source.maxProjection - source.minProjection, target.maxProjection - target.minProjection,
        Math.abs(gap), projectionTolerance(source, target));
      const datumError = Math.max(...item.nominalOrigin.map(Math.abs), ...input.spec.frame.origin.map(Math.abs),
        ...source.coordinateMagnitude, ...target.coordinateMagnitude) * Number.EPSILON * 64;
      if (datumError >= resolution / 64) { item.reason = 'nominal-plane-offset-numerically-unresolved'; continue; }
      check();
      if (![sourceDistance, targetDistance, sourceOffset, targetOffset, gap].every(Number.isFinite)) { item.reason = 'nonfinite-interface-measurement'; continue; }
      Object.assign(item, { status: 'measured', reason: null, sourceAxialOffset: sourceOffset, targetAxialOffset: targetOffset,
        signedAxialGap: gap, sourceDistanceToNominalOrigin: sourceDistance, targetDistanceToNominalOrigin: targetDistance });
    }
    for (const job of jobs) {
      if (job.row.intersectionReason !== 'not-measured') continue;
      await pause();
      const source = await prepare(job.source), target = await prepare(job.target);
      if (typeof source === 'string' || typeof target === 'string') continue;
      // The verifier bounds target preparation but its final source traversal
      // is synchronous. Bound that traversal too; never sample it and call it complete.
      if (source.positions.length / 9 > MAX_VERIFIED_TARGET_FACES) { job.row.intersectionReason = 'source-triangle-budget'; continue; }
      const minimumTolerance = projectionTolerance(source, target);
      const evidence = await verifyFitIntersections(source.positions, target.positions, { check, yieldControl: pause, minimumTolerance });
      check();
      if (!evidence) { job.row.intersectionReason = 'retained-target-triangle-budget'; continue; }
      const { verificationRetainedTriangles: _retained, ...measured } = evidence;
      // Triangle-plane straddling alone can label a shared rim vertex/edge as
      // transverse even for meshes in opposite closed halfspaces. A projection
      // is affine, so vertex extrema bound every point of every triangle. Use
      // measured full-mesh bounds, never the nominal planes or intended caps.
      const axialGap = Math.max(target.minProjection - source.maxProjection, source.minProjection - target.maxProjection);
      const axialTouch = job.row.target !== 'adjacent' && source.nondegenerate > 0 && target.nondegenerate > 0
        && measured.transverseCrossingTriangles > 0 && axialGap >= -measured.intersectionTolerance * up.length();
      if (axialTouch) {
        measured.transverseCrossingTriangles = 0;
        measured.touchingOrAmbiguousTriangles = measured.intersectingTriangles;
      }
      Object.assign(job.row, measured);
      job.row.surfaceEvidence = measured.transverseCrossingTriangles > 0 ? 'transverse-crossing'
        : measured.touchingOrAmbiguousTriangles > 0 ? 'touching-or-ambiguous' : measured.intersectionComplete ? 'none-observed' : 'unknown';
      job.row.intersectionReason = !measured.intersectionComplete ? 'degenerate-triangles-or-pair-budget'
        : axialTouch ? 'opposite-axial-halfspaces-within-numeric-tolerance' : null;
    }
    if (typeof await prepare(components.get('abutment')?.positions) !== 'string') {
      report.abutmentGingiva = await measureAbutmentGingiva(input, { check, yieldControl: pause });
    }
    // Cancellation arriving during the last synchronous audit must still win.
    await pause();
  } catch (error) {
    if (!(error instanceof RelationshipBudgetExceeded)) throw error;
    report.termination = 'time-budget';
    for (const row of report.relationships) {
      if (row.reason === 'not-measured') row.reason = 'time-budget';
      if (row.intersectionReason === 'not-measured') row.intersectionReason = 'time-budget';
    }
    for (const item of report.interfaces) if (item.reason === 'not-measured') item.reason = 'time-budget';
  }
  // Even on budget exhaustion, allow queued cancellation to invalidate this job.
  await (control.yieldControl ?? defaultYield)(); cancelled();
  report.durationMs = Math.max(0, performance.now() - started);
  return report;
}
