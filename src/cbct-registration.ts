import { Matrix4, Quaternion, Vector3 } from 'three';
import type { ModelPart, Vec3 } from './models.ts';
import { partMatrix } from './pose.ts';

export interface CbctLandmarkPair { source: Vec3; target: Vec3 }
export interface CbctArchRegistration {
  arch: 'upper' | 'lower';
  volumeId: string;
  mmPerUnit: number;
  rmsMm: number;
  residualsMm: number[];
  reviewed: boolean;
  method?: 'landmarks' | 'surface';
  /** Saved current-pose dependency; appearance changes do not invalidate it. */
  poses: { id: string; matrix: number[]; role: string; positions: Float32Array }[];
  before: { id: string; pose?: number[]; offset: Vec3; rotation?: Vec3 }[];
}

/** Move a whole scan assembly together; never recenter individual source files. */
export function applyCbctRigidDelta(parts: readonly ModelPart[], matrix: readonly number[]): ModelPart[] {
  const delta = new Matrix4().fromArray(matrix);
  return parts.map(part => ({ ...part, pose: delta.clone().multiply(partMatrix(part)).toArray(), offset: [0, 0, 0], rotation: [0, 0, 0] }));
}

/** Appearance changes are harmless; a different source or pose invalidates a fit. */
export function cbctPoseMatches(saved: readonly ModelPart[], parts: readonly ModelPart[]) {
  return saved.length === parts.length && saved.every(before => {
    const part = parts.find(part => part.id === before.id);
    if (!part || part.positions !== before.positions || part.role !== before.role) return false;
    const previous = partMatrix(before).elements;
    return partMatrix(part).elements.every((value, i) => Math.abs(value - previous[i]) < 1e-9);
  });
}

/** Pose edits invalidate review but still permit restoring the same source assembly. */
export function cbctSourcesMatch(saved: readonly ModelPart[], parts: readonly ModelPart[]) {
  return saved.length === parts.length && saved.every(before => parts.some(part => part.id === before.id && part.positions === before.positions && part.role === before.role));
}

/** Retain original reset poses across source removals and metadata changes. */
export function cbctResetParts(saved: readonly ModelPart[], parts: readonly ModelPart[]): ModelPart[] {
  return parts.map(part => {
    const original = saved.find(before => before.id === part.id && before.positions === part.positions);
    return original ? { ...part, pose: original.pose, offset: [...original.offset], rotation: original.rotation ? [...original.rotation] : undefined } : part;
  });
}

/** New files inherit an established common registration, keeping shared file coordinates. */
export function cbctAssemblyDelta(before: readonly ModelPart[], after: readonly ModelPart[]): number[] | null {
  if (!before.length || !cbctSourcesMatch(before, after)) return null;
  const original = before.map(part => partMatrix(part));
  const posed = before.map(part => partMatrix(after.find(next => next.id === part.id)!));
  const delta = posed[0].clone().multiply(original[0].clone().invert());
  if (!posed.every((matrix, index) => {
    const expected = delta.clone().multiply(original[index]).elements;
    return matrix.elements.every((value, i) => Math.abs(value - expected[i]) < 1e-8);
  })) return null;
  return delta.toArray();
}

/** A reviewed subset cannot stand in for an entire imported scan assembly. */
export function cbctAssemblyRegistered(records: readonly Pick<CbctArchRegistration, 'arch'>[], parts: readonly ModelPart[]) {
  const scans = parts.filter(part => part.role !== 'bite' && !part.reference && !part.restoration);
  return scans.length > 0 && scans.every(part => records.some(record => record.arch === part.role));
}

function principalQuaternion(input: number[]) {
  const a = input.slice(), eigenvectors = Array<number>(16).fill(0);
  for (let i = 0; i < 4; i++) eigenvectors[i * 4 + i] = 1;
  for (let iteration = 0; iteration < 100; iteration++) {
    let p = 0, q = 1, magnitude = 0;
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
      if (Math.abs(a[i * 4 + j]) > magnitude) { p = i; q = j; magnitude = Math.abs(a[i * 4 + j]); }
    }
    const scale = Math.max(...a.map(Math.abs), Number.MIN_VALUE);
    if (magnitude < scale * 1e-14) break;
    const angle = .5 * Math.atan2(2 * a[p * 4 + q], a[q * 4 + q] - a[p * 4 + p]);
    const c = Math.cos(angle), s = Math.sin(angle), app = a[p * 4 + p], aqq = a[q * 4 + q], apq = a[p * 4 + q];
    for (let k = 0; k < 4; k++) if (k !== p && k !== q) {
      const akp = a[k * 4 + p], akq = a[k * 4 + q];
      a[k * 4 + p] = a[p * 4 + k] = c * akp - s * akq;
      a[k * 4 + q] = a[q * 4 + k] = s * akp + c * akq;
    }
    a[p * 4 + p] = c * c * app - 2 * c * s * apq + s * s * aqq;
    a[q * 4 + q] = s * s * app + 2 * c * s * apq + c * c * aqq;
    a[p * 4 + q] = a[q * 4 + p] = 0;
    for (let k = 0; k < 4; k++) {
      const vkp = eigenvectors[k * 4 + p], vkq = eigenvectors[k * 4 + q];
      eigenvectors[k * 4 + p] = c * vkp - s * vkq;
      eigenvectors[k * 4 + q] = s * vkp + c * vkq;
    }
  }
  const largest = [0, 1, 2, 3].reduce((best, i) => a[i * 4 + i] > a[best * 4 + best] ? i : best, 0);
  return new Quaternion(eigenvectors[4 + largest], eigenvectors[8 + largest], eigenvectors[12 + largest], eigenvectors[largest]).normalize();
}

