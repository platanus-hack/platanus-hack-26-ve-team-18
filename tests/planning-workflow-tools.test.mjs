import test from 'node:test';
import assert from 'node:assert/strict';
import { asSchema } from 'ai';
import { createPlanningWorkflowTools, boundedPlanningTools } from '../server/planning-workflow-tools.ts';
import { WORKFLOW_BUDGET } from '../src/case-workflow.ts';

const design = (anatomy = 'molar') => ({ anatomy, anatomySource: 'procedural-template', parameters: {
  fixture: { radius: 1.73, length: 7.4, depth: .4, taper: .18 },
  abutment: { radius: 1.5, height: 1.2, emergenceRadius: 2.1, angleX: 3, angleY: -4 },
  crown: { width: 8.1, depth: 7.2, height: 4.3, cuspHeight: .17, rotation: 13 },
}, contour: { cervicalScale: .92, occlusalScale: 1.12 } });
const request = () => ({ revision: 'source-current', snapshot: { teeth: [{ fdi: 16, status: 'unreviewed', assignedTriangles: 0 }] },
  sources: [{ id: 'scan-1', arch: 'upper', patientRight: 'image-left', roleConfirmed: true, candidates: [{ id: 7, triangles: 500, area: 30, height: 6, warnings: [] }] }],
  preparation: { sources: [], sites: [{ id: 'site-1', sourceId: 'scan-1', fdi: 16, status: 'proposed-missing', localized: true, confidence: .9,
    kind: 'bounded', slotCount: 1, geometricDraftEligible: true,
    space: { unit: 'file units (u)', mesiodistal: 9, buccolingual: 8, crownHeight: 6, sampledVertical: 9, verticalMethod: 'Provisional opposing samples.' },
    supporting: ['Scanned ridge between crown boundaries'], conflicting: [], questions: [] }] } });
const command = (siteId = 'site-1', anatomy = 'molar') => ({ siteId, rationale: 'Evaluate a reversible spatial hypothesis from bounded local evidence.', design: design(anatomy) });
const neutralRequest = () => {
  const input = request(); input.sources[0].patientRight = null;
  Object.assign(input.preparation.sites[0], { fdi: null, confidence: 0, status: 'identity-unresolved' });
  return input;
};
const execute = (tools, name, input) => tools[name].execute(input, { toolCallId: 'test-call', messages: [] });

test('complete AI designs queue directly with exact values, without prior tools or optimization', async () => {
  const { tools, draftRequests } = createPlanningWorkflowTools(request());
  const input = command(), result = await execute(tools, 'requestDraftComponents', input);
  assert.equal(result.queued, true); assert.equal(result.operation, 'local-construct-measure');
  assert.equal(result.optimization, false); assert.equal(result.artifactStatus, 'pending-worker');
  assert.equal(result.units, 'file units (u)'); assert.equal(result.provenance, 'hypothesized');
  assert.equal(result.budget.candidates, 1); assert.equal(result.clinicalState, 'draft hypothesis; unaccepted');
  assert.equal(result.measurementReview.status, 'pending-worker');
  assert.ok(result.measurementReview.required.includes('component-support.pilar-enclosure'));
  assert.match(result.measurementReview.next, /actual worker artifacts and measurements/);
  assert.equal(result.idempotent, false);
  assert.deepEqual(draftRequests, [{ siteId: input.siteId, fdi: 16, anatomy: input.design.anatomy, rationale: input.rationale, design: input.design }]);
  assert.deepEqual(result.design, input.design);
  input.design.parameters.crown.width = 500;
  assert.equal(draftRequests[0].design.parameters.crown.width, 8.1);
});

