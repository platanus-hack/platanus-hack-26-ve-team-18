import type { Vec3 } from './models';
import type { RestorationComponentKind, RestorationMesh, RestorationReferencePlanes, RestorationSpec } from './restoration-types';
import { buildCrownMesh, cloneShape, CROWN_THETA, templateShape, validateCrownShape } from './crown-anatomy.ts';
import { restorationQualityContextSchema } from './restoration-quality-schema.ts';

// Pure planning geometry. No source mesh, physical-unit conversion, fitting,
// manufacturer interface, engineered thread form, screw channel, or surgical inference.
const SEGMENTS = 64;
const TAU = Math.PI * 2;
// Illustrative generic implant proportions relative to the nominal fixture
// radius. The thread is a visual envelope, never a manufacturer's thread form.
const FIXTURE_SEGMENTS = 32, THREAD_RINGS_PER_PITCH = 8, MAX_THREAD_TURNS = 18;
const THREAD_PITCH = 0.42, THREAD_DEPTH = 0.14, APICAL_FLUTES = 3;
const COLLAR_RINGS = 6;
// Visual retention length relative to the existing crown-body height. This
// construction proportion is neither clinical post height nor wall thickness.
const RETENTION_POST_HEIGHT_SHARE = .58;
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const minus = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

function finite(value: number, name: string, min = -Infinity, max = Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be finite in [${min}, ${max}].`);
  }
}

function positive(value: number, name: string) {
  finite(value, name);
  if (!(value > 0)) throw new Error(`${name} must be positive, in file units.`);
}

export function validateRestorationSpec(spec: RestorationSpec) {
  if (!spec || spec.version !== 'implant-assembly/v1') throw new Error('Expected implant-assembly/v1 spec.');
  if (!Number.isInteger(spec.fdi) || !/^[1-4][1-8]$/.test(String(spec.fdi))) throw new Error('FDI must identify a permanent tooth.');
  for (const key of ['parentPartId', 'source'] as const) {
    if (typeof spec[key] !== 'string' || !spec[key].trim() || spec[key].length > (key === 'source' ? 4000 : 200)) throw new Error(`${key} must be a bounded nonempty string.`);
  }
  if (!['hypothesized', 'clinician-entered'].includes(spec.provenance)) throw new Error('Unknown concept provenance.');
  if (spec.units !== 'file units (u)') throw new Error('Dimensions must use file units (u); no physical scale is inferred.');
  if (!['incisor', 'canine', 'premolar', 'molar'].includes(spec.anatomy)) throw new Error('Unknown crown anatomical class.');
  const keys = (value: object, allowed: string[], name: string) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`Unknown or invalid ${name} fields.`);
  };
  keys(spec, ['version', 'fdi', 'parentPartId', 'componentDesign', 'draftIdentity', 'frame', 'parameters', 'anatomy', 'contour', 'appearance', 'editProvenance', 'crownShape', 'qualityContext', 'anatomicalSigns', 'provenance', 'units', 'source', 'siteEvidence'], 'restoration spec');
  if (spec.componentDesign !== undefined && spec.componentDesign !== 'nested-support/v1') throw new Error('Unknown component construction profile.');
  if (spec.contour !== undefined) {
    keys(spec.contour, ['cervicalScale', 'occlusalScale'], 'contour');
    for (const [key, value] of Object.entries(spec.contour)) finite(value, key, 0.5, 1.5);
  }
  if (spec.appearance !== undefined) {
    keys(spec.appearance, ['fixture', 'abutment', 'crown'], 'appearance');
    for (const appearance of Object.values(spec.appearance)) {
      keys(appearance, ['color', 'roughness'], 'component appearance');
      if (appearance.color !== undefined && (typeof appearance.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(appearance.color))) throw new Error('Display color must be a six-digit hex color; it is not a dental shade match.');
      if (appearance.roughness !== undefined) finite(appearance.roughness, 'Display roughness', 0, 1);
    }
  }
  if (spec.editProvenance !== undefined) {
    keys(spec.editProvenance, ['actor', 'reason'], 'edit provenance');
    if (!['manual', 'agent'].includes(spec.editProvenance.actor) || typeof spec.editProvenance.reason !== 'string' || !spec.editProvenance.reason.trim() || spec.editProvenance.reason.length > 500) throw new Error('Edit provenance needs a known actor and a reason of at most 500 characters.');
    if (spec.provenance !== (spec.editProvenance.actor === 'agent' ? 'hypothesized' : 'clinician-entered')) throw new Error('Edit actor and concept provenance must agree.');
  }
  if (spec.qualityContext !== undefined) restorationQualityContextSchema.parse(spec.qualityContext);
  if (spec.draftIdentity !== undefined) {
    const draft = spec.draftIdentity;
    keys(draft, ['siteId', 'templateFdi', 'alternatives', 'basis'], 'draft identity');
    if (typeof draft.siteId !== 'string' || !draft.siteId.trim() || draft.siteId.length > 200 || !/^[1-4][1-8]$/.test(String(draft.templateFdi)) || !Array.isArray(draft.alternatives) || draft.alternatives.length > 32 || draft.alternatives.some(fdi => !Number.isInteger(fdi) || !/^[1-4][1-8]$/.test(String(fdi))) || typeof draft.basis !== 'string' || draft.basis.length > 4000) throw new Error('Invalid draft site identity.');
  }
  if (spec.siteEvidence !== undefined) {
    const evidence = spec.siteEvidence;
    keys(evidence, ['method', 'partIds', 'fdis', 'surface', 'bounds', 'slot'], 'site evidence');
    keys(evidence.surface, ['partId', 'face', 'point'], 'surface anchor');
    if (!['reviewed-surface', 'bounded-gap', 'distal-extension'].includes(evidence.method) || !Array.isArray(evidence.partIds) || !evidence.partIds.length || evidence.partIds.length > 64 || evidence.partIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 200) || !Array.isArray(evidence.fdis) || evidence.fdis.length > 32 || evidence.fdis.some(fdi => !Number.isInteger(fdi) || !/^[1-4][1-8]$/.test(String(fdi)))) throw new Error('Invalid site evidence dependencies.');
    const anchor = evidence.surface;
    if (typeof anchor.partId !== 'string' || !anchor.partId.trim() || anchor.partId.length > 200 || !Number.isSafeInteger(anchor.face) || anchor.face < 0 || !Array.isArray(anchor.point) || anchor.point.length !== 3 || !anchor.point.every(Number.isFinite)) throw new Error('Invalid site evidence surface anchor.');
    if (evidence.bounds && (!Array.isArray(evidence.bounds) || evidence.bounds.length !== 2 || !evidence.bounds.every(Number.isFinite))) throw new Error('Invalid site bounds.');
    if (evidence.slot) {
      keys(evidence.slot, ['index', 'count'], 'site slot');
      if (!Number.isSafeInteger(evidence.slot.index) || !Number.isSafeInteger(evidence.slot.count) || evidence.slot.index < 0 || evidence.slot.count < 1 || evidence.slot.index >= evidence.slot.count) throw new Error('Invalid site slot.');
    }
  }
  if (spec.crownShape) {
    validateCrownShape(spec.crownShape);
    if (spec.crownShape.toothClass !== spec.anatomy) throw new Error('Donor/template tooth class must match the restoration anatomy.');
    if (spec.crownShape.arch !== (spec.fdi < 30 ? 'upper' : 'lower')) throw new Error('Donor/template arch must match the restoration arch.');
  }
  if (spec.anatomicalSigns && (![1, -1].includes(spec.anatomicalSigns.mesial) || ![1, -1].includes(spec.anatomicalSigns.buccal))) throw new Error('Anatomical axis signs must each be +1 or -1.');
  const frame = spec.frame;
  keys(frame, ['origin', 'u', 'v', 'up'], 'frame');
  for (const key of ['origin', 'u', 'v', 'up'] as const) {
    const vector = frame?.[key];
    if (!Array.isArray(vector) || vector.length !== 3 || vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error(`frame.${key} must contain three finite coordinates.`);
    }
  }
  const { u, v, up } = frame;
  const tolerance = 1e-8;
  if ([u, v, up].some(axis => Math.abs(dot(axis, axis) - 1) > tolerance) ||
      [dot(u, v), dot(u, up), dot(v, up)].some(value => Math.abs(value) > tolerance) ||
      Math.abs(dot(cross(u, v), up) - 1) > tolerance) {
    throw new Error('Source frame must be right-handed and orthonormal (u cross v = up); axes are not normalized automatically.');
  }
  const { fixture: f, abutment: a, crown: c } = spec.parameters ?? {};
  if (!f || !a || !c) throw new Error('Fixture, abutment, and crown parameters are required.');
  keys(spec.parameters, ['fixture', 'abutment', 'crown'], 'parameters');
  keys(f, ['radius', 'length', 'depth', 'taper'], 'fixture');
  keys(a, ['radius', 'height', 'emergenceRadius', 'angleX', 'angleY'], 'abutment');
  keys(c, ['width', 'depth', 'height', 'cuspHeight', 'rotation'], 'crown');
  positive(f.radius, 'Fixture radius'); positive(f.length, 'Fixture length');
  finite(f.depth, 'Fixture depth', 0); finite(f.taper, 'Fixture taper', 0, 0.95);
  positive(a.radius, 'Abutment radius'); positive(a.height, 'Abutment height'); positive(a.emergenceRadius, 'Abutment emergence radius');
  // Numerical bounds on the slanted loft, never manufacturer/clinical limits.
  finite(a.angleX, 'Abutment X angle (degrees)', -80, 80);
  finite(a.angleY, 'Abutment Y angle (degrees)', -80, 80);
  positive(c.width, 'Crown width'); positive(c.depth, 'Crown depth'); positive(c.height, 'Crown height');
  finite(c.cuspHeight, 'Crown cusp height', 0); finite(c.rotation, 'Crown rotation (degrees)', -360, 360);
  const dimensions = [f.radius * (1 - f.taper), f.length, a.radius, a.height, a.emergenceRadius, c.width, c.depth, c.height];
  if (Math.max(...dimensions) / Math.min(...dimensions) > 10_000) throw new Error('Component proportions exceed the numerical construction range.');
}

class Surface {
  points: Vec3[] = [];
  faces: number[] = [];

  point(point: Vec3) { this.points.push(point); return this.points.length - 1; }

  ring(point: (angle: number, index: number) => Vec3, segments = SEGMENTS) {
    const start = this.points.length;
    for (let i = 0; i < segments; i++) this.point(point(i * TAU / segments, i));
    return start;
  }

  // Rings run counterclockwise from +up. Bottom -> top, then outer -> inner.
  connect(bottom: number, top: number, segments = SEGMENTS) {
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      this.faces.push(bottom + i, bottom + j, top + i, bottom + j, top + j, top + i);
    }
  }

  cap(ring: number, center: Vec3, top: boolean, segments = SEGMENTS) {
    const vertex = this.point(center);
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments;
      this.faces.push(vertex, ring + (top ? i : j), ring + (top ? j : i));
    }
  }

  mesh(component: RestorationComponentKind, frame: RestorationSpec['frame']): RestorationMesh {
    // Round shared vertices ONCE before expansion. Reject collapsed geometry in
    // the actual Float32 source coordinates instead of silently recentering it.
    let minimumEdge = Infinity;
    for (let i = 0; i < this.faces.length; i += 3) for (let edge = 0; edge < 3; edge++) {
      const a = this.points[this.faces[i + edge]], b = this.points[this.faces[i + (edge + 1) % 3]];
      minimumEdge = Math.min(minimumEdge, Math.hypot(...minus(a, b)));
    }
    const points: Vec3[] = this.points.map(point => {
      const transform = (axis: number) => {
        const exact = frame.origin[axis] + frame.u[axis] * point[0] + frame.v[axis] * point[1] + frame.up[axis] * point[2];
        const rounded = Math.fround(exact);
        // Edge/winding checks alone cannot detect folded surfaces after partial
        // precision loss. Bound rounding before emitting any source coordinates.
        if (!Number.isFinite(exact) || Math.abs(rounded - exact) > minimumEdge * 0.02) throw new Error(`${component}: Float32 precision is insufficient for the local geometric features at this source origin.`);
        return rounded;
      };
      return [transform(0), transform(1), transform(2)];
    });
    const positions = new Float32Array(this.faces.length * 3), normals = new Float32Array(positions.length);
    const low: Vec3 = [Infinity, Infinity, Infinity], high: Vec3 = [-Infinity, -Infinity, -Infinity];
    const keys = new Set<string>();
    for (const point of points) {
      if (!point.every(Number.isFinite)) throw new Error(`${component}: coordinates exceed Float32 range.`);
      const key = point.join(',');
      if (keys.has(key)) throw new Error(`${component}: dimensions lose precision at this source origin; no recentering was applied.`);
      keys.add(key);
      for (let axis = 0; axis < 3; axis++) { low[axis] = Math.min(low[axis], point[axis]); high[axis] = Math.max(high[axis], point[axis]); }
    }
    const edges = new Map<string, { count: number; balance: number }>();
    const reference = points[0];
    let signedVolume = 0;
    for (let i = 0; i < this.faces.length; i += 3) {
      const ids = this.faces.slice(i, i + 3), [a, b, c] = ids.map(id => points[id]);
      const normal = cross(minus(b, a), minus(c, a)), area = Math.hypot(...normal);
      if (!(area > 0) || !Number.isFinite(area)) throw new Error(`${component}: degenerate triangle at the requested dimensions/source coordinates.`);
      signedVolume += dot(minus(a, reference), cross(minus(b, reference), minus(c, reference))) / 6;
      for (let corner = 0; corner < 3; corner++) {
        positions.set(points[ids[corner]], (i + corner) * 3);
        normals.set(normal.map(value => value / area), (i + corner) * 3);
        const from = ids[corner], to = ids[(corner + 1) % 3], key = `${Math.min(from, to)},${Math.max(from, to)}`;
        const edge = edges.get(key) ?? { count: 0, balance: 0 };
        edge.count++; edge.balance += from < to ? 1 : -1; edges.set(key, edge);
      }
    }
    if (!(signedVolume > 0) || !Number.isFinite(signedVolume) || [...edges.values()].some(edge => edge.count !== 2 || edge.balance !== 0)) {
      throw new Error(`${component}: failed closed-surface winding check.`);
    }
    return { component, positions, normals, triangles: this.faces.length / 3, vertices: points.length,
      closed: true, dimensions: [high[0] - low[0], high[1] - low[1], high[2] - low[2]] };
  }
}

/**
 * A shallow crown skirt covers the transmucosal collar below the site datum.
 * This radius-relative visual proportion is not a measured gingival margin or
 * sulcus depth. It stays independent of fixture depth so burying the fixture
 * cannot lift the crown or change its contacts.
 */
export function restorationMarginDepth(spec: Pick<RestorationSpec, 'parameters'>) {
  return spec.parameters.abutment.emergenceRadius * .5;
}

/** V-thread radial profile over one pitch: 1 at the crest, 0 at the root. */
function threadProfile(phase: number) {
  if (phase < .09 || phase >= .91) return 1;
  if (phase < .44) return 1 - (phase - .09) / .35;
  if (phase < .56) return 0;
  return (phase - .56) / .35;
}

/**
 * Generic tapered, bone-level screw envelope: machined collar, helical V-thread
 * with apical flutes and a rounded apex. `radius` is the nominal (major) radius
 * at the platform; `taper` narrows the major envelope linearly to the apex.
 */
function fixture(spec: RestorationSpec) {
  const { radius, length, depth, taper } = spec.parameters.fixture;
  const mesh = new Surface(), top = -depth, apex = -depth - length;
  const major = (z: number) => radius * (1 - taper * (top - z) / length);
  const collar = Math.min(length * .08, radius * .45), dome = Math.min(length * .12, major(apex) * .9);
  const threadTop = top - collar, threadBottom = apex + dome, threaded = threadTop - threadBottom;
  // Coarsen the pitch for extreme proportions so the ring count stays bounded.
  const pitch = Math.max(radius * THREAD_PITCH, threaded / MAX_THREAD_TURNS);
  const steps = Math.max(2, Math.ceil(threaded / pitch * THREAD_RINGS_PER_PITCH));
  const threadDepth = (z: number) => Math.min(radius * THREAD_DEPTH, major(z) * .3);
  const radiusAt = (z: number, angle: number) => {
    const t = (z - threadBottom) / threaded, d = threadDepth(z);
    // Threads run out toward the apex; three flutes cut the apical third.
    const runout = .45 + .55 * Math.min(1, t / .2) ** 2 * (3 - 2 * Math.min(1, t / .2));
    let flute = 0;
    if (t < .35) for (let k = 0; k < APICAL_FLUTES; k++) {
      const offset = angle - k * TAU / APICAL_FLUTES - .4;
      flute = Math.max(flute, Math.exp(-((Math.atan2(Math.sin(offset), Math.cos(offset)) / .3) ** 2)) * (1 - t / .35));
    }
    const phase = (((threadTop - z) / pitch + angle / TAU) % 1 + 1) % 1;
    return major(z) - d * (1 + .5 * flute) + d * runout * (1 - .85 * flute) * threadProfile(phase);
  };
  let last = -1;
  const add = (z: number, r: (angle: number) => number) => {
    const ring = mesh.ring(angle => { const value = r(angle); return [value * Math.cos(angle), value * Math.sin(angle), z]; }, FIXTURE_SEGMENTS);
    if (last < 0) mesh.cap(ring, [0, 0, apex], false, FIXTURE_SEGMENTS); else mesh.connect(last, ring, FIXTURE_SEGMENTS);
    last = ring;
  };
  const tip = major(threadBottom) - threadDepth(threadBottom) * .75;
  for (let k = 1; k < 6; k++) {
    const angle = k / 6 * Math.PI / 2;
    add(apex + dome * (1 - Math.cos(angle)), () => tip * Math.sin(angle));
  }
  for (let j = 0; j <= steps; j++) {
    const z = threadBottom + threaded * j / steps;
    add(z, angle => radiusAt(z, angle));
  }
  const neck = threadTop + collar * .2;
  add(neck, () => major(neck));
  add(top, () => radius);
  mesh.cap(last, [0, 0, top], true, FIXTURE_SEGMENTS);
  return mesh.mesh('fixture', spec.frame);
}

/**
 * Generic pilar envelope: a transmucosal collar flaring from the platform to
 * the emergence radius at the crown margin, a narrow shoulder, then a tapered
 * core that the crown encloses. Without platform depth it starts at the site
 * plane. Matching radii is visual continuity, never a precision platform,
 * internal connection, seating tolerance, or compatible hardware.
 */
function abutment(spec: RestorationSpec) {
  const { radius, height, emergenceRadius, angleX, angleY } = spec.parameters.abutment;
  const { depth, radius: platformRadius } = spec.parameters.fixture;
  const mesh = new Surface();
  const dx = Math.tan(angleY * Math.PI / 180) * height;
  const dy = -Math.tan(angleX * Math.PI / 180) * height;
  const margin = 0;
  // Above the site plane, angles describe centerline slopes, not a rigid tilt.
  const ringAt = (z: number, r: number) => {
    const shift = Math.max(0, z) / height;
    return mesh.ring(angle => [dx * shift + r * Math.cos(angle), dy * shift + r * Math.sin(angle), z]);
  };
  let last = -1, coreBase = emergenceRadius;
  if (depth > 0) {
    for (let i = 0; i <= 4; i++) {
      const t = i / 4, ring = ringAt(-depth + (depth - margin) * t, platformRadius + (emergenceRadius - platformRadius) * t * t);
      if (last < 0) mesh.cap(ring, [0, 0, -depth], false); else mesh.connect(last, ring);
      last = ring;
    }
    coreBase = Math.min(emergenceRadius, Math.max(radius, emergenceRadius * .8));
    if (coreBase < emergenceRadius) { const shoulder = ringAt(-margin, coreBase); mesh.connect(last, shoulder); last = shoulder; }
  }
  const levels = [...new Set([...Array.from({ length: 6 }, (_, i) => -margin + (height + margin) * (i + 1) / 6), ...(margin > 0 ? [0] : [])])].sort((a, b) => a - b);
  if (last < 0) { last = ringAt(0, emergenceRadius); mesh.cap(last, [0, 0, 0], false); }
  for (const z of levels) {
    const ring = ringAt(z, coreBase + (radius - coreBase) * (z + margin) / (height + margin));
    mesh.connect(last, ring); last = ring;
  }
  if (spec.componentDesign === 'nested-support/v1') {
    // Keep every neck/emergence control exact, including impossible designs.
    // The post starts at the existing crown seating centre and follows up;
    // continuing the angled neck slope here would move it out of the crown.
    const postHeight = retentionPostHeight(spec);
    const addPostRing = (t: number, ratio: number) => {
      const ring = mesh.ring(angle => [dx + radius * ratio * Math.cos(angle), dy + radius * ratio * Math.sin(angle), height + postHeight * t]);
      mesh.connect(last, ring); last = ring;
    };
    for (let i = 1; i <= 6; i++) {
      const t = i / 8;
      addPostRing(t, 1 - .2 * t);
    }
    // Quarter-ellipse rounding meets a finite flat top, avoiding a pointed
    // retention tip. No connection, intaglio or manufacturing seat is implied.
    for (let i = 1; i <= 5; i++) {
      const angle = i / 5 * Math.PI / 2;
      addPostRing(.75 + .25 * Math.sin(angle), .85 - .22 * (1 - Math.cos(angle)));
    }
    mesh.cap(last, [dx, dy, height + postHeight], true);
  } else mesh.cap(last, [dx, dy, height], true);
  // Crown seating is independent of the emitted post tip.
  const top: Vec3 = [dx, dy, height];
  return { mesh: mesh.mesh('abutment', spec.frame), top };
}

function retentionPostHeight(spec: RestorationSpec) {
  return spec.componentDesign === 'nested-support/v1' ? spec.parameters.crown.height * RETENTION_POST_HEIGHT_SHARE : 0;
}

/** Crown-body seating plane in ORIGINAL SOURCE coordinates, not the pilar tip. */
export function restorationSupportDatum(spec: RestorationSpec) {
  const { frame, parameters: { abutment: { height, angleX, angleY } } } = spec;
  const x = height * Math.tan(angleY * Math.PI / 180), y = -height * Math.tan(angleX * Math.PI / 180);
  return {
    origin: frame.origin.map((value, axis) => value + frame.u[axis] * x + frame.v[axis] * y + frame.up[axis] * height) as Vec3,
    normal: [...frame.up] as Vec3, postHeight: retentionPostHeight(spec),
  };
}

/** Distinct actual source-frame vertices above the unchanged crown-body datum.
 * No surface points are invented. Neck/base vertices are excluded; absence of
 * a post in legacy construction yields an empty region, never inferred support.
 * Scalar datums are projections from frame.origin along frame.up, in file units.
 */
export function crownSupportRegion(spec: RestorationSpec, pilar: Pick<RestorationMesh, 'positions'>) {
  const { frame, parameters: { abutment: { height, radius, emergenceRadius, angleX, angleY } } } = spec;
  let rounding = 0;
  for (let axis = 0; axis < 3; axis++) {
    let magnitude = Math.abs(frame.origin[axis]);
    for (let i = axis; i < pilar.positions.length; i += 3) magnitude = Math.max(magnitude, Math.abs(pilar.positions[i]));
    // Conservative source-coordinate Float32 half-ULP plus projection arithmetic.
    rounding += magnitude * Math.abs(frame.up[axis]) * 2 ** -23;
  }
  // Validation permits a small frame error; at extreme radius/height ratios
  // that error must not turn seating-ring vertices into retention-post samples.
  const radial = Math.max(radius, emergenceRadius, spec.parameters.fixture.radius);
  const frameError = Math.abs(dot(frame.u, frame.up)) * (radial + Math.abs(height * Math.tan(angleY * Math.PI / 180)))
    + Math.abs(dot(frame.v, frame.up)) * (radial + Math.abs(height * Math.tan(angleX * Math.PI / 180)))
    + Math.abs(dot(frame.up, frame.up) - 1) * Math.max(spec.parameters.fixture.depth, height + retentionPostHeight(spec));
  const numericTolerance = Math.max(rounding + frameError, Math.max(height, retentionPostHeight(spec)) * 1e-6);
  const selected: number[] = [], seen = new Set<string>();
  let supportTop = -Infinity;
  for (let i = 0; i < pilar.positions.length; i += 3) {
    const x = pilar.positions[i], y = pilar.positions[i + 1], z = pilar.positions[i + 2];
    const axial = (x - frame.origin[0]) * frame.up[0] + (y - frame.origin[1]) * frame.up[1] + (z - frame.origin[2]) * frame.up[2];
    supportTop = Math.max(supportTop, axial);
    if (spec.componentDesign !== 'nested-support/v1' || axial <= height + numericTolerance) continue;
    const key = `${x},${y},${z}`;
    if (!seen.has(key)) { seen.add(key); selected.push(x, y, z); }
  }
  return { positions: Float32Array.from(selected), seatingDatum: height, supportTop, numericTolerance };
}

/** Resolve the unmodified anatomy so a fitted/saved spec can retain it across
 * future template revisions. Returned arrays are independent of the input. */
export function restorationCrownShape(spec: RestorationSpec) {
  const arch = spec.fdi < 30 ? 'upper' : 'lower';
  // Keep callers that explicitly compare alternative anatomy classes useful:
  // the class is authoritative, while the FDI digit refines a matching class.
  const digits = { incisor: 1, canine: 3, premolar: 4, molar: 6 };
  const digit = spec.fdi % 10;
  const inferredClass = digit <= 2 ? 'incisor' : digit === 3 ? 'canine' : digit <= 5 ? 'premolar' : 'molar';
  return spec.crownShape ? cloneShape(spec.crownShape) : templateShape(arch, inferredClass === spec.anatomy ? digit : digits[spec.anatomy]);
}

function crown(spec: RestorationSpec, base: Vec3) {
  const { width, depth, height, cuspHeight, rotation } = spec.parameters.crown;
  const shape = restorationCrownShape(spec);
  // Deform a fresh copy only. The fitter pins the unmodified base shape and
  // repeated edit/save/rebuild operations must never compound these scales.
  const cervicalScale = spec.contour?.cervicalScale ?? 1, occlusalScale = spec.contour?.occlusalScale ?? 1;
  if (cervicalScale !== 1) {
    const levels = shape.wall.length / shape.rim.length;
    for (let level = 0; level < levels; level++) {
      const factor = 1 + (cervicalScale - 1) * (1 - level / (levels - 1)) ** 2;
      for (let angle = 0; angle < shape.rim.length; angle++) shape.wall[level * shape.rim.length + angle] *= factor;
    }
  }
  // Body height scales the anatomy. New templates record one common relief
  // plane, preserving table continuity; legacy shapes retain their datums.
  const rim = Array.from(shape.rimZ);
  for (let a = 0; a < rim.length; a++) for (let r = 0; r < shape.occlusal.length / rim.length; r++) {
    const index = r * rim.length + a, value = shape.occlusal[index], datum = shape.reliefDatum ?? rim[a];
    shape.occlusal[index] = value + cuspHeight / height * Math.max(0, (value - datum) / Math.max(0.05, 1 - datum));
    // Scale positive relief above each rim, preserving positive fossae and
    // measured wall datums. Existing cuspHeight behavior is identical at 1.
    if (occlusalScale !== 1 && shape.occlusal[index] > datum) shape.occlusal[index] = datum + (shape.occlusal[index] - datum) * occlusalScale;
  }
  const centreRim = shape.reliefDatum ?? rim.reduce((sum, value) => sum + value, 0) / rim.length;
  shape.apex += cuspHeight / height * Math.max(0, (shape.apex - centreRim) / Math.max(0.05, 1 - centreRim));
  if (occlusalScale !== 1 && shape.apex > centreRim) shape.apex = centreRim + (shape.apex - centreRim) * occlusalScale;
  const anatomy = buildCrownMesh(shape, [width, depth, height]);
  const mesh = new Surface(), angle = rotation * Math.PI / 180;
  // Retain the anatomical surface ordering for adaptation, but replace its
  // artificial basal cap with an emergence skirt below the site datum.
  const basalVertex = anatomy.vertexCount - 1;
  for (let i = 0; i < anatomy.vertices.length - 3; i += 3) {
    const x = anatomy.vertices[i] * (spec.anatomicalSigns?.mesial ?? 1), y = anatomy.vertices[i + 1] * (spec.anatomicalSigns?.buccal ?? 1), z = anatomy.vertices[i + 2];
    mesh.point([base[0] + x * Math.cos(angle) - y * Math.sin(angle), base[1] + x * Math.sin(angle) + y * Math.cos(angle), base[2] + z]);
  }
  for (let i = 0; i < anatomy.indices.length; i += 3) {
    const face = Array.from(anatomy.indices.subarray(i, i + 3));
    if (!face.includes(basalVertex)) mesh.faces.push(...face);
  }
  const margin = -restorationMarginDepth(spec), emergence = spec.parameters.abutment.emergenceRadius;
  const sm = spec.anatomicalSigns?.mesial ?? 1, sb = spec.anatomicalSigns?.buccal ?? 1;
  let last = 0;
  for (let level = 1; level <= COLLAR_RINGS; level++) {
    const t = 1 - level / COLLAR_RINGS;
    // Smooth radial transition, with the crown centre following the pilar
    // slope. This is a solid visual envelope, not an intaglio or wall thickness.
    const blend = t * (2 - t);
    const ring = mesh.ring((theta, index) => {
      const radialX = emergence * Math.cos(theta) * sm, radialY = emergence * Math.sin(theta) * sb;
      const bottomX = radialX * Math.cos(angle) - radialY * Math.sin(angle);
      const bottomY = radialX * Math.sin(angle) + radialY * Math.cos(angle);
      const top = mesh.points[index];
      return [base[0] * t + bottomX + (top[0] - base[0] - bottomX) * blend,
        base[1] * t + bottomY + (top[1] - base[1] - bottomY) * blend, margin + (base[2] - margin) * t];
    }, CROWN_THETA);
    mesh.connect(ring, last, CROWN_THETA); last = ring;
  }
  mesh.cap(last, [0, 0, margin], false, CROWN_THETA);
  if ((spec.anatomicalSigns?.mesial ?? 1) * (spec.anatomicalSigns?.buccal ?? 1) < 0) {
    for (let i = 0; i < mesh.faces.length; i += 3) [mesh.faces[i + 1], mesh.faces[i + 2]] = [mesh.faces[i + 2], mesh.faces[i + 1]];
  }
  return { ...mesh.mesh('crown', spec.frame), crownBodyTriangles: anatomy.indices.length / 3 - CROWN_THETA };
}

/** Explicit planes in the parent's source coordinates; no bone datum is inferred. */
export function restorationReferencePlanes(spec: RestorationSpec): RestorationReferencePlanes {
  validateRestorationSpec(spec);
  const { frame, parameters: { fixture: f } } = spec;
  const plane = (x: number, y: number, z: number) => ({
    origin: [frame.origin[0] + x * frame.u[0] + y * frame.v[0] + z * frame.up[0],
      frame.origin[1] + x * frame.u[1] + y * frame.v[1] + z * frame.up[1],
      frame.origin[2] + x * frame.u[2] + y * frame.v[2] + z * frame.up[2]] satisfies Vec3,
    normal: [...frame.up] satisfies Vec3,
  });
  return { site: plane(0, 0, 0), fixturePlatform: plane(0, 0, -f.depth), fixtureApex: plane(0, 0, -f.depth - f.length),
    crownBase: plane(0, 0, -restorationMarginDepth(spec)),
    interpretation: 'generic-contiguous-envelopes; no compatible implant connection' };
}

/**
 * Three independent, closed triangle soups in the ORIGINAL SOURCE frame.
 * Fixture coronal face is origin - depth*up, apex extends a further length.
 * Abutment bridges the platform to the site plane, then rises inside the crown.
 * Overlapping solid envelopes do not encode an implant connection or seating.
 * Crown anatomy is a donor/template hypothesis; basal caps are artificial.
 */
export function generateRestoration(spec: RestorationSpec): RestorationMesh[] {
  validateRestorationSpec(spec);
  const pillar = abutment(spec);
  return [fixture(spec), pillar.mesh, crown(spec, pillar.top)];
}

/** Split only the known constructed collar from crown-body triangles. Kept in
 * source coordinates; all triangles remain available for collision display. */
export function crownTissueRegions(_spec: RestorationSpec, crown: RestorationMesh) {
  // Region identity comes from construction, never a plane cut through rounded
  // source coordinates. Unknown/imported topology retains the entire audit.
  const count = crown.crownBodyTriangles;
  const cut = Number.isSafeInteger(count) && count! > 0 && count! * 9 <= crown.positions.length
    ? count! * 9 : crown.positions.length;
  return { body: crown.positions.slice(0, cut), emergence: crown.positions.slice(cut) };
}
