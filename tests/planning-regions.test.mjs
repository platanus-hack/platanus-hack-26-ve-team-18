import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAIRegionReviews } from '../src/planning-regions.ts';
import { reconcileIdentities, draftToothCase } from '../src/draft-workflow.ts';
import { emptyToothCase } from '../src/tooth-session.ts';
import { automaticConceptSites } from '../src/planning-automation.ts';
import { toothCounts } from '../src/teeth.ts';

const frame = { origin: [123, 456, 789], up: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] };
const measure = { value: 4, unit: 'file units (u)', method: 'Local sampled envelope.' };
function fixture() {
  const parts = ['upper-private', 'lower-private'].map((id, i) => ({ id, role: i ? 'lower' : 'upper', roleSource: 'user-reviewed', name: id,
    triangles: 64, positions: new Float32Array(64 * 9), fileName: `${id}.ply` }));
  const identities = [], scans = parts.map((part, index) => {
    const teeth = [index ? 36 : 17, index ? 34 : 15].map((fdi, i) => {
      const id = i + 1, faces = Uint32Array.from({ length: 12 }, (_, face) => i * 12 + face);
      identities.push({ partId: part.id, candidateId: id, fdi, confidence: .93, needsReview: false, alternatives: [], blockingReasons: [], reason: 'Measured local sequence.', source: 'geometry' });
      return { id, fdi, faces, centroid: frame.origin, top: frame.origin, axis: frame.up, s: [i * 8, i * 8 + 5], sCenter: i * 8 + 2.5,
        mdWidth: 5, blWidth: 4, height: 3, cervicalLevel: 0, peaks: 2, crownScore: .94, kind: 'crown', flags: [] };
    });
    const candidates = teeth.map(tooth => ({ id: tooth.id, faces: tooth.faces, seed: { face: tooth.faces[0], point: tooth.top }, centroid: tooth.centroid, area: 16, height: tooth.height, warnings: [] }));
    const draftLabels = new Uint8Array(part.triangles);
    for (const tooth of teeth) for (const face of tooth.faces) draftLabels[face] = tooth.fdi;
    return { partId: part.id, scan: { frame, method: 'Local whole-crown grouping', candidates, warnings: [], unassignedTriangles: 40 },
      analysis: { teeth, classes: new Uint8Array(64).fill(1, 0, 24), classCounts: { crown: 24, unknown: 40 },
        gaps: [{ id: 'gap-1', before: 1, after: 2, positions: [index ? 35 : 16], s: [5, 8] }], coverage: { boundaryFaces: 0 } },
      numbering: { arch: part.role, orientation: 1, groups: [], skipped: [], sequence: teeth.map(tooth => tooth.fdi) }, draftLabels, warnings: [] };
  });
  const neighbor = (source, i) => ({ partId: source.partId, toothId: source.analysis.teeth[i].id, fdi: source.analysis.teeth[i].fdi, confidence: .93, centroid: frame.origin });
  const sites = [{ id: 'upper-private-site', partId: parts[0].id, arch: 'upper', fdi: 16, alternatives: [], status: 'proposed-missing', kind: 'bounded',
    confidence: .85, priority: 'medium', slot: { index: 0, count: 1, s: [5, 8] }, frame, anchor: { partId: parts[0].id, face: 40, point: frame.origin }, patchFaces: new Uint32Array([40, 41, 42]),
    frameBasis: 'Local ridge sample.', mesialSign: 1, buccalSign: 1,
    adjacent: { mesial: neighbor(scans[0], 1), distal: neighbor(scans[0], 0) }, contralateral: neighbor(scans[1], 1), opposing: { partId: parts[1].id, teeth: [neighbor(scans[1], 0)], poseVerified: false },
    space: { mesiodistal: measure, buccolingual: measure, proximalGap: measure, crownHeight: measure, vertical: measure },
    evidence: { supporting: ['FDI 17 and FDI 15 flank the local space.'], conflicting: [] }, questions: ['Review FDI 16.'] }];
  const prepared = { id: 1, revision: 'r1', scans, identities, sites, warnings: [] };
  const reviewed = emptyToothCase();
  for (const part of parts) reviewed.labels[part.id] = new Uint8Array(part.triangles);
  reviewed.reviewedMask = Object.fromEntries(parts.map(part => [part.id, new Uint8Array(part.triangles)]));
  return { parts, prepared, reviewed };
}
const review = (overrides = {}) => ({ sourceId: 'scan-1', candidateId: 1, classification: 'tooth', decision: 'use', fdi: 14,
  rationale: 'Existing whole-crown dimensions and rendered region support a premolar hypothesis.', evidence: ['view-1'], ...overrides });
