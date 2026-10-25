import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { MockLanguageModelV4 } from 'ai/test';
import { createAnthropic } from '@ai-sdk/anthropic';
import { simulateReadableStream } from 'ai';
import { createAssistantMiddleware } from '../server/assistant.ts';
import { ANTHROPIC_MODELS, DEFAULT_ASSISTANT_MODEL } from '../src/anthropic-models.ts';
import { assistantToolCatalog, buildAssistantSnapshot } from '../src/assistant-context.ts';
import { emptyToothCase } from '../src/tooth-session.ts';
import { readAssistantEvents } from '../src/assistant-protocol.ts';
import { captureRequestedTomographyView } from '../src/tomography-evidence.ts';
import { evidence, jpegUrls, sliceCapture, spec, summary } from './tomography-fixtures.mjs';

const snapshot = () => buildAssistantSnapshot({ parts: [], selected: null, probe: null, report: null, tolerance: 0.5, analysisState: 'unavailable', teeth: emptyToothCase().teeth, counts: {}, fitSummary: [], fitRadius: null });
async function serve(t, config = {}) {
  const middleware = createAssistantMiddleware(config);
  const server = createServer((req, res) => void middleware(req, res, () => { res.statusCode = 404; res.end(); }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const body = () => ({ messages: [{ role: 'user', content: 'Which scans are imported?' }], snapshot: snapshot() });
const post = (url, payload = body(), headers = {}) => fetch(`${url}/api/assistant/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload) });
const finish = reason => ({ type: 'finish', finishReason: { unified: reason, raw: reason }, usage: { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } } });
const stream = chunks => ({ stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }) });
const answerModel = text => new MockLanguageModelV4({ doStream: [
  stream([{ type: 'tool-call', toolCallId: 'inventory', toolName: 'getModelInventory', input: '{}' }, finish('tool-calls')]),
  stream([{ type: 'text-start', id: 'answer' }, { type: 'text-delta', id: 'answer', delta: text }, { type: 'text-end', id: 'answer' }, finish('stop')]),
] });

test('optional assistant reports configuration and rejects calls without a key', async t => {
  const url = await serve(t);
  const status = await (await fetch(`${url}/api/assistant/status`)).json();
  assert.deepEqual(status, { configured: false, model: DEFAULT_ASSISTANT_MODEL });
  const response = await post(url);
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /ANTHROPIC_API_KEY/);
});

test('each selected model reaches its provider instance and is attributed in the chat header', async t => {
  const selected = [];
  const models = new Map(ANTHROPIC_MODELS.map(({ id }) => [id, answerModel(`Answered by ${id}.`)]));
  models.set('claude-test', answerModel('Server fallback.'));
  const url = await serve(t, {
    model: 'claude-test',
    languageModelFactory: id => { selected.push(id); return models.get(id); },
  });
  assert.deepEqual(await (await fetch(`${url}/api/assistant/status`)).json(), { configured: true, model: 'claude-test' });
  assert.deepEqual(selected, []);
  for (const { id } of ANTHROPIC_MODELS) {
    const response = await post(url, { ...body(), model: id });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-assistant-model'), id);
    const events = []; await readAssistantEvents(response.body, event => events.push(event));
    assert.equal(events.filter(event => event.type === 'text').map(event => event.text).join(''), `Answered by ${id}.`);
    assert.equal(events.at(-1).type, 'done');
    assert.equal(models.get(id).doStreamCalls.length, 2);
  }
  assert.deepEqual(selected, ANTHROPIC_MODELS.map(model => model.id));
  const fallback = await post(url);
  assert.equal(fallback.headers.get('x-assistant-model'), 'claude-test');
  assert.match(await fallback.text(), /Server fallback/);
  assert.equal(models.get('claude-test').doStreamCalls.length, 2);
  assert.deepEqual(selected, [...ANTHROPIC_MODELS.map(model => model.id), 'claude-test']);
  assert.deepEqual(await (await fetch(`${url}/api/assistant/status`)).json(), { configured: true, model: 'claude-test' });
});

test('omitting a chat model uses the server model or the assistant default', async t => {
  for (const configuredModel of [undefined, '', 'claude-test']) {
    const selected = [];
    const model = answerModel('No scans imported.');
    const url = await serve(t, { model: configuredModel, languageModelFactory: id => { selected.push(id); return model; } });
    const response = await post(url);
    const expected = configuredModel || DEFAULT_ASSISTANT_MODEL;
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-assistant-model'), expected);
    assert.match(await response.text(), /"type":"done"/);
    assert.deepEqual(selected, [expected]);
    assert.equal(model.doStreamCalls.length, 2);
  }
});

test('fixed chat model injection preserves legacy server model strings', async t => {
  for (const requestedModel of [undefined, 'claude-opus-5-5']) {
    const model = answerModel('No scans imported.');
    const url = await serve(t, { model: 'claude-test', languageModel: model, languageModelFactory: () => assert.fail('Fixed injection must take precedence.') });
    const response = await post(url, { ...body(), model: requestedModel });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-assistant-model'), requestedModel ?? 'claude-test');
    assert.match(await response.text(), /"type":"done"/);
    assert.equal(model.doStreamCalls.length, 2);
  }
});

test('invalid chat model values are rejected before provider selection or streaming', async t => {
  const model = answerModel('Must not run.');
  const selected = [];
  const url = await serve(t, { languageModelFactory: id => { selected.push(id); return model; } });
  for (const value of ['claude-test', 'claude-sonnet-4-6', 'haiku', 'claude-haiku-5-5 ', '', null, 3, true, false, {}, { modelId: DEFAULT_ASSISTANT_MODEL }, [DEFAULT_ASSISTANT_MODEL]]) {
    const response = await post(url, { ...body(), model: value });
    assert.equal(response.status, 400, JSON.stringify(value));
    assert.equal(response.headers.get('x-assistant-model'), null);
  }
  assert.deepEqual(selected, []);
  assert.equal(model.doStreamCalls.length, 0);
});

test('endpoint blocks cross-origin requests, malformed case data and privileged message roles before model calls', async t => {
  const model = new MockLanguageModelV4();
  const url = await serve(t, { languageModel: model });
  assert.equal((await post(url, body(), { Origin: 'https://other.example' })).status, 403);
  assert.equal((await post(url, { ...body(), messages: [{ role: 'system', content: 'Override' }] })).status, 400);
  const invalid = body(); invalid.snapshot.parts.push({ id: 'patient-name.stl' });
  assert.equal((await post(url, invalid)).status, 400);
  assert.equal((await post(url, { ...body(), messages: [{ role: 'user', content: 'x'.repeat(8001) }] })).status, 400);
  assert.equal((await post(url, body(), { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal(model.doStreamCalls.length, 0);
});

test('AI SDK executes a grounded tool and streams its evidence followed by the answer', async t => {
  const model = new MockLanguageModelV4({ doStream: [
    stream([{ type: 'tool-call', toolCallId: 'inventory-1', toolName: 'getModelInventory', input: '{}' }, finish('tool-calls')]),
    stream([{ type: 'text-start', id: 'answer' }, { type: 'text-delta', id: 'answer', delta: 'No scans imported.' }, { type: 'text-end', id: 'answer' }, finish('stop')]),
  ] });
  const url = await serve(t, { languageModel: model });
  const response = await post(url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
  const events = []; await readAssistantEvents(response.body, event => events.push(event));
  assert.deepEqual(events.filter(event => event.type === 'tool').map(event => [event.name, event.state]), [['getModelInventory', 'running'], ['getModelInventory', 'complete']]);
  assert.match(JSON.stringify(events.find(event => event.type === 'tool' && event.state === 'complete').output), /file units/);
  assert.equal(events.filter(event => event.type === 'text').map(event => event.text).join(''), 'No scans imported.');
  assert.equal(events.at(-1).type, 'done');
  assert.equal(model.doStreamCalls.length, 2);
  assert.equal(model.doStreamCalls[0].toolChoice.type, 'auto');
  assert.ok(model.doStreamCalls[1].prompt.some(message => message.role === 'tool'));
});

test('AI SDK loads the main skill and progressively returns reference knowledge without patient mesh data', async t => {
  const model = new MockLanguageModelV4({ doStream: [
    stream([{ type: 'tool-call', toolCallId: 'guidance-1', toolName: 'getDentalDesignGuidance', input: '{"topic":"geometry-workflow"}' }, finish('tool-calls')]),
    stream([{ type: 'text-start', id: 'answer' }, { type: 'text-delta', id: 'answer', delta: 'This is general design guidance; this chat cannot generate or place a crown.' }, { type: 'text-end', id: 'answer' }, finish('stop')]),
  ] });
  const url = await serve(t, { languageModel: model });
  const localPart = {
    id: 'PRIVATE_PATIENT_ID', name: 'PRIVATE_PATIENT_NAME', fileName: 'PRIVATE_PATIENT_SCAN.ply',
    positions: new Float32Array([987654.321, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array(9),
    role: 'upper', closed: false, visible: true, offset: [0, 0, 0], triangles: 1, vertices: 3, dimensions: [1, 1, 0],
  };
  const teeth = emptyToothCase().teeth;
  teeth[36].note = 'PRIVATE_PATIENT_NOTE';
  const summary = buildAssistantSnapshot({ parts: [localPart], selected: localPart.id, probe: null, report: null, tolerance: 0.5, analysisState: 'unavailable', teeth, counts: {}, fitSummary: [], fitRadius: null });
  const response = await post(url, { messages: [{ role: 'user', content: 'What evidence is needed for crown shape, bite, and implant depth or size?' }], snapshot: summary });
  assert.equal(response.status, 200);
  const events = []; await readAssistantEvents(response.body, event => events.push(event));
  assert.deepEqual(events.filter(event => event.type === 'tool').map(event => [event.id, event.name, event.state]), [
    ['guidance-1', 'getDentalDesignGuidance', 'running'], ['guidance-1', 'getDentalDesignGuidance', 'complete'],
  ]);
  const complete = events.find(event => event.type === 'tool' && event.state === 'complete');
  assert.deepEqual(events.find(event => event.type === 'tool' && event.state === 'running').input, { topic: 'geometry-workflow' });
  assert.equal(complete.output.status, 'available');
  assert.equal(complete.output.source, 'skills/dental-restoration-design/references/geometry-workflow.md');
  assert.equal(complete.output.content, await readFile(new URL('../skills/dental-restoration-design/references/geometry-workflow.md', import.meta.url), 'utf8'));
  assert.match(complete.output.provenance, /GENERAL DESIGN KNOWLEDGE; not a patient observation/);
  assert.equal(Object.hasOwn(complete.output, 'units'), false);
  assert.equal(events.some(event => event.type === 'error'), false);
  assert.equal(events.at(-1).type, 'done');
  assert.equal(model.doStreamCalls.length, 2);
  assert.deepEqual(model.doStreamCalls.map(call => call.toolChoice.type), ['auto', 'auto']);
  assert.deepEqual(model.doStreamCalls[0].tools.map(tool => tool.name), assistantToolCatalog.filter(entry => entry.name !== 'requestTomographyView').map(entry => entry.name));
  const mainSkill = await readFile(new URL('../skills/dental-restoration-design/SKILL.md', import.meta.url), 'utf8');
  for (const call of model.doStreamCalls) {
    const system = call.prompt.filter(message => message.role === 'system').map(message => message.content).join('\n');
    assert.ok(system.includes(mainSkill));
    assert.match(system, /getDentalDesignGuidance call alone never satisfies the case-evidence requirement/);
    assert.match(system, /GENERAL DESIGN KNOWLEDGE, not a patient observation/);
    assert.match(system, /implant depth\/size, crown shape.*bite questions/);
    assert.match(system, /Report distances in file units/);
    assert.match(system, /Previous chat may describe old geometry; obtain fresh tool results/);
    assert.match(system, /Never prescribe implant diameter\/length/);
    assert.match(system, /No tools can alter a case.*generate geometry/);
    assert.match(system, /Without that tool, provide evidence interpretation and design guidance only/);
    assert.match(system, /Raw mesh access, coding-agent CLI execution.*clinical placement approval remain unavailable/);
  }
  const feedback = model.doStreamCalls[1].prompt.filter(message => message.role === 'tool').flatMap(message => message.content).find(part => part.toolCallId === 'guidance-1');
  assert.equal(feedback.type, 'tool-result');
  assert.equal(feedback.output.type, 'json');
  assert.deepEqual(feedback.output.value, complete.output);
  assert.doesNotMatch(JSON.stringify({ calls: model.doStreamCalls, events }), /PRIVATE_PATIENT|987654|"positions"|"normals"/);
});

test('AI SDK rejects a traversal topic instead of returning file contents or completing the guidance tool', async t => {
  const model = new MockLanguageModelV4({ doStream: [
    stream([{ type: 'tool-call', toolCallId: 'invalid-guidance', toolName: 'getDentalDesignGuidance', input: '{"topic":"../../.env.local"}' }, finish('tool-calls')]),
    stream([{ type: 'text-start', id: 'answer' }, { type: 'text-delta', id: 'answer', delta: 'That topic is unavailable.' }, { type: 'text-end', id: 'answer' }, finish('stop')]),
  ] });
  const url = await serve(t, { languageModel: model });
  const response = await post(url); const events = [];
  await readAssistantEvents(response.body, event => events.push(event));
  assert.equal(response.status, 200);
  assert.deepEqual(events.filter(event => event.type === 'tool').map(event => event.state), ['running', 'error']);
  assert.equal(events.some(event => event.type === 'tool' && event.state === 'complete'), false);
  assert.equal(model.doStreamCalls.length, 2);
  const feedback = model.doStreamCalls[1].prompt.filter(message => message.role === 'tool').flatMap(message => message.content).find(part => part.toolCallId === 'invalid-guidance');
  assert.equal(feedback.output.type, 'error-text');
  assert.match(feedback.output.value, /Invalid input/);
  assert.equal(events.at(-1).type, 'done');
});

test('reference guidance and fresh site evidence retain distinct provenance in one model turn', async t => {
  const model = new MockLanguageModelV4({ doStream: [
    stream([
      { type: 'tool-call', toolCallId: 'clinical-guidance', toolName: 'getDentalDesignGuidance', input: '{"topic":"clinical-considerations"}' },
      { type: 'tool-call', toolCallId: 'site-evidence', toolName: 'inspectImplantSite', input: '{"fdi":36}' },
      finish('tool-calls'),
    ]),
    stream([{ type: 'text-start', id: 'answer' }, { type: 'text-delta', id: 'answer', delta: 'The recorded site has no marker. General guidance cannot establish implant depth or size.' }, { type: 'text-end', id: 'answer' }, finish('stop')]),
  ] });
  const response = await post(await serve(t, { languageModel: model }));
  const events = []; await readAssistantEvents(response.body, event => events.push(event));
  const outputs = Object.fromEntries(events.filter(event => event.type === 'tool' && event.state === 'complete').map(event => [event.id, event.output]));
  assert.equal(outputs['clinical-guidance'].status, 'available');
  assert.match(outputs['clinical-guidance'].provenance, /GENERAL DESIGN KNOWLEDGE; not a patient observation/);
  assert.equal(outputs['site-evidence'].status, 'unavailable');
  assert.match(outputs['site-evidence'].provenance, /local mesh metadata and user-entered FDI records/);
  assert.equal(outputs['site-evidence'].record.fdi, 36);
  assert.equal(outputs['site-evidence'].record.status, 'unreviewed');
  assert.equal(outputs['site-evidence'].record.site, null);
  const feedback = model.doStreamCalls[1].prompt.filter(message => message.role === 'tool').flatMap(message => message.content);
  for (const part of feedback) assert.deepEqual(part.output.value, outputs[part.toolCallId]);
  assert.equal(feedback.length, 2);
  assert.equal(events.at(-1).type, 'done');
});

test('provider failures return a safe error without exposing credentials or upstream data', async t => {
  const model = new MockLanguageModelV4({ doStream: async () => { throw new Error('private upstream diagnostic'); } });
  const url = await serve(t, { languageModel: model, apiKey: 'test-secret-do-not-expose' });
  const response = await post(url); const text = await response.text();
  assert.match(text, /error/);
  assert.doesNotMatch(text, /test-secret|private upstream diagnostic/);
  assert.doesNotMatch(text, /"type":"done"/);
});

test('event reader preserves split UTF-8 and NDJSON record boundaries', async () => {
  const bytes = new TextEncoder().encode('{"type":"text","text":"diámetro"}\n{"type":"done"}');
  const events = [];
  await readAssistantEvents(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } }), event => events.push(event));
  assert.deepEqual(events, [{ type: 'text', text: 'diámetro' }, { type: 'done' }]);
});

test('closing a client stream aborts the upstream AI SDK request', async t => {
  let upstreamAborted;
  const aborted = new Promise(resolve => { upstreamAborted = resolve; });
  const model = new MockLanguageModelV4({ doStream: async ({ abortSignal }) => ({
    stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'text-start', id: 'pending' });
      controller.enqueue({ type: 'text-delta', id: 'pending', delta: 'Partial' });
      abortSignal.addEventListener('abort', () => { upstreamAborted(); controller.close(); }, { once: true });
    } }),
  }) });
  const url = await serve(t, { languageModel: model });
  const response = await post(url);
  const reader = response.body.getReader(); await reader.read(); await reader.cancel();
  const timeout = setTimeout(() => upstreamAborted('timeout'), 2000);
  assert.equal(await aborted, undefined); clearTimeout(timeout);
  assert.equal(model.doStreamCalls[0].abortSignal.aborted, true);
});

test('token-limited answers are incomplete and never receive a done event', async t => {
  const model = new MockLanguageModelV4({ doStream: [
    stream([{ type: 'tool-call', toolCallId: 'inventory-1', toolName: 'getModelInventory', input: '{}' }, finish('tool-calls')]),
    stream([{ type: 'text-start', id: 'partial' }, { type: 'text-delta', id: 'partial', delta: 'Incomplete assessment' }, { type: 'text-end', id: 'partial' }, finish('length')]),
  ] });
  const url = await serve(t, { languageModel: model });
  const response = await post(url); const events = [];
  await readAssistantEvents(response.body, event => events.push(event));
  assert.ok(events.some(event => event.type === 'text'));
  assert.ok(events.some(event => event.type === 'error' && /output limit.*incomplete/.test(event.message)));
  assert.ok(!events.some(event => event.type === 'done'));
});

test('timed-out incomplete uploads release both concurrency slots', { timeout: 3000 }, async t => {
  const model = new MockLanguageModelV4({ doStream: [
    stream([{ type: 'tool-call', toolCallId: 'inventory-1', toolName: 'getModelInventory', input: '{}' }, finish('tool-calls')]),
    stream([{ type: 'text-start', id: 'ok' }, { type: 'text-delta', id: 'ok', delta: 'Responding' }, { type: 'text-end', id: 'ok' }, finish('stop')]),
  ] });
  const url = await serve(t, { languageModel: model, requestTimeoutMs: 100 });
  const stalled = () => new Promise(resolve => {
    const request = httpRequest(`${url}/api/assistant/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    request.on('error', resolve); request.on('response', response => { response.resume(); response.on('end', resolve); });
    request.write('{'); // Deliberately leave the body open.
  });
  await Promise.all([stalled(), stalled()]);
  const response = await post(url);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /"type":"done"/);
});


