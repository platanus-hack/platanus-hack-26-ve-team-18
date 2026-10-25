import test from 'node:test';
import assert from 'node:assert/strict';
import { aiGenerationPlan, planningDesignRevision, completedConceptKeys, conceptKey } from '../src/planning-automation.ts';
import { planningExecutionSchema } from '../src/case-planning-schema.ts';
import { emptyToothCase } from '../src/tooth-session.ts';
import { restorationGenerationDesignSchema } from '../src/restoration-generation.ts';

const design = (width = 4) => ({ anatomy: 'molar', anatomySource: 'procedural-template',
  parameters: { fixture: { radius: 1, length: 4, depth: .2, taper: .15 },
    abutment: { radius: .8, height: .5, emergenceRadius: 1, angleX: 0, angleY: 3 },
    crown: { width, depth: 3.5, height: 2, cuspHeight: .1, rotation: 5 } },
  contour: { cervicalScale: .95, occlusalScale: 1.1 } });

function fixture() {
  const measure = { value: 4, method: 'Synthetic local surface envelope.' };
  const sites = ['private-first-site', 'private-second-site'].map((id, index) => ({
    id, partId: 'private-arch', arch: 'lower', fdi: null, kind: 'bounded', status: 'identity-unresolved',
    draftIdentity: { templateFdi: 35, alternatives: [36], basis: 'Identity unknown.' },
    anchor: { partId: 'private-arch', face: index, point: [index * 10, 0, 0] }, frame: {},
    patchFaces: Uint32Array.of(index), space: { mesiodistal: measure, buccolingual: measure, crownHeight: measure },
  }));
  const execution = { requestedModel: 'test-model', actualModel: 'test-model', provider: 'test',
    inputTokens: 20, outputTokens: 30, providerSteps: 2, durationMs: 1,
    limits: { providerSteps: 3, toolCalls: 16, outputTokensPerStep: 8192 }, toolResults: [],
    draftRequests: sites.map((_, index) => ({ siteId: `site-${index + 1}`, fdi: 36, anatomy: 'molar', rationale: 'Explicit visual design.', design: design(4 + index) })),
  };
  return { result: { revision: 'current', model: 'test-model', mappings: [], execution },
    prepared: { revision: 'current', sites }, sites, parts: [{ id: 'private-arch', role: 'lower', triangles: 2 }],
    teeth: emptyToothCase(), counts: {} };
}

test('AI tool decisions resolve to distinct source sites and preserve exact independent designs', () => {
  const input = fixture(), before = structuredClone(input);
  input.result.execution = planningExecutionSchema.parse(input.result.execution);
  const plan = aiGenerationPlan(input);
  assert.deepEqual(plan.requests.map(request => request.siteId), input.sites.map(site => site.id));
  assert.deepEqual(plan.requests.map(request => request.design.parameters.crown.width), [4, 5]);
  assert.deepEqual(plan.sites.map(site => site.draftIdentity.templateFdi), [36, 36]);
  assert.ok(plan.sites.every(site => site.draftIdentity && site.fdi === 36));
  assert.deepEqual(plan.skipped, []);
  assert.deepEqual(input, before, 'Resolving templates cannot write patient identities, chart records or provider choices.');
});

test('stale, missing, duplicate and invalid AI decisions never become default local generation', () => {
  for (const mutate of [
    input => { input.result.revision = 'old'; },
    input => { delete input.result.execution; },
    input => { input.result.execution.draftRequests = []; },
    input => { input.result.execution.draftRequests.forEach(request => { delete request.design; }); },
    input => { input.result.execution.draftRequests[1].siteId = 'site-1'; },
    input => { input.result.execution.draftRequests.forEach(request => { request.design.parameters.crown.width = NaN; }); },
    input => { input.result.execution.draftRequests.forEach(request => { request.fdi = 16; }); },
  ]) {
    const input = fixture(); mutate(input);
    assert.deepEqual(aiGenerationPlan(input).requests, []);
  }
});

test('local exclusions, changed identity decisions and source loss invalidate only the affected AI command', () => {
  for (const mutate of [
    input => { input.teeth.reviewedMask = { 'private-arch': Uint8Array.of(1, 0) }; },
    input => { input.decisions = { 'private-first-site': null }; },
    input => { input.sites = [{ ...input.sites[0], fdi: 34, draftIdentity: undefined }, input.sites[1]]; },
    input => { input.sites = [{ ...input.sites[0], partId: 'another-arch' }, input.sites[1]]; },
  ]) {
    const input = fixture(); mutate(input);
    const plan = aiGenerationPlan(input);
    assert.deepEqual(plan.requests.map(request => request.siteId), ['private-second-site']);
    assert.equal(plan.skipped.length, 1);
  }
});

test('new AI design values change the generation dependency even on the same case revision', () => {
  const input = fixture(), revision = planningDesignRevision(input.result);
  input.result.execution.draftRequests[0].design.parameters.fixture.depth += .1;
  assert.notEqual(planningDesignRevision(input.result), revision);
});

test('an incoming changed design queues replacement before the old assembly becomes stale', () => {
  const input = fixture(), previous = structuredClone(input.result);
  const old = { spec: { fdi: 36, draftIdentity: { siteId: input.sites[0].id } }, warnings: [] };
  const assemblies = [old];
  input.result.execution.draftRequests[0].design.parameters.crown.width = 5;
  const plan = aiGenerationPlan(input);
  const completed = completedConceptKeys(assemblies, previous, input.result);
  assert.ok(plan.sites.filter(site => !completed.has(conceptKey(site))).some(site => site.id === input.sites[0].id));
  assert.ok(completedConceptKeys(assemblies, previous, previous).has(conceptKey(old.spec)), 'An unchanged response retains its existing completed site.');
  old.warnings.push('STALE: source changed');
  assert.equal(completedConceptKeys(assemblies, previous, previous).size, 0);
});

test('AI construction schema requires complete bounded choices and excludes arbitrary geometry or transforms', () => {
  assert.deepEqual(restorationGenerationDesignSchema.parse(design()), design());
  for (const mutate of [
    value => { delete value.parameters.fixture.depth; },
    value => { value.parameters.abutment.angleX = 90; },
    value => { value.parameters.fixture.radius = 0; },
    value => { value.contour.cervicalScale = 2; },
    value => { value.frame = { origin: [1, 2, 3] }; },
    value => { value.vertices = [0, 0, 0]; },
  ]) { const value = design(); mutate(value); assert.equal(restorationGenerationDesignSchema.safeParse(value).success, false); }
});
