import type { AutoToothCandidate, AutoToothFrame, AutoToothScan, AutoToothSettings } from './auto-tooth-types';
import type { Vec3 } from './models';

// These are relative shape thresholds, never millimetres. This is a proposal, not
// a tooth classifier: smooth tissue and a worn crown can be geometrically ambiguous.
const METHOD = 'Area PCA / local persistent-basin support / edge-geodesic crown watershed';
const LIMIT = 1_000_000;
const REVIEW = 'Heuristic crown proposals are not clinically validated. Review boundaries and missing or merged teeth; no FDI labels are inferred.';

/** Cooperative work budget. Shared by local detection and arch analysis workers. */
export class Budget {
  private start = performance.now();
  private work = 0;
  private limitMs: number;
  private message: string;
  constructor(limitMs = 8_000, message = 'Automatic tooth detection exceeded its 8 second limit. Try a smaller local scan.') {
    this.limitMs = limitMs; this.message = message;
  }
  tick(n = 1) {
    this.work += n;
    if (this.work >= 2048) {
      this.work = 0;
      if (performance.now() - this.start > this.limitMs) throw new Error(this.message);
    }
  }
}

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function unit(a: Vec3): Vec3 {
  const length = Math.hypot(...a);
  return length ? a.map(x => x / length) as Vec3 : [0, 0, 1];
}

/** Symmetric 3x3 Jacobi eigensolver. Columns are orthonormal eigenvectors. */
function eigen(covariance: number[]): { value: number; axis: Vec3 }[] {
  const a = covariance.slice(), v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let iteration = 0; iteration < 32; iteration++) {
    let p = 0, q = 1;
    for (const [i, j] of [[0, 2], [1, 2]]) if (Math.abs(a[i * 3 + j]) > Math.abs(a[p * 3 + q])) { p = i; q = j; }
    if (Math.abs(a[p * 3 + q]) < 1e-15) break;
    const angle = 0.5 * Math.atan2(2 * a[p * 3 + q], a[q * 3 + q] - a[p * 3 + p]);
    const c = Math.cos(angle), s = Math.sin(angle);
    for (let k = 0; k < 3; k++) {
      const kp = a[k * 3 + p], kq = a[k * 3 + q];
      a[k * 3 + p] = c * kp - s * kq; a[k * 3 + q] = s * kp + c * kq;
    }
    for (let k = 0; k < 3; k++) {
      const pk = a[p * 3 + k], qk = a[q * 3 + k];
      a[p * 3 + k] = c * pk - s * qk; a[q * 3 + k] = s * pk + c * qk;
      const vp = v[k * 3 + p], vq = v[k * 3 + q];
      v[k * 3 + p] = c * vp - s * vq; v[k * 3 + q] = s * vp + c * vq;
    }
  }
  return [0, 1, 2].map(i => ({ value: Math.max(0, a[i * 3 + i]), axis: unit([v[i], v[3 + i], v[6 + i]]) })).sort((a, b) => a.value - b.value);
}

class Heap {
  private nodes: number[] = [];
  private costs: number[] = [];
  get length() { return this.nodes.length; }
  push(node: number, cost: number) {
    let i = this.nodes.length;
    this.nodes.push(node); this.costs.push(cost);
    while (i) {
      const parent = (i - 1) >>> 1;
      if (this.costs[parent] <= cost) break;
      this.nodes[i] = this.nodes[parent]; this.costs[i] = this.costs[parent]; i = parent;
    }
    this.nodes[i] = node; this.costs[i] = cost;
  }
  pop(): [number, number] {
    const node = this.nodes[0], cost = this.costs[0], last = this.nodes.pop()!, value = this.costs.pop()!;
    if (this.nodes.length) {
      let i = 0;
      while (2 * i + 1 < this.nodes.length) {
        let child = 2 * i + 1;
        if (child + 1 < this.nodes.length && this.costs[child + 1] < this.costs[child]) child++;
        if (this.costs[child] >= value) break;
        this.nodes[i] = this.nodes[child]; this.costs[i] = this.costs[child]; i = child;
      }
      this.nodes[i] = last; this.costs[i] = value;
    }
    return [node, cost];
  }
}

export interface Mesh {
  n: number; area: Float64Array; xyz: Float64Array; normal: Float32Array;
  adjacent: Int32Array; valid: Uint32Array; component: Int32Array;
  groups: number[][]; scale: number; reference: Vec3; center: Vec3;
  axes: { value: number; axis: Vec3 }[]; bad: number; nonManifold: number;
}

