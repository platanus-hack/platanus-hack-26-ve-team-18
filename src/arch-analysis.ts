import type { Vec3 } from './models';
import type { AutoToothScan } from './auto-tooth-types';
import { Budget, buildMesh, type Mesh } from './auto-tooth-geometry.ts';

/**
 * Tooth-level arch analysis from an occlusal height map.
 *
 * Detection peaks are cusp-scale seeds. This module orders the arch surface along
 * a fitted arch curve, measures cross-section profiles, and cuts the curve into
 * small "atoms" at candidate interproximal boundaries, crown/low/unscanned
 * transitions and wall-steepness changes. Grouping atoms into teeth, gaps and
 * non-tooth tissue happens jointly with FDI sequence alignment
 * (tooth-numbering.ts), then `ArchModel.finalize` assigns faces.
 *
 * Every threshold is relative to the scan's own measured relief and extent. No
 * millimetre scale, FDI identity or tissue diagnosis is assumed; classes describe
 * geometric evidence and can be wrong.
 */
export const ARCH_ANALYSIS_METHOD = 'Occlusal height map / arch-curve cross-section profiles / wall steepness / interproximal pinch';
export type SurfaceClass = 'unknown' | 'crown' | 'gingiva' | 'ridge' | 'outside-band' | 'boundary' | 'debris' | 'restoration-like' | 'soft-tissue-protrusion';
export const SURFACE_CLASSES: readonly SurfaceClass[] = ['unknown', 'crown', 'gingiva', 'ridge', 'outside-band', 'boundary', 'debris', 'restoration-like', 'soft-tissue-protrusion'];
export const SURFACE_CLASS_LABELS: Record<SurfaceClass, string> = {
  unknown: 'Unknown or mixed surface',
  crown: 'Plausible tooth crown',
  gingiva: 'Tissue-like cervical band (colour cue; unconfirmed)',
  ridge: 'Low ridge-like surface (tooth absence unconfirmed)',
  'outside-band': 'Outside the dental band (palate, vestibule or floor area)',
  boundary: 'Open scan boundary',
  debris: 'Small disconnected fragment',
  'restoration-like': 'Restoration, abutment or scanbody-like protrusion',
  'soft-tissue-protrusion': 'Elevated surface without crown walls (for example tuberosity or retromolar tissue)',
};
const code = (value: SurfaceClass) => SURFACE_CLASSES.indexOf(value);

export interface ArchToothSegment {
  /** 1-based order along the arch curve; geometry identity only. */
  id: number;
  fdi: number | null;
  faces: Uint32Array;
  centroid: Vec3;
  top: Vec3;
  axis: Vec3;
  s: [number, number];
  sCenter: number;
  /** Arc-length span at crown level, file units. */
  mdWidth: number;
  /** Cross-section width at mid-crown height, file units. */
  blWidth: number;
  /** Crown relief above the estimated cervical level, file units. */
  height: number;
  cervicalLevel: number;
  peaks: number;
  crownScore: number;
  kind: 'crown' | 'restoration-like';
  flags: string[];
}
export interface ArchGapSegment {
  id: string;
  s: [number, number];
  length: number;
  kind: 'bounded' | 'terminal-start' | 'terminal-end';
  support: 'ridge' | 'not-scanned' | 'mixed' | 'soft-tissue';
  coverage: number;
  /** Median crest relative to neighbouring cervical levels, file units; negative is below. */
  ridgeHeight: number | null;
  before: number | null;
  after: number | null;
  /** FDI positions this gap consumed in the best sequence alignment; empty for tissue/unobserved. */
  positions: number[];
}
export interface ArchAtom {
  index: number; start: number; end: number;
  s0: number; s1: number;
  crownFrac: number; lowFrac: number; unscannedFrac: number;
  steep: number; promRel: number; topRel: number;
  peaks: number; tissue: number | null; blMid: number;
  /** Boundary evidence at the start cut, 0..1; -1 at the curve end. */
  startCut: number;
}
export interface ArchCurve {
  points: Vec3[];
  s: number[];
  tangent: Vec3[];
  lingual: Vec3[];
  crownLevel: number[];
  state: ('crown' | 'low' | 'unscanned')[];
}
export interface ArchAnalysis {
  version: 2;
  method: string;
  frame: { origin: Vec3; up: Vec3; e1: Vec3; e2: Vec3 };
  curve: ArchCurve;
  curveMode: 'angular' | 'linear';
  length: number;
  teeth: ArchToothSegment[];
  gaps: ArchGapSegment[];
  classes: Uint8Array;
  classCounts: Record<SurfaceClass, number>;
  coverage: { scannedFraction: number; boundaryFaces: number; openEdges: number; components: number; debrisComponents: number };
  scale: { cell: number; toothWidth: number; crownProminence: number; bandHalfWidth: number; medianEdge: number };
  anterior: { direction: Vec3 | null; apexS: number | null; confidence: number; basis: string };
  lingualConfidence: number;
  warnings: string[];
}
export interface ArchAnalysisOptions { tissueScores?: Float32Array; budgetMs?: number }
export interface SegmentGroup {
  kind: 'tooth' | 'gap' | 'tissue' | 'unscanned';
  /** Inclusive atom range. */
  start: number; end: number;
  fdi?: number | null;
  positions?: number[];
  crownLikelihood?: number;
}

type V = [number, number, number];
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: ArrayLike<number>): V => { const l = Math.hypot(a[0], a[1], a[2]); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1]; };
const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value));
export function quantile(values: ArrayLike<number>, q: number): number {
  const sorted = Float64Array.from(values).filter(Number.isFinite).sort();
  if (!sorted.length) return NaN;
  const at = clamp(q) * (sorted.length - 1), low = Math.floor(at), high = Math.ceil(at);
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
}
function weightedMedian(values: number[], weights: number[]): number {
  const order = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
  const total = weights.reduce((sum, w) => sum + w, 0);
  let running = 0;
  for (const i of order) { running += weights[i]; if (running >= total / 2) return values[i]; }
  return values[order[order.length - 1]];
}

/** Per-curve-sample profile measurements (normalized units unless stated). */
export interface ArchProfile {
  top: Float64Array; topT: Float64Array; prom: Float64Array; steep: Float64Array; cover: Float64Array;
  widthHigh: Float64Array; widthMid: Float64Array; boundary: Float64Array; state: ('crown' | 'low' | 'unscanned')[];
}

