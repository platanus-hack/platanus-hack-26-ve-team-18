import assert from 'node:assert/strict';
import test from 'node:test';
import { DicomImportError, importDicomVolume, MAX_DICOM_FILES, MAX_DICOM_VOXELS } from '../src/dicom-volume.ts';

// Synthetic Part 10 records; no source patient data is used in these tests.
function element(group, tag, vr, value, littleEndian = true, implicit = false) {
  let data;
  if (['US', 'SS'].includes(vr)) {
    const values = Array.isArray(value) ? value : [value]; data = Buffer.alloc(values.length * 2);
    values.forEach((n, i) => vr === 'SS' ? littleEndian ? data.writeInt16LE(n, i * 2) : data.writeInt16BE(n, i * 2) : littleEndian ? data.writeUInt16LE(n, i * 2) : data.writeUInt16BE(n, i * 2));
  } else if (value instanceof Uint8Array) data = Buffer.from(value);
  else data = Buffer.from(String(value));
  if (data.length % 2) data = Buffer.concat([data, Buffer.from([vr === 'UI' || vr === 'OW' || vr === 'OB' ? 0 : 32])]);
  const long = ['OW', 'OB', 'SQ', 'UN', 'UT'].includes(vr), header = Buffer.alloc(implicit || !long ? 8 : 12);
  const u16 = (n, at) => littleEndian ? header.writeUInt16LE(n, at) : header.writeUInt16BE(n, at);
  const u32 = (n, at) => littleEndian ? header.writeUInt32LE(n, at) : header.writeUInt32BE(n, at);
  u16(group, 0); u16(tag, 2);
  if (implicit) u32(data.length, 4);
  else { header.write(vr, 4); if (long) u32(data.length, 8); else u16(data.length, 6); }
  return Buffer.concat([header, data]);
}
function dicom(z, options = {}) {
  const o = { series: '1.2.3', frame: '1.2.4', study: '1.2.5', sop: `1.2.6.${z + 1}`, syntax: '1.2.840.10008.1.2.1', columns: 2, rows: 2, orientation: '1\\0\\0\\0\\1\\0', position: `10\\20\\${30 + z}`, pixelSpacing: '2\\3', bits: 16, stored: 16, highBit: 15, signed: 0, samples: 1, slope: '1', intercept: '0', values: [z * 10, z * 10 + 1, z * 10 + 2, z * 10 + 3], ...options };
  const le = o.syntax !== '1.2.840.10008.1.2.2', implicit = o.syntax === '1.2.840.10008.1.2';
  const e = (g, t, vr, v) => element(g, t, vr, v, le, implicit);
  const parts = [e(8, 0x18, 'UI', o.sop), e(8, 0x60, 'CS', 'CT')];
  if (o.declaredSpacing !== undefined) parts.push(e(0x18, 0x88, 'DS', o.declaredSpacing));
  parts.push(e(0x18, 0x50, 'DS', '1'), e(0x20, 0x0d, 'UI', o.study), e(0x20, 0x0e, 'UI', o.series), e(0x20, 0x32, 'DS', o.position), e(0x20, 0x37, 'DS', o.orientation), e(0x20, 0x52, 'UI', o.frame), e(0x28, 2, 'US', o.samples), e(0x28, 4, 'CS', 'MONOCHROME2'));
  if (o.frames !== undefined) parts.push(e(0x28, 8, 'IS', o.frames));
  parts.push(e(0x28, 0x10, 'US', o.rows), e(0x28, 0x11, 'US', o.columns), e(0x28, 0x30, 'DS', o.pixelSpacing), e(0x28, 0x100, 'US', o.bits), e(0x28, 0x101, 'US', o.stored), e(0x28, 0x102, 'US', o.highBit), e(0x28, 0x103, 'US', o.signed));
  if (o.padding !== undefined) parts.push(e(0x28, 0x120, o.signed ? 'SS' : 'US', o.padding));
  if (o.paddingLimit !== undefined) parts.push(e(0x28, 0x121, o.signed ? 'SS' : 'US', o.paddingLimit));
  if (o.modalityLut) parts.push(e(0x28, 0x3000, 'SQ', new Uint8Array()));
  parts.push(e(0x28, 0x1052, 'DS', o.intercept), e(0x28, 0x1053, 'DS', o.slope));
  const count = o.values.length * o.bits / 8;
  const pixels = Buffer.alloc(count + count % 2);
  o.values.forEach((n, i) => o.bits === 8 ? pixels.writeUInt8(n & 255, i) : le ? pixels.writeUInt16LE(n & 65535, i * 2) : pixels.writeUInt16BE(n & 65535, i * 2));
  const pixelVR = o.pixelVR ?? (o.bits === 8 ? 'OB' : 'OW');
  if (!le && o.bits === 8 && pixelVR === 'OW') pixels.swap16();
  parts.push(e(0x7fe0, 0x10, pixelVR, pixels));
  const preamble = Buffer.alloc(132); preamble.write('DICM', 128);
  return new File([preamble, element(2, 0x10, 'UI', o.syntax), ...parts], 'synthetic-local-slice.dcm');
}

