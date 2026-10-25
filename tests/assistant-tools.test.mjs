import test from 'node:test';
import assert from 'node:assert/strict';
import { Matrix4 } from 'three';
import { asSchema } from 'ai';
import { assistantSnapshotSchema, assistantToolCatalog, buildAssistantSnapshot } from '../src/assistant-context.ts';
import { createAssistantTools } from '../src/assistant-tools.ts';
import { partMatrix } from '../src/pose.ts';

const privateIds = ['SECRET_UPPER_PART', 'SECRET_LOWER_PART', 'SECRET_BITE_PART'];
function part(index = 0, patch = {}) {
  return {
    id: privateIds[index], name: `Patient Jane scan ${index}`, fileName: `Jane-private-${index}.stl`,
    positions: new Float32Array([10, 0, 0, 12, 0, 0, 10, 2, 0]), normals: new Float32Array(9),
    closed: false, visible: true, offset: [0, 0, 0], triangles: 1, vertices: 3, dimensions: [2, 2, 0],
    role: index === 0 ? 'upper' : index === 1 ? 'lower' : 'bite', ...patch,
  };
}
const record = (patch = {}) => ({ status: 'unreviewed', restoration: 'none', note: '', ...patch });
const anchor = (partId, point) => ({ partId, point, face: 0 });
const analysisPart = id => ({ id, distances: new Float32Array([-0.2, Infinity, 0.1]), intersecting: new Uint8Array([1]), penetratingVertices: 1, nearbyVertices: 1, intersectingTriangles: 1, maxDepth: 0.2 });
function inputs(patch = {}) {
  return {
    parts: [], selected: null, probe: null, report: null, tolerance: 0.5, analysisState: 'unavailable',
    teeth: {}, counts: {}, fitSummary: [], fitRadius: null, ...patch,
  };
}
function collisionInputs(pairPatch = {}) {
  const parts = [part(), part(1)];
  return inputs({
    parts, selected: parts[0].id, analysisState: 'ready',
    report: {
      durationMs: 3,
      parts: parts.map(item => analysisPart(item.id)),
      pairs: [{ a: parts[0].id, b: parts[1].id, intersectingTriangles: 2, penetratingVertices: 1, nearbyVertices: 3, minDistance: 0, maxDepth: 0.2, ...pairPatch }],
    },
  });
}
function transformedInputs() {
  const upper = part(0, { pose: new Matrix4().makeTranslation(5, 3, 0).toArray(), rotation: [0, 0, 90], offset: [1, 2, 0] });
  const lower = part(1, { offset: [8, 8, 4] });
  return inputs({
    parts: [upper, lower], selected: upper.id,
    teeth: {
      11: record({ status: 'present', site: anchor(upper.id, [10, 0, 0]), note: 'Sensitive clinical note' }),
      12: record({ site: anchor(upper.id, [12, 0, 0]) }),
      36: record({ status: 'missing', restoration: 'implant', site: anchor(lower.id, [10, 0, 0]) }),
    },
    counts: { 11: 1 },
  });
}
const tooth = (snapshot, fdi) => snapshot.teeth.find(item => item.fdi === fdi);
const close = (actual, expected) => actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-9, `${value} vs ${expected[i]}`));
function noBuffers(value) {
  assert.equal(ArrayBuffer.isView(value), false);
  assert.equal(value instanceof ArrayBuffer, false);
  if (value && typeof value === 'object') for (const child of Object.values(value)) noBuffers(child);
}

test('empty workspace yields all 32 FDI records without inferring absent teeth', async () => {
  const snapshot = buildAssistantSnapshot(inputs());
  assert.equal(snapshot.parts.length, 0);
  assert.equal(snapshot.teeth.length, 32);
  assert.equal(new Set(snapshot.teeth.map(item => item.fdi)).size, 32);
  assert.ok(snapshot.teeth.every(item => item.status === 'unreviewed' && item.assignedTriangles === 0 && item.site === null));
  const chart = await createAssistantTools(snapshot).getToothChart.execute({});
  assert.equal(chart.teeth.length, 32);
  assert.match(chart.limitations.join(' '), /Unreviewed.*do not mean absent/);
});

