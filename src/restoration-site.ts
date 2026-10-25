import { Triangle, Vector3 } from 'three';
import { toothArch, isFdiTooth } from './teeth.ts';
import { partMatrix } from './pose.ts';
import type { ModelPart, Vec3 } from './models';
import type { SurfaceAnchor, ToothCase } from './tooth-types';
import type { AutoToothScan } from './auto-tooth-types';
import type { RestorationSpec } from './restoration-types';

type Frame = RestorationSpec['frame'];
type ScanSource = { partId: string; scan: AutoToothScan };
interface Crown { center: Vector3; size: number }
interface Source { parts: ModelPart[]; frame: Frame; crowns: Map<number, Crown>; assigned: Set<number> }
interface Bounds { left: number; right: number; missing: number[]; slot: number; sequence: number[] }

// A short interpolation experiment, not an anatomical reconstruction of a long edentulous arch.
const MAX_MISSING_RUN = 3;
const vector = (point: Vec3) => new Vector3(...point);
const finitePoint = (point: unknown): point is Vec3 => Array.isArray(point) && point.length === 3 && point.every(value => typeof value === 'number' && Number.isFinite(value));

function archSequence(fdi: number): number[] {
  return toothArch(fdi) === 'upper'
    ? [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28]
    : [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38];
}

function boundsFor(fdi: number, teeth: ToothCase): Bounds {
  const sequence = archSequence(fdi), index = sequence.indexOf(fdi);
  const search = (direction: number) => {
    let at = index + direction;
    while (at >= 0 && at < sequence.length && teeth.teeth[sequence[at]]?.status === 'missing') at += direction;
    return teeth.teeth[sequence[at]]?.status === 'present' ? at : -1;
  };
  const left = search(-1), right = search(1);
  if (left < 0 || right < 0) throw new Error('The site needs two reviewed present neighbours; unknown or not-scanned positions cannot be skipped.');
  const missing = sequence.slice(left + 1, right);
  if (missing.length > MAX_MISSING_RUN) throw new Error(`Automatic localization is limited to ${MAX_MISSING_RUN} consecutive reviewed missing positions.`);
  return { left: sequence[left], right: sequence[right], missing, slot: index - left, sequence };
}

function sourceFrame(scan: AutoToothScan | undefined): Frame {
  if (!scan || scan.method === 'unavailable' || ![scan.frame?.origin, scan.frame?.u, scan.frame?.v, scan.frame?.up].every(finitePoint)) throw new Error('Local arch orientation is unavailable.');
  const up = vector(scan.frame.up).normalize(), u = vector(scan.frame.u).normalize();
  u.addScaledVector(up, -u.dot(up));
  if (up.lengthSq() < .99 || u.lengthSq() < 1e-12) throw new Error('Local arch orientation has collapsed or parallel axes.');
  u.normalize();
  const v = new Vector3().crossVectors(up, u);
  if (vector(scan.frame.v).normalize().dot(v) < .99) throw new Error('Local arch orientation has inconsistent transverse axes.');
  return { origin: [...scan.frame.origin], u: u.toArray(), v: v.toArray(), up: up.toArray() };
}

function loadTriangle(part: ModelPart, face: number, triangle: Triangle): boolean {
  triangle.a.fromArray(part.positions, face * 9); triangle.b.fromArray(part.positions, face * 9 + 3); triangle.c.fromArray(part.positions, face * 9 + 6);
  const area = triangle.getArea();
  return [triangle.a, triangle.b, triangle.c].every(point => Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z)) && area > 0 && Number.isFinite(area);
}

function samePose(parts: ModelPart[]): boolean {
  let scale = Infinity;
  const triangle = new Triangle();
  for (const part of parts) for (let face = 0; face < part.triangles; face++) {
    if (!loadTriangle(part, face, triangle)) continue;
    scale = Math.min(scale, Math.max(triangle.a.distanceTo(triangle.b), triangle.b.distanceTo(triangle.c), triangle.c.distanceTo(triangle.a)));
    break;
  }
  if (!Number.isFinite(scale)) return false;
  const base = partMatrix(parts[0]).elements;
  // Translation tolerance follows a local surface feature, independent of the workspace origin.
  return parts.every(part => partMatrix(part).elements.every((value, index) => Number.isFinite(value) && Math.abs(value - base[index]) <= (index >= 12 && index <= 14 ? scale * 1e-9 : 1e-12)));
}

