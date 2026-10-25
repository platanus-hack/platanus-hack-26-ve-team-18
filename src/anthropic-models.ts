import { z } from 'zod';

/** Models available for explicit selection in the local AI workflows. */
export const ANTHROPIC_MODELS = [
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
] as const;

export type AnthropicModelId = typeof ANTHROPIC_MODELS[number]['id'];
export const DEFAULT_ASSISTANT_MODEL = 'claude-sonnet-5-5' satisfies AnthropicModelId;
export const DEFAULT_IDENTIFICATION_MODEL = 'claude-haiku-5-5' satisfies AnthropicModelId;
export const anthropicModelIdSchema = z.enum(ANTHROPIC_MODELS.map(model => model.id));

export function isAnthropicModelId(value: unknown): value is AnthropicModelId {
  return anthropicModelIdSchema.safeParse(value).success;
}
