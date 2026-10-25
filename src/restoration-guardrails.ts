import type { RestorationComponentKind, RestorationMesh, RestorationSpec, RestorationFitMeasurement } from './restoration-types';
import type { CrownExtents, QualityCriterion, QualityStatus } from './restoration-quality';

export const RESTORATION_GUARDRAILS_VERSION = 'restoration-guardrails/v1' as const;
export const RESTORATION_GUARDRAIL_IDS = ['anatomy', 'dimensions', 'cervical-emergence', 'surface-integrity', 'shade', 'subcrestal-placement', 'adjacent-root-clearance'] as const;
export type RestorationGuardrailId = typeof RESTORATION_GUARDRAIL_IDS[number];
export type GuardrailValue = string | number | boolean | null;

/** Optional case feedback, never a clinical constraint or a fitter objective.
 * Clinician-entered records confirmed wording, not verified clinical applicability. */
export interface RestorationPlacementFeedback {
  provenance: 'unconfirmed-case-feedback' | 'clinician-entered-case-feedback';
  source: string;
  subcrestalDepthMm: number | null;
  adjacentToothClearanceMm: number | null;
}
export interface RestorationGuardrailSuggestion {
  component: RestorationComponentKind;
  kind: 'parameter' | 'anatomy' | 'appearance' | 'inspect' | 'collect-evidence';
  /** Supported control names to inspect; these are not an executable edit. */
  parameters: string[];
  action: string;
  /** Deliberately no numeric proposal for an unmeasured clinical relationship. */
  automatic: false;
}
export interface RestorationGuardrailIssue {
  id: RestorationGuardrailId;
  components: RestorationComponentKind[];
  status: QualityStatus;
  summary: string;
  /** JSON-safe measurements and explicitly named nominal controls. Null means unmeasured. */
  actual: Record<string, GuardrailValue>;
  target: {
    description: string;
    value: number | null;
    units: 'file units (u)' | 'mm' | 'not-established';
    provenance: 'engineering-prototype' | 'unconfirmed-case-feedback' | 'clinician-entered-case-feedback' | 'not-established';
  };
  missingEvidence: string[];
  suggestions: RestorationGuardrailSuggestion[];
}
export interface RestorationComponentExtents {
  component: RestorationComponentKind;
  /** Bounds projected onto the construction frame; not nominal controls, bone measurements or axis lengths. */
  extents: CrownExtents | null;
}
export interface RestorationGuardrailReport {
  version: typeof RESTORATION_GUARDRAILS_VERSION;
  status: QualityStatus;
  units: 'file units (u)';
  componentExtents: RestorationComponentExtents[];
  issues: RestorationGuardrailIssue[];
  limits: string[];
}
export interface RestorationGuardrailInput {
  spec: RestorationSpec;
  components: RestorationMesh[];
  criteria: QualityCriterion[];
  measurement?: RestorationFitMeasurement | null;
  placementFeedback?: RestorationPlacementFeedback | null;
}

const kinds = ['fixture', 'abutment', 'crown'] as const;
const unknownTarget = (description: string): RestorationGuardrailIssue['target'] => ({ description, value: null, units: 'not-established', provenance: 'not-established' });
const suggestion = (component: RestorationComponentKind, kind: RestorationGuardrailSuggestion['kind'], parameters: string[], action: string): RestorationGuardrailSuggestion => ({ component, kind, parameters, action, automatic: false });
const finiteOrNull = (value: number | undefined): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;