/** Internal height-map model. Retained in the worker for numbering and site localization; not transferred. */
export class ArchModel {
  readonly mesh: Mesh;
  readonly positions: Float32Array;
  readonly up: V; readonly e1: V; readonly e2: V;
  readonly x0: number; readonly y0: number; readonly cell: number; readonly nx: number; readonly ny: number;
  readonly H: Float32Array; readonly F: Int32Array; readonly occupied: Uint8Array;
  readonly faceS: Float32Array; readonly faceT: Float32Array;
  curveX: number[] = []; curveY: number[] = []; curveS: number[] = []; curveTx: number[] = []; curveTy: number[] = []; curveLx: number[] = []; curveLy: number[] = [];
  crownLevel: number[] = [];
  profile!: ArchProfile;
  atoms: ArchAtom[] = [];
  crownProminence = 0; bandHalfWidth = 0; medianEdge = 0; length = 0;
  curveMode: 'angular' | 'linear' = 'linear';
  lingualConfidence = 0;
  anterior: ArchAnalysis['anterior'] = { direction: null, apexS: null, confidence: 0, basis: '' };
  warnings: string[] = [];
  open!: Uint8Array;
  debris!: Uint8Array;
  debrisComponents = 0;
  seedFaces = new Set<number>();
  tissue: Float32Array | undefined;
  analysis: ArchAnalysis | null = null;
  constructor(mesh: Mesh, positions: Float32Array, up: V, e1: V, e2: V, grid: { x0: number; y0: number; cell: number; nx: number; ny: number }) {
    this.mesh = mesh; this.positions = positions; this.up = up; this.e1 = e1; this.e2 = e2;
    this.x0 = grid.x0; this.y0 = grid.y0; this.cell = grid.cell; this.nx = grid.nx; this.ny = grid.ny;
    this.H = new Float32Array(grid.nx * grid.ny).fill(-Infinity);
    this.F = new Int32Array(grid.nx * grid.ny).fill(-1);
    this.occupied = new Uint8Array(grid.nx * grid.ny);
    this.faceS = new Float32Array(mesh.n).fill(NaN);
    this.faceT = new Float32Array(mesh.n).fill(NaN);
  }
  get scale() { return this.mesh.scale; }
  /** Source coordinates → normalized plan coordinates [x, y, height]. */
  plan(point: ArrayLike<number>): V {
    const p: V = [0, 1, 2].map(k => (point[k] - this.mesh.reference[k]) / this.mesh.scale) as V;
    return [dot(p, this.e1), dot(p, this.e2), dot(p, this.up)];
  }
  /** Normalized plan coordinates → source coordinates. */
  source(x: number, y: number, z: number): Vec3 {
    return [0, 1, 2].map(k => this.mesh.reference[k] + this.mesh.scale * (x * this.e1[k] + y * this.e2[k] + z * this.up[k])) as Vec3;
  }
  /** Height along `up` in source units → normalized height. */
  normalizedHeight(sourceHeight: number) { return (sourceHeight - dot(this.mesh.reference, this.up)) / this.mesh.scale; }
  sourceHeight(normalized: number) { return normalized * this.mesh.scale + dot(this.mesh.reference, this.up); }
  cellIndex(x: number, y: number): number {
    const i = Math.floor((x - this.x0) / this.cell), j = Math.floor((y - this.y0) / this.cell);
    return i < 0 || j < 0 || i >= this.nx || j >= this.ny ? -1 : j * this.nx + i;
  }
  /** Curve sample index nearest to arc length s (normalized units). */
  sampleAt(s: number): number { return clamp(Math.round(s / this.cell), 0, this.curveS.length - 1); }
  /** Plan position at arc length s and lingual offset t (normalized). */
  at(s: number, t: number): [number, number] {
    const i = this.sampleAt(s);
    const extra = s - this.curveS[i];
    return [this.curveX[i] + extra * this.curveTx[i] + t * this.curveLx[i], this.curveY[i] + extra * this.curveTy[i] + t * this.curveLy[i]];
  }
  /** Nearest projected triangle point, highest only for coincident projections.
   * The bounded height-map lookup is approximate; it never extrapolates a face
   * or prefers a remote crown merely because it is taller than the ridge.
   */
  surfaceAt(x: number, y: number, radiusCells = 2, acceptFace?: (face: number) => boolean): { face: number; point: Vec3; height: number; planDistance: number } | null {
    if (![x, y, radiusCells].every(Number.isFinite) || radiusCells < 0) return null;
    let best: { face: number; point: Vec3; height: number; planDistance: number } | null = null;
    let bestDistance = Infinity;
    const seen = new Set<number>();
    const radius = Math.floor(radiusCells);
    const ci = Math.floor((x - this.x0) / this.cell), cj = Math.floor((y - this.y0) / this.cell);
    for (let dj = -radius; dj <= radius; dj++) for (let di = -radius; di <= radius; di++) {
      const i = ci + di, j = cj + dj;
      if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) continue;
      const index = j * this.nx + i, face = this.F[index];
      if (face < 0 || !this.occupied[index] || seen.has(face) || (acceptFace && !acceptFace(face))) continue;
      seen.add(face);
      const points = [0, 1, 2].map(j => this.plan(this.positions.subarray(face * 9 + j * 3, face * 9 + j * 3 + 3)));
      const [a, b, c] = points;
      const det = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
      let weights: number[] | null = null;
      if (Math.abs(det) > 1e-18) {
        const u = ((x - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (y - a[1])) / det;
        const v = ((b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1])) / det;
        if (u >= 0 && v >= 0 && u + v <= 1) weights = [1 - u - v, u, v];
      }
      if (!weights) {
        let closest = Infinity;
        for (let edge = 0; edge < 3; edge++) {
          const next = (edge + 1) % 3, p = points[edge], q = points[next];
          const dx = q[0] - p[0], dy = q[1] - p[1], length2 = dx * dx + dy * dy;
          const t = length2 > 0 ? clamp(((x - p[0]) * dx + (y - p[1]) * dy) / length2) : 0;
          const distance = (p[0] + t * dx - x) ** 2 + (p[1] + t * dy - y) ** 2;
          if (distance < closest) { closest = distance; weights = [0, 0, 0]; weights[edge] = 1 - t; weights[next] = t; }
        }
      }
      if (!weights) continue;
      const projected = [0, 1, 2].map(k => points.reduce((sum, p, j) => sum + weights[j] * p[k], 0));
      const distance = Math.hypot(projected[0] - x, projected[1] - y);
      if (distance > (radius + 1) * this.cell) continue;
      if (best && (distance > bestDistance + 1e-12 || (Math.abs(distance - bestDistance) <= 1e-12 && (projected[2] < best.height || (projected[2] === best.height && face > best.face))))) continue;
      const point = [0, 1, 2].map(k => weights.reduce((sum, w, j) => sum + w * this.positions[face * 9 + j * 3 + k], 0)) as Vec3;
      bestDistance = distance;
      best = { face, point, height: projected[2], planDistance: distance * this.scale };
    }
    return best;
  }
  /** Assign faces and summaries for a chosen grouping of atoms. */
  finalize(groups: SegmentGroup[]): ArchAnalysis {
    const { mesh, profile, atoms, cell } = this;
    const samples = this.curveS.length, scale = mesh.scale, P = this.crownProminence, band = this.bandHalfWidth;
    const groupOfSample = new Int32Array(samples).fill(-1);
    groups.forEach((group, g) => { for (let i = atoms[group.start].start; i <= atoms[group.end].end; i++) groupOfSample[i] = g; });
    const span = (group: SegmentGroup): [number, number] => [atoms[group.start].start, atoms[group.end].end];
    const toothTop = groups.map(group => { if (group.kind !== 'tooth') return -Infinity; const [a, b] = span(group); let best = -Infinity; for (let i = a; i <= b; i++) best = Math.max(best, profile.top[i]); return best; });
    const toothProm = groups.map(group => {
      if (group.kind !== 'tooth') return P;
      const [a, b] = span(group), values: number[] = [];
      for (let i = a; i <= b; i++) if (Number.isFinite(profile.prom[i])) values.push(profile.prom[i]);
      return values.length ? quantile(values, 0.5) : P;
    });
    const cervical = groups.map((_, g) => toothTop[g] - 0.8 * Math.max(toothProm[g], 0.4 * P));
    const classes = new Uint8Array(mesh.n);
    const toothFaces: number[][] = groups.map(() => []);
    for (const f of mesh.valid) {
      if (this.debris[f]) { classes[f] = code('debris'); continue; }
      const s = this.faceS[f], t = this.faceT[f];
      const z = mesh.xyz[f * 3] * this.up[0] + mesh.xyz[f * 3 + 1] * this.up[1] + mesh.xyz[f * 3 + 2] * this.up[2];
      if (Number.isNaN(s) || Math.abs(t) > band * 1.3) { classes[f] = code('outside-band'); continue; }
      const i = this.sampleAt(s), g = groupOfSample[i];
      const group = g >= 0 ? groups[g] : null;
      if (group?.kind === 'tooth' && z >= cervical[g]) { classes[f] = code('crown'); toothFaces[g].push(f); continue; }
      if (group?.kind === 'gap') { classes[f] = profile.state[i] === 'low' ? code('ridge') : code('unknown'); continue; }
      if (group?.kind === 'tissue') { classes[f] = profile.state[i] === 'crown' ? code('soft-tissue-protrusion') : code('ridge'); continue; }
      // Below a candidate's cervical cut is unassigned geometry. Without
      // independent tissue evidence it is not a gingiva segmentation.
      if (group?.kind === 'tooth') { classes[f] = this.tissue && this.tissue[f] >= 0.65 && this.tissue[f] <= 1 ? code('gingiva') : code('unknown'); continue; }
      classes[f] = code('unknown');
    }
    for (const f of mesh.valid) if (this.debris[f]) classes[f] = code('debris');
    for (const f of mesh.valid) if (this.open[f] && classes[f] !== code('crown') && classes[f] !== code('debris')) classes[f] = code('boundary');

    const up = this.up, e1 = this.e1, e2 = this.e2;
    const teeth: ArchToothSegment[] = [];
    const toothIdOfGroup = new Map<number, number>();
    const medianWidth = quantile(groups.filter(group => group.kind === 'tooth').map(group => (atoms[group.end].s1 - atoms[group.start].s0)), 0.5);
    groups.forEach((group, g) => {
      if (group.kind !== 'tooth') return;
      const faces = toothFaces[g];
      if (faces.length < 12) { for (const f of faces) classes[f] = code('unknown'); return; }
      let area = 0, peaks = 0, topFace = faces[0], flatTop = 0, flatArea = 0, wall = 0;
      const centroid: V = [0, 0, 0], axis: V = [0, 0, 0];
      for (const f of faces) {
        const a = mesh.area[f], p = mesh.xyz.subarray(f * 3, f * 3 + 3), n = mesh.normal.subarray(f * 3, f * 3 + 3), z = dot(p, up);
        area += a; for (let q = 0; q < 3; q++) centroid[q] += a * p[q];
        if (z > dot(mesh.xyz.subarray(topFace * 3, topFace * 3 + 3), up)) topFace = f;
        if (this.seedFaces.has(f)) peaks++;
        if (z >= toothTop[g] - 0.35 * toothProm[g]) for (let q = 0; q < 3; q++) axis[q] += a * n[q];
        if (z >= toothTop[g] - 0.15 * toothProm[g]) { flatArea += a; flatTop += a * Math.abs(dot(n, up)); }
        if (Math.abs(dot(n, up)) < 0.3) wall += a;
      }
      for (let q = 0; q < 3; q++) centroid[q] /= area;
      const [a, b] = span(group);
      let bl = 0;
      for (let i = a; i <= b; i++) bl = Math.max(bl, profile.widthMid[i]);
      const md = atoms[group.end].s1 - atoms[group.start].s0;
      const flags: string[] = [];
      const ratio = md / (medianWidth || md);
      if (ratio > 1.9) flags.push('Unusually long crown segment; adjacent crowns may be merged.');
      if (ratio < 0.5) flags.push('Unusually short crown segment; a crown may be split or partly scanned.');
      if (faces.some(f => this.open[f])) flags.push('Touches an open scan boundary; part of this crown may be missing from the scan.');
      const restorationLike = flatArea > area * 0.25 && flatTop / Math.max(flatArea, 1e-12) > 0.97 && wall > area * 0.25;
      if (restorationLike) { flags.push('Flat top with steep walls: possible restoration, abutment or scanbody. Review before treating as natural anatomy.'); for (const f of faces) classes[f] = code('restoration-like'); }
      if (group.start !== group.end) {
        const internal = atoms.slice(group.start + 1, group.end + 1).map(atom => atom.startCut);
        if (internal.some(value => value >= 0.5)) flags.push('Merged across a visible interproximal boundary to match expected tooth proportions; review the split.');
      }
      const tp = mesh.xyz.subarray(topFace * 3, topFace * 3 + 3);
      toothIdOfGroup.set(g, teeth.length + 1);
      teeth.push({
        id: teeth.length + 1, fdi: group.fdi ?? null, faces: Uint32Array.from(faces).sort(),
        centroid: this.source(dot(centroid, e1), dot(centroid, e2), dot(centroid, up)),
        top: this.source(dot(tp, e1), dot(tp, e2), dot(tp, up)),
        axis: unit(dot(axis, axis) > 0 ? axis : up),
        s: [atoms[group.start].s0, atoms[group.end].s1], sCenter: (atoms[group.start].s0 + atoms[group.end].s1) / 2,
        mdWidth: md, blWidth: bl * scale, height: (toothTop[g] - cervical[g]) * scale, cervicalLevel: this.sourceHeight(cervical[g]),
        peaks, crownScore: Number((group.crownLikelihood ?? 0).toFixed(3)), kind: restorationLike ? 'restoration-like' : 'crown', flags,
      });
    });
    const gaps: ArchGapSegment[] = [];
    const nearestTooth = (g: number, direction: -1 | 1) => { for (let k = g + direction; k >= 0 && k < groups.length; k += direction) if (toothIdOfGroup.has(k)) return toothIdOfGroup.get(k)!; return null; };
    groups.forEach((group, g) => {
      if (group.kind === 'tooth') return;
      const before = nearestTooth(g, -1), after = nearestTooth(g, 1);
      const isTerminal = before === null || after === null;
      if (group.kind === 'tissue' && !isTerminal) return;
      const [a, b] = span(group);
      let unscanned = 0, low = 0; const lows: number[] = [];
      for (let i = a; i <= b; i++) { if (profile.state[i] === 'unscanned') unscanned++; else if (Number.isFinite(profile.top[i])) { lows.push(profile.top[i]); if (profile.state[i] === 'low') low++; } }
      const n = b - a + 1;
      const neighbours = [before, after].filter((id): id is number => id !== null).map(id => teeth[id - 1]);
      const cervicalMean = neighbours.length ? neighbours.reduce((sum, tooth) => sum + this.normalizedHeight(tooth.cervicalLevel), 0) / neighbours.length : null;
      gaps.push({
        id: `G${gaps.length + 1}`, s: [atoms[group.start].s0, atoms[group.end].s1], length: atoms[group.end].s1 - atoms[group.start].s0,
        kind: before !== null && after !== null ? 'bounded' : before !== null ? 'terminal-end' : 'terminal-start',
        support: group.kind === 'tissue' ? 'soft-tissue' : unscanned / n > 0.75 ? 'not-scanned' : unscanned / n < 0.25 && low / n >= 0.75 ? 'ridge' : 'mixed',
        coverage: Number((1 - unscanned / n).toFixed(3)),
        ridgeHeight: lows.length && cervicalMean !== null ? (quantile(lows, 0.5) - cervicalMean) * scale : null,
        before, after, positions: group.kind === 'gap' || group.kind === 'unscanned' ? [...(group.positions ?? [])] : [],
      });
    });
    const classCounts = Object.fromEntries(SURFACE_CLASSES.map(name => [name, 0])) as Record<SurfaceClass, number>;
    for (const f of mesh.valid) classCounts[SURFACE_CLASSES[classes[f]]]++;
    const scannedFraction = profile.state.filter(value => value !== 'unscanned').length / samples;
    const warnings = [...this.warnings];
    if (teeth.some(tooth => tooth.kind === 'restoration-like')) warnings.push('A restoration-like protrusion was retained for review rather than discarded.');
    if (classCounts['soft-tissue-protrusion']) warnings.push('Elevated surfaces without crown walls (for example tuberosity or retromolar tissue) were kept out of tooth identity.');
    this.analysis = {
      version: 2, method: ARCH_ANALYSIS_METHOD, frame: { origin: this.source(0, 0, 0), up, e1, e2 }, curveMode: this.curveMode, length: this.length * scale,
      curve: {
        points: this.curveX.map((x, i) => this.source(x, this.curveY[i], this.crownLevel[i])), s: this.curveS.map(value => value * scale),
        tangent: this.curveTx.map((tx, i) => unit([0, 1, 2].map(k => tx * e1[k] + this.curveTy[i] * e2[k]))),
        lingual: this.curveLx.map((lx, i) => unit([0, 1, 2].map(k => lx * e1[k] + this.curveLy[i] * e2[k]))),
        crownLevel: this.crownLevel.map(value => this.sourceHeight(value)), state: profile.state,
      },
      teeth, gaps, classes, classCounts,
      coverage: { scannedFraction: Number(scannedFraction.toFixed(3)), boundaryFaces: this.open.reduce((sum, value) => sum + value, 0), openEdges: this.openEdges, components: mesh.groups.length, debrisComponents: this.debrisComponents },
      scale: { cell: cell * scale, toothWidth: (medianWidth || 0), crownProminence: P * scale, bandHalfWidth: band * scale, medianEdge: this.medianEdge * scale },
      anterior: this.anterior, lingualConfidence: this.lingualConfidence, warnings,
    };
    return this.analysis;
  }
  openEdges = 0;
}

