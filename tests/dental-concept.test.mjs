import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Matrix4, Vector3 } from 'three';
import { parseModel } from '../src/import-models.ts';
import { createNearestSurfaceQuery } from '../src/collision.ts';
import {
  createCrownConcept, validateConceptSpec, frameMatrices, transformPoint,
  trianglePositions, toPLY, inspectMesh, IDENTITY_MATRIX,
} from '../skills/dental-restoration-design/scripts/dental-concept.mjs';
import {
  inspectScanBytes, inspectLocalScans, createPreviewData, createPreviewHTML,
} from '../skills/dental-restoration-design/scripts/inspect-scans.mjs';

const scripts = resolve('skills/dental-restoration-design/scripts');
const example = JSON.parse(readFileSync(join(scripts, 'synthetic-example.json'), 'utf8'));
const spec = () => structuredClone(example);
const encode = value => new TextEncoder().encode(value).buffer;
const near = (a, b, tolerance = 1e-10) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
const tetraVertices = [[40, -30, 10], [42, -30, 10], [40, -27, 10], [40, -30, 14]];
const tetraFaces = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]];
const tetraOBJ = `${tetraVertices.map(p => `v ${p.join(' ')}`).join('\n')}\n${tetraFaces.map(f => `f ${f.map(v => v + 1).join(' ')}`).join('\n')}\n`;
const tetraPLY = `ply\nformat ascii 1.0\nelement vertex 4\nproperty float x\nproperty float y\nproperty float z\nelement face 4\nproperty list uchar int vertex_indices\nend_header\n${tetraVertices.map(p => p.join(' ')).join('\n')}\n${tetraFaces.map(f => `3 ${f.join(' ')}`).join('\n')}\n`;
const tetraSTL = `solid test\n${tetraFaces.map(f => `facet normal 0 0 0\nouter loop\n${f.map(v => `vertex ${tetraVertices[v].join(' ')}`).join('\n')}\nendloop\nendfacet`).join('\n')}\nendsolid test\n`;

test('deterministic finite closed oriented crown imports as one watertight component', () => {
  const input = spec(), before = structuredClone(input);
  const a = createCrownConcept(input), b = createCrownConcept(input);
  assert.deepEqual(input, before, 'generation must not mutate caller data');
  assert.deepEqual(a, b);
  assert.ok(a.mesh.positions instanceof Float64Array);
  assert.ok(a.mesh.indices instanceof Uint32Array);
  assert.ok(a.mesh.positions.every(Number.isFinite));
  assert.equal(a.report.integrity.edgeManifold, true);
  assert.equal(a.report.integrity.vertexManifold, true);
  assert.equal(a.report.integrity.consistentlyOriented, true);
  assert.equal(a.report.integrity.degenerateTriangles, 0);
  assert.ok(a.report.integrity.signedVolume > 0);
  const { vertexCount: v, edgeCount: e, triangleCount: f } = a.report.integrity;
  assert.equal(v - e + f, 2, 'closed genus-zero surface');
  assert.deepEqual(Array.from(a.mesh.positions.subarray(0, 3)), input.frame.origin);
  const ply = toPLY(a.mesh);
  assert.equal(ply, toPLY(b.mesh));
  const { parts, warnings } = parseModel(encode(ply), 'crown-concept.ply');
  assert.equal(parts.length, 1);
  assert.equal(parts[0].closed, true);
  assert.equal(parts[0].triangles, f);
  assert.deepEqual(parts[0].offset, [0, 0, 0]);
  assert.deepEqual(warnings, []);
  assert.deepEqual(a.report.assessments, {
    fixture: 'unassessed', abutment: 'unassessed', clinicalFit: 'unassessed',
    occlusion: 'unassessed', manufacturing: 'not-for-manufacturing',
  });
  assert.equal(a.spec.geometry.basalClosure, 'artificial-flat-cap');
  assert.equal(a.report.sourceHashVerification, 'caller-supplied-unverified');
});

