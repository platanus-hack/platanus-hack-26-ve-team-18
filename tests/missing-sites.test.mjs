import test from 'node:test';
import assert from 'node:assert/strict';
import { proposeSites, invertRigid, multiply, isRigidPose } from '../src/missing-sites.ts';
const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const point = [4, 0, 0];
function fixture() {
  const positions = new Float32Array(9 * 9), s = new Float32Array(9);
  for (let f = 0; f < 9; f++) { s[f] = 3 + f / 4; positions.set([s[f], 0, 0, s[f] + .1, 0, 0, s[f], .1, 0], f * 9); }
  const tooth = (id, fdi, center) => ({ id, fdi, faces: new Uint32Array([0, 1]), centroid: [center, 0, 4], top: [center, 0, 6], axis: [0, 0, 1], s: [center - 1, center + 1], sCenter: center, mdWidth: 2, blWidth: 4, height: 4, cervicalLevel: 2, peaks: 1, crownScore: .9, kind: 'crown', flags: [] });
  const teeth = [tooth(1, 14, 2), tooth(2, 12, 6)];
  const analysis = {
    frame: { up: [0, 0, 1] }, anterior: { apexS: 8, direction: [1, 0, 0] }, scale: { bandHalfWidth: 2, cell: 1 },
    curve: { tangent: Array.from({ length: 16 }, () => [1, 0, 0]), lingual: Array.from({ length: 16 }, () => [0, 1, 0]), state: Array(16).fill('low') },
    teeth, classes: new Uint8Array(9).fill(3), gaps: [{ id: 'g1', kind: 'bounded', support: 'ridge', s: [3, 5], positions: [13], before: 1, after: 2, coverage: 1 }],
  };
  const model = {
    scale: 1, positions, faceS: s, faceT: new Float32Array(9), mesh: { valid: new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8]) },
    profile: { topT: new Float32Array(16) }, H: new Float32Array(16).fill(-10),
    sampleAt: value => Math.max(0, Math.min(15, Math.round(value))), at: (x, y) => [x, y], plan: value => value,
    cellIndex: () => 0, surfaceAt: (x, y) => ({ face: 0, point: [x, y, 0], height: 0 }),
  };
  const numbering = { scale: 2 / 7.6, sequence: [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28], groups: [{ kind: 'gap', positions: [13], confidence: .9, alternatives: [] }] };
  return { partId: 'upper-opaque-source', arch: 'upper', model, analysis, numbering, pose: identity.slice(), identityConfidence: 1 };
}
const options = { chart: {}, poseVerified: false };

test('a bounded scanned ridge yields a data-only proposed site with source-local frame and measures', () => {
  const sites = proposeSites([fixture()], options);
  assert.equal(sites.length, 1);
  const site = sites[0];
  assert.equal(site.status, 'proposed-missing'); assert.equal(site.fdi, 13); assert.equal(site.kind, 'bounded');
  assert.deepEqual(site.anchor.point, point); assert.equal(site.patchFaces.length, 9);
  assert.deepEqual(site.frame, { origin: point, u: [1, 0, 0], v: [0, 1, 0], up: [0, 0, 1] });
  assert.equal(site.space.mesiodistal.value, 2); assert.equal(site.space.buccolingual.value, 4); assert.equal(site.space.vertical.value, null);
  assert.ok(Object.values(site.space).every(value => value.unit === 'file units (u)'));
});

test('unscanned, mixed, absent localization and segmentation failure never become automatic missing teeth', () => {
  for (const failure of ['unscanned', 'mixed', 'no-surface', 'boundary-only', 'crown-in-gap']) {
    const input = fixture();
    if (failure === 'unscanned') { input.analysis.gaps[0].support = 'not-scanned'; input.analysis.gaps[0].coverage = 0; }
    if (failure === 'mixed') { input.analysis.gaps[0].support = 'mixed'; input.analysis.gaps[0].coverage = .5; }
    if (failure === 'no-surface') input.model.surfaceAt = () => null;
    if (failure === 'boundary-only') input.analysis.classes.fill(5);
    if (failure === 'crown-in-gap') input.analysis.teeth.push({ ...input.analysis.teeth[0], id: 3, fdi: null, sCenter: 4 });
    const [site] = proposeSites([input], options);
    assert.notEqual(site.status, 'proposed-missing', failure); assert.equal(site.confidence, 0, failure);
    if (failure === 'unscanned') { assert.equal(site.status, 'not-scanned'); assert.equal(site.anchor, null); }
  }
});

test('a terminal tag on a two-flank gap does not manufacture a terminal region', () => {
  for (const kind of ['terminal-start', 'terminal-end']) for (const positions of [[], [13]]) {
    const input = fixture(); input.analysis.gaps[0] = { ...input.analysis.gaps[0], kind, positions };
    assert.deepEqual(proposeSites([input], options), []);
  }
});

function terminalFixture(kind = 'terminal-end', arch = 'lower') {
  const input = fixture(), end = kind === 'terminal-end';
  input.arch = arch; input.partId = `${arch}-terminal`;
  input.identityConfirmed = false;
  const flank = input.analysis.teeth[end ? 0 : 1];
  flank.fdi = arch === 'lower' ? end ? 36 : 46 : end ? 26 : 16;
  input.analysis.teeth = [flank];
  input.analysis.anterior.apexS = end ? 0 : 8;
  input.analysis.gaps[0] = { ...input.analysis.gaps[0], kind, before: end ? flank.id : null, after: end ? null : flank.id, positions: [] };
  input.numbering.sequence = arch === 'lower' ? [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38] : [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28];
  input.numbering.groups = [{ kind: 'tooth', fdi: flank.fdi, confidence: .9 }];
  return input;
}

