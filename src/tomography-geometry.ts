import { edgeTable, triTable } from 'three/examples/jsm/objects/MarchingCubes.js';
import type { TomographySurface, TomographyVolume, Vec3 } from './tomography-types.ts';

/** Voxel indices locate sample centers; the origin is the center of voxel [0, 0, 0]. */
export function voxelToPatient(volume: TomographyVolume, point: Vec3): Vec3 {
  const [a, b, c] = volume.directions;
  const x = point[0] * volume.spacing[0], y = point[1] * volume.spacing[1], z = point[2] * volume.spacing[2];
  return [
    volume.origin[0] + a[0] * x + b[0] * y + c[0] * z,
    volume.origin[1] + a[1] * x + b[1] * y + c[1] * z,
    volume.origin[2] + a[2] * x + b[2] * y + c[2] * z,
  ];
}

/** Inverse of the orthonormal direction-column affine, in voxel index coordinates. */
export function patientToVoxel(volume: TomographyVolume, point: Vec3): Vec3 {
  const x = point[0] - volume.origin[0], y = point[1] - volume.origin[1], z = point[2] - volume.origin[2];
  return volume.directions.map((axis, i) => (axis[0] * x + axis[1] * y + axis[2] * z) / volume.spacing[i]) as Vec3;
}

/** Center of the sample-center bounds, in absolute patient LPS millimeters. */
export function volumeCenter(volume: TomographyVolume): Vec3 {
  return voxelToPatient(volume, volume.dimensions.map(size => (size - 1) / 2) as Vec3);
}

/**
 * Trilinear intensity sampling, without extrapolation or interpolation through
 * missing data. Only corners with positive weight participate. Tiny affine
 * roundoff at integer planes is snapped so an exact valid plane stays usable
 * next to NaN padding or an explicitly missing plane.
 */
export function sampleVolume(volume: TomographyVolume, patientPoint: Vec3): number {
  if (!patientPoint.every(Number.isFinite)) return NaN;
  const point = patientToVoxel(volume, patientPoint);
  for (let axis = 0; axis < 3; axis++) {
    const direction = volume.directions[axis];
    let error = 1;
    for (let component = 0; component < 3; component++) {
      error += Math.abs(direction[component]) * (Math.abs(patientPoint[component]) + Math.abs(volume.origin[component])) / volume.spacing[axis];
    }
    const nearest = Math.round(point[axis]);
    // Large absolute origins must not turn this roundoff allowance into a
    // meaningful fraction of a voxel, or snap representable outside points in.
    const tolerance = Math.min(1e-7, 8 * Number.EPSILON * error);
    if (Math.abs(point[axis] - nearest) <= tolerance) point[axis] = nearest;
    if (!Number.isFinite(point[axis]) || point[axis] < 0 || point[axis] > volume.dimensions[axis] - 1) return NaN;
  }
  const [nx, ny, nz] = volume.dimensions;
  const x0 = Math.floor(point[0]), y0 = Math.floor(point[1]), z0 = Math.floor(point[2]);
  const tx = point[0] - x0, ty = point[1] - y0, tz = point[2] - z0;
  let result = 0;
  for (let iz = 0; iz < 2; iz++) {
    const wz = iz ? tz : 1 - tz;
    if (wz === 0) continue;
    const z = Math.min(z0 + iz, nz - 1);
    if (volume.missingSlices.includes(z)) return NaN;
    for (let iy = 0; iy < 2; iy++) {
      const wy = iy ? ty : 1 - ty;
      if (wy === 0) continue;
      const y = Math.min(y0 + iy, ny - 1);
      for (let ix = 0; ix < 2; ix++) {
        const wx = ix ? tx : 1 - tx;
        if (wx === 0) continue;
        const value = volume.voxels[Math.min(x0 + ix, nx - 1) + nx * (y + ny * z)];
        if (!Number.isFinite(value)) return NaN;
        result += value * wx * wy * wz;
      }
    }
  }
  return result;
}

export interface TomographySurfaceOptions {
  threshold: number;
  /** Explicit sampling step, an integer from 1 through 8. Never adjusted automatically. */
  stride: number;
  maxTriangles?: number;
  shouldCancel?: () => boolean;
}

const DEFAULT_MAX_TRIANGLES = 600_000;
const HARD_MAX_TRIANGLES = 1_000_000;
// The standard marching-cubes corner/edge order used by Three's exported tables.
const CORNERS = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
const EDGES = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];