const imageParts = prompt => prompt.flatMap(message => message.content instanceof Array ? message.content : [])
  .flatMap(part => part.type === 'tool-result' && part.output.type === 'content' ? part.output.value : [part])
  .filter(part => part.type === 'file');

test('selected local JPEG reaches the injected model as native multimodal evidence, not text or every image', async t => {
  const model = new MockLanguageModelV4({ doStream: [
    stream([{ type: 'tool-call', toolCallId: 'inspect-2', toolName: 'inspectTomographyView', input: '{"viewId":"view-2"}' }, finish('tool-calls')]),
    stream([{ type: 'text-start', id: 'answer' }, { type: 'text-delta', id: 'answer', delta: 'Inspected view-2 with incomplete coverage and unregistered overlay.' }, { type: 'text-end', id: 'answer' }, finish('stop')]),
  ] });
  const images = evidence();
  images.summary.complete = false; images.summary.quantitativeMeasurementsAllowed = false; images.summary.missingSlices = 1;
  const response = await post(await serve(t, { languageModel: model }), { ...body(), tomography: images });
  assert.equal(response.status, 200);
  const events = []; await readAssistantEvents(response.body, event => events.push(event));
  assert.equal(events.at(-1).type, 'done');
  assert.equal(model.doStreamCalls.length, 2);
  assert.equal(imageParts(model.doStreamCalls[0].prompt).length, 0);
  const nativeFiles = imageParts(model.doStreamCalls[1].prompt);
  assert.equal(nativeFiles.length, 1);
  assert.equal(nativeFiles[0].mediaType, 'image/jpeg');
  assert.equal(nativeFiles[0].data.type, 'data');
  assert.deepEqual(nativeFiles[0].data.data, new Uint8Array(Buffer.from(jpegUrls[1].split(',')[1], 'base64')));
  assert.notDeepEqual(nativeFiles[0].data.data, new Uint8Array(Buffer.from(jpegUrls[0].split(',')[1], 'base64')));
  const feedback = model.doStreamCalls[1].prompt.filter(message => message.role === 'tool').flatMap(message => message.content).find(part => part.toolCallId === 'inspect-2');
  const metadata = JSON.parse(feedback.output.value.find(part => part.type === 'text').text);
  assert.deepEqual(metadata.metadata.spec, images.views[1].spec);
  assert.deepEqual(metadata.metadata.pixelOriginLpsMm, images.views[1].pixelOriginLpsMm);
  assert.equal(metadata.summary.complete, false);
  assert.equal(metadata.summary.quantitativeMeasurementsAllowed, false);
  assert.equal(metadata.summary.units, 'mm');
  assert.equal(metadata.summary.registration.workspaceUnits, 'file units');
  assert.equal(metadata.summary.registration.status, 'unregistered');
  assert.match(metadata.limitations.join(' '), /Incomplete previews cannot establish bone height, depth, safety clearance or HU density/);
  assert.doesNotMatch(JSON.stringify(events), /data:image|base64|"voxels"|sourceUID|patientName/);
  assert.deepEqual(events.find(event => event.type === 'tool' && event.state === 'complete').output, metadata);
});

