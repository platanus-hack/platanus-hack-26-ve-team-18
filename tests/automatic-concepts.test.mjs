import test from 'node:test';
import assert from 'node:assert/strict';
import { automaticConceptSites } from '../src/planning-automation.ts';
import { specForHypothesis } from '../src/workflow-geometry.ts';
import { generateRestoration } from '../src/restoration-geometry.ts';
import { emptyToothCase } from '../src/tooth-session.ts';
import { createPlanningSession, readPlanningSession } from '../src/planning-session.ts';
import { planningExportBundle, planningExportManifest } from '../src/planning-export.ts';
import { prepareCase } from '../src/case-preparation.ts';

const roundtrip = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const part = {
    id: 'original-upper', name: 'Synthetic upper', fileName: 'synthetic-upper.ply', role: 'upper',
    positions: Float32Array.of(0,0,0, 4,0,0, 0,4,0, 4,0,0, 4,4,0, 0,4,0),
    normals: Float32Array.of(0,0,1, 0,0,1, 0,0,1, 0,0,1, 0,0,1, 0,0,1),
    triangles: 2, vertices: 4, dimensions: [4,4,0], offset: [0,0,0], closed: false, visible: true,
  };
  const teeth = emptyToothCase();
  teeth.labels[part.id] = Uint8Array.of(16, 0);
  teeth.reviewedMask = { [part.id]: Uint8Array.of(1, 0) };
  teeth.teeth[16] = { status: 'present', restoration: 'none', note: 'Reviewed neighbouring tooth.' };
  const measured = value => ({ value, unit: 'file units (u)', method: 'Synthetic local surface measurement.', provenance: value === null ? 'unknown' : 'measured' });
  const site = {
    id: `upper-${part.id}-gap-1`, arch: 'upper', partId: part.id, fdi: null, alternatives: [],
    draftIdentity: { templateFdi: 15, alternatives: [15, 25, 14], basis: 'Latent local sequence selects an illustrative template; patient side and anatomical identity remain unresolved.' },
    status: 'identity-unresolved', confidence: 0, priority: 'low', kind: 'bounded',
    slot: { index: 0, count: 1, s: [1,3] },
    evidence: { supporting: ['Scanned ridge between local crowns.'], conflicting: ['Patient right is unconfirmed.'] },
    anchor: { partId: part.id, face: 1, point: [2,2,0] }, patchFaces: Uint32Array.of(1),
    frame: { origin: [2,2,0], u: [1,0,0], v: [0,1,0], up: [0,0,1] }, frameBasis: 'Local ridge tangent; anatomical signs are hypotheses.',
    frameEvidence: { status: 'hypothesized', mesial: 'unknown', buccal: 'unknown', limitations: ['Patient right is unconfirmed.'] },
    mesialSign: 1, buccalSign: -1, adjacent: { mesial: null, distal: null }, opposing: null, contralateral: null,
    space: { mesiodistal: measured(2), proximalGap: measured(2), buccolingual: measured(3), vertical: measured(null), crownHeight: measured(4) },
    questions: ['Optional identity correction.'],
  };
  const result = { revision: 'automatic-revision', model: 'external-assessment', summary: 'No provider draft approval.', mappings: [], findings: [], actions: [], designs: [], limitations: [] };
  return { sites: [site], teeth, counts: { 16: 1 }, parts: [part], result, decisions: {} };
}

function assemblyFor(spec) {
  const id = 'automatic-draft';
  return {
    id, spec, draftSite: true, createdAt: '2026-10-24T12:00:00.000Z', warnings: ['Anatomical identity and patient side unresolved; clinical fit unvalidated.'],
    parts: generateRestoration(spec).map(mesh => ({
      ...mesh, id: `${id}-${mesh.component}`, name: `Unresolved draft ${mesh.component}`, fileName: `draft-${mesh.component}.ply`,
      role: 'model', offset: [0,0,0], visible: true, restoration: { assemblyId: id, component: mesh.component, parentPartId: spec.parentPartId },
    })),
  };
}