function distalFixture(end = true) {
  const input = terminalFixture(end ? 'terminal-end' : 'terminal-start');
  input.roleConfirmed = true;
  const n = 81, s = Float32Array.from({ length: n }, (_, i) => 3 + i / 20), positions = new Float32Array(n * 9);
  for (let f = 0; f < n; f++) positions.set([s[f], -2, 0, s[f] + .05, -2, 0, s[f], 2, 0], f * 9);
  const sampleS = Array.from({ length: 41 }, (_, i) => 3 + i / 10);
  input.analysis.curve = { ...input.analysis.curve, s: sampleS,
    tangent: sampleS.map(() => [1, 0, 0]), lingual: sampleS.map(() => [0, 1, 0]),
    state: sampleS.map(value => (end ? value : 10 - value) > 4.8 && (end ? value : 10 - value) < 6 ? 'crown' : 'low') };
  Object.assign(input.model, { positions, faceS: s, faceT: new Float32Array(n), profile: { topT: new Float32Array(41) },
    mesh: { valid: Uint32Array.from({ length: n }, (_, i) => i) }, sampleAt: value => Math.max(0, Math.min(40, Math.round((value - 3) * 10))) });
  input.model.surfaceAt = (x, y, _radius, accept = () => true) => {
    const face = [...input.model.mesh.valid].filter(accept).sort((a, b) => Math.abs(s[a] - x) - Math.abs(s[b] - x))[0];
    return face === undefined ? null : { face, point: [s[face], y, 0], height: 0 };
  };
  input.analysis.classes = Uint8Array.from(s, value => input.analysis.curve.state[input.model.sampleAt(value)] === 'low' ? 3 : 8);
  Object.assign(input.analysis.gaps[0], { s: [3, 7], support: 'soft-tissue', ridgeHeight: -.5 });
  Object.assign(input.analysis.scale, { cell: .1, toothWidth: 2 });
  const flank = input.analysis.teeth[0];
  Object.assign(flank, { faces: Uint32Array.from({ length: 12 }, (_, i) => i), s: end ? [1, 3] : [7, 9], sCenter: end ? 2 : 8, centroid: [end ? 2 : 8, 0, 2] });
  const opposite = fixture(); opposite.partId = 'opposite'; opposite.model.up = [0, 0, -1];
  opposite.analysis.frame.up = [0, 0, -1]; opposite.analysis.gaps = [];
  opposite.model.plan = ([x, y, z]) => [x, y, -z]; opposite.model.H.fill(-3);
  opposite.model.positions = positions.slice();
  for (let i = 2; i < positions.length; i += 3) opposite.model.positions[i] = 3;
  opposite.analysis.teeth = [{ ...opposite.analysis.teeth[0], faces: Uint32Array.from({ length: n }, (_, i) => i), axis: [0, 0, -1] }];
  return [input, opposite];
}

test('a supported free-end slot coexists with terminal review, stops at the first rise, and never asserts an FDI', () => {
  for (const end of [true, false]) {
    const inputs = distalFixture(end), before = structuredClone(inputs[0].analysis);
    const sites = proposeSites(inputs, options), draft = sites.find(site => site.kind === 'distal-extension');
    const review = sites.find(site => site.kind === 'terminal');
    assert.ok(review && draft); assert.notEqual(draft.id, review.id);
    assert.equal(review.draftIdentity, undefined); assert.equal(review.status, 'segmentation-unresolved');
    assert.deepEqual(review.slot.s, [3, 7]); assert.equal(draft.fdi, null);
    assert.equal(draft.status, 'identity-unresolved'); assert.equal(draft.priority, 'low'); assert.equal(draft.confidence, 0);
    assert.equal(draft.draftIdentity.templateFdi, 36); assert.equal(draft.slot.count, 1);
    assert.ok(draft.adjacent.mesial); assert.equal(draft.adjacent.distal, null);
    assert.ok(end ? draft.slot.s[0] === 3 && draft.slot.s[1] < 4.8 : draft.slot.s[1] === 7 && draft.slot.s[0] > 5.2);
    assert.equal(draft.space.proximalGap.value, null); assert.equal(draft.space.mesiodistal.provenance, 'hypothesized');
    assert.match(draft.space.mesiodistal.method, /first continuous low-ridge/);
    assert.ok(draft.opposing.teeth.length && draft.space.vertical.sampleCount >= 3);
    assert.match(draft.evidence.conflicting.join(' '), /not a diagnosis or a treatment plan/);
    assert.deepEqual(inputs[0].analysis, before);
  }
});

test('unsupported terminal contexts cannot gain a distal draft through a remote low patch or neutral template', () => {
  const mutations = [
    ([input]) => { input.analysis.anterior.apexS = null; },
    ([input]) => { input.analysis.gaps[0].ridgeHeight = .1; },
    ([input]) => { input.analysis.gaps[0].ridgeHeight = null; },
    ([input]) => { input.analysis.gaps[0].coverage = .89; },
    ([input]) => { input.analysis.gaps[0].support = 'mixed'; },
    ([input]) => { input.analysis.curve.state[2] = 'unscanned'; },
    ([input]) => { input.analysis.curve.state[0] = 'crown'; },
    ([input]) => { input.analysis.teeth[0].flags = ['Boundary unresolved']; },
    ([input]) => { input.analysis.teeth[0].kind = 'restoration-like'; },
    ([input]) => { input.analysis.teeth[0].crownScore = .5; },
    ([input]) => { input.analysis.teeth[0].s[1] -= .3; },
    ([input]) => { input.analysis.classes[15] = 1; input.model.surfaceAt = () => ({ face: 15, point: [3.75, 0, 0] }); },
    ([input]) => { input.analysis.classes.fill(8, 20, 29); },
    ([input]) => { input.reviewedLabels = new Uint8Array(81); input.reviewedLabels[15] = 31; },
    ([input]) => { input.reviewedMask = new Uint8Array(81); input.reviewedMask[15] = 1; },
    ([input]) => { input.reviewedMask = new Uint8Array(81); input.reviewedMask[0] = 1; },
    (inputs) => { inputs.pop(); },
    ([, opposite]) => { opposite.analysis.teeth = []; },
    ([, opposite]) => { opposite.model.H.fill(NaN); },
    ([, opposite]) => { opposite.pose[0] = 2; },
    ([input]) => { input.identityConfirmed = true; input.analysis.teeth[0].fdi = 37; input.numbering.groups[0].fdi = 37; },
  ];
  for (const mutate of mutations) {
    const inputs = distalFixture(); mutate(inputs);
    assert.ok(proposeSites(inputs, options).every(site => site.kind !== 'distal-extension'), mutate.toString());
  }
});

