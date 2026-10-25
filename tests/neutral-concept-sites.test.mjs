import test from 'node:test';
import assert from 'node:assert/strict';
import { automaticConceptSites, conceptKey } from '../src/planning-automation.ts';
import { emptyToothCase } from '../src/tooth-session.ts';

function fixture() {
  const measure = value => ({ value, unit: 'file units (u)', method: 'Synthetic surface measurement', provenance: 'measured' });
  const positions = Float32Array.from([0, 20, 40, 60].flatMap(x => [
    x - 3, -2, 0, x + 3, -2, 0, x + 3, 2, 0,
    x - 3, -2, 0, x + 3, 2, 0, x - 3, 2, 0,
  ]));
  const parts = [{ id: 'lower-ridge', role: 'lower', name: 'Disjoint ridge patches', fileName: 'ridge.ply',
    positions, normals: Float32Array.from({ length: positions.length }, (_, i) => i % 3 === 2 ? 1 : 0),
    triangles: 8, vertices: 24, dimensions: [66, 4, 0], closed: false, visible: true, offset: [0, 0, 0] }];
  const teeth = emptyToothCase();
  teeth.labels['lower-ridge'] = new Uint8Array(8);
  teeth.reviewedMask = { 'lower-ridge': new Uint8Array(8) };
  const sites = ['ridge-a', 'ridge-b', 'ridge-c'].map((id, index) => {
    const origin = [index * 20, 0, 0];
    return { id, arch: 'lower', partId: 'lower-ridge', fdi: null,
      draftIdentity: { templateFdi: 36, alternatives: [35, 37], basis: 'Template only; tooth identity unresolved.' },
      alternatives: [], status: 'identity-unresolved', confidence: .8, priority: 'medium', kind: 'bounded',
      slot: { index: 0, count: 1, s: [index * 20 - 3, index * 20 + 3] },
      evidence: { supporting: [`${id}:surface`], conflicting: [] },
      anchor: { partId: 'lower-ridge', face: index * 2, point: [...origin] },
      patchFaces: Uint32Array.of(index * 2, index * 2 + 1),
      frame: { origin, u: [1, 0, 0], v: [0, 1, 0], up: [0, 0, 1] }, frameBasis: 'Disjoint bounded ridge patch.',
      mesialSign: 1, buccalSign: 1, adjacent: { mesial: null, distal: null }, opposing: null, contralateral: null,
      space: { mesiodistal: measure(4), proximalGap: measure(4), buccolingual: measure(4), vertical: measure(3), crownHeight: measure(3) }, questions: [],
    };
  });
  return { sites, teeth, parts, counts: {}, result: { model: 'local-geometry', mappings: [], findings: [] } };
}

test('concept keys use neutral site identity independently of the shared shape template', () => {
  const a = { fdi: 36, siteId: 'ridge-a', draftIdentity: { templateFdi: 36 } };
  const b = { fdi: 36, siteId: 'ridge-b', draftIdentity: { templateFdi: 36 } };
  assert.notEqual(conceptKey(a), conceptKey(b));
  assert.equal(conceptKey(a), conceptKey({ fdi: 35, draftIdentity: { siteId: 'ridge-a', templateFdi: 35 } }));
  assert.equal(conceptKey({ ...a, id: a.siteId, siteId: undefined }), conceptKey(a));
  assert.equal(conceptKey({ fdi: 36 }), conceptKey({ fdi: 36, siteId: 'unrelated-surface' }));
  assert.notEqual(conceptKey({ fdi: 36 }), conceptKey({ fdi: 35 }));
  assert.notEqual(conceptKey(a), conceptKey({ fdi: 36 }));
});

test('automatic concepts retain independent neutral sites sharing a template and return disposable copies', () => {
  const input = fixture(), chart = structuredClone(input.teeth), original = structuredClone(input.sites);
  const sites = automaticConceptSites(input);
  assert.deepEqual(sites.map(site => site.id), ['ridge-a', 'ridge-b', 'ridge-c']);
  assert.ok(sites.every(site => site.fdi === 36 && site.status === 'proposed-missing'));
  assert.equal(new Set(sites.map(site => conceptKey(site))).size, 3);
  assert.deepEqual(input.sites, original); assert.deepEqual(input.teeth, chart);
  sites[0].draftIdentity.templateFdi = 35;
  assert.deepEqual(input.sites, original, 'Disposable shape selection must not edit retained site evidence.');
});

test('anatomical duplicate FDIs are blocked while a separate neutral site using that shape is retained', () => {
  const input = fixture();
  input.sites = input.sites.map((site, index) => index < 2 ? { ...site, fdi: 36, draftIdentity: undefined, status: 'proposed-missing' } : site);
  assert.deepEqual(automaticConceptSites(input).map(site => site.id), ['ridge-c']);
});

test('duplicate site IDs and overlapping patches on the same source are held for review', () => {
  for (const conflict of ['duplicate neutral ID', 'duplicate anatomical ID', 'overlapping faces', 'overlapping different templates']) {
    const input = fixture();
    if (conflict.startsWith('duplicate')) {
      input.sites[1] = { ...input.sites[1], id: input.sites[0].id };
      if (conflict === 'duplicate anatomical ID') for (let index = 0; index < 2; index++) {
        input.sites[index] = { ...input.sites[index], fdi: 35 + index, draftIdentity: undefined, status: 'proposed-missing' };
      }
    } else {
      input.sites[1] = { ...input.sites[1], patchFaces: Uint32Array.of(1, 2),
        ...(conflict === 'overlapping different templates' ? { draftIdentity: { ...input.sites[1].draftIdentity, templateFdi: 35 } } : {}) };
    }
    assert.deepEqual(automaticConceptSites(input).map(site => site.id), ['ridge-c'], conflict);
    input.sites.reverse();
    assert.deepEqual(automaticConceptSites(input).map(site => site.id), ['ridge-c'], `${conflict} must not depend on input order`);
  }
});

test('equal face numbers on separate imported parts do not conflict', () => {
  const input = fixture();
  input.parts.push({ ...input.parts[0], id: 'other-ridge',
    positions: input.parts[0].positions.map((value, index) => index % 3 === 0 ? value + 20 : value) });
  input.teeth.labels['other-ridge'] = new Uint8Array(8);
  input.sites[1] = { ...input.sites[1], partId: 'other-ridge', patchFaces: input.sites[0].patchFaces.slice(),
    anchor: { ...input.sites[1].anchor, partId: 'other-ridge', face: 0 } };
  assert.deepEqual(automaticConceptSites(input).map(site => site.id), ['ridge-a', 'ridge-b', 'ridge-c']);
});

test('same-template neutral sites still respect reviewed surface protection and explicit rejection', () => {
  for (const blocked of ['label', 'reviewed zero', 'rejected']) {
    const input = fixture();
    if (blocked === 'label') input.teeth.labels['lower-ridge'][0] = 255;
    else if (blocked === 'reviewed zero') input.teeth.reviewedMask['lower-ridge'][0] = 1;
    else input.decisions = { 'ridge-a': null };
    assert.deepEqual(automaticConceptSites(input).map(site => site.id), ['ridge-b', 'ridge-c'], blocked);
  }
});