test('anchors use saved pose, rotation around the posed centre, and manual offset', () => {
  const source = transformedInputs();
  const original = source.parts[0].positions.slice();
  const snapshot = buildAssistantSnapshot(source);
  close(tooth(snapshot, 11).site.workspacePoint, [18, 5, 0]);
  close(tooth(snapshot, 12).site.workspacePoint, [18, 7, 0]);
  close(tooth(snapshot, 36).site.workspacePoint, [18, 8, 4]);
  assert.equal(tooth(snapshot, 11).site.partId, 'scan-1');
  assert.deepEqual(snapshot.parts[0].dimensions, [2, 2, 0]);
  assert.equal(snapshot.parts[0].dimensionsBasis, 'original file-axis bounds');
  assert.deepEqual(snapshot.parts[0].offset, [1, 2, 0]);
  assert.deepEqual(snapshot.parts[0].rotationDegrees, [0, 0, 90]);
  assert.equal(snapshot.parts[0].hasSavedBitePose, true);
  assert.equal(snapshot.parts[0].hasManualMovement, true);
  assert.deepEqual(source.parts[0].positions, original);
});

test('snapshot never reads geometry without sites and caches a matrix for repeated sites', () => {
  const unanchored = part(0, { rotation: [0, 0, 90] });
  Object.defineProperty(unanchored, 'positions', { get() { throw new Error('Unexpected mesh scan'); } });
  Object.defineProperty(unanchored, 'normals', { get() { throw new Error('Unexpected normals'); } });
  assert.doesNotThrow(() => buildAssistantSnapshot(inputs({ parts: [unanchored] })));
  const anchored = part(0, { rotation: [0, 0, 90] });
  const positions = anchored.positions;
  let reads = 0;
  Object.defineProperty(anchored, 'positions', { get() { reads++; return positions; } });
  partMatrix(anchored);
  const once = reads;
  reads = 0;
  buildAssistantSnapshot(inputs({ parts: [anchored], teeth: {
    11: record({ site: anchor(anchored.id, [10, 0, 0]) }),
    12: record({ site: anchor(anchored.id, [12, 0, 0]) }),
  } }));
  assert.ok(once > 0);
  assert.equal(reads, once);
});

test('all snapshot references are anonymized; notes default off and raw buffers never escape', () => {
  const source = collisionInputs();
  source.parts.push(part(2));
  source.teeth = { 36: record({ note: 'SECRET CLINICAL NOTE', site: anchor(source.parts[0].id, [10, 0, 0]) }) };
  source.probe = { id: source.parts[0].id, face: 0, vertex: 1, position: [11, 0, 0], distance: -0.2, intersecting: true };
  source.fitSummary = [{ id: source.parts[0].id, matrix: new Matrix4().toArray(), beforeRms: 0.5, afterRms: 0.1, samples: 40, references: [{ id: source.parts[2].id, beforeRms: 0.5, afterRms: 0.1, samples: 40, beforeCoverage: 0.5, afterCoverage: 0.9 }] }];
  source.fitRadius = 1;
  const snapshot = buildAssistantSnapshot(source);
  const serialized = JSON.stringify(snapshot);
  for (const item of source.parts) for (const identifier of [item.id, item.name, item.fileName]) assert.equal(serialized.includes(identifier), false);
  for (const key of ['positions', 'normals', 'distances', 'matrix', 'SECRET CLINICAL NOTE']) assert.equal(serialized.includes(key), false);
  assert.equal(Object.hasOwn(tooth(snapshot, 36), 'note'), false);
  assert.equal(snapshot.selectedPartId, 'scan-1');
  assert.deepEqual(snapshot.collision.pairs.map(pair => [pair.a, pair.b]), [['scan-1', 'scan-2']]);
  assert.equal(snapshot.probe.partId, 'scan-1');
  assert.equal(snapshot.biteFit.arches[0].references[0].id, 'scan-3');
  noBuffers(snapshot);
});

