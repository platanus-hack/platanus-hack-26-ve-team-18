import type { Vec3 } from './models';
import type { ArchAtom, ArchModel, SegmentGroup } from './arch-analysis.ts';

/**
 * Joint tooth grouping and FDI sequence alignment along one arch curve.
 *
 * Atoms (short arch segments with crown evidence) are grouped into teeth, gaps
 * (positions with space but no crown), non-tooth tissue and unscanned stretches.
 * Teeth are aligned to permanent FDI positions using relative crown proportions
 * with one fitted scale per arch, so numbering never shifts to fill a gap: a gap
 * consumes positions in proportion to its length. Positions removed without a
 * space (for example after orthodontic extraction) remain ambiguous and lower
 * the confidence of every neighbouring identity.
 *
 * Confidence is an evidence margin: how much worse the best alternative
 * explanation is (constrained re-solve). It is not a calibrated accuracy.
 */

/** Approximate mean permanent crown mesiodistal widths by tooth digit 1..8 (relative proportions only, never millimetres). */
export const REFERENCE_MD: Record<'upper' | 'lower', readonly number[]> = {
  upper: [8.6, 6.6, 7.6, 7.0, 6.7, 10.2, 9.2, 8.6],
  lower: [5.3, 5.8, 6.8, 7.0, 7.2, 11.1, 10.4, 10.3],
};
export const REFERENCE_PROVENANCE = 'Approximate mean permanent crown mesiodistal proportions from standard dental anatomy tables; used only as relative ratios with a per-arch fitted scale.';
export const RIGHT_TO_LEFT: Record<'upper' | 'lower', readonly number[]> = {
  upper: [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28],
  lower: [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38],
};

export interface NumberingOptions {
  arch: 'upper' | 'lower';
  /** +1: arc length runs from patient right to patient left; -1: the reverse. */
  orientation: 1 | -1;
  apexS: number | null;
  apexWeight: number;
  budgetMs?: number;
  /** Diagnostics hook: receives each constrained re-solve. */
  onAlternative?: (fdi: number, steps: { label: string; i: number; j: number; q: number; m: number; cost: number }[], margin: number) => void;
}
export interface NumberedGroup extends SegmentGroup {
  label: string;
  confidence: number;
  alternatives: number[];
  cost: number;
}
export interface ArchNumbering {
  arch: 'upper' | 'lower';
  orientation: 1 | -1;
  /** File units per reference unit (not a millimetre conversion). */
  scale: number;
  cost: number;
  groups: NumberedGroup[];
  sequence: number[];
  /** FDI positions that lack crown and space between present neighbours (closure, agenesis or extraction). */
  skipped: number[];
  method: string;
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value));
const MAX_GROUP_ATOMS = 6;
/** Absent without space: premolars are the usual orthodontic extraction/agenesis positions. */
const skipCost = (digit: number) => digit === 4 || digit === 5 ? 1.0 : 2.2;
const MISSING_PRIOR = 1.2;
const THIRD_MOLAR_PRIOR = 0.8;
/** Anterior crowns are wedge-shaped in cross-section; premolars and molars have near-vertical walls. */
const posteriorEvidence = (steep: number) => sigmoid(2 * Math.log(Math.max(steep, 0.05) / 4.5));

interface GroupFeatures {
  length: number; crownFrac: number; lowFrac: number; unscannedFrac: number;
  steep: number; promRel: number; peaks: number; tissue: number | null;
  internal: number; atEnd: boolean; crown: number;
}

/** Crown likelihood from wall steepness, relief, cusp seeds and optional colour. Interpretable, not trained. */
export function crownLikelihood(features: Omit<GroupFeatures, 'crown' | 'length' | 'internal'>): number {
  // Missing coverage is not negative tooth evidence, but cannot establish a
  // crown either. Colour alone is a weak veto, never an anatomical label.
  if (features.unscannedFrac >= 0.6) return 0.01;
  const tissue = Number.isFinite(features.tissue) && features.tissue! >= 0 && features.tissue! <= 1 ? features.tissue! : 0;
  const z = 2.2 * (2 * features.crownFrac - 1)
    + 3 * Math.log(Math.max(features.steep, 0.05) / 2.4)
    + clamp(features.promRel - 0.5, -1, 1)
    + 0.6 * (features.peaks > 0 ? 1 : -1)
    - 3 * Math.max(0, tissue - 0.45)
    - (features.atEnd ? 0.6 : 0);
  return clamp(sigmoid(z), 0.01, 0.99);
}

