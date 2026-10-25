import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateRestoration, restorationReferencePlanes } from '../src/restoration-geometry.ts';
import { parseModel } from '../src/import-models.ts';
import { inspectMesh } from '../skills/dental-restoration-design/scripts/dental-concept.mjs';

function spec() {
  return { version: 'implant-assembly/v1', fdi: 36, parentPartId: 'synthetic-lower',
    frame: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], up: [0, 0, 1] },
    parameters: { fixture: { radius: 1.1, length: 5, depth: 0.4, taper: 0.3 },
      abutment: { radius: 0.8, height: 2.1, emergenceRadius: 1.3, angleX: 0, angleY: 0 },
      crown: { width: 5.2, depth: 4.6, height: 3.5, cuspHeight: 1.1, rotation: 0 } },
    anatomy: 'molar', provenance: 'hypothesized', units: 'file units (u)', source: 'Synthetic geometric hypothesis; no patient data' };
}

test('partial Float32 folding and extreme anisotropy are rejected before source geometry is emitted', () => {
  const offset = spec();
  offset.frame = { origin: [0, 0, 1e7], u: [2/3, 2/3, -1/3], v: [-1/3, 2/3, 2/3], up: [2/3, -1/3, 2/3] };
  assert.throws(() => generateRestoration(offset), /precision/i);
  const stretched = spec();
  stretched.frame = { ...offset.frame, origin: [0, 0, 0] };
  Object.assign(stretched.parameters.crown, { width: 400000, depth: 0.1, height: 0.1 });
  assert.throws(() => generateRestoration(stretched), /numerical construction/i);
});
const subtract = (a, b) => a.map((v, i) => v - b[i]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const close = (a, b, tolerance = 1e-5) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
function bounds(mesh, axis) {
  let min = Infinity, max = -Infinity;
  for (let i = axis; i < mesh.positions.length; i += 3) { min = Math.min(min, mesh.positions[i]); max = Math.max(max, mesh.positions[i]); }
  return [min, max];
}
function indexed(mesh) {
  const points = [], indices = [], lookup = new Map();
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const point = Array.from(mesh.positions.subarray(i, i + 3)), key = point.join(',');
    if (!lookup.has(key)) { lookup.set(key, points.length / 3); points.push(...point); }
    indices.push(lookup.get(key));
  }
  return { positions: Float32Array.from(points), indices: Uint32Array.from(indices) };
}
function integrity(mesh) {
  const report = inspectMesh(indexed(mesh));
  assert.equal(mesh.closed, true);
  assert.equal(report.closed, true);
  assert.equal(report.vertexManifold, true);
  assert.equal(report.consistentlyOriented, true);
  assert.equal(report.degenerateTriangles, 0);
  assert.ok(report.signedVolume > 0);
  assert.equal(report.vertexCount, mesh.vertices);
  assert.equal(report.triangleCount, mesh.triangles);
  assert.equal(report.vertexCount - report.edgeCount + report.triangleCount, 2);
  assert.deepEqual(mesh.dimensions, report.bounds.size);
  return report;
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('three deterministic independent closed, oriented meshes with finite unit normals; spec stays untouched', () => {
  const input = freeze(spec()), before = JSON.stringify(input), meshes = generateRestoration(input);
  assert.deepEqual(meshes.map(mesh => mesh.component), ['fixture', 'abutment', 'crown']);
  const buffers = meshes.flatMap(mesh => [mesh.positions.buffer, mesh.normals.buffer]);
  assert.equal(new Set(buffers).size, 6);
  for (const mesh of meshes) {
    integrity(mesh);
    assert.ok(mesh.positions instanceof Float32Array);
    assert.ok(mesh.normals instanceof Float32Array);
    assert.equal(mesh.positions.length, mesh.triangles * 9);
    assert.equal(mesh.normals.length, mesh.positions.length);
    for (let i = 0; i < mesh.positions.length; i += 9) {
      const [a, b, c] = [0, 3, 6].map(offset => Array.from(mesh.positions.subarray(i + offset, i + offset + 3)));
      const normal = cross(subtract(b, a), subtract(c, a)), length = Math.hypot(...normal);
      for (const offset of [0, 3, 6]) {
        const actual = Array.from(mesh.normals.subarray(i + offset, i + offset + 3));
        close(Math.hypot(...actual), 1, 1e-6);
        assert.ok(dot(normal, actual) / length > 0.99999);
      }
    }
  }
  assert.equal(JSON.stringify(input), before);
  const again = generateRestoration(input);
  meshes.forEach((mesh, i) => { assert.deepEqual(mesh.positions, again[i].positions); assert.notEqual(mesh.positions.buffer, again[i].positions.buffer); });
  const untouched = meshes[1].positions.slice();
  meshes[0].positions.fill(123);
  assert.deepEqual(meshes[1].positions, untouched);
});

test('fixture and generic abutment share an explicit submerged platform; crown follows its slanted top', () => {
  const input = spec(), [fixture, abutment, crown] = generateRestoration(input);
  close(bounds(fixture, 2)[1], -input.parameters.fixture.depth);
  close(bounds(fixture, 2)[0], -input.parameters.fixture.depth - input.parameters.fixture.length);
  assert.deepEqual(bounds(abutment, 2), [-Math.fround(input.parameters.fixture.depth), Math.fround(input.parameters.abutment.height)]);
  const planes = restorationReferencePlanes(input);
  assert.deepEqual(planes.fixturePlatform.origin, [0, 0, -input.parameters.fixture.depth]);
  assert.deepEqual(planes.site.origin, input.frame.origin);
  assert.match(planes.interpretation, /no compatible implant connection/);
  const platformRadius = Math.max(...Array.from(abutment.positions).filter((_, index) => index % 3 === 0 && abutment.positions[index + 2] === Math.fround(-input.parameters.fixture.depth)));
  close(platformRadius, input.parameters.fixture.radius);
  close(bounds(crown, 2)[0], input.parameters.abutment.height);
  close(bounds(fixture, 0)[1], input.parameters.fixture.radius);
  input.parameters.abutment.angleX = 13; input.parameters.abutment.angleY = -19;
  const slanted = generateRestoration(input), h = input.parameters.abutment.height;
  const top = [Math.tan(-19 * Math.PI / 180) * h, -Math.tan(13 * Math.PI / 180) * h];
  for (let i = 0; i < crown.positions.length; i += 3) {
    close(slanted[2].positions[i] - crown.positions[i], top[0]);
    close(slanted[2].positions[i + 1] - crown.positions[i + 1], top[1]);
    close(slanted[2].positions[i + 2], crown.positions[i + 2]);
  }
  slanted.forEach(integrity);
});

test('each fixture and crown parameter edits its own component; abutment controls remain independent', () => {
  const input = spec(), original = generateRestoration(input);
  for (const [component, key, value] of [
    ['fixture', 'radius', 1.5], ['fixture', 'length', 7], ['fixture', 'depth', 1.1], ['fixture', 'taper', 0.7],
    ['crown', 'width', 6.2], ['crown', 'depth', 5.6], ['crown', 'height', 4.1], ['crown', 'cuspHeight', 1.9], ['crown', 'rotation', 27],
    ['abutment', 'radius', 1.2], ['abutment', 'emergenceRadius', 1.9],
    ['abutment', 'height', 3.1], ['abutment', 'angleX', 17], ['abutment', 'angleY', -12],
  ]) {
    const edited = structuredClone(input); edited.parameters[component][key] = value;
    const next = generateRestoration(edited), index = ['fixture', 'abutment', 'crown'].indexOf(component);
    assert.notDeepEqual(next[index].positions, original[index].positions, `${component}.${key} must affect its shape`);
    if (component !== 'fixture' || !['radius', 'depth'].includes(key)) assert.deepEqual(next[component === 'fixture' ? 1 : 0].positions, original[component === 'fixture' ? 1 : 0].positions);
    if (component === 'fixture' || (component === 'abutment' && ['radius', 'emergenceRadius'].includes(key))) assert.deepEqual(next[2].positions, original[2].positions);
    if (component === 'crown') assert.deepEqual(next[1].positions, original[1].positions);
    next.forEach(integrity);
  }
});

test('incisor, canine, premolar and molar have distinct procedural exterior anatomy with closed caps', () => {
  const input = spec(), crowns = [];
  for (const anatomy of ['incisor', 'canine', 'premolar', 'molar']) {
    input.anatomy = anatomy;
    const meshes = generateRestoration(input); meshes.forEach(integrity); crowns.push(meshes[2].positions);
    input.parameters.crown.cuspHeight = 0;
    generateRestoration(input).forEach(integrity);
    input.parameters.crown.cuspHeight = 1.1;
  }
  for (let a = 0; a < crowns.length; a++) for (let b = a + 1; b < crowns.length; b++) assert.notDeepEqual(crowns[a], crowns[b]);
});

test('source frame transforms coordinates and normals once, preserving handedness and source origin', () => {
  const input = spec(), local = generateRestoration(input);
  input.frame = { origin: [100, -20, 30], u: [0, 1, 0], v: [0, 0, -1], up: [-1, 0, 0] };
  const transformed = generateRestoration(input);
  for (let k = 0; k < local.length; k++) {
    for (let i = 0; i < local[k].positions.length; i += 3) {
      const [x, y, z] = local[k].positions.subarray(i, i + 3);
      close(transformed[k].positions[i], 100 - z);
      close(transformed[k].positions[i + 1], -20 + x);
      close(transformed[k].positions[i + 2], 30 - y);
      const [nx, ny, nz] = local[k].normals.subarray(i, i + 3);
      close(transformed[k].normals[i], -nz, 0.001);
      close(transformed[k].normals[i + 1], nx, 0.001);
      close(transformed[k].normals[i + 2], -ny, 0.001);
    }
    integrity(transformed[k]);
  }
});

test('file-unit scaling preserves geometry proportions, topology and normals', () => {
  const input = spec(); input.frame.origin = [2, -3, 4];
  const original = generateRestoration(input);
  for (const factor of [0.001, 0.1, 10, 1000]) {
    const scaled = structuredClone(input); scaled.frame.origin = scaled.frame.origin.map(v => v * factor);
    for (const [component, keys] of Object.entries({ fixture: ['radius', 'length', 'depth'], abutment: ['radius', 'height', 'emergenceRadius'], crown: ['width', 'depth', 'height', 'cuspHeight'] })) {
      for (const key of keys) scaled.parameters[component][key] *= factor;
    }
    const meshes = generateRestoration(scaled);
    meshes.forEach((mesh, k) => {
      integrity(mesh); assert.equal(mesh.triangles, original[k].triangles);
      for (let i = 0; i < mesh.positions.length; i++) close(mesh.positions[i] / factor, original[k].positions[i], 2e-6);
    });
  }
});

test('arbitrary oblique and upper/lower frames preserve local depths without choosing global anatomical up', () => {
  const input = spec(), original = generateRestoration(input);
  for (const sign of [1, -1]) {
    const alpha = 0.63, beta = -0.42;
    input.frame = {
      origin: [-17, 3, 22],
      u: [Math.cos(alpha), Math.sin(alpha), 0],
      v: [-Math.sin(alpha) * Math.cos(beta) * sign, Math.cos(alpha) * Math.cos(beta) * sign, Math.sin(beta) * sign],
      up: [Math.sin(alpha) * Math.sin(beta) * sign, -Math.cos(alpha) * Math.sin(beta) * sign, Math.cos(beta) * sign],
    };
    const { origin, u, v, up } = input.frame, meshes = generateRestoration(input);
    meshes.forEach((mesh, k) => {
      integrity(mesh);
      for (let i = 0; i < mesh.positions.length; i += 3) {
        const p = subtract(Array.from(mesh.positions.subarray(i, i + 3)), origin);
        for (const [axis, direction] of [u, v, up].entries()) close(dot(p, direction), original[k].positions[i + axis]);
      }
    });
  }
});

test('invalid, reflected and non-orthonormal frames and invalid parameters fail clearly', () => {
  for (const frame of [null, { origin: [0, 0] },
    { ...spec().frame, origin: [NaN, 0, 0] }, { ...spec().frame, up: [0, 0, -1] },
    { ...spec().frame, u: [2, 0, 0] }, { ...spec().frame, v: [0.1, 1, 0] }]) {
    const input = spec(); input.frame = frame; assert.throws(() => generateRestoration(input), /frame|coordinates/i);
  }
  for (const [component, key, values] of [
    ['fixture', 'radius', [0, -1, NaN, Infinity]], ['fixture', 'length', [0, -1]],
    ['fixture', 'depth', [-1, NaN]], ['fixture', 'taper', [-0.1, 1]],
    ['abutment', 'radius', [0, -1]], ['abutment', 'emergenceRadius', [0, -1]], ['abutment', 'height', [0, Infinity]],
    ['abutment', 'angleX', [-90, 90, NaN]], ['abutment', 'angleY', [-90, 90]],
    ['crown', 'width', [0, NaN]], ['crown', 'depth', [-1, Infinity]], ['crown', 'height', [0, -2]],
    ['crown', 'cuspHeight', [-1, NaN]], ['crown', 'rotation', [NaN, Infinity]],
  ]) for (const value of values) {
    const input = spec(); input.parameters[component][key] = value;
    assert.throws(() => generateRestoration(input), /finite|positive/i, `${component}.${key}: ${value}`);
  }
  for (const edit of [{ version: 'future' }, { fdi: 99 }, { units: 'mm' }, { source: '' }, { provenance: 'automatic' }, { anatomy: 'unknown' }, { parameters: {} }]) {
    assert.throws(() => generateRestoration({ ...spec(), ...edit }));
  }
  const hugeOrigin = spec(); hugeOrigin.frame.origin = [1e12, 1e12, 1e12];
  assert.throws(() => generateRestoration(hugeOrigin), /precision|degenerate/i);
});

test('worker transfers six independent arrays, preserves request IDs and recovers from invalid work', async () => {
  const previousPost = globalThis.postMessage, previousHandler = globalThis.onmessage;
  let response, transfer;
  globalThis.postMessage = (data, buffers) => { transfer = buffers; response = structuredClone(data, { transfer: buffers }); };
  try {
    await import('../src/restoration.worker.ts');
    const input = spec(), before = structuredClone(input);
    globalThis.onmessage({ data: { id: 21, spec: input } });
    assert.equal(response.id, 21); assert.equal(response.components.length, 3);
    assert.equal(transfer.length, 6); assert.equal(new Set(transfer).size, 6);
    response.components.forEach(integrity); assert.deepEqual(input, before);
    input.parameters.fixture.radius = -1;
    globalThis.onmessage({ data: { id: 22, spec: input } });
    assert.equal(response.id, 22); assert.match(response.error, /radius/i); assert.deepEqual(transfer, []);
    globalThis.onmessage({ data: { id: 1.5, spec: spec() } });
    assert.match(response.error, /ID.*integer/i);
    globalThis.onmessage({ data: { id: 23, spec: spec() } });
    assert.equal(response.id, 23); assert.equal(response.components.length, 3);
  } finally {
    if (previousPost === undefined) delete globalThis.postMessage; else globalThis.postMessage = previousPost;
    if (previousHandler === undefined) delete globalThis.onmessage; else globalThis.onmessage = previousHandler;
  }
});

test('assembly CLI writes three independently importable PLYs and a manifest without overwriting outputs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'restoration-assembly-'));
  try {
    const input = spec(), path = join(directory, 'input.json'), out = join(directory, 'assembly');
    await writeFile(path, JSON.stringify(input));
    const script = 'skills/dental-restoration-design/scripts/generate-assembly.mjs';
    const args = ['--experimental-strip-types', script, '--spec', path, '--out-dir', out];
    const run = promisify(execFile), { stdout } = await run(process.execPath, args);
    assert.match(stdout, /not-for-manufacturing/);
    assert.deepEqual((await readdir(out)).sort(), ['abutment.ply', 'crown.ply', 'fixture.ply', 'manifest.json']);
    const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.spec, input); assert.equal(manifest.units, 'file units (u)');
    assert.equal(manifest.assessments.manufacturerCompatibility, 'unassessed');
    assert.deepEqual(manifest.components.map(mesh => mesh.component), ['fixture', 'abutment', 'crown']);
    const original = generateRestoration(input);
    for (const [i, component] of manifest.components.entries()) {
      const data = await readFile(join(out, component.fileName));
      const imported = parseModel(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), component.fileName);
      assert.equal(imported.parts.length, 1); assert.equal(imported.parts[0].closed, true);
      assert.equal(imported.parts[0].triangles, original[i].triangles);
      for (const axis of [0, 1, 2]) assert.deepEqual(bounds(imported.parts[0], axis), bounds(original[i], axis));
    }
    await assert.rejects(run(process.execPath, args), /already exists|EEXIST/i);
    await assert.rejects(run(process.execPath, ['--experimental-strip-types', script, '--spec', path]), /--out-dir/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