test('explicitly included notes are bounded and redact source identities', () => {
  const source = transformedInputs();
  source.includeNotes = true;
  source.teeth[11].note = `Review ${source.parts[0].id} ${source.parts[0].name} ${source.parts[0].fileName}: ${'x'.repeat(2200)}`;
  const snapshot = buildAssistantSnapshot(source);
  const note = tooth(snapshot, 11).note;
  assert.equal(note.length, 2000);
  assert.match(note, /\[redacted\]/);
  for (const identifier of [source.parts[0].id, source.parts[0].name, source.parts[0].fileName]) assert.equal(note.includes(identifier), false);
  assert.equal(assistantSnapshotSchema.safeParse({ ...snapshot, notesIncluded: false }).success, false);
});

test('NaN, infinity, invalid counts and invalid points become nullable data, never JSON nonfinite values', () => {
  const source = collisionInputs({ minDistance: Infinity, maxDepth: NaN, penetratingVertices: Infinity });
  source.tolerance = Infinity;
  source.parts[0].dimensions = [Infinity, -1, NaN];
  source.parts[0].offset = [NaN, 0, 0];
  source.parts[0].triangles = 1.5;
  source.teeth = { 11: record({ site: anchor(source.parts[0].id, [Infinity, 0, 0]) }) };
  source.counts = { 11: -1 };
  source.probe = { id: source.parts[0].id, face: 0, vertex: 0, position: [NaN, 0, 0], distance: -Infinity, intersecting: false };
  const snapshot = buildAssistantSnapshot(source);
  assert.deepEqual(snapshot.parts[0].dimensions, [null, null, null]);
  assert.deepEqual(snapshot.parts[0].offset, [null, 0, 0]);
  assert.equal(snapshot.parts[0].triangles, null);
  assert.equal(snapshot.tolerance, null);
  assert.equal(snapshot.collision.pairs[0].minDistance, null);
  assert.equal(snapshot.collision.pairs[0].penetratingVertices, null);
  assert.equal(snapshot.probe.workspacePoint, null);
  assert.equal(snapshot.probe.signedSampleDistance, null);
  assert.equal(tooth(snapshot, 11).assignedTriangles, null);
  assert.equal(tooth(snapshot, 11).site, null);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
});

test('running, paused and unavailable analyses discard stale reports and probe comparisons', async () => {
  for (const state of ['running', 'paused', 'unavailable']) {
    const source = collisionInputs();
    source.analysisState = state;
    source.probe = { id: source.parts[0].id, face: 0, vertex: 0, position: [10, 0, 0], distance: -0.2, intersecting: true };
    const snapshot = buildAssistantSnapshot(source);
    assert.equal(snapshot.collision, null);
    assert.equal(snapshot.probe.signedSampleDistance, null);
    assert.equal(snapshot.probe.intersecting, null);
    const result = await createAssistantTools(snapshot).getCollisionReport.execute({});
    assert.equal(result.status, 'unavailable');
    assert.equal(result.analysisState, state);
    assert.equal(result.crossingOrInsidePairCount, null);
    assert.match(result.interpretation, /must not be described as clear/);
  }
});

test('ready without a valid report or a matching visible comparison scope is unavailable', () => {
  assert.equal(buildAssistantSnapshot(inputs({ analysisState: 'ready' })).analysisState, 'unavailable');
  for (const mutate of [
    source => { source.parts[1].visible = false; },
    source => { source.parts[1].role = 'bite'; },
    source => { source.report.parts.pop(); },
    source => { source.report.pairs[0].a = 'unloaded-private-id'; },
  ]) {
    const source = collisionInputs(); mutate(source);
    const snapshot = buildAssistantSnapshot(source);
    assert.equal(snapshot.analysisState, 'unavailable');
    assert.equal(snapshot.collision, null);
  }
});

