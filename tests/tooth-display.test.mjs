import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import * as THREE from 'three';
import { candidateToothDisplay, mappingDisplayIdentity, toothDisplay } from '../src/tooth-display.ts';
import { MeshViewer } from '../src/viewer.ts';

const candidate = (id = 1, displayIdentity) => ({ id, faces: new Uint32Array([0, 1]), centroid: [0, 0, 0], warnings: [], displayIdentity });
const mapping = (candidateId, fdi, source = 'model', needsReview = false) => ({ candidateId, fdi, source, needsReview, reason: 'Synthetic identity.' });

test('available FDI is independent of geometric IDs and carries explicit review provenance', () => {
  for (const [id, fdi] of [[1, 17], [2, 18], [9, 27]]) {
    const input = candidate(id, mappingDisplayIdentity(mapping(id, fdi)));
    const before = structuredClone(input);
    const draft = candidateToothDisplay(input, { arch: 'upper' });
    assert.equal(draft.label, `FDI ${fdi}`);
    assert.equal(draft.marker, String(fdi));
    assert.equal(draft.note, 'draft');
    assert.match(draft.description, /not reviewed/);
    assert.deepEqual(input, before);
    const reviewed = toothDisplay(mappingDisplayIdentity(mapping(id, fdi, 'user')));
    assert.equal(reviewed.marker, String(fdi));
    assert.equal(reviewed.note, 'reviewed');
    assert.match(reviewed.description, /clinical record unchanged/);
    const uncertain = toothDisplay(mappingDisplayIdentity(mapping(id, fdi, 'model', true)));
    assert.equal(uncertain.marker, `${fdi}?`);
    assert.equal(uncertain.note, 'draft');
    assert.match(uncertain.description, /needs review/);
  }
});

test('unknown, invalid, wrong-arch, or explicitly cleared identities never become invented FDI', () => {
  for (const fdi of [null, 0, 19, 255, 17.5, NaN, 37]) {
    const display = candidateToothDisplay(candidate(17, { fdi, status: 'draft' }), { arch: 'upper', labels: new Uint8Array([18, 18]) });
    assert.equal(display.label, 'Region C17');
    assert.equal(display.note, 'unknown');
  }
  assert.equal(candidateToothDisplay(candidate(18)).label, 'Region C18', 'a region ID resembling FDI is still geometry');
  assert.equal(candidateToothDisplay(candidate(1, { fdi: 17, status: 'draft' }), { arch: null }).note, 'unknown');
});

test('only complete uniform surface labels supply fallback FDI and mixed provenance remains draft', () => {
  const input = candidate();
  const labels = new Uint8Array([27, 27]);
  const before = labels.slice();
  assert.equal(candidateToothDisplay(input, { labels }).marker, '27');
  assert.equal(candidateToothDisplay(input, { labels }).note, 'draft');
  assert.equal(candidateToothDisplay(input, { labels, recordedLabels: labels }).note, '');
  assert.deepEqual(labels, before);
  for (const mixed of [[17, 18], [17, 0], [255, 255], [17]]) {
    assert.equal(candidateToothDisplay(input, { labels: new Uint8Array(mixed) }).note, 'unknown');
  }
  assert.equal(candidateToothDisplay({ ...input, faces: new Uint32Array() }, { labels }).note, 'unknown');
});

test('saved assignments override a stale proposal; partial or mixed saved boundaries do not borrow an identity', () => {
  const input = candidate(1, { fdi: 17, status: 'draft' });
  assert.equal(candidateToothDisplay(input, { recordedLabels: new Uint8Array([18, 18]) }).marker, '18');
  for (const labels of [[18, 0], [17, 18], [255, 0]]) {
    assert.equal(candidateToothDisplay(input, { recordedLabels: new Uint8Array(labels) }).note, 'unknown');
  }
});

test('real viewport annotations update FDI and uncertainty without changing candidate geometry', t => {
  const draws = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({
    getContext: () => ({ fillRect() {}, fillText(text) { draws.push(text); } }),
  }) } });
  t.after(() => previous ? Object.defineProperty(globalThis, 'document', previous) : delete globalThis.document);
  const geometry = new THREE.BufferGeometry();
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  const input = candidate(4, { fdi: 17, status: 'uncertain' });
  const instance = Object.create(MeshViewer.prototype);
  Object.assign(instance, {
    annotations: new THREE.Group(), markerGeometry: new THREE.SphereGeometry(1, 4, 4),
    sources: new Map([['scan', { role: 'upper', triangles: 2 }]]), meshes: new Map([['scan', mesh]]),
    toothView: { enabled: true, labels: {}, autoOverlay: { partId: 'scan', candidates: [input], selectedCandidate: 4 }, sites: [], boundary: [] },
  });
  t.after(() => { instance.clearAnnotations(); instance.markerGeometry.dispose(); geometry.dispose(); mesh.material.dispose(); });
  instance.rebuildAnnotations();
  assert.deepEqual(draws, ['17?', 'draft']);
  draws.length = 0;
  input.displayIdentity = { fdi: 27, status: 'reviewed-mapping' };
  instance.rebuildAnnotations();
  assert.deepEqual(draws, ['27', 'reviewed']);
  draws.length = 0;
  input.displayIdentity = { fdi: null, status: 'uncertain' };
  instance.rebuildAnnotations();
  assert.deepEqual(draws, ['C4', 'unknown']);
  assert.equal(input.id, 4);
  assert.deepEqual([...input.faces], [0, 1]);

  draws.length = 0;
  instance.toothView.autoOverlay = null;
  instance.toothView.planningSites = [{
    id: 'gap', partId: 'scan', arch: 'upper', fdi: 17, draftIdentity: { templateFdi: 27 }, status: 'identity-unresolved',
    anchor: { partId: 'scan', face: 0, point: [0, 0, 0] },
    frame: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], up: [0, 0, 1] }, patchFaces: new Uint32Array(),
    space: { mesiodistal: { value: null }, buccolingual: { value: null }, crownHeight: { value: null } },
  }];
  instance.rebuildAnnotations();
  assert.deepEqual(draws, ['?', 'unknown'], 'illustrative draft template numbers are never anatomical identities');

  const axisCount = () => {
    let count = 0;
    instance.annotations.traverse(object => { if (object.isLine) count++; });
    return count;
  };
  instance.toothView.activeTooth = 11;
  instance.toothView.focusedPlanningSiteId = null;
  instance.rebuildAnnotations();
  assert.equal(axisCount(), 0, 'selecting FDI 11 must not focus an unrelated FDI 17 site');
  instance.toothView.activeTooth = 17;
  instance.rebuildAnnotations();
  assert.equal(axisCount(), 1, 'the matching tooth retains its site annotation');
  instance.toothView.activeTooth = 41;
  instance.toothView.focusedPlanningSiteId = 'gap';
  instance.rebuildAnnotations();
  assert.equal(axisCount(), 1, 'explicit site focus may select an unresolved or other-arch site');
  instance.toothView.focusedPlanningSiteId = null;
  instance.rebuildAnnotations();
  assert.equal(axisCount(), 0, 'clearing upper focus for a lower chart tooth clears the upper axis');
});

