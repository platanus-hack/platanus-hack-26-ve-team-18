import assert from 'node:assert/strict';
import test from 'node:test';
import { BufferGeometry } from 'three';
import {
  attachTexture, importModels, parseModel, MAX_IMPORT_BYTES, MAX_WORKSPACE_PARTS, MAX_WORKSPACE_TRIANGLES,
} from '../src/import-models.ts';

const encode = text => new TextEncoder().encode(text).buffer;
const tetraVertices = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
const tetraFaces = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]];
const tetra = (offset = [0, 0, 0]) => tetraFaces.map(face => face.map(index => tetraVertices[index].map((value, axis) => value + offset[axis])));
const triangle = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];

function asciiSTL(triangles) {
  return encode(`solid model\n${triangles.map(face => `facet normal 0 0 0\nouter loop\n${face.map(vertex => `vertex ${vertex.join(' ')}`).join('\n')}\nendloop\nendfacet`).join('\n')}\nendsolid model\n`);
}

function binarySTL(triangles) {
  const buffer = new ArrayBuffer(84 + triangles.length * 50);
  const view = new DataView(buffer);
  view.setUint32(80, triangles.length, true);
  triangles.forEach((face, index) => face.flat().forEach((value, axis) => view.setFloat32(84 + index * 50 + 12 + axis * 4, value, true)));
  return buffer;
}

function repeatedBinarySTL(count, face) {
  const buffer = new ArrayBuffer(84 + count * 50);
  new DataView(buffer).setUint32(80, count, true);
  const bytes = new Uint8Array(buffer);
  const record = new Uint8Array(binarySTL([face]), 84);
  for (let index = 0; index < count; index++) bytes.set(record, 84 + index * 50);
  return buffer;
}

function objTriangles(triangles, name = 'Object') {
  return `o ${name}\n${triangles.flat().map(vertex => `v ${vertex.join(' ')}`).join('\n')}\n${triangles.map((_, index) => `f ${index * 3 + 1} ${index * 3 + 2} ${index * 3 + 3}`).join('\n')}\n`;
}

function asciiPLY(vertices, faces) {
  return encode(`ply\nformat ascii 1.0\nelement vertex ${vertices.length}\nproperty float x\nproperty float y\nproperty float z\nelement face ${faces.length}\nproperty list uchar int vertex_indices\nend_header\n${vertices.map(vertex => vertex.join(' ')).join('\n')}\n${faces.map(face => `${face.length} ${face.join(' ')}`).join('\n')}\n`);
}

function binaryPLY(littleEndian) {
  const header = new TextEncoder().encode(`ply\nformat binary_${littleEndian ? 'little' : 'big'}_endian 1.0\nelement vertex 4\nproperty float x\nproperty float y\nproperty float z\nelement face 4\nproperty list uchar int vertex_indices\nend_header\n`);
  const buffer = new ArrayBuffer(header.length + 4 * 12 + 4 * 13);
  new Uint8Array(buffer).set(header);
  const view = new DataView(buffer);
  let cursor = header.length;
  for (const value of tetraVertices.flat()) { view.setFloat32(cursor, value, littleEndian); cursor += 4; }
  for (const face of tetraFaces) {
    view.setUint8(cursor++, 3);
    for (const index of face) { view.setInt32(cursor, index, littleEndian); cursor += 4; }
  }
  return buffer;
}