test('filename-role distal slots remain neutral local drafts without inventing opposing or vertical evidence', () => {
  for (const end of [true, false]) for (const withOtherScan of [true, false]) {
    const inputs = distalFixture(end); inputs.forEach(input => { input.roleConfirmed = false; });
    if (!withOtherScan) inputs.pop();
    const site = proposeSites(inputs, options).find(site => site.kind === 'distal-extension');
    assert.ok(site); assert.equal(site.fdi, null); assert.equal(site.status, 'identity-unresolved');
    assert.ok(site.draftIdentity); assert.equal(site.confidence, 0);
    assert.equal(site.opposing, null); assert.equal(site.space.vertical.value, null);
    assert.equal(site.space.vertical.provenance, 'unknown'); assert.equal(site.space.vertical.sampleCount, 0);
    assert.match(site.evidence.conflicting.join(' '), /arch role is unconfirmed.*vertical room are unavailable/);
    assert.doesNotMatch(site.evidence.supporting.join(' '), /opposing.*evidence|opposing crown/);
    // Unknown role never bypasses the independent local-support gates.
    inputs[0].analysis.curve.state[end ? 2 : 38] = 'unscanned';
    assert.ok(proposeSites(inputs, options).every(site => site.kind !== 'distal-extension'));
  }
});

test('scanned one-flank terminal ridges yield localized anonymous review regions on either arch and end', () => {
  for (const arch of ['upper', 'lower']) for (const kind of ['terminal-start', 'terminal-end']) {
    const input = terminalFixture(kind, arch), original = structuredClone(input.analysis.gaps);
    const [site] = proposeSites([input], options);
    assert.equal(site.kind, 'terminal'); assert.equal(site.arch, arch); assert.equal(site.fdi, null);
    assert.equal(site.status, 'identity-unresolved'); assert.equal(site.priority, 'low');
    assert.ok(site.confidence > 0 && site.confidence <= .3); assert.equal(site.draftIdentity, undefined);
    assert.deepEqual(site.slot, { index: 0, count: 1, s: [3, 5] });
    assert.deepEqual(site.anchor.point, [4, 0, 0]); assert.deepEqual(site.frame.origin, site.anchor.point);
    assert.equal(site.patchFaces.length, 9); assert.equal(site.space.proximalGap.value, null);
    assert.equal([site.adjacent.mesial, site.adjacent.distal].filter(Boolean).length, 1);
    assert.match(site.space.mesiodistal.method, /review-region span/);
    assert.match(site.evidence.conflicting.join(' '), /insufficient evidence of a missing tooth or an implant indication/);
    assert.match(site.evidence.conflicting.join(' '), /no absent FDI or tooth count/);
    assert.match(site.questions.join(' '), /retromolar.*previously present.*which position/);
    assert.doesNotMatch(JSON.stringify(site.evidence), /FDI null|NaN|Infinity/);
    assert.deepEqual(input.analysis.gaps, original);
  }
});

test('terminal numbering remains unresolved unless the sole position and flank sequence are reliable', () => {
  for (const positions of [[], [37], [37, 38], [38], [17], [39]]) {
    const input = terminalFixture(); input.analysis.gaps[0].positions = positions;
    input.numbering.groups.push({ kind: 'gap', positions, confidence: .95, alternatives: [] });
    const [site] = proposeSites([input], options);
    assert.equal(site.fdi, null); assert.equal(site.status, 'identity-unresolved'); assert.equal(site.draftIdentity, undefined);
  }
  const input = terminalFixture(); input.identityConfirmed = true;
  input.analysis.gaps[0].positions = [37]; input.numbering.groups.push({ kind: 'gap', positions: [37], confidence: .95, alternatives: [] });
  let [site] = proposeSites([input], options);
  assert.equal(site.fdi, 37); assert.equal(site.status, 'identity-unresolved'); assert.equal(site.draftIdentity, undefined);
  [site] = proposeSites([input], { ...options, chart: { 37: { status: 'present' } } });
  assert.match(site.evidence.conflicting.join(' '), /saved chart.*present/);
  assert.deepEqual(proposeSites([input], { ...options, chart: { 37: { status: 'not-scanned' } } }), []);
  input.numbering.groups[1].alternatives = [35];
  [site] = proposeSites([input], options); assert.equal(site.fdi, null);
});

test('terminal review requires a substantial adjacent low ridge rather than an edge, protrusion or debris', () => {
  const cases = [
    input => { input.analysis.gaps[0].support = 'not-scanned'; },
    input => { input.analysis.gaps[0].coverage = .2; },
    ...[1, 5, 6, 8].map(code => input => input.analysis.classes.fill(code)),
    input => { input.model.surfaceAt = () => null; },
    input => input.model.faceS.fill(4),
    input => { input.analysis.gaps[0].s = [3, 3.2]; },
    input => { input.analysis.teeth[0].s = [-5, -3]; },
    input => { input.analysis.gaps[0].before = null; },
  ];
  for (const change of cases) {
    const input = terminalFixture(); change(input);
    assert.deepEqual(proposeSites([input], options), [], change.toString());
  }
});