// Connected synthetic gum sheet with six crowns and one bounded empty slot.
// This follows the arch fixtures in case-preparation.test.mjs without patient files.
function syntheticArchWithGap() {
  const count = 7, radius = count * 1.12, step = .22;
  const centers = Array.from({ length: count }, (_, i) => {
    const angle = .12 + (Math.PI - .24) * i / (count - 1);
    return [radius * Math.cos(angle), radius * Math.sin(angle)];
  });
  const nx = Math.ceil((radius * 2 + 4) / step), ny = Math.ceil((radius + 4) / step);
  const points = Array.from({ length: ny + 1 }, (_, y) => Array.from({ length: nx + 1 }, (_, x) => {
    const px = -radius - 2 + x * (radius * 2 + 4) / nx, py = -2 + y * (radius + 4) / ny;
    let height = 0;
    centers.forEach(([cx, cy], i) => {
      if (i === 3) return;
      const r = Math.hypot(px - cx, py - cy) / 1.43;
      if (r < 1) height = Math.max(height, 2.3 * (.5 + .5 * Math.cos(Math.PI * r)));
    });
    return [px, py, height];
  }));
  const faces = [];
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    const a = points[y][x], b = points[y][x + 1], c = points[y + 1][x + 1], d = points[y + 1][x];
    faces.push(...a, ...b, ...d, ...b, ...c, ...d);
  }
  return Float32Array.from(faces);
}

test('real preparation retains a latent shape template before clearing unknown patient-side identities', () => {
  const positions = syntheticArchWithGap(), before = positions.slice(), partId = 'synthetic-gap';
  const prepared = prepareCase({ id: 1, revision: 'synthetic-gap-revision', confidenceThreshold: 1,
    sources: [{ id: partId, arch: 'upper', positions }], patientRight: { [partId]: null } });
  const source = prepared.scans[0];
  assert.equal(source.scan.candidates.length, 6, 'the fixture must exercise a real bounded crown gap');
  assert.equal(source.numbering, null);
  assert.ok(source.analysis.teeth.every(tooth => tooth.fdi === null));
  assert.ok(source.analysis.gaps.every(gap => gap.positions.length === 0));
  assert.ok(prepared.identities.every(identity => identity.fdi === null));
  assert.ok(source.draftLabels.every(label => label === 0));
  const eligible = automaticConceptSites({ sites: prepared.sites, parts: [{ id: partId, role: 'upper', triangles: positions.length / 9 }], teeth: emptyToothCase(), counts: {}, result: fixture().result });
  assert.equal(eligible.length, 1);
  const publicSite = prepared.sites.find(site => site.id === eligible[0].id);
  assert.equal(publicSite.fdi, null);
  assert.deepEqual(publicSite.alternatives, []);
  assert.equal(publicSite.status, 'identity-unresolved');
  assert.equal(publicSite.confidence, 0);
  assert.ok(publicSite.draftIdentity.alternatives.includes(publicSite.draftIdentity.templateFdi));
  assert.match(publicSite.draftIdentity.basis, /patient side.*unresolved/i);
  assert.ok(publicSite.patchFaces.length > 0 && publicSite.frame && publicSite.anchor);
  assert.ok(['mesiodistal', 'buccolingual', 'crownHeight'].every(key => publicSite.space[key].value > 0));
  assert.equal(generateRestoration(specForHypothesis(eligible[0], prepared.scans)).length, 3);
  assert.deepEqual(positions, before);
});