test('rigid equivariance uses arbitrary anatomical axes and preserves global translations', () => {
  const input = spec();
  input.frame.origin = [0, 0, 0];
  const original = createCrownConcept(input);
  const rotation = new Matrix4().makeRotationAxis(new Vector3(1, 2, -3).normalize(), 1.17);
  rotation.setPosition(-141.25, 273.5, -88.75);
  const m = rotation.elements;
  const movedSpec = spec();
  movedSpec.frame = { origin: m.slice(12, 15), xAxis: m.slice(0, 3), yAxis: m.slice(4, 7), zAxis: m.slice(8, 11), provenance: 'Synthetic arbitrary rigid anatomical frame.' };
  movedSpec.sources[0].fileToWorld = [...m];
  const moved = createCrownConcept(movedSpec);
  assert.deepEqual(moved.mesh.indices, original.mesh.indices);
  for (let i = 0; i < original.mesh.positions.length; i += 3) {
    const expected = new Vector3().fromArray(original.mesh.positions, i).applyMatrix4(rotation);
    expected.toArray().forEach((v, a) => near(moved.mesh.positions[i + a], v));
  }
  near(moved.report.integrity.signedVolume, original.report.integrity.signedVolume, 1e-9);
  assert.deepEqual(moved.spec.sources[0].fileToWorld, m);
  const arbitraryLocal = [2.3, -1.4, 6.7];
  const world = transformPoint(moved.spec.pose.localToWorld, arbitraryLocal);
  const recovered = transformPoint(moved.spec.pose.worldToLocal, world);
  recovered.forEach((v, i) => near(v, arbitraryLocal[i]));
  assert.deepEqual(validateConceptSpec(moved.spec), moved.spec, 'recorded poses can be validated on reimport');
});

test('file units remain unknown; declared labels do not scale geometry; uniform scale is explicit', () => {
  const unknown = createCrownConcept(spec());
  assert.deepEqual(unknown.spec.units, example.units);
  assert.equal(unknown.spec.units.name, null);
  const declaredSpec = spec();
  declaredSpec.units = { status: 'declared', name: 'caller-grid-unit', provenance: 'Synthetic declared unit.' };
  assert.deepEqual(createCrownConcept(declaredSpec).mesh, unknown.mesh);
  const scaledSpec = spec(), factor = 0.03125;
  scaledSpec.frame.origin = scaledSpec.frame.origin.map(v => v * factor);
  for (const key of ['width', 'depth', 'basalWidth', 'basalDepth', 'shoulderHeight', 'domeHeight', 'grooveWidth', 'grooveDepth']) scaledSpec.geometry[key] *= factor;
  for (const c of scaledSpec.geometry.cusps) { c.position = c.position.map(v => v * factor); c.height *= factor; c.radius *= factor; }
  const scaled = createCrownConcept(scaledSpec);
  scaled.mesh.positions.forEach((v, i) => near(v, unknown.mesh.positions[i] * factor, 1e-12));
  near(scaled.report.integrity.signedVolume, unknown.report.integrity.signedVolume * factor ** 3, 1e-12);
  assert.equal(scaled.spec.units.status, 'unknown');
});

test('explicit cusp and groove controls alter the top without changing its closed topology', () => {
  const input = spec();
  input.geometry.toothClass = 'premolar';
  input.geometry.domeHeight = 2;
  input.geometry.cusps = input.geometry.cusps.slice(0, 2);
  const a = createCrownConcept(input);
  const deeper = structuredClone(input);
  deeper.geometry.grooveDepth += 0.5;
  const b = createCrownConcept(deeper);
  near(a.mesh.positions.at(-1) - b.mesh.positions.at(-1), 0.5);
  const raised = structuredClone(input);
  raised.geometry.cusps[0].height += 2;
  const c = createCrownConcept(raised);
  assert.ok(c.mesh.positions.some((v, i) => i % 3 === 2 && v > a.mesh.positions[i] + 0.1));
  assert.deepEqual(a.mesh.indices, b.mesh.indices);
  assert.equal(c.report.integrity.closed, true);
});

test('triangle soup works with the existing nearest-surface collision API in global coordinates', () => {
  const concept = createCrownConcept(spec()), positions = trianglePositions(concept.mesh);
  assert.ok(positions instanceof Float64Array);
  assert.equal(positions.length, concept.mesh.indices.length * 3);
  const nearest = createNearestSurfaceQuery(positions), result = new Vector3();
  const point = new Vector3(...spec().frame.origin).add(new Vector3(0, 0, -3));
  near(nearest.nearestPoint(point, result), 3);
  near(result.z, spec().frame.origin[2]);
});

test('minimum tessellation and asymmetric footprint retain a flat outward basal fan and lossless PLY doubles', () => {
  const input = spec();
  input.geometry.tessellation = { angularSegments: 12, axialSegments: 1, radialSegments: 2 };
  input.geometry.width = 10.125; input.geometry.depth = 15.375;
  input.frame.origin = [31.123456789, -21.876543219, 11.135791113];
  const { mesh, report } = createCrownConcept(input);
  assert.equal(report.integrity.triangleCount, 72);
  assert.equal(report.integrity.closed, true);
  const soup = trianglePositions(mesh), origin = new Vector3(...input.frame.origin);
  for (let face = 0; face < 12; face++) {
    const points = [0, 3, 6].map(k => new Vector3().fromArray(soup, face * 9 + k));
    const normal = points[1].clone().sub(points[0]).cross(points[2].clone().sub(points[0]));
    assert.ok(normal.dot(new Vector3(...input.frame.zAxis)) < 0);
    for (const p of points) near(p.clone().sub(origin).dot(new Vector3(...input.frame.zAxis)), 0);
  }
  const vertexRows = toPLY(mesh).split('end_header\n')[1].trim().split('\n').slice(0, mesh.positions.length / 3);
  assert.deepEqual(vertexRows.flatMap(row => row.split(' ').map(Number)), Array.from(mesh.positions));
});