function validateVolume(volume: TomographyVolume) {
  const dimensions = volume.dimensions;
  if (dimensions.length !== 3 || dimensions.some(size => !Number.isSafeInteger(size) || size < 1)) {
    throw new Error('Tomography dimensions must contain three positive integers.');
  }
  const count = dimensions[0] * dimensions[1] * dimensions[2];
  if (!Number.isSafeInteger(count) || !(volume.voxels instanceof Float32Array) || volume.voxels.length !== count) {
    throw new Error('Tomography voxel data must match the x-fastest volume dimensions.');
  }
  if (volume.spacing.length !== 3 || volume.spacing.some(value => !Number.isFinite(value) || value <= 0)) {
    throw new Error('Tomography spacing must contain three positive finite millimeter values.');
  }
  if (volume.origin.length !== 3 || !volume.origin.every(Number.isFinite)) throw new Error('Tomography origin must be finite.');
  const axes = volume.directions;
  if (axes.length !== 3 || axes.some(axis => axis.length !== 3 || !axis.every(Number.isFinite))) {
    throw new Error('Tomography directions must be three orthonormal columns.');
  }
  for (let i = 0; i < 3; i++) for (let j = i; j < 3; j++) {
    const dot = axes[i][0] * axes[j][0] + axes[i][1] * axes[j][1] + axes[i][2] * axes[j][2];
    if (Math.abs(dot - Number(i === j)) > 1e-6) throw new Error('Tomography directions must be three orthonormal columns.');
  }
  if (volume.missingSlices.some(z => !Number.isInteger(z) || z < 0 || z >= dimensions[2])) {
    throw new Error('Missing tomography slices must be valid z indices.');
  }
}

/**
 * Synchronous worker-oriented marching cubes. Values >= threshold are inside.
 * Positions are LPS-oriented mm relative to volume.origin, with outward flat
 * unit normals. No outside samples, end caps, hole filling, or segmentation
 * assumptions are introduced. Edge cells may be narrower than the stride.
 *
 * Two passes count and then write the same triangles, allocating exactly two
 * bounded Float32Arrays (at most 72 MB combined). Capacity failure never returns
 * a truncated mesh. A worker may also be terminated to cancel synchronous work.
 */
