import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { edgeTable, triTable } from 'three/examples/jsm/objects/MarchingCubes.js';
import { detectToothRegions } from './auto-tooth-geometry.ts';
import { createNearestSurfaceQuery, type NearestSurfaceQuery } from './collision.ts';
import type { TomographyVolume, Vec3 } from './tomography-types.ts';

export interface CbctAutoAlignmentInput {
  volume: TomographyVolume;
  /** Nonindexed triangles in the current shared workspace, including their current poses. */
  sources: { id: string; positions: Float64Array }[];
  /** Explicit, confirmed millimetres per file unit; never estimated by this fit. */
  mmPerUnit: number;
}

export interface CbctAutoAlignmentResult {
  /** Column-major world rigid DELTA in workspace units. Apply once to ALL optical/bite sources. */
  matrix: number[];
  /** Unsigned distance RMS to the sampled target over ALL area-sampled optical points, in mm. */
  rmsMm: number;
  /** Unsigned distance median to the sampled target over ALL optical samples, in mm. */
  medianMm: number;
  /** Fraction of area-sampled optical points within 1 mm with compatible surface directions. */
  coverage: number;
  samples: number;
  /** Registration-only intensity isolevel, in rescaled intensity units (not a distance). */
  threshold: number;
  durationMs: number;
  /** Shape-selected crown support is separate from the honest full optical pool metrics above. */
  registrationSupport?: {
    method: 'heuristic-crown-regions' | 'full-optical-surface';
    samples: number;
    coverage: number;
    inlierRmsMm: number;
    medianMm: number;
    perSource: { id: string; samples: number; coverage: number; regions: number; supportedRegions: number }[];
  };
  /** Registration approximation only; the original voxels/display reconstruction are untouched. */
  registrationTarget?: {
    method: 'spatially-sampled-native-isosurface';
    /** Original voxel sampling, along the volume's three direction axes. No voxel decimation. */
    voxelSpacingMm: Vec3;
    /** One representative native isosurface triangle per occupied cell of this size. */
    samplingCellMm: number;
    samples: number;
    /** Native triangles visited, without ever allocating their complete mesh. */
    nativeTriangles: number;
  };
}

type Sample = { point: Vector3; normal: Vector3; sourceIndex: number; regionIndex?: number };
type Shape = { center: Vector3; axes: Vector3[]; values: number[] };
type Match = { p: Vector3; q: Vector3; normal: Vector3; distance: number; sourceIndex: number; regionIndex?: number };
type Fit = { matrix: Matrix4; rmsMm: number; medianMm: number; coverage: number; score: number };
const MAX_MS = 18_000;
const MIN_SAMPLES = 100;
const SUPPORT_MM = 1;
const NORMAL_DOT = .25;
const MAX_TARGET_SAMPLES = 48_000;
const TARGET_CELL_MM = .125;
const MAX_TARGET_CELL_MM = 1;
const CORNERS = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
const EDGES = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];

/** Small symmetric Jacobi eigensolver; columns are orthonormal eigenvectors. */
function eigen(input: number[], size: number) {
  const a = input.slice(), vectors = Array<number>(size * size).fill(0);
  for (let i = 0; i < size; i++) vectors[i * size + i] = 1;
  for (let iteration = 0; iteration < 80; iteration++) {
    let p = 0, q = 1, largest = 0;
    for (let i = 0; i < size; i++) for (let j = i + 1; j < size; j++) {
      if (Math.abs(a[i * size + j]) > largest) { largest = Math.abs(a[i * size + j]); p = i; q = j; }
    }
    if (largest < Math.max(...a.map(Math.abs), 1e-30) * 1e-13) break;
    const angle = .5 * Math.atan2(2 * a[p * size + q], a[q * size + q] - a[p * size + p]);
    const c = Math.cos(angle), s = Math.sin(angle);
    const app = a[p * size + p], aqq = a[q * size + q], apq = a[p * size + q];
    for (let k = 0; k < size; k++) if (k !== p && k !== q) {
      const x = a[k * size + p], y = a[k * size + q];
      a[k * size + p] = a[p * size + k] = c * x - s * y;
      a[k * size + q] = a[q * size + k] = s * x + c * y;
    }
    a[p * size + p] = c * c * app - 2 * c * s * apq + s * s * aqq;
    a[q * size + q] = s * s * app + 2 * c * s * apq + c * c * aqq;
    a[p * size + q] = a[q * size + p] = 0;
    for (let k = 0; k < size; k++) {
      const x = vectors[k * size + p], y = vectors[k * size + q];
      vectors[k * size + p] = c * x - s * y;
      vectors[k * size + q] = s * x + c * y;
    }
  }
  return Array.from({ length: size }, (_, i) => ({
    value: a[i * size + i], vector: Array.from({ length: size }, (_, k) => vectors[k * size + i]),
  })).sort((a, b) => b.value - a.value);
}

function shape(points: Vector3[]): Shape {
  const center = points.reduce((a, p) => a.add(p), new Vector3()).multiplyScalar(1 / points.length);
  const covariance = Array<number>(9).fill(0);
  for (const point of points) {
    const p = point.clone().sub(center).toArray();
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) covariance[i * 3 + j] += p[i] * p[j] / points.length;
  }
  const result = eigen(covariance, 3), axes = result.map(item => new Vector3(...item.vector as Vec3));
  // Always use right-handed frames. Candidate rotations never reflect or rescale.
  axes[2].crossVectors(axes[0], axes[1]).normalize();
  return { center, axes, values: result.map(item => Math.max(0, item.value)) };
}