/** Exact-vertex manifold adjacency, normalized by the scan's own bounding size (never millimetres). */
export function buildMesh(positions: Float32Array, budget: Budget): Mesh {
  if (!(positions instanceof Float32Array) || positions.length % 9) throw new Error('Automatic tooth detection needs complete Float32Array triangles (nine coordinates per face).');
  const n = positions.length / 9;
  if (n > LIMIT) throw new Error(`Automatic tooth detection supports at most ${LIMIT.toLocaleString('en-US')} triangles.`);
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    budget.tick();
    for (let k = 0; k < 3; k++) {
      const x = positions[i + k];
      if (!Number.isFinite(x)) throw new Error('Automatic tooth detection requires finite coordinates.');
      lo[k] = Math.min(lo[k], x); hi[k] = Math.max(hi[k], x);
    }
  }
  const reference = n ? lo.map((x, k) => x + (hi[k] - x) / 2) as Vec3 : [0, 0, 0] as Vec3;
  const scale = n ? Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1 : 1;
  const area = new Float64Array(n), xyz = new Float64Array(n * 3), normal = new Float32Array(n * 3);
  const adjacent = new Int32Array(n * 3).fill(-1), component = new Int32Array(n).fill(-1);
  const vertices = new Uint32Array(n * 3), vertexIds = new Map<string, number>();
  const good: number[] = [], center: Vec3 = [0, 0, 0], second = new Array<number>(9).fill(0);
  let total = 0, bad = 0;
  for (let f = 0; f < n; f++) {
    budget.tick();
    const p = Array.from({ length: 3 }, (_, j) => [0, 1, 2].map(k => (positions[f * 9 + j * 3 + k] - reference[k]) / scale));
    const ab = p[1].map((x, k) => x - p[0][k]), ac = p[2].map((x, k) => x - p[0][k]);
    const norm = cross(ab, ac), twiceArea = Math.hypot(...norm);
    // Relative to this face's edges, not the global bounding box; tiny valid
    // disconnected shells remain separate and are not silently welded away.
    if (!(twiceArea > Math.hypot(...ab) * Math.hypot(...ac) * 1e-12)) { bad++; continue; }
    const weight = twiceArea / 2; area[f] = weight; total += weight; good.push(f);
    const sum = [0, 1, 2].map(k => p[0][k] + p[1][k] + p[2][k]);
    for (let k = 0; k < 3; k++) {
      xyz[f * 3 + k] = sum[k] / 3; normal[f * 3 + k] = norm[k] / twiceArea; center[k] += weight * sum[k] / 3;
      for (let l = 0; l < 3; l++) {
        // Exact area integral of x*x^T over a triangle, including its interior.
        second[k * 3 + l] += weight * (sum[k] * sum[l] + p.reduce((s, a) => s + a[k] * a[l], 0)) / 12;
      }
    }
    for (let j = 0; j < 3; j++) {
      const offset = f * 9 + j * 3;
      // Float32 -> decimal strings are injective, and -0 denotes the same point.
      // This is exact identity, with NO quantisation or tolerance welding.
      const key = `${positions[offset]},${positions[offset + 1]},${positions[offset + 2]}`;
      let id = vertexIds.get(key);
      if (id === undefined) { id = vertexIds.size; vertexIds.set(key, id); }
      vertices[f * 3 + j] = id;
    }
  }
  if (total) for (let k = 0; k < 3; k++) center[k] /= total;
  const covariance = second.map((x, i) => total ? x / total - center[Math.floor(i / 3)] * center[i % 3] : 0);
  const count = vertexIds.size, edges = new Map<number, number>();
  let nonManifold = 0;
  for (const f of good) {
    budget.tick();
    for (let j = 0; j < 3; j++) {
      const a = vertices[f * 3 + j], b = vertices[f * 3 + (j + 1) % 3], key = Math.min(a, b) * count + Math.max(a, b);
      const slot = f * 3 + j, previous = edges.get(key);
      if (previous === undefined) edges.set(key, slot);
      else if (previous >= 0) {
        if (adjacent[previous] < 0) { adjacent[slot] = Math.floor(previous / 3); adjacent[previous] = f; }
        else {
          const other = adjacent[previous];
          for (let k = 0; k < 3; k++) if (adjacent[other * 3 + k] === Math.floor(previous / 3)) adjacent[other * 3 + k] = -1;
          adjacent[previous] = -1; edges.set(key, -1); nonManifold++;
        }
      }
    }
  }
  const groups: number[][] = [];
  for (const start of good) {
    if (component[start] >= 0) continue;
    const faces = [start], id = groups.length; component[start] = id;
    for (let head = 0; head < faces.length; head++) {
      budget.tick();
      const f = faces[head];
      for (let k = 0; k < 3; k++) {
        const next = adjacent[f * 3 + k];
        if (next >= 0 && component[next] < 0) { component[next] = id; faces.push(next); }
      }
    }
    groups.push(faces);
  }
  return { n, area, xyz, normal, adjacent, valid: new Uint32Array(good), component, groups, scale, reference, center, axes: eigen(covariance), bad, nonManifold };
}

