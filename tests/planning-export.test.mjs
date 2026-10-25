import assert from 'node:assert/strict';
import test from 'node:test';
import { Matrix4 } from 'three';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { planningExportBundle, planningExportManifest } from '../src/planning-export.ts';
import { createPlanningSession } from '../src/planning-session.ts';
import { emptyToothCase, geometrySignature } from '../src/tooth-session.ts';
import { generateRestoration } from '../src/restoration-geometry.ts';

async function fixture() {
  const source = { id: 'upper', name: 'Upper', fileName: 'upper.ply', role: 'upper', positions: new Float32Array([0,0,0, 4,0,0, 0,4,0]), normals: new Float32Array(9), triangles: 1, vertices: 3, closed: false, visible: true, offset: [1,2,3], dimensions: [4,4,0], pose: new Matrix4().makeRotationZ(Math.PI / 4).toArray() };
  const spec = { version: 'implant-assembly/v1', fdi: 15, parentPartId: source.id,
    frame: { origin: [1,1,0], u: [1,0,0], v: [0,1,0], up: [0,0,1] },
    parameters: { fixture: { radius: .6, length: 2, depth: 0, taper: .1 }, abutment: { radius: .5, height: 1, emergenceRadius: .7, angleX: 0, angleY: 0 }, crown: { width: 2, depth: 2, height: 2, cuspHeight: .4, rotation: 0 } },
    anatomy: 'premolar', provenance: 'hypothesized', units: 'file units (u)', source: 'Explicit procedural hypothesis.' };
  const assemblies = ['candidate-one', '../candidate two', 'stale-candidate'].map((id, index) => ({
    id, spec, createdAt: '2026-10-24T12:00:00.000Z', warnings: index === 2 ? ['STALE: source changed'] : ['Clinical fit unvalidated.'],
    parts: generateRestoration(spec).map(mesh => ({ ...mesh, id: `${id}-${mesh.component}`, name: mesh.component, fileName: `${mesh.component}.ply`, offset: [0,0,0], visible: true, role: 'model', restoration: { assemblyId: id, component: mesh.component, parentPartId: source.id } })),
  }));
  const session = await createPlanningSession({ parts: [source], teeth: emptyToothCase(), assemblies, mmPerUnit: .5, unitsProvenance: 'Independent calibration reference.' });
  return { session, assemblies };
}

function zipFiles(buffer) {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer), files = new Map();
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    assert.equal(view.getUint16(offset + 8, true), 0, 'ZIP entries are uncompressed');
    const size = view.getUint32(offset + 18, true), nameLength = view.getUint16(offset + 26, true), extraLength = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    const start = offset + 30 + nameLength + extraLength;
    assert.equal(files.has(name), false, 'Each component has an independent ZIP path');
    files.set(name, bytes.slice(start, start + size));
    offset = start + size;
  }
  assert.equal(view.getUint32(offset, true), 0x02014b50, 'A standard ZIP central directory follows the files');
  return files;
}

test('mesh sidecar preserves source hashes, registration and units with independent same-FDI candidate paths', async () => {
  const { session } = await fixture(), before = JSON.stringify(session);
  const manifest = planningExportManifest(session);
  assert.equal(manifest.format, 'platanus-mesh-export');
  assert.equal(manifest.mmPerUnit, .5);
  assert.equal(manifest.units, 'file units (u)');
  assert.deepEqual(manifest.sources, session.sources);
  const [first, second, stale] = manifest.assemblies;
  assert.notEqual(first.parts[0].path, second.parts[0].path);
  assert.ok(second.parts[0].path.includes('%2F'));
  assert.equal(stale.exported, false);
  assert.ok(stale.parts.every(part => part.path === null));
  for (const part of first.parts) {
    assert.equal(part.positions, undefined);
    assert.equal(part.normals, undefined);
    assert.equal(part.parentSourceKey, 'scan-1');
    assert.deepEqual(part.fileToWorkspace, session.sources[0].fileToWorkspace);
  }
  assert.equal(JSON.stringify(session), before);
});

test('bundle meshes match the saved snapshot and sidecar geometry hashes even if live assemblies change', async () => {
  const { session, assemblies } = await fixture();
  assemblies[0].parts[0].positions[0] = 999;
  const files = zipFiles(await planningExportBundle(session, assemblies).arrayBuffer());
  assert.equal(files.size, 7);
  const manifest = JSON.parse(new TextDecoder().decode(files.get('manifest.json')));
  for (const assembly of manifest.assemblies.filter(assembly => assembly.exported)) for (const part of assembly.parts) {
    const bytes = files.get(part.path);
    assert.ok(bytes, 'Every manifest path resolves to an exported mesh');
    const geometry = new PLYLoader().parse(bytes.buffer);
    const positions = geometry.getAttribute('position').array;
    assert.equal(await geometrySignature(positions), part.geometrySha256);
    assert.deepEqual(Array.from(positions), session.assemblies.find(item => item.id === assembly.id).parts.find(item => item.component === part.component).positions);
    geometry.dispose();
  }
  assert.equal([...files.keys()].some(name => name.includes('stale-candidate')), false);
});
