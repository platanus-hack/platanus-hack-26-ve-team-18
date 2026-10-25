import test from 'node:test';
import assert from 'node:assert/strict';
import { applySiteDecisions, projectPlanningAssessment } from '../src/planning-projection.ts';
import { aiGenerationPlan, automaticConceptSites } from '../src/planning-automation.ts';
import { emptyToothCase } from '../src/tooth-session.ts';
import { localPlanningResult } from '../src/draft-workflow.ts';

const frame = { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], up: [0, 0, 1] };
const measure = { value: 4, unit: 'file units (u)', method: 'Synthetic local envelope.' };
const design = { anatomy: 'molar', anatomySource: 'procedural-template',
  parameters: { fixture: { radius: 1, length: 4, depth: .2, taper: .15 },
    abutment: { radius: .8, height: .5, emergenceRadius: 1, angleX: 0, angleY: 3 },
    crown: { width: 4, depth: 3.5, height: 2, cuspHeight: .1, rotation: 5 } },
  contour: { cervicalScale: .95, occlusalScale: 1.1 } };

function fixture() {
  const part = { id: 'upper', role: 'upper', roleSource: 'user-reviewed', triangles: 64 };
  const crowns = [18, 15].map((fdi, index) => ({ id: index + 1, fdi,
    faces: Uint32Array.from({ length: 12 }, (_, face) => index * 12 + face),
    kind: 'crown', mdWidth: 5, blWidth: 4, height: 3, flags: [] }));
  const candidates = crowns.map(crown => ({ id: crown.id, faces: crown.faces, warnings: [] }));
  const draftLabels = new Uint8Array(part.triangles);
  for (const crown of crowns) for (const face of crown.faces) draftLabels[face] = crown.fdi;
  const neighbor = crown => ({ toothId: crown.id, fdi: crown.fdi, partId: part.id, centroid: frame.origin, confidence: .93 });
  const site = { id: 'upper-gap', partId: part.id, arch: 'upper', fdi: 16, alternatives: [],
    status: 'proposed-missing', confidence: .85, kind: 'bounded', priority: 'medium',
    anchor: { partId: part.id, face: 40, point: frame.origin }, patchFaces: Uint32Array.of(40, 41), frame,
    adjacent: { mesial: neighbor(crowns[1]), distal: neighbor(crowns[0]) }, opposing: null, contralateral: null,
    space: { mesiodistal: measure, buccolingual: measure, crownHeight: measure },
    evidence: { supporting: ['Local bounded ridge.'], conflicting: [] }, questions: [] };
  const prepared = { id: 1, revision: 'current', sites: [site], warnings: [],
    identities: crowns.map(crown => ({ partId: part.id, candidateId: crown.id, fdi: crown.fdi,
      confidence: .93, needsReview: false, blockingReasons: [], alternatives: [], source: 'geometry', reason: 'Local sequence.' })),
    scans: [{ partId: part.id, scan: { frame, candidates, warnings: [] }, draftLabels,
      analysis: { teeth: crowns, gaps: [{ id: 'gap', before: 1, after: 2, positions: [16] }] },
      numbering: { arch: 'upper', orientation: 1 }, warnings: [] }] };
  const reviewed = emptyToothCase();
  reviewed.labels[part.id] = new Uint8Array(part.triangles);
  reviewed.reviewedMask = { [part.id]: new Uint8Array(part.triangles) };
  return { prepared, parts: [part], reviewed, confidenceThreshold: .8, identityDecisions: {}, identityRegions: {}, siteDecisions: {} };
}

function assessment(fdi = 17, overrides = {}) {
  return { revision: 'current', model: 'test-ai', mappings: [], findings: [], designs: [],
    execution: {
      regionReviews: [{ sourceId: 'scan-1', candidateId: 1, classification: 'tooth', decision: 'use', fdi,
        rationale: 'Existing crown region reviewed.', evidence: ['view-1'], ...overrides }],
      draftRequests: [{ siteId: 'site-1', fdi: 16, anatomy: 'molar', rationale: 'Bounded visual draft.', design }],
    } };
}

function plan(input, result, projected = projectPlanningAssessment({ ...input, result })) {
  return aiGenerationPlan({ ...projected, result, parts: input.parts, decisions: input.siteDecisions });
}

test('site identity decisions change only identity states and preserve structural blocks', () => {
  const [site] = fixture().prepared.sites;
  for (const status of ['proposed-missing', 'identity-unresolved', 'dentist-confirmed-missing', 'segmentation-unresolved', 'not-scanned', 'partial-coverage']) {
    for (const fdi of [16, null]) {
      const original = { ...site, status }, before = structuredClone(original);
      const [projected] = applySiteDecisions([original], { [site.id]: fdi });
      const identityState = ['proposed-missing', 'identity-unresolved', 'dentist-confirmed-missing'].includes(status);
      assert.equal(projected.status, identityState ? fdi === null ? 'identity-unresolved' : 'proposed-missing' : status);
      assert.equal(projected.fdi, fdi);
      assert.equal(projected.confidence, original.confidence);
      assert.deepEqual(original, before);
    }
  }
  assert.equal(applySiteDecisions([site], {})[0], site);
});