function checkSpread(points: Vector3[]) {
  let extent = 0, area = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i].clone().sub(points[0]); extent = Math.max(extent, a.lengthSq());
    for (let j = i + 1; j < points.length; j++) area = Math.max(area, a.clone().cross(points[j].clone().sub(points[0])).lengthSq());
  }
  if (!(extent > 1e-12) || area < extent * extent * 1e-6) throw new Error('Choose well-spread, noncollinear matching landmarks across the arch.');
}

/** Landmark fit only: rigid, no rescaling, reflection, deformation, or anatomical inference. */
export function registerCbctLandmarks(pairs: readonly CbctLandmarkPair[], mmPerUnit: number) {
  if (!Number.isFinite(mmPerUnit) || mmPerUnit <= 0 || mmPerUnit > 1e6) throw new Error('Confirm a positive millimetres-per-file-unit scale before registration.');
  if (pairs.length < 3 || pairs.length > 32 || pairs.some(pair => [...pair.source, ...pair.target].length !== 6 || ![...pair.source, ...pair.target].every(Number.isFinite))) throw new Error('Registration needs 3–32 finite matching landmark pairs.');
  const source = pairs.map(pair => new Vector3(...pair.source));
  const target = pairs.map(pair => new Vector3(...pair.target).multiplyScalar(1 / mmPerUnit));
  checkSpread(source); checkSpread(target);
  const mean = (points: Vector3[]) => points.reduce((sum, p) => sum.add(p), new Vector3()).multiplyScalar(1 / points.length);
  const from = mean(source), to = mean(target), covariance = Array<number>(9).fill(0);
  for (let i = 0; i < source.length; i++) {
    const p = source[i].clone().sub(from).toArray(), q = target[i].clone().sub(to).toArray();
    for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) covariance[row * 3 + col] += p[row] * q[col];
  }
  const [xx, xy, xz, yx, yy, yz, zx, zy, zz] = covariance;
  const rotation = principalQuaternion([
    xx + yy + zz, yz - zy, zx - xz, xy - yx,
    yz - zy, xx - yy - zz, xy + yx, zx + xz,
    zx - xz, xy + yx, -xx + yy - zz, yz + zy,
    xy - yx, zx + xz, yz + zy, -xx - yy + zz,
  ]);
  const matrix = new Matrix4().makeRotationFromQuaternion(rotation);
  matrix.setPosition(to.clone().sub(from.clone().applyQuaternion(rotation)));
  const residualsMm = source.map((p, i) => p.clone().applyMatrix4(matrix).distanceTo(target[i]) * mmPerUnit);
  return { matrix: matrix.toArray(), residualsMm, rmsMm: Math.sqrt(residualsMm.reduce((sum, r) => sum + r * r, 0) / residualsMm.length) };
}

export function currentCbctRegistrations(records: readonly CbctArchRegistration[], parts: readonly ModelPart[], volumeId: string | undefined, mmPerUnit: number | null) {
  return records.filter(record => record.volumeId === volumeId && record.mmPerUnit === mmPerUnit && record.poses.length > 0 && record.poses.every(saved => {
    const part = parts.find(part => part.id === saved.id);
    return part && part.positions === saved.positions && part.role === saved.role && partMatrix(part).toArray().every((v, i) => Math.abs(v - saved.matrix[i]) < 1e-9);
  }) && parts.filter(part => part.role === record.arch).length === record.poses.length);
}

export function tomographyReferencePart(surface: { positions: Float32Array; normals: Float32Array; origin: Vec3; volumeId: string; triangles: number }, mmPerUnit: number | null, visible: boolean): ModelPart {
  // Without an explicit mesh scale the CBCT may be inspected alone in its native mm frame.
  const scale = mmPerUnit && mmPerUnit > 0 ? 1 / mmPerUnit : 1;
  const matrix = new Matrix4().makeScale(scale, scale, scale).setPosition(...surface.origin.map(v => v * scale) as Vec3);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < surface.positions.length; i++) { min[i % 3] = Math.min(min[i % 3], surface.positions[i]); max[i % 3] = Math.max(max[i % 3], surface.positions[i]); }
  return { id: `cbct-reference-${surface.volumeId}`, name: 'CBCT threshold surface', fileName: '', reference: 'tomography', positions: surface.positions, normals: surface.normals, pose: matrix.toArray(), offset: [0, 0, 0], closed: false, visible, role: 'model', presentationColor: '#c5d8df', triangles: surface.triangles, vertices: surface.positions.length / 3, dimensions: min.map((v, i) => Number.isFinite(v) ? (max[i] - v) * scale : 0) as Vec3 };
}
