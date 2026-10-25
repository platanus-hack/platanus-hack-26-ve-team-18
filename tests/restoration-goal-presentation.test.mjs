import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import { generateRestoration } from '../src/restoration-geometry.ts';
import { evaluateRestorationQuality } from '../src/restoration-quality.ts';
import { restorationFeedbackTargetId } from '../src/restoration-feedback.ts';
import { applyRestorationEdit } from '../src/restoration-edit.ts';
import { applyAssistantRestorationEdit, buildRestorationAssistantSnapshot, createRestorationAssistantTools,
  projectRestorationGoal, restorationAssistantGoalSchema, restorationAssistantLimits, restorationAssistantSnapshotSchema } from '../src/restoration-assistant.ts';

// Render the actual components with the existing compiler and React renderer.
const compiled = new Map(await Promise.all(['RestorationMeasurements', 'RestorationPanel'].map(async name => {
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
let RestorationMeasurements, RestorationGoalRequirements, RestorationPanel;
try {
  ({ RestorationMeasurements, RestorationGoalRequirements } = await import('../src/RestorationMeasurements.tsx'));
  ({ RestorationPanel } = await import('../src/RestorationPanel.tsx'));
} finally { loader.deregister(); }
const render = (component, props) => renderToStaticMarkup(createElement(component, props));
const children = node => Array.isArray(node) ? node : node?.props ? [node.props.children] : [];
const nodes = tree => [tree, ...children(tree).flatMap(nodes)].filter(node => node && typeof node === 'object' && !Array.isArray(node));
const text = tree => typeof tree === 'string' || typeof tree === 'number' ? String(tree) : children(tree).map(text).join('');
const targetId = `${restorationFeedbackTargetId('PRIVATE_CONTACT_SURFACE')}.adjacent.mesial`;
function row(overrides = {}) {
  return { id: `${targetId}.proximal-gap`, label: 'Mesial sampled contact gap', priority: 'required', actual: 1.4, lower: null,
    upper: .3, error: 1.1, units: 'file units (u)', status: 'fail', reason: 'Sampled contact is open.', ...overrides };
}
function goal() {
  const rows = [row(), row({ id: `${targetId}.crossings`, label: 'Target crossings', actual: 0, upper: 0, error: 0, units: 'count', status: 'pass', reason: 'Complete supplied-target check.' }),
    row({ id: 'relative-width', label: 'Neighbour width preference', priority: 'preference', actual: 3, lower: 4, upper: 5, error: -1 }),
    row({ id: 'guardrail.subcrestal-placement', label: 'Bone-crest platform depth', priority: 'clinical', actual: null, lower: 1.5, upper: null, error: null, units: 'mm', status: 'unknown', reason: 'Reviewed bone crest is missing.' }),
    row({ id: 'pilar-emergence', label: 'Pilar emergence', priority: 'clinical', actual: null, upper: null, error: null, status: 'unknown', reason: 'Emergence needs review.' })];
  const after = { status: 'unmet', rows, requiredError: .25, preferenceError: .2 };
  const before = { ...structuredClone(after), requiredError: .5, rows: [...rows].reverse().map(item => item.id === rows[0].id ? { ...item, actual: 2.8, error: 2.5 } : item) };
  const rejected = { ...structuredClone(after), requiredError: 8, rows: rows.map(item => ({ ...item, actual: 99.99 })) };
  return { version: 'restoration-goal/v1', evidenceRevision: 'goal-abcdefabcdefabcd', targetGaps: { PRIVATE_CONTACT_SURFACE: .1 }, contract: structuredClone(before),
    status: after.status, termination: 'candidate-budget', before, after, selectedAttempt: 1,
    attempts: [{ attempt: 0, accepted: true, reason: 'Initial measurements.', snapshot: before },
      { attempt: 1, accepted: true, reason: 'Reduced required error.', snapshot: after },
      { attempt: 2, accepted: false, reason: 'Required crossing worsened.', snapshot: rejected }],
    durationMs: 1234, maxAttempts: 3, bounds: { 'crown.width': [3.4, 5.4], 'abutment.angleY': [-8, 8], cervicalScale: [.65, 1.1] },
    limits: ['Sampled distances are not contact area.'] };
}
function make(spec) {
  spec ??= { version: 'implant-assembly/v1', fdi: 36, parentPartId: 'PRIVATE_SOURCE_ID', source: 'PRIVATE_SCAN.ply',
    frame: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], up: [0, 0, 1] }, anatomy: 'molar', provenance: 'hypothesized', units: 'file units (u)',
    parameters: { fixture: { radius: 1, length: 4, depth: .5, taper: .2 }, abutment: { radius: .8, height: 2, emergenceRadius: 1, angleX: 0, angleY: 0 }, crown: { width: 4, depth: 5, height: 3, cuspHeight: .4, rotation: 90 } } };
  const components = generateRestoration(spec), quality = evaluateRestorationQuality({ spec, components });
  const measurement = { score: 0, objectiveScore: 0, morphologyPenalty: 0, surfaces: [] };
  return { id: 'PRIVATE_ASSEMBLY', createdAt: 'initial', spec, warnings: [],
    fit: { before: measurement, after: measurement, candidates: 1, durationMs: 1, termination: 'candidate-budget', limits: [], quality: { initial: quality, final: quality, rounds: 0, stopReason: 'stable' } },
    parts: components.map(mesh => ({ ...mesh, id: `PRIVATE_${mesh.component}`, name: 'PRIVATE_NAME', fileName: 'PRIVATE_SCAN.ply', visible: true, role: 'model', offset: [0, 0, 0],
      restoration: { assemblyId: 'PRIVATE_ASSEMBLY', component: mesh.component, parentPartId: spec.parentPartId } })) };
}

test('AI projections retain the pilar enclosure requirement and bounded support controls by fixed IDs', () => {
  const report = goal();
  const support = row({ id: 'component-support.pilar-enclosure', label: 'PRIVATE_SUPPORT_LABEL',
    actual: 3, upper: 0, error: 3, units: 'count' });
  report.after.rows.push(support); report.before.rows.push(structuredClone(support));
  Object.assign(report.bounds, { 'abutment.radius': [.52, .88], 'abutment.emergenceRadius': [.65, 1.1], 'abutment.angleX': [-8, 8] });
  const projected = projectRestorationGoal(report);
  const enclosure = projected.after.rows.find(item => item.id === support.id);
  assert.equal(enclosure.label, 'Pilar support vertices outside crown');
  assert.equal(enclosure.actual, 3); assert.equal(enclosure.upper, 0); assert.equal(enclosure.priority, 'required');
  assert.deepEqual(projected.bounds['abutment.radius'], [.52, .88]);
  assert.deepEqual(projected.bounds['abutment.emergenceRadius'], [.65, 1.1]);
  assert.deepEqual(projected.bounds['abutment.angleX'], [-8, 8]);
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_SUPPORT_LABEL/);
  assert.equal(buildRestorationAssistantSnapshot([make()]).assemblies[0].componentDesign, 'legacy');
  const nested = make({ ...make().spec, componentDesign: 'nested-support/v1' });
  assert.equal(buildRestorationAssistantSnapshot([nested]).assemblies[0].componentDesign, 'nested-support/v1');
});

test('requirements show selected measurements by ID, fixed bounds and separate required/preferences/clinical evidence', () => {
  const item = make(); item.fit.goal = goal();
  item.previousVersions = [{ spec: structuredClone(item.spec), fit: structuredClone(item.fit) }];
  item.previousVersions[0].fit.goal.after.rows[0].actual = 77.77;
  const html = render(RestorationMeasurements, { assembly: item });
  assert.match(html, /Mouth-fit requirements · Unmet/);
  assert.match(html, /Required contacts &amp; no-crossings/);
  assert.match(html, /Shape preferences/); assert.match(html, /Clinical evidence/);
  assert.match(html, /2\.8 file units \(u\) → 1\.4 file units \(u\)/);
  assert.doesNotMatch(html, /99\.99|77\.77/);
  assert.match(html, /≤ 0\.3/); assert.match(html, /3\.4 – 5\.4/); assert.match(html, /-8 – 8/); assert.match(html, /0\.65 – 1\.1/);
  assert.match(html, /degrees/); assert.match(html, /ratio/); assert.match(html, /≥ 1\.5[\s\S]*?mm/);
  assert.match(html, /Current signed error/); assert.match(html, /<td>-1/); assert.match(html, /0 count → 0 count/);
  assert.match(html, /Remaining failures &amp; unknowns · 4/);
  assert.match(html, /Clinical evidence · Pilar emergence/);
  assert.match(html, /Attempt budget reached · 3 \/ 3 measured attempts · 1\.23 s/);
  assert.match(html, /Selected attempt 1/); assert.match(html, /Selected result/); assert.match(html, /Rejected/);
  assert.match(html, /Numeric guardrails · actual \/ target \/ error/);
});

test('zero aggregate error, retained geometry and measurement-only termination never hide unknown clinical evidence', () => {
  const report = goal();
  report.after = { status: 'unknown', requiredError: 0, preferenceError: 0, rows: report.after.rows.filter(item => item.priority === 'clinical') };
  report.before = structuredClone(report.after); report.status = 'unknown'; report.selectedAttempt = 0; report.maxAttempts = 1;
  report.attempts = [{ attempt: 0, accepted: true, reason: 'Values measured exactly as entered.', snapshot: report.before }];
  report.termination = 'measurement-only';
  const html = render(RestorationGoalRequirements, { goal: report });
  assert.match(html, /Mouth-fit requirements · Unknown · evidence incomplete/);
  assert.match(html, /Initial measured design retained/); assert.match(html, /Measurement only · entered values retained/);
  assert.match(html, /Required error 0 → 0/); assert.match(html, /Remaining failures &amp; unknowns · 2/);
  assert.match(html, /Unmeasured file units \(u\)/); assert.match(html, /Unmeasured mm/);
  assert.doesNotMatch(html, /Mouth-fit requirements · Satisfied/);
});

test('goal-only, missing and stale reports have usable distinct states', () => {
  const item = make(); delete item.fit.quality;
  item.fit.goal = goal();
  assert.match(render(RestorationMeasurements, { assembly: item }), /Mouth-fit requirements · Unmet/);
  item.warnings.push('STALE: source changed');
  const stale = render(RestorationMeasurements, { assembly: item });
  assert.match(stale, /Mouth-fit requirements · Stale · remeasurement needed/);
  assert.match(stale, /last measured report, not the current fit/);
  delete item.fit.goal;
  assert.match(render(RestorationMeasurements, { assembly: item }), /Mouth-fit requirements · Not evaluated/);
  assert.match(render(RestorationMeasurements, { assembly: item }), /Use Fit to mouth requirements/);
});

test('lost rows remain unresolved and an equality failure is not inferred to pass from zero error', () => {
  const report = goal();
  report.after.rows = report.after.rows.filter(item => !item.id.endsWith('.crossings'));
  report.after.rows[0].actual = .3; report.after.rows[0].error = 0;
  report.after.rows[0].exclusiveUpper = true;
  const html = render(RestorationGoalRequirements, { goal: report });
  assert.match(html, /Remaining failures &amp; unknowns · 5/);
  assert.match(html, /Target crossings[\s\S]*?Evidence lost/);
  assert.match(html, /Mesial sampled contact gap<small>Unmet/);
  assert.match(html, /&lt; 0\.3/);
  assert.doesNotMatch(html, /≤ 0\.3/);
});

test('each stop reason is displayed without converting budget exhaustion or stalled search to success', () => {
  const reasons = { satisfied: 'Measured requirements satisfied', 'needs-evidence': 'Needs evidence', 'candidate-budget': 'Attempt budget reached',
    'time-budget': 'Time budget reached', stalled: 'No acceptable improvement found', 'measurement-only': 'Measurement only' };
  for (const [termination, label] of Object.entries(reasons)) {
    const report = goal(); report.termination = termination;
    if (termination === 'satisfied') {
      report.status = 'satisfied'; report.after.status = 'satisfied'; report.after.requiredError = 0;
      report.after.rows = report.after.rows.filter(item => item.status === 'pass');
      report.before.rows = [...report.after.rows];
    }
    const html = render(RestorationGoalRequirements, { goal: report });
    assert.ok(html.includes(label));
    if (termination !== 'satisfied') assert.match(html, /Mouth-fit requirements · Unmet/);
  }
});

test('renamed fitting button invokes the existing comparison callback for a loaded case without a goal', () => {
  const item = make(), calls = []; let tree;
  const props = { assemblies: [item], selectedId: item.id, busy: false, onCompare: (...args) => calls.push(args),
    onSelect() {}, onRemove() {}, onUpdate() {}, onTogglePart() {}, onExportPart() {} };
  function Capture() { tree = RestorationPanel(props); return tree; }
  const html = render(Capture, {});
  const button = nodes(tree).find(node => node.type === 'button' && text(node) === 'Fit to mouth requirements');
  assert.ok(button); assert.equal(button.props.disabled, false); button.props.onClick();
  assert.deepEqual(calls, [[item.id]]); assert.doesNotMatch(html, /Retry fitting as a comparison/);
  props.busy = true; render(Capture, {});
  assert.equal(nodes(tree).find(node => node.type === 'button' && text(node) === 'Fit to mouth requirements').props.disabled, true);
});

test('assistant goal projection preserves numeric rows and selected attempts without mutating existing feedback APIs', () => {
  const item = make(), before = buildRestorationAssistantSnapshot([item]); item.fit.goal = goal();
  item.fit.goal.after.rows[0].exclusiveUpper = true;
  const snapshot = buildRestorationAssistantSnapshot([item]), projected = snapshot.assemblies[0].goal;
  assert.equal(before.assemblies[0].goal, null); assert.equal(projected.status, 'unmet'); assert.equal(projected.selectedAttempt, 1);
  const original = item.fit.goal.after.rows[0], actual = projected.after.rows.find(row => row.id === original.id);
  for (const field of ['priority', 'actual', 'lower', 'upper', 'exclusiveUpper', 'error', 'units', 'status']) assert.equal(actual[field], original[field]);
  assert.deepEqual(projected.bounds, item.fit.goal.bounds);
  assert.deepEqual(projected.attempts.map(({ attempt, accepted }) => ({ attempt, accepted })), [{ attempt: 0, accepted: true }, { attempt: 1, accepted: true }, { attempt: 2, accepted: false }]);
  assert.deepEqual(snapshot.assemblies[0].quality, before.assemblies[0].quality);
  assert.deepEqual(snapshot.assemblies[0].relationships, before.assemblies[0].relationships);
  assert.deepEqual(snapshot.assemblies[0].meshes, before.assemblies[0].meshes);
  const legacy = structuredClone(snapshot); delete legacy.assemblies[0].goal;
  assert.equal(restorationAssistantSnapshotSchema.parse(legacy).assemblies[0].goal, null);
});

test('explicit nested allowlist drops private source text, arbitrary keys, local revisions and geometry', () => {
  const item = make(), report = goal(); item.fit.goal = report;
  report.evidenceRevision = 'PRIVATE_EVIDENCE_REVISION'; report.targetGaps = { PRIVATE_TARGET_ID: .1 };
  report.limits = ['PRIVATE_PATIENT_METADATA']; report.bounds.PRIVATE_BOUND = [12, 14];
  report.positions = [123456, 234567, 345678]; report.contract.PRIVATE_LOCAL_CONTRACT = 'PRIVATE_LOCAL_DATA';
  for (const snapshot of [report.before, report.after, ...report.attempts.map(item => item.snapshot)]) {
    snapshot.provenance = 'PRIVATE_SNAPSHOT_PROVENANCE';
    for (const row of snapshot.rows) { row.label = 'PRIVATE_UNREGISTERED_LABEL'; row.reason = 'PRIVATE_UNREGISTERED_REASON'; row.normals = [987654]; }
  }
  report.after.rows.push(row({ id: 'PRIVATE_NEW_SOURCE_ID', label: 'PRIVATE_ADDITIONAL_LABEL', reason: 'PRIVATE_ADDITIONAL_REASON' }));
  report.attempts.forEach(attempt => { attempt.reason = 'PRIVATE_ATTEMPT_REASON'; attempt.sourceId = 'PRIVATE_ATTEMPT_ID'; });
  const unchanged = structuredClone(report), projected = buildRestorationAssistantSnapshot([item]).assemblies[0].goal;
  assert.deepEqual(report, unchanged);
  assert.deepEqual(Object.keys(projected).sort(), ['version', 'status', 'termination', 'before', 'after', 'selectedAttempt', 'attempts', 'durationMs', 'maxAttempts', 'bounds', 'limits'].sort());
  assert.deepEqual(Object.keys(projected.after).sort(), ['status', 'rows', 'requiredError', 'preferenceError'].sort());
  assert.deepEqual(Object.keys(projected.attempts[0]).sort(), ['attempt', 'accepted', 'status', 'requiredError', 'preferenceError'].sort());
  assert.match(projected.after.rows.at(-1).id, /^requirement-[a-f0-9]{16}$/);
  assert.equal(projected.after.rows.at(-1).label, 'Additional requirement');
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE_|evidenceRevision|targetGaps|provenance|positions|normals|sourceId|123456|987654/);
  assert.equal(restorationAssistantGoalSchema.safeParse({ ...projected, evidenceRevision: 'goal-abcdefabcdefabcd' }).success, false);
  const unsafe = structuredClone(projected); unsafe.after.rows[0].positions = [1, 2, 3];
  assert.equal(restorationAssistantGoalSchema.safeParse(unsafe).success, false);
});