function quantile(sorted: number[], fraction: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))];
}

function validateVolume(volume: TomographyVolume) {
  const d = volume.dimensions, count = d[0] * d[1] * d[2];
  if (d.length !== 3 || d.some(n => !Number.isSafeInteger(n) || n < 3 || n > 4096) || !Number.isSafeInteger(count)
    || count > 160_000_000 || !(volume.voxels instanceof Float32Array) || volume.voxels.length !== count) {
    throw new Error('Automatic alignment needs a bounded three-dimensional volume with matching voxel data.');
  }
  if (volume.spacing.length !== 3 || volume.spacing.some(n => !Number.isFinite(n) || n <= 0 || n > 2)
    || volume.origin.length !== 3 || !volume.origin.every(Number.isFinite)) {
    throw new Error('Automatic alignment needs finite patient coordinates and voxel spacing no greater than 2 mm.');
  }
  const axes = volume.directions;
  if (axes.length !== 3 || axes.some(a => a.length !== 3 || !a.every(Number.isFinite))) throw new Error('Invalid tomography direction axes.');
  for (let i = 0; i < 3; i++) for (let j = i; j < 3; j++) {
    const dot = axes[i].reduce((sum, n, k) => sum + n * axes[j][k], 0);
    if (Math.abs(dot - Number(i === j)) > 1e-6) throw new Error('Tomography direction axes must be orthonormal.');
  }
  if (volume.missingSlices.some(z => !Number.isInteger(z) || z < 0 || z >= d[2])) throw new Error('Missing tomography planes must have valid volume indices.');
}

/** Area-stratified deterministic triangle samples, rather than tessellation-weighted vertices. */
function sampleTriangles(parts: { positions: Float32Array | Float64Array; sourceIndex?: number; regionIndex?: number }[], scale: number, count: number, check: () => void): Sample[] {
  const totalTriangles = parts.reduce((n, p) => n + p.positions.length / 9, 0);
  if (!totalTriangles || !Number.isInteger(totalTriangles) || totalTriangles > 2_000_000) throw new Error('Optical alignment needs nonempty, bounded triangle surfaces.');
  const areas = new Float64Array(totalTriangles);
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), u = new Vector3(), v = new Vector3();
  let total = 0, triangle = 0;
  for (const part of parts) {
    if (!(part.positions instanceof Float32Array || part.positions instanceof Float64Array) || part.positions.length % 9) throw new Error('Optical positions must contain complete finite triangles.');
    const p = part.positions;
    for (let i = 0; i < p.length; i += 9) {
      if ((triangle & 4095) === 0) check();
      for (let j = 0; j < 9; j++) if (!Number.isFinite(p[i + j] * scale)) throw new Error('Optical triangle coordinates must be finite after explicit unit conversion.');
      a.fromArray(p, i).multiplyScalar(scale); b.fromArray(p, i + 3).multiplyScalar(scale); c.fromArray(p, i + 6).multiplyScalar(scale);
      const area = u.subVectors(b, a).cross(v.subVectors(c, a)).length() / 2;
      total += area; areas[triangle++] = total;
    }
  }
  if (!Number.isFinite(total) || total < 1) throw new Error('Optical alignment needs a nondegenerate surface with sufficient physical extent.');
  const samples: Sample[] = [];
  let partIndex = 0, offset = 0;
  triangle = 0;
  for (let i = 0; i < count; i++) {
    const area = (i + .5) / count * total;
    while (areas[triangle] < area) triangle++;
    while (triangle * 9 - offset >= parts[partIndex].positions.length) offset += parts[partIndex++].positions.length;
    const p = parts[partIndex].positions, start = triangle * 9 - offset;
    a.fromArray(p, start).multiplyScalar(scale); b.fromArray(p, start + 3).multiplyScalar(scale); c.fromArray(p, start + 6).multiplyScalar(scale);
    // Incommensurate low-discrepancy barycentric positions avoid repeated face centroids.
    const r = Math.sqrt(((i + 1) * .7548776662466927) % 1), s = ((i + 1) * .5698402909980532) % 1;
    const normal = u.subVectors(b, a).cross(v.subVectors(c, a)).normalize().clone();
    const point = a.clone().multiplyScalar(1 - r).addScaledVector(b, r * (1 - s)).addScaledVector(c, r * s);
    samples.push({ point, normal, sourceIndex: parts[partIndex].sourceIndex ?? partIndex, regionIndex: parts[partIndex].regionIndex });
  }
  return samples;
}