function frame(mesh: Mesh, up: Vec3): AutoToothFrame {
  let u = mesh.axes[2].axis;
  if (Math.abs(dot(u, up)) > 0.95) u = mesh.axes[1].axis;
  u = unit(u.map((x, k) => x - dot(u, up) * up[k]) as Vec3);
  return { origin: mesh.center.map((x, k) => mesh.reference[k] + mesh.scale * x) as Vec3, up, u, v: unit(cross(up, u)) };
}

function heightDistribution(faces: ArrayLike<number>, field: Float64Array, area: Float64Array, budget: Budget) {
  const order = Uint32Array.from(faces).sort((a, b) => { budget.tick(); return field[b] - field[a] || a - b; });
  let sum = 0; for (const f of order) { budget.tick(); sum += area[f]; }
  let weight = 0, top = field[order[0]], base = field[order[order.length - 1]], foundTop = false;
  for (const f of order) {
    budget.tick(); weight += area[f];
    if (!foundTop && weight >= sum * 0.02) { top = field[f]; foundTop = true; }
    if (weight >= sum * 0.90) { base = field[f]; break; }
  }
  return { order, base, top };
}
const separation = (mesh: Mesh, a: number, b: number) => Math.hypot(mesh.xyz[a * 3] - mesh.xyz[b * 3], mesh.xyz[a * 3 + 1] - mesh.xyz[b * 3 + 1], mesh.xyz[a * 3 + 2] - mesh.xyz[b * 3 + 2]);
interface BranchScratch { parent: Int32Array; summit: Int32Array; area: Float64Array; count: Uint32Array; boundary: Uint8Array }
interface Branch { face: number; saddle: number; area: number; count: number; boundary: boolean; estimatedBase: boolean }

/** Persistence support before any distance cutoff. Each union follows an exact manifold edge. */
function branches(mesh: Mesh, order: Uint32Array, field: Float64Array, up: Vec3, base: number, budget: Budget, scratch: BranchScratch): Branch[] {
  const { parent, summit, area, count, boundary } = scratch;
  for (const f of order) { budget.tick(); parent[f] = -1; }
  const find = (node: number) => {
    let root = node;
    while (parent[root] !== root) root = parent[root];
    while (node !== root) { const next = parent[node]; parent[node] = root; node = next; }
    return root;
  };
  const result: Branch[] = [];
  for (const f of order) {
    budget.tick(); parent[f] = f; summit[f] = f; count[f] = 1; boundary[f] = 0;
    area[f] = mesh.area[f] * Math.abs(dot(mesh.normal.subarray(f * 3, f * 3 + 3), up));
    for (let k = 0; k < 3; k++) {
      const next = mesh.adjacent[f * 3 + k];
      if (next < 0) boundary[find(f)] = 1;
      else if (parent[next] >= 0) {
        let a = find(f), b = find(next);
        if (a === b) continue;
        if (field[summit[a]] < field[summit[b]] || (field[summit[a]] === field[summit[b]] && summit[a] > summit[b])) [a, b] = [b, a];
        if (field[summit[b]] > field[f]) result.push({ face: summit[b], saddle: field[f], area: area[b], count: count[b], boundary: !!boundary[b], estimatedBase: false });
        parent[b] = a; area[a] += area[b]; count[a] += count[b]; boundary[a] |= boundary[b];
      }
    }
  }
  const root = find(order[0]);
  result.push({ face: summit[root], saddle: base, area: area[root], count: count[root], boundary: !!boundary[root], estimatedBase: true });
  return result;
}

interface Peak { face: number; top: number; prominence: number; floor: number; supportFloor: number; depth: number; radius: number; seedRadius: number; local: boolean; shoulderArea: number; shoulderTissue: number; estimatedBase: boolean }
interface Proposal { up: Vec3; peaks: Peak[]; labels: Int32Array; score: number; evidence: { height: number; width: number; tissue: number }[] }

