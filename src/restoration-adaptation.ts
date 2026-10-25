import { Vector3 } from 'three';
import { createNearestSurfaceQuery } from './collision.ts';
import type { NearestSurfaceQuery } from './collision.ts';
import { buildCrownMesh, cloneShape, CROWN_RINGS, CROWN_THETA, CROWN_WALL } from './crown-anatomy.ts';
import type { CrownShape } from './crown-anatomy.ts';
import { generateRestoration, restorationCrownShape } from './restoration-geometry.ts';
import type { RestorationFitSurface, RestorationSpec } from './restoration-types';

/**
 * Bounded LOCAL occlusal adaptation seed. Instead of shrinking the whole crown
 * against a localized antagonist, cast forward rays along frame.up from the
 * crown base under each occlusal-table vertex and lower only vertices whose
 * height exceeds the observed hit minus the target gap. Cuts spread with a
 * smooth local falloff so cusp/fossa relief survives outside the conflict.
 * Wall, rim, margin, body parameters, frame and pose are never changed. The
 * result is a candidate for the fitter's complete triangle audit, not clearance.
 */
export interface OcclusalAdaptationOptions {
  /** Largest vertex reduction as a fraction of crown body height; default 0.3. */
  maxRelativeChange?: number;
  /** Falloff radius as a fraction of min(crown width, depth); default 0.2, 0 disables spreading. */
  falloffRadius?: number;
  maxTargetTriangles?: number;
  /** Callers sharing a global budget may pass their remaining time; default 4000, at most 60000. */
  maxDurationMs?: number;
}
export interface OcclusalAdaptationControl {
  /** Return true to cancel, or throw the caller's own cancellation error (propagated unchanged). */
  checkCancelled?: () => boolean;
  yieldControl?: () => Promise<void>;
}
export interface OcclusalAdaptationReport {
  version: 'occlusal-adaptation/v1';
  status: 'adapted' | 'not-needed' | 'rejected';
  reason: string;
  antagonistSurfaces: string[];
  targetTriangles: number;
  /** Target faces whose bounds overlap the crown footprint above its base; rays outside cannot hit others. */
  regionTriangles: number;
  raySamples: number;
  rayHits: number;
  /** Misses keep their original height; their clearance is unknown, never free. */
  unknownRays: number;
  requiredVertices: number;
  adjustedVertices: number;
  maxReduction: number;
  maxRelativeReduction: number;
  maxRelativeChange: number;
  /** Minimum adapted-vertex-to-hit distance along up; vertices only, not a surface bound. */
  minimumVertexRayGap: number | null;
  units: 'file units (u)';
  durationMs: number;
  limits: string[];
}
export interface OcclusalAdaptationResult { spec: RestorationSpec | null; report: OcclusalAdaptationReport }

/** Own class so the fitter can import this module without a cycle; callers may translate it. */
export class OcclusalAdaptationCancelled extends Error {
  constructor() { super('Occlusal adaptation was cancelled.'); this.name = 'OcclusalAdaptationCancelled'; }
}
class AdaptationBudgetExceeded extends Error {}
const defaultYield = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const LIMITS = [
  'Seed only: heights are capped at occlusal-table vertices along frame.up from the crown base. Interpolated triangles between vertices can still reach or cross opposing geometry; the subsequent full-triangle fit audit decides acceptance.',
  'Rays that miss every antagonist leave their vertex unchanged; clearance there is unknown, not free. Static sampled gaps do not establish clinical occlusion or loading.',
  'Body height, width/depth, wall, rim, margin, abutment, fixture, frame and pose are unchanged. Cuts are bounded by a fraction of body height and stay above the radial wall section at each vertex radius (interior fossae may drop below the perimeter rim) plus small numerical reserves that are not material thickness; antagonist overlap with actual wall/rim vertices, or larger conflicts, are reported instead of distorting the crown.',
  'Cut heights are bound to the crown height and relief parameters at proposal time. Later parameter edits rescale them and require remeasurement.',
  'No boolean operation, self-intersection test, material thickness or manufacturing check is performed.',
];

