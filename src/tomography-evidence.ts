import { z } from 'zod';
import type { TomographyRegistration, TomographyViewSpec, TomographyVolume } from './tomography-types.ts';

export const MAX_TOMOGRAPHY_IMAGES = 8;
export const MAX_TOMOGRAPHY_IMAGE_BYTES = 1.5 * 1024 * 1024;
export const MAX_TOMOGRAPHY_ROUNDS = 3;
export const MAX_TOMOGRAPHY_PIXELS = 1536;
const finite = z.number().finite().min(-1e7).max(1e7);
const positive = finite.positive();
const vec3 = z.tuple([finite, finite, finite]);
const count = z.number().int().min(0).max(100_000_000);
const unit = vec3.refine(v => Math.abs(Math.hypot(...v) - 1) < 1e-4, 'Use a unit direction.');
const matrix = z.array(finite).length(16).refine(m => m[3] === 0 && m[7] === 0 && m[11] === 0 && m[15] === 1, 'Use a column-major affine matrix.');
const volumeId = z.literal('volume-1');
const viewId = z.string().regex(/^view-[1-8]$/);
const dot = (a: number[], b: number[]) => a.reduce((sum, x, i) => sum + x * b[i], 0);
const anatomicalBasis = {
  axial: { normal: [0, 0, -1], up: [0, -1, 0] },
  coronal: { normal: [0, -1, 0], up: [0, 0, 1] },
  sagittal: { normal: [1, 0, 0], up: [0, 0, 1] },
};

export const tomographyViewSpecSchema = z.object({
  plane: z.enum(['axial', 'coronal', 'sagittal', 'oblique']),
  center: vec3,
  normal: unit.optional(),
  up: unit.optional(),
  widthMm: positive.max(2000), heightMm: positive.max(2000),
  windowCenter: finite, windowWidth: positive,
  slabMm: finite.min(0).max(100).optional(),
}).strict().superRefine((spec, ctx) => {
  if (spec.plane === 'oblique' && (!spec.normal || !spec.up)) ctx.addIssue({ code: 'custom', message: 'An oblique view needs its exact normal and up directions.' });
  if (spec.plane !== 'oblique') {
    const basis = anatomicalBasis[spec.plane];
    if ((spec.normal && spec.normal.some((v, i) => Math.abs(v - basis.normal[i]) > 1e-4)) || (spec.up && spec.up.some((v, i) => Math.abs(v - basis.up[i]) > 1e-4))) ctx.addIssue({ code: 'custom', message: 'Anatomical planes must use their declared LPS basis; use oblique for another basis.' });
  }
  if (spec.normal && spec.up && Math.abs(dot(spec.normal, spec.up)) > 1e-4) ctx.addIssue({ code: 'custom', message: 'Normal and up must be perpendicular.' });
});

export const tomographyRegistrationSchema = z.object({
  status: z.enum(['unregistered', 'unconfirmed', 'confirmed']),
  workspaceUnits: z.literal('file units'),
  patientToWorkspace: matrix.nullable(),
}).strict().refine(r => r.status === 'unregistered' ? r.patientToWorkspace === null : r.patientToWorkspace !== null, 'Registration status and transform must agree.');

/** Deliberately has no free-form strings, filenames, DICOM UIDs or patient fields. */
export const tomographySummarySchema = z.object({
  volumeId,
  coordinateSystem: z.literal('LPS'), units: z.literal('mm'),
  dimensions: z.tuple([count.min(1), count.min(1), count.min(1)]),
  spacingMm: z.tuple([positive, positive, positive]), originLpsMm: vec3,
  directionsLps: z.tuple([unit, unit, unit]),
  complete: z.boolean(), missingSlices: count,
  quantitativeMeasurementsAllowed: z.boolean(),
  provenance: z.object({ source: z.literal('local-dicom'), sourceSlices: count, expectedSlices: count, rescaled: z.boolean(), intensityUnits: z.enum(['HU', 'rescaled values']) }).strict(),
  registration: tomographyRegistrationSchema,
}).strict().superRefine((s, ctx) => {
  if ((!s.complete || s.missingSlices > 0) && s.quantitativeMeasurementsAllowed) ctx.addIssue({ code: 'custom', message: 'Incomplete previews cannot support quantitative measurements.' });
  if (s.complete && s.missingSlices > 0) ctx.addIssue({ code: 'custom', message: 'Missing slices require incomplete status.' });
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) if (Math.abs(dot(s.directionsLps[i], s.directionsLps[j])) > 1e-4) ctx.addIssue({ code: 'custom', message: 'Volume axes must be perpendicular.' });
});