function groupFeatures(atoms: ArchAtom[], i: number, j: number): GroupFeatures {
  let length = 0, crown = 0, low = 0, unscanned = 0, steepWeight = 0, steep = 0, prom = 0, peaks = 0, tissue = 0, tissueWeight = 0, internal = 0;
  for (let a = i; a <= j; a++) {
    const atom = atoms[a], w = atom.s1 - atom.s0;
    length += w; crown += w * atom.crownFrac; low += w * atom.lowFrac; unscanned += w * atom.unscannedFrac;
    const sw = w * (atom.crownFrac > 0.5 ? 1 : 0.25); steep += sw * atom.steep; steepWeight += sw;
    prom += w * atom.promRel; peaks += atom.peaks;
    if (atom.tissue !== null) { tissue += w * atom.tissue; tissueWeight += w; }
    if (a > i) internal += Math.max(0, atom.startCut - 0.1);
  }
  const features = {
    length, crownFrac: crown / length, lowFrac: low / length, unscannedFrac: unscanned / length,
    steep: steepWeight ? steep / steepWeight : 0, promRel: prom / length, peaks, tissue: tissueWeight ? tissue / tissueWeight : null,
    internal, atEnd: i === 0 || j === atoms.length - 1,
  };
  return { ...features, crown: crownLikelihood(features) };
}

type Label = 'tooth' | 'gap' | 'tissue' | 'unscanned';
interface Step { from: number; label: Label; i: number; j: number; q: number; m: number; cost: number }
interface Constraint { label: Label; position: number; atom: number }

