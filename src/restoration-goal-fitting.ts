import { fitRestoration, RestorationFitCancelled } from './restoration-fitting.ts';
import type { RestorationFitControl } from './restoration-fitting';
import { crownTissueRegions, generateRestoration, restorationCrownShape } from './restoration-geometry.ts';
import { applyPilarCrownSupport, measureCrownExtents, measurePilarCrownSupport } from './restoration-quality.ts';
import { measureAbutmentGingiva, measureFixtureGingiva } from './restoration-gingiva.ts';
import { planProximalAdaptation } from './restoration-proximal-adaptation.ts';
import { verifyFitIntersections } from './restoration-fit-verification.ts';
import { restorationFeedbackTargetId } from './restoration-feedback.ts';
import { acceptsGoalCandidate, extendGoalContract, goalParameterBounds, restorationGoalSchema, restorationGoalSnapshot } from './restoration-goals.ts';
import type { RestorationGoalReport, RestorationGoalSnapshot } from './restoration-goals';
import type { RestorationFitInput, RestorationFitResult, RestorationSpec } from './restoration-types';

class GoalTimeBudget extends Error {}
const yieldDefault = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** Binds a reusable contract to complete target bytes and construction/anatomy
 * dependencies. Targets remain local; only the opaque fingerprint is saved. */
