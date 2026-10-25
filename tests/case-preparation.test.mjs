import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareCase, preparationTransfers } from '../src/case-preparation.ts';
import { mirrorFdi } from '../src/missing-sites.ts';
import { reconcileIdentities, draftToothCase } from '../src/draft-workflow.ts';
import { emptyToothCase } from '../src/tooth-session.ts';
import { createPlanningSession, readPlanningSession } from '../src/planning-session.ts';

// Smooth protrusions on a connected open gum sheet, in arbitrary file units.
function arch(count = 7, { missing = -1, scale = 1, shift = [0, 0, 0] } = {}) {
  const radius = Math.max(3, count * 1.12), step = .22;
  const centers = Array.from({ length: count }, (_, i) => { const a = .12 + (Math.PI - .24) * i / (count - 1); return [radius * Math.cos(a), radius * Math.sin(a)]; });
  const nx = Math.ceil((radius * 2 + 4) / step), ny = Math.ceil((radius + 4) / step);
  const points = Array.from({ length: ny + 1 }, (_, y) => Array.from({ length: nx + 1 }, (_, x) => {
    const px = -radius - 2 + x * (radius * 2 + 4) / nx, py = -2 + y * (radius + 4) / ny;
    let h = 0;
    centers.forEach(([cx, cy], i) => { if (i === missing) return; const r = Math.hypot(px - cx, py - cy) / 1.43; if (r < 1) h = Math.max(h, 2.3 * (.5 + .5 * Math.cos(Math.PI * r))); });
    return [px, py, h].map((value, k) => scale * value + shift[k]);
  }));
  const faces = [];
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { const a = points[y][x], b = points[y][x + 1], c = points[y + 1][x + 1], d = points[y + 1][x]; faces.push(...a, ...b, ...d, ...b, ...c, ...d); }
  return new Float32Array(faces);
}
const positions = arch();
const request = extra => ({ id: 7, revision: 'source-order-pose-chart-unit-settings-revision', sources: [{ id: 'arch-a', arch: 'upper', positions }], ...extra });
const unknown = prepareCase(request());
const right = prepareCase(request({ patientRight: { 'arch-a': 'image-right' } }));

test('changed region boundaries cannot expand an exact-face draft correction through preparation or reopening', async () => {
  const original = unknown.scans[0].scan.candidates[0], faces = Array.from(original.faces);
  const decisions = { 'arch-a:C1': 11 }, regions = { 'arch-a:C1': faces };
  const tissueScores = new Float32Array(positions.length / 9).fill(.05);
  for (let i = 0; i < faces.length; i += 3) tissueScores[faces[i]] = .95;
  const source = { id: 'arch-a', arch: 'upper', positions, tissueScores, identityCorrections: [{ fdi: 11, faces }] };
  const exact = prepareCase(request({ sources: [{ ...source, tissueScores: undefined }] }));
  assert.equal(exact.identities[0].fdi, 11);
  assert.equal(reconcileIdentities(exact, null, [{ id: 'arch-a' }], .8, decisions, regions)[0].needsReview, false);
  const prepared = prepareCase(request({ sources: [source] }));
  const fresh = prepared.scans[0].scan.candidates[0], extra = Array.from(fresh.faces).filter(face => !faces.includes(face));
  assert.ok(extra.length > 0, 'the tissue change must exercise the real resegmentation boundary');
  const part = { id: 'arch-a', name: 'Synthetic upper', fileName: 'synthetic.ply', role: 'upper', positions, normals: new Float32Array(positions.length), triangles: positions.length / 9, vertices: positions.length / 3, dimensions: [20, 12, 3], offset: [0, 0, 0], closed: false, visible: true };
  const reviewed = emptyToothCase(); reviewed.labels[part.id] = new Uint8Array(part.triangles);
  const identities = reconcileIdentities(prepared, null, [part], .8, decisions, regions);
  assert.equal(identities[0].needsReview, true);
  const effective = draftToothCase(reviewed, [part], prepared, identities, decisions, regions);
  assert.ok(faces.every(face => effective.labels[part.id][face] === 11));
  assert.ok(extra.every(face => effective.labels[part.id][face] === 0));
  const saved = await createPlanningSession({ parts: [part], teeth: reviewed, assemblies: [], draft: { evidence: { revision: prepared.revision, sources: prepared.scans, views: [] }, prepared, result: null }, workflow: { identityDecisions: decisions, identityRegions: regions } });
  const restored = await readPlanningSession(saved, [part]);
  const rows = reconcileIdentities(restored.draft.prepared, null, restored.parts, .8, restored.workflow.identityDecisions, restored.workflow.identityRegions);
  const reopened = draftToothCase(restored.teeth, restored.parts, restored.draft.prepared, rows, restored.workflow.identityDecisions, restored.workflow.identityRegions);
  assert.equal(rows[0].needsReview, true);
  assert.ok(extra.every(face => reopened.labels[part.id][face] === 0));
  assert.ok(reviewed.labels[part.id].every(value => value === 0));
});

