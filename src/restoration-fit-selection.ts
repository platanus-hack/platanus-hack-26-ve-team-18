import type { RestorationFitMeasurement } from './restoration-types';
import type { RestorationQualityReport } from './restoration-quality';

/** Shared by fitting and session validation. A lower score cannot purchase lost
 * observed bite coverage or a new intersection on a previously clear target. */
export function acceptsFitCandidate(candidate: RestorationFitMeasurement, best: RestorationFitMeasurement,
  quality?: RestorationQualityReport, bestQuality?: RestorationQualityReport): boolean {
  if (!(candidate.score + 1e-10 < best.score) || candidate.surfaces.length !== best.surfaces.length) return false;
  // A better objective cannot buy a newly failed check or discard evidence.
  if (quality && bestQuality && bestQuality.criteria.some(previous => {
    const next = quality.criteria.find(item => item.id === previous.id);
    return !next || (previous.status === 'pass' && next.status !== 'pass')
      || (previous.status === 'unknown' && next.status === 'fail');
  })) return false;
  return best.surfaces.every(previous => {
    const next = candidate.surfaces.find(surface => surface.id === previous.id);
    if (!next || next.role !== previous.role || (previous.intersectingTriangles === 0 && next.intersectingTriangles > 0)) return false;
    if (quality && bestQuality && previous.targetGap > 0 && previous.sampledMinDistance >= previous.targetGap
      && next.sampledMinDistance < next.targetGap) return false;
    if (quality && bestQuality) {
      if ((previous.transverseCrossingTriangles ?? previous.intersectingTriangles) === 0
        && (next.transverseCrossingTriangles ?? next.intersectingTriangles) > 0) return false;
      const before = bestQuality.crownExtents, after = quality.crownExtents;
      // Composite criteria can already fail because of the opposite side.
      // Preserve each previously satisfactory contact separately.
      if (before && after && previous.role === 'adjacent'
        && previous.sampledMinDistance - previous.targetGap <= bestQuality.tolerances.proximalOpenFraction * before.mesiodistal
        && next.sampledMinDistance - next.targetGap > quality.tolerances.proximalOpenFraction * after.mesiodistal) return false;
      if (before && after && previous.role === 'antagonist' && previous.sampledOcclusalGap != null
        && previous.sampledOcclusalGap - previous.targetGap <= bestQuality.tolerances.occlusalOpenFraction * before.occlusal
        && (next.sampledOcclusalGap == null || next.sampledOcclusalGap - next.targetGap > quality.tolerances.occlusalOpenFraction * after.occlusal)) return false;
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