test('live schema and direct execution require every strict finite bounded design field', async () => {
  const { tools, draftRequests } = createPlanningWorkflowTools(request());
  const schema = asSchema(tools.requestDraftComponents.inputSchema).jsonSchema;
  assert.ok(schema.required.includes('design')); assert.equal(schema.additionalProperties, false);
  const mutations = [
    input => { delete input.design; }, input => { input.design = {}; },
    input => { delete input.design.parameters.fixture.depth; }, input => { delete input.design.parameters.abutment.angleY; },
    input => { delete input.design.parameters.crown.cuspHeight; }, input => { delete input.design.anatomySource; },
    input => { delete input.design.contour; }, input => { delete input.design.contour.occlusalScale; },
    input => { input.design.anatomy = 'posterior'; }, input => { input.design.anatomySource = 'automatic'; },
    input => { input.design.parameters.fixture.radius = 0; }, input => { input.design.parameters.fixture.length = -1; },
    input => { input.design.parameters.fixture.depth = -1; }, input => { input.design.parameters.fixture.taper = .96; },
    input => { input.design.parameters.abutment.height = 0; }, input => { input.design.parameters.abutment.angleX = 81; },
    input => { input.design.parameters.abutment.angleY = -81; }, input => { input.design.parameters.crown.rotation = 361; },
    input => { input.design.parameters.crown.cuspHeight = -1; }, input => { input.design.parameters.crown.width = '8'; },
    input => { input.design.parameters.crown.depth = NaN; }, input => { input.design.parameters.crown.height = Infinity; },
    input => { input.design.contour.cervicalScale = .49; }, input => { input.design.contour.occlusalScale = 1.51; },
    input => { input.design.positions = [1, 2, 3]; }, input => { input.design.parameters.fixture.vertices = []; },
    input => { input.design.componentDesign = 'nested-support/v1'; },
    input => { input.file = '/patient-mesh.ply'; },
  ];
  for (const mutate of mutations) {
    const input = command(); mutate(input);
    assert.equal(tools.requestDraftComponents.inputSchema.safeParse(input).success, false, mutate.toString());
    await assert.rejects(async () => execute(tools, 'requestDraftComponents', input));
  }
  assert.equal(draftRequests.length, 0);
});

test('placement guidance preserves measured space and does not invent future support/contact evidence', async () => {
  const input = request(), space = input.preparation.sites[0].space;
  space.sampledVertical = null;
  const before = structuredClone(input), { tools } = createPlanningWorkflowTools(input);
  const result = await execute(tools, 'inspectPlacementRules', { siteId: 'site-1' });
  assert.deepEqual(result.surfaceObjectives.space, space);
  assert.equal(result.surfaceObjectives.componentDesign, 'nested-support/v1');
  assert.match(result.surfaceObjectives.componentDatums.crownSeating, /abutment.height/);
  assert.match(result.surfaceObjectives.componentDatums.retentionSupport, /top is not the crown seating plane/);
  assert.deepEqual(result.surfaceObjectives.constructionEvidence, {
    status: 'not-constructed', contacts: null, externalCrossings: null, pilarEnclosure: null,
    reason: 'Available MD/BL, neighboring crown height and sampled vertical space are preparation evidence. Actual contact bands, crossings, emitted support and gum exposure require worker geometry and a fresh restoration review.',
  });
  assert.match(result.surfaceObjectives.constraints.join(' '), /component-support.pilar-enclosure/);
  assert.match(result.surfaceObjectives.constraints.join(' '), /Preserve the target contract and remeasure all targets/);
  assert.deepEqual(input, before);
});

test('same-site identical designs are idempotent and conflicting duplicates retain the first design explicitly', async () => {
  const { tools, draftRequests } = createPlanningWorkflowTools(request());
  assert.equal((await execute(tools, 'requestDraftComponents', command())).queued, true);
  const same = command(); same.rationale = 'A restated explanation for the identical design.';
  same.design.parameters.crown = Object.fromEntries(Object.entries(same.design.parameters.crown).reverse());
  const duplicate = await execute(tools, 'requestDraftComponents', same);
  assert.equal(duplicate.queued, true); assert.equal(duplicate.idempotent, true);
  for (const change of [d => { d.parameters.fixture.radius += .1; }, d => { d.anatomySource = 'patient-donor'; }, d => { d.contour.cervicalScale = 1; }]) {
    const conflicting = command(); change(conflicting.design);
    const result = await execute(tools, 'requestDraftComponents', conflicting);
    assert.equal(result.queued, false); assert.equal(result.code, 'conflicting-duplicate');
    assert.match(result.reason, /conflicting duplicate was rejected/i);
  }
  assert.equal(draftRequests.length, 1); assert.deepEqual(draftRequests[0].design, design());
});