test('joint preparation returns whole-crown geometry without asserting FDI or physical scale', () => {
  const source = unknown.scans[0];
  assert.equal(source.scan.candidates.length, 7);
  assert.equal(source.numbering, null);
  assert.ok(source.analysis);
  assert.ok(source.analysis.teeth.every(tooth => tooth.fdi === null));
  assert.ok(source.analysis.gaps.every(gap => gap.positions.length === 0));
  assert.ok(unknown.identities.every(item => item.fdi === null && item.confidence === 0 && item.alternatives.length === 0 && item.needsReview));
  assert.ok(source.draftLabels.every(value => value === 0));
  assert.ok(unknown.sites.every(site => site.fdi === null && site.alternatives.length === 0));
  const seen = new Set();
  for (const candidate of source.scan.candidates) {
    assert.ok(candidate.faces.length >= 12 && candidate.faces.includes(candidate.seed.face));
    assert.ok(candidate.area > 0 && candidate.height > 0 && candidate.centroid.every(Number.isFinite));
    for (const face of candidate.faces) { assert.ok(face < positions.length / 9); assert.ok(!seen.has(face)); seen.add(face); }
  }
  assert.equal(source.scan.unassignedTriangles, positions.length / 9 - seen.size);
  assert.equal(source.analysis.classCounts.gingiva, 0, 'unassigned geometry is not a gingiva segmentation without independent tissue cues');
  assert.deepEqual(structuredClone(unknown), unknown, 'result contains no worker-only models, closures or mesh positions');
  assert.ok(!/\bmm\b/i.test(JSON.stringify(unknown)), 'physical millimetres must not be inferred; substrings such as symmetric are not units');
  assert.ok(unknown.sites.every(site => Object.values(site.space).every(value => value.unit === 'file units (u)')));
});

test('explicit patient-right reverses draft FDI while candidate geometry stays the same', () => {
  const left = prepareCase(request({ patientRight: { 'arch-a': 'image-left' } }));
  assert.ok(right.scans[0].numbering);
  assert.deepEqual(left.scans[0].scan.candidates, right.scans[0].scan.candidates);
  assert.deepEqual(left.identities.map(item => item.fdi), right.identities.map(item => item.fdi === null ? null : mirrorFdi(item.fdi)));
  assert.equal(right.revision, request().revision);
  assert.equal(right.id, 7);
});

test('an unresolved lower site retains independently identified upper opposing crowns', () => {
  const lower = arch(7, { missing: 3 });
  for (let i = 2; i < lower.length; i += 3) lower[i] = 5 - lower[i];
  const localized = prepareCase(request({ sources: [{ id: 'lower', arch: 'lower', positions: lower }] }));
  const gap = localized.sites.find(site => site.kind === 'bounded');
  assert.ok(gap?.frame);
  const crown = right.scans[0].analysis.teeth.find(tooth => tooth.fdi !== null);
  const upper = positions.slice();
  for (let i = 0; i < upper.length; i += 3) {
    upper[i] += gap.frame.origin[0] - crown.centroid[0];
    upper[i + 1] += gap.frame.origin[1] - crown.centroid[1];
  }
  const result = prepareCase(request({
    sources: [{ id: 'upper', arch: 'upper', positions: upper }, { id: 'lower', arch: 'lower', positions: lower }],
    patientRight: { upper: 'image-right', lower: null }, poseVerified: false, confidenceThreshold: 0,
  }));
  const site = result.sites.find(site => site.partId === 'lower' && site.kind === 'bounded');
  assert.ok(site, 'the synthetic lower arch must retain its localized gap');
  assert.equal(site.fdi, null);
  assert.ok(site.opposing?.teeth.length, 'the posed upper crown must be included geometrically');
  const numbered = site.opposing.teeth.filter(tooth => tooth.fdi !== null);
  assert.ok(numbered.length, 'site uncertainty must not erase the other arch’s identity');
  for (const tooth of numbered) {
    const identity = result.identities.find(item => item.partId === tooth.partId && item.candidateId === tooth.toothId);
    assert.equal(tooth.fdi, identity.fdi);
  }
  assert.equal(site.opposing.poseVerified, false);
});

