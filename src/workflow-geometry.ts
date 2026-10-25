import { Box3, Matrix4, Vector3 } from 'three';
import type { ModelPart, Vec3 } from './models';
import type { SiteHypothesis } from './missing-sites';
import type { PreparedCaseSource } from './case-preparation-types';
import type { RestorationSpec, RestorationFitSurface } from './restoration-types';
import type { ToothCase } from './tooth-types';
import { toothClassOf, donorShape, templateShape, type CrownShape } from './crown-anatomy.ts';
import { partMatrix } from './pose.ts';
import { RIGHT_TO_LEFT } from './tooth-numbering.ts';
import { isFdiTooth, toothArch } from './teeth.ts';
import { qualityContextFromSite, qualityNeighborFromSegment } from './restoration-quality.ts';
import { conceptKey } from './planning-automation.ts';
import { generatedCrownTargetId, type GeneratedCrownPart } from './restoration-fit-targets.ts';
import { restorationGenerationDesignSchema, type RestorationGenerationDesign } from './restoration-generation.ts';
import { restorationCrownShape, validateRestorationSpec } from './restoration-geometry.ts';

/** The segmentation and dimensional measurements remain hypotheses about
 * anatomy. A named neighboring surface is not a reviewed tooth identity. */
export function withQualityContext(spec: RestorationSpec, site: SiteHypothesis | undefined, scans: PreparedCaseSource[]): RestorationSpec {
  if (!site) return spec;
  const neighbors = (['mesial', 'distal'] as const).flatMap(side => {
    const reference = site.adjacent[side];
    const segment = reference && scans.find(scan => scan.partId === reference.partId)?.analysis?.teeth.find(tooth => tooth.id === reference.toothId);
    return segment ? [qualityNeighborFromSegment(segment, side, reference!.partId)] : [];
  });
  return { ...spec, qualityContext: { ...qualityContextFromSite(site, neighbors),
    ...(spec.qualityContext?.placementFeedback ? { placementFeedback: spec.qualityContext.placementFeedback } : {}) } };
}

/** Same rim-relative relief and Float32 local coordinates as the generator.
 * A crown height parameter alone is not the crown's emitted peak. */
function crownPeak(shape: CrownShape, height: number, cuspHeight: number): number {
  let peak = 0, meanRim = 0;
  for (const rim of shape.rimZ) { peak = Math.max(peak, Math.fround(height * rim)); meanRim += rim / shape.rimZ.length; }
  const relief = (value: number, rim: number) => value + cuspHeight / height * Math.max(0, (value - rim) / Math.max(.05, 1 - rim));
  for (let i = 0; i < shape.occlusal.length; i++) peak = Math.max(peak, Math.fround(height * Math.fround(relief(shape.occlusal[i], shape.reliefDatum ?? shape.rimZ[i % shape.rimZ.length]))));
  return Math.max(peak, Math.fround(height * relief(shape.apex, shape.reliefDatum ?? meanRim)));
}

/** Width is a scale parameter. Fit both signed extrema, including asymmetric
 * templates, inside the symmetric site envelope without shifting its origin. */
function crownHalfWidth(shape: CrownShape): number {
  let half = 0;
  for (let i = 0; i < shape.wall.length; i++) half = Math.max(half, Math.abs(shape.wall[i] * Math.cos(i % shape.rim.length / shape.rim.length * Math.PI * 2) / 2));
  for (let i = 0; i < shape.rim.length; i++) half = Math.max(half, Math.abs(shape.rim[i] * Math.cos(i / shape.rim.length * Math.PI * 2) / 2));
  return half;
}

/** Full signed span of the normalized outline along one local axis. BL is not
 * bound to a symmetric envelope, so lingually tapered templates use their span. */
function crownSpan(shape: CrownShape, axis: (angle: number) => number): number {
  let low = 0, high = 0;
  const visit = (radius: number, i: number) => { const value = radius * axis(i / shape.rim.length * Math.PI * 2) / 2; low = Math.min(low, value); high = Math.max(high, value); };
  for (let i = 0; i < shape.wall.length; i++) visit(shape.wall[i], i % shape.rim.length);
  for (let i = 0; i < shape.rim.length; i++) visit(shape.rim[i], i);
  return high - low;
}

/** Dimensionless upper bound on emitted body BL/MD for the selected template.
 * A prototype footprint prior that stops a short gap plus a broad neighbour
 * cross-section from producing a lozenge; not a tooth-size norm or clinical target. */