test('big-endian 8-bit OW samples respect word order including an odd final sample', async () => {
  for (const values of [[1,2,3,4],[1,2,3]]) {
    const {volume} = await importDicomVolume([dicom(0, { syntax:'1.2.840.10008.1.2.2',bits:8,stored:8,highBit:7,columns:values.length,rows:1,pixelVR:'OW',values })]);
    assert.deepEqual(Array.from(volume.voxels), values);
  }
});

test('unsupported modality LUT cannot silently become quantitative identity-rescaled data', async () => {
  await assert.rejects(importDicomVolume([dicom(0,{modalityLut:true})]), /Modality LUT/);
  await assert.rejects(importDicomVolume([dicom(0,{modalityLut:true})],{allowIncompletePreview:true}), /Modality LUT/);
});

test('geometric sort ignores input order and swaps DICOM row/column spacing correctly', async () => {
  const { volume } = await importDicomVolume([dicom(2), dicom(0), dicom(1)]);
  assert.deepEqual(volume.dimensions, [2, 2, 3]); assert.deepEqual(volume.spacing, [3, 2, 1]);
  assert.deepEqual(volume.origin, [10, 20, 30]); assert.deepEqual(volume.directions, [[1, 0, 0], [0, 1, 0], [0, 0, 1]]);
  assert.deepEqual([...volume.voxels], [0, 1, 2, 3, 10, 11, 12, 13, 20, 21, 22, 23]);
  assert.deepEqual(volume.range, [0, 23]); assert.equal(volume.complete, true); assert.equal(volume.quantitativeMeasurementsAllowed, true);
  assert.equal(volume.provenance.interpolated, false); assert.match(volume.id, /^[0-9a-f-]{36}$/);
  const metadata = JSON.stringify({ ...volume, voxels: undefined });
  for (const secret of ['1.2.3', '1.2.4', '1.2.5', 'synthetic-local-slice']) assert.ok(!metadata.includes(secret));
});

for (const syntax of ['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2']) {
  test(`native syntax ${syntax} decodes signed stored bits, rescale and padding`, async () => {
    const { volume } = await importDicomVolume([dicom(0, { syntax, signed: 1, stored: 12, highBit: 14, slope: '2', intercept: '-100', padding: -2048, values: [0x8000 | (4095 << 3), 0x8000 | (2048 << 3), 0, 2047 << 3] })]);
    assert.equal(volume.voxels[0], -102); assert.ok(Number.isNaN(volume.voxels[1]));
    assert.equal(volume.voxels[2], -100); assert.equal(volume.voxels[3], 3994); assert.equal(volume.provenance.paddingVoxels, 1);
  });
}

test('native 8-bit signed pixels and signed padding range are respected', async () => {
  const { volume } = await importDicomVolume([dicom(0, { bits: 8, stored: 8, highBit: 7, signed: 1, padding: -128, paddingLimit: -127, values: [128, 129, 255, 127] })]);
  assert.ok(Number.isNaN(volume.voxels[0]) && Number.isNaN(volume.voxels[1]));
  assert.equal(volume.voxels[2], -1); assert.equal(volume.voxels[3], 127);
});

test('missing planes reject by default and explicit preview preserves NaN and provenance', async () => {
  const files = [dicom(0), dicom(1), dicom(4)];
  await assert.rejects(importDicomVolume(files), error => error.code === 'incomplete' && /2 missing/.test(error.message));
  const { volume } = await importDicomVolume(files, { allowIncompletePreview: true });
  assert.deepEqual(volume.dimensions, [2, 2, 5]); assert.deepEqual(volume.missingSlices, [2, 3]);
  assert.ok(volume.voxels.subarray(8, 16).every(Number.isNaN)); assert.equal(volume.complete, false); assert.equal(volume.quantitativeMeasurementsAllowed, false);
  assert.equal(volume.provenance.missingDataPolicy, 'nan-preview'); assert.equal(volume.provenance.interpolated, false);
});