test('schema bounds arrays and rejects extra geometry, raw identifiers and inconsistent FDI records', () => {
  const snapshot = buildAssistantSnapshot(inputs({ parts: [part()] }));
  const invalid = [
    { ...snapshot, parts: Array(65).fill(snapshot.parts[0]) },
    { ...snapshot, teeth: snapshot.teeth.slice(1) },
    { ...snapshot, teeth: snapshot.teeth.map(() => snapshot.teeth[0]) },
    { ...snapshot, parts: [{ ...snapshot.parts[0], positions: new Float32Array(9) }] },
    { ...snapshot, parts: [{ ...snapshot.parts[0], id: privateIds[0] }] },
    { ...snapshot, selectedPartId: 'scan-2' },
    { ...snapshot, notesIncluded: true, teeth: snapshot.teeth.map(item => ({ ...item, note: 'n'.repeat(2001) })) },
    { ...snapshot, biteFit: { ...snapshot.biteFit, arches: Array(65).fill({}) } },
    { ...snapshot, probe: { partId: 'scan-1', triangleIndex: 0, vertexIndex: 0, workspacePoint: [0, 0, 0], signedSampleDistance: 0, intersecting: false } },
  ];
  for (const value of invalid) assert.equal(assistantSnapshotSchema.safeParse(value).success, false);
  const ready = buildAssistantSnapshot(collisionInputs());
  assert.equal(assistantSnapshotSchema.safeParse({ ...ready, collision: { ...ready.collision, pairs: Array(2017).fill(ready.collision.pairs[0]) } }).success, false);
  assert.equal(assistantSnapshotSchema.safeParse({ ...ready, analysisState: 'running' }).success, false);
  assert.throws(() => buildAssistantSnapshot(inputs({ parts: Array.from({ length: 65 }, (_, i) => part(0, { id: String(i) })) })), /64/);
});

test('case SDK tools match their catalog entries, remain read-only and expose serializable Zod input schemas', async () => {
  const snapshot = buildAssistantSnapshot(transformedInputs());
  const tools = createAssistantTools(snapshot);
  const caseCatalog = assistantToolCatalog.filter(entry => !['getDentalDesignGuidance', 'getTomographyInventory', 'inspectTomographyView', 'requestTomographyView'].includes(entry.name));
  assert.equal(caseCatalog.length, 8);
  assert.deepEqual(Object.keys(tools), caseCatalog.map(entry => entry.name));
  const args = { inspectImplantSite: { fdi: 36 }, measureSiteDistance: { fromFdi: 11, toFdi: 36 } };
  const before = JSON.stringify(snapshot);
  for (const [name, item] of Object.entries(tools)) {
    assert.equal(item.metadata.annotations.readOnlyHint, true);
    assert.ok(asSchema(item.inputSchema).jsonSchema);
    const result = await item.execute(args[name] ?? {});
    assert.equal(result.units, 'file units');
    assert.match(result.provenance, /local mesh metadata and user-entered/);
    assert.match(result.limitations.join(' '), /CT.*bone width.*density.*nerve.*sinus.*implant size.*safety clearance/);
    assert.match(result.limitations.join(' '), /no patient diagnosis.*no automatic movement/);
    noBuffers(result);
  }
  assert.equal(JSON.stringify(snapshot), before);
});

