import { Box3, Vector3 } from 'three';
import { createFitIntersectionQuery } from './restoration-fit-intersections.ts';

export type FitIntersectionMeasurement = ReturnType<ReturnType<typeof createFitIntersectionQuery>['test']>;
export interface FitVerificationMeasurement extends FitIntersectionMeasurement {
  /** Target faces retained for the bounded pair audit after broadphase screening. */
  verificationRetainedTriangles: number;
}
export interface FitVerificationControl { check?: () => void; yieldControl?: () => Promise<void> }

const faceBox = (positions: Float32Array, face: number, box: Box3) => {
  const o = face * 9;
  box.min.set(Math.min(positions[o], positions[o + 3], positions[o + 6]), Math.min(positions[o + 1], positions[o + 4], positions[o + 7]), Math.min(positions[o + 2], positions[o + 5], positions[o + 8]));
  box.max.set(Math.max(positions[o], positions[o + 3], positions[o + 6]), Math.max(positions[o + 1], positions[o + 4], positions[o + 7]), Math.max(positions[o + 2], positions[o + 5], positions[o + 8]));
  return box;
};
// Identical to the box predicate in restoration-fit-intersections.ts.
const overlaps = (a: Box3, b: Box3, epsilon: number) => a.min.x <= b.max.x + epsilon && a.max.x + epsilon >= b.min.x &&
  a.min.y <= b.max.y + epsilon && a.max.y + epsilon >= b.min.y && a.min.z <= b.max.z + epsilon && a.max.z + epsilon >= b.min.z;
const scratchA = new Vector3(), scratchB = new Vector3();
// Same zero-area test as Triangle.getArea() > 0 in the sampled query.
const nondegenerate = (positions: Float32Array, face: number) => {
  const o = face * 9;
  scratchA.set(positions[o + 6] - positions[o + 3], positions[o + 7] - positions[o + 4], positions[o + 8] - positions[o + 5]);
  scratchB.set(positions[o] - positions[o + 3], positions[o + 1] - positions[o + 4], positions[o + 2] - positions[o + 5]);
  return scratchA.cross(scratchB).length() * .5 > 0;
};
const finiteFace = (positions: Float32Array, face: number) => {
  for (let i = face * 9; i < face * 9 + 9; i++) if (!Number.isFinite(positions[i])) return false;
  return true;
};
const pack = (positions: Float32Array, faces: number[]) => {
  const out = new Float32Array(faces.length * 9);
  faces.forEach((face, i) => out.set(positions.subarray(face * 9, face * 9 + 9), i * 9));
  return out;
};

/** Retained target faces above this need a large uninterruptible BVH sort; return null instead. */
export const MAX_VERIFIED_TARGET_FACES = 20_000;
const YIELD_FACES = 8192;

/**
 * Complete follow-up to the sampled createFitIntersectionQuery audit. Every
 * target face is screened, without sampling, against the union box of the
 * nondegenerate source faces using the full-target tolerance and the same
 * epsilon-expanded box predicate as the sampled query. An excluded face fails
 * that predicate against the union box and therefore against every source face
 * box inside it (min/max are exact in float64), so the complete query would
 * never pair-test it either. Retained target faces, and the source faces that
 * can reach them, then go through the existing SAT query with its tolerance
 * floored at the full-target value (a subset box would otherwise shrink it and
 * under-report touching contact). The existing 200k pair cap still applies.
 *
 * Output matches createFitIntersectionQuery(target, total).test(source), with:
 * - intersectionTestedTriangles: every nondegenerate target face, all of which
 *   were screened (broadphase-excluded or retained for the pair audit). Not a sample count.
 * - verificationRetainedTriangles: the subset retained for the pair audit.
 *
 * Returns null when more than MAX_VERIFIED_TARGET_FACES are retained: an honest
 * "could not complete"; callers keep their original evidence. Degenerate target
 * or source faces, or the pair cap, keep intersectionComplete false like the
 * sampled query; a fully degenerate target is an incomplete zero. Inputs are
 * never mutated.
 */