/** Propose crown regions independently of CBCT distances, so gingiva cannot vote itself into a bone fit. */
function crownSamples(sources: CbctAutoAlignmentInput['sources'], scale: number, origin: Vector3, check: () => void, started: number, fullSamples: Sample[]) {
  const parts: { positions: Float64Array; sourceIndex: number; regionIndex?: number }[] = [];
  let regionIndex = 0;
  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
    check();
    const positions = sources[sourceIndex].positions;
    if (positions.length / 9 > 1_000_000) throw new Error('Crown-supported automatic alignment needs sources with at most 1,000,000 triangles.');
    // The reused detector has its own cooperative 8-second budget. Reserve it
    // inside the ONE registration deadline, rather than restarting the clock.
    if (performance.now() - started > MAX_MS - 8_000) throw new Error('Automatic alignment exceeded its bounded search time while selecting crown support. Use matching landmarks.');
    const local = new Float32Array(positions.length), reference = new Vector3().fromArray(positions);
    for (let i = 0; i < positions.length; i++) {
      if ((i & 16383) === 0) check();
      // Subtract BEFORE Float32 conversion; detector precision must not depend
      // on the absolute DICOM/workspace origin. ICP still uses original doubles.
      local[i] = (positions[i] - reference.getComponent(i % 3)) * scale;
    }
    let detection: ReturnType<typeof detectToothRegions>;
    try { detection = detectToothRegions(local, { direction: 'auto', sensitivity: 1 }); }
    catch (error) {
      check();
      if (error instanceof Error && /8 second limit/.test(error.message)) throw new Error('Automatic alignment exceeded its bounded search time during crown selection. Use matching landmarks.');
      throw error;
    }
    check();
    const full = shape(fullSamples.filter(s => s.sourceIndex === sourceIndex).map(s => s.point));
    const up = full.axes[2].clone();
    if (detection.candidates.length) {
      const proposed = shape(detection.candidates.map(c => new Vector3(...c.centroid).addScaledVector(reference, scale).sub(origin)));
      // The occlusal envelope lies away from the scan's bulk tissue/palate.
      // Use its source-relative least-variance axis, so a detector's alternative
      // sidewall axis cannot suppress neighbouring teeth along the arch.
      if (up.dot(proposed.center.sub(full.center)) < 0) up.negate();
    }
    // A second dome directly below an occlusal proposal is often gingiva.
    // Keep the visible crown envelope, rather than letting stacked tissue caps
    // enlarge a partial-match denominator or pull the optical arch into bone.
    const candidates = detection.candidates.filter(a => detection.candidates.every(b => {
      if (a === b) return true;
      const delta = new Vector3(...b.centroid).sub(new Vector3(...a.centroid)), height = delta.dot(up);
      const planarSq = Math.max(0, delta.lengthSq() - height * height);
      return height <= 3 || planarSq >= Math.min(a.area, b.area) * .25;
    }));
    // A lone tissue dome or one locally convincing tooth cannot define a jaw.
    // Such sources retain the conservative full-surface support contract.
    const centers = candidates.map(c => new Vector3(...c.centroid));
    if (centers.length < 3 || shape(centers).values[1] < 4) {
      parts.push({ positions, sourceIndex });
      continue;
    }
    for (const candidate of candidates) {
      const selected = new Float64Array(candidate.faces.length * 9);
      for (let i = 0; i < candidate.faces.length; i++) {
        if ((i & 4095) === 0) check();
        selected.set(positions.subarray(candidate.faces[i] * 9, candidate.faces[i] * 9 + 9), i * 9);
      }
      parts.push({ positions: selected, sourceIndex, regionIndex: regionIndex++ });
    }
  }
  const samples = sampleTriangles(parts, scale, 2200, check);
  for (const sample of samples) sample.point.sub(origin);
  return { samples, method: regionIndex ? 'heuristic-crown-regions' as const : 'full-optical-surface' as const };
}

/**
 * Stream native marching cubes directly from the original ROI. Keep at most one
 * real triangle per spatial cell, coarsening only this registration sample pool
 * if necessary. There is no full mesh, copied/decimated voxel grid, filled gap,
 * or dependency on the display's threshold/stride/triangle capacity. Distances
 * to this subset can overestimate the complete isosurface distance.
 */
