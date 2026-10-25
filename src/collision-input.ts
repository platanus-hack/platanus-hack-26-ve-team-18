import type { CollisionPart } from './collision';
import type { ModelPart } from './models';
import { posedPositions } from './pose.ts';

/** Translate in double precision, retaining small surfaces even at large offsets. */
export function prepareCollisionParts(parts: ModelPart[]): CollisionPart[] {
  const visible = parts.filter(part => part.visible && part.role !== 'bite' && !part.restoration?.stale);
  const anchor = visible[0];
  if (!anchor) return [];
  const origin = posedPositions(anchor).subarray(0, 3);
  return visible.map(part => {
    const positions = posedPositions(part);
    for (let i = 0; i < positions.length; i++) {
      const axis = i % 3;
      positions[i] -= origin[axis];
    }
    return { id: part.id, positions, closed: part.closed,
      ...(part.restoration?.assemblyId ? { assemblyId: part.restoration.assemblyId } : {}) };
  });
}
