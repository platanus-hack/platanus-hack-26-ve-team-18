import test from 'node:test';
import assert from 'node:assert/strict';
import { fittingSurfaces } from '../src/workflow-geometry.ts';
import { generateRestoration } from '../src/restoration-geometry.ts';

const spec = () => ({ version: 'implant-assembly/v1', fdi: 36, parentPartId: 'lower',
  frame: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], up: [0, 0, 1] },
  parameters: { fixture: { radius: 1, length: 5, depth: .5, taper: .2 }, abutment: { radius: .8, height: 2, emergenceRadius: 1.2, angleX: 0, angleY: 0 }, crown: { width: 2, depth: 2, height: 2, cuspHeight: .3, rotation: 0 } },
  anatomy: 'molar', provenance: 'hypothesized', units: 'file units (u)', source: 'Synthetic target extraction regression' });
const near = Float32Array.of(-1, -1, 1, 1, -1, 1, 0, 1, 1);
const part = (id, role, positions = near) => ({ id, role, positions, normals: new Float32Array(positions.length), triangles: positions.length / 9, offset: [0, 0, 0] });

test('localized fallback retains labeled neighbors and unclassified source arch without a SiteHypothesis', () => {
  const positions = Float32Array.from([...near, ...near.map((value, i) => i % 3 === 0 ? value + 2 : value)]);
  const parts = [part('lower', 'lower', positions), part('bite', 'bite'), part('upper', 'upper')];
  const teeth = { labels: { lower: Uint8Array.of(35, 0) }, teeth: {} };
  const before = structuredClone({ parts, teeth });
  const targets = fittingSurfaces(spec(), parts, teeth);
  assert.deepEqual(targets.map(target => target.role).sort(), ['adjacent', 'antagonist', 'source-arch']);
  assert.equal(targets.find(target => target.role === 'adjacent').side, undefined, 'without a site, proximity does not establish mesial/distal identity');
  assert.equal(targets.find(target => target.role === 'source-arch').positions.length, 9);
  assert.equal(targets.some(target => target.id.startsWith('bite:')), false);
  assert.deepEqual({ parts, teeth }, before);
});

test('only the two flanking teeth receive attractive contact targets; other teeth stay crossing context', () => {
  const positions = Float32Array.from([...near, ...near, ...near, ...near]);
  const lower = part('lower', 'lower', positions);
  const teeth = { labels: { lower: Uint8Array.of(33, 34, 35, 37) }, teeth: {} };
  for (const site of [undefined, { adjacent: { mesial: { partId:'lower',fdi:35 }, distal:{partId:'lower',fdi:37} }, patchFaces: [], partId: 'lower' }]) {
    const surfaces = fittingSurfaces(spec(), [lower], teeth, site);
    assert.deepEqual(surfaces.filter(surface => surface.role === 'adjacent').map(surface => Number(surface.id.match(/FDI-(\d+)/)[1])).sort(), [35, 37]);
    const other = surfaces.filter(surface => surface.role === 'other-tooth');
    assert.equal(other.length, 2); assert.ok(other.every(surface => surface.targetGap === 0 && surface.positions.length === 9));
  }
});

test('context follows crown displacement from tall and angled abutments', () => {
  for (const [height, angleX, angleY] of [[8, 0, 0], [8, 32, -28]]) {
    const input = spec(); Object.assign(input.parameters.abutment, { height, angleX, angleY });
    const crown = generateRestoration(input).find(mesh => mesh.component === 'crown');
    const opponent = part('upper', 'upper', crown.positions.slice(0, 9));
    const targets = fittingSurfaces(input, [part('lower', 'lower'), opponent], { labels: {}, teeth: {} });
    assert.equal(targets.find(target => target.role === 'antagonist').positions.length, 9);
  }
});