function sampledTarget(volume: TomographyVolume, bounds: [Vec3, Vec3], threshold: number, check: () => void) {
  const [lo, hi] = bounds, [nx, ny] = volume.dimensions, spacing = volume.spacing;
  const missing = new Set(volume.missingSlices), values = new Float64Array(8), vertices = new Float64Array(36);
  // Scanner-relative centroid followed by three scanner-relative corners.
  // All allocation is bounded, regardless of how many native faces are visited.
  const kept = new Float64Array(MAX_TARGET_SAMPLES * 12);
  let cells = new Map<number, number>(), cellMm = TARGET_CELL_MM, count = 0, nativeTriangles = 0, work = 0;
  const cellKey = (x: number, y: number, z: number) => {
    const width = Math.ceil((hi[0] - lo[0]) * spacing[0] / cellMm) + 1;
    const height = Math.ceil((hi[1] - lo[1]) * spacing[1] / cellMm) + 1;
    return Math.floor(x / cellMm) + width * (Math.floor(y / cellMm) + height * Math.floor(z / cellMm));
  };
  const cellDistance = (x: number, y: number, z: number) =>
    (x - (Math.floor(x / cellMm) + .5) * cellMm) ** 2
    + (y - (Math.floor(y / cellMm) + .5) * cellMm) ** 2
    + (z - (Math.floor(z / cellMm) + .5) * cellMm) ** 2;
  const coarsen = () => {
    check();
    cellMm *= 2;
    if (cellMm > MAX_TARGET_CELL_MM) throw new Error('The jaw target is too complex for sufficiently resolved bounded registration samples. Use matching landmarks.');
    cells = new Map();
    let next = 0;
    for (let i = 0; i < count; i++) {
      if ((i & 2047) === 0) check();
      const start = i * 12, x = kept[start], y = kept[start + 1], z = kept[start + 2], key = cellKey(x, y, z);
      const previous = cells.get(key);
      if (previous !== undefined && cellDistance(x, y, z) >= cellDistance(kept[previous * 12], kept[previous * 12 + 1], kept[previous * 12 + 2])) continue;
      const index = previous ?? next++;
      kept.copyWithin(index * 12, start, start + 12);
      cells.set(key, index);
    }
    count = next;
  };
  const retain = (i: number, j: number, k: number) => {
    const x = (vertices[i] + vertices[j] + vertices[k]) / 3;
    const y = (vertices[i + 1] + vertices[j + 1] + vertices[k + 1]) / 3;
    const z = (vertices[i + 2] + vertices[j + 2] + vertices[k + 2]) / 3;
    const ux = vertices[j] - vertices[i], uy = vertices[j + 1] - vertices[i + 1], uz = vertices[j + 2] - vertices[i + 2];
    const vx = vertices[k] - vertices[i], vy = vertices[k + 1] - vertices[i + 1], vz = vertices[k + 2] - vertices[i + 2];
    if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) === 0) return;
    nativeTriangles++;
    let key = cellKey(x, y, z), previous = cells.get(key);
    while (previous === undefined && count === MAX_TARGET_SAMPLES) {
      coarsen(); key = cellKey(x, y, z); previous = cells.get(key);
    }
    if (previous !== undefined && cellDistance(x, y, z) >= cellDistance(kept[previous * 12], kept[previous * 12 + 1], kept[previous * 12 + 2])) return;
    const index = previous ?? count++, start = index * 12;
    kept[start] = x; kept[start + 1] = y; kept[start + 2] = z;
    for (let corner = 0; corner < 3; corner++) for (let axis = 0; axis < 3; axis++) {
      kept[start + 3 + corner * 3 + axis] = vertices[[i, j, k][corner] + axis];
    }
    cells.set(key, index);
  };
  for (let z = lo[2]; z < hi[2]; z++) {
    check();
    if (missing.has(z) || missing.has(z + 1)) continue;
    for (let y = lo[1]; y < hi[1]; y++) for (let x = lo[0]; x < hi[0]; x++) {
      if ((work++ & 2047) === 0) check();
      let cube = 0, valid = true;
      for (let corner = 0; corner < 8; corner++) {
        const c = CORNERS[corner], value = volume.voxels[x + c[0] + nx * (y + c[1] + ny * (z + c[2]))];
        values[corner] = value;
        if (!Number.isFinite(value)) { valid = false; break; }
        if (value < threshold) cube |= 1 << corner;
      }
      if (!valid || edgeTable[cube] === 0) continue;
      for (let edge = 0; edge < 12; edge++) if (edgeTable[cube] & (1 << edge)) {
        const [i, j] = EDGES[edge], a = CORNERS[i], b = CORNERS[j];
        const t = (threshold - values[i]) / (values[j] - values[i]);
        vertices[edge * 3] = (x - lo[0] + a[0] + t * (b[0] - a[0])) * spacing[0];
        vertices[edge * 3 + 1] = (y - lo[1] + a[1] + t * (b[1] - a[1])) * spacing[1];
        vertices[edge * 3 + 2] = (z - lo[2] + a[2] + t * (b[2] - a[2])) * spacing[2];
      }
      for (let entry = cube * 16; triTable[entry] !== -1 && entry < cube * 16 + 15; entry += 3) {
        retain(triTable[entry] * 3, triTable[entry + 1] * 3, triTable[entry + 2] * 3);
      }
    }
  }
  if (count < 100) throw new Error('Insufficient dense surface geometry for automatic alignment.');
  // Patient-relative Float64 coordinates retain DICOM direction/origin precision.
  const positions = new Float64Array(count * 9);
  for (let i = 0; i < count; i++) {
    if ((i & 2047) === 0) check();
    for (let corner = 0; corner < 3; corner++) {
      const start = i * 12 + 3 + corner * 3;
      const x = kept[start] + lo[0] * spacing[0], y = kept[start + 1] + lo[1] * spacing[1], z = kept[start + 2] + lo[2] * spacing[2];
      for (let axis = 0; axis < 3; axis++) positions[i * 9 + corner * 3 + axis] =
        volume.directions[0][axis] * x + volume.directions[1][axis] * y + volume.directions[2][axis] * z;
    }
  }
  return { positions, info: { method: 'spatially-sampled-native-isosurface' as const,
    voxelSpacingMm: [...spacing] as Vec3, samplingCellMm: cellMm, samples: count, nativeTriangles } };
}

