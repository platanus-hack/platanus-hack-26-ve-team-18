import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { MockLanguageModelV4 } from 'ai/test';
import { createToothIdentificationMiddleware, DEFAULT_TOOTH_MODEL } from '../server/tooth-identification.ts';
import { ANTHROPIC_MODELS, DEFAULT_IDENTIFICATION_MODEL } from '../src/anthropic-models.ts';

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const jpeg = marker => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(marker), Buffer.from([0xff, 0xd9])]);
const VIEW_A = jpeg('VIEW-A');
const VIEW_B = jpeg('VIEW-B');
const body = () => ({
  arch: 'upper',
  patientRight: 'image-right',
  views: [
    { label: 'Occlusal overview', mediaType: 'image/jpeg', base64: VIEW_A.toString('base64') },
    { label: 'Oblique +u', mediaType: 'image/jpeg', base64: VIEW_B.toString('base64') },
  ],
  candidates: [
    { id: 3, triangles: 120, area: 4.5, height: 7, warnings: [] },
    { id: 7, triangles: 80, area: 3, height: 6, warnings: ['open edge'] },
  ],
});
const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const generated = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] });
const goodOutput = {
  mappings: [
    { candidateId: 3, fdi: 11, needsReview: false, reason: 'Central incisor shape.' },
    { candidateId: 7, fdi: null, needsReview: true, reason: 'Partly visible in the views.' },
  ],
  possibleMissing: [{ fdi: 12, reason: 'No separate region in this segment.' }],
  warnings: ['Candidate 7 is partial.'],
};
const hang = options => new Promise((_, reject) => options.abortSignal.addEventListener('abort', () => reject(options.abortSignal.reason), { once: true }));

