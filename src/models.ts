export type Vec3 = [number, number, number];
export type ScanRole = 'model' | 'upper' | 'lower' | 'bite';

export interface ModelPart {
  /** Display-only anatomy; excluded from source picking, collision and case evidence. */
  reference?: 'tomography';
  /** One local import-file identity shared by its disconnected/material parts. */
  sourceFileId?: string;
  /** Original local file bytes, computed in the import worker when available. */
  sourceByteSha256?: string;
  id: string;
  name: string;
  fileName: string;
  positions: Float32Array;
  normals: Float32Array;
  /** Per-corner UV coordinates and linear RGB; source geometry stays unchanged. */
  uvs?: Float32Array;
  colors?: Float32Array;
  /** Per-face gingiva color cue, -1 unknown, otherwise 0..1. Not a diagnosis. */
  tissueScores?: Float32Array;
  texture?: { fileName: string; mimeType: 'image/jpeg' | 'image/png'; bytes: Uint8Array; width?: number; height?: number };
  textureStatus?: 'mapped' | 'unmapped' | 'vertex-colors';
  presentationColor?: string;
  /** Display-only surface finish; does not imply a physical material property. */
  presentationRoughness?: number;
  restoration?: { assemblyId: string; component: 'fixture' | 'abutment' | 'crown'; parentPartId: string; stale?: boolean };
  closed: boolean;
  visible: boolean;
  offset: Vec3;
  triangles: number;
  vertices: number;
  dimensions: Vec3;
  role?: ScanRole;
  roleSource?: 'filename-hypothesis' | 'user-reviewed';
  /** Saved file-to-workspace bite registration, column-major rigid matrix. */
  pose?: number[];
  /** Manual XYZ rotation in degrees, around the posed mesh centre. */
  rotation?: Vec3;
}
