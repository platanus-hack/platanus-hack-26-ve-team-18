/**
 * Pure, deterministic exterior-concept API. No filesystem, network, patient data,
 * fitting, or evaluation of code. Suitable for a worker or a validated SDK tool.
 * See README.md beside this module for the complete input contract.
 */
export const SCHEMA_VERSION = 'dental-crown-concept/v1';
export const IDENTITY_MATRIX = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
export const LIMITS = Object.freeze({
  frameTolerance: 1e-8, maxSources: 64, maxCusps: 8,
  angularSegments: [12, 256], axialSegments: [1, 64], radialSegments: [2, 128],
  maxTriangles: 100_000,
});
export const CONCEPT_LIMITATIONS = Object.freeze([
  'Hypothetical exterior visualization only; site and tooth identity are caller supplied.',
  'The flat basal closure is artificial, not a fitted intaglio, cervical margin, implant connection, fixture, abutment, or drill guide.',
  'Fixture, abutment, clinical fit, margins, emergence profile, occlusion, contacts, tissue clearance, material thickness, and manufacturability are unassessed.',
  'No anatomy was inferred from a scan. Cusp heights are additive field amplitudes, not measured anatomical apex heights.',
  'Coordinates and distances are file units. No unit conversion, registration, recentering, or automatic gap detection is performed.',
  'Scan hashes and provenance in a generation spec are caller supplied; generation does not verify file contents.',
  'A closed concept surface does not establish clinical suitability or manufacturing readiness.',
]);