const MAX_BODY_ASPECT = { incisor: 1.2, canine: 1.25, premolar: 1.5, molar: 1.5 } as const;
/** Geometric share of the total top below the crown-body seating datum; the
 * body takes the remainder. The retention post does not raise this datum.
 * An illustrative ratio, not a gingival height. */
const ABUTMENT_SHARE = .1;

function surfaceWidth(site: SiteHypothesis): number | null {
  // Previously saved sites may contain centroid distances, which cannot bound
  // an available envelope. Keep those as evidence, never as contact width.
  const gap = site.space?.proximalGap;
  return !gap || /centroid/i.test(gap.method) ? null : gap.value;
}

/** Dimensions are editable surface-derived hypotheses, not implant or material prescriptions. */
export function specForHypothesis(site: SiteHypothesis, scans: PreparedCaseSource[]): RestorationSpec | null {
  if (site.fdi === null || !site.anchor || !site.frame || !['proposed-missing', 'dentist-confirmed-missing'].includes(site.status)) return null;
  const measuredWidth = surfaceWidth(site), width = measuredWidth ?? site.space.mesiodistal.value;
  const depth = site.space.buccolingual.value, height = site.space.crownHeight.value, vertical = site.space.vertical?.value ?? null;
  if (width === null || depth === null || height === null || ![width, depth, height].every(value => Number.isFinite(value) && value > 0)) return null;
  if (vertical !== null && (!Number.isFinite(vertical) || vertical <= 0)) return null;
  const shape = templateShape(site.arch, site.fdi % 10);
  // Normalize the TOTAL top, not just the crown body. A one-part-per-million
  // numerical reserve absorbs local Float32 rounding; it is not bite clearance.
  const available = Math.min(height, vertical ?? height);
  const size = available * (1 - 1e-6) / (ABUTMENT_SHARE + crownPeak(shape, 1 - ABUTMENT_SHARE, 0));
  const abutmentHeight = size * ABUTMENT_SHARE;
  const bodyWidth = width * (measuredWidth === null ? .92 : .98), crownWidth = bodyWidth / (2 * crownHalfWidth(shape));
  // Emitted BL follows the neighbouring cross-section hypothesis, capped by the
  // template aspect prior relative to the emitted MD body. Both are normalized
  // by the template's actual extrema, so the parameter is not expanded again.
  const anatomy = toothClassOf(site.fdi), emittedWidth = crownWidth * crownSpan(shape, Math.cos);
  const bodyDepth = Math.min(depth * .94, emittedWidth * MAX_BODY_ASPECT[anatomy]), crownDepth = bodyDepth / crownSpan(shape, Math.sin);
  const depthBasis = bodyDepth < depth * .94 ? ` Body BL is capped at ${MAX_BODY_ASPECT[anatomy]}x the emitted MD body (${anatomy} template footprint prior, a prototype hypothesis) instead of 94% of the neighbouring cross-section hypothesis (${depth.toPrecision(5)} u).` : ' Body BL is 94% of the neighbouring cross-section hypothesis.';
  const widthBasis = measuredWidth === null ? `Arc-span fallback (surface width unavailable): ${site.space.mesiodistal.method}` : `Surface envelope: ${site.space.proximalGap.method} Initial envelope occupancy is 98%, an editable geometric starting value, not a clinical contact target.`;
  const heightBasis = vertical === null ? 'No measured antagonist headroom; total top follows the neighbouring-height hypothesis.' : `Total top is capped by sampled local antagonist headroom${site.opposing?.poseVerified ? ' in the reviewed static pose' : ' provisionally; bite pose is unverified'}. ${site.space.vertical.method}`;
  return {
    version: 'implant-assembly/v1', componentDesign: 'nested-support/v1', fdi: site.fdi, parentPartId: site.partId, frame: site.frame, anatomicalSigns: { mesial: site.mesialSign, buccal: site.buccalSign },
    ...(site.draftIdentity ? { draftIdentity: { ...site.draftIdentity, siteId: site.id } } : {}),
    anatomy, provenance: 'hypothesized', units: 'file units (u)',
    source: `Scanned-space hypothesis. ${site.draftIdentity ? `${site.draftIdentity.basis} ` : ''}${site.frameBasis} Width: ${widthBasis}${depthBasis} Height: ${site.space.crownHeight.method} ${heightBasis} Actual template cusp anatomy is included; the crown-body seating datum takes ${ABUTMENT_SHARE * 100}% of the total top and the body takes the remainder. A derived rounded pilar retention post extends above that datum without raising the crown; its enclosure requires measurement. The emergence skirt covers the pilar to half an emergence radius below the ridge datum (a visual proportion, not measured sulcus depth); additional cusp relief starts at zero. Generic component dimensions are illustrative ratios; fixture platform starts half a fixture radius below the ridge datum as an editable visual proportion, with bone-safe depth unknown; clinical fit unvalidated.`,
    parameters: { fixture: { radius: Math.min(width, depth) * .2, length: height, depth: Math.min(width, depth) * .1, taper: .25 }, abutment: { radius: Math.min(width, depth) * .17, height: abutmentHeight, emergenceRadius: Math.min(width, depth) * .25, angleX: 0, angleY: 0 }, crown: { width: crownWidth, depth: crownDepth, height: size * (1 - ABUTMENT_SHARE), cuspHeight: 0, rotation: 0 } },
    siteEvidence: { method: site.kind === 'distal-extension' ? 'distal-extension' : 'bounded-gap', partIds: [...new Set([site.partId, ...scans.map(scan => scan.partId)])], fdis: site.draftIdentity ? [] : [site.fdi], surface: site.anchor, slot: { index: site.slot.index, count: site.slot.count }, bounds: site.slot.s },
  };
}

