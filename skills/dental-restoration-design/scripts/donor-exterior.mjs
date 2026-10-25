/** Data-only donor surface edits. No I/O, anatomy synthesis, fitting, or unit conversion. */
export const SCHEMA_VERSION = 'dental-donor-exterior/v1';
export const LIMITS = Object.freeze({ maxSourceTriangles: 2_000_000, maxOutputTriangles: 2_000_000, maxPlanes: 32, normalTolerance: 1e-8 });
export const LIMITATIONS = Object.freeze([
  'Donor exterior only. Clipping leaves uncapped selection cuts; OPEN patches are allowed.',
  'No smoothing, synthetic anatomy, registration, recentering, or automatic scaling. Distances are file units.',
  'An affine donor edit, including reflection or scaling, is not a rigid source pose.',
  'No intaglio, fixture, abutment, implant connection, or manufacturing geometry is generated.',
  'Clinical fit, contacts, occlusion, tissue clearance, material thickness, and manufacturability are unassessed.',
  'Topology checks do not rule out self-intersections or establish anatomical identity or clinical suitability.',
]);

const fail = message => { throw new Error(message); };
function object(value, keys, name) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail(`${name} must be a plain data object.`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${name}.${key} is unsupported.`);
}
function finite(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${name} must be finite.`);
  return value;
}
function vector(value, length, name) {
  if (!Array.isArray(value) || value.length !== length) fail(`${name} needs ${length} numbers.`);
  return value.map((v, i) => finite(v, `${name}[${i}]`));
}
function text(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) fail(`${name} needs a nonempty string of at most 2000 characters.`);
  return value;
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => a.map((v, i) => v - b[i]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const point = (p, i) => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
function doubleArea(a, b, c) {
  const value = Math.hypot(...cross(sub(b, a), sub(c, a)));
  if (!Number.isFinite(value)) fail('Triangle area overflow; use representable coordinates.');
  return value;
}
function cancellation(options) {
  object(options, ['checkCancelled'], 'options');
  if (options.checkCancelled !== undefined && typeof options.checkCancelled !== 'function') fail('checkCancelled must be a function.');
  return () => { if (options.checkCancelled?.()) fail('Cancelled.'); };
}

/** Detached explicit spec. Axes are checked, never normalized. Source claims are unverified. */
export function validateDonorSpec(input) {
  object(input, ['schemaVersion', 'source', 'planes', 'sourceToTarget', 'weldTolerance', 'componentPolicy'], 'spec');
  if (input.schemaVersion !== SCHEMA_VERSION) fail(`schemaVersion must be ${SCHEMA_VERSION}.`);
  object(input.source, ['id', 'sha256', 'provenance'], 'source');
  const source = { id: text(input.source.id, 'source.id'), sha256: input.source.sha256, provenance: text(input.source.provenance, 'source.provenance') };
  if (typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256)) fail('source.sha256 must contain 64 lowercase hex digits (unverified by the core).');
  if (!Array.isArray(input.planes) || input.planes.length > LIMITS.maxPlanes) fail(`planes must be an array of at most ${LIMITS.maxPlanes} half-spaces.`);
  const planes = input.planes.map((p, i) => {
    object(p, ['normal', 'offset'], `planes[${i}]`);
    const normal = vector(p.normal, 3, `planes[${i}].normal`);
    if (Math.abs(Math.hypot(...normal) - 1) > LIMITS.normalTolerance) fail(`planes[${i}].normal must be unit length; no normalization is applied.`);
    return { normal, offset: finite(p.offset, `planes[${i}].offset`) };
  });
  const m = vector(input.sourceToTarget, 16, 'sourceToTarget');
  if (m[3] !== 0 || m[7] !== 0 || m[11] !== 0 || m[15] !== 1) fail('sourceToTarget must be an affine column-major 4x4 matrix.');
  const determinant = dot(m.slice(0, 3), cross(m.slice(4, 7), m.slice(8, 11)));
  if (!Number.isFinite(determinant) || determinant === 0) fail('sourceToTarget determinant must be finite and nonzero (nonsingular).');
  if (finite(input.weldTolerance, 'weldTolerance') <= 0) fail('weldTolerance must be positive in source file units.');
  if (!['largest', 'all'].includes(input.componentPolicy)) fail('componentPolicy must be largest or all.');
  return { schemaVersion: SCHEMA_VERSION, source, planes, sourceToTarget: m, weldTolerance: input.weldTolerance, componentPolicy: input.componentPolicy };
}

