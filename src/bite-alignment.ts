import { Box3, Matrix4, Quaternion, Vector3 } from 'three';
import { createNearestSurfaceQuery } from './collision.ts';
import type { NearestSurfaceQuery } from './collision.ts';

export interface BiteAlignmentArch {
  id: string;
  positions: Float64Array;
  role: 'upper' | 'lower';
}

export interface BiteAlignmentReference {
  id: string;
  positions: Float64Array;
}

export interface BiteAlignmentInput {
  /** Nonindexed triangles, already transformed into the shared workspace coordinates. */
  arches: BiteAlignmentArch[];
  bites: BiteAlignmentReference[];
  /** Local correspondence capture radius in file units. */
  maxDistance: number;
}

export interface BiteAlignmentArchResult {
  id: string;
  /** Column-major world-space rigid delta. Premultiply the existing arch pose. */
  matrix: number[];
  /** Unsigned surface RMS on the same frozen bite samples, in file units. */
  beforeRms: number;
  afterRms: number;
  samples: number;
  /** Raw RMS on each reference's frozen, initially owned samples, before residual trimming. */
  references: {
    id: string;
    beforeRms: number;
    afterRms: number;
    samples: number;
    /** Fraction of the frozen pool with compatible normals inside the capture radius. */
    beforeCoverage: number;
    afterCoverage: number;
  }[];
}

export interface BiteAlignmentResult {
  arches: BiteAlignmentArchResult[];
  durationMs: number;
}

export interface BiteAlignmentRequest extends BiteAlignmentInput { id: number }
export type BiteAlignmentResponse = { id: number; result: BiteAlignmentResult } | { id: number; error: string };

// Deliberately local: no initial-pose search, rescaling, reflection, or bite motion.
const MAX_SAMPLES = 3200, MIN_SAMPLES = 40, MAX_ITERATIONS = 40;
const MAX_DURATION_MS = 8000, MAX_TRIANGLES = 2_000_000, MAX_PART_TRIANGLES = 750_000;
const TRIM_FRACTION = 0.85, MAX_ANGLE = Math.PI / 18;
const NORMAL_AGREEMENT = 0.6;

interface MeshInfo {
  mesh: BiteAlignmentReference;
  box: Box3;
  diagonal: number;
  precision: number;
}
interface Sample { referenceId: string; point: Vector3; normal: Vector3 }
interface Match extends Sample { source: Vector3; distance: number; validNormal: boolean }
interface ArchState extends MeshInfo {
  mesh: BiteAlignmentArch;
  query: NearestSurfaceQuery;
  matrix: Matrix4;
  samples: Sample[];
}
interface Support { center: Vector3; radius: number }

/** Symmetric Jacobi eigensolver; vectors are stored as columns of a row-major matrix. */
function symmetricEigen(matrix: number[], n: number): { values: number[]; vectors: number[] } {
  const a = matrix.slice(), vectors = Array<number>(n * n).fill(0);
  for (let i = 0; i < n; i++) vectors[i * n + i] = 1;
  for (let iteration = 0; iteration < 80 * n * n; iteration++) {
    let p = 0, q = 1, off = 0, scale = 0;
    for (let i = 0; i < n; i++) {
      scale = Math.max(scale, Math.abs(a[i * n + i]));
      for (let j = i + 1; j < n; j++) {
        if (Math.abs(a[i * n + j]) > off) { off = Math.abs(a[i * n + j]); p = i; q = j; }
      }
    }
    if (off <= Math.max(scale * 1e-12, Number.MIN_VALUE)) {
      return { values: Array.from({ length: n }, (_, i) => a[i * n + i]), vectors };
    }
    const app = a[p * n + p], aqq = a[q * n + q], apq = a[p * n + q];
    const angle = 0.5 * Math.atan2(2 * apq, aqq - app), c = Math.cos(angle), s = Math.sin(angle);
    for (let k = 0; k < n; k++) {
      if (k === p || k === q) continue;
      const akp = a[k * n + p], akq = a[k * n + q];
      a[k * n + p] = a[p * n + k] = c * akp - s * akq;
      a[k * n + q] = a[q * n + k] = s * akp + c * akq;
    }
    a[p * n + p] = c * c * app - 2 * c * s * apq + s * s * aqq;
    a[q * n + q] = s * s * app + 2 * c * s * apq + c * c * aqq;
    a[p * n + q] = a[q * n + p] = 0;
    for (let k = 0; k < n; k++) {
      const vkp = vectors[k * n + p], vkq = vectors[k * n + q];
      vectors[k * n + p] = c * vkp - s * vkq;
      vectors[k * n + q] = s * vkp + c * vkq;
    }
  }
  throw new Error('Local refinement could not solve a stable rigid step.');
}

