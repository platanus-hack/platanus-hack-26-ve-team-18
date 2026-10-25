#!/usr/bin/env node
// Local composition of the application's real APIs. No provider or HTTP client.
import { createHash } from 'node:crypto';
import { File } from 'node:buffer';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import { importModels, MAX_IMPORT_BYTES, MAX_WORKSPACE_PARTS } from '../src/import-models.ts';
import { prepareCase } from '../src/case-preparation.ts';
import { localPlanningResult } from '../src/draft-workflow.ts';
import { specForHypothesis, withPatientDonor, withQualityContext, fittingSurfaces } from '../src/workflow-geometry.ts';
import { fitRestoration } from '../src/restoration-fitting.ts';
import { emptyToothCase, geometrySignature } from '../src/tooth-session.ts';
import { appearanceSignature, createPlanningSession, readPlanningSession } from '../src/planning-session.ts';
import { planningExportBundle } from '../src/planning-export.ts';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const DISCLAIMER = 'Caller-supplied unreviewed engineering hypothesis; not patient laterality, missing status, treatment intent or clinical truth.';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const arrayHash = array => sha(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
const json = (path, value) => writeFile(path, `${JSON.stringify(value, (_key, item) => ArrayBuffer.isView(item) ? Array.from(item) : item, 2)}\n`, { flag: 'wx' });
const within = (parent, child) => { const path = relative(parent, child); return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)); };

export const HELP = `Evaluate an explicit local upper/lower/bite case using application APIs (Node 24).
Usage:
  node --experimental-strip-types scripts/evaluate-planning-case.mjs \\
    --upper /private/upper.ply --lower /private/lower.ply \\
    --bite /private/bite-1.ply --bite /private/bite-2.ply --out /private/new-evaluation
Required: one --upper, one --lower, at least one --bite, and a NEW --out directory.
Optional repeatable local support: --texture image.png|image.jpg, --material materials.mtl.
Optional --side image-left|image-right is an ENGINEERING SIDE SCENARIO, never patient truth.
Optional --fit-site INDEX --hypothesis-fdi CODE must be supplied together. INDEX is zero-based
in evaluation.json sites; CODE is caller-supplied permanent FDI, unreviewed and arch-compatible.
No fit is attempted by default. Unlocalized/not-scanned sites cannot be forced.
Bounds: --max-candidates 1..80 (14), --fit-ms 100..60000 (12000),
--timeout-ms 1000..600000 (180000). Distances always remain file units; scale is unknown.
Writes evaluation.json, stage-journal.json, session.json, planning.zip, manifest.json and
separate exported component PLYs when an eligible explicit fit succeeds. No scans copied,
uploads, provider calls, automatic registration, clinical accuracy or effort-saving claims.
Outputs under this project's public directory are refused. Ctrl-C terminates the worker.`;

