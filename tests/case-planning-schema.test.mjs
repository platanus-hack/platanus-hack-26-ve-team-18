import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAssistantSnapshot } from '../src/assistant-context.ts';
import { emptyToothCase } from '../src/tooth-session.ts';
import { ANTHROPIC_MODELS } from '../src/anthropic-models.ts';
import {
  CasePlanningError, MAX_PLANNING_IMAGE_BASE64_LENGTH, casePlanningRequestSchema,
  casePlanningOutputSchema, isPlanningBase64, validateCasePlanning,
} from '../src/case-planning-schema.ts';

const jpeg = Buffer.from([255, 216, 255, 224, 0, 16, 255, 217]).toString('base64');
const part = (id, role) => ({
  id, role, name: 'PRIVATE_NAME', fileName: 'PRIVATE_FILE.ply', positions: new Float32Array(9), normals: new Float32Array(9),
  closed: false, visible: true, offset: [0, 0, 0], triangles: 200, vertices: 600, dimensions: [10, 20, 30],
});
const candidate = id => ({ id, triangles: 80, area: 40, height: 5, warnings: [] });
function request() {
  return {
    revision: 'pose-7:annotations-2',
    snapshot: buildAssistantSnapshot({ parts: [part('private-upper', 'upper'), part('private-lower', 'lower')], selected: null, probe: null, report: null, tolerance: 0.5, analysisState: 'unavailable', teeth: emptyToothCase().teeth, counts: {}, fitSummary: [], fitRadius: null }),
    sources: [
      { id: 'scan-1', arch: 'upper', triangles: 200, texture: 'vertex-colors', patientRight: null, candidates: [candidate(1), candidate(2)] },
      { id: 'scan-2', arch: 'lower', triangles: 200, texture: 'unmapped', patientRight: 'image-left', candidates: [candidate(1)] },
    ],
    views: [
      { id: 'view-1', sourceId: null, context: 'occlusion', label: '+X', mediaType: 'image/jpeg', base64: jpeg },
      { id: 'view-2', sourceId: 'scan-1', context: 'arch', label: 'occlusal', mediaType: 'image/jpeg', base64: jpeg },
      { id: 'view-3', sourceId: 'scan-2', context: 'arch', label: 'occlusal', mediaType: 'image/jpeg', base64: jpeg },
    ],
  };
}
const mapping = (sourceId, candidateId, fdi) => ({ sourceId, candidateId, fdi, needsReview: false, reason: 'Anatomical hypothesis.' });
const output = () => ({
  summary: 'Review the visible surfaces and unresolved tooth identity.',
  mappings: [mapping('scan-1', 1, 11), mapping('scan-2', 1, 36)],
  findings: [{ id: 'finding-1', fdi: 11, category: 'surface-observation', title: 'Visible color variation', detail: 'Color alone does not establish disease.', evidence: ['view-2', 'scan-1:C1'], needsClinicalReview: false }],
  actions: [{ id: 'action-1', fdi: 11, kind: 'hygiene-review', title: 'Assess surface appearance', rationale: 'Review whether cleaning assessment is indicated.', evidence: ['view-2'], prerequisites: ['Clinical examination and hygiene assessment.'] }],
  designs: [{ fdi: 36, anatomy: 'molar', rationale: 'An editable exterior alternative for review, conditional on the recorded site and clinical assessment.' }],
  limitations: ['Texture appearance is not a diagnosis.'],
});

test('related planning fields cannot split numerical fixture prescriptions', () => {
  const value = output();
  value.actions[0] = { ...value.actions[0], title: 'Implant review at FDI 11', rationale: 'Use a diameter of 4 mm and length of 10 mm.' };
  assert.throws(() => validateCasePlanning(value, request()), /Numerical/);
  for (const summary of ['Use a 4mm implant.', 'Use implants 4 mm in diameter and 10 mm long.']) {
    assert.throws(() => validateCasePlanning({ ...output(), summary }, request()), /Numerical/);
  }
  value.actions[0].title = 'Review replacement options'; value.actions[0].kind = 'implant-review';
  assert.throws(() => validateCasePlanning(value, request()), /Numerical/);
  value.actions[0] = { ...value.actions[0], kind: 'clinical-review', title: 'Clinical review at FDI 11', rationale: 'Fixture depth remains unknown.', prerequisites: ['Obtain 3D imaging and a clinical examination before deciding whether treatment is indicated.'] };
  assert.equal(validateCasePlanning(value, request()).actions.length, 1);
});

