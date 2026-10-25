import type { SurfaceAnchor } from './tooth-types';

type Anchor = Pick<SurfaceAnchor, 'face' | 'point'>;
interface Edge { a: number; b: number; faces: number[]; length: number; midpoint: [number, number, number]; blocked: boolean }
interface Mesh {
  positions: Float32Array;
  vertices: number[];
  faceVertices: Uint32Array;
  faceEdges: Uint32Array;
  edges: Edge[];
  degenerate: Uint8Array;
  faceCount: number;
}

const MAX_FACES = 1_000_000;
const MAX_PICKS = 256;
const NO_EDGE = 0xffffffff;

/** A fresh worker can also be terminated by its caller when a newer request arrives. */
class Budget {
  private work = 0;
  private nextCheck = 4096;
  private started = performance.now();
  tick(amount = 1) {
    this.work += amount;
    if (this.work < this.nextCheck) return;
    this.nextCheck = this.work + 4096;
    if (this.work > 30_000_000 || performance.now() - this.started > 8_000) {
      throw new Error('Surface selection exceeded its work limit. Use fewer boundary points or a smaller mesh.');
    }
  }
}

class MinHeap {
  private nodes: number[] = [];
  private distances: number[] = [];
  push(node: number, distance: number) {
    let i = this.nodes.length;
    this.nodes.push(node);
    this.distances.push(distance);
    while (i > 0) {
      const parent = (i - 1) >>> 1;
      if (this.distances[parent] <= distance) break;
      this.nodes[i] = this.nodes[parent];
      this.distances[i] = this.distances[parent];
      i = parent;
    }
    this.nodes[i] = node;
    this.distances[i] = distance;
  }
  pop(): { node: number; distance: number } | undefined {
    if (!this.nodes.length) return undefined;
    const node = this.nodes[0], distance = this.distances[0];
    const lastNode = this.nodes.pop()!, lastDistance = this.distances.pop()!;
    if (this.nodes.length) {
      let i = 0;
      while (i * 2 + 1 < this.nodes.length) {
        let child = i * 2 + 1;
        if (child + 1 < this.nodes.length && this.distances[child + 1] < this.distances[child]) child++;
        if (this.distances[child] >= lastDistance) break;
        this.nodes[i] = this.nodes[child];
        this.distances[i] = this.distances[child];
        i = child;
      }
      this.nodes[i] = lastNode;
      this.distances[i] = lastDistance;
    }
    return { node, distance };
  }
}

const distance = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
function vertex(mesh: Mesh, id: number): [number, number, number] {
  const offset = mesh.vertices[id], p = mesh.positions;
  return [p[offset], p[offset + 1], p[offset + 2]];
}

