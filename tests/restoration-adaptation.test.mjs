import test from 'node:test';
import assert from 'node:assert/strict';
import { OcclusalAdaptationCancelled, planOcclusalAdaptation, proposeOcclusalAdaptation } from '../src/restoration-adaptation.ts';
import { generateRestoration, restorationCrownShape } from '../src/restoration-geometry.ts';
import { auditCrownMesh, buildCrownMesh } from '../src/crown-anatomy.ts';

function spec(overrides = {}) {
  const base = { version: 'implant-assembly/v1', fdi: 36, parentPartId: 'synthetic', frame: { origin: [10, -4, 2], u: [1, 0, 0], v: [0, 1, 0], up: [0, 0, 1] },
    parameters: { fixture: { radius: 1.1, length: 5, depth: .4, taper: .3 }, abutment: { radius: .8, height: 2.1, emergenceRadius: 1.3, angleX: 0, angleY: 0 }, crown: { width: 5.2, depth: 4.6, height: 3.5, cuspHeight: 1.1, rotation: 0 } },
    anatomy: 'molar', provenance: 'hypothesized', units: 'file units (u)', source: 'Synthetic adaptation fixture, no patient data', ...overrides };
  base.crownShape = restorationCrownShape(base);
  return base;
}
/** Horizontal patch at frame height z over frame x in [x0, x1], y in [y0, y1]. */
function patch(s, z, x0, x1, y0 = -4, y1 = 4) {
  const [ox, oy, oz] = s.frame.origin, p = (x, y) => [ox + x, oy + y, oz + z];
  return Float32Array.from([p(x0, y0), p(x1, y0), p(x1, y1), p(x0, y0), p(x1, y1), p(x0, y1)].flat());
}
const crownTop = s => {
  const crown = generateRestoration(s).find(c => c.component === 'crown').positions;
  let top = -Infinity;
  for (let i = 2; i < crown.length; i += 3) top = Math.max(top, crown[i] - s.frame.origin[2]);
  return top;
};
/** Crown vertices (world → frame) that lie inside the patch footprint. */
function verticesUnder(s, x0, x1) {
  const crown = generateRestoration(s).find(c => c.component === 'crown').positions, out = [];
  for (let i = 0; i < crown.length; i += 3) {
    const x = crown[i] - s.frame.origin[0];
    if (x >= x0 && x <= x1) out.push(crown[i + 2] - s.frame.origin[2]);
  }
  return out;
}

test('a localized antagonist lowers only the local occlusal region, preserving body, wall and pose', async () => {
  const input = spec(), snapshot = structuredClone(input);
  const top = crownTop(input), patchZ = top - .25, gap = .05;
  const surfaces = [{ id: 'opposing:mesial', role: 'antagonist', positions: patch(input, patchZ, .8, 3), targetGap: gap },
    { id: 'mesial-neighbour', role: 'adjacent', side: 'mesial', positions: patch(input, 0, 0, 1) }];
  const { spec: adapted, report } = await planOcclusalAdaptation(input, surfaces);
  assert.equal(report.status, 'adapted', report.reason);
  assert.deepEqual(input, snapshot, 'Input spec and anatomy remain unmodified.');
  assert.notEqual(adapted.crownShape.occlusal.buffer, input.crownShape.occlusal.buffer);
  assert.deepEqual(adapted.parameters, input.parameters);
  assert.deepEqual(adapted.frame, input.frame);
  for (const key of ['rim', 'rimZ', 'wall', 'dims']) assert.deepEqual(adapted.crownShape[key], input.crownShape[key], key);
  assert.match(adapted.crownShape.source.provenance, /Local occlusal adaptation/);
  assert.ok(report.unknownRays > 0 && report.rayHits > 0, 'Rays outside the patch are reported as unknown.');
  assert.ok(report.maxRelativeReduction <= .3);

  const before = generateRestoration(input), after = generateRestoration(adapted);
  for (const kind of ['fixture', 'abutment']) assert.deepEqual(after.find(c => c.component === kind), before.find(c => c.component === kind), `${kind} unchanged`);
  const crown = after.find(c => c.component === 'crown');
  assert.equal(crown.positions.length, before.find(c => c.component === 'crown').positions.length, 'Topology preserved.');
  assert.ok(crown.positions.every(Number.isFinite) && crown.normals.every(Number.isFinite));
  assert.ok(auditCrownMesh(buildCrownMesh(adapted.crownShape, [5.2, 4.6, 3.5])).closed, 'Closed manifold.');
  assert.ok(Math.max(...verticesUnder(input, .8, 3)) > patchZ - gap + .05, 'Fixture must actually conflict before adaptation.');
  // Vertices under the patch respect hit - gap; the far (distal) cusps keep their full height.
  for (const z of verticesUnder(adapted, .8, 3)) assert.ok(z <= patchZ - gap + 1e-4, `${z} exceeds ${patchZ - gap}`);
  const distalBefore = Math.max(...verticesUnder(input, -3, -1.5)), distalAfter = Math.max(...verticesUnder(adapted, -3, -1.5));
  assert.ok(Math.abs(distalBefore - distalAfter) < 1e-6, 'No global shrink.');
  assert.equal(await proposeOcclusalAdaptation(input, surfaces).then(s => s.crownShape.occlusal.length), adapted.crownShape.occlusal.length);
});

