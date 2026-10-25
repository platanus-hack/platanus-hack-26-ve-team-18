import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import { beginWorkflow, endWorkflow, journalWorkflow } from '../src/case-workflow.ts';
import { planningExecutionSchema } from '../src/case-planning-schema.ts';
import { readPlanningEvents } from '../src/planning-events.ts';

// Render the production components, including the actual shared activity view.
const compiled = new Map(await Promise.all(['AIActivity', 'WorkflowReview'].map(async name => {
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
let AIActivity, WorkflowReview, WorkflowJournal;
try {
  ({ AIActivity } = await import('../src/AIActivity.tsx'));
  ({ WorkflowReview, WorkflowJournal } = await import('../src/WorkflowReview.tsx'));
} finally { loader.deregister(); }

const render = (props, component = AIActivity) => renderToStaticMarkup(createElement(component, props));
const callCount = html => (html.match(/class="ai-activity__call"/g) ?? []).length;
const assessment = (tools = []) => ({
  revision: 'current', model: 'actual-model', summary: 'Evidence-linked assessment.', mappings: [], findings: [], actions: [], designs: [], limitations: [],
  execution: {
    requestedModel: 'requested-model', actualModel: 'actual-model', provider: 'anthropic.messages',
    inputTokens: 1200, outputTokens: 340, providerSteps: 2, durationMs: 1540,
    limits: { providerSteps: 3, toolCalls: 16, outputTokensPerStep: 8192 },
    toolResults: tools, draftRequests: [],
  },
});
const started = () => ({ id: 'call-1', name: 'evaluateMissingSite', phase: 'running', input: { siteId: 'bounded-gap' } });

const parsedActivitySources = [
  ['live events', async tools => {
    const events = [
      { type: 'started', revision: 'current', model: 'actual-model' },
      ...tools.flatMap((call, index) => [
        { type: 'tool', activity: { id: `call-${index}`, name: call.name, phase: 'running', input: call.input } },
        { type: 'tool', activity: { ...call, id: `call-${index}`, phase: 'complete' } },
      ]),
      { type: 'result', result: assessment(tools) },
    ];
    const bytes = new TextEncoder().encode(events.map(event => JSON.stringify(event)).join('\n') + '\n');
    let aiActivity = [];
    await readPlanningEvents(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }), event => {
      if (event.type !== 'tool') return;
      aiActivity = [...aiActivity.filter(call => call.id !== event.activity.id), event.activity];
      // Render each parsed update while the request is still active, as the UI does.
      render({ aiActivity, status: 'running' });
    });
    assert.equal(aiActivity.length, tools.length);
    return { aiActivity, status: 'complete' };
  }],
  ['saved assessments', async tools => {
    const saved = JSON.parse(JSON.stringify(assessment(tools)));
    saved.execution = planningExecutionSchema.parse(saved.execution);
    return { assessment: saved };
  }],
];

for (const [source, parsedProps] of parsedActivitySources) {
  test(`${source} render prototype-like tool names as fallback text`, async () => {
    const names = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];
    const html = render(await parsedProps(names.map(name => ({ name, input: {}, output: { status: 'available' } }))));
    assert.equal(callCount(html), names.length);
    for (const label of ['  proto  ', 'constructor', 'to String', 'has Own Property']) {
      assert.ok(html.includes(`<strong>${label}</strong>`), `Expected the fallback label ${JSON.stringify(label)}.`);
    }
    assert.equal((html.match(/class="ai-activity__call-state">Result received/g) ?? []).length, names.length);
  });

  test(`${source} render non-string statuses without coercion or invented errors`, async () => {
    for (const status of [null, false, 42, {}, { toString: null }, { toString: 'error', valueOf: null }, ['error'], ['failed'], ['budget-reached']]) {
      const html = render(await parsedProps([{ name: 'inspectPreparedCase', input: {}, output: { status, evidence: 'Retained tool evidence.' } }]));
      assert.match(html, /Inspect prepared scans/);
      assert.match(html, /class="ai-activity__call-state">Result received/);
      assert.match(html, /Retained tool evidence/);
      assert.doesNotMatch(html, /A tool reported an error|data-phase="error"/);
    }
  });

  test(`${source} preserve recognized string status meanings`, async () => {
    for (const [status, state] of [
      ['error', 'Error'], ['failed', 'Error'], ['budget-reached', 'Error'],
      ['requested', 'Edit requested · awaiting local application'],
      ['applied', 'Local edit reported applied'], ['unavailable', 'Evidence unavailable'],
      ['available', 'Result received'], ['unrecognized', 'Result received'],
    ]) {
      const html = render(await parsedProps([{ name: 'inspectPreparedCase', input: {}, output: { status } }]));
      assert.ok(html.includes(`<p class="ai-activity__call-state">${state}</p>`), `Expected state for ${status}.`);
      assert.equal(html.includes('A tool reported an error'), state === 'Error');
      assert.equal(html.includes('data-phase="error"'), state === 'Error');
    }
  });
}

test('empty state stays empty and an active request does not invent tool calls', () => {
  assert.equal(render({}), '');
  const html = render({ status: 'running', aiActivity: [] });
  assert.match(html, /AI request in progress/);
  assert.match(html, /No tool calls recorded yet/);
  assert.match(html, /0 calls recorded/);
  assert.equal(callCount(html), 0);
  assert.doesNotMatch(html, /Inspect inputs|AI assessment recorded/);
});

test('live call start and completion show observed evidence and measured duration', () => {
  const start = render({ aiActivity: [started()], status: 'running' });
  assert.match(start, /Tool call in progress/);
  assert.match(start, /Inspect site evidence/);
  assert.match(start, /class="ai-activity__call-state">Running/);
  assert.match(start, /bounded-gap/);
  assert.doesNotMatch(start, /<h4>Returned evidence|Result received/);

  const finish = render({ aiActivity: [{ ...started(), phase: 'complete', output: { status: 'available', evidence: ['Two scanned neighbours.'] }, durationMs: 122 }], status: 'running' });
  assert.match(finish, /Result received/);
  assert.match(finish, /122 ms/);
  assert.match(finish, /Two scanned neighbours/);
  assert.match(finish, /AI request in progress/);
  assert.doesNotMatch(finish, /Tool call in progress|AI assessment recorded/);
});

test('saved completed outputs restore tool evidence, attribution, steps and token usage', () => {
  const html = render({ assessment: assessment([{ name: 'getCollisionReport', input: {}, output: { status: 'available', sampledDistance: 0.42, units: 'file units (u)' } }]) });
  assert.match(html, /AI assessment recorded/);
  assert.match(html, /Read surface measurements/);
  assert.match(html, /0.42/);
  assert.match(html, /file units \(u\)/);
  assert.match(html, /anthropic.messages/);
  assert.match(html, /actual-model/);
  assert.match(html, /Requested model/);
  assert.match(html, /requested-model/);
  assert.match(html, /Model steps<\/dt><dd>2/);
  assert.match(html, /1,200 \/ 340/);
  assert.match(html, /1.5 s/);
  assert.equal(callCount(html), 1);
});

test('live completed calls take precedence over saved call copies', () => {
  const html = render({
    aiActivity: [{ ...started(), phase: 'complete', output: { reason: 'Live evidence retained.' }, durationMs: 2500 }],
    assessment: assessment([{ name: 'evaluateMissingSite', input: {}, output: { reason: 'Saved copy should be absent.' } }]),
  });
  assert.equal(callCount(html), 1);
  assert.match(html, /Live evidence retained/);
  assert.match(html, /2.5 s/);
  assert.doesNotMatch(html, /Saved copy should be absent/);
});

test('structured commands retain their origin in saved and live tool activity', () => {
  const call = { name: 'requestDraftComponents', origin: 'structured-command', input: { siteId: 'site-1' }, output: { queued: true } };
  const saved = render({ assessment: assessment([call]) });
  assert.match(saved, /AI decision · local validation/);
  assert.match(saved, /Queued · awaiting local construction/);
  const live = render({ aiActivity: [{ ...call, id: 'command-1', phase: 'complete' }], status: 'complete' });
  assert.match(live, /AI decision · local validation/);
  const empty = render({ assessment: assessment(), status: 'incomplete' });
  assert.match(empty, /did not queue any restoration construction/);
});

test('measurement follow-up failures show the recorded reason without expanding tool details', () => {
  const message = 'The answer reached the output limit. Completed geometry is retained.';
  const html = render({ status: 'error', aiActivity: [{ id: 'review', name: 'reviewMeasuredRestoration', phase: 'error',
    output: { status: 'incomplete', code: 'output-limit', message }, durationMs: 14500 }] });
  assert.match(html, /Review generated component measurements/);
  assert.ok(html.includes(`<p class="ai-activity__notice">${message}</p>`));
  assert.match(html, /14\.5 s/);
});

test('a queued design acknowledges pending construction while the worker journal retains actual construction', () => {
  const result = assessment([{ name: 'requestDraftComponents', input: { siteId: 'bounded-gap' }, output: { queued: true, artifactStatus: 'pending-worker' } }]);
  const run = endWorkflow(journalWorkflow(beginWorkflow('current', 'run'), {
    name: 'construct-ai-design', stage: 'anatomy', status: 'complete', durationMs: 850,
    detail: 'Constructed fixture, abutment and crown from the requested design.', artifactIds: ['local-artifact'],
  }), 'complete');
  const review = render({ assessment: result, workflowRuns: [run], onSelect() {} }, WorkflowReview);
  assert.match(review, /Queued · awaiting local construction/);
  assert.doesNotMatch(review, /Concept generated|Components generated/);
  const journal = render({ workflowRuns: [run] }, WorkflowJournal);
  assert.match(journal, /Workflow record · complete/);
  assert.match(journal, /Constructed fixture, abutment and crown/);
  assert.match(journal.replace(/<[^>]+>/g, ''), /Local tool results · 1/);
});

test('all process review steps retain activity without duplicating the findings-step view', () => {
  const result = assessment([{ name: 'inspectPlacementRules', input: { siteId: 'bounded-gap' }, output: { status: 'available', units: 'file units (u)' } }]);
  const props = { assessment: result, workflowRuns: [endWorkflow(beginWorkflow('current', 'run'), 'complete')], onSelect() {} };
  for (const step of [0, 2, 3]) assert.match(render({ ...props, step }, WorkflowJournal), /AI tool activity[\s\S]*Audit placement rules[\s\S]*Workflow record/);
  const findings = render({ ...props, step: 1 }, WorkflowReview) + render({ ...props, step: 1 }, WorkflowJournal);
  assert.equal((findings.match(/>AI tool activity<\/h3>/g) ?? []).length, 1);
  const reopened = render({ assessment: result, step: 3 }, WorkflowJournal);
  assert.match(reopened, /AI tool activity/);
  assert.doesNotMatch(reopened, /Workflow record/);
});

test('zero-call assessments and failed requests avoid implying unobserved success', () => {
  const saved = assessment(); saved.execution.inputTokens = null; saved.execution.outputTokens = null;
  const zero = render({ assessment: saved });
  assert.match(zero, /No tool calls were recorded for this assessment/);
  assert.match(zero, /Unknown \/ Unknown/);
  assert.doesNotMatch(zero, /Result received/);

  const failed = render({ status: 'error', aiActivity: [] });
  assert.match(failed, /Workflow stopped · AI assessment may be incomplete/);
  assert.match(failed, /No tool calls were recorded before the workflow stopped/);
  assert.doesNotMatch(failed, /AI assessment recorded/);
  const error = render({ aiActivity: [{ ...started(), phase: 'error', output: { error: 'Site evidence could not be read.' }, durationMs: 0 }], status: 'error' });
  assert.match(error, /Site evidence could not be read/);
  assert.match(error, /class="ai-activity__call-state">Error/);
  assert.match(error, /0 ms/);
});

test('cancelled and incomplete runs retain evidence without leaving calls visibly running', () => {
  const cancelled = render({ aiActivity: [started()], status: 'cancelled' });
  assert.match(cancelled, /Workflow paused/);
  assert.match(cancelled, /Interrupted · no result recorded/);
  assert.doesNotMatch(cancelled, /class="ai-activity__call-state">Running|data-phase="running"/);
  const run = endWorkflow(beginWorkflow('current', 'run'), 'partial');
  const partial = render({ aiActivity: [started()], workflowRuns: [run], onSelect() {} }, WorkflowReview);
  assert.match(partial, /Workflow needs attention/);
  assert.match(partial, /Interrupted · no result recorded/);
  const endedWithoutResult = render({ aiActivity: [started()], status: 'complete' });
  assert.match(endedWithoutResult, /Some tool results are missing/);
  assert.match(endedWithoutResult, /Interrupted · no result recorded/);
  assert.doesNotMatch(endedWithoutResult, /Tool call in progress|data-phase="running"/);
  const noResult = render({ aiActivity: [{ ...started(), phase: 'complete' }] });
  assert.match(noResult, /Assessment incomplete/);
  assert.match(noResult, /Completion was reported without returned evidence/);
  assert.doesNotMatch(noResult, /Result received/);
});

test('tool rejection and budget errors remain visible even when the tool returned normally', () => {
  const notQueued = render({ aiActivity: [{ ...started(), name: 'requestDraftComponents', phase: 'complete', output: { queued: false, reason: 'Conflicting duplicate rejected.' } }] });
  assert.match(notQueued, /Not queued/);
  assert.match(notQueued, /Conflicting duplicate rejected/);
  assert.doesNotMatch(notQueued, /Queued · awaiting/);
  const budget = render({ assessment: assessment([{ name: 'getToothChart', input: {}, output: { status: 'budget-reached' } }]) });
  assert.match(budget, /A tool reported an error/);
  assert.match(budget, /class="ai-activity__call-state">Error/);
});

test('region settings, site choice and rule audits have concise labels and honest decision states', () => {
  const names = ['inspectToothRegion', 'reviewToothRegions', 'reviewRestorationSite', 'inspectPlacementRules'];
  const html = render({ aiActivity: names.map((name, index) => ({ id: `call-${index}`, name, phase: 'complete', output: index === 1 ? { recorded: true, appliedToReviewedChart: false } : index === 2 ? { recorded: false } : { status: 'available' } })) });
  for (const label of ['Inspect tooth region settings', 'Review region settings', 'Review restoration site choice', 'Audit placement rules', 'Draft decision recorded', 'Decision not recorded']) assert.match(html, new RegExp(label));
  assert.doesNotMatch(html, /Local edit reported applied/);
});

test('request acknowledgments never imply an applied edit, and rejected edits expose returned reasons', () => {
  const call = { id: 'edit', name: 'requestRestorationEdit', phase: 'complete', input: { assemblyId: 'restoration-1' } };
  const request = render({ aiActivity: [{ ...call, output: { status: 'requested', applied: false } }] });
  assert.match(request, /Request local design revision/);
  assert.match(request, /Edit requested · awaiting local application/);
  assert.doesNotMatch(request, /Local edit reported applied/);
  const applied = render({ aiActivity: [{ ...call, output: { status: 'applied', before: { editRevision: 'v1' }, after: { editRevision: 'v2' } } }] });
  assert.match(applied, /Local edit reported applied/);
  assert.doesNotMatch(applied, /Edit requested · awaiting/);
  const rejected = render({ aiActivity: [{ ...call, phase: 'error', output: { status: 'error', code: 'rejected', message: 'Measured guardrails rejected this candidate. The current model was retained.' } }] });
  assert.match(rejected, /class="ai-activity__call-state">Error/);
  assert.match(rejected, /Measured guardrails rejected this candidate/);
  assert.doesNotMatch(rejected, /Local edit reported applied/);
});

test('untrusted tool names, model strings and payload text render as escaped text', () => {
  const malicious = '<script>alert("tool")</script>';
  const result = assessment(); result.execution.actualModel = malicious;
  const html = render({ assessment: result, aiActivity: [{ id: 'unsafe', name: malicious, phase: 'complete', input: { note: '<img src=x onerror=alert(1)>' }, output: { evidence: malicious } }] });
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<script|<img|onerror="/);
  const evidenceOnly = render({ aiActivity: [{ ...started(), phase: 'complete', output: { evidence: 'Observed surface spans.', thinking: 'PRIVATE_REASONING', chainOfThought: 'PRIVATE_CHAIN' } }] });
  assert.match(evidenceOnly, /Observed surface spans/);
  assert.doesNotMatch(evidenceOnly, /PRIVATE_REASONING|PRIVATE_CHAIN/);
});

test('record and UTF-8 detail limits bound large and cyclic inspection payloads', () => {
  const cyclic = { text: '🦷'.repeat(6000), fields: Array.from({ length: 100 }, (_, index) => ({ index, text: 'evidence '.repeat(1000) })) };
  cyclic.self = cyclic;
  const aiActivity = Array.from({ length: 30 }, (_, index) => ({ id: `call-${index}`, name: 'evaluateMissingSite', phase: 'complete', input: cyclic, output: cyclic }));
  const html = render({ aiActivity });
  assert.equal(callCount(html), 16);
  assert.match(html, /Showing the latest 16 of 30 recorded calls/);
  assert.match(html, /Show earlier calls/);
  const details = [...html.matchAll(/<pre>([\s\S]*?)<\/pre>/g)];
  assert.equal(details.length, 32);
  const decode = text => text.replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  for (const [, text] of details) assert.ok(Buffer.byteLength(decode(text)) <= 3000, 'Each rendered UTF-8 text preview is bounded.');
  assert.ok(Buffer.byteLength(html) < 130_000);
  assert.match(html, /truncated/);
  const smallCycle = render({ aiActivity: [{ ...started(), phase: 'complete', output: (() => { const value = {}; value.self = value; return value; })() }] });
  assert.match(smallCycle, /Repeated reference/);
});