function meshInfo(mesh: BiteAlignmentReference, checkBudget: () => void): MeshInfo {
  const p = mesh.positions;
  if (!(p instanceof Float64Array) || p.length === 0 || p.length % 9 !== 0) {
    throw new Error(`${mesh.id}: expected nonempty Float64 triangle positions.`);
  }
  if (p.length / 9 > MAX_PART_TRIANGLES) {
    throw new Error(`${mesh.id}: local refinement supports at most ${MAX_PART_TRIANGLES.toLocaleString()} triangles per scan.`);
  }
  const box = new Box3(), v = new Vector3();
  for (let i = 0; i < p.length; i += 3) {
    if ((i & 4095) === 0) checkBudget();
    if (!Number.isFinite(p[i]) || !Number.isFinite(p[i + 1]) || !Number.isFinite(p[i + 2])) {
      throw new Error(`${mesh.id}: positions must be finite.`);
    }
    box.expandByPoint(v.fromArray(p, i));
  }
  const diagonal = box.getSize(v).length();
  const magnitude = Math.max(...box.min.toArray().map(Math.abs), ...box.max.toArray().map(Math.abs));
  const precision = Math.max(diagonal * 1e-10, magnitude * Number.EPSILON * 64);
  if (!(diagonal > 0) || precision > diagonal * 1e-4) {
    throw new Error(`${mesh.id}: geometry has too little spread or coordinate precision for local refinement.`);
  }
  return { mesh, box, diagonal, precision };
}

/** Equal sample budgets per reference; equal-area samples within each reference. */
function sampleBites(meshes: MeshInfo[], checkBudget: () => void): Sample[] {
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), ab = new Vector3(), ac = new Vector3();
  const samples: Sample[] = [];
  for (const [referenceIndex, info] of meshes.entries()) {
    let totalArea = 0;
    const positions = info.mesh.positions, cumulative = new Float64Array(positions.length / 9);
    for (let i = 0; i < cumulative.length; i++) {
      if ((i & 4095) === 0) checkBudget();
      a.fromArray(positions, i * 9); b.fromArray(positions, i * 9 + 3); c.fromArray(positions, i * 9 + 6);
      const area = ab.subVectors(b, a).cross(ac.subVectors(c, a)).length() / 2;
      if (area > info.precision * info.diagonal) totalArea += area;
      cumulative[i] = totalArea;
    }
    if (!(totalArea > 0) || !Number.isFinite(totalArea)) throw new Error(`Bite reference "${info.mesh.id}" has no usable surface area.`);
    const count = Math.floor(MAX_SAMPLES / meshes.length) + (referenceIndex < MAX_SAMPLES % meshes.length ? 1 : 0);
    let triangleIndex = 0;
    for (let i = 0; i < count; i++) {
      if ((i & 127) === 0) checkBudget();
      const area = totalArea * (i + 0.5) / count;
      while (cumulative[triangleIndex] <= area) triangleIndex++;
      a.fromArray(positions, triangleIndex * 9); b.fromArray(positions, triangleIndex * 9 + 3); c.fromArray(positions, triangleIndex * 9 + 6);
      const u = Math.sqrt(((i + 1) * 0.7548776662466927) % 1), v = ((i + 1) * 0.5698402909980532) % 1;
      const point = a.clone().addScaledVector(ab.subVectors(b, a), u * (1 - v)).addScaledVector(ac.subVectors(c, a), u * v);
      samples.push({ referenceId: info.mesh.id, point, normal: ab.cross(ac).normalize().clone() });
    }
  }
  return samples;
}

