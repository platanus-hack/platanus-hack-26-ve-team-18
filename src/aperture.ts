import type { ModelPart } from './models.ts';
import { presentationArch } from './presentation.ts';

/**
 * Visual bite opening, ported from hack-26's apertura: upper arch translates
 * +up and lower arch −up, symmetric, proportional to model size so the slider
 * stays unit-agnostic (percent, never millimetres). Purely presentational —
 * poses, manual offsets and collision evidence are left untouched; the delta
 * is composed onto `offset`, which partMatrix applies in scene-root space.
 */
export function withArchSeparation(parts: ModelPart[], aperture: number, upAxis: 'y' | 'z'): ModelPart[] {
  const percent = Math.min(100, Math.max(0, aperture));
  if (percent <= 0) return parts;
  const arches = parts.filter(part => presentationArch(part, parts) === 'upper' || presentationArch(part, parts) === 'lower');
  if (!arches.some(part => presentationArch(part, parts) === 'upper') || !arches.some(part => presentationArch(part, parts) === 'lower')) return parts;
  const radius = Math.max(...arches.map(part => Math.hypot(...part.dimensions) / 2));
  if (!Number.isFinite(radius) || radius <= 0) return parts;
  const delta = radius * 0.36 * percent / 100;
  const axis = upAxis === 'y' ? 1 : 2;
  return parts.map(part => {
    const arch = presentationArch(part, parts);
    if (arch !== 'upper' && arch !== 'lower') return part;
    const offset = [...part.offset] as ModelPart['offset'];
    offset[axis] += (arch === 'upper' ? 1 : -1) * delta;
    return { ...part, offset };
  });
}
