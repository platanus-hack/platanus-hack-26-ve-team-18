import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { generateRestoration } from '../src/restoration-geometry.ts';
import { displayNormals } from '../src/restoration-appearance.ts';
import { restorationPly } from '../src/restoration-export.ts';
import { parseModel } from '../src/import-models.ts';

// An offset, rotated frame: any accidental pose or frame transform would move coordinates.
const frame = (() => {
  const up = new THREE.Vector3(0.2, -0.3, 1).normalize(), u = new THREE.Vector3(1, 0.4, 0).projectOnPlane(up).normalize(), v = up.clone().cross(u);
  return { origin: [12.5, -40.25, 7.75], u: u.toArray(), v: v.toArray(), up: up.toArray() };
})();
const spec = { version: 'implant-assembly/v1', fdi: 36, parentPartId: 'lower', frame,
  parameters: { fixture: { radius: 1.1, length: 5, depth: 0.4, taper: 0.3 }, abutment: { radius: 0.8, height: 2.1, emergenceRadius: 1.3, angleX: 0, angleY: 0 },
    crown: { width: 5.2, depth: 4.6, height: 3.5, cuspHeight: 1.1, rotation: 0 } },
  anatomy: 'molar', provenance: 'hypothesized', units: 'file units (u)', source: 'Synthetic geometric hypothesis; no patient data' };
const colors = { fixture: '#94a3b8', abutment: '#c4a46b', crown: '#f4ead7' };
// A rotated, translated current pose must NOT be applied by the export.
const pose = new THREE.Matrix4().makeRotationZ(0.7).setPosition(5, -3, 2).toArray();
const parts = generateRestoration(spec).map(mesh => ({ id: `a-${mesh.component}`, name: mesh.component, fileName: `FDI-36-${mesh.component}.ply`,
  positions: mesh.positions, normals: mesh.normals, triangles: mesh.triangles, vertices: mesh.vertices, closed: mesh.closed, dimensions: mesh.dimensions,
  offset: [0, 0, 0], visible: true, role: 'model', pose, presentationColor: colors[mesh.component], restoration: { assemblyId: 'a', component: mesh.component, parentPartId: 'lower' } }));

function parseAscii(text) {
  const lines = text.split('\n'), end = lines.indexOf('end_header'), header = lines.slice(0, end);
  const vertices = Number(header.find(line => line.startsWith('element vertex')).split(' ')[2]);
  const rows = lines.slice(end + 1, end + 1 + vertices).map(line => line.split(' ').map(Number));
  return { header, rows, faces: lines.slice(end + 1 + vertices) };
}

test('export keeps source coordinates/topology byte-equal and writes source-frame display normals', () => {
  for (const part of parts) {
    const before = part.positions.slice(), normalsBefore = part.normals.slice();
    const { header, rows, faces } = parseAscii(restorationPly(part));
    assert.deepEqual(header.filter(line => line.startsWith('property')).map(line => line.split(' ').at(-1)), ['x', 'y', 'z', 'nx', 'ny', 'nz', 'red', 'green', 'blue', 'vertex_indices']);
    assert.ok(header.some(line => /Clinical fit unvalidated/.test(line)));
    assert.ok(header.some(line => /PBR properties are not preserved/.test(line)));
    assert.ok(header.some(line => /original source coordinates/.test(line)));
    const positions = Float32Array.from(rows.flatMap(row => row.slice(0, 3)));
    assert.deepEqual(new Uint8Array(positions.buffer), new Uint8Array(part.positions.buffer), `${part.name}: positions byte-equal, pose not applied`);
    assert.equal(faces.length, part.triangles);
    faces.forEach((line, face) => assert.equal(line, `3 ${face * 3} ${face * 3 + 1} ${face * 3 + 2}`));
    const display = displayNormals(part).normals, exported = Float32Array.from(rows.flatMap(row => row.slice(3, 6)));
    assert.deepEqual(exported, display, `${part.name}: normals are the viewer display normals`);
    for (let c = 0; c < rows.length; c++) {
      const n = new THREE.Vector3(...rows[c].slice(3, 6)), flat = new THREE.Vector3().fromArray(part.normals, c * 3);
      assert.ok(Math.abs(n.length() - 1) < 1e-5);
      assert.ok(n.dot(flat) > 0.5, `${part.name}: normal ${c} stays outward and in the source frame`);
    }
    const hex = colors[part.restoration.component];
    for (const row of rows) assert.deepEqual(row.slice(6), [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)));
    assert.deepEqual(part.positions, before); assert.deepEqual(part.normals, normalsBefore);
  }
});

test('the app importer round-trips source geometry and colors but recomputes flat normals', () => {
  for (const part of parts) {
    const result = parseModel(new TextEncoder().encode(restorationPly(part)).buffer, part.fileName);
    assert.equal(result.parts.length, 1);
    const imported = result.parts[0];
    assert.deepEqual(new Uint8Array(imported.positions.buffer), new Uint8Array(part.positions.buffer), `${part.name}: positions/topology round-trip`);
    // Current importer behavior (unchanged here): file normals are replaced by per-face normals.
    for (let i = 0; i < part.normals.length; i++) assert.ok(Math.abs(imported.normals[i] - part.normals[i]) < 1e-5);
    // PLYLoader decodes sRGB bytes to linear (re-quantized to 8 bits); the importer keeps them as vertex colors.
    const expected = new THREE.Color(colors[part.restoration.component]);
    assert.equal(imported.textureStatus, 'vertex-colors');
    for (const [i, value] of [expected.r, expected.g, expected.b].entries()) assert.ok(Math.abs(imported.colors[i] - value) <= 1.01 / 255);
    assert.equal(imported.restoration, undefined, 'no metadata is guessed on reimport');
  }
});

test('a part without a hex presentation color omits color properties', () => {
  const { header } = parseAscii(restorationPly({ ...parts[0], presentationColor: undefined }));
  assert.equal(header.some(line => /property uchar red/.test(line)), false);
  assert.equal(header.some(line => /Vertex colors/.test(line)), false);
});
