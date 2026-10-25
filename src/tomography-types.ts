/** DICOM patient coordinates use millimeters in the LPS frame. */
export type Vec3 = [number, number, number];

export interface TomographyVolume {
  /** Random local identity. Never a DICOM UID, filename, or patient identifier. */
  id: string;
  dimensions: [number, number, number];
  spacing: Vec3;
  origin: Vec3;
  /** Unit column, row, and stack axes, in LPS coordinates. */
  directions: [Vec3, Vec3, Vec3];
  /** x-fastest, then y, then z. Missing planes and padding are NaN. */
  voxels: Float32Array;
  range: [number, number];
  missingSlices: number[];
  complete: boolean;
  quantitativeMeasurementsAllowed: boolean;
  warnings: string[];
  provenance: {
    source: 'local-dicom';
    sourceSlices: number;
    expectedSlices: number;
    duplicateSlices: number;
    transferSyntaxes: string[];
    rescaled: boolean;
    intensityUnits: 'HU' | 'rescaled values';
    paddingVoxels: number;
    missingDataPolicy: 'reject' | 'nan-preview';
    interpolated: false;
  };
}

export type TomographyPlane = 'axial' | 'coronal' | 'sagittal' | 'oblique';
export interface TomographyViewSpec {
  plane: TomographyPlane;
  center: Vec3;
  normal?: Vec3;
  up?: Vec3;
  widthMm: number;
  heightMm: number;
  windowCenter: number;
  windowWidth: number;
  slabMm?: number;
}

/** Explicit presentation registration; no inferred conversion to mesh file units. */
export interface TomographyRegistration {
  /** Column-major affine from patient LPS mm to workspace file units. */
  patientToWorkspace: number[];
  confirmed: boolean;
}

export interface TomographySeriesChoice {
  /** Opaque local selection token; contains no original DICOM UID. */
  id: string;
  label: string;
  slices: number;
  dimensions: [number, number];
  modality: 'CT' | 'CBCT' | 'other';
}

export interface TomographySurface {
  volumeId: string;
  /** LPS-oriented millimeters relative to volume.origin, x/y/z per corner. */
  positions: Float32Array;
  normals: Float32Array;
  triangles: number;
  threshold: number;
  stride: number;
  effectiveSpacing: Vec3;
  origin: Vec3;
  complete: boolean;
  quantitativeMeasurementsAllowed: false;
  method: 'threshold-isosurface';
  warnings: string[];
}

export type TomographyStatus = 'empty' | 'importing' | 'select-series' | 'ready' | 'incomplete-preview' | 'extracting' | 'cancelled' | 'error';

export type TomographyWorkerRequest =
  | { type: 'import'; requestId: number; files: File[]; allowIncompletePreview?: boolean; seriesId?: string }
  | { type: 'extract'; requestId: number; volumeId: string; threshold: number; stride: number; volume?: TomographyVolume }
  | { type: 'cancel'; requestId: number }
  | { type: 'clear' };

export type TomographyWorkerResponse =
  | { type: 'progress'; requestId: number; message: string }
  | { type: 'imported'; requestId: number; volume: TomographyVolume; seriesChoices: TomographySeriesChoice[] }
  | { type: 'selection'; requestId: number; seriesChoices: TomographySeriesChoice[]; message: string }
  | { type: 'surface'; requestId: number; surface: TomographySurface }
  | { type: 'error'; requestId: number; message: string; seriesChoices?: TomographySeriesChoice[] };