// Use the project's existing TSX transformer to verify actual rendered panel text.
const compiled = new Map(await Promise.all(['AutoTeethPanel', 'ToothPanel', 'AnthropicModelSelect'].map(async name => {
  const url = new URL(`../src/${name}.tsx`, import.meta.url);
  return [url.href, (await transformWithOxc(await readFile(url, 'utf8'), url.pathname)).code];
})));
const loader = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('.css')) return { url: 'data:text/javascript,export{}', shortCircuit: true };
    if (specifier.startsWith('./') && context.parentURL?.includes('/src/') && !/\.[a-z]+$/i.test(specifier)) {
      for (const extension of ['.ts', '.tsx']) {
        const url = new URL(`${specifier}${extension}`, context.parentURL);
        if (existsSync(url)) return next(url.href, context);
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    return compiled.has(url) ? { format: 'module', source: compiled.get(url), shortCircuit: true } : next(url, context);
  },
});
let AutoTeethPanel, ToothPanel;
try {
  ({ AutoTeethPanel } = await import('../src/AutoTeethPanel.tsx'));
  ({ ToothPanel } = await import('../src/ToothPanel.tsx'));
} finally { loader.deregister(); }
const render = (component, props) => renderToStaticMarkup(createElement(component, props));
const panelProps = () => ({
  activePartName: 'Local scan', activePartRole: 'upper', selectedTooth: 11, model: 'claude-haiku-5-5', defaultModel: 'claude-haiku-5-5',
  settings: { direction: 'auto', sensitivity: 1 }, patientRight: null, configured: false,
  proposal: {
    partId: 'scan', scan: { candidates: [candidate(1), candidate(2), candidate(3), candidate(4)], warnings: [], unassignedTriangles: 0 },
    selectedCandidate: 1, mappings: [mapping(1, 17, 'user'), mapping(2, 18), mapping(3, 27, 'model', true)], possibleMissing: [], views: [], model: null,
  },
});

test('candidate buttons prefer mapped FDI and disclose draft / reviewed / unknown identity', () => {
  const props = panelProps();
  const before = structuredClone(props);
  const html = render(AutoTeethPanel, props);
  assert.match(html, /<strong>FDI 17<\/strong><span>Mapping reviewed · clinical record unchanged<\/span>/);
  assert.match(html, /<strong>FDI 18<\/strong><span>Draft identity · not reviewed<\/span>/);
  assert.match(html, /<strong>FDI 27\?<\/strong><span>Draft identity · needs review<\/span>/);
  assert.match(html, /<strong>Region C4<\/strong><span>FDI unknown<\/span>/);
  assert.match(html, /aria-label="Assign FDI for region C1"/);
  assert.doesNotMatch(html, /<strong>C1<\/strong>|No review flag/);
  assert.deepEqual(props, before);
});

test('an invalid mapping or selected chart tooth cannot relabel an unknown candidate', () => {
  const props = panelProps();
  props.selectedTooth = 18;
  props.proposal.mappings = [mapping(1, 37)];
  const html = render(AutoTeethPanel, props);
  assert.match(html, /<strong>Region C1<\/strong><span>FDI unknown<\/span>/);
  assert.match(html.replace(/<[^>]+>/g, ''), /Proposed FDI 37 is outside the active arch/);
  assert.doesNotMatch(html, /<strong>FDI (18|37)<\/strong>/);
});

test('odontogram keeps permanent FDI positions and explains viewport draft indicators', () => {
  const html = render(ToothPanel, { selectedTooth: 17, teeth: {}, counts: {}, hasScans: false, tool: 'inspect', brushRadius: 1, boundaryCount: 0, draftCount: 0 });
  for (const fdi of [17, 18, 27]) assert.match(html, new RegExp(`class="tooth-slot-number">${fdi}<`));
  assert.match(html, /3D indicators use FDI numbers/);
  assert.match(html, /“draft” marks an unreviewed identity; \? marks uncertainty/);
});