function buildMesh(positions: Float32Array, budget: Budget): Mesh {
  if (!(positions instanceof Float32Array) || positions.length % 9 !== 0) {
    throw new Error('Surface positions must be a Float32Array of complete triangles (nine coordinates per face).');
  }
  const faceCount = positions.length / 9;
  if (faceCount > MAX_FACES) throw new Error(`Surface selection supports at most ${MAX_FACES} triangles per mesh.`);
  const mesh: Mesh = {
    positions, faceCount, vertices: [], edges: [],
    faceVertices: new Uint32Array(faceCount * 3), faceEdges: new Uint32Array(faceCount * 3).fill(NO_EDGE),
    degenerate: new Uint8Array(faceCount),
  };
  const vertexIds = new Map<string, number>(), edgeIds = new Map<string, number>();
  for (let i = 0; i < positions.length; i += 3) {
    budget.tick();
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) throw new Error('Surface coordinates must be finite.');
    // Float32 values stringify without losing identity. Only exact coordinates share vertices;
    // signed zero denotes the same coordinate. Nearby vertices are never tolerance welded.
    const key = `${x},${y},${z}`;
    let id = vertexIds.get(key);
    if (id === undefined) {
      id = mesh.vertices.length;
      mesh.vertices.push(i);
      vertexIds.set(key, id);
    }
    mesh.faceVertices[i / 3] = id;
  }
  for (let face = 0; face < faceCount; face++) {
    budget.tick();
    const offset = face * 9;
    const ab = [positions[offset + 3] - positions[offset], positions[offset + 4] - positions[offset + 1], positions[offset + 5] - positions[offset + 2]];
    const ac = [positions[offset + 6] - positions[offset], positions[offset + 7] - positions[offset + 1], positions[offset + 8] - positions[offset + 2]];
    mesh.degenerate[face] = Number(Math.hypot(ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]) === 0);
    for (let side = 0; side < 3; side++) {
      const v1 = mesh.faceVertices[face * 3 + side], v2 = mesh.faceVertices[face * 3 + (side + 1) % 3];
      if (v1 === v2) continue;
      const a = Math.min(v1, v2), b = Math.max(v1, v2), key = `${a}:${b}`;
      let id = edgeIds.get(key);
      if (id === undefined) {
        id = mesh.edges.length;
        const pa = vertex(mesh, a), pb = vertex(mesh, b);
        mesh.edges.push({ a, b, faces: [], length: distance(pa, pb), midpoint: [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2], blocked: false });
        edgeIds.set(key, id);
      }
      const edge = mesh.edges[id];
      if (edge.faces[edge.faces.length - 1] !== face) edge.faces.push(face);
      if (mesh.degenerate[face] || edge.faces.length > 2) edge.blocked = true;
      mesh.faceEdges[face * 3 + side] = id;
    }
  }
  return mesh;
}

function validateAnchor(mesh: Mesh, anchor: Anchor, name: string) {
  if (!anchor || !Number.isInteger(anchor.face) || anchor.face < 0 || anchor.face >= mesh.faceCount) {
    throw new Error(`${name} must reference a valid triangle face.`);
  }
  if (!Array.isArray(anchor.point) || anchor.point.length !== 3 || !anchor.point.every(Number.isFinite)) {
    throw new Error(`${name} must have three finite point coordinates.`);
  }
}

function selectedFaces(selected: Uint8Array): Uint32Array {
  let count = 0;
  for (const value of selected) count += value;
  const faces = new Uint32Array(count);
  for (let face = 0, i = 0; face < selected.length; face++) if (selected[face]) faces[i++] = face;
  return faces;
}

/**
 * Approximate surface distance on an edge-midpoint graph, in file units. A face is
 * selected when a shared-edge midpoint is reached within radius, plus all picked
 * faces. This is a whole-triangle brush, not an exact continuous geodesic disk.
 * Routes stay inside triangles and cross only edges with exactly two valid faces.
 */
export function brushFaces(positions: Float32Array, hits: readonly Anchor[], radius: number): Uint32Array {
  if (!Number.isFinite(radius) || radius < 0) throw new Error('Brush radius must be finite and non-negative, in file units.');
  if (!Array.isArray(hits) || hits.length > MAX_PICKS) throw new Error(`A brush request supports at most ${MAX_PICKS} surface picks.`);
  const budget = new Budget(), mesh = buildMesh(positions, budget);
  const selected = new Uint8Array(mesh.faceCount), best = new Float64Array(mesh.edges.length).fill(Infinity), heap = new MinHeap();
  for (const hit of hits) {
    validateAnchor(mesh, hit, 'Brush pick');
    selected[hit.face] = 1;
    for (let side = 0; side < 3; side++) {
      const id = mesh.faceEdges[hit.face * 3 + side];
      if (id === NO_EDGE) continue;
      const edge = mesh.edges[id];
      if (edge.blocked || edge.faces.length !== 2) continue;
      const d = distance(hit.point, edge.midpoint);
      if (d <= radius && d < best[id]) { best[id] = d; heap.push(id, d); }
    }
  }
  for (let entry; (entry = heap.pop());) {
    budget.tick();
    if (entry.distance !== best[entry.node]) continue;
    const edge = mesh.edges[entry.node];
    for (const face of edge.faces) {
      selected[face] = 1;
      for (let side = 0; side < 3; side++) {
        const nextId = mesh.faceEdges[face * 3 + side];
        if (nextId === NO_EDGE || nextId === entry.node) continue;
        const next = mesh.edges[nextId];
        if (next.blocked || next.faces.length !== 2) continue;
        const d = entry.distance + distance(edge.midpoint, next.midpoint);
        if (d <= radius && d < best[nextId]) { best[nextId] = d; heap.push(nextId, d); }
      }
    }
  }
  return selectedFaces(selected);
}