test('source FDI constrains anatomy, including known FDI with unknown patient side', async () => {
  for (const patientRight of ['image-left', null]) {
    const input = request(); input.sources[0].patientRight = patientRight;
    const { tools, draftRequests } = createPlanningWorkflowTools(input);
    const result = await execute(tools, 'requestDraftComponents', command('site-1', 'incisor'));
    assert.equal(result.queued, false); assert.equal(result.code, 'anatomy-mismatch'); assert.equal(draftRequests.length, 0);
  }
});

test('morphology tools expose allowed classes, numerical space and donor evidence without deciding for the model', async () => {
  const input = request();
  const relationships = { adjacent: { mesial: null, distal: null }, contralateral: { sourceId: 'scan-1', candidateId: 7, fdi: 26, confidence: .9 }, opposing: null };
  input.preparation.sites[0].relationships = relationships;
  const { tools, draftRequests } = createPlanningWorkflowTools(input);
  const evidence = await execute(tools, 'chooseAnatomicalCandidate', { siteId: 'site-1' });
  assert.equal(evidence.anatomy, 'molar'); assert.deepEqual(evidence.allowedAnatomies, ['molar']);
  assert.equal(evidence.donorChoice, 'model-required');
  assert.deepEqual(evidence.anatomySourceChoices, ['procedural-template', 'patient-donor']);
  assert.deepEqual(evidence.morphologyEvidence.relationships, relationships);
  assert.deepEqual(evidence.morphologyEvidence.space, input.preparation.sites[0].space);
  assert.deepEqual(evidence.morphologyEvidence.contralateralCandidate.candidate, input.sources[0].candidates[0]);
  assert.equal(evidence.morphologyEvidence.identity.patientSideConfirmed, true); assert.equal(draftRequests.length, 0);
  const unresolved = await execute(createPlanningWorkflowTools(neutralRequest()).tools, 'chooseAnatomicalCandidate', { siteId: 'site-1' });
  assert.equal(unresolved.anatomy, null);
  assert.deepEqual(unresolved.allowedAnatomies, ['incisor', 'canine', 'premolar', 'molar']);
  assert.equal(unresolved.morphologyEvidence.identity.patientSideConfirmed, false);
});

test('null FDI uses explicit anatomy only for an arch-matched template and leaves chart/identity unchanged', async () => {
  for (const [arch, templates] of [['upper', [11, 13, 14, 16]], ['lower', [31, 33, 34, 36]]]) {
    for (const [index, anatomy] of ['incisor', 'canine', 'premolar', 'molar'].entries()) {
      const input = neutralRequest(); input.sources[0].arch = arch;
      input.snapshot.teeth = [{ fdi: templates[index], status: 'present', assignedTriangles: 50 }];
      const before = structuredClone(input), { tools, draftRequests } = createPlanningWorkflowTools(input);
      const result = await execute(tools, 'requestDraftComponents', command('site-1', anatomy));
      assert.equal(result.queued, true, `${arch} ${anatomy}`); assert.equal(result.siteFdi, null);
      assert.equal(result.templateFdi, templates[index]); assert.equal(draftRequests[0].fdi, templates[index]);
      assert.equal(draftRequests[0].anatomy, anatomy); assert.deepEqual(input, before);
    }
  }
});

test('unknown-side known FDI preserves source evidence rather than replacing it with a canonical template identity', async () => {
  const input = neutralRequest(); Object.assign(input.preparation.sites[0], { fdi: 26, confidence: .9 }); input.snapshot.teeth[0].fdi = 26;
  const { tools, draftRequests } = createPlanningWorkflowTools(input);
  const evidence = await execute(tools, 'evaluateMissingSite', { siteId: 'site-1' });
  assert.equal(evidence.site.fdi, 26); assert.equal(evidence.neutralIdentity, true);
  assert.equal((await execute(tools, 'requestDraftComponents', command())).queued, true);
  assert.equal(draftRequests[0].fdi, 26); assert.equal(input.sources[0].patientRight, null);
});

test('a filename role permits only a locally eligible neutral visual concept, without confirming anatomy', async () => {
  const input = neutralRequest(); input.sources[0].roleConfirmed = false;
  const before = structuredClone(input), { tools, draftRequests } = createPlanningWorkflowTools(input);
  assert.equal((await execute(tools, 'requestDraftComponents', command())).queued, true);
  assert.equal(draftRequests.length, 1); assert.deepEqual(input, before);
  const named = request(); named.sources[0].roleConfirmed = false;
  assert.equal((await execute(createPlanningWorkflowTools(named).tools, 'requestDraftComponents', command())).queued, false);
});

