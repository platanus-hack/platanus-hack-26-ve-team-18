import { z } from 'zod';
import type { RestorationAssembly, RestorationComponentKind, RestorationParameters, RestorationSpec } from './restoration-types';
import { restorationCrownShape, validateRestorationSpec } from './restoration-geometry.ts';

// Numerical engineering bounds in file units, not clinical dimensions or a
// conversion to mm. Site, pose, chart identity and approvals are not editable.
const dimension = z.number().finite().min(0.000001).max(1_000_000);
const nonnegative = z.number().finite().min(0).max(1_000_000);
const fixture = z.strictObject({ radius: dimension.optional(), length: dimension.optional(), depth: nonnegative.optional(), taper: z.number().finite().min(0).max(0.95).optional() });
const abutment = z.strictObject({ radius: dimension.optional(), height: dimension.optional(), emergenceRadius: dimension.optional(), angleX: z.number().finite().min(-80).max(80).optional(), angleY: z.number().finite().min(-80).max(80).optional() });
const crown = z.strictObject({ width: dimension.optional(), depth: dimension.optional(), height: dimension.optional(), cuspHeight: nonnegative.optional(), rotation: z.number().finite().min(-360).max(360).optional() });
export const restorationContourSchema = z.strictObject({ cervicalScale: z.number().finite().min(0.5).max(1.5).optional(), occlusalScale: z.number().finite().min(0.5).max(1.5).optional() });
const componentAppearance = z.strictObject({ color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), roughness: z.number().finite().min(0).max(1).optional() });
export const restorationAppearanceSchema = z.strictObject({ fixture: componentAppearance.optional(), abutment: componentAppearance.optional(), crown: componentAppearance.optional() });
export const restorationEditProvenanceSchema = z.strictObject({ actor: z.enum(['manual', 'agent']), reason: z.string().trim().min(1).max(500) });

export type RestorationEdit = {
  reason: string;
  parameters?: { fixture?: Partial<RestorationParameters['fixture']>; abutment?: Partial<RestorationParameters['abutment']>; crown?: Partial<RestorationParameters['crown']> };
  anatomy?: RestorationSpec['anatomy'];
  contour?: RestorationSpec['contour'];
  appearance?: Partial<Record<RestorationComponentKind, { color?: string; roughness?: number }>>;
};
const hasValue = (value: unknown): boolean => value !== undefined && (value === null || typeof value !== 'object' || Object.values(value).some(hasValue));
export const restorationEditSchema = z.strictObject({
  reason: z.string().trim().min(1).max(500),
  parameters: z.strictObject({ fixture: fixture.optional(), abutment: abutment.optional(), crown: crown.optional() }).optional(),
  anatomy: z.enum(['incisor', 'canine', 'premolar', 'molar']).optional(),
  contour: restorationContourSchema.optional(),
  appearance: restorationAppearanceSchema.optional(),
}).refine(({ reason: _reason, ...changes }) => hasValue(changes), { message: 'An edit must request at least one change.' });

const kinds = ['fixture', 'abutment', 'crown'] as const;
const defaultAppearance = { fixture: { color: '#94a3b8', roughness: 0.48 }, abutment: { color: '#c4a46b', roughness: 0.36 }, crown: { color: '#f4ead7', roughness: 0.42 } };
const effective = (spec: RestorationSpec) => ({ parameters: spec.parameters, anatomy: spec.anatomy,
  contour: { cervicalScale: spec.contour?.cervicalScale ?? 1, occlusalScale: spec.contour?.occlusalScale ?? 1 },
  appearance: Object.fromEntries(kinds.map(kind => [kind, { color: (spec.appearance?.[kind]?.color ?? defaultAppearance[kind].color).toLowerCase(), roughness: spec.appearance?.[kind]?.roughness ?? defaultAppearance[kind].roughness }])) });

/** Pure atomic edit. Donor anatomy survives parameter/contour/display changes;
 * selecting another class intentionally creates an explicit template. */
export function applyRestorationEdit(spec: RestorationSpec, value: RestorationEdit, actor: 'manual' | 'agent'): RestorationSpec {
  const edit = restorationEditSchema.parse(value);
  if (actor !== 'manual' && actor !== 'agent') throw new Error('Unknown restoration edit actor.');
  validateRestorationSpec(spec);
  const next = structuredClone(spec);
  for (const kind of kinds) if (edit.parameters?.[kind]) Object.assign(next.parameters[kind], edit.parameters[kind]);
  if (edit.contour) next.contour = { ...next.contour, ...edit.contour };
  if (edit.appearance) {
    next.appearance ??= {};
    for (const kind of kinds) if (edit.appearance[kind]) next.appearance[kind] = { ...next.appearance[kind], ...edit.appearance[kind], ...(edit.appearance[kind].color ? { color: edit.appearance[kind].color!.toLowerCase() } : {}) };
  }
  if (edit.anatomy && edit.anatomy !== next.anatomy) {
    next.anatomy = edit.anatomy;
    delete next.crownShape;
    next.crownShape = restorationCrownShape(next);
  }
  // A legacy unpinned template becomes explicit before agent provenance is set,
  // so worker preparation cannot silently select a new patient donor.
  next.crownShape ??= restorationCrownShape(next);
  if (identity(effective(spec)) === identity(effective(next))) throw new Error('The edit does not change the restoration.');
  next.provenance = actor === 'agent' ? 'hypothesized' : 'clinician-entered';
  next.editProvenance = { actor, reason: edit.reason };
  validateRestorationSpec(next);
  return next;
}

// Stable streaming fingerprint: bounded opaque output without retaining a giant
// raw JSON revision. This is an optimistic concurrency token, not authentication.
function identity(value: unknown): string {
  let a = 0x811c9dc5, b = 0x9e3779b9;
  const feed = (text: string) => { for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193); b = Math.imul(b ^ c, 0x85ebca6b); } };
  const visit = (item: unknown) => {
    if (item === null || typeof item !== 'object') { feed(JSON.stringify(item) ?? 'undefined'); return; }
    if (ArrayBuffer.isView(item)) { feed('typed['); for (const number of item as unknown as Iterable<number>) { feed(String(number)); feed(','); } feed(']'); return; }
    if (Array.isArray(item)) { feed('['); item.forEach(value => { visit(value); feed(','); }); feed(']'); return; }
    feed('{'); for (const key of Object.keys(item).sort()) { if ((item as Record<string, unknown>)[key] === undefined) continue; feed(JSON.stringify(key)); feed(':'); visit((item as Record<string, unknown>)[key]); feed(','); } feed('}');
  };
  visit(value);
  return `${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}

export function restorationEditRevision(assembly: RestorationAssembly): string {
  return `restoration-edit/v1:${identity({ id: assembly.id, spec: assembly.spec, createdAt: assembly.createdAt,
    geometry: assembly.parts.map(part => ({ id: part.id, component: part.restoration?.component, triangles: part.triangles, vertices: part.vertices, dimensions: part.dimensions })),
    stale: assembly.warnings.filter(warning => warning.startsWith('STALE:')) })}`;
}
