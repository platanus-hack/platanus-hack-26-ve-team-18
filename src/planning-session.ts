/**
 * Atomic, local-only planning persistence. Original patient scan buffers are never saved.
 *
 * createPlanningSession({ parts, teeth, assemblies, draft, ...settings }) returns
 * a JSON-safe file. readPlanningSession(unknown, importedParts) validates the
 * entire file and source geometry, then returns one replacement state. The
 * caller must apply that state together; neither helper mutates the workspace.
 * Draft hypotheses are kept separate from the user-reviewed ToothCase.
 */
import { z } from 'zod';
import { Matrix4, Triangle, Vector3 } from 'three';
import type { ModelPart } from './models.ts';
import type { ToothCase } from './tooth-types.ts';
import type { RestorationAssembly, RestorationSpec, RestorationFitReport } from './restoration-types.ts';
import { acceptsFitCandidate } from './restoration-fit-selection.ts';
import { validateRestorationSpec } from './restoration-geometry.ts';
import { restorationGuardrailsSchema, restorationQualityContextSchema, restorationQualitySchema } from './restoration-quality-schema.ts';
import { evaluateRestorationQuality, type RestorationQualityReport } from './restoration-quality.ts';
import type { CasePlanningRequest, CasePlanningResult } from './case-planning-types.ts';
import type { AutoToothScan } from './auto-tooth-types.ts';
import type { CasePreparationResult, PreparedCaseSource } from './case-preparation-types.ts';
import { createToothSession, geometrySignature, readToothSession } from './tooth-session.ts';
import { isFdiTooth, toothArch } from './teeth.ts';
import { partMatrix } from './pose.ts';
import { isPlanningBase64, MAX_PLANNING_IMAGE_BASE64_LENGTH } from './case-planning-schema.ts';
import { planningExecutionSchema } from './case-planning-schema.ts';
import { workflowRunSchema, correctionEventSchema } from './case-workflow.ts';
import { CROWN_THETA, CROWN_WALL, CROWN_RINGS, validateCrownShape, toothClassOf } from './crown-anatomy.ts';

const MAX_PARTS = 64;
const MAX_TRIANGLES = 2_000_000;
const MAX_COORDINATES = MAX_TRIANGLES * 9;
const finite = z.number().finite();
const nonnegative = finite.nonnegative();
const positive = finite.positive();
const count = z.number().int().min(0).max(MAX_TRIANGLES);
const confidence = finite.min(0).max(1);
const id = z.string().min(1).max(160);
const text = z.string().max(4000);
const strings = z.array(text).max(128);
const fdi = z.number().int().refine((value): boolean => isFdiTooth(value), 'Invalid permanent FDI position.');
const vec = z.tuple([finite, finite, finite]);
const interval = z.tuple([finite, finite]);
const arch = z.enum(['upper', 'lower']);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const date = z.iso.datetime();
const sign = z.union([z.literal(1), z.literal(-1)]);
const frame = z.strictObject({ origin: vec, u: vec, v: vec, up: vec }).refine(value => {
  const u = new Vector3(...value.u), v = new Vector3(...value.v), up = new Vector3(...value.up);
  return [u, v, up].every(axis => Math.abs(axis.lengthSq() - 1) < 1e-8)
    && Math.abs(u.dot(v)) < 1e-8 && Math.abs(u.dot(up)) < 1e-8 && Math.abs(v.dot(up)) < 1e-8
    && Math.abs(u.clone().cross(v).dot(up) - 1) < 1e-8;
}, 'A restoration frame must be right-handed and orthonormal.');
const matrix = z.array(finite).length(16).refine(value => {
  const columns = [0, 4, 8].map(offset => new Vector3(value[offset], value[offset + 1], value[offset + 2]));
  return value[3] === 0 && value[7] === 0 && value[11] === 0 && value[15] === 1
    && columns.every(column => Math.abs(column.lengthSq() - 1) < 1e-8)
    && Math.abs(columns[0].dot(columns[1])) < 1e-8 && Math.abs(columns[0].dot(columns[2])) < 1e-8
    && Math.abs(columns[1].dot(columns[2])) < 1e-8 && Math.abs(new Matrix4().fromArray(value).determinant() - 1) < 1e-8;
}, 'fileToWorkspace must be a finite rigid transform without scale or reflection.');
const anchor = z.strictObject({ partId: id, face: count, point: vec });
const savedAnchor = z.strictObject({ partKey: id, face: count, point: vec });
const parameters = z.strictObject({
  fixture: z.strictObject({ radius: positive, length: positive, depth: nonnegative, taper: finite.min(0).max(.95) }),
  abutment: z.strictObject({ radius: positive, height: positive, emergenceRadius: positive, angleX: finite.min(-80).max(80), angleY: finite.min(-80).max(80) }),
  crown: z.strictObject({ width: positive, depth: positive, height: positive, cuspHeight: nonnegative, rotation: finite.min(-360).max(360) }),
});
const componentAppearance = z.strictObject({ color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), roughness: confidence.optional() });
const contourScale = finite.min(.5).max(1.5);
const float32 = finite.refine(value => Number.isFinite(Math.fround(value)), 'Coordinate exceeds Float32 range.');
const shape = z.strictObject({
  version: z.literal(1), toothClass: z.enum(['incisor', 'canine', 'premolar', 'molar']), arch, digit: z.number().int().min(1).max(8),
  source: z.strictObject({ kind: z.enum(['patient-donor', 'procedural-template']), donorFdi: fdi.nullable(), donorPartId: id.nullable(), donorToothId: count.nullable(), mirrored: z.boolean(), faceCount: count, provenance: text,
    selection: z.strictObject({ faces: z.array(count).min(60).max(120_000), frame: z.strictObject({ origin: vec, mesial: vec, buccal: vec, occlusal: vec }) }).optional() }),
  dims: z.tuple([positive, positive, positive]), rim: z.array(float32).length(CROWN_THETA), rimZ: z.array(float32).length(CROWN_THETA),
  wall: z.array(float32).length(CROWN_WALL * CROWN_THETA), occlusal: z.array(float32).length(CROWN_RINGS * CROWN_THETA), apex: finite,
});
const specSchema = z.strictObject({
  version: z.literal('implant-assembly/v1'), fdi, parentPartId: id, frame, parameters,
  draftIdentity: z.strictObject({ siteId: id, templateFdi: fdi, alternatives: z.array(fdi).max(32), basis: text }).optional(),
  anatomy: z.enum(['incisor', 'canine', 'premolar', 'molar']), crownShape: shape.optional(), anatomicalSigns: z.strictObject({ mesial: sign, buccal: sign }).optional(),
  contour: z.strictObject({ cervicalScale: contourScale.optional(), occlusalScale: contourScale.optional() }).optional(),
  appearance: z.strictObject({ fixture: componentAppearance.optional(), abutment: componentAppearance.optional(), crown: componentAppearance.optional() }).optional(),
  editProvenance: z.strictObject({ actor: z.enum(['manual', 'agent']), reason: z.string().trim().min(1).max(500) }).optional(),
  qualityContext: restorationQualityContextSchema.optional(),
  provenance: z.enum(['hypothesized', 'clinician-entered']), units: z.literal('file units (u)'), source: text.min(1),
  siteEvidence: z.strictObject({ method: z.enum(['reviewed-surface', 'bounded-gap']), partIds: z.array(id).min(1).max(MAX_PARTS), fdis: z.array(fdi).max(32), surface: anchor,
    bounds: interval.optional(), slot: z.strictObject({ index: count, count: count.refine(value => value > 0) }).optional() }).optional(),
}).refine(value => !value.editProvenance || value.provenance === (value.editProvenance.actor === 'manual' ? 'clinician-entered' : 'hypothesized'),
  'Restoration edit provenance must match its manual or agent actor.');
