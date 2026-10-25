#!/usr/bin/env node
/** Coding-agent local CLI only. SDK executors should pass geometry handles to the pure core. */
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseModel, MAX_IMPORT_BYTES } from '../../../src/import-models.ts';
import { createDonorExterior, validateDonorSpec, toPLY } from './donor-exterior.mjs';
import { trianglePositions } from './dental-concept.mjs';

const MAX_SPEC_BYTES = 1024 * 1024;
const HELP = `Generate a scan-donor EXTERIOR from explicit source-coordinate half-spaces and affine edit.
Usage from repository root:
  node --experimental-strip-types skills/dental-restoration-design/scripts/generate-donor.mjs \\
    --spec /private/donor-spec.json --out /tmp/new-donor-exterior
--spec: local JSON <=1 MiB. --out: NEW local directory; never overwrite.
Source: {path, sha256, partIndex?}; path resolves relative to the spec file, sha256 is the
expected source BYTE hash (64 lowercase hex digits), partIndex is 0-based importer order
and required for files importing as multiple parts. No network access or external materials.
Other required fields: schemaVersion='dental-donor-exterior/v1', planes=[{normal,offset}],
sourceToTarget=16 column-major numbers, weldTolerance>0, componentPolicy='largest'|'all'.
Normals must already be unit vectors; retain dot(normal,point)<=offset in SOURCE coordinates.
Writes crown-exterior.ply, normalized spec.json, selection-map.json, report.json.
OPEN cuts are allowed. No intaglio/fixture/connection, fit, or manufacturing assessment.
See scripts/README.md. File paths are for this coding-agent CLI, not an SDK tool contract.`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const arrayBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
function localPath(value, name) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || /^[a-z][a-z\d+.-]*:/i.test(value)) throw new Error(`${name} must be a local file path, not a URL.`);
  return value;
}
async function readBoundedFile(path, limit, name) {
  const info = await stat(path);
  if (!info.isFile() || info.size > limit) throw new Error(`${name} must be a local file of at most ${limit} bytes.`);
  const bytes = await readFile(path);
  if (bytes.length > limit) throw new Error(`${name} exceeds its byte budget.`);
  return bytes;
}

// Canonical ordered importer xyz hash: each coordinate encoded as Float64 little-endian,
// promoting importer Float32 values. Does not depend on platform byte order or UUIDs.
function orderedTriangleHash(positions) {
  const digest = createHash('sha256'), chunk = Buffer.alloc(8192);
  for (let start = 0; start < positions.length; start += chunk.length / 8) {
    const count = Math.min(chunk.length / 8, positions.length - start);
    for (let i = 0; i < count; i++) chunk.writeDoubleLE(positions[start + i], i * 8);
    digest.update(chunk.subarray(0, count * 8));
  }
  return digest.digest('hex');
}

