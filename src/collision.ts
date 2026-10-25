import { Box3, Ray, Triangle, Vector3 } from 'three';

export interface CollisionPart {
  id: string;
  positions: Float32Array | Float64Array;
  /** Caller has verified that this is a closed, watertight surface. */
  closed: boolean;
}

export interface PartAnalysis {
  id: string;
  distances: Float32Array;
  intersecting: Uint8Array;
  penetratingVertices: number;
  nearbyVertices: number;
  intersectingTriangles: number;
  maxDepth: number;
}

export interface PairAnalysis {
  a: string;
  b: string;
  /** Number of distinct flagged faces, summed across both parts. */
  intersectingTriangles: number;
  penetratingVertices: number;
  nearbyVertices: number;
  /** Unsigned vertex-sampled surface gap; crossings/contact force zero. */
  minDistance: number;
  maxDepth: number;
}

export interface CollisionReport {
  parts: PartAnalysis[];
  pairs: PairAnalysis[];
  durationMs: number;
}

interface Node {
  box: Box3;
  start: number;
  end: number;
  left?: Node;
  right?: Node;
}

interface BVH {
  part: CollisionPart;
  order: Uint32Array;
  bounds: Float64Array;
  root: Node;
  epsilon: number;
}

// Scratch storage is reused by these synchronous queries (each worker has its own).
const triangle = new Triangle(), otherTriangle = new Triangle();
const point = new Vector3(), closest = new Vector3(), hit = new Vector3();
const barycentric = new Vector3(), edge = new Vector3(), offset = new Vector3();
const ray = new Ray(), axis = new Vector3();
const normalA = new Vector3(), normalB = new Vector3();
const edgesA = [new Vector3(), new Vector3(), new Vector3()];
const edgesB = [new Vector3(), new Vector3(), new Vector3()];
const directions = [
  new Vector3(1, 0.371390676, 0.694137121).normalize(),
  new Vector3(-0.432713219, 1, 0.173205081).normalize(),
  new Vector3(0.237129113, -0.613791337, 1).normalize(),
];

function readTriangle(tree: BVH, index: number, target: Triangle): Triangle {
  const p = tree.part.positions, start = index * 9;
  target.a.fromArray(p, start);
  target.b.fromArray(p, start + 3);
  target.c.fromArray(p, start + 6);
  return target;
}

function build(part: CollisionPart, checkBudget?: () => void): BVH {
  const p = part.positions;
  if (!(p instanceof Float32Array || p instanceof Float64Array) || p.length % 9 !== 0) {
    throw new Error(`Part ${part.id}: positions must contain complete Float32 or Float64 triangles.`);
  }
  const order = new Uint32Array(p.length / 9);
  const bounds = new Float64Array(order.length * 6);
  for (let i = 0; i < order.length; i++) {
    if ((i & 4095) === 0) checkBudget?.();
    order[i] = i;
    for (let a = 0; a < 3; a++) {
      const x = p[i * 9 + a], y = p[i * 9 + a + 3], z = p[i * 9 + a + 6];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
        throw new Error(`Part ${part.id}: positions must be finite.`);
      }
      bounds[i * 6 + a] = Math.min(x, y, z);
      bounds[i * 6 + a + 3] = Math.max(x, y, z);
    }
  }
  function split(start: number, end: number): Node {
    checkBudget?.();
    const box = new Box3();
    for (let i = start; i < end; i++) {
      const b = order[i] * 6;
      box.min.min(point.fromArray(bounds, b));
      box.max.max(point.fromArray(bounds, b + 3));
    }
    const node: Node = { box, start, end };
    if (end - start > 8) {
      const size = box.getSize(point);
      const a = size.x >= size.y && size.x >= size.z ? 0 : size.y >= size.z ? 1 : 2;
      order.subarray(start, end).sort((i, j) =>
        (bounds[i * 6 + a] + bounds[i * 6 + a + 3]) -
        (bounds[j * 6 + a] + bounds[j * 6 + a + 3]));
      const mid = (start + end) >>> 1;
      node.left = split(start, mid);
      node.right = split(mid, end);
    }
    return node;
  }
  const root = split(0, order.length);
  const extent = root.box.getSize(point).length();
  const magnitude = root.box.isEmpty() ? 0 : Math.max(
    ...root.box.min.toArray().map(Math.abs), ...root.box.max.toArray().map(Math.abs));
  return { part, order, bounds, root, epsilon: extent * 1e-10 + magnitude * Number.EPSILON * 16 };
}