/** Local evidence supplies identity and placement; every construction value is
 * explicitly supplied by the AI design. Missing measurements never select a
 * geometric default or a different anatomy hypothesis on this path. */
export function specForAIGeneration(site: SiteHypothesis, scans: PreparedCaseSource[], value: RestorationGenerationDesign, rationale: string): RestorationSpec {
  const design = restorationGenerationDesignSchema.parse(value);
  if (site.fdi === null || !isFdiTooth(site.fdi) || toothArch(site.fdi) !== site.arch
    || !site.anchor || site.anchor.partId !== site.partId || !site.frame
    || !['proposed-missing', 'dentist-confirmed-missing'].includes(site.status)) throw new Error('AI generation requires a current, localized missing-site hypothesis.');
  if (!site.draftIdentity && toothClassOf(site.fdi) !== design.anatomy) throw new Error('AI anatomy must match the named FDI tooth class.');
  if (typeof rationale !== 'string' || !rationale.trim() || rationale.length > 600) throw new Error('AI generation requires a bounded design rationale.');
  const spec: RestorationSpec = {
    version: 'implant-assembly/v1', componentDesign: 'nested-support/v1', fdi: site.fdi, parentPartId: site.partId, frame: structuredClone(site.frame),
    anatomicalSigns: { mesial: site.mesialSign, buccal: site.buccalSign },
    ...(site.draftIdentity ? { draftIdentity: { ...structuredClone(site.draftIdentity), siteId: site.id, templateFdi: site.fdi } } : {}),
    anatomy: design.anatomy, parameters: design.parameters, contour: design.contour,
    provenance: 'hypothesized', units: 'file units (u)',
    source: `AI-directed design. Skill: skills/dental-restoration-design/SKILL.md. Anatomy source: ${design.anatomySource}. Rationale: ${rationale.trim()} ${site.draftIdentity ? `${site.draftIdentity.basis} ` : ''}${site.frameBasis} Exact requested parameters and contour; measurement only. Planning concept; clinical fit unvalidated.`,
    siteEvidence: { method: site.kind === 'distal-extension' ? 'distal-extension' : 'bounded-gap', partIds: [...new Set([site.partId, ...scans.map(scan => scan.partId)])], fdis: site.draftIdentity ? [] : [site.fdi], surface: structuredClone(site.anchor), slot: { index: site.slot.index, count: site.slot.count }, bounds: [...site.slot.s] },
  };
  if (design.anatomySource === 'procedural-template') spec.crownShape = restorationCrownShape(spec);
  validateRestorationSpec(spec);
  return spec;
}

/** Worker-side anatomy resolution for an exact design. A requested donor must
 * resolve from eligible local evidence; automatic donor sizing is discarded. */
