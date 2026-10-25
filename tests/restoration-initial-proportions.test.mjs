import test from 'node:test';
import assert from 'node:assert/strict';
import { specForHypothesis } from '../src/workflow-geometry.ts';
import { generateRestoration } from '../src/restoration-geometry.ts';

// Synthetic file-unit envelopes only; no patient geometry or clinical sizes.
const measure = value => ({ value, unit: 'file units (u)', provenance: 'measured', method: 'Synthetic surface envelope.' });
function site(fdi, { gap = 3, bl = 4, height = 5, vertical = 4 } = {}) {
  const frame = { origin: [1, 2, 3], u: [0, 1, 0], v: [-1, 0, 0], up: [0, 0, 1] };
  return { id: 'synthetic-gap', fdi, arch: fdi < 30 ? 'upper' : 'lower', partId: 'arch', status: 'proposed-missing',
    anchor: { partId: 'arch', face: 7, point: frame.origin }, frame, frameBasis: 'Synthetic ridge datum.',
    mesialSign: 1, buccalSign: -1, slot: { index: 0, count: 1, s: [0, gap + 1] },
    opposing: { partId: 'opponent', teeth: [], poseVerified: false },
    space: { mesiodistal: measure(gap + 1), proximalGap: measure(gap), buccolingual: measure(bl), crownHeight: measure(height), vertical: measure(vertical) } };
}
function bounds(mesh, frame) {
  const out = [[Infinity, -Infinity], [Infinity, -Infinity], [Infinity, -Infinity]];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const d = frame.origin.map((value, axis) => mesh.positions[i + axis] - value);
    for (const [axis, basis] of [frame.u, frame.v, frame.up].entries()) {
      const value = d.reduce((sum, x, k) => sum + x * basis[k], 0);
      out[axis][0] = Math.min(out[axis][0], value); out[axis][1] = Math.max(out[axis][1], value);
    }
  }
  return out;
}
const FDIS = [11, 13, 14, 16, 17, 21, 24, 26, 31, 33, 34, 35, 36, 37, 46];
const CAP = { incisor: 1.2, canine: 1.25, premolar: 1.5, molar: 1.5 };

test('a short gap with a broad neighbouring cross-section cannot emit a lozenge body', () => {
  for (const fdi of FDIS) {
    const input = site(fdi, { gap: 3, bl: 9 }), before = structuredClone(input), spec = specForHypothesis(input, []);
    const b = bounds(generateRestoration(spec).find(mesh => mesh.component === 'crown'), spec.frame);
    const md = b[0][1] - b[0][0], bl = b[1][1] - b[1][0];
    assert.ok(md > .97 * 3 && md <= 3, `FDI ${fdi}: emitted MD ${md}`);
    assert.ok(bl / md <= CAP[spec.anatomy] * (1 + 1e-5), `FDI ${fdi}: emitted BL/MD ${bl / md}`);
    assert.ok(bl / md > CAP[spec.anatomy] * .999, `FDI ${fdi}: cap is reached, body is not shrunk further`);
    assert.ok(bl <= .94 * 9, `FDI ${fdi}: emitted BL ${bl} stays inside the neighbouring hypothesis`);
    assert.match(spec.source, /footprint prior, a prototype hypothesis/);
    assert.deepEqual(input, before);
  }
});

test('an unconstrained BL body equals 94% of the neighbouring hypothesis after template normalization', () => {
  for (const fdi of FDIS) {
    const spec = specForHypothesis(site(fdi, { gap: 4, bl: 4 }), []);
    const b = bounds(generateRestoration(spec).find(mesh => mesh.component === 'crown'), spec.frame);
    assert.ok(Math.abs(b[1][1] - b[1][0] - .94 * 4) < 1e-4, `FDI ${fdi}: emitted BL ${b[1][1] - b[1][0]}`);
    assert.match(spec.source, /Body BL is 94% of the neighbouring cross-section hypothesis/);
  }
});

test('visible abutment takes a tenth of the unchanged total top; the crown body takes the rest', () => {
  for (const fdi of FDIS) for (const vertical of [4, null]) {
    const input = site(fdi, { vertical: vertical ?? 1 }); if (vertical === null) input.space.vertical.value = null;
    const spec = specForHypothesis(input, []), meshes = generateRestoration(spec);
    const crown = bounds(meshes.find(mesh => mesh.component === 'crown'), spec.frame);
    const top = vertical ?? input.space.crownHeight.value;
    assert.ok(crown[2][1] <= top && crown[2][1] > .999 * top, `FDI ${fdi}: total top ${crown[2][1]}`);
    assert.ok(Math.abs(crown[2][0] / crown[2][1] - .1) < 1e-3, `FDI ${fdi}: abutment share ${crown[2][0] / crown[2][1]}`);
    assert.ok(Math.abs(spec.parameters.abutment.height - crown[2][0]) < 1e-5);
  }
});

test('initial proportions preserve the saved frame, anchor and component axes', () => {
  const input = site(26, { gap: 3, bl: 9 }), spec = specForHypothesis(input, []);
  assert.deepEqual(spec.frame, input.frame);
  assert.deepEqual(spec.siteEvidence.surface, input.anchor);
  assert.deepEqual(spec.anatomicalSigns, { mesial: 1, buccal: -1 });
  assert.equal(spec.parameters.crown.rotation, 0);
  assert.equal(spec.parameters.crown.cuspHeight, 0);
  assert.equal(spec.parameters.fixture.depth, 0);
  assert.equal(spec.provenance, 'hypothesized');
  assert.equal(spec.units, 'file units (u)');
});
