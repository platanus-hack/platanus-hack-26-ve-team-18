import { z } from 'zod';
import { Vector3, type Matrix4 } from 'three';
import { partMatrix } from './pose.ts';
import { FDI_TEETH, isFdiTooth } from './teeth.ts';
import type { ModelPart, Vec3 } from './models.ts';
import type { CollisionReport } from './collision.ts';
import type { BiteAlignmentArchResult } from './bite-alignment.ts';
import type { ToothRecord } from './tooth-types.ts';
import type { Probe } from './viewer.ts';

const finite = z.number().finite();
const nonnegative = finite.nonnegative();
const count = nonnegative.int().max(Number.MAX_SAFE_INTEGER).nullable();
const vector = z.tuple([finite, finite, finite]);
const nullableVector = z.tuple([finite.nullable(), finite.nullable(), finite.nullable()]);
const dimensions = z.tuple([nonnegative.nullable(), nonnegative.nullable(), nonnegative.nullable()]);
const scanId = z.string().max(7).regex(/^scan-(?:[1-9]|[1-5]\d|6[0-4])$/);
const fdi = z.number().int().refine(isFdiTooth, 'Use a permanent FDI tooth number (11–18, 21–28, 31–38, or 41–48).');
const analysisStateSchema = z.enum(['ready', 'running', 'paused', 'unavailable']);

const partSchema = z.object({
  id: scanId,
  role: z.enum(['model', 'upper', 'lower', 'bite']),
  visible: z.boolean(),
  closed: z.boolean(),
  triangles: count,
  vertices: count,
  dimensions,
  dimensionsBasis: z.literal('original file-axis bounds'),
  offset: nullableVector,
  rotationDegrees: nullableVector,
  hasSavedBitePose: z.boolean(),
  hasManualMovement: z.boolean(),
}).strict();

const siteSchema = z.object({ partId: scanId, workspacePoint: vector }).strict();
const toothSchema = z.object({
  fdi,
  status: z.enum(['unreviewed', 'present', 'missing', 'not-scanned']),
  restoration: z.enum(['none', 'crown', 'implant']),
  assignedTriangles: count,
  site: siteSchema.nullable(),
  note: z.string().max(2000).optional(),
}).strict();

const pairSchema = z.object({
  a: scanId,
  b: scanId,
  intersectingTriangles: count,
  penetratingVertices: count,
  nearbyVertices: count,
  minDistance: nonnegative.nullable(),
  maxDepth: nonnegative.nullable(),
}).strict();

const fitReferenceSchema = z.object({
  id: scanId,
  beforeRms: nonnegative.nullable(),
  afterRms: nonnegative.nullable(),
  samples: count,
  beforeCoverage: nonnegative.max(1).nullable(),
  afterCoverage: nonnegative.max(1).nullable(),
}).strict();