/** Linear in emitted vertices, in the same source/site frame as the quality evaluator. */
export function measureRestorationComponentExtents(spec: RestorationSpec, component?: RestorationMesh): CrownExtents | null {
  if (!component?.positions.length || component.positions.length % 9) return null;
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
  const { origin, u, v, up } = spec.frame;
  for (let i = 0; i < component.positions.length; i += 3) {
    const x = component.positions[i] - origin[0], y = component.positions[i + 1] - origin[1], z = component.positions[i + 2] - origin[2];
    const values = [x * u[0] + y * u[1] + z * u[2], x * v[0] + y * v[1] + z * v[2], x * up[0] + y * up[1] + z * up[2]];
    if (!values.every(Number.isFinite)) return null;
    for (let axis = 0; axis < 3; axis++) { low[axis] = Math.min(low[axis], values[axis]); high[axis] = Math.max(high[axis], values[axis]); }
  }
  return { mesiodistal: high[0] - low[0], buccolingual: high[1] - low[1], occlusal: high[2] - low[2], base: low[2], top: high[2] };
}

/** Basic emitted-triangle diagnostics only; neither smooth shading nor closed metadata proves surface integrity. */
function surfaceDiagnostics(component?: RestorationMesh) {
  if (!component) return { present: false, declaredClosed: null, triangleLayoutValid: false, nonfiniteCoordinates: null, degenerateTriangles: null };
  const positions = component.positions;
  let nonfiniteCoordinates = 0, degenerateTriangles = 0;
  for (const value of positions) if (!Number.isFinite(value)) nonfiniteCoordinates++;
  for (let i = 0; i + 8 < positions.length; i += 9) {
    const ax = positions[i + 3] - positions[i], ay = positions[i + 4] - positions[i + 1], az = positions[i + 5] - positions[i + 2];
    const bx = positions[i + 6] - positions[i], by = positions[i + 7] - positions[i + 1], bz = positions[i + 8] - positions[i + 2];
    const area = Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
    const scale = Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz);
    // A scale-relative numerical degeneracy check, not a clinical surface-finish tolerance.
    if (Number.isFinite(area) && !(area > scale * 1e-12)) degenerateTriangles++;
  }
  return { present: true, declaredClosed: component.closed, triangleLayoutValid: positions.length > 0 && positions.length % 9 === 0,
    nonfiniteCoordinates, degenerateTriangles };
}

/**
 * Dentist-feedback audit kept separate from the ten existing fitting criteria.
 * Unknown clinical evidence never produces a pass or an executable revision.
 * Placement/shade/clinical contour evidence is not ingested by this evaluator.
 */