function boxDistanceSq(box: Box3, p: Vector3): number {
  const x = Math.max(box.min.x - p.x, 0, p.x - box.max.x);
  const y = Math.max(box.min.y - p.y, 0, p.y - box.max.y);
  const z = Math.max(box.min.z - p.z, 0, p.z - box.max.z);
  return x * x + y * y + z * z;
}

function pointSegmentDistanceSq(p: Vector3, a: Vector3, b: Vector3): number {
  edge.subVectors(b, a);
  const lengthSq = edge.lengthSq();
  const t = lengthSq ? Math.max(0, Math.min(1, offset.subVectors(p, a).dot(edge) / lengthSq)) : 0;
  return closest.copy(a).addScaledVector(edge, t).distanceToSquared(p);
}

function triangleDistanceSq(p: Vector3, t: Triangle): number {
  t.closestPointToPoint(p, closest);
  const distance = closest.distanceToSquared(p);
  // Zero-area faces can produce NaN in the triangle's interior-region formula.
  return Number.isFinite(distance) ? distance : Math.min(
    pointSegmentDistanceSq(p, t.a, t.b), pointSegmentDistanceSq(p, t.b, t.c),
    pointSegmentDistanceSq(p, t.c, t.a));
}

function nearest(tree: BVH, p: Vector3): number {
  let best = Infinity;
  function visit(node: Node): void {
    if (boxDistanceSq(node.box, p) >= best) return;
    if (node.left && node.right) {
      const leftFirst = boxDistanceSq(node.left.box, p) <= boxDistanceSq(node.right.box, p);
      visit(leftFirst ? node.left : node.right);
      visit(leftFirst ? node.right : node.left);
    } else {
      for (let i = node.start; i < node.end; i++) {
        best = Math.min(best, triangleDistanceSq(p, readTriangle(tree, tree.order[i], triangle)));
      }
    }
  }
  visit(tree.root);
  return Math.sqrt(best);
}

export interface NearestSurfaceQuery {
  /** Unsigned distance; Infinity means no face within maxDistance. Targets are caller-owned. */
  nearestPoint(p: Vector3, target: Vector3, normal?: Vector3, maxDistance?: number): number;
  /** First forward triangle hit along a unit direction. Infinity means no observed surface. */
  rayDistance(p: Vector3, direction: Vector3, maxDistance?: number): number;
}