function assertPart(part, { triangles, vertices, closed }) {
  assert.ok(part.positions instanceof Float32Array);
  assert.ok(part.normals instanceof Float32Array);
  assert.equal(part.positions.length, triangles * 9);
  assert.equal(part.normals.length, part.positions.length);
  assert.equal(part.triangles, triangles);
  assert.equal(part.vertices, vertices);
  assert.equal(part.closed, closed);
  assert.equal(part.visible, true);
  assert.deepEqual(part.offset, [0, 0, 0]);
  assert.match(part.id, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
  assert.ok(part.positions.every(Number.isFinite));
  for (let index = 0; index < part.normals.length; index += 3) {
    assert.ok(Math.abs(Math.hypot(...part.normals.subarray(index, index + 3)) - 1) < 1e-6);
  }
}

test('ASCII STL separates welded closed shells and preserves their common coordinates', () => {
  const { parts, warnings } = parseModel(asciiSTL([...tetra([10, 20, 30]), ...tetra([-7, -9, -11])]), 'assembly.STL');
  assert.equal(parts.length, 2);
  assert.deepEqual(warnings, []);
  for (const part of parts) {
    assertPart(part, { triangles: 4, vertices: 4, closed: true });
    assert.deepEqual(part.dimensions, [1, 1, 1]);
    assert.equal(part.fileName, 'assembly.STL');
  }
  assert.equal(parts[0].positions[0], 10);
  assert.equal(parts[0].positions[1], 20);
  assert.equal(parts[0].positions[2], 30);
  assert.equal(parts[1].positions[0], -7);
  assert.notEqual(parts[0].id, parts[1].id);
});

test('binary STL recomputes unit normals and ignores supplied normal orientation', () => {
  const faces = tetra();
  faces[0].reverse();
  const { parts, warnings } = parseModel(binarySTL(faces), 'binary.stl');
  assert.equal(parts.length, 1);
  assertPart(parts[0], { triangles: 4, vertices: 4, closed: true });
  assert.deepEqual(warnings, []);
});

test('exact welding preserves tiny representable gaps between components', () => {
  const shifted = triangle.map(([x, y, z]) => [x, y, z + 1e-12]);
  const { parts, warnings } = parseModel(binarySTL([triangle, shifted]), 'gap.stl');
  assert.equal(parts.length, 2);
  assert.equal(parts[0].positions[2], 0);
  assert.ok(parts[1].positions[2] > 0);
  assert.equal(warnings.length, 2);
  for (const part of parts) assertPart(part, { triangles: 1, vertices: 3, closed: false });
});

test('OBJ keeps object/group boundaries even where coordinates coincide, and triangulates quads', () => {
  const text = `v 10 20 30\nv 12 20 30\nv 12 23 30\nv 10 23 30\no First object\nf 1 2 3 4\ng Second group\nf -4 -3 -2 -1\n`;
  const { parts, warnings } = parseModel(encode(text), 'groups.obj');
  assert.deepEqual(parts.map(part => part.name), ['First object', 'Second group']);
  for (const part of parts) {
    assertPart(part, { triangles: 2, vertices: 4, closed: false });
    assert.deepEqual(part.dimensions, [2, 3, 0]);
    assert.deepEqual(Array.from(part.positions.subarray(0, 3)), [10, 20, 30]);
  }
  assert.ok(warnings.every(warning => /open/.test(warning)));
});

test('OBJ splits disconnected surfaces inside an object and warns about ignored materials', () => {
  const text = `mtllib missing.mtl\nusemtl enamel\n${objTriangles([...tetra(), ...tetra([25, 0, 0])], 'Teeth')}`;
  const { parts, warnings } = parseModel(encode(text), 'teeth.obj');
  assert.deepEqual(parts.map(part => part.name), ['Teeth (1)', 'Teeth (2)']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /materials and textures were ignored/);
  for (const part of parts) assertPart(part, { triangles: 4, vertices: 4, closed: true });
});

test('OBJ supports inline comments and line continuations', () => {
  const text = 'v 0 0 0 # origin\nv 1 0 0\nv 0 1 0\nf 1 2 \\\n3 # face\n';
  assertPart(parseModel(encode(text), 'comments.obj').parts[0], { triangles: 1, vertices: 3, closed: false });
  assertPart(parseModel(encode(text.replaceAll('\n', '\r\n')), 'windows.obj').parts[0], { triangles: 1, vertices: 3, closed: false });
});

test('ASCII PLY imports indexed surfaces and triangulates quads', () => {
  assertPart(parseModel(asciiPLY(tetraVertices, tetraFaces), 'tetra.ply').parts[0], { triangles: 4, vertices: 4, closed: true });
  const plane = [[4, 5, 6], [6, 5, 6], [6, 8, 6], [4, 8, 6]];
  const { parts } = parseModel(asciiPLY(plane, [[0, 1, 2, 3]]), 'quad.ply');
  assertPart(parts[0], { triangles: 2, vertices: 4, closed: false });
  assert.deepEqual(parts[0].dimensions, [2, 3, 0]);
  assert.equal(parts[0].positions[0], 4);
});

for (const littleEndian of [true, false]) {
  test(`binary ${littleEndian ? 'little' : 'big'} endian PLY imports a closed surface`, () => {
    const { parts, warnings } = parseModel(binaryPLY(littleEndian), 'binary.ply');
    assertPart(parts[0], { triangles: 4, vertices: 4, closed: true });
    assert.deepEqual(warnings, []);
  });
}

test('PLY welds duplicate geometric vertices across indexed faces', () => {
  const vertices = tetra().flat();
  const faces = tetraFaces.map((_, index) => [index * 3, index * 3 + 1, index * 3 + 2]);
  assertPart(parseModel(asciiPLY(vertices, faces), 'seams.ply').parts[0], { triangles: 4, vertices: 4, closed: true });
});

test('non-manifold edges are never classified as closed', () => {
  const faces = [triangle, [[0, 0, 0], [1, 0, 0], [0, -1, 0]], [[0, 0, 0], [1, 0, 0], [0, 0, 1]]];
  const { parts, warnings } = parseModel(binarySTL(faces), 'non-manifold.stl');
  assertPart(parts[0], { triangles: 3, vertices: 5, closed: false });
  assert.match(warnings[0], /non-manifold/);
});

test('non-manifold vertices are not closed even when every edge has two faces', () => {
  const mirrored = tetra().map(face => face.map(vertex => vertex.map(value => -value)));
  const { parts, warnings } = parseModel(binarySTL([...tetra(), ...mirrored]), 'pinched.stl');
  assert.equal(parts.length, 1);
  assertPart(parts[0], { triangles: 8, vertices: 7, closed: false });
  assert.match(warnings[0], /non-manifold/);
});

test('importModels reads browser Files and preserves coordinates across files', async () => {
  const files = [new File([binarySTL(tetra([15, 0, 0]))], 'left.stl'), new File([asciiPLY(tetraVertices, tetraFaces)], 'right.ply')];
  const { parts, warnings } = await importModels(files);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].positions[0], 15);
  assert.equal(parts[1].positions[0], 0);
  assert.deepEqual(parts.map(part => part.fileName), ['left.stl', 'right.ply']);
  assert.deepEqual(warnings, []);
});