test('mixed and tissue-labeled terminal groups retain only supported low ridge patches for segmentation review', () => {
  for (const support of ['mixed', 'soft-tissue']) {
    const input = terminalFixture(); input.analysis.gaps[0].support = support;
    input.analysis.gaps[0].coverage = .7;
    const [site] = proposeSites([input], options);
    assert.equal(site.status, 'segmentation-unresolved'); assert.ok(site.confidence > 0 && site.confidence <= .15);
    assert.ok(site.anchor && site.frame && site.patchFaces.length); assert.equal(site.fdi, null);
    assert.match(site.evidence.conflicting.join(' '), /mixed or tissue-like/);
  }
  const input = terminalFixture(); input.reviewedMask = new Uint8Array(9); input.reviewedMask[4] = 1;
  const [site] = proposeSites([input], options);
  assert.equal(site.status, 'segmentation-unresolved'); assert.equal(site.confidence, 0);
  assert.equal(site.patchFaces.includes(4), false);
});

test('reliable second/third molar flanks and isolated third molar positions do not create terminal drafts', () => {
  for (const kind of ['terminal-start', 'terminal-end']) for (const digit of [7, 8]) {
    const input = terminalFixture(kind); input.identityConfirmed = true;
    input.analysis.teeth[0].fdi = (kind === 'terminal-start' ? 40 : 30) + digit;
    input.numbering.groups[0].fdi = input.analysis.teeth[0].fdi;
    assert.deepEqual(proposeSites([input], options), []);
  }
  const input = terminalFixture(); input.identityConfirmed = true;
  input.analysis.gaps[0].positions = [37]; input.numbering.groups.push({ kind: 'gap', positions: [37], confidence: .95, alternatives: [] });
  const anchor = { partId: input.partId, face: 8, point: [5, 0, 0] };
  const sites = proposeSites([input], { ...options, chart: { 37: { status: 'missing', site: anchor } } });
  assert.equal(sites.length, 1); assert.equal(sites[0].kind, 'chart'); assert.deepEqual(sites[0].anchor, anchor);
});

test('saved missing-site anchors are preserved rather than replaced by a fitted slot', () => {
  const input = fixture(), site = { partId: input.partId, face: 7, point: [3.5, 1, 0] };
  const chart = { 13: { status: 'missing', restoration: 'implant', note: '', site } };
  const [result] = proposeSites([input], { ...options, chart });
  assert.equal(result.kind, 'chart'); assert.equal(result.status, 'dentist-confirmed-missing'); assert.deepEqual(result.anchor, site);
  assert.equal(result.frame, null, 'an automatic frame must not silently shift a saved anchor');
  assert.deepEqual(chart[13].site, site);
});

test('a corrected crown identity cannot simultaneously become a proposed missing position', () => {
  const input = fixture(); input.analysis.teeth[0].fdi = 13;
  const [site] = proposeSites([input], options);
  assert.equal(site.status, 'identity-unresolved'); assert.match(site.evidence.conflicting.join(' '), /already carries this identity/);
});

test('rigid inversion rejects scaling, reflection, shear and invalid/projective matrices', () => {
  const pose = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 2, 3, 4, 1];
  assert.ok(isRigidPose(pose)); assert.deepEqual(multiply(invertRigid(pose), pose), identity);
  for (const change of [m => { m[0] = 2; }, m => { m[0] = -1; }, m => { m[4] = .2; }, m => { m[3] = .1; }, m => { m[12] = NaN; }, m => { m.pop(); }]) {
    const bad = identity.slice(); change(bad); assert.equal(isRigidPose(bad), false); assert.throws(() => invertRigid(bad), /rigid/);
    const input = fixture(), opposite = fixture(); opposite.partId = 'opposite'; opposite.arch = 'lower'; opposite.pose = bad;
    const site = proposeSites([input, opposite], options).find(site => site.partId === input.partId);
    assert.equal(site.space.vertical.value, null); assert.equal(site.opposing, null); assert.match(site.evidence.conflicting.join(' '), /unavailable/);
  }
});

test('ridge localization cannot anchor onto a crown, protected correction or a narrow fragment of a slot', () => {
  for (const failure of ['crown-anchor', 'reviewed-tooth', 'protected-zero', 'clustered-ridge']) {
    const input = fixture();
    if (failure === 'crown-anchor') input.analysis.classes[0] = 1;
    if (failure === 'reviewed-tooth') { input.reviewedLabels = new Uint8Array(9); input.reviewedLabels[4] = 13; }
    if (failure === 'protected-zero') { input.reviewedMask = new Uint8Array(9); input.reviewedMask[4] = 1; }
    if (failure === 'clustered-ridge') input.model.faceS.fill(4);
    const [site] = proposeSites([input], options);
    assert.equal(site.status, 'segmentation-unresolved', failure); assert.equal(site.confidence, 0, failure);
    if (failure === 'crown-anchor') { assert.equal(site.anchor, null); assert.equal(site.frame, null); }
  }
  const [zeroLabels] = proposeSites([{ ...fixture(), reviewedLabels: new Uint8Array(9) }], options);
  assert.equal(zeroLabels.status, 'proposed-missing', 'zero labels are neutral; geometric ridge evidence is still required');
});