/** Reuses the collision BVH without modifying positions or requiring a closed mesh. */
export function createNearestSurfaceQuery(
  positions: Float32Array | Float64Array, checkBudget?: () => void,
): NearestSurfaceQuery {
  const tree = build({ id: 'surface', positions, closed: false }, checkBudget);
  return {
    rayDistance(p, direction, maxDistance = Infinity) {
      const queryRay = new Ray(p, direction), face = new Triangle(), intersection = new Vector3();
      let best = maxDistance, found = false, visited = 0;
      function visit(node: Node): void {
        if ((++visited & 1023) === 0) checkBudget?.();
        if (boxDistanceSq(node.box, p) > best * best || !queryRay.intersectsBox(node.box)) return;
        if (node.left && node.right) { visit(node.left); visit(node.right); }
        else for (let i = node.start; i < node.end; i++) {
          readTriangle(tree, tree.order[i], face);
          if (queryRay.intersectTriangle(face.a, face.b, face.c, false, intersection)) {
            const distance = p.distanceTo(intersection);
            if (distance <= best) { best = distance; found = true; }
          }
        }
      }
      visit(tree.root);
      return found ? best : Infinity;
    },
    nearestPoint(p, target, normal, maxDistance = Infinity) {
      let best = maxDistance * maxDistance, found = false, visited = 0;
      function visit(node: Node): void {
        if ((++visited & 1023) === 0) checkBudget?.();
        if (boxDistanceSq(node.box, p) > best) return;
        if (node.left && node.right) {
          const leftFirst = boxDistanceSq(node.left.box, p) <= boxDistanceSq(node.right.box, p);
          visit(leftFirst ? node.left : node.right);
          visit(leftFirst ? node.right : node.left);
        } else {
          for (let i = node.start; i < node.end; i++) {
            const t = readTriangle(tree, tree.order[i], triangle);
            t.closestPointToPoint(p, closest);
            let distance = closest.distanceToSquared(p);
            if (!Number.isFinite(distance)) {
              // Keep the winning segment point as well as its distance for zero-area faces.
              let segmentBest = Infinity;
              for (const [a, b] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]]) {
                const candidate = pointSegmentDistanceSq(p, a, b);
                if (candidate < segmentBest) { segmentBest = candidate; hit.copy(closest); }
              }
              distance = segmentBest;
              closest.copy(hit);
            }
            if (distance <= best) {
              best = distance;
              found = true;
              target.copy(closest);
              if (normal) t.getNormal(normal);
            }
          }
        }
      }
      visit(tree.root);
      return found ? Math.sqrt(best) : Infinity;
    },
  };
}

function inside(tree: BVH, p: Vector3): boolean {
  if (!tree.part.closed || !tree.root.box.containsPoint(p)) return false;
  // Retry edge/vertex hits instead of counting shared edges twice or counting tangencies.
  for (const direction of directions) {
    ray.set(p, direction);
    let count = 0, ambiguous = false;
    function visit(node: Node): void {
      if (ambiguous || !ray.intersectsBox(node.box)) return;
      if (node.left && node.right) {
        visit(node.left);
        visit(node.right);
      } else {
        for (let i = node.start; i < node.end; i++) {
          const t = readTriangle(tree, tree.order[i], triangle);
          if (!ray.intersectTriangle(t.a, t.b, t.c, false, hit)) continue;
          t.getBarycoord(hit, barycentric);
          if (Math.min(barycentric.x, barycentric.y, barycentric.z) <= 1e-9) {
            ambiguous = true;
            return;
          }
          count++;
        }
      }
    }
    visit(tree.root);
    if (!ambiguous) return count % 2 === 1;
  }
  return false; // Conservative when every ray grazes a mesh edge.
}

function boxesOverlap(a: Box3, b: Box3, epsilon: number): boolean {
  return a.min.x <= b.max.x + epsilon && a.max.x + epsilon >= b.min.x &&
    a.min.y <= b.max.y + epsilon && a.max.y + epsilon >= b.min.y &&
    a.min.z <= b.max.z + epsilon && a.max.z + epsilon >= b.min.z;
}

function segmentDistanceSq(a: Vector3, b: Vector3, c: Vector3, d: Vector3): number {
  // Closest points of two finite segments, including parallel and zero-length edges.
  const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
  const vx = d.x - c.x, vy = d.y - c.y, vz = d.z - c.z;
  const wx = a.x - c.x, wy = a.y - c.y, wz = a.z - c.z;
  const uu = ux * ux + uy * uy + uz * uz, vv = vx * vx + vy * vy + vz * vz;
  const uv = ux * vx + uy * vy + uz * vz;
  const uw = ux * wx + uy * wy + uz * wz, vw = vx * wx + vy * wy + vz * wz;
  const denom = uu * vv - uv * uv;
  let s = denom > Number.EPSILON * uu * vv ? Math.max(0, Math.min(1, (uv * vw - vv * uw) / denom)) : 0;
  let t = vv ? (uv * s + vw) / vv : 0;
  if (t < 0) { t = 0; s = uu ? Math.max(0, Math.min(1, -uw / uu)) : 0; }
  else if (t > 1) { t = 1; s = uu ? Math.max(0, Math.min(1, (uv - uw) / uu)) : 0; }
  if (!vv) s = uu ? Math.max(0, Math.min(1, -uw / uu)) : 0;
  return (wx + s * ux - t * vx) ** 2 + (wy + s * uy - t * vy) ** 2 + (wz + s * uz - t * vz) ** 2;
}

