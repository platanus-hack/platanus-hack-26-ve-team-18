import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseModel } from '../src/import-models.ts';
import { trianglePositions } from '../skills/dental-restoration-design/scripts/dental-concept.mjs';
import { createDonorExterior, validateDonorSpec, toPLY, SCHEMA_VERSION, LIMITS } from '../skills/dental-restoration-design/scripts/donor-exterior.mjs';

// All fixtures are synthetic surfaces, arbitrary file units, with no clinical defaults.
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const crossing = [-1, 0, 0, 1, 0, 0, 1, 2, 0];
const spec = (changes = {}) => ({ schemaVersion: SCHEMA_VERSION,
  source: { id: 'synthetic-only', sha256: '0'.repeat(64), provenance: 'Arbitrary synthetic test surface; hash deliberately unverified.' },
  planes: [{ normal: [-1, 0, 0], offset: 0 }], sourceToTarget: [...identity], weldTolerance: 1e-9, componentPolicy: 'all', ...changes });
const near = (actual, expected, tolerance = 1e-12) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const sha = x => createHash('sha256').update(x).digest('hex');
const transform = (m, p) => [0, 1, 2].map(a => m[a] * p[0] + m[a + 4] * p[1] + m[a + 8] * p[2] + m[a + 12]);
const vertices = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
const tetra = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]].flatMap(face => face.flatMap(i => vertices[i]));
const normal = soup => {
  const a = [0, 1, 2].map(i => soup[i + 3] - soup[i]), b = [0, 1, 2].map(i => soup[i + 6] - soup[i]);
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
};
function independentOrientedVolume(mesh) {
  const soup = trianglePositions(mesh); let sum = 0;
  for (let i = 0; i < soup.length; i += 9) {
    const a = soup.subarray(i, i + 3), b = soup.subarray(i + 3, i + 6), c = soup.subarray(i + 6, i + 9);
    sum += (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return sum;
}

test('half-space clipping keeps the intersection polygon, area, and original face provenance', () => {
  const input = spec(), before = structuredClone(input), source = new Float64Array([...crossing, -3, 0, 0, -2, 0, 0, -3, 1, 0]);
  const sourceBefore = source.slice(), result = createDonorExterior(source, input);
  assert.deepEqual(input, before); assert.deepEqual(source, sourceBefore);
  assert.deepEqual(result, createDonorExterior(source, input));
  assert.ok(result.mesh.positions instanceof Float64Array); assert.ok(result.mesh.indices instanceof Uint32Array);
  const points = Array.from({ length: result.mesh.positions.length / 3 }, (_, i) => [...result.mesh.positions.subarray(i * 3, i * 3 + 3)]);
  assert.deepEqual(points.sort(), [[0, 0, 0], [0, 1, 0], [1, 0, 0], [1, 2, 0]].sort());
  assert.equal(result.mesh.indices.length / 3, 2);
  near(result.report.integrity.areaFileUnitsSquared, 1.5);
  assert.equal(result.report.integrity.boundaryEdges, 4);
  assert.equal(result.report.integrity.closed, false);
  assert.equal(result.report.integrity.surfaceStatus, 'open');
  assert.equal(result.report.integrity.signedVolume, null);
  assert.deepEqual(result.selection.triangles, [{ sourceFace: 0, clipped: true }, { sourceFace: 0, clipped: true }]);
  assert.equal(result.selection.selectedSourceFaces, 1); assert.equal(result.selection.clippedSourceFaces, 1);
  assert.deepEqual(result.selection.source, { ...input.source, verification: 'caller-supplied-unverified' });
  assert.equal(result.report.assessment.intaglio, 'not-generated');
  assert.equal(result.report.assessment.fixture, 'not-generated');
  assert.equal(result.report.assessment.implantConnection, 'not-generated');
  assert.equal(result.report.assessment.clinicalFit, 'unassessed');
  assert.equal(result.report.assessment.manufacturing, 'not-for-manufacturing');
  assert.equal(result.report.distanceUnit, 'file units');
  assert.equal(toPLY(result.mesh), toPLY(createDonorExterior(source, input).mesh));
});

test('coplanar faces survive, while point-only and edge-only remnants yield no surface', () => {
  const plane = [0, 0, 0, 0, 1, 0, 0, 0, 1];
  const result = createDonorExterior(plane, spec());
  assert.deepEqual([...trianglePositions(result.mesh)], plane);
  assert.deepEqual(result.selection.triangles, [{ sourceFace: 0, clipped: false }]);
  for (const soup of [[0, 0, 0, -1, 0, 0, -1, 1, 0], [0, 0, 0, 0, 1, 0, -1, 0, 0]]) {
    assert.throws(() => createDonorExterior(soup, spec()), /empty|degenerate/);
  }
  const retained = createDonorExterior(crossing, spec({ planes: [] }));
  assert.deepEqual([...trianglePositions(retained.mesh)], crossing);
  assert.equal(retained.selection.triangles[0].clipped, false);
});

test('clipping respects oblique source planes and affine covariance without recentering', () => {
  const input = spec({ planes: [{ normal: [Math.SQRT1_2, Math.SQRT1_2, 0], offset: Math.SQRT1_2 }] });
  const base = createDonorExterior(crossing, input);
  const m = [0, 2, 0, 0, -3, 1, 0, 0, 0.5, 0, 4, 0, 23, -17, 11, 1];
  const moved = createDonorExterior(crossing, { ...input, sourceToTarget: m });
  assert.deepEqual(moved.selection, base.selection);
  assert.deepEqual(moved.mesh.indices, base.mesh.indices);
  for (let i = 0; i < base.mesh.positions.length; i += 3) {
    const p = [...base.mesh.positions.subarray(i, i + 3)];
    assert.ok((p[0] + p[1]) * Math.SQRT1_2 <= Math.SQRT1_2 + 1e-12);
    transform(m, p).forEach((v, a) => near(moved.mesh.positions[i + a], v));
  }
  assert.equal(moved.report.transform.determinant, 24);
  assert.equal(moved.report.transform.kind, 'affine-donor-edit');
  assert.equal(moved.report.transform.windingReversed, false);
});

test('negative determinant reverses winding once, preserving donor normals and closed orientation', () => {
  const m = [-2, 0, 0, 0, 1, 3, 0, 0, 0, 2, 4, 0, 10, -20, 30, 1];
  const triangle = [1, 2, 3, 2, 2, 3, 1, 3, 3];
  const reflected = createDonorExterior(triangle, spec({ planes: [], sourceToTarget: m }));
  const soup = trianglePositions(reflected.mesh);
  assert.deepEqual([...soup.subarray(0, 3)], [10, -8, 42]);
  normal(soup).forEach((v, i) => near(v, [0, 0, 6][i]));
  assert.deepEqual([...soup.subarray(3, 6)], transform(m, triangle.slice(6, 9)));
  assert.equal(reflected.report.transform.determinant, -24); assert.equal(reflected.report.transform.windingReversed, true);
  const original = createDonorExterior(tetra, spec({ planes: [] })), moved = createDonorExterior(tetra, spec({ planes: [], sourceToTarget: m }));
  assert.equal(moved.report.integrity.closed, true); assert.equal(moved.report.integrity.inconsistentSharedWinding, 0);
  near(independentOrientedVolume(moved.mesh), independentOrientedVolume(original.mesh) * 24, 1e-10);
  assert.equal(moved.report.integrity.signedVolume, null, 'the API does not assess solid volume even for a topologically closed surface');
  const tiny = identity.map((v, i) => [0, 5, 10].includes(i) ? 1e-8 : v);
  assert.ok(createDonorExterior(tetra, spec({ planes: [], sourceToTarget: tiny })).report.integrity.areaFileUnitsSquared > 0);
});

test('oppositely traversed shared edges clip to a single connected patch without an artificial seam', () => {
  const a = [0.1, 0, 0], b = [0.9, 1, 0], c = [0.9, 0, 0], d = [0.1, 1, 0];
  const result = createDonorExterior([...a, ...b, ...c, ...b, ...a, ...d], spec({ planes: [{ normal: [-1, 0, 0], offset: -0.3 }] }));
  assert.equal(result.report.integrity.components, 1); assert.equal(result.report.integrity.triangles, 3);
  assert.equal(result.report.integrity.boundaryEdges, 5); assert.equal(result.report.integrity.inconsistentSharedWinding, 0);
  near(result.report.integrity.areaFileUnitsSquared, 0.6);
  const sharedCut = [];
  for (let i = 0; i < result.mesh.positions.length; i += 3) {
    const [x, y] = result.mesh.positions.subarray(i, i + 3);
    if (Math.abs(x - 0.3) < 1e-12 && Math.abs(y - 0.25) < 1e-12) sharedCut.push(i / 3);
  }
  assert.equal(sharedCut.length, 1);
});

test('component selection uses shared edges, deterministic face counts, and preserves source mapping', () => {
  const o = [0, 0, 0], x = [1, 0, 0], y = [0, 1, 0], z = [0, 0, 1], u = [-1, 0, 0], v = [0, -1, 0];
  const source = [...o, ...x, ...y, ...o, ...u, ...v, ...x, ...o, ...z];
  const all = createDonorExterior(source, spec({ planes: [] }));
  assert.equal(all.report.integrity.components, 2); assert.equal(all.report.integrity.nonManifoldVertices, 1);
  const largest = createDonorExterior(source, spec({ planes: [], componentPolicy: 'largest' }));
  assert.equal(largest.report.integrity.components, 1); assert.equal(largest.report.integrity.triangles, 2);
  assert.deepEqual(largest.selection.triangles, [{ sourceFace: 0, clipped: false }, { sourceFace: 2, clipped: false }]);
  assert.deepEqual(largest.selection.removedComponentTriangleCounts, [1]);
  const tied = createDonorExterior([...o, ...x, ...y, ...o, ...u, ...v], spec({ planes: [], componentPolicy: 'largest' }));
  assert.deepEqual(tied.selection.triangles, [{ sourceFace: 0, clipped: false }]);
  const nonManifold = createDonorExterior([...o, ...x, ...y, ...x, ...o, ...z, ...o, ...x, ...v], spec({ planes: [] }));
  assert.equal(nonManifold.report.integrity.nonManifoldEdges, 1); assert.equal(nonManifold.report.integrity.nonManifoldVertices, 2);
  assert.equal(nonManifold.report.integrity.closed, false);
});

test('tolerance welding crosses grid cells using distance and reports collapsed remnants', () => {
  const source = [0.049, 0, 0, 1, 0, 0, 0, 1, 0, 0.051, 0, 0, 0, -1, 0, 1, 0, 0];
  const result = createDonorExterior(source, spec({ planes: [], weldTolerance: 0.01 }));
  assert.equal(result.report.integrity.components, 1); assert.equal(result.report.integrity.vertices, 4);
  assert.equal(result.report.integrity.boundaryEdges, 4);
  assert.throws(() => createDonorExterior([0, 0, 0, 0.001, 0, 0, 0, 0.001, 0], spec({ planes: [], weldTolerance: 0.1 })), /empty|degenerate/);
});

test('an uncapped clipped tetrahedron remains OPEN through the actual importer', () => {
  const result = createDonorExterior(tetra, spec({ planes: [{ normal: [0, 0, -1], offset: -0.5 }] }));
  assert.equal(result.report.integrity.triangles, 3); assert.equal(result.report.integrity.boundaryEdges, 3);
  assert.equal(result.report.integrity.closed, false); assert.equal(result.report.integrity.signedVolume, null);
  const imported = parseModel(new TextEncoder().encode(toPLY(result.mesh)).buffer, 'synthetic.ply');
  assert.equal(imported.parts.length, 1); assert.equal(imported.parts[0].triangles, 3); assert.equal(imported.parts[0].closed, false);
  assert.equal(imported.warnings.length, 1);
});

test('malformed specs, nonfinite geometry, empty output, numerical ranges and budgets fail explicitly', () => {
  for (const change of [
    { schemaVersion: 'other' }, { unexpected: true }, { planes: null }, { planes: Array(LIMITS.maxPlanes + 1).fill({ normal: [1, 0, 0], offset: 0 }) },
    { planes: [{ normal: [2, 0, 0], offset: 0 }] }, { planes: [{ normal: [0, 0, 0], offset: 0 }] },
    { planes: [{ normal: [1, 0], offset: 0 }] }, { planes: [{ normal: [1, 0, 0], offset: Infinity }] },
    { planes: [{ normal: [NaN, 0, 0], offset: 0 }] }, { sourceToTarget: [1] },
    { sourceToTarget: identity.map((v, i) => i === 0 ? 0 : v) }, { sourceToTarget: identity.map((v, i) => i === 3 ? 0.1 : v) },
    { sourceToTarget: identity.map((v, i) => i === 12 ? Infinity : v) }, { weldTolerance: 0 }, { weldTolerance: -1 },
    { weldTolerance: NaN }, { componentPolicy: 'some' }, { source: { ...spec().source, sha256: 'fake' } },
  ]) assert.throws(() => validateDonorSpec(spec(change)));
  const original = spec(), detached = validateDonorSpec(original);
  detached.planes[0].offset = 5; detached.sourceToTarget[12] = 7;
  assert.equal(original.planes[0].offset, 0); assert.equal(original.sourceToTarget[12], 0);
  for (const bad of [[], [1, 2, 3], 'triangle', [...crossing.slice(0, 8), NaN], [...crossing.slice(0, 8), Infinity], Array(9).fill(0)]) {
    assert.throws(() => createDonorExterior(bad, spec()));
  }
  assert.throws(() => createDonorExterior(crossing, spec({ planes: [{ normal: [1, 0, 0], offset: -2 }] })), /empty/);
  assert.throws(() => createDonorExterior(crossing, spec({ weldTolerance: Number.MIN_VALUE })), /grid range/);
  const collapse = identity.map((v, i) => i === 12 ? 1e30 : v);
  assert.throws(() => createDonorExterior(crossing, spec({ sourceToTarget: collapse })), /degenerate/);
  assert.throws(() => createDonorExterior(new Float32Array((LIMITS.maxSourceTriangles + 1) * 9), spec()), /source.*budget/i);
  assert.throws(() => toPLY({ positions: new Float64Array(crossing), indices: new Uint32Array((LIMITS.maxOutputTriangles + 1) * 3) }), /budget/);
  assert.throws(() => toPLY({ positions: new Float64Array(crossing), indices: new Uint32Array([0, 1, 3]) }), /range/);
});

test('cancellation propagates promptly without mutating inputs or producing a partial result', () => {
  const sentinel = new Error('synthetic cancellation'), input = spec(), before = structuredClone(input);
  assert.throws(() => createDonorExterior(crossing, input, { checkCancelled: () => { throw sentinel; } }), error => error === sentinel);
  assert.throws(() => createDonorExterior(crossing, input, { checkCancelled: () => true }), /Cancelled/);
  const source = Float64Array.from(Array.from({ length: 512 }, () => crossing).flat()), copy = source.slice(); let checks = 0;
  assert.throws(() => createDonorExterior(source, input, { checkCancelled: () => { if (++checks === 5) throw sentinel; } }), error => error === sentinel);
  assert.equal(checks, 5); assert.deepEqual(source, copy); assert.deepEqual(input, before);
});

const cli = resolve('skills/dental-restoration-design/scripts/generate-donor.mjs');
function runCLI(path, out) { return spawnSync(process.execPath, ['--experimental-strip-types', cli, '--spec', path, '--out', out], { encoding: 'utf8' }); }
function obj(soup) {
  const lines = [];
  for (let i = 0; i < soup.length; i += 3) lines.push(`v ${soup.slice(i, i + 3).join(' ')}`);
  for (let i = 0; i < soup.length / 3; i += 3) lines.push(`f ${i + 1} ${i + 2} ${i + 3}`);
  return lines.join('\n') + '\n';
}
function cliSpec(path, bytes, changes = {}) { const input = spec(changes); input.source = { path, sha256: sha(bytes) }; return input; }

test('CLI verifies bytes, records reproducible provenance, round-trips open coordinates, and refuses overwrite', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dental-donor-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const source = obj(crossing), sourcePath = join(directory, 'source.obj'), specPath = join(directory, 'input.json'), out = join(directory, 'output');
  await writeFile(sourcePath, source);
  const input = cliSpec('source.obj', source); await writeFile(specPath, JSON.stringify(input));
  const run = runCLI(specPath, out); assert.equal(run.status, 0, run.stderr);
  assert.deepEqual((await readdir(out)).sort(), ['crown-exterior.ply', 'report.json', 'selection-map.json', 'spec.json']);
  const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8')), selection = JSON.parse(await readFile(join(out, 'selection-map.json'), 'utf8'));
  const normalized = JSON.parse(await readFile(join(out, 'spec.json'), 'utf8')), ply = await readFile(join(out, 'crown-exterior.ply'));
  assert.equal(report.source.sourceByteHashVerified, true); assert.equal(report.source.sourceByteSha256, sha(source));
  assert.equal(report.source.sourcePartIndex, 0); assert.equal(report.integrity.surfaceStatus, 'open');
  assert.equal(report.integrity.signedVolume, null); assert.equal(report.output.sha256, sha(ply));
  assert.equal(report.output.importerRoundTrip.triangles, 2); assert.equal(report.output.importerRoundTrip.parts, 1);
  assert.deepEqual(report.output.importerRoundTrip.partClosed, [false]);
  assert.equal(report.output.importerRoundTrip.maxAbsoluteCoordinateError, 0);
  const canonicalSoup = Buffer.alloc(crossing.length * 8); crossing.forEach((v, i) => canonicalSoup.writeDoubleLE(v, i * 8));
  assert.equal(report.source.orderedSourceTriangleSha256, sha(canonicalSoup));
  assert.deepEqual(selection.verification, Object.fromEntries(Object.entries(report.source).filter(([k]) => k !== 'warnings')));
  assert.equal(normalized.source.path, sourcePath); assert.equal(normalized.source.partIndex, 0);
  assert.deepEqual(selection.triangles, [{ sourceFace: 0, clipped: true }, { sourceFace: 0, clipped: true }]);
  const second = join(directory, 'second'); await writeFile(specPath, JSON.stringify(normalized));
  assert.equal(runCLI(specPath, second).status, 0);
  for (const name of await readdir(out)) assert.deepEqual(await readFile(join(out, name)), await readFile(join(second, name)));
  const failed = runCLI(specPath, out); assert.notEqual(failed.status, 0); assert.match(failed.stderr, /already exists|NEW/);
  assert.deepEqual(await readFile(join(out, 'crown-exterior.ply')), ply);
  input.source.sha256 = 'f'.repeat(64); await writeFile(specPath, JSON.stringify(input));
  const mismatch = runCLI(specPath, join(directory, 'mismatch')); assert.notEqual(mismatch.status, 0); assert.match(mismatch.stderr, /SHA256 mismatch/);
  assert.equal((await readdir(directory)).includes('mismatch'), false);
});

test('CLI requires explicit part selection, enforces local/spec budgets, and rejects Float32 collapse', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dental-donor-input-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const specPath = join(directory, 'input.json'), sourcePath = join(directory, 'source.obj');
  const source = obj([...crossing, ...crossing.map((v, i) => i % 3 === 0 ? v + 10 : v)]);
  await writeFile(sourcePath, source);
  const input = cliSpec('source.obj', source, { planes: [] }); await writeFile(specPath, JSON.stringify(input));
  let run = runCLI(specPath, join(directory, 'ambiguous')); assert.notEqual(run.status, 0); assert.match(run.stderr, /explicit source.partIndex/);
  input.source.partIndex = 1; await writeFile(specPath, JSON.stringify(input));
  const selected = join(directory, 'selected'); run = runCLI(specPath, selected); assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(await readFile(join(selected, 'report.json'), 'utf8'));
  assert.equal(report.source.sourcePartIndex, 1); assert.equal(report.integrity.triangles, 1); near(report.integrity.bounds.min[0], 9);
  input.source.partIndex = 2; await writeFile(specPath, JSON.stringify(input));
  run = runCLI(specPath, join(directory, 'range')); assert.notEqual(run.status, 0); assert.match(run.stderr, /out of range/);
  input.source.path = 'https://example.invalid/synthetic.obj'; await writeFile(specPath, JSON.stringify(input));
  run = runCLI(specPath, join(directory, 'remote')); assert.notEqual(run.status, 0); assert.match(run.stderr, /local file path/);
  await writeFile(specPath, ' '.repeat(1024 * 1024 + 1));
  run = runCLI(specPath, join(directory, 'large')); assert.notEqual(run.status, 0); assert.match(run.stderr, /1048576/);
  const m = [...identity]; m[12] = 2 ** 24;
  await writeFile(specPath, JSON.stringify(cliSpec('source.obj', source, { sourceToTarget: m })));
  // Explicitly choose one component so the failure is from output precision, not ambiguity.
  const collapseInput = JSON.parse(await readFile(specPath, 'utf8')); collapseInput.source.partIndex = 0;
  // Clip the unit-width end of the donor, which collapses after the large translation.
  collapseInput.planes = [{ normal: [-1, 0, 0], offset: 0 }];
  await writeFile(specPath, JSON.stringify(collapseInput));
  run = runCLI(specPath, join(directory, 'collapse')); assert.notEqual(run.status, 0); assert.match(run.stderr, /degenerate|Float32/i);
  assert.equal((await readdir(directory)).includes('collapse'), false);
});
