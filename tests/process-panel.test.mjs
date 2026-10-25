import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import { describeProcess } from '../src/guided-process.ts';
import { beginWorkflow, endWorkflow } from '../src/case-workflow.ts';

// Render the actual panel with the project's existing TSX transformer; no DOM
// dependency or production component copy is needed for these guidance checks.
const require = createRequire(import.meta.url);
const modules = new Map([['./anthropic-models', new URL('../src/anthropic-models.ts', import.meta.url).href]]);
for (const name of ['AnthropicModelSelect', 'ProcessPanel']) {
  const url = new URL(`../src/${name}.tsx`, import.meta.url);
  const source = (await readFile(url, 'utf8')).replace(/^import '\.\/[^']+\.css';\s*$/gm, '');
  const transformed = await transformWithOxc(source, url.pathname, { jsx: { runtime: 'automatic' } });
  const code = transformed.code.replace(/from (['"])([^'"]+)\1/g, (_, _quote, specifier) =>
    `from ${JSON.stringify(modules.get(specifier) ?? pathToFileURL(require.resolve(specifier)).href)}`);
  modules.set(`./${name}`, `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}
const { ProcessPanel } = await import(modules.get('./ProcessPanel'));

const base = () => ({
  scanCount: 2, hasArch: true, preparing: false, preparationStage: '', evidenceReady: true,
  configured: false, queued: false, workflowPaused: false, assessing: false, generating: false, generationPhase: null,
  generationDetail: '', measuring: false, measurementPaused: false, needsMeasurements: true,
  measurementsReady: true, measuredPairs: 0, generatedCount: 0, staleCount: 0,
  hasAssessment: false, assessmentSource: null, issues: [], error: '',
});
const completeRun = () => endWorkflow(beginWorkflow('current', 'run'), 'complete');
const noop = () => {};
function render(input, props = {}) {
  return renderToStaticMarkup(createElement(ProcessPanel, {
    state: describeProcess(input), aiConfigured: input.configured, model: 'claude-haiku-5-5', modelLabel: 'Haiku 5.5', modelLocked: input.configured !== true, onModel: noop, scanCount: input.scanCount,
    cbctLoaded: false, cbctShared: false, onCbctShared: noop, onStart: noop, onPause: noop, onResume: noop,
    onLocal: noop, onImport: noop, onReview: noop, onEvidence: noop, onSave: noop, onExport: noop,
    onSettings: noop, sessionBusy: false, ...props,
  }));
}
function primaryButton(markup) {
  return markup.match(/<button\b[^>]*class="process-panel__primary"[^>]*>[\s\S]*?<\/button>/)?.[0] ?? '';
}

test('routine scan hypotheses leave Start enabled and corrections optional', () => {
  const markup = render({ ...base(), issues: ['Filename roles and patient side are hypotheses.'] });
  assert.match(primaryButton(markup), /Start local workflow/);
  assert.doesNotMatch(primaryButton(markup), /\bdisabled=/);
  assert.match(markup, /You can start the draft now/);
  assert.match(markup, /Role, side and bite corrections are optional in Advanced tools/);
  assert.doesNotMatch(markup, /Before continuing/);
});

test('completed draft findings remain visible without a continue or approval action', () => {
  const markup = render({ ...base(), hasAssessment: true, assessmentSource: 'local', generatedCount: 1,
    run: completeRun(), issues: ['Unresolved patient-side FDI.', 'Crossing surface pairs.', 'Unreviewed CBCT registration.', 'Unverified bite pose.'] });
  assert.match(markup, /data-status="review"/);
  assert.match(markup, /Draft findings/);
  assert.match(markup, /Unresolved patient-side FDI/);
  assert.match(markup, /Crossing surface pairs/);
  assert.match(markup, /1 more item in the draft details/);
  assert.match(primaryButton(markup), /Inspect draft details/);
  assert.match(markup, /do not pause draft generation or require approval/);
  assert.doesNotMatch(markup, /Before continuing|Resume local workflow|Retry local workflow|Continue locally/);
});

test('an active run between phases exposes pause without another Start', () => {
  const markup = render({ ...base(), hasAssessment: true, run: beginWorkflow('current', 'run') });
  assert.match(markup, /data-status="running"/);
  assert.match(markup, /Pause workflow/);
  assert.equal(primaryButton(markup), '');
  assert.doesNotMatch(markup, /Start local workflow|Inspect draft details/);
});

test('unavailable surface measurements do not claim a successful zero-pair report', () => {
  const draft = { ...base(), hasAssessment: true, generatedCount: 1, run: completeRun() };
  const measured = render(draft);
  assert.match(measured, /No nearby or intersecting surface pairs reported/);
  const paused = render({ ...draft, measurementsReady: false, measurementPaused: true });
  assert.match(paused, /Current surface measurements are unavailable/);
  assert.match(paused, /<dd>—<\/dd>/);
  assert.doesNotMatch(paused, /No nearby or intersecting surface pairs reported/);
});

test('a rejected first import displays its error and retains the add-files action', () => {
  const markup = render({ ...base(), scanCount: 0, hasArch: false, evidenceReady: false,
    error: 'Malformed scan: no usable triangles.' });
  assert.match(markup, /data-status="error"/);
  assert.match(markup, /Malformed scan: no usable triangles/);
  assert.match(primaryButton(markup), /Add patient files/);
});
