import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRestorationSiteProposer, proposeRestorationSpec } from '../src/restoration-site.ts';
import { FDI_TEETH } from '../src/teeth.ts';

// Synthetic surfaces only: two reviewed neighbours and a distinct ridge patch.
// Geometry, labels, anchors and detection axes all use the original file frame.
const crownPatch = x => [x - .25, -.25, 1, x + .25, -.25, 1, x, .5, 1];
const ridgePatch = [-1, -1, 0, 1, -1, 0, 0, 2, 0];
function fixture({ fdi = 36, extra = [], extraLabels = [] } = {}) {
  const positions = Float32Array.from([...crownPatch(-2), ...crownPatch(2), ...ridgePatch, ...extra]);
  const dimensions = [0, 1, 2].map(axis => {
    const values = Array.from(positions).filter((_, index) => index % 3 === axis);
    return Math.max(...values) - Math.min(...values);
  });
  const part = { id: 'arch-source', role: fdi < 30 ? 'upper' : 'lower', name: 'Synthetic arch', fileName: 'synthetic.ply',
    positions, normals: new Float32Array(positions.length), dimensions, triangles: positions.length / 9,
    vertices: positions.length / 3, closed: false, visible: true, offset: [0, 0, 0] };
  const teeth = { teeth: Object.fromEntries(FDI_TEETH.map(code => [code, { status: 'unreviewed', restoration: 'none', note: '' }])),
    labels: { [part.id]: Uint8Array.from([fdi - 1, fdi + 1, 0, ...extraLabels]) } };
  for (const code of [fdi - 1, fdi + 1]) teeth.teeth[code] = { status: 'present', restoration: 'none', note: 'Reviewed synthetic neighbour' };
  teeth.teeth[fdi] = { status: 'missing', restoration: 'implant', note: 'Reviewed synthetic gap' };
  const scans = [{ partId: part.id, scan: { frame: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], up: [0, 0, 1] },
    candidates: [], warnings: [], unassignedTriangles: 1, method: 'synthetic test' } }];
  return { part, teeth, scans, fdi };
}
const infer = ({ fdi, part, teeth, scans }) => proposeRestorationSpec(fdi, [part], teeth, scans);
const locate = (input, point = [0, 0, 0], face = 2) => {
  input.teeth.teeth[input.fdi].site = { partId: input.part.id, face, point };
  return input;
};
const close = (actual, expected, tolerance = 1e-5) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const closeVector = (actual, expected, tolerance) => actual.forEach((value, index) => close(value, expected[index], tolerance));

const rectangle = (x0, x1, y0 = -1, y1 = 1, z = 0) => [x0, y0, z, x1, y0, z, x1, y1, z, x0, y0, z, x1, y1, z, x0, y1, z];
const shiftedPatch = (x, y, z = 1) => crownPatch(x).map((value, index) => value + (index % 3 === 1 ? y : index % 3 === 2 ? z - 1 : 0));
function replaceGeometry(input, positions, labels) {
  input.part.positions = Float32Array.from(positions);
  input.part.normals = new Float32Array(positions.length);
  input.part.triangles = positions.length / 9; input.part.vertices = positions.length / 3;
  input.teeth.labels[input.part.id] = Uint8Array.from(labels);
  return input;
}
function gapFixture(missing = [35, 36], ends = [missing[0] - 1, missing.at(-1) + 1]) {
  const input = fixture({ fdi: missing[0] }), span = missing.length + 1;
  for (const code of FDI_TEETH) input.teeth.teeth[code] = { status: 'unreviewed', restoration: 'none', note: '' };
  for (const code of ends) input.teeth.teeth[code].status = 'present';
  for (const code of missing) input.teeth.teeth[code] = { status: 'missing', restoration: 'implant', note: 'Reviewed gap' };
  replaceGeometry(input, [...crownPatch(-span), ...crownPatch(span), ...rectangle(-span + .5, span - .5)], [...ends, 0, 0]);
  return input;
}