test('rejects unsupported, empty, malformed, degenerate, and non-finite input', () => {
  const objVertices = 'v 0 0 0\nv 1 0 0\nv 0 1 0\n';
  const cases = [
    [encode('anything'), 'model.glb', /unsupported format/i],
    [new ArrayBuffer(0), 'empty.stl', /empty/i],
    [encode('not an STL'), 'bad.stl', /truncated|invalid/i],
    [encode('solid x\nendsolid x'), 'empty.stl', /no complete triangle/i],
    [encode('solid x\nfacet normal 0 0 1\nvertex 0 0 0\nvertex 1 0 0\nendfacet\nendsolid x'), 'bad.stl', /three valid vertices/i],
    [binarySTL([[[0, 0, 0], [1, 0, 0], [2, 0, 0]]]), 'flat.stl', /degenerate/i],
    [binarySTL([[[0, 0, 0], [1, 0, 0], [NaN, 1, 0]]]), 'nan.stl', /non-finite/i],
    [asciiSTL([[[0, 0, 0], [1, 0, 0], [Infinity, 1, 0]]]), 'infinity.stl', /non-finite/i],
    [encode(`${objVertices}f 0 2 3`), 'zero.obj', /invalid vertex index/i],
    [encode(`${objVertices}f 1 2 4`), 'range.obj', /invalid vertex index/i],
    [encode(`${objVertices}f -4 -2 -1`), 'negative.obj', /invalid vertex index/i],
    [encode(`${objVertices}f 1.5 2 3`), 'fraction.obj', /invalid vertex index/i],
    [encode(`${objVertices}f 1 2`), 'short.obj', /three vertices/i],
    [encode(`${objVertices}f 1 2 3\nf`), 'empty-face.obj', /three vertices/i],
    [encode('v NaN 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3'), 'nan.obj', /non-finite/i],
    [encode('v 0 0\nf 1 1 1'), 'missing.obj', /missing/i],
    [encode(`${objVertices}f 1 1 3`), 'repeated.obj', /degenerate/i],
    [asciiPLY(tetraVertices, [[0, 1, 9]]), 'range.ply', /invalid vertex index/i],
    [asciiPLY(tetraVertices, [[0, 1, -1]]), 'negative.ply', /invalid vertex index/i],
    [asciiPLY(tetraVertices, [[0, 1, 1.5]]), 'fraction.ply', /invalid vertex index/i],
    [asciiPLY(tetraVertices, [[0, 1]]), 'short.ply', /triangles or quads/i],
    [asciiPLY(tetraVertices, [[0, 1, 2, 3, 0]]), 'polygon.ply', /triangulate larger polygons/i],
    [asciiPLY([[NaN, 0, 0], [1, 0, 0], [0, 1, 0]], [[0, 1, 2]]), 'nan.ply', /non-finite/i],
    [binaryPLY(true).slice(0, -1), 'truncated.ply', /incomplete/i],
  ];
  for (const [buffer, fileName, message] of cases) {
    assert.throws(() => parseModel(buffer, fileName), error => error.message.includes(fileName) && message.test(error.message), fileName);
  }
});