test('assistant instructions use requirements for problem-directed edits without adding tools or success shortcuts', () => {
  const item = make(); item.fit.goal = goal();
  const tools = createRestorationAssistantTools(buildRestorationAssistantSnapshot([item]), { allowEdits: true });
  assert.deepEqual(Object.keys(tools).sort(), ['getRestorationDesign', 'requestRestorationEdit']);
  assert.deepEqual(tools.getRestorationDesign.execute({}).assemblies[0].goal, projectRestorationGoal(item.fit.goal));
  const instructions = restorationAssistantLimits.join(' ');
  assert.match(instructions, /failed required contacts\/no-crossings/);
  assert.match(instructions, /Clinical unknowns need evidence/);
  assert.match(instructions, /Accepted, unchanged or generated geometry never means achieved/);
  assert.match(instructions, /goal\.after and selectedAttempt/);
  assert.match(instructions, /remaining failures and unknowns/);
});

test('applied edit results carry freshly projected goals and preserve existing before/after numeric feedback', async () => {
  const item = make(); item.fit.goal = goal();
  const design = buildRestorationAssistantSnapshot([item]).assemblies[0];
  const request = { assemblyId: design.id, expectedRevision: design.editRevision,
    edit: { reason: 'Revise crown width against required sampled contact.', parameters: { crown: { width: 4.2 } } } };
  const updated = make(applyRestorationEdit(item.spec, request.edit, 'agent')); updated.createdAt = 'updated'; updated.fit.goal = goal();
  updated.fit.goal.evidenceRevision = 'PRIVATE_NEW_EVIDENCE_REVISION'; updated.fit.goal.after.rows[0].actual = .8;
  updated.fit.goal.after.rows[0].error = .5;
  const { result } = await applyAssistantRestorationEdit({ assemblies: [item], busy: false, applyEdit: async () => updated }, request, new AbortController().signal);
  assert.equal(result.status, 'applied'); assert.equal(result.before.goal.after.rows[0].actual, 1.4); assert.equal(result.after.goal.after.rows[0].actual, .8);
  assert.ok(Array.isArray(result.changes)); assert.ok(Array.isArray(result.failureFeedback));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|evidenceRevision|targetGaps|"positions"|"normals"/);
});
