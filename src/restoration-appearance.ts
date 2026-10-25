import type { ModelPart } from './models.ts';
import { crownEnamel } from './crown-enamel.ts';

export type RestorationComponent = NonNullable<ModelPart['restoration']>['component'];

/**
 * Display-only material for a generated concept component. These values make
 * parts distinguishable; they do not describe a manufacturer's alloy, ceramic,
 * surface treatment, threads, or connection, and they imply no clinical fit.
 */
export interface RestorationAppearance {
  key: string;
  component: RestorationComponent;
  finish: 'ceramic-concept' | 'metal-concept';
  roughness: number;
  metalness: number;
  clearcoat: number;
  clearcoatRoughness: number;
  envMapIntensity: number;
}

const appearances: Record<RestorationComponent, Omit<RestorationAppearance, 'key' | 'component'>> = {
  crown: { finish: 'ceramic-concept', roughness: 0.42, metalness: 0, clearcoat: 0.16, clearcoatRoughness: 0.4, envMapIntensity: 0.3 },
  abutment: { finish: 'metal-concept', roughness: 0.36, metalness: 0.55, clearcoat: 0, clearcoatRoughness: 0, envMapIntensity: 0.8 },
  // Display values do not identify an alloy or a manufacturer's surface finish.
  fixture: { finish: 'metal-concept', roughness: 0.48, metalness: 0.6, clearcoat: 0, clearcoatRoughness: 0, envMapIntensity: 0.8 },
};

/**
 * Only in-app restoration metadata selects a concept material. A reimported
 * PLY without that metadata stays an ordinary scan surface, whatever its name.
 */
export function restorationAppearance(part: ModelPart): RestorationAppearance | null {
  const component = part.restoration?.component;
  if (!component || !(component in appearances) || part.reference) return null;
  const appearance = appearances[component];
  const roughness = part.presentationRoughness ?? appearance.roughness;
  const key = `restoration-${component}-v2${crownEnamel(part) ? '-enamel' : ''}${roughness === appearance.roughness ? '' : `-roughness-${roughness}`}`;
  return { key, component, ...appearance, roughness };
}

const SMOOTH_CREASE_DEGREES = 40;
const cache = new WeakMap<Float32Array, { normals: Float32Array; creaseDegrees: number }>();

/**
 * Per-corner normals averaged over coincident corners whose faces lie within
 * the crease angle. Faceted ring/height-field shading becomes smooth while cap
 * and margin edges stay sharp. Positions are only read; source normals,
 * picking, collision and export keep the original arrays.
 */
export function smoothDisplayNormals(positions: Float32Array, fallback: Float32Array, creaseDegrees = SMOOTH_CREASE_DEGREES): Float32Array {
  const cached = cache.get(positions);
  if (cached?.creaseDegrees === creaseDegrees && cached.normals.length === positions.length) return cached.normals;
  const corners = positions.length / 3, faces = Math.floor(corners / 3);
  const faceNormals = new Float32Array(faces * 3), areas = new Float32Array(faces), angles = new Float32Array(faces * 3);
  for (let f = 0; f < faces; f++) {
    const o = f * 9;
    const ax = positions[o + 3] - positions[o], ay = positions[o + 4] - positions[o + 1], az = positions[o + 5] - positions[o + 2];
    const bx = positions[o + 6] - positions[o], by = positions[o + 7] - positions[o + 1], bz = positions[o + 8] - positions[o + 2];
    const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx, length = Math.hypot(nx, ny, nz);
    areas[f] = length;
    if (length > 0) faceNormals.set([nx / length, ny / length, nz / length], f * 3);
    for (let k = 0; k < 3; k++) {
      const p = o + k * 3, q = o + ((k + 1) % 3) * 3, r = o + ((k + 2) % 3) * 3;
      const ux = positions[q] - positions[p], uy = positions[q + 1] - positions[p + 1], uz = positions[q + 2] - positions[p + 2];
      const vx = positions[r] - positions[p], vy = positions[r + 1] - positions[p + 1], vz = positions[r + 2] - positions[p + 2];
      const scale = Math.hypot(ux, uy, uz) * Math.hypot(vx, vy, vz);
      angles[f * 3 + k] = scale > 0 ? Math.acos(Math.min(1, Math.max(-1, (ux * vx + uy * vy + uz * vz) / scale))) : 0;
    }
  }
  const groups = new Map<string, number[]>();
  for (let c = 0; c < faces * 3; c++) {
    const key = `${positions[c * 3]},${positions[c * 3 + 1]},${positions[c * 3 + 2]}`;
    const group = groups.get(key);
    if (group) group.push(c); else groups.set(key, [c]);
  }
  const normals = fallback.length === positions.length ? fallback.slice() : new Float32Array(positions.length);
  const threshold = Math.cos(creaseDegrees * Math.PI / 180);
  for (const group of groups.values()) {
    for (const corner of group) {
      const face = Math.floor(corner / 3);
      if (!(areas[face] > 0)) continue;
      let x = 0, y = 0, z = 0;
      for (const other of group) {
        const f = Math.floor(other / 3);
        if (!(areas[f] > 0)) continue;
        const cos = faceNormals[f * 3] * faceNormals[face * 3] + faceNormals[f * 3 + 1] * faceNormals[face * 3 + 1] + faceNormals[f * 3 + 2] * faceNormals[face * 3 + 2];
        if (cos < threshold) continue;
        // Corner-angle weighting is independent of how a facet was split into triangles.
        const weight = angles[other];
        x += faceNormals[f * 3] * weight; y += faceNormals[f * 3 + 1] * weight; z += faceNormals[f * 3 + 2] * weight;
      }
      const length = Math.hypot(x, y, z);
      if (length > 0) normals.set([x / length, y / length, z / length], corner * 3);
    }
  }
  cache.set(positions, { normals, creaseDegrees });
  return normals;
}

/** Normals uploaded for display; generated concepts are smoothed, imported scans keep theirs. */
export function displayNormals(part: ModelPart): { normals: Float32Array; mode: 'source' | 'smoothed-display' } {
  return restorationAppearance(part) ? { normals: smoothDisplayNormals(part.positions, part.normals), mode: 'smoothed-display' } : { normals: part.normals, mode: 'source' };
}