function byReference<T extends Sample>(samples: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const sample of samples) {
    const group = groups.get(sample.referenceId);
    if (group) group.push(sample); else groups.set(sample.referenceId, [sample]);
  }
  return groups;
}

function correspondences(state: ArchState, matrix: Matrix4, samples: Sample[], checkBudget: () => void): Match[] {
  const inverse = matrix.clone().invert(), local = new Vector3(), source = new Vector3(), normal = new Vector3();
  return samples.map((sample, i) => {
    if ((i & 127) === 0) checkBudget();
    local.copy(sample.point).applyMatrix4(inverse);
    const distance = state.query.nearestPoint(local, source, normal);
    source.applyMatrix4(matrix);
    normal.transformDirection(matrix);
    return { ...sample, source: source.clone(), distance, validNormal: Math.abs(normal.dot(sample.normal)) >= NORMAL_AGREEMENT };
  });
}

function trimmed(matches: Match[], maxDistance: number): Match[] {
  return [...byReference(matches).values()].flatMap(group => {
    const eligible = group.filter(m => m.validNormal && m.distance <= maxDistance).sort((a, b) => a.distance - b.distance);
    // Each reference keeps its own quota, tied to its original frozen pool.
    return eligible.slice(0, Math.floor(group.length * TRIM_FRACTION));
  });
}

function support(matches: Match[], state: ArchState, poolSize = state.samples.length, referenceId?: string): Support {
  const fail = () => { throw new Error(`${state.mesh.role} arch: insufficient separated, nondegenerate bite support${referenceId ? ` for reference "${referenceId}"` : ''}; use broader matching patches on both arches or adjust the starting pose.`); };
  if (matches.length < MIN_SAMPLES || matches.length < poolSize * 0.7) fail();
  const origin = matches[0].point, center = new Vector3(), covariance = Array<number>(9).fill(0);
  for (const match of matches) center.add(new Vector3().subVectors(match.point, origin));
  center.multiplyScalar(1 / matches.length).add(origin);
  const cells = new Set<string>(), cellSize = state.diagonal * 0.02;
  for (const match of matches) {
    const p = new Vector3().subVectors(match.point, center), v = p.toArray();
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) covariance[a * 3 + b] += v[a] * v[b] / matches.length;
    cells.add(v.map(x => Math.floor(x / cellSize)).join(','));
  }
  const values = symmetricEigen(covariance, 3).values.sort((a, b) => a - b);
  const radius = Math.sqrt(values[0] + values[1] + values[2]);
  if (cells.size < 12 || radius < state.diagonal * 0.06 || values[1] < values[2] * 0.015 || values[0] < values[2] * 1e-4) fail();
  return { center, radius };
}

function supportedInliers(matches: Match[], state: ArchState, maxDistance: number): { inliers: Match[]; spatial: Support } {
  const inliers = trimmed(matches, maxDistance), groups = byReference(inliers);
  for (const [id, pool] of byReference(state.samples)) support(groups.get(id) ?? [], state, pool.length, id);
  return { inliers, spatial: support(inliers, state) };
}

