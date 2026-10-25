import test from 'node:test';
import assert from 'node:assert/strict';
import { fittingSurfaces, specForAIGeneration, specForHypothesis, withAIGenerationDesign } from '../src/workflow-geometry.ts';
import { generateRestoration, restorationCrownShape } from '../src/restoration-geometry.ts';
import { Matrix4, Vector3 } from 'three';
import { partMatrix } from '../src/pose.ts';
import { restorationCrownParts, restorationFitParts } from '../src/restoration-fit-targets.ts';

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

function assembly(id, fdi, parentPartId, origin, extra = {}) {
  const input = { ...spec(), fdi, parentPartId, frame: { ...spec().frame, origin }, ...extra };
  const shifted = Float32Array.from(near, (value, i) => value + origin[i % 3]);
  return { id, spec: input, createdAt: '2026-10-25T00:00:00.000Z', warnings: [], parts: ['fixture', 'abutment', 'crown'].map(component => ({
    ...part(`${id}-${component}`, 'model', shifted.slice()), visible: true,
    restoration: { assemblyId: id, component, parentPartId },
  })) };
}

test('generated neighbors and antagonists are separate named crown targets beside the original scans', () => {
  const input = { ...spec(), anatomicalSigns: { mesial: -1, buccal: 1 } };
  const sources = [part('lower', 'lower'), part('upper', 'upper')];
  const assemblies = [assembly('mesial', 35, 'lower', [-2, 0, 0]), assembly('distal', 37, 'lower', [2, 0, 0]),
    assembly('opposite', 26, 'upper', [0, 0, 4]), assembly('farther', 34, 'lower', [-4, 0, 0]),
    assembly('self', 36, 'lower', [0, 0, 0]), assembly('same-site-alternative', 36, 'lower', [0, 0, 0])];
  const before = structuredClone({ sources, assemblies });
  const requestParts = restorationFitParts(input, 'self', sources, assemblies);
  assert.deepEqual(requestParts.filter(part => part.restoration).map(part => part.restoration.component), ['crown', 'crown', 'crown', 'crown']);
  const targets = fittingSurfaces(input, requestParts, { labels: { lower: Uint8Array.of(34) }, teeth: {} });
  const crowns = targets.filter(target => target.id.includes(':generated-crown:'));
  assert.deepEqual(crowns.map(target => [target.id.split(':')[2], target.role, target.side]), [
    ['mesial', 'adjacent', 'mesial'], ['distal', 'adjacent', 'distal'], ['opposite', 'antagonist', undefined], ['farther', 'other-tooth', undefined],
  ]);
  assert.ok(targets.some(target => target.id === 'lower:FDI-34:local-triangles'));
  assert.ok(targets.some(target => target.id === 'upper:opposing-local-triangles'));
  assert.ok(crowns.every(target => target.targetProvenance.includes('Generated crown concept') && target.targetProvenance.includes('file units') || target.role === 'other-tooth'));
  assert.deepEqual({ sources, assemblies }, before);
  // Defense in depth if a caller supplies own and comparison descriptors.
  const all = fittingSurfaces(input, [...sources, ...restorationCrownParts(sources, assemblies)], { labels: {}, teeth: {} });
  assert.ok(all.every(target => !target.id.includes(':self:') && !target.id.includes(':same-site-alternative:')));
});

test('neutral neighboring crowns use geometry and retain no template FDI in their target label', () => {
  const neutral = siteId => ({ siteId, templateFdi: 36, alternatives: [46], basis: 'Side unresolved.' });
  const input = { ...spec(), draftIdentity: neutral('current'), anatomicalSigns: { mesial: -1, buccal: 1 } };
  const source = part('lower', 'lower');
  const assemblies = [assembly('own', 36, 'lower', [0, 0, 0], { draftIdentity: neutral('current') }),
    assembly('neighbor', 36, 'lower', [-2, 0, 0], { draftIdentity: neutral('neighbor') }),
    assembly('behind-neighbor', 36, 'lower', [-4, 0, 0], { draftIdentity: neutral('behind') })];
  const targets = fittingSurfaces(input, restorationFitParts(input, 'own', [source], assemblies), { labels: {}, teeth: {} });
  const crowns = targets.filter(target => target.id.includes(':generated-crown:'));
  assert.deepEqual(crowns.map(target => target.role), ['adjacent', 'other-tooth']);
  assert.equal(crowns[0].side, 'mesial');
  assert.ok(crowns.every(target => !target.id.includes('FDI') && target.targetProvenance.includes('identity unresolved')));
});

test('only the latest usable crown of another site is supplied, including hidden geometry', () => {
  const sources = [part('lower', 'lower')], first = assembly('first', 35, 'lower', [-2, 0, 0]), last = assembly('last', 35, 'lower', [-2, 0, 0]);
  last.parts.forEach(part => { part.visible = false; });
  const stale = assembly('stale', 37, 'lower', [2, 0, 0]); stale.warnings.push('STALE: surfaces changed.');
  const targets = restorationFitParts(spec(), 'current', sources, [first, last, stale]);
  assert.deepEqual(targets.filter(part => part.restoration).map(part => part.restoration.assemblyId), ['last']);
});