test('the configured threshold changes exception flags without changing geometry or scores', () => {
  const low = prepareCase(request({ patientRight: { 'arch-a': 'image-right' }, confidenceThreshold: 0 }));
  const high = prepareCase(request({ patientRight: { 'arch-a': 'image-right' }, confidenceThreshold: 1 }));
  assert.deepEqual(low.scans[0].scan.candidates, high.scans[0].scan.candidates);
  assert.deepEqual(low.identities.map(item => [item.fdi, item.confidence]), high.identities.map(item => [item.fdi, item.confidence]));
  assert.ok(low.identities.some((item, i) => !item.needsReview && high.identities[i].needsReview));
  assert.deepEqual(low.identities.map(item => item.blockingReasons), high.identities.map(item => item.blockingReasons), 'threshold changes cannot add or remove structural reasons');
  const scoreOnly = high.identities.find(item => item.fdi !== null && item.needsReview && item.blockingReasons.length === 0);
  assert.ok(scoreOnly, 'score-only exceptions remain independently reclassifiable');
  assert.equal(low.identities.find(item => item.candidateId === scoreOnly.candidateId).needsReview, false);
  assert.ok(low.identities.filter(item => item.fdi === null).every(item => item.needsReview));
  for (const confidenceThreshold of [-.1, 1.1, NaN]) assert.throws(() => prepareCase(request({ confidenceThreshold })), /threshold/);
});

test('existing reviewed identity, exclusions and explicit erasures survive re-preparation', () => {
  const candidate = right.scans[0].scan.candidates[0], labels = new Uint8Array(positions.length / 9), mask = new Uint8Array(labels.length);
  const [identityFace, excludedFace, erasedFace] = candidate.faces;
  labels[identityFace] = 17; labels[excludedFace] = 255; mask[erasedFace] = 1;
  const chart = { 17: { status: 'present', restoration: 'none', note: 'reviewed' } };
  const original = { labels: labels.slice(), mask: mask.slice(), chart: structuredClone(chart), positions: positions.slice() };
  const result = prepareCase(request({ chart, patientRight: { 'arch-a': 'image-right' }, sources: [{ ...request().sources[0], reviewedLabels: labels, reviewedMask: mask }] }));
  assert.equal(result.scans[0].draftLabels[identityFace], 17);
  assert.equal(result.scans[0].draftLabels[excludedFace], 255);
  assert.equal(result.scans[0].draftLabels[erasedFace], 0);
  const identity = result.identities.find(item => item.candidateId === candidate.id);
  assert.equal(identity.fdi, 17); assert.equal(identity.source, 'reviewed');
  assert.ok(identity.blockingReasons.some(reason => /protected exclusion or erased correction/.test(reason)));
  assert.equal(identity.needsReview, true, 'an explicit reviewed identity cannot erase protected boundary corrections');
  assert.deepEqual(labels, original.labels); assert.deepEqual(mask, original.mask); assert.deepEqual(chart, original.chart); assert.deepEqual(positions, original.positions);
});

test('a chart absence conflicting with a crown prevents automatic labels for that identity', () => {
  const item = right.identities.find(item => item.fdi !== null);
  const result = prepareCase(request({ patientRight: { 'arch-a': 'image-right' }, chart: { [item.fdi]: { status: 'missing', restoration: 'none', note: '' } } }));
  const next = result.identities.find(identity => identity.candidateId === item.candidateId);
  assert.equal(next.needsReview, true);
  assert.ok(next.blockingReasons.some(reason => /conflicts with the saved/.test(reason)));
  assert.match(next.reason, /conflict/);
  assert.ok(!result.scans[0].draftLabels.includes(item.fdi));
});

test('uniform file scaling preserves geometry counts and scales measured lengths, never units', () => {
  const changed = arch(7, { scale: 4, shift: [12, -8, 3] });
  const result = prepareCase(request({ sources: [{ id: 'arch-a', arch: 'upper', positions: changed }] }));
  assert.equal(result.scans[0].scan.candidates.length, unknown.scans[0].scan.candidates.length);
  assert.ok(Math.abs(result.scans[0].analysis.length / unknown.scans[0].analysis.length - 4) < .04);
  assert.ok(result.sites.every(site => Object.values(site.space).every(value => value.unit === 'file units (u)')));
});

test('one unusable source preserves the other source and finite fallback axes', () => {
  const result = prepareCase(request({ sources: [...request().sources, { id: 'bad', arch: 'lower', positions: new Float32Array([NaN, 0, 0, 0, 1, 0, 1, 0, 0]) }] }));
  assert.ok(result.scans[0].scan.candidates.length);
  assert.equal(result.scans[1].scan.method, 'unavailable');
  assert.ok(result.scans[1].scan.frame.origin.every(Number.isFinite));
  assert.ok(result.scans[1].scan.candidates.length === 0);
});

