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

test('terminal ridges and scan ends never generate automatic missing sites', () => {
  for (const kind of ['terminal-start', 'terminal-end']) for (const positions of [[], [13]]) {
    const input = fixture(); input.analysis.gaps[0] = { ...input.analysis.gaps[0], kind, positions };
    assert.deepEqual(proposeSites([input], options), []);
  }
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
