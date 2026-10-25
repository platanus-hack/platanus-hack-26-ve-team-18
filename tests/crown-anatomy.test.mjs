import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CROWN_THETA, CROWN_WALL, CROWN_RINGS,
  templateShape, donorShape, validateCrownShape, buildCrownMesh, placeCrown, auditCrownMesh, cloneShape,
} from '../src/crown-anatomy.ts';
import { generateRestoration } from '../src/restoration-geometry.ts';

const identity = () => ({ origin: [0, 0, 0], mesial: [1, 0, 0], buccal: [0, 1, 0], occlusal: [0, 0, 1] });
const info = { arch: 'upper', digit: 6, donorFdi: 16, donorPartId: 'synthetic-donor', donorToothId: 1, mirrored: false };
const subtract = (a, b) => a.map((value, i) => value - b[i]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const close = (a, b, tolerance = 1e-5) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
const point = (vertices, id) => Array.from(vertices.subarray(id * 3, id * 3 + 3));

function integrity(mesh) {
  const audit = auditCrownMesh(mesh);
  assert.equal(audit.closed, true);
  assert.ok(audit.volume > 0);
  assert.equal(audit.degenerate, 0);
  assert.equal(audit.boundaryEdges, 0);
  assert.equal(audit.nonManifoldEdges, 0);
  assert.equal(audit.orientationErrors, 0);
  assert.equal(audit.consistentlyOriented, true);
  assert.equal(audit.nonManifoldVertices, 0);
  assert.equal(audit.vertexManifold, true);
  assert.equal(audit.components, 1);
  assert.equal(audit.selfIntersection, 'untested');
  const edges = new Set();
  for (let i = 0; i < mesh.indices.length; i += 3) for (let c = 0; c < 3; c++) {
    const a = mesh.indices[i + c], b = mesh.indices[i + (c + 1) % 3];
    edges.add(`${Math.min(a, b)},${Math.max(a, b)}`);
  }
  assert.equal(mesh.vertexCount - edges.size + mesh.indices.length / 3, 2);
  return audit;
}

function emittedIntegrity(placed) {
  assert.equal(placed.positions.length, placed.normals.length);
  assert.ok(placed.positions.every(Number.isFinite));
  const vertices = [], indices = [], ids = new Map();
  for (let i = 0; i < placed.positions.length; i += 3) {
    const p = Array.from(placed.positions.subarray(i, i + 3)), key = p.join(',');
    if (!ids.has(key)) { ids.set(key, vertices.length / 3); vertices.push(...p); }
    indices.push(ids.get(key));
  }
  const mesh = { vertices: Float32Array.from(vertices), indices: Uint32Array.from(indices), vertexCount: vertices.length / 3 };
  integrity(mesh);
  for (let i = 0; i < placed.positions.length; i += 9) {
    const [a, b, c] = [0, 3, 6].map(offset => Array.from(placed.positions.subarray(i + offset, i + offset + 3)));
    const n = cross(subtract(b, a), subtract(c, a)), length = Math.hypot(...n);
    assert.ok(length > 0);
    for (let corner = 0; corner < 3; corner++) {
      const actual = Array.from(placed.normals.subarray(i + corner * 3, i + corner * 3 + 3));
      close(Math.hypot(...actual), 1, 1e-6);
      close(dot(n, actual) / length, 1, 1e-6);
    }
  }
  return mesh;
}

// Vertical ray against the actual emitted triangles, including their planar
// interpolation. Reading template control heights would not test survival.
function surfaceHeightAt(positions, x, y) {
  let height = -Infinity;
  for (let i = 0; i < positions.length; i += 9) {
    const ax = positions[i], ay = positions[i + 1], bx = positions[i + 3], by = positions[i + 4], cx = positions[i + 6], cy = positions[i + 7];
    const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(det) < 1e-12) continue;
    const u = ((x - ax) * (cy - ay) - (cx - ax) * (y - ay)) / det;
    const v = ((bx - ax) * (y - ay) - (x - ax) * (by - ay)) / det;
    if (u >= -1e-8 && v >= -1e-8 && u + v <= 1 + 1e-8) height = Math.max(height, positions[i + 2] + u * (positions[i + 5] - positions[i + 2]) + v * (positions[i + 8] - positions[i + 2]));
  }
  assert.ok(Number.isFinite(height), `No emitted surface at ${x}, ${y}`);
  return height;
}

// Width of the emitted exterior projected onto the occlusal plane, sliced at y.
// Triangle-edge interpolation includes the actual wall contour, not just rim
// control radii. These normalized silhouette checks are not clinical dimensions.
function projectedWidthAtY(positions, y) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < positions.length; i += 9) for (let c = 0; c < 3; c++) {
    const a = i + c * 3, b = i + ((c + 1) % 3) * 3;
    const ay = positions[a + 1], by = positions[b + 1];
    if (ay === by || y < Math.min(ay, by) || y > Math.max(ay, by)) continue;
    const x = positions[a] + (positions[b] - positions[a]) * (y - ay) / (by - ay);
    lo = Math.min(lo, x); hi = Math.max(hi, x);
  }
  assert.ok(Number.isFinite(lo) && hi > lo);
  return hi - lo;
}

