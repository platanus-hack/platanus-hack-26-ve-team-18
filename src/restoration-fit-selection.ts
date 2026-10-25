import type { RestorationFitMeasurement } from './restoration-types';
import type { RestorationQualityReport } from './restoration-quality';

/** Shared by fitting and session validation. A lower score cannot purchase lost
 * observed bite coverage or a new intersection on a previously clear target. */
export function acceptsFitCandidate(candidate: RestorationFitMeasurement, best: RestorationFitMeasurement,
  quality?: RestorationQualityReport, bestQuality?: RestorationQualityReport): boolean {
  return candidate.score + 1e-10 < best.score && preservesFitEvidence(candidate, best, quality, bestQuality);
}

/** Also used for exact agent edits: presentation-only changes need not lower
 * the fitting score, but may never buy a loss of geometric evidence. */
export function preservesFitEvidence(candidate: RestorationFitMeasurement, best: RestorationFitMeasurement,
  quality?: RestorationQualityReport, bestQuality?: RestorationQualityReport): boolean {
  if (candidate.surfaces.length !== best.surfaces.length) return false;
  // A better objective cannot buy a newly failed check or discard evidence.
  if (quality && bestQuality && bestQuality.criteria.some(previous => {
    const next = quality.criteria.find(item => item.id === previous.id);
    return !next || (previous.status === 'pass' && next.status !== 'pass')
      || (previous.status === 'unknown' && next.status === 'fail');
  })) return false;
  if (quality && bestQuality) {
    // Composite failures must not conceal a newly oversized axis or worsen an
    // existing overfill while another objective improves. Compare each bound,
    // including the two independent space-occupancy measurements.
    for (const [id, key, high, oldHigh] of [
      ['relative-width', 'ratio', quality.tolerances?.widthToNeighbor?.[1], bestQuality.tolerances?.widthToNeighbor?.[1]],
      ['relative-depth', 'ratio', quality.tolerances?.depthToNeighbor?.[1], bestQuality.tolerances?.depthToNeighbor?.[1]],
      ['relative-height', 'ratio', quality.tolerances?.heightToNeighbor?.[1], bestQuality.tolerances?.heightToNeighbor?.[1]],
      ['space-occupancy', 'mesiodistalOccupancy', quality.tolerances?.gapOccupancy?.[1], bestQuality.tolerances?.gapOccupancy?.[1]],
      ['space-occupancy', 'verticalOccupancy', quality.tolerances?.heightOccupancyMax, bestQuality.tolerances?.heightOccupancyMax],
    ] as const) {
      const before = bestQuality.criteria.find(item => item.id === id)?.measured?.[key];
      const after = quality.criteria.find(item => item.id === id)?.measured?.[key];
      if (typeof before !== 'number' || typeof oldHigh !== 'number') continue;
      if (typeof after !== 'number' || !Number.isFinite(after) || typeof high !== 'number'
        || Math.max(0, after - high) > Math.max(0, before - oldHigh) + 1e-9) return false;
    }
  }
  return best.surfaces.every(previous => {
    const next = candidate.surfaces.find(surface => surface.id === previous.id);
    if (!next || next.role !== previous.role || (previous.intersectingTriangles === 0 && next.intersectingTriangles > 0)) return false;
    const observedCrossings = previous.transverseCrossingTriangles ?? previous.intersectingTriangles;
    const nextCrossings = next.transverseCrossingTriangles ?? next.intersectingTriangles;
    if (observedCrossings > 0 && nextCrossings < observedCrossings && !next.intersectionComplete) return false;
    if (quality && bestQuality && previous.targetGap > 0) {
      const oldDeficit = Math.max(0, previous.targetGap - previous.sampledMinDistance);
      const nextDeficit = Math.max(0, next.targetGap - next.sampledMinDistance);
      const allowance = Math.max(previous.targetGap, previous.sampledMinDistance, next.sampledMinDistance, Number.MIN_VALUE) * 1e-9;
      if (nextDeficit > oldDeficit + allowance) return false;
    }
    if (quality && bestQuality) {
      if (next.side !== previous.side || next.targetGap !== previous.targetGap
        || next.sourceRegion !== previous.sourceRegion
        || JSON.stringify(next.sourceComponents) !== JSON.stringify(previous.sourceComponents)) return false;
      // A reduced score cannot purchase more observed crossings on an already
      // failing target, or less complete evidence on that same target.
      if (previous.intersectionComplete && !next.intersectionComplete) return false;
      const observed = previous.transverseCrossingTriangles;
      if (observed !== undefined && (next.transverseCrossingTriangles === undefined
        || next.transverseCrossingTriangles > observed)) return false;
      if ((previous.transverseCrossingTriangles ?? previous.intersectingTriangles) === 0
        && (next.transverseCrossingTriangles ?? next.intersectingTriangles) > 0) return false;
      const before = bestQuality.crownExtents, after = quality.crownExtents;
      // Composite criteria can already fail because of the opposite side.
      // Preserve each previously satisfactory contact separately.
      if (before && after && previous.role === 'adjacent'
        && previous.sampledMinDistance - previous.targetGap <= bestQuality.tolerances.proximalOpenFraction * before.mesiodistal
        && next.sampledMinDistance - next.targetGap > bestQuality.tolerances.proximalOpenFraction * before.mesiodistal) return false;
      if (before && after && previous.role === 'antagonist' && previous.sampledOcclusalGap != null
        && previous.sampledOcclusalGap - previous.targetGap <= bestQuality.tolerances.occlusalOpenFraction * before.occlusal
        && (next.sampledOcclusalGap == null || next.sampledOcclusalGap - next.targetGap > bestQuality.tolerances.occlusalOpenFraction * before.occlusal)) return false;
      // An incomplete zero test cannot establish removal of an observed crossing.
      if (!next.intersectionComplete && next.intersectingTriangles === 0 && previous.intersectingTriangles > 0) return false;
      // Per target, so an already failing or unknown composite rule cannot mask
      // lost evidence: a capped test with zero crossings (touches or not) can
      // neither replace complete zero-crossing evidence nor clear an observed crossing.
      const crossings = (item: RestorationFitMeasurement['surfaces'][number]) => item.transverseCrossingTriangles ?? item.intersectingTriangles;
      if (!next.intersectionComplete && crossings(next) === 0
        && ((previous.intersectionComplete && crossings(previous) === 0) || crossings(previous) > 0)) return false;
    }
    if (previous.role === 'antagonist' && (previous.occlusalRayHits ?? 0) > 0) {
      // Compare proportions exactly by cross multiplication; resampling can
      // change the number of unique triangle centroids in a candidate.
      if (!(next.occlusalRaySamples! > 0) ||
          !(next.occlusalRayHits! * previous.occlusalRaySamples! >= previous.occlusalRayHits! * next.occlusalRaySamples!)) return false;
    }
    return true;
  });
}