test('transfer list deduplicates shared analysis/candidate buffers and round trips intact', () => {
  const result = structuredClone(right), transfer = preparationTransfers(result);
  assert.equal(new Set(transfer).size, transfer.length);
  const next = structuredClone(result, { transfer });
  assert.equal(next.scans[0].scan.candidates.length, right.scans[0].scan.candidates.length);
  assert.ok(next.scans[0].analysis.teeth.every(tooth => tooth.faces.length));
});

test('triangle reversal and a proper rigid change of file frame preserve the fitted band instead of growing a terminal path', () => {
  const reversed = new Float32Array(positions.length), rigid = new Float32Array(positions.length);
  for (let f = 0; f < positions.length / 9; f++) reversed.set(positions.subarray(f * 9, f * 9 + 9), positions.length - (f + 1) * 9);
  for (let i = 0; i < positions.length; i += 3) rigid.set([positions[i + 2] + 16, positions[i] - 32, positions[i + 1] + 8], i);
  const base = unknown.scans[0].analysis;
  for (const variant of [reversed, rigid]) {
    const result = prepareCase(request({ sources: [{ id: 'arch-a', arch: 'upper', positions: variant }] }));
    assert.equal(result.scans[0].scan.candidates.length, unknown.scans[0].scan.candidates.length);
    assert.ok(Math.abs(result.scans[0].analysis.length - base.length) <= 2 * base.scale.cell);
    assert.ok(result.sites.every(site => site.kind !== 'terminal' && site.fdi === null));
  }
});

// A threshold of zero must never turn an explicit structural conflict into an
// eligible automated identity; this is separate from the score-only test above.
test('structural chart conflicts stay blocking even when the score threshold is zero', () => {
  const item = right.identities.find(item => item.fdi !== null);
  const result = prepareCase(request({ patientRight: { 'arch-a': 'image-right' }, confidenceThreshold: 0, chart: { [item.fdi]: { status: 'not-scanned', restoration: 'none', note: '' } } }));
  const identity = result.identities.find(identity => identity.candidateId === item.candidateId);
  assert.ok(identity.confidence > 0); assert.equal(identity.needsReview, true); assert.ok(identity.blockingReasons.length);
  assert.ok(identity.blockingReasons.every(reason => !/threshold/.test(reason)));
  assert.ok(!result.scans[0].draftLabels.includes(item.fdi));
});

test('filename-only arch roles and invalid image-side values cannot assert anatomical identities', () => {
  for (const extra of [
    { patientRight: { 'arch-a': 'image-right' }, sources: [{ ...request().sources[0], roleConfirmed: false }] },
    { patientRight: { 'arch-a': 'left' } },
  ]) {
    const result = prepareCase(request(extra));
    assert.equal(result.scans[0].scan.candidates.length, unknown.scans[0].scan.candidates.length);
    assert.equal(result.scans[0].numbering, null);
    assert.ok(result.identities.every(item => item.fdi === null && item.needsReview));
    assert.ok(result.sites.every(site => site.kind === 'chart' || site.fdi === null));
  }
});

test('reviewed identity corrections are reflected in downstream tooth and donor metadata', () => {
  const candidate = right.scans[0].scan.candidates[0], labels = new Uint8Array(positions.length / 9);
  labels[candidate.faces[0]] = 18;
  const result = prepareCase(request({ patientRight: { 'arch-a': 'image-right' }, sources: [{ ...request().sources[0], reviewedLabels: labels }] }));
  assert.equal(result.identities.find(item => item.candidateId === candidate.id).fdi, 18);
  assert.equal(result.scans[0].analysis.teeth.find(tooth => tooth.id === candidate.id).fdi, 18);
});

test('reviewed non-tooth exclusions never re-enter detector or grouped crown geometry', () => {
  const labels = new Uint8Array(positions.length / 9), original = positions.slice();
  for (const face of right.scans[0].scan.candidates[0].faces) labels[face] = 255;
  const result = prepareCase(request({ patientRight: { 'arch-a': 'image-right' }, sources: [{ ...request().sources[0], reviewedLabels: labels }] }));
  assert.ok(result.scans[0].analysis);
  assert.ok(result.scans[0].scan.candidates.every(candidate => candidate.faces.every(face => labels[face] !== 255)));
  assert.equal(Object.values(result.scans[0].analysis.classCounts).reduce((sum, count) => sum + count, 0), labels.length, 'public class counts retain excluded source triangles as unknown, preserving session integrity');
  for (let face = 0; face < labels.length; face++) if (labels[face] === 255) assert.equal(result.scans[0].draftLabels[face], 255);
  assert.deepEqual(positions, original);
});