function occlusalPeaks(mesh) {
  const neighbours = Array.from({ length: mesh.vertexCount }, () => new Set());
  for (let i = 0; i < mesh.indices.length; i += 3) for (let c = 0; c < 3; c++) {
    const a = mesh.indices[i + c], b = mesh.indices[i + (c + 1) % 3];
    neighbours[a].add(b); neighbours[b].add(a);
  }
  const peaks = [];
  for (let id = 0; id < mesh.vertexCount; id++) {
    const p = point(mesh.vertices, id);
    // Exclude the peripheral marginal ridges from the cusp-table check.
    if (Math.hypot(p[0], p[1]) < 0.75 && [...neighbours[id]].every(other => p[2] > mesh.vertices[other * 3 + 2])) peaks.push(p);
  }
  return peaks;
}

// Flood the actual triangle graph in height order. A basin's persistence is
// the rise needed before it connects to a lower basin. This distinguishes
// sampled shallow ripples from additional fossae, without claiming smoothness.
function occlusalBasins(mesh) {
  const ids = mesh.zones.occlusal, active = new Set(ids);
  const neighbours = Array.from({ length: mesh.vertexCount }, () => new Set());
  for (let i = 0; i < mesh.indices.length; i += 3) for (let c = 0; c < 3; c++) {
    const a = mesh.indices[i + c], b = mesh.indices[i + (c + 1) % 3];
    if (active.has(a) && active.has(b)) { neighbours[a].add(b); neighbours[b].add(a); }
  }
  const z = id => mesh.vertices[id * 3 + 2], parents = new Map(), origins = new Map(), basins = [];
  const root = id => { while (parents.get(id) !== id) id = parents.get(id); return id; };
  for (const id of [...ids].sort((a, b) => z(a) - z(b) || a - b)) {
    parents.set(id, id); origins.set(id, id);
    for (const neighbour of neighbours[id]) if (parents.has(neighbour)) {
      const a = root(id), b = root(neighbour);
      if (a === b) continue;
      const higher = z(origins.get(a)) > z(origins.get(b)) ? a : b, lower = higher === a ? b : a;
      const origin = origins.get(higher), depth = z(id) - z(origin);
      if (depth > 0) basins.push({ position: point(mesh.vertices, origin), depth });
      parents.set(higher, lower);
    }
  }
  return basins;
}

// Analytic cylinder sidewalls plus optional measured polar occlusal surface.
// The bottom is open unless explicitly added, as with a cropped scan.
function donor({ height = () => 1, top = true, bottom = false, missing = () => false } = {}) {
  const n = CROWN_THETA, rings = 32, positions = [], topFaces = [];
  const at = (r, a, z) => [r * Math.cos(a * Math.PI * 2 / n), r * Math.sin(a * Math.PI * 2 / n), z];
  const face = (a, b, c, isTop = false) => {
    if (isTop) topFaces.push(positions.length / 9);
    positions.push(...a, ...b, ...c);
  };
  for (let a = 0; a < n; a++) {
    const b = (a + 1) % n;
    for (let level = 0; level < 4; level++) {
      const z0 = level / 4, z1 = (level + 1) / 4;
      const p = at(1, a, z0), q = at(1, b, z0), r = at(1, a, z1), s = at(1, b, z1);
      face(p, q, r); face(q, s, r);
    }
    if (bottom) face(at(1, b, 0), at(1, a, 0), [0, 0, 0]);
    if (top && !missing(a)) for (let ring = 0; ring < rings; ring++) {
      const outer = 1 - ring / rings, inner = 1 - (ring + 1) / rings;
      const p = at(outer, a, height(outer)), q = at(outer, b, height(outer));
      if (inner === 0) face(p, q, [0, 0, height(0)], true);
      else { const r = at(inner, a, height(inner)), s = at(inner, b, height(inner)); face(p, q, r, true); face(q, s, r, true); }
    }
  }
  return { positions: Float32Array.from(positions), faces: Array.from({ length: positions.length / 9 }, (_, i) => i), topFaces };
}

function shuffledSurface(input) {
  let state = 42;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  const order = input.faces.slice();
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const positions = new Float32Array(input.positions.length);
  order.forEach((id, i) => {
    const corners = [0, 1, 2].map(c => point(input.positions, id * 3 + c));
    const shift = i % 3, winding = i % 2 ? [0, 2, 1] : [0, 1, 2];
    winding.forEach((c, k) => positions.set(corners[(c + shift) % 3], i * 9 + k * 3));
  });
  return { positions, faces: input.faces.slice().reverse() };
}

test('all arches and digits retain deterministic single-shell crown topology and zones', () => {
  const reference = buildCrownMesh(templateShape('upper', 6), [5, 4, 3]);
  for (const arch of ['upper', 'lower']) for (let digit = 1; digit <= 8; digit++) {
    const shape = templateShape(arch, digit), copy = cloneShape(shape);
    validateCrownShape(shape);
    assert.deepEqual(shape, templateShape(arch, digit));
    assert.deepEqual(shape, copy);
    assert.notEqual(shape.rim.buffer, copy.rim.buffer);
    const mesh = buildCrownMesh(shape, [5, 4, 3]);
    integrity(mesh);
    assert.equal(mesh.vertexCount, (CROWN_WALL + CROWN_RINGS) * CROWN_THETA + 2);
    assert.equal(mesh.indices.length / 3, mesh.vertexCount * 2 - 4);
    // Fitting stores vertex offsets and indexes emitted triangle corners.
    assert.deepEqual(mesh.indices, reference.indices);
    assert.deepEqual(mesh.zones, reference.zones);
    assert.equal(mesh.zones.margin.length, CROWN_THETA);
    assert.equal(mesh.zones.occlusal.length, CROWN_RINGS * CROWN_THETA + 1);
    assert.ok(mesh.zones.mesial.every(id => mesh.vertices[id * 3] > 0));
    assert.ok(mesh.zones.distal.every(id => mesh.vertices[id * 3] < 0));
    for (let a = 0; a < CROWN_THETA; a++) close(shape.rim[a], shape.wall[(CROWN_WALL - 1) * CROWN_THETA + a], 0);
    assert.equal(mesh.vertices[(mesh.vertexCount - 1) * 3 + 2], 0);
    const tableHeights = Array.from(shape.occlusal);
    assert.ok(Math.max(...tableHeights) - Math.min(...tableHeights) > 0.03);
    assert.ok(Math.min(shape.apex, ...tableHeights, ...shape.rimZ) > 0);
    close(Math.max(shape.apex, ...tableHeights, ...shape.rimZ), 1, 1e-7);
  }
});