function sharedFrame(parts: ModelPart[], scans: ScanSource[]): Frame {
  const available = parts.map(part => scans.find(item => item.partId === part.id)?.scan).filter((scan): scan is AutoToothScan => !!scan && scan.method !== 'unavailable');
  const frame = sourceFrame(available[0]);
  if (available.some(scan => vector(sourceFrame(scan).up).dot(vector(frame.up)) < .95)) throw new Error('Parts from this import disagree on local arch orientation.');
  return frame;
}

function summarize(parts: ModelPart[], frame: Frame, teeth: ToothCase): Source {
  const axes = [frame.u, frame.v, frame.up].map(vector), reference = vector(frame.origin), triangle = new Triangle();
  const groups = new Map<number, { area: number; center: Vector3; low: number[]; high: number[] }>();
  const assigned = new Set<number>();
  for (const part of parts) {
    const labels = teeth.labels[part.id];
    if (part.positions.length !== part.triangles * 9 || (labels && labels.length !== part.triangles)) throw new Error('Source geometry and reviewed triangle labels do not match.');
    for (let face = 0; face < part.triangles; face++) {
      const code = labels?.[face];
      if (!isFdiTooth(code)) continue;
      assigned.add(code);
      if (teeth.teeth[code]?.status !== 'present' || !loadTriangle(part, face, triangle)) continue;
      const group = groups.get(code) ?? { area: 0, center: new Vector3(), low: [Infinity, Infinity, Infinity], high: [-Infinity, -Infinity, -Infinity] };
      const area = triangle.getArea(); group.area += area;
      // Surface area weighting makes the centre independent of local triangle density.
      group.center.lerp(triangle.getMidpoint(new Vector3()), area / group.area);
      for (const point of [triangle.a, triangle.b, triangle.c]) for (let axis = 0; axis < 3; axis++) {
        const value = point.clone().sub(reference).dot(axes[axis]);
        group.low[axis] = Math.min(group.low[axis], value); group.high[axis] = Math.max(group.high[axis], value);
      }
      groups.set(code, group);
    }
  }
  return { parts, frame, assigned, crowns: new Map([...groups].map(([code, group]) => [code, { center: group.center, size: Math.max(...group.high.map((value, axis) => value - group.low[axis])) }])) };
}

function reviewedAnchor(part: ModelPart, site: SurfaceAnchor, teeth: ToothCase): SurfaceAnchor {
  if (!Number.isSafeInteger(site.face) || site.face < 0 || site.face >= part.triangles || !finitePoint(site.point)) throw new Error('The reviewed site is not a valid source anchor.');
  if (teeth.labels[part.id]?.[site.face]) throw new Error('The missing site conflicts with an assigned or excluded tooth surface.');
  const triangle = new Triangle();
  if (!loadTriangle(part, site.face, triangle)) throw new Error('The reviewed site is off its source surface or the triangle is degenerate.');
  const closest = triangle.closestPointToPoint(vector(site.point), new Vector3());
  const localSize = Math.max(triangle.a.distanceTo(triangle.b), triangle.b.distanceTo(triangle.c), triangle.c.distanceTo(triangle.a));
  const tolerance = Math.max(localSize * 1e-5, Number.EPSILON * Math.max(...site.point.map(Math.abs), 1) * 64);
  if (!closest.toArray().every(Number.isFinite) || closest.distanceTo(vector(site.point)) > tolerance) throw new Error('The reviewed site is off its source surface.');
  return { partId: part.id, face: site.face, point: [...site.point] };
}

/** Clip a triangle to a local search box before ranking; a closer invalid face must not hide valid support. */
function clippedClosest(points: Vector3[], low: number[], high: number[], target: Vector3): Vector3 | null {
  let polygon = points;
  for (let axis = 0; axis < 3; axis++) for (const side of [-1, 1]) {
    const bound = side < 0 ? low[axis] : high[axis], next: Vector3[] = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length];
      const da = (a.getComponent(axis) - bound) * side, db = (b.getComponent(axis) - bound) * side;
      if (da <= 0) next.push(a);
      if ((da < 0 && db > 0) || (da > 0 && db < 0)) next.push(a.clone().lerp(b, da / (da - db)));
    }
    polygon = next;
    if (polygon.length < 3) return null;
  }
  const triangle = new Triangle(), closest = new Vector3(); let winner: Vector3 | null = null, distance = Infinity;
  for (let i = 1; i + 1 < polygon.length; i++) {
    triangle.set(polygon[0], polygon[i], polygon[i + 1]);
    if (!(triangle.getArea() > 0)) continue;
    triangle.closestPointToPoint(target, closest);
    const d = closest.distanceToSquared(target);
    if (Number.isFinite(d) && d < distance) { distance = d; winner = closest.clone(); }
  }
  return winner;
}

