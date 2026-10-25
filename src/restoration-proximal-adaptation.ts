import { Triangle, Vector3 } from 'three';
import { createNearestSurfaceQuery } from './collision.ts';
import type { NearestSurfaceQuery } from './collision.ts';
import { cloneShape, CROWN_THETA, CROWN_WALL } from './crown-anatomy.ts';
import { generateRestoration, restorationCrownShape } from './restoration-geometry.ts';
import type { RestorationFitSurface, RestorationSpec } from './restoration-types';

export interface ProximalAdaptationOptions {
  /** Maximum emitted vertex movement / original input crown.width, in (0, .03]. */
  maxDisplacementFraction?: number;
  /** At most three independent strengths, weakest first. Default 3. */
  maxCandidates?: number;
  maxTargetTriangles?: number;
  /** Cooperative worker budget, default 4000 ms, maximum 60000. */
  maxDurationMs?: number;
}
export interface ProximalAdaptationControl {
  checkCancelled?: () => boolean;
  yieldControl?: () => Promise<void>;
}
export interface ProximalSideProposal {
  side: 'mesial' | 'distal';
  targetIds: string[];
  status: 'unknown' | 'not-needed' | 'proposed';
  reason: string;
  facingSamples: number;
  /** Closest eligible vertex on the selected restrictive side target, not exact surface clearance. */
  sampledMinDistance: number | null;
  targetId: string | null;
  targetGap: number | null;
  targetGapProvenance: string | null;
  angularIndex: number | null;
  wallLevel: number | null;
  alignment: number | null;
  requestedDisplacement: number;
  boundedDisplacement: number;
  targetConstraints: { id: string; targetGap: number; facingSamples: number; sampledMinDistance: number | null; requestedDisplacement: number | null }[];
}
export interface ProximalAdaptationReport {
  version: 'proximal-adaptation/v1';
  status: 'proposed' | 'not-needed' | 'rejected';
  reason: string;
  units: 'file units (u)';
  targetTriangles: number;
  originalWidth: number;
  maxDisplacement: number;
  sides: ProximalSideProposal[];
  candidates: { fraction: number; maxDisplacement: number; adjustedVertices: number }[];
  durationMs: number;
  limits: string[];
}
export interface ProximalAdaptationResult {
  /** Strongest constructed proposal; null is not an acceptance or clearance result. */
  spec: RestorationSpec | null;
  /** Independent shapes at increasing strengths, never sequentially stacked. */
  candidates: RestorationSpec[];
  report: ProximalAdaptationReport;
}
export class ProximalAdaptationCancelled extends Error {
  constructor() { super('Proximal adaptation was cancelled.'); this.name = 'ProximalAdaptationCancelled'; }
}
class ProximalBudgetExceeded extends Error {}
const MARKER = 'Local proximal adaptation (proximal-adaptation/v1)';
const defaultYield = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const LIMITS = [
  'Proposals only. The parent must regenerate and completely audit every supplied target, including adjacent teeth, antagonist and crown-only tissue, before accepting a candidate. A facing vertex sample does not prove separation, contact area, penetration depth or clinical contact.',
  'Targets must already be in the restoration parent file coordinates and current pose. Pose registration and tooth-side assignments are caller evidence, not inferred here. Missing or behind-wall targets remain unknown.',
  'Target gaps are frozen once per supplied target. An omitted gap uses 0.015 times the minimum input crown dimension, an explicit engineering hypothesis in file units, never a clinical prescription.',
  'Only intermediate wall radii change. Cervical basal ring, rim ring, rim/rimZ, occlusal/apex, dimensions, component parameters, frame and pose are preserved. Vertex movement is measured on the emitted Float32 crown against the original input crown and bounded by at most 3% of its width.',
  'An adapted provenance marker prevents another application, including after parameter edits. Later parameter changes rescale the patch and require a fresh parent audit; rebuilding from an unadapted shape is an explicit new proposal basis.',
  'The deformation is a smooth local radial bulge, not patient anatomy reconstruction, a boolean operation, a self-intersection proof, or a manufacturing/clinical assessment.',
];

/**
 * Worker-only, bounded proximal wall proposals. All distance targets retain
 * every supplied face; source wall vertices are sampled. Independent variants
 * are built from the same original shape and never accepted in this module.
 */