test('malformed, missing, non-finite, left-handed, conflicting or unsafe specs fail closed', () => {
  const cases = [
    [s => { s.geometry.width = NaN; }, /finite/],
    [s => { s.geometry.depth = Infinity; }, /finite/],
    [s => { s.geometry.basalWidth = 0; }, /positive/],
    [s => { delete s.geometry.domeHeight; }, /finite/],
    [s => { s.geometry.basalDepth = s.geometry.depth + 1; }, /Basal/],
    [s => { s.geometry.grooveDepth = s.geometry.shoulderHeight; }, /grooveDepth/],
    [s => { s.geometry.grooveDepth = s.geometry.domeHeight + 0.1; }, /grooveDepth/],
    [s => { s.geometry.cusps = []; }, /cusps/],
    [s => { s.geometry.cusps[0].position = [s.geometry.width, 0]; }, /ellipse/],
    [s => { s.geometry.cusps[0].radius = -1; }, /positive/],
    [s => { s.geometry.tessellation.angularSegments = 3; }, /finite/],
    [s => { s.geometry.tessellation.radialSegments = 2.5; }, /integer/],
    [s => { s.geometry.basalClosure = 'fitted-intaglio'; }, /artificial/],
    [s => { s.frame.xAxis = [2, 0, 0]; }, /orthonormal/],
    [s => { s.frame.zAxis = [0, 0, -1]; }, /right-handed/],
    [s => { s.frame.yAxis = [1, 0, 0]; }, /orthonormal/],
    [s => { s.frame.origin = [0, 0, Infinity]; }, /finite/],
    [s => { s.units.name = 'mm'; }, /Unknown units/],
    [s => { delete s.units; }, /object/],
    [s => { s.units = { status: 'declared', name: '', provenance: 'test' }; }, /nonempty/],
    [s => { s.sources[0].id = 'made-up'; }, /sha256/],
    [s => { s.sources.push(structuredClone(s.sources[0])); }, /unique/],
    [s => { s.sources[0].provenance = ''; }, /nonempty/],
    [s => { s.sources[0].fileToWorld[0] = 2; }, /orthonormal/],
    [s => { s.site.sourceScanId = `sha256:${'1'.repeat(64)}`; }, /same arch/],
    [s => { s.site.arch = 'lower'; }, /same arch/],
    [s => { s.site.hypothetical = false; }, /hypothetical/],
    [s => { s.purpose = 'manufacturing'; }, /exterior-concept/],
    [s => { s.geometry.hiddenScript = 'runAnything()'; }, /not supported/],
    [s => { s.pose = frameMatrices(s.frame); s.pose.localToWorld[12]++; }, /does not match/],
    [s => { s.frame.origin = [1e12, 1e12, 1e12]; }, /Float32|precision/],
  ];
  for (const [mutate, pattern] of cases) { const s = spec(); mutate(s); assert.throws(() => createCrownConcept(s), pattern); }
  assert.throws(() => createCrownConcept(spec(), { checkCancelled: () => { throw new Error('Cancelled'); } }), /Cancelled/);
});

test('mesh integrity detects a pinched nonmanifold vertex despite paired closed edges', () => {
  const vertices = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [-1, 0, 0], [0, -1, 0], [0, 0, -1]];
  const faces = [...tetraFaces, ...tetraFaces.map(f => f.map(i => i === 0 ? 0 : i + 3))];
  const result = inspectMesh({ positions: Float64Array.from(vertices.flat()), indices: Uint32Array.from(faces.flat()) });
  assert.equal(result.edgeManifold, true);
  assert.equal(result.vertexManifold, false);
  assert.equal(result.closed, false);
});