function unionFind(count) {
  const parents = Int32Array.from({ length: count }, (_, i) => i);
  const root = i => { while (parents[i] !== i) { parents[i] = parents[parents[i]]; i = parents[i]; } return i; };
  return { root, join: (a, b) => { parents[root(b)] = root(a); } };
}

// Edge adjacency defines surface components. Vertex-only contact does not join patches.
function connectivity(indices, check) {
  const faces = unionFind(indices.length / 3), fans = unionFind(indices.length), edges = new Map();
  for (let i = 0; i < indices.length; i += 3) {
    if (i % 3072 === 0) check();
    for (let k = 0; k < 3; k++) {
      const corner = i + k, next = i + (k + 1) % 3, a = indices[corner], b = indices[next];
      const key = `${Math.min(a, b)},${Math.max(a, b)}`, previous = edges.get(key);
      if (!previous) edges.set(key, { corner, next, a, b, count: 1 });
      else {
        faces.join(previous.corner / 3 | 0, i / 3);
        fans.join(corner, a === previous.a ? previous.corner : previous.next);
        fans.join(next, b === previous.b ? previous.next : previous.corner);
        previous.count++;
        if (a === previous.a) previous.inconsistent = true;
      }
    }
  }
  const groups = new Map();
  for (let i = 0; i < indices.length / 3; i++) {
    if (i % 1024 === 0) check();
    const key = faces.root(i);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }
  return { groups: [...groups.values()], edges, fans };
}

function topology(mesh, check) {
  const { positions: p, indices: f } = mesh, { groups, edges, fans } = connectivity(f, check);
  let boundaryEdges = 0, nonManifoldEdges = 0, inconsistentSharedWinding = 0, area = 0;
  const vertexFans = new Map(), nonManifold = new Set(), min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const e of edges.values()) {
    if (e.count === 1) boundaryEdges++;
    if (e.count > 2) { nonManifoldEdges++; nonManifold.add(e.a); nonManifold.add(e.b); }
    if (e.count === 2 && e.inconsistent) inconsistentSharedWinding++;
  }
  for (let i = 0; i < f.length; i++) {
    if (i % 3072 === 0) check();
    const v = f[i], fan = fans.root(i);
    if (vertexFans.has(v) && vertexFans.get(v) !== fan) nonManifold.add(v);
    else vertexFans.set(v, fan);
    if (i % 3 === 0) {
      const a = doubleArea(point(p, f[i]), point(p, f[i + 1]), point(p, f[i + 2]));
      if (!a) fail('Retained triangle is degenerate after welding or transformation.');
      area += a / 2;
    }
  }
  for (let i = 0; i < p.length; i++) {
    if (i % 3072 === 0) check();
    if (!Number.isFinite(p[i])) fail('Transformed coordinates must be finite.');
    min[i % 3] = Math.min(min[i % 3], p[i]); max[i % 3] = Math.max(max[i % 3], p[i]);
  }
  if (!Number.isFinite(area) || area <= 0) fail('Retained area must be positive and finite.');
  const closed = boundaryEdges === 0 && nonManifoldEdges === 0 && nonManifold.size === 0 && inconsistentSharedWinding === 0;
  return { vertices: p.length / 3, triangles: f.length / 3, components: groups.length, boundaryEdges, nonManifoldEdges,
    nonManifoldVertices: nonManifold.size, inconsistentSharedWinding, degenerateTriangles: 0, areaFileUnitsSquared: area,
    bounds: { min, max }, closed, surfaceStatus: boundaryEdges ? 'open' : closed ? 'closed' : 'non-manifold-or-inconsistent',
    signedVolume: null, volumeReason: 'No solid or enclosed-volume assessment; open patches are allowed.' };
}