const result = regionReviews => ({ revision: 'r1', model: 'test-ai', mappings: [], findings: [], actions: [], designs: [], limitations: [], execution: { regionReviews } });
const apply = (data, reviews) => applyAIRegionReviews(data.prepared, result(reviews), data.parts, data.reviewed);

test('validated AI FDI changes update actual draft labels, analysis and references while retaining local geometry', () => {
  const data = fixture(), before = structuredClone(data), assessment = result([review(), review({ sourceId: 'scan-2', fdi: 35 })]);
  // A legacy mapping must not reinstate the replaced geometric assertion.
  assessment.mappings = [{ sourceId: 'scan-1', candidateId: 1, fdi: 17, needsReview: false, reason: 'Old geometry mapping.' }];
  const next = applyAIRegionReviews(data.prepared, assessment, data.parts, data.reviewed);
  const identity = next.identities[0], source = next.scans[0], site = next.sites[0];
  assert.equal(identity.fdi, 14); assert.equal(identity.source, 'ai'); assert.equal(identity.confidence, .93); assert.equal(identity.needsReview, false);
  assert.match(identity.reason, /AI tooth identity hypothesis/);
  assert.equal(source.analysis.teeth[0].fdi, 14);
  assert.deepEqual(source.analysis.gaps[0].positions, []); assert.equal(source.analysis.gaps[0].s, data.prepared.scans[0].analysis.gaps[0].s);
  assert.ok(source.scan.candidates[0].faces.every(face => source.draftLabels[face] === 14));
  assert.equal(source.scan.candidates[0].faces, data.prepared.scans[0].scan.candidates[0].faces);
  assert.equal(source.analysis.teeth[0].faces, source.scan.candidates[0].faces);
  assert.equal(source.analysis.classes, data.prepared.scans[0].analysis.classes);
  assert.equal(site.adjacent.distal.toothId, 1); assert.equal(site.adjacent.distal.fdi, 14);
  assert.equal(site.opposing.teeth[0].fdi, 35); assert.equal(site.opposing.teeth[0].confidence, .93);
  assert.equal(site.fdi, null); assert.equal(site.status, 'identity-unresolved'); assert.equal(site.draftIdentity.templateFdi, 16);
  assert.match(site.draftIdentity.basis, /illustrative anatomy only/); assert.equal(site.contralateral, null);
  assert.equal(site.patchFaces, data.prepared.sites[0].patchFaces); assert.equal(site.anchor, data.prepared.sites[0].anchor); assert.equal(site.frame, data.prepared.sites[0].frame);
  assert.doesNotMatch(site.evidence.supporting.join(' '), /FDI 17/);
  assert.equal(next.sites.length, data.prepared.sites.length);
  const identities = reconcileIdentities(next, assessment, data.parts, .8, {});
  assert.equal(identities[0].needsReview, false); assert.doesNotMatch(identities[0].reason, /disagreement/);
  const draft = draftToothCase(data.reviewed, data.parts, next, identities);
  assert.ok(source.scan.candidates[0].faces.every(face => draft.labels[data.parts[0].id][face] === 14));
  assert.equal(draft.reviewedMask, data.reviewed.reviewedMask);
  assert.equal(data.reviewed.teeth[14].status, 'unreviewed');
  assert.deepEqual(data, before, 'AI application and downstream consumers are immutable');
});