test('direct observations cannot cite only a different mapped tooth; adjacent gap evidence remains usable', () => {
  const wrong = output();
  wrong.findings[0].fdi = 26; wrong.findings[0].evidence = ['scan-1:C1'];
  assert.throws(() => validateCasePlanning(wrong, request()), /Tooth-specific/);
  const wrongAction = output();
  wrongAction.actions[0].fdi = 26; wrongAction.actions[0].evidence = ['scan-1:C1'];
  assert.throws(() => validateCasePlanning(wrongAction, request()), /Tooth-specific/);
  const gap = output();
  gap.findings[0] = { ...gap.findings[0], fdi: 12, category: 'possible-missing', evidence: ['view-2', 'scan-1:C1'] };
  const gapRequest = request(); gapRequest.sources[0].patientRight = 'image-left';
  assert.equal(validateCasePlanning(gap, gapRequest).findings[0].fdi, 12);
  const occlusion = output();
  occlusion.findings[0] = { ...occlusion.findings[0], category: 'occlusion-review', evidence: ['scan-1:C1', 'scan-2:C1'] };
  assert.equal(validateCasePlanning(occlusion, request()).findings[0].evidence.length, 2);
});

test('named missing-position hypotheses require confirmed laterality on the corresponding arch', () => {
  const value = output();
  value.findings[0] = { ...value.findings[0], fdi: 12, category: 'possible-missing', evidence: ['view-2', 'scan-1:C1'] };
  // The lower source already has a confirmed side; it cannot establish upper laterality.
  assert.throws(() => validateCasePlanning(value, request()), {
    name: 'CasePlanningError', message: /named missing-position hypothesis requires confirmed patient laterality/,
  });
});

test('partial gap hypotheses can keep FDI unknown without confirmed patient laterality', () => {
  const req = request(); req.sources[1].patientRight = null;
  const value = output();
  value.findings[0] = { ...value.findings[0], fdi: null, category: 'possible-missing', title: 'Possible partial gap', detail: 'Review visible space, scan coverage and unresolved position.', evidence: ['view-2', 'scan-1:C1'] };
  const result = validateCasePlanning(value, req);
  assert.equal(result.findings[0].fdi, null);
  assert.equal(result.findings[0].category, 'possible-missing');
  assert.equal(result.findings[0].needsClinicalReview, true);
  assert.deepEqual(result.findings[0].evidence, ['view-2', 'scan-1:C1']);
});
const rejects = (mutate, req = request()) => {
  const value = output(); mutate(value);
  assert.throws(() => validateCasePlanning(value, req), CasePlanningError);
};

test('planning accepts anonymized bounded data, keeps unknown side and unmapped texture explicit', () => {
  const parsed = casePlanningRequestSchema.parse(request());
  assert.equal(parsed.sources[0].patientRight, null);
  assert.equal(parsed.sources[1].texture, 'unmapped');
  assert.equal(parsed.snapshot.teeth.every(tooth => tooth.status === 'unreviewed'), true);
  assert.doesNotMatch(JSON.stringify(parsed), /PRIVATE_NAME|PRIVATE_FILE|private-upper/);
});

test('planning model selection is optional and accepts only the shared three model IDs', () => {
  assert.equal(casePlanningRequestSchema.parse(request()).model, undefined);
  for (const { id } of ANTHROPIC_MODELS) {
    assert.equal(casePlanningRequestSchema.parse({ ...request(), model: id }).model, id);
  }
  for (const model of ['', ' claude-haiku-5-5', 'claude-sonnet-5-5 ', 'CLAUDE-OPUS-5-5',
    'claude-haiku-4-5', 'custom-server-model', null, 42, {}, ['claude-haiku-5-5']]) {
    assert.equal(casePlanningRequestSchema.safeParse({ ...request(), model }).success, false);
  }
});