/** Solve the alignment for one scale. Positions are s-order indices 0..15. */
export function solveAlignment(atoms: ArchAtom[], features: (GroupFeatures | null)[][], md: number[], digits: number[], k: number, options: NumberingOptions, symmetry: (number | null)[] | null, constraint?: Constraint) {
  const n = atoms.length, P = 16, PHASES = 3, KINDS = 3;
  const crownSpan = atoms.reduce((sum, atom) => sum + (atom.s1 - atom.s0) * atom.crownFrac, 0);
  const seedCount = atoms.reduce((sum, atom) => sum + atom.peaks, 0);
  const evidenceWidth = crownSpan / Math.max(1, seedCount) || atoms[atoms.length - 1].s1 - atoms[0].s0;
  // State: (atoms consumed, next free position, phase 0 before/1 inside/2 after teeth, last kind 0 other/1 tooth/2 gap).
  const size = (n + 1) * (P + 1) * PHASES * KINDS;
  const cost = new Float64Array(size).fill(Infinity);
  const back: (Step | null)[] = new Array(size).fill(null);
  const index = (i: number, p: number, phase: number, kind: number) => ((i * (P + 1) + p) * PHASES + phase) * KINDS + kind;
  cost[index(0, 0, 0, 0)] = 0;
  const thirdMolar = (q: number) => digits[q] === 8;
  const midline = (q: number, s0: number, s1: number) => {
    if (options.apexS === null || !(options.apexWeight > 0)) return 0;
    let penalty = 0;
    if (q === 7) penalty += ((s1 - options.apexS) / (k * 4)) ** 2;
    if (q === 8) penalty += ((s0 - options.apexS) / (k * 4)) ** 2;
    return 0.5 * options.apexWeight * penalty;
  };
  // Contralateral consistency: similar arc distance from the midline for mirrored positions.
  const mirrored = (q: number, center: number) => {
    if (!symmetry || options.apexS === null || symmetry[15 - q] === null) return 0;
    const own = Math.abs(center - options.apexS), other = Math.abs(symmetry[15 - q]! - options.apexS);
    // Teeth drift mesially into spaces far more often than distally: a distal offset is less plausible.
    const drift = own > other ? 1.5 : 0.75;
    return 0.5 * options.apexWeight * drift * ((own - other) / (k * 4)) ** 2;
  };
  const relax = (from: number, to: number, step: Step) => {
    const value = cost[from] + step.cost;
    if (value < cost[to]) { cost[to] = value; back[to] = step; }
  };
  for (let i = 0; i < n; i++) for (let p = 0; p <= P; p++) for (let phase = 0; phase < PHASES; phase++) for (let kind = 0; kind < KINDS; kind++) {
    const from = index(i, p, phase, kind);
    if (!Number.isFinite(cost[from])) continue;
    const gap = kind === 2 ? 1 : 0;
    for (let j = i; j < Math.min(n, i + MAX_GROUP_ATOMS); j++) {
      const f = features[i][j - i];
      if (!f) continue;
      const s0 = atoms[i].s0, s1 = atoms[j].s1, center = (s0 + s1) / 2;
      const blocked = (label: Label, q: number, m = 1) => !!constraint && constraint.label === label && constraint.atom >= i && constraint.atom <= j && constraint.position >= q && constraint.position < q + m;
      // Calling crown-like surface "tissue" costs in proportion to how much of it there is.
      // Integrate atom evidence before combining. Averaging first lets a long
      // flat span hide several strong crown atoms inside a cheap tissue group.
      let discardedCrown = 0;
      for (let a = i; a <= j; a++) {
        const atom = features[a][0];
        if (atom) discardedCrown += -1.5 * Math.log(1 - atom.crown) * atom.length / evidenceWidth;
      }
      const tissueCost = discardedCrown + 0.3 + 3 * f.unscannedFrac;
      if (phase === 0) relax(from, index(j + 1, p, 0, 0), { from, label: 'tissue', i, j, q: -1, m: 0, cost: tissueCost });
      if (phase === 1) {
        relax(from, index(j + 1, p, 1, kind === 1 ? 0 : kind), { from, label: 'tissue', i, j, q: -1, m: 0, cost: tissueCost + 3 * (f.length / (k * 5)) ** 2 + 0.5 });
        relax(from, index(j + 1, p, 2, 0), { from, label: 'tissue', i, j, q: -1, m: 0, cost: tissueCost + (gap ? 1.5 : 0) });
      }
      if (phase === 2) relax(from, index(j + 1, p, 2, 0), { from, label: 'tissue', i, j, q: -1, m: 0, cost: tissueCost });
      // Only genuinely missing surface may consume positions without width or crown evidence.
      const unscannedCost = f.unscannedFrac >= 0.6 ? 0.5 : Infinity;
      if (phase === 0 || phase === 2) relax(from, index(j + 1, p, phase, 0), { from, label: 'unscanned', i, j, q: -1, m: 0, cost: unscannedCost });
      if (phase === 1) {
        for (let m = 0; m <= 4 && p + m <= P; m++) if (!blocked('unscanned', p, m)) relax(from, index(j + 1, p + m, 1, 0), { from, label: 'unscanned', i, j, q: p, m, cost: unscannedCost + 0.25 * m });
        relax(from, index(j + 1, p, 2, 0), { from, label: 'unscanned', i, j, q: -1, m: 0, cost: unscannedCost + (gap ? 1.5 : 0) });
      }
      if (phase === 2) continue;
      const posterior = posteriorEvidence(f.steep);
      // Adjacent crowns need interproximal evidence between them.
      const split = kind === 1 ? 2.5 * Math.max(0, 0.45 - atoms[i].startCut) : 0;
      const qMin = p, qMax = phase === 0 ? P - 1 : Math.min(P - 1, p + 3);
      for (let q = qMin; q <= qMax; q++) {
        if (blocked('tooth', q)) continue;
        let skips = 0;
        if (phase === 1) for (let r = p; r < q; r++) skips += skipCost(digits[r]);
        const width = Math.log(f.length / (k * md[q]));
        const type = -1.2 * Math.log((digits[q] >= 4 ? posterior : 1 - posterior) + 0.05);
        // Molars vary more and terminal molars measure only to their distal marginal ridge.
        const sigma = digits[q] >= 6 ? 0.2 : 0.15;
        const c = width * width / (2 * sigma ** 2) - 1.5 * Math.log(f.crown) + 2.5 * f.internal + (thirdMolar(q) ? THIRD_MOLAR_PRIOR : 0)
          + skips + split + type + midline(q, s0, s1) + mirrored(q, center);
        relax(from, index(j + 1, q + 1, 1, 1), { from, label: 'tooth', i, j, q, m: 1, cost: c });
      }
      if (phase !== 1) continue;
      for (let q = p; q <= Math.min(P - 1, p + 2); q++) for (let m = 1; m <= 4 && q + m <= P; m++) {
        if (blocked('gap', q, m)) continue;
        let sum = 0, molars = 0, skips = 0, symmetric = 0;
        for (let r = p; r < q; r++) skips += skipCost(digits[r]);
        for (let r = q; r < q + m; r++) { sum += md[r]; if (thirdMolar(r)) molars++; }
        let at = s0;
        for (let r = q; r < q + m; r++) { const slot = (s1 - s0) * md[r] / sum; symmetric += mirrored(r, at + slot / 2); at += slot; }
        const width = Math.log(f.length / (k * sum));
        let c = width * width / (2 * 0.3 ** 2) + discardedCrown + MISSING_PRIOR * m + 1.0 * molars + 3 * f.unscannedFrac + skips + symmetric;
        if (q <= 7 && q + m > 8 && options.apexS !== null) c += 0.5 * options.apexWeight * ((s0 + (s1 - s0) * (md.slice(q, 8).reduce((a, b) => a + b, 0) / sum) - options.apexS) / (k * 4)) ** 2;
        relax(from, index(j + 1, q + m, 1, 2), { from, label: 'gap', i, j, q, m, cost: c });
      }
    }
  }
  let best = Infinity, bestState = -1;
  // A tissue-only or entirely unscanned solution is valid. Requiring phase 1
  // forced at least one invented tooth on weak/edentulous surface geometry.
  for (let p = 0; p <= P; p++) for (let phase = 0; phase < PHASES; phase++) for (let kind = 0; kind < KINDS; kind++) {
    const state = index(n, p, phase, kind), value = cost[state] + (phase === 1 && kind === 2 ? 1.5 : 0);
    if (value < best) { best = value; bestState = state; }
  }
  const steps: Step[] = [];
  for (let state = bestState; state >= 0 && back[state];) { const step = back[state]!; steps.push(step); state = step.from; }
  steps.reverse();
  return { cost: best, steps };
}

