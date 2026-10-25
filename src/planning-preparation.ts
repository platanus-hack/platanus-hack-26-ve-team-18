import type { CasePreparationResult } from './case-preparation-types';
import type { PlanningPreparationEvidence, PlanningToothReference } from './case-planning-types';
import type { SiteNeighbour } from './missing-sites';
import type { ModelPart } from './models';
import type { ToothCase } from './tooth-types';
import { automaticConceptSites } from './planning-automation.ts';
import { localPlanningResult } from './draft-workflow.ts';
import { toothCounts } from './teeth.ts';

/** Bounded anonymous worker evidence. Preserve relationships without sending mesh coordinates or filenames. */
export function planningPreparationEvidence(prepared: CasePreparationResult, parts: ModelPart[], threshold = .8, teeth?: ToothCase): PlanningPreparationEvidence {
  const sourceId = (partId: string) => `scan-${parts.findIndex(part => part.id === partId) + 1}`;
  const privateText = [...new Set(parts.flatMap(part => [part.id, part.name, part.fileName, part.sourceFileId, part.texture?.fileName]).filter((value): value is string => !!value))].sort((a, b) => b.length - a.length);
  const privatePattern = privateText.length ? new RegExp(privateText.map(token => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : null;
  const publicText = (value: string) => (privatePattern ? value.replace(privatePattern, '[local source]') : value).slice(0, 600);
  const bounded = (values: string[]) => values.slice(0, 12).map(publicText);
  const reference = (tooth: SiteNeighbour | null): PlanningToothReference | null => tooth ? {
    sourceId: sourceId(tooth.partId), candidateId: tooth.toothId, fdi: tooth.fdi, confidence: tooth.confidence,
  } : null;
  const eligible = new Set(teeth ? automaticConceptSites({ sites: prepared.sites, teeth, counts: toothCounts(teeth.labels), parts, result: localPlanningResult(prepared, parts) }).map(site => site.id) : []);
  return {
    threshold,
    sources: prepared.scans.map(source => ({ sourceId: sourceId(source.partId), method: publicText(source.scan.method).slice(0, 160), crownRegions: source.scan.candidates.length,
      unresolvedTriangles: source.scan.unassignedTriangles, boundaryFaces: source.analysis?.coverage.boundaryFaces ?? null,
      colourAvailable: !!parts.find(part => part.id === source.partId)?.tissueScores })),
    regions: prepared.scans.flatMap(source => {
      const candidates = source.scan.candidates.slice(0, 32), supplied = new Set(candidates.map(candidate => candidate.id));
      const ordered = (source.analysis?.teeth ?? []).filter(tooth => supplied.has(tooth.id)).slice().sort((a, b) => a.sCenter - b.sCenter);
      const finite = (value: number | undefined) => value !== undefined && Number.isFinite(value) && value >= 0 ? value : null;
      return candidates.map(candidate => {
        const tooth = source.analysis?.teeth.find(tooth => tooth.id === candidate.id);
        const identity = prepared.identities.find(identity => identity.partId === source.partId && identity.candidateId === candidate.id);
        const index = ordered.findIndex(tooth => tooth.id === candidate.id);
        return { sourceId: sourceId(source.partId), candidateId: candidate.id, fdi: identity ? identity.fdi : tooth?.fdi ?? null,
          confidence: identity?.confidence ?? 0, needsReview: identity?.needsReview ?? true, kind: tooth?.kind ?? 'unresolved',
          dimensions: { mesiodistal: finite(tooth?.mdWidth), buccolingual: finite(tooth?.blWidth), height: finite(tooth?.height) },
          peaks: finite(tooth?.peaks), flags: bounded([...new Set([...(tooth?.flags ?? []), ...candidate.warnings, ...(identity?.blockingReasons ?? [])])]),
          protectedTriangles: candidate.faces.reduce((count, face) => count + Number(!!teeth?.labels[source.partId]?.[face] || !!teeth?.reviewedMask?.[source.partId]?.[face]), 0),
          neighbors: index < 0 ? [] : [ordered[index - 1]?.id, ordered[index + 1]?.id].filter((id): id is number => id !== undefined),
        };
      });
    }),
    sites: prepared.sites.slice(0, 128).map((site, index) => ({ id: `site-${index + 1}`, sourceId: sourceId(site.partId), fdi: site.fdi,
      status: site.status, confidence: site.confidence, localized: !!site.anchor && !!site.frame, kind: site.kind, slotCount: site.slot.count,
      geometricDraftEligible: eligible.has(site.id),
      supporting: bounded(site.evidence.supporting), conflicting: bounded(site.evidence.conflicting), questions: bounded(site.questions),
      relationships: { adjacent: { mesial: reference(site.adjacent.mesial), distal: reference(site.adjacent.distal) }, contralateral: reference(site.contralateral),
        opposing: site.opposing ? { sourceId: sourceId(site.opposing.partId), teeth: site.opposing.teeth.slice(0, 32).map(tooth => reference(tooth)!), poseVerified: site.opposing.poseVerified } : null },
      space: { unit: 'file units (u)', mesiodistal: site.space.mesiodistal.value, buccolingual: site.space.buccolingual.value,
        sampledVertical: site.space.vertical.value, verticalMethod: publicText(site.space.vertical.method),
        crownHeight: site.space.crownHeight?.value ?? null, proximalGap: site.space.proximalGap?.value ?? null,
        widthMethod: publicText(site.space.proximalGap?.value !== null && site.space.proximalGap?.value !== undefined ? site.space.proximalGap.method : site.space.mesiodistal.method), heightMethod: publicText(site.space.crownHeight?.method ?? 'Unavailable neighboring crown-height evidence.') },
    })),
  };
}