test('FDI tool schemas reject nonpermanent numbers, strings, fractional values, missing fields and extra input', () => {
  const tools = createAssistantTools(buildAssistantSnapshot(inputs()));
  for (const bad of [0, 10, 19, 20, 29, 39, 49, 51, 11.5, '36', NaN, Infinity]) {
    for (const name of ['getToothChart', 'inspectImplantSite']) {
      assert.equal(tools[name].inputSchema.safeParse({ fdi: bad }).success, false);
      assert.throws(() => tools[name].execute({ fdi: bad }));
    }
    assert.equal(tools.measureSiteDistance.inputSchema.safeParse({ fromFdi: bad, toFdi: 36 }).success, false);
    assert.equal(tools.measureSiteDistance.inputSchema.safeParse({ fromFdi: 36, toFdi: bad }).success, false);
  }
  assert.equal(tools.inspectImplantSite.inputSchema.safeParse({}).success, false);
  assert.equal(tools.measureSiteDistance.inputSchema.safeParse({ fromFdi: 11 }).success, false);
  assert.equal(tools.getModelInventory.inputSchema.safeParse({ move: true }).success, false);
  assert.equal(tools.getToothChart.inputSchema.safeParse({ fdi: 36, note: 'inject' }).success, false);
  for (const valid of [11, 18, 21, 28, 31, 38, 41, 48]) assert.equal(tools.inspectImplantSite.inputSchema.safeParse({ fdi: valid }).success, true);
});

test('site tools report missing markers without implying teeth are absent', async () => {
  const source = inputs({ teeth: { 16: record({ status: 'present', restoration: 'crown' }), 36: record({ status: 'not-scanned', restoration: 'implant' }), 37: record({ status: 'missing' }) } });
  const tools = createAssistantTools(buildAssistantSnapshot(source));
  const site = await tools.inspectImplantSite.execute({ fdi: 11 });
  assert.equal(site.status, 'unavailable');
  assert.equal(site.record.status, 'unreviewed');
  const measurement = await tools.measureSiteDistance.execute({ fromFdi: 11, toFdi: 36 });
  assert.equal(measurement.status, 'unavailable');
  assert.equal(measurement.distance, null);
  assert.deepEqual(measurement.missingMarkers, [11, 36]);
  const checklist = await tools.getPlanningChecklist.execute({});
  assert.deepEqual(checklist.userMarkedMissingFdi, [37]);
  assert.deepEqual(checklist.notScannedFdi, [36]);
  assert.deepEqual(checklist.implantSitesWithoutMarkers, [36]);
  assert.deepEqual(checklist.scanRoleCounts, { upper: 0, lower: 0, bite: 0, model: 0 });
  assert.equal(checklist.biteRefinementInputsAvailable, false);
});

test('distance measures actual transformed workspace markers, with file-unit and clearance limits', async () => {
  const tools = createAssistantTools(buildAssistantSnapshot(transformedInputs()));
  const result = await tools.measureSiteDistance.execute({ fromFdi: 11, toFdi: 36 });
  assert.equal(result.status, 'available');
  assert.ok(Math.abs(result.distance - 5) < 1e-9);
  assert.equal(result.from.partId, 'scan-1');
  assert.equal(result.to.partId, 'scan-2');
  assert.match(result.limitations.join(' '), /not intertooth width.*surface gap/);
  const zero = await tools.measureSiteDistance.execute({ fromFdi: 11, toFdi: 11 });
  assert.equal(zero.distance, 0);
  const reverse = await tools.measureSiteDistance.execute({ fromFdi: 36, toFdi: 11 });
  assert.equal(reverse.distance, result.distance);
});

test('unloaded anchors and nonfinite transformed points are unavailable', () => {
  const source = inputs({ parts: [part()], teeth: {
    11: record({ site: anchor('unloaded-private-part', [10, 0, 0]) }),
    12: record({ site: anchor(privateIds[0], [10, 0, 0]) }),
  } });
  source.parts[0].offset = [Infinity, 0, 0];
  const snapshot = buildAssistantSnapshot(source);
  assert.equal(tooth(snapshot, 11).site, null);
  assert.equal(tooth(snapshot, 12).site, null);
});