function propose(mesh: Mesh, up: Vec3, sensitivity: number, budget: Budget, tissueCosts?: Float32Array): Proposal {
  let field = new Float64Array(mesh.n);
  for (const f of mesh.valid) { budget.tick(); field[f] = dot(mesh.xyz.subarray(f * 3, f * 3 + 3), up); }
  // Edge diffusion removes tessellation-scale cusps; persistence below removes
  // noise at larger resolutions. Never diffuse between disconnected surfaces.
  for (let pass = 0; pass < 4; pass++) {
    const smooth = field.slice();
    for (const f of mesh.valid) {
      budget.tick();
      let value = field[f] * Math.sqrt(mesh.area[f]) * 2, weight = Math.sqrt(mesh.area[f]) * 2;
      for (let k = 0; k < 3; k++) {
        const other = mesh.adjacent[f * 3 + k];
        if (other >= 0) { const w = Math.sqrt(mesh.area[other]); value += field[other] * w; weight += w; }
      }
      smooth[f] = value / weight;
    }
    field = smooth;
  }
  const peaks: Peak[] = [];
  const scratch: BranchScratch = { parent: new Int32Array(mesh.n).fill(-1), summit: new Int32Array(mesh.n), area: new Float64Array(mesh.n), count: new Uint32Array(mesh.n), boundary: new Uint8Array(mesh.n) };
  const basinTissue = new Float64Array(mesh.n), basinBoundary = new Float64Array(mesh.n);
  const { parent, area: basinArea } = scratch;
  for (const faces of mesh.groups) {
    if (faces.length < 12) continue;
    budget.tick();
    const { order: sorted, base, top } = heightDistribution(faces, field, mesh.area, budget);
    const relief = top - base;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    const localFrame = frame(mesh, up);
    for (const f of faces) {
      budget.tick();
      const p = mesh.xyz.subarray(f * 3, f * 3 + 3), u = dot(p, localFrame.u), v = dot(p, localFrame.v);
      minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, v); maxV = Math.max(maxV, v);
    }
    const span = Math.hypot(maxU - minU, maxV - minV);
    // A nonzero bump is insufficient: low relief, noisy planes have no crowns.
    if (!(relief > span * 0.025 / Math.sqrt(sensitivity))) continue;
    const original = branches(mesh, sorted, field, up, base, budget, scratch);
    const features = original.slice(0, -1).filter(p => {
      const prominence = field[p.face] - p.saddle;
      return p.count >= 8 && !p.boundary && prominence > Math.sqrt(p.area) * 0.12 && Math.abs(dot(mesh.normal.subarray(p.face * 3, p.face * 3 + 3), up)) > 0.5;
    });
    // Count-weighted statistics are dominated by dense scan detail. Weight the
    // local support distribution by projected branch area, excluding the root
    // (which has no merge saddle), and use its lower area quantile.
    features.sort((a, b) => a.area - b.area);
    const supportArea = features.reduce((sum, p) => sum + p.area, 0);
    let accumulated = 0, featureScale = relief;
    for (const p of features) {
      accumulated += p.area;
      if (accumulated >= supportArea * 0.10) { featureScale = Math.sqrt(p.area); break; }
    }
    const local = features.length >= 2 && relief > featureScale * 1.3;
    const raw = original;
    const find = (node: number) => {
      let root = node;
      while (parent[root] !== root) root = parent[root];
      while (node !== root) { const next = parent[node]; parent[node] = root; node = next; }
      return root;
    };

    raw.sort((a, b) => field[b.face] - b.saddle - (field[a.face] - a.saddle) || a.face - b.face);
    const accepted: Peak[] = [];
    for (const item of raw) {
      budget.tick();
      const f = item.face, prominence = field[f] - (local ? item.saddle : Math.max(item.saddle, base));
      // Color can make a geometric seed less credible, never create a peak or
      // lower a geometric threshold. Unknown and weak cues have no cost.
      const seedPenalty = tissueCosts?.[f] ?? 0;
      const minProminence = (local ? Math.max(featureScale * 0.06, Math.sqrt(item.area) * 0.12) : relief * 0.21) / sensitivity;
      if (local && (item.count < 8 || item.area < featureScale ** 2 * 0.015)) continue;
      if (prominence < minProminence * (1 + 0.75 * seedPenalty) || (!local && field[f] < base + relief * 0.48) || Math.abs(dot(mesh.normal.subarray(f * 3, f * 3 + 3), up)) < 0.35) continue;
      const width = local ? Math.max(featureScale * 0.5, Math.min(Math.sqrt(item.area), featureScale)) : relief;
      const radius = local ? width * 0.65 / sensitivity : Math.max(relief * 0.52 / sensitivity, span * 0.008);
      const supportFloor = Math.max(base + relief * (0.30 + 0.10 * (sensitivity - 1)), field[f] - prominence * 0.78 / Math.sqrt(sensitivity));
      const depth = local ? Math.max(Math.min(prominence, width * 0.5), width * 0.35) : prominence;
      accepted.push({ face: f, top: field[f], prominence, supportFloor: local ? field[f] - prominence * 0.78 / Math.sqrt(sensitivity) : supportFloor,
        floor: local ? field[f] - depth * 0.9 / Math.sqrt(sensitivity) : supportFloor,
        depth, local, seedRadius: radius, shoulderArea: 0, shoulderTissue: 0, estimatedBase: item.estimatedBase || (!local && base > item.saddle),
        radius: Math.max((local ? width * 2.5 : relief * 2.5) / Math.sqrt(sensitivity), radius * 2) });
      if (accepted.length >= 256) break;
    }
    if (!accepted.length) continue;
    // Measure the entire connected shoulder BEFORE the distance cutoff can
    // trim a broad palate/tissue bowl into an apparently compact little cap.
    // One extra descending union pass answers all shoulder-area queries; no
    // per-marker whole-mesh searches or projected connectivity are introduced.
    let totalProjected = 0;
    for (const f of faces) {
      budget.tick(); parent[f] = -1;
      totalProjected += mesh.area[f] * Math.abs(dot(mesh.normal.subarray(f * 3, f * 3 + 3), up));
    }
    const events = accepted.map(peak => ({ peak, area: 0, tissue: 0, boundaryHeight: -Infinity })).sort((a, b) => b.peak.supportFloor - a.peak.supportFloor);
    let event = 0;
    const measure = () => {
      const item = events[event++], root = find(item.peak.face);
      item.area = basinArea[root]; item.tissue = basinTissue[root]; item.boundaryHeight = basinBoundary[root];
    };
    for (const f of sorted) {
      budget.tick();
      while (event < events.length && events[event].peak.supportFloor > field[f]) measure();
      parent[f] = f;
      basinArea[f] = mesh.area[f] * Math.abs(dot(mesh.normal.subarray(f * 3, f * 3 + 3), up));
      basinTissue[f] = basinArea[f] * (tissueCosts?.[f] ?? 0);
      basinBoundary[f] = -Infinity;
      for (let k = 0; k < 3; k++) {
        const next = mesh.adjacent[f * 3 + k];
        if (next < 0) basinBoundary[find(f)] = Math.max(basinBoundary[find(f)], field[f]);
        if (next < 0 || parent[next] < 0) continue;
        const a = find(f), b = find(next);
        if (a !== b) {
          parent[b] = a; basinArea[a] += basinArea[b]; basinTissue[a] += basinTissue[b];
          basinBoundary[a] = Math.max(basinBoundary[a], basinBoundary[b]);
        }
      }
    }
    while (event < events.length) measure();
    const supportedPeaks: Peak[] = [];
    for (const item of events) {
      const p = item.peak;
      p.shoulderArea = item.area; p.shoulderTissue = item.area ? item.tissue / item.area : 0;
      // Judge the whole shoulder before color/distance costs trim it. Neither
      // a cropped shoulder nor a broad pink cap gains support by being shrunk.
      if (item.boundaryHeight >= p.top - Math.min(p.prominence, p.depth) * 0.32) continue;
      if ((item.area < totalProjected * 0.55 || p.prominence > Math.sqrt(item.area) * 0.45)
        && p.prominence > Math.sqrt(item.area) * 0.10 * (1 + 5 * p.shoulderTissue) / Math.sqrt(sensitivity)) supportedPeaks.push(p);
    }
    // Rejected tissue/crop peaks cannot suppress a nearby supported crown.
    const distinct: Peak[] = [];
    supportedPeaks.sort((a, b) => b.prominence - a.prominence || a.face - b.face);
    for (const p of supportedPeaks) {
      // Heuristic cusp suppression at measured support scale, never a tooth count.
      if (distinct.some(other => separation(mesh, p.face, other.face) < Math.min(p.seedRadius, other.radius * 0.26))) continue;
      distinct.push(p);
      if (distinct.length >= 64) break;
    }
    peaks.push(...distinct);
  }
  peaks.sort((a, b) => b.prominence - a.prominence || a.face - b.face);
  peaks.length = Math.min(peaks.length, 64);
  const labels = new Int32Array(mesh.n).fill(-1), distance = new Float64Array(mesh.n).fill(Infinity), queue = new Heap();
  for (let i = 0; i < peaks.length; i++) {
    const seed = peaks[i].face, cost = peaks[i].radius * 0.12 * (tissueCosts?.[seed] ?? 0);
    labels[seed] = i; distance[seed] = cost; queue.push(seed, cost);
  }
  while (queue.length) {
    budget.tick();
    const [f, cost] = queue.pop();
    if (cost !== distance[f]) continue;
    const id = labels[f], peak = peaks[id];
    for (let k = 0; k < 3; k++) {
      const next = mesh.adjacent[f * 3 + k];
      if (next < 0 || field[next] < peak.floor) continue;
      const step = separation(mesh, f, next), low = Math.max(0, peak.top - field[next]) / peak.depth;
      // A bounded, soft penalty discourages growth into strongly pink tissue;
      // it is not an exclusion mask or a tissue diagnosis.
      const nextCost = cost + step * (1 + 2 * low * low + 3 * (tissueCosts?.[next] ?? 0));
      if (nextCost <= peak.radius && nextCost < distance[next]) { distance[next] = nextCost; labels[next] = id; queue.push(next, nextCost); }
    }
  }
  // Reject border maxima and broad/elongated tissue patches. The watershed
  // never obtains seeds from border curvature, or fills a component by default.
  const makeStats = () => ({ area: 0, x: 0, y: 0, xx: 0, yy: 0, xy: 0, boundaryHeight: -Infinity, tissue: 0, count: 0 });
  const stats = peaks.map(makeStats);
  const local = frame(mesh, up);
  for (const f of mesh.valid) {
    budget.tick();
    const id = labels[f]; if (id < 0) continue;
    const s = stats[id], a = mesh.area[f], p = mesh.xyz.subarray(f * 3, f * 3 + 3), x = dot(p, local.u), y = dot(p, local.v);
    s.tissue += a * (tissueCosts?.[f] ?? 0); s.area += a; s.x += a * x; s.y += a * y; s.xx += a * x * x; s.yy += a * y * y; s.xy += a * x * y; s.count++;
    for (let k = 0; k < 3; k++) if (mesh.adjacent[f * 3 + k] < 0) s.boundaryHeight = Math.max(s.boundaryHeight, field[f]);
  }
  const supportedRegion = (s: ReturnType<typeof makeStats>, i: number) => {
    if (s.count < 8 || !s.area) return false;
    const p = peaks[i], xx = Math.max(0, s.xx / s.area - (s.x / s.area) ** 2), yy = Math.max(0, s.yy / s.area - (s.y / s.area) ** 2), xy = s.xy / s.area - s.x * s.y / s.area ** 2;
    const discriminant = Math.hypot(xx - yy, 2 * xy), small = (xx + yy - discriminant) / 2, large = (xx + yy + discriminant) / 2;
    const compact = small > 0 && large / small < (p.local ? 20 : 12);
    const supported = s.boundaryHeight < p.top - p.prominence * 0.32;
    const shape = p.prominence / Math.sqrt(s.area) > (p.local ? 0.075 : 0.10) * (1 + 5 * s.tissue / s.area) / Math.sqrt(sensitivity);
    return compact && supported && shape;
  };
  const keep = stats.map(supportedRegion);
  for (const f of mesh.valid) {
    budget.tick();
    if (labels[f] >= 0 && (!keep[labels[f]] || mesh.adjacent[f * 3] < 0 || mesh.adjacent[f * 3 + 1] < 0 || mesh.adjacent[f * 3 + 2] < 0)) labels[f] = -1;
  }
  // Source-dependent floors can otherwise leave a small island behind when
  // two fronts meet. Keep only each marker's connected portion of its basin.
  const reached = new Uint8Array(mesh.n), connected: number[] = [];
  for (let id = 0; id < peaks.length; id++) {
    const seed = peaks[id].face;
    if (labels[seed] !== id) continue;
    connected.length = 0; connected.push(seed); reached[seed] = 1;
    for (let head = 0; head < connected.length; head++) {
      budget.tick();
      const f = connected[head];
      for (let k = 0; k < 3; k++) {
        const next = mesh.adjacent[f * 3 + k];
        if (next >= 0 && !reached[next] && labels[next] === id) { reached[next] = 1; connected.push(next); }
      }
    }
  }
  const retained = peaks.map(makeStats);
  for (const f of mesh.valid) {
    budget.tick();
    if (!reached[f]) labels[f] = -1;
    const id = labels[f]; if (id < 0) continue;
    const s = retained[id], a = mesh.area[f], p = mesh.xyz.subarray(f * 3, f * 3 + 3), x = dot(p, local.u), y = dot(p, local.v);
    s.tissue += a * (tissueCosts?.[f] ?? 0); s.area += a; s.x += a * x; s.y += a * y; s.xx += a * x * x; s.yy += a * y * y; s.xy += a * x * y; s.count++;
  }
  // Only connected regions that can actually be returned may vote for an axis.
  const finalKeep = retained.map(supportedRegion);
  for (const f of mesh.valid) { budget.tick(); if (labels[f] >= 0 && !finalKeep[labels[f]]) labels[f] = -1; }
  const evidence = retained.flatMap((s, i) => finalKeep[i] ? [{ height: Math.min(peaks[i].prominence, peaks[i].depth), width: Math.sqrt(s.area), tissue: s.tissue / s.area }] : []);
  const score = evidence.reduce((sum, e) => sum + e.height * e.width / (1 + 3 * e.tissue), 0);
  return { up, peaks, labels, score, evidence };
}