test('posterior contacts have a distinct convexity above the facial contour without a proximal seam', () => {
  for (const arch of ['upper', 'lower']) for (const digit of [4, 5, 6, 7, 8]) {
    const mesh = buildCrownMesh(templateShape(arch, digit), [2, 2, 1]);
    const profile = angle => Array.from({ length: CROWN_WALL }, (_, j) => point(mesh.vertices, j * CROWN_THETA + angle));
    const radius = p => Math.hypot(p[0], p[1]);
    const widest = samples => samples.reduce((best, p) => radius(p) > radius(best) ? p : best);
    const facial = widest(profile(CROWN_THETA / 4));
    for (const angle of [0, CROWN_THETA / 2]) {
      const samples = profile(angle), contact = widest(samples);
      assert.ok(contact[2] > facial[2] + 0.2, `${arch} ${digit}: contact blended into the low facial bulge`);
      assert.ok(radius(contact) > radius(samples[0]) + 0.15);
      assert.ok(radius(contact) > radius(samples.at(-1)) + 0.04, 'Contact must turn inward toward the marginal ridge');
      // Both proximal axes, including angular wraparound. A smooth profile
      // has small second differences rather than a one-sided contour jump.
      for (let j = 0; j < CROWN_WALL; j++) {
        const at = a => radius(point(mesh.vertices, j * CROWN_THETA + (a + CROWN_THETA) % CROWN_THETA));
        assert.ok(Math.abs(at(angle) - (at(angle - 1) + at(angle + 1)) / 2) < 0.003);
      }
    }
  }
});

test('posterior proximal-to-buccal shoulders are defined but softened above the rounded neck', () => {
  for (const arch of ['upper', 'lower']) for (const digit of [4, 5, 6, 7, 8]) {
    const mesh = buildCrownMesh(templateShape(arch, digit), [2, 2, 1]);
    // Turning angles on the emitted wall ring's XY outline. This tests the
    // visible contour at normalized dimensions, not clinical line-angle values.
    const turn = (level, angle) => {
      const at = a => point(mesh.vertices, level * CROWN_THETA + (a + CROWN_THETA) % CROWN_THETA);
      const a = at(angle - 1), b = at(angle), c = at(angle + 1);
      const u = subtract(b, a), v = subtract(c, b);
      return Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1]) * 180 / Math.PI;
    };
    const contactLevel = Math.round((CROWN_WALL - 1) * 0.77);
    for (const angle of [CROWN_THETA / 8, 3 * CROWN_THETA / 8]) {
      assert.ok(turn(contactLevel, angle) > 5, `${arch} ${digit}: rounded-away buccal shoulder`);
      assert.ok(turn(contactLevel, angle) > 1.3 * turn(0, angle));
    }
    for (let angle = 0; angle < CROWN_THETA; angle++) {
      const change = turn(contactLevel, angle);
      assert.ok(change > 0 && change < 12, `${arch} ${digit}: sharp corner or contact dimple at ${angle}`);
    }
  }
});

test('posterior marginal ridges turn from the outer wall into the occlusal table without a rim trench', () => {
  for (const arch of ['upper', 'lower']) for (const digit of [4, 5, 6, 7, 8]) {
    const { positions } = placeCrown(buildCrownMesh(templateShape(arch, digit), [2, 2, 1]), identity());
    for (const side of [-1, 1]) {
      const at = x => surfaceHeightAt(positions, side * x, 0);
      const rim = at(0.93), crest = at(0.8);
      assert.ok(crest > rim + 0.02, `${arch} ${digit}: missing marginal ridge on side ${side}`);
      assert.ok(crest > at(0.7) + 0.015, `${arch} ${digit}: ridge does not turn into the table`);
      for (const x of [0.82, 0.86, 0.9]) assert.ok(at(x) >= rim, 'Peripheral trench between the wall and ridge');
      assert.ok(at(0.9) - rim < 0.02, 'Abrupt rim-to-table step');
    }
  }
});