test('an unknown-side, zero-confidence bounded site builds three draft components without provider approval or chart changes', () => {
  const input = fixture(), before = structuredClone(input);
  const selected = automaticConceptSites(input);
  assert.equal(selected.length, 1);
  assert.notEqual(selected[0], input.sites[0], 'construction uses a disposable site copy');
  assert.equal(selected[0].fdi, 15, 'the construction identity selects a shape only');
  assert.equal(selected[0].confidence, 0, 'confidence is not promoted to enable generation');
  assert.deepEqual(selected[0].draftIdentity, input.sites[0].draftIdentity);
  const spec = specForHypothesis(selected[0], []);
  assert.ok(spec);
  assert.equal(spec.fdi, 15);
  assert.deepEqual(spec.draftIdentity, { ...input.sites[0].draftIdentity, siteId: input.sites[0].id });
  assert.equal(spec.anatomy, 'premolar');
  assert.equal(spec.provenance, 'hypothesized');
  assert.equal(spec.units, 'file units (u)');
  assert.deepEqual(spec.siteEvidence.surface, input.sites[0].anchor);
  const components = generateRestoration(spec);
  assert.deepEqual(components.map(mesh => mesh.component), ['fixture', 'abutment', 'crown']);
  for (const mesh of components) {
    assert.ok(mesh.positions instanceof Float32Array && mesh.positions.every(Number.isFinite));
    assert.ok(mesh.triangles > 0 && mesh.dimensions.every(value => value > 0));
  }
  assert.equal(input.sites[0].fdi, null, 'public anatomical identity remains unresolved');
  assert.deepEqual(input, before, 'sites, chart, reviewed labels, masks and geometry remain unchanged');
});

