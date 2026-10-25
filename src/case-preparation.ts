import { detectToothRegions } from './auto-tooth-geometry.ts';
import { analyzeArch, provisionalGroups, SURFACE_CLASSES, type ArchAnalysis, type ArchModel, type ArchToothSegment } from './arch-analysis.ts';
import { confirmedArchOrientation, numberArch, type ArchNumbering } from './tooth-numbering.ts';
import { isRigidPose, mirrorFdi, proposeSites, type SiteArchInput, type SiteHypothesis } from './missing-sites.ts';
import type { AutoToothCandidate, AutoToothScan } from './auto-tooth-types';
import type { Vec3 } from './models';
import type { CasePreparationRequest, CasePreparationResult, PreparationSource, PreparedCaseSource, PreparedIdentity } from './case-preparation-types';

export const DEFAULT_PREPARATION_THRESHOLD = 0.8;
const IDENTITY_POSE = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const readable = (error: unknown) => error instanceof Error ? error.message : 'Local preparation unavailable.';
const validFdi = (fdi: number, arch: 'upper' | 'lower') => Number.isInteger(fdi) && fdi % 10 >= 1 && fdi % 10 <= 8 && (arch === 'upper' ? fdi >= 11 && fdi <= 28 : fdi >= 31 && fdi <= 48);
const facePoint = (positions: Float32Array, face: number): Vec3 => [
  (positions[face * 9] + positions[face * 9 + 3] + positions[face * 9 + 6]) / 3,
  (positions[face * 9 + 1] + positions[face * 9 + 4] + positions[face * 9 + 7]) / 3,
  (positions[face * 9 + 2] + positions[face * 9 + 5] + positions[face * 9 + 8]) / 3,
];

/** Failure axes are for presentation only; no invalid coordinates escape. */
function unavailable(source: PreparationSource, message: string): PreparedCaseSource {
  const low: Vec3 = [Infinity, Infinity, Infinity], high: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < source.positions.length; i++) if (Number.isFinite(source.positions[i])) {
    const axis = i % 3; low[axis] = Math.min(low[axis], source.positions[i]); high[axis] = Math.max(high[axis], source.positions[i]);
  }
  const origin: Vec3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) if (Number.isFinite(low[k]) && Number.isFinite(high[k])) origin[k] = low[k] + (high[k] - low[k]) / 2;
  const warnings = [message, 'Presentation axes only; tooth orientation and identity are unknown.'];
  return { partId: source.id, scan: { frame: { origin, u: [1, 0, 0], v: [0, 1, 0], up: [0, 0, 1] }, candidates: [], warnings, method: 'unavailable', unassignedTriangles: Math.floor(source.positions.length / 9) }, analysis: null, numbering: null, draftLabels: source.reviewedLabels?.length === source.positions.length / 9 ? source.reviewedLabels.slice() : new Uint8Array(Math.floor(source.positions.length / 9)), warnings };
}

/** Whole grouped crown, using original face indices; cusp seeds are not teeth. */
function candidateFor(model: ArchModel, tooth: ArchToothSegment): AutoToothCandidate {
  let area = 0, seed = tooth.faces[0], height = -Infinity;
  for (const face of tooth.faces) {
    area += model.mesh.area[face] * model.scale ** 2;
    const point = facePoint(model.positions, face);
    const h = point[0] * model.up[0] + point[1] * model.up[1] + point[2] * model.up[2];
    if (h > height) { height = h; seed = face; }
  }
  return { id: tooth.id, faces: tooth.faces, seed: { face: seed, point: facePoint(model.positions, seed) }, centroid: tooth.centroid, area, height: tooth.height, warnings: [...tooth.flags] };
}

/** A failed sequence fit must not silently erase an independent crown region.
 * Retained regions carry no identity or confidence; known tooth spans prevent
 * secondary cusp seeds from becoming extra teeth inside an already grouped crown.
 */