function consecutiveFixture() {
  const input = fixture();
  const n = 33, positions = new Float32Array(n * 9), s = new Float32Array(n);
  for (let f = 0; f < n; f++) { s[f] = 3 + 4 * f / (n - 1); positions.set([s[f], 0, 0, s[f] + .1, 0, 0, s[f], .1, 0], f * 9); }
  Object.assign(input.model, { positions, faceS: s, faceT: new Float32Array(n), mesh: { valid: Uint32Array.from({ length: n }, (_, f) => f) } });
  input.model.surfaceAt = (x, y, _radius, accept = () => true) => {
    const faces = Array.from(input.model.mesh.valid).filter(accept).sort((a, b) => Math.abs(s[a] - x) - Math.abs(s[b] - x));
    return faces.length ? { face: faces[0], point: [s[faces[0]], y, 0], height: 0 } : null;
  };
  input.analysis.classes = new Uint8Array(n).fill(3);
  input.analysis.teeth[1] = { ...input.analysis.teeth[1], fdi: 11, centroid: [8, 0, 4], s: [7, 9], sCenter: 8 };
  input.analysis.gaps[0] = { ...input.analysis.gaps[0], s: [3, 7], positions: [13, 12] };
  input.numbering.groups[0].positions = [13, 12]; input.numbering.scale = 4 / (7.6 + 6.6);
  return input;
}

test('consecutive positions get disjoint proportional source-local slots with independent ridge support', () => {
  const input = consecutiveFixture(), original = structuredClone(input.analysis.gaps);
  const sites = proposeSites([input], options).sort((a, b) => a.slot.index - b.slot.index);
  assert.equal(sites.length, 2);
  assert.deepEqual(sites.map(site => site.fdi), [13, 12]);
  assert.ok(sites.every(site => site.status === 'proposed-missing' && site.anchor && site.slot.count === 2));
  assert.equal(sites[0].slot.s[1], sites[1].slot.s[0]);
  assert.ok(Math.abs(sites[0].space.mesiodistal.value / sites[1].space.mesiodistal.value - 7.6 / 6.6) < .001);
  const shared = sites[0].patchFaces.filter(face => sites[1].patchFaces.includes(face)); assert.equal(shared.length, 0);
  assert.deepEqual(input.analysis.gaps, original);
  assert.equal(sites[0].space.buccolingual.provenance, 'hypothesized');
  assert.equal(sites[0].space.mesiodistal.provenance, 'hypothesized');
  assert.equal(sites[0].space.crownHeight.provenance, 'hypothesized');
  assert.equal(sites[0].frameEvidence.status, 'hypothesized');
});

for (const count of [2, 3]) for (const reverse of [false, true]) {
  test(`${count}-slot bounded gaps retain only immediate scanned neighbors in ${reverse ? 'reversed' : 'forward'} curve order`, () => {
    for (const useApex of [true, false]) {
      const input = consecutiveFixture(), gap = input.analysis.gaps[0];
      if (count === 3) {
        input.analysis.teeth[0].fdi = 15;
        gap.positions = [14, 13, 12];
        input.numbering.scale = 4 / (7 + 7.6 + 6.6);
      }
      const [distalFlank, mesialFlank] = input.analysis.teeth;
      distalFlank.axis = [0, .6, .8]; mesialFlank.axis = [0, -.6, .8];
      mesialFlank.blWidth = 8; mesialFlank.height = 6;
      if (reverse) {
        // Reverse arc parameterization while keeping the source geometry and
        // anatomical anterior direction fixed.
        input.model.faceS = input.model.faceS.map(s => 10 - s);
        input.model.at = (s, t) => [10 - s, t];
        input.analysis.curve.tangent = input.analysis.curve.tangent.map(() => [-1, 0, 0]);
        input.analysis.anterior.apexS = 10 - input.analysis.anterior.apexS;
        for (const tooth of input.analysis.teeth) {
          tooth.s = [10 - tooth.s[1], 10 - tooth.s[0]]; tooth.sCenter = 10 - tooth.sCenter;
        }
        [gap.before, gap.after] = [gap.after, gap.before];
        gap.positions.reverse(); input.numbering.sequence.reverse();
      }
      if (!useApex) input.analysis.anterior.apexS = null;
      input.numbering.groups[0].positions = [...gap.positions];
      const original = structuredClone(input.analysis.gaps);
      const sites = proposeSites([input], options).sort((a, b) => a.slot.index - b.slot.index);
      const expected = [{ mesial: null, distal: distalFlank.id }];
      if (count === 3) expected.push({ mesial: null, distal: null });
      expected.push({ mesial: mesialFlank.id, distal: null });
      if (reverse) expected.reverse();
      assert.deepEqual(sites.map(site => ({ mesial: site.adjacent.mesial?.toothId ?? null, distal: site.adjacent.distal?.toothId ?? null })), expected);
      assert.deepEqual(sites.map(site => site.fdi), gap.positions);
      assert.equal(sites.length, count);
      for (const site of sites) {
        assert.equal(site.mesialSign, reverse ? -1 : 1);
        assert.equal(site.status, 'proposed-missing'); assert.ok(site.anchor);
        assert.equal(site.space.buccolingual.value, 6); assert.equal(site.space.crownHeight.value, 5);
        assert.equal(site.space.proximalGap.value, null);
        assert.deepEqual(site.frame.up, [0, 0, 1]);
        assert.match(site.frameBasis, /averaged from 2/);
        assert.match(site.evidence.supporting.join(' '), /whole gap bounds.*not immediate contacts/i);
        for (const flank of [distalFlank, mesialFlank]) assert.match(site.evidence.supporting.join(' '), new RegExp(`FDI ${flank.fdi}`));
      }
      assert.deepEqual(input.analysis.gaps, original);
    }
  });
}

test('file-unit distances and site spans do not round a small valid case down to zero', () => {
  const input = fixture(), scale = 1e-8;
  input.model.scale = scale; input.numbering.scale *= scale;
  input.model.positions = input.model.positions.map(value => value * scale);
  input.analysis.gaps[0].s = input.analysis.gaps[0].s.map(value => value * scale);
  input.analysis.anterior.apexS *= scale;
  input.analysis.teeth = input.analysis.teeth.map(tooth => ({ ...tooth, centroid: tooth.centroid.map(value => value * scale), s: tooth.s.map(value => value * scale), sCenter: tooth.sCenter * scale, mdWidth: tooth.mdWidth * scale, blWidth: tooth.blWidth * scale, height: tooth.height * scale }));
  input.model.surfaceAt = (x, y) => ({ face: 0, point: [x * scale, y * scale, 0], height: 0 });
  const [site] = proposeSites([input], options);
  assert.equal(site.status, 'proposed-missing');
  assert.ok(Math.abs(site.space.mesiodistal.value / scale - 2) < 1e-12);
  assert.ok(site.slot.s[1] > site.slot.s[0]); assert.ok(site.space.buccolingual.value > 0);
});