test('rotation and anatomical signs use the exact generated crown mapping', async () => {
  const input = spec({ fdi: 46, anatomicalSigns: { mesial: -1, buccal: 1 } });
  input.parameters.crown.rotation = 25;
  input.parameters.abutment.angleY = 6;
  input.crownShape = restorationCrownShape(input);
  const patchZ = crownTop(input) - .3;
  const adapted = await proposeOcclusalAdaptation(input, [{ id: 'opp', role: 'antagonist', positions: patch(input, patchZ, -3, -.5), targetGap: .05 }]);
  assert.ok(adapted);
  assert.ok(Math.max(...verticesUnder(input, -3, -.5)) > patchZ - .05 + .05);
  for (const z of verticesUnder(adapted, -3, -.5)) assert.ok(z <= patchZ - .05 + 1e-4, `${z}`);
  assert.deepEqual(adapted.anatomicalSigns, input.anatomicalSigns);
});

test('rejects conflicts below the rim or beyond the distortion bound instead of shrinking', async () => {
  const input = spec(), rimTop = input.parameters.abutment.height + Math.min(...input.crownShape.rimZ) * 3.5;
  const below = await planOcclusalAdaptation(input, [{ id: 'low', role: 'antagonist', positions: patch(input, rimTop - .2, -3, 3), targetGap: 0 }]);
  assert.equal(below.spec, null);
  assert.match(below.report.reason, /rim/);
  const deep = await planOcclusalAdaptation(input, [{ id: 'deep', role: 'antagonist', positions: patch(input, crownTop(input) - .9, -3, 3), targetGap: 0 }], {}, { maxRelativeChange: .1 });
  assert.equal(deep.spec, null);
  assert.match(deep.report.reason, /distortion/);
});

test('missing, distant or behind-base antagonists never count as free clearance', async () => {
  const input = spec();
  assert.equal((await planOcclusalAdaptation(input, [])).report.status, 'rejected');
  const beside = await planOcclusalAdaptation(input, [{ id: 'beside', role: 'antagonist', positions: patch(input, 4, 20, 30) }]);
  assert.equal(beside.spec, null);
  assert.match(beside.report.reason, /unknown/);
  const behind = await planOcclusalAdaptation(input, [{ id: 'behind', role: 'antagonist', positions: patch(input, -2, -5, 5, -5, 5) }]);
  assert.equal(behind.spec, null);
  const clear = await planOcclusalAdaptation(input, [{ id: 'open', role: 'antagonist', positions: patch(input, crownTop(input) + 1, -5, 5, -5, 5) }]);
  assert.equal(clear.report.status, 'not-needed');
  assert.equal(clear.spec, null);
});

