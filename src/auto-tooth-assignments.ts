import type { ModelPart } from './models';
import type { ToothCase } from './tooth-types';
import { isFdiTooth, toothArch, toothCounts } from './teeth.ts';

export interface AutoAssignment { partId: string; tooth: number; faces: Uint32Array }
export interface AutoAssignmentResult { data: ToothCase; applied: number[]; skipped: { tooth: number; reason: string }[]; triangles: number }

/** Explicit batch acceptance preserves existing reviewed masks and missing/not-scanned records. */
export function applyAutoAssignments(data: ToothCase, parts: ModelPart[], regions: AutoAssignment[]): AutoAssignmentResult {
  if (!Array.isArray(regions) || regions.length > 32) throw new Error('Apply at most 32 tooth proposals at once.');
  const seen = new Set<number>(), visited = new Map<string, Uint8Array>();
  const partsById = new Map(parts.map(part => [part.id, part]));
  for (const region of regions) {
    const part = partsById.get(region.partId);
    if (!isFdiTooth(region.tooth) || seen.has(region.tooth) || !part || part.role !== toothArch(region.tooth) || !(region.faces instanceof Uint32Array)) throw new Error('Every mapped region must have a unique FDI number on its matching arch.');
    seen.add(region.tooth);
    let mask = visited.get(part.id);
    if (!mask) { mask = new Uint8Array(part.triangles); visited.set(part.id, mask); }
    for (const face of region.faces) {
      if (face >= part.triangles || mask[face]) throw new Error('Automatic regions contain an invalid or overlapping triangle.');
      mask[face] = 1;
    }
  }
  const counts = toothCounts(data.labels);
  const labels = { ...data.labels }, teeth = { ...data.teeth };
  const copied = new Set<string>(), applied: number[] = [], skipped: AutoAssignmentResult['skipped'] = [];
  let triangles = 0;
  for (const region of regions) {
    const record = teeth[region.tooth];
    if (record.status === 'missing' || record.status === 'not-scanned' || counts[region.tooth]) {
      skipped.push({ tooth: region.tooth, reason: counts[region.tooth] ? 'Existing surface assignment preserved' : `Reviewed ${record.status} status preserved` }); continue;
    }
    const part = partsById.get(region.partId)!;
    const before = labels[part.id];
    const eligible = region.faces.filter(face => !before?.[face] && !data.reviewedMask?.[part.id]?.[face]);
    if (!eligible.length) { skipped.push({ tooth: region.tooth, reason: 'All triangles are protected or excluded' }); continue; }
    if (!copied.has(part.id)) { labels[part.id] = before?.slice() ?? new Uint8Array(part.triangles); copied.add(part.id); }
    for (const face of eligible) labels[part.id][face] = region.tooth;
    teeth[region.tooth] = { ...record, status: 'present', restoration: record.restoration === 'crown' ? 'crown' : 'none', site: undefined };
    triangles += eligible.length; applied.push(region.tooth);
  }
  return { data: applied.length ? { labels, teeth, ...(data.reviewedMask ? { reviewedMask: data.reviewedMask } : {}) } : data, applied, skipped, triangles };
}