function boundaryGraph(mesh: Mesh, budget: Budget) {
  const adjacency: number[][] = Array.from({ length: mesh.vertices.length }, () => []);
  const unsafe = new Uint8Array(mesh.vertices.length), openEdges = new Uint8Array(mesh.vertices.length);
  const parent = new Uint32Array(mesh.faceVertices.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const root = (value: number): number => {
    while (parent[value] !== value) { parent[value] = parent[parent[value]]; value = parent[value]; }
    return value;
  };
  const corner = (face: number, v: number) => {
    const first = face * 3;
    return first + (mesh.faceVertices[first] === v ? 0 : mesh.faceVertices[first + 1] === v ? 1 : 2);
  };
  for (let id = 0; id < mesh.edges.length; id++) {
    budget.tick();
    const edge = mesh.edges[id];
    if (edge.blocked) { unsafe[edge.a] = unsafe[edge.b] = 1; continue; }
    adjacency[edge.a].push(id);
    adjacency[edge.b].push(id);
    if (edge.faces.length === 1) { openEdges[edge.a]++; openEdges[edge.b]++; }
    else {
      for (const v of [edge.a, edge.b]) parent[root(corner(edge.faces[0], v))] = root(corner(edge.faces[1], v));
    }
  }
  const firstFan = new Int32Array(mesh.vertices.length).fill(-1);
  for (let i = 0; i < mesh.faceVertices.length; i++) {
    budget.tick();
    const v = mesh.faceVertices[i];
    if (mesh.degenerate[Math.floor(i / 3)]) unsafe[v] = 1;
    const fan = root(i);
    if (firstFan[v] === -1) firstFan[v] = fan;
    else if (firstFan[v] !== fan) unsafe[v] = 1;
    if (openEdges[v] !== 0 && openEdges[v] !== 2) unsafe[v] = 1;
  }
  return { adjacency, unsafe };
}

function shortestPath(mesh: Mesh, adjacency: number[][], unsafe: Uint8Array, start: number, target: number, budget: Budget): number[] {
  budget.tick(mesh.vertices.length * 2);
  const best = new Float64Array(mesh.vertices.length).fill(Infinity), previous = new Int32Array(mesh.vertices.length).fill(-1), heap = new MinHeap();
  best[start] = 0;
  heap.push(start, 0);
  for (let entry; (entry = heap.pop());) {
    budget.tick();
    if (entry.distance !== best[entry.node]) continue;
    if (entry.node === target) {
      const path = [target];
      while (path[path.length - 1] !== start) path.push(previous[path[path.length - 1]]);
      return path.reverse();
    }
    for (const id of adjacency[entry.node]) {
      budget.tick();
      const edge = mesh.edges[id], next = edge.a === entry.node ? edge.b : edge.a;
      if (unsafe[next]) continue;
      const d = entry.distance + edge.length;
      if (d < best[next]) { best[next] = d; previous[next] = entry.node; heap.push(next, d); }
    }
  }
  throw new Error('Boundary points are disconnected by open, degenerate, or non-manifold geometry. Choose a loop on one continuous surface.');
}

const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const minus = (a: readonly number[], b: readonly number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: readonly number[], b: readonly number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function pointSegmentDistance(point: readonly number[], a: readonly number[], b: readonly number[]): number {
  const v = minus(b, a), t = Math.max(0, Math.min(1, dot(minus(point, a), v) / dot(v, v)));
  return Math.hypot(point[0] - a[0] - t * v[0], point[1] - a[1] - t * v[1], point[2] - a[2] - t * v[2]);
}
function roundoff(...points: readonly number[][]): number {
  // Use local differences: a large shared file-coordinate origin must not
  // turn separated short edges into intersections on an otherwise small loop.
  let scale = Number.MIN_VALUE;
  const origin = points[0];
  for (const point of points) for (let axis = 0; axis < 3; axis++) scale = Math.max(scale, Math.abs(point[axis] - origin[axis]));
  return scale * Number.EPSILON * 64;
}
function segmentsIntersect(a: number[], b: number[], c: number[], d: number[]): boolean {
  const epsilon = roundoff(a, b, c, d);
  if (pointSegmentDistance(a, c, d) <= epsilon || pointSegmentDistance(b, c, d) <= epsilon || pointSegmentDistance(c, a, b) <= epsilon || pointSegmentDistance(d, a, b) <= epsilon) return true;
  const u = minus(b, a), v = minus(d, c), q = minus(c, a), normal = cross(u, v);
  // Cross products avoid subtracting nearly equal squared lengths for long,
  // almost-parallel edges. That subtraction can erase a real intersection.
  const denominator = dot(normal, normal);
  if (denominator === 0) return false;
  const s = dot(cross(q, v), normal) / denominator, t = dot(cross(q, u), normal) / denominator;
  return s > 0 && s < 1 && t > 0 && t < 1 && Math.hypot(s * u[0] - q[0] - t * v[0], s * u[1] - q[1] - t * v[1], s * u[2] - q[2] - t * v[2]) <= epsilon;
}

function validateLoop(mesh: Mesh, loop: number[], budget: Budget) {
  if (loop.length < 3) throw new Error('Boundary needs at least three distinct mesh vertices.');
  if (loop.length > 20_000) throw new Error('Boundary path is too long. Use a smaller region or mesh.');
  const points = loop.map(id => vertex(mesh, id));
  const segments = points.map((a, i) => {
    const b = points[(i + 1) % points.length];
    return { i, a, b, minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]), minY: Math.min(a[1], b[1]), maxY: Math.max(a[1], b[1]), minZ: Math.min(a[2], b[2]), maxZ: Math.max(a[2], b[2]) };
  }).sort((a, b) => a.minX - b.minX);
  for (let i = 0; i < segments.length; i++) {
    const a = segments[i];
    for (let j = i + 1; j < segments.length && segments[j].minX <= a.maxX; j++) {
      budget.tick();
      const b = segments[j];
      if (b.minY > a.maxY || b.maxY < a.minY || b.minZ > a.maxZ || b.maxZ < a.minZ) continue;
      const adjacent = (a.i + 1) % loop.length === b.i || (b.i + 1) % loop.length === a.i;
      if (adjacent) {
        const first = (a.i + 1) % loop.length === b.i ? a : b, second = first === a ? b : a;
        // Adjacent edges may meet at their common endpoint, but may not double back.
        if (pointSegmentDistance(first.a, second.a, second.b) <= roundoff(first.a, second.a, second.b) || pointSegmentDistance(second.b, first.a, first.b) <= roundoff(second.b, first.a, first.b)) {
          throw new Error('Boundary is degenerate or overlaps itself. Move the boundary picks.');
        }
      } else if (segmentsIntersect(a.a, a.b, b.a, b.b)) {
        throw new Error('Boundary intersects itself. Choose a simple closed loop.');
      }
    }
  }
}