export function withAIGenerationDesign(spec: RestorationSpec, site: SiteHypothesis | undefined, scans: PreparedCaseSource[], parts: ModelPart[], value: RestorationGenerationDesign): RestorationSpec {
  const design = restorationGenerationDesignSchema.parse(value);
  validateRestorationSpec(spec);
  if (!spec.draftIdentity && toothClassOf(spec.fdi) !== design.anatomy) throw new Error('AI anatomy must match the named FDI tooth class.');
  if (spec.anatomy !== design.anatomy || JSON.stringify(spec.parameters) !== JSON.stringify(design.parameters)
    || JSON.stringify(spec.contour) !== JSON.stringify(design.contour)) throw new Error('AI generation specification differs from the authorized design.');
  const unresolved = { ...spec };
  delete unresolved.crownShape;
  if (design.anatomySource === 'procedural-template') return { ...spec, crownShape: restorationCrownShape(unresolved) };
  const donor = withPatientDonor(unresolved, site, scans, parts);
  if (donor.crownShape?.source.kind !== 'patient-donor') throw new Error('The AI-requested patient donor is unavailable or ineligible; no procedural fallback was generated.');
  const crownShape = donor.crownShape;
  // withPatientDonor documents its automatic initialization. Those numerical
  // changes are intentionally not used for an exact AI construction.
  crownShape.source.provenance = crownShape.source.provenance.split(' Initial MD/BL/height scales:')[0]
    + ' AI-requested parameters, additional cusp relief and contour are preserved; automatic donor sizing was not applied.';
  return { ...spec, crownShape, anatomicalSigns: donor.anatomicalSigns };
}

/**
 * Optional patient donor hypothesis. Only an unflagged, well-supported exact
 * contralateral crown is used. Its local axes come from the tooth/arch evidence,
 * never the whole scan's display axes. Source poses remain separate and rigid.
 */
