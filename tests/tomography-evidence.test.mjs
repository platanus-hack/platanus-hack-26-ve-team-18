import test from 'node:test';
import assert from 'node:assert/strict';
import { asSchema } from 'ai';
import { buildTomographySummary, captureRequestedTomographyView, MAX_TOMOGRAPHY_IMAGE_BYTES, prepareTomographyEvidence, stripCanvasJpegMetadata, tomographyCaptureSchema, tomographyContinuationSchema, tomographyEvidenceSchema, tomographySummarySchema, tomographyViewSpecSchema } from '../src/tomography-evidence.ts';
import { createTomographyTools } from '../src/assistant-tools.ts';
import { capture3d, evidence, identity, jpegUrls, sliceCapture, spec, summary } from './tomography-fixtures.mjs';

const source = (overrides = {}) => ({ revision: 'local-revision', summary: summary(), initialViews: [spec()], capture: async requested => sliceCapture(requested), ...overrides });

test('fresh browser JPEG color profiles are stripped while strict transport still rejects metadata', () => {
  const original = Buffer.from(jpegUrls[0].split(',')[1], 'base64');
  for (const marker of [0xe1,0xe2,0xfe]) {
    const payload = Buffer.from('ICC_PROFILE\0BROWSER_ENCODER_METADATA');
    const header = Buffer.alloc(4); header[0]=255; header[1]=marker; header.writeUInt16BE(payload.length+2,2);
    const raw = Buffer.concat([original.subarray(0,2),header,payload,original.subarray(2)]);
    const encoded = `data:image/jpeg;base64,${raw.toString('base64')}`;
    assert.equal(tomographyCaptureSchema.safeParse({...sliceCapture(),dataUrl:encoded}).success,false);
    assert.equal(stripCanvasJpegMetadata(encoded),jpegUrls[0]);
    assert.equal(tomographyCaptureSchema.safeParse({...sliceCapture(),dataUrl:stripCanvasJpegMetadata(encoded)}).success,true);
  }
});

test('sharing off or no source does not read metadata, invoke captures or create an image payload', async () => {
  const controller = new AbortController();
  const forbidden = { get summary() { assert.fail('Sharing off must not read metadata'); }, capture() { assert.fail('Sharing off must not capture'); }, capture3d() { assert.fail('Sharing off must not capture'); } };
  assert.equal(await prepareTomographyEvidence(forbidden, false, controller.signal), undefined);
  assert.equal(await prepareTomographyEvidence(undefined, true, controller.signal), undefined);
  const tools = createTomographyTools();
  assert.equal(tools.getTomographyInventory.execute({}).sharing, 'off');
  assert.equal('requestTomographyView' in tools, false);
  const result = await tools.inspectTomographyView.execute({ viewId: 'view-1' });
  assert.equal(result.status, 'unavailable');
  const output = await tools.inspectTomographyView.toModelOutput({ input: { viewId: 'view-1' }, output: result });
  assert.equal(output.value.some(part => part.type === 'file'), false);
});

test('local captures retain exact oblique basis, pixel-center axes, window, camera and registration', async () => {
  const requested = { ...spec(), plane: 'oblique', normal: [Math.SQRT1_2, 0, Math.SQRT1_2], up: [0, 1, 0], slabMm: 1.5 };
  const src = source({ initialViews: [requested], capture3d: async () => capture3d() });
  const result = await prepareTomographyEvidence(src, true, new AbortController().signal);
  assert.deepEqual(result.views[0], sliceCapture(requested));
  assert.equal(result.views[1].id, 'view-2');
  assert.deepEqual(result.views[1].camera, capture3d().camera);
  assert.deepEqual(result.views[1].referencePlane, capture3d().referencePlane);
  const tools = createTomographyTools(result);
  const inventory = tools.getTomographyInventory.execute({});
  assert.equal(JSON.stringify(inventory).includes('base64'), false);
  assert.deepEqual(inventory.views[0].spec, requested);
  assert.deepEqual(inventory.summary.spacingMm, [0.2, 0.3, 0.4]);
  assert.deepEqual(inventory.summary.registration, summary().registration);
  for (const tool of Object.values(tools)) {
    assert.ok(asSchema(tool.inputSchema).jsonSchema);
    assert.equal(tool.metadata.annotations.readOnlyHint, true);
  }
  assert.equal(typeof tools.requestTomographyView.execute, 'undefined');
});