/** Same additive relief the crown generator applies; returns effective normalized heights. */
function relieve(shape: CrownShape, relief: number) {
  const out = cloneShape(shape), rim = shape.rimZ, T = CROWN_THETA;
  for (let i = 0; i < out.occlusal.length; i++) {
    const r = rim[i % T], value = shape.occlusal[i];
    out.occlusal[i] = value + relief * Math.max(0, (value - r) / Math.max(0.05, 1 - r));
  }
  const centre = Array.from(rim).reduce((sum, value) => sum + value, 0) / T;
  out.apex = shape.apex + relief * Math.max(0, (shape.apex - centre) / Math.max(0.05, 1 - centre));
  return { shape: out, centre };
}
/** Inverse of the piecewise-linear, strictly increasing relief map. */
const unrelieve = (effective: number, rim: number, relief: number) => {
  const k = Math.max(0.05, 1 - rim);
  return effective <= rim ? effective : (effective + relief * rim / k) / (1 + relief / k);
};

/** Numerical reserves (fractions of body height), engineering guards, not material thickness or a clinical margin. */
const WALL_RESERVE = 0.01, BASE_RESERVE = 0.05;
/**
 * Lowest effective height an occlusal vertex at normalized radius r and angle
 * index a can take while staying inside the unchanged radial wall section:
 * the highest height at which the piecewise-linear wall radius is <= r. A
 * fossa vertex whose radius is inside the whole wall may drop below the
 * perimeter rim down to the base reserve. a = -1 (apex, r = 0) uses every angle.
 */
function wallFloor(shape: CrownShape, a: number, r: number, H: number) {
  let floor = 0;
  for (const angle of a < 0 ? Array.from({ length: CROWN_THETA }, (_, i) => i) : [a]) {
    const radius = (j: number) => shape.wall[j * CROWN_THETA + angle], height = (j: number) => j / (CROWN_WALL - 1) * shape.rimZ[angle] * H;
    let z = 0;
    if (radius(CROWN_WALL - 1) <= r) z = height(CROWN_WALL - 1);
    else for (let j = CROWN_WALL - 1; j > 0; j--) {
      if (radius(j - 1) > r) continue;
      z = height(j - 1) + (r - radius(j - 1)) / (radius(j) - radius(j - 1)) * (height(j) - height(j - 1));
      break;
    }
    floor = Math.max(floor, z);
  }
  return Math.max(floor + WALL_RESERVE * H, BASE_RESERVE * H);
}