test('mixed, unresolved, excluded and boundary-review flanks block sites without inventing ridge or absence', () => {
  for (const choice of [{ classification: 'mixed' }, { classification: 'unresolved' }, { classification: 'non-tooth', decision: 'exclude' }, { decision: 'needs-boundary-review' }]) {
    const data = fixture(), next = apply(data, [review(choice)]), source = next.scans[0], identity = next.identities[0], site = next.sites[0];
    assert.equal(identity.fdi, null); assert.equal(identity.needsReview, true); assert.ok(identity.blockingReasons.length);
    assert.equal(source.analysis.teeth[0].fdi, null); assert.equal(source.analysis.teeth[0].kind, 'crown'); assert.ok(source.analysis.teeth[0].flags.length);
    assert.ok(source.scan.candidates[0].faces.every(face => source.draftLabels[face] === 0));
    assert.equal(source.analysis.classes, data.prepared.scans[0].analysis.classes);
    assert.equal(source.analysis.gaps.length, data.prepared.scans[0].analysis.gaps.length);
    assert.deepEqual(source.analysis.gaps[0].positions, []); assert.deepEqual(source.numbering.skipped, []);
    assert.equal(site.status, 'segmentation-unresolved'); assert.equal(site.fdi, null); assert.equal(site.draftIdentity, undefined);
    assert.match(site.evidence.conflicting.join(' '), /immediate flank/);
    assert.deepEqual(automaticConceptSites({ sites: next.sites, teeth: data.reviewed, counts: toothCounts(data.reviewed.labels), parts: data.parts, result: result([review(choice)]) }), []);
    assert.equal(data.reviewed.teeth[16].status, 'unreviewed');
  }
});

test('distal draft identity review preserves its neutral template but an excluded flank removes eligibility', () => {
  for (const blocked of [false, true]) {
    const data = fixture(), site = data.prepared.sites[0];
    Object.assign(site, { kind: 'distal-extension', fdi: null, status: 'identity-unresolved',
      draftIdentity: { templateFdi: 16, alternatives: [26], basis: 'Tentative posterior anatomy.' } });
    site.adjacent = { mesial: site.adjacent.distal, distal: null };
    const next = apply(data, [review(blocked ? { decision: 'exclude', classification: 'non-tooth' } : {})]);
    assert.equal(next.sites[0].kind, 'distal-extension'); assert.equal(next.sites[0].fdi, null);
    assert.equal(next.sites[0].status, blocked ? 'segmentation-unresolved' : 'identity-unresolved');
    assert.equal(!!next.sites[0].draftIdentity, !blocked);
    assert.equal(automaticConceptSites({ sites: next.sites, teeth: data.reviewed, counts: {}, parts: data.parts, result: result([]) }).length, blocked ? 0 : 1);
  }
});

test('human saved labels and explicit draft identities outrank AI, including skips', () => {
  for (const fdi of [18, null]) {
    const data = fixture(); data.prepared.identities[0] = { ...data.prepared.identities[0], fdi, source: 'reviewed', needsReview: fdi === null };
    const next = apply(data, [review({ classification: 'non-tooth', decision: 'exclude' })]);
    assert.equal(next, data.prepared); assert.equal(next.identities[0].fdi, fdi);
  }
  const data = fixture(); data.reviewed.labels[data.parts[0].id][0] = 18;
  const next = apply(data, [review()]);
  assert.equal(next.identities[0].fdi, 18); assert.equal(next.identities[0].source, 'reviewed');
  assert.equal(next.scans[0].analysis.teeth[0].fdi, 18); assert.equal(next.scans[0].draftLabels[0], 18);
  assert.equal(data.reviewed.labels[data.parts[0].id][0], 18);
});

test('protected zero and excluded faces block AI without altering saved masks or labels', () => {
  for (const label of [0, 255]) {
    const data = fixture(); data.reviewed.labels[data.parts[0].id][1] = label; data.reviewed.reviewedMask[data.parts[0].id][1] = 1;
    const before = structuredClone(data.reviewed), next = apply(data, [review()]);
    assert.equal(next.identities[0].needsReview, true); assert.equal(next.identities[0].fdi, null);
    assert.match(next.identities[0].reason, /protected/); assert.equal(next.scans[0].draftLabels[1], label);
    const rows = reconcileIdentities(next, result([review()]), data.parts, 0, {});
    assert.equal(rows[0].needsReview, true);
    const draft = draftToothCase(data.reviewed, data.parts, next, rows);
    assert.equal(draft.labels[data.parts[0].id][1], label); assert.equal(draft.reviewedMask, data.reviewed.reviewedMask);
    assert.deepEqual(data.reviewed, before);
  }
});