test('a reviewed missing implant site yields deterministic hypotheses without changing source evidence', () => {
  const input = fixture(), before = structuredClone(input), first = infer(input);
  assert.deepEqual(first, infer(input));
  assert.deepEqual(input, before);
  assert.equal(first.fdi, 36);
  assert.equal(first.parentPartId, input.part.id);
  closeVector(first.frame.origin, [0, 0, 0], 1e-12);
  assert.equal(first.provenance, 'hypothesized');
  assert.equal(first.units, 'file units (u)');
  assert.match(first.source, /hypothesized/i);
  assert.match(first.source, /bone.*unassessed/i);
  for (const fdi of [0, 19, 29, 49, 36.5, NaN, '36']) assert.throws(() => proposeRestorationSpec(fdi, [input.part], input.teeth, input.scans), /FDI/i);
  for (const status of ['unreviewed', 'present', 'not-scanned']) {
    const changed = fixture(); changed.teeth.teeth[36].status = status;
    assert.throws(() => infer(changed), /confirm.*missing/i);
  }
  for (const restoration of ['none', 'crown']) {
    const changed = fixture(); changed.teeth.teeth[36].restoration = restoration;
    assert.throws(() => infer(changed), /intent/i);
  }
});

test('explicit reviewed source anchors accept triangle interiors, edges and vertices', () => {
  for (const point of [[0, 0, 0], [0, -1, 0], [-1, -1, 0], [0, 2, 0]]) {
    const input = locate(fixture(), point), spec = infer(input);
    assert.deepEqual(spec.frame.origin, point);
    assert.notEqual(spec.frame.origin, point);
    assert.match(spec.source, /reviewed surface site/i);
  }
});

test('explicit anchors reject invalid faces, nonfinite points and unrelated or wrong-arch source IDs', () => {
  for (const face of [-1, .5, 3, NaN, Infinity]) assert.throws(() => infer(locate(fixture(), [0, 0, 0], face)));
  for (const point of [[NaN, 0, 0], [0, Infinity, 0], [0, 0, -Infinity]]) assert.throws(() => infer(locate(fixture(), point)));
  const unrelated = locate(fixture()); unrelated.teeth.teeth[36].site.partId = 'another-source';
  assert.throws(() => infer(unrelated), /localiz|site/i);
  const wrongArch = locate(fixture()); wrongArch.part.role = 'upper';
  assert.throws(() => infer(wrongArch), /localiz|site/i);
});

test('explicit anchor points must contain exactly three coordinates', () => {
  for (const point of [[], [0, 0], [0, 0, 0, 1]]) {
    assert.throws(() => infer(locate(fixture(), point)), /anchor|point|coordinates/i);
  }
});

test('explicit anchors reject off-plane and outside-triangle points', () => {
  for (const point of [[0, 0, .1], [10, 0, 0], [0, -2, 0]]) {
    assert.throws(() => infer(locate(fixture(), point)), /off.*surface|anchor/i);
  }
});

test('explicit anchors cannot be attached to a collapsed source triangle', () => {
  const input = locate(fixture());
  input.part.positions.set([0, 0, 0, 0, 0, 0, 0, 0, 0], 18);
  assert.throws(() => infer(input), /surface|anchor|degenerate/i);
});

test('a missing-site anchor cannot be placed on a different assigned FDI surface', () => {
  const input = locate(fixture(), [-2, 0, 1], 0);
  assert.equal(input.teeth.labels[input.part.id][0], 35);
  assert.throws(() => infer(input), /conflict|assigned|tooth/i);
});

test('a distant source outlier must not loosen the local anchor surface tolerance', () => {
  const input = locate(fixture({ extra: [1e7, 0, 0, 1e7, 1, 0, 1e7, 0, 1], extraLabels: [255] }), [0, 0, .1]);
  assert.throws(() => infer(input), /off.*surface|anchor/i);
});

test('an explicit reviewed site works without tooth neighbours and remains a file-unit hypothesis', () => {
  const input = locate(fixture()); input.teeth.labels[input.part.id].fill(0);
  const result = infer(input);
  assert.deepEqual(result.frame.origin, [0, 0, 0]);
  assert.equal(result.provenance, 'hypothesized');
  assert.equal(result.units, 'file units (u)');
  assert.ok(result.parameters.fixture.radius > 0);
  assert.match(result.source, /bone.*unassessed/i);
});