test('restored site decisions cannot make newly cropped or mixed flanks executable', () => {
  for (const condition of ['cropped', 'mixed']) {
    const input = fixture();
    input.siteDecisions = JSON.parse(JSON.stringify({ 'upper-gap': 16 }));
    assert.equal(plan(input, assessment()).requests.length, 1, 'the saved identity correction starts with a usable site');
    if (condition === 'cropped') input.prepared.scans[0].analysis.teeth[0].flags = ['Cropped crown.'];
    const result = assessment(17, condition === 'mixed' ? { classification: 'mixed' } : {}), before = structuredClone(input);
    const projected = projectPlanningAssessment({ ...input, result });
    assert.equal(projected.prepared.sites[0].status, 'segmentation-unresolved');
    assert.equal(projected.sites[0].status, 'segmentation-unresolved');
    assert.deepEqual(automaticConceptSites({ ...projected, parts: input.parts, result, decisions: input.siteDecisions }), []);
    assert.deepEqual(plan(input, result, projected).requests, []);
    assert.deepEqual(input, before, 'projection preserves the saved decisions and preparation');
  }
});

test('consecutive AI assessments use incoming crown labels and counts before checking the incoming gap', () => {
  const input = fixture(), before = structuredClone(input);
  const previous = projectPlanningAssessment({ ...input, result: assessment(16) });
  assert.equal(previous.counts[16], 12);
  assert.equal(previous.teeth.teeth[16].status, 'present');
  const result = assessment(17), incoming = projectPlanningAssessment({ ...input, result });
  assert.equal(incoming.identities[0].fdi, 17);
  assert.equal(incoming.counts[16] ?? 0, 0);
  assert.equal(incoming.counts[17], 12);
  assert.equal(incoming.teeth.teeth[16].status, 'unreviewed');
  assert.ok(incoming.prepared.scans[0].scan.candidates[0].faces.every(face => incoming.teeth.labels.upper[face] === 17));
  assert.deepEqual(plan(input, result, { ...incoming, counts: previous.counts }).requests, [], 'previous assessment counts reproduce the stale rejection');
  assert.deepEqual(plan(input, result, incoming).requests.map(request => request.fdi), [16]);
  assert.deepEqual(input, before);
});

test('AI to local fallback checks fresh local crown identities, labels and sites before generating the gap', () => {
  const input = fixture(), before = structuredClone(input);
  const previous = projectPlanningAssessment({ ...input, result: assessment(16) });
  assert.equal(previous.counts[16], 12);
  assert.equal(previous.sites[0].adjacent.distal.fdi, 16);
  const result = localPlanningResult(input.prepared, input.parts);
  assert.deepEqual(automaticConceptSites({ sites: previous.sites, teeth: input.reviewed, counts: previous.counts,
    parts: input.parts, result, decisions: input.siteDecisions }), [], 'previous render inputs reproduce the local fallback rejection');
  const incoming = projectPlanningAssessment({ ...input, result });
  assert.equal(incoming.identities[0].fdi, 18);
  assert.equal(incoming.counts[18], 12);
  assert.equal(incoming.counts[16] ?? 0, 0);
  assert.equal(incoming.sites[0].adjacent.distal.fdi, 18);
  assert.equal(incoming.teeth.teeth[16].status, 'unreviewed');
  assert.ok(incoming.prepared.scans[0].scan.candidates[0].faces.every(face => incoming.teeth.labels.upper[face] === 18));
  assert.deepEqual(automaticConceptSites({ ...incoming, parts: input.parts, result, decisions: input.siteDecisions }).map(site => site.fdi), [16]);
  assert.deepEqual(input, before);
});

test('local fallback protects current human draft corrections on the proposed ridge patch', () => {
  const input = fixture(), result = localPlanningResult(input.prepared, input.parts);
  input.identityDecisions['upper:C99'] = 14;
  input.identityRegions['upper:C99'] = [40];
  const before = structuredClone(input), incoming = projectPlanningAssessment({ ...input, result });
  assert.equal(incoming.teeth.labels.upper[40], 14);
  assert.equal(input.reviewed.labels.upper[40], 0);
  assert.equal(automaticConceptSites({ ...incoming, teeth: input.reviewed, parts: input.parts, result,
    decisions: input.siteDecisions }).length, 1, 'raw saved labels miss the human draft patch correction');
  assert.deepEqual(automaticConceptSites({ ...incoming, parts: input.parts, result, decisions: input.siteDecisions }), []);
  assert.deepEqual(input, before);
});

test('incoming eligibility honors current explicit human identities and corrected patch faces', () => {
  for (const [key, fdi, faces] of [
    ['upper:C1', 16, Array.from({ length: 12 }, (_, face) => face)],
    ['upper:C99', 14, [40]],
  ]) {
    const input = fixture(), result = assessment(17);
    input.identityDecisions[key] = fdi;
    input.identityRegions[key] = faces;
    const before = structuredClone(input), projected = projectPlanningAssessment({ ...input, result });
    assert.ok(faces.every(face => projected.teeth.labels.upper[face] === fdi));
    assert.deepEqual(plan(input, result, projected).requests, []);
    if (fdi === 14) assert.equal(plan(input, result, { ...projected, teeth: input.reviewed }).requests.length, 1, 'raw reviewed labels miss the current draft patch correction');
    assert.deepEqual(input, before);
  }
});