test('emitted posterior cusp slopes reach a scalloped exterior without an outer shelf or changed neck', () => {
  for (const arch of ['upper', 'lower']) for (const digit of [4, 5, 6, 7, 8]) {
    const shape = templateShape(arch, digit), mesh = buildCrownMesh(shape, [2, 2, 1]);
    const { positions } = placeCrown(mesh, identity());
    const at = (angle, rho) => surfaceHeightAt(positions,
      mesh.vertices[((CROWN_WALL - 1) * CROWN_THETA + angle) * 3] * rho,
      mesh.vertices[((CROWN_WALL - 1) * CROWN_THETA + angle) * 3 + 1] * rho);
    // Heights come from emitted triangles just inside the exterior, rather
    // than checking coefficients or the unbuilt rim controls. These are
    // normalized regression bounds, not clinical crown-height proportions.
    const exterior = Array.from({ length: CROWN_THETA / 4 }, (_, i) => at(i * 4, 0.98));
    assert.ok(Math.max(...exterior) - Math.min(...exterior) > 0.1, `${arch} ${digit}: level peripheral band`);
    for (const cusp of occlusalPeaks(mesh)) {
      const angle = (Math.round(Math.atan2(cusp[1], cusp[0]) / (2 * Math.PI) * CROWN_THETA) + CROWN_THETA) % CROWN_THETA;
      const profile = [0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.94, 0.98].map(rho => at(angle, rho));
      assert.ok(profile[0] > profile.at(-1) + 0.03, `${arch} ${digit}: cusp volume does not extend to its outer slope`);
      for (let i = 1; i < profile.length; i++) {
        assert.ok(profile[i] <= profile[i - 1] + 0.002, `${arch} ${digit}: extra peripheral hump or moat`);
        assert.ok(profile[i - 1] - profile[i] < 0.05, `${arch} ${digit}: abrupt cusp-to-wall step`);
      }
    }
    for (const id of mesh.zones.margin) close(Math.hypot(mesh.vertices[id * 3], mesh.vertices[id * 3 + 1]), 0.78, 2e-7);
    assert.match(shape.source.provenance, /Scalloped.*procedural morphology hypothesis.*not.*validated/);
  }
});

test('emitted lower-molar central fissures have a continuous varying course instead of a straight cross', () => {
  for (const digit of [6, 7, 8]) {
    const { positions } = placeCrown(buildCrownMesh(templateShape('lower', digit), [2, 2, 1]), identity());
    const troughs = [-0.55, -0.35, 0.35, 0.55].map(x => {
      const samples = Array.from({ length: 29 }, (_, i) => ({ y: (i - 14) * 0.01, z: surfaceHeightAt(positions, x, (i - 14) * 0.01) }));
      const trough = samples.reduce((a, b) => a.z < b.z ? a : b);
      // A course must still be a depression beside the unequal cusp volumes;
      // moving an arbitrary line on an otherwise flat surface cannot pass.
      for (const side of [-1, 1]) assert.ok(surfaceHeightAt(positions, x, trough.y + side * 0.09) > trough.z + 0.015);
      return trough.y;
    });
    assert.ok(troughs[0] < -0.015 && troughs.at(-1) > 0.015);
    assert.ok(Math.max(...troughs) - Math.min(...troughs) > 0.045, `lower ${digit}: straight trench`);
    assert.ok(troughs.slice(1).every((y, i) => Math.abs(y - troughs[i]) < 0.06), `lower ${digit}: disconnected groove course`);
  }
});

test('molar cusp variants and central fossae survive in the emitted triangle surfaces', () => {
  const molars = new Map();
  for (const arch of ['upper', 'lower']) for (const digit of [6, 7, 8]) {
    const shape = templateShape(arch, digit), placed = placeCrown(buildCrownMesh(shape, [2, 2, 1]), identity());
    const mesh = emittedIntegrity(placed), peaks = occlusalPeaks(mesh);
    const five = arch === 'lower' && digit === 6;
    const expected = five ? [[0.5, 0.45], [-0.05, 0.5], [-0.55, 0.38], [0.48, -0.42], [-0.42, -0.42]]
      : [[0.48, 0.45], [-0.45, 0.45], [0.45, -0.42], [-0.42, -0.45]];
    assert.equal(peaks.length, five ? 5 : 4, `${arch} ${digit} emitted cusp count`);
    // The upper central fossa is mesial to the oblique ridge; the origin now
    // lies on that ridge. A lower molar retains its central crossing grooves.
    const fossa = surfaceHeightAt(placed.positions, arch === 'upper' ? 0.16 : 0, arch === 'upper' ? 0.03 : 0);
    for (const [x, y] of expected) {
      assert.ok(peaks.some(p => Math.hypot(p[0] - x, p[1] - y) < 0.13), `${arch} ${digit} missing emitted peak at ${x}, ${y}`);
      assert.ok(surfaceHeightAt(placed.positions, x, y) > fossa + 0.1, `${arch} ${digit} cusp/fossa relief lost`);
    }
    molars.set(`${arch}-${digit}`, placed.positions);
  }
  const dl6 = surfaceHeightAt(molars.get('upper-6'), -0.42, -0.45), dl7 = surfaceHeightAt(molars.get('upper-7'), -0.42, -0.45);
  assert.ok(dl6 - dl7 > 0.05, 'Upper second-molar distolingual cusp was not reduced on the surface');
  close(surfaceHeightAt(molars.get('upper-6'), 0.45, -0.42), surfaceHeightAt(molars.get('upper-7'), 0.45, -0.42), 1e-6);
  assert.notDeepEqual(molars.get('lower-6'), molars.get('lower-7'));
  assert.match(templateShape('lower', 8).source.provenance, /variable.*four-cusp hypothesis/);
});