test('neutral sites require explicit local eligibility plus every bounded numerical guard', async () => {
  const mutations = [
    r => { delete r.preparation.sites[0].geometricDraftEligible; }, r => { r.preparation.sites[0].geometricDraftEligible = false; },
    ...['terminal', 'chart', undefined].map(kind => r => { r.preparation.sites[0].kind = kind; }),
    ...['not-scanned', 'segmentation-unresolved', 'dentist-confirmed-missing'].map(status => r => { r.preparation.sites[0].status = status; }),
    r => { r.preparation.sites[0].localized = false; }, r => { delete r.preparation.sites[0].space; },
    r => { r.preparation.sites[0].slotCount = 0; }, r => { delete r.preparation.sites[0].slotCount; },
    ...['mesiodistal', 'buccolingual', 'crownHeight'].flatMap(field => [0, -1, null, undefined, NaN, Infinity].map(value => r => { r.preparation.sites[0].space[field] = value; })),
    r => { r.preparation.sites[0].sourceId = 'unknown'; },
  ];
  for (const mutate of mutations) {
    const input = neutralRequest(); mutate(input); const { tools, draftRequests } = createPlanningWorkflowTools(input);
    assert.equal((await execute(tools, 'requestDraftComponents', command())).queued, false, mutate.toString()); assert.equal(draftRequests.length, 0);
  }
  const input = neutralRequest(); input.sources[0].patientRight = 'image-left';
  assert.equal((await execute(createPlanningWorkflowTools(input).tools, 'requestDraftComponents', command())).queued, true);
});

test('a separately eligible distal-extension slot can queue only a neutral single-site illustration', async () => {
  const input = neutralRequest(), site = input.preparation.sites[0];
  site.kind = 'distal-extension';
  site.relationships = { adjacent: { mesial: { sourceId: 'scan-1', candidateId: 7, fdi: null, confidence: 0 }, distal: null } };
  const before = structuredClone(input), { tools, draftRequests } = createPlanningWorkflowTools(input);
  assert.equal((await execute(tools, 'requestDraftComponents', command())).queued, true);
  assert.equal(draftRequests.length, 1); assert.deepEqual(input, before);
  const filenameRole = structuredClone(input); filenameRole.sources[0].roleConfirmed = false;
  filenameRole.preparation.sites[0].space.sampledVertical = null;
  filenameRole.preparation.sites[0].relationships.opposing = null;
  assert.equal((await execute(createPlanningWorkflowTools(filenameRole).tools, 'requestDraftComponents', command())).queued, true);
  for (const mutate of [
    r => { r.preparation.sites[0].geometricDraftEligible = false; },
    r => { r.preparation.sites[0].kind = 'terminal'; },
    r => { r.preparation.sites[0].fdi = 16; },
    r => { r.preparation.sites[0].status = 'proposed-missing'; },
    r => { r.preparation.sites[0].slotCount = 2; },
    r => { r.preparation.sites[0].relationships.adjacent.mesial = null; },
    r => { r.preparation.sites[0].relationships.adjacent.distal = r.preparation.sites[0].relationships.adjacent.mesial; },
  ]) {
    const bad = structuredClone(input); mutate(bad);
    assert.equal((await execute(createPlanningWorkflowTools(bad).tools, 'requestDraftComponents', command())).queued, false, mutate.toString());
  }
});