export async function verifyFitIntersections(source: Float32Array, target: Float32Array, control: FitVerificationControl = {}): Promise<FitVerificationMeasurement | null> {
  const check = control.check ?? (() => {});
  check();
  if (!(target instanceof Float32Array) || !target.length || target.length % 9) throw new Error('Intersection targets require finite, nonempty triangle-soup positions.');
  if (!(source instanceof Float32Array) || source.length % 9) throw new Error('Intersection source requires finite complete triangles.');
  const pause = async () => { check(); if (control.yieldControl) { await control.yieldControl(); check(); } };
  const box = new Box3();
  const targetTotal = target.length / 9, sourceTotal = source.length / 9;

  // Pass 1: validate, flag nondegenerate faces, and bound each mesh.
  const targetValid = new Uint8Array(targetTotal), sourceValid = new Uint8Array(sourceTotal);
  const targetBox = new Box3(), sourceBox = new Box3();
  let targetDegenerate = false, sourceDegenerate = false, targetFaces = 0;
  for (let face = 0; face < targetTotal; face++) {
    if (face && face % YIELD_FACES === 0) await pause();
    if (!finiteFace(target, face)) throw new Error('Intersection targets require finite, nonempty triangle-soup positions.');
    if (!nondegenerate(target, face)) { targetDegenerate = true; continue; }
    targetValid[face] = 1; targetFaces++;
    targetBox.union(faceBox(target, face, box));
  }
  for (let face = 0; face < sourceTotal; face++) {
    if (face && face % YIELD_FACES === 0) await pause();
    if (!finiteFace(source, face)) throw new Error('Intersection source requires finite complete triangles.');
    if (!nondegenerate(source, face)) { sourceDegenerate = true; continue; }
    sourceValid[face] = 1;
    sourceBox.union(faceBox(source, face, box));
  }
  // Same formula and box as createFitIntersectionQuery over every target face.
  const extent = targetBox.isEmpty() ? 0 : targetBox.getSize(new Vector3()).length();
  const magnitude = targetBox.isEmpty() ? 0 : Math.max(...targetBox.min.toArray().map(Math.abs), ...targetBox.max.toArray().map(Math.abs));
  const epsilon = Math.max(extent, magnitude) * Number.EPSILON * 64 + Number.MIN_VALUE;
  const incomplete = targetDegenerate || sourceDegenerate;

  // Pass 2: conservative broadphase over all target faces.
  const retained: number[] = [], retainedBox = new Box3();
  if (!sourceBox.isEmpty()) for (let face = 0; face < targetTotal; face++) {
    if (face && face % YIELD_FACES === 0) await pause();
    if (!targetValid[face] || !overlaps(sourceBox, faceBox(target, face, box), epsilon)) continue;
    if (retained.length >= MAX_VERIFIED_TARGET_FACES) { check(); return null; }
    retained.push(face);
    retainedBox.union(box);
  }
  if (!retained.length) {
    check();
    return { intersectingTriangles: 0, intersectionTestedTriangles: targetFaces, intersectionComplete: !incomplete,
      transverseCrossingTriangles: 0, touchingOrAmbiguousTriangles: 0, intersectionPairTests: 0, intersectionTolerance: epsilon,
      verificationRetainedTriangles: 0 };
  }
  // Source faces outside the retained union box cannot pass any per-pair box test.
  const nearby: number[] = [];
  for (let face = 0; face < sourceTotal; face++) {
    if (face && face % YIELD_FACES === 0) await pause();
    if (sourceValid[face] && overlaps(faceBox(source, face, box), retainedBox, epsilon)) nearby.push(face);
  }
  await pause();
  const query = createFitIntersectionQuery(pack(target, retained), retained.length, check, epsilon);
  await pause();
  const measured = query.test(pack(source, nearby));
  check();
  return { ...measured, intersectionTestedTriangles: targetFaces, intersectionComplete: measured.intersectionComplete && !incomplete,
    verificationRetainedTriangles: retained.length };
}
