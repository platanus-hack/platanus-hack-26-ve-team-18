import { Ray, Triangle, Vector3 } from 'three';
import { createNearestSurfaceQuery } from './collision.ts';
import type { NearestSurfaceQuery } from './collision.ts';
import type { Vec3 } from './models';
import type { RestorationFitSurface, RestorationMesh, RestorationSpec } from './restoration-types';

export interface FixtureGingivaOptions {
  /** Optional prototype allowance in file units; never a clinical threshold. */
  exposureTolerance?: number;
  /** Explicit total remaining nominal depth allowance. Omitted means no proposal. */
  maxDepthIncrease?: number;
}
export interface FixtureGingivaControl {
  /** Caller-owned deadlines/errors propagate unchanged. */
  check?: () => void;
  checkCancelled?: () => boolean;
  yieldControl?: () => Promise<void>;
}
export interface FixtureGingivaSample {
  point: Vec3;
  status: 'known' | 'missed' | 'ambiguous';
  /** Signed axial elevation: positive is above the observed tissue. */
  exposure: number | null;
  numericTolerance: number;
  exposureTolerance: number;
}
export interface FixtureGingivaReport {
  version: 'fixture-gingiva/v1';
  status: 'pass' | 'fail' | 'unknown';
  maxExposure: number | null;
  knownSamples: number;
  samples: number;
  coverage: number;
  missedSamples: number;
  ambiguousSamples: number;
  sampleMeasurements: FixtureGingivaSample[];
  /** Maximum of the per-sample numerical/prototype allowances. */
  numericTolerance: number;
  exposureTolerance: number;
  requiredDepthIncrease: number | null;
  units: 'file units (u)';
  clinicalChecks: { boneDepth: 'unknown'; rootClearance: 'unknown'; containment: 'unknown'; clinicalSafety: 'unknown' };
  limits: string[];
}

export interface AbutmentGingivaSample extends FixtureGingivaSample {
  /** Required only for vertices observed above the single-valued gum envelope. */
  crownSupport: 'not-required' | 'supported' | 'unsupported' | 'unknown';
  crownDistance: number | null;
}
export interface AbutmentGingivaReport {
  version: 'abutment-gingiva/v1';
  /** Failure requires a vertex above observed gum and outside the actual crown. */
  status: 'pass' | 'fail' | 'unknown';
  samples: number;
  knownSamples: number;
  missedSamples: number;
  ambiguousSamples: number;
  coverage: number;
  exposedSamples: number;
  supportedSamples: number;
  unsupportedSamples: number;
  unknownSupportSamples: number;
  maxUnsupportedExposure: number | null;
  numericTolerance: number;
  crownTolerance: number | null;
  sampleMeasurements: AbutmentGingivaSample[];
  units: 'file units (u)';
  clinicalChecks: FixtureGingivaReport['clinicalChecks'];
  limits: string[];
}

interface GingivaInput {
  spec: RestorationSpec; components: readonly RestorationMesh[];
  surfaces: readonly RestorationFitSurface[]; options?: FixtureGingivaOptions;
}

/** Used before cooperative work starts; a budget exit must retain an unknown. */
export function unmeasuredAbutmentGingiva(reason: string): AbutmentGingivaReport {
  return { version: 'abutment-gingiva/v1', status: 'unknown', samples: 0, knownSamples: 0,
    missedSamples: 0, ambiguousSamples: 0, coverage: 0, exposedSamples: 0, supportedSamples: 0,
    unsupportedSamples: 0, unknownSupportSamples: 0, maxUnsupportedExposure: null,
    numericTolerance: 0, crownTolerance: null, sampleMeasurements: [], units: 'file units (u)',
    clinicalChecks: { boneDepth: 'unknown', rootClearance: 'unknown', containment: 'unknown', clinicalSafety: 'unknown' },
    limits: [reason, 'No completed emitted-vertex gum/crown-support sample set. Clinical emergence, bone depth, root clearance and tissue containment remain unknown.'] };
}

// Includes every vertex of the bounded helical fixture, without substituting
// a smooth cylinder or dropping thread-root samples from the exposure check.
const BLOCK_FACES = 4096, MAX_TARGET_FACES = 1_000_000, MAX_FIXTURE_FACES = 10_000, MAX_SAMPLES = 5000;
const FLOAT32_EPSILON = 2 ** -23;
const defaultYield = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export interface CrownPointSupport {
  status: 'enclosed' | 'outside' | 'unknown';
  /** Unsigned distance to the actual emitted crown boundary; never thickness. */
  distance: number | null;
}