async function serve(t, config = {}) {
  const middleware = createToothIdentificationMiddleware(config);
  const server = createServer((req, res) => void middleware(req, res, () => { res.statusCode = 404; res.end(); }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
const identify = (url, payload = body(), headers = {}, init = {}) => fetch(`${url}/api/teeth/identify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: url, ...headers },
  body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  ...init,
});
async function until(check, message, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(message);
}
const userParts = call => call.prompt.filter(message => message.role === 'user').flatMap(message => message.content);

test('status reports configuration and model without claiming provider reachability', async t => {
  const url = await serve(t);
  const status = await (await fetch(`${url}/api/teeth/status`)).json();
  assert.deepEqual(Object.keys(status).sort(), ['configured', 'model']);
  assert.deepEqual(status, { configured: false, model: DEFAULT_TOOTH_MODEL });
  assert.equal(DEFAULT_TOOTH_MODEL, 'claude-haiku-5-5');
  const configured = await serve(t, { languageModel: new MockLanguageModelV4(), model: 'claude-test' });
  assert.deepEqual(await (await fetch(`${configured}/api/teeth/status`)).json(), { configured: true, model: 'claude-test' });
  assert.equal((await fetch(`${url}/api/teeth/status`, { method: 'POST', headers: { Origin: url } })).status, 405);
  assert.equal((await fetch(`${url}/api/teeth/status`, { headers: { Origin: 'https://other.example' } })).status, 403);
});

test('identify without a configured key returns 503 and never reaches a provider', async t => {
  const url = await serve(t);
  const response = await identify(url);
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /ANTHROPIC_API_KEY/);
});

test('each selected identification model reaches its provider instance and is returned with the mapping', async t => {
  const selected = [];
  const models = new Map(ANTHROPIC_MODELS.map(({ id }) => [id, new MockLanguageModelV4({ doGenerate: generated({ ...goodOutput, warnings: [`Answered by ${id}.`] }) })]));
  models.set('claude-test', new MockLanguageModelV4({ doGenerate: generated(goodOutput) }));
  const url = await serve(t, {
    model: 'claude-test',
    languageModelFactory: id => { selected.push(id); return models.get(id); },
  });
  assert.deepEqual(await (await fetch(`${url}/api/teeth/status`)).json(), { configured: true, model: 'claude-test' });
  assert.deepEqual(selected, []);
  for (const { id } of ANTHROPIC_MODELS) {
    const response = await identify(url, { ...body(), model: id });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.model, id);
    assert.deepEqual(result.warnings, [`Answered by ${id}.`]);
    assert.equal(models.get(id).doGenerateCalls.length, 1);
  }
  assert.deepEqual(selected, ANTHROPIC_MODELS.map(model => model.id));
  const fallback = await identify(url);
  assert.equal((await fallback.json()).model, 'claude-test');
  assert.equal(models.get('claude-test').doGenerateCalls.length, 1);
  assert.deepEqual(selected, [...ANTHROPIC_MODELS.map(model => model.id), 'claude-test']);
  assert.deepEqual(await (await fetch(`${url}/api/teeth/status`)).json(), { configured: true, model: 'claude-test' });
});

test('omitting an identification model uses the server model or the identification default', async t => {
  for (const configuredModel of [undefined, '', 'claude-test']) {
    const selected = [];
    const model = new MockLanguageModelV4({ doGenerate: generated(goodOutput) });
    const url = await serve(t, { model: configuredModel, languageModelFactory: id => { selected.push(id); return model; } });
    const response = await identify(url);
    const expected = configuredModel || DEFAULT_IDENTIFICATION_MODEL;
    assert.equal(response.status, 200);
    assert.equal((await response.json()).model, expected);
    assert.deepEqual(selected, [expected]);
    assert.equal(model.doGenerateCalls.length, 1);
  }
});

test('fixed identification model injection preserves legacy server model strings', async t => {
  for (const requestedModel of [undefined, 'claude-opus-5-5']) {
    const model = new MockLanguageModelV4({ doGenerate: generated(goodOutput) });
    const url = await serve(t, { model: 'claude-test', languageModel: model, languageModelFactory: () => assert.fail('Fixed injection must take precedence.') });
    const response = await identify(url, { ...body(), model: requestedModel });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).model, requestedModel ?? 'claude-test');
    assert.equal(model.doGenerateCalls.length, 1);
  }
});

test('invalid identification model values are rejected before provider selection or generation', async t => {
  const model = new MockLanguageModelV4({ doGenerate: generated(goodOutput) });
  const selected = [];
  const url = await serve(t, { languageModelFactory: id => { selected.push(id); return model; } });
  for (const value of ['claude-test', 'claude-sonnet-4-6', 'haiku', 'claude-haiku-5-5 ', '', null, 3, true, false, {}, { modelId: DEFAULT_IDENTIFICATION_MODEL }, [DEFAULT_IDENTIFICATION_MODEL]]) {
    const response = await identify(url, { ...body(), model: value });
    assert.equal(response.status, 400, JSON.stringify(value));
  }
  assert.deepEqual(selected, []);
  assert.equal(model.doGenerateCalls.length, 0);
});

test('identify requires a same-origin JSON POST before doing any work', async t => {
  const model = new MockLanguageModelV4({ doGenerate: generated(goodOutput) });
  const url = await serve(t, { languageModel: model });
  assert.equal((await identify(url, body(), { Origin: 'https://other.example' })).status, 403);
  const noOrigin = await fetch(`${url}/api/teeth/identify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body()) });
  assert.equal(noOrigin.status, 403);
  assert.equal((await identify(url, body(), { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await fetch(`${url}/api/teeth/identify`, { headers: { Origin: url } })).status, 405);
  assert.equal(model.doGenerateCalls.length, 0);
});

test('oversized uploads are refused by declared length and by streamed size', async t => {
  const model = new MockLanguageModelV4({ doGenerate: generated(goodOutput) });
  const url = await serve(t, { languageModel: model });
  const declared = await identify(url, 'x'.repeat(MAX_BODY_BYTES + 1));
  assert.equal(declared.status, 413);
  // Streamed uploads have no declared length; a dropped connection is also acceptable once the cap is hit.
  const chunk = Buffer.alloc(1024 * 1024, 0x20);
  const stream = new ReadableStream({ pull(controller) { controller.enqueue(chunk); } });
  const streamed = await fetch(`${url}/api/teeth/identify`, {
    method: 'POST', duplex: 'half', headers: { 'Content-Type': 'application/json', Origin: url }, body: stream,
  }).then(response => response.status, () => 'closed');
  assert.ok(streamed === 413 || streamed === 'closed', String(streamed));
  assert.equal(model.doGenerateCalls.length, 0);
});

test('malformed requests are rejected before the model sees any case data', async t => {
  const model = new MockLanguageModelV4({ doGenerate: generated(goodOutput) });
  const url = await serve(t, { languageModel: model });
  const withFileName = { ...body(), fileName: 'PATIENT.stl' };
  assert.equal((await identify(url, withFileName)).status, 400);
  const notJpeg = body(); notJpeg.views[0].base64 = Buffer.from('\x89PNG\r\n\x1a\nxxxx').toString('base64');
  assert.equal((await identify(url, notJpeg)).status, 400);
  const truncated = body(); truncated.views[0].base64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]).toString('base64');
  assert.equal((await identify(url, truncated)).status, 400);
  const badBase64 = body(); badBase64.views[0].base64 = 'not base64!';
  assert.equal((await identify(url, badBase64)).status, 400);
  const tooManyViews = body(); tooManyViews.views = [...tooManyViews.views, ...tooManyViews.views, tooManyViews.views[0]];
  assert.equal((await identify(url, tooManyViews)).status, 400);
  assert.equal((await identify(url, '{"arch":')).status, 400);
  assert.equal(model.doGenerateCalls.length, 0);
});