test('inferred sites require both neighbouring FDI surfaces to be reviewed present', () => {
  for (const status of ['unreviewed', 'missing', 'not-scanned']) {
    for (const code of [35, 37]) {
      const input = fixture(); input.teeth.teeth[code].status = status;
      assert.throws(() => infer(input), /review|neighbour|neighbor/i, `FDI ${code} is ${status}`);
    }
  }
});

test('no automatic extrapolation is made from a single neighbour or past an arch end', () => {
  const single = fixture(); single.teeth.labels[single.part.id][1] = 0;
  assert.throws(() => infer(single), /two.*neigh|locat/i);
  const end = fixture(); end.fdi = 38;
  end.teeth.teeth[38] = { status: 'missing', restoration: 'implant', note: '' };
  end.teeth.labels[end.part.id] = Uint8Array.from([37, 36, 0]);
  assert.throws(() => infer(end), /two.*neigh|locat/i);
});

test('an automatic ridge anchor must remain between the two reviewed neighbour centres', () => {
  const input = fixture();
  input.part.positions.set([2.25, -.25, 0, 2.75, -.25, 0, 2.5, .5, 0], 18);
  assert.throws(() => infer(input), /between|ridge|locat/i);
});

test('labelled teeth cannot win ridge localization even when closer than the unassigned surface', () => {
  const input = fixture({ extra: [-1, -1, 1, 1, -1, 1, 0, 2, 1], extraLabels: [32] });
  input.teeth.teeth[32].status = 'present';
  closeVector(infer(input).frame.origin, [0, 0, 0], 1e-12);
  input.teeth.labels[input.part.id][2] = 32;
  assert.throws(() => infer(input), /ridge|locat/i);
});

test('translated, rotated and scaled source frames preserve source localization and proportional parameters', () => {
  const original = infer(fixture());
  // A proper rotation: local x -> +y, local y -> -z, local z -> -x.
  const rotate = ([x, y, z]) => [-z, x, -y];
  for (const fdi of [16, 36]) for (const factor of [.001, 1, 1000]) {
    const input = fixture({ fdi }), origin = [32 * factor, -24 * factor, 8 * factor];
    const transform = point => rotate(point).map((value, axis) => value * factor + origin[axis]);
    for (let i = 0; i < input.part.positions.length; i += 3) input.part.positions.set(transform(Array.from(input.part.positions.subarray(i, i + 3))), i);
    input.part.dimensions = [1, 4.5, 3].map(value => value * factor);
    input.scans[0].scan.frame = { origin, u: rotate([1, 0, 0]), v: rotate([0, 1, 0]), up: rotate([0, 0, 1]) };
    const result = infer(input), tolerance = factor * 5e-6;
    closeVector(result.frame.origin, origin, tolerance);
    for (const axis of ['u', 'v', 'up']) closeVector(result.frame[axis], rotate(original.frame[axis]), 1e-12);
    for (const [component, keys] of Object.entries({ fixture: ['radius', 'length', 'depth'], abutment: ['radius', 'height', 'emergenceRadius'], crown: ['width', 'depth', 'height', 'cuspHeight'] })) {
      for (const key of keys) close(result.parameters[component][key], original.parameters[component][key] * factor, tolerance);
    }
    // A current workspace pose never changes the stored file-frame proposal.
    input.part.pose = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 90, -50, 30, 1];
    input.part.offset = [5, 6, 7]; input.part.rotation = [15, 25, 35];
    assert.deepEqual(infer(input), result);
  }
});

test('an oblique rigid source-frame rotation must not resize the same neighbouring surfaces', () => {
  const input = fixture(), original = infer(input), angle = Math.PI / 4;
  const rotate = ([x, y, z]) => [x, y * Math.cos(angle) - z * Math.sin(angle), y * Math.sin(angle) + z * Math.cos(angle)];
  for (let i = 0; i < input.part.positions.length; i += 3) input.part.positions.set(rotate(Array.from(input.part.positions.subarray(i, i + 3))), i);
  for (const axis of ['u', 'v', 'up']) input.scans[0].scan.frame[axis] = rotate(input.scans[0].scan.frame[axis]);
  const rotated = infer(input);
  closeVector(rotated.frame.origin, rotate(original.frame.origin), 1e-6);
  for (const component of ['fixture', 'abutment', 'crown']) for (const key of Object.keys(original.parameters[component])) {
    close(rotated.parameters[component][key], original.parameters[component][key], 1e-6);
  }
});