test('upper molar oblique ridges survive between the mesiolingual and distobuccal cusps with fossae beside them', () => {
  for (const digit of [6, 7, 8]) {
    const mesh = buildCrownMesh(templateShape('upper', digit), [2, 2, 1]);
    const { positions } = placeCrown(mesh, identity());
    // Cross-sections through the bridge, excluding the cusp tips. In the local
    // frame ML is (+x,-y), DB is (-x,+y); the other diagonal must remain lower.
    for (const t of [-0.18, -0.12, -0.06, 0, 0.06, 0.12, 0.18]) {
      const ridge = surfaceHeightAt(positions, t, -t);
      for (const offset of [-0.12, 0.12]) {
        assert.ok(ridge > surfaceHeightAt(positions, t + offset, -t + offset) + 0.008, `upper ${digit}: bridge lost at ${t}, flank ${offset}`);
      }
    }
    const saddle = surfaceHeightAt(positions, 0, 0);
    assert.ok(surfaceHeightAt(positions, -0.25, 0.25) > saddle + 0.04);
    assert.ok(surfaceHeightAt(positions, 0.25, -0.25) > saddle + 0.04);
    // Distinct depressions on the mesial and distal sides, below the bridge and
    // below their immediate surrounding surface (finite surface samples).
    for (const [x, y] of [[0.16, 0.03], [-0.18, -0.02]]) {
      const fossa = surfaceHeightAt(positions, x, y);
      assert.ok(fossa < saddle - 0.08);
      assert.ok(fossa > 0);
      assert.ok(surfaceHeightAt(positions, x, y + 0.08) > fossa + 0.008);
      assert.ok(surfaceHeightAt(positions, x, y - 0.08) > fossa + 0.008);
    }
  }
});

test('upper oblique ridge joins retain two main fossae without additional deep sampled pits', () => {
  for (const digit of [6, 7, 8]) {
    const mesh = buildCrownMesh(templateShape('upper', digit), [2, 2, 1]);
    const central = occlusalBasins(mesh).filter(b => Math.hypot(b.position[0], b.position[1]) < 0.4);
    // 0.01 is a normalized regression tolerance, not a clinical groove depth.
    const fossae = central.filter(b => b.depth > 0.01);
    assert.equal(fossae.length, 2, `upper ${digit}: additional substantial basin at ridge join`);
    assert.ok(fossae.some(b => b.position[0] > 0.1 && b.position[0] + b.position[1] > 0.1));
    assert.ok(fossae.some(b => b.position[0] < -0.1 && b.position[0] + b.position[1] < -0.1));
    assert.ok(central.filter(b => !fossae.includes(b)).every(b => b.depth < 0.006));
  }
});

test('premolar fallbacks preserve two cusps while the lower first premolar narrows lingually', () => {
  const surfaces = new Map();
  for (const arch of ['upper', 'lower']) for (const digit of [4, 5]) {
    const shape = templateShape(arch, digit), mesh = buildCrownMesh(shape, [2, 2, 1]);
    const { positions } = placeCrown(mesh, identity()), peaks = occlusalPeaks(mesh);
    assert.equal(peaks.length, 2, `${arch} ${digit}: extra or missing cusp`);
    for (const y of [-0.45, 0.45]) assert.ok(peaks.some(p => Math.hypot(p[0], p[1] - y) < 0.10));
    assert.ok(surfaceHeightAt(positions, 0, -0.45) > surfaceHeightAt(positions, 0, 0) + 0.1);
    const ratio = projectedWidthAtY(positions, -0.45) / projectedWidthAtY(positions, 0.45);
    if (arch === 'lower' && digit === 4) assert.ok(ratio < 0.96 && ratio > 0.85, `lower first lingual/buccal shoulder ratio ${ratio}`);
    else close(ratio, 1, 0.002);
    surfaces.set(`${arch}-${digit}`, positions);
  }
  const first = surfaces.get('lower-4'), second = surfaces.get('lower-5');
  assert.ok(surfaceHeightAt(second, 0, -0.45) > surfaceHeightAt(first, 0, -0.45) + 0.06);
  close(surfaceHeightAt(first, 0, 0.45), surfaceHeightAt(second, 0, 0.45), 1e-7);
  assert.match(templateShape('lower', 5).source.provenance, /variable.*two-cusp hypothesis.*three-cusp variant/);
});

test('new posterior templates retain one common relief datum through independent cloning', () => {
  for (const arch of ['upper', 'lower']) for (const digit of [4, 5, 6, 7, 8]) {
    const shape = templateShape(arch, digit), copy = cloneShape(shape), transferred = structuredClone(shape);
    assert.equal(shape.reliefDatum, Math.max(...shape.rimZ));
    assert.equal(copy.reliefDatum, shape.reliefDatum);
    assert.equal(transferred.reliefDatum, shape.reliefDatum);
    validateCrownShape(copy);
    validateCrownShape(transferred);
    assert.notEqual(copy.occlusal.buffer, shape.occlusal.buffer);
    assert.notEqual(copy.rimZ.buffer, shape.rimZ.buffer);
    assert.deepEqual(buildCrownMesh(copy, [2, 2, 1]), buildCrownMesh(shape, [2, 2, 1]));
  }
});

