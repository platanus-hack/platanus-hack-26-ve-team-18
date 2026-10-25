import type { Vec3 } from './models';

/**
 * Editable crown anatomy on one fixed, watertight topology.
 *
 * Shapes live in normalized anatomical coordinates: x mesial, y buccal, z
 * occlusal, with the margin (cervical) plane at z = 0. Patient donor crowns are
 * resampled into this topology; procedural templates use the same layout, so
 * fitting deformations, comparisons and exports work identically for both.
 * Expressing donors in anatomical axes makes a contralateral donor a reflection
 * automatically; placement flips winding when the target frame is left-handed.
 */
export const CROWN_THETA = 96;
export const CROWN_WALL = 14;
export const CROWN_RINGS = 24;
export type ToothClass = 'incisor' | 'canine' | 'premolar' | 'molar';
export const toothClassOf = (fdi: number): ToothClass => { const d = fdi % 10; return d <= 2 ? 'incisor' : d === 3 ? 'canine' : d <= 5 ? 'premolar' : 'molar'; };

export interface CrownShapeSource {
  kind: 'patient-donor' | 'procedural-template';
  donorFdi: number | null;
  donorPartId: string | null;
  donorToothId: number | null;
  /** True when the donor comes from the other side of the arch (a reflection in world space). */
  mirrored: boolean;
  faceCount: number;
  provenance: string;
  /** Reproducible source selection in the donor's original file frame. Source
   * geometry identity/pose is bound by the enclosing case record, not a name. */
  selection?: { faces: number[]; frame: DonorFrame };
}
export interface CrownShape {
  version: 1;
  toothClass: ToothClass;
  arch: 'upper' | 'lower';
  digit: number;
  source: CrownShapeSource;
  /** Source dimensions in file units: mesiodistal, buccolingual, cervical-to-cusp height. */
  dims: Vec3;
  /** Normalized outline radius at the rim (unit ellipse = half widths). */
  rim: Float32Array;
  /** Normalized rim height (z / height). */
  rimZ: Float32Array;
  /** Normalized wall radius per level (margin → rim) and angle. */
  wall: Float32Array;
  /** Normalized occlusal height per ring (rim → centre) and angle. */
  occlusal: Float32Array;
  apex: number;
}
export interface CrownMesh {
  /** Local anatomical vertex coordinates (file units), indexed. */
  vertices: Float32Array;
  indices: Uint32Array;
  /** Index ranges by surface zone, for zone-specific objectives. */
  zones: { margin: number[]; wall: number[]; occlusal: number[]; mesial: number[]; distal: number[] };
  vertexCount: number;
}
export interface CrownDeformation {
  /** Per-vertex local displacement (file units), same count as mesh vertices. */
  offsets: Float32Array | null;
}

type V = [number, number, number];
const TAU = Math.PI * 2;
const clamp = (value: number, low = 0, high = 1) => Math.min(high, Math.max(low, value));
const gauss = (dx: number, dy: number, sx: number, sy = sx) => Math.exp(-0.5 * ((dx / sx) ** 2 + (dy / sy) ** 2));
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const subtract = (a: Vec3, b: Vec3): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Anatomical reflection is allowed; scale/shear and automatic axis repair are not. */
function validateFrame(frame: DonorFrame, name: string): void {
  const axes = [frame?.mesial, frame?.buccal, frame?.occlusal];
  if (![frame?.origin, ...axes].every(axis => Array.isArray(axis) && axis.length === 3 && axis.every(Number.isFinite)) ||
      axes.some(axis => Math.abs(dot(axis, axis) - 1) > 1e-8) ||
      Math.abs(dot(axes[0], axes[1])) > 1e-8 || Math.abs(dot(axes[0], axes[2])) > 1e-8 || Math.abs(dot(axes[1], axes[2])) > 1e-8) {
    throw new Error(`${name} anatomical frame must be finite and orthonormal (either handedness).`);
  }
}

function validateMesh(mesh: CrownMesh): void {
  if (!mesh || !(mesh.vertices instanceof Float32Array) || !Number.isSafeInteger(mesh.vertexCount) || mesh.vertexCount < 4 || mesh.vertices.length !== mesh.vertexCount * 3 || !mesh.vertices.every(Number.isFinite) ||
      !(mesh.indices instanceof Uint32Array) || mesh.indices.length < 12 || mesh.indices.length % 3 || !mesh.indices.every(index => index < mesh.vertexCount)) {
    throw new Error('Crown mesh needs finite indexed vertices and valid triangle indices.');
  }
}

function emptyShape(arch: 'upper' | 'lower', digit: number, source: CrownShapeSource, dims: Vec3): CrownShape {
  return {
    version: 1, toothClass: toothClassOf(digit), arch, digit, source, dims,
    rim: new Float32Array(CROWN_THETA), rimZ: new Float32Array(CROWN_THETA),
    wall: new Float32Array(CROWN_WALL * CROWN_THETA), occlusal: new Float32Array(CROWN_RINGS * CROWN_THETA), apex: 0.8,
  };
}

/** Circular fill of NaN entries by linear interpolation between valid neighbours. */
function fillCircular(values: Float64Array | Float32Array): boolean {
  const n = values.length, valid: number[] = [];
  for (let i = 0; i < n; i++) if (Number.isFinite(values[i])) valid.push(i);
  if (!valid.length) return false;
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(values[i])) continue;
    let before = valid[valid.length - 1] - n, after = valid[0] + n;
    for (const v of valid) { if (v < i && v > before) before = v; if (v > i && v < after) after = v; }
    const a = values[(before + n) % n], b = values[after % n], t = (i - before) / (after - before);
    values[i] = a + (b - a) * t;
  }
  return true;
}
function smoothCircular(values: Float32Array | Float64Array, passes: number) {
  for (let pass = 0; pass < passes; pass++) {
    const copy = Float64Array.from(values);
    for (let i = 0; i < values.length; i++) values[i] = (copy[(i - 1 + values.length) % values.length] + 2 * copy[i] + copy[(i + 1) % values.length]) / 4;
  }
}