export async function planOcclusalAdaptation(spec: RestorationSpec, surfaces: RestorationFitSurface[], control: OcclusalAdaptationControl = {}, options: OcclusalAdaptationOptions = {}): Promise<OcclusalAdaptationResult> {
  const started = performance.now();
  const maxRelativeChange = options.maxRelativeChange ?? 0.3, falloff = options.falloffRadius ?? 0.2;
  const maxTargetTriangles = options.maxTargetTriangles ?? 1_000_000, maxDurationMs = options.maxDurationMs ?? 4000;
  if (!(maxRelativeChange > 0 && maxRelativeChange <= 0.5)) throw new Error('Maximum relative occlusal change must be in (0, 0.5].');
  if (!(falloff >= 0 && falloff <= 0.5)) throw new Error('Falloff radius must be in [0, 0.5].');
  if (!Number.isSafeInteger(maxTargetTriangles) || maxTargetTriangles < 1) throw new Error('Target triangle budget must be a positive integer.');
  if (!(maxDurationMs > 0 && maxDurationMs <= 60_000)) throw new Error('Time budget must be in (0, 60000] ms.');
  const cancelled = () => { if (control.checkCancelled?.()) throw new OcclusalAdaptationCancelled(); };
  const check = () => { cancelled(); if (performance.now() - started > maxDurationMs) throw new AdaptationBudgetExceeded(); };
  const yieldWork = async () => { await (control.yieldControl ?? defaultYield)(); check(); };
  cancelled();
  // Validates the spec and pins the resolved anatomy; input stays untouched.
  generateRestoration(spec);
  const base = restorationCrownShape(spec);
  const { width: W, depth: D, height: H, cuspHeight, rotation } = spec.parameters.crown;
  const { frame } = spec, a = spec.parameters.abutment;
  const dx = a.height * Math.tan(a.angleY * Math.PI / 180), dy = -a.height * Math.tan(a.angleX * Math.PI / 180);
  const sm = spec.anatomicalSigns?.mesial ?? 1, sb = spec.anatomicalSigns?.buccal ?? 1;
  const cos = Math.cos(rotation * Math.PI / 180), sin = Math.sin(rotation * Math.PI / 180);
  const relief = cuspHeight / H;
  const effective = relieve(base, relief);
  const mesh = buildCrownMesh(effective.shape, [W, D, H]);
  const T = CROWN_THETA, first = CROWN_WALL * T, count = CROWN_RINGS * T + 1; // occlusal rings + apex
  const xs = new Float64Array(count), ys = new Float64Array(count), zs = new Float64Array(count), floors = new Float64Array(count);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const wallXs = new Float64Array(first), wallYs = new Float64Array(first), wallZs = new Float64Array(first);
  const place = (v: number) => {
    const lx = mesh.vertices[v * 3] * sm, ly = mesh.vertices[v * 3 + 1] * sb, x = dx + lx * cos - ly * sin, y = dy + lx * sin + ly * cos;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    return [x, y, mesh.vertices[v * 3 + 2]];
  };
  for (let v = 0; v < first; v++) [wallXs[v], wallYs[v], wallZs[v]] = place(v);
  for (let i = 0; i < count; i++) {
    [xs[i], ys[i], zs[i]] = place(first + i);
    floors[i] = wallFloor(base, i < count - 1 ? i % T : -1, i < count - 1 ? base.rim[i % T] * (1 - (Math.floor(i / T) + 1) / (CROWN_RINGS + 1)) : 0, H);
  }
  const scale = Math.min(W, D, H), pad = scale * 1e-4;
  const antagonists = (Array.isArray(surfaces) ? surfaces : []).filter(surface => surface?.role === 'antagonist');
  const report = (status: OcclusalAdaptationReport['status'], reason: string, extra: Partial<OcclusalAdaptationReport> = {}): OcclusalAdaptationReport => ({
    version: 'occlusal-adaptation/v1', status, reason, antagonistSurfaces: antagonists.map(s => s.id), targetTriangles: 0, regionTriangles: 0,
    raySamples: 0, rayHits: 0, unknownRays: 0, requiredVertices: 0, adjustedVertices: 0, maxReduction: 0, maxRelativeReduction: 0,
    maxRelativeChange, minimumVertexRayGap: null, units: 'file units (u)', durationMs: performance.now() - started, limits: LIMITS, ...extra,
  });
  if (!antagonists.length) return { spec: null, report: report('rejected', 'No antagonist target was supplied; the opposing relationship is unmeasured.') };

  try {
    // Crop each target to faces whose frame-space bounds overlap the crown
    // footprint above the base. Any face hit by a footprint ray satisfies this,
    // so the crop preserves exact ray results while bounding BVH preparation.
    const queries: { id: string; gap: number; query: NearestSurfaceQuery[] }[] = [];
    let targetTriangles = 0, regionTriangles = 0;
    const [ox, oy, oz] = frame.origin, { u, v, up } = frame;
    for (const surface of antagonists) {
      const p = surface.positions;
      if (!(p instanceof Float32Array) || !p.length || p.length % 9) throw new Error(`${surface.id}: target must be nonempty triangle-soup positions.`);
      if (surface.targetGap !== undefined && !(Number.isFinite(surface.targetGap) && surface.targetGap >= 0)) throw new Error('Target gaps must be finite, nonnegative file-unit values.');
      targetTriangles += p.length / 9;
      if (targetTriangles > maxTargetTriangles) throw new Error('Antagonist targets exceed the triangle budget; select an explicit local region.');
      const kept: number[] = [];
      for (let t = 0; t < p.length; t += 9) {
        if ((t / 9 & 4095) === 0) { if (t && (t / 9 & 65535) === 0) await yieldWork(); else check(); }
        let lx = Infinity, hx = -Infinity, ly = Infinity, hy = -Infinity, hz = -Infinity;
        for (let c = t; c < t + 9; c += 3) {
          const rx = p[c] - ox, ry = p[c + 1] - oy, rz = p[c + 2] - oz;
          if (!Number.isFinite(rx + ry + rz)) throw new Error(`${surface.id}: target coordinates must be finite.`);
          const fx = rx * u[0] + ry * u[1] + rz * u[2], fy = rx * v[0] + ry * v[1] + rz * v[2], fz = rx * up[0] + ry * up[1] + rz * up[2];
          lx = Math.min(lx, fx); hx = Math.max(hx, fx); ly = Math.min(ly, fy); hy = Math.max(hy, fy); hz = Math.max(hz, fz);
        }
        if (hx >= minX - pad && lx <= maxX + pad && hy >= minY - pad && ly <= maxY + pad && hz > a.height) for (let c = t; c < t + 9; c++) kept.push(p[c]);
      }
      regionTriangles += kept.length / 9;
      const positions = Float32Array.from(kept), blocks: NearestSurfaceQuery[] = [];
      for (let start = 0; start < positions.length; start += 8192 * 9) {
        await yieldWork();
        blocks.push(createNearestSurfaceQuery(positions.subarray(start, start + 8192 * 9), check));
      }
      queries.push({ id: surface.id, gap: surface.targetGap ?? scale * 0.025, query: blocks });
    }
    const extra = { targetTriangles, regionTriangles, raySamples: count };
    if (!regionTriangles) return { spec: null, report: report('rejected', 'No antagonist geometry lies over the crown footprint; occlusal clearance is unknown, not free.', { ...extra, unknownRays: count }) };

    // Allowed effective height = nearest forward hit minus that target's gap.
    const allowed = new Float64Array(count).fill(Infinity), hitDistance = new Float64Array(count).fill(Infinity);
    const origin = new Vector3(), direction = new Vector3(...up);
    let hits = 0;
    for (let i = 0; i < count; i++) {
      if ((i & 127) === 0) await yieldWork();
      const fx = xs[i], fy = ys[i], fz = a.height;
      origin.set(ox + fx * u[0] + fy * v[0] + fz * up[0], oy + fx * u[1] + fy * v[1] + fz * up[1], oz + fx * u[2] + fy * v[2] + fz * up[2]);
      for (const target of queries) for (const block of target.query) {
        const distance = block.rayDistance(origin, direction);
        if (Number.isFinite(distance)) {
          hitDistance[i] = Math.min(hitDistance[i], distance);
          allowed[i] = Math.min(allowed[i], distance - target.gap);
        }
      }
      if (Number.isFinite(hitDistance[i])) hits++;
    }
    Object.assign(extra, { rayHits: hits, unknownRays: count - hits });
    // The unchanged wall/rim is checked directly: an antagonist hit below any
    // actual wall vertex (minus gap) cannot be resolved by an occlusal cut.
    for (let w = 0; w < first; w++) {
      if ((w & 127) === 0) await yieldWork();
      const fx = wallXs[w], fy = wallYs[w], fz = a.height;
      origin.set(ox + fx * u[0] + fy * v[0] + fz * up[0], oy + fx * u[1] + fy * v[1] + fz * up[1], oz + fx * u[2] + fy * v[2] + fz * up[2]);
      for (const target of queries) for (const block of target.query) {
        if (block.rayDistance(origin, direction) - target.gap < wallZs[w]) return { spec: null, report: report('rejected', 'Observed antagonist overlaps the unchanged crown rim/wall; a local occlusal cut cannot resolve it. Revisit base height, site or bite registration instead.', extra) };
      }
    }
    if (!hits) return { spec: null, report: report('rejected', 'Every forward occlusal ray missed the antagonist; clearance is unknown, not free.', extra) };

    const required = new Float64Array(count);
    let requiredVertices = 0, maxRequired = 0;
    for (let i = 0; i < count; i++) {
      const cut = zs[i] - allowed[i];
      if (!(cut > 0)) continue;
      if (allowed[i] < floors[i]) return { spec: null, report: report('rejected', 'A required occlusal cut would cross the unchanged radial wall section (or base reserve) at that vertex radius; revisit base height, site or bite registration instead.', { ...extra, requiredVertices: requiredVertices + 1 }) };
      required[i] = cut; requiredVertices++; maxRequired = Math.max(maxRequired, cut);
    }
    if (!requiredVertices) return { spec: null, report: report('not-needed', 'No occlusal vertex exceeds its observed antagonist hit minus target gap; sampled vertices alone do not prove triangle clearance.', extra) };
    if (maxRequired > maxRelativeChange * H) return { spec: null, report: report('rejected', `A local cut of ${(maxRequired / H * 100).toFixed(1)}% body height exceeds the ${(maxRelativeChange * 100).toFixed(0)}% distortion bound; the conflict needs a site, base or bite review rather than a deeper cut.`, { ...extra, requiredVertices, maxReduction: maxRequired, maxRelativeReduction: maxRequired / H }) };

    // Smooth max-dilation of the required cuts. Each required vertex still gets
    // at least its cut; neighbours never drop below min(original, rim floor).
    const radius = falloff * Math.min(W, D), displacement = new Float64Array(count);
    const sources = Array.from(required.keys()).filter(i => required[i] > 0);
    for (let j = 0; j < count; j++) {
      if ((j & 255) === 0) check();
      let best = required[j];
      if (radius > 0) for (const i of sources) {
        const d2 = ((xs[i] - xs[j]) ** 2 + (ys[i] - ys[j]) ** 2) / (radius * radius);
        if (d2 < 1) best = Math.max(best, required[i] * (1 - d2) ** 2);
      }
      displacement[j] = Math.min(best, Math.max(required[j], zs[j] - floors[j]));
      if (!(displacement[j] > 0)) displacement[j] = 0;
    }
    const shape = cloneShape(base);
    let adjusted = 0, maxReduction = 0, minimumGap = Infinity;
    for (let i = 0; i < count; i++) {
      const z = zs[i] - displacement[i];
      if (Number.isFinite(hitDistance[i])) minimumGap = Math.min(minimumGap, hitDistance[i] - z);
      if (!displacement[i]) continue;
      adjusted++; maxReduction = Math.max(maxReduction, displacement[i]);
      if (i < count - 1) shape.occlusal[i] = unrelieve(z / H, base.rimZ[i % T], relief);
      else shape.apex = unrelieve(z / H, effective.centre, relief);
    }
    shape.source = { ...shape.source, provenance: `${base.source.provenance} Local occlusal adaptation (occlusal-adaptation/v1): ${adjusted} occlusal vertices lowered by at most ${maxReduction.toPrecision(3)} u (${(maxReduction / H * 100).toFixed(1)}% body height) against forward antagonist ray hits; wall, rim and body dimensions unchanged.` };
    const adapted: RestorationSpec = { ...structuredClone({ ...spec, crownShape: undefined }), crownShape: shape };
    try { generateRestoration(adapted); }
    catch (error) { return { spec: null, report: report('rejected', `Adapted crown failed construction checks: ${error instanceof Error ? error.message : String(error)}`, extra) }; }
    cancelled();
    return { spec: adapted, report: report('adapted', `Lowered ${adjusted} occlusal vertices locally (${requiredVertices} required by ray hits); body height unchanged.`, {
      ...extra, requiredVertices, adjustedVertices: adjusted, maxReduction, maxRelativeReduction: maxReduction / H,
      minimumVertexRayGap: Number.isFinite(minimumGap) ? minimumGap : null }) };
  } catch (error) {
    if (error instanceof AdaptationBudgetExceeded) return { spec: null, report: report('rejected', 'Adaptation time budget exhausted; select a smaller antagonist region.') };
    throw error;
  }
}

/** New independent spec with an adapted crownShape, or null when no bounded local adaptation applies. */
export async function proposeOcclusalAdaptation(spec: RestorationSpec, surfaces: RestorationFitSurface[], control?: OcclusalAdaptationControl, options?: OcclusalAdaptationOptions): Promise<RestorationSpec | null> {
  return (await planOcclusalAdaptation(spec, surfaces, control, options)).spec;
}
