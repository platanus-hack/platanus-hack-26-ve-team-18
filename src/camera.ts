import { Box3, PerspectiveCamera, Quaternion, Vector3 } from 'three';

/** OrbitControls normally forces an off-centre pivot onto the optical axis.
 * Retain the angular offset so selecting a surface pivot does not move the view. */
export class InspectionCamera extends PerspectiveCamera {
  private orbitOffset = new Quaternion();

  override lookAt(target: Vector3): void;
  override lookAt(x: number, y: number, z: number): void;
  override lookAt(targetOrX: Vector3 | number, y?: number, z?: number) {
    if (typeof targetOrX === 'number') super.lookAt(targetOrX, y!, z!);
    else super.lookAt(targetOrX);
    this.quaternion.multiply(this.orbitOffset);
  }

  preservePoseAtPivot(pivot: Vector3) {
    const orientation = this.quaternion.clone();
    super.lookAt(pivot);
    this.orbitOffset.copy(this.quaternion).invert().multiply(orientation);
    this.quaternion.copy(orientation);
  }

  aimAt(pivot: Vector3) {
    this.orbitOffset.identity();
    this.lookAt(pivot);
  }
}

/** Fit all eight bounds corners in the current view, including their depth.
 * The camera orientation and the file's coordinate system stay unchanged. */
export function fitCameraToBounds(camera: InspectionCamera, bounds: Box3, padding = 1.12) {
  if (bounds.isEmpty()) return null;
  const target = bounds.getCenter(new Vector3());
  const radius = Math.max(bounds.getSize(new Vector3()).length() / 2, 1e-6);
  const inverse = camera.quaternion.clone().invert();
  const tanY = Math.tan(camera.getEffectiveFOV() * Math.PI / 360);
  const tanX = tanY * Math.max(camera.aspect, 1e-6);
  const corner = new Vector3();
  let distance = radius * 0.02;
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        corner.set(x, y, z).sub(target).applyQuaternion(inverse);
        distance = Math.max(distance, corner.z + Math.max(Math.abs(corner.x) / tanX, Math.abs(corner.y) / tanY) * padding, corner.z + radius * 0.02);
      }
    }
  }
  camera.position.set(0, 0, distance).applyQuaternion(camera.quaternion).add(target);
  camera.preservePoseAtPivot(target);
  camera.updateMatrixWorld(true);
  return { target, radius, distance };
}