const surfaceMeasurement = z.strictObject({
  id, role: z.enum(['adjacent', 'antagonist', 'tissue', 'source-arch', 'other-tooth']), side: z.enum(['mesial', 'distal']).optional(), targetGap: nonnegative, weight: positive,
  targetProvenance: text.optional(),
  targetTriangles: count, samples: count, sampledMinDistance: nonnegative, sampledRmsGapError: nonnegative, nearSamples: count,
  intersectingTriangles: count, intersectionTestedTriangles: count, verificationRetainedTriangles: count.optional(), intersectionComplete: z.boolean(),
  sampledMedianDistance: nonnegative.optional(), sampledP95Distance: nonnegative.optional(), sampledMaxGapDeficit: nonnegative.optional(), sampledRegionArea: nonnegative.optional(), intersectionTolerance: nonnegative.optional(),
  occlusalRaySamples: count.optional(), occlusalRayHits: count.optional(), sampledOcclusalGap: nonnegative.nullable().optional(), sampledOcclusalGapError: nonnegative.nullable().optional(),
  sampledRegionTriangles: count.optional(), transverseCrossingTriangles: count.optional(), touchingOrAmbiguousTriangles: count.optional(), intersectionPairTests: z.number().int().min(0).max(200_000).optional(),
});
const measurement = z.strictObject({ score: nonnegative, objectiveScore: nonnegative, morphologyPenalty: nonnegative, surfaces: z.array(surfaceMeasurement).max(128) });
const plane = z.strictObject({ origin: vec, normal: vec });
const fitReport = z.strictObject({
  selectionPolicy: z.enum(['score-with-contact-evidence/v1', 'quality-gated/v1']).optional(),
  version: z.literal('restoration-fit/v1'), status: z.enum(['improved', 'unchanged']), termination: z.enum(['candidate-budget', 'time-budget', 'converged', 'no-surfaces']),
  before: measurement, after: measurement, candidates: count, durationMs: nonnegative, units: z.literal('file units (u)'),
  candidateAttempts: count.optional(), invalidCandidates: count.optional(), bestCandidate: count.optional(),
  quality: z.strictObject({ initial: restorationQualitySchema, final: restorationQualitySchema, rounds: z.number().int().min(0).max(4), stopReason: z.enum(['checks-passed', 'budget', 'no-admissible-revision', 'measurement-only']) }).optional(),
  anatomyCandidates: z.array(shape).min(1).max(2).optional(),
  referencePlanes: z.strictObject({ site: plane, fixturePlatform: plane, fixtureApex: plane, crownBase: plane, interpretation: z.literal('generic-contiguous-envelopes; no compatible implant connection') }),
  sampling: z.strictObject({ method: z.literal('deterministic-area-stratified-triangle-barycentres'), direction: z.literal('restoration-to-target'), requestedPerSurface: count, fullResolutionDistanceTargets: z.literal(true), maximumIntersectionTargetTriangles: count, maximumVerificationRegionTriangles: count.optional() }), limits: strings,
});
const historyEntry = z.strictObject({ candidate: count, parameters, measurement, accepted: z.boolean(), quality: restorationQualitySchema.optional(), anatomyCandidate: z.number().int().min(0).max(1).optional(), revision: z.strictObject({ round: z.number().int().min(1).max(4), reason: text }).optional() });
const component = z.enum(['fixture', 'abutment', 'crown']);
const mesh = z.strictObject({
  id, name: text, fileName: text, component, geometrySha256: sha, positions: z.array(float32).min(9).max(MAX_COORDINATES), normals: z.array(float32).min(9).max(MAX_COORDINATES),
  triangles: count.refine(value => value > 0), vertices: count.refine(value => value > 0), dimensions: z.tuple([nonnegative, nonnegative, nonnegative]),
  closed: z.boolean(), visible: z.boolean(), fileToWorkspace: matrix, presentationColor: z.string().max(80).optional(), presentationRoughness: confidence.optional(),
}).refine(value => value.positions.length === value.triangles * 9 && value.normals.length === value.positions.length && value.vertices <= value.triangles * 3, 'Malformed component mesh arrays.');
const assemblySchema = z.strictObject({ id, spec: specSchema, parts: z.array(mesh).length(3), createdAt: date, warnings: strings,
  draftSite: z.boolean().optional(),
  previousVersions: z.array(z.strictObject({ spec: specSchema, createdAt: date, warnings: strings, fit: fitReport.optional(), candidateHistory: z.array(historyEntry).max(128).optional() })).max(16).optional(),
  fit: fitReport.optional(), candidateHistory: z.array(historyEntry).max(128).optional() }).refine(value => value.parts.every(part => {
    const appearance = value.spec.appearance?.[part.component];
    // Old sessions may carry display colors without an editable appearance spec.
    return (appearance?.color === undefined || part.presentationColor?.toLowerCase() === appearance.color.toLowerCase())
      && (appearance?.roughness === undefined || part.presentationRoughness === appearance.roughness);
  }), 'Component presentation color or roughness does not match its restoration appearance.');
const candidate = z.strictObject({ id: count, faces: z.array(count).min(1).max(MAX_TRIANGLES), seed: z.strictObject({ face: count, point: vec }), centroid: vec, area: nonnegative, height: nonnegative, warnings: strings,
  evidence: z.strictObject({ shoulderProjectedArea: nonnegative, shoulderTissueCost: nonnegative, reliefReference: z.enum(['merge-saddle', 'estimated-base']) }).optional() });