test('cancellation and target budgets are enforced', async () => {
  const input = spec(), surfaces = [{ id: 'opp', role: 'antagonist', positions: patch(input, crownTop(input) - .2, -3, 3) }];
  let calls = 0;
  await assert.rejects(planOcclusalAdaptation(input, surfaces, { checkCancelled: () => ++calls > 3, yieldControl: async () => {} }), OcclusalAdaptationCancelled);
  class ParentCancelled extends Error {}
  await assert.rejects(planOcclusalAdaptation(input, surfaces, { checkCancelled: () => { if (++calls > 8) throw new ParentCancelled(); return false; } }), ParentCancelled);
  const expired = await planOcclusalAdaptation(input, surfaces, { yieldControl: () => new Promise(resolve => setTimeout(resolve, 5)) }, { maxDurationMs: 1 });
  assert.equal(expired.spec, null);
  assert.match(expired.report.reason, /time budget/);
  await assert.rejects(planOcclusalAdaptation(input, surfaces, {}, { maxDurationMs: 0 }), /Time budget/);
  await assert.rejects(planOcclusalAdaptation(input, surfaces, {}, { maxTargetTriangles: 1 }), /triangle budget/);
});

test('an interior antagonist below the perimeter rim but above the radial wall section still adapts locally', async () => {
  const input = spec(), H = input.parameters.crown.height, base = input.parameters.abutment.height;
  const rimMin = base + Math.min(...input.crownShape.rimZ) * H, half = .25;
  const centre = (s) => {
    const crown = generateRestoration(s).find(c => c.component === 'crown').positions, out = [];
    for (let i = 0; i < crown.length; i += 3) {
      const x = crown[i] - s.frame.origin[0], y = crown[i + 1] - s.frame.origin[1];
      if (Math.abs(x) <= half && Math.abs(y) <= half) out.push(crown[i + 2] - s.frame.origin[2]);
    }
    return out;
  };
  const peak = Math.max(...centre(input)), gap = .02, patchZ = rimMin - .05;
  assert.ok(peak > patchZ - gap, `fixture must conflict: peak ${peak}, patch ${patchZ}`);
  assert.ok(peak - (patchZ - gap) <= .3 * H, 'fixture stays inside the 30% bound');
  const { spec: adapted, report } = await planOcclusalAdaptation(input, [{ id: 'interior-cusp', role: 'antagonist', positions: patch(input, patchZ, -half, half, -half, half), targetGap: gap }]);
  assert.equal(report.status, 'adapted', report.reason);
  for (const z of centre(adapted)) assert.ok(z <= patchZ - gap + 1e-4, `${z}`);
  // Exclude the artificial basal cap (z = base); occlusal vertices keep the base reserve.
  assert.ok(Math.min(...centre(adapted).filter(z => z > base + 1e-6)) >= base + .05 * H - 1e-4, 'Base reserve retained.');
  for (const key of ['rim', 'rimZ', 'wall']) assert.deepEqual(adapted.crownShape[key], input.crownShape[key], key);
  assert.ok(auditCrownMesh(buildCrownMesh(adapted.crownShape, [5.2, 4.6, H])).closed);
  // The same depth over the perimeter overlaps actual wall vertices and is rejected.
  const wall = await planOcclusalAdaptation(input, [{ id: 'perimeter', role: 'antagonist', positions: patch(input, patchZ, 1.8, 3, -.6, .6), targetGap: gap }]);
  assert.equal(wall.spec, null);
  assert.match(wall.report.reason, /rim\/wall/);
  // An interior conflict deeper than the bound is rejected rather than cut.
  const deep = await planOcclusalAdaptation(input, [{ id: 'interior-deep', role: 'antagonist', positions: patch(input, patchZ, -half, half, -half, half), targetGap: gap }], {}, { maxRelativeChange: (peak - (patchZ - gap)) / H * .5 });
  assert.equal(deep.spec, null);
  assert.match(deep.report.reason, /distortion/);
});