test('actual generated posterior controls preserve every interior peak and central continuity', () => {
  // Includes the reported FDI 14 scale=1.5/relief=0 and FDI 34
  // scale=1/relief=.5 regressions. These synthetic file-unit control bounds
  // exercise the complete generator, not a duplicate of its relief formula.
  for (const fdi of [14, 15, 16, 17, 18, 34, 35, 36, 37, 38]) {
    let baseline;
    for (const cuspHeight of [0, 0.5, 1.1]) for (const occlusalScale of [0.5, 1, 1.5]) {
      const anatomy = fdi % 10 < 6 ? 'premolar' : 'molar';
      const spec = { version: 'implant-assembly/v1', fdi, parentPartId: 'synthetic-control',
        frame: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], up: [0, 0, 1] },
        parameters: { fixture: { radius: 1.1, length: 5, depth: 0.4, taper: 0.3 },
          abutment: { radius: 0.8, height: 2.1, emergenceRadius: 1.3, angleX: 0, angleY: 0 },
          crown: { width: 5.2, depth: 4.6, height: 3.5, cuspHeight, rotation: 0 } },
        anatomy, contour: { cervicalScale: 1, occlusalScale }, provenance: 'hypothesized', units: 'file units (u)',
        source: 'Synthetic generated cusp-count regression; no patient anatomy or clinical dimensions.' };
      const snapshot = structuredClone(spec), crown = generateRestoration(spec).find(mesh => mesh.component === 'crown');
      assert.deepEqual(spec, snapshot, 'Requested controls must remain exact.');
      const mesh = emittedIntegrity(crown);
      if (!baseline) {
        const reference = structuredClone(spec);
        reference.parameters.crown.cuspHeight = 0;
        reference.contour.occlusalScale = 1;
        baseline = emittedIntegrity(generateRestoration(reference).find(mesh => mesh.component === 'crown'));
      }
      assert.deepEqual(mesh.indices, baseline.indices, 'Controls must preserve emitted topology.');
      // A common monotone elevation map preserves every mesh edge's height
      // order, including the complete centre-vertex fan. Angular rim maps can
      // reverse these orders and create spikes even when cusp locations pass.
      // Ignore only source-coordinate Float32 rounding, not a geometry-sized
      // prominence or spatial region. The reported central spikes were .2 u.
      const rounding = spec.parameters.crown.height * 2e-6;
      for (let i = 0; i < mesh.indices.length; i += 3) for (let c = 0; c < 3; c++) {
        const a = mesh.indices[i + c] * 3, b = mesh.indices[i + (c + 1) % 3] * 3;
        const before = baseline.vertices[a + 2] - baseline.vertices[b + 2];
        const after = mesh.vertices[a + 2] - mesh.vertices[b + 2];
        if (Math.abs(before) > rounding) assert.ok(before * after > 0, `FDI ${fdi}: relief reversed an emitted edge elevation`);
        else if (before === 0) assert.ok(Math.abs(after) <= rounding, `FDI ${fdi}: relief split an equal-height edge`);
      }
      // Normalize the welded emitted coordinates only for the existing cusp
      // metric. Count every strict crest, including close or low split peaks.
      for (let i = 0; i < mesh.vertices.length; i += 3) {
        mesh.vertices[i] *= 2 / spec.parameters.crown.width;
        mesh.vertices[i + 1] *= 2 / spec.parameters.crown.depth;
        mesh.vertices[i + 2] = (mesh.vertices[i + 2] - spec.parameters.abutment.height) / spec.parameters.crown.height;
      }
      const peaks = occlusalPeaks(mesh);
      assert.equal(peaks.length, anatomy === 'premolar' ? 2 : fdi === 36 ? 5 : 4,
        `FDI ${fdi}, additional relief ${cuspHeight}, occlusal scale ${occlusalScale}: extra or missing emitted cusp`);
      assert.equal(peaks.filter(p => Math.hypot(p[0], p[1]) < 0.3).length, 0,
        `FDI ${fdi}, additional relief ${cuspHeight}, occlusal scale ${occlusalScale}: artificial central crest`);
      if (anatomy === 'premolar') for (const side of [-1, 1]) assert.ok(peaks.some(p => p[1] * side > 0.3 && Math.abs(p[0]) < 0.1), 'A premolar crest split away from its cusp axis.');
    }
  }
});

test('placement preserves reflected and oblique rigid frames; normals match emitted Float32 triangles', () => {
  const mesh = buildCrownMesh(templateShape('lower', 6), [5, 4, 3]);
  const frames = [identity(), { ...identity(), mesial: [-1, 0, 0] },
    { origin: [17.125, -8.25, 2.5], mesial: [2 / 3, 2 / 3, -1 / 3], buccal: [-1 / 3, 2 / 3, 2 / 3], occlusal: [2 / 3, -1 / 3, 2 / 3] }];
  const originalVolume = auditCrownMesh(mesh).volume;
  for (const [i, frame] of frames.entries()) {
    const result = placeCrown(mesh, frame);
    assert.equal(result.mirrored, i === 1);
    const placedMesh = emittedIntegrity(result);
    close(auditCrownMesh(placedMesh).volume, originalVolume, 2e-5);
    const ids = i === 1 ? [mesh.indices[0], mesh.indices[2], mesh.indices[1]] : Array.from(mesh.indices.subarray(0, 3));
    ids.forEach((id, c) => {
      const local = point(mesh.vertices, id);
      for (let axis = 0; axis < 3; axis++) close(result.positions[c * 3 + axis], Math.fround(frame.origin[axis] + local[0] * frame.mesial[axis] + local[1] * frame.buccal[axis] + local[2] * frame.occlusal[axis]), 0);
    });
  }
});