test('partial coverage in a consecutive gap does not borrow the adjacent slot ridge as an anchor', () => {
  const input = consecutiveFixture();
  for (let f = 0; f < input.analysis.classes.length; f++) if (input.model.faceS[f] > 5.15) input.analysis.classes[f] = 5;
  const sites = proposeSites([input], options).sort((a, b) => a.slot.index - b.slot.index);
  assert.equal(sites[0].status, 'proposed-missing');
  assert.equal(sites[1].status, 'segmentation-unresolved'); assert.equal(sites[1].anchor, null); assert.equal(sites[1].confidence, 0);
  input.analysis.gaps[0].coverage = 0; input.analysis.gaps[0].support = 'not-scanned';
  const unscanned = proposeSites([input], options).sort((a, b) => a.slot.index - b.slot.index);
  assert.ok(unscanned.every(site => site.status === 'not-scanned' && site.anchor === null));
  assert.equal(unscanned[0].slot.s[1], unscanned[1].slot.s[0]);
});

test('a terminal chart absence remains visible without manufacturing a terminal ridge frame or erasing its anchor', () => {
  const input = fixture(); input.analysis.gaps[0].kind = 'terminal-end';
  const site = { partId: input.partId, face: 8, point: [5, 0, 0] };
  const sites = proposeSites([input], { ...options, chart: { 13: { status: 'missing', site } } });
  assert.equal(sites.length, 1); assert.equal(sites[0].kind, 'chart'); assert.equal(sites[0].frame, null); assert.deepEqual(sites[0].anchor, site);
});

test('degenerate site tangents do not produce a fabricated coordinate frame', () => {
  const input = fixture(); input.analysis.curve.tangent = input.analysis.curve.tangent.map(() => [0, 0, 1]);
  const [site] = proposeSites([input], options);
  assert.equal(site.frame, null); assert.equal(site.frameEvidence.status, 'unavailable');
  assert.match(site.evidence.conflicting.join(' '), /degenerate/);
});

test('valid poses alone cannot establish opposed occlusal axes or a reviewed bite', () => {
  const input = fixture(), other = fixture(); other.partId = 'lower'; other.arch = 'lower';
  let site = proposeSites([input, other], options).find(site => site.partId === input.partId);
  assert.equal(site.space.vertical.value, null); assert.equal(site.opposing.poseVerified, false);
  assert.match(site.evidence.conflicting.join(' '), /do not face/);
  other.analysis.frame.up = [0, 0, -1];
  site = proposeSites([input, other], options).find(site => site.partId === input.partId);
  assert.equal(site.space.vertical.value, 10); assert.equal(site.opposing.poseVerified, false);
  assert.equal(site.space.vertical.sampleCount, 9);
  assert.match(site.evidence.conflicting.join(' '), /bite pose is not verified/);
  other.model.occupied = new Uint8Array(16);
  site = proposeSites([input, other], options).find(site => site.partId === input.partId);
  assert.equal(site.space.vertical.value, null); assert.equal(site.space.vertical.sampleCount, 0, 'interpolated height-map holes are not observed antagonist samples');
  other.roleConfirmed = false;
  site = proposeSites([input, other], options).find(site => site.partId === input.partId);
  assert.equal(site.opposing, null); assert.equal(site.space.vertical.value, null);
});

function flankFixture() {
  const input = fixture();
  const wall = x => [x, -2, 1, x, 2, 1, x, 2, 5, x, -2, 1, x, 2, 5, x, -2, 5];
  input.model.positions = Float32Array.from([...input.model.positions, ...wall(3.4), ...wall(4.9)]);
  input.analysis.teeth[0].faces = Uint32Array.of(9, 10); input.analysis.teeth[1].faces = Uint32Array.of(11, 12);
  return input;
}

test('flank triangle envelopes center the supported ridge without mistaking arc span or centroid distance for width', () => {
  for (const reverse of [false, true]) {
    const input = flankFixture();
    for (const tooth of input.analysis.teeth) {
      tooth.faces = Uint32Array.from({ length: 3000 }, (_, i) => tooth.faces[i % 2]);
      if (reverse) tooth.faces.reverse();
      tooth.centroid[0] += 1000; // Centroids cannot determine this surface gap.
    }
    const [result] = proposeSites([input], options);
    assert.ok(Math.abs(result.space.proximalGap.value - 1.5) < 1e-6);
    assert.equal(result.space.mesiodistal.value, 2, 'arc span remains separate evidence');
    assert.ok(Math.abs(result.anchor.point[0] - 4.15) < 1e-6);
    assert.deepEqual(result.frame.origin, result.anchor.point);
    assert.match(result.frameBasis, /midpoint between facing flank surfaces/);
    assert.match(result.space.proximalGap.method, /original flank triangles/);
  }
});

test('an unavailable ridge midpoint keeps the anchor and uses the smaller asymmetric side of the gap', () => {
  const input = flankFixture();
  input.model.surfaceAt = () => ({ face: 0, point: [4, 0, 0], height: 0 });
  const [result] = proposeSites([input], options);
  assert.deepEqual(result.anchor.point, [4, 0, 0]);
  assert.ok(Math.abs(result.space.proximalGap.value - 1.2) < 1e-6);
});