test('large triangles crossing the context survive when their centroid lies outside it', () => {
  const spanning = Float32Array.of(-1, -1, 1, 1, -1, 1, 0, 100, 1);
  const targets = fittingSurfaces(spec(), [part('lower', 'lower'), part('upper', 'upper', spanning)], { labels: {}, teeth: {} });
  assert.deepEqual(targets.find(target => target.role === 'antagonist').positions, spanning);
});

test('context includes the allowed fitting angle range before the first candidate is evaluated', () => {
  const input = spec(); Object.assign(input.parameters.abutment, { height: 8, angleY: 74 });
  const extreme = structuredClone(input); extreme.parameters.abutment.angleY = 80;
  extreme.parameters.abutment.height *= 1.18;
  const crown = generateRestoration(extreme).find(mesh => mesh.component === 'crown');
  const targets = fittingSurfaces(input, [part('lower', 'lower'), part('upper', 'upper', crown.positions.slice(0, 9))], { labels: {}, teeth: {} });
  assert.equal(targets.find(target => target.role === 'antagonist').positions.length, 9);
});

test('draft target labels stay hypotheses, and reviewed labels and zero erasures win', () => {
  const positions = Float32Array.from([...near, ...near, ...near]);
  const lower = part('lower', 'lower', positions);
  const teeth = { labels: { lower: Uint8Array.of(35, 0, 0) }, reviewedMask: { lower: Uint8Array.of(1, 1, 0) }, teeth: {} };
  const targets = fittingSurfaces(spec(), [lower], teeth, undefined, [{ partId: 'lower', draftLabels: Uint8Array.of(34, 34, 37) }]);
  assert.ok(targets.some(target => target.id.includes('FDI-35:local-triangles')));
  assert.ok(targets.some(target => target.id.includes('FDI-37:hypothesized-local-triangles')));
  assert.equal(targets.some(target => target.id.includes('FDI-34')), false);
  assert.equal(targets.find(target => target.role === 'source-arch').positions.length, 9);
});

test('unnumbered drafts fit geometric flank regions while preserving protected corrections', () => {
  const input = spec(); input.draftIdentity = { siteId: 'space', templateFdi: 36, alternatives: [46], basis: 'Unknown patient side.' };
  const positions = Float32Array.from([...near, ...near, ...near, ...near]);
  const lower = part('lower', 'lower', positions);
  const site = { id: 'space', partId: 'lower', patchFaces: Uint32Array.of(3), adjacent: { mesial: { partId: 'lower', toothId: 1, fdi: null }, distal: { partId: 'lower', toothId: 2, fdi: null } } };
  const scans = [{ partId: 'lower', scan: { candidates: [{ id: 1, faces: Uint32Array.of(0, 1) }, { id: 2, faces: Uint32Array.of(2) }] } }];
  const teeth = { labels: { lower: new Uint8Array(4) }, reviewedMask: { lower: Uint8Array.of(0, 1, 0, 0) }, teeth: {} };
  const before = structuredClone({ site, scans, teeth });
  const surfaces = fittingSurfaces(input, [lower], teeth, site, scans);
  const adjacent = surfaces.filter(surface => surface.role === 'adjacent');
  assert.equal(adjacent.length, 2);
  assert.ok(adjacent.every(surface => surface.positions.length === 9 && !surface.id.includes('FDI')));
  assert.deepEqual(adjacent.map(surface => surface.side).sort(), ['distal', 'mesial']);
  assert.equal(surfaces.find(surface => surface.role === 'source-arch').positions.length, 9);
  assert.equal(surfaces.find(surface => surface.role === 'tissue').positions.length, 9);
  assert.deepEqual({ site, scans, teeth }, before);
});

test('target poses are resolved exactly once into the parent source frame', () => {
  const lower = part('lower', 'lower'), upper = part('upper', 'upper');
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, -40, 20, 1];
  lower.pose = [...matrix]; upper.pose = [...matrix];
  const targets = fittingSurfaces(spec(), [lower, upper], { labels: {}, teeth: {} });
  assert.deepEqual(targets.find(target => target.role === 'antagonist').positions, near);
});