function segmentHitsTriangle(a: Vector3, b: Vector3, t: Triangle, epsilon: number): boolean {
  const e2 = epsilon * epsilon;
  if (triangleDistanceSq(a, t) <= e2 || triangleDistanceSq(b, t) <= e2) return true;
  edge.subVectors(b, a);
  const length = edge.length();
  if (length > 0) {
    ray.set(a, edge.multiplyScalar(1 / length));
    if (ray.intersectTriangle(t.a, t.b, t.c, false, hit) && a.distanceTo(hit) <= length + epsilon) return true;
  }
  return segmentDistanceSq(a, b, t.a, t.b) <= e2 ||
    segmentDistanceSq(a, b, t.b, t.c) <= e2 || segmentDistanceSq(a, b, t.c, t.a) <= e2;
}

function trianglesIntersect(a: Triangle, b: Triangle, epsilon: number): boolean {
  a.getNormal(normalA);
  b.getNormal(normalB);
  if (normalA.lengthSq() === 0 || normalB.lengthSq() === 0) {
    const flat = normalA.lengthSq() === 0 ? a : b, target = flat === a ? b : a;
    return segmentHitsTriangle(flat.a, flat.b, target, epsilon) ||
      segmentHitsTriangle(flat.b, flat.c, target, epsilon) ||
      segmentHitsTriangle(flat.c, flat.a, target, epsilon);
  }
  edgesA[0].subVectors(a.b, a.a); edgesA[1].subVectors(a.c, a.b); edgesA[2].subVectors(a.a, a.c);
  edgesB[0].subVectors(b.b, b.a); edgesB[1].subVectors(b.c, b.b); edgesB[2].subVectors(b.a, b.c);
  function separated(direction: Vector3): boolean {
    const length = direction.length();
    if (length === 0) return false;
    // Project relative to a local origin to retain precision on translated models.
    const project = (p: Vector3) => ((p.x - a.a.x) * direction.x +
      (p.y - a.a.y) * direction.y + (p.z - a.a.z) * direction.z) / length;
    const a1 = project(a.b), a2 = project(a.c);
    const b0 = project(b.a), b1 = project(b.b), b2 = project(b.c);
    return Math.max(0, a1, a2) < Math.min(b0, b1, b2) - epsilon ||
      Math.max(b0, b1, b2) < Math.min(0, a1, a2) - epsilon;
  }
  if (separated(normalA) || separated(normalB)) return false;
  for (const ea of edgesA) for (const eb of edgesB) {
    if (separated(axis.crossVectors(ea, eb))) return false;
  }
  // Coplanar triangles also need axes within their plane.
  for (const e of edgesA) if (separated(axis.crossVectors(normalA, e))) return false;
  for (const e of edgesB) if (separated(axis.crossVectors(normalB, e))) return false;
  return true;
}

function intersections(a: BVH, b: BVH, flagsA: Uint8Array, flagsB: Uint8Array, epsilon: number): number {
  let count = 0;
  function visit(na: Node, nb: Node): void {
    if (!boxesOverlap(na.box, nb.box, epsilon)) return;
    if (na.left && na.right && (!nb.left || na.end - na.start >= nb.end - nb.start)) {
      visit(na.left, nb); visit(na.right, nb);
    } else if (nb.left && nb.right) {
      visit(na, nb.left); visit(na, nb.right);
    } else {
      for (let i = na.start; i < na.end; i++) {
        const ia = a.order[i];
        readTriangle(a, ia, triangle);
        for (let j = nb.start; j < nb.end; j++) {
          const ib = b.order[j];
          if (flagsA[ia] && flagsB[ib]) continue;
          let overlap = true;
          for (let k = 0; k < 3; k++) {
            if (a.bounds[ia * 6 + k] > b.bounds[ib * 6 + k + 3] + epsilon ||
              b.bounds[ib * 6 + k] > a.bounds[ia * 6 + k + 3] + epsilon) { overlap = false; break; }
          }
          if (overlap && trianglesIntersect(triangle, readTriangle(b, ib, otherTriangle), epsilon)) {
            count += (flagsA[ia] ? 0 : 1) + (flagsB[ib] ? 0 : 1);
            flagsA[ia] = flagsB[ib] = 1;
          }
        }
      }
    }
  }
  visit(a.root, b.root);
  return count;
}