test('unreadable inputs are never silently omitted; preview marks even unknowable boundary defects nonquantitative', async () => {
  const files = [dicom(0), dicom(1), new File(['damaged'], 'private-patient-name.dcm')];
  await assert.rejects(importDicomVolume(files), /1 unreadable DICOM/);
  const { volume } = await importDicomVolume(files, { allowIncompletePreview: true });
  assert.equal(volume.complete, false); assert.equal(volume.quantitativeMeasurementsAllowed, false); assert.deepEqual(volume.missingSlices, []);
  assert.ok(volume.warnings.some(w => /boundary positions are unknown/.test(w))); assert.ok(!JSON.stringify(volume.warnings).includes('private-patient'));
});

test('mixed series require explicit opaque local selection', async () => {
  const files = [dicom(0), dicom(1, { series: '1.9.8' })];
  await assert.rejects(importDicomVolume(files), error => {
    assert.equal(error.code, 'series-selection'); assert.equal(error.seriesChoices.length, 2);
    assert.deepEqual(error.seriesChoices.map(c => c.id), ['series-1', 'series-2']); return true;
  });
  const { volume } = await importDicomVolume(files, { seriesId: 'series-2' }); assert.equal(volume.voxels[0], 10);
  await assert.rejects(importDicomVolume(files, { seriesId: 'unknown' }), /unavailable/);
});

test('duplicates, frames, orientations, shear and irregular spacing reject even in preview mode', async () => {
  for (const [files, pattern] of [
    [[dicom(0), dicom(0)], /Duplicate/],
    [[dicom(0), dicom(1, { position: '10\\20\\30' })], /Duplicate/],
    [[dicom(0), dicom(1, { frame: '1.9.2' })], /frames/],
    [[dicom(0), dicom(1, { orientation: '0\\1\\0\\1\\0\\0' })], /inconsistent/],
    [[dicom(0), dicom(1, { position: '10.2\\20\\31' })], /drift|shear/],
    [[dicom(0), dicom(1), dicom(2, { position: '10\\20\\32.4' })], /Irregular/],
    [[dicom(0, { orientation: '1\\0\\0\\0.1\\1\\0' })], /orthonormal/],
  ]) await assert.rejects(importDicomVolume(files, { allowIncompletePreview: true }), pattern);
});

test('explicit compressed, multiframe, invalid pixel formats and malformed geometry errors are clear', async () => {
  for (const [options, pattern] of [
    [{ syntax: '1.2.840.10008.1.2.4.90' }, /compressed/],
    [{ syntax: '1.2.840.10008.1.2.1.99' }, /deflated/],
    [{ frames: 2 }, /Multiframe/], [{ samples: 3 }, /single-sample/],
    [{ stored: 17 }, /8-bit or 16-bit/], [{ pixelSpacing: '0\\1' }, /positive/],
    [{ position: 'NaN\\0\\1' }, /finite/], [{ slope: '0' }, /nonzero/],
  ]) await assert.rejects(importDicomVolume([dicom(0, options)], { allowIncompletePreview: true }), pattern);
});

test('short PixelData is rejected or retained as a wholly missing plane', async () => {
  const files = [dicom(0), dicom(1, { values: [10, 11] }), dicom(2)];
  await assert.rejects(importDicomVolume(files), /Truncated/);
  const { volume } = await importDicomVolume(files, { allowIncompletePreview: true });
  assert.deepEqual(volume.missingSlices, [1]); assert.ok(volume.voxels.subarray(4, 8).every(Number.isNaN)); assert.equal(volume.provenance.sourceSlices, 2);
});

test('declared spacing finds undersampling and rejects inconsistent headers', async () => {
  const { volume } = await importDicomVolume([dicom(0, { declaredSpacing: 1 }), dicom(2, { declaredSpacing: 1 })], { allowIncompletePreview: true });
  assert.deepEqual(volume.missingSlices, [1]);
  await assert.rejects(importDicomVolume([dicom(0, { declaredSpacing: 1 }), dicom(1, { declaredSpacing: 2 })]), /inconsistent declared/);
});

test('capacity and cancellation fail before large allocations', async () => {
  await assert.rejects(importDicomVolume([]), /Choose/);
  await assert.rejects(importDicomVolume(new Array(MAX_DICOM_FILES + 1).fill(dicom(0))), /limited/);
  await assert.rejects(importDicomVolume([{ size: 65 * 1024 * 1024 }]), /limit/);
  const side = Math.floor(Math.sqrt(MAX_DICOM_VOXELS)) + 1;
  await assert.rejects(importDicomVolume([dicom(0, { columns: side, rows: side })]), /dimensions/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(importDicomVolume([dicom(0)], { signal: controller.signal }), error => error.name === 'AbortError');
  assert.ok(new DicomImportError('safe').seriesChoices.length === 0);
});