test('planning rejects names, files, geometry, notes and arbitrary source identities', () => {
  for (const mutate of [
    value => { value.patientName = 'PRIVATE'; },
    value => { value.sources[0].fileName = 'PRIVATE.ply'; },
    value => { value.sources[0].positions = [1, 2, 3]; },
    value => { value.views[0].notes = 'PRIVATE'; },
    value => { value.snapshot.notesIncluded = true; value.snapshot.teeth[0].note = 'PRIVATE'; },
    value => { value.snapshot.teeth[0].note = ''; },
    value => { value.sources[0].id = 'PATIENT.ply'; },
    value => { value.sources[0].arch = 'lower'; },
    value => { value.sources[0].triangles++; },
  ]) {
    const value = request(); mutate(value);
    assert.equal(casePlanningRequestSchema.safeParse(value).success, false);
  }
});

test('view/source IDs and source/candidate pairs are unique, bounded and internally referenced', () => {
  for (const mutate of [
    value => { value.views[1].id = 'view-1'; },
    value => { value.views[1].sourceId = 'scan-3'; },
    value => { value.views[1].sourceId = null; },
    value => { value.sources.push(value.sources[0]); },
    value => { value.sources[0].candidates.push(value.sources[0].candidates[0]); },
    value => { value.views = []; },
    value => { value.views = Array.from({ length: 9 }, (_, i) => ({ ...value.views[0], id: `view-${i + 1}` })); },
    value => { value.views[0].mediaType = 'image/png'; },
  ]) {
    const value = request(); mutate(value);
    assert.equal(casePlanningRequestSchema.safeParse(value).success, false);
  }
  const largeUnits = request(); largeUnits.sources[0].candidates[0].area = 1e24;
  largeUnits.sources[0].candidates[0].height = 1e12; largeUnits.sources[0].candidates[0].id = 1_000_000;
  assert.equal(casePlanningRequestSchema.safeParse(largeUnits).success, true);
});

test('base64 uses canonical padding and rejects oversized adversarial strings in linear time', () => {
  assert.equal(isPlanningBase64(jpeg), true);
  for (const value of ['', 'a===', 'ab==', 'abd=', 'YWJj=', 'AAAA\n', 'a'.repeat(MAX_PLANNING_IMAGE_BASE64_LENGTH) + '!', 'AAAA=AAA']) assert.equal(isPlanningBase64(value), false, value.slice(0, 30));
  assert.equal(isPlanningBase64('YQ=='), true);
  assert.equal(isPlanningBase64('YWI='), true);
});

test('result keeps submitted revision, fills omitted pairs as unknown and forces clinical review', () => {
  const req = request(), result = validateCasePlanning(output(), req);
  assert.equal(result.revision, req.revision);
  assert.equal(result.mappings.length, 3);
  assert.deepEqual(result.mappings.find(item => item.sourceId === 'scan-1' && item.candidateId === 2), { sourceId: 'scan-1', candidateId: 2, fdi: null, needsReview: true, reason: 'No mapping returned; identity is unknown.' });
  assert.equal(result.mappings[0].needsReview, true);
  assert.equal(result.findings[0].needsClinicalReview, true);
  assert.equal(result.actions[0].kind, 'hygiene-review');
  assert.match(result.limitations.join(' '), /unscanned|Unscanned/);
  const changed = { ...req, revision: 'pose-8:annotations-2' };
  assert.notEqual(validateCasePlanning(output(), changed).revision, result.revision);
  rejects(value => { value.revision = 'stale-model-revision'; });
  rejects(value => { value.model = 'model-chosen-by-case'; });
  assert.equal(casePlanningOutputSchema.safeParse({ ...output(), revision: req.revision }).success, false);
});