test('vertical envelope converts opposing-axis samples and varying ridge heights to one site-axis datum', () => {
  const input = fixture(), other = fixture(); other.partId = 'lower'; other.arch = 'lower';
  other.analysis.gaps = []; other.model.up = other.analysis.frame.up = [.6, 0, -.8];
  const plan = ([x, y, z]) => [.8 * x + .6 * z, y, .6 * x - .8 * z];
  other.model.plan = plan; other.model.H = Float32Array.of(-10);
  input.model.surfaceAt = (x, y) => ({ face: 0, point: [x, y, x - 4], height: x - 4 });
  const [result] = proposeSites([input, other], options);
  // At x=3.4 the ridge is z=-.6. Opposing axial offset 12.52 projects
  // to 10.016 on site up; relative to the fixed site datum it is 9.416.
  assert.ok(Math.abs(result.space.vertical.value - 9.416) < 1e-9);
  assert.equal(result.space.vertical.sampleCount, 9);
  assert.match(result.space.vertical.method, /provisional; bite unverified/);
  assert.match(result.space.vertical.method, /not ray clearance/);
  const common = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 50, -17, 8, 1];
  input.pose = common; other.pose = common;
  const [moved] = proposeSites([input, other], options);
  assert.equal(moved.space.vertical.value, result.space.vertical.value);
});

test('flank measurements and their surface midpoint scale and rotate with the source frame', () => {
  const base = proposeSites([flankFixture()], options)[0];
  for (const scale of [1e-8, 3]) {
    const input = flankFixture(), originalSurface = input.model.surfaceAt;
    const point = ([x, y, z]) => [scale * (10 - y), scale * (20 + z), scale * (30 - x)];
    const direction = ([x, y, z]) => [-y, z, -x];
    input.model.scale = scale; input.numbering.scale *= scale;
    input.model.plan = ([x, y, z]) => [30 - z / scale, 10 - x / scale, y / scale - 20];
    for (let i = 0; i < input.model.positions.length; i += 3) input.model.positions.set(point(input.model.positions.slice(i, i + 3)), i);
    input.model.surfaceAt = (...args) => { const sample = originalSurface(...args); return { ...sample, point: point(sample.point) }; };
    input.analysis.frame.up = direction(input.analysis.frame.up);
    input.analysis.anterior.apexS *= scale;
    input.analysis.anterior.direction = direction(input.analysis.anterior.direction);
    for (const field of ['tangent', 'lingual']) input.analysis.curve[field] = input.analysis.curve[field].map(direction);
    input.analysis.gaps[0].s = input.analysis.gaps[0].s.map(value => value * scale);
    for (const tooth of input.analysis.teeth) {
      tooth.axis = direction(tooth.axis); tooth.sCenter *= scale; tooth.s = tooth.s.map(value => value * scale);
      for (const field of ['mdWidth', 'blWidth', 'height']) tooth[field] *= scale;
    }
    const [result] = proposeSites([input], options);
    assert.ok(Math.abs(result.space.proximalGap.value / scale - base.space.proximalGap.value) < 3e-6);
    const expected = point(base.anchor.point);
    expected.forEach((value, axis) => assert.ok(Math.abs(result.anchor.point[axis] - value) < scale * 3e-6));
  }
});

test('an exact internal slot boundary belongs to only the following ridge patch', () => {
  const input = consecutiveFixture();
  const boundary = 3 + 4 * 7.6 / (7.6 + 6.6);
  input.model.faceS = Float64Array.from(input.model.faceS); input.model.faceS[16] = boundary;
  const sites = proposeSites([input], options).sort((a, b) => a.slot.index - b.slot.index);
  assert.equal(sites[0].patchFaces.includes(16), false);
  assert.equal(sites[1].patchFaces.includes(16), true);
});

function opponentFixture(triangles = [
  [1, -1, 7, 7, -1, 7, 4, 1, 7],
  [4, -1, 8, 5, 0, 8, 4, 1, 8],
  [9, -1, 8, 10, 0, 8, 9, 1, 8],
]) {
  const input = fixture(), other = fixture();
  for (const tooth of input.analysis.teeth) tooth.faces = new Uint32Array();
  other.arch = 'lower'; other.partId = 'lower-opponents'; other.analysis.gaps = [];
  other.model.up = other.analysis.frame.up = [0, 0, -1];
  other.model.positions = Float32Array.from(triangles.flat());
  other.analysis.teeth = triangles.map((_, id) => ({ ...other.analysis.teeth[0], id: id + 1, fdi: id ? null : 44, axis: [0, 0, -1], centroid: [4, 0, 8], faces: Uint32Array.of(id) }));
  other.identities = Object.fromEntries(other.analysis.teeth.map(tooth => [tooth.id, { fdi: tooth.fdi, confidence: .7 }]));
  return [input, other];
}
const opponents = (arches, verified = false) => proposeSites(arches, { ...options, poseVerified: verified }).find(site => site.partId === arches[0].partId);

test('multiple posed overlapping crowns qualify independently of centroids, FDI identity or exact contact', () => {
  const arches = opponentFixture(), other = arches[1];
  other.analysis.teeth[0].centroid = [1000, 0, 7]; other.analysis.teeth[1].centroid = [-1000, 0, 8];
  let site = opponents(arches);
  assert.deepEqual(site.opposing.teeth.map(tooth => tooth.toothId), [1, 2]);
  assert.deepEqual(site.opposing.teeth[0].centroid, [1000, 0, 7], 'returned centroids retain their source coordinates');
  assert.equal(site.opposing.teeth[1].fdi, null); assert.equal(site.opposing.teeth[1].confidence, .7);
  assert.match(site.evidence.supporting.join(' '), /posed triangles.*does not establish contact.*confidence describes identity only/);
  other.identities[1].confidence = .1;
  for (const tooth of other.analysis.teeth) tooth.centroid = [-5000, 5000, -5000];
  site = opponents(arches);
  assert.deepEqual(site.opposing.teeth.map(tooth => tooth.toothId), [1, 2]);
  assert.equal(site.opposing.teeth[0].confidence, .1);
});

