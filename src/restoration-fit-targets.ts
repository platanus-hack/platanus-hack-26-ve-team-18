import type { ModelPart, Vec3 } from './models.ts';
import type { RestorationAssembly, RestorationFitReport, RestorationSpec } from './restoration-types.ts';
import { conceptKey } from './planning-automation.ts';
import { partMatrix } from './pose.ts';
import { toothArch } from './teeth.ts';

/** Worker-only descriptors. Vertices remain in the owning scan's file frame;
 * the pose follows the same rule as displayParts, including reopened meshes. */
export interface GeneratedCrownPart extends ModelPart {
  fitTarget: { siteKey: string; fdi: number | null; origin: Vec3; revision: string; hypothesisDependent: boolean; current: boolean };
}
export function generatedCrownTargetId(part: ModelPart): string | undefined {
  const target = (part as Partial<GeneratedCrownPart>).fitTarget;
  return target && part.restoration?.component === 'crown'
    ? `${part.restoration.parentPartId}:generated-crown:${encodeURIComponent(part.restoration.assemblyId)}:${encodeURIComponent(target.revision)}:${target.fdi === null ? 'draft-site' : `FDI-${target.fdi}`}` : undefined;
}

/** Include stale reports here: stale pair evidence does not itself change the
 * target's mesh. Otherwise two mutually dependent fits invalidate in a loop. */
export function restorationCrownParts(parts: ModelPart[], assemblies: RestorationAssembly[]): GeneratedCrownPart[] {
  const parents = new Map(parts.filter(part => !part.restoration).map(part => [part.id, part]));
  const poses = new Map<string, number[]>();
  const crowns: GeneratedCrownPart[] = assemblies.flatMap(assembly => {
    const parent = parents.get(assembly.spec.parentPartId);
    if (!parent || parent.role !== toothArch(assembly.spec.fdi)) return [];
    if (!poses.has(parent.id)) poses.set(parent.id, partMatrix(parent).toArray());
    return assembly.parts.filter(part => part.restoration?.component === 'crown'
      && part.restoration.assemblyId === assembly.id && part.restoration.parentPartId === parent.id).map(part => ({
      ...part, pose: poses.get(parent.id),
      restoration: { ...part.restoration!, stale: assembly.warnings.some(warning => warning.startsWith('STALE:')) },
      fitTarget: { siteKey: conceptKey(assembly.spec), fdi: assembly.spec.draftIdentity ? null : assembly.spec.fdi,
        origin: assembly.spec.frame.origin, revision: assembly.createdAt, current: false,
        hypothesisDependent: !!(assembly.draftSite || assembly.spec.draftIdentity || assembly.spec.source.startsWith('AI-proposed missing-site hypothesis.')
          || assembly.warnings.some(warning => warning.startsWith('AI-proposed missing-site hypothesis.'))) },
    }));
  });
  const current = new Map<string, GeneratedCrownPart>();
  for (const crown of crowns) {
    const previous = current.get(crown.fitTarget.siteKey);
    if (!previous || previous.restoration!.stale || !crown.restoration!.stale) current.set(crown.fitTarget.siteKey, crown);
  }
  // Match the default displayed alternative. Retain the latest stale crown
  // only for dependency comparisons if a site has no current report at all.
  for (const crown of crowns) crown.fitTarget.current = current.get(crown.fitTarget.siteKey) === crown;
  return crowns;
}

/** One current crown per other site. Hiding a component is presentation only;
 * own components and same-site alternatives are never external fit targets. */
export function restorationFitParts(spec: RestorationSpec, id: string, parts: ModelPart[], assemblies: RestorationAssembly[]): ModelPart[] {
  const current = new Map<string, GeneratedCrownPart>();
  for (const crown of restorationCrownParts(parts, assemblies)) {
    if (!crown.fitTarget.current || crown.restoration!.assemblyId === id || crown.fitTarget.siteKey === conceptKey(spec) || crown.restoration!.stale) continue;
    current.set(crown.fitTarget.siteKey, crown);
  }
  return [...parts.filter(part => !part.restoration && (part.role === 'upper' || part.role === 'lower')), ...current.values()];
}

export function generatedFitTargetIds(report: RestorationFitReport | undefined): string[] {
  return report?.after.surfaces.filter(surface => surface.id.includes(':generated-crown:')).map(surface => surface.id) ?? [];
}
