import { Color, Vector3 } from 'three';
import type { ModelPart, Vec3 } from './models.ts';
import type { RestorationSpec } from './restoration-types.ts';
import { partMatrix } from './pose.ts';
import { gingivaColorCue } from './texture-evidence.ts';

/** Presentation only: sampled scan colour is not a calibrated dental shade. */
export interface CrownEnamel {
  coordinates: Float32Array;
  colors: Float32Array;
  baseColor: string;
  source: 'nearby-scan-colors' | 'illustrative-fallback' | 'manual-display-color';
  samples: number;
  /** Bounded relative linear-colour variation, derived from accepted scan samples. */
  variation: number;
}
type EnamelPart = ModelPart & { crownEnamel?: CrownEnamel };
const fallback = '#d7d4c9';
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const srgb = (value: number) => value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
const cache = new WeakMap<Float32Array, { key: string; frameKey: string; local: ReturnType<typeof localFrame>; inputs: unknown[]; enamel: CrownEnamel }>();

export function crownEnamel(part: ModelPart): CrownEnamel | undefined {
  const enamel = (part as EnamelPart).crownEnamel;
  return part.restoration?.component === 'crown' && !part.reference
    && enamel?.coordinates.length === part.positions.length && enamel.colors.length === part.positions.length ? enamel : undefined;
}

/** Use measured crown extents in its construction frame, never world axes or millimetres. */
function localFrame(positions: Float32Array, spec: RestorationSpec) {
  const angle = spec.parameters.crown.rotation * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  const { origin, u, v, up } = spec.frame;
  const axes = [u.map((value, axis) => (value * c + v[axis] * s) * (spec.anatomicalSigns?.mesial ?? 1)),
    u.map((value, axis) => (-value * s + v[axis] * c) * (spec.anatomicalSigns?.buccal ?? 1)), up];
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const project = (x: number, y: number, z: number): Vec3 => axes.map(axis =>
    (x - origin[0]) * axis[0] + (y - origin[1]) * axis[1] + (z - origin[2]) * axis[2]) as Vec3;
  const coordinates = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const p = project(positions[i], positions[i + 1], positions[i + 2]);
    coordinates.set(p, i);
    for (let axis = 0; axis < 3; axis++) { min[axis] = Math.min(min[axis], p[axis]); max[axis] = Math.max(max[axis], p[axis]); }
  }
  const span = max.map((value, axis) => Math.max(value - min[axis], 1e-12));
  const normalize = (p: Vec3): Vec3 => p.map((value, axis) => (value - min[axis]) / span[axis] - (axis < 2 ? 0.5 : 0)) as Vec3;
  for (let i = 0; i < coordinates.length; i += 3) coordinates.set(normalize([coordinates[i], coordinates[i + 1], coordinates[i + 2]]), i);
  return { coordinates, project: (p: Vector3) => normalize(project(p.x, p.y, p.z)), areaScale: Math.max(...span) ** 2 };
}

function toothLikeColor(r: number, g: number, b: number) {
  const cue = gingivaColorCue(r, g, b);
  if (cue < 0 || cue > 0.1) return false;
  const red = srgb(r), green = srgb(g), blue = srgb(b);
  // Low redness alone also admits pale pink/magenta. Unknown atlas faces are
  // rejected separately, even if their retained RGB happens to look ivory.
  return blue <= green + 0.02 && Math.max(red, green, blue) - Math.min(red, green, blue) < 0.4
    && 0.2126 * r + 0.7152 * g + 0.0722 * b >= 0.15 && Math.min(r, g, b) < 0.93;
}