/** Check the container, dimensions and allowlisted markers. Reject EXIF, comments and other metadata. */
function jpegDimensions(dataUrl: string): [number, number] | null {
  try {
    const raw = atob(dataUrl.slice('data:image/jpeg;base64,'.length));
    const byte = (i: number) => raw.charCodeAt(i);
    const word = (i: number) => byte(i) * 256 + byte(i + 1);
    if (raw.length > MAX_TOMOGRAPHY_IMAGE_BYTES || word(0) !== 0xffd8 || word(raw.length - 2) !== 0xffd9) return null;
    let dimensions: [number, number] | null = null;
    let entropy = false, sawScan = false;
    for (let pos = 2; pos < raw.length;) {
      if (entropy) {
        while (pos < raw.length) {
          if (byte(pos) !== 0xff) { pos++; continue; }
          const next = byte(pos + 1);
          if (next === 0 || (next >= 0xd0 && next <= 0xd7)) { pos += 2; continue; }
          if (next === 0xff) { pos++; continue; }
          break;
        }
      }
      if (byte(pos++) !== 0xff) return null;
      while (byte(pos) === 0xff) pos++;
      const marker = byte(pos++);
      if (marker === 0xd9) return dimensions && sawScan && pos === raw.length ? dimensions : null;
      const length = word(pos);
      if (length < 2 || pos + length > raw.length) return null;
      entropy = false;
      if (marker === 0xda) {
        if (!dimensions || length < 6) return null;
        sawScan = true; entropy = true;
      } else if (marker === 0xe0) {
        // Canvas encoders emit a JFIF header; thumbnails/extra data are not permitted.
        if (length !== 16 || raw.slice(pos + 2, pos + 7) !== 'JFIF\0' || byte(pos + 14) !== 0 || byte(pos + 15) !== 0) return null;
      } else if (marker === 0xee) {
        if (length !== 14 || raw.slice(pos + 2, pos + 7) !== 'Adobe') return null;
      } else if (![0xc0, 0xc1, 0xc2, 0xc4, 0xdb, 0xdd].includes(marker)) return null;
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (dimensions || length < 8 || ![1, 3, 4].includes(byte(pos + 7)) || length !== 8 + 3 * byte(pos + 7)) return null;
        dimensions = [word(pos + 5), word(pos + 3)];
        if (dimensions.some(n => n < 1 || n > MAX_TOMOGRAPHY_PIXELS)) return null;
      }
      pos += length;
    }
    return null;
  } catch { return null; }
}
const jpeg = z.string().max(Math.ceil(MAX_TOMOGRAPHY_IMAGE_BYTES / 3) * 4 + 23)
  .regex(/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/)
  .refine(value => jpegDimensions(value) !== null, 'Use a bounded metadata-free canvas JPEG.');