test('rejects partially readable STL files instead of silently dropping faces', () => {
  const valid = new TextDecoder().decode(asciiSTL([triangle]));
  const incompleteSolid = valid.replace('endsolid model', '');
  assert.throws(() => parseModel(encode(valid + incompleteSolid), 'partial.stl'), /faces could not be read/i);
});

test('rejects point clouds instead of interpreting every three points as a face', () => {
  assert.throws(() => parseModel(asciiPLY(triangle, []), 'points.ply'), /point clouds/i);
  assert.throws(() => parseModel(encode('v 0 0 0\nv 1 0 0\nv 0 1 0\np 1 2 3\n'), 'points.obj'), /point clouds/i);
  assert.throws(() => parseModel(encode('v 0 0 0\nv 1 0 0\nl 1 2\n'), 'lines.obj'), /lines/i);
});

test('disposes all loader geometries after extraction and on validation failure', () => {
  const original = BufferGeometry.prototype.dispose;
  let disposed = 0;
  BufferGeometry.prototype.dispose = function () { disposed++; original.call(this); };
  try {
    const { parts } = parseModel(binarySTL(tetra()), 'valid.stl');
    assert.equal(disposed, 1);
    assertPart(parts[0], { triangles: 4, vertices: 4, closed: true });
    assert.throws(() => parseModel(binarySTL([[triangle[0], triangle[0], triangle[2]]]), 'bad.stl'), /degenerate/i);
    assert.equal(disposed, 2);
  } finally { BufferGeometry.prototype.dispose = original; }
});

test('exports shared workspace and import budgets', () => {
  assert.equal(MAX_WORKSPACE_TRIANGLES, 2_000_000);
  assert.equal(MAX_WORKSPACE_PARTS, 64);
  assert.equal(MAX_IMPORT_BYTES, 100 * 1024 * 1024);
});