/** Arc-length centres of aligned positions, for contralateral consistency. */
function positionCenters(steps: Step[], atoms: ArchAtom[], md: number[]): (number | null)[] {
  const centers: (number | null)[] = new Array(16).fill(null);
  for (const step of steps) {
    if (step.label === 'tooth') centers[step.q] = (atoms[step.i].s0 + atoms[step.j].s1) / 2;
    if (step.label === 'gap') {
      const s0 = atoms[step.i].s0, s1 = atoms[step.j].s1;
      let sum = 0; for (let r = step.q; r < step.q + step.m; r++) sum += md[r];
      let at = s0;
      for (let r = step.q; r < step.q + step.m; r++) { const slot = (s1 - s0) * md[r] / sum; centers[r] = at + slot / 2; at += slot; }
    }
  }
  return centers;
}

/** Anatomical chirality hypothesis only, never confirmed laterality. Public preparation uses confirmedArchOrientation instead. */
export function archOrientation(model: ArchModel, arch: 'upper' | 'lower'): { orientation: 1 | -1; confidence: number; patientRight: Vec3 | null; basis: string } {
  const anterior = model.anterior;
  if (!anterior.direction) return { orientation: 1, confidence: 0, patientRight: null, basis: 'Anterior direction unknown; patient side cannot be inferred from this scan alone.' };
  // Crowns point toward the occlusal plane: inferior for the upper arch, superior for the lower.
  const superior = arch === 'upper' ? model.up.map(value => -value) : [...model.up];
  const a = anterior.direction;
  const right: Vec3 = [a[1] * superior[2] - a[2] * superior[1], a[2] * superior[0] - a[0] * superior[2], a[0] * superior[1] - a[1] * superior[0]];
  const l = Math.hypot(...right);
  if (!(l > 0)) return { orientation: 1, confidence: 0, patientRight: null, basis: 'Anterior and occlusal directions are parallel.' };
  const R = right.map(value => value / l) as Vec3;
  // Weight curve tangents by how anterior each sample is; anterior tangents run mediolaterally.
  const n = model.curveX.length;
  let cx = 0, cy = 0; for (let i = 0; i < n; i++) { cx += model.curveX[i]; cy += model.curveY[i]; } cx /= n; cy /= n;
  const aPlan = [a[0] * model.e1[0] + a[1] * model.e1[1] + a[2] * model.e1[2], a[0] * model.e2[0] + a[1] * model.e2[1] + a[2] * model.e2[2]];
  const rPlan = [R[0] * model.e1[0] + R[1] * model.e1[1] + R[2] * model.e1[2], R[0] * model.e2[0] + R[1] * model.e2[1] + R[2] * model.e2[2]];
  let sum = 0, weight = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.max(0, (model.curveX[i] - cx) * aPlan[0] + (model.curveY[i] - cy) * aPlan[1]);
    sum += w * (model.curveTx[i] * rPlan[0] + model.curveTy[i] * rPlan[1]); weight += w;
  }
  const strength = weight > 0 ? Math.abs(sum) / weight : 0;
  return {
    orientation: sum < 0 ? 1 : -1,
    confidence: Number(clamp(anterior.confidence * clamp(strength / 0.6) * 0.95).toFixed(3)),
    patientRight: R,
    basis: `${anterior.basis} Patient right = anterior × superior, assuming the scanner export is not mirrored.`,
  };
}