test('nearby vertex samples alone do not count as triangle crossings or inside samples', async () => {
  const touching = await createAssistantTools(buildAssistantSnapshot(collisionInputs({ intersectingTriangles: 2, crossingTriangles: 0, contactTriangles: 2, penetratingVertices: 0 }))).getCollisionReport.execute({});
  assert.equal(touching.crossingOrInsidePairCount, 0);
  assert.equal(touching.report.pairs[0].contactTriangles, 2);
  const near = await createAssistantTools(buildAssistantSnapshot(collisionInputs({ intersectingTriangles: 0, penetratingVertices: 0, nearbyVertices: 5, minDistance: 0.15, maxDepth: 0 }))).getCollisionReport.execute({});
  assert.equal(near.status, 'available');
  assert.equal(near.crossingOrInsidePairCount, 0);
  assert.equal(near.report.pairs[0].nearbyVertices, 5);
  assert.match(near.interpretation, /Nearby samples alone do not establish intersection/);
  assert.match(near.limitations.join(' '), /not exact contact area, overlap volume/);
  const inside = await createAssistantTools(buildAssistantSnapshot(collisionInputs({ intersectingTriangles: 0, penetratingVertices: 2 }))).getCollisionReport.execute({});
  assert.equal(inside.crossingOrInsidePairCount, 1);
  const empty = collisionInputs(); empty.report.pairs = [];
  const none = await createAssistantTools(buildAssistantSnapshot(empty)).getCollisionReport.execute({});
  assert.equal(none.status, 'available');
  assert.equal(none.crossingOrInsidePairCount, 0);
  assert.match(none.interpretation, /does not establish exact separation or clinical clearance/);
  const unknown = await createAssistantTools(buildAssistantSnapshot(collisionInputs({ intersectingTriangles: NaN, penetratingVertices: NaN }))).getCollisionReport.execute({});
  assert.equal(unknown.crossingOrInsidePairCount, null);
});

test('probe keeps its workspace coordinates without reapplying pose and masks reference-scan comparisons', async () => {
  const source = collisionInputs();
  source.parts[0].offset = [99, 0, 0];
  source.probe = { id: source.parts[0].id, face: 0, vertex: 2, position: [18, 5, 0], distance: -0.2, intersecting: true };
  const result = await createAssistantTools(buildAssistantSnapshot(source)).inspectSurfaceProbe.execute({});
  assert.deepEqual(result.probe.workspacePoint, [18, 5, 0]);
  assert.equal(result.probe.signedSampleDistance, -0.2);
  assert.match(result.limitations.join(' '), /negative signed sample indicates inside a closed/);
  source.parts.push(part(2));
  source.probe.id = source.parts[2].id;
  const reference = buildAssistantSnapshot(source);
  assert.equal(reference.probe.signedSampleDistance, null);
  assert.equal(reference.probe.intersecting, null);
  source.probe.id = 'unloaded-private-id';
  assert.equal(buildAssistantSnapshot(source).probe, null);
});

test('fit output retains compact saved-fit references, masks nonfinite metrics, and warns about manual movement', async () => {
  const source = transformedInputs(); source.parts.push(part(2));
  source.fitRadius = 2;
  source.fitSummary = [{ id: source.parts[0].id, matrix: new Matrix4().toArray(), beforeRms: Infinity, afterRms: 0.1, samples: 40, references: [
    { id: source.parts[2].id, beforeRms: 0.5, afterRms: 0.1, samples: 40, beforeCoverage: 0.5, afterCoverage: 0.9 },
  ] }];
  const result = await createAssistantTools(buildAssistantSnapshot(source)).getBiteFitReport.execute({});
  assert.equal(result.status, 'available');
  assert.equal(result.matchRadius, 2);
  assert.equal(result.arches[0].beforeRms, null);
  assert.equal(result.arches[0].references[0].id, 'scan-3');
  assert.equal(Object.hasOwn(result.arches[0], 'matrix'), false);
  assert.equal(result.manualMovementExists, true);
  assert.match(result.measurementPose, /saved bite fit, not current manual pose/);
  assert.match(result.interpretation, /do not measure the current manually moved pose/);
  assert.match(result.limitations.join(' '), /not contact area or clinical accuracy/);
});
