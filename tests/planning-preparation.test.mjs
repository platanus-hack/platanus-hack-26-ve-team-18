import test from 'node:test';
import assert from 'node:assert/strict';
import { planningPreparationEvidence } from '../src/planning-preparation.ts';
import { localPlanningResult } from '../src/draft-workflow.ts';
import { automaticConceptSites } from '../src/planning-automation.ts';
import { emptyToothCase } from '../src/tooth-session.ts';

test('planning retains lower terminal review and one-to-many opponents without exposing source geometry', () => {
  const crown = (partId, toothId, fdi) => ({ partId, toothId, fdi, confidence: .7, centroid: [123, 456, 789] });
  const parts = [{ id: 'upper-private', role: 'upper', name: 'private-name' }, { id: 'lower-private', role: 'lower' }];
  const source = partId => ({ partId, scan: { method: 'local arch analysis', candidates: [], unassignedTriangles: 3 }, analysis: null });
  const measure = { value: 8, method: 'Sampled envelope; not clearance.' };
  const site = { id: 'private-lower-site', arch: 'lower', partId: 'lower-private', fdi: null, kind: 'terminal', status: 'segmentation-unresolved', confidence: 0,
    slot: { count: 0 }, anchor: { point: [123, 456, 789] }, frame: {}, patchFaces: new Uint32Array([5, 6, 7]),
    evidence: { supporting: ['Scanned ridge beyond one crown.'], conflicting: ['Absence unconfirmed.'] }, questions: ['Review coverage.'],
    adjacent: { mesial: crown('lower-private', 1, 36), distal: null }, contralateral: null,
    opposing: { partId: 'upper-private', teeth: [crown('upper-private', 2, 26), crown('upper-private', 3, 27)], poseVerified: false },
    space: { mesiodistal: measure, buccolingual: measure, vertical: { ...measure, value: null } } };
  const prepared = { revision: 'r1', scans: parts.map(part => source(part.id)), sites: [site], identities: [] };
  const payload = planningPreparationEvidence(prepared, parts);
  const evidence = payload.sites[0];
  assert.equal(evidence.sourceId, 'scan-2');
  assert.equal(evidence.kind, 'terminal');
  assert.equal(evidence.fdi, null);
  assert.equal(evidence.relationships.adjacent.distal, null);
  assert.deepEqual(evidence.relationships.opposing.teeth.map(tooth => tooth.fdi), [26, 27]);
  assert.equal(evidence.relationships.opposing.poseVerified, false);
  assert.equal(evidence.space.sampledVertical, null);
  assert.doesNotMatch(JSON.stringify(payload), /private|centroid|patchFaces|123|789/);
  const result = localPlanningResult(prepared, parts);
  assert.equal(result.findings[0].category, 'data-quality');
  assert.match(result.findings[0].title, /Lower terminal ridge/);
  assert.deepEqual(result.designs, []);
  assert.deepEqual(result.actions, []);
});

test('neutral distal drafting preserves terminal review and exports its hypothesized one-sided width honestly', () => {
  const parts = [{ id: 'lower', role: 'lower', triangles: 8 }], teeth = emptyToothCase();
  const measure = { value: 4, unit: 'file units (u)', method: 'Hypothesized slot width from a continuous low ridge.' };
  const site = { id: 'distal', partId: 'lower', arch: 'lower', fdi: null, kind: 'distal-extension', status: 'identity-unresolved', confidence: 0,
    draftIdentity: { templateFdi: 36, alternatives: [46], basis: 'Illustrative shape only; review required.' },
    slot: { count: 1 }, anchor: { face: 3, point: [4, 0, 0] }, frame: {}, patchFaces: Uint32Array.of(3, 4, 5),
    adjacent: { mesial: { partId: 'lower', toothId: 1, fdi: null, confidence: 0 }, distal: null }, opposing: null, contralateral: null,
    evidence: { supporting: ['Locally supported ridge slot.'], conflicting: ['Clinical review required.'] }, questions: [],
    space: { mesiodistal: measure, buccolingual: measure, crownHeight: measure, vertical: measure, proximalGap: { ...measure, value: null, method: 'Unavailable two-flank clearance.' } } };
  const terminal = { ...site, id: 'terminal', kind: 'terminal', status: 'segmentation-unresolved', draftIdentity: undefined };
  const prepared = { revision: 'r1', scans: [], identities: [], sites: [terminal, site] }, before = structuredClone({ prepared, teeth });
  const evidence = planningPreparationEvidence(prepared, parts, .8, teeth);
  assert.deepEqual(evidence.sites.map(site => site.geometricDraftEligible), [false, true]);
  assert.equal(evidence.sites[1].fdi, null); assert.equal(evidence.sites[1].kind, 'distal-extension');
  assert.equal(evidence.sites[1].space.widthMethod, measure.method);
  const result = localPlanningResult(prepared, parts);
  assert.ok(result.findings.every(finding => finding.category === 'data-quality' && finding.needsClinicalReview));
  assert.deepEqual(result.designs, []);
  assert.deepEqual(automaticConceptSites({ sites: prepared.sites, teeth, counts: {}, parts, result }).map(site => site.id), ['distal']);
  for (const mutate of [s => { s.kind = 'terminal'; }, s => { delete s.draftIdentity; }, s => { s.status = 'segmentation-unresolved'; },
    s => { s.fdi = 37; }, s => { s.adjacent.mesial = null; }, s => { s.slot.count = 2; }]) {
    const invalid = structuredClone(site); mutate(invalid);
    assert.deepEqual(automaticConceptSites({ sites: [invalid], teeth, counts: {}, parts, result }), [], mutate.toString());
  }
  assert.deepEqual({ prepared, teeth }, before);
});