function planAxes(mesh: Mesh, up: V): { e1: V; e2: V } {
  const seed: V = Math.abs(up[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const a = unit(cross(up, seed)), b = unit(cross(up, a));
  let sw = 0, mx = 0, my = 0;
  for (const f of mesh.valid) { const p = mesh.xyz.subarray(f * 3, f * 3 + 3), w = mesh.area[f]; sw += w; mx += w * dot(p, a); my += w * dot(p, b); }
  mx /= sw || 1; my /= sw || 1;
  let xx = 0, yy = 0, xy = 0;
  for (const f of mesh.valid) {
    const p = mesh.xyz.subarray(f * 3, f * 3 + 3), w = mesh.area[f], x = dot(p, a) - mx, y = dot(p, b) - my;
    xx += w * x * x; yy += w * y * y; xy += w * x * y;
  }
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
  const e1 = unit([0, 1, 2].map(k => Math.cos(angle) * a[k] + Math.sin(angle) * b[k]));
  return { e1, e2: unit(cross(up, e1)) };
}

function boxBlur(values: Float32Array, nx: number, ny: number, radius: number): Float32Array {
  let current: Float32Array = values, next: Float32Array = new Float32Array(values.length);
  for (let pass = 0; pass < 3; pass++) {
    for (let j = 0; j < ny; j++) {
      let sum = 0;
      for (let i = -radius; i <= radius; i++) sum += current[j * nx + Math.min(nx - 1, Math.max(0, i))];
      for (let i = 0; i < nx; i++) {
        next[j * nx + i] = sum / (2 * radius + 1);
        sum += current[j * nx + Math.min(nx - 1, i + radius + 1)] - current[j * nx + Math.max(0, i - radius)];
      }
    }
    [current, next] = [next, current === values ? new Float32Array(values.length) : current];
    for (let i = 0; i < nx; i++) {
      let sum = 0;
      for (let j = -radius; j <= radius; j++) sum += current[Math.min(ny - 1, Math.max(0, j)) * nx + i];
      for (let j = 0; j < ny; j++) {
        next[j * nx + i] = sum / (2 * radius + 1);
        sum += current[Math.min(ny - 1, j + radius + 1) * nx + i] - current[Math.max(0, j - radius) * nx + i];
      }
    }
    [current, next] = [next, current];
  }
  return current;
}

interface Polyline { x: number[]; y: number[] }
function resample(line: Polyline, step: number): Polyline & { s: number[] } {
  const out: Polyline & { s: number[] } = { x: [line.x[0]], y: [line.y[0]], s: [0] };
  let carried = 0, total = 0;
  for (let i = 1; i < line.x.length; i++) {
    const dx = line.x[i] - line.x[i - 1], dy = line.y[i] - line.y[i - 1], length = Math.hypot(dx, dy);
    if (!(length > 0)) continue;
    let along = step - carried;
    while (along <= length) {
      out.x.push(line.x[i - 1] + dx * along / length); out.y.push(line.y[i - 1] + dy * along / length);
      total += step; out.s.push(total); along += step;
    }
    carried = length - (along - step);
  }
  return out;
}
function smooth(line: Polyline, window: number, passes: number): Polyline {
  let x = line.x.slice(), y = line.y.slice();
  for (let pass = 0; pass < passes; pass++) {
    const nx = x.slice(), ny = y.slice();
    for (let i = 1; i < x.length - 1; i++) {
      let sx = 0, sy = 0, n = 0;
      for (let k = -window; k <= window; k++) { const j = Math.min(x.length - 1, Math.max(0, i + k)); sx += x[j]; sy += y[j]; n++; }
      nx[i] = sx / n; ny[i] = sy / n;
    }
    x = nx; y = ny;
  }
  return { x, y };
}
function polylineResidual(line: Polyline, px: number[], py: number[]): number {
  const distances: number[] = [];
  for (let k = 0; k < px.length; k += Math.max(1, Math.floor(px.length / 1500))) {
    let best = Infinity;
    for (let i = 1; i < line.x.length; i++) {
      const ax = line.x[i - 1], ay = line.y[i - 1], bx = line.x[i] - ax, by = line.y[i] - ay, l2 = bx * bx + by * by;
      const t = l2 > 0 ? clamp(((px[k] - ax) * bx + (py[k] - ay) * by) / l2) : 0;
      best = Math.min(best, Math.hypot(px[k] - ax - t * bx, py[k] - ay - t * by));
    }
    distances.push(best);
  }
  return quantile(distances, 0.5);
}

/** Angular ordering around the band's centroid handles U/V arches and gaps between teeth. */
function angularCurve(px: number[], py: number[], pw: number[]): { line: Polyline; span: number; center: [number, number] } | null {
  let sw = 0, cx = 0, cy = 0;
  for (let i = 0; i < px.length; i++) { sw += pw[i]; cx += pw[i] * px[i]; cy += pw[i] * py[i]; }
  cx /= sw; cy /= sw;
  const bins = 120, radii: number[][] = Array.from({ length: bins }, () => []), weights: number[][] = Array.from({ length: bins }, () => []);
  for (let i = 0; i < px.length; i++) {
    const angle = Math.atan2(py[i] - cy, px[i] - cx), bin = Math.min(bins - 1, Math.floor((angle + Math.PI) / (2 * Math.PI) * bins));
    radii[bin].push(Math.hypot(px[i] - cx, py[i] - cy)); weights[bin].push(pw[i]);
  }
  const occupied = radii.map(list => list.length >= 3);
  if (occupied.filter(Boolean).length < 6) return null;
  let bestStart = 0, bestLength = -1;
  for (let start = 0; start < bins; start++) {
    if (occupied[start] || !occupied[(start + bins - 1) % bins]) continue;
    let length = 0;
    while (length < bins && !occupied[(start + length) % bins]) length++;
    if (length > bestLength) { bestLength = length; bestStart = start; }
  }
  const first = bestLength < 0 ? 0 : (bestStart + bestLength) % bins;
  const line: Polyline = { x: [], y: [] };
  let span = 0;
  for (let k = 0; k < bins; k++) {
    const bin = (first + k) % bins;
    if (!occupied[bin]) continue;
    const angle = -Math.PI + (bin + 0.5) / bins * 2 * Math.PI, radius = weightedMedian(radii[bin], weights[bin]);
    line.x.push(cx + radius * Math.cos(angle)); line.y.push(cy + radius * Math.sin(angle));
    span = k + 1;
  }
  return { line, span: span / bins * 360, center: [cx, cy] };
}
/** A gently curved quadrant or segment is ordered along its principal axis. */
function linearCurve(px: number[], py: number[], pw: number[]): Polyline | null {
  let sw = 0, mx = 0, my = 0;
  for (let i = 0; i < px.length; i++) { sw += pw[i]; mx += pw[i] * px[i]; my += pw[i] * py[i]; }
  mx /= sw; my /= sw;
  let xx = 0, yy = 0, xy = 0;
  for (let i = 0; i < px.length; i++) { const dx = px[i] - mx, dy = py[i] - my; xx += pw[i] * dx * dx; yy += pw[i] * dy * dy; xy += pw[i] * dx * dy; }
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy), ux = Math.cos(angle), uy = Math.sin(angle);
  let low = Infinity, high = -Infinity;
  const along = px.map((x, i) => { const a = (x - mx) * ux + (py[i] - my) * uy; low = Math.min(low, a); high = Math.max(high, a); return a; });
  const bins = 80, values: number[][] = Array.from({ length: bins }, () => []), weights: number[][] = Array.from({ length: bins }, () => []);
  for (let i = 0; i < px.length; i++) {
    const bin = Math.min(bins - 1, Math.floor((along[i] - low) / (high - low || 1) * bins));
    values[bin].push(-(px[i] - mx) * uy + (py[i] - my) * ux); weights[bin].push(pw[i]);
  }
  const line: Polyline = { x: [], y: [] };
  for (let bin = 0; bin < bins; bin++) {
    if (values[bin].length < 3) continue;
    const a = low + (bin + 0.5) / bins * (high - low), b = weightedMedian(values[bin], weights[bin]);
    line.x.push(mx + a * ux - b * uy); line.y.push(my + a * uy + b * ux);
  }
  return line.x.length >= 6 ? line : null;
}

/** Robust quadratic trend through samples (Huber reweighting). */
function robustQuadratic(xs: number[], ys: number[]): (x: number) => number {
  if (xs.length < 3) { const mean = ys.reduce((a, b) => a + b, 0) / Math.max(1, ys.length); return () => mean; }
  const center = xs.reduce((a, b) => a + b, 0) / xs.length;
  const span = Math.max(1e-9, Math.max(...xs.map(x => Math.abs(x - center))));
  let weights = xs.map(() => 1), coefficients = [0, 0, 0];
  for (let iteration = 0; iteration < 5; iteration++) {
    const m = [0, 0, 0, 0, 0, 0, 0, 0, 0], r = [0, 0, 0];
    xs.forEach((x, i) => {
      const t = (x - center) / span, basis = [1, t, t * t];
      for (let a = 0; a < 3; a++) { r[a] += weights[i] * basis[a] * ys[i]; for (let b = 0; b < 3; b++) m[a * 3 + b] += weights[i] * basis[a] * basis[b]; }
    });
    for (let a = 0; a < 3; a++) m[a * 4] += 1e-9 + (a === 2 ? 1e-3 * m[0] : 0);
    const det = (q: number[]) => q[0] * (q[4] * q[8] - q[5] * q[7]) - q[1] * (q[3] * q[8] - q[5] * q[6]) + q[2] * (q[3] * q[7] - q[4] * q[6]);
    const d = det(m);
    if (!(Math.abs(d) > 0)) break;
    coefficients = [0, 1, 2].map(column => { const q = m.slice(); for (let row = 0; row < 3; row++) q[row * 3 + column] = r[row]; return det(q) / d; });
    const residuals = xs.map((x, i) => { const t = (x - center) / span; return ys[i] - (coefficients[0] + coefficients[1] * t + coefficients[2] * t * t); });
    const scale = Math.max(1e-9, 1.4826 * quantile(residuals.map(Math.abs), 0.5));
    weights = residuals.map(value => Math.abs(value) <= 1.5 * scale ? 1 : 1.5 * scale / Math.abs(value));
  }
  return x => { const t = (x - center) / span; return coefficients[0] + coefficients[1] * t + coefficients[2] * t * t; };
}

/**
 * Analyse one arch source. `scan` supplies the detected occlusal direction and
 * cusp-scale seeds. Throws when orientation is unavailable; callers retain the
 * other arch and report this source as unresolved.
 */
export function analyzeArch(positions: Float32Array, scan: AutoToothScan, options: ArchAnalysisOptions = {}): ArchModel {
  if (!scan || scan.method === 'unavailable') throw new Error('Arch orientation is unavailable; tooth-level analysis needs a detected occlusal direction.');
  const budget = new Budget(options.budgetMs ?? 15_000, 'Arch analysis exceeded its local time budget. Simplify or split the scan, then retry.');
  const mesh = buildMesh(positions, budget);
  if (mesh.valid.length < 64) throw new Error('The scan has too few valid triangles for arch analysis.');
  if (!scan.frame.up.every(Number.isFinite) || !(Math.hypot(...scan.frame.up) > 1e-12)) throw new Error('The detected occlusal direction is unavailable.');
  const up = unit(scan.frame.up);
  if (!up.every(Number.isFinite) || Math.abs(Math.hypot(...up) - 1) > 1e-6) throw new Error('The detected occlusal direction is not a usable unit vector.');
  const { e1, e2 } = planAxes(mesh, up);

  // --- Occlusal height map: highest surface toward the crowns per plan cell. ---
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const vertex = (f: number, j: number): V => {
    const o = f * 9 + j * 3;
    const p: V = [(positions[o] - mesh.reference[0]) / mesh.scale, (positions[o + 1] - mesh.reference[1]) / mesh.scale, (positions[o + 2] - mesh.reference[2]) / mesh.scale];
    return [dot(p, e1), dot(p, e2), dot(p, up)];
  };
  for (const f of mesh.valid) {
    budget.tick();
    const p = mesh.xyz.subarray(f * 3, f * 3 + 3), x = dot(p, e1), y = dot(p, e2);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const extent = Math.max(maxX - minX, maxY - minY);
  const cell = extent / 360;
  const pad = 4 * cell;
  const grid = { x0: minX - pad, y0: minY - pad, cell, nx: Math.ceil((maxX - minX + 2 * pad) / cell) + 1, ny: Math.ceil((maxY - minY + 2 * pad) / cell) + 1 };
  const model = new ArchModel(mesh, positions, up, e1, e2, grid);
  const { H, F, occupied, nx, ny } = model;
  const edges: number[] = [];
  for (const f of mesh.valid) {
    budget.tick();
    const [a, b, c] = [vertex(f, 0), vertex(f, 1), vertex(f, 2)];
    if (f % 17 === 0) edges.push(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    const i0 = Math.max(0, Math.floor((Math.min(a[0], b[0], c[0]) - grid.x0) / cell)), i1 = Math.min(nx - 1, Math.floor((Math.max(a[0], b[0], c[0]) - grid.x0) / cell));
    const j0 = Math.max(0, Math.floor((Math.min(a[1], b[1], c[1]) - grid.y0) / cell)), j1 = Math.min(ny - 1, Math.floor((Math.max(a[1], b[1], c[1]) - grid.y0) / cell));
    const det = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    let hit = false;
    if (Math.abs(det) > 1e-20) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = grid.x0 + (i + 0.5) * cell, y = grid.y0 + (j + 0.5) * cell;
      const u = ((x - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (y - a[1])) / det;
      const v = ((b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1])) / det;
      if (u < -1e-9 || v < -1e-9 || u + v > 1 + 1e-9) continue;
      hit = true;
      const z = a[2] + u * (b[2] - a[2]) + v * (c[2] - a[2]), index = j * nx + i;
      if (z > H[index]) { H[index] = z; F[index] = f; }
      occupied[index] = 1;
    }
    if (!hit) {
      const x = (a[0] + b[0] + c[0]) / 3, y = (a[1] + b[1] + c[1]) / 3, z = (a[2] + b[2] + c[2]) / 3, index = model.cellIndex(x, y);
      if (index >= 0) { if (z > H[index]) { H[index] = z; F[index] = f; } occupied[index] = 1; }
    }
  }
  model.medianEdge = quantile(edges, 0.5);
  for (let pass = 0; pass < 2; pass++) {
    const fill: [number, number][] = [];
    for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
      const index = j * nx + i;
      if (H[index] > -Infinity) continue;
      let sum = 0, count = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) { const value = H[(j + dj) * nx + i + di]; if (value > -Infinity) { sum += value; count++; } }
      if (count >= 5) fill.push([index, sum / count]);
    }
    for (const [index, value] of fill) H[index] = value;
  }

  // --- Local relief and the crown band seed points. ---
  const mask = new Float32Array(nx * ny), weighted = new Float32Array(nx * ny);
  for (let i = 0; i < H.length; i++) if (H[i] > -Infinity) { mask[i] = 1; weighted[i] = H[i]; }
  // Three box passes approximate a Gaussian with sigma ~ radius cells (~6% of the arch extent).
  const radius = Math.max(3, Math.round(0.06 * 360));
  const blurM = boxBlur(mask, nx, ny, radius), blurH = boxBlur(weighted, nx, ny, radius);
  const relief = new Float32Array(nx * ny).fill(NaN);
  const reliefValues: number[] = [];
  for (let i = 0; i < H.length; i++) if (H[i] > -Infinity && blurM[i] > 0.05) { relief[i] = H[i] - blurH[i] / blurM[i]; reliefValues.push(relief[i]); }
  // Flat gum/palate can occupy most of a synthetic or cropped scan. A zero
  // percentile cutoff would fit the arch through that entire sheet. Require
  // positive relief relative to the same scan, without a physical-unit prior.
  const highCut = Math.max(quantile(reliefValues, 0.75), 0.15 * quantile(reliefValues, 0.98));
  const px: number[] = [], py: number[] = [], pw: number[] = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const index = j * nx + i;
    if (!(relief[index] >= highCut) || !occupied[index]) continue;
    px.push(grid.x0 + (i + 0.5) * cell); py.push(grid.y0 + (j + 0.5) * cell); pw.push(Math.max(1e-6, relief[index] - highCut + 1e-3));
  }
  const seedWeight = (quantile(pw, 0.9) || 1) * 4;
  for (const candidate of scan.candidates) {
    model.seedFaces.add(candidate.seed.face);
    const p: V = [0, 1, 2].map(k => (candidate.centroid[k] - mesh.reference[k]) / mesh.scale) as V;
    for (let r = 0; r < 4; r++) { px.push(dot(p, e1)); py.push(dot(p, e2)); pw.push(seedWeight); }
  }
  if (px.length < 40) throw new Error('No elevated crown band was found; flat, edentulous or heavily cropped scans need manual review.');
  const angular = angularCurve(px, py, pw), linear = linearCurve(px, py, pw);
  let line: Polyline | null = null;
  const angularResidual = angular ? polylineResidual(smooth(angular.line, 2, 2), px, py) : Infinity;
  const linearResidual = linear ? polylineResidual(smooth(linear, 2, 2), px, py) : Infinity;
  if (angular && (angular.span >= 140 ? angularResidual <= linearResidual * 1.6 : angularResidual < linearResidual)) { line = angular.line; model.curveMode = 'angular'; }
  else line = linear;
  if (!line) throw new Error('The crown band could not be ordered along an arch curve.');
  let curve = resample(smooth(line, 2, 3), cell);
  if (curve.x.length < 8) throw new Error('The detected arch curve is too short for tooth-level analysis.');

  const tangentAt = (c: Polyline, i: number): [number, number] => {
    const a = Math.max(0, i - 2), b = Math.min(c.x.length - 1, i + 2);
    const dx = c.x[b] - c.x[a], dy = c.y[b] - c.y[a], l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  };
  // Lingual side: concave side of the curve (towards the angular centre for U/V arches).
  let lingualSign = 1;
  {
    let votes = 0, total = 0;
    for (let i = 2; i < curve.x.length - 2; i += 3) {
      const [tx, ty] = tangentAt(curve, i), nxl = -ty, nyl = tx;
      if (model.curveMode === 'angular' && angular) votes += Math.sign((angular.center[0] - curve.x[i]) * nxl + (angular.center[1] - curve.y[i]) * nyl);
      else {
        const [ax, ay] = tangentAt(curve, Math.max(0, i - 6)), [bx, by] = tangentAt(curve, Math.min(curve.x.length - 1, i + 6));
        votes += Math.sign((bx - ax) * nxl + (by - ay) * nyl);
      }
      total++;
    }
    lingualSign = votes >= 0 ? 1 : -1;
    model.lingualConfidence = Number((total ? clamp(Math.abs(votes) / total) : 0).toFixed(3));
    if (model.lingualConfidence < 0.4) model.warnings.push('Buccal/lingual sides of this arch segment are ambiguous; anatomical orientation of generated crowns needs review.');
  }
  const lateral: number[] = [];
  for (let k = 0; k < px.length; k += Math.max(1, Math.floor(px.length / 4000))) {
    let best = Infinity;
    for (let i = 0; i < curve.x.length; i += 2) best = Math.min(best, Math.hypot(px[k] - curve.x[i], py[k] - curve.y[i]));
    lateral.push(best);
  }
  const bandHalfWidth = Math.max(6 * cell, quantile(lateral, 0.9) * 1.15);
  model.bandHalfWidth = bandHalfWidth;

  // Do not grow an inferred arch into merely covered scan surface. A greedy
  // terminal follower can turn onto palate/vestibule and revisit existing
  // crowns, amplifying tiny rasterization changes into false giant gaps.
  // The measured elevated band bounds automatic analysis; terminal anatomy
  // remains unestablished and cannot generate automatic missing sites.
  curve = resample({ x: curve.x, y: curve.y }, cell);
  const samples = curve.x.length, length = curve.s[samples - 1];
  model.length = length;
  model.curveX = curve.x; model.curveY = curve.y; model.curveS = curve.s;
  for (let i = 0; i < samples; i++) {
    const [tx, ty] = tangentAt(curve, i);
    model.curveTx.push(tx); model.curveTy.push(ty);
    model.curveLx.push(-ty * lingualSign); model.curveLy.push(tx * lingualSign);
  }

  // --- Per-cell arc coordinates (slabs) and per-face projection. ---
  const tMax = bandHalfWidth * 1.8;
  const cellS = new Float32Array(nx * ny).fill(NaN), cellT = new Float32Array(nx * ny).fill(NaN);
  for (let i = 0; i < samples; i++) {
    budget.tick(32);
    for (let t = -tMax; t <= tMax; t += cell * 0.5) {
      const index = model.cellIndex(curve.x[i] + t * model.curveLx[i], curve.y[i] + t * model.curveLy[i]);
      if (index < 0) continue;
      if (Number.isNaN(cellT[index]) || Math.abs(t) < Math.abs(cellT[index])) { cellT[index] = t; cellS[index] = curve.s[i]; }
    }
  }
  for (const f of mesh.valid) {
    const p = mesh.xyz.subarray(f * 3, f * 3 + 3), index = model.cellIndex(dot(p, e1), dot(p, e2));
    if (index >= 0) { model.faceS[f] = cellS[index]; model.faceT[f] = cellT[index]; }
  }

  // --- Cross-section profiles along the curve. ---
  const steps = Math.ceil(tMax / cell), rowLength = 2 * steps + 1;
  const profileRows = new Float32Array(samples * rowLength).fill(-Infinity);
  const top = new Float64Array(samples), topT = new Float64Array(samples), cover = new Float64Array(samples);
  const prom = new Float64Array(samples).fill(NaN), steep = new Float64Array(samples);
  for (let i = 0; i < samples; i++) {
    budget.tick(16);
    let best = -Infinity, bestT = 0, hits = 0, inside = 0;
    const side: number[] = [];
    for (let k = -steps; k <= steps; k++) {
      const t = k * cell, index = model.cellIndex(curve.x[i] + t * model.curveLx[i], curve.y[i] + t * model.curveLy[i]);
      const h = index >= 0 ? H[index] : -Infinity;
      profileRows[i * rowLength + k + steps] = h;
      if (Math.abs(t) <= bandHalfWidth) { inside++; if (index >= 0 && occupied[index]) hits++; if (h > best) { best = h; bestT = t; } }
      else if (Math.abs(t) <= bandHalfWidth * 1.6 && h > -Infinity) side.push(h);
    }
    top[i] = best; topT[i] = bestT; cover[i] = hits / Math.max(1, inside);
    // Crown axial walls appear as abrupt height-map steps on both sides; tissue mounds and ridges slope gently.
    if (best > -Infinity) {
      const row = i * rowLength, kt = Math.round(bestT / cell) + steps;
      let left = 0, right = 0;
      for (let k = 1; k <= kt; k++) { const a = profileRows[row + k - 1], b = profileRows[row + k]; if (a > -Infinity && b > -Infinity) left = Math.max(left, (b - a) / cell); }
      for (let k = kt; k < 2 * steps; k++) { const a = profileRows[row + k], b = profileRows[row + k + 1]; if (a > -Infinity && b > -Infinity) right = Math.max(right, (a - b) / cell); }
      steep[i] = Math.min(left, right);
    }
    if (best > -Infinity && side.length >= 3) prom[i] = best - quantile(side, 0.5);
  }
  const medianProm = quantile(Array.from(prom).filter(Number.isFinite), 0.5);
  const initial: number[] = [];
  for (let i = 0; i < samples; i++) if (prom[i] >= 0.5 * medianProm && cover[i] >= 0.3) initial.push(i);
  if (initial.length < 6) throw new Error('No consistent crown relief was found along the arch; the scan may be edentulous, flat or incompletely covered.');
  const P = quantile(initial.map(i => prom[i]), 0.75);
  model.crownProminence = P;
  const level = robustQuadratic(initial.map(i => curve.s[i]), initial.map(i => top[i]));
  const crownLevel = curve.s.map(level);
  model.crownLevel = crownLevel;
  type State = 'crown' | 'low' | 'unscanned';
  const state: State[] = [];
  for (let i = 0; i < samples; i++) {
    if (cover[i] < 0.25 || !(top[i] > -Infinity)) state.push('unscanned');
    else if (top[i] >= crownLevel[i] - 0.45 * P && (Number.isNaN(prom[i]) || prom[i] >= 0.3 * P)) state.push('crown');
    else state.push('low');
  }
  const minRun = Math.max(3, Math.round(0.02 * length / cell));
  const runs = () => {
    const out: { state: State; start: number; end: number }[] = [];
    for (let i = 0; i < samples; i++) {
      if (!out.length || out[out.length - 1].state !== state[i]) out.push({ state: state[i], start: i, end: i });
      else out[out.length - 1].end = i;
    }
    return out;
  };
  for (const run of runs()) if (run.state === 'crown' && run.end - run.start + 1 < minRun) for (let i = run.start; i <= run.end; i++) state[i] = 'low';
  {
    const list = runs();
    list.forEach((run, k) => {
      if (run.state !== 'crown' && k > 0 && k < list.length - 1 && list[k - 1].state === 'crown' && list[k + 1].state === 'crown' && run.end - run.start + 1 < minRun) {
        for (let i = run.start; i <= run.end; i++) state[i] = 'crown';
      }
    });
  }

  // --- Interproximal evidence: crown outline pinch near the occlusal table, plus occlusal dips. ---
  const window = Math.max(2, Math.round(0.03 * length / cell));
  const localTop = new Float64Array(samples);
  for (let i = 0; i < samples; i++) { let best = -Infinity; for (let k = -window; k <= window; k++) { const j = i + k; if (j >= 0 && j < samples && Number.isFinite(top[j])) best = Math.max(best, top[j]); } localTop[i] = best; }
  const widthAt = (i: number, levelValue: number) => {
    const row = i * rowLength, center = Math.round(topT[i] / cell) + steps;
    if (!(profileRows[row + center] >= levelValue)) return 0;
    let low = center, high = center;
    while (low > 0 && profileRows[row + low - 1] >= levelValue) low--;
    while (high < 2 * steps && profileRows[row + high + 1] >= levelValue) high++;
    return (high - low + 1) * cell;
  };
  const widthHigh = new Float64Array(samples), widthMid = new Float64Array(samples);
  for (let i = 0; i < samples; i++) {
    if (state[i] !== 'crown') continue;
    widthHigh[i] = widthAt(i, localTop[i] - 0.3 * P);
    widthMid[i] = widthAt(i, crownLevel[i] - 0.55 * P);
  }
  const smoothArray = (values: Float64Array, radiusSamples: number) => values.map((_, i) => {
    let sum = 0, count = 0;
    for (let k = -radiusSamples; k <= radiusSamples; k++) { const j = i + k; if (j >= 0 && j < values.length) { sum += values[j]; count++; } }
    return sum / count;
  });
  const highSmooth = smoothArray(widthHigh, 1), topSmooth = smoothArray(Float64Array.from(top, value => Number.isFinite(value) ? value : 0), 1);
  const separation = Math.max(minRun, Math.round(0.035 * length / cell));
  // Contacts are valleys of the occlusal-table outline width: depth is measured against BOTH sides,
  // so a long narrowing marginal ridge or a plateau does not become a boundary.
  const boundary = new Float64Array(samples);
  const valley = new Uint8Array(samples);
  for (let i = 0; i < samples; i++) {
    if (state[i] !== 'crown') continue;
    let leftMax = 0, rightMax = 0;
    for (let k = 1; k <= separation; k++) {
      if (i - k >= 0 && state[i - k] === 'crown') leftMax = Math.max(leftMax, highSmooth[i - k]);
      if (i + k < samples && state[i + k] === 'crown') rightMax = Math.max(rightMax, highSmooth[i + k]);
    }
    const reference = Math.min(leftMax || rightMax, rightMax || leftMax);
    const depth = reference > 0 ? clamp(1 - highSmooth[i] / reference) : 0;
    const dip = clamp((localTop[i] - topSmooth[i]) / (0.45 * P));
    boundary[i] = clamp(0.75 * depth + 0.25 * dip);
    const previous = i > 0 ? highSmooth[i - 1] : Infinity, next = i + 1 < samples ? highSmooth[i + 1] : Infinity;
    if (highSmooth[i] <= previous && highSmooth[i] <= next && (highSmooth[i] < previous || highSmooth[i] < next || highSmooth[i] === 0)) valley[i] = 1;
  }
  model.profile = { top, topT, prom, steep, cover, widthHigh, widthMid, boundary, state };

  // --- Cut candidates and atoms. ---
  const cuts = new Map<number, number>();
  const addCut = (i: number, strength: number) => { if (i > 0 && i < samples) cuts.set(i, Math.max(cuts.get(i) ?? 0, strength)); };
  for (let i = 1; i < samples; i++) if (state[i] !== state[i - 1]) addCut(i, 0.9);
  const peakCandidates: number[] = [];
  for (let i = 1; i < samples - 1; i++) if (state[i] === 'crown' && valley[i] && boundary[i] >= 0.12) peakCandidates.push(i);
  peakCandidates.sort((a, b) => boundary[b] - boundary[a]);
  const kept: number[] = [];
  const minAtom = Math.max(2, Math.round(separation / 2));
  for (const i of peakCandidates) { if (kept.some(j => Math.abs(j - i) < minAtom)) continue; kept.push(i); addCut(i, boundary[i]); }
  const steepSmooth = smoothArray(steep, 2);
  for (let i = 1; i < samples; i++) {
    if (state[i] !== 'crown' || state[i - 1] !== 'crown') continue;
    if ((steepSmooth[i - 1] < 2) !== (steepSmooth[i] < 2) && ![...cuts.keys()].some(j => Math.abs(j - i) < minAtom / 1.5)) addCut(i, 0.4);
  }
  const ordered = [...cuts.keys()].sort((a, b) => a - b).filter((i, k, list) => k === 0 || i - list[k - 1] >= 2);
  const starts = [0, ...ordered];
  const tissue = options.tissueScores && options.tissueScores.length === mesh.n ? options.tissueScores : undefined;
  model.tissue = tissue;
  // Seeds and tissue colour per sample (via face projection).
  const seedsPerSample = new Float64Array(samples);
  for (const face of model.seedFaces) { const s = model.faceS[face]; if (!Number.isNaN(s) && Math.abs(model.faceT[face]) <= bandHalfWidth * 1.3) seedsPerSample[model.sampleAt(s)]++; }
  let tissueSum: Float64Array | null = null, tissueArea: Float64Array | null = null;
  if (tissue) {
    tissueSum = new Float64Array(samples); tissueArea = new Float64Array(samples);
    for (const f of mesh.valid) {
      if (!(tissue[f] >= 0 && tissue[f] <= 1) || Number.isNaN(model.faceS[f]) || Math.abs(model.faceT[f]) > bandHalfWidth) continue;
      const z = dot(mesh.xyz.subarray(f * 3, f * 3 + 3), up), i = model.sampleAt(model.faceS[f]);
      if (z < crownLevel[i] - 0.8 * P) continue;
      tissueSum[i] += mesh.area[f] * tissue[f]; tissueArea[i] += mesh.area[f];
    }
  }
  model.atoms = starts.map((start, index) => {
    const end = (index + 1 < starts.length ? starts[index + 1] : samples) - 1;
    const n = end - start + 1;
    let crown = 0, low = 0, unscanned = 0, peaks = 0, tSum = 0, tArea = 0, bl = 0;
    const steeps: number[] = [], proms: number[] = [], tops: number[] = [];
    for (let i = start; i <= end; i++) {
      if (state[i] === 'crown') { crown++; steeps.push(steep[i]); if (Number.isFinite(prom[i])) proms.push(prom[i]); tops.push(top[i] - crownLevel[i]); bl = Math.max(bl, widthMid[i]); }
      else if (state[i] === 'low') { low++; steeps.push(steep[i]); if (Number.isFinite(prom[i])) proms.push(prom[i]); }
      else unscanned++;
      peaks += seedsPerSample[i];
      if (tissueSum && tissueArea) { tSum += tissueSum[i]; tArea += tissueArea[i]; }
    }
    return {
      index, start, end, s0: start * cell * mesh.scale, s1: (end + 1) * cell * mesh.scale,
      crownFrac: crown / n, lowFrac: low / n, unscannedFrac: unscanned / n,
      steep: steeps.length ? quantile(steeps, 0.5) : 0, promRel: proms.length ? quantile(proms, 0.5) / P : 0,
      topRel: tops.length ? quantile(tops, 0.5) / P : -1, peaks, tissue: tArea > 0 ? tSum / tArea : null,
      blMid: bl * mesh.scale, startCut: index === 0 ? -1 : cuts.get(start) ?? 0,
    };
  });

  // --- Open boundaries, debris and fragments. ---
  model.open = new Uint8Array(mesh.n);
  for (const f of mesh.valid) for (let k = 0; k < 3; k++) if (mesh.adjacent[f * 3 + k] < 0) { model.open[f] = 1; model.openEdges++; }
  model.debris = new Uint8Array(mesh.n);
  let totalArea = 0;
  const componentArea = mesh.groups.map(group => { let a = 0; for (const f of group) a += mesh.area[f]; totalArea += a; return a; });
  mesh.groups.forEach((group, g) => {
    if (componentArea[g] >= totalArea * 0.01) return;
    const inBand = group.filter(f => !Number.isNaN(model.faceS[f]) && Math.abs(model.faceT[f]) <= bandHalfWidth * 1.3).length;
    if (inBand < group.length * 0.5 || componentArea[g] < totalArea * 0.0015) {
      model.debrisComponents++;
      for (const f of group) model.debris[f] = 1;
    }
  });
  if (model.debrisComponents) model.warnings.push(`${model.debrisComponents} small disconnected fragment${model.debrisComponents === 1 ? '' : 's'} classified as debris; excluded from tooth identity.`);
  const scannedFraction = state.filter(value => value !== 'unscanned').length / samples;
  if (scannedFraction < 0.85) model.warnings.push('Parts of the arch band have little or no scanned surface; those positions are reported as not scanned, never missing.');

  // --- Anterior direction from the arch shape (laterality support). ---
  {
    const ax = curve.x[0], ay = curve.y[0], bx = curve.x[samples - 1], by = curve.y[samples - 1];
    const chord = Math.hypot(bx - ax, by - ay);
    let apex = 0, depth = -Infinity;
    for (let i = 0; i < samples; i++) {
      const d = chord > 0 ? ((curve.x[i] - ax) * (by - ay) - (curve.y[i] - ay) * (bx - ax)) / chord : 0;
      if (Math.abs(d) > depth) { depth = Math.abs(d); apex = i; }
    }
    const mx = (ax + bx) / 2, my = (ay + by) / 2, dx = curve.x[apex] - mx, dy = curve.y[apex] - my, l = Math.hypot(dx, dy);
    if (model.curveMode === 'angular' && chord > 0 && l > 0) {
      const ratio = depth / chord;
      const [t0x, t0y] = tangentAt(curve, 2), [t1x, t1y] = tangentAt(curve, samples - 3);
      const turned = Math.acos(clamp(t0x * t1x + t0y * t1y, -1, 1)) * 180 / Math.PI;
      const confidence = clamp((ratio - 0.18) / 0.3) * clamp((turned - 60) / 80);
      if (confidence > 0) model.anterior = {
        direction: unit([0, 1, 2].map(k => (dx / l) * e1[k] + (dy / l) * e2[k])), apexS: curve.s[apex] * mesh.scale,
        confidence: Number((0.95 * confidence).toFixed(3)), basis: `Arch curve apex (depth/width ${ratio.toFixed(2)}, tangent turn ${turned.toFixed(0)}°).`,
      };
    }
    if (!model.anterior.direction) {
      // Partial arch: posterior crowns are wider buccolingually than anterior crowns.
      const crownAtoms = model.atoms.filter(atom => atom.crownFrac > 0.6 && atom.steep >= 2);
      if (crownAtoms.length >= 3) {
        const half = Math.floor(crownAtoms.length / 2);
        const startBl = crownAtoms.slice(0, half).reduce((sum, atom) => sum + atom.blMid, 0) / half;
        const endBl = crownAtoms.slice(-half).reduce((sum, atom) => sum + atom.blMid, 0) / half;
        const towardEnd = endBl < startBl, contrast = Math.abs(endBl - startBl) / Math.max(startBl, endBl, 1e-12);
        const [tx, ty] = tangentAt(curve, towardEnd ? samples - 3 : 2), sign = towardEnd ? 1 : -1;
        model.anterior = {
          direction: unit([0, 1, 2].map(k => sign * (tx * e1[k] + ty * e2[k]))), apexS: null,
          confidence: Number((0.6 * clamp(contrast / 0.25)).toFixed(3)), basis: 'Partial arch: narrower buccolingual crowns assumed anterior.',
        };
      } else model.anterior = { direction: null, apexS: null, confidence: 0, basis: 'Arch shape did not establish an anterior direction.' };
    }
  }
  return model;
}