export function withPatientDonor(spec: RestorationSpec, site: SiteHypothesis | undefined, scans: PreparedCaseSource[], parts: ModelPart[]): RestorationSpec {
  if (spec.draftIdentity) return spec;
  const donor = site?.contralateral;
  const quadrant = Math.floor(spec.fdi / 10);
  const counterpart = (quadrant === 1 ? 2 : quadrant === 2 ? 1 : quadrant === 3 ? 4 : 3) * 10 + spec.fdi % 10;
  if (!site || !donor || donor.fdi !== counterpart || donor.confidence < .8 || toothClassOf(donor.fdi) !== spec.anatomy) return spec;
  const source = scans.find(source => source.partId === donor.partId);
  const part = parts.find(part => part.id === donor.partId);
  const analysis = source?.analysis;
  const tooth = analysis?.teeth.find(tooth => tooth.id === donor.toothId && tooth.fdi === donor.fdi);
  if (!part || part.role !== site.arch || !analysis || !tooth || tooth.kind !== 'crown' || tooth.flags.length || tooth.crownScore < .8 || analysis.lingualConfidence < .8) return spec;
  if (tooth.faces.length < 60 || !Number.isFinite(tooth.cervicalLevel) || !Number.isFinite(tooth.sCenter)) return spec;
  try {
    const vector = (value: Vec3) => {
      if (!Array.isArray(value) || value.length !== 3 || !value.every(Number.isFinite)) throw new Error('Unavailable donor axis.');
      const result = new Vector3(...value);
      if (!(result.length() > 1e-8)) throw new Error('Degenerate donor axis.');
      return result.normalize();
    };
    const archUp = vector(analysis.frame.up), occlusal = vector(tooth.axis);
    if (occlusal.dot(archUp) < 0) occlusal.negate();
    if (occlusal.dot(archUp) < .5) return spec;
    const curve = analysis.curve;
    let index = -1, nearest = Infinity;
    for (let i = 0; i < curve.s.length; i++) {
      const distance = Math.abs(curve.s[i] - tooth.sCenter);
      if (distance < nearest) { nearest = distance; index = i; }
    }
    if (index < 0 || !curve.tangent[index] || !curve.lingual[index]) return spec;
    const tangent = vector(curve.tangent[index]);
    let mesialSign: 1 | -1;
    if (analysis.anterior.apexS !== null && Math.abs(tooth.sCenter - analysis.anterior.apexS) > 1e-8) {
      mesialSign = tooth.sCenter < analysis.anterior.apexS ? 1 : -1;
    } else if (source?.numbering) {
      const donorQuadrant = Math.floor(donor.fdi / 10);
      const right = donorQuadrant === 1 || donorQuadrant === 4;
      mesialSign = (right ? source.numbering.orientation : -source.numbering.orientation) === 1 ? 1 : -1;
    } else return spec;
    const mesial = tangent.addScaledVector(occlusal, -tangent.dot(occlusal)).multiplyScalar(mesialSign);
    if (mesial.length() < 1e-8) return spec;
    mesial.normalize();
    const outward = vector(curve.lingual[index]).negate();
    const buccal = outward.clone().addScaledVector(occlusal, -outward.dot(occlusal));
    buccal.addScaledVector(mesial, -buccal.dot(mesial));
    if (buccal.length() < 1e-8) return spec;
    buccal.normalize();
    if (buccal.dot(outward) < .5) return spec;
    // cervicalLevel is an absolute projection onto analysis.frame.up, not a
    // height above the tooth centroid. This is an estimated scan cut datum.
    const origin = new Vector3(...tooth.centroid);
    origin.addScaledVector(archUp, tooth.cervicalLevel - origin.dot(archUp));
    const targetSigns = spec.anatomicalSigns ?? { mesial: site.mesialSign, buccal: site.buccalSign };
    const donorHandedness = new Vector3().crossVectors(mesial, buccal).dot(occlusal);
    const mirrored = donorHandedness * targetSigns.mesial * targetSigns.buccal < 0;
    // Contralateral mapping must actually reflect world anatomy. A disagreement
    // means the inferred anatomical axes are unresolved, so retain the fallback.
    if (!mirrored) return spec;
    const tuple = (p: Vector3): Vec3 => [p.x, p.y, p.z];
    const crownShape = donorShape(part.positions, tooth.faces, {
      origin: tuple(origin), mesial: tuple(mesial), buccal: tuple(buccal), occlusal: tuple(occlusal),
    }, { arch: site.arch, digit: spec.fdi % 10, donorFdi: donor.fdi, donorPartId: part.id, donorToothId: donor.toothId, mirrored });
    const desired = [spec.parameters.crown.width, spec.parameters.crown.depth, spec.parameters.crown.height + spec.parameters.crown.cuspHeight];
    if (desired.some((dimension, i) => dimension / crownShape.dims[i] < .5 || dimension / crownShape.dims[i] > 2)) return spec;
    const crown = { ...spec.parameters.crown, height: desired[2], cuspHeight: 0 };
    // Replacing a template with donor anatomy must not reopen the initial
    // measured envelope. Manual specs without site measurements retain their
    // explicitly requested parameters.
    if (site.space) {
      const limit = Math.min(site.space.crownHeight?.value ?? Infinity, site.space.vertical?.value ?? Infinity);
      const room = limit - spec.parameters.abutment.height;
      if (!(room > 0)) return spec;
      if (Number.isFinite(room)) crown.height *= Math.min(1, room * (1 - 1e-6) / crownPeak(crownShape, crown.height, 0));
      const width = surfaceWidth(site);
      if (width !== null && width > 0) crown.width = Math.min(crown.width, width * .98 / (2 * crownHalfWidth(crownShape)));
    }
    crownShape.source.provenance += ` Tooth-local mesial axis follows the fitted arch tangent toward the anterior; buccal opposes its lingual field; the occlusal axis is the scanned tooth axis. The cervical cut datum is estimated from scan geometry, not a clinical margin. Contralateral mapping reflects orientation. Initial MD/BL/height scales: ${[crown.width, crown.depth, crown.height].map((dimension, i) => (dimension / crownShape.dims[i]).toPrecision(5)).join(' / ')}. Resampled donor relief is preserved; no additional procedural relief is applied initially. Axis scales remain editable.`;
    const parameters = { ...spec.parameters, crown };
    return { ...spec, parameters, anatomicalSigns: targetSigns, crownShape,
      source: `${spec.source} Patient contralateral donor FDI ${donor.fdi}; tooth-local resampling and reflection, not an exact reconstruction.` };
  } catch { return spec; }
}