/** Point-to-plane rigid least squares, centered/scaled to expose missing motion constraints. */
function rigidStep(matches: Match[], spatial: Support, role: string): { rotation: Vector3; translation: Vector3 } {
  const h = Array<number>(36).fill(0), rhs = Array<number>(6).fill(0);
  const groups = byReference(matches);
  for (const match of matches) {
    const weight = 1 / (groups.size * groups.get(match.referenceId)!.length);
    const n = match.normal, relative = new Vector3().subVectors(match.source, spatial.center);
    const angular = relative.cross(n).multiplyScalar(1 / spatial.radius);
    const row = [angular.x, angular.y, angular.z, n.x, n.y, n.z];
    const residual = n.dot(new Vector3().subVectors(match.source, match.point));
    for (let a = 0; a < 6; a++) {
      rhs[a] -= row[a] * residual * weight;
      for (let b = 0; b < 6; b++) h[a * 6 + b] += row[a] * row[b] * weight;
    }
  }
  const { values, vectors } = symmetricEigen(h, 6), maximum = Math.max(...values);
  // Reject very weak modes as well as exact rank loss; tiny facets must not make
  // a nearly spherical/cylindrical surface appear strongly pose-constraining.
  if (!(Math.min(...values) > maximum * 1e-3) || !Number.isFinite(maximum)) {
    throw new Error(`${role} arch: bite patches do not constrain a stable rigid pose (flat, symmetric, or weak surface support).`);
  }
  const solution = Array<number>(6).fill(0);
  for (let eigen = 0; eigen < 6; eigen++) {
    let projection = 0;
    for (let a = 0; a < 6; a++) projection += vectors[a * 6 + eigen] * rhs[a];
    for (let a = 0; a < 6; a++) solution[a] += vectors[a * 6 + eigen] * projection / values[eigen];
  }
  if (!solution.every(Number.isFinite)) throw new Error(`${role} arch: could not compute a finite local rigid step.`);
  return { rotation: new Vector3(...solution.slice(0, 3)).multiplyScalar(1 / spatial.radius), translation: new Vector3(...solution.slice(3)) };
}

function stepMatrix(rotation: Vector3, translation: Vector3, center: Vector3, fraction: number): Matrix4 {
  const angle = rotation.length() * fraction;
  const quaternion = angle ? new Quaternion().setFromAxisAngle(rotation.clone().normalize(), angle) : new Quaternion();
  const matrix = new Matrix4().makeRotationFromQuaternion(quaternion);
  const shift = center.clone().sub(center.clone().applyMatrix4(matrix)).addScaledVector(translation, fraction);
  return matrix.setPosition(shift);
}

function isLocal(state: ArchState, matrix: Matrix4, maxDistance: number): boolean {
  const e = matrix.elements, cosine = Math.max(-1, Math.min(1, (e[0] + e[5] + e[10] - 1) / 2));
  if (Math.acos(cosine) > MAX_ANGLE) return false;
  const limit = Math.min(maxDistance * 2, state.diagonal * 0.12), corner = new Vector3();
  for (let i = 0; i < 8; i++) {
    corner.set(i & 1 ? state.box.max.x : state.box.min.x, i & 2 ? state.box.max.y : state.box.min.y, i & 4 ? state.box.max.z : state.box.min.z);
    if (corner.clone().applyMatrix4(matrix).distanceTo(corner) > limit) return false;
  }
  return matrix.elements.every(Number.isFinite);
}

const rms = (matches: Match[]) => Math.sqrt(matches.reduce((sum, m) => sum + m.distance * m.distance, 0) / matches.length);
function trimmedRms(matches: Match[]): number {
  const groups = [...byReference(matches).values()];
  return Math.sqrt(groups.reduce((sum, group) => {
    const distances = group.map(m => m.distance).sort((a, b) => a - b);
    const count = Math.floor(distances.length * TRIM_FRACTION);
    return sum + distances.slice(0, count).reduce((total, d) => total + d * d, 0) / count;
  }, 0) / groups.length);
}