/** Clip dot(normal,p)<=offset in SOURCE coordinates, weld, select, then explicitly transform. */
export function createDonorExterior(sourcePositions, input, options = {}) {
  const check = cancellation(options); check();
  const spec = validateDonorSpec(input);
  if (!(Array.isArray(sourcePositions) || sourcePositions instanceof Float32Array || sourcePositions instanceof Float64Array) ||
      !sourcePositions.length || sourcePositions.length % 9) fail('sourcePositions must be a nonempty xyz triangle soup (length divisible by 9).');
  const sourceTriangles = sourcePositions.length / 9;
  if (sourceTriangles > LIMITS.maxSourceTriangles) fail(`Source exceeds ${LIMITS.maxSourceTriangles} triangle budget.`);
  for (let i = 0; i < sourcePositions.length; i++) {
    if (i % 3072 === 0) check();
    finite(sourcePositions[i], `sourcePositions[${i}]`);
  }
  const positions = [], indices = [], records = [], buckets = new Map(), tolerance = spec.weldTolerance;
  function weld(v) {
    const cell = v.map(x => Math.floor(x / tolerance));
    if (cell.some(x => !Number.isSafeInteger(x) || Math.abs(x) >= Number.MAX_SAFE_INTEGER - 1)) fail('Coordinates/weldTolerance exceed the safe numerical grid range.');
    let id = Infinity;
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
      const candidates = buckets.get(`${cell[0] + x},${cell[1] + y},${cell[2] + z}`);
      for (const j of candidates || []) if (j < id && Math.hypot(...sub(v, point(positions, j))) <= tolerance) id = j;
    }
    if (id !== Infinity) return id;
    id = positions.length / 3; positions.push(...v);
    const key = cell.join(',');
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(id);
    return id;
  }
  let discardedDegenerateTriangles = 0;
  for (let i = 0; i < sourceTriangles; i++) {
    if (i % 256 === 0) check();
    let polygon = [point(sourcePositions, i * 3), point(sourcePositions, i * 3 + 1), point(sourcePositions, i * 3 + 2)], clipped = false;
    if (!doubleArea(...polygon)) fail(`Source face ${i} is degenerate.`);
    for (const { normal, offset } of spec.planes) {
      const output = [];
      for (let k = 0; k < polygon.length; k++) {
        const a = polygon[k], b = polygon[(k + 1) % polygon.length];
        const da = finite(dot(normal, a) - offset, 'Plane distance'), db = finite(dot(normal, b) - offset, 'Plane distance');
        if (da <= 0) output.push(a); else clipped = true;
        if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
          // Evaluate shared edges in the same direction on both incident faces.
          const firstDifference = a.findIndex((v, axis) => v !== b[axis]);
          const forward = a[firstDifference] < b[firstDifference];
          const start = forward ? a : b, end = forward ? b : a;
          const ds = forward ? da : db, de = forward ? db : da;
          const t = ds / finite(ds - de, 'Plane intersection denominator');
          output.push(start.map((v, axis) => finite(v * (1 - t) + end[axis] * t, 'Clipped coordinate')));
        }
      }
      polygon = output;
      if (polygon.length < 3) break;
    }
    for (let k = 1; k < polygon.length - 1; k++) {
      const tri = [polygon[0], polygon[k], polygon[k + 1]];
      if (!doubleArea(...tri)) { discardedDegenerateTriangles++; continue; }
      const ids = tri.map(weld);
      if (new Set(ids).size < 3 || !doubleArea(...ids.map(j => point(positions, j)))) { discardedDegenerateTriangles++; continue; }
      if (records.length >= LIMITS.maxOutputTriangles) fail(`Output exceeds ${LIMITS.maxOutputTriangles} triangle budget.`);
      indices.push(...ids); records.push({ sourceFace: i, clipped });
    }
  }
  if (!records.length) fail('Selection is empty or all retained triangles are degenerate at weldTolerance.');
  const { groups } = connectivity(indices, check);
  groups.sort((a, b) => b.length - a.length || a[0] - b[0]);
  const chosen = spec.componentPolicy === 'largest' ? groups.slice(0, 1) : groups;
  const faceIds = chosen.flat().sort((a, b) => a - b), remap = new Map(), finalPositions = [], finalIndices = [];
  const m = spec.sourceToTarget, determinant = dot(m.slice(0, 3), cross(m.slice(4, 7), m.slice(8, 11)));
  for (const face of faceIds) {
    if (finalIndices.length % 3072 === 0) check();
    for (const corner of determinant < 0 ? [0, 2, 1] : [0, 1, 2]) {
      const original = indices[face * 3 + corner];
      if (!remap.has(original)) {
        const v = point(positions, original); remap.set(original, finalPositions.length / 3);
        finalPositions.push(...[0, 1, 2].map(a => finite(m[a] * v[0] + m[a + 4] * v[1] + m[a + 8] * v[2] + m[a + 12], 'Transformed coordinate')));
      }
      finalIndices.push(remap.get(original));
    }
  }
  const mesh = { positions: new Float64Array(finalPositions), indices: new Uint32Array(finalIndices) };
  const triangles = faceIds.map(i => records[i]), selected = new Set(triangles.map(t => t.sourceFace));
  const selection = { source: { ...spec.source, verification: 'caller-supplied-unverified' }, sourceFaceIndexConvention: '0-based input triangle-soup order',
    planes: spec.planes, weldTolerance: tolerance, weldSpace: 'source', componentPolicy: spec.componentPolicy,
    componentConnectivity: 'shared welded edge', largestCriterion: 'triangle count; ties use first source order',
    inputTriangles: sourceTriangles, selectedSourceFaces: selected.size, clippedSourceFaces: new Set(triangles.filter(t => t.clipped).map(t => t.sourceFace)).size,
    removedComponentTriangleCounts: spec.componentPolicy === 'largest' ? groups.slice(1).map(g => g.length) : [], discardedDegenerateTriangles, triangles };
  const report = { schemaVersion: SCHEMA_VERSION, distanceUnit: 'file units', integrity: topology(mesh, check),
    transform: { kind: 'affine-donor-edit', storage: 'column-major', sourceToTarget: [...m], determinant, windingReversed: determinant < 0 },
    assessment: { intaglio: 'not-generated', fixture: 'not-generated', implantConnection: 'not-generated', clinicalFit: 'unassessed', manufacturing: 'not-for-manufacturing' },
    limitations: [...LIMITATIONS] };
  check();
  return { spec, mesh, selection, report };
}