// Detection frames can be presentation axes (method unavailable), unlike restoration frames.
const scan = z.strictObject({ frame: z.strictObject({ origin: vec, up: vec, u: vec, v: vec }), candidates: z.array(candidate).max(128), warnings: strings, unassignedTriangles: count, method: text });
const sourceScan = z.strictObject({ partId: id, scan });
const view = z.strictObject({ id, sourceId: id.nullable(), context: z.enum(['arch', 'occlusion']), label: z.string().max(80), mediaType: z.literal('image/jpeg'), base64: z.string().max(MAX_PLANNING_IMAGE_BASE64_LENGTH).refine(isPlanningBase64) });
const references = z.array(id).max(16);
const resultSchema = z.strictObject({
  revision: id, model: id, summary: text,
  execution: planningExecutionSchema.optional(),
  mappings: z.array(z.strictObject({ sourceId: id, candidateId: count, fdi: fdi.nullable(), needsReview: z.boolean(), reason: text })).max(8192),
  findings: z.array(z.strictObject({ id, fdi: fdi.nullable(), category: z.enum(['identity', 'possible-missing', 'surface-observation', 'restoration-review', 'hygiene-review', 'occlusion-review', 'data-quality']), title: text, detail: text, evidence: references, needsClinicalReview: z.boolean() })).max(64),
  actions: z.array(z.strictObject({ id, fdi: fdi.nullable(), kind: z.enum(['clinical-review', 'hygiene-review', 'restoration-review', 'implant-review']), title: text, rationale: text, evidence: references, prerequisites: strings })).max(64),
  designs: z.array(z.strictObject({ fdi, anatomy: z.enum(['incisor', 'canine', 'premolar', 'molar']), rationale: text })).max(32), limitations: strings,
});
const analysisSchema = z.strictObject({
  version: z.literal(2), method: text, frame: z.strictObject({ origin: vec, up: vec, e1: vec, e2: vec }),
  curve: z.strictObject({ points: z.array(vec).max(10000), s: z.array(finite).max(10000), tangent: z.array(vec).max(10000), lingual: z.array(vec).max(10000), crownLevel: z.array(finite).max(10000), state: z.array(z.enum(['crown', 'low', 'unscanned'])).max(10000) }),
  curveMode: z.enum(['angular', 'linear']), length: nonnegative,
  teeth: z.array(z.strictObject({ id: count, fdi: fdi.nullable(), faces: z.array(count).max(MAX_TRIANGLES), centroid: vec, top: vec, axis: vec, s: interval, sCenter: finite, mdWidth: nonnegative, blWidth: nonnegative, height: nonnegative, cervicalLevel: finite, peaks: count, crownScore: confidence, kind: z.enum(['crown', 'restoration-like']), flags: strings })).max(128),
  gaps: z.array(z.strictObject({ id, s: interval, length: nonnegative, kind: z.enum(['bounded', 'terminal-start', 'terminal-end']), support: z.enum(['ridge', 'not-scanned', 'mixed', 'soft-tissue']), coverage: confidence, ridgeHeight: finite.nullable(), before: count.nullable(), after: count.nullable(), positions: z.array(fdi).max(32) })).max(128),
  classes: z.array(z.number().int().min(0).max(8)).max(MAX_TRIANGLES),
  classCounts: z.strictObject({ unknown: count, crown: count, gingiva: count, ridge: count, 'outside-band': count, boundary: count, debris: count, 'restoration-like': count, 'soft-tissue-protrusion': count }),
  coverage: z.strictObject({ scannedFraction: confidence, boundaryFaces: count, openEdges: z.number().int().min(0).max(MAX_COORDINATES), components: count, debrisComponents: count }),
  scale: z.strictObject({ cell: nonnegative, toothWidth: nonnegative, crownProminence: nonnegative, bandHalfWidth: nonnegative, medianEdge: nonnegative }),
  anterior: z.strictObject({ direction: vec.nullable(), apexS: finite.nullable(), confidence, basis: text }), lingualConfidence: confidence, warnings: strings,
});
const numbering = z.strictObject({ arch, orientation: z.union([z.literal(1), z.literal(-1)]), scale: positive, cost: finite,
  groups: z.array(z.strictObject({ kind: z.enum(['tooth', 'gap', 'tissue', 'unscanned']), start: count, end: count, fdi: fdi.nullable().optional(), positions: z.array(fdi).max(32).optional(), crownLikelihood: confidence.optional(), label: text, confidence, alternatives: z.array(fdi).max(32), cost: finite })).max(512),
  sequence: z.array(fdi).max(32), skipped: z.array(fdi).max(32), method: text,
});
const neighbour = z.strictObject({ toothId: count, fdi: fdi.nullable(), partId: id, centroid: vec, confidence });
const measuredValue = z.strictObject({ value: finite.nullable(), unit: z.literal('file units (u)'), method: text, provenance: z.enum(['measured', 'hypothesized', 'unknown']).optional(), sampleCount: count.optional() });
const site = z.strictObject({
  id, arch, partId: id, fdi: fdi.nullable(), alternatives: z.array(fdi).max(32),
  draftIdentity: z.strictObject({ templateFdi: fdi, alternatives: z.array(fdi).max(32), basis: text }).optional(),
  status: z.enum(['proposed-missing', 'dentist-confirmed-missing', 'not-scanned', 'segmentation-unresolved', 'identity-unresolved']), confidence,
  priority: z.enum(['high', 'medium', 'low']), kind: z.enum(['bounded', 'terminal', 'chart']), slot: z.strictObject({ index: count, count, s: interval }),
  evidence: z.strictObject({ supporting: strings, conflicting: strings }), anchor: anchor.nullable(), patchFaces: z.array(count).max(MAX_TRIANGLES), frame: frame.nullable(), frameBasis: text,
  frameEvidence: z.strictObject({ status: z.enum(['hypothesized', 'unavailable']), mesial: z.enum(['hypothesized', 'unknown']), buccal: z.enum(['hypothesized', 'unknown']), limitations: strings }).optional(),
  mesialSign: sign, buccalSign: sign, adjacent: z.strictObject({ mesial: neighbour.nullable(), distal: neighbour.nullable() }),
  opposing: z.strictObject({ partId: id, teeth: z.array(neighbour).max(128), poseVerified: z.boolean() }).nullable(), contralateral: neighbour.nullable(),
  space: z.strictObject({ mesiodistal: measuredValue, proximalGap: measuredValue, buccolingual: measuredValue, vertical: measuredValue, crownHeight: measuredValue }), questions: strings,
});
const preparedSchema = z.strictObject({
  id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), revision: id,
  durationMs: nonnegative.optional(),
  scans: z.array(sourceScan.extend({ analysis: analysisSchema.nullable(), numbering: numbering.nullable(), draftLabels: z.array(z.number().int().min(0).max(255)).max(MAX_TRIANGLES), warnings: strings })).max(MAX_PARTS),
  sites: z.array(site).max(128), identities: z.array(z.strictObject({ partId: id, candidateId: count, fdi: fdi.nullable(), confidence, alternatives: z.array(fdi).max(32), needsReview: z.boolean(), reason: text, blockingReasons: z.array(z.string().max(1000)).max(32).optional(), source: z.enum(['geometry', 'reviewed']) })).max(8192), warnings: strings,
});
const evidenceSource = sourceScan.extend({ analysis: analysisSchema.nullable().optional(), numbering: numbering.nullable().optional(), draftLabels: z.array(z.number().int().min(0).max(255)).max(MAX_TRIANGLES).optional(), warnings: strings.optional() });
const draftSchema = z.strictObject({ evidence: z.strictObject({ revision: id, sources: z.array(evidenceSource).max(MAX_PARTS), views: z.array(view).max(8) }), result: resultSchema.nullable(), prepared: preparedSchema.optional() });
const sourceSchema = z.strictObject({ key: id, name: text, fileName: text, role: z.enum(['model', 'upper', 'lower', 'bite']), roleSource: z.enum(['filename-hypothesis', 'user-reviewed']).optional(), sourceByteSha256: sha.optional(), appearanceSha256: sha.optional(), triangles: count.refine(value => value > 0), geometrySha256: sha, fileToWorkspace: matrix, visible: z.boolean() });
const reviewedSchema = z.strictObject({
  format: z.literal('platanus-tooth-identification'), version: z.literal(1), numbering: z.literal('FDI permanent'), units: z.literal('file units (u)'), source: z.literal('user-reviewed identification'), createdAt: date,
  parts: z.array(z.strictObject({ key: id, name: text, fileName: text, role: arch, triangles: count, geometrySha256: sha, labelsBase64: z.string().max(Math.ceil(MAX_TRIANGLES / 3) * 4), reviewedMaskBase64: z.string().max(Math.ceil(MAX_TRIANGLES / 3) * 4).optional(), fileToWorkspace: matrix })).max(MAX_PARTS),
  teeth: z.array(z.strictObject({ fdi, status: z.enum(['unreviewed', 'present', 'missing', 'not-scanned']), restoration: z.enum(['none', 'crown', 'implant']), note: z.string().max(2000), site: savedAnchor.optional() })).length(32),
});
const progressSchema = z.strictObject({ stage: z.string().max(160), completed: count, total: count }).refine(value => value.completed <= value.total, 'Progress exceeds its total.');
const timingSchema = z.strictObject({ stage: z.string().max(160), durationMs: nonnegative });
const workflowSchema = z.strictObject({
  step: z.number().int().min(0).max(3).optional(),
  selectedTooth: fdi.optional(), selectedAssemblyId: id.nullable().optional(),
  focusedSiteId: id.nullable().optional(),
  identityDecisions: z.record(id, fdi.nullable()).optional(), siteDecisions: z.record(id, fdi.nullable()).optional(),
  identityRegions: z.record(id, z.array(count).max(MAX_TRIANGLES)).optional(),
  archivedDraftDecisions: z.array(z.strictObject({ revision: id, reason: text, identityDecisions: z.record(id, fdi.nullable()), siteDecisions: z.record(id, fdi.nullable()), patientRight: z.enum(['image-left', 'image-right']).nullable() })).max(32).optional(),
  collisionTolerance: nonnegative.optional(),
  runs: z.array(workflowRunSchema).max(32).optional(), correctionEvents: z.array(correctionEventSchema).max(2000).optional(),
  assessments: z.array(resultSchema).max(32).optional(),
  biteReviewed: z.boolean().optional(),
  timedPreparationRevision: id.optional(),
});
export type PlanningWorkflowState = z.infer<typeof workflowSchema>;
export const planningSessionSchema = z.strictObject({
  format: z.literal('platanus-planning-session'), version: z.literal(1), createdAt: date, units: z.literal('file units (u)'),
  sources: z.array(sourceSchema).min(1).max(MAX_PARTS), reviewed: reviewedSchema,
  correctionMasks: z.array(z.strictObject({ sourceKey: id, values: z.array(z.union([z.literal(0), z.literal(1)])).max(MAX_TRIANGLES) })).max(MAX_PARTS).default([]),
  draft: draftSchema.nullable(), assemblies: z.array(assemblySchema).max(21),
  mmPerUnit: positive.nullable(), unitsProvenance: text, confidenceThreshold: confidence,
  patientRight: z.enum(['image-left', 'image-right']).nullable(), model: z.string().max(160), manualMode: z.boolean(),
  progress: progressSchema, timings: z.array(timingSchema).max(128), acceptedActions: z.array(id).max(64),
  workflow: workflowSchema.optional(),
}).refine(value => value.mmPerUnit === null || !!value.unitsProvenance.trim(), 'A calibrated scale needs its independent provenance.');