test('allows exactly 64 components, rejects 65, and enforces the part cap across files', async () => {
  const faces = Array.from({ length: MAX_WORKSPACE_PARTS + 1 }, (_, index) => triangle.map(([x, y, z]) => [x + index * 3, y, z]));
  assert.equal(parseModel(binarySTL(faces.slice(0, MAX_WORKSPACE_PARTS)), '64.stl').parts.length, MAX_WORKSPACE_PARTS);
  assert.throws(() => parseModel(binarySTL(faces), '65.stl'), /64 part limit/i);
  await assert.rejects(importModels([
    new File([binarySTL(faces.slice(0, 40))], 'first.stl'),
    new File([binarySTL(faces.slice(40))], 'second.stl'),
  ]), /64 part limit/i);
  let reads = 0;
  const file = { name: 'unread.stl', size: 1, arrayBuffer() { reads++; throw new Error('Must not read'); } };
  await assert.rejects(importModels(Array(MAX_WORKSPACE_PARTS + 1).fill(file)), /64 part limit/i);
  assert.equal(reads, 0);
});

test('checks the triangle budget before allocating and still rejects truncated input at the limit', () => {
  const buffer = new ArrayBuffer(84);
  const view = new DataView(buffer);
  view.setUint32(80, MAX_WORKSPACE_TRIANGLES, true);
  assert.throws(() => parseModel(buffer, 'truncated.stl'), /truncated|invalid triangle count/i);
  view.setUint32(80, MAX_WORKSPACE_TRIANGLES + 1, true);
  assert.throws(() => parseModel(buffer, 'too-many.stl'), /2,000,000 triangle limit/i);
});

test('imports a four-scan-sized batch above 600,000 triangles without reducing faces or changing coordinates', async () => {
  // Match the four dense intraoral scan headers without checking local scan files into the repository.
  const counts = [527_280, 282_662, 40_806, 46_447];
  const names = ['upper.stl', 'lower.stl', 'bite1.stl', 'bite2.stl'];
  const faces = counts.map((_, index) => triangle.map(([x, y, z]) => [x + index * 10, y - 20, z + 30]));
  const files = counts.map((count, index) => new File([repeatedBinarySTL(count, faces[index])], names[index]));
  const { parts, warnings } = await importModels(files);
  assert.equal(parts.length, 4);
  assert.equal(parts.reduce((total, part) => total + part.triangles, 0), 897_195);
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    assert.equal(part.fileName, names[index]);
    assert.equal(part.triangles, counts[index]);
    assert.equal(part.positions.length, counts[index] * 9);
    assert.equal(part.normals.length, part.positions.length);
    assert.deepEqual([...part.positions.subarray(0, 9)], faces[index].flat());
    assert.deepEqual([...part.positions.subarray(-9)], faces[index].flat());
    assert.deepEqual(part.offset, [0, 0, 0]);
    assert.deepEqual(part.dimensions, [1, 1, 0]);
  }
  assert.equal(warnings.length, 4);
});

test('enforces the triangle cap across files', async () => {
  const buffer = new ArrayBuffer(84);
  const view = new DataView(buffer);
  const first = new File([binarySTL(tetra())], 'first.stl');
  view.setUint32(80, MAX_WORKSPACE_TRIANGLES - 4, true);
  await assert.rejects(importModels([first, new File([buffer], 'truncated.stl')]), /truncated|invalid triangle count/i);
  // Individually within the limit, but one triangle beyond the remaining batch budget.
  view.setUint32(80, MAX_WORKSPACE_TRIANGLES - 3, true);
  await assert.rejects(importModels([first, new File([buffer], 'second.stl')]), /2,000,000 triangle limit/i);
});

test('checks 100 MiB total before reading files and reports read errors', async () => {
  let reads = 0;
  const file = { name: 'large.stl', size: 60 * 1024 * 1024, arrayBuffer() { reads++; throw new Error('Must not read'); } };
  await assert.rejects(importModels([file, file]), /100 MiB input limit/i);
  assert.equal(reads, 0);
  assert.throws(() => parseModel(new ArrayBuffer(MAX_IMPORT_BYTES + 1), 'large.ply'), /100 MiB input limit/i);
  await assert.rejects(importModels([{ name: 'unreadable.stl', size: 1, async arrayBuffer() { throw new Error('disk'); } }]), /unreadable.stl: file could not be read/i);
  await assert.rejects(importModels([]), /Choose at least one/i);
});

