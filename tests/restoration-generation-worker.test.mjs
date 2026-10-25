import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { specForAIGeneration, withAIGenerationDesign, withPatientDonor } from '../src/workflow-geometry.ts';
import { generateRestoration } from '../src/restoration-geometry.ts';
import { buildCrownMesh, templateShape, placeCrown } from '../src/crown-anatomy.ts';
import { restorationRelationshipsSchema } from '../src/restoration-relationships-schema.ts';

// Execute the actual worker module in an isolated worker global. Geometry,
// fitting, intersections and relationship measurements are not mocked.
const workerUrl = new URL('../src/restoration-fit.worker.ts', import.meta.url);
const source = stripTypeScriptTypes(await readFile(workerUrl, 'utf8'))
  .replace(/from\s*(['"])(\.\/[^'"]+)\1/g, (_, quote, relative) => `from ${JSON.stringify(new URL(relative.endsWith('.ts') ? relative : `${relative}.ts`, workerUrl).href)}`)
  .replaceAll('globalThis.', 'workerScope.');
let moduleNumber = 0;
async function workerHarness(t) {
  const messages = [], waiting = new Map();
  let sequence = 0;
  const scope = { postMessage(message) {
    const copy = structuredClone(message); messages.push(copy);
    if (['result', 'error', 'cancelled'].includes(copy.type)) waiting.get(copy.id)?.(copy);
  } };
  const previous = globalThis.__generationWorkerTest;
  globalThis.__generationWorkerTest = scope;
  try {
    const script = `const workerScope = globalThis.__generationWorkerTest;\n${source}`;
    await import(`data:text/javascript;base64,${Buffer.from(script).toString('base64')}#${++moduleNumber}`);
  } finally {
    if (previous === undefined) delete globalThis.__generationWorkerTest; else globalThis.__generationWorkerTest = previous;
  }
  t.after(() => { scope.onmessage({ data: { type: 'cancel', id: sequence } }); });
  return { messages,
    run(request, onMessage) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { waiting.delete(id); reject(new Error('Worker did not settle.')); }, 15_000);
        waiting.set(id, message => { clearTimeout(timeout); waiting.delete(id); resolve(message); });
        const post = scope.postMessage;
        scope.postMessage = message => { post(message); onMessage?.(message, () => scope.onmessage({ data: { type: 'cancel', id } })); };
        scope.onmessage({ data: structuredClone({ ...request, id }) });
      });
    },
  };
}
const measure = value => ({ value, unit: 'file units (u)', method: 'Synthetic local surface measurement.', provenance: 'measured' });
const baseSite = () => ({ id: 'local-space', fdi: 36, partId: 'lower', arch: 'lower', status: 'proposed-missing',
  anchor: { partId: 'lower', face: 0, point: [0, 0, 0] }, frame: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], up: [0, 0, 1] },
  frameBasis: 'Synthetic source frame.', mesialSign: 1, buccalSign: -1,
  slot: { index: 0, count: 1, s: [-2, 2] }, patchFaces: Uint32Array.of(0),
  adjacent: { mesial: null, distal: null }, contralateral: null, opposing: null,
  space: { proximalGap: measure(3), mesiodistal: measure(3), buccolingual: measure(3), crownHeight: measure(3), vertical: measure(3) } });
const designValues = () => ({ anatomy: 'molar', anatomySource: 'procedural-template',
  parameters: { fixture: { radius: .9, length: 4.3, depth: .4, taper: .21 }, abutment: { radius: .8, height: .7, emergenceRadius: 1.1, angleX: 5, angleY: -3 }, crown: { width: 3.4, depth: 2.8, height: 2.7, cuspHeight: .27, rotation: 19 } },
  contour: { cervicalScale: .81, occlusalScale: 1.19 } });
const trianglePart = (id, role, z) => ({ id, role, positions: Float32Array.of(-10, -10, z, 10, -10, z, 0, 10, z), normals: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1), triangles: 1, offset: [0, 0, 0] });
function requestFixture() {
  const site = baseSite(), generationDesign = designValues();
  return { type: 'prepare-fit', site, generationDesign, spec: specForAIGeneration(site, [], generationDesign, 'Preserve the exact authored candidate.'),
    parts: [trianglePart('lower', 'lower', 0), trianglePart('upper', 'upper', 2.5)], scans: [], teeth: { labels: {}, teeth: {} },
    options: { maxCandidates: 80, verifyBaselineIntersections: false, samplesPerSurface: 24, maxDurationMs: 10_000 } };
}

