import type { TomographyViewSpec } from './tomography-types.ts';
import type { RestorationAssistantEditRequest } from './restoration-assistant.ts';
export interface ChatMessage { role: 'user' | 'assistant'; content: string }
/** Public diagnostics only: never forward provider exception text or request payloads. */
export const ASSISTANT_FAILURES = {
  interrupted: 'The answer was interrupted. Try again.',
  provider: 'The AI response could not be completed. Retry the workflow.',
  authentication: 'Anthropic rejected the server API key. Update ANTHROPIC_API_KEY and restart the local server.',
  'model-access': 'The server account cannot use the selected model. Check model access or select another model.',
  'model-unavailable': 'The selected model is unavailable. Select another model and retry.',
  'rate-limit': 'Anthropic reached a rate limit. Wait a moment and retry.',
  'provider-request': 'Anthropic rejected the request format or inputs. The server integration needs review.',
  'provider-unavailable': 'Anthropic is temporarily unavailable. Wait a moment and retry.',
  'tool-choice': 'The AI response did not match the requested tool selection. This is a tool workflow failure; retry with fresh evidence.',
  'tool-input': 'The AI requested an unavailable tool or invalid tool inputs. No pending edit was applied.',
  'missing-evidence': 'The AI did not read the current restoration measurements. Retry the measurement review.',
  'no-restorations': 'No current restoration concepts are available for measurement review. Generate a concept or review the unresolved case evidence first.',
  timeout: 'The request timed out. Try a shorter question.',
  'ambiguous-action': 'The assistant did not produce one unambiguous successful action. No action was requested.',
  'output-limit': 'The answer reached the output limit and is incomplete. Ask a narrower question.',
  unfinished: 'The answer did not finish normally and is incomplete. Try again.',
  empty: 'No answer was returned. Try a more specific question.',
  request: 'The assistant could not complete the request. Try again.',
} as const;
export type AssistantFailureCode = keyof typeof ASSISTANT_FAILURES;
export const assistantFailureEvent = (code: AssistantFailureCode): Extract<AssistantEvent, { type: 'error' }> =>
  ({ type: 'error', code, message: ASSISTANT_FAILURES[code] });

export type AssistantEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string; name: string; state: 'running' | 'complete' | 'error'; input?: unknown; output?: unknown }
  | { type: 'view-request'; id: string; spec: TomographyViewSpec; round: number; continuationToken?: string; editsUsed?: number }
  | { type: 'edit-request'; id: string; request: RestorationAssistantEditRequest; continuationToken: string; editsUsed: number }
  | { type: 'error'; message: string; code?: AssistantFailureCode }
  | { type: 'done' };

/** Decode records across arbitrary network/UTF-8 chunk boundaries. */
export async function readAssistantEvents(body: ReadableStream<Uint8Array>, onEvent: (event: AssistantEvent) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  function consume(final = false) {
    let end: number;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      if (line.trim()) onEvent(JSON.parse(line) as AssistantEvent);
    }
    if (final && pending.trim()) onEvent(JSON.parse(pending) as AssistantEvent);
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true }); consume();
    }
    pending += decoder.decode(); consume(true);
  } finally { reader.releaseLock(); }
}