/** Bounded transport data: no mesh buffers, source identifiers, or pose matrices. */
export const assistantSnapshotSchema = z.object({
  version: z.literal(1),
  units: z.literal('file units'),
  provenance: z.literal('local mesh metadata and user-entered FDI records'),
  selectedPartId: scanId.nullable(),
  selectedFdi: fdi.nullable(),
  parts: z.array(partSchema).max(64),
  teeth: z.array(toothSchema).length(32),
  notesIncluded: z.boolean(),
  analysisState: analysisStateSchema,
  tolerance: nonnegative.nullable(),
  collision: z.object({
    scope: z.literal('complete visible non-reference scans'),
    comparedPartIds: z.array(scanId).max(64),
    durationMs: nonnegative.nullable(),
    pairs: z.array(pairSchema).max(2016),
  }).strict().nullable(),
  probe: z.object({
    partId: scanId,
    triangleIndex: count,
    vertexIndex: count,
    workspacePoint: vector.nullable(),
    signedSampleDistance: finite.nullable(),
    intersecting: z.boolean().nullable(),
  }).strict().nullable(),
  biteFit: z.object({
    measurementPose: z.literal('saved bite fit, not current manual pose'),
    matchRadius: nonnegative.nullable(),
    manualMovementExists: z.boolean(),
    arches: z.array(z.object({
      id: scanId,
      beforeRms: nonnegative.nullable(),
      afterRms: nonnegative.nullable(),
      samples: count,
      hasManualMovement: z.boolean(),
      references: z.array(fitReferenceSchema).max(64),
    }).strict()).max(64),
  }).strict(),
}).strict().superRefine((snapshot, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  const ids = new Set(snapshot.parts.map(part => part.id));
  if (snapshot.parts.some((part, i) => part.id !== `scan-${i + 1}`)) issue('Part identifiers must be sequential anonymized scan identifiers.');
  const requirePart = (id: string) => { if (!ids.has(id)) issue('A reference does not belong to this snapshot.'); };
  if (snapshot.selectedPartId) requirePart(snapshot.selectedPartId);
  if (new Set(snapshot.teeth.map(tooth => tooth.fdi)).size !== 32) issue('Include each permanent FDI position exactly once.');
  for (const tooth of snapshot.teeth) {
    if (tooth.site) requirePart(tooth.site.partId);
    if (!snapshot.notesIncluded && tooth.note !== undefined) issue('Notes require explicit inclusion.');
  }
  if ((snapshot.analysisState === 'ready') !== (snapshot.collision !== null)) issue('Only a ready analysis may include a collision report.');
  if (snapshot.collision) {
    const compared = new Set(snapshot.collision.comparedPartIds);
    if (compared.size !== snapshot.collision.comparedPartIds.length) issue('Compared scans must be unique.');
    const eligible = snapshot.parts.filter(part => part.visible && part.role !== 'bite');
    if (eligible.length < 2 || eligible.length !== compared.size || eligible.some(part => !compared.has(part.id))) issue('Collision scope must match the visible non-reference scans.');
    const pairs = new Set<string>();
    for (const pair of snapshot.collision.pairs) {
      if (!compared.has(pair.a) || !compared.has(pair.b) || pair.a === pair.b) issue('Collision pairs must reference distinct compared scans.');
      const key = [pair.a, pair.b].sort().join(':');
      if (pairs.has(key)) issue('Collision pairs must be unique.');
      pairs.add(key);
    }
  }
  if (snapshot.probe) {
    requirePart(snapshot.probe.partId);
    if (!snapshot.collision?.comparedPartIds.includes(snapshot.probe.partId)
      && (snapshot.probe.signedSampleDistance !== null || snapshot.probe.intersecting !== null)) issue('Probe collision metrics require a ready comparison for that scan.');
  }
  for (const arch of snapshot.biteFit.arches) {
    requirePart(arch.id);
    for (const reference of arch.references) requirePart(reference.id);
  }
});

export type AssistantSnapshot = z.infer<typeof assistantSnapshotSchema>;
export type AssistantAnalysisState = z.infer<typeof analysisStateSchema>;

export interface AssistantSnapshotInput {
  parts: readonly ModelPart[];
  selected: string | null;
  selectedFdi?: number;
  probe: Probe | null;
  report: CollisionReport | null;
  tolerance: number;
  analysisState: AssistantAnalysisState;
  teeth: Readonly<Record<number, ToothRecord>>;
  counts: Readonly<Record<number, number>>;
  fitSummary: readonly BiteAlignmentArchResult[];
  fitRadius: number | null;
  includeNotes?: boolean;
}

const finiteOrNull = (value: number | null | undefined): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const positiveOrNull = (value: number | null | undefined): number | null => typeof value === 'number' && value >= 0 ? finiteOrNull(value) : null;
const countOrNull = (value: number | undefined): number | null => Number.isSafeInteger(value) ? positiveOrNull(value) : null;
const coverageOrNull = (value: number): number | null => value <= 1 ? positiveOrNull(value) : null;
const components = (value: Vec3): [number | null, number | null, number | null] => value.map(finiteOrNull) as [number | null, number | null, number | null];
const pointOrNull = (value: Vec3): Vec3 | null => value.every(Number.isFinite) ? [...value] : null;
const manuallyMoved = (part: ModelPart) => part.offset.some(value => value !== 0) || (part.rotation ?? [0, 0, 0]).some(value => value !== 0);