export function parseArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const inputs = [], values = new Map();
  const numeric = { '--fit-site': [0, Number.MAX_SAFE_INTEGER], '--hypothesis-fdi': [11, 48], '--max-candidates': [1, 80], '--fit-ms': [100, 60000], '--timeout-ms': [1000, 600000] };
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}. Use --help.`);
    if (['--upper', '--lower', '--bite', '--texture', '--material'].includes(flag)) {
      const role = flag.slice(2);
      if (['upper', 'lower'].includes(role) && inputs.some(input => input.role === role)) throw new Error(`Supply exactly one ${flag}.`);
      if (['upper', 'lower', 'bite'].includes(role) && !/\.(ply|stl|obj)$/i.test(value)) throw new Error(`${flag} requires a local PLY, STL or OBJ file.`);
      if (role === 'texture' && !/\.(png|jpe?g)$/i.test(value)) throw new Error('--texture requires a local PNG or JPEG file.');
      if (role === 'material' && !/\.mtl$/i.test(value)) throw new Error('--material requires a local MTL file.');
      if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) throw new Error('Inputs must be local file paths.');
      inputs.push({ role, path: resolve(value) });
    } else if (['--out', '--side', ...Object.keys(numeric)].includes(flag)) {
      if (values.has(flag)) throw new Error(`Repeated option ${flag}.`);
      if (numeric[flag]) {
        const number = Number(value), [min, max] = numeric[flag];
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${flag} must be an integer in [${min}, ${max}].`);
        values.set(flag, number);
      } else values.set(flag, value);
    } else throw new Error(`Unsupported option ${flag}. Use --help.`);
  }
  if (!values.has('--out') || !['upper', 'lower', 'bite'].every(role => inputs.some(input => input.role === role))) throw new Error('Provide --upper, --lower, at least one --bite, and --out. Use --help.');
  if (inputs.length > MAX_WORKSPACE_PARTS) throw new Error('Select at most 64 input/support files.');
  if (new Set(inputs.map(input => basename(input.path))).size !== inputs.length) throw new Error('Input basenames must be unique for unambiguous local role/texture matching.');
  if (values.has('--side') && !['image-left', 'image-right'].includes(values.get('--side'))) throw new Error('--side must be image-left or image-right.');
  if (values.has('--fit-site') !== values.has('--hypothesis-fdi')) throw new Error('--fit-site and --hypothesis-fdi must be supplied together.');
  const fdi = values.get('--hypothesis-fdi');
  if (fdi !== undefined && !/^[1-4][1-8]$/.test(String(fdi))) throw new Error('--hypothesis-fdi must be a permanent FDI code.');
  return { inputs, out: resolve(values.get('--out')), side: values.get('--side') ?? null, fitSite: values.get('--fit-site') ?? null, hypothesisFdi: fdi ?? null,
    maxCandidates: values.get('--max-candidates') ?? 14, fitMs: values.get('--fit-ms') ?? 12000, timeoutMs: values.get('--timeout-ms') ?? 180000 };
}

/** Only this disposable site is adapted to the existing generator contract. The chart and prepared sites stay unchanged. */
export function engineeringFitSite(prepared, index, fdi) {
  const original = prepared.sites[index];
  if (!original) throw new Error('--fit-site is outside the prepared site list.');
  if (!/^[1-4][1-8]$/.test(String(fdi)) || original.arch !== (fdi < 30 ? 'upper' : 'lower')) throw new Error('Caller FDI must match the localized source arch.');
  if (!['proposed-missing', 'identity-unresolved'].includes(original.status) || original.kind === 'chart' || !original.anchor || !original.frame || !original.patchFaces.length) throw new Error('Selected site is not a localized scanned-space hypothesis; no forced generation.');
  const site = structuredClone(original);
  site.fdi = fdi;
  site.status = 'proposed-missing'; // Existing generator enum; deliberately not a saved clinical chart status.
  site.evidence.conflicting.push(DISCLAIMER);
  site.frameBasis = `${DISCLAIMER} ${site.frameBasis}`;
  if (!specForHypothesis(site, prepared.scans)) throw new Error('Selected site lacks positive localized design dimensions; no forced generation.');
  return site;
}

function bounds(positions) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index++) { const axis = index % 3; min[axis] = Math.min(min[axis], positions[index]); max[axis] = Math.max(max[axis], positions[index]); }
  return { min, max };
}
const siteSummary = (site, index) => ({ index, ...site, patchFaces: { count: site.patchFaces.length, sha256: arrayHash(site.patchFaces) } });

// Extract only the stored entries created by planningExportBundle, keeping exactly its PLY bytes/paths.
async function writeBundle(directory, session) {
  const bytes = Buffer.from(await planningExportBundle(session).arrayBuffer());
  await writeFile(resolve(directory, 'planning.zip'), bytes, { flag: 'wx' });
  const artifacts = [{ path: 'planning.zip', byteLength: bytes.length, sha256: sha(bytes) }];
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    if (bytes.readUInt16LE(offset + 8) !== 0) throw new Error('Expected stored application ZIP entries.');
    const size = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26), extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength, path = resolve(directory, name);
    if (!within(directory, path) || path === directory || start + size > bytes.length) throw new Error('Invalid application export entry.');
    await mkdir(dirname(path), { recursive: true });
    const content = bytes.subarray(start, start + size);
    await writeFile(path, content, { flag: 'wx' });
    artifacts.push({ path: name, byteLength: size, sha256: sha(content) });
    offset = start + size;
  }
  if (bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error('Expected application ZIP directory.');
  return artifacts;
}