/** A conservative local envelope includes the bounded fitting range, displaced crown, abutment and basal cap. */
function contextRadius(spec: RestorationSpec) {
  const { crown: c, abutment: a, fixture: f } = spec.parameters;
  const digit = toothClassOf(spec.fdi) === spec.anatomy ? spec.fdi % 10 : { incisor: 1, canine: 3, premolar: 4, molar: 6 }[spec.anatomy];
  const shape = spec.crownShape ?? templateShape(spec.fdi < 30 ? 'upper' : 'lower', digit);
  let radial = 0, top = 0, meanRim = 0;
  for (const r of shape.wall) radial = Math.max(radial, r);
  for (const r of shape.rim) radial = Math.max(radial, r);
  for (const r of shape.rimZ) { top = Math.max(top, c.height * 1.2 * r); meanRim += r / shape.rimZ.length; }
  const height = (value: number, rim: number) => c.height * 1.2 * value + c.cuspHeight * 1.15 * Math.max(0, (value - rim) / Math.max(.05, 1 - rim));
  for (let i = 0; i < shape.occlusal.length; i++) top = Math.max(top, height(shape.occlusal[i], shape.reliefDatum ?? shape.rimZ[i % shape.rimZ.length]));
  top = Math.max(top, height(shape.apex, shape.reliefDatum ?? meanRim));
  const slope = (angle: number) => Math.tan(Math.min(80, Math.abs(angle) + 6) * Math.PI / 180);
  const offset = a.height * 1.18 * Math.hypot(slope(a.angleY), slope(a.angleX), 1);
  const crown = offset + Math.hypot(c.width * 1.18 * radial / 2, c.depth * 1.18 * radial / 2, top);
  const pillar = Math.max(Math.hypot(f.radius, f.depth), a.emergenceRadius, offset + a.radius);
  // The margin retains local neighboring context; it is a crop parameter, not a clearance target.
  return Math.max(crown, pillar) + Math.max(c.width, c.depth, c.height);
}

/** Every target is a named triangle subset transformed exactly once into the parent frame.
 * Draft labels are optional hypotheses; reviewed labels and explicit erasures always win. */