export function buildAssistantSnapshot({
  parts, selected, selectedFdi, probe, report, tolerance, analysisState, teeth, counts,
  fitSummary, fitRadius, includeNotes = false,
}: AssistantSnapshotInput): AssistantSnapshot {
  if (parts.length > 64) throw new RangeError('Assistant snapshots support at most 64 scans.');
  if (new Set(parts.map(part => part.id)).size !== parts.length) throw new RangeError('Scans must have distinct local identifiers.');
  const ids = new Map(parts.map((part, i) => [part.id, `scan-${i + 1}`]));
  const sources = new Map(parts.map(part => [part.id, part]));
  const matrices = new Map<string, Matrix4>();
  // partMatrix may inspect bounds for manual rotations; call once per anchored part only.
  const siteFor = (site: ToothRecord['site']): AssistantSnapshot['teeth'][number]['site'] => {
    if (!site || !pointOrNull(site.point)) return null;
    const part = sources.get(site.partId), partId = ids.get(site.partId);
    if (!part || !partId) return null;
    let matrix = matrices.get(site.partId);
    if (!matrix) { matrix = partMatrix(part); matrices.set(site.partId, matrix); }
    const workspacePoint = pointOrNull(new Vector3(...site.point).applyMatrix4(matrix).toArray());
    return workspacePoint ? { partId, workspacePoint } : null;
  };
  const identifiers = includeNotes
    ? [...new Set(parts.flatMap(part => [part.fileName, part.name, part.id]).filter(Boolean))].sort((a, b) => b.length - a.length)
    : [];
  const redactNote = (note: string): string => {
    for (const identifier of identifiers) note = note.split(identifier).join('[redacted]');
    return note.slice(0, 2000);
  };
  const compared = parts.filter(part => part.visible && part.role !== 'bite');
  const comparedIds = new Set(compared.map(part => part.id));
  const usableReport = analysisState === 'ready' && report !== null && compared.length >= 2
    && report.parts.length === compared.length
    && new Set(report.parts.map(part => part.id)).size === compared.length
    && report.parts.every(part => comparedIds.has(part.id))
    && report.pairs.every(pair => comparedIds.has(pair.a) && comparedIds.has(pair.b) && pair.a !== pair.b);
  const currentState = analysisState === 'ready' && !usableReport ? 'unavailable' : analysisState;
  const probeId = probe ? ids.get(probe.id) : undefined;
  const probeCompared = usableReport && probe !== null && comparedIds.has(probe.id);

  return assistantSnapshotSchema.parse({
    version: 1,
    units: 'file units',
    provenance: 'local mesh metadata and user-entered FDI records',
    selectedPartId: selected ? ids.get(selected) ?? null : null,
    selectedFdi: selectedFdi !== undefined && isFdiTooth(selectedFdi) ? selectedFdi : null,
    parts: parts.map(part => ({
      id: ids.get(part.id)!, role: part.role ?? 'model', visible: part.visible, closed: part.closed,
      triangles: countOrNull(part.triangles),
      vertices: countOrNull(part.vertices),
      dimensions: part.dimensions.map(positiveOrNull), dimensionsBasis: 'original file-axis bounds',
      offset: components(part.offset), rotationDegrees: components(part.rotation ?? [0, 0, 0]),
      hasSavedBitePose: part.pose !== undefined, hasManualMovement: manuallyMoved(part),
    })),
    teeth: FDI_TEETH.map(fdi => {
      const record = teeth[fdi];
      return {
        fdi, status: record?.status ?? 'unreviewed', restoration: record?.restoration ?? 'none',
        assignedTriangles: countOrNull(counts[fdi] ?? 0), site: siteFor(record?.site),
        ...(includeNotes ? { note: redactNote(record?.note ?? '') } : {}),
      };
    }),
    notesIncluded: includeNotes,
    analysisState: currentState,
    tolerance: positiveOrNull(tolerance),
    collision: usableReport ? {
      scope: 'complete visible non-reference scans', comparedPartIds: compared.map(part => ids.get(part.id)!),
      durationMs: positiveOrNull(report.durationMs),
      pairs: report.pairs.map(pair => ({
        a: ids.get(pair.a)!, b: ids.get(pair.b)!,
        intersectingTriangles: countOrNull(pair.intersectingTriangles),
        penetratingVertices: countOrNull(pair.penetratingVertices), nearbyVertices: countOrNull(pair.nearbyVertices),
        minDistance: positiveOrNull(pair.minDistance), maxDepth: positiveOrNull(pair.maxDepth),
      })),
    } : null,
    probe: probe && probeId ? {
      partId: probeId, triangleIndex: countOrNull(probe.face), vertexIndex: countOrNull(probe.vertex),
      workspacePoint: pointOrNull(probe.position),
      signedSampleDistance: probeCompared ? finiteOrNull(probe.distance) : null,
      intersecting: probeCompared ? probe.intersecting : null,
    } : null,
    biteFit: {
      measurementPose: 'saved bite fit, not current manual pose', matchRadius: positiveOrNull(fitRadius),
      manualMovementExists: parts.some(manuallyMoved),
      arches: fitSummary.filter(arch => ids.has(arch.id)).map(arch => ({
        id: ids.get(arch.id)!, beforeRms: positiveOrNull(arch.beforeRms), afterRms: positiveOrNull(arch.afterRms),
        samples: countOrNull(arch.samples), hasManualMovement: manuallyMoved(sources.get(arch.id)!),
        references: arch.references.filter(reference => ids.has(reference.id)).map(reference => ({
          id: ids.get(reference.id)!, beforeRms: positiveOrNull(reference.beforeRms), afterRms: positiveOrNull(reference.afterRms),
          samples: countOrNull(reference.samples), beforeCoverage: coverageOrNull(reference.beforeCoverage), afterCoverage: coverageOrNull(reference.afterCoverage),
        })),
      })),
    },
  });
}