test('a generated crown between a named scan flank and the site receives the contact objective', () => {
  const sources = [part('lower', 'lower')], site = { partId: 'lower', patchFaces: [], adjacent: { mesial: { partId: 'lower', fdi: 34 }, distal: null } };
  for (const x of [-2, -1000]) {
    const targets = fittingSurfaces(spec(), restorationFitParts(spec(), 'current', sources, [assembly('neighbor', 35, 'lower', [x, 0, 0])]),
      { labels: { lower: Uint8Array.of(34) }, teeth: {} }, site);
    const scan = targets.find(target => target.id === 'lower:FDI-34:local-triangles');
    assert.equal(scan.role, x === -2 ? 'other-tooth' : 'adjacent', 'An out-of-context crown must not remove the existing scan objective.');
    assert.equal(scan.side, x === -2 ? undefined : 'mesial');
  }
});

test('generated crown registration, manual rotation and offset match display transforms exactly once', () => {
  const lower = part('lower', 'lower'), upper = part('upper', 'upper');
  lower.pose = new Matrix4().makeTranslation(100, -40, 20).toArray(); lower.rotation = [0, 0, 17]; lower.offset = [1, 0, 0];
  upper.pose = new Matrix4().makeRotationY(.1).setPosition(100, -40, 23).toArray(); upper.rotation = [0, 0, -11]; upper.offset = [0, 1, 0];
  const neighbor = assembly('opposing', 26, 'upper', [0, 0, 1]);
  const raw = neighbor.parts.find(part => part.restoration.component === 'crown');
  // Reopened components already have a saved world pose. It must be replaced,
  // not compounded with their source's current registration.
  raw.pose = new Matrix4().makeTranslation(-900, 800, 700).toArray(); raw.rotation = [2, 0, 3]; raw.offset = [.1, .2, .3];
  const before = structuredClone({ lower, upper, neighbor });
  const input = spec(), targets = fittingSurfaces(input, restorationFitParts(input, 'current', [lower, upper], [neighbor]), { labels: {}, teeth: {} });
  const crown = targets.find(target => target.id.includes(':generated-crown:'));
  const expectedMatrix = partMatrix(lower).invert().multiply(partMatrix({ ...raw, pose: partMatrix(upper).toArray() }));
  const expected = new Float32Array(raw.positions.length), point = new Vector3();
  for (let i = 0; i < expected.length; i += 3) point.fromArray(raw.positions, i).applyMatrix4(expectedMatrix).toArray(expected, i);
  assert.deepEqual(crown.positions, expected);
  assert.deepEqual({ lower, upper, neighbor }, before);
});

function aiSite() {
  const measured = value => ({ value, unit: 'file units (u)', method: 'Synthetic measurement', provenance: 'measured' });
  return { id: 'real-local-site', fdi: 36, partId: 'lower', arch: 'lower', status: 'proposed-missing',
    anchor: { partId: 'lower', face: 0, point: [10, 20, 30] }, frame: { ...spec().frame, origin: [10, 20, 30] },
    frameBasis: 'Current local surface frame.', mesialSign: -1, buccalSign: 1,
    slot: { index: 0, count: 1, s: [4, 8] }, adjacent: { mesial: null, distal: null },
    space: { proximalGap: measured(.8), mesiodistal: measured(1), buccolingual: measured(1), crownHeight: measured(1), vertical: measured(1) } };
}

test('distal-extension spec builders retain truthful evidence and only a mesial fitting neighbour', () => {
  const site = aiSite(); site.kind = 'distal-extension';
  site.frame.origin = [0, 0, 0]; site.anchor.point = [0, 0, 0]; site.patchFaces = Uint32Array.of(1);
  site.draftIdentity = { templateFdi: site.fdi, alternatives: [], basis: 'Tentative distal illustration; FDI unconfirmed.' };
  site.adjacent = { mesial: { partId: 'lower', toothId: 1, fdi: null, confidence: 0 }, distal: null };
  for (const built of [specForHypothesis(site, []), specForAIGeneration(site, [], exactDesign(), 'Illustrative one-sided draft.')]) {
    assert.equal(built.siteEvidence.method, 'distal-extension');
    assert.deepEqual(built.siteEvidence.fdis, []); assert.equal(built.draftIdentity.siteId, site.id);
    const input = part('lower', 'lower', Float32Array.from([...near, ...near]));
    const scans = [{ partId: 'lower', scan: { candidates: [{ id: 1, faces: Uint32Array.of(0) }] } }];
    const surfaces = fittingSurfaces(built, [input], { labels: {}, teeth: {} }, site, scans);
    assert.deepEqual(surfaces.filter(surface => surface.role === 'adjacent').map(surface => surface.side), ['mesial']);
    assert.equal(generateRestoration(built).length, 3);
  }
});
const exactDesign = () => ({ anatomy: 'molar', anatomySource: 'procedural-template', parameters: spec().parameters, contour: { cervicalScale: .77, occlusalScale: 1.23 } });