const texturedOBJ = (prefix = '', name = 'Upper') => `${prefix}
o ${name}
v 10 20 30 1 0 0
v 11 20 30 0 1 0
v 10 21 30 0 0 1
v 10 20 31 1 1 1
vt 0 1
vt 1 1
vt 0 0
vt 1 0
f 1/1 2/2 3/3
f 1/4 3/3 4/2
`;
const localImage = name => new File([new Uint8Array([255, 216, 255, 217])], name, { type: 'image/jpeg' });

function binaryFaceUVPLY() {
  const header = new TextEncoder().encode('ply\nformat binary_little_endian 1.0\ncomment TextureFile atlases/atlas.jpg\nelement vertex 4\nproperty float x\nproperty float y\nproperty float z\nelement face 2\nproperty list uchar int vertex_indices\nproperty list uchar float texcoord\nend_header\n');
  const buffer = new ArrayBuffer(header.length + 4 * 12 + 2 * (1 + 3 * 4 + 1 + 6 * 4));
  new Uint8Array(buffer).set(header);
  const view = new DataView(buffer);
  let cursor = header.length;
  for (const value of tetraVertices.flat()) { view.setFloat32(cursor, value, true); cursor += 4; }
  for (const [face, uvs] of [[[0, 1, 2], [0, 1, 1, 1, 0, 0]], [[0, 2, 3], [1, 0, 0, 0, 1, 1]]]) {
    view.setUint8(cursor++, 3);
    for (const index of face) { view.setInt32(cursor, index, true); cursor += 4; }
    view.setUint8(cursor++, 6);
    for (const value of uvs) { view.setFloat32(cursor, value, true); cursor += 4; }
  }
  return buffer;
}

test('binary PLY per-face texcoord lists preserve seams, face order, and local TextureFile comments generically', async () => {
  const { parts, warnings } = await importModels([
    new File([binaryFaceUVPLY()], 'arbitrary-scan-name.ply'), localImage('atlas.jpg'),
  ]);
  assert.equal(parts.length, 1);
  const part = parts[0];
  assert.equal(part.triangles, 2);
  assert.equal(part.vertices, 4);
  assert.deepEqual([...part.positions], [...tetraVertices[0], ...tetraVertices[1], ...tetraVertices[2], ...tetraVertices[0], ...tetraVertices[2], ...tetraVertices[3]]);
  assert.deepEqual([...part.uvs], [0, 1, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1]);
  assert.equal(part.texture.fileName, 'atlas.jpg');
  assert.equal(part.textureStatus, 'mapped');
  assert.match(warnings.join('\n'), /decoding is unavailable/);
});