/**
 * Procedural template: a labelled fallback when no suitable patient donor exists.
 * Class-specific outline, cervical constriction, height of contour, cusps,
 * marginal ridges, fossae and grooves. Not a validated morphology model.
 */
export function templateShape(arch: 'upper' | 'lower', digit: number): CrownShape {
  const toothClass = toothClassOf(digit);
  const shape = emptyShape(arch, digit, { kind: 'procedural-template', donorFdi: null, donorPartId: null, donorToothId: null, mirrored: false, faceCount: 0, provenance: `Procedural ${arch} ${toothClass} template (fallback; not patient anatomy).` }, [1, 1, 1]);
  if (toothClass === 'molar' && arch === 'lower') shape.source.provenance += digit === 6 ? ' Five-cusp first-molar hypothesis.' : digit === 7 ? ' Four-cusp second-molar hypothesis.' : ' Third-molar anatomy is variable; this is a four-cusp hypothesis.';
  if (toothClass === 'molar' && arch === 'upper' && digit === 7) shape.source.provenance += ' Reduced distolingual cusp second-molar hypothesis.';
  // Both two- and three-cusp lower second premolars occur; retain one explicit
  // fallback, not an inferred patient variant (Al Maarif, Dental anatomy, Lec. 10).
  // https://learning-space.uoa.edu.iq/sites/default/files/2024-10/Dental%20anatomy.%20Lec.%2010.pdf
  if (arch === 'lower' && digit === 5) shape.source.provenance += ' Second-premolar anatomy is variable; this is a two-cusp hypothesis, not the three-cusp variant.';
  const exponent = toothClass === 'molar' ? 3.0 : toothClass === 'premolar' ? 2.3 : toothClass === 'canine' ? 2.1 : 2.6;
  for (let a = 0; a < CROWN_THETA; a++) {
    const theta = a / CROWN_THETA * TAU, c = Math.cos(theta), s = Math.sin(theta);
    // Superellipse outline; upper molars are slightly rhomboid. Actual MD/BL
    // dimensions come from the caller, not a universal tooth-size ratio.
    let r = 1 / ((Math.abs(c) ** exponent + Math.abs(s) ** exponent) ** (1 / exponent));
    if (toothClass === 'molar' && arch === 'upper') r *= 1 + 0.05 * Math.sin(2 * theta);
    // The lower first premolar converges lingually (Al Maarif, Lec. 9, pp. 2–3).
    // Narrow its lingual shoulders while retaining the axial size envelope.
    // This coefficient is a normalized shape hypothesis, not a clinical size.
    // https://learning-space.uoa.edu.iq/sites/default/files/2024-10/Dental%20anatomy.%20Lec.%209.pdf
    if (arch === 'lower' && digit === 4) r *= 1 - 0.2 * Math.max(0, -s) * c * c;
    if (toothClass === 'canine') r *= 1 - 0.08 * Math.abs(Math.sin(theta)) * (s < 0 ? 1 : 0.4);
    shape.rim[a] = r;
  }
  // Height of contour: buccal around the cervical third, lingual around the middle third.
  for (let a = 0; a < CROWN_THETA; a++) {
    const theta = a / CROWN_THETA * TAU, s = Math.sin(theta);
    const contour = s > 0 ? 0.3 : 0.48;
    shape.rimZ[a] = toothClass === 'incisor' ? 0.72 : toothClass === 'canine' ? 0.7 : 0.66;
    for (let j = 0; j < CROWN_WALL; j++) {
      const f = j / (CROWN_WALL - 1);
      // Cervical constriction to ~0.78, bulge at the height of contour, slight occlusal convergence.
      const bulge = f < contour ? 0.78 + 0.22 * Math.sin(Math.PI / 2 * f / contour) : 1 - 0.07 * ((f - contour) / (1 - contour)) ** 2;
      const lingualTaper = toothClass === 'incisor' && s < 0 ? 1 - 0.25 * f : 1;
      shape.wall[j * CROWN_THETA + a] = shape.rim[a] * bulge * lingualTaper;
    }
  }
  for (let a = 0; a < CROWN_THETA; a++) shape.rim[a] = shape.wall[(CROWN_WALL - 1) * CROWN_THETA + a];
  const relief = (x: number, y: number): number => {
    // x mesial, y buccal in the unit square. Returns normalized height above the rim level band.
    if (toothClass === 'molar') {
      const cusps = arch === 'upper'
        ? [[0.48, 0.45, 1.0], [-0.45, 0.45, 0.9], [0.45, -0.42, 1.05], [-0.42, -0.45, digit === 7 ? 0.45 : 0.75]]
        : digit === 6 ? [[0.5, 0.45, 1.0], [-0.05, 0.5, 0.9], [-0.55, 0.38, 0.7], [0.48, -0.42, 1.05], [-0.42, -0.42, 0.95]]
        : [[0.48, 0.45, 1.0], [-0.45, 0.45, 0.9], [0.45, -0.42, 1.05], [-0.42, -0.45, 0.95]];
      let h = 0;
      for (const [cx, cy, w] of cusps) h = Math.max(h, w * gauss(x - cx, y - cy, 0.34, 0.32));
      // Marginal ridges along mesial/distal edges, central fossa and fissures.
      const marginal = 0.45 * Math.max(gauss(x - 0.82, y, 0.08, 0.55), gauss(x + 0.82, y, 0.08, 0.55));
      // End the lower first-molar cross fissure before its middle buccal
      // cusp; carrying it to the rim splits that intended peak in two.
      const crossFissure = arch === 'lower' && digit === 6 && y > 0 ? 0.3 * gauss(0, y, 1, 0.18) : Math.abs(y) > 0.35 ? 1 : 0.3;
      const groove = 0.35 * gauss(0, y, 1, 0.07) * (1 - gauss(x, 0, 0.9, 1) * 0.2) + 0.25 * gauss(x, 0, 0.06, 1) * crossFissure;
      const surface = Math.max(h, marginal) - groove - 0.25 * gauss(x, y, 0.25);
      if (arch === 'upper') {
        // The oblique ridge joins mesiolingual (+x,-y) to distobuccal (-x,+y),
        // with fossae beside it (Al Maarif, Dental anatomy, Lec. 11, pp. 3–4).
        // https://learning-space.uoa.edu.iq/sites/default/files/2024-10/Dental%20anatomy.%20Lec.%2011.pdf
        // A saddle rises toward the existing cusps, rather than adding a peak.
        // Blend after the generic fissures so they cannot erase the bridge;
        // the negative off-band floor preserves the surrounding depressions.
        const along = (x - y) / Math.SQRT2, across = (x + y) / Math.SQRT2;
        const band = gauss(0, across, 1, 0.1);
        const oblique = (0.24 + 1.1 * Math.abs(along)) * gauss(along, 0, 0.5) * band - 0.6 * (1 - band);
        // Compact smooth maximum: soften the join's spurious small pits while
        // leaving distant cusp tips and depressions exactly unchanged.
        const blend = Math.max(0, 1 - Math.abs(surface - oblique) / 0.2);
        return Math.max(surface, oblique) + 0.05 * blend * blend;
      }
      return surface;
    }
    if (toothClass === 'premolar') {
      const lingualHeight = arch === 'upper' ? 0.88 : digit === 4 ? 0.45 : 0.75;
      const h = Math.max(gauss(x, y - 0.45, 0.42, 0.3), lingualHeight * gauss(x, y + 0.45, 0.42, 0.3));
      const marginal = 0.42 * Math.max(gauss(x - 0.78, y, 0.09, 0.5), gauss(x + 0.78, y, 0.09, 0.5));
      return Math.max(h, marginal) - 0.35 * gauss(0, y, 1, 0.08) - 0.18 * gauss(x, y, 0.22);
    }
    if (toothClass === 'canine') {
      const cusp = gauss(x - 0.05, y - 0.15, 0.3, 0.35);
      const ridges = 0.75 * Math.max(gauss(x - 0.45, y - 0.12, 0.35, 0.12), gauss(x + 0.45, y - 0.12, 0.35, 0.12)) * (1 - Math.abs(x) * 0.6);
      return Math.max(cusp, ridges) - 0.3 * gauss(x, y + 0.45, 0.4, 0.25);
    }
    // Incisor: incisal edge along x near the labial side, shovel-shaped lingual fossa, cingulum.
    const edge = gauss(0, y - 0.35, 1, 0.16) * (1 - 0.15 * x * x);
    const marginal = 0.55 * Math.max(gauss(x - 0.8, y + 0.1, 0.1, 0.45), gauss(x + 0.8, y + 0.1, 0.1, 0.45));
    const cingulum = 0.25 * gauss(x, y + 0.75, 0.3, 0.15);
    return Math.max(edge, marginal, cingulum) - 0.12 * gauss(x, y + 0.2, 0.4, 0.25);
  };
  const tableHeight = toothClass === 'incisor' ? 0.22 : toothClass === 'canine' ? 0.28 : 0.24;
  let apex = 0;
  for (let i = 0; i < CROWN_RINGS; i++) {
    const rho = 1 - (i + 1) / (CROWN_RINGS + 1);
    for (let a = 0; a < CROWN_THETA; a++) {
      const theta = a / CROWN_THETA * TAU, r = shape.rim[a] * rho;
      const x = r * Math.cos(theta), y = r * Math.sin(theta);
      const dome = 1 - rho * rho;
      shape.occlusal[i * CROWN_THETA + a] = shape.rimZ[a] + tableHeight * (0.35 * dome + relief(x, y) * (0.4 + 0.6 * Math.min(1, (1 - rho) * 4)));
    }
  }
  apex = shape.rimZ.reduce((sum, value) => sum + value, 0) / CROWN_THETA + tableHeight * (0.35 + relief(0, 0));
  shape.apex = apex;
  // Normalize so the highest point is z = 1.
  let top = apex;
  for (const value of shape.occlusal) top = Math.max(top, value);
  for (let i = 0; i < shape.occlusal.length; i++) shape.occlusal[i] /= top;
  for (let a = 0; a < CROWN_THETA; a++) shape.rimZ[a] /= top;
  shape.apex /= top;
  return shape;
}