test('a valid request sends the manifest and bounded JPEG views to a structured-output model call', async t => {
  const model = new MockLanguageModelV4({ doGenerate: generated(goodOutput) });
  const url = await serve(t, { languageModel: model });
  const response = await identify(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const result = await response.json();
  assert.deepEqual(Object.keys(result).sort(), ['mappings', 'model', 'possibleMissing', 'warnings']);
  assert.equal(result.model, DEFAULT_TOOTH_MODEL);
  assert.deepEqual(result.mappings.map(item => [item.candidateId, item.fdi, item.needsReview]), [[3, 11, false], [7, null, true]]);
  assert.deepEqual(result.possibleMissing, [{ fdi: 12, reason: 'No separate region in this segment.' }]);

  assert.equal(model.doGenerateCalls.length, 1);
  const call = model.doGenerateCalls[0];
  assert.equal(call.responseFormat.type, 'json');
  assert.ok(call.responseFormat.schema);
  const system = call.prompt.filter(message => message.role === 'system').map(message => message.content).join('\n');
  assert.match(system, /Never number teeth by counting regions/);
  assert.match(system, /Do not diagnose/);
  const parts = userParts(call);
  const text = parts.filter(part => part.type === 'text').map(part => part.text).join('\n');
  assert.match(text, /Arch: upper/);
  assert.match(text, /patient's right side is on the image's right side/);
  assert.match(text, /"id":3/);
  assert.match(text, /"warnings":\["open edge"\]/);
  assert.doesNotMatch(text, /Occlusal overview|PATIENT|fileName/);
  const files = parts.filter(part => part.type === 'file');
  assert.equal(files.length, 2);
  assert.ok(files.every(part => part.mediaType === 'image/jpeg'));
  // The SDK wraps file bytes as { type: 'data', data }; unwrap both raw bytes and base64 payloads.
  const payload = part => { const raw = part.data.data ?? part.data; return typeof raw === 'string' ? Buffer.from(raw, 'base64') : Buffer.from(raw); };
  assert.deepEqual(files.map(payload), [VIEW_A, VIEW_B]);
  assert.doesNotMatch(JSON.stringify(call.prompt.filter(message => message.role !== 'system')), /"positions"|"faces"|"normals"/);
});

test('model mappings that break the contract are rejected with a generic message', async t => {
  const bad = { ...goodOutput, mappings: [{ candidateId: 99, fdi: 11, needsReview: false, reason: 'Invented id' }, goodOutput.mappings[1]] };
  const url = await serve(t, { languageModel: new MockLanguageModelV4({ doGenerate: generated(bad) }) });
  const response = await identify(url);
  assert.equal(response.status, 502);
  const error = await response.json();
  assert.match(error.error, /unusable mapping/);
  assert.doesNotMatch(JSON.stringify(error), /99|Invented/);
  const wrongArch = { ...goodOutput, mappings: [{ candidateId: 3, fdi: 36, needsReview: false, reason: 'Lower molar' }, goodOutput.mappings[1]] };
  assert.equal((await identify(await serve(t, { languageModel: new MockLanguageModelV4({ doGenerate: generated(wrongArch) }) }))).status, 502);
});

test('provider failures return a generic error and never log or echo credentials', async t => {
  const model = new MockLanguageModelV4({ doGenerate: async () => { throw new Error('401 invalid x-api-key sk-test-SECRET-123'); } });
  const url = await serve(t, { languageModel: model });
  const logged = [];
  for (const method of ['log', 'warn', 'error', 'info', 'debug']) t.mock.method(console, method, (...args) => { logged.push(args); });
  const response = await identify(url);
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.match(text, /could not complete the request/);
  assert.doesNotMatch(text, /SECRET|x-api-key|401/);
  assert.deepEqual(logged, []);
});

test('a model call that returns no structured output is treated as a failed identification', async t => {
  const url = await serve(t, { languageModel: new MockLanguageModelV4({ doGenerate: { content: [{ type: 'text', text: 'Sure, here are the teeth.' }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] } }) });
  const response = await identify(url);
  assert.equal(response.status, 502);
  assert.doesNotMatch(JSON.stringify(await response.json()), /Sure, here/);
});

test('client disconnect aborts the model call, returns no result, and frees the single slot', async t => {
  let behavior = hang;
  let aborted = false;
  const model = new MockLanguageModelV4({ doGenerate: options => {
    options.abortSignal.addEventListener('abort', () => { aborted = true; }, { once: true });
    return behavior(options);
  } });
  const url = await serve(t, { languageModel: model });
  const controller = new AbortController();
  const pending = identify(url, body(), {}, { signal: controller.signal });
  await until(() => model.doGenerateCalls.length === 1, 'model call started');
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await until(() => aborted, 'server aborted the model call after the client left');
  behavior = () => generated(goodOutput);
  let response;
  await until(async () => { response = await identify(url); return response.status !== 429; }, 'the identification slot was released');
  assert.equal(response.status, 200);
  assert.equal((await response.json()).mappings.length, 2);
});

test('a second identification is refused while the first holds the only slot', async t => {
  let behavior = hang;
  const model = new MockLanguageModelV4({ doGenerate: options => behavior(options) });
  const url = await serve(t, { languageModel: model });
  const controller = new AbortController();
  const first = identify(url, body(), {}, { signal: controller.signal });
  await until(() => model.doGenerateCalls.length === 1, 'first call started');
  const second = await identify(url);
  assert.equal(second.status, 429);
  assert.equal(model.doGenerateCalls.length, 1);
  controller.abort();
  await assert.rejects(first, { name: 'AbortError' });
  behavior = () => generated(goodOutput);
  await until(async () => (await identify(url)).status === 200, 'slot released after abort');
});

test('timeouts answer 504 even when the provider ignores cancellation', async t => {
  const model = new MockLanguageModelV4({ doGenerate: () => new Promise(() => {}) });
  const url = await serve(t, { languageModel: model, requestTimeoutMs: 50 });
  const response = await identify(url);
  assert.equal(response.status, 504);
  assert.match((await response.json()).error, /timed out/);
  // The slot is free again after a timeout, so the next request reaches the provider.
  assert.equal((await identify(url)).status, 504);
  assert.equal(model.doGenerateCalls.length, 2);
});