test('sharing absent exposes unavailable inventory and no image data, capture request tool or fictitious image', async t => {
  const model = new MockLanguageModelV4({ doStream: [
    stream([{ type: 'tool-call', toolCallId: 'no-images', toolName: 'getTomographyInventory', input: '{}' }, finish('tool-calls')]),
    stream([{ type: 'text-start', id: 'answer' }, { type: 'text-delta', id: 'answer', delta: 'No images have been shared.' }, { type: 'text-end', id: 'answer' }, finish('stop')]),
  ] });
  const response = await post(await serve(t, { languageModel: model }));
  const events = []; await readAssistantEvents(response.body, event => events.push(event));
  const inventory = events.find(event => event.type === 'tool' && event.state === 'complete').output;
  assert.equal(inventory.sharing, 'off'); assert.deepEqual(inventory.views, []); assert.equal(inventory.summary, null);
  for (const call of model.doStreamCalls) {
    assert.equal(imageParts(call.prompt).length, 0);
    assert.equal(call.tools.some(tool => tool.name === 'requestTomographyView'), false);
    assert.match(call.prompt.filter(message => message.role === 'system').map(message => message.content).join(' '), /Image sharing for this request: off/);
  }
});

test('invalid, private or unbounded image metadata is rejected before provider calls with fixed safe errors', async t => {
  const model = answerModel('Must not see invalid images.');
  const url = await serve(t, { languageModel: model });
  const variants = [
    { ...evidence(), sharing: 'off' },
    { ...evidence(), summary: { ...summary(), patientName: 'PRIVATE_NAME' } },
    { ...evidence(), summary: { ...summary(), sourceUID: 'PRIVATE_UID' } },
    { ...evidence(), views: [{ ...sliceCapture(), voxels: [12345] }] },
    { ...evidence(), views: [{ ...sliceCapture(), id: 'PRIVATE_NAME.dcm' }] },
    { ...evidence(), views: [{ ...sliceCapture(), dataUrl: 'https://PRIVATE_IMAGE.example' }] },
    { ...evidence(), views: [{ ...sliceCapture(), dataUrl: 'data:image/jpeg;base64,AAAA' }] },
    { ...evidence(), views: Array(9).fill(sliceCapture()) },
  ];
  for (const tomography of variants) {
    const response = await post(url, { ...body(), tomography });
    assert.equal(response.status, 400);
    const error = await response.text();
    assert.doesNotMatch(error, /PRIVATE_|voxels|12345|base64/);
    assert.equal(JSON.parse(error).error, 'Invalid question or case summary. Refresh the workspace and try again.');
  }
  for (const continuation of [
    { round: 1, viewId: 'view-1', spec: spec(), analysis: '' },
    { round: 4, viewId: 'view-1', spec: spec(), analysis: '' },
  ]) assert.equal((await post(url, { ...body(), continuation })).status, 400);
  assert.equal((await post(url, body(), { Origin: url.replace('http:', 'https:') })).status, 403);
  assert.equal(model.doStreamCalls.length, 0);
});