test('known chart conflicts block named and unknown-side sites; established identities retain confidence guards', async () => {
  for (const patientRight of ['image-left', null]) for (const change of [r => { r.snapshot.teeth[0].assignedTriangles = 5; }, r => { r.snapshot.teeth[0].status = 'present'; }, r => { r.snapshot.teeth[0].status = 'not-scanned'; }]) {
    const input = request(); input.sources[0].patientRight = patientRight; change(input); const { tools, draftRequests } = createPlanningWorkflowTools(input);
    assert.equal((await execute(tools, 'requestDraftComponents', command())).queued, false); assert.equal(draftRequests.length, 0);
  }
  for (const change of [r => { r.preparation.sites[0].confidence = .79; }, r => { r.preparation.threshold = .95; }, r => { r.sources[0].roleConfirmed = false; }, r => { r.preparation.sites[0].status = 'not-scanned'; }, r => { r.preparation.sites[0].status = 'segmentation-unresolved'; }, r => { r.preparation.sites[0].fdi = 36; }]) {
    const input = request(); change(input); const { tools } = createPlanningWorkflowTools(input);
    assert.equal((await execute(tools, 'requestDraftComponents', command())).queued, false);
    assert.equal((await execute(tools, 'inspectPreparedCase', {})).revision, input.revision);
  }
  const input = request(); input.preparation.sites[0].confidence = .8;
  assert.equal((await execute(createPlanningWorkflowTools(input).tools, 'requestDraftComponents', command())).queued, true);
  input.sources[0].patientRight = null; input.preparation.sites[0].confidence = .79;
  assert.equal((await execute(createPlanningWorkflowTools(input).tools, 'requestDraftComponents', command())).queued, false);
});

test('legacy named sites remain eligible without additive neutral evidence fields', async () => {
  const input = request(); for (const field of ['kind', 'slotCount', 'geometricDraftEligible', 'space']) delete input.preparation.sites[0][field];
  assert.equal((await execute(createPlanningWorkflowTools(input).tools, 'requestDraftComponents', command())).queued, true);
  input.sources[0].patientRight = null;
  assert.equal((await execute(createPlanningWorkflowTools(input).tools, 'requestDraftComponents', command())).queued, false);
});

test('unavailable sites and clinical prescriptions cannot queue illustrative designs', async () => {
  const { tools, draftRequests } = createPlanningWorkflowTools(request());
  assert.equal((await execute(tools, 'requestDraftComponents', command('invented'))).queued, false);
  const input = command(); input.rationale = 'Place a 4 mm implant.';
  await assert.rejects(async () => execute(tools, 'requestDraftComponents', input), /prescriptions are unsupported/); assert.equal(draftRequests.length, 0);
});

test('parallel structured tools share one request-wide call budget', async () => {
  const { tools } = createPlanningWorkflowTools(request()); const bounded = boundedPlanningTools(tools);
  const results = await Promise.all(Array.from({ length: WORKFLOW_BUDGET.toolCalls + 4 }, () => execute(bounded, 'inspectPreparedCase', {})));
  assert.equal(results.filter(result => result.status === 'budget-reached').length, 4);
});

test('site budget preserves queued designs and permits an identical retry at capacity', async () => {
  const input = request(), site = input.preparation.sites[0];
  input.preparation.sites = Array.from({ length: 17 }, (_, index) => ({ ...site, id: `site-${index + 1}` }));
  const { tools, draftRequests } = createPlanningWorkflowTools(input);
  for (let i = 1; i <= 16; i++) assert.equal((await execute(tools, 'requestDraftComponents', command(`site-${i}`))).queued, true);
  assert.equal((await execute(tools, 'requestDraftComponents', command('site-17'))).queued, false);
  assert.equal((await execute(tools, 'requestDraftComponents', command())).idempotent, true); assert.equal(draftRequests.length, 16);
});

test('both arches remain in review inventory and terminal regions cannot queue unconfirmed implants', async () => {
  const input = request(); input.sources.push({ id: 'scan-2', arch: 'lower', patientRight: null, roleConfirmed: true });
  input.preparation.sites.push({ ...input.preparation.sites[0], id: 'site-2', sourceId: 'scan-2', kind: 'terminal', fdi: null, status: 'identity-unresolved' });
  const { tools, draftRequests } = createPlanningWorkflowTools(input), inventory = await execute(tools, 'inspectPreparedCase', {});
  assert.deepEqual(inventory.archReviews.map(row => row.arch), ['upper', 'lower']); assert.deepEqual(inventory.archReviews[1].terminalSiteIds, ['site-2']);
  assert.equal((await execute(tools, 'requestDraftComponents', command('site-2'))).queued, false);
  input.sources[1].patientRight = 'image-left'; Object.assign(input.preparation.sites[1], { fdi: 37, confidence: .99, status: 'proposed-missing' });
  assert.equal((await execute(tools, 'requestDraftComponents', command('site-2'))).queued, false); assert.equal(draftRequests.length, 0);
});