export interface DonorFrame { origin: Vec3; mesial: Vec3; buccal: Vec3; occlusal: Vec3 }

/**
 * Resample a scanned crown (triangle soup subset of its source) into the crown topology.
 * Interproximal surfaces hidden by contacts and cervical areas below the cut are
 * interpolated; the recorded provenance states this.
 */
export function donorShape(positions: Float32Array, faces: ArrayLike<number>, frame: DonorFrame, info: { arch: 'upper' | 'lower'; digit: number; donorFdi: number | null; donorPartId: string; donorToothId: number; mirrored: boolean }): CrownShape {
  if (!(positions instanceof Float32Array) || positions.length % 9 || !positions.every(Number.isFinite)) throw new Error('Donor source must be finite triangle-soup positions.');
  if (faces.length < 60 || faces.length > 120_000) throw new Error('The donor crown needs 60–120000 selected source faces.');
  validateFrame(frame, 'Donor');
  const selected = new Set<number>();
  for (let i = 0; i < faces.length; i++) {
    const face = faces[i];
    if (!Number.isSafeInteger(face) || face < 0 || face >= positions.length / 9 || selected.has(face)) throw new Error('Donor source face indices must be valid and unique.');
    selected.add(face);
  }
  if (!['upper', 'lower'].includes(info.arch) || !Number.isInteger(info.digit) || info.digit < 1 || info.digit > 8) throw new Error('Donor tooth arch and digit are required.');
  if (info.donorFdi !== null && (!/^[1-4][1-8]$/.test(String(info.donorFdi)) || (info.donorFdi < 30 ? 'upper' : 'lower') !== info.arch || toothClassOf(info.donorFdi) !== toothClassOf(info.digit))) throw new Error('Donor FDI must have the requested anatomical class and arch.');
  const toLocal = (o: number): V => {
    const d = [positions[o] - frame.origin[0], positions[o + 1] - frame.origin[1], positions[o + 2] - frame.origin[2]];
    return [d[0] * frame.mesial[0] + d[1] * frame.mesial[1] + d[2] * frame.mesial[2], d[0] * frame.buccal[0] + d[1] * frame.buccal[1] + d[2] * frame.buccal[2], d[0] * frame.occlusal[0] + d[1] * frame.occlusal[1] + d[2] * frame.occlusal[2]];
  };
  const triangles: [V, V, V][] = [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let k = 0; k < faces.length; k++) {
    const f = faces[k];
    const tri: [V, V, V] = [toLocal(f * 9), toLocal(f * 9 + 3), toLocal(f * 9 + 6)];
    triangles.push(tri);
    for (const p of tri) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2]); }
  }
  const W = maxX - minX, D = maxY - minY, H = maxZ - Math.max(0, minZ);
  if (![W, D, H].every(value => Number.isFinite(value) && value > 0)) throw new Error('The donor crown has no usable extent.');
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, base = Math.max(0, minZ);
  const shape = emptyShape(info.arch, info.digit, {
    kind: 'patient-donor', donorFdi: info.donorFdi, donorPartId: info.donorPartId, donorToothId: info.donorToothId, mirrored: info.mirrored, faceCount: faces.length,
    selection: { faces: [...selected].sort((a, b) => a - b), frame: {
      origin: [...frame.origin], mesial: [...frame.mesial], buccal: [...frame.buccal], occlusal: [...frame.occlusal],
    } },
    provenance: `Patient ${info.mirrored ? 'contralateral (reflected)' : 'same-side'} donor crown${info.donorFdi ? ` FDI ${info.donorFdi}` : ''}, resampled from ${faces.length.toLocaleString('en-US')} scanned faces into the editable crown topology. Hidden interproximal and cervical areas are interpolated.`,
  }, [W, D, H]);
  const norm = (p: V): V => [(p[0] - cx) / (W / 2), (p[1] - cy) / (D / 2), (p[2] - base) / H];
  // Canonical corners keep barycentric arithmetic independent of face winding
  // and starting corner; max-height reductions are independent of face order.
  const normalized = triangles.map(tri => tri.map(norm).sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]));
  // Occlusal height field: rasterize donor triangles (max height) on a local grid.
  const G = 120, grid = new Float64Array(G * G).fill(-Infinity);
  const cellOf = (x: number) => (x + 1.15) / 2.3 * G;
  for (const [a, b, c] of normalized) {
    const i0 = Math.max(0, Math.floor(Math.min(cellOf(a[0]), cellOf(b[0]), cellOf(c[0])))), i1 = Math.min(G - 1, Math.ceil(Math.max(cellOf(a[0]), cellOf(b[0]), cellOf(c[0]))));
    const j0 = Math.max(0, Math.floor(Math.min(cellOf(a[1]), cellOf(b[1]), cellOf(c[1])))), j1 = Math.min(G - 1, Math.ceil(Math.max(cellOf(a[1]), cellOf(b[1]), cellOf(c[1]))));
    const det = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = (i + 0.5) / G * 2.3 - 1.15, y = (j + 0.5) / G * 2.3 - 1.15;
      let z: number;
      if (Math.abs(det) > 1e-14) {
        const u = ((x - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (y - a[1])) / det, v = ((b[0] - a[0]) * (y - a[1]) - (x - a[0]) * (b[1] - a[1])) / det;
        if (u < -1e-6 || v < -1e-6 || u + v > 1 + 1e-6) continue;
        z = a[2] + u * (b[2] - a[2]) + v * (c[2] - a[2]);
      } else continue;
      if (z > grid[j * G + i]) grid[j * G + i] = z;
    }
  }
  const heightAt = (x: number, y: number): number => {
    const fi = cellOf(x) - 0.5, fj = cellOf(y) - 0.5;
    const i = Math.floor(fi), j = Math.floor(fj);
    let sum = 0, weight = 0;
    for (const [di, dj] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= G || jj >= G) continue;
      const value = grid[jj * G + ii];
      if (!Number.isFinite(value)) continue;
      const w = (1 - Math.abs(fi - ii)) * (1 - Math.abs(fj - jj));
      sum += w * value; weight += w;
    }
    return weight > 0 ? sum / weight : NaN;
  };
  // Intersect the actual projected surface with each radial half-plane. The
  // rim is the highest surface point on the outer contour, including vertical
  // contour ties. A 1e-6 normalized radius band absorbs source Float32 noise;
  // selecting against the final maximum avoids order-dependent tolerance ties.
  const radial = new Float64Array(CROWN_THETA).fill(NaN), rimZ = new Float64Array(CROWN_THETA).fill(NaN);
  const levels = CROWN_WALL;
  const wallMax = new Float64Array(levels * CROWN_THETA).fill(NaN);
  // Consume a triangle's radial-plane section immediately. Do not retain all
  // angles' sections: a highly tessellated cap can produce millions of them.
  const section = (tri: V[], dx: number, dy: number): [number, number][] => {
    const hits: [number, number][] = [];
    const record = (p: V) => { hits.push([p[0] * dx + p[1] * dy, p[2]]); };
    for (let edge = 0; edge < 3; edge++) {
      const a = tri[edge], b = tri[(edge + 1) % 3];
      const sa = a[0] * dy - a[1] * dx, sb = b[0] * dy - b[1] * dx;
      if (Math.abs(sa) <= 1e-12) record(a);
      if (Math.abs(sb) <= 1e-12) record(b);
      if (sa * sb < 0) {
        const t = sa / (sa - sb);
        record([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
      }
    }
    return hits;
  };
  for (let angle = 0; angle < CROWN_THETA; angle++) {
    const theta = angle / CROWN_THETA * TAU, dx = Math.cos(theta), dy = Math.sin(theta);
    const samples: [number, number][] = [];
    for (const tri of normalized) {
      for (const hit of section(tri, dx, dy)) if (hit[0] > 0 && hit[1] >= 0) samples.push(hit);
    }
    let radius = -Infinity, height = -Infinity;
    for (const [r] of samples) radius = Math.max(radius, r);
    for (const [r, z] of samples) if (r >= radius - 1e-6) height = Math.max(height, z);
    if (radius > 0 && height > 0) { radial[angle] = radius; rimZ[angle] = height; }
  }
  if (!fillCircular(radial) || !fillCircular(rimZ)) throw new Error('The donor outline could not be resampled.');
  smoothCircular(radial, 2); smoothCircular(rimZ, 3);
  // Coordinates arrive as Float32. A rigid pose can put nominally coplanar
  // margin vertices on either side of a level. Bound projected rounding in
  // source units, then express it in normalized height; this is numerical
  // precision, not a clinical distance or a license to fill a scanned hole.
  let coordinateMagnitude = Math.max(0, ...frame.origin.map(Math.abs));
  for (const face of selected) for (let k = 0; k < 9; k++) coordinateMagnitude = Math.max(coordinateMagnitude, Math.abs(positions[face * 9 + k]));
  const heightTolerance = Math.max(1e-10, 4 * 2 ** -23 * coordinateMagnitude / H);
  let measuredWall = 0;
  for (let a = 0; a < CROWN_THETA; a++) {
    const theta = a / CROWN_THETA * TAU, dx = Math.cos(theta), dy = Math.sin(theta);
    const highestWall = (levels - 2) / (levels - 1) * rimZ[a];
    for (const tri of normalized) {
      if (Math.min(tri[0][2], tri[1][2], tri[2][2]) > highestWall + heightTolerance || Math.max(tri[0][2], tri[1][2], tri[2][2]) < -heightTolerance) continue;
      const hits = section(tri, dx, dy);
      for (let i = 0; i < hits.length; i++) for (let k = i + 1; k < hits.length; k++) {
        const [r0, z0] = hits[i], [r1, z1] = hits[k];
        if (Math.max(r0, r1) <= 1e-6) continue;
        for (let j = 0; j < levels - 1; j++) {
          const height = j / (levels - 1) * rimZ[a];
          if (height < Math.min(z0, z1) - heightTolerance || height > Math.max(z0, z1) + heightTolerance) continue;
          const radius = Math.abs(z1 - z0) < 1e-12 ? Math.max(r0, r1) : r0 + (r1 - r0) * clamp((height - z0) / (z1 - z0));
          const index = j * CROWN_THETA + a;
          // A collapsed basal point cannot serve as a positive margin ring.
          if (radius > 1e-6 && !(wallMax[index] >= radius)) wallMax[index] = radius;
        }
      }
    }
    for (let j = 0; j < levels - 1; j++) if (Number.isFinite(wallMax[j * CROWN_THETA + a])) measuredWall++;
  }
  // Fill angular holes from observations at the same height fraction first.
  // Entirely unobserved rows remain NaN for the axial fallback below.
  for (let j = 0; j < levels - 1; j++) fillCircular(wallMax.subarray(j * CROWN_THETA, (j + 1) * CROWN_THETA));
  for (let a = 0; a < CROWN_THETA; a++) {
    shape.rim[a] = Math.max(0.2, radial[a]);
    shape.rimZ[a] = rimZ[a];
    // Preserve every measured radius. Only unseen/collapsed levels receive the
    // explicit cervical-envelope fallback; no smoothing of observed walls.
    const column = Float64Array.from({ length: levels }, (_, j) => wallMax[j * CROWN_THETA + a]);
    column[levels - 1] = shape.rim[a];
    for (let j = levels - 2; j >= 0; j--) {
      const f = j / (levels - 1), constricted = shape.rim[a] * (0.8 + 0.2 * Math.sin(Math.PI / 2 * Math.min(1, f / 0.35)));
      if (!Number.isFinite(column[j])) {
        // Continue the nearest observed profile toward a missing basal row.
        // Do not replace a narrow cervical contour with a fixed fraction of
        // the widest rim. A positive radius is still an artificial closure.
        column[j] = j + 2 < levels && Number.isFinite(column[j + 2])
          ? clamp(2 * column[j + 1] - column[j + 2], column[j + 1] * 0.25, column[j + 1] * 1.08)
          : Math.min(constricted, column[j + 1]);
      }
    }
    for (let j = 0; j < levels; j++) shape.wall[j * CROWN_THETA + a] = column[j];
  }
  const wallTotal = (levels - 1) * CROWN_THETA;
  shape.source.provenance += ` Wall coverage: ${measuredWall}/${wallTotal} radial samples measured by triangle intersections below the smoothed rim; ${wallTotal - measuredWall} wall heights interpolated angularly or continued axially with a cervical-envelope hypothesis. Radial outer-envelope sampling cannot preserve overhangs or an intaglio.`;
  for (let a = 0; a < CROWN_THETA; a++) shape.rim[a] = shape.wall[(levels - 1) * CROWN_THETA + a];
  // Require measured coverage before completing small holes. Sidewalls (even
  // with a basal cap) cannot supply evidence for a patient occlusal surface.
  const sampledRings: Float64Array[] = [];
  let measured = 0;
  for (let i = 0; i < CROWN_RINGS; i++) {
    const rho = 1 - (i + 1) / (CROWN_RINGS + 1);
    const ring = new Float64Array(CROWN_THETA);
    for (let a = 0; a < CROWN_THETA; a++) {
      const theta = a / CROWN_THETA * TAU, r = shape.rim[a] * rho;
      const height = heightAt(r * Math.cos(theta), r * Math.sin(theta));
      ring[a] = height > 0 ? height : NaN;
    }
    const count = ring.reduce((sum, value) => sum + Number(Number.isFinite(value)), 0);
    if (count < CROWN_THETA * 0.5) throw new Error('The donor has insufficient measured occlusal coverage (at least half of every polar ring is required).');
    measured += count;
    sampledRings.push(ring);
  }
  const total = CROWN_RINGS * CROWN_THETA;
  if (measured < total * 0.8) throw new Error('The donor has insufficient measured occlusal coverage (at least 80% of polar samples is required).');
  sampledRings.forEach((ring, i) => { fillCircular(ring); shape.occlusal.set(ring, i * CROWN_THETA); });
  const center = heightAt(0, 0);
  shape.apex = center > 0 && Number.isFinite(center) ? center : sampledRings[CROWN_RINGS - 1].reduce((sum, value) => sum + value, 0) / CROWN_THETA;
  shape.source.provenance += ` Occlusal coverage: ${measured}/${total} polar heights measured from the rasterized surface; ${total - measured} missing heights and ${center > 0 && Number.isFinite(center) ? 0 : 1} centre height interpolated. Basal closure is artificial; clinical fit is unvalidated.`;
  let top = shape.apex;
  for (const value of shape.rimZ) top = Math.max(top, value);
  for (const value of shape.occlusal) top = Math.max(top, value);
  if (top > 0 && top !== 1) {
    for (let i = 0; i < shape.occlusal.length; i++) shape.occlusal[i] /= top;
    for (let a = 0; a < CROWN_THETA; a++) shape.rimZ[a] /= top;
    shape.apex /= top;
    shape.dims = [W, D, H * top];
  }
  validateCrownShape(shape);
  return shape;
}

/** Validate transferred/persisted anatomy without coercing malformed arrays or axes. */
export function validateCrownShape(shape: CrownShape): void {
  if (!shape || shape.version !== 1 || !['upper', 'lower'].includes(shape.arch) || !Number.isInteger(shape.digit) || shape.digit < 1 || shape.digit > 8 || shape.toothClass !== toothClassOf(shape.digit)) throw new Error('Invalid crown anatomy version, arch or class.');
  if (!Array.isArray(shape.dims) || shape.dims.length !== 3 || !shape.dims.every(value => Number.isFinite(value) && value > 0)) throw new Error('Crown source dimensions must be positive and finite.');
  for (const [array, size] of [[shape.rim, CROWN_THETA], [shape.rimZ, CROWN_THETA], [shape.wall, CROWN_WALL * CROWN_THETA], [shape.occlusal, CROWN_RINGS * CROWN_THETA]] satisfies [Float32Array, number][]) {
    if (!(array instanceof Float32Array) || array.length !== size || !array.every(value => Number.isFinite(value) && value > 0)) throw new Error('Crown anatomy arrays must match the finite positive topology.');
  }
  if (!Number.isFinite(shape.apex) || shape.apex <= 0) throw new Error('Crown central height must be finite and positive.');
  const source = shape.source;
  if (!source || !['patient-donor', 'procedural-template'].includes(source.kind) || typeof source.provenance !== 'string' || !source.provenance.trim() || !Number.isSafeInteger(source.faceCount) || source.faceCount < 0 || typeof source.mirrored !== 'boolean') throw new Error('Crown source provenance is required.');
  if (source.kind === 'patient-donor' && (typeof source.donorPartId !== 'string' || !source.donorPartId.trim() || !Number.isSafeInteger(source.donorToothId) || source.faceCount < 60)) throw new Error('A patient donor needs source part, tooth identity and selected face count.');
  if (source.selection) {
    if (source.kind !== 'patient-donor' || !Array.isArray(source.selection.faces) || source.selection.faces.length !== source.faceCount || source.selection.faces.length > 120_000 || source.selection.faces.some((face, i, all) => !Number.isSafeInteger(face) || face < 0 || (i > 0 && face <= all[i - 1]))) throw new Error('A donor selection requires sorted unique original face indices matching its face count.');
    validateFrame(source.selection.frame, 'Donor selection');
  }
}

/**
 * Build the closed local crown mesh for target dimensions (file units). Vertex
 * order: margin ring (level 0) … rim ring, occlusal rings toward the centre,
 * occlusal apex, base centre. Faces wind outward in a right-handed local frame.
 */
export function buildCrownMesh(shape: CrownShape, dims: Vec3, deformation?: CrownDeformation): CrownMesh {
  validateCrownShape(shape);
  const [W, D, H] = dims;
  if (![W, D, H].every(value => Number.isFinite(value) && value > 0)) throw new Error('Crown dimensions must be positive file-unit values.');
  const T = CROWN_THETA, rings = CROWN_WALL + CROWN_RINGS;
  const count = rings * T + 2;
  const vertices = new Float32Array(count * 3);
  const set = (index: number, x: number, y: number, z: number) => { vertices[index * 3] = x; vertices[index * 3 + 1] = y; vertices[index * 3 + 2] = z; };
  const zones: CrownMesh['zones'] = { margin: [], wall: [], occlusal: [], mesial: [], distal: [] };
  for (let j = 0; j < CROWN_WALL; j++) for (let a = 0; a < T; a++) {
    const theta = a / T * TAU, r = shape.wall[j * T + a], f = j / (CROWN_WALL - 1);
    const index = j * T + a;
    set(index, r * Math.cos(theta) * W / 2, r * Math.sin(theta) * D / 2, f * shape.rimZ[a] * H);
    (j === 0 ? zones.margin : zones.wall).push(index);
    if (Math.cos(theta) > 0.6) zones.mesial.push(index); else if (Math.cos(theta) < -0.6) zones.distal.push(index);
  }
  for (let i = 0; i < CROWN_RINGS; i++) for (let a = 0; a < T; a++) {
    const rho = 1 - (i + 1) / (CROWN_RINGS + 1);
    const theta = a / T * TAU, r = shape.rim[a] * rho;
    const index = (CROWN_WALL + i) * T + a;
    // Ring 0 of the occlusal table starts just inside the rim.
    set(index, r * Math.cos(theta) * W / 2, r * Math.sin(theta) * D / 2, shape.occlusal[i * T + a] * H);
    zones.occlusal.push(index);
    if (Math.cos(theta) > 0.75 && rho > 0.7) zones.mesial.push(index); else if (Math.cos(theta) < -0.75 && rho > 0.7) zones.distal.push(index);
  }
  const apex = rings * T, base = apex + 1;
  set(apex, 0, 0, shape.apex * H);
  zones.occlusal.push(apex);
  set(base, 0, 0, 0);
  if (deformation?.offsets) {
    if (deformation.offsets.length !== count * 3) throw new Error('Crown deformation does not match the crown topology.');
    if (!deformation.offsets.every(Number.isFinite)) throw new Error('Crown deformation must be finite.');
    for (let i = 0; i < count * 3; i++) vertices[i] += deformation.offsets[i];
  }
  const indices: number[] = [];
  for (let ring = 0; ring < rings - 1; ring++) for (let a = 0; a < T; a++) {
    const b = (a + 1) % T, p = ring * T + a, q = ring * T + b, r = (ring + 1) * T + a, s = (ring + 1) * T + b;
    indices.push(p, q, r, q, s, r);
  }
  for (let a = 0; a < T; a++) {
    const b = (a + 1) % T;
    indices.push((rings - 1) * T + a, (rings - 1) * T + b, apex);
    indices.push(b, a, base);
  }
  return { vertices, indices: Uint32Array.from(indices), zones, vertexCount: count };
}

/** Local anatomical mesh → triangle soup in source coordinates. Flips winding for left-handed frames. */
export function placeCrown(mesh: CrownMesh, frame: { origin: Vec3; mesial: Vec3; buccal: Vec3; occlusal: Vec3 }): { positions: Float32Array; normals: Float32Array; mirrored: boolean } {
  validateFrame(frame, 'Target');
  const localAudit = auditCrownMesh(mesh);
  if (!localAudit.closed) throw new Error('Crown placement requires one closed, outward-oriented, nondegenerate manifold.');
  const { mesial: x, buccal: y, occlusal: z, origin: o } = frame;
  const mirrored = dot(cross(x, y), z) < 0;
  const pointAt = (vertices: Float32Array, id: number): V => [vertices[id * 3], vertices[id * 3 + 1], vertices[id * 3 + 2]];
  let minimumEdge = Infinity;
  for (let i = 0; i < mesh.indices.length; i += 3) for (let c = 0; c < 3; c++) {
    const a = pointAt(mesh.vertices, mesh.indices[i + c]), b = pointAt(mesh.vertices, mesh.indices[i + (c + 1) % 3]);
    minimumEdge = Math.min(minimumEdge, Math.hypot(...subtract(a, b)));
  }
  // Round shared vertices once, then validate the coordinates actually exported.
  // A 2% smallest-edge rounding bound also catches partial folding before an
  // entire edge collapses. This is a numerical guard, not a fit tolerance.
  const world = new Float32Array(mesh.vertexCount * 3), keys = new Set<string>();
  for (let v = 0; v < mesh.vertexCount; v++) {
    const lx = mesh.vertices[v * 3], ly = mesh.vertices[v * 3 + 1], lz = mesh.vertices[v * 3 + 2];
    for (let k = 0; k < 3; k++) {
      const exact = o[k] + lx * x[k] + ly * y[k] + lz * z[k], rounded = Math.fround(exact);
      if (!Number.isFinite(rounded) || !Number.isFinite(exact) || Math.abs(rounded - exact) > minimumEdge * 0.02) throw new Error('Crown Float32 precision is insufficient at the requested target origin.');
      world[v * 3 + k] = rounded;
    }
    const key = pointAt(world, v).join(',');
    if (keys.has(key)) throw new Error('Crown vertices collapse at the requested Float32 target precision.');
    keys.add(key);
  }
  const indices = mesh.indices.slice();
  if (mirrored) for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
  if (!auditCrownMesh({ ...mesh, vertices: world, indices }).closed) throw new Error('Crown degenerates or loses outward orientation after Float32 placement.');
  const triangles = mesh.indices.length / 3;
  const positions = new Float32Array(triangles * 9), normals = new Float32Array(triangles * 9);
  for (let t = 0; t < triangles; t++) {
    const ids = [indices[t * 3], indices[t * 3 + 1], indices[t * 3 + 2]];
    const p = ids.map(id => pointAt(world, id));
    const n = cross(subtract(p[1], p[0]), subtract(p[2], p[0])), l = Math.hypot(...n);
    const local = [0, 1, 2].map(c => pointAt(mesh.vertices, mesh.indices[t * 3 + c]));
    const ln = cross(subtract(local[1], local[0]), subtract(local[2], local[0]));
    const expectedAt = (k: number) => x[k] * ln[0] + y[k] * ln[1] + z[k] * ln[2];
    const expected: V = [expectedAt(0), expectedAt(1), expectedAt(2)];
    if (!(dot(n, expected) > 0)) throw new Error('Crown face folds after Float32 placement.');
    for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) { positions[t * 9 + c * 3 + k] = p[c][k]; normals[t * 9 + c * 3 + k] = n[k] / l; }
  }
  return { positions, normals, mirrored };
}

