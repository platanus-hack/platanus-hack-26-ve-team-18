import { Matrix4, Vector3, type Box3, type PerspectiveCamera } from 'three';

export interface ScreenBounds { left: number; top: number; right: number; bottom: number }
export interface ProjectionTarget { bounds: Box3; matrixWorld: Matrix4 }

/** Project displayed local bounds through their actual world transforms, including scene centering.
 * Clip depth before dividing by perspective so a near-plane crossing never mirrors the anchor.
 * These are presentation bounds, not a surface visibility/contact measurement.
 */
export function projectMeshBounds(targets: Iterable<ProjectionTarget>, camera: PerspectiveCamera, width: number, height: number): ScreenBounds | null {
  if (![width, height, camera.near, camera.far].every(Number.isFinite) || width <= 0 || height <= 0 || camera.near <= 0 || camera.far <= camera.near) return null;
  let result: ScreenBounds | null = null;
  for (const { bounds, matrixWorld } of targets) {
    if (bounds.isEmpty()) continue;
    const toCamera = new Matrix4().multiplyMatrices(camera.matrixWorldInverse, matrixWorld);
    const corners = Array.from({ length: 8 }, (_, i) => new Vector3(
      i & 1 ? bounds.max.x : bounds.min.x,
      i & 2 ? bounds.max.y : bounds.min.y,
      i & 4 ? bounds.max.z : bounds.min.z,
    ).applyMatrix4(toCamera));
    if (corners.some(point => !point.toArray().every(Number.isFinite))) continue;
    const clipped = corners.filter(point => point.z <= -camera.near && point.z >= -camera.far);
    for (let i = 0; i < corners.length; i++) for (const axis of [1, 2, 4]) {
      if (i & axis) continue;
      const start = corners[i], end = corners[i | axis];
      for (const depth of [-camera.near, -camera.far]) {
        const t = (depth - start.z) / (end.z - start.z);
        if (t > 0 && t < 1) clipped.push(start.clone().lerp(end, t));
      }
    }
    if (!clipped.length) continue;
    let left = Infinity, top = -Infinity, right = -Infinity, bottom = Infinity;
    for (const point of clipped) {
      point.applyMatrix4(camera.projectionMatrix);
      left = Math.min(left, point.x); right = Math.max(right, point.x);
      top = Math.max(top, point.y); bottom = Math.min(bottom, point.y);
    }
    if (![left, top, right, bottom].every(Number.isFinite) || right < -1 || left > 1 || top < -1 || bottom > 1) continue;
    const projected = {
      left: (Math.max(-1, left) + 1) * width / 2, right: (Math.min(1, right) + 1) * width / 2,
      top: (1 - Math.min(1, top)) * height / 2, bottom: (1 - Math.max(-1, bottom)) * height / 2,
    };
    result = result ? {
      left: Math.min(result.left, projected.left), top: Math.min(result.top, projected.top),
      right: Math.max(result.right, projected.right), bottom: Math.max(result.bottom, projected.bottom),
    } : projected;
  }
  return result;
}

/** Prefer the mesh's right edge, flip left when needed, then clamp to the usable canvas. */
export function placeFloatingControls(target: ScreenBounds | null, available: ScreenBounds, width: number, height: number) {
  const maxX = Math.max(available.left, available.right - width);
  const maxY = Math.max(available.top, available.bottom - height);
  let x = maxX, y = available.top;
  if (target && Object.values(target).every(Number.isFinite)) {
    const right = target.right + 14, left = target.left - width - 14;
    x = right <= maxX ? right : left >= available.left ? left
      : available.right - target.right >= target.left - available.left ? right : left;
    y = (target.top + target.bottom - height) / 2;
  }
  return { x: Math.max(available.left, Math.min(maxX, x)), y: Math.max(available.top, Math.min(maxY, y)) };
}