const overlay = z.object({
  registration: tomographyRegistrationSchema,
  components: z.array(z.object({
    id: z.string().regex(/^(?:scan-(?:[1-9]|[1-5]\d|6[0-4])|restoration-(?:[1-9]|[1-9]\d|1[0-8]\d|19[0-2])|volume-1)$/),
    kind: z.enum(['mesh', 'restoration', 'threshold-surface']),
    /** Current component-to-workspace pose, column-major, file units. */
    localToWorkspace: matrix,
    thresholdSurface: z.object({ method: z.literal('threshold-isosurface'), threshold: finite, stride: z.number().int().min(1).max(8), effectiveSpacingMm: z.tuple([positive, positive, positive]) }).strict().optional(),
  }).strict()).max(256),
}).strict();
const common = {
  id: viewId, volumeId, dataUrl: jpeg,
  pixelWidth: z.number().int().min(1).max(MAX_TOMOGRAPHY_PIXELS),
  pixelHeight: z.number().int().min(1).max(MAX_TOMOGRAPHY_PIXELS),
  overlay,
};
export const tomographyCaptureSchema = z.discriminatedUnion('kind', [
  z.object({ ...common, kind: z.literal('slice'), projection: z.literal('orthographic'), spec: tomographyViewSpecSchema,
    /** Exact sample at image pixel (0,0), and one-pixel increments; y increases down. */
    pixelOriginLpsMm: vec3, pixelRightLpsMm: vec3, pixelDownLpsMm: vec3,
    sampling: z.literal('trilinear').optional(), unavailablePixels: count.optional(),
  }).strict(),
  z.object({ ...common, kind: z.literal('3d'), projection: z.enum(['orthographic', 'perspective']),
    coordinateSystem: z.enum(['LPS mm', 'workspace file units']),
    camera: z.object({ position: vec3, target: vec3, up: unit, near: positive, far: positive, verticalFovDegrees: positive.max(179).nullable(), aspect: positive.optional(), workspaceToCamera: z.array(finite).length(16).optional(), projectionMatrix: z.array(finite).length(16).optional() }).strict(),
    /** Pixel (0,0) and axes on the camera-target plane, not a depth-independent perspective scale. */
    referencePlane: z.object({ origin: vec3, pixelRight: vec3, pixelDown: vec3, units: z.enum(['mm', 'file units']) }).strict(),
  }).strict(),
]).superRefine((capture, ctx) => {
  const size = jpegDimensions(capture.dataUrl);
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (size && (size[0] !== capture.pixelWidth || size[1] !== capture.pixelHeight)) issue('JPEG dimensions must match exact view metadata.');
  const right = capture.kind === 'slice' ? capture.pixelRightLpsMm : capture.referencePlane.pixelRight;
  const down = capture.kind === 'slice' ? capture.pixelDownLpsMm : capture.referencePlane.pixelDown;
  const rightLength = Math.hypot(...right), downLength = Math.hypot(...down);
  if (!rightLength || !downLength || Math.abs(dot(right, down) / (rightLength * downLength)) > 1e-4) issue('Pixel axes must be nonzero and perpendicular.');
  if (capture.kind === 'slice') {
    const close = (a: number, b: number) => Math.abs(a - b) < 1e-4 * Math.max(1, Math.abs(a), Math.abs(b));
    const basis = capture.spec.plane === 'oblique' ? { normal: capture.spec.normal!, up: capture.spec.up! } : anatomicalBasis[capture.spec.plane];
    if (basis.normal && basis.up) {
      const [u, n] = [basis.up, basis.normal];
      const expectedRight = [u[1] * n[2] - u[2] * n[1], u[2] * n[0] - u[0] * n[2], u[0] * n[1] - u[1] * n[0]];
      if (right.some((v, i) => !close(v / rightLength, expectedRight[i])) || down.some((v, i) => !close(v / downLength, -u[i]))) issue('Pixel axes must agree with the exact LPS plane basis.');
    }
    const center = capture.pixelOriginLpsMm.map((v, i) => v + right[i] * (capture.pixelWidth - 1) / 2 + down[i] * (capture.pixelHeight - 1) / 2);
    if (!center.every((v, i) => close(v, capture.spec.center[i])) || !close(rightLength * capture.pixelWidth, capture.spec.widthMm) || !close(downLength * capture.pixelHeight, capture.spec.heightMm)) issue('Pixel coordinates must agree with the slice center and field of view.');
    if (capture.unavailablePixels !== undefined && capture.unavailablePixels > capture.pixelWidth * capture.pixelHeight) issue('Unavailable pixel count exceeds the raster.');
  }
  if (capture.kind === '3d') {
    if (capture.camera.near >= capture.camera.far) issue('Camera clipping planes must be ordered.');
    if ((capture.projection === 'perspective') !== (capture.camera.verticalFovDegrees !== null)) issue('Perspective cameras require their exact field of view.');
    if (capture.referencePlane.units !== (capture.coordinateSystem === 'LPS mm' ? 'mm' : 'file units')) issue('Camera and reference plane units must agree.');
  }
});

