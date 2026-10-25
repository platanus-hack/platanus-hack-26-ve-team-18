import { Triangle, Vector3 } from 'three';
import { createNearestSurfaceQuery } from './collision.ts';
import type { NearestSurfaceQuery } from './collision.ts';
import { createFitIntersectionQuery } from './restoration-fit-intersections.ts';
import { MAX_VERIFIED_TARGET_FACES, verifyFitIntersections } from './restoration-fit-verification.ts';
import { crownTissueRegions, generateRestoration, restorationCrownShape, restorationReferencePlanes } from './restoration-geometry.ts';
import { acceptsFitCandidate } from './restoration-fit-selection.ts';
import { DEFAULT_QUALITY_TOLERANCES, evaluateRestorationQuality, measureCrownExtents, RESTORATION_QUALITY_CONTEXT_VERSION } from './restoration-quality.ts';
import { planOcclusalAdaptation } from './restoration-adaptation.ts';
import type { RestorationFitHistoryEntry, RestorationFitInput, RestorationFitMeasurement, RestorationFitOptions,
  RestorationFitResult, RestorationFitSurface, RestorationMesh, RestorationParameters, RestorationSpec } from './restoration-types';

export interface RestorationFitControl {
  checkCancelled?: () => boolean;
  onPhase?: (phase: 'creating' | 'fitting') => void;
  /** Worker callers yield between candidates so cancel/new-job messages can run. */
  yieldControl?: () => Promise<void>;
}
export class RestorationFitCancelled extends Error {
  constructor() { super('Restoration fitting was cancelled.'); this.name = 'RestorationFitCancelled'; }
}
class FitBudgetExceeded extends Error {}
const defaultYield = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const copyParameters = (p: RestorationParameters): RestorationParameters => ({ fixture: { ...p.fixture }, abutment: { ...p.abutment }, crown: { ...p.crown } });
const boundedInteger = (value: number | undefined, fallback: number, min: number, max: number, name: string) => {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error(`${name} must be an integer in [${min}, ${max}].`);
  return result;
};
function optionsOf(options: RestorationFitOptions = {}) {
  if (options.tissueSource !== undefined && !['crown', 'crown-and-abutment'].includes(options.tissueSource)) throw new Error('Unknown tissue audit source.');
  if (options.verifyBaselineIntersections !== undefined && typeof options.verifyBaselineIntersections !== 'boolean') throw new Error('Full baseline verification must be boolean.');
  return {
    tissueSource: options.tissueSource ?? 'crown-and-abutment',
    verifyBaselineIntersections: options.verifyBaselineIntersections ?? false,
    maxCandidates: boundedInteger(options.maxCandidates, 32, 1, 80, 'Candidate budget'),
    maxDurationMs: boundedInteger(options.maxDurationMs, 12_000, 100, 60_000, 'Time budget'),
    samplesPerSurface: boundedInteger(options.samplesPerSurface, 320, 16, 2048, 'Sample budget'),
    maxTargetTriangles: boundedInteger(options.maxTargetTriangles, 1_000_000, 1, 2_000_000, 'Distance target triangle budget'),
    maxIntersectionTriangles: boundedInteger(options.maxIntersectionTriangles, 4096, 1, 20_000, 'Intersection target triangle budget'),
  };
}