/** Align one analysed arch to FDI positions. Returns grouped atoms with identities and evidence margins. */
export function numberArch(model: ArchModel, options: NumberingOptions): ArchNumbering {
  const atoms = model.atoms;
  if (!atoms.length) throw new Error('No arch segments are available for numbering.');
  if (atoms.some(atom => !Number.isFinite(atom.s0) || !Number.isFinite(atom.s1) || !(atom.s1 > atom.s0))) throw new Error('Arch segments require finite, positive arc spans.');
  const start = performance.now(), limit = options.budgetMs ?? 10_000;
  const order = options.orientation === 1 ? RIGHT_TO_LEFT[options.arch] : [...RIGHT_TO_LEFT[options.arch]].reverse();
  const md = order.map(fdi => REFERENCE_MD[options.arch][fdi % 10 - 1]);
  const digits = order.map(fdi => fdi % 10);
  const features: (GroupFeatures | null)[][] = atoms.map((_, i) => Array.from({ length: Math.min(MAX_GROUP_ATOMS, atoms.length - i) }, (__, d) => groupFeatures(atoms, i, i + d)));
  const crownLength = atoms.filter(atom => atom.crownFrac > 0.5 && atom.steep >= 2).reduce((sum, atom) => sum + atom.s1 - atom.s0, 0) || atoms.reduce((sum, atom) => sum + atom.s1 - atom.s0, 0);
  const total = md.reduce((a, b) => a + b, 0), smallest = [...md].sort((a, b) => a - b).slice(0, 4).reduce((a, b) => a + b, 0);
  const kLow = 0.35 * crownLength / total, kHigh = 2.5 * crownLength / smallest;
  let best = { cost: Infinity, steps: [] as Step[], k: 1 };
  let symmetry: (number | null)[] | null = null;
  const tryScale = (k: number) => {
    if (performance.now() - start > limit) throw new Error('Tooth numbering exceeded its local time budget.');
    const result = solveAlignment(atoms, features, md, digits, k, options, symmetry);
    if (result.cost < best.cost) best = { ...result, k };
  };
  for (let s = 0; s < 48; s++) tryScale(kLow * (kHigh / kLow) ** (s / 47));
  const coarse = best.k, ratio = (kHigh / kLow) ** (1 / 47);
  for (let s = -6; s <= 6; s++) tryScale(coarse * ratio ** (s / 6));
  if (!Number.isFinite(best.cost)) throw new Error('No consistent tooth sequence fits this arch.');
  // Bilateral refinement for whole arches: compare mirrored positions' distance from the midline.
  if (options.apexS !== null && options.apexWeight >= 0.5) {
    for (let pass = 0; pass < 3; pass++) {
      symmetry = positionCenters(best.steps, atoms, md);
      const scale = best.k;
      best = { cost: Infinity, steps: [], k: scale };
      for (let s = -4; s <= 4; s++) tryScale(scale * ratio ** (s / 4));
    }
  }
  const k = best.k;
  const groups: NumberedGroup[] = best.steps.map(step => {
    const f = features[step.i][step.j - step.i]!;
    const positions = step.label === 'tooth' ? [step.q] : step.label === 'gap' || (step.label === 'unscanned' && step.m > 0) ? Array.from({ length: step.m }, (_, r) => step.q + r) : [];
    const fdis = positions.map(q => order[q]);
    return {
      kind: step.label, start: step.i, end: step.j, fdi: step.label === 'tooth' ? fdis[0] : null, positions: fdis,
      crownLikelihood: f.crown, label: step.label === 'tooth' ? `FDI ${fdis[0]}` : step.label === 'gap' ? `Gap · ${fdis.join(', ')}` : step.label === 'unscanned' ? 'Not scanned' : 'Non-tooth tissue',
      confidence: 0, alternatives: [], cost: step.cost,
    };
  });
  // Evidence margins: forbid each identity/gap position and re-solve at the same scale.
  for (const group of groups) {
    if (group.kind !== 'tooth' && group.kind !== 'gap') continue;
    const center = Math.round((group.start + group.end) / 2);
    const margins: number[] = [];
    const alternatives = new Set<number>();
    for (const fdi of group.positions ?? []) {
      if (performance.now() - start > limit) break;
      const q = order.indexOf(fdi);
      const constrained = solveAlignment(atoms, features, md, digits, k, options, symmetry, { label: group.kind === 'tooth' ? 'tooth' : 'gap', position: q, atom: center });
      margins.push(constrained.cost - best.cost);
      options.onAlternative?.(fdi, constrained.steps.map(step => ({ ...step, q: step.q >= 0 ? order[step.q] : -1 })), constrained.cost - best.cost);
      const replacement = constrained.steps.find(step => step.i <= center && step.j >= center);
      if (replacement?.label === 'tooth' && order[replacement.q] !== fdi) alternatives.add(order[replacement.q]);
      if (replacement?.label === 'gap') for (let r = 0; r < replacement.m; r++) if (order[replacement.q + r] !== fdi) alternatives.add(order[replacement.q + r]);
    }
    const margin = margins.length ? Math.min(...margins) : 0;
    // Margin → evidence score. Gap identities are discounted: drift and closure make them less certain than crowns.
    group.confidence = Number((group.kind === 'tooth' ? (1 - Math.exp(-Math.max(0, margin) / 1.5)) * clamp(group.crownLikelihood ?? 0, 0, 1) ** 0.25 : 1 - Math.exp(-Math.max(0, margin) / 2.2)).toFixed(3));
    group.alternatives = [...alternatives].slice(0, 3);
  }
  // Positions skipped without space between consecutive aligned groups.
  const skipped: number[] = [];
  let last = -1;
  for (const group of groups) {
    if (!group.positions?.length) continue;
    const first = order.indexOf(group.positions[0]);
    if (last >= 0) for (let q = last + 1; q < first; q++) skipped.push(order[q]);
    last = order.indexOf(group.positions[group.positions.length - 1]);
  }
  return { arch: options.arch, orientation: options.orientation, scale: k, cost: best.cost, groups, sequence: [...order], skipped, method: 'Dynamic-programming alignment of crown/gap/tissue segments to permanent FDI proportions with one fitted scale per arch' };
}