function retainUnresolvedCrowns(model: ArchModel, analysis: ArchAnalysis, detected: AutoToothScan) {
  const assigned = new Set(analysis.teeth.flatMap(tooth => [...tooth.faces]));
  for (const candidate of detected.candidates) {
    const s = model.faceS[candidate.seed.face] * model.scale;
    if (!Number.isFinite(s) || analysis.teeth.some(tooth => s >= tooth.s[0] && s <= tooth.s[1])) continue;
    const atom = model.atoms.find(atom => s >= atom.s0 && s < atom.s1);
    if (!atom || atom.crownFrac < 0.5 || atom.steep < 1.8 || (atom.tissue !== null && atom.tissue > 0.5)) continue;
    const faces = candidate.faces.filter(face => !assigned.has(face) && !model.debris[face]);
    if (faces.length < 12 || faces.length < 0.8 * candidate.faces.length) continue;
    let s0 = Infinity, s1 = -Infinity;
    for (const face of faces) { const fs = model.faceS[face] * model.scale; if (Number.isFinite(fs)) { s0 = Math.min(s0, fs); s1 = Math.max(s1, fs); } }
    if (!Number.isFinite(s0) || !(s1 > s0)) continue;
    for (const face of faces) { assigned.add(face); analysis.classes[face] = 1; }
    analysis.teeth.push({ id: analysis.teeth.length + 1, fdi: null, faces, centroid: candidate.centroid, top: candidate.seed.point, axis: model.up,
      s: [s0, s1], sCenter: (s0 + s1) / 2, mdWidth: s1 - s0, blWidth: 0, height: candidate.height, cervicalLevel: candidate.seed.point.reduce((sum, value, k) => sum + value * model.up[k], 0) - candidate.height,
      peaks: 1, crownScore: 0, kind: 'crown', flags: ['Crown-like region retained outside the sequence fit; identity and grouping are unresolved.', ...candidate.warnings] });
  }
  for (const name of SURFACE_CLASSES) analysis.classCounts[name] = 0;
  // Excluded/degenerate analysis copies retain their original-order unknown
  // class; the public counts still cover every source triangle for persistence.
  for (const value of analysis.classes) analysis.classCounts[SURFACE_CLASSES[value]]++;
}

interface LocalArch { source: PreparationSource; prepared: PreparedCaseSource; model: ArchModel; numbering: ArchNumbering; confirmed: boolean }

/**
 * Data-only local executor. Never mutates chart, reviewed arrays or source data.
 * All outputs remain source-frame/file-unit hypotheses. The caller snapshots
 * dependencies into revision and terminates stale synchronous worker jobs.
 */