export interface PlanningSessionDraft {
  evidence: { revision: string; sources: ({ partId: string; scan: AutoToothScan } & Partial<Omit<PreparedCaseSource, 'partId' | 'scan'>>)[]; views: CasePlanningRequest['views'] };
  result: CasePlanningResult | null;
  prepared?: CasePreparationResult;
}
export interface PlanningSessionInput {
  parts: ModelPart[];
  teeth: ToothCase;
  assemblies: RestorationAssembly[];
  draft?: PlanningSessionDraft | null;
  mmPerUnit?: number | null;
  unitsProvenance?: string;
  confidenceThreshold?: number;
  patientRight?: 'image-left' | 'image-right' | null;
  model?: string;
  manualMode?: boolean;
  progress?: z.infer<typeof progressSchema>;
  timings?: z.infer<typeof timingSchema>[];
  acceptedActions?: string[];
  workflow?: PlanningWorkflowState;
}
export interface RestoredPlanningDraft extends Omit<PlanningSessionDraft, 'evidence'> {
  evidence: { revision: string; sources: PreparedCaseSource[]; views: CasePlanningRequest['views'] };
}
export type PlanningSessionFile = z.infer<typeof planningSessionSchema>;
export interface RestoredPlanningSession {
  recoveryWarnings?: string[];
  parts: ModelPart[];
  teeth: ToothCase;
  assemblies: RestorationAssembly[];
  draft: RestoredPlanningDraft | null;
  mmPerUnit: number | null;
  unitsProvenance: string;
  confidenceThreshold: number;
  patientRight: 'image-left' | 'image-right' | null;
  model: string;
  manualMode: boolean;
  progress: z.infer<typeof progressSchema>;
  timings: z.infer<typeof timingSchema>[];
  acceptedActions: string[];
  workflow?: PlanningWorkflowState;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
function fail(message: string): never { throw new Error(message); }
function json(value: unknown, depth = 0): Json {
  if (depth > 32) return fail('Planning session nesting exceeds its limit.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fail('Planning session contains a nonfinite value.');
  if (value instanceof Float32Array || value instanceof Uint8Array || value instanceof Uint32Array) {
    if (value.length > MAX_COORDINATES) return fail('Planning mesh array exceeds its size limit.');
    return Array.from(value, item => json(item, depth + 1));
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_COORDINATES) return fail('Planning mesh array exceeds its size limit.');
    return value.map(item => json(item, depth + 1));
  }
  if (typeof value !== 'object' || value === undefined || Object.getPrototypeOf(value) !== Object.prototype) return fail('Planning sessions require plain JSON data.');
  const result: { [key: string]: Json } = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') return fail('Invalid planning session key.');
    if (item !== undefined) result[key] = json(item, depth + 1);
  }
  return result;
}