const fail = message => { throw new Error(message); };
function object(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object.`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${name}.${key} is not supported.`);
  return value;
}
function text(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2000) fail(`${name} must be a nonempty string (at most 2000 characters).`);
  return value;
}
function number(value, name, min = -Infinity, max = Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${name} must be finite in [${min}, ${max}].`);
  return value;
}
function positive(value, name) {
  number(value, name);
  if (value <= 0) fail(`${name} must be positive.`);
  return value;
}
function vector(value, name, length = 3) {
  if (!Array.isArray(value) || value.length !== length) fail(`${name} must contain ${length} finite numbers.`);
  return value.map((v, i) => number(v, `${name}[${i}]`));
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const subtract = (a, b) => a.map((v, i) => v - b[i]);

function rotation(x, y, z, name) {
  const t = LIMITS.frameTolerance;
  if ([x, y, z].some(a => Math.abs(dot(a, a) - 1) > t) ||
      Math.abs(dot(x, y)) > t || Math.abs(dot(x, z)) > t || Math.abs(dot(y, z)) > t ||
      Math.abs(dot(cross(x, y), z) - 1) > t) {
    fail(`${name} must be orthonormal and right-handed (x cross y = z); no axis normalization is applied.`);
  }
}

export function validateRigidMatrix(value, name = 'matrix') {
  const m = vector(value, name, 16);
  if (m[3] !== 0 || m[7] !== 0 || m[11] !== 0 || m[15] !== 1) fail(`${name} must be a column-major affine rigid 4x4 matrix.`);
  rotation(m.slice(0, 3), m.slice(4, 7), m.slice(8, 11), name);
  return m;
}

/** Frame axes are columns; local +z is the caller's basal-to-occlusal direction. */
export function frameMatrices(frame) {
  object(frame, ['origin', 'xAxis', 'yAxis', 'zAxis', 'provenance'], 'frame');
  const origin = vector(frame.origin, 'frame.origin');
  const x = vector(frame.xAxis, 'frame.xAxis'), y = vector(frame.yAxis, 'frame.yAxis'), z = vector(frame.zAxis, 'frame.zAxis');
  text(frame.provenance, 'frame.provenance');
  rotation(x, y, z, 'frame');
  const localToWorld = [...x, 0, ...y, 0, ...z, 0, ...origin, 1];
  // Compute the actual inverse, rather than silently correcting near-unit axes.
  const determinant = dot(x, cross(y, z));
  const rows = [cross(y, z), cross(z, x), cross(x, y)].map(a => a.map(v => v / determinant));
  const worldToLocal = [
    rows[0][0], rows[1][0], rows[2][0], 0,
    rows[0][1], rows[1][1], rows[2][1], 0,
    rows[0][2], rows[1][2], rows[2][2], 0,
    -dot(rows[0], origin), -dot(rows[1], origin), -dot(rows[2], origin), 1,
  ];
  if (![...localToWorld, ...worldToLocal].every(Number.isFinite)) fail('Frame matrices overflow; use representable file coordinates.');
  return { storage: 'column-major', localToWorld, worldToLocal };
}

export function transformPoint(matrix, point) {
  return [0, 1, 2].map(a => matrix[a] * point[0] + matrix[4 + a] * point[1] + matrix[8 + a] * point[2] + matrix[12 + a]);
}

/** Validate the entire data-only contract. Returns a detached spec with recorded poses. */
export function validateConceptSpec(input) {
  object(input, ['schemaVersion', 'purpose', 'units', 'sources', 'site', 'frame', 'geometry', 'pose'], 'spec');
  if (input.schemaVersion !== SCHEMA_VERSION) fail(`schemaVersion must be ${SCHEMA_VERSION}.`);
  if (input.purpose !== 'exterior-concept-only') fail('purpose must be exterior-concept-only.');
  const units = object(input.units, ['status', 'name', 'provenance'], 'units');
  if (!['unknown', 'declared'].includes(units.status)) fail('units.status must be unknown or declared.');
  if (units.status === 'unknown' && units.name !== null) fail('Unknown units require name: null; millimeters are never assumed.');
  if (units.status === 'declared') text(units.name, 'units.name');
  text(units.provenance, 'units.provenance');
  if (!Array.isArray(input.sources) || !input.sources.length || input.sources.length > LIMITS.maxSources) fail('sources must contain 1–64 source scans.');
  const ids = new Set();
  for (const [i, source] of input.sources.entries()) {
    const n = `sources[${i}]`;
    object(source, ['id', 'fileName', 'role', 'fileToWorld', 'provenance'], n);
    if (typeof source.id !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(source.id)) fail(`${n}.id must be sha256:<64 lowercase hex digits>.`);
    if (ids.has(source.id)) fail('Source scan IDs must be unique.');
    ids.add(source.id);
    text(source.fileName, `${n}.fileName`);
    if (!['upper', 'lower', 'bite'].includes(source.role)) fail(`${n}.role must be upper, lower, or bite.`);
    validateRigidMatrix(source.fileToWorld, `${n}.fileToWorld`);
    text(source.provenance, `${n}.provenance`);
  }
  const site = object(input.site, ['hypothetical', 'toothNotation', 'toothIdentity', 'arch', 'sourceScanId', 'provenance'], 'site');
  if (site.hypothetical !== true) fail('site.hypothetical must be true.');
  for (const key of ['toothNotation', 'toothIdentity', 'provenance']) text(site[key], `site.${key}`);
  if (!['upper', 'lower'].includes(site.arch)) fail('site.arch must be upper or lower.');
  const siteSource = input.sources.find(s => s.id === site.sourceScanId);
  if (!siteSource || siteSource.role !== site.arch) fail('site.sourceScanId must identify a source scan with the same arch role.');
  const pose = frameMatrices(input.frame);
  if (input.pose !== undefined) {
    object(input.pose, ['storage', 'localToWorld', 'worldToLocal'], 'pose');
    if (input.pose.storage !== 'column-major') fail('pose.storage must be column-major.');
    for (const key of ['localToWorld', 'worldToLocal']) {
      const given = vector(input.pose[key], `pose.${key}`, 16);
      if (given.some((v, i) => Math.abs(v - pose[key][i]) > 1e-10 * Math.max(1, Math.abs(v), Math.abs(pose[key][i])))) fail(`pose.${key} does not match frame.`);
    }
  }
  const g = object(input.geometry, ['kind', 'toothClass', 'width', 'depth', 'basalWidth', 'basalDepth', 'shoulderHeight', 'domeHeight', 'grooveDepth', 'grooveWidth', 'cusps', 'tessellation', 'basalClosure'], 'geometry');
  if (g.kind !== 'parametric-crown-exterior-v1') fail('geometry.kind must be parametric-crown-exterior-v1.');
  if (!['molar', 'premolar'].includes(g.toothClass)) fail('geometry.toothClass must be molar or premolar (metadata only).');
  for (const key of ['width', 'depth', 'basalWidth', 'basalDepth', 'shoulderHeight', 'domeHeight', 'grooveWidth']) positive(g[key], `geometry.${key}`);
  number(g.grooveDepth, 'geometry.grooveDepth', 0);
  if (g.basalWidth > g.width || g.basalDepth > g.depth) fail('Basal dimensions must not exceed exterior width/depth.');
  if (g.grooveDepth >= g.shoulderHeight) fail('grooveDepth must be below shoulderHeight to keep the height field above the artificial base.');
  if (g.grooveDepth > g.domeHeight) fail('grooveDepth must not exceed domeHeight; the top must stay at or above the shoulder to avoid side-wall crossings.');
  if (g.basalClosure !== 'artificial-flat-cap') fail('geometry.basalClosure must be artificial-flat-cap.');
  if (!Array.isArray(g.cusps) || g.cusps.length < 1 || g.cusps.length > LIMITS.maxCusps) fail('geometry.cusps must contain 1–8 explicit cusp influences.');
  for (const [i, cusp] of g.cusps.entries()) {
    const n = `geometry.cusps[${i}]`;
    object(cusp, ['position', 'height', 'radius'], n);
    const [x, y] = vector(cusp.position, `${n}.position`, 2);
    if (Math.hypot(x / (g.width / 2), y / (g.depth / 2)) >= 1) fail(`${n}.position must be strictly inside the footprint ellipse.`);
    positive(cusp.height, `${n}.height`);
    positive(cusp.radius, `${n}.radius`);
  }
  const t = object(g.tessellation, ['angularSegments', 'axialSegments', 'radialSegments'], 'geometry.tessellation');
  for (const key of ['angularSegments', 'axialSegments', 'radialSegments']) {
    number(t[key], `tessellation.${key}`, ...LIMITS[key]);
    if (!Number.isInteger(t[key])) fail(`tessellation.${key} must be an integer.`);
  }
  if (2 * t.angularSegments * (t.axialSegments + t.radialSegments) > LIMITS.maxTriangles) fail('Tessellation exceeds 100000 triangles.');
  // Reject extreme dimensions whose ratios or height sums overflow before allocation.
  if (![g.width / 2, g.depth / 2, g.basalWidth / 2, g.basalDepth / 2].every(v => v > 0) ||
      !Number.isFinite(g.shoulderHeight + g.domeHeight + g.cusps.reduce((s, c) => s + c.height, 0))) fail('Dimensions exceed numerical range.');
  return { ...structuredClone(input), pose };
}

/** Bounds in the existing global coordinate system; never recenters the mesh. */
export function meshBounds(positions) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i])) fail('Mesh coordinates must be finite.');
    const a = i % 3;
    min[a] = Math.min(min[a], positions[i]); max[a] = Math.max(max[a], positions[i]);
  }
  return { min, max, size: min.map((v, a) => max[a] - v) };
}

/** Expands indexed positions for the existing collision worker's CollisionPart. */
export function trianglePositions(mesh) {
  const result = new Float64Array(mesh.indices.length * 3);
  for (let i = 0; i < mesh.indices.length; i++) result.set(mesh.positions.subarray(mesh.indices[i] * 3, mesh.indices[i] * 3 + 3), i * 3);
  return result;
}

/** Deterministic indexed surface. Top is a height graph, sides are nested rings. */
export function createCrownConcept(input, { checkCancelled = () => {} } = {}) {
  const spec = validateConceptSpec(input), g = spec.geometry;
  const { angularSegments: n, axialSegments: s, radialSegments: r } = g.tessellation;
  const local = [0, 0, 0], faces = [];
  function ring(rx, ry, height) {
    checkCancelled();
    const start = local.length / 3;
    for (let i = 0; i < n; i++) {
      const angle = i * 2 * Math.PI / n, x = rx * Math.cos(angle), y = ry * Math.sin(angle);
      local.push(x, y, typeof height === 'function' ? height(x, y) : height);
    }
    return start;
  }
  function connect(a, b) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      faces.push(a + i, a + j, b + i, a + j, b + j, b + i);
    }
  }
  const base = ring(g.basalWidth / 2, g.basalDepth / 2, 0);
  for (let i = 0; i < n; i++) faces.push(0, base + (i + 1) % n, base + i);
  let last = base;
  for (let level = 1; level <= s; level++) {
    const t = level / s, bulge = Math.sin(t * Math.PI / 2);
    const next = ring((g.basalWidth + (g.width - g.basalWidth) * bulge) / 2,
      (g.basalDepth + (g.depth - g.basalDepth) * bulge) / 2, g.shoulderHeight * t);
    connect(last, next); last = next;
  }
  function top(x, y) {
    const edge = Math.max(0, 1 - (x / (g.width / 2)) ** 2 - (y / (g.depth / 2)) ** 2);
    const cusps = g.cusps.reduce((sum, c) => sum + c.height * Math.exp(-0.5 * (Math.hypot(x - c.position[0], y - c.position[1]) / c.radius) ** 2), 0);
    const groove = Math.max(Math.exp(-((x / g.grooveWidth) ** 2)), Math.exp(-((y / g.grooveWidth) ** 2)));
    return g.shoulderHeight + edge * (g.domeHeight + cusps - g.grooveDepth * groove);
  }
  for (let level = r - 1; level >= 1; level--) {
    const next = ring(g.width / 2 * level / r, g.depth / 2 * level / r, top);
    connect(last, next); last = next;
  }
  const center = local.length / 3;
  local.push(0, 0, top(0, 0));
  for (let i = 0; i < n; i++) faces.push(last + i, last + (i + 1) % n, center);
  const positions = new Float64Array(local.length);
  for (let i = 0; i < local.length; i += 3) {
    if ((i & 1023) === 0) checkCancelled();
    positions.set(transformPoint(spec.pose.localToWorld, local.slice(i, i + 3)), i);
  }
  const mesh = { positions, indices: Uint32Array.from(faces) };
  const integrity = inspectMesh(mesh);
  if (!integrity.closed || !Number.isFinite(integrity.signedVolume) || integrity.signedVolume <= 0) fail('Generated geometry lost numerical precision or is not an oriented closed manifold.');
  // The repo importer stores Float32 coordinates. Fail explicitly instead of
  // silently moving the concept to the origin when the file pose loses detail.
  const previewIntegrity = inspectMesh({ positions: Float32Array.from(positions), indices: mesh.indices });
  if (!previewIntegrity.closed || !Number.isFinite(previewIntegrity.signedVolume) || previewIntegrity.signedVolume <= 0) fail('Original global coordinates lose geometry in the Float32 importer. No recentering was applied; choose a representable spec.');
  return {
    spec, mesh,
    report: {
      schemaVersion: SCHEMA_VERSION, purpose: spec.purpose, units: spec.units,
      coordinateSystem: 'original-world-frame', pose: spec.pose,
      sources: spec.sources, sourceHashVerification: 'caller-supplied-unverified', site: spec.site,
      integrity, float32ImportCheck: 'passed-nondegenerate',
      volumeMeaning: 'Signed volume of the artificially closed concept in file units cubed; orientation check, not tissue or overlap volume.',
      basalClosure: 'artificial-flat-cap',
      assessments: { fixture: 'unassessed', abutment: 'unassessed', clinicalFit: 'unassessed', occlusion: 'unassessed', manufacturing: 'not-for-manufacturing' },
      limitations: [...CONCEPT_LIMITATIONS],
    },
  };
}

/** Edge incidence AND connected vertex fans; does not test general self-intersection. */
export function inspectMesh({ positions, indices }) {
  if (!(positions instanceof Float64Array || positions instanceof Float32Array) || !positions.length || positions.length % 3 ||
      !(indices instanceof Uint32Array) || !indices.length || indices.length % 3) fail('Expected indexed Float32/Float64 xyz and Uint32 triangles.');
  const bounds = meshBounds(positions), vertexCount = positions.length / 3, edges = new Map();
  const fans = Int32Array.from({ length: indices.length }, (_, i) => i), first = new Map();
  const root = i => { while (fans[i] !== i) { fans[i] = fans[fans[i]]; i = fans[i]; } return i; };
  let degenerateTriangles = 0, signedVolume = 0, consistentlyOriented = true;
  const origin = Array.from(positions.subarray(0, 3));
  for (let i = 0; i < indices.length; i += 3) {
    const ids = Array.from(indices.subarray(i, i + 3));
    if (ids.some(id => id >= vertexCount)) fail('Mesh index is out of bounds.');
    const points = ids.map(id => Array.from(positions.subarray(id * 3, id * 3 + 3)));
    const normal = cross(subtract(points[1], points[0]), subtract(points[2], points[0]));
    const area = Math.hypot(...normal);
    if (!(area > 0) || !Number.isFinite(area)) degenerateTriangles++;
    signedVolume += dot(subtract(points[0], origin), cross(subtract(points[1], origin), subtract(points[2], origin))) / 6;
    for (let c = 0; c < 3; c++) {
      const a = ids[c], b = ids[(c + 1) % 3], corner = i + c, next = i + (c + 1) % 3;
      if (!first.has(a)) first.set(a, corner);
      const key = `${Math.min(a, b)},${Math.max(a, b)}`, previous = edges.get(key);
      if (!previous) edges.set(key, { count: 1, a, corner, next });
      else {
        previous.count++;
        const same = previous.a === a;
        if (same) consistentlyOriented = false;
        fans[root(corner)] = root(same ? previous.corner : previous.next);
        fans[root(next)] = root(same ? previous.next : previous.corner);
      }
    }
  }
  let vertexManifold = first.size === vertexCount;
  for (let i = 0; i < indices.length; i++) if (root(i) !== root(first.get(indices[i]))) vertexManifold = false;
  const edgeManifold = [...edges.values()].every(edge => edge.count === 2);
  return { vertexCount, triangleCount: indices.length / 3, edgeCount: edges.size, edgeManifold, vertexManifold,
    consistentlyOriented, closed: edgeManifold && vertexManifold && consistentlyOriented && degenerateTriangles === 0,
    degenerateTriangles, signedVolume, bounds };
}

/** ASCII doubles preserve the generated global coordinates in the exported file. */
export function toPLY(mesh) {
  inspectMesh(mesh);
  const { positions, indices } = mesh;
  const lines = ['ply', 'format ascii 1.0', 'comment Hypothetical exterior concept; artificial basal closure; NOT FOR MANUFACTURING',
    'comment Coordinates are original file units; no unit conversion', `element vertex ${positions.length / 3}`,
    'property double x', 'property double y', 'property double z', `element face ${indices.length / 3}`,
    'property list uchar int vertex_indices', 'end_header'];
  for (let i = 0; i < positions.length; i += 3) lines.push(`${positions[i]} ${positions[i + 1]} ${positions[i + 2]}`);
  for (let i = 0; i < indices.length; i += 3) lines.push(`3 ${indices[i]} ${indices[i + 1]} ${indices[i + 2]}`);
  return `${lines.join('\n')}\n`;
}