function roundTrip(ply, mesh) {
  const imported = parseModel(arrayBuffer(Buffer.from(ply)), 'crown-exterior.ply');
  const expected = trianglePositions(mesh), actualTriangles = imported.parts.reduce((n, p) => n + p.triangles, 0);
  if (actualTriangles !== mesh.indices.length / 3) throw new Error('Importer round-trip triangle count changed.');
  // Importer may regroup disconnected components. Compare a multiset of oriented
  // Float32 triangles, allowing cyclic corner rotation, preserving reflection winding.
  const key = (p, i) => {
    const corners = [0, 3, 6].map(k => [0, 1, 2].map(a => Math.fround(p[i + k + a])).join(','));
    return [0, 1, 2].map(k => [corners[k], corners[(k + 1) % 3], corners[(k + 2) % 3]].join(';')).sort()[0];
  };
  const counts = new Map();
  for (let i = 0; i < expected.length; i += 9) { const k = key(expected, i); counts.set(k, (counts.get(k) || 0) + 1); }
  for (const part of imported.parts) for (let i = 0; i < part.positions.length; i += 9) {
    const k = key(part.positions, i), count = counts.get(k);
    if (!count) throw new Error('Importer round-trip coordinates or winding changed beyond Float32 precision.');
    if (count === 1) counts.delete(k); else counts.set(k, count - 1);
  }
  if (counts.size) throw new Error('Importer round-trip omitted triangles.');
  let maxAbsoluteCoordinateError = 0;
  for (const x of mesh.positions) maxAbsoluteCoordinateError = Math.max(maxAbsoluteCoordinateError, Math.abs(x - Math.fround(x)));
  return { triangles: actualTriangles, parts: imported.parts.length, partClosed: imported.parts.map(p => p.closed),
    coordinates: 'oriented triangle multiset equals Float32-rounded canonical mesh', maxAbsoluteCoordinateError,
    warnings: imported.warnings, note: 'Importer uses Float32 and exact vertex connectivity; core uses Float64 and source-space tolerance welding. No fit assessment.' };
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === '--help') { console.log(HELP); return; }
  let specPath, out;
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}. Use --help.`);
    if (flag === '--spec' && !specPath) specPath = localPath(value, '--spec');
    else if (flag === '--out' && !out) out = localPath(value, '--out');
    else throw new Error(`Unsupported or repeated option ${flag}. Use --help.`);
  }
  if (!specPath || !out) throw new Error('Provide --spec and --out. Use --help.');
  const directory = resolve(out);
  // Early check is advisory; atomic mkdir below is the no-overwrite guard, including races.
  try { await stat(directory); throw new Error('Output directory already exists; --out must be NEW.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  specPath = resolve(specPath);
  const input = JSON.parse((await readBoundedFile(specPath, MAX_SPEC_BYTES, 'Spec')).toString('utf8'));
  const source = input?.source;
  if (!source || Object.getPrototypeOf(source) !== Object.prototype || Object.keys(source).some(k => !['path', 'sha256', 'partIndex'].includes(k))) throw new Error('source must contain only path, sha256, and optional partIndex.');
  const path = resolve(dirname(specPath), localPath(source.path, 'source.path'));
  if (typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256)) throw new Error('source.sha256 needs 64 lowercase hex digits.');
  if (source.partIndex !== undefined && (!Number.isSafeInteger(source.partIndex) || source.partIndex < 0)) throw new Error('source.partIndex must be a nonnegative integer.');
  const coreInput = { ...input, source: { id: `sha256:${source.sha256}`, sha256: source.sha256, provenance: 'Local CLI source byte hash verified before generation.' } };
  validateDonorSpec(coreInput);
  const bytes = await readBoundedFile(path, MAX_IMPORT_BYTES, 'Source');
  const actualHash = hash(bytes);
  if (actualHash !== source.sha256) throw new Error('Source SHA256 mismatch; no output written.');
  const imported = parseModel(arrayBuffer(bytes), basename(path));
  if (imported.parts.length > 1 && source.partIndex === undefined) throw new Error('Multiple source parts: provide explicit source.partIndex in importer order.');
  const partIndex = source.partIndex ?? 0, part = imported.parts[partIndex];
  if (!part) throw new Error('source.partIndex is out of range.');
  const { mesh, spec, selection, report } = createDonorExterior(part.positions, coreInput);
  const triangleHash = orderedTriangleHash(part.positions), ply = toPLY(mesh);
  const importerRoundTrip = roundTrip(ply, mesh);
  const verification = { sourceByteSha256: actualHash, sourceByteHashVerified: true, sourcePartIndex: partIndex, sourcePartCount: imported.parts.length,
    orderedSourceTriangleSha256: triangleHash, orderedSourceTriangleEncoding: 'selected importer part, ordered xyz triangle soup, Float64 little-endian (promoted from Float32)',
    sourceFaceIndexConvention: '0-based triangle order within selected importer part, not original file face IDs' };
  const normalizedSpec = { ...spec, source: { path, sha256: actualHash, partIndex } };
  selection.verification = verification;
  report.source = { ...verification, warnings: imported.warnings };
  report.output = { fileName: 'crown-exterior.ply', sha256: hash(ply), format: 'ASCII PLY double xyz', importerRoundTrip };
  try { await mkdir(directory); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Output directory already exists; --out must be NEW.'); throw error; }
  for (const [name, value] of Object.entries({ 'crown-exterior.ply': ply, 'spec.json': JSON.stringify(normalizedSpec, null, 2) + '\n',
    'selection-map.json': JSON.stringify(selection, null, 2) + '\n', 'report.json': JSON.stringify(report, null, 2) + '\n' })) {
    await writeFile(resolve(directory, name), value, { flag: 'wx' });
  }
  console.log(JSON.stringify({ directory, triangles: mesh.indices.length / 3, surfaceStatus: report.integrity.surfaceStatus, distanceUnit: 'file units', clinicalFit: 'unassessed' }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
