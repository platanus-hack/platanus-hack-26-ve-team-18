import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';

// Compile and render the actual panel and model selector using the project's
// transformer. Only CSS is omitted; no provider, DOM or new dependency is used.
const compiled = new Map(await Promise.all(['AutoTeethPanel', 'AnthropicModelSelect'].map(async name => {
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
let AutoTeethPanel;
try { ({ AutoTeethPanel } = await import('../src/AutoTeethPanel.tsx')); }
finally { loader.deregister(); }

const noop = () => {};
const base = () => ({
  activePartName: 'Upper scan', activePartRole: 'upper', selectedTooth: 11,
  autoRun: false, settings: { direction: 'auto', sensitivity: 1 }, proposal: null,
  busy: false, stage: '', configured: true, model: 'claude-haiku-5-5', defaultModel: 'claude-haiku-5-5',
  patientRight: null, error: '', notice: '', canApplyMapped: false,
  onAutoRun: noop, onSettings: noop, onScan: noop, onCancel: noop, onSelectCandidate: noop,
  onMapCandidate: noop, onRejectCandidate: noop, onUseSelected: noop, onApplyMapped: noop,
  onPrepareViews: noop, onPatientRight: noop, onIdentify: noop, onModel: noop, onPickTool: noop, onReviewGap: noop,
});
const review = (patch = {}) => ({
  sourceId: 'scan-2', candidateId: 41, classification: 'tooth', decision: 'use', fdi: 17,
  rationale: 'Whole-crown geometry supports a provisional tooth region.',
  evidence: ['Occlusal relief on the prepared case region.', 'Patient-side identity remains a hypothesis.'], ...patch,
});
const candidate = id => ({ id, faces: new Uint32Array([0]), seed: { face: 0, point: [0, 0, 0] }, centroid: [0, 0, 0], area: 1, height: 1, warnings: [] });
const proposal = (id = 1) => ({
  partId: 'independent-local-scan', scan: { candidates: [candidate(id)], warnings: [], unassignedTriangles: 0 },
  selectedCandidate: id, mappings: [{ candidateId: id, fdi: 18, source: 'user', needsReview: false, reason: 'Existing local mapping.' }],
  possibleMissing: [], model: null, views: [],
});
function render(patch = {}) {
  const props = { ...base(), ...patch };
  let tree;
  // Capture the real elements while React owns the hook context, then exercise
  // their event handlers to verify parent callbacks without a browser harness.
  function Capture() { tree = AutoTeethPanel(props); return tree; }
  return { html: renderToStaticMarkup(createElement(Capture)), tree, props };
}
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object'
  ? [tree, ...nodes(tree.props?.children)] : [];
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : tree && typeof tree === 'object'
  ? text(tree.props?.children) : typeof tree === 'string' || typeof tree === 'number' ? String(tree) : '';
const button = (tree, label) => {
  const found = nodes(tree).find(node => node.type === 'button' && (text(node) === label || node.props['aria-label'] === label));
  assert.ok(found, `Missing button: ${label}`);
  return found;
};
const caseSection = html => html.match(/<section class="auto-teeth-case-settings"[\s\S]*?<\/section>/)?.[0] ?? '';

test('default panel keeps standalone identification and omits unsupplied case settings', () => {
  const { html } = render();
  assert.doesNotMatch(html, /AI case region settings|Review tooth regions with AI|Inspect case region/);
  assert.match(html, /FDI identification/);
  assert.match(html, /Identify FDI with Haiku 5\.5/);
  assert.doesNotMatch(render({ caseRegionSettings: [] }).html, /AI case region settings/);
});

test('supplied canonical settings render as reversible provisional decisions without clinical review', () => {
  const settings = [review()];
  const before = structuredClone(settings);
  const { html } = render({ caseRegionSettings: settings, onInspectCaseRegion: noop });
  const section = caseSection(html);
  assert.match(section, /AI case region settings/);
  assert.match(section, /Case region C41/);
  assert.match(section, /Class: tooth · Decision: use/);
  assert.match(section, /Provisional FDI: FDI 17 · draft identity/);
  assert.match(section, /Rationale: Whole-crown geometry/);
  assert.match(section, /Occlusal relief on the prepared case region/);
  assert.match(section, /Reversible draft settings from AI case review, not reviewed clinical records/);
  assert.match(section, /Saved labels and exclusions stay protected/);
  assert.match(section, /these settings do not apply saved labels/);
  assert.doesNotMatch(section, /Mapping reviewed|Approved|clinically validated|Apply mapped teeth|Assign FDI/);
  assert.deepEqual(settings, before);
});

test('null identity stays explicitly unknown and mixed regions retain boundary-correction guidance', () => {
  const { html } = render({ caseRegionSettings: [review({ classification: 'mixed', decision: 'needs-boundary-review', fdi: null })] });
  const section = caseSection(html);
  assert.match(section, /Class: mixed · Decision: needs-boundary-review/);
  assert.match(section, /Provisional FDI: Unknown \(null\)/);
  assert.match(section, /Ambiguous or mixed regions need local boundary correction/);
  assert.doesNotMatch(section, /Provisional FDI: FDI|FDI 11/);
  assert.match(section, /<button[^>]*disabled=""[^>]*>Inspect case region<\/button>/);
});

test('empty case action launches only the parent workflow without requiring a local proposal', () => {
  const calls = [];
  const { html, tree } = render({ activePartName: null, activePartRole: null, caseRegionSettings: [],
    onReviewCaseRegions: () => calls.push('case-review'), onScan: () => calls.push('scan'), onIdentify: () => calls.push('identify') });
  assert.match(caseSection(html), /No AI case region settings for the active source yet/);
  assert.equal(button(tree, 'Review tooth regions with AI').props.disabled, false);
  assert.equal(button(tree, 'Identify FDI with Haiku 5.5').props.disabled, true);
  assert.deepEqual(calls, [], 'rendering does not launch any AI request');
  button(tree, 'Review tooth regions with AI').props.onClick();
  assert.deepEqual(calls, ['case-review']);
  assert.match(html, /Images are sent only when you choose Identify FDI with Haiku 5\.5 or Review tooth regions with AI/);
});

test('busy or unconfirmed configuration disables case AI review; inspection remains local', () => {
  for (const patch of [{ busy: true }, { configured: false }, { configured: null }]) {
    const { html, tree } = render({ caseRegionSettings: [review()], onReviewCaseRegions: noop, onInspectCaseRegion: noop, ...patch });
    assert.equal(button(tree, 'Review tooth regions with AI').props.disabled, true);
    assert.match(html, /<button[^>]*disabled=""[^>]*>Review tooth regions with AI<\/button>/);
    assert.equal(button(tree, 'Inspect case region C41').props.disabled, patch.busy === true);
  }
});

test('case IDs never relabel or select independently detected candidates, including matching numeric IDs', () => {
  for (const localId of [1, 41]) {
    const local = proposal(localId), settings = [review({ fdi: 27 })];
    const before = structuredClone({ local, settings }), calls = [];
    const { html, tree } = render({ proposal: local, caseRegionSettings: settings,
      onInspectCaseRegion: id => calls.push(['case-inspect', id]),
      onSelectCandidate: id => calls.push(['local-select', id]),
      onMapCandidate: () => calls.push(['local-map']), onApplyMapped: () => calls.push(['apply']) });
    assert.match(caseSection(html), /Case region C41[\s\S]*Provisional FDI: FDI 27/);
    assert.match(html, /prepared case regions; separately detected regions below may have different IDs/);
    const detected = html.match(/<details class="auto-teeth-proposals"[\s\S]*?<\/details>/)?.[0] ?? '';
    assert.match(detected, /<strong>FDI 18<\/strong><span>Mapping reviewed · clinical record unchanged<\/span>/);
    assert.doesNotMatch(detected, /Case region|<strong>FDI 27|value="27" selected|Whole-crown geometry/);
    assert.match(detected, /<option value="18" selected="">FDI 18<\/option>/);
    assert.deepEqual(calls, []);
    button(tree, 'Inspect case region C41').props.onClick();
    assert.deepEqual(calls, [['case-inspect', 41]]);
    assert.deepEqual({ local, settings }, before);
  }
});

test('case settings follow supplied parent rows across source changes without retaining old rows', () => {
  assert.match(caseSection(render({ caseRegionSettings: [review()] }).html), /Case region C41/);
  const next = caseSection(render({ activePartName: 'Another active source', caseRegionSettings: [review({ sourceId: 'scan-3', candidateId: 72 })] }).html);
  assert.match(next, /Case region C72/);
  assert.doesNotMatch(next, /Case region C41/);
  const cleared = caseSection(render({ caseRegionSettings: [], onReviewCaseRegions: noop }).html);
  assert.match(cleared, /No AI case region settings for the active source yet/);
  assert.doesNotMatch(cleared, /Case region C/);
});

test('AI rationale and evidence render as escaped text', () => {
  const { html } = render({ caseRegionSettings: [review({
    rationale: '<img src=x onerror="run()"> & <script>unsafe()</script>',
    evidence: ['<b>Untrusted evidence</b> & "quoted"'],
  })] });
  const section = caseSection(html);
  assert.match(section, /&lt;img src=x onerror=&quot;run\(\)&quot;&gt;/);
  assert.match(section, /&lt;script&gt;unsafe\(\)&lt;\/script&gt;/);
  assert.match(section, /&lt;b&gt;Untrusted evidence&lt;\/b&gt; &amp; &quot;quoted&quot;/);
  assert.doesNotMatch(section, /<img|<script|<b>/);
});

test('case display bounds rows, rationale, evidence count and evidence string lengths', () => {
  const settings = Array.from({ length: 70 }, (_, index) => review({ candidateId: index, rationale: 'r'.repeat(700),
    evidence: [...Array.from({ length: 12 }, () => 'e'.repeat(200)), 'hidden thirteenth evidence'] }));
  const section = caseSection(render({ caseRegionSettings: settings }).html);
  assert.equal((section.match(/>Inspect case region<\/button>/g) ?? []).length, 64);
  assert.match(section, /Case region C63/);
  assert.doesNotMatch(section, /Case region C64|Case region C69|hidden thirteenth evidence/);
  assert.match(section, /Showing the first 64 case region settings/);
  assert.ok(section.includes(`${'r'.repeat(599)}…`));
  assert.ok(!section.includes('r'.repeat(600)));
  assert.equal((section.match(new RegExp(`${'e'.repeat(159)}…`, 'g')) ?? []).length, 64 * 12);
  assert.ok(!section.includes('e'.repeat(160)));
});

test('case review remains independent of the existing prepared-view Identify FDI flow', () => {
  const local = proposal(), calls = [];
  local.views = Array.from({ length: 4 }, (_, index) => ({ label: `Local view ${index}`, mediaType: 'image/jpeg', base64: 'AA==' }));
  const { tree } = render({ proposal: local, patientRight: 'image-left', caseRegionSettings: [review()],
    onIdentify: () => calls.push('standalone-identify'), onReviewCaseRegions: () => calls.push('case-review') });
  const identify = button(tree, 'Identify FDI with Haiku 5.5');
  assert.equal(identify.props.disabled, false);
  identify.props.onClick();
  assert.deepEqual(calls, ['standalone-identify']);
});