/** Shared by the gum-exposure and independent core-support audits. Every
 * supplied point and every crown face is retained. Boundary/grazing witnesses
 * stay unknown; a nearest face normal alone cannot establish a solid sign. */
export async function measureClosedCrownPoints(crown: RestorationMesh | undefined, points: readonly Vec3[],
  control: FixtureGingivaControl = {}, projectionTolerance = 0): Promise<{ samples: CrownPointSupport[]; numericTolerance: number | null; limits: string[] }> {
  const samples: CrownPointSupport[] = points.map(() => ({ status: 'unknown', distance: null }));
  let numericTolerance: number | null = null;
  const limits: string[] = [];
  const started = performance.now();
  // Local cap supplements the caller's cancellation/deadline. Partial outside
  // witnesses survive this cap; unfinished samples never become enclosed.
  class SupportTimeBudget extends Error {}
  const cancelled = () => {
    control.check?.();
    if (control.checkCancelled?.()) { const error = new Error('Crown support measurement was cancelled.'); error.name = 'AbutmentGingivaCancelled'; throw error; }
  };
  const check = () => {
    cancelled();
    if (performance.now() - started >= 4000) throw new SupportTimeBudget();
  };
  const pause = async () => { check(); await (control.yieldControl ?? defaultYield)(); check(); };
  const unknown = (reason: string) => { limits.push(reason); return { samples, numericTolerance, limits }; };
  const p = crown?.positions;
  check();
  if (!p || !crown?.closed || !(p instanceof Float32Array) || !p.length || p.length % 9)
    return unknown('Missing, open or invalid emitted crown; sampled support is unknown.');
  if (p.length / 9 > MAX_FIXTURE_FACES || points.length > MAX_SAMPLES)
    return unknown('Crown or pilar exceeds the full-evidence support measurement bound; no subsampling is permitted.');
  if (!points.length) return unknown('No emitted pilar vertices in the crown-support region; support is unknown.');
  if (!points.every(point => point.every(Number.isFinite))) return unknown('Nonfinite emitted support points; support is numerically unresolved.');
  try {
    const faces: { triangle: Triangle; altitude: number }[] = [];
    const edges = new Map<string, { count: number; balance: number }>();
    const low: Vec3 = [Infinity, Infinity, Infinity], high: Vec3 = [-Infinity, -Infinity, -Infinity];
    let magnitude = 0;
    for (let face = 0; face < p.length / 9; face++) {
      if (face % 256 === 0) await pause();
      const vertices: Vector3[] = [], keys: string[] = [];
      for (let corner = 0; corner < 3; corner++) {
        const point = new Vector3().fromArray(p, face * 9 + corner * 3);
        if (![point.x, point.y, point.z].every(Number.isFinite)) return unknown('Nonfinite emitted crown positions; support is numerically unresolved.');
        vertices.push(point); keys.push(`${point.x},${point.y},${point.z}`);
        for (let axis = 0; axis < 3; axis++) {
          const value = point.getComponent(axis);
          magnitude = Math.max(magnitude, Math.abs(value));
          low[axis] = Math.min(low[axis], value); high[axis] = Math.max(high[axis], value);
        }
      }
      const triangle = new Triangle(...vertices as [Vector3, Vector3, Vector3]);
      const longest = Math.max(vertices[0].distanceTo(vertices[1]), vertices[1].distanceTo(vertices[2]), vertices[2].distanceTo(vertices[0]));
      const altitude = 2 * triangle.getArea() / longest;
      if (!(altitude > 0) || !Number.isFinite(altitude)) return unknown('Degenerate emitted crown triangles prevent support classification.');
      faces.push({ triangle, altitude });
      for (let corner = 0; corner < 3; corner++) {
        const from = keys[corner], to = keys[(corner + 1) % 3], key = from < to ? `${from}|${to}` : `${to}|${from}`;
        const edge = edges.get(key) ?? { count: 0, balance: 0 };
        edge.count++; edge.balance += from < to ? 1 : -1; edges.set(key, edge);
      }
    }
    if ([...edges.values()].some(edge => edge.count !== 2 || edge.balance !== 0))
      return unknown('Actual crown edges are open, nonmanifold or inconsistently wound; support is unknown.');
    for (const point of points) magnitude = Math.max(magnitude, ...point.map(Math.abs));
    numericTolerance = Math.max(projectionTolerance, magnitude * FLOAT32_EPSILON * 8 + 2 ** -146);
    if (numericTolerance >= Math.min(...high.map((value, axis) => value - low[axis])) / 64)
      return unknown('Crown support is numerically unresolved at the emitted coordinate scale.');
    const query = createNearestSurfaceQuery(p, check);
    const directions = [new Vector3(1, .371390676, .694137121),
      new Vector3(-.432713219, 1, .173205081), new Vector3(.237129113, -.613791337, 1),
      new Vector3(Math.SQRT2, Math.sqrt(3), -Math.sqrt(5)), new Vector3(-Math.sqrt(7), Math.sqrt(11), Math.sqrt(13)),
      new Vector3(Math.sqrt(17), -Math.sqrt(19), Math.sqrt(23)), new Vector3(-Math.sqrt(29), -Math.sqrt(31), Math.sqrt(37))]
      .map(direction => direction.normalize());
    const point = new Vector3(), hit = new Vector3(), barycentric = new Vector3(), nearest = new Vector3();
    const ray = new Ray(), normal = new Vector3();
    let faceTests = 0;
    for (let index = 0; index < points.length; index++) {
      if (index % 16 === 0) await pause();
      point.fromArray(points[index]);
      const distance = query.nearestPoint(point, nearest), sample = samples[index];
      if (!Number.isFinite(distance)) continue;
      sample.distance = distance;
      if (distance <= numericTolerance) continue;
      const parities: number[] = [];
      for (const direction of directions) {
        ray.set(point, direction);
        let intersections = 0, ambiguous = false;
        for (const face of query.rayTriangleCandidates(point, direction)) {
          const { triangle, altitude } = faces[face];
          if (++faceTests % 32768 === 0) await pause();
          if (!ray.intersectTriangle(triangle.a, triangle.b, triangle.c, false, hit)) continue;
          triangle.getBarycoord(hit, barycentric); triangle.getNormal(normal);
          if (Math.min(barycentric.x, barycentric.y, barycentric.z) <= numericTolerance / altitude
            || Math.abs(normal.dot(direction)) <= Math.sqrt(FLOAT32_EPSILON)) { ambiguous = true; break; }
          intersections++;
        }
        // A fixed bounded pool provides additional independent evidence when
        // one ray grazes tessellation edges. Only clean rays establish parity;
        // no number of grazing rays can stand in for three agreeing clean rays.
        if (ambiguous) continue;
        parities.push(intersections % 2);
        if (parities.some(value => value !== parities[0])) break;
      }
      if (parities.length >= 3 && parities.every(value => value === parities[0]))
        sample.status = parities[0] ? 'enclosed' : 'outside';
    }
    if (samples.some(sample => sample.status === 'unknown')) limits.push('Boundary proximity, grazing/edge ray hits, contradictory parity or unresolved nearest distance leave support samples unknown.');
  } catch (error) {
    if (!(error instanceof SupportTimeBudget)) throw error;
    limits.push('The bounded crown-support audit timed out. Completed outside witnesses are retained; unfinished support samples are unknown.');
  }
  // Let a queued cancellation invalidate even the final synchronous ray. The
  // local cap only limits unfinished work; it cannot erase completed witnesses.
  await (control.yieldControl ?? defaultYield)(); cancelled();
  return { samples, numericTolerance, limits };
}