test('missing geometry and structural blocks remain ineligible at every confidence', async t => {
  const cases = [
    ['missing source', input => { input.parts = []; }],
    ['wrong source arch', input => { input.parts[0].role = 'lower'; }],
    ['terminal site', input => { input.sites[0].kind = 'terminal'; }],
    ['chart anchor without bounded geometry', input => { input.sites[0].kind = 'chart'; }],
    ['not scanned', input => { input.sites[0].status = 'not-scanned'; }],
    ['segmentation unresolved', input => { input.sites[0].status = 'segmentation-unresolved'; }],
    ['missing anchor', input => { input.sites[0].anchor = null; }],
    ['missing frame', input => { input.sites[0].frame = null; }],
    ['missing patch', input => { input.sites[0].patchFaces = new Uint32Array(); }],
    ['patch outside original triangles', input => { input.sites[0].patchFaces = Uint32Array.of(2); }],
    ['no latent shape identity', input => { delete input.sites[0].draftIdentity; }],
    ['invalid or opposite-arch templates', input => { input.sites[0].draftIdentity = { ...input.sites[0].draftIdentity, templateFdi: 99, alternatives: [35] }; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => {
    for (const confidence of [0, 1]) {
      const input = fixture(); input.sites[0].confidence = confidence; mutate(input);
      const before = structuredClone(input);
      assert.deepEqual(automaticConceptSites(input), []);
      assert.deepEqual(input, before);
    }
  });
  for (const dimension of ['mesiodistal', 'buccolingual', 'crownHeight']) await t.test(`${dimension} needs a finite positive value`, () => {
    for (const value of [null, 0, -1, NaN, Infinity]) {
      const input = fixture(); input.sites[0].space[dimension].value = value;
      assert.deepEqual(automaticConceptSites(input), [], `${dimension}=${value}`);
    }
  });
});

test('reviewed labels, exclusions, protected zero corrections and explicit skips cannot be overwritten', async t => {
  const cases = [
    ['reviewed tooth', input => { input.teeth.labels[input.parts[0].id][1] = 14; }],
    ['excluded surface', input => { input.teeth.labels[input.parts[0].id][1] = 255; }],
    ['protected zero', input => { input.teeth.reviewedMask[input.parts[0].id][1] = 1; }],
    ['explicit skip', input => { input.decisions[input.sites[0].id] = null; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, () => {
    const input = fixture(); mutate(input); const before = structuredClone(input);
    assert.deepEqual(automaticConceptSites(input), []);
    assert.deepEqual(input, before);
  });
});

test('conflicting chart positions, existing tooth labels and mapped teeth are never used as construction identities', async t => {
  const cases = [
    ['present chart position', (input, code) => { input.teeth.teeth[code].status = 'present'; }],
    ['not-scanned chart position', (input, code) => { input.teeth.teeth[code].status = 'not-scanned'; }],
    ['already assigned tooth', (input, code) => { input.counts[code] = 1; }],
    ['mapping needing review', (input, code) => { input.result.mappings.push({ sourceId: 'scan-1', candidateId: code, fdi: code, needsReview: true, reason: 'Existing tooth hypothesis.' }); }],
  ];
  for (const [name, conflict] of cases) await t.test(name, () => {
    const input = fixture(), originalSite = structuredClone(input.sites[0]);
    conflict(input, 15);
    const [alternative] = automaticConceptSites(input);
    assert.ok(alternative, 'an unconflicted latent alternative remains usable');
    assert.equal(alternative.fdi, 25);
    assert.equal(alternative.draftIdentity.templateFdi, 25);
    assert.deepEqual(input.sites[0], originalSite, 'choosing an alternative must not rewrite the public site');
    for (const code of [25, 14]) conflict(input, code);
    const before = structuredClone(input);
    assert.deepEqual(automaticConceptSites(input), [], 'all latent alternatives conflict');
    assert.deepEqual(input, before);
  });
});

test('resolved FDI has no silent alternative and overlapping geometric sites are withheld', () => {
  const input = fixture(); input.sites[0].fdi = 15; input.sites[0].status = 'proposed-missing'; delete input.sites[0].draftIdentity;
  input.teeth.teeth[15].status = 'present'; input.sites[0].alternatives = [25];
  assert.deepEqual(automaticConceptSites(input), []);

  const duplicates = fixture();
  duplicates.sites.push({ ...structuredClone(duplicates.sites[0]), id: 'second-localized-site' });
  duplicates.sites.push({ ...structuredClone(duplicates.sites[0]), id: 'independent-localized-site', draftIdentity: { ...duplicates.sites[0].draftIdentity, templateFdi: 14, alternatives: [] } });
  const before = structuredClone(duplicates);
  assert.deepEqual(automaticConceptSites(duplicates), []);
  assert.deepEqual(duplicates, before);
});

test('separate unnumbered spaces can share an illustrative template without sharing concept identity', () => {
  const input = fixture(), part = input.parts[0], original = part.positions;
  part.positions = Float32Array.from([...original, ...original.map((value, index) => index % 3 === 0 ? value + 10 : value)]);
  part.normals = Float32Array.from([...part.normals, ...part.normals]); part.triangles = 4; part.vertices = 8; part.dimensions = [14,4,0];
  input.teeth.labels[part.id] = Uint8Array.of(16,0,0,0); input.teeth.reviewedMask[part.id] = Uint8Array.of(1,0,0,0);
  input.sites.push({ ...structuredClone(input.sites[0]), id: 'second-space', patchFaces: Uint32Array.of(3), anchor: { partId: part.id, face: 3, point: [12,2,0] } });
  const sites = automaticConceptSites(input);
  assert.equal(sites.length, 2); assert.ok(sites.every(site => site.fdi === 15));
  const specs = sites.map(site => specForHypothesis(site, []));
  assert.deepEqual(specs.map(spec => spec.draftIdentity.siteId), [input.sites[0].id, 'second-space']);
});

function zipFiles(buffer) {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer), files = new Map();
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    assert.equal(view.getUint16(offset + 8, true), 0);
    const size = view.getUint32(offset + 18, true), nameLength = view.getUint16(offset + 26, true), extraLength = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    const start = offset + 30 + nameLength + extraLength;
    assert.equal(files.has(name), false);
    files.set(name, bytes.slice(start, start + size)); offset = start + size;
  }
  assert.equal(view.getUint32(offset, true), 0x02014b50);
  return files;
}

test('session and mesh export preserve unresolved draft metadata, unknown patient side and reviewed chart', async () => {
  const input = fixture(), source = input.parts[0], spec = specForHypothesis(automaticConceptSites(input)[0], []);
  const scan = { partId: source.id, scan: { frame: input.sites[0].frame, candidates: [], warnings: [], unassignedTriangles: 2, method: 'Synthetic bounded surface.' }, analysis: null, numbering: null, draftLabels: input.teeth.labels[source.id].slice(), warnings: [] };
  const prepared = { id: 1, revision: input.result.revision, scans: [scan], sites: input.sites, identities: [], warnings: [] };
  const state = { parts: input.parts, teeth: input.teeth, assemblies: [assemblyFor(spec)], patientRight: null, confidenceThreshold: 1, manualMode: true,
    draft: { evidence: { revision: prepared.revision, sources: [scan], views: [] }, prepared, result: input.result } };
  const before = structuredClone(state), saved = roundtrip(await createPlanningSession(state));
  assert.equal(saved.patientRight, null);
  assert.equal(saved.mmPerUnit, null);
  assert.equal(saved.draft.prepared.sites[0].fdi, null);
  assert.deepEqual(saved.draft.prepared.sites[0].draftIdentity, input.sites[0].draftIdentity);
  assert.deepEqual(saved.assemblies[0].spec.draftIdentity, { ...input.sites[0].draftIdentity, siteId: saved.draft.prepared.sites[0].id });
  const reopened = await readPlanningSession(saved, input.parts);
  assert.equal(reopened.patientRight, null);
  assert.equal(reopened.draft.prepared.sites[0].fdi, null);
  assert.deepEqual(reopened.draft.prepared.sites[0].draftIdentity, input.sites[0].draftIdentity);
  assert.deepEqual(reopened.assemblies[0].spec.draftIdentity, spec.draftIdentity);
  assert.deepEqual(reopened.teeth, input.teeth);
  const imported = input.parts.map(part => ({ ...part, id: 'reimported-upper' })), importedBefore = structuredClone(imported);
  const renamed = await readPlanningSession(saved, imported), restoredSite = renamed.draft.prepared.sites[0];
  assert.equal(restoredSite.partId, 'reimported-upper');
  assert.equal(restoredSite.anchor.partId, 'reimported-upper');
  assert.equal(restoredSite.fdi, null);
  assert.ok(restoredSite.patchFaces instanceof Uint32Array);
  assert.deepEqual(renamed.assemblies[0].spec.draftIdentity, { ...input.sites[0].draftIdentity, siteId: restoredSite.id });
  assert.equal(renamed.patientRight, null);
  assert.deepEqual(renamed.teeth.teeth, input.teeth.teeth);
  assert.deepEqual(renamed.teeth.labels['reimported-upper'], input.teeth.labels[source.id]);
  assert.deepEqual(renamed.teeth.reviewedMask['reimported-upper'], input.teeth.reviewedMask[source.id]);
  assert.deepEqual(imported, importedBefore);
  const savedAgain = roundtrip(await createPlanningSession(renamed));
  const manifest = roundtrip(planningExportManifest(savedAgain));
  assert.deepEqual(manifest.assemblies[0].spec.draftIdentity, savedAgain.assemblies[0].spec.draftIdentity);
  assert.equal(manifest.assemblies[0].exported, true);
  assert.equal(manifest.mmPerUnit, null);
  assert.ok(manifest.assemblies[0].parts.every(part => part.path.startsWith('draft-site/') && !part.path.includes('FDI-')));
  const files = zipFiles(await planningExportBundle(savedAgain).arrayBuffer());
  assert.equal(files.size, 4, 'one manifest and three independent component meshes');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(files.get('manifest.json'))), manifest);
  for (const part of manifest.assemblies[0].parts) assert.ok(files.has(part.path));
  assert.deepEqual(state, before, 'saving, reopening and exporting cannot mutate original inputs');
});