test('precise view request hands off to local rendering, then resumes the original question with actual image evidence', async t => {
  const requested = { ...spec(), plane: 'oblique', center: [12.5, 25, 30], normal: [0, 0, -1], up: [0, -1, 0], widthMm: 80, heightMm: 60, slabMm: 0.2 };
  const model = new MockLanguageModelV4({ doStream: [
    stream([
      { type: 'text-start', id: 'analysis' }, { type: 'text-delta', id: 'analysis', delta: 'Need a precise section through this recorded location.' }, { type: 'text-end', id: 'analysis' },
      { type: 'tool-call', toolCallId: 'request-section', toolName: 'requestTomographyView', input: JSON.stringify(requested) }, finish('tool-calls'),
    ]),
    stream([{ type: 'tool-call', toolCallId: 'inspect-new', toolName: 'inspectTomographyView', input: '{"viewId":"view-3"}' }, finish('tool-calls')]),
    stream([{ type: 'text-start', id: 'answer' }, { type: 'text-delta', id: 'answer', delta: 'The requested view-3 is now visible.' }, { type: 'text-end', id: 'answer' }, finish('stop')]),
  ] });
  const url = await serve(t, { languageModel: model });
  const original = { ...body(), tomography: evidence() };
  const first = await post(url, original); const initialEvents = [];
  await readAssistantEvents(first.body, event => initialEvents.push(event));
  const handoff = initialEvents.find(event => event.type === 'view-request');
  assert.deepEqual(handoff, { type: 'view-request', id: 'request-section', spec: requested, round: 1 });
  assert.equal(initialEvents.some(event => event.type === 'error' || event.type === 'done'), false);
  assert.equal(model.doStreamCalls.length, 1);
  let captured = 0;
  const rendered = await captureRequestedTomographyView({ revision: 'local', summary: summary(), capture: async (s, signal) => { assert.deepEqual(s, requested); assert.equal(signal.aborted, false); captured++; return sliceCapture(s); } }, original.tomography, requested, 1, new AbortController().signal);
  assert.equal(captured, 1);
  const continuation = { round: 1, viewId: 'view-3', spec: requested, analysis: 'Need a precise section through this recorded location.' };
  const next = await post(url, { ...original, tomography: rendered, continuation }); const resumed = [];
  await readAssistantEvents(next.body, event => resumed.push(event));
  assert.equal(resumed.at(-1).type, 'done');
  assert.equal(model.doStreamCalls.length, 3);
  const continuedPrompt = model.doStreamCalls[1].prompt;
  assert.equal(continuedPrompt.filter(message => message.role === 'user').length, 1);
  assert.equal(continuedPrompt.find(message => message.role === 'user').content[0].text, original.messages[0].content);
  assert.match(continuedPrompt.filter(message => message.role === 'system').map(message => message.content).join(' '), /Continuation round 1\/3.*view-3.*Need a precise section/s);
  assert.equal(imageParts(model.doStreamCalls[2].prompt).length, 1);
  const actual = resumed.find(event => event.type === 'tool' && event.state === 'complete').output;
  assert.deepEqual(actual.metadata.spec, requested);
  assert.deepEqual(actual.metadata.pixelOriginLpsMm, sliceCapture(requested).pixelOriginLpsMm);
  const invalid = await post(url, { ...original, tomography: rendered, continuation: { ...continuation, spec: { ...requested, center: [0, 0, 0] } } });
  assert.equal(invalid.status, 400);
  assert.equal(model.doStreamCalls.length, 3);
});

