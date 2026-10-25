import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';

// Exercise the actual React panel output using the project's existing TSX compiler.
// CSS has no server-rendered behavior; geometry and workflow modules stay real.
const files = ['PlanningPanel', 'WorkflowReview', 'RestorationPanel', 'AnthropicModelSelect'];
const compiled = new Map(await Promise.all(files.map(async name => {
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
let PlanningPanel, WorkflowReview, WorkflowSettings, RestorationPanel;
try {
  ({ PlanningPanel } = await import('../src/PlanningPanel.tsx'));
  ({ WorkflowReview, WorkflowSettings } = await import('../src/WorkflowReview.tsx'));
  ({ RestorationPanel } = await import('../src/RestorationPanel.tsx'));
} finally { loader.deregister(); }

const noop = () => {};
const render = (component, props) => renderToStaticMarkup(createElement(component, props));
const frame = { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], up: [0, 0, 1] };
const measured = { value: 2, method: 'Synthetic sampled file-unit distance.' };
function site(overrides = {}) {
  return {
    id: 'bounded-upper-gap', partId: 'upper', arch: 'upper', fdi: null,
    draftIdentity: { templateFdi: 26, alternatives: [16], basis: 'Unknown patient side; bounded scan space.' },
    alternatives: [16, 26], status: 'identity-unresolved', confidence: .7, priority: 'medium', kind: 'bounded',
    anchor: { partId: 'upper', face: 0, point: [0, 0, 0] }, frame, frameBasis: 'Bounded ridge frame.',
    space: { mesiodistal: measured, buccolingual: measured, vertical: measured },
    evidence: { supporting: ['Two scanned neighbours.'], conflicting: [] }, questions: ['Patient side unknown.'],
    ...overrides,
  };
}
function planningProps(overrides = {}) {
  return {
    step: 0, parts: [{ id: 'upper', name: 'upper scan', role: 'upper', roleSource: 'filename-hypothesis' }, { id: 'lower', name: 'lower scan', role: 'lower', roleSource: 'filename-hypothesis' }],
    teeth: { teeth: {} }, counts: {}, acceptedActions: [], generating: false, assembliesCount: 0,
    planning: {
      prepared: { sites: [site()] }, evidence: { sources: [{ partId: 'upper', scan: { candidates: [], warnings: [], unassignedTriangles: 0 } }], views: [{ id: 'overview', context: 'arch', label: 'Synthetic overview', mediaType: 'image/jpeg', base64: 'AA==' }] },
      busy: false, configured: false, patientRight: null, model: 'claude-haiku-5-5', modelLabel: 'Haiku',
      setModel: noop, setPatientRight: noop, prepare: noop, analyze: noop, cancel: noop,
    },
    onStep: noop, onSelectTooth: noop, onApplyIdentities: noop, onConfirmMissing: noop, onConfirmAction: noop,
    onGenerate: noop, onExport: noop, onCorrections: noop, onPrepareDraft: noop, onRunWorkflow: noop,
    ...overrides,
  };
}
function assembly(draftIdentity = site().draftIdentity) {
  return {
    id: 'concept', parts: [], warnings: [],
    spec: {
      // Deliberately different so public labels cannot accidentally read spec.fdi.
      fdi: 36, ...(draftIdentity ? { draftIdentity: { siteId: site().id, ...draftIdentity } } : {}),
      anatomy: 'molar', provenance: 'hypothesized', source: 'Local bounded gap',
      parameters: { fixture: { radius: 1, length: 2, depth: 0, taper: .1 }, abutment: { radius: 1, height: 1, emergenceRadius: 1, angleX: 0, angleY: 0 }, crown: { width: 2, depth: 2, height: 2, cuspHeight: .2, rotation: 0 } },
    },
  };
}
const restorationProps = assemblies => ({ assemblies, selectedId: assemblies[0]?.id ?? null, busy: false, error: '', onSelect: noop, onUpdate: noop, onRemove: noop, onTogglePart: noop, onExportPart: noop });

test('Start remains available with filename roles, unknown side and an unreviewed bite', () => {
  const props = planningProps({ biteReviewed: false, manualMode: false });
  const before = structuredClone({ parts: props.parts, teeth: props.teeth });
  const html = render(PlanningPanel, props);
  const start = html.match(/<button[^>]*>Start local workflow<\/button>/)?.[0];
  assert.ok(start);
  assert.doesNotMatch(start, /disabled/);
  assert.doesNotMatch(html, /Confirm suggested scan roles/);
  assert.match(html, /Start once to assess the case, generate supported local concepts and fit/);
  assert.match(html, /<details[^>]*><summary>Advanced scan, side &amp; bite corrections · optional<\/summary>[\s\S]*Role for upper scan[\s\S]*I reviewed the current static bite pose[\s\S]*<\/details>/);
  assert.deepEqual({ parts: props.parts, teeth: props.teeth }, before, 'presentation never confirms records');
});

test('unprepared and malformed geometry keeps errors and a disabled Start action visible', () => {
  const props = planningProps();
  props.planning = { ...props.planning, prepared: null, evidence: null, error: 'Malformed scan: no finite triangles.' };
  const html = render(PlanningPanel, props);
  assert.match(html, /role="alert"[^>]*><p>Malformed scan: no finite triangles\./);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Start local workflow<\/button>/);
  assert.match(html, /Retry local preparation/);
});

test('unresolved bounded spaces describe available automatic drafts and collapse optional FDI corrections', () => {
  const hypothesis = site();
  const before = structuredClone(hypothesis);
  const html = render(WorkflowReview, { sites: [hypothesis], onSelect: noop });
  assert.match(html, />Upper draft site<\/button>/);
  assert.match(html, /Automatic draft available · anatomical identity unresolved/);
  assert.match(html, /<details><summary>Optional identity correction &amp; skip<\/summary>/);
  assert.match(html, /<option value="0" selected="">Unresolved<\/option>/);
  assert.match(html, /Illustrative crown template: FDI 26/);
  assert.match(html, />Skip<\/button>/);
  assert.doesNotMatch(html, />Space FDI 26<\/button>/);
  assert.deepEqual(hypothesis, before);
});

test('identity templates never conceal absent site geometry or scan coverage', () => {
  for (const overrides of [{ anchor: null, frame: null }, { status: 'not-scanned' }, { status: 'segmentation-unresolved' }]) {
    const html = render(WorkflowReview, { sites: [site(overrides)], onSelect: noop });
    assert.doesNotMatch(html, /Automatic draft available|Use this hypothesis/);
    assert.match(html, /identity unresolved|not scanned|segmentation unresolved/);
  }
});

test('readiness and manual tools include unknown-FDI draft sites without promoting template identity', () => {
  const html = render(PlanningPanel, planningProps({ step: 2, sites: [site()], siteReadiness: [{ fdi: 26, status: 'generated', detail: 'Local draft generated.' }] }));
  assert.match(html, />Upper draft site<\/button>/);
  assert.doesNotMatch(html, />FDI 26<\/button>/);
  assert.match(html, /<details[^>]*><summary>Optional manual generation tools<\/summary>/);
  assert.match(html, /1 draft \/ reviewed site/);
  const generation = html.match(/<button[^>]*>Generate draft concepts<\/button>/)?.[0];
  assert.ok(generation);
  assert.doesNotMatch(generation, /disabled/);
});

test('alternative templates and reopened readiness metadata retain draft labels', () => {
  const alternative = render(PlanningPanel, planningProps({ step: 2, sites: [site()], siteReadiness: [{ fdi: 16, status: 'generated', detail: 'Alternative anatomy draft.' }] }));
  assert.match(alternative, />Upper draft site<\/button>/);
  assert.doesNotMatch(alternative, />FDI 16<\/button>/);
  const reopened = render(PlanningPanel, planningProps({ step: 2, sites: [], siteReadiness: [{ fdi: 46, siteId: 'reopened-lower-gap', draftIdentity: { ...site().draftIdentity, templateFdi: 46 }, status: 'generated', detail: 'Reopened draft.' }] }));
  assert.match(reopened, />Lower draft site<\/button>/);
  assert.doesNotMatch(reopened, />FDI 46<\/button>/);
});

test('restoration headings use draft arch labels and disclose template FDI only as illustrative anatomy', () => {
  const upper = render(RestorationPanel, restorationProps([assembly()]));
  assert.match(upper, /<strong>Upper draft site<\/strong>/);
  assert.match(upper, /<strong>Upper draft site · molar<\/strong>/);
  assert.doesNotMatch(upper, /<strong>FDI 36/);
  assert.match(upper, /<details[^>]*><summary>Draft identity &amp; optional correction<\/summary>/);
  assert.match(upper, /FDI 26 selects the illustrative crown template only/);
  const lower = render(RestorationPanel, restorationProps([assembly({ ...site().draftIdentity, templateFdi: 46 })]));
  assert.match(lower, /<strong>Lower draft site<\/strong>/);
  const identified = render(RestorationPanel, restorationProps([assembly(null)]));
  assert.match(identified, /<strong>FDI 36 · molar<\/strong>/);
});

test('manual mode is optional and records are never described as automatically reviewed', () => {
  const html = render(WorkflowSettings, { disabled: false, manualMode: false });
  assert.match(html, /I want to generate sites manually/);
  assert.doesNotMatch(html, /Ask below evidence score/);
  assert.match(html, /routine findings do not pause the automatic draft/);
  assert.match(html, /do not become reviewed clinical records/);
});