export function prepareCase(args: CasePreparationRequest): CasePreparationResult {
  if (!Number.isInteger(args.id) || typeof args.revision !== 'string' || !Array.isArray(args.sources)) throw new Error('Preparation requires an operation id, dependency revision and source list.');
  if (args.sources.length > 6 || new Set(args.sources.map(source => source.id)).size !== args.sources.length) throw new Error('Preparation supports at most six uniquely identified arch sources.');
  const threshold = args.confidenceThreshold ?? DEFAULT_PREPARATION_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('Confidence threshold must be between zero and one.');
  const scans: PreparedCaseSource[] = [], identities: PreparedIdentity[] = [], locals: LocalArch[] = [];
  const warnings = ['Automatic geometry and FDI are draft hypotheses; evidence scores are not clinical accuracy. Distances remain file units (u).'];
  for (const source of args.sources) {
    try {
      if (!source.id || (source.arch !== 'upper' && source.arch !== 'lower')) throw new Error('A source requires an opaque id and explicit upper/lower role.');
      if (!(source.positions instanceof Float32Array) || source.positions.length % 9) throw new Error('Preparation needs complete Float32Array triangles.');
      const triangles = source.positions.length / 9;
      if (source.reviewedLabels && (!(source.reviewedLabels instanceof Uint8Array) || source.reviewedLabels.length !== triangles)) throw new Error('Reviewed labels do not match original source triangle order.');
      if (source.reviewedMask && (!(source.reviewedMask instanceof Uint8Array) || source.reviewedMask.length !== triangles)) throw new Error('Reviewed correction mask does not match original source triangle order.');
      for (const correction of source.identityCorrections ?? []) {
        if ((correction.fdi !== null && !validFdi(correction.fdi, source.arch)) || !correction.faces.length || new Set(correction.faces).size !== correction.faces.length || correction.faces.some(face => !Number.isInteger(face) || face < 0 || face >= triangles)) throw new Error('Draft identity correction does not match this source.');
      }
      // Reviewed non-tooth exclusions cannot seed or regroup into a tooth.
      // Degenerate only the disposable analysis copy, retaining original face
      // indices and all other source coordinates. An erasure (protected zero)
      // remains geometry and is protected at assignment, not treated as a hole.
      const hasExclusions = source.reviewedLabels?.includes(255) ?? false;
      const geometry = hasExclusions ? source.positions.slice() : source.positions;
      if (hasExclusions) for (let face = 0; face < triangles; face++) if (source.reviewedLabels![face] === 255) {
        const point = geometry.subarray(face * 9, face * 9 + 3);
        geometry.set(point, face * 9 + 3); geometry.set(point, face * 9 + 6);
      }
      const detected = detectToothRegions(geometry, { direction: 'auto', sensitivity: 1 }, source.tissueScores);
      const model = analyzeArch(geometry, detected, { tissueScores: source.tissueScores });
      const orientation = confirmedArchOrientation(model, detected.frame.u, args.patientRight?.[source.id]);
      const localWarnings = [...detected.warnings];
      if (hasExclusions) localWarnings.push('Reviewed non-tooth faces were omitted from disposable shape evidence; source coordinates, original triangle order and saved corrections are preserved.');
      if (source.pose && !isRigidPose(source.pose)) localWarnings.push('Source pose has scaling, reflection, shear or invalid values; cross-arch measurements are unavailable.');
      if (orientation.orientation === null) localWarnings.push(orientation.basis);
      let numbered: ArchNumbering | null = null;
      try { numbered = numberArch(model, { arch: source.arch, orientation: orientation.orientation ?? 1, apexS: model.anterior.apexS, apexWeight: model.anterior.confidence }); }
      catch (error) { localWarnings.push(readable(error)); }
      const analysis = model.finalize(numbered?.groups ?? provisionalGroups(model));
      retainUnresolvedCrowns(model, analysis, detected);
      const confirmed = orientation.orientation !== null && source.roleConfirmed !== false;
      const identityBasis = source.roleConfirmed === false ? 'Upper/lower role is unconfirmed.' : orientation.basis;
      if (source.roleConfirmed === false) localWarnings.push('Upper/lower role is an unconfirmed import hint; anatomical identity and cross-arch measurements are withheld.');
      if (!confirmed) {
        // Joint sequence fitting groups whole teeth even with unknown chirality.
        // Its latent orientation is not an anatomical assertion in public output.
        analysis.teeth.forEach(tooth => { tooth.fdi = null; });
        analysis.gaps.forEach(gap => { gap.positions = []; });
      }
      // Candidate IDs remain geometric, independent of orientation and labels.
      const candidates = analysis.teeth.map(tooth => candidateFor(model, tooth));
      const assigned = candidates.reduce((sum, candidate) => sum + candidate.faces.length, 0);
      const scan: AutoToothScan = { frame: detected.frame, candidates, warnings: [...new Set([...localWarnings, ...analysis.warnings])], method: `${analysis.method} / joint whole-tooth grouping`, unassignedTriangles: triangles - assigned };
      const draftLabels = source.reviewedLabels?.slice() ?? new Uint8Array(triangles);
      const prepared: PreparedCaseSource = { partId: source.id, scan, analysis, numbering: confirmed ? numbered : null, draftLabels, warnings: scan.warnings };
      for (const tooth of analysis.teeth) {
        const group = numbered?.groups.find(group => group.kind === 'tooth' && Math.abs(model.atoms[group.start].s0 - tooth.s[0]) < 1e-8 && Math.abs(model.atoms[group.end].s1 - tooth.s[1]) < 1e-8);
        const reviewed = new Set<number>();
        let protectedCorrection = false;
        for (const face of tooth.faces) {
          const label = source.reviewedLabels?.[face];
          if (label && validFdi(label, source.arch)) reviewed.add(label);
          else if (label || source.reviewedMask?.[face]) protectedCorrection = true;
        }
        const reviewedFdi = reviewed.size === 1 ? [...reviewed][0] : null;
        const faceSet = new Set(tooth.faces);
        const draftCorrections = (source.identityCorrections ?? []).filter(correction => correction.faces.some(face => faceSet.has(face)));
        const exactCorrection = draftCorrections.length > 0 && draftCorrections.every(correction => correction.fdi === draftCorrections[0].fdi && correction.faces.length === faceSet.size && correction.faces.every(face => faceSet.has(face))) ? draftCorrections[0] : undefined;
        const changedCorrection = draftCorrections.length > 0 && !exactCorrection;
        const fdi = reviewed.size > 1 ? null : reviewedFdi ?? (exactCorrection ? exactCorrection.fdi : tooth.fdi);
        const chart = fdi === null ? undefined : args.chart?.[fdi];
        const contradiction = chart?.status === 'missing' || chart?.status === 'not-scanned';
        const confidence = reviewedFdi !== null || exactCorrection ? 1 : confirmed ? (group?.confidence ?? 0) * orientation.confidence : 0;
        const blockingReasons: string[] = [];
        if (fdi === null) blockingReasons.push(!confirmed ? identityBasis : 'Crown identity is unresolved.');
        if (contradiction) blockingReasons.push('The identity conflicts with the saved missing/not-scanned chart record.');
        if (reviewed.size > 1) blockingReasons.push('This grouped region intersects conflicting reviewed tooth labels.');
        if (reviewedFdi !== null && tooth.fdi !== null && reviewedFdi !== tooth.fdi) blockingReasons.push('Reviewed identity differs from the geometric sequence; the reviewed correction is preserved and the sequence needs review.');
        if (protectedCorrection) blockingReasons.push('This grouped region intersects a protected exclusion or erased correction.');
        if (changedCorrection) blockingReasons.push('This region differs from the original draft correction faces; review its changed boundary.');
        if (exactCorrection?.fdi === null) blockingReasons.push('Skipped in the draft by you.');
        blockingReasons.push(...tooth.flags);
        const needsReview = confidence < threshold || blockingReasons.length > 0;
        const reason = reviewed.size > 1 ? 'This grouped crown intersects conflicting reviewed labels; corrections are preserved.' : reviewedFdi !== null ? 'Existing reviewed identity preserved.' : !confirmed ? identityBasis : contradiction ? 'The draft identity conflicts with the saved missing/not-scanned chart record.' : tooth.flags.length ? tooth.flags.join(' ') : `Joint crown/space sequence evidence score ${confidence.toFixed(3)}; threshold ${threshold.toFixed(2)}.`;
        const alternatives = confirmed && reviewedFdi === null ? [...(group?.alternatives ?? [])] : [];
        identities.push({ partId: source.id, candidateId: tooth.id, fdi, confidence, alternatives, needsReview, blockingReasons, reason: exactCorrection && reviewedFdi === null ? 'Draft correction retained on its original faces; saved clinical records remain separate.' : reason, source: reviewedFdi !== null || exactCorrection ? 'reviewed' : 'geometry' });
        // Downstream neighbours and donor references must see the same reviewed
        // identity (including conflicts) as the preparation result.
        tooth.fdi = fdi;
        // This disposable map may contain low-score hypotheses. Eligibility
        // comes from identities; reviewed labels and zero corrections win.
        if (fdi !== null && !contradiction && reviewed.size <= 1) for (const face of tooth.faces) {
          if (source.reviewedLabels?.[face] || source.reviewedMask?.[face]) continue;
          draftLabels[face] = fdi;
        }
      }
      scans.push(prepared);
      if (numbered) locals.push({ source, prepared, model, numbering: numbered, confirmed });
    } catch (error) { scans.push(unavailable(source, readable(error))); }
  }
  // Distinct candidates or imported components cannot silently share one draft
  // identity. A saved correction wins, and other proposals remain exceptions.
  const byFdi = new Map<number, PreparedIdentity[]>();
  for (const item of identities) if (item.fdi !== null) {
    const group = byFdi.get(item.fdi) ?? []; group.push(item); byFdi.set(item.fdi, group);
  }
  for (const group of byFdi.values()) if (group.length > 1) for (const item of group) {
    if (item.source === 'reviewed' && group.filter(candidate => candidate.source === 'reviewed').length === 1) continue;
    item.needsReview = true;
    item.reason = 'Multiple crown regions propose the same FDI; existing reviewed corrections are preserved.';
    item.blockingReasons = [...(item.blockingReasons ?? []), item.reason];
  }
  // Site localization uses worker-only ArchModel state. For unknown laterality
  // restore latent position spans locally, then scrub every generated identity.
  const siteInputs: SiteArchInput[] = locals.map(local => {
    const analysis = local.prepared.analysis!;
    if (!local.confirmed) for (const gap of analysis.gaps) {
      const group = local.numbering.groups.find(group => group.kind === 'gap' && local.model.atoms[group.start].s0 === gap.s[0] && local.model.atoms[group.end].s1 === gap.s[1]);
      gap.positions = [...(group?.positions ?? [])];
    }
    const sourceIdentities = identities.filter(item => item.partId === local.source.id);
    const orientation = confirmedArchOrientation(local.model, local.prepared.scan.frame.u, args.patientRight?.[local.source.id]);
    return { partId: local.source.id, arch: local.source.arch, roleConfirmed: local.source.roleConfirmed, model: local.model, analysis, numbering: local.numbering, pose: local.source.pose ?? [...IDENTITY_POSE], identityConfidence: local.confirmed ? orientation.confidence : 0, identityConfirmed: local.confirmed,
      reviewedLabels: local.source.reviewedLabels, reviewedMask: local.source.reviewedMask,
      identities: Object.fromEntries(sourceIdentities.map(item => [item.candidateId, { fdi: item.fdi, confidence: item.needsReview ? 0 : item.confidence }])) };
  });
  const sites = proposeSites(siteInputs, { chart: args.chart ?? {}, poseVerified: args.poseVerified ?? false });
  for (const local of locals) if (!local.confirmed) {
    local.prepared.analysis!.gaps.forEach(gap => { gap.positions = []; });
    for (const site of sites) if (site.partId === local.source.id && site.kind !== 'chart') clearSiteIdentity(site, local.source.roleConfirmed === false ? 'Upper/lower role is unconfirmed; the space has no asserted anatomical identity.' : undefined);
  }
  return { id: args.id, revision: args.revision, scans, sites, identities, warnings };
}