export const tomographyEvidenceSchema = z.object({
  sharing: z.literal('rendered-images'), summary: tomographySummarySchema,
  views: z.array(tomographyCaptureSchema).max(MAX_TOMOGRAPHY_IMAGES),
  canRequestViews: z.boolean(),
}).strict().superRefine((evidence, ctx) => {
  if (new Set(evidence.views.map(v => v.id)).size !== evidence.views.length) ctx.addIssue({ code: 'custom', message: 'View identities must be unique.' });
  for (const view of evidence.views) if (JSON.stringify(view.overlay.registration) !== JSON.stringify(evidence.summary.registration)) ctx.addIssue({ code: 'custom', message: 'Capture registration must match this snapshot.' });
});
export const tomographyContinuationSchema = z.object({
  round: z.number().int().min(1).max(MAX_TOMOGRAPHY_ROUNDS),
  viewId, spec: tomographyViewSpecSchema,
  analysis: z.string().max(8000),
}).strict();
export type TomographySummary = z.infer<typeof tomographySummarySchema>;
export type TomographyCapture = z.infer<typeof tomographyCaptureSchema>;
export type TomographyEvidence = z.infer<typeof tomographyEvidenceSchema>;
export type TomographyContinuation = z.infer<typeof tomographyContinuationSchema>;
export type TomographyCaptureMetadata = TomographyCapture extends infer C ? C extends TomographyCapture ? Omit<C, 'dataUrl' | 'pixelWidth' | 'pixelHeight'> : never : never;

export interface AssistantTomographySource {
  /** Changes whenever volume, current views, component poses or registration changes. Local only. */
  revision: string;
  summary: TomographySummary;
  capture(spec: TomographyViewSpec, signal?: AbortSignal): Promise<TomographyCapture>;
  capture3d?(view: 'current', signal?: AbortSignal): Promise<TomographyCapture>;
  initialViews?: readonly TomographyViewSpec[];
}

export const tomographyLimits = [
  'Only inspected attached images are visible to the assistant; raw DICOM, voxels and other viewport angles remain local.',
  'DICOM LPS geometry is calibrated in mm. Mesh workspace distances remain file units; a registration transform is not independent validation of alignment.',
  'Incomplete previews cannot establish bone height, depth, safety clearance or HU density. Even complete images do not validate HU density, diagnosis or clinical safety.',
  'A false quantitativeMeasurementsAllowed flag prohibits quantitative conclusions. Unavailable image pixels are missing coverage or padding, not observed tissue.',
  'Image distances and threshold surfaces are not reviewed segmentation. Perspective scale applies only on the stated camera reference plane.',
  'Restoration overlays are visual design evidence; unconfirmed registration cannot establish anatomical alignment. Tools cannot change implants or restorations.',
] as const;

export function buildTomographySummary(volume: TomographyVolume, registration?: TomographyRegistration | null): TomographySummary {
  return tomographySummarySchema.parse({
    volumeId: 'volume-1', coordinateSystem: 'LPS', units: 'mm', dimensions: volume.dimensions,
    spacingMm: volume.spacing, originLpsMm: volume.origin, directionsLps: volume.directions,
    complete: volume.complete, missingSlices: volume.missingSlices.length,
    quantitativeMeasurementsAllowed: volume.complete && volume.missingSlices.length === 0 && volume.quantitativeMeasurementsAllowed,
    provenance: { source: 'local-dicom', sourceSlices: volume.provenance.sourceSlices, expectedSlices: volume.provenance.expectedSlices, rescaled: volume.provenance.rescaled, intensityUnits: volume.provenance.intensityUnits },
    registration: { status: registration ? registration.confirmed ? 'confirmed' : 'unconfirmed' : 'unregistered', workspaceUnits: 'file units', patientToWorkspace: registration?.patientToWorkspace ?? null },
  });
}

