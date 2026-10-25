export interface PlanningActivity {
  id: string;
  name: string;
  phase: 'running' | 'complete' | 'error';
  input?: unknown;
  output?: unknown;
  durationMs?: number;
  origin?: 'structured-command';
}

export type PlanningEvent =
  | { type: 'started'; revision: string; model: string }
  | { type: 'tool'; activity: PlanningActivity }
  | { type: 'result'; result: unknown }
  | { type: 'error'; error: string };

export const MAX_PLANNING_EVENT_BYTES = 1024 * 1024;
export const MAX_PLANNING_EVENTS = 200;
const MAX_SUMMARY_CHARS = 6000;

/** Trace evidence and construction controls, without documents, images or patient arrays. */
export function compactPlanningValue(value: unknown): unknown {
  const seen = new WeakSet<object>();
  let remaining = 160;
  const visit = (entry: unknown, depth: number, previewArray = false): unknown => {
    if (--remaining < 0) return { truncated: true };
    if (entry === null || entry === undefined) return null;
    if (typeof entry === 'string') return /^data:/i.test(entry) ? { omitted: 'image/data' } : entry.length > 400 ? `${entry.slice(0, 399)}…` : entry;
    if (typeof entry === 'number') return Number.isFinite(entry) ? entry : null;
    if (typeof entry === 'boolean') return entry;
    if (Array.isArray(entry)) return { type: 'array', count: entry.length, ...(previewArray ? { items: entry.slice(0, 6).map(item => visit(item, depth + 1)), ...(entry.length > 6 ? { truncated: true } : {}) } : {}) };
    if (ArrayBuffer.isView(entry) || entry instanceof ArrayBuffer) return { type: 'buffer', byteLength: entry.byteLength };
    if (typeof entry !== 'object') return { omitted: typeof entry };
    if (seen.has(entry)) return { omitted: 'circular' };
    if (depth >= 6) return { truncated: true };
    seen.add(entry);
    const keys = Object.keys(entry);
    const result: Record<string, unknown> = {};
    for (const key of keys.slice(0, 24)) {
      // Keys can come from future catalog tools; never preview their raw payloads.
      const raw = /^(content|document|documents|text|base64|dataUrl|data|image|images|geometry|mesh|meshes|positions|normals|vertices|indices|voxels|reasoning|thinking)$/i.test(key);
      const item = (entry as Record<string, unknown>)[key];
      Object.defineProperty(result, key.slice(0, 100), { enumerable: true, configurable: true, value: raw
        ? { omitted: 'payload', ...(typeof item === 'string' ? { characters: item.length } : {}) }
        : visit(item, depth + 1, /^(reviews|regionReviews|siteReviews|clinicalRules|evidence|missingEvidence|flags|blockingReasons|assemblies|feedbackRows|rows|criteria|revisions|changes|attempts|relationships|limits)$/i.test(key)) });
    }
    if (keys.length > 24) result.truncated = true;
    return result;
  };
  const compact = visit(value, 0);
  const encoded = JSON.stringify(compact);
  // Re-encoding this bounded JSON prefix can at most double its length.
  return encoded.length <= MAX_SUMMARY_CHARS ? compact : { truncated: true, summary: encoded.slice(0, 2800) };
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const boundedString = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
function parseEvent(value: unknown): PlanningEvent {
  if (record(value)) {
    if (value.type === 'started' && boundedString(value.revision, 160) && boundedString(value.model, 160)) return { type: 'started', revision: value.revision, model: value.model };
    if (value.type === 'result' && Object.hasOwn(value, 'result') && value.result !== null) return { type: 'result', result: value.result };
    if (value.type === 'error' && boundedString(value.error, 4000)) return { type: 'error', error: value.error };
    if (value.type === 'tool' && record(value.activity)) {
      const activity = value.activity;
      if (boundedString(activity.id, 512) && boundedString(activity.name, 100)
        && (activity.phase === 'running' || activity.phase === 'complete' || activity.phase === 'error')
        && (activity.durationMs === undefined || typeof activity.durationMs === 'number' && Number.isFinite(activity.durationMs) && activity.durationMs >= 0)) {
        return { type: 'tool', activity: { id: activity.id, name: activity.name, phase: activity.phase,
          ...(Object.hasOwn(activity, 'input') ? { input: activity.input } : {}),
          ...(Object.hasOwn(activity, 'output') ? { output: activity.output } : {}),
          ...(activity.durationMs !== undefined ? { durationMs: activity.durationMs } : {}),
          ...(activity.origin === 'structured-command' ? { origin: activity.origin } : {}) } };
      }
    }
  }
  throw new Error('Invalid planning event. Retry the assessment.');
}

/** Only a complete, newline-delimited terminal result is returned; progress remains live. */
export async function readPlanningEvents(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: PlanningEvent) => void,
  signal?: AbortSignal,
): Promise<unknown> {
  const reader = stream.getReader();
  const line = new Uint8Array(MAX_PLANNING_EVENT_BYTES);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0, count = 0, started = false, complete = false;
  let terminal: Extract<PlanningEvent, { type: 'result' | 'error' }> | undefined;
  const abortError = () => signal?.reason ?? new DOMException('Planning cancelled.', 'AbortError');
  const abort = () => { void reader.cancel(abortError()).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    while (true) {
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      for (let offset = 0; offset < value.length;) {
        const newline = value.indexOf(10, offset);
        const end = newline < 0 ? value.length : newline;
        if (size + end - offset > line.length) throw new Error('Planning event exceeds the 1 MiB limit.');
        line.set(value.subarray(offset, end), size); size += end - offset;
        offset = end + 1;
        if (newline < 0) continue;
        if (size && line[size - 1] === 13) size--;
        if (!size) continue;
        if (++count > MAX_PLANNING_EVENTS) throw new Error('Planning stream exceeds the 200-event limit.');
        let decoded: unknown;
        try { decoded = JSON.parse(decoder.decode(line.subarray(0, size))) as unknown; }
        catch { throw new Error('Invalid planning event. Retry the assessment.'); }
        size = 0;
        const event = parseEvent(decoded);
        if (terminal) throw new Error('Planning stream continued after its final event.');
        if (!started) {
          if (event.type !== 'started') throw new Error('Planning stream is missing its start event.');
          started = true;
        } else if (event.type === 'started') throw new Error('Planning stream started more than once.');
        if (event.type === 'result' || event.type === 'error') terminal = event;
        else onEvent(event);
        signal?.throwIfAborted();
      }
    }
    if (size || !terminal) throw new Error('Planning stream ended before a complete result. Retry the assessment.');
    // Wait for EOF so a duplicate result, trailing garbage or disconnect cannot apply a partial plan.
    onEvent(terminal);
    signal?.throwIfAborted();
    if (terminal.type === 'error') throw new Error(terminal.error);
    complete = true;
    return terminal.result;
  } finally {
    signal?.removeEventListener('abort', abort);
    if (!complete) void reader.cancel(signal?.aborted ? abortError() : undefined).catch(() => {});
    reader.releaseLock();
  }
}
