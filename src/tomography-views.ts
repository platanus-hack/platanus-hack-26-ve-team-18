/**
 * Local CBCT presentation API. All exported geometry functions are DOM-free.
 * Patient points and view dimensions are LPS millimeters; mesh inputs are file units.
 *
 * renderTomographyView(volume, spec, options) is synchronous and browser-only and
 * returns { canvas, metadata }. captureTomographyView(...) uses the SAME renderer
 * and returns those fields plus a PNG dataUrl, base64, and mediaType. Captures
 * include the exact plane, window, orientation, missing-data and overlay metadata.
 * No patient identifiers or source filenames are placed in the image or metadata.
 * Mesh contours require explicit scale and registration; unreviewed scan previews are opt-in.
 */
import type { ModelPart } from './models.ts';
import type { TomographyVolume, TomographyViewSpec, Vec3 } from './tomography-types.ts';
import { sampleVolume } from './tomography-geometry.ts';
import { partMatrix } from './pose.ts';

export interface SliceFrame {
  center: Vec3; right: Vec3; up: Vec3; normal: Vec3; widthMm: number; heightMm: number;
}
export type SliceSegment = [Vec3, Vec3];
export type PixelPoint = [number, number];
export interface OverlayRegistration { arch: 'upper' | 'lower'; rmsMm: number; reviewed: boolean; method?: 'landmarks' | 'surface' }
export interface TomographyOverlayOptions {
  parts: ModelPart[];
  /** Explicit uniform conversion after partMatrix; workspace is already registered to LPS. */
  mmPerUnit: number | null;
  registrations: OverlayRegistration[];
  /** A whole-assembly fit can also place imported meshes whose arch is unresolved. */
  assemblyRegistration?: { partIds: string[]; reviewed: boolean; rmsMm: number };
  restorations?: boolean;
  scans?: boolean;
  /** Local visual review only; unreviewed scan contours are amber and labeled. */
  previewScans?: boolean;
  /** Always pass derived reference IDs here if they share an arch role. */
  excludedPartIds?: string[];
}
export interface TomographyContour {
  partId: string; kind: 'fixture' | 'abutment' | 'crown' | 'scan';
  arch: 'upper' | 'lower' | 'model'; color: string; segments: SliceSegment[];
}
export interface TomographyMeasurement { a: Vec3; b: Vec3 }
export interface TomographyRenderOptions {
  /** Maximum raster dimensions; output fits physical aspect without stretching. */
  width?: number; height?: number;
  canvas?: HTMLCanvasElement;
  overlays?: TomographyOverlayOptions;
  crosshair?: Vec3 | false;
  measurement?: TomographyMeasurement | null;
  annotations?: boolean;
  signal?: AbortSignal;
}
export interface TomographyViewMetadata {
  version: 'local-tomography-view/v1'; volumeId: string;
  plane: TomographyViewSpec['plane']; coordinateSystem: 'LPS'; units: 'mm';
  frame: SliceFrame; width: number; height: number; mmPerPixel: [number, number];
  windowCenter: number; windowWidth: number;
  sampling: 'trilinear'; slab: { method: 'single-plane' | 'mean'; thicknessMm: number };
  complete: boolean; missingSlices: number[]; unavailablePixels: number;
  quantitativeMeasurementsAllowed: boolean;
  orientation: { left: string; right: string; top: string; bottom: string };
  overlays: { method: 'triangle-plane-intersection'; partIds: string[]; scaleMmPerUnit: number | null; registrations: OverlayRegistration[] };
  measurement: { type: 'manual-distance'; distanceMm: number; a: Vec3; b: Vec3 } | null;
  warnings: string[];
}
export interface RenderedTomographyView { canvas: HTMLCanvasElement; metadata: TomographyViewMetadata }
export interface CapturedTomographyView extends RenderedTomographyView { dataUrl: string; base64: string; mediaType: 'image/png' }

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const minus = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scaled = (v: Vec3, s: number): Vec3 => [v[0] * s, v[1] * s, v[2] * s];
function finitePoint(v: Vec3) { return v?.length === 3 && v.every(Number.isFinite); }
function unit(v: Vec3): Vec3 {
  if (!finitePoint(v) || Math.hypot(...v) < 1e-10) throw new Error('A slice direction must be a finite nonzero vector.');
  return scaled(v, 1 / Math.hypot(...v));
}
function positive(value: number, label: string) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive and finite.`);
}
function rasterSize(width: number, height: number) {
  if (![width, height].every(v => Number.isInteger(v) && v > 0 && v <= 8192) || width * height > 16_777_216) {
    throw new Error('Slice raster dimensions must be positive integers, at most 8192 per side and 16 megapixels.');
  }
}

/** Presentation-only window from at most 8192 deterministic samples; never assumes HU. */
export function initialTomographyWindow(volume: TomographyVolume): { windowCenter: number; windowWidth: number; method: 'sampled-1-99-percentiles' | 'volume-range'; sampleCount: number } {
  const count = Math.min(8192, volume.voxels.length), values: number[] = [];
  for (let i = 0; i < count; i++) {
    const index = Math.floor((i + .5) * volume.voxels.length / count);
    const plane = Math.floor(index / (volume.dimensions[0] * volume.dimensions[1]));
    const value = volume.voxels[index];
    if (Number.isFinite(value) && !volume.missingSlices.includes(plane)) values.push(value);
  }
  values.sort((a, b) => a - b);
  let low = values[Math.floor((values.length - 1) * .01)], high = values[Math.ceil((values.length - 1) * .99)];
  let method: 'sampled-1-99-percentiles' | 'volume-range' = 'sampled-1-99-percentiles';
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) { [low, high] = volume.range; method = 'volume-range'; }
  if (!Number.isFinite(low) || !Number.isFinite(high) || high < low) throw new Error('The volume has no finite intensity range to display.');
  return { windowCenter: low + (high - low) / 2, windowWidth: Math.max(1, high - low), method, sampleCount: values.length };
}

/** Native anatomical planes in LPS, independent of acquisition/stack orientation. */
export function getSliceFrame(spec: TomographyViewSpec): SliceFrame {
  if (!finitePoint(spec.center)) throw new Error('Slice center must be a finite LPS point.');
  positive(spec.widthMm, 'Slice width'); positive(spec.heightMm, 'Slice height');
  let normal: Vec3, up: Vec3;
  switch (spec.plane) {
    case 'axial': normal = [0, 0, -1]; up = [0, -1, 0]; break;
    case 'coronal': normal = [0, -1, 0]; up = [0, 0, 1]; break;
    case 'sagittal': normal = [1, 0, 0]; up = [0, 0, 1]; break;
    case 'oblique':
      if (!spec.normal || !spec.up) throw new Error('Oblique views need normal and up vectors.');
      normal = unit(spec.normal); up = unit(spec.up); break;
    default: throw new Error('Unknown slice plane.');
  }
  const rightRaw = cross(up, normal);
  if (Math.hypot(...rightRaw) < 1e-6) throw new Error('Slice up and normal are nearly parallel.');
  const right = unit(rightRaw);
  return { center: [...spec.center], right, up: unit(cross(normal, right)), normal, widthMm: spec.widthMm, heightMm: spec.heightMm };
}

/** Pixel-center convention: integer (0,0) is the center of the top-left pixel. */
export function pixelToPatient(frame: SliceFrame, x: number, y: number, width: number, height: number): Vec3 {
  const u = ((x + .5) / width - .5) * frame.widthMm;
  const v = (.5 - (y + .5) / height) * frame.heightMm;
  return frame.center.map((c, i) => c + frame.right[i] * u + frame.up[i] * v) as Vec3;
}
/** Orthogonal projection; points away from the plane have the same displayed pixel. */
export function patientToPixel(frame: SliceFrame, point: Vec3, width: number, height: number): PixelPoint {
  const delta = minus(point, frame.center);
  return [(dot(delta, frame.right) / frame.widthMm + .5) * width - .5, (.5 - dot(delta, frame.up) / frame.heightMm) * height - .5];
}

/** NaN means outside the volume, padding, or unavailable source data. Never fill gaps. */
export function resliceVolume(volume: TomographyVolume, spec: TomographyViewSpec, width = 512, height = 512): Float32Array {
  rasterSize(width, height);
  const frame = getSliceFrame(spec), pixels = new Float32Array(width * height);
  const slab = spec.slabMm ?? 0;
  if (!Number.isFinite(slab) || slab < 0) throw new Error('Slab thickness must be finite and nonnegative.');
  const steps = slab > 0 ? Math.max(2, Math.ceil(slab / Math.min(...volume.spacing)) + 1) : 1;
  if (steps > 1024) throw new Error('Slab is too thick for the volume spacing.');
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const point = pixelToPatient(frame, x, y, width, height);
    let sum = 0;
    for (let s = 0; s < steps; s++) {
      const d = steps === 1 ? 0 : slab * (s / (steps - 1) - .5);
      const value = sampleVolume(volume, point.map((v, i) => v + frame.normal[i] * d) as Vec3);
      // One missing contributing sample invalidates the pixel, including mean slabs.
      if (!Number.isFinite(value)) { sum = NaN; break; }
      sum += value;
    }
    pixels[y * width + x] = sum / steps;
  }
  return pixels;
}

/** Exact triangle/plane crossings with a numeric tolerance, not vertex proximity. */
export function intersectTrianglePlane(triangle: [Vec3, Vec3, Vec3], plane: Pick<SliceFrame, 'center' | 'normal'>, epsilon = 1e-7): SliceSegment[] {
  if (!finitePoint(plane.center) || !triangle.every(finitePoint)) throw new Error('Plane intersections require finite points.');
  positive(epsilon, 'Intersection tolerance');
  const normal = unit(plane.normal), d = triangle.map(point => dot(minus(point, plane.center), normal));
  const on = d.map(value => Math.abs(value) <= epsilon);
  if (on.every(Boolean)) return [[triangle[0], triangle[1]], [triangle[1], triangle[2]], [triangle[2], triangle[0]]];
  if (d.every(value => value > epsilon) || d.every(value => value < -epsilon)) return [];
  const points: Vec3[] = [];
  const add = (p: Vec3) => { if (!points.some(q => Math.hypot(...minus(p, q)) <= epsilon)) points.push(p); };
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    if (on[i]) add([...triangle[i]]);
    if (!on[i] && !on[j] && (d[i] < 0) !== (d[j] < 0)) {
      const t = d[i] / (d[i] - d[j]);
      add(triangle[i].map((v, k) => v + (triangle[j][k] - v) * t) as Vec3);
    }
  }
  return points.length === 2 ? [[points[0], points[1]]] : [];
}

/** Unindexed triangle soup; coplanar interior edges and duplicate segments cancel. */
export function intersectMeshPlane(positions: ArrayLike<number>, plane: Pick<SliceFrame, 'center' | 'normal'>, epsilon = 1e-7): SliceSegment[] {
  positive(epsilon, 'Intersection tolerance');
  if (!finitePoint(plane.center)) throw new Error('Plane intersections require a finite center.');
  if (positions.length % 9) throw new Error('Contour geometry must contain complete triangles.');
  const segments = new Map<string, { segment: SliceSegment; coplanar: boolean; count: number }>();
  const keyPoint = (p: Vec3) => p.map(v => Math.round(v / epsilon)).join(',');
  const normal = unit(plane.normal);
  for (let i = 0; i < positions.length; i += 9) {
    const triangle: [Vec3, Vec3, Vec3] = [[positions[i], positions[i + 1], positions[i + 2]], [positions[i + 3], positions[i + 4], positions[i + 5]], [positions[i + 6], positions[i + 7], positions[i + 8]]];
    const coplanar = triangle.every(p => Math.abs(dot(minus(p, plane.center), normal)) <= epsilon);
    for (const segment of intersectTrianglePlane(triangle, { center: plane.center, normal }, epsilon)) {
      const key = segment.map(keyPoint).sort().join('|'), previous = segments.get(key);
      if (previous) { previous.count++; previous.coplanar &&= coplanar; }
      else segments.set(key, { segment, count: 1, coplanar });
    }
  }
  return [...segments.values()].filter(entry => !entry.coplanar || entry.count % 2 === 1).map(entry => entry.segment);
}

export function projectSegmentToSlice(segment: SliceSegment, frame: SliceFrame, width: number, height: number): [PixelPoint, PixelPoint] {
  return [patientToPixel(frame, segment[0], width, height), patientToPixel(frame, segment[1], width, height)];
}

/** Apply the exact viewer pose first, then the user's explicit workspace-to-mm scale. */
export function transformPartToPatient(part: ModelPart, mmPerUnit: number): Float64Array {
  positive(mmPerUnit, 'Millimeters per file unit');
  const matrix = partMatrix(part).elements, output = new Float64Array(part.positions.length);
  for (let i = 0; i < output.length; i += 3) {
    const x = part.positions[i], y = part.positions[i + 1], z = part.positions[i + 2];
    const w = matrix[3] * x + matrix[7] * y + matrix[11] * z + matrix[15];
    for (let a = 0; a < 3; a++) output[i + a] = (matrix[a] * x + matrix[a + 4] * y + matrix[a + 8] * z + matrix[a + 12]) / w * mmPerUnit;
  }
  if (!output.every(Number.isFinite)) throw new Error('Mesh pose contains unavailable coordinates.');
  return output;
}

/** Solid, continuous plane intersections of the actual generated/scan triangles. */
export function buildTomographyContours(frame: SliceFrame, options: TomographyOverlayOptions): TomographyContour[] {
  if (options.mmPerUnit === null || !Number.isFinite(options.mmPerUnit) || options.mmPerUnit <= 0) return [];
  const byId = new Map(options.parts.map(part => [part.id, part]));
  const excluded = new Set(options.excludedPartIds ?? []), contours: TomographyContour[] = [];
  for (const part of options.parts) {
    if (!part.visible || part.role === 'bite' || part.reference === 'tomography' || excluded.has(part.id)) continue;
    const parent = part.restoration ? byId.get(part.restoration.parentPartId) : part;
    const arch = parent?.role === 'upper' || parent?.role === 'lower' ? parent.role : 'model';
    if (part.restoration && arch === 'model') continue;
    const registration = arch === 'model'
      ? options.assemblyRegistration?.partIds.includes(part.id) && Number.isFinite(options.assemblyRegistration.rmsMm) ? options.assemblyRegistration : undefined
      : options.registrations.find(record => record.arch === arch && Number.isFinite(record.rmsMm));
    if (!registration || (!registration.reviewed && (part.restoration || !options.previewScans))) continue;
    if (part.restoration ? options.restorations === false : !options.scans) continue;
    const kind = part.restoration?.component ?? 'scan';
    const color = registration.reviewed ? { fixture: '#38bdf8', abutment: '#fbbf24', crown: '#34d399', scan: arch === 'upper' ? '#93c5fd' : arch === 'lower' ? '#c4b5fd' : '#7dd3fc' }[kind] : '#fbbf24';
    const segments = intersectMeshPlane(transformPartToPatient(part, options.mmPerUnit), frame);
    if (segments.length) contours.push({ partId: part.id, kind, arch, color, segments });
  }
  return contours;
}

/** L/P/S with inverse R/A/I; oblique labels include all substantial components. */
export function directionLabel(direction: Vec3): string {
  const v = unit(direction), labels = [['L', 'R'], ['P', 'A'], ['S', 'I']];
  return v.map((value, axis) => ({ value, axis })).filter(item => Math.abs(item.value) > .05)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .map(({ value, axis }) => `${labels[axis][value >= 0 ? 0 : 1]}${Math.abs(value) < .999 ? ` ${Math.abs(value).toFixed(2)}` : ''}`).join(' / ');
}

/** Browser-only; never called by numeric imports or at module initialization. */
export function renderTomographyView(volume: TomographyVolume, spec: TomographyViewSpec, options: TomographyRenderOptions = {}): RenderedTomographyView {
  if (typeof document === 'undefined') throw new Error('Tomography image rendering requires a browser canvas.');
  options.signal?.throwIfAborted();
  positive(spec.windowWidth, 'Window width');
  if (!Number.isFinite(spec.windowCenter)) throw new Error('Window center must be finite.');
  const frame = getSliceFrame(spec), maxWidth = options.width ?? 512, maxHeight = options.height ?? 512;
  rasterSize(maxWidth, maxHeight);
  const scale = Math.min(maxWidth / frame.widthMm, maxHeight / frame.heightMm);
  const width = Math.max(1, Math.round(frame.widthMm * scale)), height = Math.max(1, Math.round(frame.heightMm * scale));
  const canvas = options.canvas ?? document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  canvas.style.aspectRatio = `${frame.widthMm} / ${frame.heightMm}`;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The browser could not create a 2D tomography canvas.');
  const pixels = resliceVolume(volume, spec, width, height), image = context.createImageData(width, height);
  const low = spec.windowCenter - spec.windowWidth / 2;
  let unavailablePixels = 0;
  for (let i = 0; i < pixels.length; i++) {
    const unavailable = !Number.isFinite(pixels[i]);
    const gray = unavailable ? 0 : Math.round(Math.min(1, Math.max(0, (pixels[i] - low) / spec.windowWidth)) * 255);
    if (unavailable) unavailablePixels++;
    // Missing data has a subdued blue checkerboard, distinct from measured black.
    const hatch = (Math.floor((i % width) / 8) + Math.floor(i / width / 8)) % 2;
    image.data.set(unavailable ? [12 + hatch * 8, 22 + hatch * 8, 36 + hatch * 8, 255] : [gray, gray, gray, 255], i * 4);
  }
  context.putImageData(image, 0, 0);
  options.signal?.throwIfAborted();
  const contours = options.overlays ? buildTomographyContours(frame, options.overlays) : [];
  const previewContours = contours.some(contour => contour.arch === 'model' ? !options.overlays?.assemblyRegistration?.reviewed : options.overlays?.registrations.some(record => record.arch === contour.arch && !record.reviewed));
  context.save(); context.beginPath(); context.rect(0, 0, width, height); context.clip();
  context.lineWidth = 1.6; context.lineJoin = 'round'; context.lineCap = 'round';
  for (const contour of contours) {
    context.strokeStyle = contour.color; context.beginPath();
    for (const segment of contour.segments) {
      const [a, b] = projectSegmentToSlice(segment, frame, width, height);
      context.moveTo(a[0] + .5, a[1] + .5); context.lineTo(b[0] + .5, b[1] + .5);
    }
    context.stroke();
  }
  context.restore();
  const quantitative = volume.complete && volume.quantitativeMeasurementsAllowed !== false;
  const measurement = options.measurement && quantitative && [options.measurement.a, options.measurement.b].every(point =>
    finitePoint(point) && Math.abs(dot(minus(point, frame.center), frame.normal)) < 1e-5 && Number.isFinite(sampleVolume(volume, point)))
    ? { type: 'manual-distance' as const, distanceMm: Math.hypot(...minus(options.measurement.a, options.measurement.b)), a: [...options.measurement.a] as Vec3, b: [...options.measurement.b] as Vec3 } : null;
  const orientation = { left: directionLabel(scaled(frame.right, -1)), right: directionLabel(frame.right), top: directionLabel(frame.up), bottom: directionLabel(scaled(frame.up, -1)) };
  if (options.annotations !== false) {
    context.font = `${Math.max(11, Math.round(width / 42))}px system-ui`; context.textBaseline = 'top';
    context.shadowColor = '#000'; context.shadowBlur = 3; context.fillStyle = '#f8fafc';
    context.textAlign = 'center'; context.fillText(orientation.top, width / 2, 8); context.fillText(orientation.bottom, width / 2, height - 20);
    context.textAlign = 'left'; context.fillText(orientation.left, 8, height / 2);
    context.textAlign = 'right'; context.fillText(orientation.right, width - 8, height / 2);
    context.textAlign = 'left'; context.fillText(`${spec.plane === 'oblique' ? 'Oblique LPS' : `${spec.plane[0].toUpperCase()}${spec.plane.slice(1)} LPS`}${spec.slabMm ? ` · mean slab ${spec.slabMm.toFixed(1)} mm` : ' · plane'}`, 8, 8);
    if (!volume.complete) { context.fillStyle = '#fbbf24'; context.fillText('Incomplete preview · measurements disabled', 8, 27); }
    if (previewContours) { context.fillStyle = '#fbbf24'; context.fillText('Amber scan contours · alignment review pending', 8, volume.complete ? 27 : 46); }
    const rulerMm = [1, 2, 5, 10, 20, 50, 100].filter(n => n <= frame.widthMm * .2).at(-1) ?? frame.widthMm / 5;
    const ruler = rulerMm / frame.widthMm * width;
    context.strokeStyle = '#e2e8f0'; context.lineWidth = 1;
    context.beginPath(); context.moveTo(12, height - 36); context.lineTo(12 + ruler, height - 36);
    context.moveTo(12, height - 40); context.lineTo(12, height - 32); context.moveTo(12 + ruler, height - 40); context.lineTo(12 + ruler, height - 32); context.stroke();
    context.fillStyle = '#f8fafc'; context.fillText(`${Number(rulerMm.toPrecision(3))} mm`, 12, height - 27);
    if (options.crosshair !== false) {
      const [x, y] = patientToPixel(frame, options.crosshair ?? frame.center, width, height);
      context.strokeStyle = '#7dd3fc'; context.lineWidth = 1;
      context.beginPath(); context.moveTo(x + .5, 0); context.lineTo(x + .5, height); context.moveTo(0, y + .5); context.lineTo(width, y + .5); context.stroke();
    }
    if (measurement) {
      const a = patientToPixel(frame, measurement.a, width, height), b = patientToPixel(frame, measurement.b, width, height);
      // A measurement belongs to its picked plane; do not imply a projected length is its 3D length.
      if ([measurement.a, measurement.b].every(p => Math.abs(dot(minus(p, frame.center), frame.normal)) < 1e-5)) {
        context.strokeStyle = '#fbbf24'; context.lineWidth = 2; context.beginPath(); context.moveTo(a[0] + .5, a[1] + .5); context.lineTo(b[0] + .5, b[1] + .5); context.stroke();
        for (const p of [a, b]) { context.beginPath(); context.arc(p[0] + .5, p[1] + .5, 3, 0, Math.PI * 2); context.stroke(); }
        context.fillStyle = '#fbbf24'; context.fillText(`Manual ${measurement.distanceMm.toFixed(2)} mm`, Math.min(width - 145, Math.max(8, (a[0] + b[0]) / 2 + 6)), Math.max(30, (a[1] + b[1]) / 2 - 20));
      }
    }
    context.shadowBlur = 0;
  }
  const warnings = [...volume.warnings];
  if (previewContours) warnings.push('Amber scan contours show an unreviewed alignment for visual comparison only.');
  if (!volume.complete) warnings.push('Preview alignment only; incomplete data remains nonquantitative. Landmark RMS is a fit residual, not a measurement of registration accuracy.');
  if (spec.slabMm) warnings.push('Grayscale is a mean slab; solid mesh contours intersect only the central plane.');
  if (unavailablePixels) warnings.push('Blue checkerboard pixels are outside the source data or unavailable; no missing data was interpolated.');
  if (measurement) warnings.push('Manual picked-point distance; not an automatic bone depth or clinical clearance.');
  const metadata: TomographyViewMetadata = {
    version: 'local-tomography-view/v1', volumeId: volume.id, plane: spec.plane, coordinateSystem: 'LPS', units: 'mm', frame,
    width, height, mmPerPixel: [frame.widthMm / width, frame.heightMm / height], windowCenter: spec.windowCenter, windowWidth: spec.windowWidth,
    sampling: 'trilinear', slab: { method: spec.slabMm ? 'mean' : 'single-plane', thicknessMm: spec.slabMm ?? 0 }, complete: volume.complete,
    missingSlices: [...volume.missingSlices], unavailablePixels, quantitativeMeasurementsAllowed: quantitative, orientation,
    overlays: { method: 'triangle-plane-intersection', partIds: contours.map(c => c.partId), scaleMmPerUnit: options.overlays?.mmPerUnit ?? null, registrations: (options.overlays?.registrations ?? []).map(r => ({ ...r })) },
    measurement, warnings,
  };
  return { canvas, metadata };
}

/** Capture evidence through the same grayscale + posed contour + annotation path. */
export function captureTomographyView(volume: TomographyVolume, spec: TomographyViewSpec, options: TomographyRenderOptions = {}): CapturedTomographyView {
  const rendered = renderTomographyView(volume, spec, options), dataUrl = rendered.canvas.toDataURL('image/png');
  const prefix = 'data:image/png;base64,';
  if (!dataUrl.startsWith(prefix) || dataUrl.length <= prefix.length) throw new Error('The browser could not capture this tomography view.');
  return { ...rendered, dataUrl, base64: dataUrl.slice(prefix.length), mediaType: 'image/png' };
}