function refineArch(state: ArchState, maxDistance: number, checkBudget: () => void): BiteAlignmentArchResult {
  let matches = correspondences(state, state.matrix, state.samples, checkBudget);
  // Ownership and validation pools are frozen BEFORE any residual/normal trimming.
  const initial = byReference(matches);
  let { inliers, spatial } = supportedInliers(matches, state, maxDistance);
  let step = rigidStep(inliers, spatial, state.mesh.role);
  const beforeRms = rms(matches), close = Math.max(state.precision * 8, Math.min(maxDistance * 0.001, state.diagonal * 1e-5));
  const referenceMetrics = (current: Match[]) => [...byReference(current)].map(([id, pool]) => {
    const before = initial.get(id)!;
    const coverage = (group: Match[]) => group.filter(m => m.validNormal && m.distance <= maxDistance).length / group.length;
    return { id, beforeRms: rms(before), afterRms: rms(pool), samples: pool.length, beforeCoverage: coverage(before), afterCoverage: coverage(pool) };
  });
  const worsenedReference = (references: BiteAlignmentArchResult['references']) => references.find(reference =>
    reference.afterRms > reference.beforeRms + Math.max(close * 2, reference.beforeRms * 0.02));
  const referenceConflict = (reference: BiteAlignmentArchResult['references'][number], rejectedStep = false) => new Error(
    `${state.mesh.role} arch: bite reference "${reference.id}" worsened (${reference.beforeRms.toPrecision(4)} → ${reference.afterRms.toPrecision(4)} file units RMS on ${reference.samples} frozen samples)${rejectedStep ? ' in a rejected step' : ''}; bite captures may conflict. Use compatible captures or check their shared starting alignment. No arch poses were applied.`,
  );
  if (beforeRms <= close) {
    return { id: state.mesh.id, matrix: state.matrix.toArray(), beforeRms, afterRms: beforeRms, samples: state.samples.length, references: referenceMetrics(matches) };
  }
  let score = trimmedRms(matches), converged = false;
  let rejectedReference: BiteAlignmentArchResult['references'][number] | undefined;
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    checkBudget();
    if (iteration) {
      ({ inliers, spatial } = supportedInliers(matches, state, maxDistance));
      step = rigidStep(inliers, spatial, state.mesh.role);
    }
    // Minimize the trimmed objective inside the SAME raw, frozen per-reference
    // bounds used at final validation. Otherwise a robust fit can sacrifice a
    // capture's trimmed-away samples and reject an otherwise useful local fit.
    let accepted = false, localTrial = false;
    const fraction = Math.min(1, (Math.PI / 60) / Math.max(step.rotation.length(), Number.EPSILON));
    for (let trial = 0; trial < 6; trial++) {
      const candidate = stepMatrix(step.rotation, step.translation, spatial.center, fraction / 2 ** trial).multiply(state.matrix);
      if (!isLocal(state, candidate, maxDistance)) continue;
      localTrial = true;
      const next = correspondences(state, candidate, state.samples, checkBudget);
      const regression = worsenedReference(referenceMetrics(next));
      if (regression) { rejectedReference = regression; continue; }
      const nextScore = trimmedRms(next);
      if (nextScore < score - Math.max(state.precision, score * 1e-8)) {
        const gain = score - nextScore;
        matches = next; state.matrix.copy(candidate); score = nextScore; accepted = true;
        if (score <= close || gain < close * 0.01) converged = true;
        break;
      }
    }
    if (!localTrial) throw new Error(`${state.mesh.role} arch: required motion exceeds the local refinement limit; move it closer before retrying.`);
    if (!accepted) { converged = true; break; }
    if (converged) break;
  }
  if (!converged) throw new Error(`${state.mesh.role} arch: local refinement did not converge within ${MAX_ITERATIONS} iterations; move the arch closer first.`);
  ({ inliers, spatial } = supportedInliers(matches, state, maxDistance));
  rigidStep(inliers, spatial, state.mesh.role); // Recheck observability at the final surface pose.
  const afterRms = rms(matches);
  const references = referenceMetrics(matches);
  const regression = worsenedReference(references);
  if (regression) throw referenceConflict(regression);
  if (!isLocal(state, state.matrix, maxDistance)) throw new Error(`${state.mesh.role} arch: refinement exceeded the local motion limit.`);
  if (!(afterRms < beforeRms * 0.98 && beforeRms - afterRms > close * 0.1)) {
    if (rejectedReference) throw referenceConflict(rejectedReference, true);
    throw new Error(`${state.mesh.role} arch: no reliable improvement from the current pose; check matching bite coverage and starting alignment.`);
  }
  if (afterRms > maxDistance * 0.35) throw new Error(`${state.mesh.role} arch: residual surface mismatch remains too large for this local refinement.`);
  return { id: state.mesh.id, matrix: state.matrix.toArray(), beforeRms, afterRms, samples: state.samples.length, references };
}