test('region evidence carries bounded local dimensions, flags, peaks, protected counts and candidate neighbors only', () => {
  const part = { id: 'patient-private-id', name: 'Patient Private Name', fileName: 'patient-private-file.ply', role: 'upper' };
  const teeth = Array.from({ length: 40 }, (_, index) => ({ id: index + 1, fdi: 17, sCenter: index * 5,
    mdWidth: 5 + index / 10, blWidth: 4, height: 3, peaks: index === 0 ? 0 : 2, kind: 'crown',
    faces: new Uint32Array([index * 3, index * 3 + 1, index * 3 + 2]), centroid: [123, 456, 789],
    flags: index === 0 ? [`Review boundary from ${part.fileName} (${part.id}).`] : [] }));
  const candidates = teeth.map(tooth => ({ id: tooth.id, faces: tooth.faces, warnings: [], seed: { point: tooth.centroid } }));
  const source = { partId: part.id, scan: { candidates, method: `Local ${part.name} analysis`, unassignedTriangles: 0 },
    analysis: { teeth, coverage: { boundaryFaces: 7 } } };
  const prepared = { scans: [source], sites: [], identities: teeth.map(tooth => ({ partId: part.id, candidateId: tooth.id,
    fdi: tooth.id === 1 ? null : tooth.fdi, confidence: .7, needsReview: true, blockingReasons: ['Local boundary review.'] })) };
  const reviewed = { teeth: {}, labels: { [part.id]: new Uint8Array(120) }, reviewedMask: { [part.id]: new Uint8Array(120) } };
  reviewed.labels[part.id][0] = 255; reviewed.reviewedMask[part.id][0] = 1; reviewed.reviewedMask[part.id][1] = 1;
  const before = structuredClone({ prepared, reviewed });
  const payload = planningPreparationEvidence(prepared, [part], .8, reviewed);
  assert.equal(payload.regions.length, 32);
  assert.deepEqual(payload.regions[0].dimensions, { mesiodistal: 5, buccolingual: 4, height: 3 });
  assert.equal(payload.regions[0].sourceId, 'scan-1'); assert.equal(payload.regions[0].candidateId, 1);
  assert.equal(payload.regions[0].fdi, null, 'an unresolved identity cannot fall back to stale analysis numbering');
  assert.equal(payload.regions[0].confidence, .7); assert.equal(payload.regions[0].needsReview, true);
  assert.equal(payload.regions[0].peaks, 0); assert.equal(payload.regions[0].protectedTriangles, 2);
  assert.match(payload.regions[0].flags.join(' '), /boundary/);
  assert.deepEqual(payload.regions[0].neighbors, [2]); assert.deepEqual(payload.regions[1].neighbors, [1, 3]); assert.deepEqual(payload.regions[31].neighbors, [31]);
  assert.equal(payload.sources[0].boundaryFaces, 7);
  assert.doesNotMatch(JSON.stringify(payload), /patient-private|Patient Private|\.ply|centroid|faces|seed|positions|123|456|789/);
  assert.deepEqual({ prepared, reviewed }, before);
});

test('unavailable region measurements stay null and long flags remain bounded', () => {
  const candidates = [{ id: 7, faces: new Uint32Array([0]), warnings: [] }];
  const source = { partId: 'source-a', scan: { candidates, method: 'Local grouping', unassignedTriangles: 0 }, analysis: null };
  const prepared = { scans: [source], sites: [], identities: [] }, parts = [{ id: 'source-a' }];
  const region = planningPreparationEvidence(prepared, parts).regions[0];
  assert.deepEqual(region.dimensions, { mesiodistal: null, buccolingual: null, height: null });
  assert.equal(region.peaks, null); assert.equal(region.kind, 'unresolved'); assert.equal(region.needsReview, true); assert.deepEqual(region.neighbors, []);
  source.analysis = { coverage: { boundaryFaces: 0 }, teeth: [{ id: 7, sCenter: 0, mdWidth: NaN, blWidth: Infinity, height: undefined, peaks: NaN, kind: 'crown', flags: Array.from({ length: 20 }, () => 'flag'.repeat(400)) }] };
  const measured = planningPreparationEvidence(prepared, parts).regions[0];
  assert.deepEqual(measured.dimensions, region.dimensions); assert.equal(measured.peaks, null);
  assert.ok(measured.flags.length <= 12 && measured.flags.every(flag => flag.length <= 600));
});