function inferredAnchor(source: Source, bounds: Bounds, teeth: ToothCase) {
  const left = source.crowns.get(bounds.left), right = source.crowns.get(bounds.right);
  if (!left || !right) throw new Error('Both reviewed neighbouring crowns need usable surfaces from the same import.');
  if (bounds.missing.some(code => source.assigned.has(code))) throw new Error('A reviewed missing position conflicts with an assigned tooth surface.');
  const scale = (left.size + right.size) / 2, up = vector(source.frame.up);
  const delta = right.center.clone().sub(left.center), height = delta.dot(up), along = delta.clone().addScaledVector(up, -height);
  const spacing = along.length(), steps = bounds.missing.length + 1, step = spacing / steps;
  if (!(scale > 0) || !Number.isFinite(scale) || spacing <= scale * 1e-6 || step < scale * .2 || step > scale * 4 || Math.abs(height) > scale * 2 || Math.max(left.size, right.size) > Math.min(left.size, right.size) * 4) throw new Error('The reviewed crown bounds have ambiguous projected spacing or scale.');
  along.normalize(); const across = new Vector3().crossVectors(up, along);
  const leftAt = bounds.sequence.indexOf(bounds.left), rightAt = bounds.sequence.indexOf(bounds.right);
  const outerLeft = source.crowns.get(bounds.sequence[leftAt - 1]), outerRight = source.crowns.get(bounds.sequence[rightAt + 1]);
  const slope = (tangent: Vector3) => {
    const forward = tangent.dot(along);
    if (forward <= scale * 1e-6 || tangent.length() > step * 4) throw new Error('The surrounding reviewed crown sequence does not support a local arch direction.');
    return tangent.dot(across) / forward;
  };
  const leftSlope = outerLeft ? slope(left.center.clone().sub(outerLeft.center)) : null;
  const rightSlope = outerRight ? slope(outerRight.center.clone().sub(right.center)) : null;
  if ([leftSlope, rightSlope].some(value => value !== null && Math.abs(value) > 1.5) || ((leftSlope === null || rightSlope === null) && Math.max(Math.abs(leftSlope ?? 0), Math.abs(rightSlope ?? 0)) > .35)) throw new Error('Local arch curvature is unresolved; locate the site for review.');
  const curved = leftSlope !== null && rightSlope !== null, a = curved ? leftSlope : 0, b = curved ? rightSlope : 0;
  const t = bounds.slot / steps;
  const bow = spacing * ((t ** 3 - 2 * t * t + t) * a + (t ** 3 - t * t) * b);
  if (Math.abs(bow) > scale * 2) throw new Error('The inferred arch curve exceeds the bounded local experiment.');
  const target = new Vector3(t * spacing, bow, height * t);
  // Separate slots keep multiple missing positions ordered. All limits use local crown evidence,
  // never the total gap length as a proxy for an allowed tissue/bone distance.
  const low = [(t - .3 / steps) * spacing, bow - scale * .5, target.z - scale * 2];
  const high = [(t + .3 / steps) * spacing, bow + scale * .5, target.z + scale * .15];
  const local = (point: Vector3) => { const d = point.clone().sub(left.center); return new Vector3(d.dot(along), d.dot(across), d.dot(up)); };
  const triangle = new Triangle();
  const candidates = (visit: (point: Vector3, part: ModelPart, face: number) => void) => {
    for (const part of source.parts) for (let face = 0; face < part.triangles; face++) {
      if ((teeth.labels[part.id]?.[face] ?? 0) !== 0 || !loadTriangle(part, face, triangle)) continue;
      const points = [triangle.a, triangle.b, triangle.c].map(local);
      if ([0, 1, 2].some(axis => points.every(point => point.getComponent(axis) < low[axis]) || points.every(point => point.getComponent(axis) > high[axis]))) continue;
      const point = clippedClosest(points, low, high, target);
      if (point) visit(point, part, face);
    }
  };
  let winner: { point: Vector3; part: ModelPart; face: number } | null = null, distance = Infinity;
  candidates((point, part, face) => { const d = point.distanceToSquared(target); if (d < distance) { distance = d; winner = { point, part, face }; } });
  const selected = winner as { point: Vector3; part: ModelPart; face: number } | null;
  if (!selected) throw new Error('No supporting unassigned ridge surface was found inside this bounded missing-position slot.');
  let ambiguous = false;
  candidates(point => { if (point.distanceToSquared(target) <= distance + (scale * .1) ** 2 && point.distanceTo(selected.point) > scale * .4) ambiguous = true; });
  if (ambiguous) throw new Error('Multiple ridge surfaces support different site hypotheses; locate the site for review.');
  const origin = left.center.clone().addScaledVector(along, selected.point.x).addScaledVector(across, selected.point.y).addScaledVector(up, selected.point.z).toArray();
  const derivative = (3 * t * t - 4 * t + 1) * a + (3 * t * t - 2 * t) * b;
  const u = along.clone().addScaledVector(across, derivative).normalize();
  if (u.dot(vector(source.frame.u)) < 0) u.negate();
  return { anchor: { partId: selected.part.id, face: selected.face, point: origin }, frame: { origin, u: u.toArray(), v: new Vector3().crossVectors(up, u).toArray(), up: up.toArray() }, scale: Math.min(scale, step), curved };
}