function denseTarget(volume: TomographyVolume, check: () => void) {
  validateVolume(volume);
  const [nx, ny, nz] = volume.dimensions, data = volume.voxels;
  const missing = new Set(volume.missingSlices);
  const intensity: number[] = [], step = Math.max(1, Math.ceil(data.length / 120_000));
  for (let i = 0; i < data.length; i += step) if (!missing.has(Math.floor(i / (nx * ny))) && Number.isFinite(data[i])) intensity.push(data[i]);
  if (intensity.length < 100) throw new Error('Insufficient finite voxel support for a dense dentition target.');
  intensity.sort((a, b) => a - b);
  const low = intensity[0], high = intensity[intensity.length - 1];
  if (!(high - low > 1e-6)) throw new Error('Insufficient intensity contrast for a dense dentition target.');
  let seed = quantile(intensity, .996);
  // Quantized/binary acquisitions can put the percentile exactly on their maximum.
  if (seed >= high) {
    let i = intensity.length - 1;
    while (i >= 0 && intensity[i] >= high) i--;
    if (i < 0) throw new Error('No usable dense-tissue threshold.');
    seed = (intensity[i] + high) / 2;
  }
  if (!(seed > low)) seed = (low + high) / 2;
  const counts = new Float64Array(nz);
  for (let z = 0; z < nz; z++) {
    check();
    if (missing.has(z)) continue;
    const end = (z + 1) * nx * ny;
    for (let i = z * nx * ny; i < end; i++) {
      if ((i & 16383) === 0) check();
      if (data[i] > seed) counts[z]++;
    }
  }
  const smooth = new Float64Array(nz), radius = Math.max(1, Math.min(2, Math.round(1 / volume.spacing[2])));
  for (let z = 0; z < nz; z++) for (let k = Math.max(0, z - radius); k <= Math.min(nz - 1, z + radius); k++) smooth[z] += counts[k] / (2 * radius + 1);
  let peak = 0;
  for (let z = 1; z < nz; z++) if (smooth[z] > smooth[peak]) peak = z;
  if (smooth[peak] < 5) throw new Error('No sufficiently dense dentition band was found.');
  let z0 = peak, z1 = peak;
  while (z0 > 0 && smooth[z0 - 1] >= .15 * smooth[peak]) z0--;
  while (z1 < nz - 1 && smooth[z1 + 1] >= .15 * smooth[peak]) z1++;
  // Upper/lower crowns can be separate dense bands. Keep nearby bands in the
  // same jaw ROI: selecting only the larger peak can snap an already aligned
  // single-jaw scan onto the wrong jaw even when its current pose is a start.
  for (let z = 0; z < nz; z++) if (Math.abs(z - peak) * volume.spacing[2] <= 25 && smooth[z] >= .15 * smooth[peak]) {
    z0 = Math.min(z0, z); z1 = Math.max(z1, z);
  }
  if ((z1 - z0) * volume.spacing[2] > 55) throw new Error('Dense structures do not form a localized dentition band.');
  const padZ = Math.ceil(3 / volume.spacing[2]);
  z0 = Math.max(0, z0 - padZ); z1 = Math.min(nz - 1, z1 + padZ);
  const xs = new Float64Array(nx), ys = new Float64Array(ny);
  let seeds = 0, edgeSeeds = 0;
  for (let z = z0; z <= z1; z++) {
    check();
    if (missing.has(z)) continue;
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) if (data[x + nx * (y + ny * z)] > seed) {
      xs[x]++; ys[y]++; seeds++;
      if (x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1) edgeSeeds++;
    }
  }
  if (seeds < 80 || edgeSeeds / seeds > .1) throw new Error('Dense dentition coverage is insufficient or clipped by the volume boundary.');
  const percentileIndex = (counts: Float64Array, fraction: number) => {
    let sum = 0;
    for (let i = 0; i < counts.length; i++) { sum += counts[i]; if (sum >= seeds * fraction) return i; }
    return counts.length - 1;
  };
  const x0 = Math.max(0, percentileIndex(xs, .005) - Math.ceil(4 / volume.spacing[0]));
  const x1 = Math.min(nx - 1, percentileIndex(xs, .995) + Math.ceil(4 / volume.spacing[0]));
  const y0 = Math.max(0, percentileIndex(ys, .005) - Math.ceil(4 / volume.spacing[1]));
  const y1 = Math.min(ny - 1, percentileIndex(ys, .995) + Math.ceil(4 / volume.spacing[1]));
  const dimensions: Vec3 = [x1 - x0 + 1, y1 - y0 + 1, z1 - z0 + 1];
  if (dimensions.some((n, i) => (n - 1) * volume.spacing[i] > [140, 120, 65][i])) throw new Error('The dense dentition region exceeds the bounded automatic search.');
  const roiCount = dimensions[0] * dimensions[1] * dimensions[2];
  const roiIntensity: number[] = [], roiStep = Math.max(1, Math.ceil(roiCount / 80_000));
  let index = 0, finite = 0;
  for (let z = z0; z <= z1; z++) {
    check();
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++, index++) {
      if ((index & 16383) === 0) check();
      const value = missing.has(z) ? NaN : data[x + nx * (y + ny * z)];
      if (Number.isFinite(value)) finite++;
      if (index % roiStep === 0 && Number.isFinite(value)) roiIntensity.push(value);
    }
  }
  // Circular padding outside this ROI is irrelevant. Missing dental tissue is
  // still rejected by the frozen optical sample pool's final support checks.
  if (finite < .5 * roiCount || roiIntensity.length < 100) throw new Error('Insufficient finite voxel support inside the dense dentition region.');
  roiIntensity.sort((a, b) => a - b);
  // Dense seeds localize the jaw/crown band rather than the whole skull. This
  // lower isolevel includes crown flanks, but is not anatomical segmentation.
  const upper = quantile(roiIntensity, .995), lower = quantile(roiIntensity, .90);
  const threshold = Math.min(seed, lower < upper ? (lower + upper) / 2 : seed);
  const surface = sampledTarget(volume, [[x0, y0, z0], [x1, y1, z1]], threshold, check);
  const samples = sampleTriangles([surface], 1, 2200, check);
  const spread = shape(samples.map(s => s.point));
  if (spread.values[1] < 4 || spread.values[2] < .1 || spread.values[2] / spread.values[0] > .7) {
    throw new Error('Dense target lacks a sufficiently spread, band-like dentition surface.');
  }
  return { query: createNearestSurfaceQuery(surface.positions, check), spread, threshold, info: surface.info };
}

