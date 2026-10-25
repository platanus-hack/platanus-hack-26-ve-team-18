import dicomParser from 'dicom-parser';
import type { DataSet } from 'dicom-parser';
import type { TomographySeriesChoice, TomographyVolume, Vec3 } from './tomography-types.ts';

// Two resident volume copies (UI + extraction worker) are deliberately bounded.
export const MAX_DICOM_VOXELS = 64 * 1024 * 1024;
export const MAX_DICOM_FILES = 4096;
export const MAX_DICOM_INPUT_BYTES = 512 * 1024 * 1024;
export const MAX_DICOM_FILE_BYTES = 64 * 1024 * 1024;
const NATIVE_SYNTAXES = new Set(['1.2.840.10008.1.2', '1.2.840.10008.1.2.1', '1.2.840.10008.1.2.2']);

export class DicomImportError extends Error {
  code: string;
  seriesChoices: TomographySeriesChoice[];
  constructor(message: string, code: string = 'invalid-dicom', seriesChoices: TomographySeriesChoice[] = []) {
    super(message); this.name = 'DicomImportError'; this.code = code; this.seriesChoices = seriesChoices;
  }
}
export interface DicomImportOptions {
  allowIncompletePreview?: boolean;
  seriesId?: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}
interface Slice {
  file: File;
  series: string;
  frame: string;
  study: string;
  sop: string;
  columns: number;
  rows: number;
  origin: Vec3;
  x: Vec3;
  y: Vec3;
  pixelSpacing: [number, number];
  declaredSpacing?: number;
  thickness?: number;
  syntax: string;
  wordSwapped8: boolean;
  bits: number;
  stored: number;
  highBit: number;
  signed: boolean;
  slope: number;
  intercept: number;
  hu: boolean;
  padding?: [number, number];
  pixelOffset: number;
  pixelLength: number;
  modality: TomographySeriesChoice['modality'];
}
function fail(message: string, code?: string): never { throw new DicomImportError(message, code); }
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const distance = (a: number[], b: number[]) => Math.hypot(...a.map((n, i) => n - b[i]));
const positive = (n: number) => Number.isFinite(n) && n > 0;
function checkAbort(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException('DICOM import cancelled.', 'AbortError'); }
function numbers(ds: DataSet, tag: string, length: number, label: string): number[] {
  const text = ds.string(tag);
  const values = text?.split('\\').map(value => value.trim() === '' ? NaN : Number(value));
  if (!values || values.length !== length || values.some(n => !Number.isFinite(n))) fail(`${label} must contain ${length} finite values.`);
  return values;
}
function scalar(ds: DataSet, tag: string, fallback: number, label: string) {
  return ds.elements[tag] ? numbers(ds, tag, 1, label)[0] : fallback;
}
function requiredUID(ds: DataSet, tag: string, label: string) {
  const uid = ds.string(tag)?.trim();
  if (!uid || uid.length > 64 || !/^[0-9]+(?:\.[0-9]+)*$/.test(uid)) fail(`${label} is required and must be a valid DICOM UID.`);
  return uid;
}
function readSlice(file: File, bytes: Uint8Array): Slice {
  let syntax: string | undefined;
  try { syntax = dicomParser.readPart10Header(bytes).string('x00020010'); }
  catch { fail('Unreadable DICOM Part 10 header. Raw or damaged-header DICOM is unsupported.', 'unreadable-header'); }
  if (!syntax || !NATIVE_SYNTAXES.has(syntax)) fail('Unsupported compressed or deflated DICOM transfer syntax. Export native uncompressed single-frame DICOM first.', 'unsupported-compression');
  let ds: DataSet;
  try { ds = dicomParser.parseDicom(bytes, { untilTag: 'x7fe00010' }); }
  catch { fail('Unreadable DICOM dataset header.', 'unreadable-header'); }
  const frames = scalar(ds, 'x00280008', 1, 'NumberOfFrames');
  if (frames !== 1) fail('Multiframe DICOM is unsupported. Export an ordinary single-frame slice series.', 'unsupported-multiframe');
  if (ds.elements.x52009229 || ds.elements.x52009230) fail('Enhanced functional-group DICOM is unsupported; export ordinary single-frame slices.', 'unsupported-multiframe');
  const columns = ds.uint16('x00280011') ?? 0, rows = ds.uint16('x00280010') ?? 0;
  if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1 || columns * rows > MAX_DICOM_VOXELS) fail('Invalid or excessive DICOM image dimensions.');
  if (ds.uint16('x00280002') !== 1 || !['MONOCHROME1', 'MONOCHROME2'].includes(ds.string('x00280004') ?? '')) fail('Only single-sample monochrome DICOM slices are supported.', 'unsupported-pixels');
  const bits = ds.uint16('x00280100') ?? 0, stored = ds.uint16('x00280101') ?? 0, highBit = ds.uint16('x00280102') ?? -1;
  const representation = ds.uint16('x00280103');
  if (![8, 16].includes(bits) || stored < 1 || stored > bits || highBit < stored - 1 || highBit >= bits || ![0, 1].includes(representation ?? -1)) fail('Only valid native 8-bit or 16-bit integer samples are supported.', 'unsupported-pixels');
  const orientation = numbers(ds, 'x00200037', 6, 'ImageOrientationPatient');
  const x = orientation.slice(0, 3) as Vec3, y = orientation.slice(3) as Vec3;
  const lx = Math.hypot(...x), ly = Math.hypot(...y);
  if (Math.abs(lx - 1) > 1e-4 || Math.abs(ly - 1) > 1e-4 || Math.abs(dot(x, y)) > 1e-5) fail('DICOM orientation must contain orthonormal unit vectors. Sheared geometry is unsupported.');
  for (let axis = 0; axis < 3; axis++) { x[axis] /= lx; y[axis] /= ly; }
  // Remove only rounded-header orthogonality noise, after validating it above.
  const projection = dot(x, y); for (let axis = 0; axis < 3; axis++) y[axis] -= projection * x[axis];
  const yl = Math.hypot(...y); for (let axis = 0; axis < 3; axis++) y[axis] /= yl;
  const pixelSpacing = numbers(ds, 'x00280030', 2, 'PixelSpacing') as [number, number];
  if (!pixelSpacing.every(positive)) fail('PixelSpacing must contain positive millimeter values.');
  const slope = scalar(ds, 'x00281053', 1, 'RescaleSlope'), intercept = scalar(ds, 'x00281052', 0, 'RescaleIntercept');
  if (ds.elements.x00283000) fail('DICOM Modality LUT transformations are unsupported. Export slices with a linear rescale instead.', 'unsupported-modality-lut');
  if (slope === 0 || !Number.isFinite(slope) || !Number.isFinite(intercept)) fail('DICOM rescale slope must be finite and nonzero and intercept finite.');
  const pixel = ds.elements.x7fe00010;
  if (!pixel || pixel.encapsulatedPixelData || pixel.hadUndefinedLength || pixel.length === 0xffffffff) fail('Missing or unsupported native DICOM PixelData.', 'unsupported-pixels');
  const signed = representation === 1;
  const paddingValue = ds.elements.x00280120 ? (signed ? ds.int16('x00280120') : ds.uint16('x00280120')) : undefined;
  const paddingLimit = ds.elements.x00280121 ? (signed ? ds.int16('x00280121') : ds.uint16('x00280121')) : paddingValue;
  if (ds.elements.x00280121 && paddingValue === undefined) fail('PixelPaddingRangeLimit requires PixelPaddingValue.');
  const declaredSpacing = ds.elements.x00180088 ? Math.abs(scalar(ds, 'x00180088', NaN, 'SpacingBetweenSlices')) : undefined;
  const thickness = ds.elements.x00180050 ? scalar(ds, 'x00180050', NaN, 'SliceThickness') : undefined;
  if ((declaredSpacing !== undefined && !positive(declaredSpacing)) || (thickness !== undefined && !positive(thickness))) fail('Declared DICOM slice spacing/thickness must be positive.');
  return {
    file, series: requiredUID(ds, 'x0020000e', 'SeriesInstanceUID'), frame: requiredUID(ds, 'x00200052', 'FrameOfReferenceUID'),
    study: requiredUID(ds, 'x0020000d', 'StudyInstanceUID'), sop: requiredUID(ds, 'x00080018', 'SOPInstanceUID'),
    columns, rows, origin: numbers(ds, 'x00200032', 3, 'ImagePositionPatient') as Vec3,
    x, y, pixelSpacing, declaredSpacing, thickness, syntax, wordSwapped8: bits === 8 && syntax === '1.2.840.10008.1.2.2' && pixel.vr === 'OW', bits, stored, highBit, signed, slope, intercept,
    hu: ds.string('x00281054')?.trim().toUpperCase() === 'HU',
    padding: paddingValue === undefined ? undefined : [Math.min(paddingValue, paddingLimit ?? paddingValue), Math.max(paddingValue, paddingLimit ?? paddingValue)],
    pixelOffset: pixel.dataOffset, pixelLength: pixel.length,
    modality: ds.string('x00080060') === 'CT' ? 'CT' : ds.string('x00080060') === 'CBCT' ? 'CBCT' : 'other',
  };
}