/** Region-specific crown/abutment centroids selected across cumulative face-area strata. */
function sampleRestoration(components: RestorationMesh[], spec: RestorationSpec, surface: RestorationFitSurface, count: number, check: () => void) {
  const { origin, u, v, up } = spec.frame, { crown, abutment } = spec.parameters;
  const baseX = abutment.height * Math.tan(abutment.angleY * Math.PI / 180);
  const baseY = -abutment.height * Math.tan(abutment.angleX * Math.PI / 180);
  const centre = new Vector3(), triangle = new Triangle(), relative = new Vector3(), normal = new Vector3();
  const samples: { point: Vector3; cumulative: number }[] = [];
  let area = 0;
  for (const component of components) {
    if (component.component === 'fixture' || (!['tissue', 'source-arch'].includes(surface.role) && component.component !== 'crown')) continue;
    const positions = component.positions;
    for (let i = 0; i < positions.length; i += 9) {
      if ((i / 9 & 255) === 0) check();
      triangle.a.fromArray(positions, i); triangle.b.fromArray(positions, i + 3); triangle.c.fromArray(positions, i + 6);
      triangle.getMidpoint(centre); triangle.getNormal(normal);
      relative.set(centre.x - origin[0], centre.y - origin[1], centre.z - origin[2]);
      const x = (relative.x * u[0] + relative.y * u[1] + relative.z * u[2] - baseX) * (spec.anatomicalSigns?.mesial ?? 1);
      const y = relative.x * v[0] + relative.y * v[1] + relative.z * v[2] - baseY;
      const z = relative.x * up[0] + relative.y * up[1] + relative.z * up[2] - abutment.height;
      const nz = normal.x * up[0] + normal.y * up[1] + normal.z * up[2];
      if (surface.role === 'adjacent') {
        if (z < crown.height * 0.2 || z > crown.height * 0.9 || Math.abs(nz) > 0.85) continue;
        if (surface.side === 'mesial' && x < crown.width * 0.2) continue;
        if (surface.side === 'distal' && x > -crown.width * 0.2) continue;
        if (!surface.side && Math.abs(x) < crown.width * 0.2 && Math.abs(y) < crown.depth * 0.2) continue;
      } else if (surface.role === 'antagonist') {
        if (z < crown.height * 0.55 || nz <= 0.05) continue;
      } else if (surface.role !== 'other-tooth') {
        // Tissue relationships include the artificial crown base and complete
        // generic abutment; a trans-site crossing remains an unresolved conflict.
        if (component.component === 'crown' && z > crown.height * 0.35) continue;
      }
      const faceArea = triangle.getArea();
      if (!(faceArea > 0)) continue;
      area += faceArea;
      samples.push({ point: centre.clone(), cumulative: area });
    }
  }
  if (!samples.length) throw new Error(`No restoration samples in the ${surface.role} objective region.`);
  const selected: Vector3[] = [], selectedIndices = new Set<number>();
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    const target = (i + 0.5) / count * area;
    while (cursor < samples.length - 1 && samples[cursor].cumulative < target) cursor++;
    if (!selectedIndices.has(cursor)) { selectedIndices.add(cursor); selected.push(samples[cursor].point); }
  }
  return { points: selected, regionTriangles: samples.length, regionArea: area };
}

function morphologyPenalty(spec: RestorationSpec, initial: RestorationSpec) {
  const p = spec.parameters, b = initial.parameters;
  return 0.04 * (
    ((p.crown.width - b.crown.width) / b.crown.width) ** 2 + ((p.crown.depth - b.crown.depth) / b.crown.depth) ** 2 +
    ((p.crown.height - b.crown.height) / b.crown.height) ** 2 + ((p.crown.cuspHeight - b.crown.cuspHeight) / b.crown.height) ** 2 +
    ((p.abutment.height - b.abutment.height) / b.abutment.height) ** 2 + ((p.crown.rotation - b.crown.rotation) / 20) ** 2 +
    ((p.abutment.angleX - b.abutment.angleX) / 12) ** 2 + ((p.abutment.angleY - b.abutment.angleY) / 12) ** 2);
}

/** Soft objective terms from explicitly measured source envelopes. A clear
 * triangle audit alone gives no incentive to repair an oversized crown. These
 * terms guide bounded proposals; independent quality/evidence gates still
 * decide acceptance, and fixture inference is never used as scale evidence. */
function measuredEnvelopePenalty(spec: RestorationSpec, components: RestorationMesh[]) {
  const context = spec.qualityContext;
  if (context?.version !== RESTORATION_QUALITY_CONTEXT_VERSION || context.units !== 'file units (u)') return 0;
  const extents = measureCrownExtents(spec, components);
  if (!extents) return 0;
  const excess = (value: number, reference: number, high: number) => Math.max(0, value / reference - high) ** 2;
  const measured = (value: typeof context.gapWidth) => value?.provenance === 'measured' && Number.isFinite(value.value) && value.value > 0;
  let penalty = 0;
  if (measured(context.gapWidth)) penalty += 4 * excess(extents.mesiodistal, context.gapWidth!.value, DEFAULT_QUALITY_TOLERANCES.gapOccupancy[1]);
  if (context.bitePoseVerified === true && measured(context.availableHeight)) {
    penalty += 4 * excess(extents.top, context.availableHeight!.value, DEFAULT_QUALITY_TOLERANCES.heightOccupancyMax);
  }
  for (const [key, emitted, high] of [
    ['mesiodistal', extents.mesiodistal, DEFAULT_QUALITY_TOLERANCES.widthToNeighbor[1]],
    ['buccolingual', extents.buccolingual, DEFAULT_QUALITY_TOLERANCES.depthToNeighbor[1]],
    ['height', extents.top, DEFAULT_QUALITY_TOLERANCES.heightToNeighbor[1]],
  ] as const) {
    const neighbors = context.neighbors?.filter(neighbor => typeof neighbor[key] === 'number' && Number.isFinite(neighbor[key]) && neighbor[key]! > 0) ?? [];
    if (!neighbors.length || neighbors.some(neighbor => neighbor.provenance !== 'measured')) continue;
    const average = neighbors.reduce((sum, neighbor) => sum + neighbor[key]!, 0) / neighbors.length;
    penalty += .25 * excess(emitted, average, high);
  }
  return penalty;
}