test('AI specification uses local placement and exact authored values without geometric initialization', () => {
  const site = aiSite(), scans = [{ partId: 'lower' }, { partId: 'upper' }], design = exactDesign(), before = structuredClone({ site, scans, design });
  const local = specForHypothesis(site, scans), exact = specForAIGeneration(site, scans, design, 'Use explicit morphology and dimensions.');
  assert.notDeepEqual(exact.parameters, local.parameters, 'The deliberately oversized request must not be replaced by measured-envelope defaults.');
  assert.deepEqual(exact.parameters, design.parameters); assert.deepEqual(exact.contour, design.contour);
  assert.equal(exact.anatomy, design.anatomy); assert.deepEqual(exact.frame, site.frame);
  assert.deepEqual(exact.anatomicalSigns, { mesial: site.mesialSign, buccal: site.buccalSign });
  assert.equal(exact.parentPartId, site.partId); assert.deepEqual(exact.siteEvidence.surface, site.anchor);
  assert.deepEqual(exact.siteEvidence.partIds, ['lower', 'upper']); assert.deepEqual(exact.siteEvidence.fdis, [36]);
  assert.equal(exact.crownShape.source.kind, 'procedural-template'); assert.equal(exact.crownShape.toothClass, 'molar');
  assert.match(exact.source, /AI-directed design/); assert.match(exact.source, /skills\/dental-restoration-design\/SKILL.md/);
  assert.deepEqual({ site, scans, design }, before);
  for (const measure of Object.values(site.space)) measure.value = null;
  assert.equal(specForHypothesis(site, scans), null);
  assert.deepEqual(specForAIGeneration(site, scans, design, 'Retain explicit values with unknown dimensions.').parameters, design.parameters);
  exact.parameters.crown.width *= 2; exact.frame.origin[0] += 50;
  assert.deepEqual(design, before.design); assert.deepEqual(site.frame, before.site.frame);
});

test('AI generation rejects missing local placement and wrong named anatomy while allowing an unidentified site template', () => {
  const design = { ...exactDesign(), anatomy: 'premolar' }, site = aiSite();
  assert.throws(() => specForAIGeneration(site, [], design, 'Review anatomy.'), /named FDI tooth class/);
  site.draftIdentity = { templateFdi: 36, alternatives: [35], basis: 'Shape only; identity unresolved.' };
  const neutral = specForAIGeneration(site, [], design, 'Use another illustrative class.');
  assert.equal(neutral.anatomy, 'premolar'); assert.equal(neutral.crownShape.toothClass, 'premolar');
  assert.equal(neutral.draftIdentity.siteId, site.id); assert.deepEqual(neutral.siteEvidence.fdis, []);
  site.fdi = 35; site.draftIdentity.templateFdi = 35;
  assert.equal(specForAIGeneration(site, [], design, 'Select the premolar template.').draftIdentity.templateFdi, 35);
  for (const change of [value => { value.anchor = null; }, value => { value.frame = null; }, value => { value.fdi = null; }, value => { value.arch = 'upper'; }]) {
    const invalid = structuredClone(site); change(invalid);
    assert.throws(() => specForAIGeneration(invalid, [], design, 'Explicit dimensions do not invent placement.'), /localized missing-site/);
  }
});

test('worker AI preparation parses the complete strict design and pins the selected procedural template', () => {
  const site = aiSite(), design = exactDesign(), input = specForAIGeneration(site, [], design, 'Pinned template regression.');
  // A caller-supplied edited shape cannot override the selected source.
  input.crownShape.occlusal[0] *= .8;
  const result = withAIGenerationDesign(input, site, [], [], design);
  assert.deepEqual(result.crownShape, restorationCrownShape({ ...input, crownShape: undefined }));
  assert.deepEqual(result.parameters, design.parameters); assert.deepEqual(result.contour, design.contour);
  for (const bad of [
    { ...design, extra: true }, { ...design, contour: undefined },
    { ...design, parameters: { ...design.parameters, crown: { ...design.parameters.crown, extra: 1 } } },
    { ...design, contour: { ...design.contour, cervicalScale: .2 } },
    { ...design, parameters: { ...design.parameters, fixture: { ...design.parameters.fixture, radius: Infinity } } },
  ]) assert.throws(() => withAIGenerationDesign(input, site, [], [], bad));
  const changed = structuredClone(input); changed.parameters.crown.width *= .9;
  assert.throws(() => withAIGenerationDesign(changed, site, [], [], design), /differs from the authorized design/);
  const donorDesign = { ...design, anatomySource: 'patient-donor' };
  assert.throws(() => withAIGenerationDesign(input, site, [], [], donorDesign), /patient donor.*unavailable or ineligible/);
});