async function evaluate(options) {
  const timings = [], started = performance.now();
  async function stage(name, operation) {
    const at = performance.now(); parentPort.postMessage({ type: 'stage', stage: name, status: 'started', at: new Date().toISOString() });
    try {
      const value = await operation(); const durationMs = performance.now() - at;
      timings.push({ stage: name, durationMs }); parentPort.postMessage({ type: 'stage', stage: name, status: 'completed', durationMs, at: new Date().toISOString() }); return value;
    } catch (error) { parentPort.postMessage({ type: 'stage', stage: name, status: 'failed', durationMs: performance.now() - at, error: error.message, at: new Date().toISOString() }); throw error; }
  }
  const inputs = [], files = [];
  await stage('Read explicit local inputs', async () => {
    let total = 0;
    for (const input of options.inputs) {
      const info = await stat(input.path);
      if (!info.isFile() || info.size <= 0 || (total += info.size) > MAX_IMPORT_BYTES) throw new Error('Inputs must be nonempty local files totaling at most 100 MiB.');
      if (input.role === 'texture' && info.size > 16 * 1024 * 1024) throw new Error('A texture exceeds 16 MiB.');
    }
    for (const input of options.inputs) {
      const bytes = await readFile(input.path);
      inputs.push({ role: input.role, fileName: basename(input.path), byteLength: bytes.length, originalByteSha256: sha(bytes) });
      files.push(new File([bytes], basename(input.path)));
    }
  });
  const imported = await stage('Import models', () => importModels(files));
  const parts = imported.parts.map((part, index) => {
    const source = inputs.find(input => input.fileName === part.fileName && ['upper', 'lower', 'bite'].includes(input.role));
    if (!source || source.originalByteSha256 !== part.sourceByteSha256) throw new Error('Importer byte provenance differs from selected local source.');
    return { ...part, id: `source-part-${index + 1}`, role: source.role, roleSource: 'user-reviewed', pose: [...IDENTITY], offset: [0, 0, 0] };
  });
  const signatures = () => Promise.all(parts.map(async part => ({ id: part.id, geometrySha256: await geometrySignature(part.positions), appearanceSha256: await appearanceSignature(part) })));
  const before = await signatures(), teeth = emptyToothCase(), assemblies = [];
  const revision = sha(JSON.stringify({ inputs, before, sideScenario: options.side, physicalScale: null }));
  const prepared = await stage('Prepare unknown/reviewable case', () => prepareCase({ id: 1, revision,
    sources: parts.filter(part => part.role !== 'bite').map(part => ({ id: part.id, arch: part.role, roleConfirmed: true, positions: part.positions, tissueScores: part.tissueScores, pose: [...IDENTITY] })),
    patientRight: Object.fromEntries(parts.map(part => [part.id, options.side])), chart: teeth.teeth, poseVerified: false }));
  prepared.durationMs = timings.at(-1).durationMs;
  // A side experiment cannot establish reviewed identities, even if its score is high.
  for (const identity of prepared.identities) { identity.needsReview = true; identity.reason = `${options.side ? DISCLAIMER : 'Laterality remains unknown; identity needs review.'} ${identity.reason}`; }
  const result = await stage('Local planning result', () => localPlanningResult(prepared, parts));
  let fit = null, fitContext = null, fitError = null;
  if (options.fitSite !== null) {
    try {
      await stage('Fit explicit engineering hypothesis', async () => {
        const site = engineeringFitSite(prepared, options.fitSite, options.hypothesisFdi);
        const base = specForHypothesis(site, prepared.scans);
        base.source = `${DISCLAIMER} ${base.source}`;
        const spec = withQualityContext(withPatientDonor(base, site, prepared.scans, parts), site, prepared.scans);
        const surfaces = fittingSurfaces(spec, parts, teeth, site, prepared.scans);
        if (!surfaces.length) throw new Error('No fitting surfaces are available; no unaudited concept exported.');
        const fitOptions = { maxCandidates: options.maxCandidates, maxDurationMs: options.fitMs, samplesPerSurface: 120, maxTargetTriangles: 1_000_000, maxIntersectionTriangles: 4096 };
        fitContext = { disclaimer: DISCLAIMER, originalSite: siteSummary(prepared.sites[options.fitSite], options.fitSite), engineeringSite: siteSummary(site, options.fitSite), initialSpec: spec,
          donorUsed: spec.crownShape?.source.kind === 'patient-donor', options: fitOptions,
          surfaces: surfaces.map(({ positions, ...surface }) => ({ ...surface, triangles: positions.length / 9, geometrySha256: arrayHash(positions) })) };
        fit = await fitRestoration({ spec, surfaces, options: fitOptions });
        const id = 'engineering-fit';
        assemblies.push({ id, spec: fit.spec, createdAt: new Date().toISOString(), warnings: [DISCLAIMER, 'Planning concept—clinical fit unvalidated.'], fit: fit.report, candidateHistory: fit.history,
          parts: fit.components.map(mesh => ({ ...mesh, id: `${id}-${mesh.component}`, name: mesh.component, fileName: `${mesh.component}.ply`, visible: true, offset: [0, 0, 0], role: 'model', restoration: { assemblyId: id, component: mesh.component, parentPartId: spec.parentPartId } })) });
      });
    } catch (error) { fitError = error.message; }
  }
  const after = await stage('Verify unchanged sources', async () => {
    const after = await signatures();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Source geometry or appearance changed during evaluation.');
    for (let index = 0; index < inputs.length; index++) {
      const info = await stat(options.inputs[index].path);
      if (info.size !== inputs[index].byteLength || sha(await readFile(options.inputs[index].path)) !== inputs[index].originalByteSha256) throw new Error('An original input file changed during evaluation.');
    }
    return after;
  });
  const session = await stage('Create and validate resumable session', async () => {
    const session = await createPlanningSession({ parts, teeth, assemblies, draft: { prepared, result, evidence: { revision, sources: prepared.scans, views: [] } },
      mmPerUnit: null, unitsProvenance: 'Unknown; no independent calibration supplied. Geometry remains in file units.', patientRight: null, model: 'local-geometry', manualMode: true, timings,
      progress: { stage: 'Engineering evaluation; clinical review pending', completed: 0, total: 1 } });
    await readPlanningSession(session, parts);
    await json(resolve(options.out, 'session.json'), session);
    return session;
  });
  const artifacts = await stage('Export application bundle and separate components', () => writeBundle(options.out, session));
  const codePaths = ['scripts/evaluate-planning-case.mjs', 'src/import-models.ts', 'src/case-preparation.ts', 'src/draft-workflow.ts', 'src/workflow-geometry.ts', 'src/restoration-fitting.ts', 'src/restoration-fit-intersections.ts', 'src/restoration-geometry.ts', 'src/planning-session.ts', 'src/planning-export.ts'];
  const implementation = await Promise.all(codePaths.map(async path => ({ path, sha256: sha(await readFile(resolve(ROOT, path))) })));
  const report = { format: 'platanus-local-evaluation', version: 1, createdAt: new Date().toISOString(), revision, status: fitError ? 'fit-needs-input-or-failed' : fit ? 'engineering-concept-exported' : 'prepared-only',
    disclosure: { execution: 'local Node worker', providerCalls: 0, uploads: 0, rawScanCopies: 0 },
    inputs, units: { label: 'file units (u)', mmPerUnit: null, provenance: 'Unknown; no independent calibration supplied.' },
    coordinates: { unchanged: true, fileToWorkspace: IDENTITY, registration: 'none', precision: 'Importer Float32 triangle order; no recentering, scaling or automatic registration.' },
    sideScenario: { value: options.side, provenance: options.side ? DISCLAIMER : 'Unknown laterality by default.', patientTruth: null, savedPatientRight: null },
    callerHypothesis: { siteIndex: options.fitSite, fdi: options.hypothesisFdi, provenance: options.fitSite === null ? null : DISCLAIMER, reviewedChartChanged: false },
    sources: session.sources.map((source, index) => ({ ...source, originalPartId: parts[index].id, bounds: bounds(parts[index].positions), closed: parts[index].closed, before: before[index], after: after[index] })),
    preparation: { durationMs: prepared.durationMs, warnings: prepared.warnings, scans: prepared.scans.map(source => ({ partId: source.partId, method: source.scan.method, candidates: source.scan.candidates.length, warnings: source.warnings })), identities: prepared.identities },
    sites: prepared.sites.map(siteSummary), planningResult: result, fitContext, fitError, fit: fit?.report ?? null, candidateHistory: fit?.history ?? [],
    unresolvedIntersections: fit?.report.after.surfaces.filter(surface => surface.intersectingTriangles > 0 || !surface.intersectionComplete) ?? null,
    effort: { measuredWallDurationMs: performance.now() - started, timings, manualBaselineMs: null, humanActiveEffortMs: null, timeSavedMs: null },
    groundTruth: { clinicalAccuracy: null, segmentationAccuracy: null, laterality: null, missingStatus: null, exactFdi: null, clinicalFit: null, manufacturingSuitability: null },
    session: { path: 'session.json', sourceChecksPassed: true, sha256: sha(await readFile(resolve(options.out, 'session.json'))) }, artifacts, implementation,
    limits: ['No images were rendered; multi-view browser review remains required.', 'Roles are caller assignments. Side, identity and selected FDI remain unreviewed engineering hypotheses; the saved clinical chart remains unreviewed.',
      'Node may retain local texture bytes/UVs without decoding color evidence. Warnings and appearance hashes describe the actual imported evidence; browser decoding may differ.',
      'Fitting uses full-resolution named local crops, not complete arches. Bite references are excluded. Fixture/bone clearance and unseen surfaces are unassessed.',
      'Every supplied fit surface is retained in before/after and candidate history. Unresolved hits and incomplete zero tests are not clearance. An absent category remains unmeasured.',
      'Unsigned samples have no clearance error bound; touching/intersection counts are neither exact contact area nor overlap volume.',
      'No clinical bite registration, jaw motion, bone/tissue assessment, intaglio, material thickness, compatible implant connection or manufacturing release.',
      ...(fit?.report.limits ?? [])] };
  await json(resolve(options.out, 'evaluation.json'), report);
  return { directory: options.out, status: report.status, sources: parts.length, sites: prepared.sites.length, components: assemblies.flatMap(assembly => assembly.parts).length,
    objectiveBefore: fit?.report.before.score ?? null, objectiveAfter: fit?.report.after.score ?? null, unresolvedSurfaces: report.unresolvedIntersections?.length ?? null, durationMs: report.effort.measuredWallDurationMs, fitError };
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  if (options.help) { console.log(HELP); return; }
  const publicDirectory = resolve(ROOT, 'public');
  if (within(publicDirectory, options.out)) throw new Error('Evaluation outputs must remain outside public.');
  await mkdir(dirname(options.out), { recursive: true });
  const parent = await realpath(dirname(options.out));
  if (within(await realpath(publicDirectory), parent)) throw new Error('Evaluation outputs must remain outside public, including symlinks.');
  options.out = resolve(parent, basename(options.out));
  await mkdir(options.out); // Never overwrite earlier evidence or untracked work.
  const events = [], worker = new Worker(new URL(import.meta.url), { workerData: options, resourceLimits: { maxOldGenerationSizeMb: 1536 } });
  let timer, interrupted;
  try {
    const summary = await new Promise((accept, reject) => {
      const stop = message => { void worker.terminate(); reject(new Error(message)); };
      timer = setTimeout(() => stop('Evaluation worker deadline exceeded; partial artifacts are uncommitted evidence. Use a new output directory.'), options.timeoutMs);
      interrupted = () => stop('Evaluation cancelled; worker terminated. Partial artifacts remain for inspection.');
      process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
      worker.on('message', message => {
        if (message.type === 'stage') events.push(message);
        else if (message.type === 'result') accept(message.summary);
        else if (message.type === 'error') reject(new Error(message.error));
      });
      worker.on('error', reject);
      worker.on('exit', code => { if (code !== 0) reject(new Error(`Evaluation worker exited with code ${code}.`)); });
    });
    await json(resolve(options.out, 'stage-journal.json'), { status: 'finished', timeoutMs: options.timeoutMs, events });
    console.log(JSON.stringify(summary));
    if (summary.fitError) process.exitCode = 1;
    return summary;
  } catch (error) {
    await json(resolve(options.out, 'stage-journal.json'), { status: 'failed-or-cancelled', timeoutMs: options.timeoutMs, events, error: error.message });
    throw error;
  } finally {
    clearTimeout(timer); process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted); await worker.terminate();
  }
}

if (!isMainThread && workerData) {
  evaluate(workerData).then(summary => parentPort.postMessage({ type: 'result', summary })).catch(error => parentPort.postMessage({ type: 'error', error: error.message }));
} else if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