/**
 * Deterministic local concept fitting. Fixture placement is held fixed. Targets
 * are named subsets in the parent's original file coordinates; callers resolve
 * poses before dispatch and must invalidate results when any dependency changes.
 * This optimizes an illustrative envelope, never clinical bite/tissue clearance.
 */
export async function fitRestoration(input: RestorationFitInput, control: RestorationFitControl = {}): Promise<RestorationFitResult> {
  const options = optionsOf(input?.options), started = performance.now();
  const cancelled = () => { if (control.checkCancelled?.()) throw new RestorationFitCancelled(); };
  const check = () => { cancelled(); if (performance.now() - started > options.maxDurationMs) throw new FitBudgetExceeded('Fitting time budget exhausted.'); };
  const yieldWork = async () => { await (control.yieldControl ?? defaultYield)(); cancelled(); };
  cancelled();
  const initial = structuredClone(input.spec);
  control.onPhase?.('creating');
  const baseComponents = generateRestoration(initial);
  // Donor selection already ran before fitting. Pin the resolved fallback as
  // well, so later parameter edits/reopens do not silently choose a new form.
  initial.crownShape ??= restorationCrownShape(initial);
  control.onPhase?.('fitting');
  if (!Array.isArray(input.surfaces) || input.surfaces.length > 16) throw new Error('Fitting requires at most 16 separately named target surfaces.');
  let total = 0;
  const ids = new Set<string>();
  const surfaces = input.surfaces.map(surface => {
    if (!surface || typeof surface.id !== 'string' || !surface.id.trim() || ids.has(surface.id)) throw new Error('Fit surface IDs must be nonempty and unique.');
    ids.add(surface.id);
    if (!['adjacent', 'antagonist', 'tissue', 'source-arch', 'other-tooth'].includes(surface.role)) throw new Error('Fit targets must be categorized as adjacent, antagonist, other tooth, tissue or unclassified source arch; bite references are not collision targets.');
    if (surface.side !== undefined && !['mesial', 'distal'].includes(surface.side)) throw new Error('Adjacent side must be mesial or distal.');
    if (surface.side && surface.role !== 'adjacent') throw new Error('Only adjacent targets have a mesial/distal side.');
    const p = surface.positions;
    if (!(p instanceof Float32Array) || p.length === 0 || p.length % 9 || !p.every(Number.isFinite)) throw new Error(`${surface.id}: target must be finite, nonempty triangle-soup positions.`);
    total += p.length / 9;
    if (total > options.maxTargetTriangles) throw new Error('Full-resolution distance targets exceed the total triangle budget; select an explicit local region.');
    if (surface.targetGap !== undefined && (!Number.isFinite(surface.targetGap) || surface.targetGap < 0)) throw new Error('Target gaps must be finite, nonnegative file-unit values.');
    if (surface.weight !== undefined && (!Number.isFinite(surface.weight) || surface.weight <= 0 || surface.weight > 100)) throw new Error('Objective weights must be finite in (0, 100].');
    return { ...surface, positions: p.slice() };
  });
  const scale = Math.min(initial.parameters.crown.width, initial.parameters.crown.depth, initial.parameters.crown.height);
  cancelled();
  type TargetDistanceQuery = Pick<NearestSurfaceQuery, 'nearestPoint' | 'rayDistance'>;
  const prepared: { surface: RestorationFitSurface; nearest: TargetDistanceQuery; intersection: ReturnType<typeof createFitIntersectionQuery>; targetGap: number; weight: number }[] = [];
  async function prepareNearest(positions: Float32Array): Promise<TargetDistanceQuery> {
    // Build exact queries over bounded face blocks, yielding between them. A
    // single million-face sort otherwise prevents queued worker cancellation
    // from running during target preparation. Querying every block preserves
    // the complete supplied triangle surface; no target faces are sampled out.
    const blockCoordinates = 8192 * 9, blocks: NearestSurfaceQuery[] = [];
    for (let start = 0; start < positions.length; start += blockCoordinates) {
      if (start) { await yieldWork(); check(); }
      blocks.push(createNearestSurfaceQuery(positions.subarray(start, start + blockCoordinates), check));
    }
    if (blocks.length === 1) return blocks[0];
    const nearestPoint = new Vector3(), nearestNormal = new Vector3();
    return { rayDistance(sample, direction, maximum = Infinity) {
      let best = maximum, found = false;
      for (const [index, block] of blocks.entries()) {
        if ((index & 31) === 0) check();
        const distance = block.rayDistance(sample, direction, best);
        if (Number.isFinite(distance) && distance <= best) { found = true; best = distance; }
      }
      return found ? best : Infinity;
    }, nearestPoint(sample, target, normal, maximum = Infinity) {
      let best = maximum, found = false;
      for (const [index, block] of blocks.entries()) {
        if ((index & 31) === 0) check();
        const distance = block.nearestPoint(sample, nearestPoint, normal ? nearestNormal : undefined, best);
        if (Number.isFinite(distance) && distance <= best) {
          found = true; best = distance; target.copy(nearestPoint);
          if (normal) normal.copy(nearestNormal);
        }
      }
      return found ? best : Infinity;
    } };
  }
  for (const surface of surfaces) {
    await yieldWork(); check();
    prepared.push({ surface, nearest: await prepareNearest(surface.positions),
      intersection: createFitIntersectionQuery(surface.positions, options.maxIntersectionTriangles, check),
      targetGap: surface.targetGap ?? (surface.role === 'source-arch' || surface.role === 'other-tooth' ? 0 : scale * (surface.role === 'adjacent' ? 0.015 : surface.role === 'antagonist' ? 0.025 : 0.01)), weight: surface.weight ?? 1 });
  }
  const point = new Vector3(), occlusalDirection = new Vector3(...initial.frame.up);
  const baselineRayCoverage = new Map<string, number>();
  async function measure(spec: RestorationSpec, components: RestorationMesh[], previous?: RestorationFitMeasurement): Promise<RestorationFitMeasurement> {
    if (!prepared.length) await yieldWork();
    let objectiveScore = 0;
    const crown = components.find(c => c.component === 'crown');
    if (!crown) throw new Error('Generated crown is missing.');
    const body = { ...crown, positions: crownTissueRegions(spec, crown).body };
    const tissueComponents = components.filter(c => c.component !== 'fixture');
    const tissuePositions = new Float32Array(tissueComponents.reduce((sum, c) => sum + c.positions.length, 0));
    let offset = 0;
    for (const component of tissueComponents) { tissuePositions.set(component.positions, offset); offset += component.positions.length; }
    const measurements: RestorationFitMeasurement['surfaces'] = [];
    for (const target of prepared) {
      // A worker message can run between targets and distance batches, including
      // during the baseline. A partial measurement is never put in history.
      await yieldWork();
      check();
      const crownOnly = target.surface.role === 'tissue' && options.tissueSource === 'crown';
      const samples = sampleRestoration(crownOnly ? [body] : components, spec, target.surface, options.samplesPerSurface, check);
      const distances: number[] = [];
      const rayGaps: number[] = [];
      for (const [index, sample] of samples.points.entries()) {
        if (index && (index & 63) === 0) { await yieldWork(); check(); }
        const distance = target.nearest.nearestPoint(sample, point);
        if (!Number.isFinite(distance)) throw new Error(`${target.surface.id}: no finite triangle-surface distance.`);
        distances.push(distance);
        if (target.surface.role === 'antagonist') {
          const gap = target.nearest.rayDistance(sample, occlusalDirection);
          if (Number.isFinite(gap)) rayGaps.push(gap);
        }
      }
      distances.sort((a, b) => a - b);
      const sampledMinDistance = distances[0];
      const gapErrors = distances.map(distance => target.surface.role === 'adjacent' ? distance - target.targetGap : Math.min(0, distance - target.targetGap));
      const clearanceRms = Math.sqrt(gapErrors.reduce((sum, error) => sum + error * error, 0) / distances.length);
      // Adjacent objective approaches a small closest patch, not every lateral
      // sample at once. Clearance objectives penalize only under-gap samples.
      const patch = distances.slice(0, Math.max(1, Math.ceil(distances.length * 0.08)));
      const patchError = patch.reduce((sum, distance) => sum + (distance - target.targetGap) ** 2, 0) / patch.length;
      const sampledRmsGapError = target.surface.role === 'adjacent' ? Math.sqrt(patchError) : clearanceRms;
      const source = crownOnly ? body.positions : ['tissue', 'source-arch'].includes(target.surface.role) ? tissuePositions : crown.positions;
      let intersections = target.intersection.test(source);
      const previousTarget = previous?.surfaces.find(surface => surface.id === target.surface.id);
      // A sampled zero cannot erase an observed crossing or replace complete
      // evidence. Screen every supplied target face before accepting its removal.
      if (!intersections.intersectionComplete && ((options.verifyBaselineIntersections && !previous)
        || (intersections.transverseCrossingTriangles === 0 && previousTarget
          && (previousTarget.intersectionComplete || (previousTarget.transverseCrossingTriangles ?? previousTarget.intersectingTriangles) > 0
            || (intersections.intersectingTriangles === 0 && previousTarget.intersectingTriangles > 0))))) {
        intersections = await verifyFitIntersections(source, target.surface.positions, { check, yieldControl: yieldWork }) ?? intersections;
        check();
      }
      const error = target.surface.role === 'adjacent' ? patchError : sampledRmsGapError ** 2;
      // Approach only an observed opposing patch along the restorative axis.
      // A nearest lateral wall or a surface behind the crown cannot close a bite.
      rayGaps.sort((a, b) => a - b);
      const rayPatch = rayGaps.slice(0, Math.max(1, Math.ceil(rayGaps.length * .08)));
      const occlusalError = rayPatch.length ? rayPatch.reduce((sum, gap) => sum + (gap - target.targetGap) ** 2, 0) / rayPatch.length : 0;
      const coverage = rayGaps.length / distances.length;
      if (!baselineRayCoverage.has(target.surface.id)) baselineRayCoverage.set(target.surface.id, coverage);
      const lostCoverage = Math.max(0, baselineRayCoverage.get(target.surface.id)! - coverage);
      // Do not saturate at 128 faces: large observed crossing counts must still
      // provide a direction for relief. Counts are not penetration or volume.
      objectiveScore += target.weight * ((error + occlusalError) / (scale * scale) + lostCoverage * 4 + (intersections.intersectingTriangles ? 4 + Math.log2(1 + intersections.intersectingTriangles) : 0) + (intersections.intersectionComplete ? 0 : 0.5));
      measurements.push({ id: target.surface.id, role: target.surface.role, ...(target.surface.side ? { side: target.surface.side } : {}),
        ...(crownOnly ? { sourceRegion: 'crown-body' as const } : {}),
        ...(options.tissueSource === 'crown' ? { sourceComponents: source === tissuePositions ? ['crown', 'abutment'] as ('crown' | 'abutment')[] : ['crown'] as 'crown'[] } : {}),
        targetGap: target.targetGap, targetProvenance: target.surface.targetProvenance ?? (target.surface.targetGap === undefined ? 'Scale-relative prototype hypothesis; no clinical contact prescription.' : 'Caller-supplied file-unit target; clinical provenance unspecified.'), weight: target.weight, targetTriangles: target.surface.positions.length / 9, samples: distances.length,
        sampledMinDistance, sampledRmsGapError, nearSamples: distances.filter(distance => distance <= target.targetGap).length,
        sampledMedianDistance: distances[Math.floor((distances.length - 1) * 0.5)],
        sampledP95Distance: distances[Math.floor((distances.length - 1) * 0.95)],
        sampledMaxGapDeficit: Math.max(0, target.targetGap - sampledMinDistance),
        ...(target.surface.role === 'antagonist' ? { occlusalRaySamples: distances.length, occlusalRayHits: rayGaps.length,
          sampledOcclusalGap: rayGaps[0] ?? null, sampledOcclusalGapError: rayGaps.length ? Math.sqrt(occlusalError) : null } : {}),
        sampledRegionTriangles: samples.regionTriangles, sampledRegionArea: samples.regionArea, ...intersections });
    }
    objectiveScore += measuredEnvelopePenalty(spec, components);
    const penalty = morphologyPenalty(spec, initial);
    const score = objectiveScore + penalty;
    if (!Number.isFinite(score)) throw new Error('Fitting objective overflowed at these coordinates/targets.');
    return { score, objectiveScore, morphologyPenalty: penalty, surfaces: measurements };
  }
  let bestSpec = initial, bestComponents = baseComponents;
  let before: RestorationFitMeasurement;
  try { before = await measure(initial, baseComponents); }
  catch (error) { if (error instanceof FitBudgetExceeded) throw new Error('Time budget exhausted before the baseline could be measured; use smaller named target regions.'); throw error; }
  let best = before;
  const initialQuality = evaluateRestorationQuality({ spec: initial, components: baseComponents, measurement: before, context: initial.qualityContext });
  let bestQuality = initialQuality;
  const anatomyCandidates = [initial.crownShape];
  let bestAnatomy = 0, adaptationNote = '';
  const history: RestorationFitHistoryEntry[] = [{ candidate: 0, parameters: copyParameters(initial.parameters), measurement: before, accepted: true, quality: initialQuality, anatomyCandidate: 0 }];
  let termination: RestorationFitResult['report']['termination'] = surfaces.length ? 'candidate-budget' : 'no-surfaces';
  const initialP = initial.parameters;
  const dimensions: { read: (p: RestorationParameters) => number; write: (p: RestorationParameters, value: number) => void; step: number; low: number; high: number }[] = [
    { read: p => p.crown.height, write: (p, v) => { p.crown.height = v; }, step: initialP.crown.height * 0.08, low: initialP.crown.height * 0.72, high: initialP.crown.height * 1.2 },
    { read: p => p.crown.width, write: (p, v) => { p.crown.width = v; }, step: initialP.crown.width * 0.06, low: initialP.crown.width * 0.82, high: initialP.crown.width * 1.18 },
    { read: p => p.crown.depth, write: (p, v) => { p.crown.depth = v; }, step: initialP.crown.depth * 0.06, low: initialP.crown.depth * 0.82, high: initialP.crown.depth * 1.18 },
    { read: p => p.crown.cuspHeight, write: (p, v) => { p.crown.cuspHeight = v; }, step: Math.max(initialP.crown.cuspHeight, initialP.crown.height * 0.15) * 0.15, low: initialP.crown.cuspHeight * 0.55, high: initialP.crown.cuspHeight * 1.15 },
    { read: p => p.abutment.angleY, write: (p, v) => { p.abutment.angleY = v; }, step: 2, low: Math.max(-80, initialP.abutment.angleY - 6), high: Math.min(80, initialP.abutment.angleY + 6) },
    { read: p => p.abutment.angleX, write: (p, v) => { p.abutment.angleX = v; }, step: 2, low: Math.max(-80, initialP.abutment.angleX - 6), high: Math.min(80, initialP.abutment.angleX + 6) },
    { read: p => p.abutment.height, write: (p, v) => { p.abutment.height = v; }, step: initialP.abutment.height * 0.06, low: initialP.abutment.height * 0.82, high: initialP.abutment.height * 1.18 },
    { read: p => p.crown.rotation, write: (p, v) => { p.crown.rotation = v; }, step: 3, low: Math.max(-360, initialP.crown.rotation - 9), high: Math.min(360, initialP.crown.rotation + 9) },
  ];
  // These bounds stay tied to the ORIGINAL candidate throughout every review
  // round. Restarting bounds around each revision would permit runaway shrink.
  const keys = ['crown.height', 'crown.width', 'crown.depth', 'crown.cuspHeight', 'abutment.angleY', 'abutment.angleX', 'abutment.height', 'crown.rotation'];
  let stepFactor = 1, invalidCandidates = 0, attempts = 1, rounds = 0;
  const tried = new Set([`0:${JSON.stringify(initial.parameters)}`]);
  async function trial(parameters: RestorationParameters, reason: string, anatomyCandidate = bestAnatomy) {
    const key = `${anatomyCandidate}:${JSON.stringify(parameters)}`;
    if (tried.has(key) || attempts >= options.maxCandidates) return;
    tried.add(key);
    await yieldWork(); check();
    const candidate = { ...initial, parameters, crownShape: anatomyCandidates[anatomyCandidate] };
    attempts++;
    let components: RestorationMesh[];
    try { components = generateRestoration(candidate); }
    catch { invalidCandidates++; return; }
    const measurement = await measure(candidate, components, best);
    const quality = evaluateRestorationQuality({ spec: candidate, components, measurement, context: initial.qualityContext });
    const accepted = acceptsFitCandidate(measurement, best, quality, bestQuality);
    history.push({ candidate: history.length, parameters: copyParameters(parameters), measurement, quality, accepted, anatomyCandidate, revision: { round: Math.max(1, rounds), reason } });
    if (accepted) { best = measurement; bestSpec = candidate; bestComponents = components; bestQuality = quality; bestAnatomy = anatomyCandidate; }
  }
  const alreadyAdapted = initial.crownShape.source.provenance.includes('Local occlusal adaptation (occlusal-adaptation/v1)');
  let adaptationAttempts = 0, sweeps = 0;
  async function tryLocalAdaptation(seed: RestorationSpec, phase: string) {
    if (alreadyAdapted || anatomyCandidates.length > 1 || adaptationAttempts >= 2 || attempts >= options.maxCandidates
      || !surfaces.some(surface => surface.role === 'antagonist') || options.maxDurationMs - (performance.now() - started) < 100) return;
    adaptationAttempts++;
    const proposal = await planOcclusalAdaptation(seed, input.surfaces, { checkCancelled: () => { cancelled(); return false; }, yieldControl: yieldWork },
      { maxTargetTriangles: options.maxTargetTriangles, maxDurationMs: Math.min(4000, options.maxDurationMs - (performance.now() - started)) });
    check();
    adaptationNote += `${adaptationNote ? ' ' : ''}Local occlusal adaptation (${phase}) ${proposal.report.status}: ${proposal.report.reason} ${proposal.report.adjustedVertices} vertices revised; maximum ${proposal.report.maxReduction.toPrecision(4)} u reduction. Vertex rays are not triangle clearance; candidate acceptance uses the subsequent bounded fit audit.`;
    if (proposal.spec?.crownShape) {
      rounds = Math.max(1, rounds);
      anatomyCandidates.push(proposal.spec.crownShape);
      await trial(copyParameters(seed.parameters), `Local occlusal adaptation (${phase}): retain the body and cervical contour while reducing observed opposing conflicts.`, 1);
    }
  }
  try {
    if (alreadyAdapted) adaptationNote = 'Existing local occlusal adaptation retained. Fit retries do not stack further cuts; rebuild from measured site to start a new anatomy comparison.';
    await tryLocalAdaptation(initial, 'initial');
    while (surfaces.length && attempts < options.maxCandidates && rounds < 4) {
      rounds++;
      const previousBest = best.score;
      // The independent evaluator proposes specific repairs. It neither reads
      // the optimizer's score nor accepts its own suggestions: every proposal
      // is regenerated, measured, and checked against the accepted candidate.
      const dimensionalRepairs = bestQuality.revisions.filter(revision => ['crown.width', 'crown.depth', 'crown.height'].includes(revision.parameter));
      if (dimensionalRepairs.length > 1) {
        // A one-axis scale repair may temporarily distort otherwise reasonable
        // anatomy. Try the coordinated source-derived revision as one bounded
        // candidate before individual edits; it receives the same full audit.
        const parameters = copyParameters(bestSpec.parameters);
        for (const revision of dimensionalRepairs) {
          const dimension = dimensions[keys.indexOf(revision.parameter)];
          dimension.write(parameters, Math.max(dimension.low, Math.min(dimension.high, revision.proposed)));
        }
        await trial(parameters, 'Coordinated crown dimension repair from independent source-envelope and proportion checks.');
      }
      for (const revision of bestQuality.revisions) {
        const dimension = dimensions[keys.indexOf(revision.parameter)];
        if (!dimension) continue; // Fixture dimensions/placement are held fixed.
        const parameters = copyParameters(bestSpec.parameters);
        dimension.write(parameters, Math.max(dimension.low, Math.min(dimension.high, revision.proposed)));
        await trial(parameters, `${revision.rules.join(', ')}: ${revision.reason}`);
      }
      for (const dimension of dimensions) {
        const centre = dimension.read(bestSpec.parameters);
        for (const sign of [-1, 1]) {
          if (attempts >= options.maxCandidates) break;
          const value = Math.max(dimension.low, Math.min(dimension.high, centre + sign * dimension.step * stepFactor));
          if (Math.abs(value - centre) < Number.EPSILON * Math.max(1, Math.abs(centre))) continue;
          const parameters = copyParameters(bestSpec.parameters);
          dimension.write(parameters, value);
          await trial(parameters, `Bounded ${keys[dimensions.indexOf(dimension)]} exploration; recheck all criteria.`);
        }
      }
      // A rim conflict can disappear after the first bounded parameter sweep.
      // Retry once from that accepted seed; never stack cuts or reset budgets.
      sweeps++;
      if (sweeps === 1 && best.score < before.score - 1e-10) await tryLocalAdaptation(bestSpec, 'after first sweep');
      if (best.score >= previousBest - 1e-10) stepFactor /= 2;
      if (bestQuality.status === 'pass' || stepFactor < 0.2 || rounds >= 4) { termination = 'converged'; break; }
    }
  } catch (error) {
    if (error instanceof FitBudgetExceeded) termination = 'time-budget'; else throw error;
  }
  cancelled();
  return { spec: bestSpec, components: bestComponents, history, report: {
    version: 'restoration-fit/v1', selectionPolicy: 'quality-gated/v1', status: best.score < before.score - 1e-10 ? 'improved' : 'unchanged', termination,
    before, after: best, candidates: history.length, candidateAttempts: attempts, invalidCandidates,
    bestCandidate: history.filter(entry => entry.accepted).at(-1)!.candidate,
    durationMs: performance.now() - started, units: 'file units (u)',
    quality: { initial: initialQuality, final: bestQuality, rounds, stopReason: options.maxCandidates === 1 || !surfaces.length ? 'measurement-only' : bestQuality.status === 'pass' ? 'checks-passed' : termination === 'converged' ? 'no-admissible-revision' : 'budget' },
    anatomyCandidates,
    referencePlanes: restorationReferencePlanes(bestSpec), sampling: {
      method: 'deterministic-area-stratified-triangle-barycentres', direction: 'restoration-to-target', requestedPerSurface: options.samplesPerSurface,
      fullResolutionDistanceTargets: true, maximumIntersectionTargetTriangles: options.maxIntersectionTriangles,
      maximumVerificationRegionTriangles: MAX_VERIFIED_TARGET_FACES,
    }, limits: [
      'Planning concept: clinical fit, occlusal loading, tissue response, manufacturer compatibility and fabrication remain unvalidated.',
      ...(adaptationNote ? [adaptationNote] : []),
      'At most two local adaptation attempts share the fit budget: initially and after the first improving parameter sweep. Only one alternative shape is retained; retrying an adapted restoration does not stack further cuts.',
      'Generate → independently evaluate → revise runs for at most four review rounds inside one shared candidate/time budget. Suggested edits are clamped to original run bounds, remeasured, and rejected if they lose a passed check or create a new failed check. Unresolved checks are not a successful fit.',
      'Unsigned centroid samples query complete supplied triangle surfaces through the collision BVH. Area strata selecting the same triangle are deduplicated; no distance error bound or contact area is established.',
      'Region area is the area eligible for sampling, in squared file units, never contact area. Median and 95th percentile summarize the selected samples; maximum gap deficit is an unsigned sample shortfall, not penetration depth.',
      'Antagonist fitting also approaches the closest 8% of forward occlusal-axis ray hits; misses are unknown. Accepted candidates cannot reduce observed ray-hit coverage or introduce intersections on a previously nonintersecting target. These static sampled gaps do not establish clinical occlusion.',
      'Adjacent RMS/score use the closest 8% of samples in the stated lateral region (sample and near counts cover the entire sampled region); antagonist/tissue objectives penalize sampled gaps below their illustrative target. Default gaps are scale-relative prototype parameters, never clinical thresholds.',
      'Unclassified source-arch targets audit the basal crown and generic abutment without attributing them to a tooth or tissue; no sampled proximity identifies their anatomy.',
      'Score sums weighted squared normalized gap errors, logarithmic observed triangle touch/crossing penalties, measured source-envelope overfill terms and a parameter-change penalty. Measured gap/headroom ceilings outweigh neighbour-relative size preferences; unverified headroom and hypothesized dimensions do not supply scale penalties. Open targets have no reliable solid interior; wholly contained relationships can be missed.',
      'Intersections initially test the complete crown (crown plus generic abutment for tissue) against a deterministic target-face subset, with 200000 triangle pair tests per target. A candidate removing observed crossings or replacing complete evidence gets a follow-up screening every supplied target triangle. Disjoint boxes are excluded; at most 20000 remaining faces receive the same bounded pair audit. The reported tested-target count includes broadphase screening for this complete follow-up. Oversized regions, degenerate faces and capped pair tests remain incomplete. Touching counts; incomplete zero crossings are not clearance.',
      'Transverse crossing requires strict straddling of both triangle planes beyond the reported numerical tolerance. Other hits are touching or ambiguous; these face categories can overlap and do not certify intended contact or an inside/outside relationship.',
      'Fitting changes only bounded crown dimensions/relief/rotation and abutment height/angles; fixture placement stays fixed. Minimum dimensions retain 72% of crown height and 82% of width/depth. No self-intersection, intaglio, material thickness or jaw-motion test is performed.',
      'Fixture platform is below the chosen site plane; the generic abutment envelope spans that offset. Coincident envelope faces encode no precision implant connection.',
      ...(!surfaces.some(surface => surface.role === 'antagonist') ? ['No antagonist target was supplied; the captured bite relationship is unmeasured.'] : []),
      ...(!surfaces.some(surface => surface.role === 'adjacent') ? ['No adjacent target was supplied; proximal relationships are unmeasured.'] : []),
      ...(!surfaces.some(surface => surface.role === 'tissue') ? ['No tissue target was supplied; cervical/tissue relationships are unmeasured.'] : []),
      ...(invalidCandidates ? [`Skipped ${invalidCandidates} candidate constructions that failed numerical/topology validation. All attempts count against the candidate budget; report/history counts include only measured valid candidates.`] : []),
      ...(initial.crownShape ? [initial.crownShape.source.provenance] : ['Crown anatomy uses an editable procedural fallback, not a patient-specific reconstruction.']),
    ],
  } };
}