test('summary projects only calibrated geometry and provenance; raw DICOM and identifiers stay local', () => {
  const original = summary();
  const volume = { id: 'PATIENT_NAME__1.2.840.123', dimensions: original.dimensions, spacing: original.spacingMm, origin: original.originLpsMm, directions: original.directionsLps, voxels: new Float32Array([987654]), range: [0, 987654], missingSlices: [], complete: true, quantitativeMeasurementsAllowed: true, warnings: ['PATIENT_NAME'], provenance: { ...original.provenance, sourceUID: 'PRIVATE_UID', fileName: 'patient.dcm' } };
  const projected = buildTomographySummary(volume, { patientToWorkspace: identity, confirmed: false });
  assert.equal(projected.volumeId, 'volume-1');
  assert.equal(projected.registration.status, 'unconfirmed');
  assert.doesNotMatch(JSON.stringify(projected), /PATIENT_NAME|PRIVATE_UID|patient\.dcm|987654|voxels|range|warnings/);
  const previews = { ...volume, complete: false, missingSlices: [3], quantitativeMeasurementsAllowed: true };
  const incomplete = buildTomographySummary(previews);
  assert.equal(incomplete.quantitativeMeasurementsAllowed, false);
  assert.equal(incomplete.missingSlices, 1);
  assert.equal(tomographySummarySchema.safeParse({ ...incomplete, quantitativeMeasurementsAllowed: true }).success, false);
  assert.equal(tomographySummarySchema.safeParse({ ...incomplete, complete: true }).success, false);
});

test('schemas reject private metadata, arbitrary IDs/URLs, invalid pixels, nonfinite or contradictory geometry', () => {
  for (const key of ['patientName', 'sourceUID', 'fileName', 'voxels', 'warnings']) {
    const value = evidence(); value.summary[key] = 'private-patient';
    assert.equal(tomographyEvidenceSchema.safeParse(value).success, false, key);
    const capture = sliceCapture(); capture[key] = 'private-patient';
    assert.equal(tomographyCaptureSchema.safeParse(capture).success, false, key);
  }
  for (const changes of [
    { volumeId: '1.2.840.10008.1' }, { id: 'patient.dcm' }, { dataUrl: 'https://private.example/scan.jpg' },
    { dataUrl: 'data:image/jpeg;base64,AAAA' }, { dataUrl: jpegUrls[0].replace('jpeg', 'png') },
    { pixelWidth: 1537 }, { pixelWidth: 3 }, { pixelOriginLpsMm: [0, 0, 0] },
    { pixelRightLpsMm: [0, 0, 0] }, { pixelRightLpsMm: [0, 1, 0] },
    { pixelRightLpsMm: [-1, 0, 0], pixelDownLpsMm: [0, -1, 0], pixelOriginLpsMm: [10.5, 20.5, 30] },
    { spec: { ...spec(), windowWidth: Infinity } }, { spec: { ...spec(), center: [NaN, 0, 0] } },
    { overlay: { registration: summary().registration, components: [{ id: 'patient.stl', kind: 'mesh', localToWorkspace: identity }] } },
  ]) assert.equal(tomographyCaptureSchema.safeParse({ ...sliceCapture(), ...changes }).success, false, JSON.stringify(changes));
  assert.equal(tomographyViewSpecSchema.safeParse({ ...spec(), plane: 'oblique' }).success, false);
  assert.equal(tomographyViewSpecSchema.safeParse({ ...spec(), plane: 'oblique', normal: [1, 0, 0], up: [1, 0, 0] }).success, false);
  assert.equal(tomographyCaptureSchema.safeParse({ ...capture3d(), camera: { ...capture3d().camera, near: 2000 } }).success, false);
});

test('JPEG metadata, overlarge containers, duplicate views and inconsistent registration are rejected', () => {
  const bytes = Buffer.from(jpegUrls[0].split(',')[1], 'base64');
  // Inject both conventional EXIF and a comment after image entropy; neither may leave the browser.
  for (const [marker, insertAt] of [[0xe1, 2], [0xfe, bytes.length - 2]]) {
    const payload = Buffer.from('PRIVATE_PATIENT\0');
    const segment = Buffer.from([0xff, marker, 0, payload.length + 2]);
    const image = Buffer.concat([bytes.subarray(0, insertAt), segment, payload, bytes.subarray(insertAt)]);
    assert.equal(tomographyCaptureSchema.safeParse({ ...sliceCapture(), dataUrl: `data:image/jpeg;base64,${image.toString('base64')}` }).success, false);
  }
  const tooBig = Buffer.concat([bytes.subarray(0, -2), Buffer.alloc(MAX_TOMOGRAPHY_IMAGE_BYTES), bytes.subarray(-2)]);
  assert.equal(tomographyCaptureSchema.safeParse({ ...sliceCapture(), dataUrl: `data:image/jpeg;base64,${tooBig.toString('base64')}` }).success, false);
  assert.equal(tomographyEvidenceSchema.safeParse({ ...evidence(), views: [sliceCapture(), sliceCapture()] }).success, false);
  const registered = evidence(); registered.views[0].overlay.registration = { status: 'confirmed', workspaceUnits: 'file units', patientToWorkspace: identity };
  assert.equal(tomographyEvidenceSchema.safeParse(registered).success, false);
});

