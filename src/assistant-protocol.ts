import type { TomographyViewSpec } from './tomography-types.ts';
import type { RestorationAssistantEditRequest } from './restoration-assistant.ts';
export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export type AssistantEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; id: string; name: string; state: 'running' | 'complete' | 'error'; input?: unknown; output?: unknown }
  | { type: 'view-request'; id: string; spec: TomographyViewSpec; round: number; continuationToken?: string; editsUsed?: number }
  | { type: 'edit-request'; id: string; request: RestorationAssistantEditRequest; continuationToken: string; editsUsed: number }
  | { type: 'error'; message: string }
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
