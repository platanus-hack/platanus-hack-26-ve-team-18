import type { Vec3 } from './models';
import type { ReactNode } from 'react';
import type { AutoToothOverlay } from './auto-tooth-types';

export type ToothStatus = 'unreviewed' | 'present' | 'missing' | 'not-scanned';
export type RestorationIntent = 'none' | 'crown' | 'implant';
/** A point on an original imported triangle, in that part's file coordinates. */
export interface SurfaceAnchor { partId: string; face: number; point: Vec3 }
export interface ToothRecord {
  status: ToothStatus;
  restoration: RestorationIntent;
  note: string;
  site?: SurfaceAnchor;
}
export interface ToothCase {
  reviewedMask?: Record<string, Uint8Array>;

  labels: Record<string, Uint8Array>;
  teeth: Record<number, ToothRecord>;
}
export type ToothTool = 'inspect' | 'auto' | 'paint' | 'erase' | 'exclude' | 'boundary' | 'seed' | 'site';
export interface ToothDraft { partId: string; faces: Uint32Array }
export interface ToothBoundaryPath { partId: string; positions: Float32Array }
export interface ToothViewState {
  focusedPlanningSiteId?: string | null;
  planningSites?: import('./missing-sites').SiteHypothesis[];
  autoOverlay?: AutoToothOverlay | null;
  enabled: boolean;
  activeTooth: number;
  tool: ToothTool;
  brushRadius: number;
  isolate: boolean;
  labels: Record<string, Uint8Array>;
  draft: ToothDraft | null;
  boundary: SurfaceAnchor[];
  boundaryPath: ToothBoundaryPath | null;
  seed: SurfaceAnchor | null;
  sites: { tooth: number; anchor: SurfaceAnchor }[];
  editablePartIds: string[];
}
export type ToothEditEvent =
  | { kind: 'pick'; tool: ToothTool; hit: SurfaceAnchor }
  | { kind: 'stroke'; tool: ToothTool; hits: SurfaceAnchor[] };

export interface ToothPanelProps {
  autoPanel?: ReactNode;
  viewport?: ReactNode;
  selectedTooth: number;
  teeth: Record<number, ToothRecord>;
  counts: Record<number, number>;
  hasScans: boolean;
  activePartName: string | null;
  activePartRole: string | null;
  editable: boolean;
  enabled: boolean;
  tool: ToothTool;
  brushRadius: number;
  isolate: boolean;
  busy: boolean;
  processing?: boolean;
  error: string;
  notice: string;
  boundaryCount: number;
  hasSeed: boolean;
  draftCount: number;
  canUndo: boolean;
  canRedo: boolean;
  onSelect: (tooth: number) => void;
  onRecord: (patch: Partial<ToothRecord>) => void;
  onEnabled: (value: boolean) => void;
  onTool: (tool: ToothTool) => void;
  onBrushRadius: (value: number) => void;
  onIsolate: (value: boolean) => void;
  onPreview: () => void;
  onConfirm: () => void;
  onClearDraft: () => void;
  onRemoveBoundaryPoint: () => void;
  onClearTooth: () => void;
  onClearSite: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onCancel: () => void;
  onSave: () => void;
  onLoad: () => void;
}