/** ASCII double xyz; no closure, volume, or clinical fit claim. */
export function toPLY(mesh) {
  object(mesh, ['positions', 'indices'], 'mesh');
  const { positions: p, indices: f } = mesh;
  if (!(p instanceof Float64Array) || !(f instanceof Uint32Array) || !p.length || p.length % 3 || !f.length || f.length % 3 ||
      f.length / 3 > LIMITS.maxOutputTriangles) fail('Expected a nonempty indexed Float64/Uint32 triangle mesh within output budget.');
  for (const x of p) if (!Number.isFinite(x)) fail('PLY coordinates must be finite.');
  for (const i of f) if (i >= p.length / 3) fail('PLY index out of range.');
  topology(mesh, () => {});
  const lines = ['ply', 'format ascii 1.0', 'comment Donor exterior; OPEN selection cuts allowed; no intaglio or fit assessment; NOT FOR MANUFACTURING',
    `element vertex ${p.length / 3}`, 'property double x', 'property double y', 'property double z', `element face ${f.length / 3}`, 'property list uchar int vertex_indices', 'end_header'];
  for (let i = 0; i < p.length; i += 3) lines.push(`${p[i]} ${p[i + 1]} ${p[i + 2]}`);
  for (let i = 0; i < f.length; i += 3) lines.push(`3 ${f[i]} ${f[i + 1]} ${f[i + 2]}`);
  return `${lines.join('\n')}\n`;
}