test('capture counts, precise requested view matching, inspection budget and continuation rounds are bounded', async () => {
  const controller = new AbortController();
  let captures = 0;
  await assert.rejects(prepareTomographyEvidence(source({ initialViews: Array(9).fill(spec()), capture: async s => { captures++; return sliceCapture(s); } }), true, controller.signal), /Too many/);
  assert.equal(captures, 0);
  await assert.rejects(prepareTomographyEvidence(source({ capture: async () => sliceCapture({ ...spec(), center: [99, 99, 99] }) }), true, controller.signal), /does not match/);
  const initial = evidence(7);
  const additional = await captureRequestedTomographyView(source(), initial, spec(), 1, controller.signal);
  assert.equal(additional.views.length, 8); assert.equal(additional.canRequestViews, false);
  await assert.rejects(captureRequestedTomographyView(source(), additional, spec(), 2, controller.signal), /limit/);
  await assert.rejects(captureRequestedTomographyView(source(), evidence(), spec(), 4, controller.signal), /limit/);
  assert.equal(tomographyContinuationSchema.safeParse({ round: 4, viewId: 'view-1', spec: spec(), analysis: '' }).success, false);
  const third = await captureRequestedTomographyView(source(), evidence(), spec(), 3, controller.signal);
  assert.equal(third.canRequestViews, false);
  assert.equal('requestTomographyView' in createTomographyTools(evidence(), 3), false);
  const tools = createTomographyTools(evidence());
  for (let i = 0; i < 8; i++) assert.equal((await tools.inspectTomographyView.execute({ viewId: 'view-1' })).status, 'available');
  assert.equal((await tools.inspectTomographyView.execute({ viewId: 'view-1' })).status, 'unavailable');
});

test('stale capture abort discards its result before another capture or image continuation can start', async () => {
  const controller = new AbortController();
  let release; let started = 0; let gotSignal;
  const pending = new Promise(resolve => { release = resolve; });
  const src = source({ initialViews: [spec(), spec()], capture: async (requested, signal) => { started++; gotSignal = signal; await pending; return sliceCapture(requested); } });
  const preparation = prepareTomographyEvidence(src, true, controller.signal);
  assert.equal(started, 1); assert.equal(gotSignal, controller.signal);
  controller.abort(); release();
  await assert.rejects(preparation, error => error.name === 'AbortError');
  assert.equal(started, 1);
  await assert.rejects(captureRequestedTomographyView(src, evidence(), spec(), 1, controller.signal), error => error.name === 'AbortError');
  assert.equal(started, 1);
  const nextController = new AbortController();
  let finishRequested;
  const requestPending = new Promise(resolve => { finishRequested = resolve; });
  const requesting = captureRequestedTomographyView(source({ capture: async requested => { await requestPending; return sliceCapture(requested); } }), evidence(), spec(), 1, nextController.signal);
  nextController.abort(); finishRequested();
  await assert.rejects(requesting, error => error.name === 'AbortError');
});


test('larger restoration scenes retain bounded anonymized component identities', () => {
  const capture = capture3d();
  capture.overlay.components = Array.from({ length: 192 }, (_, i) => ({ id: `restoration-${i + 1}`, kind: 'restoration', localToWorkspace: identity }));
  capture.overlay.components.unshift(...Array.from({ length: 64 }, (_, i) => ({ id: `scan-${i + 1}`, kind: 'mesh', localToWorkspace: identity })));
  assert.equal(tomographyCaptureSchema.safeParse(capture).success, true);
  capture.overlay.components[64].id = 'restoration-193';
  assert.equal(tomographyCaptureSchema.safeParse(capture).success, false);
  capture.overlay.components[64].id = 'restoration-1';
  capture.overlay.components.push({ id: 'volume-1', kind: 'threshold-surface', localToWorkspace: identity });
  assert.equal(tomographyCaptureSchema.safeParse(capture).success, false);
});
