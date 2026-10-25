import type { ModelPart } from './models';
import { posedPositions } from './pose.ts';

/** A bite capture often contains disconnected upper/lower patches in one file. */
export function scanSourceGroups(parts: ModelPart[]): ModelPart[][] {
  const groups = new Map<string, ModelPart[]>();
  for (const part of parts) {
    const key = part.sourceFileId ?? part.id;
    const group = groups.get(key) ?? []; group.push(part); groups.set(key, group);
  }
  return [...groups.values()];
}
export function canRefineCaseBite(parts: ModelPart[]): boolean {
  return scanSourceGroups(parts.filter(part => part.role === 'upper')).length === 1
    && scanSourceGroups(parts.filter(part => part.role === 'lower')).length === 1
    && parts.some(part => part.role === 'bite');
}
const combine = (parts: ModelPart[]) => {
  const positions = new Float64Array(parts.reduce((sum, part) => sum + part.positions.length, 0));
  let offset = 0;
  for (const part of parts) { const posed = posedPositions(part); positions.set(posed, offset); offset += posed.length; }
  return positions;
};
export function prepareCaseBite(parts: ModelPart[]) {
  if (!canRefineCaseBite(parts)) throw new Error('Assign one source file per arch and at least one bite capture. Components from the same imported file are grouped.');
  const upper = parts.filter(part => part.role === 'upper'), lower = parts.filter(part => part.role === 'lower');
  const arches = [upper, lower].map(group => ({ id: group[0].id, role: group[0].role as 'upper' | 'lower', positions: combine(group) }));
  const bites = scanSourceGroups(parts.filter(part => part.role === 'bite')).map(group => ({ id: group[0].id, positions: combine(group) }));
  const members = new Map([upper, lower].map(group => [group[0].id, group.map(part => part.id)]));
  return { arches, bites, members };
}