/** Only structural references are rewritten; clinical prose and stable artifact IDs are untouched. */
function remap(value: Json, parts: Map<string, string>, aliases: Map<string, string>, field = ''): Json {
  if (Array.isArray(value)) return value.map(item => remap(item, parts, aliases, field));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    const mappedKey = ['identityDecisions', 'siteDecisions', 'identityRegions'].includes(field) ? remap(key, parts, aliases, 'id') as string : key;
    return [mappedKey, remap(item, parts, aliases, key)];
  }));
  if (typeof value !== 'string') return value;
  if (['partId', 'parentPartId', 'donorPartId', 'partIds'].includes(field)) return parts.get(value) ?? fail('A planning dependency is missing from the source scans.');
  if (field === 'sourceId') return aliases.get(value) ?? fail('A draft source alias is missing.');
  if (field === 'evidence' || field === 'id' || field === 'focusedSiteId' || field === 'siteId') {
    // Named fitting targets may use a source id followed by a region suffix.
    for (const [before, after] of field === 'evidence' ? aliases : parts) if (value.startsWith(`${before}:`)) return `${after}${value.slice(before.length)}`;
    for (const [before, after] of parts) if (value.includes(`-${before}-`)) return value.replace(`-${before}-`, `-${after}-`);
  }
  return value;
}
function unique<T extends string | number>(values: T[], name: string) {
  if (new Set(values).size !== values.length) fail(`Duplicate ${name}.`);
}
function validateImported(parts: ModelPart[]) {
  if (!parts.length || parts.length > MAX_PARTS || parts.some(part => part.restoration)) fail('Load only the original patient source scans before reopening a session.');
  unique(parts.map(part => part.id), 'source identities');
  let total = 0;
  for (const part of parts) {
    if (!part.id || !(part.positions instanceof Float32Array) || !Number.isSafeInteger(part.triangles) || part.triangles <= 0 || part.triangles > MAX_TRIANGLES || part.positions.length !== part.triangles * 9 || part.positions.some(value => !Number.isFinite(value))) fail('Invalid imported source geometry.');
    total += part.triangles;
    if (total > MAX_TRIANGLES) fail('The workspace triangle budget is exceeded.');
  }
}
function onSurface(value: z.infer<typeof anchor>, parts: Map<string, ModelPart>) {
  const part = parts.get(value.partId);
  if (!part || value.face >= part.triangles) fail('A saved surface anchor has a missing source triangle.');
  const a = new Vector3().fromArray(part.positions, value.face * 9), b = new Vector3().fromArray(part.positions, value.face * 9 + 3), c = new Vector3().fromArray(part.positions, value.face * 9 + 6);
  const target = new Vector3(...value.point), nearest = new Triangle(a, b, c).closestPointToPoint(target, new Vector3());
  const tolerance = Math.max(a.distanceTo(b), b.distanceTo(c), c.distanceTo(a)) * 1e-5;
  const rounding = Math.max(...value.point.map(Math.abs), ...a.toArray().map(Math.abs)) * Number.EPSILON * 64;
  if (!nearest.toArray().every(Number.isFinite) || nearest.distanceTo(target) > Math.max(tolerance, rounding)) fail('A saved anchor is not on its source triangle.');
}
function facesMatch(faces: number[], part: ModelPart) {
  if (faces.length > part.triangles || faces.some(face => face >= part.triangles) || new Set(faces).size !== faces.length) fail('Draft faces do not match their original source triangle order.');
}
function validatePreparedSource(source: z.infer<typeof evidenceSource>, part: ModelPart) {
  if (source.draftLabels && (source.draftLabels.length !== part.triangles || source.draftLabels.some(label => label !== 0 && label !== 255 && (!isFdiTooth(label) || toothArch(label) !== part.role)))) fail('Prepared labels do not match their source arch.');
  if (source.numbering && source.numbering.arch !== part.role) fail('Prepared numbering references a different arch.');
  if (source.analysis) {
    if (source.analysis.classes.length !== part.triangles) fail('Prepared surface classes do not match their source.');
    const curve = source.analysis.curve;
    if ([curve.s, curve.tangent, curve.lingual, curve.crownLevel, curve.state].some(items => items.length !== curve.points.length)) fail('Malformed prepared arch curve.');
    const occupied = new Set<number>();
    unique(source.analysis.teeth.map(tooth => tooth.id), 'prepared tooth segment');
    for (const tooth of source.analysis.teeth) {
      facesMatch(tooth.faces, part);
      for (const face of tooth.faces) { if (occupied.has(face)) fail('Prepared tooth segments overlap.'); occupied.add(face); }
      if (tooth.fdi !== null && toothArch(tooth.fdi) !== part.role) fail('Prepared anatomy references a different arch.');
    }
    if (Object.values(source.analysis.classCounts).reduce((sum, count) => sum + count, 0) !== part.triangles) fail('Prepared class counts do not match their source.');
  }
}
function validateDraft(draft: z.infer<typeof draftSchema>, parts: Map<string, ModelPart>) {
  unique(draft.evidence.sources.map(source => source.partId), 'draft source');
  unique(draft.evidence.views.map(view => view.id), 'draft view');
  const sources = new Map(draft.evidence.sources.map(source => [source.partId, source]));
  for (const source of sources.values()) {
    const part = parts.get(source.partId);
    if (!part || !['upper', 'lower'].includes(part.role ?? '')) fail('A draft arch dependency is missing.');
    unique(source.scan.candidates.map(candidate => candidate.id), 'candidate identity');
    if (source.scan.unassignedTriangles > part.triangles) fail('Invalid unassigned triangle count.');
    const occupied = new Set<number>();
    for (const candidate of source.scan.candidates) {
      facesMatch(candidate.faces, part);
      for (const face of candidate.faces) { if (occupied.has(face)) fail('Draft candidate regions overlap.'); occupied.add(face); }
      if (!candidate.faces.includes(candidate.seed.face)) fail('A candidate seed must belong to its region.');
      onSurface({ partId: source.partId, ...candidate.seed }, parts);
    }
    validatePreparedSource(source, part);
  }
  for (const view of draft.evidence.views) if ((view.context === 'arch') !== (view.sourceId !== null) || (view.sourceId !== null && !sources.has(view.sourceId))) fail('A draft view references a missing arch.');
  const result = draft.result;
  if (result) {
    if (result.revision !== draft.evidence.revision) fail('The draft assessment is stale for its evidence revision.');
    unique([...result.findings, ...result.actions].map(item => item.id), 'planning action/finding identity');
    unique(result.mappings.map(item => `${item.sourceId}:${item.candidateId}`), 'mapping');
    for (const mapped of result.mappings) if (mapped.fdi !== null && !mapped.needsReview && result.mappings.some(other => other !== mapped && other.fdi === mapped.fdi)) fail('Conflicting FDI hypotheses must remain review exceptions.');
    const refs = new Set([...draft.evidence.views.map(view => view.id), ...draft.evidence.sources.flatMap(source => source.scan.candidates.map(candidate => `${source.partId}:C${candidate.id}`)), ...(draft.prepared?.sites.map(site => site.id) ?? []), 'collision-report']);
    for (const item of [...result.findings, ...result.actions]) if (item.evidence.some(ref => !refs.has(ref))) fail('A planning item references unavailable evidence.');
    for (const item of result.mappings) {
      const source = sources.get(item.sourceId), part = parts.get(item.sourceId);
      if (!source?.scan.candidates.some(candidate => candidate.id === item.candidateId) || !part || (item.fdi !== null && toothArch(item.fdi) !== part.role)) fail('A draft mapping references a missing region or a different arch.');
    }
  }
  const prepared = draft.prepared;
  if (!prepared) return;
  if (prepared.revision !== draft.evidence.revision) fail('The prepared case is stale for its evidence revision.');
  unique(prepared.scans.map(source => source.partId), 'prepared source');
  if (prepared.scans.length !== sources.size || prepared.scans.some(source => !sources.has(source.partId))) fail('Prepared scans must cover every draft source dependency.');
  unique(prepared.identities.map(identity => `${identity.partId}:${identity.candidateId}`), 'prepared identity');
  unique(prepared.sites.map(site => site.id), 'prepared site');
  for (const source of prepared.scans) {
    const part = parts.get(source.partId), basic = sources.get(source.partId);
    if (!part || !basic || source.draftLabels.length !== part.triangles || source.draftLabels.some(label => label !== 0 && label !== 255 && (!isFdiTooth(label) || toothArch(label) !== part.role))) fail('Prepared labels do not match their source arch.');
    if (JSON.stringify(source.scan) !== JSON.stringify(basic.scan)) fail('Prepared candidates do not match draft evidence.');
    validatePreparedSource(source, part);
  }
  for (const identity of prepared.identities) {
    const source = sources.get(identity.partId), part = parts.get(identity.partId);
    if (!source?.scan.candidates.some(candidate => candidate.id === identity.candidateId) || !part || (identity.fdi !== null && toothArch(identity.fdi) !== part.role)) fail('A prepared identity references a missing candidate or a different arch.');
  }
  for (const site of prepared.sites) {
    const part = parts.get(site.partId);
    if (!part || part.role !== site.arch || (site.fdi !== null && toothArch(site.fdi) !== site.arch)) fail('A prepared site references a missing source or a different arch.');
    if (site.draftIdentity && (toothArch(site.draftIdentity.templateFdi) !== site.arch
      || site.draftIdentity.alternatives.some(fdi => toothArch(fdi) !== site.arch))) fail('A draft template references a different arch.');
    facesMatch(site.patchFaces, part);
    if (site.anchor) { if (site.anchor.partId !== site.partId) fail('Site anchor belongs to a different source.'); onSurface(site.anchor, parts); }
    const checkNeighbour = (other: z.infer<typeof neighbour> | null, expectedArch: 'upper' | 'lower', expectedPart?: string) => {
      if (!other) return;
      const part = parts.get(other.partId), source = prepared.scans.find(source => source.partId === other.partId);
      if (!part || part.role !== expectedArch || (expectedPart && other.partId !== expectedPart)
        || !source?.scan.candidates.some(candidate => candidate.id === other.toothId)
        || (other.fdi !== null && toothArch(other.fdi) !== expectedArch)) fail('A site neighbour tooth or arch dependency is missing.');
    };
    if (!prepared.scans.some(source => source.partId === site.partId)) fail('The prepared site source is missing.');
    for (const other of [site.adjacent.mesial, site.adjacent.distal, site.contralateral]) checkNeighbour(other, site.arch);
    if (site.opposing) {
      const opposingArch = site.arch === 'upper' ? 'lower' : 'upper';
      if (parts.get(site.opposing.partId)?.role !== opposingArch || !prepared.scans.some(source => source.partId === site.opposing?.partId)) fail('Opposing site geometry is missing or belongs to a different role.');
      for (const other of site.opposing.teeth) checkNeighbour(other, opposingArch, site.opposing.partId);
    }
  }
}
function restoreScan(value: z.infer<typeof scan>): AutoToothScan {
  return { ...value, candidates: value.candidates.map(candidate => ({ ...candidate, faces: Uint32Array.from(candidate.faces) })) };
}
function restoreDraft(value: z.infer<typeof draftSchema>, parts: Map<string, ModelPart>): RestoredPlanningDraft {
  const restoredSource = (source: z.infer<typeof evidenceSource>): PreparedCaseSource => ({
    ...source, scan: restoreScan(source.scan),
    draftLabels: source.draftLabels ? Uint8Array.from(source.draftLabels) : new Uint8Array(parts.get(source.partId)?.triangles ?? 0),
    analysis: source.analysis ? { ...source.analysis, classes: Uint8Array.from(source.analysis.classes), teeth: source.analysis.teeth.map(tooth => ({ ...tooth, faces: Uint32Array.from(tooth.faces) })) } : null,
    numbering: source.numbering ?? null, warnings: source.warnings ?? [],
  });
  const prepared: CasePreparationResult | undefined = value.prepared ? {
    ...value.prepared, scans: value.prepared.scans.map(restoredSource),
    sites: value.prepared.sites.map(site => ({ ...site, patchFaces: Uint32Array.from(site.patchFaces) })),
  } : undefined;
  return { ...value, prepared, evidence: { ...value.evidence, sources: value.evidence.sources.map(source => prepared?.scans.find(item => item.partId === source.partId) ?? restoredSource(source)) } };
}
function restoreShape(value: z.infer<typeof shape>) {
  const restored = { ...value, rim: Float32Array.from(value.rim), rimZ: Float32Array.from(value.rimZ), wall: Float32Array.from(value.wall), occlusal: Float32Array.from(value.occlusal) };
  validateCrownShape(restored);
  return restored;
}
function restoreFit(value: z.infer<typeof fitReport>): RestorationFitReport {
  return { ...value, anatomyCandidates: value.anatomyCandidates?.map(restoreShape) };
}
function qualityHistoryEvidence(quality: RestorationQualityReport | undefined) {
  if (!quality) return undefined;
  // Guardrails are an additive report extension, not candidate selection evidence.
  const { guardrails, ...evidence } = quality;
  return JSON.stringify(evidence);
}
function restoreSpec(value: z.infer<typeof specSchema>): RestorationSpec {
  const spec: RestorationSpec = { ...value, crownShape: value.crownShape ? restoreShape(value.crownShape) : undefined };
  if (spec.draftIdentity && (spec.draftIdentity.templateFdi !== spec.fdi
    || spec.draftIdentity.alternatives.some(fdi => toothArch(fdi) !== toothArch(spec.fdi)))) fail('The draft template identity does not match its source arch.');
  if (spec.crownShape) {
    validateCrownShape(spec.crownShape);
    if (spec.crownShape.arch !== toothArch(spec.fdi) || spec.crownShape.toothClass !== spec.anatomy) fail('Crown anatomy does not match its declared arch and class.');
  }
  validateRestorationSpec(spec);
  return spec;
}