function startingMatrices(source: Shape, target: Shape) {
  // Preserve the current shared workspace pose as an independent candidate.
  const result: Matrix4[] = [new Matrix4()];
  const centered = (rotation: Matrix4) => {
    rotation.setPosition(target.center.clone().sub(source.center.clone().applyMatrix4(rotation)));
    result.push(rotation);
  };
  // A modest angle grid covers differing scanner axes without relying only on PCA.
  for (const x of [-25, 0, 25]) for (const y of [-25, 0, 25]) for (const z of [-25, 0, 25]) {
    centered(new Matrix4().makeRotationFromEuler(new Euler(x * Math.PI / 180, y * Math.PI / 180, z * Math.PI / 180)));
  }
  const from = new Matrix4().makeBasis(...source.axes as [Vector3, Vector3, Vector3]).transpose();
  // All 24 right-handed principal-frame permutations cover axis swaps and sign ambiguity.
  const permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const worldAxes = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
  for (const permutation of permutations) for (const x of [-1, 1]) for (const y of [-1, 1]) {
    const a = target.axes[permutation[0]].clone().multiplyScalar(x), b = target.axes[permutation[1]].clone().multiplyScalar(y);
    const c = a.clone().cross(b);
    centered(new Matrix4().makeBasis(a, b, c).multiply(from));
    // Also test proper cardinal rotations independently: repeated dense shapes
    // can distort the target PCA and otherwise conceal a competing pose.
    const u = worldAxes[permutation[0]].clone().multiplyScalar(x), v = worldAxes[permutation[1]].clone().multiplyScalar(y);
    centered(new Matrix4().makeBasis(u, v, u.clone().cross(v)));
  }
  return result;
}

function poseDifference(a: Matrix4, b: Matrix4, center: Vector3) {
  const rotationA = new Quaternion().setFromRotationMatrix(a), rotationB = new Quaternion().setFromRotationMatrix(b);
  return {
    angle: rotationA.angleTo(rotationB),
    distance: center.clone().applyMatrix4(a).distanceTo(center.clone().applyMatrix4(b)),
  };
}

/** Keep different pose basins before each pruning step; duplicate starts must not crowd out ambiguity evidence. */
function distinctFits(ranked: Fit[], center: Vector3, degrees: number, distance: number, limit: number) {
  const result: Fit[] = [];
  for (const fit of ranked) {
    if (result.every(other => {
      const difference = poseDifference(fit.matrix, other.matrix, center);
      return difference.angle > degrees * Math.PI / 180 || difference.distance > distance;
    })) result.push(fit);
    if (result.length >= limit) break;
  }
  return result;
}

function matches(samples: Sample[], query: NearestSurfaceQuery, matrix: Matrix4, limit: number, check: () => void) {
  const result: Match[] = [], normal = new Vector3();
  for (let i = 0; i < samples.length; i++) {
    if ((i & 63) === 0) check();
    const sample = samples[i], p = sample.point.clone().applyMatrix4(matrix), q = new Vector3(), n = new Vector3();
    const distance = query.nearestPoint(p, q, n, limit);
    normal.copy(sample.normal).transformDirection(matrix);
    // Ignore winding polarity: local imported meshes may consistently face inward.
    if (Number.isFinite(distance) && Math.abs(normal.dot(n)) >= NORMAL_DOT) result.push({ p, q, normal: n, distance, sourceIndex: sample.sourceIndex, regionIndex: sample.regionIndex });
  }
  return result;
}

function pointStep(pairs: Match[]) {
  const from = pairs.reduce((sum, p) => sum.add(p.p), new Vector3()).multiplyScalar(1 / pairs.length);
  const to = pairs.reduce((sum, p) => sum.add(p.q), new Vector3()).multiplyScalar(1 / pairs.length);
  const h = Array<number>(9).fill(0);
  for (const pair of pairs) {
    const p = pair.p.clone().sub(from).toArray(), q = pair.q.clone().sub(to).toArray();
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) h[i * 3 + j] += p[i] * q[j];
  }
  const [xx, xy, xz, yx, yy, yz, zx, zy, zz] = h;
  const v = eigen([
    xx + yy + zz, yz - zy, zx - xz, xy - yx,
    yz - zy, xx - yy - zz, xy + yx, zx + xz,
    zx - xz, xy + yx, -xx + yy - zz, yz + zy,
    xy - yx, zx + xz, yz + zy, -xx - yy + zz,
  ], 4)[0].vector;
  const rotation = new Quaternion(v[1], v[2], v[3], v[0]).normalize();
  return new Matrix4().makeRotationFromQuaternion(rotation).setPosition(to.sub(from.applyQuaternion(rotation)));
}

function planeStep(pairs: Match[]): Matrix4 | null {
  const center = pairs.reduce((sum, p) => sum.add(p.p), new Vector3()).multiplyScalar(1 / pairs.length);
  const a = Array.from({ length: 6 }, () => Array<number>(7).fill(0));
  for (const pair of pairs) {
    const n = pair.normal, cross = pair.p.clone().sub(center).cross(n);
    const row = [...cross.toArray(), ...n.toArray()], b = pair.q.clone().sub(pair.p).dot(n);
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 6; j++) a[i][j] += row[i] * row[j];
      a[i][6] += row[i] * b;
    }
  }
  // Tiny damping regularizes nearly parallel patches; a later normal-span check
  // rejects fits which have no spatial/surface-direction support.
  for (let i = 0; i < 6; i++) a[i][i] += 1e-7 * Math.max(1, a[i][i]);
  for (let i = 0; i < 6; i++) {
    let pivot = i;
    for (let j = i + 1; j < 6; j++) if (Math.abs(a[j][i]) > Math.abs(a[pivot][i])) pivot = j;
    [a[i], a[pivot]] = [a[pivot], a[i]];
    if (Math.abs(a[i][i]) < 1e-10) return null;
    const divisor = a[i][i];
    for (let k = i; k < 7; k++) a[i][k] /= divisor;
    for (let j = 0; j < 6; j++) if (j !== i) {
      const factor = a[j][i];
      for (let k = i; k < 7; k++) a[j][k] -= factor * a[i][k];
    }
  }
  const rotation = new Vector3(a[0][6], a[1][6], a[2][6]), translation = new Vector3(a[3][6], a[4][6], a[5][6]);
  const angle = rotation.length();
  if (![angle, ...translation.toArray()].every(Number.isFinite) || angle > .4 || translation.length() > 5) return null;
  const q = angle > 0 ? new Quaternion().setFromAxisAngle(rotation.multiplyScalar(1 / angle), angle) : new Quaternion();
  return new Matrix4().makeRotationFromQuaternion(q).setPosition(center.clone().add(translation).sub(center.applyQuaternion(q)));
}