test('third image continuation removes further capture requests while preserving inspectable evidence', async t => {
  const model = answerModel('The bounded image review is complete.');
  const images = evidence(); images.canRequestViews = true;
  const response = await post(await serve(t, { languageModel: model }), { ...body(), tomography: images, continuation: { round: 3, viewId: 'view-1', spec: images.views[0].spec, analysis: '' } });
  assert.match(await response.text(), /"type":"done"/);
  assert.equal(model.doStreamCalls[0].tools.some(tool => tool.name === 'requestTomographyView'), false);
  assert.equal(model.doStreamCalls[0].tools.some(tool => tool.name === 'inspectTomographyView'), true);
});

test('aborting an active multimodal continuation cancels the upstream image request without further model steps', async t => {
  let markAborted; const aborted = new Promise(resolve => { markAborted = resolve; });
  let call = 0;
  const model = new MockLanguageModelV4({ doStream: async options => {
    if (call++ === 0) return stream([{ type: 'tool-call', toolCallId: 'inspect', toolName: 'inspectTomographyView', input: '{"viewId":"view-1"}' }, finish('tool-calls')]);
    assert.equal(imageParts(options.prompt).length, 1);
    return { stream: new ReadableStream({ start(controller) {
      controller.enqueue({ type: 'text-start', id: 'pending' });
      controller.enqueue({ type: 'text-delta', id: 'pending', delta: 'Inspecting image' });
      options.abortSignal.addEventListener('abort', () => { markAborted(); controller.close(); }, { once: true });
    } }) };
  } });
  const response = await post(await serve(t, { languageModel: model }), { ...body(), tomography: evidence() });
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let seen = '';
  while (!seen.includes('Inspecting image')) { const next = await reader.read(); assert.equal(next.done, false); seen += decoder.decode(next.value); }
  await reader.cancel();
  const timeout = setTimeout(() => markAborted('timeout'), 2000);
  assert.equal(await aborted, undefined); clearTimeout(timeout);
  assert.equal(model.doStreamCalls.length, 2);
  assert.equal(model.doStreamCalls[1].abortSignal.aborted, true);
});