test('rejects unknown/repeated candidate pairs, wrong-arch/invalid FDI, and globally reused FDI', () => {
  rejects(value => { value.mappings[0].candidateId = 99; });
  rejects(value => { value.mappings[0].sourceId = 'scan-99'; });
  rejects(value => { value.mappings.push(value.mappings[0]); });
  rejects(value => { value.mappings[0].fdi = 36; });
  rejects(value => { value.mappings[0].fdi = 19; });
  rejects(value => { value.mappings.push(mapping('scan-1', 2, 11)); });
  rejects(value => { value.findings[0].fdi = 99; });
  rejects(value => { value.actions[0].fdi = 99; });
});

test('rejects fabricated views, source-only references, wrong-arch references and unavailable collisions', () => {
  for (const ref of ['view-8', 'scan-1:C99', 'scan-1', 'tooth-chart', 'collision-report', 'https://example.com']) rejects(value => { value.findings[0].evidence = [ref]; });
  rejects(value => { value.actions[0].evidence = ['scan-2:C1']; });
  rejects(value => { value.actions[0].evidence = []; });
  const req = request(); req.snapshot.analysisState = 'ready';
  req.snapshot.collision = { scope: 'complete visible non-reference scans', comparedPartIds: ['scan-1', 'scan-2'], durationMs: 4, pairs: [{ a: 'scan-1', b: 'scan-2', intersectingTriangles: 0, penetratingVertices: 0, nearbyVertices: 10, minDistance: 0.4, maxDepth: 0 }] };
  casePlanningRequestSchema.parse(req);
  const value = output(); value.findings[0].category = 'occlusion-review'; value.findings[0].evidence = ['collision-report'];
  assert.throws(() => validateCasePlanning(value, req), /aggregate collision report/);
  value.findings[0].fdi = null;
  assert.equal(validateCasePlanning(value, req).findings[0].evidence[0], 'collision-report');
  const unrelated = output(); unrelated.findings[0].fdi = 26; unrelated.findings[0].evidence = ['scan-1:C1', 'collision-report'];
  assert.throws(() => validateCasePlanning(unrelated, req), /Tooth-specific/);
  req.snapshot.collision.pairs = [];
  assert.throws(() => validateCasePlanning(value, req), CasePlanningError);
});

test('missing, not-scanned and unlabeled remain separate without automatic treatment need', () => {
  const req = request(); req.sources[0].patientRight = 'image-left';
  req.snapshot.teeth.find(tooth => tooth.fdi === 12).status = 'not-scanned';
  rejects(value => { value.findings[0].category = 'possible-missing'; value.findings[0].fdi = 12; }, req);
  rejects(value => { value.findings[0].category = 'possible-missing'; value.findings[0].fdi = 11; }, req);
  const value = output(); value.mappings = []; value.findings = []; value.actions = []; value.designs = [];
  const result = validateCasePlanning(value, req);
  assert.equal(result.mappings.every(item => item.fdi === null && item.needsReview), true);
  assert.deepEqual(result.actions, []);
  assert.deepEqual(result.designs, []);
});

test('designs require valid matching anatomy and reject hidden numeric surgical prescriptions', () => {
  rejects(value => { value.designs[0].fdi = 99; });
  rejects(value => { value.designs[0].anatomy = 'premolar'; });
  rejects(value => { value.designs.push(value.designs[0]); });
  rejects(value => { value.designs[0].fixtureDepth = 5; });
  rejects(value => { value.actions[0].rationale = 'Place a 4 mm implant at FDI 11.'; });
  rejects(value => { value.designs[0].rationale = 'Use fixture depth 5.'; });
  rejects(value => { value.limitations = ['x'.repeat(900) + ' Drill bone to 8 mm.']; });
  const value = output(); value.designs[0].rationale = 'FDI 36 implant-review concept; fixture depth remains unassessed.';
  assert.equal(validateCasePlanning(value, request()).designs.length, 1);
});

test('generic views cannot bypass conflicting tooth regions; unseen sources remain review-needed', () => {
  rejects(value => { value.findings[0].fdi = 18; value.findings[0].evidence = ['view-2', 'scan-1:C1']; });
  const req = request(); req.views = req.views.filter(view => view.sourceId !== 'scan-2');
  const value = output(); value.designs = [];
  const result = validateCasePlanning(value, req);
  assert.equal(result.mappings.find(mapping => mapping.sourceId === 'scan-2').needsReview, true);
});