/** Bounded face samples, area/distance weighted median; no image decode or geometry edits. */
function neighboringColor(sources: ModelPart[], parent: ModelPart | undefined, local: ReturnType<typeof localFrame>, labels: Readonly<Record<string, Uint8Array>>) {
  if (!parent) return null;
  const inverse = partMatrix(parent).invert(), a = new Vector3(), b = new Vector3(), c = new Vector3(), point = new Vector3();
  const cells = new Map<string, { color: Vec3; distance: number; weight: number }>();
  const budget = Math.max(1, Math.floor(16_384 / Math.max(1, sources.length)));
  for (const source of sources) {
    const colors = source.colors, scores = source.tissueScores, faces = source.positions.length / 9;
    if (!colors || colors.length !== source.positions.length || !scores || scores.length !== faces) continue;
    const matrix = inverse.clone().multiply(partMatrix(source)), count = Math.min(faces, budget);
    for (let sample = 0; sample < count; sample++) {
      const face = Math.floor(sample * faces / count), offset = face * 9;
      if (!Number.isFinite(scores[face]) || scores[face] < 0 || scores[face] > 0.1 || labels[source.id]?.[face] === 255) continue;
      let valid = true;
      for (let corner = 0; corner < 3; corner++) {
        const i = offset + corner * 3;
        if (!toothLikeColor(colors[i], colors[i + 1], colors[i + 2])) { valid = false; break; }
      }
      if (!valid) continue;
      a.fromArray(source.positions, offset); b.fromArray(source.positions, offset + 3); c.fromArray(source.positions, offset + 6);
      point.copy(a).add(b).add(c).multiplyScalar(1 / 3).applyMatrix4(matrix);
      const [x, y, z] = local.project(point), distance = x * x + y * y + (z - 0.55) ** 2;
      if (distance > 9 || z < -0.35 || z > 1.7) continue;
      const area = b.sub(a).cross(c.sub(a)).length() / local.areaScale;
      if (!(area > 0)) continue;
      const color = [0, 1, 2].map(channel => (colors[offset + channel] + colors[offset + 3 + channel] + colors[offset + 6 + channel]) / 3) as Vec3;
      const cell = [x, y, z].map(value => Math.round(value * 32)).join(','), weight = area / (0.5 + distance);
      const existing = cells.get(cell);
      if (existing) {
        for (let channel = 0; channel < 3; channel++) existing.color[channel] = (existing.color[channel] * existing.weight + color[channel] * weight) / (existing.weight + weight);
        existing.weight += weight; existing.distance = Math.min(existing.distance, distance);
      } else cells.set(cell, { color, distance, weight });
    }
  }
  const samples = [...cells.values()].sort((a, b) => a.distance - b.distance);
  const nearby = samples.slice(0, 256);
  if (nearby.length < 12) return null;
  const half = nearby.reduce((sum, sample) => sum + sample.weight, 0) / 2;
  const rgb = [0, 1, 2].map(channel => {
    const sorted = [...nearby].sort((a, b) => a.color[channel] - b.color[channel]);
    let weight = 0;
    for (const sample of sorted) { weight += sample.weight; if (weight >= half) return sample.color[channel]; }
    return sorted[sorted.length - 1].color[channel];
  }) as Vec3;
  const luminance = (color: Vec3) => 0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2];
  const sortedLight = [...nearby].sort((a, b) => luminance(a.color) - luminance(b.color));
  const quantile = (fraction: number) => {
    let weight = 0;
    for (const sample of sortedLight) { weight += sample.weight; if (weight >= half * 2 * fraction) return luminance(sample.color); }
    return luminance(sortedLight[sortedLight.length - 1].color);
  };
  // Robust spread uses only already-accepted enamel-like samples. Baked scan
  // shadows/highlights must not turn into extreme stains on a generated tooth.
  const spread = (quantile(0.9) - quantile(0.1)) / Math.max(0.15, luminance(rgb));
  return { rgb, samples: nearby.length, variation: Math.min(0.095, 0.055 + spread * 0.35) };
}

/**
 * Rebuilt from the saved spec and current local scan evidence when reopening.
 * Extra presentation attributes intentionally stay out of clinical/fit/export
 * geometry and session schemas. Weak caching releases them with the crown.
 */
export function withCrownEnamel(part: ModelPart, spec: RestorationSpec, parts: ModelPart[], labels: Readonly<Record<string, Uint8Array>> = {}): ModelPart {
  if (part.restoration?.component !== 'crown' || part.reference) return part;
  const parent = parts.find(source => source.id === spec.parentPartId);
  const sources = parent ? parts.filter(source => !source.restoration && !source.reference && source.role !== 'bite'
    && (source.id === parent.id || (parent.role === 'upper' || parent.role === 'lower') && source.role === parent.role
      || !!parent.sourceFileId && source.sourceFileId === parent.sourceFileId && source.role !== (parent.role === 'upper' ? 'lower' : 'upper'))) : [];
  const manualColor = spec.appearance?.crown?.color;
  const frameKey = JSON.stringify([spec.frame, spec.parameters.crown.rotation, spec.anatomicalSigns]);
  const key = JSON.stringify([frameKey, manualColor,
    sources.map(source => [source.id, source.pose, source.rotation, source.offset])]);
  const inputs = sources.flatMap(source => [source.positions, source.colors, source.tissueScores, labels[source.id]]);
  const cached = cache.get(part.positions);
  let enamel = cached?.key === key && inputs.length === cached.inputs.length && inputs.every((input, i) => input === cached.inputs[i]) ? cached.enamel : undefined;
  if (!enamel) {
    const local = cached?.frameKey === frameKey ? cached.local : localFrame(part.positions, spec);
    const sampled = manualColor ? null : neighboringColor(sources, parent, local, labels);
    const base = sampled ? new Color().fromArray(sampled.rgb) : new Color(manualColor ?? fallback);
    const colors = new Float32Array(part.positions.length);
    for (let i = 0; i < colors.length; i += 3) {
      const x = local.coordinates[i], y = local.coordinates[i + 1], z = clamp(local.coordinates[i + 2]);
      const cervical = (1 - z) ** 3, incisal = z ** 4;
      // Broad axial colour survives non-shader previews. The stronger mottling
      // is evaluated per fragment so long collar triangles cannot smooth it away.
      const variation = 0.006 * Math.sin(x * 17 + Math.sin(z * 7)) * Math.sin(y * 13 + z * 9);
      colors[i] = clamp(base.r * (1 + variation + cervical * 0.012 + incisal * 0.008));
      colors[i + 1] = clamp(base.g * (1 + variation - cervical * 0.018 + incisal * 0.016));
      colors[i + 2] = clamp(base.b * (1 + variation - cervical * 0.06 + incisal * 0.03));
    }
    enamel = { coordinates: local.coordinates, colors, baseColor: `#${base.getHexString()}`,
      source: manualColor ? 'manual-display-color' : sampled ? 'nearby-scan-colors' : 'illustrative-fallback', samples: sampled?.samples ?? 0,
      variation: sampled?.variation ?? 0.065 };
    cache.set(part.positions, { key, frameKey, local, inputs, enamel });
  }
  return { ...part, presentationColor: enamel.baseColor, colors: enamel.colors, crownEnamel: enamel } as EnamelPart;
}