/** Local-only import. Returned metadata never contains source paths, UIDs, or identifying fields. */
export async function importDicomVolume(files: readonly File[], options: DicomImportOptions = {}): Promise<{ volume: TomographyVolume; seriesChoices: TomographySeriesChoice[] }> {
  checkAbort(options.signal);
  if (!files.length) fail('Choose local DICOM slice files.');
  if (files.length > MAX_DICOM_FILES) fail(`DICOM import is limited to ${MAX_DICOM_FILES} files.`, 'capacity');
  const inputBytes = files.reduce((sum, file) => sum + file.size, 0);
  if (!Number.isSafeInteger(inputBytes) || inputBytes > MAX_DICOM_INPUT_BYTES || files.some(file => file.size > MAX_DICOM_FILE_BYTES)) fail('DICOM import exceeds the 512 MiB input or 64 MiB per-slice limit.', 'capacity');
  const groups = new Map<string, Slice[]>();
  let unreadableFiles = 0;
  for (let index = 0; index < files.length; index++) {
    checkAbort(options.signal);
    if (index % 16 === 0) options.onProgress?.(`Inspecting local DICOM headers (${index}/${files.length})…`);
    try {
      const bytes = new Uint8Array(await files[index].arrayBuffer()); checkAbort(options.signal);
      const slice = readSlice(files[index], bytes);
      const group = groups.get(slice.series) ?? []; group.push(slice); groups.set(slice.series, group);
    } catch (cause) {
      if (cause instanceof DicomImportError && cause.code === 'unreadable-header') unreadableFiles++;
      else throw cause;
    }
  }
  const series = [...groups.values()];
  const seriesChoices = series.map((slices, i): TomographySeriesChoice => ({ id: `series-${i + 1}`, label: `Series ${i + 1} · ${slices[0].columns} × ${slices[0].rows} · ${slices.length} slices`, slices: slices.length, dimensions: [slices[0].columns, slices[0].rows], modality: slices[0].modality }));
  if (!series.length) fail('No readable native DICOM slices were found. Raw or damaged headers are unsupported.');
  const selected = options.seriesId ? seriesChoices.findIndex(choice => choice.id === options.seriesId) : series.length === 1 ? 0 : -1;
  if (selected < 0) throw new DicomImportError(options.seriesId ? 'The selected local series is unavailable. Choose a listed series.' : 'Multiple DICOM series found. Choose one series explicitly.', 'series-selection', seriesChoices);
  if (unreadableFiles && !options.allowIncompletePreview) throw new DicomImportError(`${unreadableFiles} unreadable DICOM file(s). Import rejected; explicit incomplete preview is required to omit unreadable files and preserve gaps as NaN.`, 'incomplete', seriesChoices);
  const slices = series[selected], first = slices[0], zDirection = cross(first.x, first.y);
  const duplicateSops = new Set<string>();
  for (const slice of slices) {
    if (slice.frame !== first.frame || slice.study !== first.study) fail('Selected series mixes studies or frames of reference. Import one consistent frame.');
    if (slice.columns !== first.columns || slice.rows !== first.rows || distance(slice.x, first.x) > 1e-4 || distance(slice.y, first.y) > 1e-4 || distance(slice.pixelSpacing, first.pixelSpacing) > 1e-5) fail('Selected DICOM series has inconsistent dimensions, orientation, or pixel spacing.');
    if (duplicateSops.has(slice.sop)) fail('Duplicate DICOM SOP instances found. Remove duplicate files before importing.', 'duplicate-slice');
    duplicateSops.add(slice.sop);
  }
  slices.sort((a, b) => dot(a.origin, zDirection) - dot(b.origin, zDirection));
  const origin = slices[0].origin;
  const coordinates = slices.map(slice => dot(slice.origin, zDirection) - dot(origin, zDirection));
  const gaps = coordinates.slice(1).map((value, i) => value - coordinates[i]);
  if (gaps.some(gap => gap < 1e-4)) fail('Duplicate or nearly coincident DICOM slice planes found. Remove duplicates before importing.', 'duplicate-slice');
  const declared = slices.map(slice => slice.declaredSpacing).filter((value): value is number => value !== undefined);
  let sz: number;
  if (declared.length) {
    sz = declared[0];
    if (declared.some(value => Math.abs(value - sz) > Math.max(1e-4, sz * 1e-3))) fail('Selected DICOM series has inconsistent declared slice spacing.');
  } else if (gaps.length) {
    const minimum = Math.min(...gaps), cluster = gaps.filter(gap => gap <= minimum + Math.max(1e-4, minimum * 1e-3)).sort((a, b) => a - b);
    sz = cluster[Math.floor(cluster.length / 2)];
  } else {
    // A single plane has no observed z spacing; thickness is an explicit metadata fallback.
    sz = first.thickness ?? fail('A single slice requires declared slice spacing or SliceThickness.');
  }
  const indices = coordinates.map(value => Math.round(value / sz));
  const tolerance = Math.max(0.001, sz * 0.01);
  for (let i = 0; i < slices.length; i++) {
    if (Math.abs(coordinates[i] - indices[i] * sz) > tolerance) fail('Irregular DICOM slice spacing does not lie on a regular voxel grid.');
    const expected = origin.map((value, axis) => value + zDirection[axis] * coordinates[i]);
    if (distance(slices[i].origin, expected) > tolerance) fail('DICOM slice positions contain in-plane drift or gantry shear; this geometry is unsupported.');
    if (i && indices[i] === indices[i - 1]) fail('Duplicate DICOM slice grid locations found.', 'duplicate-slice');
  }
  const nz = indices[indices.length - 1] + 1, planeSize = first.columns * first.rows, count = planeSize * nz;
  if (!Number.isSafeInteger(count) || count > MAX_DICOM_VOXELS || nz > MAX_DICOM_FILES) fail('DICOM voxel grid exceeds the 64 million voxel or 4096 plane memory limit. Choose a smaller volume.', 'capacity');
  const present = new Set(indices), missingSlices: number[] = [];
  for (let z = 0; z < nz; z++) if (!present.has(z)) missingSlices.push(z);
  if (missingSlices.length && !options.allowIncompletePreview) throw new DicomImportError(`${missingSlices.length} missing DICOM slice plane(s). Import rejected; enable incomplete preview to preserve gaps as NaN without interpolation.`, 'incomplete', seriesChoices);
  const voxels = new Float32Array(count); voxels.fill(NaN);
  let min = Infinity, max = -Infinity, paddingVoxels = 0, corruptSlices = 0;
  for (let i = 0; i < slices.length; i++) {
    checkAbort(options.signal);
    if (i % 16 === 0) options.onProgress?.(`Decoding native DICOM slices (${i}/${slices.length})…`);
    const slice = slices[i], bytes = await slice.file.arrayBuffer(); checkAbort(options.signal);
    const required = planeSize * (slice.bits / 8), expectedLength = required + required % 2;
    if (slice.pixelLength !== expectedLength || slice.pixelOffset + expectedLength > bytes.byteLength) {
      if (!options.allowIncompletePreview) throw new DicomImportError('Truncated or inconsistent native DICOM PixelData. Explicit incomplete preview is required to preserve this plane as NaN.', 'incomplete', seriesChoices);
      missingSlices.push(indices[i]); corruptSlices++; continue;
    }
    const view = new DataView(bytes), littleEndian = slice.syntax !== '1.2.840.10008.1.2.2';
    const shift = slice.highBit + 1 - slice.stored, mask = 2 ** slice.stored - 1, sign = 2 ** (slice.stored - 1), full = 2 ** slice.stored;
    for (let j = 0; j < planeSize; j++) {
      const raw = slice.bits === 8 ? view.getUint8(slice.pixelOffset + (slice.wordSwapped8 ? j ^ 1 : j)) : view.getUint16(slice.pixelOffset + j * 2, littleEndian);
      let value = (raw >>> shift) & mask;
      if (slice.signed && value >= sign) value -= full;
      if (slice.padding && value >= slice.padding[0] && value <= slice.padding[1]) { paddingVoxels++; continue; }
      value = Math.fround(value * slice.slope + slice.intercept);
      if (!Number.isFinite(value)) fail('DICOM rescaled samples exceed finite Float32 range.');
      voxels[indices[i] * planeSize + j] = value;
      min = Math.min(min, value); max = Math.max(max, value);
    }
  }
  if (!Number.isFinite(min)) fail('Selected DICOM series contains no usable non-padding samples.');
  missingSlices.sort((a, b) => a - b);
  const complete = missingSlices.length === 0 && unreadableFiles === 0;
  const warnings = ['Local threshold and grayscale previews are not anatomical segmentation. CBCT intensity is not assumed to be calibrated HU.', 'Only the observed slice extent is known; absent boundary planes cannot be inferred.'];
  if (!declared.length) warnings.push(gaps.length ? 'Slice spacing inferred from observed geometric positions; uniformly absent planes cannot be detected.' : 'Single-plane stack spacing uses declared SliceThickness.');
  if (unreadableFiles) warnings.push(`${unreadableFiles} unreadable input file(s) omitted in explicit incomplete preview; their series and boundary positions are unknown.`);
  if (!complete) warnings.push(`${missingSlices.length} missing plane(s) remain NaN. No interpolation; quantitative measurements disabled.`);
  if (paddingVoxels) warnings.push('Pixel padding is NaN and excluded from sampling and surfaces.');
  if (series.length > 1) warnings.push('Only the explicitly selected local DICOM series was imported.');
  checkAbort(options.signal);
  return { seriesChoices, volume: {
    id: crypto.randomUUID(), dimensions: [first.columns, first.rows, nz], spacing: [first.pixelSpacing[1], first.pixelSpacing[0], sz], origin: [...origin], directions: [[...first.x], [...first.y], zDirection], voxels, range: [min, max], missingSlices, complete, quantitativeMeasurementsAllowed: complete, warnings,
    provenance: { source: 'local-dicom', sourceSlices: slices.length - corruptSlices, expectedSlices: nz, duplicateSlices: 0, transferSyntaxes: [...new Set(slices.map(slice => slice.syntax))], rescaled: slices.some(slice => slice.slope !== 1 || slice.intercept !== 0), intensityUnits: slices.every(slice => slice.hu) ? 'HU' : 'rescaled values', paddingVoxels, missingDataPolicy: options.allowIncompletePreview ? 'nan-preview' : 'reject', interpolated: false },
  } };
}