test('missing proposals require a visible arch gap and must not contradict charted or assigned teeth', () => {
  for (const conflict of ['present', 'not-scanned', 'assigned']) {
    const req = request(); req.sources[0].patientRight = 'image-left';
    const tooth = req.snapshot.teeth.find(tooth => tooth.fdi === 12);
    if (conflict === 'assigned') tooth.assignedTriangles = 2; else tooth.status = conflict;
    const value = output(); value.findings[0] = { ...value.findings[0], category: 'possible-missing', fdi: 12 };
    assert.throws(() => validateCasePlanning(value, req), /Missing-tooth hypothesis contradicts case evidence/);
  }
  const req = request(); req.sources[0].patientRight = 'image-left';
  const value = output(); value.findings[0] = { ...value.findings[0], category: 'possible-missing', fdi: 12, evidence: ['scan-1:C1'] };
  assert.throws(() => validateCasePlanning(value, req), /missing-position proposal needs a visible image of the corresponding arch/);
});

test('site-specific implant review and exterior designs require supported sites', () => {
  rejects(value => { value.actions[0] = { ...value.actions[0], kind: 'implant-review', fdi: 18, evidence: ['view-2'] }; });
  rejects(value => { value.designs = [{ fdi: 18, anatomy: 'molar', rationale: 'Arbitrary unsupported site.' }]; });
  const req = request(); req.snapshot.teeth.find(tooth => tooth.fdi === 18).status = 'not-scanned';
  rejects(value => { value.designs = [{ fdi: 18, anatomy: 'molar', rationale: 'Unscanned site.' }]; }, req);
  const value = output();
  value.findings.push({ id: 'gap-12', category: 'possible-missing', fdi: 12, title: 'Possible gap', detail: 'Review visible space and scan coverage.', evidence: ['view-2', 'scan-1:C1'], needsClinicalReview: true });
  value.actions.push({ id: 'review-12', fdi: 12, kind: 'implant-review', title: 'Review replacement alternatives', rationale: 'A visible gap remains unconfirmed.', evidence: ['view-2'], prerequisites: ['Confirm absence, indication and clinical evidence before considering implantation.'] });
  value.designs.push({ fdi: 12, anatomy: 'incisor', rationale: 'Generic editable concept for a proposed visible gap.' });
  const confirmedSide = request(); confirmedSide.sources[0].patientRight = 'image-right';
  const result = validateCasePlanning(value, confirmedSide);
  assert.equal(result.findings.find(finding => finding.id === 'gap-12').fdi, 12);
  assert.equal(result.actions.find(action => action.id === 'review-12').fdi, 12);
  assert.deepEqual(result.designs.map(design => design.fdi), [36, 12]);
});

test('unrelated or same-arch reports cannot support opposing-arch collision findings', () => {
  for (const b of ['scan-1', 'scan-3']) {
    const req = request(); req.snapshot.analysisState = 'ready';
    req.snapshot.collision = { scope: 'complete visible non-reference scans', comparedPartIds: ['scan-1', b], durationMs: 1, pairs: [{ a: 'scan-1', b, minDistance: 0.1 }] };
    rejects(value => { value.findings[0] = { ...value.findings[0], fdi: null, category: 'occlusion-review', evidence: ['collision-report'] }; }, req);
  }
});

test('surface evidence cannot certify bone-safe placement or validated clinical fit', () => {
  for (const summary of ['Bone-safe placement confirmed.', 'A safe implant trajectory is available.', 'Clinical fit is validated.', 'Surgical clearance has been verified.']) {
    assert.throws(() => validateCasePlanning({ ...output(), summary }, request()), /not established/);
  }
  assert.doesNotThrow(() => validateCasePlanning({ ...output(), summary: 'Bone-safe placement is unassessed; clinical fit is not validated.' }, request()));
});
