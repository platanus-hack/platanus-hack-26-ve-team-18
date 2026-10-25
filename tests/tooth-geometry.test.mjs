import test from 'node:test';
import assert from 'node:assert/strict';
import { brushFaces, boundaryRegion } from '../src/tooth-geometry.ts';

const mesh = faces => new Float32Array(faces.flat(2));
const pick = (face, point) => ({ face, point });
const centroid = (positions, face) => [0, 1, 2].map(axis =>
  (positions[face * 9 + axis] + positions[face * 9 + 3 + axis] + positions[face * 9 + 6 + axis]) / 3);
const A = [0, 0, 0], B = [2, 0, 0], C = [0, 2, 0], D = [0, 0, 2];
const tetra = () => mesh([[A, B, C], [A, D, B], [B, D, C], [C, D, A]]);
const tetraBoundary = () => [pick(0, A), pick(0, B), pick(0, C)];

test('brush stays on one of two arbitrarily close disconnected shells', () => {
  const positions = mesh([
    [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
    [[0, 0, 0.000001], [1, 0, 0.000001], [0, 1, 0.000001]],
  ]);
  const original = positions.slice();
  assert.deepEqual([...brushFaces(positions, [pick(0, [0.2, 0.2, 0])], 100)], [0]);
  assert.deepEqual(positions, original);
});

test('brush cannot cross a shared vertex or a merely near-coincident edge', () => {
  const vertexOnly = mesh([[A, B, C], [A, [-2, 0, 0], [0, -2, 0]]]);
  assert.deepEqual([...brushFaces(vertexOnly, [pick(0, [0.2, 0.2, 0])], 100)], [0]);
  const delta = 2 ** -20;
  const seam = mesh([
    [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
    [[1 + delta, 0, 0], [1, 1, 0], [delta, 1, 0]],
  ]);
  assert.deepEqual([...brushFaces(seam, [pick(0, [0.2, 0.2, 0])], 100)], [0]);
});

test('non-manifold edges block propagation even when all three faces are nearby', () => {
  const positions = mesh([[A, B, C], [B, A, [0, -2, 0]], [A, B, D]]);
  assert.deepEqual([...brushFaces(positions, [pick(0, [0.2, 0.2, 0])], 100)], [0]);
  assert.deepEqual([...brushFaces(positions, [pick(0, A), pick(2, D)], 100)], [0, 2]);
});

test('radius bounds edge-midpoint surface routes and radius zero includes picked faces', () => {
  const positions = mesh([
    [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
    [[1, 0, 0], [1, 1, 0], [0, 1, 0]],
  ]);
  const hit = pick(0, [0.25, 0.25, 0]);
  assert.deepEqual([...brushFaces(positions, [hit], 0)], [0]);
  assert.deepEqual([...brushFaces(positions, [hit], 0.35)], [0]);
  assert.deepEqual([...brushFaces(positions, [hit], 0.36)], [0, 1]);
  assert.deepEqual([...brushFaces(positions, [pick(1, [0.8, 0.8, 0]), hit, hit], 0)], [0, 1]);
  assert.deepEqual(brushFaces(positions, [], 1), new Uint32Array());
  assert.deepEqual(brushFaces(new Float32Array(), [], 1), new Uint32Array());
});

test('folded nearby faces require the longer connected surface route', () => {
  const sections = [[0, 0], [10, 0], [10, 0.001], [0, 0.001]];
  const faces = [];
  for (let i = 0; i < sections.length - 1; i++) {
    const [x, z] = sections[i], [nx, nz] = sections[i + 1];
    faces.push([[x, 0, z], [nx, 0, nz], [x, 1, z]], [[nx, 0, nz], [nx, 1, nz], [x, 1, z]]);
  }
  const positions = mesh(faces), hit = pick(0, [0.1, 0.2, 0]);
  assert.ok([...brushFaces(positions, [hit], 2)].every(face => face < 4));
  assert.deepEqual([...brushFaces(positions, [hit], 100)], [0, 1, 2, 3, 4, 5]);
});

test('degenerate faces may be picked but never bridge a brush to other triangles', () => {
  const positions = mesh([[A, B, C], [A, B, [1, 0, 0]], [B, A, D]]);
  assert.deepEqual([...brushFaces(positions, [pick(0, [0.2, 0.2, 0])], 100)], [0]);
  assert.deepEqual([...brushFaces(positions, [pick(1, [1, 0, 0])], 100)], [1]);
});

test('a tetrahedron loop splits either seeded side and returns closed source-coordinate segments', () => {
  const positions = tetra(), original = positions.slice(), boundary = tetraBoundary();
  const cap = boundaryRegion(positions, boundary, pick(0, centroid(positions, 0)));
  assert.deepEqual([...cap.faces], [0]);
  assert.deepEqual(cap.boundary, new Float32Array([...A, ...B, ...B, ...C, ...C, ...A]));
  const rest = boundaryRegion(positions, boundary, pick(1, centroid(positions, 1)));
  assert.deepEqual([...rest.faces], [1, 2, 3]);
  assert.deepEqual(positions, original);
});

test('boundary picks snap to their hit-face vertices and preserve translated file coordinates', () => {
  const positions = tetra();
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = positions[i] * 0.25 + 100;
    positions[i + 1] = positions[i + 1] * 0.25 - 30;
    positions[i + 2] = positions[i + 2] * 0.25 + 5;
  }
  const boundary = [pick(0, [100.01, -29.99, 5]), pick(0, [100.48, -29.99, 5]), pick(0, [100.01, -29.52, 5])];
  const result = boundaryRegion(positions, boundary, pick(0, centroid(positions, 0)));
  assert.deepEqual([...result.faces], [0]);
  assert.deepEqual(result.boundary, new Float32Array([100, -30, 5, 100.5, -30, 5, 100.5, -30, 5, 100, -29.5, 5, 100, -29.5, 5, 100, -30, 5]));
});

test('sparse boundary picks join multi-edge shortest paths including the closing leg', () => {
  const ring = Array.from({ length: 8 }, (_, i) => [2 * Math.cos(i * Math.PI / 4), 2 * Math.sin(i * Math.PI / 4), 0]);
  const faces = ring.map((point, i) => [[0, 0, 3], point, ring[(i + 1) % ring.length]])
    .concat(ring.map((point, i) => [[0, 0, -3], ring[(i + 1) % ring.length], point]));
  // Adjacency is independent of face winding.
  for (let i = 0; i < faces.length; i += 2) faces[i].reverse();
  const positions = mesh(faces);
  const result = boundaryRegion(positions, [0, 2, 4, 6].map(i => pick(i, ring[i])), pick(0, centroid(positions, 0)));
  assert.deepEqual([...result.faces], [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(result.boundary.length, 8 * 6);
  assert.deepEqual(result.boundary, new Float32Array(ring.flatMap((point, i) => [...point, ...ring[(i + 1) % ring.length]])));
});

test('a large shared file-coordinate origin does not invalidate a small separating loop', () => {
  for (const x of [0, 2 ** 46]) {
    const faces = [];
    for (let y = 0; y < 3; y++) for (let z = 0; z < 3; z++) {
      const a = [x, y, z], b = [x, y + 1, z], c = [x, y + 1, z + 1], d = [x, y, z + 1];
      faces.push([a, b, d], [b, c, d]);
    }
    const positions = mesh(faces);
    const boundary = [pick(8, [x, 1, 1]), pick(8, [x, 2, 1]), pick(9, [x, 2, 2]), pick(8, [x, 1, 2])];
    const result = boundaryRegion(positions, boundary, pick(8, centroid(positions, 8)));
    assert.deepEqual([...result.faces], [8, 9]);
    assert.equal(result.boundary.length, 24);
    for (let i = 0; i < result.boundary.length; i += 3) assert.equal(result.boundary[i], x);
  }
});

test('seed on a loop edge or vertex is ambiguous and rejected', () => {
  for (const point of [A, [1, 0, 0], B]) {
    assert.throws(() => boundaryRegion(tetra(), tetraBoundary(), pick(0, point)), /seed lies on the boundary/i);
  }
});

test('open mesh outlines and repeated snapped vertices do not silently select the mesh', () => {
  const positions = mesh([[A, B, C]]);
  assert.throws(() => boundaryRegion(positions, tetraBoundary(), pick(0, [0.5, 0.5, 0])), /open.*edge/i);
  assert.throws(() => boundaryRegion(tetra(), [pick(0, A), pick(0, [0.1, 0.1, 0]), pick(0, C)], pick(0, [0.5, 0.5, 0])), /repeated vertices/i);
  assert.throws(() => boundaryRegion(tetra(), [pick(0, A), pick(0, B)], pick(0, [0.5, 0.5, 0])), /between 3 and 256/i);
});

test('loop through a non-manifold edge or vertex is rejected', () => {
  const edgeMesh = new Float32Array([...tetra(), ...A, ...B, ...[0, -1, 0]]);
  assert.throws(() => boundaryRegion(edgeMesh, tetraBoundary(), pick(0, [0.5, 0.5, 0])), /non-manifold/i);
  const pinched = mesh([
    [A, B, C], [A, D, B], [B, D, C], [C, D, A],
    [A, [-2, 0, 0], [0, -2, 0]], [A, [0, 0, -2], [-2, 0, 0]],
    [[-2, 0, 0], [0, 0, -2], [0, -2, 0]], [[0, -2, 0], [0, 0, -2], A],
  ]);
  assert.throws(() => boundaryRegion(pinched, tetraBoundary(), pick(0, [0.5, 0.5, 0])), /non-manifold.*vertex/i);
});

test('geometrically intersecting boundary edges are rejected before an outline can be selected', () => {
  const ring = [[-1, -1, 0], [1, 1, 0], [-1, 1, 0], [1, -1, 0]], top = [0, 0, 1];
  const positions = mesh(ring.map((point, i) => [top, point, ring[(i + 1) % ring.length]]));
  const boundary = ring.map((point, i) => pick(i, point));
  assert.throws(() => boundaryRegion(positions, boundary, pick(0, centroid(positions, 0))), /intersects itself/i);
});

test('long nearly parallel boundary segments still detect their interior intersection', () => {
  const ring = [[-50_000_000, -0.5, 0], [50_000_000, 0.5, 0], [-50_000_000, 0.5, 0], [50_000_000, -0.5, 0]], top = [0, 0, 100_000_000];
  const positions = mesh(ring.map((point, i) => [top, point, ring[(i + 1) % ring.length]]));
  assert.throws(() => boundaryRegion(positions, ring.map((point, i) => pick(i, point)), pick(0, centroid(positions, 0))), /intersects itself/i);
});

test('shortest paths that reuse an intermediate vertex fail instead of inventing a region', () => {
  const ring = Array.from({ length: 6 }, (_, i) => {
    const radius = i % 2 === 0 ? 2 : 10;
    return [Math.cos(i * Math.PI / 3) * radius, Math.sin(i * Math.PI / 3) * radius, 0];
  });
  const positions = mesh(ring.map((point, i) => [A, point, ring[(i + 1) % ring.length]]));
  const boundary = [0, 2, 4].map(i => pick(i, ring[i]));
  assert.throws(() => boundaryRegion(positions, boundary, pick(0, centroid(positions, 0))), /repeat a vertex|overlap/i);
});

test('a closed nonseparating torus loop fails rather than selecting the whole shell', () => {
  const n = 6;
  const vertices = Array.from({ length: n }, (_, u) => Array.from({ length: n }, (_, v) => {
    const theta = u * 2 * Math.PI / n, phi = v * 2 * Math.PI / n;
    return [(3 + Math.cos(phi)) * Math.cos(theta), (3 + Math.cos(phi)) * Math.sin(theta), Math.sin(phi)];
  }));
  const faces = [];
  for (let u = 0; u < n; u++) for (let v = 0; v < n; v++) {
    const a = vertices[u][v], b = vertices[(u + 1) % n][v], c = vertices[(u + 1) % n][(v + 1) % n], d = vertices[u][(v + 1) % n];
    faces.push([a, b, c], [a, c, d]);
  }
  const positions = mesh(faces), boundary = Array.from({ length: n }, (_, v) => pick(v * 2 + 1, vertices[0][v]));
  const seedFace = (2 * n + 1) * 2;
  assert.throws(() => boundaryRegion(positions, boundary, pick(seedFace, centroid(positions, seedFace))), /does not separate/i);
});

test('a seed on a disconnected shell does not produce a spurious boundary region', () => {
  const first = tetra(), other = tetra();
  for (let i = 0; i < other.length; i += 3) other[i] += 10;
  const positions = new Float32Array([...first, ...other]);
  assert.throws(() => boundaryRegion(positions, tetraBoundary(), pick(4, centroid(positions, 4))), /does not separate/i);
});

test('invalid coordinates, face indices, points, radii, and excessive picks fail clearly', () => {
  const positions = tetra(), hit = pick(0, [0.5, 0.5, 0]);
  for (const radius of [-1, NaN, Infinity]) assert.throws(() => brushFaces(positions, [hit], radius), /radius/i);
  for (const face of [-1, 0.5, 4, NaN]) {
    assert.throws(() => brushFaces(positions, [pick(face, A)], 1), /valid triangle face/i);
    assert.throws(() => boundaryRegion(positions, tetraBoundary(), pick(face, A)), /valid triangle face/i);
  }
  for (const point of [[NaN, 0, 0], [0, Infinity, 0], [0, 0]]) {
    assert.throws(() => brushFaces(positions, [pick(0, point)], 1), /finite point/i);
  }
  assert.throws(() => brushFaces(new Float32Array(4), [], 1), /complete triangles/i);
  const invalid = positions.slice(); invalid[0] = NaN;
  assert.throws(() => brushFaces(invalid, [], 1), /coordinates must be finite/i);
  assert.throws(() => brushFaces(positions, Array(257).fill(hit), 1), /at most 256/i);
  assert.throws(() => boundaryRegion(positions, Array(257).fill(hit), hit), /between 3 and 256/i);
});

test('worker returns matching IDs, transfers only results, and recovers after invalid requests', async () => {
  const originalPost = globalThis.postMessage, originalHandler = globalThis.onmessage;
  let response, transferred;
  globalThis.postMessage = (message, transfer) => {
    transferred = transfer;
    response = structuredClone(message, { transfer });
  };
  try {
    await import('../src/tooth.worker.ts');
    const positions = tetra(), original = positions.slice();
    globalThis.onmessage({ data: { id: 5, operation: 'brush', positions, hits: [pick(0, [0.5, 0.5, 0])], radius: 0 } });
    assert.equal(response.id, 5);
    assert.deepEqual(response.faces, new Uint32Array([0]));
    assert.equal(transferred.length, 1);
    assert.deepEqual(positions, original);
    globalThis.onmessage({ data: { id: 6, operation: 'boundary', positions, boundary: tetraBoundary(), seed: pick(0, [0.5, 0.5, 0]) } });
    assert.equal(response.id, 6);
    assert.deepEqual(response.faces, new Uint32Array([0]));
    assert.ok(response.boundary instanceof Float32Array);
    assert.equal(response.boundary.length, 18);
    assert.equal(transferred.length, 2);
    assert.deepEqual(positions, original);
    globalThis.onmessage({ data: { id: 7, operation: 'brush', positions, hits: [], radius: -1 } });
    assert.equal(response.id, 7);
    assert.match(response.error, /radius/i);
    assert.deepEqual(transferred, []);
    globalThis.onmessage({ data: { id: 8, operation: 'unknown', positions } });
    assert.equal(response.id, 8);
    assert.match(response.error, /unknown/i);
    globalThis.onmessage({ data: { id: 9, operation: 'brush', positions, hits: [], radius: 0 } });
    assert.equal(response.id, 9);
    assert.deepEqual(response.faces, new Uint32Array());
  } finally {
    if (originalPost === undefined) delete globalThis.postMessage; else globalThis.postMessage = originalPost;
    if (originalHandler === undefined) delete globalThis.onmessage; else globalThis.onmessage = originalHandler;
  }
});