test('existing human correction paths still supersede the AI draft', () => {
  const data = fixture(), next = apply(data, [review()]);
  const decisions = { 'upper-private:C1': 18 }, regions = { 'upper-private:C1': [...next.scans[0].scan.candidates[0].faces] };
  const rows = reconcileIdentities(next, result([review()]), data.parts, .8, decisions, regions);
  assert.equal(rows[0].fdi, 18); assert.equal(rows[0].source, 'reviewed');
  const draft = draftToothCase(data.reviewed, data.parts, next, rows, decisions, regions);
  assert.ok(regions['upper-private:C1'].every(face => draft.labels['upper-private'][face] === 18));
});

test('unknown patient side, arch conflicts and null or opposite-side FDIs cannot become automatic identities', () => {
  const variants = [
    data => { data.prepared.scans[0].numbering = null; },
    data => { data.parts[0].roleSource = 'filename-hypothesis'; },
    data => { data.prepared.scans[0].numbering.arch = 'lower'; },
  ];
  for (const change of variants) {
    const data = fixture(); change(data);
    const next = apply(data, [review()]); assert.equal(next.identities[0].fdi, null); assert.equal(next.identities[0].needsReview, true);
  }
  for (const fdi of [null, 24, 34, 99]) {
    const data = fixture(), next = apply(data, [review({ fdi })]); assert.equal(next.identities[0].fdi, null); assert.equal(next.identities[0].needsReview, true);
    assert.equal(next.sites[0].status, 'identity-unresolved', 'an unresolved FDI alone does not claim broken segmentation');
    assert.equal(next.sites[0].draftIdentity.templateFdi, 16);
  }
});

test('local structural exceptions, inadequate geometry, and missing/not-scanned records stay blocking', () => {
  const changes = [
    data => { data.prepared.identities[0].blockingReasons = ['Merged across a boundary.']; },
    data => { data.prepared.scans[0].analysis.teeth[0].flags = ['Cropped crown.']; },
    data => { data.prepared.scans[0].scan.candidates[0].warnings = ['Unresolved split.']; },
    data => { data.prepared.scans[0].analysis.teeth[0].blWidth = 0; },
    data => { data.prepared.scans[0].analysis = null; },
    data => { data.reviewed.teeth[14].status = 'missing'; },
    data => { data.reviewed.teeth[14].status = 'not-scanned'; },
  ];
  for (const change of changes) {
    const data = fixture(); change(data); const next = apply(data, [review()]);
    assert.equal(next.identities[0].fdi, null); assert.equal(next.identities[0].needsReview, true);
    assert.equal(reconcileIdentities(next, result([review()]), data.parts, 0, {})[0].needsReview, true);
  }
});

test('known crown geometry with unknown patient side retains its existing neutral site and never gains FDI', () => {
  const data = fixture(), identity = data.prepared.identities[0], site = data.prepared.sites[0];
  identity.fdi = null; identity.confidence = 0; identity.needsReview = true; identity.blockingReasons = ['Patient right is unconfirmed.'];
  data.prepared.scans[0].numbering = null; data.prepared.scans[0].analysis.teeth[0].fdi = null;
  site.adjacent.distal.fdi = null; site.fdi = null; site.status = 'identity-unresolved';
  site.draftIdentity = { templateFdi: 16, alternatives: [26], basis: 'Illustrative template; unknown patient side.' };
  const next = apply(data, [review()]);
  assert.equal(next.identities[0].fdi, null); assert.equal(next.identities[0].needsReview, true);
  assert.equal(next.sites[0].status, 'identity-unresolved'); assert.equal(next.sites[0].draftIdentity.templateFdi, 16);
});

test('AI never raises confidence or clears score-only exceptions', () => {
  const data = fixture(); data.prepared.identities[0].confidence = .4; data.prepared.identities[0].needsReview = true;
  const next = apply(data, [review()]);
  assert.equal(next.identities[0].fdi, 14); assert.equal(next.identities[0].source, 'ai'); assert.equal(next.identities[0].confidence, .4); assert.equal(next.identities[0].needsReview, true);
  assert.ok(next.scans[0].scan.candidates[0].faces.every(face => next.scans[0].draftLabels[face] === 0));
  assert.equal(reconcileIdentities(next, result([review()]), data.parts, .8, {})[0].needsReview, true);
});