function clearSiteIdentity(site: SiteHypothesis, reason = 'Patient right is unconfirmed; the space is localized without an asserted FDI.') {
  if (site.fdi !== null && site.kind === 'bounded' && site.anchor && site.frame && !['not-scanned', 'segmentation-unresolved'].includes(site.status)) {
    site.draftIdentity = { templateFdi: site.fdi, alternatives: [...new Set([site.fdi, mirrorFdi(site.fdi), ...site.alternatives])], basis: `${reason} The local sequence selects an illustrative crown template only; patient side and tooth identity remain unresolved.` };
  }
  site.fdi = null; site.alternatives = []; site.confidence = 0;
  if (site.status !== 'not-scanned' && site.status !== 'segmentation-unresolved') site.status = 'identity-unresolved';
  // Opposing identities belong to their own source: an unresolved lower site
  // cannot erase an independently established upper crown identity.
  for (const neighbour of [site.adjacent.mesial, site.adjacent.distal, site.contralateral]) if (neighbour) { neighbour.fdi = null; neighbour.confidence = 0; }
  site.contralateral = null;
  site.evidence.supporting = site.evidence.supporting.map(text => text.replace(/FDI \d+/g, 'unconfirmed position'));
  site.evidence.conflicting = [reason, ...site.evidence.conflicting.map(text => text.replace(/FDI \d+/g, 'unconfirmed position'))];
  site.questions = site.questions.map(text => text.replace(/FDI \d+/g, 'unconfirmed position'));
}

/** Transfer all result buffers exactly once; shared candidate/analysis faces alias. */
export function preparationTransfers(result: CasePreparationResult): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const add = (buffer: ArrayBufferLike) => { if (buffer instanceof ArrayBuffer) buffers.add(buffer); };
  for (const source of result.scans) {
    add(source.draftLabels.buffer);
    if (source.analysis) add(source.analysis.classes.buffer);
    for (const candidate of source.scan.candidates) add(candidate.faces.buffer);
  }
  for (const site of result.sites) add(site.patchFaces.buffer);
  return [...buffers];
}