/** Snap picks to vertices, join shortest edge paths, and flood faces across non-barrier manifold edges. */
export function boundaryRegion(positions: Float32Array, boundary: readonly Anchor[], seed: Anchor): { faces: Uint32Array; boundary: Float32Array } {
  if (!Array.isArray(boundary) || boundary.length < 3 || boundary.length > MAX_PICKS) throw new Error(`Boundary needs between 3 and ${MAX_PICKS} surface picks.`);
  const budget = new Budget(), mesh = buildMesh(positions, budget);
  validateAnchor(mesh, seed, 'Region seed');
  if (mesh.degenerate[seed.face]) throw new Error('Place the region seed on a non-degenerate triangle.');
  const snapped = boundary.map(anchor => {
    validateAnchor(mesh, anchor, 'Boundary pick');
    if (mesh.degenerate[anchor.face]) throw new Error('Boundary picks cannot lie on degenerate triangles.');
    let closest = mesh.faceVertices[anchor.face * 3], nearest = Infinity;
    for (let side = 0; side < 3; side++) {
      const v = mesh.faceVertices[anchor.face * 3 + side], d = distance(anchor.point, vertex(mesh, v));
      if (d < nearest) { nearest = d; closest = v; }
    }
    return closest;
  });
  if (new Set(snapped).size !== snapped.length) throw new Error('Boundary picks snap to repeated vertices. Use distinct points around the region.');
  const { adjacency, unsafe } = boundaryGraph(mesh, budget);
  if (snapped.some(id => unsafe[id])) throw new Error('Boundary touches a non-manifold or degenerate mesh vertex. Move the picks onto a continuous surface.');
  const loop = [snapped[0]], visited = new Set(loop);
  for (let i = 0; i < snapped.length; i++) {
    const path = shortestPath(mesh, adjacency, unsafe, snapped[i], snapped[(i + 1) % snapped.length], budget);
    for (let j = 1; j < path.length; j++) {
      const id = path[j];
      if (i === snapped.length - 1 && j === path.length - 1 && id === loop[0]) continue;
      if (visited.has(id)) throw new Error('Boundary shortest paths repeat a vertex or overlap. Add or move picks to make a simple loop.');
      visited.add(id);
      loop.push(id);
      if (loop.length > 20_000) throw new Error('Boundary path is too long. Use a smaller region or mesh.');
    }
  }
  validateLoop(mesh, loop, budget);
  const barriers = new Set<number>();
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    const id = adjacency[a].find(id => mesh.edges[id].a === b || mesh.edges[id].b === b)!;
    const edge = mesh.edges[id];
    if (edge.blocked || edge.faces.length !== 2) throw new Error('Boundary follows an open or non-manifold mesh edge. Draw a closed loop inside a continuous surface.');
    barriers.add(id);
    const pa = vertex(mesh, a), pb = vertex(mesh, b);
    if (pointSegmentDistance(seed.point, pa, pb) <= roundoff(seed.point, pa, pb)) {
      throw new Error('Region seed lies on the boundary. Place it clearly on one side of the loop.');
    }
  }
  const selected = new Uint8Array(mesh.faceCount), queue = new Uint32Array(mesh.faceCount);
  let head = 0, tail = 1;
  selected[seed.face] = 1;
  queue[0] = seed.face;
  while (head < tail) {
    budget.tick();
    const face = queue[head++];
    for (let side = 0; side < 3; side++) {
      const id = mesh.faceEdges[face * 3 + side];
      if (id === NO_EDGE || barriers.has(id)) continue;
      const edge = mesh.edges[id];
      if (edge.blocked || edge.faces.length !== 2) continue;
      const other = edge.faces[0] === face ? edge.faces[1] : edge.faces[0];
      if (!selected[other]) { selected[other] = 1; queue[tail++] = other; }
    }
  }
  for (const id of barriers) {
    const [a, b] = mesh.edges[id].faces;
    if (selected[a] === selected[b]) throw new Error('Boundary does not separate the seeded region. Choose a separating loop and place the seed on one side.');
  }
  const lines = new Float32Array(loop.length * 6);
  for (let i = 0; i < loop.length; i++) {
    lines.set(vertex(mesh, loop[i]), i * 6);
    lines.set(vertex(mesh, loop[(i + 1) % loop.length]), i * 6 + 3);
  }
  return { faces: selectedFaces(selected), boundary: lines };
}