/** Drop encoder metadata (including browser ICC profiles) from freshly rendered JPEGs. */
export function stripCanvasJpegMetadata(dataUrl: string): string {
  const prefix = 'data:image/jpeg;base64,';
  if (!dataUrl.startsWith(prefix)) throw new Error('A rendered JPEG capture is required.');
  const raw = atob(dataUrl.slice(prefix.length));
  const byte = (i: number) => raw.charCodeAt(i);
  if (raw.length > MAX_TOMOGRAPHY_IMAGE_BYTES || byte(0) !== 255 || byte(1) !== 216) throw new Error('The rendered JPEG is invalid or too large.');
  const segments = [raw.slice(0, 2)];
  let pos = 2;
  while (pos < raw.length) {
    const start = pos;
    if (byte(pos++) !== 255) throw new Error('The rendered JPEG has an invalid header.');
    while (byte(pos) === 255) pos++;
    const marker = byte(pos++);
    if (marker === 0xda || marker === 0xd9) { segments.push(raw.slice(start)); break; }
    const length = byte(pos) * 256 + byte(pos + 1);
    if (length < 2 || pos + length > raw.length) throw new Error('The rendered JPEG has an incomplete header.');
    // Retain JFIF's dimension-free header and standard coding tables. Other APP
    // segments and comments are unnecessary for these freshly rendered pixels.
    if (!((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe)) segments.push(raw.slice(start, pos + length));
    pos += length;
  }
  return prefix + btoa(segments.join(''));
}

/** Encode a fresh, annotation-free render canvas. Never use a source DICOM image or patient-label canvas. */
export function captureTomographyCanvas(canvas: HTMLCanvasElement, metadata: TomographyCaptureMetadata): TomographyCapture {
  // Preserve exact pixel coordinates: callers choose a bounded render size rather than silently resizing here.
  if (canvas.width < 1 || canvas.height < 1 || canvas.width > MAX_TOMOGRAPHY_PIXELS || canvas.height > MAX_TOMOGRAPHY_PIXELS) throw new Error('The rendered view exceeds the image limit.');
  const dataUrl = stripCanvasJpegMetadata(canvas.toDataURL('image/jpeg', 0.85));
  return tomographyCaptureSchema.parse({ ...metadata, dataUrl, pixelWidth: canvas.width, pixelHeight: canvas.height });
}

/** Sharing is checked before reading the source or invoking any capture callback. */
export async function prepareTomographyEvidence(source: AssistantTomographySource | undefined, sharing: boolean, signal: AbortSignal): Promise<TomographyEvidence | undefined> {
  signal.throwIfAborted();
  if (!sharing || !source) return undefined;
  const summary = tomographySummarySchema.parse(source.summary);
  const specs = source.initialViews ?? [];
  if (specs.length + (source.capture3d ? 1 : 0) > MAX_TOMOGRAPHY_IMAGES) throw new Error('Too many rendered views.');
  const views: TomographyCapture[] = [];
  for (const spec of specs) {
    const checked = tomographyViewSpecSchema.parse(spec);
    const captured = await source.capture(checked, signal); signal.throwIfAborted();
    const view = tomographyCaptureSchema.parse({ ...captured, id: `view-${views.length + 1}` });
    if (view.kind !== 'slice' || JSON.stringify(view.spec) !== JSON.stringify(checked)) throw new Error('The rendered view does not match the requested coordinates.');
    views.push(view);
  }
  if (source.capture3d) {
    const captured = await source.capture3d('current', signal); signal.throwIfAborted();
    const view = tomographyCaptureSchema.parse({ ...captured, id: `view-${views.length + 1}` });
    if (view.kind !== '3d') throw new Error('The rendered view is not a 3D capture.');
    views.push(view);
  }
  signal.throwIfAborted();
  return tomographyEvidenceSchema.parse({ sharing: 'rendered-images', summary, views, canRequestViews: views.length < MAX_TOMOGRAPHY_IMAGES });
}

export async function captureRequestedTomographyView(source: AssistantTomographySource, evidence: TomographyEvidence, spec: TomographyViewSpec, round: number, signal: AbortSignal): Promise<TomographyEvidence> {
  signal.throwIfAborted();
  if (!evidence.canRequestViews || evidence.views.length >= MAX_TOMOGRAPHY_IMAGES || round < 1 || round > MAX_TOMOGRAPHY_ROUNDS) throw new Error('The additional view limit was reached.');
  const checked = tomographyViewSpecSchema.parse(spec);
  const captured = await source.capture(checked, signal); signal.throwIfAborted();
  const view = tomographyCaptureSchema.parse({ ...captured, id: `view-${evidence.views.length + 1}` });
  if (view.kind !== 'slice' || JSON.stringify(view.spec) !== JSON.stringify(checked)) throw new Error('The rendered view does not match the requested coordinates.');
  return tomographyEvidenceSchema.parse({ ...evidence, views: [...evidence.views, view], canRequestViews: round < MAX_TOMOGRAPHY_ROUNDS && evidence.views.length + 1 < MAX_TOMOGRAPHY_IMAGES });
}