export async function planProximalAdaptation(input: RestorationSpec, surfaces: readonly RestorationFitSurface[],
  control: ProximalAdaptationControl = {}, options: ProximalAdaptationOptions = {}): Promise<ProximalAdaptationResult> {
  const started = performance.now();
  const fraction = options.maxDisplacementFraction ?? .03, count = options.maxCandidates ?? 3;
  const triangleLimit = options.maxTargetTriangles ?? 1_000_000, duration = options.maxDurationMs ?? 4000;
  if (!(Number.isFinite(fraction) && fraction > 0 && fraction <= .03)) throw new Error('Maximum proximal displacement fraction must be in (0, .03].');
  if (!Number.isSafeInteger(count) || count < 1 || count > 3) throw new Error('Proximal candidate budget must be an integer in [1, 3].');
  if (!Number.isSafeInteger(triangleLimit) || triangleLimit < 1 || triangleLimit > 2_000_000) throw new Error('Proximal target triangle budget must be an integer in [1, 2000000].');
  if (!(Number.isFinite(duration) && duration > 0 && duration <= 60_000)) throw new Error('Proximal time budget must be in (0, 60000] ms.');
  if (!Array.isArray(surfaces) || surfaces.length > 64) throw new Error('Proximal targets require an array of at most 64 surfaces.');
  const cancelled = () => { if (control.checkCancelled?.()) throw new ProximalAdaptationCancelled(); };
  const check = () => { cancelled(); if (performance.now() - started > duration) throw new ProximalBudgetExceeded(); };
  const pause = async () => { await (control.yieldControl ?? defaultYield)(); check(); };
  cancelled();
  const spec = structuredClone(input), original = generateRestoration(spec).find(mesh => mesh.component === 'crown')!;
  const base = restorationCrownShape(spec), { crown: c } = spec.parameters, { frame } = spec;
  const limit = c.width * fraction;
  const report: ProximalAdaptationReport = { version: 'proximal-adaptation/v1', status: 'rejected', reason: '', units: 'file units (u)',
    targetTriangles: 0, originalWidth: c.width, maxDisplacement: limit, sides: [], candidates: [], durationMs: 0, limits: [...LIMITS] };
  const finish = (status: ProximalAdaptationReport['status'], reason: string, candidates: RestorationSpec[] = []): ProximalAdaptationResult => {
    cancelled(); report.status = status; report.reason = reason; report.durationMs = performance.now() - started;
    return { spec: candidates.at(-1) ?? null, candidates, report };
  };
  if (base.source.provenance.includes(MARKER)) return finish('not-needed', 'This shape already carries proximal adaptation; stacking is disabled. Rebuild explicitly from the unadapted shape.');
  const sm = spec.anatomicalSigns?.mesial ?? 1, sb = spec.anatomicalSigns?.buccal ?? 1;
  const angle = c.rotation * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
  const cervical = spec.contour?.cervicalScale ?? 1;
  const contourAt = (level: number) => 1 + (cervical - 1) * (1 - level / (CROWN_WALL - 1)) ** 2;
  const radial = (index: number) => {
    const theta = index / CROWN_THETA * Math.PI * 2, x = c.width / 2 * Math.cos(theta) * sm, y = c.depth / 2 * Math.sin(theta) * sb;
    return new Vector3(...frame.u).multiplyScalar(x * cos - y * sin).addScaledVector(new Vector3(...frame.v), x * sin + y * cos);
  };
  const ids = new Set<string>();
  try {
    // Snapshot ALL selected geometry and metadata before the first yield.
    // Later cancellation/pose updates cannot mix old vertices with new sides,
    // gaps or IDs. Callers still discard a completed result if dependencies changed.
    const snapshots: { id: string; side: 'mesial' | 'distal'; gap: number; provenance: string; positions: Float32Array }[] = [];
    for (const surface of surfaces.filter(s => s?.role === 'adjacent' && (s.side === 'mesial' || s.side === 'distal'))) {
      check();
      if (typeof surface.id !== 'string' || !surface.id.trim() || ids.has(surface.id)) throw new Error('Proximal target IDs must be nonempty and unique.');
      ids.add(surface.id);
      const p = surface.positions;
      if (!(p instanceof Float32Array) || !p.length || p.length % 9) throw new Error(`${surface.id}: proximal target requires nonempty triangle-soup positions.`);
      report.targetTriangles += p.length / 9;
      if (report.targetTriangles > triangleLimit) throw new Error('Proximal targets exceed the triangle budget; provide explicit smaller regions.');
      const gap = surface.targetGap ?? Math.min(c.width, c.depth, c.height) * .015;
      if (!(Number.isFinite(gap) && gap >= 0)) throw new Error('Proximal target gaps must be finite and nonnegative.');
      snapshots.push({ id: surface.id, side: surface.side!, gap, positions: p.slice(),
        provenance: surface.targetProvenance ?? (surface.targetGap === undefined
          ? 'Frozen input-scale hypothesis: .015 × minimum input crown dimension; file units, not clinical clearance.' : 'Caller-supplied file-unit target gap; clinical provenance unspecified.') });
    }
    const targets: { id: string; side: 'mesial' | 'distal'; gap: number; provenance: string; queries: NearestSurfaceQuery[] }[] = [];
    const triangle = new Triangle();
    for (const { positions, ...target } of snapshots) {
      const queries: NearestSurfaceQuery[] = [];
      for (let start = 0; start < positions.length; start += 4096 * 9) {
        await pause();
        const block = positions.subarray(start, start + 4096 * 9);
        if (!block.every(Number.isFinite)) throw new Error(`${target.id}: proximal target coordinates must be finite.`);
        for (let face = 0; face < block.length; face += 9) {
          if ((face / 9 & 255) === 0) check();
          triangle.a.fromArray(block, face); triangle.b.fromArray(block, face + 3); triangle.c.fromArray(block, face + 6);
          const area = triangle.getArea();
          if (!(area > 0 && Number.isFinite(area))) throw new Error(`${target.id}: degenerate target triangles cannot justify proximal growth.`);
        }
        queries.push(createNearestSurfaceQuery(block, check));
      }
      targets.push({ ...target, queries });
    }
    for (const side of ['mesial', 'distal'] as const) {
      const relevant = targets.filter(t => t.side === side).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const row: ProximalSideProposal = { side, targetIds: relevant.map(t => t.id), status: 'unknown', reason: 'No side-labelled adjacent target supplied.',
        facingSamples: 0, sampledMinDistance: null, targetId: null, targetGap: null, targetGapProvenance: null,
        angularIndex: null, wallLevel: null, alignment: null, requestedDisplacement: 0, boundedDisplacement: 0, targetConstraints: [] };
      report.sides.push(row);
      if (!relevant.length) continue;
      const hit = new Vector3(), closest = new Vector3(), delta = new Vector3();
      const samples = relevant.map(target => ({ target, facingSamples: 0, distance: Infinity, level: 0, index: 0, alignment: 0 }));
      // Anatomical theta chooses sides BEFORE signs and crown rotation. The
      // world point matches the generator's signs, rotation and sloped base.
      for (let level = 2; level < CROWN_WALL - 1; level++) for (let index = 0; index < CROWN_THETA; index++) {
        if ((index & 63) === 0) await pause();
        const theta = index / CROWN_THETA * Math.PI * 2;
        if ((side === 'mesial' ? 1 : -1) * Math.cos(theta) < .55) continue;
        // Fixed crown topology: the first corner of the first triangle in a
        // wall quad is this exact emitted vertex (also after winding reversal).
        // Read it directly so both anatomy-local and world Float32 rounding,
        // cervical contour, signs, rotation and abutment slopes match exactly.
        const point = new Vector3().fromArray(original.positions, (level * CROWN_THETA * 2 + index * 2) * 9);
        const direction = radial(index).normalize();
        for (const sample of samples) {
          const { target } = sample;
          let distance = Infinity;
          for (const [block, query] of target.queries.entries()) {
            if (block && (block & 7) === 0) await pause(); else check();
            const next = query.nearestPoint(point, hit, undefined, distance);
            if (Number.isFinite(next) && next <= distance) { distance = next; closest.copy(hit); }
          }
          if (!Number.isFinite(distance)) continue;
          const alignment = distance > 0 ? delta.subVectors(closest, point).dot(direction) / distance : 1;
          if (alignment < .65) continue; // Behind or largely tangential evidence cannot justify radial growth.
          row.facingSamples++; sample.facingSamples++;
          if (distance >= sample.distance) continue;
          Object.assign(sample, { distance, level, index, alignment });
        }
      }
      row.targetConstraints = samples.map(s => ({ id: s.target.id, targetGap: s.target.gap, facingSamples: s.facingSamples,
        sampledMinDistance: Number.isFinite(s.distance) ? s.distance : null,
        requestedDisplacement: Number.isFinite(s.distance) ? Math.max(0, s.distance - s.target.gap) * s.alignment : null }));
      // Every measured side target retains its own frozen gap. A target already
      // within its gap withholds expansion for this side. Otherwise use the
      // most restrictive positive radial deficit, with a deterministic ID tie.
      const measured = samples.filter(s => Number.isFinite(s.distance)).sort((a, b) =>
        (a.distance - a.target.gap) * a.alignment - (b.distance - b.target.gap) * b.alignment
        || (a.target.id < b.target.id ? -1 : a.target.id > b.target.id ? 1 : 0));
      const selected = measured[0];
      if (selected) Object.assign(row, { sampledMinDistance: selected.distance, targetId: selected.target.id, targetGap: selected.target.gap,
        targetGapProvenance: selected.target.provenance, angularIndex: selected.index, wallLevel: selected.level, alignment: selected.alignment });
      if (row.sampledMinDistance === null) { row.reason = 'No outward-facing wall sample reached a side target; the relationship remains unknown.'; continue; }
      row.requestedDisplacement = Math.max(0, row.sampledMinDistance - row.targetGap!) * row.alignment!;
      row.boundedDisplacement = Math.min(limit * .999, row.requestedDisplacement);
      row.status = row.boundedDisplacement > 0 ? 'proposed' : 'not-needed';
      row.reason = row.status === 'proposed' ? 'Bounded radial projection of the observed closest facing gap deficit; parent audit required.'
        : 'A facing sample is already within its frozen target gap; no expansion proposed, without claiming contact or clearance.';
    }
    const active = report.sides.filter(row => row.status === 'proposed');
    if (!active.length) return finish('not-needed', 'No side has a measured, outward-facing positive gap deficit. Missing evidence remains unknown.');
    const strengths = count === 1 ? [1] : count === 2 ? [.5, 1] : [.5, .8, 1], candidates: RestorationSpec[] = [];
    for (const strength of strengths) {
      await pause();
      const shape = cloneShape(base);
      for (let level = 1; level < CROWN_WALL - 1; level++) for (let index = 0; index < CROWN_THETA; index++) {
        let movement = 0;
        for (const seed of active) {
          const da = (index - seed.angularIndex!) / CROWN_THETA * Math.PI * 2;
          const angular = Math.atan2(Math.sin(da), Math.cos(da)) / .55;
          const vertical = (level - seed.wallLevel!) / (CROWN_WALL - 1) / .35;
          if (Math.abs(angular) < 1 && Math.abs(vertical) < 1) movement += seed.boundedDisplacement * strength
            * (1 - angular * angular) ** 2 * (1 - vertical * vertical) ** 2;
        }
        const displacement = Math.min(limit * .999, movement);
        if (displacement > 0) shape.wall[level * CROWN_THETA + index] += displacement / (radial(index).length() * contourAt(level));
      }
      shape.source.provenance = `${base.source.provenance} ${MARKER}: independent bounded wall proposal at strength ${strength}; full target audit required. Basal/rim rings and occlusal anatomy unchanged.`;
      const proposed = { ...structuredClone(spec), crownShape: shape };
      let positions: Float32Array;
      try { positions = generateRestoration(proposed).find(mesh => mesh.component === 'crown')!.positions; }
      catch { continue; } // Construction failure is never an accepted shape.
      let maximum = 0;
      const moved = new Set<string>();
      for (let i = 0; i < positions.length; i += 3) {
        if ((i / 3 & 2047) === 0) check();
        const distance = Math.hypot(positions[i] - original.positions[i], positions[i + 1] - original.positions[i + 1], positions[i + 2] - original.positions[i + 2]);
        maximum = Math.max(maximum, distance);
        if (distance > 0) moved.add(`${original.positions[i]},${original.positions[i + 1]},${original.positions[i + 2]}`);
      }
      // Check the actual Float32 output, including coordinate rounding; an
      // over-bound or unrepresentable variant is withheld, never hand-waved.
      if (!(maximum > 0) || maximum > limit) continue;
      candidates.push(proposed); report.candidates.push({ fraction: strength, maxDisplacement: maximum, adjustedVertices: moved.size });
    }
    return finish(candidates.length ? 'proposed' : 'rejected', candidates.length
      ? 'Independent bounded proximal contour candidates constructed; no candidate has been accepted or certified.'
      : 'No proposed variant survived emitted-geometry construction and displacement bounds.', candidates);
  } catch (error) {
    if (error instanceof ProximalBudgetExceeded) { report.candidates = []; return finish('rejected', 'Proximal adaptation time budget exhausted; no partial candidate returned.'); }
    throw error;
  }
}