test('two and three reviewed missing positions receive distinct ordered surface anchors', () => {
  for (const missing of [[35, 36], [34, 35, 36]]) {
    const input = gapFixture(missing), before = structuredClone(input);
    const propose = createRestorationSiteProposer([input.part], input.teeth, input.scans);
    const specs = missing.map(code => propose(code));
    specs.forEach((spec, index) => {
      closeVector(spec.frame.origin, [-(missing.length + 1) + 2 * (index + 1), 0, 0], 1e-12);
      assert.deepEqual(spec, proposeRestorationSpec(spec.fdi, [input.part], input.teeth, input.scans));
      assert.deepEqual(spec.siteEvidence.bounds, [missing[0] - 1, missing.at(-1) + 1]);
      assert.deepEqual(spec.siteEvidence.slot, { index: index + 1, count: missing.length });
      assert.equal(spec.siteEvidence.surface.partId, input.part.id);
      assert.deepEqual(spec.siteEvidence.surface.point, spec.frame.origin);
      assert.match(spec.source, /equal-spacing.*hypothesis/);
      assert.match(spec.source, /bone, implant suitability and compatibility unassessed/);
      assert.equal(spec.units, 'file units (u)');
    });
    assert.deepEqual(input, before);
  }
});

test('missing positions without implant intent still occupy a slot in the reviewed run', () => {
  const input = gapFixture(); input.teeth.teeth[36].restoration = 'none';
  closeVector(infer(input).frame.origin, [-1, 0, 0], 1e-12);
  assert.throws(() => proposeRestorationSpec(36, [input.part], input.teeth, input.scans), /intent/i);
});

test('the arch sequence can bound reviewed anterior gaps across the FDI midline', () => {
  for (const [missing, ends] of [[[11, 21], [12, 22]], [[41, 31], [42, 32]]]) {
    const input = gapFixture(missing, ends);
    missing.forEach((code, index) => closeVector(proposeRestorationSpec(code, [input.part], input.teeth, input.scans).frame.origin, [index ? 1 : -1, 0, 0], 1e-12));
  }
});

test('reviewed bounds cannot skip unknown, unscanned or unlabelled-present intervening positions', () => {
  for (const status of ['unreviewed', 'not-scanned', 'present']) {
    const input = gapFixture(); input.teeth.teeth[36].status = status;
    assert.throws(() => infer(input), /reviewed|neighbour|same import/i);
  }
  const conflict = gapFixture(); conflict.teeth.labels[conflict.part.id][2] = 36;
  assert.throws(() => infer(conflict), /conflict/i);
  const tooLong = gapFixture([33, 34, 35, 36]);
  assert.throws(() => infer(tooLong), /limited to 3/i);
});

test('support confined to the middle of a multi-tooth gap cannot collapse every site to one anchor', () => {
  const input = gapFixture();
  replaceGeometry(input, [...crownPatch(-3), ...crownPatch(3), ...rectangle(-.1, .1)], [34, 37, 0, 0]);
  for (const code of [35, 36]) assert.throws(() => proposeRestorationSpec(code, [input.part], input.teeth, input.scans), /support|slot|ridge/i);
});

test('automatic support rejects excluded, collapsed and nonfinite triangles', () => {
  const excluded = fixture(); excluded.teeth.labels[excluded.part.id][2] = 255;
  assert.throws(() => infer(excluded), /ridge|support/i);
  assert.throws(() => infer(locate(excluded)), /excluded/i);
  for (const points of [new Array(9).fill(0), [0, 0, 0, 1, 0, 0, 2, 0, 0], [NaN, 0, 0, 1, 0, 0, 0, 1, 0]]) {
    const input = fixture(); input.part.positions.set(points, 18);
    assert.throws(() => infer(input), /ridge|support/i);
  }
  const valid = fixture({ extra: [0, 0, 1, 0, 0, 1, 0, 0, 1], extraLabels: [0] });
  closeVector(infer(valid).frame.origin, [0, 0, 0], 1e-12);
});