function fallbackScale(source: Source, teeth: ToothCase): number {
  const axes = [source.frame.u, source.frame.v, source.frame.up].map(vector), low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
  const triangle = new Triangle(), reference = vector(source.frame.origin);
  for (const part of source.parts) for (let face = 0; face < part.triangles; face++) {
    if (teeth.labels[part.id]?.[face] === 255 || !loadTriangle(part, face, triangle)) continue;
    for (const corner of [triangle.a, triangle.b, triangle.c]) {
      const point = corner.clone().sub(reference);
      for (let axis = 0; axis < 3; axis++) {
        const value = point.dot(axes[axis]);
        low[axis] = Math.min(low[axis], value); high[axis] = Math.max(high[axis], value);
      }
    }
  }
  return Math.max(...high.map((value, axis) => value - low[axis])) / 10;
}

/** One immutable worker-request snapshot; reuse surface summaries across sites. Stale workers are terminated by the host. */
export function createRestorationSiteProposer(parts: ModelPart[], teeth: ToothCase, scans: ScanSource[]) {
  const cache = new Map<string, Source | Error>();
  return (fdi: number): RestorationSpec => {
    if (!isFdiTooth(fdi)) throw new Error('Choose a permanent FDI position.');
    const record = teeth.teeth[fdi];
    if (record?.status !== 'missing' || record.restoration !== 'implant') throw new Error(`FDI ${fdi}: confirm the missing site and implant planning intent first.`);
    const arch = parts.filter(part => part.role === toothArch(fdi) && !part.restoration).sort((a, b) => a.id.localeCompare(b.id));
    const groups = new Map<string, ModelPart[]>();
    for (const part of arch) { const key = part.sourceFileId ? `file:${part.sourceFileId}` : `part:${part.id}`; groups.set(key, [...(groups.get(key) ?? []), part]); }
    let source: Source, anchor: SurfaceAnchor, frame: Frame, scale: number, description: string;
    let bounds: Bounds | undefined;
    if (record.site) {
      const parent = arch.find(part => part.id === record.site!.partId);
      if (!parent) throw new Error(`FDI ${fdi}: the reviewed site does not match an imported source in this arch.`);
      anchor = reviewedAnchor(parent, record.site, teeth);
      const siblings = [...groups.values()].find(group => group.includes(parent))!;
      const compatible = samePose(siblings) ? siblings : [parent];
      const ownScan = scans.find(item => item.partId === parent.id)?.scan;
      frame = ownScan && ownScan.method !== 'unavailable' ? sourceFrame(ownScan) : sharedFrame(compatible, scans);
      source = summarize(compatible, frame, teeth);
      const sequence = archSequence(fdi), at = sequence.indexOf(fdi);
      const nearby = [sequence[at - 1], sequence[at + 1]].map(code => source.crowns.get(code)?.size).filter((value): value is number => value !== undefined && value > 0);
      scale = nearby.length ? nearby.reduce((sum, value) => sum + value) / nearby.length : fallbackScale(source, teeth);
      const neighbours = [sequence[at - 1], sequence[at + 1]].map(code => source.crowns.get(code)).filter((crown): crown is Crown => !!crown);
      if (neighbours.length === 2) { const up = vector(frame.up), u = neighbours[1].center.clone().sub(neighbours[0].center); u.addScaledVector(up, -u.dot(up)); if (u.lengthSq() > 1e-12) { u.normalize(); frame = { ...frame, u: u.toArray(), v: new Vector3().crossVectors(up, u).toArray() }; } }
      frame = { ...frame, origin: anchor.point };
      description = `Reviewed surface site; ${nearby.length ? 'neighbouring surface envelope ratios' : 'arch-frame extent fallback'}; all dimensions hypothesized`;
    } else {
      try { bounds = boundsFor(fdi, teeth); } catch (error) { throw new Error(`FDI ${fdi}: ${(error as Error).message} Use “Locate missing site” in corrections.`); }
      const hypotheses: { source: Source; result: ReturnType<typeof inferredAnchor> }[] = [], reasons: string[] = [];
      for (const [key, group] of groups) {
        try {
          const cacheKey = `${toothArch(fdi)}:${key}`;
          if (!cache.has(cacheKey)) {
            try {
              if (!samePose(group)) throw new Error('Parts from this import no longer share a rigid pose.');
              cache.set(cacheKey, summarize(group, sharedFrame(group, scans), teeth));
            } catch (error) { cache.set(cacheKey, error instanceof Error ? error : new Error(String(error))); }
          }
          const prepared = cache.get(cacheKey)!;
          if (prepared instanceof Error) throw prepared;
          hypotheses.push({ source: prepared, result: inferredAnchor(prepared, bounds, teeth) });
        } catch (error) { reasons.push((error as Error).message); }
      }
      if (hypotheses.length !== 1) throw new Error(`FDI ${fdi}: ${hypotheses.length ? 'Multiple imported sources support this site; choose a reviewed surface marker.' : `The site cannot be localized from two reviewed neighbours and supporting ridge geometry. ${reasons[0] ?? ''}`} Use “Locate missing site” in corrections.`);
      const hypothesis = hypotheses[0]; source = hypothesis.source;
      ({ anchor, frame, scale } = hypothesis.result);
      description = `Bounded ${bounds.missing.length}-position gap between reviewed FDI ${bounds.left}/${bounds.right}; slot ${bounds.slot}/${bounds.missing.length}, equal-spacing ${hypothesis.result.curved ? 'reviewed-crown tangent curve' : 'short-chord'} hypothesis snapped to unassigned surface; all dimensions hypothesized`;
    }
    if (!(scale > 0) || !Number.isFinite(scale)) throw new Error('The site has no usable geometric scale.');
    // Editable visual envelopes only. Surface localization does not establish implant suitability.
    return {
      version: 'implant-assembly/v1', componentDesign: 'nested-support/v1', fdi, parentPartId: anchor.partId, frame,
      anatomy: fdi % 10 <= 2 ? 'incisor' : fdi % 10 === 3 ? 'canine' : fdi % 10 <= 5 ? 'premolar' : 'molar',
      parameters: { fixture: { radius: scale * .2, length: scale, depth: scale * .1, taper: .25 }, abutment: { radius: scale * .18, height: scale * .3, emergenceRadius: scale * .23, angleX: 0, angleY: 0 }, crown: { width: scale * .8, depth: scale * .75, height: scale * .6, cuspHeight: 0, rotation: 0 } },
      provenance: 'hypothesized', units: 'file units (u)', source: `${description}; bone, implant suitability and compatibility unassessed.`,
      siteEvidence: { method: record.site ? 'reviewed-surface' : 'bounded-gap', partIds: arch.map(part => part.id), fdis: archSequence(fdi), surface: anchor, ...(bounds ? { bounds: [bounds.left, bounds.right] as [number, number], slot: { index: bounds.slot, count: bounds.missing.length } } : {}) },
    };
  };
}

/** A surface localization, never a bone/implant placement calculation. Run in a worker. */
export function proposeRestorationSpec(fdi: number, parts: ModelPart[], teeth: ToothCase, scans: ScanSource[]): RestorationSpec {
  return createRestorationSiteProposer(parts, teeth, scans)(fdi);
}