/** Colour/UV evidence must not be silently substituted under an old assessment. */
export async function appearanceSignature(part: ModelPart): Promise<string> {
  const digest = async (array: Float32Array | Uint8Array | undefined) => {
    if (!array) return null;
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength).slice();
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
  };
  const arrays = await Promise.all([part.uvs, part.colors, part.tissueScores, part.texture?.bytes].map(digest));
  return digest(new TextEncoder().encode(JSON.stringify([part.textureStatus ?? null, ...arrays]))) as Promise<string>;
}

function bindDecisionRegions(workflow: PlanningWorkflowState, draft: { evidence: { sources: { partId: string; scan: { candidates: { id: number; faces: ArrayLike<number> }[] } }[] } } | null | undefined): PlanningWorkflowState {
  const regions = { ...workflow.identityRegions };
  for (const key of Object.keys(workflow.identityDecisions ?? {})) {
    if (regions[key]) continue;
    const match = /^(.*):C(\d+)$/.exec(key);
    const candidate = draft?.evidence.sources.find(source => source.partId === match?.[1])?.scan.candidates.find(candidate => candidate.id === Number(match?.[2]));
    if (candidate) regions[key] = Array.from(candidate.faces);
  }
  return Object.keys(regions).length || workflow.identityRegions ? { ...workflow, identityRegions: regions } : workflow;
}

export async function createPlanningSession(input: PlanningSessionInput): Promise<PlanningSessionFile> {
  const parts = input.parts.filter(part => !part.restoration);
  validateImported(parts);
  const generated = input.assemblies.flatMap(assembly => assembly.parts);
  if (parts.length + generated.length > MAX_PARTS || [...parts, ...generated].reduce((sum, part) => sum + part.triangles, 0) > MAX_TRIANGLES) fail('The workspace geometry budget is exceeded.');
  for (const part of generated) if (!(part.positions instanceof Float32Array) || !(part.normals instanceof Float32Array) || part.positions.length > MAX_COORDINATES || part.normals.length !== part.positions.length) fail('Malformed or oversized component mesh arrays.');
  const keys = new Map(parts.map((part, index) => [part.id, `scan-${index + 1}`]));
  const aliases = new Map(input.parts.map((part, index) => [`scan-${index + 1}`, keys.get(part.id) ?? '']));
  const sources = await Promise.all(parts.map(async part => ({ key: keys.get(part.id), name: part.name, fileName: part.fileName, role: part.role ?? 'model', ...(part.roleSource ? { roleSource: part.roleSource } : {}), ...(part.sourceByteSha256 ? { sourceByteSha256: part.sourceByteSha256 } : {}), appearanceSha256: await appearanceSignature(part), triangles: part.triangles, geometrySha256: await geometrySignature(part.positions), fileToWorkspace: partMatrix(part).toArray(), visible: part.visible })));
  const sourcePoses = new Map(parts.map((part, index) => [part.id, sources[index].fileToWorkspace]));
  const assemblies = await Promise.all(input.assemblies.map(async assembly => ({ ...assembly, spec: remap(json(assembly.spec), keys, aliases),
    ...(assembly.previousVersions ? { previousVersions: remap(json(assembly.previousVersions), keys, aliases) } : {}),
    ...(assembly.fit ? { fit: remap(json(assembly.fit), keys, aliases) } : {}),
    ...(assembly.candidateHistory ? { candidateHistory: remap(json(assembly.candidateHistory), keys, aliases) } : {}),
    parts: await Promise.all(assembly.parts.map(async part => {
      if (part.restoration?.assemblyId !== assembly.id || part.restoration.parentPartId !== assembly.spec.parentPartId) fail('A component does not belong to its assembly.');
      const parentPose = sourcePoses.get(assembly.spec.parentPartId) ?? fail('An assembly parent is missing.');
      // Components are constructed in their parent's immutable file coordinates.
      // Match the displayed pose, which follows the current source registration.
      const fileToWorkspace = partMatrix({ ...part, pose: parentPose }).toArray();
      return { id: part.id, name: part.name, fileName: part.fileName, component: part.restoration.component, geometrySha256: await geometrySignature(part.positions), positions: Array.from(part.positions), normals: Array.from(part.normals), triangles: part.triangles, vertices: part.vertices, dimensions: part.dimensions, closed: part.closed, visible: part.visible, fileToWorkspace, ...(part.presentationColor ? { presentationColor: part.presentationColor } : {}), ...(part.presentationRoughness !== undefined ? { presentationRoughness: part.presentationRoughness } : {}) };
    })),
  })));
  const file = planningSessionSchema.parse({ format: 'platanus-planning-session', version: 1, createdAt: new Date().toISOString(), units: 'file units (u)', sources,
    reviewed: await createToothSession(parts, input.teeth),
    correctionMasks: Object.entries(input.teeth.reviewedMask ?? {}).map(([partId, values]) => ({ sourceKey: keys.get(partId) ?? fail('A reviewed correction mask has a missing source dependency.'), values: Array.from(values) })), draft: input.draft ? remap(json(input.draft), keys, aliases) : null, assemblies: json(assemblies),
    mmPerUnit: input.mmPerUnit ?? null, unitsProvenance: input.unitsProvenance ?? '', confidenceThreshold: input.confidenceThreshold ?? .8, patientRight: input.patientRight ?? null, model: input.model ?? '', manualMode: input.manualMode ?? false,
    progress: input.progress ?? { stage: '', completed: 0, total: 0 }, timings: input.timings ?? [], acceptedActions: input.acceptedActions ?? [],
    ...(input.workflow ? { workflow: remap(json(bindDecisionRegions(input.workflow, input.draft)), keys, aliases) } : {}) });
  // The writer follows the same semantic checks as untrusted imports.
  await readPlanningSession(file, parts);
  return file;
}

const boundedMeshArray = z.custom<unknown[]>(value => Array.isArray(value) && value.length >= 9 && value.length <= MAX_COORDINATES, 'Mesh array exceeds its size limit.');
const budgetEnvelope = z.object({
  sources: z.array(z.object({ triangles: count })).max(MAX_PARTS),
  assemblies: z.array(z.object({ parts: z.array(z.object({ triangles: count, positions: boundedMeshArray, normals: boundedMeshArray })).max(3) })).max(21),
});
function validateBudget(value: unknown) {
  const parsed = budgetEnvelope.safeParse(value);
  if (!parsed.success) fail('Invalid planning session: geometry exceeds its size limit.');
  const meshes = parsed.data.assemblies.flatMap(assembly => assembly.parts);
  if (parsed.data.sources.length + meshes.length > MAX_PARTS || [...parsed.data.sources, ...meshes].reduce((sum, part) => sum + part.triangles, 0) > MAX_TRIANGLES) fail('The restored workspace geometry budget is exceeded.');
}

