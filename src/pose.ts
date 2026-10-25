import { Box3, Euler, Matrix4, Vector3 } from 'three';
import type { ModelPart, ScanRole, Vec3 } from './models.ts';

export const roleLabels: Record<ScanRole, string> = { model: 'Other mesh', upper: 'Upper arch', lower: 'Lower arch', bite: 'Bite reference' };

export function inferScanRole(fileName: string): ScanRole {
  const name = fileName.replace(/\.[^.]+$/, '').toLowerCase();
  if (/^bite(?:[\s_-]*\d+)?$/.test(name)) return 'bite';
  if (/^upper(?:[\s_-].*)?$/.test(name)) return 'upper';
  if (/^lower(?:[\s_-].*)?$/.test(name)) return 'lower';
  return 'model';
}

/** File coordinates stay immutable; only the displayed/analysed rigid pose changes. */
export function partMatrix(part: ModelPart): Matrix4 {
  const base = part.pose ? new Matrix4().fromArray(part.pose) : new Matrix4();
  const rotation = part.rotation ?? [0, 0, 0];
  if (rotation.some(value => value !== 0)) {
    const bounds = new Box3();
    const point = new Vector3();
    for (let i = 0; i < part.positions.length; i += 3) bounds.expandByPoint(point.fromArray(part.positions, i));
    const pivot = bounds.getCenter(point).applyMatrix4(base);
    const r = new Matrix4().makeRotationFromEuler(new Euler(...rotation.map(value => value * Math.PI / 180) as Vec3));
    base.premultiply(new Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
    base.premultiply(r).premultiply(new Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z));
  }
  return base.premultiply(new Matrix4().makeTranslation(...part.offset));
}

export function posedPositions(part: ModelPart): Float64Array {
  const matrix = partMatrix(part);
  const positions = new Float64Array(part.positions.length);
  const point = new Vector3();
  for (let i = 0; i < positions.length; i += 3) {
    point.fromArray(part.positions, i).applyMatrix4(matrix).toArray(positions, i);
  }
  return positions;
}