/**
 * Refines both arches against fixed partial bite surfaces, or throws without a partial result.
 * RMS describes deterministic sampled surface agreement, not contact, volume, or clinical accuracy.
 * Stale requests should be cancelled by terminating their worker; no caller buffers are mutated.
 */
export function refineBiteAlignment(input: BiteAlignmentInput): BiteAlignmentResult {
  const started = performance.now();
  const checkBudget = () => {
    if (performance.now() - started > MAX_DURATION_MS) throw new Error('Local refinement exceeded its time budget; use smaller scans or move the arches closer first.');
  };
  const { arches, bites, maxDistance } = input;
  if (!Number.isFinite(maxDistance) || maxDistance <= 0) throw new Error('Maximum matching distance must be finite and positive, in file units.');
  if (arches.length !== 2 || arches.filter(a => a.role === 'upper').length !== 1 || arches.filter(a => a.role === 'lower').length !== 1) {
    throw new Error('Local bite refinement requires exactly one upper arch and one lower arch.');
  }
  if (!bites.length) throw new Error('At least one fixed bite reference scan is required.');
  if (bites.length > MAX_SAMPLES / (MIN_SAMPLES * 2)) throw new Error('Too many bite references for meaningful coverage on both arches; use fewer compatible captures.');
  const all = [...arches, ...bites];
  if (all.some(m => typeof m.id !== 'string' || !m.id) || new Set(all.map(m => m.id)).size !== all.length) throw new Error('Scan IDs must be nonempty and unique.');
  const infos = all.map(mesh => meshInfo(mesh, checkBudget));
  if (all.reduce((sum, mesh) => sum + mesh.positions.length / 9, 0) > MAX_TRIANGLES) throw new Error('Too many triangles for bounded local refinement; use smaller scans.');
  const states: ArchState[] = arches.map((mesh, i) => ({
    ...infos[i], mesh, query: createNearestSurfaceQuery(mesh.positions, checkBudget), matrix: new Matrix4(), samples: [],
  }));
  const samples = sampleBites(infos.slice(2), checkBudget), closest = new Vector3();
  for (let i = 0; i < samples.length; i++) {
    if ((i & 127) === 0) checkBudget();
    const sample = samples[i], distances = states.map(state => state.query.nearestPoint(sample.point, closest, undefined, maxDistance));
    const owner = distances[0] <= distances[1] ? 0 : 1, other = 1 - owner;
    if (!Number.isFinite(distances[owner])) continue;
    const margin = Math.max(maxDistance * 0.05, distances[owner] * 0.25, states[owner].precision * 8);
    if (distances[other] - distances[owner] <= margin) continue;
    states[owner].samples.push(sample);
  }
  for (const state of states) {
    const groups = byReference(state.samples);
    for (const bite of bites) if ((groups.get(bite.id)?.length ?? 0) < MIN_SAMPLES) {
      throw new Error(`${state.mesh.role} arch: insufficient nearby, unambiguous bite samples for reference "${bite.id}" within the maximum distance; every reference needs matching patches on both arches. Move both arches close to their matching bite patches first or remove the unusable reference.`);
    }
  }
  const results = states.map(state => refineArch(state, maxDistance, checkBudget));
  // Frozen ownership must remain credible after both independent motions.
  const inverses = states.map(state => state.matrix.clone().invert()), local = new Vector3();
  for (let owner = 0; owner < states.length; owner++) {
    let ambiguous = 0;
    for (const [i, sample] of states[owner].samples.entries()) {
      if ((i & 127) === 0) checkBudget();
      const distances = states.map((state, j) => state.query.nearestPoint(local.copy(sample.point).applyMatrix4(inverses[j]), closest));
      const margin = Math.max(maxDistance * 0.025, distances[owner] * 0.25, states[owner].precision * 8);
      if (distances[1 - owner] - distances[owner] <= margin) ambiguous++;
    }
    if (ambiguous > states[owner].samples.length * 0.05) throw new Error(`${states[owner].mesh.role} arch: bite ownership became ambiguous after refinement; improve the starting alignment.`);
  }
  checkBudget();
  return { arches: results, durationMs: performance.now() - started };
}