test('placement rejects invalid frames, full and partial Float32 collapse, and invalid local geometry', () => {
  const mesh = buildCrownMesh(templateShape('upper', 1), [1, 1, 1]);
  for (const frame of [null, { ...identity(), origin: [NaN, 0, 0] }, { ...identity(), mesial: [2, 0, 0] },
    { ...identity(), buccal: [1, 0, 0] }, { ...identity(), occlusal: [0, 0, 0] }, { ...identity(), origin: [0, Infinity, 0] }]) {
    assert.throws(() => placeCrown(mesh, frame), /finite and orthonormal/);
  }
  for (const origin of [[1e8, 1e8, 1e8], [0, 0, 1e5], [Number.MAX_VALUE, 0, 0]]) {
    assert.throws(() => placeCrown(mesh, { ...identity(), origin }), /Float32|precision/);
  }
  const oblique = { origin: [0, 0, 1e7], mesial: [2 / 3, 2 / 3, -1 / 3], buccal: [-1 / 3, 2 / 3, 2 / 3], occlusal: [2 / 3, -1 / 3, 2 / 3] };
  assert.throws(() => placeCrown(mesh, oblique), /Float32|precision/);
  // Rounding remains below the edge-error bound and all vertices stay
  // distinct, but a thin tetrahedron face collapses or reverses after Float32.
  for (const [by, cy] of [[0.49999, 1], [0.5005, 1.0011]]) {
    const thin = tetrahedron();
    thin.vertices.set([1, by, 0], 3); thin.vertices.set([2, cy, 0], 6);
    assert.equal(auditCrownMesh(thin).closed, true);
    assert.throws(() => placeCrown(thin, { ...identity(), origin: [10000, 10000, 0] }), /degenerates or loses outward orientation after Float32/);
  }
  // Large absolute coordinates are valid when local features remain resolvable.
  const large = buildCrownMesh(templateShape('upper', 6), [1e8, 1e8, 1e8]);
  emittedIntegrity(placeCrown(large, { ...identity(), origin: [1e8, -1e8, 1e8] }));
  const broken = { ...mesh, vertices: mesh.vertices.slice() };
  broken.vertices.set(point(broken.vertices, 0), 3);
  assert.throws(() => placeCrown(broken, identity()), /nondegenerate/);
  assert.throws(() => placeCrown({ ...mesh, indices: Uint32Array.from([0, 1, 999999, 0]) }, identity()), /valid triangle indices/);
});

test('donor rim is invariant to selected face order, triangle order, winding and corners', () => {
  const input = donor(), first = donorShape(input.positions, input.faces, identity(), info);
  const reverse = donorShape(input.positions, input.faces.slice().reverse(), identity(), info);
  const shuffled = shuffledSurface(input), reordered = donorShape(shuffled.positions, shuffled.faces, identity(), info);
  assert.deepEqual(reverse, first);
  assert.deepEqual(reordered, first);
  for (let a = 0; a < CROWN_THETA; a++) {
    close(first.rimZ[a] * first.dims[2], 1, 1e-6);
    close(first.rim[a], first.wall[(CROWN_WALL - 1) * CROWN_THETA + a], 0);
  }
  const mesh = buildCrownMesh(first, first.dims);
  integrity(mesh);
  // A measured cylindrical donor must not inherit procedural contact bulges,
  // line angles or cervical rounding, even when it shares the fitting topology.
  for (let i = 0; i < CROWN_WALL * CROWN_THETA; i++) {
    const p = point(mesh.vertices, i);
    close(Math.hypot(p[0], p[1]), 1, 1e-6);
  }
});

test('donor selection records original sorted faces and independent source axes for reproducible extraction', () => {
  const input = donor(), frame = identity();
  const shape = donorShape(input.positions, input.faces.slice().reverse(), frame, info);
  assert.deepEqual(shape.source.selection.faces, Array.from(input.faces).sort((a, b) => a - b));
  assert.deepEqual(shape.source.selection.frame, frame);
  const cloned = cloneShape(shape);
  cloned.source.selection.faces[0] = 99999;
  cloned.source.selection.frame.origin[0] = 999;
  assert.notEqual(shape.source.selection.faces[0], 99999);
  assert.deepEqual(shape.source.selection.frame.origin, frame.origin);
  assert.throws(() => validateCrownShape(cloned), /sorted unique original face/);
});

test('measured bowl fossae remain deep and follow the sampled surface instead of a rim-relative plateau', () => {
  const input = donor({ height: r => 0.2 + 0.8 * r * r });
  const shape = donorShape(input.positions, input.faces, identity(), info), mesh = buildCrownMesh(shape, shape.dims);
  integrity(mesh);
  close(shape.apex * shape.dims[2], 0.2, 0.002);
  let previous = Infinity;
  for (let ring = 0; ring < CROWN_RINGS; ring++) {
    const offset = ring * CROWN_THETA, id = CROWN_WALL * CROWN_THETA + offset;
    const p = point(mesh.vertices, id), expected = 0.2 + 0.8 * (p[0] * p[0] + p[1] * p[1]);
    close(p[2], expected, 0.003);
    assert.ok(p[2] < previous - 0.001);
    previous = p[2];
  }
  assert.ok(shape.occlusal[(CROWN_RINGS - 1) * CROWN_THETA] < shape.rimZ[0] * 0.3);
  const shuffled = shuffledSurface(input);
  assert.deepEqual(donorShape(shuffled.positions, shuffled.faces, identity(), info), shape);
});

test('sidewalls and inadequate occlusal patches are rejected; small holes disclose interpolation', () => {
  for (const input of [donor({ top: false }), donor({ top: false, bottom: true }), donor({ missing: a => a < CROWN_THETA / 2 })]) {
    assert.throws(() => donorShape(input.positions, input.faces, identity(), info), /insufficient measured occlusal coverage/);
  }
  const input = donor({ missing: a => a >= 4 && a <= 8 });
  const shape = donorShape(input.positions, input.faces, identity(), info);
  validateCrownShape(shape);
  assert.match(shape.source.provenance, /Occlusal coverage: \d+\/2304/);
  assert.match(shape.source.provenance, /[1-9]\d* missing heights/);
  assert.match(shape.source.provenance, /Basal closure is artificial/);
  assert.equal(shape.source.kind, 'patient-donor');
  integrity(buildCrownMesh(shape, shape.dims));
});

function tetrahedron(offset = [0, 0, 0]) {
  return { vertices: Float32Array.from([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]].flatMap(p => p.map((v, axis) => v + offset[axis]))),
    indices: Uint32Array.from([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]), vertexCount: 4 };
}