test('invalid closer surfaces are filtered before valid supporting surfaces are ranked', () => {
  const input = fixture({ extra: [.8, -.1, 1, 1, -.1, 1, .9, .2, 1], extraLabels: [0] });
  closeVector(infer(input).frame.origin, [0, 0, 0], 1e-12);
});

test('equally plausible separated support patches abstain regardless of triangle order', () => {
  // The crown-level target is [0,0,1]; these patches are equally far to either side.
  const patches = [rectangle(-.1, .1, .2, .3), rectangle(-.1, .1, -.3, -.2)];
  for (const ordered of [patches, [...patches].reverse()]) {
    const input = fixture();
    replaceGeometry(input, [...crownPatch(-2), ...crownPatch(2), ...ordered.flat()], [35, 37, 0, 0, 0, 0]);
    assert.throws(() => infer(input), /multiple.*surface|hypotheses/i);
  }
});

test('collapsed projected crown bounds and distant support abstain at local crown scale', () => {
  const stacked = fixture(); stacked.part.positions.set(shiftedPatch(-2, 0, 2), 9);
  assert.throws(() => infer(stacked), /projected|spacing/i);
  const deep = gapFixture([34, 35, 36]);
  for (let i = 18; i < deep.part.positions.length; i += 3) deep.part.positions[i + 2] = -5;
  assert.throws(() => infer(deep), /support|ridge/i);
});

test('automatic and explicit sites reject unavailable, nonfinite and collapsed scan frames', () => {
  for (const change of [frame => { frame.u = [0, 0, 0]; }, frame => { frame.u = [0, 0, 1]; }, frame => { frame.up = [0, 0, 0]; }, frame => { frame.v = [0, 0, 1]; }, frame => { frame.origin[1] = Infinity; }]) {
    for (const explicit of [false, true]) {
      const input = explicit ? locate(fixture()) : fixture(); change(input.scans[0].scan.frame);
      assert.throws(() => infer(input), /orientation|axes/i);
    }
  }
  const unavailable = fixture(); unavailable.scans[0].scan.method = 'unavailable';
  assert.throws(() => infer(unavailable), /orientation/i);
});

function splitFixture() {
  const input = fixture();
  const parts = ['left', 'right', 'ridge'].map((id, index) => ({ ...input.part, id, sourceFileId: 'one-import',
    positions: input.part.positions.slice(index * 9, index * 9 + 9), normals: new Float32Array(9), triangles: 1, vertices: 3 }));
  input.teeth.labels = Object.fromEntries(parts.map((part, index) => [part.id, Uint8Array.of([35, 37, 0][index])]));
  const scans = [{ ...input.scans[0], partId: 'left' }];
  return { ...input, parts, scans };
}

test('split components can share crown evidence only within one import and rigid pose', () => {
  const input = splitFixture();
  // Absence of an annotation array means unassigned, as elsewhere in the tooth case.
  delete input.teeth.labels.ridge;
  const result = proposeRestorationSpec(36, input.parts, input.teeth, input.scans);
  assert.equal(result.parentPartId, 'ridge');
  closeVector(result.frame.origin, [0, 0, 0], 1e-12);
  assert.deepEqual(result, proposeRestorationSpec(36, [...input.parts].reverse(), input.teeth, input.scans));
  assert.deepEqual(result.siteEvidence.partIds, ['left', 'ridge', 'right']);
  input.parts.forEach(part => { part.offset = [20, 30, 40]; });
  assert.deepEqual(result, proposeRestorationSpec(36, input.parts, input.teeth, input.scans));
  input.parts[1].offset = [21, 30, 40];
  assert.throws(() => proposeRestorationSpec(36, input.parts, input.teeth, input.scans), /rigid pose/i);
  input.parts.forEach(part => { part.offset = [0, 0, 0]; delete part.sourceFileId; });
  assert.throws(() => proposeRestorationSpec(36, input.parts, input.teeth, input.scans), /same import|reviewed neighbour/i);
});

