import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANTHROPIC_MODELS,
  DEFAULT_ASSISTANT_MODEL,
  DEFAULT_IDENTIFICATION_MODEL,
  anthropicModelIdSchema,
  isAnthropicModelId,
} from '../src/anthropic-models.ts';

test('the shared catalog exposes the three supported models and workflow defaults', () => {
  assert.deepEqual(ANTHROPIC_MODELS, [
    { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
    { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  ]);
  assert.equal(DEFAULT_ASSISTANT_MODEL, 'claude-sonnet-5-5');
  assert.equal(DEFAULT_IDENTIFICATION_MODEL, 'claude-haiku-5-5');
  for (const { id } of ANTHROPIC_MODELS) {
    assert.equal(anthropicModelIdSchema.parse(id), id);
    assert.equal(isAnthropicModelId(id), true);
  }
});

test('model input accepts exact catalog ids without coercion or arbitrary model configuration', () => {
  for (const value of [undefined, null, 3, true, false, {}, { id: DEFAULT_ASSISTANT_MODEL }, [DEFAULT_ASSISTANT_MODEL], '', 'sonnet', 'claude-test', 'claude-opus-5-5 ', 'CLAUDE-OPUS-5-5']) {
    assert.equal(anthropicModelIdSchema.safeParse(value).success, false, JSON.stringify(value));
    assert.equal(isAnthropicModelId(value), false, JSON.stringify(value));
  }
});