test('audit detects reversed individual faces and inward shells despite positive edge incidence', () => {
  const mesh = tetrahedron();
  integrity(mesh);
  const reversed = { ...mesh, indices: mesh.indices.slice() };
  [reversed.indices[1], reversed.indices[2]] = [reversed.indices[2], reversed.indices[1]];
  const report = auditCrownMesh(reversed);
  assert.equal(report.boundaryEdges, 0);
  assert.equal(report.nonManifoldEdges, 0);
  assert.ok(report.volume > 0);
  assert.equal(report.orientationErrors, 3);
  assert.equal(report.consistentlyOriented, false);
  assert.equal(report.closed, false);
  for (let i = 0; i < reversed.indices.length; i += 3) [reversed.indices[i + 1], reversed.indices[i + 2]] = [mesh.indices[i + 2], mesh.indices[i + 1]];
  const inward = auditCrownMesh(reversed);
  assert.equal(inward.consistentlyOriented, true);
  assert.ok(inward.volume < 0);
  assert.equal(inward.closed, false);
});

test('audit detects pinched vertex fans and multiple face components', () => {
  const a = tetrahedron(), b = tetrahedron([4, 4, 4]);
  const separate = { vertices: Float32Array.from([...a.vertices, ...b.vertices]), indices: Uint32Array.from([...a.indices, ...b.indices.map(id => id + 4)]), vertexCount: 8 };
  const components = auditCrownMesh(separate);
  assert.equal(components.components, 2);
  assert.equal(components.vertexManifold, true);
  assert.equal(components.consistentlyOriented, true);
  assert.equal(components.closed, false);
  const opposite = tetrahedron();
  for (let i = 0; i < opposite.vertices.length; i++) opposite.vertices[i] *= -1;
  for (let i = 0; i < opposite.indices.length; i += 3) [opposite.indices[i + 1], opposite.indices[i + 2]] = [opposite.indices[i + 2], opposite.indices[i + 1]];
  const pinch = { vertices: Float32Array.from([...a.vertices, ...opposite.vertices.subarray(3)]),
    indices: Uint32Array.from([...a.indices, ...opposite.indices.map(id => id === 0 ? 0 : id + 3)]), vertexCount: 7 };
  const fans = auditCrownMesh(pinch);
  assert.equal(fans.boundaryEdges, 0);
  assert.equal(fans.nonManifoldEdges, 0);
  assert.equal(fans.orientationErrors, 0);
  assert.equal(fans.nonManifoldVertices, 1);
  assert.equal(fans.vertexManifold, false);
  assert.equal(fans.components, 2);
  assert.equal(fans.closed, false);
  // Identify two disjoint vertex fans on the SAME connected crown. Component
  // counting still passes, so this specifically exercises the vertex-link test.
  const crown = buildCrownMesh(templateShape('lower', 6), [5, 4, 3]);
  const apex = crown.vertexCount - 2, base = crown.vertexCount - 1;
  const identified = { ...crown, vertices: crown.vertices.slice(0, -3), vertexCount: crown.vertexCount - 1,
    indices: crown.indices.map(id => id === base ? apex : id) };
  const connectedPinch = auditCrownMesh(identified);
  assert.equal(connectedPinch.components, 1);
  assert.equal(connectedPinch.boundaryEdges, 0);
  assert.equal(connectedPinch.nonManifoldEdges, 0);
  assert.equal(connectedPinch.orientationErrors, 0);
  assert.equal(connectedPinch.degenerate, 0);
  assert.equal(connectedPinch.nonManifoldVertices, 1);
  assert.equal(connectedPinch.closed, false);
});

test('audit validates malformed buffers and reports open and degenerate surfaces honestly', () => {
  const mesh = tetrahedron();
  for (const broken of [{ ...mesh, vertexCount: 5 }, { ...mesh, indices: Uint32Array.from([0, 1, 2, 3]) },
    { ...mesh, indices: Uint32Array.from([0, 1, 2, 0, 1, 4, 0, 3, 2, 1, 2, 3]) },
    { ...mesh, vertices: Float32Array.from([...mesh.vertices.subarray(0, 11), NaN]) }]) {
    assert.throws(() => auditCrownMesh(broken), /finite indexed vertices and valid triangle indices/);
  }
  const crown = buildCrownMesh(templateShape('upper', 4), [4, 5, 3]);
  const open = auditCrownMesh({ ...crown, indices: crown.indices.slice(3) });
  assert.equal(open.closed, false);
  assert.equal(open.boundaryEdges, 3);
  const flat = tetrahedron(); flat.vertices.set([0, 0, 0], 9);
  const report = auditCrownMesh(flat);
  assert.ok(report.degenerate > 0);
  assert.equal(report.closed, false);
  assert.equal(report.selfIntersection, 'untested');
});

test('persisted shape validation stays compatible and rejects malformed data before building', () => {
  const shape = templateShape('lower', 6);
  for (const mutate of [s => { s.rim = new Float32Array(3); }, s => { s.occlusal[8] = NaN; },
    s => { s.wall[0] = 0; }, s => { s.apex = Infinity; }, s => { s.dims = [1, -1, 1]; }, s => { s.toothClass = 'canine'; }]) {
    const broken = cloneShape(shape); mutate(broken);
    assert.throws(() => validateCrownShape(broken));
    assert.throws(() => buildCrownMesh(broken, [1, 1, 1]));
  }
  const dims = shape.dims.slice();
  buildCrownMesh(shape, [2, 3, 4]);
  assert.deepEqual(shape.dims, dims);
});