/** Single-shell topology/orientation audit. Self-intersection is NOT tested. */
export function auditCrownMesh(mesh: CrownMesh): { closed: boolean; volume: number; degenerate: number; boundaryEdges: number; nonManifoldEdges: number; orientationErrors: number; consistentlyOriented: boolean; nonManifoldVertices: number; vertexManifold: boolean; components: number; selfIntersection: 'untested' } {
  validateMesh(mesh);
  const edges = new Map<string, { count: number; balance: number; face: number }>();
  const links = Array.from({ length: mesh.vertexCount }, () => new Map<number, number[]>());
  const parents = Array.from({ length: mesh.indices.length / 3 }, (_, i) => i);
  const root = (face: number): number => { while (parents[face] !== face) { parents[face] = parents[parents[face]]; face = parents[face]; } return face; };
  let degenerate = 0, volume = 0;
  const v = mesh.vertices;
  const reference: V = [v[0], v[1], v[2]];
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [a, b, c] = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]];
    const pa: V = [v[a * 3], v[a * 3 + 1], v[a * 3 + 2]], pb: V = [v[b * 3], v[b * 3 + 1], v[b * 3 + 2]], pc: V = [v[c * 3], v[c * 3 + 1], v[c * 3 + 2]];
    const e1 = subtract(pb, pa), e2 = subtract(pc, pa), n = cross(e1, e2);
    if (!(Math.hypot(...n) > Math.hypot(...e1) * Math.hypot(...e2) * 1e-12)) degenerate++;
    volume += dot(subtract(pa, reference), cross(subtract(pb, reference), subtract(pc, reference))) / 6;
    for (const [p, q, opposite] of [[a, b, c], [b, c, a], [c, a, b]]) {
      const key = p < q ? `${p},${q}` : `${q},${p}`;
      const edge = edges.get(key) ?? { count: 0, balance: 0, face: t / 3 };
      edge.count++; edge.balance += p < q ? 1 : -1;
      parents[root(t / 3)] = root(edge.face);
      edges.set(key, edge);
      const link = links[p];
      link.set(q, [...(link.get(q) ?? []), opposite]); link.set(opposite, [...(link.get(opposite) ?? []), q]);
    }
  }
  let boundaryEdges = 0, nonManifoldEdges = 0, orientationErrors = 0, nonManifoldVertices = 0;
  for (const edge of edges.values()) {
    if (edge.count === 1) boundaryEdges++; else if (edge.count > 2) nonManifoldEdges++;
    if (edge.count === 2 && edge.balance !== 0) orientationErrors++;
  }
  for (const link of links) {
    const visited = new Set<number>(), stack = [...link.keys()].slice(0, 1);
    while (stack.length) { const vertex = stack.pop()!; if (visited.has(vertex)) continue; visited.add(vertex); stack.push(...(link.get(vertex) ?? []).filter(id => !visited.has(id))); }
    const degrees = [...link.values()].map(neighbours => neighbours.length), ends = degrees.filter(degree => degree === 1).length;
    // A surface vertex has a single cyclic link (interior), or a single path
    // (boundary). Two closed shells touching at a vertex have two link cycles.
    if (link.size < 2 || visited.size !== link.size || degrees.some(degree => degree !== 1 && degree !== 2) || (ends !== 0 && ends !== 2) || (ends === 0 && link.size < 3)) nonManifoldVertices++;
  }
  const components = new Set(parents.map((_, face) => root(face))).size;
  const consistentlyOriented = orientationErrors === 0 && nonManifoldEdges === 0, vertexManifold = nonManifoldVertices === 0;
  return { closed: boundaryEdges === 0 && nonManifoldEdges === 0 && consistentlyOriented && vertexManifold && components === 1 && degenerate === 0 && Number.isFinite(volume) && volume > 0,
    volume, degenerate, boundaryEdges, nonManifoldEdges, orientationErrors, consistentlyOriented, nonManifoldVertices, vertexManifold, components, selfIntersection: 'untested' };
}

/** Detached copy for editing; this operation does not reflect anatomy. */
export function cloneShape(shape: CrownShape): CrownShape {
  const selection = shape.source.selection;
  return { ...shape, source: { ...shape.source, ...(selection ? { selection: { faces: [...selection.faces], frame: {
    origin: [...selection.frame.origin], mesial: [...selection.frame.mesial], buccal: [...selection.frame.buccal], occlusal: [...selection.frame.occlusal],
  } } } : {}) }, dims: [shape.dims[0], shape.dims[1], shape.dims[2]], rim: shape.rim.slice(), rimZ: shape.rimZ.slice(), wall: shape.wall.slice(), occlusal: shape.occlusal.slice() };
}