test('PLY quad face UVs follow the existing 013/123 triangulation without welding seam coordinates', () => {
  const header = 'ply\nformat ascii 1.0\nelement vertex 4\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nproperty list uchar float texcoord\nend_header\n';
  const vertices = '0 0 0\n1 0 0\n1 1 0\n0 1 0\n';
  const { parts } = parseModel(encode(header + vertices + '4 0 1 2 3 8 0 0 1 0 1 1 0 1\n'), 'quad-atlas.ply');
  assert.equal(parts[0].triangles, 2);
  assert.deepEqual([...parts[0].positions], [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  assert.deepEqual([...parts[0].uvs], [0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1]);
  const incomplete = parseModel(encode(header + vertices + '4 0 1 2 3 6 0 0 1 0 1 1\n'), 'incomplete-atlas.ply');
  assert.equal(incomplete.parts[0].uvs, undefined);
  assert.match(incomplete.warnings.join('\n'), /incomplete.*face UVs/);
});

test('OBJ preserves separate UV seam corners, linear vertex colors, and original face/coordinate order', () => {
  const { parts } = parseModel(encode(texturedOBJ()), 'upper.obj');
  assert.equal(parts.length, 1);
  const part = parts[0];
  assert.deepEqual([...part.positions], [10, 20, 30, 11, 20, 30, 10, 21, 30, 10, 20, 30, 10, 21, 30, 10, 20, 31]);
  assert.deepEqual([...part.uvs], [0, 1, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1]);
  assert.deepEqual([...part.colors], [1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 1, 1]);
  assert.equal(part.vertices, 4, 'UV seam does not change exact geometric welding');
  assert.equal(part.textureStatus, 'vertex-colors');
  assert.equal(part.tissueScores.length, part.triangles);
});

test('indexed PLY preserves UVs and linear RGB through component splitting', () => {
  const header = `ply\nformat ascii 1.0\nelement vertex 6\nproperty float x\nproperty float y\nproperty float z\nproperty float s\nproperty float t\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nelement face 2\nproperty list uchar int vertex_indices\nend_header\n`;
  const data = `0 0 0 0 1 128 128 128\n1 0 0 1 1 128 128 128\n0 1 0 0 0 128 128 128\n9 0 0 1 0 255 0 0\n10 0 0 0 0 255 0 0\n9 1 0 1 1 255 0 0\n3 0 1 2\n3 3 4 5\n`;
  const { parts } = parseModel(encode(header + data), 'colored.ply');
  assert.equal(parts.length, 2);
  assert.deepEqual([...parts[0].uvs], [0, 1, 1, 1, 0, 0]);
  assert.deepEqual([...parts[1].uvs], [1, 0, 0, 0, 1, 1]);
  assert.ok(Math.abs(parts[0].colors[0] - 0.2158605) < 1 / 255, 'Three retains linear integer PLY colors at the source bit depth');
  assert.deepEqual([...parts[1].colors], [1, 0, 0, 1, 0, 0, 1, 0, 0]);
  assert.equal(parts[1].positions[0], 9);
});

test('incomplete OBJ UVs never use loader placeholder coordinates as an atlas mapping', async () => {
  const text = texturedOBJ().replace('f 1/4 3/3 4/2', 'f 1 3 4');
  const part = parseModel(encode(text), 'upper.obj').parts[0];
  assert.equal(part.uvs, undefined);
  const result = await attachTexture(part, localImage('upper.jpg'));
  assert.equal(result.part.textureStatus, 'unmapped');
  assert.match(result.warnings[0], /No atlas mapping was invented/);
  assert.equal(result.part.colors, part.colors, 'valid source vertex colors remain usable');
  assert.throws(() => parseModel(encode(texturedOBJ().replace('1/4', '1/9')), 'bad-uv.obj'), /invalid texture vertex/);
});

test('local MTL map_Kd resolves sanitized image basenames and keeps image bytes without a Node decoder', async () => {
  const obj = texturedOBJ('mtllib materials/scan.mtl\nusemtl enamel');
  const image = localImage('upper.jpg');
  const { parts, warnings } = await importModels([
    image,
    new File([encode(obj)], 'upper.obj'),
    new File(['newmtl enamel\nmap_Kd ..\\atlases\\upper.jpg\n'], 'scan.mtl'),
  ]);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].texture.fileName, 'upper.jpg');
  assert.equal(parts[0].texture.mimeType, 'image/jpeg');
  assert.deepEqual([...parts[0].texture.bytes], [255, 216, 255, 217]);
  assert.equal(parts[0].textureStatus, 'mapped');
  assert.equal(parts[0].colors, undefined, 'never keep stale evidence from a previous texture');
  assert.match(warnings.join('\n'), /decoding is unavailable/);
  assert.doesNotMatch(warnings.join('\n'), /were ignored/);
});

test('unique exact mesh basenames pair images, while duplicate and unrelated atlases are never guessed', async () => {
  const obj = new File([encode(texturedOBJ('', 'Arch'))], 'upper.obj');
  const paired = await importModels([obj, localImage('upper.jpeg')]);
  assert.equal(paired.parts[0].texture.fileName, 'upper.jpeg');
  const ambiguous = await importModels([obj, localImage('upper.jpeg'), localImage('upper.jpg')]);
  assert.equal(ambiguous.parts[0].texture, undefined);
  assert.match(ambiguous.warnings.join('\n'), /several images/);
  const unrelated = await importModels([obj, localImage('lower.jpg')]);
  assert.equal(unrelated.parts[0].texture, undefined);
  assert.match(unrelated.warnings.join('\n'), /no unique local mesh/);
});