/** Fully validate before returning; no mutation of parts, roles, poses, chart, or assemblies. */
export async function readPlanningSession(value: unknown, parts: ModelPart[]): Promise<RestoredPlanningSession> {
  validateImported(parts);
  validateBudget(value);
  const parsed = planningSessionSchema.safeParse(value);
  if (!parsed.success) fail(`Invalid planning session: ${parsed.error.issues[0]?.message ?? 'malformed data'}`);
  const file = parsed.data;
  const legacyAppearance = file.sources.some(source => !source.appearanceSha256);
  unique(file.sources.map(source => source.key), 'saved source key');
  if (file.sources.length !== parts.length) fail('Reimport exactly the same patient source scans before reopening this session.');
  const hashes = await Promise.all(parts.map(part => geometrySignature(part.positions)));
  const unused = new Set(parts.map(part => part.id)), byKey = new Map<string, ModelPart>();
  for (const source of file.sources) {
    let matches = parts.filter((part, index) => unused.has(part.id) && part.triangles === source.triangles && hashes[index] === source.geometrySha256);
    if (matches.length > 1) matches = matches.filter(part => part.name === source.name && part.fileName === source.fileName);
    if (matches.length !== 1) fail('Patient scan geometry is missing or ambiguous. The original geometry hash and triangle order are required.');
    const part = matches[0]; unused.delete(part.id);
    if (source.sourceByteSha256 && part.sourceByteSha256 !== source.sourceByteSha256) fail('Original scan byte hash differs. Reimport the exact original source files.');
    if (source.appearanceSha256 && await appearanceSignature(part) !== source.appearanceSha256) fail('Scan colour, texture or UV evidence differs. Reattach the original local textures before reopening.');
    byKey.set(source.key, { ...part, role: source.role, roleSource: source.roleSource, visible: source.visible, pose: [...source.fileToWorkspace], offset: [0, 0, 0], rotation: [0, 0, 0] });
  }
  // Return sources in the current import order, so scan-N transport aliases remain correct.
  const restored = parts.map(part => [...byKey.values()].find(source => source.id === part.id) ?? fail('Missing restored source.'));
  const savedArches = file.sources.filter(source => source.role === 'upper' || source.role === 'lower');
  if (savedArches.length !== file.reviewed.parts.length) fail('Reviewed identification has missing source dependencies.');
  const reviewedKeys = new Set<string>();
  for (const source of file.reviewed.parts) {
    const matches = savedArches.filter(arch => arch.role === source.role && arch.geometrySha256 === source.geometrySha256 && arch.triangles === source.triangles && arch.name === source.name && arch.fileName === source.fileName);
    if (matches.length !== 1 || JSON.stringify(matches[0].fileToWorkspace) !== JSON.stringify(source.fileToWorkspace)) fail('Reviewed identification does not match the saved patient source pose.');
    reviewedKeys.add(matches[0].key);
  }
  if (reviewedKeys.size !== savedArches.length) fail('Reviewed identification repeats a source dependency.');
  const teeth = await readToothSession(file.reviewed, restored);
  unique(file.correctionMasks.map(mask => mask.sourceKey), 'reviewed correction mask source');
  if (file.correctionMasks.length) {
    const masks: Record<string, Uint8Array> = { ...teeth.reviewedMask };
    for (const mask of file.correctionMasks) {
      const part = byKey.get(mask.sourceKey);
      if (!part || !['upper', 'lower'].includes(part.role ?? '') || mask.values.length !== part.triangles) fail('Reviewed correction masks must match their source arch triangle order.');
      if (teeth.reviewedMask?.[part.id]?.some((value, index) => value !== mask.values[index])) fail('Reviewed correction masks conflict with the saved identification.');
      masks[part.id] = Uint8Array.from(mask.values);
    }
    teeth.reviewedMask = masks;
  }
  const ids = new Map([...byKey].map(([key, part]) => [key, part.id]));
  const aliases = new Map([...byKey].map(([key, part]) => [key, `scan-${restored.indexOf(part) + 1}`]));
  const draftSaved = file.draft;
  if (draftSaved) validateDraft(draftSaved, byKey);
  const draft = draftSaved && !legacyAppearance ? restoreDraft(draftSchema.parse(remap(json(draftSaved), ids, aliases)), new Map(restored.map(part => [part.id, part]))) : null;
  unique(file.acceptedActions, 'accepted action');
  if (file.acceptedActions.some(id => !file.draft?.result?.actions.some(action => action.id === id))) fail('An accepted action is missing from its draft plan.');
  unique(file.assemblies.map(assembly => assembly.id), 'assembly identity');
  if (file.workflow?.selectedAssemblyId && !file.assemblies.some(assembly => assembly.id === file.workflow?.selectedAssemblyId)) fail('The selected workflow assembly is missing.');
  unique(file.assemblies.flatMap(assembly => assembly.parts.map(part => part.id)), 'component identity');
  let triangles = restored.reduce((sum, part) => sum + part.triangles, 0);
  let componentCount = 0;
  const assemblies: RestorationAssembly[] = [];
  for (const assembly of file.assemblies) {
    const parent = byKey.get(assembly.spec.parentPartId);
    if (!parent || parent.role !== toothArch(assembly.spec.fdi)) fail('An assembly parent is missing or belongs to a different arch.');
    if (assembly.spec.siteEvidence) {
      for (const key of assembly.spec.siteEvidence.partIds) if (!byKey.has(key)) fail('An assembly site dependency is missing.');
      onSurface(assembly.spec.siteEvidence.surface, byKey);
    }
    const donor = assembly.spec.crownShape?.source;
    if (donor?.kind === 'patient-donor') {
      const source = donor.donorPartId ? byKey.get(donor.donorPartId) : undefined;
      if (!source || source.role !== parent.role || donor.faceCount > source.triangles
        || (donor.donorFdi !== null && (toothArch(donor.donorFdi) !== parent.role || toothClassOf(donor.donorFdi) !== assembly.spec.anatomy))) fail('The patient donor geometry or anatomical dependency is missing or incompatible.');
      if (donor.selection?.faces.some(face => face >= source.triangles)) fail('Donor selection references triangles outside its verified source.');
    }
    unique(assembly.parts.map(part => part.component), 'assembly component');
    const spec = restoreSpec(specSchema.parse(remap(json(assembly.spec), ids, aliases)));
    if (spec.draftIdentity && (!spec.siteEvidence || spec.siteEvidence.method !== 'bounded-gap'
      || spec.siteEvidence.surface.partId !== spec.parentPartId)) fail('A draft concept requires its original bounded surface site.');
    if (spec.draftIdentity && draft?.prepared && !assembly.warnings.some(warning => warning.startsWith('STALE:'))) {
      const site = draft.prepared.sites.find(site => site.id === spec.draftIdentity!.siteId);
      if (!site || site.partId !== spec.parentPartId || !site.anchor || site.anchor.face !== spec.siteEvidence!.surface.face
        || site.anchor.point.some((value, axis) => value !== spec.siteEvidence!.surface.point[axis])) fail('A draft concept no longer matches its originating surface site.');
    }
    if (assembly.candidateHistory && !assembly.fit) fail('Fitting history requires its measured fitting report.');
    if (assembly.fit) {
      const fit = assembly.fit;
      if (fit.candidates < 1 || (fit.bestCandidate !== undefined && fit.bestCandidate >= fit.candidates)
        || (fit.candidateAttempts !== undefined && (fit.candidateAttempts < fit.candidates || (fit.invalidCandidates ?? 0) > fit.candidateAttempts - fit.candidates))) fail('Fitting attempt counts or selected candidate are invalid.');
    }
    if (assembly.fit && assembly.candidateHistory) {
      const history = assembly.candidateHistory, chosen = history.filter(item => item.accepted).at(-1);
      if (history.length !== assembly.fit.candidates || history.some((item, index) => item.candidate !== index)
        || !chosen || !history[0].accepted || (assembly.fit.bestCandidate !== undefined && chosen.candidate !== assembly.fit.bestCandidate)
        || JSON.stringify(history[0].measurement) !== JSON.stringify(assembly.fit.before)
        || JSON.stringify(chosen.measurement) !== JSON.stringify(assembly.fit.after)
        || JSON.stringify(chosen.parameters) !== JSON.stringify(spec.parameters)) fail('Fitting history is stale for the selected assembly candidate.');
      if (assembly.fit.selectionPolicy === 'quality-gated/v1' && (!assembly.fit.quality || history.some(entry => !entry.quality)
        || qualityHistoryEvidence(history[0].quality) !== qualityHistoryEvidence(assembly.fit.quality.initial)
        || qualityHistoryEvidence(chosen.quality) !== qualityHistoryEvidence(assembly.fit.quality.final))) fail('Quality history is missing or stale for the selected candidate.');
      if (assembly.fit.anatomyCandidates) {
        if (history.some(entry => entry.anatomyCandidate === undefined || !assembly.fit!.anatomyCandidates![entry.anatomyCandidate])
          || JSON.stringify(assembly.fit.anatomyCandidates[chosen.anatomyCandidate!]) !== JSON.stringify(assembly.spec.crownShape)) fail('Candidate anatomy history is missing or stale.');
        for (const candidate of assembly.fit.anatomyCandidates) {
          restoreSpec({ ...assembly.spec, crownShape: candidate });
          // Adaptation may change the visible exterior, never donor identity or selection.
          if (JSON.stringify({ ...candidate.source, provenance: '' }) !== JSON.stringify({ ...assembly.spec.crownShape!.source, provenance: '' })) fail('Candidate anatomy changed its source dependency.');
          const original = assembly.fit.anatomyCandidates[0];
          if (['rim', 'rimZ', 'wall', 'dims'].some(key => JSON.stringify(candidate[key as 'rim']) !== JSON.stringify(original[key as 'rim']))) fail('An occlusal anatomy revision changed its fixed wall or cervical contour.');
        }
      } else if (history.some(entry => entry.anatomyCandidate !== undefined)) fail('Candidate anatomy references require stored anatomy.');
      let best = history[0].measurement, bestQuality = history[0].quality;
      for (const entry of history.slice(1)) {
        const improves = assembly.fit.selectionPolicy === 'quality-gated/v1'
          ? acceptsFitCandidate(entry.measurement, best, entry.quality, bestQuality)
          : assembly.fit.selectionPolicy === 'score-with-contact-evidence/v1'
            ? acceptsFitCandidate(entry.measurement, best) : entry.measurement.score + 1e-10 < best.score;
        if (entry.accepted !== improves) fail('Fitting history does not preserve its best measured candidate.');
        if (improves) { best = entry.measurement; bestQuality = entry.quality; }
      }
    }
    for (const measured of [assembly.fit?.before, assembly.fit?.after, ...(assembly.candidateHistory?.map(item => item.measurement) ?? [])]) {
      if (!measured) continue;
      for (const target of measured.surfaces) {
        const sourceKey = target.id.split(':')[0], source = byKey.get(sourceKey);
        if (!source || !target.id.includes(':') || !['upper', 'lower'].includes(source.role ?? '')
          || (target.role === 'antagonist' ? source.role === parent.role : source.role !== parent.role)) fail('A fitting target source dependency is missing or has an incompatible role.');
      }
    }
    const meshes: ModelPart[] = [];
    for (const mesh of assembly.parts) {
      triangles += mesh.triangles; componentCount++;
      if (triangles > MAX_TRIANGLES || restored.length + componentCount > MAX_PARTS) fail('The restored workspace geometry budget is exceeded.');
      if (restored.some(part => part.id === mesh.id)) fail('A component identity collides with an imported source.');
      const positions = Float32Array.from(mesh.positions), normals = Float32Array.from(mesh.normals);
      if (await geometrySignature(positions) !== mesh.geometrySha256) fail('A component geometry hash does not match its saved mesh.');
      const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
      for (let index = 0; index < positions.length; index++) { const axis = index % 3; low[axis] = Math.min(low[axis], positions[index]); high[axis] = Math.max(high[axis], positions[index]); }
      if (mesh.dimensions.some((dimension, axis) => Math.abs(dimension - (high[axis] - low[axis])) > 1e-5 * Math.max(1, dimension))) fail('Component dimensions are stale for their geometry.');
      meshes.push({ id: mesh.id, name: mesh.name, fileName: mesh.fileName, positions, normals, triangles: mesh.triangles, vertices: mesh.vertices, dimensions: mesh.dimensions, closed: mesh.closed, visible: mesh.visible, role: 'model', offset: [0, 0, 0], rotation: [0, 0, 0], pose: mesh.fileToWorkspace, presentationColor: mesh.presentationColor, presentationRoughness: mesh.presentationRoughness, restoration: { assemblyId: assembly.id, component: mesh.component, parentPartId: parent.id } });
    }
    const fit = assembly.fit ? restoreFit(fitReport.parse(remap(json(assembly.fit), ids, aliases))) : undefined;
    const candidateHistory = assembly.candidateHistory ? z.array(historyEntry).max(128).parse(remap(json(assembly.candidateHistory), ids, aliases)) : undefined;
    if (fit?.quality) {
      const current = evaluateRestorationQuality({ spec, components: meshes.map(mesh => ({ ...mesh, component: mesh.restoration!.component, closed: mesh.closed === true })), measurement: fit.after, context: spec.qualityContext, tolerances: fit.quality.final.tolerances });
      // Re-evaluate the hash-verified geometry. Historical prose may contain old
      // source IDs, but a saved verdict or measured extent cannot be trusted.
      if (current.status !== fit.quality.final.status || current.criteria.some(criterion => {
        const saved = fit.quality!.final.criteria.find(item => item.id === criterion.id);
        return !saved || saved.status !== criterion.status || JSON.stringify(saved.measured) !== JSON.stringify(criterion.measured);
      })) fail('Saved quality checks do not match the current verified geometry and evidence.');
      // Always replace the current extension, including legacy saves without it.
      // Other candidates and previous revisions retain their historical reports.
      const guardrails = restorationGuardrailsSchema.parse(current.guardrails);
      fit.quality.final = { ...fit.quality.final, guardrails };
      const chosen = candidateHistory?.filter(item => item.accepted).at(-1);
      if (chosen) chosen.quality = { ...(chosen.quality ?? fit.quality.final), guardrails };
      if (chosen?.candidate === 0 || (!candidateHistory && fit.candidates === 1 && JSON.stringify(fit.before) === JSON.stringify(fit.after)
        && qualityHistoryEvidence(fit.quality.initial) === qualityHistoryEvidence(fit.quality.final))) {
        fit.quality.initial = { ...fit.quality.initial, guardrails };
      }
    }
    assemblies.push({ ...assembly, warnings: legacyAppearance ? [...assembly.warnings.filter(warning => !warning.startsWith('STALE:')), 'STALE: Legacy case did not bind colour/UV/tissue evidence. Historical geometry retained; prepare current evidence before re-evaluation.'] : assembly.warnings, spec, parts: meshes,
      previousVersions: assembly.previousVersions?.map(version => ({ ...version, spec: restoreSpec(specSchema.parse(remap(json(version.spec), ids, aliases))), fit: version.fit ? restoreFit(fitReport.parse(remap(json(version.fit), ids, aliases))) : undefined, ...(version.candidateHistory ? { candidateHistory: z.array(historyEntry).max(128).parse(remap(json(version.candidateHistory), ids, aliases)) } : {}) })),
      fit,
      ...(candidateHistory ? { candidateHistory } : {}),
    });
  }
  let workflow = file.workflow ? workflowSchema.parse(remap(json(legacyAppearance ? file.workflow : bindDecisionRegions(file.workflow, draftSaved)), ids, aliases)) : undefined;
  if (workflow?.identityRegions) for (const [key, faces] of Object.entries(workflow.identityRegions)) {
    const match = /^(.*):C\d+$/.exec(key), source = restored.find(part => part.id === match?.[1]);
    if (!source) fail('A draft identity correction source is missing.');
    facesMatch(faces, source);
  }
  if (legacyAppearance) {
    workflow ??= {};
    workflow.archivedDraftDecisions = [...(workflow.archivedDraftDecisions ?? []), { revision: draftSaved?.evidence.revision ?? 'unverified-legacy', reason: 'Appearance-dependent region/site identities are unverified. Prior choices are historical and must not bind to freshly segmented candidate IDs.', identityDecisions: workflow.identityDecisions ?? {}, siteDecisions: workflow.siteDecisions ?? {}, patientRight: file.patientRight }].slice(-32);
    workflow.identityDecisions = {}; workflow.identityRegions = {}; workflow.siteDecisions = {}; workflow.focusedSiteId = null;
  }
  if (legacyAppearance && draftSaved?.result) {
    const historical = resultSchema.parse(remap(json(draftSaved.result), ids, aliases));
    historical.limitations = [...historical.limitations, 'Historical legacy assessment: appearance dependencies are unverified; this is not current case evidence.', ...(file.acceptedActions.length ? [`Historically included conditional review actions: ${file.acceptedActions.join(', ')}. Clinical treatment acceptance was not recorded.`] : [])];
    workflow = { ...workflow, assessments: [...(workflow?.assessments ?? []), historical].slice(-32) };
  }
  if (legacyAppearance && workflow?.runs) workflow.runs = workflow.runs.map(run => ({ ...run, status: 'stale', stages: run.stages.map(stage => ({ ...stage, status: 'stale' })) }));
  return { parts: restored, teeth, assemblies, draft, mmPerUnit: file.mmPerUnit, unitsProvenance: file.unitsProvenance, confidenceThreshold: file.confidenceThreshold, patientRight: legacyAppearance ? null : file.patientRight, model: file.model, manualMode: file.manualMode, progress: file.progress, timings: file.timings, acceptedActions: legacyAppearance ? [] : file.acceptedActions,
    ...(workflow ? { workflow } : {}), ...(legacyAppearance ? { recoveryWarnings: ['Legacy case: reviewed chart/corrections restored. Prior draft choices and patient side are archived because their appearance-dependent region/view evidence cannot be verified. Component history is stale; preparation will run locally with side unknown.'] } : {}) };
}