test('opponent triangle clipping retains crossing faces but rejects bounding-box overlap and edge-only touches', () => {
  const arches = opponentFixture([
    [0, -10, 7, 8, -10, 7, 4, 10, 7], // every vertex outside, triangle crosses region
    [5, 5, 7, 8, 2, 7, 8, 5, 7], // bounding box overlaps the upper right corner only
    [4, 0, 7, 4, 0, 8, 4, 0, 9], // zero projected area
  ]);
  assert.deepEqual(opponents(arches).opposing.teeth.map(tooth => tooth.toothId), [1]);
});

test('opponent membership rejects non-opposed or invalid individual and arch axes even in a verified pose', () => {
  for (const axis of [[0, 0, 1], [1, 0, 0], [Math.sqrt(.75), 0, -.5], [0, 0, 0], [NaN, 0, -1]]) {
    const arches = opponentFixture();
    for (const tooth of arches[1].analysis.teeth) tooth.axis = axis;
    assert.deepEqual(opponents(arches, true).opposing.teeth, [], JSON.stringify(axis));
  }
  for (const axis of [[0, 0, 1], [0, 0, 0], [NaN, 0, -1]]) {
    const arches = opponentFixture(); arches[1].model.up = axis;
    const site = opponents(arches, true);
    assert.deepEqual(site.opposing.teeth, []); assert.equal(site.space.vertical.value, null);
  }
  const arches = opponentFixture(); arches[0].analysis.curve.tangent.fill([0, 0, 1]);
  const site = opponents(arches);
  assert.equal(site.frame, null); assert.deepEqual(site.opposing.teeth, []); assert.equal(site.space.vertical.value, null);
});

test('opponents must occupy a local region above the ridge, with clipping at the height bounds', () => {
  const atHeight = height => [3, -1, height, 5, -1, height, 4, 1, height];
  const arches = opponentFixture([atHeight(-1), atHeight(7), atHeight(13), [3, -1, 11, 5, -1, 13, 4, 1, 13]]);
  assert.deepEqual(opponents(arches).opposing.teeth.map(tooth => tooth.toothId), [2, 4]);
});

test('opponents use the final localized anchor, not the uncentered curve point', () => {
  const arches = opponentFixture([[4.7, -.5, 7, 5, -.5, 7, 4.8, .5, 7]]);
  arches[0] = flankFixture();
  // Surface extrema give width 1.5 and a final origin x=4.15; this triangle
  // intersects that footprint but would miss a width-1.2 footprint at x=4.
  const site = opponents(arches);
  assert.ok(Math.abs(site.anchor.point[0] - 4.15) < 1e-6);
  assert.deepEqual(site.opposing.teeth.map(tooth => tooth.toothId), [1]);
});

test('opponent membership does not depend on face ordering, duplicates, subdivision or an early sample', () => {
  const baseTriangle = [3, -1, 7, 5, -1, 7, 4, 1, 7];
  const split = [[3, -1, 7, 5, -1, 7, 4, 0, 7], [5, -1, 7, 4, 1, 7, 4, 0, 7], [4, 1, 7, 3, -1, 7, 4, 0, 7]];
  for (const triangles of [[baseTriangle], split, Array.from({ length: 3001 }, (_, i) => i === 3000 ? baseTriangle : [20, 0, 7, 21, 0, 7, 20, 1, 7])]) {
    const arches = opponentFixture(triangles), other = arches[1];
    const tooth = other.analysis.teeth[0]; other.analysis.teeth = [tooth];
    tooth.faces = Uint32Array.from([...triangles.keys(), ...triangles.keys()]);
    assert.equal(opponents(arches).opposing.teeth.length, 1);
    tooth.faces.reverse(); assert.equal(opponents(arches).opposing.teeth.length, 1);
  }
});

test('posed opponents survive separate source frames, common workspace transforms and small file units', () => {
  const apply = (matrix, point) => [0, 1, 2].map(row => matrix[row] * point[0] + matrix[4 + row] * point[1] + matrix[8 + row] * point[2] + matrix[12 + row]);
  for (const scale of [1, 1e-8, 3]) {
    const arches = opponentFixture(), [input, other] = arches;
    input.model.scale *= scale; input.numbering.scale *= scale;
    input.analysis.gaps[0].s = input.analysis.gaps[0].s.map(value => value * scale);
    input.analysis.anterior.apexS *= scale;
    for (const tooth of input.analysis.teeth) for (const key of ['mdWidth', 'blWidth', 'height']) tooth[key] *= scale;
    input.model.surfaceAt = (x, y) => ({ face: 0, point: [x * scale, y * scale, 0], height: 0 });
    input.model.plan = point => point.map(value => value / scale);
    other.model.positions = other.model.positions.map(value => value * scale);
    assert.deepEqual(opponents(arches).opposing.teeth.map(tooth => tooth.toothId), [1, 2]);
    other.pose = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 12 * scale, -3 * scale, 2 * scale, 1];
    const inverse = invertRigid(other.pose);
    for (let i = 0; i < other.model.positions.length; i += 3) other.model.positions.set(apply(inverse, other.model.positions.slice(i, i + 3)), i);
    other.model.up = other.analysis.frame.up = [1, 0, 0];
    for (const tooth of other.analysis.teeth) tooth.axis = [1, 0, 0];
    assert.deepEqual(opponents(arches).opposing.teeth.map(tooth => tooth.toothId), [1, 2]);
    const common = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 15 * scale, 9 * scale, -7 * scale, 1];
    input.pose = common; other.pose = multiply(common, other.pose);
    assert.deepEqual(opponents(arches).opposing.teeth.map(tooth => tooth.toothId), [1, 2]);
  }
});