test('reference-only STL attachment keeps geometry, transform, and colors intact without inventing UVs', async () => {
  const part = parseModel(binarySTL(tetra([50, 0, 0])), 'upper.stl').parts[0];
  part.pose = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1];
  part.offset = [1, 2, 3];
  const { part: next, warnings } = await attachTexture(part, localImage('folder/upper.jpg'));
  assert.equal(next.id, part.id);
  assert.equal(next.positions, part.positions);
  assert.equal(next.normals, part.normals);
  assert.equal(next.pose, part.pose);
  assert.equal(next.offset, part.offset);
  assert.equal(next.texture.fileName, 'upper.jpg');
  assert.equal(next.uvs, undefined);
  assert.equal(next.tissueScores, undefined);
  assert.equal(next.textureStatus, 'unmapped');
  assert.match(warnings[0], /unmapped reference image/);
});

test('MTL material groups pair their own local images and remote maps never fall back to a guessed atlas', async () => {
  const first = texturedOBJ('mtllib both.mtl\nusemtl top', 'Top');
  const second = '\ng Bottom\nusemtl bottom\nf 1/1 3/3 4/4\n';
  const { parts } = await importModels([
    new File([first + second], 'arches.obj'),
    new File(['newmtl top\nmap_Kd upper.jpg\nnewmtl bottom\nmap_Kd lower.jpg'], 'both.mtl'),
    localImage('upper.jpg'), localImage('lower.jpg'),
  ]);
  assert.deepEqual(parts.map(part => part.texture.fileName), ['upper.jpg', 'lower.jpg']);
  const remote = await importModels([
    new File([texturedOBJ('mtllib remote.mtl\nusemtl enamel')], 'upper.obj'),
    new File(['newmtl enamel\nmap_Kd https://example.invalid/upper.jpg'], 'remote.mtl'),
    localImage('upper.jpg'),
  ]);
  assert.equal(remote.parts[0].texture, undefined);
  assert.match(remote.warnings.join('\n'), /Remote texture reference was ignored/);
});

test('connected multi-material meshes keep topology and retain a local reference when decoding is unavailable', async () => {
  const obj = texturedOBJ('mtllib both.mtl\nusemtl enamel').replace('f 1/4 3/3 4/2', 'usemtl tissue\nf 1/4 3/3 4/2');
  const { parts, warnings } = await importModels([
    new File([obj], 'combined.obj'),
    new File(['newmtl enamel\nmap_Kd ivory.jpg\nnewmtl tissue\nmap_Kd red.jpg'], 'both.mtl'),
    localImage('ivory.jpg'), localImage('red.jpg'),
  ]);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].triangles, 2);
  assert.equal(parts[0].vertices, 4);
  assert.equal(parts[0].textureStatus, 'unmapped');
  assert.equal(parts[0].texture.fileName, 'ivory.jpg');
  assert.match(warnings.join('\n'), /first image was kept as an unmapped reference/);
});

test('support files count toward 100 MiB, images cap at 16 MiB, and supports do not count as mesh parts', async () => {
  const obj = new File([texturedOBJ()], 'upper.obj');
  let reads = 0;
  const oversized = { name: 'upper.jpg', size: 16 * 1024 * 1024 + 1, arrayBuffer() { reads++; throw new Error('Must not read'); } };
  await assert.rejects(importModels([obj, oversized]), /16 MiB/);
  await assert.rejects(attachTexture(parseModel(encode(texturedOBJ()), 'upper.obj').parts[0], oversized), /16 MiB/);
  await assert.rejects(importModels([{ ...oversized, size: MAX_IMPORT_BYTES } , obj]), /100 MiB/);
  assert.equal(reads, 0);
  const files = Array.from({ length: 64 }, (_, index) => new File([binarySTL([triangle])], `${index}.stl`));
  assert.equal((await importModels([...files, localImage('0.jpg')])).parts.length, 64);
  await assert.rejects(importModels([localImage('upper.jpg')]), /alongside image/);
});