test('an explicit marker can reuse compatible orientation from a sibling in the same import', () => {
  const input = splitFixture();
  input.teeth.teeth[36].site = { partId: 'ridge', face: 0, point: [0, 0, 0] };
  const result = proposeRestorationSpec(36, input.parts, input.teeth, input.scans);
  assert.equal(result.parentPartId, 'ridge');
  assert.deepEqual(result.frame.origin, [0, 0, 0]);
  assert.equal(result.siteEvidence.method, 'reviewed-surface');
  input.parts[0].offset = [1, 0, 0];
  assert.throws(() => proposeRestorationSpec(36, input.parts, input.teeth, input.scans), /orientation/i);
});

test('sibling pose agreement uses local geometry scale independent of a large common workspace offset', () => {
  for (const offset of [0, 1e6]) {
    const input = splitFixture();
    for (const part of input.parts) {
      part.positions = part.positions.map(value => value * .001);
      part.offset = [offset, 0, 0];
    }
    proposeRestorationSpec(36, input.parts, input.teeth, input.scans);
    input.parts[1].offset = [offset + .0005, 0, 0];
    assert.throws(() => proposeRestorationSpec(36, input.parts, input.teeth, input.scans), /rigid pose/i);
  }
});

test('excluded and invalid source outliers cannot inflate explicit-site fallback dimensions', () => {
  const original = locate(fixture()); original.teeth.labels[original.part.id].fill(0);
  const baseline = infer(original);
  for (const [extra, label] of [[[1e7, 0, 0, 1e7, 1, 0, 1e7, 0, 1], 255], [[NaN, 0, 0, 1, 0, 0, 0, 1, 0], 0]]) {
    const input = locate(fixture({ extra, extraLabels: [label] }));
    input.teeth.labels[input.part.id].fill(0); input.teeth.labels[input.part.id][3] = label;
    assert.deepEqual(infer(input).parameters, baseline.parameters);
  }
});

test('competing imports abstain independent of source order, and an explicit marker resolves the source', () => {
  const first = fixture(), second = fixture(); second.part.id = 'second-import';
  for (let i = 0; i < second.part.positions.length; i += 3) second.part.positions[i] += 50;
  second.scans[0].partId = second.part.id; second.scans[0].scan.frame.origin[0] = 50;
  first.teeth.labels[second.part.id] = first.teeth.labels[first.part.id].slice();
  const parts = [first.part, second.part], scans = [...first.scans, ...second.scans];
  for (const ordered of [parts, [...parts].reverse()]) assert.throws(() => proposeRestorationSpec(36, ordered, first.teeth, scans), /multiple imported sources/i);
  locate(first);
  const result = proposeRestorationSpec(36, parts, first.teeth, scans);
  assert.equal(result.parentPartId, first.part.id); closeVector(result.frame.origin, [0, 0, 0], 1e-12);
  first.teeth.teeth[36].site.point = [0, 0, .2];
  assert.throws(() => proposeRestorationSpec(36, parts, first.teeth, scans), /off.*surface/i);
});

test('unchanged crown surfaces yield the same location under uneven retriangulation', () => {
  const make = strips => {
    const input = fixture(), left = [];
    for (let index = 0; index < strips; index++) left.push(...rectangle(-3 + index / strips, -3 + (index + 1) / strips, -.5, .5, 1));
    left.push(...rectangle(-2, -1, -.5, .5, 1));
    replaceGeometry(input, [...left, ...crownPatch(2), ...ridgePatch], [...new Array(left.length / 9).fill(35), 37, 0]);
    return infer(input);
  };
  const coarse = make(1), uneven = make(64);
  closeVector(coarse.frame.origin, [0, 0, 0], 1e-12);
  closeVector(uneven.frame.origin, coarse.frame.origin, 1e-6);
  assert.deepEqual(uneven.parameters, coarse.parameters);
});

