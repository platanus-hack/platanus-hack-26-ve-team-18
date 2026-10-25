import type { ModelPart } from './models.ts';

export type ArchRole = 'upper' | 'lower';

/** Contacts and positive near-surface gaps are near; only crossing/inside is collision. */
export function collisionSampleState(crossing: boolean, distance: number, tolerance: number, contact = false): 'clear' | 'near' | 'collision' {
  if (crossing || distance < 0) return 'collision';
  return contact || Number.isFinite(distance) && distance <= tolerance ? 'near' : 'clear';
}

export function presentationArch(part: ModelPart, parts: ModelPart[]): ArchRole | null {
  const role = part.restoration ? parts.find(source => source.id === part.restoration!.parentPartId)?.role : part.role;
  return role === 'upper' || role === 'lower' ? role : null;
}

/** Bite captures never enter the displayed scene. Transparency does not change analysis. */
export function presentationOpacity(part: ModelPart, opacities: Readonly<Record<string, number>>): number {
  if (part.role === 'bite') return 0;
  const value = opacities[part.id] ?? (part.restoration ? opacities[part.restoration.parentPartId] : undefined) ?? 1;
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}

export function withArchOpacity(parts: ModelPart[], current: Readonly<Record<string, number>>, arch: ArchRole, value: number): Record<string, number> {
  const next = { ...current };
  for (const part of parts) if (presentationArch(part, parts) === arch) next[part.id] = value;
  return next;
}