test('local STL, OBJ and PLY inventory preserves original bounds and hashes actual source bytes', () => {
  for (const [extension, content, role] of [['stl', tetraSTL, 'upper'], ['obj', tetraOBJ, 'lower'], ['ply', tetraPLY, 'bite']]) {
    const bytes = Buffer.from(content), a = inspectScanBytes(bytes, `synthetic.${extension}`, role);
    const b = inspectScanBytes(bytes, `synthetic.${extension}`, role);
    assert.deepEqual(a.inventory, b.inventory);
    assert.equal(a.inventory.id, `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    assert.deepEqual(a.inventory.bounds, { min: [40, -30, 10], max: [42, -27, 14], size: [2, 3, 4] });
    assert.equal(a.inventory.triangleCount, 4);
    assert.equal(a.inventory.closed, true);
    assert.equal(a.inventory.units.status, 'unknown');
    assert.deepEqual(a.inventory.fileToWorld, [...IDENTITY_MATRIX]);
    assert.equal(a.inventory.coordinatePreserving, true);
    assert.deepEqual(Array.from(a.parts[0].positions.subarray(0, 3)), tetraVertices[0]);
    const preview = createPreviewData(a.parts.map(p => ({ ...p, role })), 2);
    assert.equal(preview.displayedTriangleCount, 2);
    assert.equal(preview.originalTriangleCount, 4);
    assert.equal(preview.sampled, true);
    assert.deepEqual(preview.meshes[0].positions.slice(0, 3), tetraVertices[0]);
  }
  const open = inspectScanBytes(encode('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'), 'open.obj', 'upper');
  assert.equal(open.inventory.closed, false);
  assert.ok(open.inventory.warnings.length > 0);
  assert.throws(() => inspectScanBytes(encode(tetraOBJ), 'x.obj', 'guessed'), /role/);
  const data = createPreviewData(open.parts);
  data.meshes[0].name = '</script><script>alert(1)</script>';
  const html = createPreviewHTML(data);
  assert.ok(!html.includes('</script><script>alert(1)'));
  assert.ok(html.includes('\\u003c/script\\u003e'));
});

test('CLIs write importable artifacts and safe previews outside the repo, refuse overwrite, and expose help', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dental-concept-test-'));
  try {
    const source = join(root, 'synthetic-upper.ply'), out = join(root, 'generated'), inventoryOut = join(root, 'inventory');
    await writeFile(source, tetraPLY);
    const local = await inspectLocalScans([{ path: source, role: 'upper' }]);
    const input = spec();
    input.sources[0].id = local.inventory.scans[0].id;
    input.site.sourceScanId = input.sources[0].id;
    const specFile = join(root, 'input.json');
    await writeFile(specFile, JSON.stringify(input));
    const run = (name, args) => execFileSync(process.execPath, ['--experimental-strip-types', join(scripts, name), ...args], { encoding: 'utf8', cwd: tmpdir(), stdio: 'pipe' });
    const generated = JSON.parse(run('generate-concept.mjs', ['--spec', specFile, '--out', out]));
    assert.equal(generated.clinicalFit, 'unassessed');
    assert.deepEqual((await readdir(out)).sort(), ['crown-concept.ply', 'preview.html', 'preview.json', 'report.json', 'spec.json']);
    const outputPLY = await readFile(join(out, 'crown-concept.ply'));
    const { parts } = parseModel(outputPLY.buffer.slice(outputPLY.byteOffset, outputPLY.byteOffset + outputPLY.byteLength), 'crown-concept.ply');
    assert.equal(parts[0].closed, true);
    const savedSpec = JSON.parse(await readFile(join(out, 'spec.json'), 'utf8'));
    assert.deepEqual(savedSpec.pose.localToWorld.slice(12, 15), input.frame.origin);
    const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
    assert.equal(report.output.id, `sha256:${createHash('sha256').update(outputPLY).digest('hex')}`);
    assert.equal(report.assessments.fixture, 'unassessed');
    const secondOut = join(root, 'generated-again');
    run('generate-concept.mjs', ['--spec', specFile, '--out', secondOut]);
    for (const file of ['crown-concept.ply', 'spec.json', 'report.json', 'preview.json', 'preview.html']) {
      assert.deepEqual(await readFile(join(out, file)), await readFile(join(secondOut, file)), `${file} deterministic across separate CLI processes`);
    }
    const inventory = JSON.parse(run('inspect-scans.mjs', ['--upper', source, '--out', inventoryOut]));
    assert.equal(inventory.scans, 1);
    assert.deepEqual((await readdir(inventoryOut)).sort(), ['inventory.json', 'preview.html', 'preview.json']);
    assert.throws(() => run('generate-concept.mjs', ['--spec', specFile, '--out', out]), /EEXIST/);
    for (const command of ['generate-concept.mjs', 'inspect-scans.mjs']) {
      assert.match(run(command, ['--help']), /file units/);
    }
    assert.equal(await readFile(source, 'utf8'), tetraPLY, 'source is untouched');
  } finally { await rm(root, { recursive: true, force: true }); }
});