/**
 * Arc direction conditioned only on an explicitly supplied patient-right image
 * side. Arch shape locates the mediolateral tangent; it never confirms chirality.
 * The image's horizontal axis is the original detector's frame.u, not e1.
 */
export function confirmedArchOrientation(model: ArchModel, imageU: Vec3, patientRight: 'image-left' | 'image-right' | null | undefined): { orientation: 1 | -1 | null; confidence: number; basis: string } {
  if (patientRight !== 'image-left' && patientRight !== 'image-right') return { orientation: null, confidence: 0, basis: 'Patient right is unconfirmed; geometric grouping has no asserted FDI.' };
  const sign = patientRight === 'image-right' ? 1 : -1;
  const right: Vec3 = [sign * imageU[0], sign * imageU[1], sign * imageU[2]];
  if (!right.every(Number.isFinite) || Math.abs(Math.hypot(...right) - 1) > 1e-5) return { orientation: null, confidence: 0, basis: 'The image horizontal axis is unavailable.' };
  const rx = right[0] * model.e1[0] + right[1] * model.e1[1] + right[2] * model.e1[2];
  const ry = right[0] * model.e2[0] + right[1] * model.e2[1] + right[2] * model.e2[2];
  let sum = 0, weight = 0;
  for (let i = 0; i < model.curveS.length; i++) {
    const w = model.anterior.apexS === null ? 1 : Math.max(0, 1 - Math.abs(model.curveS[i] * model.scale - model.anterior.apexS) / (0.2 * model.length * model.scale));
    sum += w * (rx * model.curveTx[i] + ry * model.curveTy[i]); weight += w;
  }
  const strength = weight > 0 ? Math.abs(sum) / weight : 0;
  if (strength < 0.25) return { orientation: null, confidence: 0, basis: 'Confirmed image side cannot be projected reliably onto this arch curve.' };
  return { orientation: sum < 0 ? 1 : -1, confidence: clamp(strength), basis: 'Arc tangent relative to explicitly confirmed patient-right image side; no chirality inferred from anatomy.' };
}