/**
 * Distances use the minimum signed distance to all other parts: any containing
 * target takes precedence, with the deepest target winning. Counts are corners
 * (nonindexed duplicates included). Nearby means outside/on-surface and <= tolerance.
 */
export function analyzeCollisions(parts: CollisionPart[], tolerance: number): CollisionReport {
  const started = performance.now();
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error('Tolerance must be finite and nonnegative.');
  if (new Set(parts.map(p => p.id)).size !== parts.length) throw new Error('Part IDs must be unique.');
  const trees = parts.map(part => build(part));
  const results: PartAnalysis[] = parts.map(p => ({
    id: p.id, distances: new Float32Array(p.positions.length / 3).fill(Infinity),
    intersecting: new Uint8Array(p.positions.length / 9),
    penetratingVertices: 0, nearbyVertices: 0, intersectingTriangles: 0, maxDepth: 0,
  }));
  const pairs: PairAnalysis[] = [];
  for (let a = 0; a < trees.length; a++) for (let b = a + 1; b < trees.length; b++) {
    if (!trees[a].order.length || !trees[b].order.length) continue;
    const epsilon = Math.max(trees[a].epsilon, trees[b].epsilon);
    const pair: PairAnalysis = {
      a: parts[a].id, b: parts[b].id, intersectingTriangles: 0,
      penetratingVertices: 0, nearbyVertices: 0, minDistance: Infinity, maxDepth: 0,
    };
    function sample(source: number, target: number): void {
      const positions = parts[source].positions, result = results[source];
      // Import expands shared vertices into triangle corners. Reuse the expensive
      // surface query for exact duplicate coordinates, retaining all corner counts.
      const samples = new Map<string, number>();
      for (let i = 0; i < positions.length; i += 3) {
        const key = `${positions[i]},${positions[i + 1]},${positions[i + 2]}`;
        let distance = samples.get(key);
        if (distance === undefined) {
          point.fromArray(positions, i);
          distance = nearest(trees[target], point);
          if (distance <= epsilon) distance = 0;
          else if (inside(trees[target], point)) distance = -distance;
          samples.set(key, distance);
        }
        result.distances[i / 3] = Math.min(result.distances[i / 3], distance);
        pair.minDistance = Math.min(pair.minDistance, Math.abs(distance));
        if (distance < 0) { pair.penetratingVertices++; pair.maxDepth = Math.max(pair.maxDepth, -distance); }
        else if (distance <= tolerance) pair.nearbyVertices++;
      }
    }
    sample(a, b); sample(b, a);
    const flagsA = new Uint8Array(trees[a].order.length), flagsB = new Uint8Array(trees[b].order.length);
    pair.intersectingTriangles = intersections(trees[a], trees[b], flagsA, flagsB, epsilon);
    if (pair.intersectingTriangles) pair.minDistance = 0;
    for (let i = 0; i < flagsA.length; i++) results[a].intersecting[i] |= flagsA[i];
    for (let i = 0; i < flagsB.length; i++) results[b].intersecting[i] |= flagsB[i];
    if (pair.intersectingTriangles || pair.penetratingVertices || pair.nearbyVertices) pairs.push(pair);
  }
  for (const result of results) {
    for (const distance of result.distances) {
      if (distance < 0) { result.penetratingVertices++; result.maxDepth = Math.max(result.maxDepth, -distance); }
      else if (distance <= tolerance) result.nearbyVertices++;
    }
    for (const flag of result.intersecting) result.intersectingTriangles += flag;
  }
  return { parts: results, pairs, durationMs: performance.now() - started };
}