export function extractTomographySurface(volume: TomographyVolume, options: TomographySurfaceOptions): TomographySurface {
  validateVolume(volume);
  const { threshold, stride, shouldCancel } = options;
  const maxTriangles = options.maxTriangles ?? DEFAULT_MAX_TRIANGLES;
  if (!Number.isFinite(threshold)) throw new Error('The tomography threshold must be finite.');
  if (!Number.isInteger(stride) || stride < 1 || stride > 8) throw new Error('Tomography stride must be an integer from 1 through 8.');
  if (!Number.isInteger(maxTriangles) || maxTriangles < 1 || maxTriangles > HARD_MAX_TRIANGLES) {
    throw new Error(`The triangle limit must be an integer from 1 through ${HARD_MAX_TRIANGLES}.`);
  }
  const checkCancelled = () => {
    if (shouldCancel?.()) {
      const error = new Error('Tomography surface extraction cancelled.');
      error.name = 'AbortError';
      throw error;
    }
  };
  checkCancelled();
  const [nx, ny, nz] = volume.dimensions, [sx, sy, sz] = volume.spacing;
  const [a, b, c] = volume.directions;
  const determinant = (a[1] * b[2] - a[2] * b[1]) * c[0]
    + (a[2] * b[0] - a[0] * b[2]) * c[1] + (a[0] * b[1] - a[1] * b[0]) * c[2];
  const missing = new Set(volume.missingSlices);
  const values = new Float64Array(8), vertices = new Float32Array(36);
  let skippedNonFinite = false;

  const scan = (positions?: Float32Array, normals?: Float32Array): number => {
    let triangles = 0, work = 0;
    for (let z = 0; z < nz - 1; z += stride) {
      checkCancelled();
      const z1 = Math.min(z + stride, nz - 1);
      let missingSpan = false;
      for (let plane = z; plane <= z1; plane++) if (missing.has(plane)) { missingSpan = true; break; }
      if (missingSpan) continue;
      for (let y = 0; y < ny - 1; y += stride) for (let x = 0; x < nx - 1; x += stride) {
        if ((work++ & 2047) === 0) checkCancelled();
        const x1 = Math.min(x + stride, nx - 1), y1 = Math.min(y + stride, ny - 1);
        const dx = x1 - x, dy = y1 - y, dz = z1 - z;
        let cube = 0, valid = true;
        for (let corner = 0; corner < 8; corner++) {
          const p = CORNERS[corner];
          const value = volume.voxels[x + p[0] * dx + nx * (y + p[1] * dy + ny * (z + p[2] * dz))];
          values[corner] = value;
          if (!Number.isFinite(value)) valid = false;
          // The table's low-valued side gives outward winding for high-density solids.
          if (value < threshold) cube |= 1 << corner;
        }
        if (!valid) { skippedNonFinite = true; continue; }
        // Do not bridge NaN padding or an unlisted NaN plane skipped by stride.
        if (stride > 1) {
          for (let iz = z; iz <= z1 && valid; iz++) for (let iy = y; iy <= y1 && valid; iy++) {
            const row = nx * (iy + ny * iz);
            for (let ix = x; ix <= x1; ix++) if (!Number.isFinite(volume.voxels[row + ix])) { valid = false; break; }
          }
          if (!valid) { skippedNonFinite = true; continue; }
        }
        const edges = edgeTable[cube];
        if (edges === 0) continue;
        for (let edge = 0; edge < 12; edge++) {
          if (!(edges & (1 << edge))) continue;
          const [i, j] = EDGES[edge], p = CORNERS[i], q = CORNERS[j];
          const t = (threshold - values[i]) / (values[j] - values[i]);
          const vx = (x + (p[0] + t * (q[0] - p[0])) * dx) * sx;
          const vy = (y + (p[1] + t * (q[1] - p[1])) * dy) * sy;
          const vz = (z + (p[2] + t * (q[2] - p[2])) * dz) * sz;
          const offset = edge * 3;
          vertices[offset] = a[0] * vx + b[0] * vy + c[0] * vz;
          vertices[offset + 1] = a[1] * vx + b[1] * vy + c[1] * vz;
          vertices[offset + 2] = a[2] * vx + b[2] * vy + c[2] * vz;
          if (!Number.isFinite(vertices[offset]) || !Number.isFinite(vertices[offset + 1]) || !Number.isFinite(vertices[offset + 2])) {
            throw new Error('Tomography surface coordinates exceed finite Float32 millimeter coordinates.');
          }
        }
        const table = cube * 16;
        for (let entry = 0; entry < 15 && triTable[table + entry] !== -1; entry += 3) {
          const v0 = triTable[table + entry] * 3;
          const v1 = triTable[table + entry + (determinant < 0 ? 2 : 1)] * 3;
          const v2 = triTable[table + entry + (determinant < 0 ? 1 : 2)] * 3;
          const ux = vertices[v1] - vertices[v0], uy = vertices[v1 + 1] - vertices[v0 + 1], uz = vertices[v1 + 2] - vertices[v0 + 2];
          const vx = vertices[v2] - vertices[v0], vy = vertices[v2 + 1] - vertices[v0 + 1], vz = vertices[v2 + 2] - vertices[v0 + 2];
          const normalX = uy * vz - uz * vy, normalY = uz * vx - ux * vz, normalZ = ux * vy - uy * vx;
          const length = Math.hypot(normalX, normalY, normalZ);
          // Threshold equality can collapse a table triangle to an edge or point.
          if (length === 0) continue;
          if (triangles >= maxTriangles) {
            throw new Error(`Tomography surface exceeds the ${maxTriangles.toLocaleString('en-US')} triangle limit. Choose a different threshold or explicitly increase stride; no partial surface was returned.`);
          }
          if (positions && normals) {
            if ((triangles + 1) * 9 > positions.length) throw new Error('Tomography volume changed during extraction.');
            let target = triangles * 9;
            for (const source of [v0, v1, v2]) {
              positions[target] = vertices[source];
              positions[target + 1] = vertices[source + 1];
              positions[target + 2] = vertices[source + 2];
              normals[target] = normalX / length;
              normals[target + 1] = normalY / length;
              normals[target + 2] = normalZ / length;
              target += 3;
            }
          }
          triangles++;
        }
      }
    }
    checkCancelled();
    return triangles;
  };

  const triangles = scan();
  checkCancelled();
  const positions = new Float32Array(triangles * 9), normals = new Float32Array(triangles * 9);
  if (triangles > 0 && scan(positions, normals) !== triangles) throw new Error('Tomography volume changed during extraction.');
  const warnings = new Set(volume.warnings);
  warnings.add('Threshold isosurface preview only; not anatomical segmentation or a quantitative measurement surface.');
  warnings.add('Volume edges and missing-data gaps are left open; surface completeness does not imply a watertight mesh.');
  if (stride > 1) warnings.add(`Explicit stride ${stride} samples a coarser grid and can omit small structures; boundary cells may be narrower.`);
  if (missing.size || skippedNonFinite || !volume.complete) warnings.add('Incomplete source data: cubes touching missing slices or non-finite voxels are omitted without filling gaps.');
  if (Math.min(nx, ny, nz) < 2) warnings.add('At least two sample planes on every axis are needed for a three-dimensional isosurface.');
  return {
    volumeId: volume.id, positions, normals, triangles, threshold, stride,
    effectiveSpacing: [sx * stride, sy * stride, sz * stride], origin: [...volume.origin],
    complete: volume.complete && missing.size === 0 && !skippedNonFinite,
    quantitativeMeasurementsAllowed: false, method: 'threshold-isosurface', warnings: [...warnings],
  };
}