test('AI worker forces one exact candidate with full intersection and relationship measurements even if caller requests optimization', async t => {
  const worker = await workerHarness(t), input = requestFixture(), before = structuredClone(input);
  const message = await worker.run(input);
  assert.equal(message.type, 'result', message.error);
  const { result } = message;
  assert.deepEqual(result.spec.parameters, input.generationDesign.parameters); assert.deepEqual(result.spec.contour, input.generationDesign.contour);
  assert.deepEqual(result.spec.frame, input.spec.frame); assert.deepEqual(result.spec.crownShape, input.spec.crownShape);
  assert.equal(result.history.length, 1); assert.equal(result.report.candidates, 1); assert.equal(result.report.candidateAttempts, 1);
  assert.equal(result.report.quality.stopReason, 'measurement-only'); assert.equal(result.report.anatomyCandidates.length, 1);
  const antagonist = result.report.after.surfaces.find(surface => surface.role === 'antagonist');
  assert.ok(antagonist, 'The crossing opposing surface must be audited.');
  assert.equal(antagonist.intersectionComplete, true); assert.equal(antagonist.intersectionTestedTriangles, 1);
  assert.ok(antagonist.intersectingTriangles > 0, 'The measurement must retain the conflict instead of cutting or shrinking the crown.');
  assert.equal(result.report.relationships.version, 'restoration-relationships/v1');
  assert.ok(result.report.abutmentGingiva, 'Each fitting trial must measure pilar support before goal selection.');
  assert.equal(result.report.goal.after.rows.find(row => row.id === 'abutment-gingiva')?.status, result.report.abutmentGingiva.status);
  assert.ok(result.report.goal.contract.rows.some(row => row.id === 'abutment-gingiva' && row.priority === 'required'));
  assert.ok(result.report.relationships.relationships.some(row => row.status === 'measured'));
  restorationRelationshipsSchema.parse(result.report.relationships);
  const exact = generateRestoration(input.spec);
  result.components.forEach((mesh, i) => assert.deepEqual(mesh.positions, exact[i].positions));
  assert.deepEqual(input, before);
});

test('AI worker rejects incomplete or unrecognized designs, unauthorized values and unavailable donor requests without fallback', async t => {
  const worker = await workerHarness(t);
  for (const change of [
    input => { input.generationDesign.parameters.fixture.radius = Infinity; },
    input => { delete input.generationDesign.parameters.abutment.height; },
    input => { input.generationDesign.parameters.crown.unrecognized = 1; },
    input => { delete input.generationDesign.contour; },
    input => { input.spec.parameters.crown.width *= .8; },
    input => { input.generationDesign.anatomySource = 'patient-donor'; },
  ]) {
    const input = requestFixture(); change(input);
    const previousResults = worker.messages.filter(message => message.type === 'result').length;
    const message = await worker.run(input);
    assert.equal(message.type, 'error'); assert.ok(message.error.length);
    assert.equal(worker.messages.filter(message => message.type === 'result').length, previousResults);
  }
});