/**
 * Sampled directional IOS envelope only. Exact emitted Float32 vertices include
 * the fixture's top, all rings and cap centres; no nominal cylinder replaces it.
 * Every supplied tissue triangle is retained, in bounded collision-BVH blocks.
 * All work and report data are local; input geometry/specification is unmodified.
 */
export function measureFixtureGingiva(input: GingivaInput,
  control: FixtureGingivaControl = {}): Promise<FixtureGingivaReport> {
  return measureGingivaEnvelope(input, control, 'fixture');
}

async function measureGingivaEnvelope(input: GingivaInput, control: FixtureGingivaControl,
  component: 'fixture' | 'abutment'): Promise<FixtureGingivaReport> {
  const check = () => {
    control.check?.();
    if (control.checkCancelled?.()) {
      const error = new Error(`${component} gingiva measurement was cancelled.`);
      error.name = 'FixtureGingivaCancelled'; throw error;
    }
  };
  const pause = async () => { check(); await (control.yieldControl ?? defaultYield)(); check(); };
  check();
  const { spec, options = {} } = input;
  for (const name of ['exposureTolerance', 'maxDepthIncrease'] as const) {
    const value = options[name];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) throw new Error(`${name} must be finite nonnegative file units.`);
  }
  const { origin, u, v, up } = spec.frame;
  if ([origin, u, v, up].some(p => !Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite)) ||
      [u, v, up].some(p => Math.abs(dot(p, p) - 1) > 1e-8) ||
      [dot(u, v), dot(u, up), dot(v, up)].some(n => Math.abs(n) > 1e-8)) throw new Error('Gingiva measurement requires a finite orthonormal source frame.');
  const { depth, length, radius } = spec.parameters.fixture;
  if (![depth, length, radius].every(Number.isFinite) || depth < 0 || length <= 0 || radius <= 0) throw new Error('Gingiva measurement requires finite nonnegative depth and positive fixture dimensions.');
  const report: FixtureGingivaReport = {
    version: 'fixture-gingiva/v1', status: 'unknown', maxExposure: null,
    knownSamples: 0, samples: 0, coverage: 0, missedSamples: 0, ambiguousSamples: 0, sampleMeasurements: [],
    numericTolerance: 0, exposureTolerance: options.exposureTolerance ?? 0, requiredDepthIncrease: null, units: 'file units (u)',
    clinicalChecks: { boneDepth: 'unknown', rootClearance: 'unknown', containment: 'unknown', clinicalSafety: 'unknown' },
    limits: [
      'Directional visible-tissue envelope at emitted fixture vertices only; unsampled fixture interiors and holes between rays remain unknown. This is not continuous surface coverage, contact area or overlap volume.',
      'Bone depth, root clearance, 3D containment and clinical safety remain unknown; IOS tissue and file units establish none of these.',
      'Numeric allowances follow Float32 coordinate scale and ray incidence, with no file-unit floor or assumed clinical threshold. Allowances reaching 1/64 of the fixture radius or length are numerically unresolved, not a pass. They do not bound scan uncertainty or certify an unrounded surface.',
      'A depth proposal changes nominal fixture.depth only, preserving origin/frame and crown position. Regenerate the bridged abutment and remeasure; rounded transverse coordinates can change.',
    ],
  };
  const finish = (reason?: string) => { if (reason) report.limits.push(reason); check(); return report; };
  const fixtures = input.components.filter(c => c.component === component);
  if (fixtures.length !== 1 || !fixtures[0].positions.length) return finish(`Missing or ambiguous emitted ${component}; gingival exposure is unknown.`);
  const positions = fixtures[0].positions;
  const tissue = input.surfaces.filter(surface => surface.role === 'tissue');
  const validate = (p: Float32Array) => {
    if (!(p instanceof Float32Array) || p.length % 9) throw new Error('Gingiva geometry requires complete Float32 triangle-soup positions.');
  };
  validate(positions); tissue.forEach(surface => validate(surface.positions));
  if (positions.length / 9 > MAX_FIXTURE_FACES) return finish(`Fixture exceeds the ${MAX_FIXTURE_FACES}-face measurement bound; exposure is unknown.`);
  const targetFaces = tissue.reduce((sum, surface) => sum + surface.positions.length / 9, 0);
  if (targetFaces > MAX_TARGET_FACES) return finish(`Tissue exceeds the ${MAX_TARGET_FACES}-face measurement bound; no target subsampling or pass is permitted.`);

  let magnitude = Math.max(...origin.map(Math.abs)), localMagnitude = 0, low = Infinity, high = -Infinity;
  const project = (p: ArrayLike<number>, offset: number): Vec3 => {
    const x = p[offset], y = p[offset + 1], z = p[offset + 2];
    if (![x, y, z].every(Number.isFinite)) throw new Error('Gingiva geometry requires finite positions.');
    magnitude = Math.max(magnitude, Math.abs(x), Math.abs(y), Math.abs(z));
    const relative: Vec3 = [x - origin[0], y - origin[1], z - origin[2]];
    const local: Vec3 = [dot(relative, u), dot(relative, v), dot(relative, up)];
    localMagnitude = Math.max(localMagnitude, ...local.map(Math.abs));
    low = Math.min(low, local[2]); high = Math.max(high, local[2]);
    return local;
  };
  const seen = new Set<string>(), samples: { point: Vec3; local: Vec3 }[] = [];
  let sourceDegenerate = false;
  const sourceTriangle = new Triangle();
  for (let i = 0; i < positions.length; i += 3) {
    if (i % (BLOCK_FACES * 9) === 0) await pause();
    const local = project(positions, i), point: Vec3 = [positions[i], positions[i + 1], positions[i + 2]], key = point.join(',');
    if (i % 9 === 0) {
      sourceTriangle.a.fromArray(positions, i); sourceTriangle.b.fromArray(positions, i + 3); sourceTriangle.c.fromArray(positions, i + 6);
      if (!(sourceTriangle.getArea() > 0)) sourceDegenerate = true;
    }
    if (!seen.has(key)) { seen.add(key); samples.push({ point, local }); }
    if (samples.length > MAX_SAMPLES) return finish(`Fixture exceeds the ${MAX_SAMPLES}-unique-vertex measurement bound; no sample truncation or pass is permitted.`);
  }
  report.samples = samples.length;
  // For the pilar, numerical resolution follows its actual emitted bounds,
  // including a moved/slanted component, rather than the nominal fixture size.
  const extent = (axis: number) => Math.max(...samples.map(s => s.local[axis])) - Math.min(...samples.map(s => s.local[axis]));
  const resolution = component === 'fixture' ? Math.min(radius, length) : Math.min(extent(0), extent(1), extent(2));
  // Float64 change of basis retains the supplied Float32 triangles without a
  // second Float32 rounding and makes opposing rays share exactly the same x/y.
  const blocks: NearestSurfaceQuery[] = [], grazingProjections: NearestSurfaceQuery[] = [];
  let degenerate = false;
  const a = new Vector3(), b = new Vector3(), c = new Vector3();
  for (const surface of tissue) for (let start = 0; start < surface.positions.length; start += BLOCK_FACES * 9) {
    await pause();
    const count = Math.min(BLOCK_FACES * 9, surface.positions.length - start), local = new Float64Array(count);
    for (let i = 0; i < count; i += 3) local.set(project(surface.positions, start + i), i);
    const grazing: number[] = [];
    for (let i = 0; i < count; i += 9) {
      a.fromArray(local, i); b.fromArray(local, i + 3).sub(a); c.fromArray(local, i + 6).sub(a);
      const area = b.cross(c).length();
      if (area === 0) degenerate = true;
      else if (Math.abs(b.z) / area <= Math.sqrt(FLOAT32_EPSILON)) {
        // A ray lying in a vertical triangle has no first ray hit. Retain its
        // XY projection separately so triangle order/grouping cannot hide a
        // fold by choosing a horizontal neighbour's nearest normal instead.
        for (let corner = 0; corner < 3; corner++) grazing.push(local[i + corner * 3], local[i + corner * 3 + 1], 0);
      }
    }
    blocks.push(createNearestSurfaceQuery(local, check));
    if (grazing.length) grazingProjections.push(createNearestSurfaceQuery(Float64Array.from(grazing), check));
  }
  // Coordinate-rounding allowance, strengthened per ray by its slope below.
  const numeric = Math.max(magnitude, localMagnitude) * FLOAT32_EPSILON * 8 + 2 ** -146;
  const rayEpsilon = Math.max(localMagnitude, high - low) * Number.EPSILON * 128 + Number.MIN_VALUE;
  report.numericTolerance = numeric;
  report.exposureTolerance = Math.max(numeric, options.exposureTolerance ?? 0);
  // Include all tissue, even layers entirely above/below the fixture itself.
  const padding = Math.max(high - low, numeric), bottom = low - padding, top = high + padding;
  const forward = new Vector3(0, 0, 1), backward = new Vector3(0, 0, -1);
  const rayStart = new Vector3(), hit = new Vector3(), nearest = new Vector3(), normal = new Vector3();
  let exposed = false, correction = 0, rayCalls = 0;
  for (let index = 0; index < samples.length; index++) {
    if (index % 32 === 0) await pause();
    const sample = samples[index], [x, y, z] = sample.local;
    let below = Infinity, above = Infinity, winner: NearestSurfaceQuery | undefined;
    for (const block of blocks) {
      if (++rayCalls % 256 === 0) await pause();
      check();
      const distance = block.rayDistance(rayStart.set(x, y, bottom), forward, below);
      if (distance < below) { below = distance; winner = block; }
      above = Math.min(above, block.rayDistance(rayStart.set(x, y, top), backward, above));
    }
    let status: FixtureGingivaSample['status'] = 'missed', exposure: number | null = null, tolerance = numeric;
    let grazing = false;
    for (const projection of grazingProjections) {
      if (++rayCalls % 256 === 0) await pause();
      if (projection.nearestPoint(rayStart.set(x, y, 0), nearest, undefined, numeric) <= numeric) { grazing = true; break; }
    }
    if (grazing || Number.isFinite(below) || Number.isFinite(above)) {
      status = 'ambiguous';
      const lower = bottom + below, upper = top - above;
      // Distinct intersections, irrespective of prototype tolerance, are not a
      // single-valued tissue surface. Duplicate/copanar faces do not add layers.
      if (!grazing && winner && Number.isFinite(below) && Number.isFinite(above) && Math.abs(upper - lower) <= rayEpsilon) {
        winner.nearestPoint(hit.set(x, y, lower), nearest, normal);
        const incidence = Math.abs(normal.z);
        // Near-parallel triangles amplify coordinate error too strongly for a
        // Float32 envelope assertion. This dimensionless guard is numerical.
        tolerance = incidence > 0 ? numeric / incidence : numeric;
        if (incidence > Math.sqrt(FLOAT32_EPSILON) && tolerance < resolution / 64 && nearest.distanceTo(hit) <= rayEpsilon) {
          exposure = z - (lower + upper) / 2;
          status = 'known'; report.knownSamples++;
          report.maxExposure = Math.max(report.maxExposure ?? -Infinity, exposure);
          exposed ||= exposure > Math.max(tolerance, options.exposureTolerance ?? 0);
          correction = Math.max(correction, exposure + 2 * tolerance);
        }
      }
    }
    report.numericTolerance = Math.max(report.numericTolerance, tolerance);
    report.exposureTolerance = Math.max(report.exposureTolerance, tolerance);
    if (status === 'missed') report.missedSamples++;
    if (status === 'ambiguous') report.ambiguousSamples++;
    report.sampleMeasurements.push({ point: sample.point, status, exposure, numericTolerance: tolerance, exposureTolerance: Math.max(tolerance, options.exposureTolerance ?? 0) });
  }
  report.coverage = report.knownSamples / report.samples;
  const complete = report.knownSamples === report.samples && !degenerate && !sourceDegenerate;
  report.status = exposed ? 'fail' : complete ? 'pass' : 'unknown';
  if (!targetFaces) report.limits.push('No visible tissue patch supplied; gingival exposure is unknown.');
  if (!complete) report.limits.push('Incomplete or ambiguous tissue-ray coverage; unknown samples cannot pass or support a depth proposal. Observed exposure still fails.');
  if (degenerate) report.limits.push('Degenerate supplied tissue triangles prevent a complete envelope assertion.');
  if (sourceDegenerate) report.limits.push('Degenerate emitted component triangles prevent a complete envelope assertion.');
  if (component === 'abutment') return finish();
  // A proposal assumes the emitted fixture corresponds to this nominal spec.
  const fixtureLow = Math.min(...samples.map(s => s.local[2])), fixtureHigh = Math.max(...samples.map(s => s.local[2]));
  const matchesSpec = Math.abs(fixtureHigh + depth) <= numeric && Math.abs(fixtureLow + depth + length) <= numeric;
  if (!matchesSpec) report.limits.push('Emitted fixture axial bounds differ from the nominal specification; no depth proposal.');
  if (options.maxDepthIncrease === undefined) report.limits.push('No explicit maxDepthIncrease bound supplied; no depth proposal.');
  else if (complete && matchesSpec) {
    const increase = report.status === 'pass' ? 0 : Math.max(0, correction);
    if (increase <= options.maxDepthIncrease && Number.isFinite(depth + increase) && (increase === 0 || depth + increase > depth)) report.requiredDepthIncrease = increase;
    else report.limits.push('Required depth increase exceeds the explicit bound or nominal numeric range; no clipped correction is proposed.');
  }
  return finish();
}