test('reviewed outer crowns guide a bounded curved gap away from misleading chord-center surfaces', () => {
  const input = gapFixture([34, 35, 36]);
  const supports = [-2, 0, 2].flatMap((x, index) => rectangle(x - .25, x + .25, (index === 1 ? 1 : .75) - .1, (index === 1 ? 1 : .75) + .1));
  const chord = rectangle(-.25, .25, -.1, .1, .95);
  replaceGeometry(input, [...crownPatch(-4), ...crownPatch(4), ...shiftedPatch(-6, -1), ...shiftedPatch(6, -1), ...chord, ...supports], [33, 37, 32, 38, 0, 0, ...new Array(6).fill(0)]);
  input.teeth.teeth[32].status = 'present'; input.teeth.teeth[38].status = 'present';
  for (const [index, code] of [34, 35, 36].entries()) {
    const result = proposeRestorationSpec(code, [input.part], input.teeth, input.scans);
    closeVector(result.frame.origin, [-2 + index * 2, index === 1 ? 1 : .75, 0], 1e-6);
    assert.match(result.source, /reviewed-crown tangent curve/);
    assert.ok(result.siteEvidence.fdis.includes(32) && result.siteEvidence.fdis.includes(38));
  }
  input.teeth.labels[input.part.id].fill(255, 6);
  assert.throws(() => proposeRestorationSpec(35, [input.part], input.teeth, input.scans), /support|ridge/i);
  input.teeth.teeth[38].status = 'unreviewed';
  assert.throws(() => proposeRestorationSpec(35, [input.part], input.teeth, input.scans), /curvature/i);
});

test('multi-position sites preserve proper source transforms, scale and a right-handed local frame', () => {
  const original = gapFixture([34, 35, 36]);
  const specs = [34, 35, 36].map(code => proposeRestorationSpec(code, [original.part], original.teeth, original.scans));
  const rotate = ([x, y, z]) => [(x - y) / Math.sqrt(2), (x + y) / Math.sqrt(2), z];
  for (const factor of [.001, 1000]) {
    const input = gapFixture([34, 35, 36]), translation = [30, -20, 10].map(value => value * factor);
    const transform = point => rotate(point).map((value, axis) => value * factor + translation[axis]);
    for (let i = 0; i < input.part.positions.length; i += 3) input.part.positions.set(transform(Array.from(input.part.positions.subarray(i, i + 3))), i);
    input.scans[0].scan.frame.origin = translation;
    for (const axis of ['u', 'v', 'up']) input.scans[0].scan.frame[axis] = rotate(input.scans[0].scan.frame[axis]);
    for (const expected of specs) {
      const actual = proposeRestorationSpec(expected.fdi, [input.part], input.teeth, input.scans);
      closeVector(actual.frame.origin, transform(expected.frame.origin), factor * 5e-6);
      for (const axis of ['u', 'v', 'up']) closeVector(actual.frame[axis], rotate(expected.frame[axis]), 2e-6);
      close(actual.parameters.crown.width, expected.parameters.crown.width * factor, factor * 5e-6);
    }
  }
});

test('a reviewed marker remains authoritative for a longer gap that automatic localization declines', () => {
  const input = gapFixture([33, 34, 35, 36]);
  locate(input, [0, 0, 0], 2);
  const result = infer(input);
  assert.deepEqual(result.frame.origin, [0, 0, 0]);
  assert.equal(result.siteEvidence.method, 'reviewed-surface');
  assert.equal(result.siteEvidence.bounds, undefined);
});

test('the site worker preserves request IDs and isolates unsupported positions within a batch', async () => {
  const workerUrl = new URL('../src/restoration-site.worker.ts', import.meta.url);
  const workerSource = (await readFile(workerUrl, 'utf8')).replace("'./restoration-site'", JSON.stringify(new URL('../src/restoration-site.ts', import.meta.url).href));
  const previousSelf = globalThis.self, responses = [];
  const scope = { postMessage: message => responses.push(message) }; globalThis.self = scope;
  try {
    await import(`data:text/javascript;base64,${Buffer.from(workerSource).toString('base64')}`);
    const input = gapFixture();
    scope.onmessage({ data: { id: 73, fdis: [35, 99, 36], parts: [input.part], teeth: input.teeth, scans: input.scans } });
    assert.equal(responses.length, 1);
    assert.equal(responses[0].id, 73);
    assert.deepEqual(responses[0].specs.map(spec => spec.fdi), [35, 36]);
    assert.equal(responses[0].warnings.length, 1);
    assert.match(responses[0].warnings[0], /FDI/);
    assert.equal(responses[0].specs[0].siteEvidence.method, 'bounded-gap');
  } finally {
    if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf;
  }
});