test('Anthropic serialization places the selected JPEG inside native tool_result image content', async t => {
  const providerRequests = [];
  const provider = createAnthropic({ apiKey: 'local-test-key-never-output', fetch: async (_url, options) => {
    providerRequests.push(JSON.parse(options.body));
    const first = providerRequests.length === 1;
    const records = [
      { type: 'message_start', message: { id: `message-${providerRequests.length}`, role: 'assistant', model: DEFAULT_ASSISTANT_MODEL, usage: { input_tokens: 10 } } },
      ...(first ? [
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'native-inspection', name: 'inspectTomographyView', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"viewId":"view-2"}' } },
      ] : [
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The selected image is visible.' } },
      ]),
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: first ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ];
    return new Response(records.map(record => `event: ${record.type}\ndata: ${JSON.stringify(record)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  const response = await post(await serve(t, { languageModel: provider(DEFAULT_ASSISTANT_MODEL) }), { ...body(), tomography: evidence() });
  const result = await response.text();
  assert.match(result, /"type":"done"/);
  assert.equal(providerRequests.length, 2);
  assert.doesNotMatch(JSON.stringify(providerRequests[0]), /"type":"image"|data:image|\/9j/);
  const toolResults = providerRequests[1].messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'tool_result');
  const selected = toolResults.find(part => part.tool_use_id === 'native-inspection');
  const images = selected.content.filter(part => part.type === 'image');
  assert.deepEqual(images, [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpegUrls[1].split(',')[1] } }]);
  assert.doesNotMatch(result, /local-test-key|data:image|"type":"image"/);
});

test('aggregate image request byte limit applies before parsing for declared and chunked uploads', async t => {
  const model = answerModel('Must not receive an oversized request.');
  const url = await serve(t, { languageModel: model });
  const declared = await new Promise((resolve, reject) => {
    const request = httpRequest(`${url}/api/assistant/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': 18 * 1024 * 1024 + 1 } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject); request.end();
  });
  assert.equal(declared, 413);
  const chunked = await new Promise((resolve, reject) => {
    const request = httpRequest(`${url}/api/assistant/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject);
    request.write(Buffer.alloc(9 * 1024 * 1024, 32)); request.end(Buffer.alloc(9 * 1024 * 1024 + 1, 32));
  });
  assert.equal(chunked, 413);
  assert.equal(model.doStreamCalls.length, 0);
});