export function fittingSurfaces(spec: RestorationSpec, parts: ModelPart[], teeth: ToothCase, site?: SiteHypothesis, scans: PreparedCaseSource[] = []): RestorationFitSurface[] {
  const parent = parts.find(part => part.id === spec.parentPartId);
  if (!parent || (parent.role !== 'upper' && parent.role !== 'lower')) return [];
  const generated = parts.filter((part): part is GeneratedCrownPart => !!generatedCrownTargetId(part)
    && (part as GeneratedCrownPart).fitTarget.current && !part.restoration?.stale && (part as GeneratedCrownPart).fitTarget.siteKey !== conceptKey(spec)
    && parts.some(source => !source.restoration && source.id === part.restoration?.parentPartId && (source.role === 'upper' || source.role === 'lower')));
  const available = new Set<number>();
  if (!site || generated.length) for (const part of parts.filter(part => !part.restoration && part.role === parent.role)) {
    const reviewed = teeth.labels[part.id], draft = scans.find(source => source.partId === part.id)?.draftLabels, mask = teeth.reviewedMask?.[part.id];
    for (let face = 0; face < part.triangles; face++) {
      const label = reviewed?.[face] || (!mask?.[face] ? draft?.[face] ?? 0 : 0);
      if (isFdiTooth(label) && toothArch(label) === parent.role && label !== spec.fdi) available.add(label);
    }
  }
  for (const neighbor of Object.values(site?.adjacent ?? {})) if (neighbor?.fdi) available.add(neighbor.fdi);
  const order = RIGHT_TO_LEFT[parent.role], position = order.indexOf(spec.fdi);
  const inverse = partMatrix(parent).invert();
  const origin = new Vector3(...spec.frame.origin), radius = contextRadius(spec);
  const result: RestorationFitSurface[] = [];
  const subset = (part: ModelPart, faces: number[], matrix: Matrix4) => {
    const out = new Float32Array(faces.length * 9), point = new Vector3();
    for (let index = 0; index < faces.length; index++) {
      if (!Number.isSafeInteger(faces[index]) || faces[index] < 0 || faces[index] >= part.triangles) throw new Error('A fitting region has an invalid original source face.');
      for (let corner = 0; corner < 3; corner++) point.fromArray(part.positions, faces[index] * 9 + corner * 3).applyMatrix4(matrix).toArray(out, index * 9 + corner * 3);
    }
    return out;
  };
  const localCrowns = generated.flatMap(part => {
    const source = parts.find(source => source.id === part.restoration!.parentPartId)!;
    // The request descriptor already carries the complete display pose. Do not
    // multiply the source pose a second time or transform the saved vertices.
    const transform = inverse.clone().multiply(partMatrix(part));
    const sourceOrigin = origin.clone().applyMatrix4(transform.clone().invert()), box = new Box3(), point = new Vector3(), faces: number[] = [];
    for (let face = 0; face < part.triangles; face++) {
      box.makeEmpty();
      for (let corner = 0; corner < 3; corner++) box.expandByPoint(point.fromArray(part.positions, face * 9 + corner * 3));
      if (box.distanceToPoint(sourceOrigin) <= radius) faces.push(face);
    }
    const along = new Vector3(...part.fitTarget.origin).applyMatrix4(transform).sub(origin).dot(new Vector3(...spec.frame.u));
    return faces.length ? [{ part, source, transform, faces, along }] : [];
  });
  const numberedCrowns = !spec.draftIdentity && localCrowns.some(({ part, source }) => part.fitTarget.fdi !== null && source.role === parent.role);
  if (numberedCrowns) for (const { part, source } of localCrowns) if (part.fitTarget.fdi !== null && source.role === parent.role) available.add(part.fitTarget.fdi);
  const fallbackFlanks = position < 0 ? [] : [order.slice(0, position).reverse().find(fdi => available.has(fdi)), order.slice(position + 1).find(fdi => available.has(fdi))];
  // Unnumbered sites use the nearest local generated flank on each frame-U
  // side. A template FDI must never supply a patient identity or anatomical side.
  const geometricFlanks = new Map<number, typeof localCrowns[number]>();
  for (const target of localCrowns) if (target.source.role === parent.role && Math.abs(target.along) > 1e-8) {
    const sign = Math.sign(target.along), previous = geometricFlanks.get(sign);
    if (!previous || Math.abs(target.along) < Math.abs(previous.along)) geometricFlanks.set(sign, target);
  }
  for (const target of localCrowns) {
    const { part, source, faces, transform, along } = target, fdi = part.fitTarget.fdi;
    const antagonist = source.role !== parent.role;
    const numbered = !spec.draftIdentity && fdi !== null;
    const adjacent = !antagonist && (numbered ? fallbackFlanks.includes(fdi) : geometricFlanks.get(Math.sign(along)) === target);
    const side = adjacent && spec.anatomicalSigns ? numbered
      ? Math.floor(fdi! / 10) !== Math.floor(spec.fdi / 10) || fdi! % 10 < spec.fdi % 10 ? 'mesial' : 'distal'
      : along * spec.anatomicalSigns.mesial > 0 ? 'mesial' : 'distal' : undefined;
    result.push({ id: generatedCrownTargetId(part)!, role: antagonist ? 'antagonist' : adjacent ? 'adjacent' : 'other-tooth',
      ...(side ? { side } : {}), positions: subset(part, faces, transform),
      targetGap: antagonist ? spec.parameters.crown.height * .025 : adjacent ? spec.parameters.crown.width * .005 : 0,
      targetProvenance: `Generated crown concept (${fdi === null ? 'tooth identity unresolved' : `FDI ${fdi}`}); revision ${part.fitTarget.revision}. ${antagonist
        ? 'Prototype target: 0.025 × initial crown body height in file units; static pose only, no clinical bite target supplied.'
        : adjacent ? 'Prototype target: 0.005 × initial crown width in file units; no clinical proximal-contact target supplied.'
          : 'No attractive contact objective; geometric crossing/clearance context only.'}` });
  }
  for (const part of parts.filter(part => !part.restoration && (part.role === 'upper' || part.role === 'lower'))) {
    const transform = inverse.clone().multiply(partMatrix(part));
    // Test source-space face bounds against the inverse-transformed context.
    // A centroid crop loses long triangles whose edges cross the region.
    const sourceOrigin = origin.clone().applyMatrix4(transform.clone().invert()), box = new Box3(), point = new Vector3();
    const faces: number[] = [], surroundings: number[] = [];
    const byTooth = new Map<number, number[]>(), draftFdis = new Set<number>();
    const labels = teeth.labels[part.id], protectedFaces = teeth.reviewedMask?.[part.id];
    const draft = scans.find(scan => scan.partId === part.id)?.draftLabels;
    const geometricFlanks = new Map<number, { toothId: number; side: 'mesial' | 'distal' } | null>();
    const byRegion = new Map<number, { faces: number[]; side: 'mesial' | 'distal' }>();
    if (spec.draftIdentity && site) for (const side of ['mesial', 'distal'] as const) {
      const neighbour = site.adjacent[side];
      const candidate = neighbour?.partId === part.id ? scans.find(scan => scan.partId === part.id)?.scan.candidates.find(candidate => candidate.id === neighbour.toothId) : undefined;
      for (const face of candidate?.faces ?? []) {
        if (labels?.[face] || protectedFaces?.[face]) continue;
        geometricFlanks.set(face, geometricFlanks.has(face) ? null : { toothId: candidate!.id, side });
      }
    }
    const patch = new Set(part.id === site?.partId ? site.patchFaces : []);
    for (let face = 0; face < part.triangles; face++) {
      box.makeEmpty();
      for (let corner = 0; corner < 3; corner++) box.expandByPoint(point.fromArray(part.positions, face * 9 + corner * 3));
      if (box.distanceToPoint(sourceOrigin) > radius) continue;
      if (part.role !== parent.role) { faces.push(face); continue; }
      if (patch.has(face)) continue;
      const reviewed = labels?.[face] ?? 0;
      const inferred = !reviewed && !protectedFaces?.[face] && draft?.length === part.triangles ? draft[face] : 0;
      const label = reviewed || inferred;
      const labelArch = label < 30 ? 'upper' : 'lower';
      if (/^[1-4][1-8]$/.test(String(label)) && labelArch === parent.role && label !== spec.fdi) {
        const indices = byTooth.get(label) ?? []; indices.push(face); byTooth.set(label, indices);
        if (inferred) draftFdis.add(label);
      } else {
        const flank = geometricFlanks.get(face);
        if (flank) { const region = byRegion.get(flank.toothId) ?? { faces: [], side: flank.side }; region.faces.push(face); byRegion.set(flank.toothId, region); }
        else surroundings.push(face);
      }
    }
    if (faces.length) result.push({ id: `${part.id}:opposing-local-triangles`, role: 'antagonist', positions: subset(part, faces, transform), targetGap: spec.parameters.crown.height * .025, targetProvenance: 'Prototype target: 0.025 × initial crown body height in file units; no clinical bite target supplied.' });
    for (const [fdi, indices] of byTooth) {
      const namedSide = site?.adjacent.mesial?.partId === part.id && site.adjacent.mesial.fdi === fdi ? 'mesial'
        : site?.adjacent.distal?.partId === part.id && site.adjacent.distal.fdi === fdi ? 'distal'
          : undefined;
      const flanking = (!!namedSide || (!site && fallbackFlanks.includes(fdi)))
        && (!numberedCrowns || fallbackFlanks.includes(fdi));
      const side = flanking ? namedSide ?? (!site && spec.anatomicalSigns ? Math.floor(fdi / 10) !== Math.floor(spec.fdi / 10) || fdi % 10 < spec.fdi % 10 ? 'mesial' : 'distal' : undefined) : undefined;
      result.push({ id: `${part.id}:FDI-${fdi}:${draftFdis.has(fdi) ? 'hypothesized-' : ''}local-triangles`, role: flanking ? 'adjacent' : 'other-tooth', ...(side ? { side } : {}), positions: subset(part, indices, transform), targetGap: flanking ? spec.parameters.crown.width * .005 : 0, targetProvenance: flanking ? 'Prototype target: 0.005 × initial crown width in file units; no clinical proximal-contact target supplied.' : 'Other scanned tooth: no attractive contact objective; geometric crossing/clearance context only.' });
    }
    for (const [toothId, region] of byRegion) result.push({ id: `${part.id}:candidate-${toothId}:local-triangles`, role: 'adjacent', side: region.side,
      positions: subset(part, region.faces, transform), targetGap: spec.parameters.crown.width * .005,
      targetProvenance: 'Scanned geometric flank; tooth identity and anatomical side remain hypotheses. Prototype target: 0.005 × initial crown width in file units.' });
    if (surroundings.length) result.push({ id: `${part.id}:unclassified-local-triangles`, role: 'source-arch', positions: subset(part, surroundings, transform), targetGap: 0, targetProvenance: 'Prototype no-crossing objective in file units; tissue response and signed containment are unknown.' });
    if (patch.size) result.push({ id: `${part.id}:visible-ridge-patch`, role: 'tissue', positions: subset(part, [...patch], transform), targetGap: 0, targetProvenance: 'Prototype no-crossing objective in file units; tissue response and signed containment are unknown.' });
  }
  return result;
}
