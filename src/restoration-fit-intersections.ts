import { Box3, Triangle, Vector3 } from 'three';

interface Node { box: Box3; faces?: number[]; left?: Node; right?: Node }
const read = (positions: Float32Array, face: number, triangle: Triangle) => {
  triangle.a.fromArray(positions, face * 9);
  triangle.b.fromArray(positions, face * 9 + 3);
  triangle.c.fromArray(positions, face * 9 + 6);
  return triangle;
};
const overlaps = (a: Box3, b: Box3, epsilon: number) => a.min.x <= b.max.x + epsilon && a.max.x + epsilon >= b.min.x &&
  a.min.y <= b.max.y + epsilon && a.max.y + epsilon >= b.min.y && a.min.z <= b.max.z + epsilon && a.max.z + epsilon >= b.min.z;

/**
 * Bounded triangle SAT audit. Touching and coplanar contact count as crossing
 * evidence. The target cap is a deterministic spread over original face order;
 * zero in an incomplete audit is never evidence of an intersection-free mesh.
 * Uses the same SAT axes as collision.ts; the existing exported nearest query
 * is reused separately for distances, without rebuilding it for each candidate.
 */
export function createFitIntersectionQuery(positions: Float32Array, limit: number, check: () => void, minimumTolerance = 0) {
  if (!(positions instanceof Float32Array) || !positions.length || positions.length % 9 || !positions.every(Number.isFinite)) throw new Error('Intersection targets require finite, nonempty triangle-soup positions.');
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Intersection target limit must be a positive safe integer.');
  if (!(minimumTolerance >= 0 && Number.isFinite(minimumTolerance))) throw new Error('Intersection minimum tolerance must be finite and nonnegative.');
  const total = positions.length / 9, selected = Math.min(total, limit);
  const triangle = new Triangle(), other = new Triangle(), normalA = new Vector3(), normalB = new Vector3(), axis = new Vector3();
  const edgesA = [new Vector3(), new Vector3(), new Vector3()], edgesB = [new Vector3(), new Vector3(), new Vector3()];
  const boxes = new Map<number, Box3>();
  let degenerate = false;
  const faces: number[] = [];
  for (let i = 0; i < selected; i++) {
    if ((i & 255) === 0) check();
    const face = Math.floor((i + 0.5) * total / selected);
    read(positions, face, triangle);
    if (!(triangle.getArea() > 0)) { degenerate = true; continue; }
    faces.push(face);
    boxes.set(face, new Box3().setFromPoints([triangle.a, triangle.b, triangle.c]));
  }
  const boxOf = (face: number) => {
    const box = boxes.get(face);
    if (!box) throw new Error('Intersection audit face bound is missing.');
    return box;
  };
  function build(indices: number[]): Node {
    check();
    const box = new Box3();
    for (const face of indices) box.union(boxOf(face));
    if (indices.length <= 8) return { box, faces: indices };
    const size = box.getSize(new Vector3()), dimension = size.x >= size.y && size.x >= size.z ? 'x' : size.y >= size.z ? 'y' : 'z';
    indices.sort((a, b) => boxOf(a).min[dimension] + boxOf(a).max[dimension] - boxOf(b).min[dimension] - boxOf(b).max[dimension]);
    const middle = Math.floor(indices.length / 2);
    return { box, left: build(indices.slice(0, middle)), right: build(indices.slice(middle)) };
  }
  const root = build(faces);
  const extent = root.box.isEmpty() ? 0 : root.box.getSize(new Vector3()).length();
  const magnitude = root.box.isEmpty() ? 0 : Math.max(...root.box.min.toArray().map(Math.abs), ...root.box.max.toArray().map(Math.abs));
  // Float32 source values are the surfaces being tested, not uncertain clinical
  // measurements. A 1e-9 * whole-arch extent tolerance falsely joined separated
  // small faces when a target also contained very long triangles.
  // minimumTolerance lets a subset audit keep its parent mesh's tolerance.
  const epsilon = Math.max(Math.max(extent, magnitude) * Number.EPSILON * 64 + Number.MIN_VALUE, minimumTolerance);

  function intersects(a: Triangle, b: Triangle) {
    a.getNormal(normalA); b.getNormal(normalB);
    edgesA[0].subVectors(a.b, a.a); edgesA[1].subVectors(a.c, a.b); edgesA[2].subVectors(a.a, a.c);
    edgesB[0].subVectors(b.b, b.a); edgesB[1].subVectors(b.c, b.b); edgesB[2].subVectors(b.a, b.c);
    const separated = (direction: Vector3) => {
      const length = direction.length();
      if (length === 0) return false;
      const project = (p: Vector3) => ((p.x - a.a.x) * direction.x + (p.y - a.a.y) * direction.y + (p.z - a.a.z) * direction.z) / length;
      const a1 = project(a.b), a2 = project(a.c), b0 = project(b.a), b1 = project(b.b), b2 = project(b.c);
      return Math.max(0, a1, a2) < Math.min(b0, b1, b2) - epsilon || Math.max(b0, b1, b2) < Math.min(0, a1, a2) - epsilon;
    };
    if (separated(normalA) || separated(normalB)) return 0;
    for (const aEdge of edgesA) for (const bEdge of edgesB) if (separated(axis.crossVectors(aEdge, bEdge))) return 0;
    for (const edge of edgesA) if (separated(axis.crossVectors(normalA, edge))) return 0;
    for (const edge of edgesB) if (separated(axis.crossVectors(normalB, edge))) return 0;
    const straddles = (t: Triangle, origin: Vector3, normal: Vector3) => {
      const signed = (p: Vector3) => (p.x - origin.x) * normal.x + (p.y - origin.y) * normal.y + (p.z - origin.z) * normal.z;
      const values = [signed(t.a), signed(t.b), signed(t.c)];
      return Math.min(...values) < -epsilon && Math.max(...values) > epsilon;
    };
    // Strict straddling of both planes is transverse crossing evidence. All
    // other hits include coplanar/edge/vertex contact and ambiguous tangencies;
    // neither category measures penetration depth or a solid interior.
    return straddles(a, b.a, normalB) && straddles(b, a.a, normalA) ? 2 : 1;
  }
  return {
    test(source: Float32Array) {
      if (!(source instanceof Float32Array) || source.length % 9 || !source.every(Number.isFinite)) throw new Error('Intersection source requires finite complete triangles.');
      const sourceBox = new Box3(), targetsHit = new Set<number>(), targetsCrossed = new Set<number>(), targetsTouched = new Set<number>();
      let sourceHit = 0, sourceCrossed = 0, sourceTouched = 0, tests = 0, completed = true, sourceDegenerate = false;
      // Pair-test cap prevents coincident dense patches from exhausting a job.
      const pairLimit = 200_000;
      for (let face = 0; face < source.length / 9; face++) {
        if ((face & 127) === 0) check();
        read(source, face, triangle);
        if (!(triangle.getArea() > 0)) { sourceDegenerate = true; continue; }
        sourceBox.setFromPoints([triangle.a, triangle.b, triangle.c]);
        let hit = false, crossed = false, touched = false;
        function visit(node: Node) {
          if (!completed || !overlaps(sourceBox, node.box, epsilon)) return;
          if (node.faces) for (const target of node.faces) {
            if (!overlaps(sourceBox, boxOf(target), epsilon)) continue;
            if (tests >= pairLimit) { completed = false; return; }
            tests++;
            if ((tests & 1023) === 0) check();
            const relationship = intersects(triangle, read(positions, target, other));
            if (relationship) { hit = true; targetsHit.add(target); }
            if (relationship === 2) { crossed = true; targetsCrossed.add(target); }
            if (relationship === 1) { touched = true; targetsTouched.add(target); }
          }
          else {
            if (node.left) visit(node.left);
            if (node.right) visit(node.right);
          }
        }
        visit(root);
        if (hit) sourceHit++;
        if (crossed) sourceCrossed++;
        if (touched) sourceTouched++;
        if (!completed) break;
      }
      return { intersectingTriangles: sourceHit + targetsHit.size, intersectionTestedTriangles: faces.length,
        intersectionComplete: completed && selected === total && !degenerate && !sourceDegenerate,
        transverseCrossingTriangles: sourceCrossed + targetsCrossed.size,
        touchingOrAmbiguousTriangles: sourceTouched + targetsTouched.size,
        intersectionPairTests: tests, intersectionTolerance: epsilon };
    },
  };
}