/**
 * A transgingival pilar need not have zero gum crossings. Instead, look for
 * emitted vertices above a usable gum ray which also lack crown support.
 * Missing gum cannot be replaced by the construction origin or nearest normal.
 * This runs in the caller's worker and propagates its cancellation/deadline.
 */
export async function measureAbutmentGingiva(input: Omit<GingivaInput, 'options'>,
  control: FixtureGingivaControl = {}): Promise<AbutmentGingivaReport> {
  const envelope = await measureGingivaEnvelope(input, control, 'abutment');
  const check = () => {
    control.check?.();
    if (control.checkCancelled?.()) {
      const error = new Error('Abutment gingiva measurement was cancelled.');
      error.name = 'AbutmentGingivaCancelled'; throw error;
    }
  };
  const pause = async () => { check(); await (control.yieldControl ?? defaultYield)(); check(); };
  const report: AbutmentGingivaReport = {
    version: 'abutment-gingiva/v1', status: 'unknown', samples: envelope.samples,
    knownSamples: envelope.knownSamples, missedSamples: envelope.missedSamples,
    ambiguousSamples: envelope.ambiguousSamples, coverage: envelope.coverage,
    exposedSamples: 0, supportedSamples: 0, unsupportedSamples: 0, unknownSupportSamples: 0,
    maxUnsupportedExposure: null, numericTolerance: envelope.numericTolerance, crownTolerance: null,
    sampleMeasurements: envelope.sampleMeasurements.map(sample => ({ ...sample, crownSupport: 'not-required', crownDistance: null })),
    units: 'file units (u)', clinicalChecks: envelope.clinicalChecks,
    limits: [
      'Emitted abutment vertices are tested against opposing axial rays through every supplied gum triangle. A vertex above a known gum envelope must be supported by the actual emitted crown; the construction origin and nominal radii cannot substitute.',
      'Missing, multilayer, near-parallel or numerically unresolved gum rays remain unknown. An open scan supplies a directional surface only; it establishes no tissue interior or clinical emergence contour.',
      'Crown support uses actual closed, consistently joined, nondegenerate triangles, unsigned boundary distance and three agreeing non-edge ray parities. Open or inconsistent crown geometry, edge hits and contradictory parities remain unknown. Supplied closure flags alone are insufficient.',
      'Pass applies only to this emitted vertex sample set. Unsampled faces, self-intersections, wall thickness, intaglio, clinical emergence, tissue response, hardware compatibility, bone depth and root clearance remain unassessed. No contact area, overlap volume or surgical correction is inferred.',
    ],
  };
  const exposed = report.sampleMeasurements.filter(sample => sample.status === 'known' && sample.exposure! > sample.exposureTolerance);
  report.exposedSamples = exposed.length;
  // No crown work is needed for vertices demonstrably below the gum envelope.
  const crowns = input.components.filter(mesh => mesh.component === 'crown');
  const crown = crowns.length === 1 ? crowns[0] : undefined;
  const support = await measureClosedCrownPoints(crown, exposed.map(sample => sample.point), control);
  report.crownTolerance = support.numericTolerance;
  for (let index = 0; index < exposed.length; index++) {
    const sample = exposed[index], measured = support.samples[index];
    sample.crownDistance = measured.distance;
    // Retain the legacy gum audit's boundary-support convention. The independent
    // core-support criterion deliberately leaves boundary proximity unknown.
    sample.crownSupport = measured.status === 'enclosed'
      || measured.distance !== null && support.numericTolerance !== null && measured.distance <= support.numericTolerance
      ? 'supported' : measured.status === 'outside' ? 'unsupported' : 'unknown';
    if (sample.crownSupport === 'supported') report.supportedSamples++;
    else if (sample.crownSupport === 'unsupported') {
      report.unsupportedSamples++;
      report.maxUnsupportedExposure = Math.max(report.maxUnsupportedExposure ?? -Infinity, sample.exposure!);
    } else report.unknownSupportSamples++;
  }
  const usableEnvelope = envelope.status !== 'unknown' && envelope.samples > 0 && envelope.knownSamples === envelope.samples &&
    !envelope.limits.some(limit => /Degenerate/.test(limit));
  report.status = report.unsupportedSamples > 0 ? 'fail' : usableEnvelope && report.unknownSupportSamples === 0 ? 'pass' : 'unknown';
  if (exposed.length) report.limits.push(...support.limits);
  if (!usableEnvelope) report.limits.push('Incomplete or ambiguous gum evidence prevents a sample-set pass; observed unsupported exposure still fails.');
  await pause();
  return report;
}