export function goalEvidenceRevision(input: RestorationFitInput) {
  let a = 2166136261, b = 3335557771;
  const feed = (value: number) => { a = Math.imul(a ^ value, 16777619); b = Math.imul(b ^ value, 2246822519); };
  const text = JSON.stringify([input.spec.frame, input.spec.fdi, input.spec.anatomy, input.spec.anatomicalSigns, input.spec.componentDesign,
    input.spec.parameters.fixture.radius, input.spec.parameters.fixture.length, input.spec.parameters.fixture.taper,
    input.spec.crownShape, input.spec.qualityContext]);
  for (let i = 0; i < text.length; i++) feed(text.charCodeAt(i));
  for (const surface of [...input.surfaces].sort((x, y) => x.id.localeCompare(y.id))) {
    for (const value of `${surface.id}:${surface.role}:${surface.side ?? ''}`) feed(value.charCodeAt(0));
    const bytes = new Uint8Array(surface.positions.buffer, surface.positions.byteOffset, surface.positions.byteLength);
    for (const byte of bytes) feed(byte);
  }
  return `goal-${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}

/** Initial generation and explicit retry use this loop. Exact manual edits are
 * measured once. All trials share one deadline and fixed input-space bounds. */
export async function fitRestorationToGoals(input: RestorationFitInput, control: RestorationFitControl = {}): Promise<RestorationFitResult> {
  const started = performance.now(), duration = input.options?.maxDurationMs ?? 30_000;
  if (!Number.isFinite(duration) || duration < 100 || duration > 60_000) throw new Error('Goal time budget must be in [100, 60000] ms.');
  const maxAttempts = input.options?.maxCandidates === 1 ? 1 : Math.min(13, input.options?.maxCandidates ?? 13);
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('Goal attempt budget must be positive.');
  const check = () => { if (control.checkCancelled?.()) throw new RestorationFitCancelled(); if (performance.now() - started >= duration) throw new GoalTimeBudget(); };
  const yieldWork = async () => { await (control.yieldControl ?? yieldDefault)(); check(); };
  check();
  // Freeze geometry, metadata and the contract before the first async yield.
  // A caller changing its scene cannot silently change a later trial's basis.
  input = structuredClone(input);
  input.spec.crownShape ??= restorationCrownShape(input.spec);
  const inherited = input.goalContract ? restorationGoalSchema.parse(input.goalContract) : undefined;
  if (inherited && Object.keys(inherited.targetGaps).some(id => !input.surfaces.some(surface => surface.id === id))) {
    throw new Error('A previous goal target is missing. Restore its evidence or rebuild requirements from the reviewed site.');
  }
  const bounds = inherited?.bounds ?? goalParameterBounds(input.spec.parameters, input.spec.contour);
  const scale = Math.min(input.spec.parameters.crown.width, input.spec.parameters.crown.depth, input.spec.parameters.crown.height);
  // A supplied contract means retry the original requirements. Session loading
  // remaps target IDs; its historical fingerprint cannot identify those aliases.
  // Fresh evidence is always measured, but it does not relax existing targets.
  // Rebuilding without a contract establishes new requirements explicitly.
  const targetGaps = Object.fromEntries(input.surfaces.map(surface => [surface.id,
    inherited?.targetGaps[surface.id] ?? surface.targetGap ?? (surface.role === 'other-tooth' || surface.role === 'source-arch' ? 0 : scale * (surface.role === 'adjacent' ? .015 : surface.role === 'antagonist' ? .025 : .01))]));
  const surfaces = input.surfaces.map(surface => ({ ...surface, targetGap: targetGaps[surface.id] }));
  async function measure(spec: RestorationSpec) {
    check();
    const result = await fitRestoration({ spec, surfaces, options: { ...input.options, maxCandidates: 1,
      maxDurationMs: Math.max(100, Math.floor(duration - (performance.now() - started))), tissueSource: 'crown', verifyBaselineIntersections: true } },
      { ...control, checkCancelled: () => { check(); return false; }, yieldControl: yieldWork });
    result.report.gingiva = await measureFixtureGingiva({ spec: result.spec, components: result.components, surfaces,
      options: { maxDepthIncrease: Math.max(0, bounds['fixture.depth'][1] - spec.parameters.fixture.depth) } }, { check, yieldControl: yieldWork });
    result.report.abutmentGingiva = await measureAbutmentGingiva({ spec: result.spec, components: result.components, surfaces }, { check, yieldControl: yieldWork });
    const support = await measurePilarCrownSupport(result, { check, yieldControl: yieldWork });
    // maxCandidates=1 means these three reports all describe the same exact
    // emitted trial. Keep selected history and baseline consistent before the
    // goal snapshot/gate; no post-selection audit can silently change evidence.
    result.report.quality!.initial = applyPilarCrownSupport(result.report.quality!.initial, support);
    result.report.quality!.final = applyPilarCrownSupport(result.report.quality!.final, support);
    if (result.history[0]?.quality) result.history[0].quality = applyPilarCrownSupport(result.history[0].quality, support);
    check(); return result;
  }
  let best: RestorationFitResult;
  try { best = await measure(input.spec); }
  catch (error) { if (error instanceof GoalTimeBudget) throw new Error('Time budget ended before mouth-fit requirements could be measured.'); throw error; }
  const original = restorationGoalSnapshot(best, best.report.gingiva!, inherited?.contract);
  const contract = extendGoalContract(inherited?.contract, original);
  let current = original, selectedAttempt = 0;
  const attempts: RestorationGoalReport['attempts'] = [{ attempt: 0, accepted: true, reason: 'Measure the current geometry against every mouth-fit requirement.', snapshot: original }];
  let termination: RestorationGoalReport['termination'] = maxAttempts === 1 ? 'measurement-only' : 'candidate-budget';
  const tried = new Set([JSON.stringify([best.spec.parameters, best.spec.contour])]);
  function clamp(spec: RestorationSpec) {
    for (const [key, [low, high]] of Object.entries(bounds)) {
      if (key === 'cervicalScale') { spec.contour = { ...spec.contour, cervicalScale: Math.max(low, Math.min(high, spec.contour?.cervicalScale ?? 1)) }; continue; }
      const [component, field] = key.split('.');
      const values = spec.parameters[component as keyof typeof spec.parameters] as unknown as Record<string, number>;
      values[field] = Math.max(low, Math.min(high, values[field]));
    }
    return spec;
  }
  async function proposals(): Promise<{ spec: RestorationSpec; reason: string }[]> {
    const output: { spec: RestorationSpec; reason: string }[] = [];
    const add = (spec: RestorationSpec, reason: string) => output.push({ spec: clamp(spec), reason });
    const clone = () => structuredClone(best.spec);
    const burial = best.report.gingiva?.requiredDepthIncrease;
    if (burial !== null && burial !== undefined && burial > 0) {
      const spec = clone(); spec.parameters.fixture.depth += burial;
      add(spec, 'Move the generic fixture below the measured gum envelope; preserve the crown and bridge the pilar to the new platform. This does not establish bone depth.');
    }
    const p = best.spec.parameters, extents = best.report.quality!.final.crownExtents!;
    // Support repair is independent of gum. Keep a short, fixed set of radius,
    // emergence, height and slope hypotheses; every candidate is remeasured
    // against the original target/bounds and all external crossing requirements.
    if (current.rows.some(row => ['component-support.pilar-enclosure', 'abutment-gingiva'].includes(row.id) && row.status === 'fail')) {
      for (const fraction of [.9, .8, .65]) {
        if (bounds['abutment.radius']) {
          const spec = clone(); spec.parameters.abutment.radius = input.spec.parameters.abutment.radius * fraction;
          add(spec, 'Reduce the emitted pilar core radius within the frozen support search bounds; recheck complete support, every tooth contact and external crossing.');
        }
      }
      if (bounds['abutment.emergenceRadius']) {
        const spec = clone(); spec.parameters.abutment.emergenceRadius *= .9;
        add(spec, 'Reduce the pilar emergence radius within fixed bounds and remeasure support separately from gum emergence and external crossings.');
      }
      for (const key of ['angleX', 'angleY'] as const) if (bounds[`abutment.${key}`] && p.abutment[key]) {
        const spec = clone(); spec.parameters.abutment[key] *= .75;
        add(spec, 'Reduce pilar slope within frozen bounds; retain every existing per-target contact and complete crossing audit.');
      }
      const spec = clone(); spec.parameters.abutment.height *= .9;
      spec.parameters.crown.height += p.abutment.height - spec.parameters.abutment.height;
      add(spec, 'Coordinate nominal pilar and crown body heights within the original bounds; remeasure the actual top, emitted support region and every target.');
    }
    // This loop measures each candidate with maxCandidates=1, so repairs in the
    // standalone fitter never run here. Offer source-derived size corrections
    // and observed collision relief before contact expansion consumes the shared
    // attempt budget. All proposals still pass the full fixed-goal audit.
    const dimensions = best.report.quality!.final.revisions.filter(revision =>
      ['crown.width', 'crown.depth', 'crown.height'].includes(revision.parameter) && bounds[revision.parameter]);
    if (dimensions.length) {
      const spec = clone();
      for (const revision of dimensions) {
        const key = revision.parameter.split('.')[1] as 'width' | 'depth' | 'height';
        spec.parameters.crown[key] = revision.proposed;
      }
      add(spec, 'Coordinate crown dimension repairs from the measured gap/headroom and independent proportion checks, within the original goal bounds; recheck every target.');
    }
    const crossed = best.report.after.surfaces.filter(surface => (surface.transverseCrossingTriangles ?? 0) > 0);
    if (crossed.some(surface => surface.role === 'antagonist')) {
      const spec = clone(); spec.parameters.crown.height *= .92;
      add(spec, 'Reduce crown height to relieve observed opposing-tooth crossings; retain source coordinates and recheck the fixed headroom/contact requirements.');
    }
    if (crossed.some(surface => ['adjacent', 'other-tooth', 'source-arch'].includes(surface.role))) {
      for (const axis of ['both', 'width', 'depth'] as const) {
        const spec = clone();
        if (axis !== 'depth') spec.parameters.crown.width *= .94;
        if (axis !== 'width') spec.parameters.crown.depth *= .94;
        add(spec, `Relieve observed tooth/source-arch crossings with a bounded ${axis === 'both' ? 'combined footprint' : axis} reduction; full per-target crossing and contact audits decide acceptance.`);
      }
    }
    if (crossed.some(surface => surface.role === 'tissue')) {
      const spec = clone(), rise = p.crown.height * .06;
      spec.parameters.abutment.height += rise; spec.parameters.crown.height -= rise;
      add(spec, 'Raise the crown-body base away from observed gum crossings while coordinating crown height to retain the top; fixture placement is unchanged and every requirement is remeasured.');
    }
    const adjacent = best.report.after.surfaces.filter(surface => surface.role === 'adjacent');
    const open = (side: 'mesial' | 'distal') => Math.max(0, ...adjacent.filter(row => row.side === side).map(row => row.sampledMinDistance - row.targetGap));
    const mesial = open('mesial'), distal = open('distal');
    const expansion = Math.min(.3, (mesial + distal) / extents.mesiodistal * 1.1);
    const needsContact = current.rows.some(row => row.id.endsWith('proximal-gap') && row.status === 'fail');
    if (needsContact && Math.max(mesial, distal) < p.crown.width * .08) {
      const patch = await planProximalAdaptation(best.spec, surfaces,
        { checkCancelled: () => { check(); return false; }, yieldControl: yieldWork },
        { maxDurationMs: Math.max(1, Math.min(4000, duration - (performance.now() - started))), maxDisplacementFraction: .03 });
      check();
      for (const spec of [...patch.candidates].reverse()) add(spec, 'Adapt only the proximal wall contact bands toward measured neighbours; preserve the cervical and occlusal anatomy, then audit all targets.');
    }
    if (needsContact && expansion > 0) {
      // Widen the contact band while retaining the cervical footprint. Recheck
      // three top heights: changing lateral anatomy changes antagonist contact.
      for (const fraction of [1, .65]) for (const height of [.95, 1, .9]) {
        const spec = clone(), factor = 1 + expansion * fraction;
        spec.parameters.crown.width *= factor;
        spec.parameters.crown.height *= height;
        spec.contour = { ...spec.contour, cervicalScale: (spec.contour?.cervicalScale ?? 1) / factor };
        clamp(spec);
        const emitted = measureCrownExtents(spec, generateRestoration(spec));
        const wanted = contract.rows.find(row => row.id === 'relative-depth')?.lower;
        if (emitted && wanted && emitted.buccolingual < wanted) spec.parameters.crown.depth *= wanted * 1.005 / emitted.buccolingual;
        add(spec, 'Close both neighbour gaps with a wider contact band, retain a narrower cervical contour, and coordinate crown height and buccolingual proportion; recheck every target.');
      }
      if (Math.abs(mesial - distal) > extents.mesiodistal * .01) {
        const spec = clone(), shift = (mesial - distal) * .35 * (spec.anatomicalSigns?.mesial ?? 1);
        spec.parameters.abutment.angleY = Math.atan((p.abutment.height * Math.tan(p.abutment.angleY * Math.PI / 180) + shift) / p.abutment.height) * 180 / Math.PI;
        add(spec, 'Balance the open neighbour contacts with a bounded pilar slope; preserve each contact already within bounds.');
      }
    }
    for (const direction of [-1, 1]) {
      const spec = clone(); spec.parameters.abutment.height *= 1 + direction * .2;
      spec.parameters.crown.height += p.abutment.height - spec.parameters.abutment.height;
      add(spec, 'Coordinate pilar height and crown body height while retaining the overall top; evaluate cervical and opposing relationships separately.');
    }
    for (const revision of best.report.quality!.final.revisions) {
      if (!bounds[revision.parameter]) continue;
      const spec = clone(), [part, key] = revision.parameter.split('.');
      (spec.parameters[part as keyof typeof spec.parameters] as unknown as Record<string, number>)[key] = revision.proposed;
      add(spec, revision.reason);
    }
    return output;
  }
  try {
    while (attempts.length < maxAttempts) {
      if (!current.rows.some(row => row.priority === 'required' && row.status === 'fail')) {
        termination = current.status === 'satisfied' ? 'satisfied' : 'needs-evidence'; break;
      }
      let improved = false, attempted = false;
      for (const proposal of await proposals()) {
        if (attempts.length >= maxAttempts) break;
        const key = JSON.stringify([proposal.spec.parameters, proposal.spec.contour, proposal.spec.crownShape?.wall]);
        if (tried.has(key)) continue;
        tried.add(key); attempted = true;
        await yieldWork();
        let candidate: RestorationFitResult;
        try { candidate = await measure(proposal.spec); }
        catch (error) {
          if (error instanceof GoalTimeBudget || error instanceof RestorationFitCancelled) throw error;
          attempts.push({ attempt: attempts.length, accepted: false, reason: 'Candidate could not complete the required construction/audit; the previous model is retained.', snapshot: current }); continue;
        }
        const snapshot = restorationGoalSnapshot(candidate, candidate.report.gingiva!, contract);
        const accepted = acceptsGoalCandidate(candidate, best, snapshot, current);
        attempts.push({ attempt: attempts.length, accepted, reason: accepted ? proposal.reason : `${proposal.reason} Rejected: no admissible requirement improvement.`, snapshot });
        if (accepted) { best = candidate; current = snapshot; selectedAttempt = attempts.length - 1; improved = true; break; }
      }
      if (!improved && (!attempted || attempts.length < maxAttempts)) { termination = 'stalled'; break; }
    }
  } catch (error) { if (error instanceof GoalTimeBudget) termination = 'time-budget'; else throw error; }
  if (control.checkCancelled?.()) throw new RestorationFitCancelled();
  const emergence: NonNullable<RestorationGoalReport['emergence']> = [];
  for (const surface of surfaces.filter(surface => surface.role === 'tissue')) {
    const row: NonNullable<RestorationGoalReport['emergence']>[number] = { target: restorationFeedbackTargetId(surface.id),
      transverseCrossingTriangles: null, touchingOrAmbiguousTriangles: null, intersectionComplete: false };
    try {
      check();
      const pillar = best.components.find(mesh => mesh.component === 'abutment')!.positions;
      const collar = crownTissueRegions(best.spec, best.components.find(mesh => mesh.component === 'crown')!).emergence;
      const emergencePositions = new Float32Array(pillar.length + collar.length);
      emergencePositions.set(pillar); emergencePositions.set(collar, pillar.length);
      const measured = await verifyFitIntersections(emergencePositions, surface.positions, { check, yieldControl: yieldWork });
      if (measured) Object.assign(row, { transverseCrossingTriangles: measured.transverseCrossingTriangles,
        touchingOrAmbiguousTriangles: measured.touchingOrAmbiguousTriangles, intersectionComplete: measured.intersectionComplete });
    } catch (error) { if (!(error instanceof GoalTimeBudget)) throw error; }
    emergence.push(row);
  }
  best.report.goal = restorationGoalSchema.parse({ version: 'restoration-goal/v1', evidenceRevision: goalEvidenceRevision({ ...input, spec: best.spec }), targetGaps, bounds, contract,
    status: current.status, termination, before: original, after: current, attempts, selectedAttempt,
    durationMs: performance.now() - started, maxAttempts, emergence,
    limits: [
      'Fixed per-run file-unit targets and parameter bounds; neighbour-average ratios are preferences, not mandatory tooth dimensions. Unknown clinical evidence never passes.',
      'Required visible-tissue audits use the crown body above the pilar top. The constructed emergence collar and pilar are audited separately against gum; their intersections require review, not an automatic clearance pass. Unclassified source-arch and tooth targets retain the full crown.',
      'Contacts are sampled proximity and forward-ray checks in the supplied static pose, not exact contact area, force or a verified clinical bite.',
      'Gum exposure is a sampled directional envelope, not 3D containment or bone/root clearance. Proposed fixture depth changes preserve the source frame and crown position.',
      'Candidate search is bounded; stalled or exhausted search is not proof of geometric impossibility. Each accepted step preserves complete audits, existing required passes and zero-crossing targets.',
      'Exact manual edits are measured once without changing requested values. Initial generation and Fit to mouth requirements run coordinated revisions automatically.',
    ] });
  return best;
}
