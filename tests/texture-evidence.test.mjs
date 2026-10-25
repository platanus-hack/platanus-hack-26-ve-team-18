import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeTextureEvidence, gingivaColorCue, MAX_TEXTURE_BYTES, MAX_TEXTURE_PIXELS, sampleTextureEvidence, tissueScoresFromColors } from '../src/texture-evidence.ts';

const pixels = {
  width: 2, height: 2,
  // Top row red tissue / ivory; bottom row black atlas padding / neutral ivory.
  data: new Uint8Array([220, 65, 95, 255, 244, 231, 205, 255, 0, 0, 0, 255, 224, 221, 212, 255]),
};
const faceAt = (u, v) => [u, v, u, v, u, v];

test('UVs address top-left image rows with bottom-left UV orientation, retaining seam corners', () => {
  const uvs = new Float32Array([...faceAt(0, 1), ...faceAt(1, 0)]);
  const { colors, tissueScores } = sampleTextureEvidence(uvs, pixels);
  assert.equal(colors.length, 18);
  assert.ok(Math.abs(colors[0] - 0.7156935) < 1e-6, 'sRGB image samples become linear RGB');
  assert.ok(colors[0] > colors[1] * 5);
  assert.ok(colors[9] > 0.7 && colors[10] > 0.7, 'opposite seam corner retains its own UV');
  assert.ok(tissueScores[0] > 0.95);
  assert.equal(tissueScores[1], 0);
  assert.deepEqual([...uvs], [...faceAt(0, 1), ...faceAt(1, 0)]);
});

test('black padding, outside-atlas UVs, NaN UVs, and transparency supply unknown cues', () => {
  for (const uv of [faceAt(0, 0), faceAt(-0.01, 0.5), faceAt(1.01, 0.5), faceAt(NaN, 0.5)]) {
    assert.equal(sampleTextureEvidence(new Float32Array(uv), pixels).tissueScores[0], -1);
  }
  const transparent = { width: 1, height: 1, data: new Uint8Array([220, 65, 95, 0]) };
  assert.equal(sampleTextureEvidence(new Float32Array(faceAt(0.5, 0.5)), transparent).tissueScores[0], -1);
});

test('valid interior and two corners cannot hide one invalid texture sample', () => {
  const red = { width: 2, height: 2, data: new Uint8Array([...Array(4)].flatMap(() => [220, 65, 95, 255])) };
  // The average UV remains inside the red atlas despite the third corner.
  const outside = new Float32Array([0.5, 0.5, 0.5, 0.5, -0.01, 0.5]);
  assert.equal(sampleTextureEvidence(outside, red).tissueScores[0], -1);
  for (const alpha of [0, 255]) {
    const partial = { ...red, data: red.data.slice() };
    partial.data.set(alpha === 0 ? [220, 65, 95, 0] : [0, 0, 0, 255], 0);
    const uv = new Float32Array([0.1, 0.9, 0.9, 0.1, 0.9, 0.1]);
    assert.equal(sampleTextureEvidence(uv, partial).tissueScores[0], -1);
  }
});

test('corner colors and face cues keep exact face order and distinguish red from warm ivory conservatively', () => {
  const { colors, tissueScores } = sampleTextureEvidence(new Float32Array([...faceAt(0.75, 0.75), ...faceAt(0.25, 0.75), ...faceAt(0.25, 0.25)]), pixels);
  assert.deepEqual([...tissueScores], [0, 1, -1]);
  assert.deepEqual([...tissueScoresFromColors(colors)], [0, 1, -1]);
  assert.equal(gingivaColorCue(0, 0, 0), -1);
  assert.equal(gingivaColorCue(NaN, 0.2, 0.3), -1);
  assert.equal(gingivaColorCue(0.85, 0.8, 0.65), 0);
});

test('sampler validates complete triangle UV/RGB arrays and bounded decoded pixels', () => {
  assert.throws(() => sampleTextureEvidence(new Float32Array(2), pixels), /triangle corner/);
  assert.throws(() => tissueScoresFromColors(new Float32Array(3)), /triangle corner/);
  assert.throws(() => sampleTextureEvidence(new Float32Array(6), { ...pixels, data: new Uint8Array(3) }), /Invalid/);
  assert.throws(() => sampleTextureEvidence(new Float32Array(6), { width: MAX_TEXTURE_PIXELS + 1, height: 1, data: new Uint8Array(0) }), /oversized/);
  assert.equal(MAX_TEXTURE_BYTES, 16 * 1024 * 1024);
});

test('Node without image decoding returns no fabricated color evidence', async () => {
  assert.equal(await decodeTextureEvidence(new Uint8Array([1]), 'image/jpeg', new Float32Array(6)), null);
  await assert.rejects(decodeTextureEvidence(new Uint8Array(), 'image/png', new Float32Array(6)), /1 byte and 16 MiB/);
  await assert.rejects(decodeTextureEvidence(new Uint8Array(MAX_TEXTURE_BYTES + 1), 'image/png', new Float32Array(6)), /1 byte and 16 MiB/);
});

test('local pixel decoding closes the bitmap after readback, on canvas failure, and above the decoded pixel cap', async t => {
  let closes = 0;
  const bitmap = { width: 2, height: 2, close() { closes++; } };
  function mockGlobal(name, value) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : delete globalThis[name]);
  }
  mockGlobal('createImageBitmap', async (_blob, options) => {
    assert.equal(options.imageOrientation, 'from-image');
    assert.equal(options.colorSpaceConversion, 'none');
    return bitmap;
  });
  mockGlobal('OffscreenCanvas', class {
    getContext() { return { drawImage() {}, getImageData() { return pixels; } }; }
  });
  const result = await decodeTextureEvidence(new Uint8Array([1]), 'image/png', new Float32Array(faceAt(0.25, 0.75)));
  assert.equal(result.width, 2);
  assert.equal(result.height, 2);
  assert.equal(result.tissueScores[0], 1);
  assert.equal(closes, 1);
  bitmap.width = MAX_TEXTURE_PIXELS + 1;
  await assert.rejects(decodeTextureEvidence(new Uint8Array([1]), 'image/png', new Float32Array(6)), /decoded image limit/);
  assert.equal(closes, 2);
  bitmap.width = 2;
  globalThis.OffscreenCanvas = class { getContext() { return null; } };
  await assert.rejects(decodeTextureEvidence(new Uint8Array([1]), 'image/png', new Float32Array(6)), /unavailable/);
  assert.equal(closes, 3);
});