function refine(samples: Sample[], query: NearestSurfaceQuery, initial: Matrix4, iterations: number, start: number, end: number, check: () => void) {
  const matrix = initial.clone();
  for (let iteration = 0; iteration < iterations; iteration++) {
    const limit = start * (end / start) ** (iteration / (iterations - 1));
    const pairs = matches(samples, query, matrix, limit, check).sort((a, b) => a.distance - b.distance);
    if (pairs.length < Math.max(40, samples.length * .20)) break;
    pairs.length = Math.max(30, Math.floor(pairs.length * .75));
    const delta = iteration < 5 ? pointStep(pairs) : planeStep(pairs) ?? pointStep(pairs);
    matrix.premultiply(delta);
    const e = delta.elements;
    if (iteration > 5 && Math.hypot(e[12], e[13], e[14]) < 1e-4 && Math.abs(e[0] + e[5] + e[10] - 3) < 1e-8) break;
  }
  return matrix;
}

function evaluate(samples: Sample[], query: NearestSurfaceQuery, matrix: Matrix4, check: () => void): Fit {
  const distances: number[] = [];
  let support = 0, squares = 0;
  const q = new Vector3(), n = new Vector3(), normal = new Vector3();
  for (let i = 0; i < samples.length; i++) {
    if ((i & 63) === 0) check();
    const sample = samples[i], p = sample.point.clone().applyMatrix4(matrix);
    // A capped nonmatch still participates in the median and score.
    const distance = query.nearestPoint(p, q, n, 8);
    distances.push(Math.min(distance, 8));
    normal.copy(sample.normal).transformDirection(matrix);
    if (distance <= SUPPORT_MM && Math.abs(normal.dot(n)) >= NORMAL_DOT) { support++; squares += distance * distance; }
  }
  distances.sort((a, b) => a - b);
  const coverage = support / samples.length, medianMm = quantile(distances, .5), rmsMm = support ? Math.sqrt(squares / support) : Infinity;
  return { matrix, coverage, medianMm, rmsMm, score: coverage - .12 * medianMm - .08 * (Number.isFinite(rmsMm) ? rmsMm : 8) };
}

/**
 * Local dense-band, multistart trimmed ICP approximation. Rigid only: no inferred
 * scale, anatomical segmentation, clinical registration, contact area, or volume.
 * Incomplete acquisitions can support a visual preview fit: missing planes and
 * NaNs stay unavailable, without interpolation or changing volume validity flags.
 * The caller runs this synchronous CPU work in a terminable worker. AbortSignal
 * is useful before execution/cooperative callbacks; worker termination cancels
 * an in-flight request because queued worker messages cannot interrupt JS.
 */