test('global duplicate FDIs and repeated candidate reviews are conservative and order independent', () => {
  const data = fixture();
  // A third imported component on the same arch participates in global checks.
  const part = { ...data.parts[0], id: 'other-upper' }, source = structuredClone(data.prepared.scans[0]);
  source.partId = part.id; source.analysis.teeth[0].fdi = 14;
  data.parts.push(part); data.prepared.scans.push(source);
  data.prepared.identities.push({ ...data.prepared.identities[0], partId: part.id, fdi: 14 });
  const next = apply(data, [review()]);
  for (const identity of next.identities.filter(identity => identity.candidateId === 1 && identity.partId !== data.parts[1].id)) {
    assert.equal(identity.fdi, null); assert.equal(identity.needsReview, true); assert.match(identity.reason, /Conflicting FDI/);
  }
  for (const reviews of [[review(), review({ fdi: 18 })], [review({ fdi: 18 }), review()]]) {
    const next = apply(fixture(), reviews); assert.equal(next.identities[0].fdi, null); assert.equal(next.identities[0].needsReview, true);
    assert.match(next.identities[0].reason, /Conflicting AI reviews/);
  }
});

test('a unique reviewed FDI wins over a duplicate AI proposal on another candidate', () => {
  const data = fixture(); data.prepared.identities[1] = { ...data.prepared.identities[1], fdi: 14, source: 'reviewed' };
  const next = apply(data, [review()]);
  assert.equal(next.identities[0].fdi, null); assert.equal(next.identities[0].needsReview, true);
  assert.equal(next.identities[1].fdi, 14); assert.equal(next.identities[1].needsReview, false); assert.equal(next.identities[1].source, 'reviewed');
});

test('a saved FDI outside detected candidates cannot be reused by an AI region', () => {
  const data = fixture(); data.reviewed.labels[data.parts[0].id][63] = 14;
  const next = apply(data, [review()]);
  assert.equal(next.identities[0].fdi, null); assert.equal(next.identities[0].needsReview, true);
  assert.match(next.identities[0].reason, /already assigned to a saved human/);
  assert.equal(data.reviewed.labels[data.parts[0].id][63], 14);
});

test('only current revisions, anonymous aliases and exact existing candidates are accepted', () => {
  const data = fixture();
  assert.equal(applyAIRegionReviews(null, result([review()]), data.parts, data.reviewed), null);
  assert.equal(applyAIRegionReviews(data.prepared, null, data.parts, data.reviewed), data.prepared);
  assert.equal(applyAIRegionReviews(data.prepared, { ...result([review()]), revision: 'older' }, data.parts, data.reviewed), data.prepared);
  for (const invalid of [{ sourceId: 'upper-private' }, { sourceId: 'scan-0' }, { sourceId: 'scan-01' }, { sourceId: 'scan-9' }, { candidateId: 999 }, { candidateId: '1' }]) assert.equal(apply(data, [review(invalid)]), data.prepared);
  const hidden = fixture();
  hidden.prepared.scans[0].scan.candidates.push(...Array.from({ length: 31 }, (_, index) => ({ ...hidden.prepared.scans[0].scan.candidates[0], id: 3 + index })));
  hidden.prepared.identities.push({ ...hidden.prepared.identities[0], candidateId: 33 });
  assert.equal(apply(hidden, [review({ candidateId: 33 })]), hidden.prepared, 'a candidate omitted from bounded model evidence is unavailable');
  data.parts.unshift({ id: 'unrelated-model', role: 'model' });
  assert.equal(apply(data, [review()]), data.prepared);
  assert.equal(apply(data, [review({ sourceId: 'scan-2' })]).identities[0].fdi, 14);
});

test('changed or ineligible donors are cleared and rejected opponents retain only their geometric reference', () => {
  const data = fixture(), next = apply(data, [review({ sourceId: 'scan-2', candidateId: 2, fdi: 33 }), review({ sourceId: 'scan-2', classification: 'mixed' })]);
  const site = next.sites[0];
  assert.equal(site.contralateral, null); assert.equal(site.opposing.teeth[0].toothId, 1); assert.equal(site.opposing.teeth[0].fdi, null); assert.equal(site.opposing.teeth[0].confidence, 0);
  assert.equal(site.fdi, 16, 'an independent opposing identity cannot erase the established site identity');
});
