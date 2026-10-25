import { Vector3 } from 'three';
import type { ModelPart, Vec3 } from './models.ts';
import { partMatrix } from './pose.ts';

/** An actual triangle hit in file coordinates, attached to this geometry revision. */
export interface MeasurementAnchor {
  partId: string;
  face: number;
  point: Vec3;
  sourcePositions: Float32Array;
}
export interface MeasurementPoint { partId: string; face: number; name: string; position: Vec3 }
export interface Measurement { points: MeasurementPoint[]; distance: number | null }
export interface RulerState extends Measurement {
  enabled: boolean;
  cleared: boolean;
  screenPoints: ([number, number] | null)[];
}
export const emptyRuler: RulerState = { enabled: false, cleared: false, points: [], distance: null, screenPoints: [] };

/** No vertex snapping, surface sampling, screen scaling, or physical-unit inference. */
export function resolveMeasurement(anchors: readonly MeasurementAnchor[], parts: ReadonlyMap<string, ModelPart>): Measurement | null {
  const points: MeasurementPoint[] = [];
  const matrices = new Map<string, ReturnType<typeof partMatrix>>();
  for (const anchor of anchors) {
    const part = parts.get(anchor.partId);
    if (!part || part.reference || part.role === 'bite' || part.positions !== anchor.sourcePositions
      || !Number.isInteger(anchor.face) || anchor.face < 0 || anchor.face >= part.triangles
      || !anchor.point.every(Number.isFinite)) return null;
    let matrix = matrices.get(part.id);
    if (!matrix) { matrix = partMatrix(part); matrices.set(part.id, matrix); }
    const position = new Vector3(...anchor.point).applyMatrix4(matrix).toArray() as Vec3;
    if (!position.every(Number.isFinite)) return null;
    points.push({ partId: part.id, face: anchor.face, name: part.name, position });
  }
  const distance = points.length === 2 ? new Vector3(...points[0].position).distanceTo(new Vector3(...points[1].position)) : null;
  return { points, distance };
}

export function formatMeasurement(distance: number): string {
  // Preserve meaningful small distances instead of rounding them to zero.
  return distance !== 0 && (distance < 0.001 || distance >= 1e6) ? distance.toExponential(3) : distance.toFixed(3);
}

/** The explicit case scan scale, or null when the physical scale is unset. */
export function scanScale(mmPerUnit: number | null | undefined): number | null {
  return typeof mmPerUnit === 'number' && Number.isFinite(mmPerUnit) && mmPerUnit > 0 ? mmPerUnit : null;
}

/** Display conversion only: preserve source coordinates and the raw measurement. */
export function measurementLabel(distance: number, mmPerUnit: number | null): string {
  const scale = scanScale(mmPerUnit);
  return `${formatMeasurement(scale === null ? distance : distance * scale)} ${scale === null ? 'file units' : 'mm'}`;
}

/** File-unit length shown in mm to the nearest micrometre when the scale is set.
 * Tiny nonzero values keep three significant digits instead of reading as 0. */
export function lengthToDisplay(value: number, mmPerUnit: number | null | undefined): number {
  const scale = scanScale(mmPerUnit);
  if (scale === null) return value;
  const mm = value * scale, rounded = Number(mm.toFixed(3));
  return rounded === 0 && mm !== 0 ? Number(mm.toPrecision(3)) : rounded;
}

/** Entered length back to file units; geometry is never rescaled. */
export function lengthFromDisplay(value: number, mmPerUnit: number | null | undefined): number {
  const scale = scanScale(mmPerUnit);
  return scale === null ? value : Number((value / scale).toPrecision(15));
}