export function alignOpticalScansToCbct(input: CbctAutoAlignmentInput, signal?: AbortSignal): CbctAutoAlignmentResult {
  const started = performance.now();
  const check = () => {
    if (signal?.aborted) { const error = new Error('Automatic alignment cancelled.'); error.name = 'AbortError'; throw error; }
    if (performance.now() - started > MAX_MS) throw new Error('Automatic alignment exceeded its bounded search time. Use matching landmarks or a smaller volume.');
  };
  check();
  const { volume, sources, mmPerUnit } = input;
  if (!Number.isFinite(mmPerUnit) || mmPerUnit <= 0 || mmPerUnit > 1e6) throw new Error('Confirm a positive millimetres-per-file-unit scale before automatic alignment.');
  if (!Array.isArray(sources) || !sources.length || sources.length > 64 || sources.some(s => !(s.positions instanceof Float64Array))) throw new Error('Provide finite optical triangle sources in shared workspace coordinates.');
  validateVolume(volume);
  const fullSamples = sampleTriangles(sources, mmPerUnit, 2200, check);
  // A patient-relative computational frame avoids large absolute DICOM origins;
  // the final delta below restores the absolute patient/workspace frame.
  const origin = new Vector3(...volume.origin);
  for (const sample of fullSamples) sample.point.sub(origin);
  const fullShape = shape(fullSamples.map(s => s.point));
  if (fullShape.values[1] < 4 || fullShape.values[2] < .01 || fullShape.values[0] > 40_000) throw new Error('Optical surface has insufficient three-dimensional extent at the confirmed scale.');
  const selection = crownSamples(sources, mmPerUnit, origin, check, started, fullSamples), samples = selection.samples;
  const source = shape(samples.map(s => s.point));
  const target = denseTarget(volume, check);
  const coarse = samples.filter((_, i) => i % 4 === 0);
  const matrices = startingMatrices(source, target.spread);
  // Selected caps and a full isosurface have different centroids. Whole-source
  // frames supply additional starts without moving the current-pose candidate.
  if (selection.method === 'heuristic-crown-regions') matrices.push(...startingMatrices(fullShape, target.spread).slice(1));
  const starts = matrices.map(matrix => evaluate(coarse, target.query, matrix, check));
  const current = starts[0];
  starts.sort((a, b) => b.score - a.score);
  const candidates = distinctFits(starts, source.center, 28, 3, 16);
  // A displaced whole-target centroid must not crowd the current local basin
  // out of the multistart search (e.g. a single optical jaw in a two-jaw CBCT).
  if (!candidates.includes(current)) candidates.push(current);
  const trials: Fit[] = [];
  for (const start of candidates) {
    const matrix = refine(coarse, target.query, start.matrix, 22, 8, 1.5, check);
    trials.push(evaluate(coarse, target.query, matrix, check));
  }
  trials.sort((a, b) => b.score - a.score);
  const finalists = distinctFits(trials, source.center, 12, 2, 4).map(trial => {
    const matrix = refine(samples, target.query, trial.matrix, 32, 2.5, .8, check);
    return evaluate(samples, target.query, matrix, check);
  }).sort((a, b) => b.score - a.score);
  const best = finalists[0];
  if (!best || best.coverage < .55 || best.medianMm > .9 || best.rmsMm > .7) {
    throw new Error('Insufficient matching dense-surface support for automatic alignment. Confirm the scale and use matching landmarks.');
  }
  const fullFit = evaluate(fullSamples, target.query, best.matrix, check);
  for (const other of finalists.slice(1)) {
    const difference = poseDifference(other.matrix, best.matrix, source.center);
    // Crown selection must not conceal competing poses supported equally well
    // by the original scan (e.g. repeated arches with different cap sampling).
    const otherFull = evaluate(fullSamples, target.query, other.matrix, check);
    const competingFull = fullFit.coverage >= .55 && otherFull.coverage >= .55 && Math.abs(fullFit.score - otherFull.score) < .015;
    if ((best.score - other.score < .015 || competingFull) && (difference.angle > Math.PI / 6 || difference.distance > 3)) {
      throw new Error('Multiple different poses have similar support; automatic alignment is ambiguous. Use matching landmarks.');
    }
  }
  const support = matches(samples, target.query, best.matrix, SUPPORT_MM, check);
  // A large scan or one locally matching tooth must not hide another source,
  // an unsupported side of the arch, or a crown proposal on unrelated tissue.
  const perSource: NonNullable<CbctAutoAlignmentResult['registrationSupport']>['perSource'] = [];
  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
    const pool = samples.filter(s => s.sourceIndex === sourceIndex), pairs = support.filter(s => s.sourceIndex === sourceIndex);
    const regions = new Set(pool.flatMap(s => s.regionIndex === undefined ? [] : [s.regionIndex]));
    let supportedRegions = 0;
    for (const region of regions) {
      const count = pool.filter(s => s.regionIndex === region).length, matched = pairs.filter(s => s.regionIndex === region).length;
      if (count >= 8 && matched >= 6 && matched / count >= .5) supportedRegions++;
    }
    if (pool.length < 20 || pairs.length < 12 || pairs.length / pool.length < (regions.size ? .55 : .25)
      || (regions.size && supportedRegions < Math.max(3, Math.ceil(regions.size * .5)))) {
      throw new Error('An optical source has insufficient distributed crown/surface support for the shared rigid alignment.');
    }
    const before = shape(pool.map(s => s.point)), after = shape(pairs.map(s => s.p));
    if (after.values[0] < before.values[0] * .5 || after.values[1] < before.values[1] * .4) {
      throw new Error('Matching crown support does not span the optical source; use matching landmarks.');
    }
    perSource.push({ id: sources[sourceIndex].id, samples: pool.length, coverage: pairs.length / pool.length, regions: regions.size, supportedRegions });
  }
  const spread = shape(support.map(p => p.p));
  const normalCovariance = Array<number>(9).fill(0);
  for (const pair of support) {
    const n = pair.normal.toArray();
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) normalCovariance[i * 3 + j] += n[i] * n[j] / support.length;
  }
  if (support.length < MIN_SAMPLES || spread.values[1] < source.values[1] * .35 || eigen(normalCovariance, 3)[2].value < .025) {
    throw new Error('Matching support is too localized or geometrically ambiguous for automatic alignment.');
  }
  // q_rel = R (p_mm - origin) + t_rel, hence q_mm = R p_mm + t_rel + origin - R origin.
  const matrix = best.matrix.clone();
  const rotation = matrix.clone().setPosition(0, 0, 0);
  const translation = new Vector3().setFromMatrixPosition(matrix).add(origin)
    .sub(origin.clone().applyMatrix4(rotation)).multiplyScalar(1 / mmPerUnit);
  matrix.setPosition(translation);
  if (!matrix.elements.every(Number.isFinite)) throw new Error('Automatic alignment transform exceeds finite workspace coordinates.');
  // Report the FULL original optical sample pool, including gingiva/palate,
  // before crown selection, trimming, or compatibility filters.
  // Search scores use capped distances/inlier RMS; public metrics do not hide outliers.
  const distances: number[] = [], nearest = new Vector3();
  let squares = 0;
  for (let i = 0; i < fullSamples.length; i++) {
    if ((i & 63) === 0) check();
    const distance = target.query.nearestPoint(fullSamples[i].point.clone().applyMatrix4(best.matrix), nearest);
    distances.push(distance); squares += distance * distance;
  }
  distances.sort((a, b) => a - b);
  check();
  return { matrix: matrix.toArray(), rmsMm: Math.sqrt(squares / fullSamples.length), medianMm: quantile(distances, .5),
    coverage: fullFit.coverage, samples: fullSamples.length,
    registrationSupport: { method: selection.method, samples: samples.length, coverage: best.coverage, inlierRmsMm: best.rmsMm, medianMm: best.medianMm, perSource }, threshold: target.threshold, registrationTarget: target.info, durationMs: performance.now() - started };
}