/** Kept independent of the AI SDK so the UI can display the same tool descriptions. */
export const assistantToolCatalog = [
  { name: 'getModelInventory', title: 'Model inventory', description: 'Read anonymized mesh roles, visibility, file-axis dimensions, and current manual movement.', example: 'What scans are loaded and which have been moved?' },
  { name: 'getToothChart', title: 'FDI tooth chart', description: 'Read all 32 user-entered permanent FDI records, or one FDI position. Unreviewed does not mean missing.', example: 'Show the recorded status and restoration intent for FDI 36.' },
  { name: 'inspectImplantSite', title: 'Site marker', description: 'Inspect a user-entered FDI record and its workspace surface marker; no bone or implant suitability assessment.', example: 'What information and marker are recorded for FDI 36?' },
  { name: 'getCollisionReport', title: 'Collision report', description: 'Read only ready aggregate triangle intersections and vertex-sampled distances for visible non-reference scans.', example: 'Explain the current mesh intersections and sampled gaps.' },
  { name: 'getBiteFitReport', title: 'Saved bite fit', description: 'Read saved fit RMS, sample coverage, and references, with a warning when manual movement exists.', example: 'Summarize the saved bite fit and its limitations.' },
  { name: 'inspectSurfaceProbe', title: 'Surface probe', description: 'Read the selected workspace corner and its available signed sampled distance.', example: 'Explain the currently selected surface probe.' },
  { name: 'measureSiteDistance', title: 'Marker distance', description: 'Measure Euclidean workspace distance between two user-placed FDI markers in file units; not width or clearance.', example: 'Measure the marker-to-marker distance between FDI 35 and 36.' },
  { name: 'getPlanningChecklist', title: 'Review checklist', description: 'List recorded-data gaps and items for clinician review without diagnosis, implant sizing, or automatic movement.', example: 'Which case records and mesh limitations still need review?' },
  { name: 'getTomographyInventory', title: 'Shared tomography inventory', description: 'Read explicitly shared rendered image metadata, calibrated LPS geometry, completeness and registration status. No raw volume access.', example: 'Which tomography views are available to inspect?' },
  { name: 'inspectTomographyView', title: 'Rendered image inspection', description: 'Inspect one opted-in slice or 3D JPEG with exact view and overlay metadata.', example: 'Inspect the shared sagittal view and describe the visible restoration alignment.' },
  { name: 'requestTomographyView', title: 'Request local slice', description: 'When image sharing is enabled, request an additional precise local slice within three bounded continuation rounds.', example: 'Inspect an oblique section at an exact LPS center and orientation.' },
  { name: 'getDentalDesignGuidance', title: 'Dental design guidance', description: 'Read an allowlisted repository reference on clinical considerations, geometry workflow, the concept kit, AI SDK integration, or sources. General design knowledge, not patient observations; cannot generate or place meshes.', example: 'What evidence is needed to discuss crown shape, bite, or implant depth and size?' },
] as const;