export function evaluateRestorationGuardrails(input: RestorationGuardrailInput): RestorationGuardrailReport {
  const { spec, components, criteria } = input;
  const p = spec.parameters;
  const componentExtents = kinds.map(component => ({ component, extents: measureRestorationComponentExtents(spec, components.find(mesh => mesh.component === component)) }));
  const crown = componentExtents.find(item => item.component === 'crown')!.extents;
  const criterion = (id: QualityCriterion['id']) => criteria.find(item => item.id === id);
  const anatomy = criterion('anatomy');
  const issues: RestorationGuardrailIssue[] = [];
  issues.push({ id: 'anatomy', components: ['crown'], status: anatomy?.status === 'fail' || !crown ? 'fail' : 'unknown',
    summary: anatomy?.status === 'fail' ? anatomy.reasons.join(' ') : 'Tooth class or donor provenance does not demonstrate the emitted cusps, ridges, fossae or cervical anatomy.',
    actual: { toothClass: spec.anatomy, source: spec.crownShape?.source.kind ?? 'procedural-template', toothIdentityReviewed: null,
      emittedCrownAvailable: !!crown, donorAnisotropy: anatomy?.measured.donorAnisotropy ?? null, demonstratedCuspCount: null,
      nominalCuspHeight: p.crown.cuspHeight, nominalOcclusalScale: spec.contour?.occlusalScale ?? 1 },
    target: unknownTarget('Reviewed tooth-specific morphology; gap width alone cannot select tooth class.'),
    missingEvidence: ['Reviewed tooth identity and suitable anatomical reference.', 'Inspection of actual emitted cusp peaks/incisal form, marginal ridges, fossae, grooves and cervical taper.'],
    suggestions: [suggestion('crown', 'anatomy', ['anatomy'], 'Compare a supported tooth template with reviewed tooth identity; retain source/provenance and inspect the regenerated surface. A suitable donor requires its separate local evidence workflow.'),
      suggestion('crown', 'parameter', ['crown.cuspHeight', 'crown.rotation', 'contour.occlusalScale'], 'Review relief and orientation against the actual crown and antagonist; increasing relief alone does not recreate missing anatomy.')] });

  const dimensionRules = ['relative-width', 'relative-depth', 'relative-height', 'space-occupancy'] as const;
  const failedDimensions = dimensionRules.map(criterion).filter(item => item?.status === 'fail');
  const dimensions: Record<string, GuardrailValue> = { measurementFrame: 'site u/v/up; source coordinates', units: 'file units (u)', verifiedMmPerUnit: null };
  for (const item of componentExtents) {
    for (const key of ['mesiodistal', 'buccolingual', 'occlusal', 'base', 'top'] as const) dimensions[`${item.component}.${key}`] = item.extents?.[key] ?? null;
  }
  // Names explicitly distinguish controls from actual emitted bounds.
  for (const kind of kinds) for (const [key, value] of Object.entries(p[kind])) dimensions[`nominal.${kind}.${key}`] = finiteOrNull(value);
  issues.push({ id: 'dimensions', components: [...kinds], status: failedDimensions.length || componentExtents.some(item => !item.extents) ? 'fail' : 'unknown',
    summary: failedDimensions.length ? failedDimensions.flatMap(item => item!.reasons).join(' ') : 'Actual component extents are reported; acceptable patient-specific dimensions are not established by template controls or prototype ratios.',
    actual: dimensions, target: unknownTarget('Reviewed component-specific dimensions and proportions in an explicitly defined frame; see the separate engineering criteria for measured comparison ranges.'),
    missingEvidence: ['Clinician-reviewed component dimension targets and anatomical references.', 'Independent physical calibration before any millimetre comparison.'],
    suggestions: [suggestion('crown', 'parameter', ['crown.width', 'crown.depth', 'crown.height'], 'Use emitted MD/BL/occlusal bounds and measured neighbour/headroom evidence to choose a bounded change; regenerate and remeasure because rotation and anatomy alter extents.'),
      suggestion('abutment', 'parameter', ['abutment.radius', 'abutment.height'], 'Compare the generic envelope with crown/cervical evidence; nominal height is not measured gingival height.'),
      suggestion('fixture', 'collect-evidence', ['fixture.radius', 'fixture.length'], 'Obtain reviewed bone, root and implant-system evidence before choosing clinical fixture dimensions; geometric controls remain a concept hypothesis.')] });

  const tissue = input.measurement?.surfaces.filter(surface => surface.role === 'tissue') ?? [];
  const footprint = crown ? Math.min(crown.mesiodistal, crown.buccolingual) / 2 : null;
  const overcontour = footprint !== null && (p.abutment.radius >= footprint || p.abutment.emergenceRadius >= footprint);
  const tissueCrossing = tissue.some(surface => (surface.transverseCrossingTriangles ?? 0) > 0);
  const tissueClassified = tissue.length > 0 && tissue.every(surface => typeof surface.transverseCrossingTriangles === 'number' && Number.isFinite(surface.transverseCrossingTriangles) && surface.transverseCrossingTriangles >= 0);
  const unclassifiedTissueIntersections = tissue.filter(surface => surface.transverseCrossingTriangles === undefined).reduce((sum, surface) => sum + surface.intersectingTriangles, 0);
  const tissueGaps = tissue.map(surface => surface.sampledMinDistance).filter(Number.isFinite);
  issues.push({ id: 'cervical-emergence', components: ['abutment', 'crown'], status: overcontour || tissueCrossing ? 'fail' : 'unknown',
    summary: overcontour ? 'Generic abutment radii reach the crown half-footprint; inspect the actual cervical transition for overcontour.' : tissueCrossing ? 'Observed transverse crossings with a supplied tissue target require local contour review.' : unclassifiedTissueIntersections > 0 ? 'Legacy tissue intersections are unclassified: contact and transverse crossing cannot be distinguished. Cervical fit remains unassessed.' : 'Cervical continuity, emergence profile and tissue response are not established by closure or zero sampled crossings.',
    actual: { nominalAbutmentRadius: p.abutment.radius, nominalEmergenceRadius: p.abutment.emergenceRadius, nominalAbutmentHeight: p.abutment.height,
      crownHalfFootprint: footprint, suppliedTissueTargets: tissue.length, sampledTissueMinDistance: tissueGaps.length ? Math.min(...tissueGaps) : null,
      tissueCrossingObserved: tissueCrossing ? true : tissueClassified ? false : null, unclassifiedTissueIntersectingTriangles: tissue.length ? unclassifiedTissueIntersections : null,
      clinicalEmergenceAngleDegrees: null, tissueCompression: null, nominalCervicalScale: spec.contour?.cervicalScale ?? 1 },
    target: unknownTarget('Reviewed crown–abutment–mucosal transition, emergence and hygiene access; no universal angle or tissue-pressure target.'),
    missingEvidence: ['Reviewed cervical/mucosal boundary and implant platform relationship.', 'Local contour/continuity and hygiene-access review; tissue thickness/response cannot be inferred from an external surface.'],
    suggestions: [suggestion('abutment', 'parameter', ['abutment.emergenceRadius', 'abutment.radius', 'abutment.height'], 'Inspect the cervical cross-section and envelope before a bounded radius/height adjustment; regenerate and reassess tissue and antagonist relationships.'),
      suggestion('crown', 'parameter', ['contour.cervicalScale'], 'Review cervical wall contour in the emitted surface before a bounded contour adjustment; a closed basal cap is not an intaglio or tissue-fit result.')] });

  const surfaceActual: Record<string, GuardrailValue> = { selfIntersection: 'untested', physicalSurfaceFinish: null, cervicalContinuity: 'unassessed' };
  let invalidSurface = false;
  for (const kind of kinds) {
    const result = surfaceDiagnostics(components.find(component => component.component === kind));
    for (const [key, value] of Object.entries(result)) surfaceActual[`${kind}.${key}`] = value;
    invalidSurface ||= !result.present || !result.declaredClosed || !result.triangleLayoutValid || !!result.nonfiniteCoordinates || !!result.degenerateTriangles;
  }
  issues.push({ id: 'surface-integrity', components: [...kinds], status: invalidSurface ? 'fail' : 'unknown',
    summary: invalidSurface ? 'A missing, open, malformed, nonfinite or degenerate component failed the basic emitted-surface checks.' : 'Basic emitted triangles have no detected finite/degeneracy error; full surface integrity remains unassessed.',
    actual: surfaceActual, target: unknownTarget('Valid emitted surfaces plus separate self-intersection, cervical transition and material/process review.'),
    missingEvidence: ['Independent self-intersection and local fold/continuity checks.', 'Material/process surface finish and manufacturing evidence; smooth display normals do not change geometry.'],
    suggestions: kinds.map(component => suggestion(component, 'inspect', [], 'Inspect the reported component and regenerate from a valid specification if malformed; do not hide geometry defects with display smoothing.')) });

  issues.push({ id: 'shade', components: ['crown'], status: 'unknown',
    summary: 'Clinical shade is unsupported by this geometry evaluator; render colour and metal/ceramic finish are illustrative appearance.',
    actual: { measuredShade: null, displayColorOverride: spec.appearance?.crown?.color ?? null, displayRoughnessOverride: spec.appearance?.crown?.roughness ?? null, shadeMatch: null },
    target: unknownTarget('A recorded clinical shade target and suitable measurement/viewing evidence.'),
    missingEvidence: ['Separately recorded shade measurement/reference and controlled viewing conditions; an RGB texture is not automatically calibrated shade.'],
    suggestions: [suggestion('crown', 'appearance', ['appearance.crown.color', 'appearance.crown.roughness'], 'An explicitly enabled appearance tool may adjust the concept display colour/roughness; report it as display-only and keep clinical shade unknown.')] });

  const feedback = input.placementFeedback && ['unconfirmed-case-feedback', 'clinician-entered-case-feedback'].includes(input.placementFeedback.provenance) ? input.placementFeedback : null;
  const feedbackLabel = feedback?.provenance === 'clinician-entered-case-feedback' ? 'Clinician-entered case' : 'Unconfirmed case';
  const feedbackTarget = (value: number | null | undefined, description: string): RestorationGuardrailIssue['target'] => ({ description,
    value: typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null, units: 'mm',
    provenance: feedback?.provenance ?? 'not-established' });
  issues.push({ id: 'subcrestal-placement', components: ['fixture'], status: 'unknown',
    summary: 'Fixture depth is an offset from the construction origin, not a measured implant-platform-to-bone-crest depth. Case feedback is not an applied clinical target.',
    actual: { nominalDepthFromSiteOrigin: p.fixture.depth, nominalDepthUnits: 'file units (u)', measuredSubcrestalDepthMm: null, verifiedMmPerUnit: null, reviewedBoneCrest: null, feedbackSource: feedback?.source ?? null },
    target: feedbackTarget(feedback?.subcrestalDepthMm, `${feedbackLabel} subcrestal-depth feedback only; review platform/crest datum, applicability and tolerance before assessment.`),
    missingEvidence: ['Independent verified scale and registration in the evaluated revision.', 'Reviewed bone crest, selected implant platform/axis and implant-system context.', 'Clinician review of target applicability, its reference surface and tolerance.'],
    suggestions: [suggestion('fixture', 'collect-evidence', ['fixture.depth'], 'Resolve the target and bone/scale evidence first. Never copy a millimetre target into fixture.depth or use the gingival surface as bone crest.')] });
  issues.push({ id: 'adjacent-root-clearance', components: ['fixture'], status: 'unknown',
    summary: 'Crown contacts and a scanned gap do not measure fixture-to-root clearance. Adjacent-teeth feedback needs an explicit surface/distance definition.',
    actual: { measuredFixtureToRootClearanceMm: null, measuredFixtureToAdjacentToothClearanceMm: null, reviewedNeighborRoots: null, verifiedMmPerUnit: null, feedbackSource: feedback?.source ?? null },
    target: feedbackTarget(feedback?.adjacentToothClearanceMm, `${feedbackLabel} minimum adjacent-teeth clearance feedback only; resolve tooth/root/implant surfaces and uncertainty before assessment.`),
    missingEvidence: ['Reviewed neighboring tooth/root geometry and other relevant anatomical exclusions.', 'Verified physical scale, source registration and a defined fixture-to-target measurement method.', 'Clinician review of clearance-target applicability; crown distance cannot substitute for root distance.'],
    suggestions: [suggestion('fixture', 'collect-evidence', ['fixture.radius', 'fixture.depth', 'fixture.length'], 'Collect and review the missing evidence; no movement of original meshes or automatic fixture relocation follows from a crown-gap measurement.')] });

  return { version: RESTORATION_GUARDRAILS_VERSION, status: issues.some(issue => issue.status === 'fail') ? 'fail' : 'unknown', units: 'file units (u)', componentExtents, issues,
    limits: ['Dentist-feedback guardrails are separate from the ten engineering fitting criteria and never append automatic revisions.',
      'All measurements refer to exactly the supplied spec, emitted components and fit evidence; the host must bind these to source/pose/site/parameter revisions.',
      'Clinical scale, bone/root, shade and contour acceptance evidence is not evaluated by this API. Missing evidence lists requirements for assessment, not proof that the entire case lacks those records.',
      'Placement feedback is optional and case-specific. Confirmed clinician wording does not verify applicability or measurements. No clinical numeric constant is supplied by this evaluator and no millimetre target is converted or applied.',
      'Sampled tissue gaps are not contact area, pressure, signed penetration or true minimum clearance; declared closure is generator metadata, not an independent topology audit.'] };
}
