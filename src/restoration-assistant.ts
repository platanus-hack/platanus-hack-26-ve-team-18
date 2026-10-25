import { tool, type ToolExecutionOptions } from 'ai';
import { z } from 'zod';
import type { RestorationAssembly } from './restoration-types.ts';
import { restorationEditSchema, restorationEditRevision, type RestorationEdit } from './restoration-edit.ts';
import { restorationQualitySchema, restorationGuardrailsSchema } from './restoration-quality-schema.ts';
import { restorationAppearance } from './restoration-appearance.ts';

export const MAX_ASSISTANT_EDITS = 3;
const finite = z.number().finite(), positive = finite.positive();
const component = z.enum(['fixture', 'abutment', 'crown']);
const id = z.string().regex(/^restoration-(?:[1-9]|[1-5]\d|6[0-4])$/);
const revision = z.string().regex(/^revision-[a-f0-9]{16}$/);
const material = z.strictObject({ color: z.string().regex(/^#[a-fA-F0-9]{6}$/).nullable(), roughness: finite.min(0).max(1).nullable() });
const parameters = z.strictObject({
  fixture: z.strictObject({ radius: positive, length: positive, depth: finite.nonnegative(), taper: finite.min(0).max(.95) }),
  abutment: z.strictObject({ radius: positive, height: positive, emergenceRadius: positive, angleX: finite.min(-80).max(80), angleY: finite.min(-80).max(80) }),
  crown: z.strictObject({ width: positive, depth: positive, height: positive, cuspHeight: finite.nonnegative(), rotation: finite.min(-360).max(360) }),
});
const quality = restorationQualitySchema.shape;
const criterion = quality.criteria.element;
const proposal = quality.revisions.element;

/** Explicitly projected transport fields: no names, source IDs, raw meshes or donor metadata. */
export const restorationDesignSchema = z.strictObject({
  id, editRevision: revision, stale: z.boolean(), parameters,
  anatomy: z.enum(['incisor', 'canine', 'premolar', 'molar']),
  contour: z.strictObject({ cervicalScale: positive, occlusalScale: positive }),
  appearance: z.strictObject({ fixture: material, abutment: material, crown: material }),
  meshes: z.array(z.strictObject({ component, dimensions: z.tuple([finite.nonnegative().nullable(), finite.nonnegative().nullable(), finite.nonnegative().nullable()]), closed: z.boolean(), triangles: z.number().int().nonnegative() })).max(3),
  quality: z.strictObject({ status: z.enum(['pass', 'fail', 'unknown']), crownExtents: quality.crownExtents,
    criteria: z.array(criterion).max(32), proposedLocalRevisions: z.array(proposal).max(32), guardrails: restorationGuardrailsSchema.nullable(),
    unassessed: z.array(z.string().max(100)).max(40) }),
});
export const restorationAssistantSnapshotSchema = z.strictObject({
  version: z.literal(1), units: z.literal('file units'), assemblies: z.array(restorationDesignSchema).max(64),
}).superRefine((value, ctx) => {
  if (value.assemblies.some((item, index) => item.id !== `restoration-${index + 1}`)) ctx.addIssue({ code: 'custom', message: 'Use sequential anonymous restoration identifiers.' });
});
export type RestorationAssistantSnapshot = z.infer<typeof restorationAssistantSnapshotSchema>;
export type RestorationDesign = z.infer<typeof restorationDesignSchema>;

/** Opaque transport revision; the host retains the engine's full local revision. */
export function assistantRestorationRevision(assembly: RestorationAssembly): string {
  const value = restorationEditRevision(assembly);
  let a = 2166136261, b = 3335557771;
  for (let i = 0; i < value.length; i++) { a = Math.imul(a ^ value.charCodeAt(i), 16777619); b = Math.imul(b ^ value.charCodeAt(i), 2246822519); }
  return `revision-${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}

export function buildRestorationAssistantSnapshot(assemblies: readonly RestorationAssembly[]): RestorationAssistantSnapshot {
  if (assemblies.length > 64) throw new Error('The assistant supports at most 64 restoration assemblies.');
  return restorationAssistantSnapshotSchema.parse({ version: 1, units: 'file units', assemblies: assemblies.map((assembly, index) => {
    const spec = assembly.spec, report = assembly.fit?.quality?.final;
    const identifiers = [assembly.id, spec.parentPartId, spec.source, spec.crownShape?.source.donorPartId, spec.crownShape?.source.provenance,
      spec.qualityContext?.placementFeedback?.source, ...(spec.qualityContext?.neighbors.map(item => item.id) ?? []),
      ...assembly.parts.flatMap(part => [part.id, part.name, part.fileName, part.sourceFileId, part.texture?.fileName])]
      .filter((value): value is string => Boolean(value)).sort((a, b) => b.length - a.length);
    const redact = (value: string) => identifiers.reduce((text, identifier) => text.split(identifier).join('[redacted]'), value).slice(0, 4000);
    const guardrails = report?.guardrails ? restorationGuardrailsSchema.parse({ ...report.guardrails,
      issues: report.guardrails.issues.map(issue => ({ ...issue, summary: redact(issue.summary),
        actual: Object.fromEntries(Object.entries(issue.actual).map(([key, value]) => [key, key === 'feedbackSource' ? null : typeof value === 'string' ? redact(value) : value])),
        target: { ...issue.target, description: redact(issue.target.description) }, missingEvidence: issue.missingEvidence.map(redact),
        suggestions: issue.suggestions.map(suggestion => ({ ...suggestion, action: redact(suggestion.action) })) })), limits: report.guardrails.limits.map(redact),
    }) : null;
    const appearance = Object.fromEntries((['fixture', 'abutment', 'crown'] as const).map(kind => {
      const part = assembly.parts.find(part => part.restoration?.component === kind);
      return [kind, { color: spec.appearance?.[kind]?.color ?? part?.presentationColor ?? null,
        roughness: spec.appearance?.[kind]?.roughness ?? part?.presentationRoughness ?? (part ? restorationAppearance(part)?.roughness : null) ?? null }];
    }));
    return { id: `restoration-${index + 1}`, editRevision: assistantRestorationRevision(assembly),
      stale: assembly.warnings.some(value => value.startsWith('STALE:')) || assembly.parts.some(part => part.restoration?.stale),
      parameters: spec.parameters, anatomy: spec.anatomy, contour: { cervicalScale: spec.contour?.cervicalScale ?? 1, occlusalScale: spec.contour?.occlusalScale ?? 1 }, appearance,
      meshes: assembly.parts.filter(part => part.restoration).map(part => ({ component: part.restoration!.component,
        dimensions: part.dimensions.map(value => Number.isFinite(value) && value >= 0 ? value : null), closed: part.closed, triangles: part.triangles })),
      quality: { status: report?.status ?? 'unknown', crownExtents: report?.crownExtents ?? null,
        criteria: report?.criteria.map(({ id, status, measured, reasons }) => ({ id, status, measured, reasons: reasons.map(redact) })) ?? [],
        proposedLocalRevisions: report?.revisions.map(({ parameter, current, proposed, rules, reason }) => ({ parameter, current, proposed, rules, reason: redact(reason) })) ?? [], guardrails,
        unassessed: [...new Set([...(report?.criteria.filter(item => item.status === 'unknown').map(item => item.id) ?? ['quality-evaluation']),
          'patient-specific-anatomy', 'clinical-shade-match', 'bone-and-surgical-clearance'])] },
    };
  }) });
}

export const restorationEditRequestSchema = z.strictObject({ assemblyId: id, expectedRevision: revision, edit: restorationEditSchema });
export type RestorationAssistantEditRequest = z.infer<typeof restorationEditRequestSchema>;
export const restorationEditResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('applied'), request: restorationEditRequestSchema, before: restorationDesignSchema, after: restorationDesignSchema }),
  z.strictObject({ status: z.literal('error'), request: restorationEditRequestSchema, before: restorationDesignSchema,
    code: z.enum(['stale', 'busy', 'invalid', 'failed']), message: z.string().max(300) }),
]);
export type RestorationAssistantEditResult = z.infer<typeof restorationEditResultSchema>;
export const restorationContinuationSchema = z.strictObject({ token: z.string().regex(/^[a-f0-9]{48}$/), result: restorationEditResultSchema.optional() });
export const restorationAssistantRequestSchema = z.strictObject({
  snapshot: restorationAssistantSnapshotSchema, allowEdits: z.boolean(), continuation: restorationContinuationSchema.optional(),
});

export const restorationAssistantLimits = [
  'These are generic local implant, abutment/pilar and crown concepts, not patient-specific surgical prescriptions or compatible manufactured hardware.',
  'Mesh dimensions are emitted file-axis extents in file units; crown parameter scales need not equal actual crown dimensions. No millimeter conversion or subcrestal placement rule is available.',
  'Quality checks and proposed local revisions are engineering guardrails. Unknown anatomy, shade, bone, tissue, occlusion and clinical clearance remain unassessed; appearance is display-only.',
  'Sampled gaps and triangle tests are not exact contact area, overlap volume, occlusal force, or clinical fit. Closed mesh geometry does not establish anatomical validity.',
  'A requested edit is pending until the local host returns an applied result with fresh before/after measurements. At most three edits are allowed for one user question.',
] as const;

/** One successful request per snapshot; read fresh evidence in a PRIOR SDK step. No geometry executes here. */
export function createRestorationAssistantTools(snapshot: RestorationAssistantSnapshot | undefined, options: { allowEdits?: boolean; editsUsed?: number } = {}) {
  const current = snapshot ? restorationAssistantSnapshotSchema.parse(snapshot) : undefined;
  const inspected = new Set<string>(); let requested: RestorationAssistantEditRequest | undefined;
  const readSchema = z.strictObject({ assemblyId: id.optional() });
  const read = (input: z.infer<typeof readSchema>) => {
    const { assemblyId } = readSchema.parse(input);
    const assemblies = current?.assemblies.filter(item => !assemblyId || item.id === assemblyId) ?? [];
    for (const item of assemblies) inspected.add(item.id);
    return { status: assemblies.length ? 'available' : 'unavailable', units: 'file units', assemblies,
      editsRemaining: options.allowEdits ? Math.max(0, MAX_ASSISTANT_EDITS - (options.editsUsed ?? 0)) : 0, limitations: restorationAssistantLimits };
  };
  const requestEdit = (input: unknown, execution?: ToolExecutionOptions<{}>) => {
    const parsed = restorationEditRequestSchema.safeParse(input);
    const error = (code: string, message: string) => ({ status: 'error' as const, code, message });
    if (!parsed.success) return error('invalid', 'Use only validated design values and a nonempty reason.');
    const action = parsed.data, design = current?.assemblies.find(item => item.id === action.assemblyId);
    if (!design) return error('unknown-assembly', 'Read an assembly in the current inventory.');
    if (design.stale || design.editRevision !== action.expectedRevision) return error('stale', 'This revision is stale. Obtain fresh local evidence.');
    const previouslyReturned = !execution || execution.messages.some(message => message.role === 'tool' && message.content.some(part => {
      if (part.type !== 'tool-result' || part.toolName !== 'getRestorationDesign' || part.output.type !== 'json') return false;
      const value = part.output.value as { assemblies?: unknown[] } | null;
      return value?.assemblies?.some(item => { const parsed = restorationDesignSchema.safeParse(item); return parsed.success && parsed.data.id === design.id && parsed.data.editRevision === design.editRevision; });
    }));
    if (!inspected.has(design.id) || !previouslyReturned) return error('fresh-evidence-required', 'Read getRestorationDesign in a prior step before requesting this revision.');
    if (requested) return error('one-edit-per-snapshot', 'One revision has already been requested. Await fresh host evidence.');
    requested = action;
    return { status: 'requested' as const, request: action, applied: false as const };
  };
  return {
    getRestorationDesign: Object.assign(tool({ title: 'Restoration design inventory', description: 'Read anonymous current implant, abutment/pilar and crown values, actual mesh extents/closure, quality guardrails, proposed local revisions and unknown evidence. Read before each edit.', inputSchema: readSchema, execute: read, metadata: { annotations: { readOnlyHint: true } } }), { execute: read, inputSchema: readSchema }),
    ...(current && options.allowEdits && (options.editsUsed ?? 0) < MAX_ASSISTANT_EDITS ? {
      requestRestorationEdit: Object.assign(tool({ title: 'Request one bounded local design revision', description: 'Request one revision-bound edit of a known generic implant/crown/abutment concept using current evidence and a reason. Returns requested, never applied: stop for the host to build exactly one candidate, then evaluate actual before/after evidence. No placement, raw mesh, bone or clinical prescription tools.', inputSchema: restorationEditRequestSchema, execute: requestEdit, metadata: { annotations: { readOnlyHint: false } } }), { execute: requestEdit, inputSchema: restorationEditRequestSchema }),
    } : {}),
  };
}

/** Exported host contract. The callback receives LOCAL IDs and the engine's LOCAL revision. */
export interface AssistantRestorationSource {
  assemblies: RestorationAssembly[];
  busy: boolean;
  /** External image/registration/display inputs only; excludes generated restoration changes. */
  sourceRevision?: string;
  applyEdit: (id: string, edit: RestorationEdit, expectedRevision: string, signal: AbortSignal) => Promise<RestorationAssembly>;
}

/** Only called after a complete, successful handoff stream; rejects stale/unknown actions before worker startup. */
export async function applyAssistantRestorationEdit(source: AssistantRestorationSource, action: RestorationAssistantEditRequest, signal: AbortSignal): Promise<{ result: RestorationAssistantEditResult; assembly?: RestorationAssembly }> {
  signal.throwIfAborted();
  const request = restorationEditRequestSchema.parse(action);
  const inventory = buildRestorationAssistantSnapshot(source.assemblies);
  const index = inventory.assemblies.findIndex(item => item.id === request.assemblyId);
  const before = inventory.assemblies[index], assembly = source.assemblies[index];
  if (!before || !assembly) throw new Error('The requested restoration is no longer available.');
  const fail = (code: 'stale' | 'busy' | 'invalid' | 'failed', message: string) => ({ result: restorationEditResultSchema.parse({ status: 'error', request, before, code, message }) });
  if (before.stale || before.editRevision !== request.expectedRevision) return fail('stale', 'The local restoration revision changed; this edit was not applied.');
  if (source.busy) return fail('busy', 'Local restoration work is busy; this edit was not applied.');
  try {
    const updated = await source.applyEdit(assembly.id, request.edit, restorationEditRevision(assembly), signal);
    signal.throwIfAborted();
    if (updated.id !== assembly.id) return fail('invalid', 'The host returned a different assembly.');
    const after = buildRestorationAssistantSnapshot(source.assemblies.map((item, i) => i === index ? updated : item)).assemblies[index];
    if (after.editRevision === before.editRevision) return fail('invalid', 'The host did not return a new revision.');
    return { assembly: updated, result: restorationEditResultSchema.parse({ status: 'applied', request, before, after }) };
  } catch {
    signal.throwIfAborted();
    return fail('failed', 'The local worker rejected or could not complete this edit. No applied result was returned.');
  }
}