/** Default grouping when sequence alignment is unavailable: crown-like atom runs become provisional teeth. */
export function provisionalGroups(model: ArchModel): SegmentGroup[] {
  const groups: SegmentGroup[] = [];
  model.atoms.forEach((atom, index) => {
    const kind: SegmentGroup['kind'] = atom.unscannedFrac > 0.6 ? 'unscanned' : atom.crownFrac > 0.5 && atom.steep >= 2 ? 'tooth' : atom.crownFrac > 0.5 ? 'tissue' : 'gap';
    const previous = groups[groups.length - 1];
    if (previous && previous.kind === kind && kind !== 'tooth') previous.end = index;
    else groups.push({ kind, start: index, end: index, fdi: null, positions: [] });
  });
  return groups;
}

/** Bounded, transferable summary for the UI and AI tools (no per-face arrays). */
export function summarizeArch(analysis: ArchAnalysis) {
  return {
    curveMode: analysis.curveMode, length: analysis.length,
    teeth: analysis.teeth.map(tooth => ({ id: tooth.id, fdi: tooth.fdi, mdWidth: tooth.mdWidth, blWidth: tooth.blWidth, height: tooth.height, peaks: tooth.peaks, crownScore: tooth.crownScore, kind: tooth.kind, flags: tooth.flags })),
    gaps: analysis.gaps.map(gap => ({ id: gap.id, kind: gap.kind, length: gap.length, support: gap.support, coverage: gap.coverage, before: gap.before, after: gap.after, positions: gap.positions })),
    classCounts: analysis.classCounts, coverage: analysis.coverage, scale: analysis.scale, anterior: { confidence: analysis.anterior.confidence, basis: analysis.anterior.basis },
    warnings: analysis.warnings,
  };
}