function donorFixture() {
  const site = baseSite(), generationDesign = designValues();
  generationDesign.anatomySource = 'patient-donor';
  Object.assign(generationDesign.parameters.abutment, { height: 2, angleX: 0, angleY: 0 });
  Object.assign(generationDesign.parameters.crown, { width: 5.2, depth: 4.6, height: 3.5, cuspHeight: .5 });
  const origin = [10, 20, 30], axes = { mesial: [0, 1, 0], buccal: [-1, 0, 0], occlusal: [0, 0, 1] };
  const placed = placeCrown(buildCrownMesh(templateShape('lower', 6), [5.2, 4.6, 4]), { origin, ...axes });
  const faces = Uint32Array.from({ length: placed.positions.length / 9 }, (_, i) => i);
  const tooth = { id: 2, fdi: 46, faces, centroid: [10, 20, 32], axis: axes.occlusal, sCenter: 2, cervicalLevel: 30, crownScore: .95, kind: 'crown', flags: [] };
  site.contralateral = { toothId: 2, fdi: 46, partId: 'donor', centroid: tooth.centroid, confidence: .95 };
  const scan = { partId: 'donor', scan: { candidates: [] }, analysis: { frame: { up: [0, 0, 1] }, teeth: [tooth],
    curve: { s: [0, 2, 4], tangent: [[0, 1, 0], [0, 1, 0], [0, 1, 0]], lingual: [[1, 0, 0], [1, 0, 0], [1, 0, 0]] },
    anterior: { apexS: 10 }, lingualConfidence: .95 } };
  const part = { id: 'donor', role: 'lower', positions: placed.positions, normals: placed.normals, triangles: placed.positions.length / 9, offset: [0, 0, 0] };
  const scans = [scan], parts = [trianglePart('lower', 'lower', 0), part];
  return { type: 'prepare-fit', site, scans, parts, generationDesign, spec: specForAIGeneration(site, scans, generationDesign, 'Use an eligible donor without changing any authored construction values.'),
    teeth: { labels: {}, teeth: {} }, options: { maxCandidates: 32, maxDurationMs: 10_000, samplesPerSurface: 24 } };
}

test('AI patient donor resolves actual local anatomy while preserving cusp relief, size, depth and contour exactly', async t => {
  const worker = await workerHarness(t), input = donorFixture(), before = structuredClone(input);
  const automatic = withPatientDonor(input.spec, input.site, input.scans, input.parts);
  assert.equal(automatic.crownShape?.source.kind, 'patient-donor');
  assert.notDeepEqual(automatic.parameters, input.spec.parameters, 'This fixture must exercise automatic donor resizing and relief initialization.');
  const prepared = withAIGenerationDesign(input.spec, input.site, input.scans, input.parts, input.generationDesign);
  assert.deepEqual(prepared.parameters, input.generationDesign.parameters); assert.deepEqual(prepared.contour, input.generationDesign.contour);
  assert.deepEqual(prepared.crownShape.occlusal, automatic.crownShape.occlusal);
  assert.deepEqual(prepared.crownShape.source.selection, automatic.crownShape.source.selection);
  assert.match(prepared.crownShape.source.provenance, /automatic donor sizing was not applied/);
  const message = await worker.run(input);
  assert.equal(message.type, 'result', message.error);
  assert.equal(message.result.spec.crownShape.source.kind, 'patient-donor');
  assert.equal(message.result.spec.crownShape.source.donorFdi, 46);
  assert.deepEqual(message.result.spec.parameters, input.generationDesign.parameters);
  assert.deepEqual(message.result.spec.contour, input.generationDesign.contour);
  assert.deepEqual(message.result.spec.anatomicalSigns, input.spec.anatomicalSigns);
  assert.equal(message.result.history.length, 1);
  const exact = generateRestoration(prepared);
  message.result.components.forEach((mesh, i) => assert.deepEqual(mesh.positions, exact[i].positions));
  assert.deepEqual(input, before);
});

test('an explicit procedural source stays procedural even when eligible patient donor evidence is available', async t => {
  const worker = await workerHarness(t), input = donorFixture();
  input.generationDesign.anatomySource = 'procedural-template';
  input.spec = specForAIGeneration(input.site, input.scans, input.generationDesign, 'Select procedural anatomy deliberately.');
  const message = await worker.run(input);
  assert.equal(message.type, 'result', message.error);
  assert.equal(message.result.spec.crownShape.source.kind, 'procedural-template');
  assert.deepEqual(message.result.spec.crownShape, input.spec.crownShape);
  assert.deepEqual(message.result.spec.parameters, input.generationDesign.parameters);
});

test('cancelling an AI generation worker still prevents publishing an exact candidate', async t => {
  const worker = await workerHarness(t);
  const message = await worker.run(requestFixture(), (message, cancel) => { if (message.type === 'progress' && message.phase === 'fitting') cancel(); });
  assert.equal(message.type, 'cancelled');
  assert.equal(worker.messages.some(message => message.type === 'result'), false);
});