/**
 * Find unlabelled local crown proposals. Source triangles and coordinates are
 * never changed. IDs are seed-face + 1 (not arch order or FDI); a rerun on the
 * same face ordering is deterministic. Re-triangulation can change these IDs.
 * Optional per-face color cues are -1 (unknown) or 0..1 (gingiva-like color).
 * Only strong cues raise costs; they cannot substitute for geometric support.
 * Terminate the request's worker to cancel it; the internal budget is 8 seconds.
 */
export function detectToothRegions(positions: Float32Array, settings: AutoToothSettings, tissueScores?: Float32Array): AutoToothScan {
  const budget = new Budget(), mesh = buildMesh(positions, budget);
  let tissueCosts: Float32Array | undefined;
  if (tissueScores !== undefined) {
    if (!(tissueScores instanceof Float32Array) || tissueScores.length !== mesh.n) throw new Error('Automatic tooth color cues need one Float32Array score per face.');
    for (let f = 0; f < tissueScores.length; f++) {
      budget.tick();
      const score = tissueScores[f];
      if (score !== -1 && !(Number.isFinite(score) && score >= 0 && score <= 1)) throw new Error('Automatic tooth color cues must be -1 (unknown) or finite scores from 0 to 1.');
      if (score > 0.6 && mesh.area[f] > 0) {
        tissueCosts ??= new Float32Array(mesh.n);
        tissueCosts[f] = ((score - 0.6) / 0.4) ** 2;
      }
    }
  }
  const sensitivity = Math.min(1.5, Math.max(0.5, Number.isFinite(settings?.sensitivity) ? settings.sensitivity : 1));
  const direction = settings?.direction ?? 'auto';
  if (!['auto', '+x', '-x', '+y', '-y', '+z', '-z'].includes(direction)) throw new Error('Unknown automatic tooth axis override.');
  let up = mesh.axes[0].axis;
  const warnings = [REVIEW];
  const method = tissueCosts ? `${METHOD} / gingiva color costs` : METHOD;
  if (tissueCosts) warnings.push('Strong gingiva-like color cues raise seed, growth and region-support costs. Staining, lighting, restorations and image mapping errors can affect these heuristic boundaries; color is not a tissue diagnosis.');
  if (mesh.bad) warnings.push(`${mesh.bad} degenerate triangles were excluded.`);
  if (mesh.nonManifold) warnings.push('Non-manifold shared edges block propagation and are treated as open scan boundaries.');
  const empty = (): AutoToothScan => ({ frame: frame(mesh, up), candidates: [], warnings: [...warnings, 'No sufficiently prominent, supported crown peaks were found. Flat, noisy, edentulous, or heavily cropped surfaces may need manual selection.'], unassignedTriangles: mesh.n, method });
  if (!mesh.valid.length) return empty();
  let proposals: Proposal[];
  if (direction === 'auto') {
    proposals = [propose(mesh, up, sensitivity, budget, tissueCosts), propose(mesh, up.map(x => -x) as Vec3, sensitivity, budget, tissueCosts)];
    // A tall or narrow partial tooth can have a sidewall as its least-variance
    // PCA axis. Compare other axes even when that sidewall already has a cap.
    // Tiny fragments do not count as analysed components or disable fallback.
    const eligible = mesh.groups.reduce((sum, group) => sum + (group.length >= 12 ? 1 : 0), 0);
    const nonPlanar = mesh.axes[0].value > mesh.axes[1].value * 0.02;
    const elongated = mesh.axes[0].value > mesh.axes[1].value * 0.2 && mesh.axes[1].value < mesh.axes[2].value * 0.6;
    if (eligible <= 32 && nonPlanar && (!proposals.some(p => p.score > 0) || elongated)) {
      for (const axis of mesh.axes.slice(1)) {
        proposals.push(propose(mesh, axis.axis, sensitivity, budget, tissueCosts), propose(mesh, axis.axis.map(x => -x) as Vec3, sensitivity, budget, tissueCosts));
      }
      warnings.push('The partial scan has a weak occlusal plane; alternative PCA axes were inspected. Verify the proposed crown direction.');
    }
  } else {
    up = [0, 0, 0]; up['xyz'.indexOf(direction[1])] = direction[0] === '+' ? 1 : -1;
    proposals = [propose(mesh, up, sensitivity, budget, tissueCosts)];
  }
  // Compare directions at one shared evidence scale: a single broad palate
  // basin must not outweigh several independent locally supported caps simply
  // because its area and peak-to-base height are much larger.
  const widths = proposals.flatMap(p => p.evidence.map(e => e.width)).sort((a, b) => a - b);
  const evidenceScale = widths[Math.floor(widths.length / 2)] || 1;
  if (proposals.some(p => p.evidence.length > 1)) for (const p of proposals) p.score = p.evidence.reduce((sum, e) => sum + Math.min(e.height, evidenceScale * 0.5) * Math.min(e.width, evidenceScale) / (1 + 3 * e.tissue), 0);
  const proposal = proposals.sort((a, b) => b.score - a.score)[0]; up = proposal.up;
  if (proposal.peaks.some(p => p.local)) warnings.push('Local basin support was used because whole-scan height relief masks smaller peaks. Shallow saddles can still split cusps or miss flat crowns; proposals are not one-to-one tooth labels.');
  if (proposals.length > 1 && proposals[1].score > proposal.score * 0.8) warnings.push('The crown direction is ambiguous between PCA axes or signs. Verify orientation or use an explicit axis before accepting regions.');
  const members = proposal.peaks.map(() => [] as number[]);
  for (const f of mesh.valid) { budget.tick(); const id = proposal.labels[f]; if (id >= 0) members[id].push(f); }
  let candidates: AutoToothCandidate[] = [];
  for (let i = 0; i < members.length; i++) {
    const faces = members[i]; if (faces.length < 8) continue;
    const peak = proposal.peaks[i], centroid: Vec3 = [0, 0, 0]; let area = 0;
    for (const f of faces) {
      budget.tick(); const a = mesh.area[f]; area += a;
      for (let k = 0; k < 3; k++) centroid[k] += a * mesh.xyz[f * 3 + k];
    }
    const seedPoint = [0, 1, 2].map(k => (positions[peak.face * 9 + k] + positions[peak.face * 9 + 3 + k] + positions[peak.face * 9 + 6 + k]) / 3) as Vec3;
    candidates.push({ id: peak.face + 1, faces: new Uint32Array(faces), seed: { face: peak.face, point: seedPoint }, centroid: centroid.map((x, k) => mesh.reference[k] + mesh.scale * x / area) as Vec3, area: area * mesh.scale ** 2, height: peak.prominence * mesh.scale,
      evidence: { shoulderProjectedArea: peak.shoulderArea * mesh.scale ** 2, shoulderTissueCost: peak.shoulderTissue, reliefReference: peak.estimatedBase ? 'estimated-base' : 'merge-saddle' },
      warnings: ['Conservative height watershed; low cervical margins and interproximal valleys may be unassigned. Multiple proposals can belong to one crown.', 'Height is smoothed peak-to-saddle (or estimated base) relief in file units, not anatomical tooth height.', 'Shoulder support sums absolute projected triangle areas before growth cutoffs; folds may overlap and nearby tissue may be included. It is not contact area. Tissue cost is a color penalty, not a tissue probability.'] });
  }
  if (!candidates.length) return empty();
  if (candidates.length > 32) { warnings.push('More than 32 supported peaks were found; only the 32 strongest proposals are returned.'); candidates = candidates.slice(0, 32); }
  candidates.sort((a, b) => a.id - b.id);
  if (mesh.groups.length > 1) warnings.push('Disconnected shells were analysed independently; nearby surfaces were not joined. Fragmented crowns may need manual merging.');
  if (candidates.length === 1) warnings.push('Only one supported cap was found; a partial crown and a similar tissue dome cannot be distinguished reliably from geometry alone.');
  warnings.push('Orientation and region scale are estimated from surface shape in file units. Tissue peaks, gum inclusion, split cusps, and missed flat crowns can require correction. A crown without a distinct height maximum can be missed; smoothing depends on mesh resolution.');
  budget.tick(2048);
  return { frame: frame(mesh, up), candidates, warnings, unassignedTriangles: mesh.n - candidates.reduce((sum, c) => sum + c.faces.length, 0), method };
}
