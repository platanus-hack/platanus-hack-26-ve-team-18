import type { AssistantSnapshot } from './assistant-context.ts';
import { ASSISTANT_FAILURES, readAssistantEvents, type AssistantEvent, type AssistantFailureCode } from './assistant-protocol.ts';
import { isAnthropicModelId } from './anthropic-models.ts';
import { reviewSnapshot, type DraftReviewResult } from './draft-review.ts';
import { compactPlanningValue, type PlanningActivity } from './planning-events.ts';
import {
  applyAssistantRestorationEdit, buildRestorationAssistantSnapshot,
  MAX_MEASUREMENT_FOLLOW_UP_EDITS, restorationContinuationSchema, restorationEditRefusalSchema, restorationEditRequestSchema,
  type AssistantRestorationSource, type RestorationAssistantEditRequest,
  type RestorationAssistantEditResult, type RestorationDesign,
} from './restoration-assistant.ts';
import { restorationEditRevision } from './restoration-edit.ts';
import type { RestorationAssembly } from './restoration-types.ts';
import { tomographyEvidenceSchema, type TomographyEvidence } from './tomography-evidence.ts';

export const DRAFT_REFINEMENT_BUDGET = Object.freeze({ edits: MAX_MEASUREMENT_FOLLOW_UP_EDITS, providerRequests: MAX_MEASUREMENT_FOLLOW_UP_EDITS + 1, commitMs: 5000 });

export interface RestorationAgentReviewInput {
  snapshot: AssistantSnapshot;
  /** Current committed scene metadata, including the regenerated component extents. */
  getSnapshot: () => AssistantSnapshot;
  /** Read committed props, not the source object captured when this run started. */
  getSource: () => AssistantRestorationSource | undefined;
  /** Original source buffers/poses, annotations, sharing and registration; excludes generated geometry. */
  getCaseRevision?: () => string;
  model: string;
  tomography?: TomographyEvidence;
  signal: AbortSignal;
  onActivity?: (activity: PlanningActivity) => void;
  /** Pending changes are adjudicated against the exact host result before they are accepted. */
  onEditTransition?: (transition: { pending: boolean; assemblies: readonly RestorationAssembly[] }) => void;
}

export class RestorationAgentReviewError extends Error {
  readonly status: 'incomplete' | 'stale' | 'budget';
  readonly code: string;
  constructor(status: RestorationAgentReviewError['status'], message: string, code: string = status) { super(message); this.status = status; this.code = code; }
}
const incomplete = (detail?: string, code = 'invalid-stream') => new RestorationAgentReviewError('incomplete',
  `The AI measurement follow-up is incomplete.${detail ? ` ${detail}` : ''} Completed geometry is retained.`, code);
function httpFailure(status: number): RestorationAgentReviewError {
  const detail = status === 429 ? 'The assistant is busy or reached a rate limit. Wait a moment and retry.'
    : status === 503 ? 'The assistant is unavailable. Check server configuration and retry.'
      : status === 409 ? 'The continuation expired or no longer matches this case. Start a fresh workflow.'
        : status === 400 ? 'The assistant rejected the case summary. Refresh the workspace and retry.'
          : status === 401 || status === 403 ? 'The assistant denied this request. Check server access and configuration.'
            : `The assistant request failed (HTTP ${status}). Retry the workflow.`;
  return incomplete(detail, `http-${status}`);
}
const stale = () => new RestorationAgentReviewError('stale', 'The case or restoration changed during AI measurement follow-up. Completed geometry is retained; start a fresh workflow.');
const budget = () => new RestorationAgentReviewError('budget', 'The AI measurement follow-up reached its bounded budget without a final review. Completed geometry is retained.');
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = (value: unknown): string => JSON.stringify(value, (_key, entry: unknown) => record(entry)
  ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);

function capture(source: AssistantRestorationSource) {
  const assemblies = [...source.assemblies];
  return { assemblies, snapshot: buildRestorationAssistantSnapshot(assemblies, source.selectedId),
    revisions: assemblies.map(restorationEditRevision), fixedEvidence: assemblies.map(fixedAssemblyEvidence),
    sourceRevision: source.sourceRevision, selectedId: source.selectedId };
}
type SourceState = ReturnType<typeof capture>;
function sameSource(source: AssistantRestorationSource, state: SourceState): boolean {
  return source.sourceRevision === state.sourceRevision && source.selectedId === state.selectedId
    && source.assemblies.length === state.assemblies.length
    && source.assemblies.every((assembly, index) => assembly === state.assemblies[index] && restorationEditRevision(assembly) === state.revisions[index])
    && canonical(buildRestorationAssistantSnapshot(source.assemblies, source.selectedId)) === canonical(state.snapshot);
}

// This also catches case changes for direct callers without a local revision callback.
// Buffer/pose identity is host-owned and must be supplied through sourceRevision/getCaseRevision.
const caseEvidence = (snapshot: AssistantSnapshot) => canonical({
  selectedPartId: snapshot.selectedPartId, selectedFdi: snapshot.selectedFdi,
  teeth: snapshot.teeth, tolerance: snapshot.tolerance, biteFit: snapshot.biteFit,
  parts: snapshot.parts.map(({ dimensions: _dimensions, closed: _closed, triangles: _triangles, vertices: _vertices, ...pose }) => pose),
});

function editableValues(design: RestorationDesign, request?: RestorationAssistantEditRequest): unknown {
  const merge = (before: unknown, patch: unknown): unknown => record(patch)
    ? { ...(record(before) ? before : {}), ...Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, merge(record(before) ? before[key] : undefined, value)])) }
    : typeof patch === 'string' && /^#[a-f0-9]{6}$/i.test(patch) ? patch.toLowerCase() : patch;
  const values = { parameters: design.parameters, anatomy: design.anatomy, contour: design.contour, appearance: design.appearance };
  const { reason: _reason, ...patch } = request?.edit ?? {};
  return merge(merge({}, values), patch);
}

function fixedAssemblyEvidence(assembly: RestorationAssembly): string {
  const spec = assembly.spec;
  return canonical({
    version: spec.version, units: spec.units, source: spec.source, frame: spec.frame, parentPartId: spec.parentPartId,
    fdi: spec.fdi, draftIdentity: spec.draftIdentity, anatomicalSigns: spec.anatomicalSigns, siteEvidence: spec.siteEvidence,
    parts: assembly.parts.map(part => ({ id: part.id, restoration: part.restoration, role: part.role,
      visible: part.visible, offset: part.offset, rotation: part.rotation, pose: part.pose })),
  });
}

const prompt = [
  'Continue the AI design process using the CURRENT measured fixture, abutment/pilar and crown inventory. Read getRestorationDesign before every edit, after every applied or rejected host result, and before the final review. Review ALL component goals, goal.after numeric rows, selectedAttempt, feedback rows, relationships, actual mesh extents and guardrails; missing or stale goals remain unknown.',
  'Address failed REQUIRED per-target contacts, gaps and no-crossing rows first. Shape preferences cannot compensate for a required failure. Propose a justified, bounded parameter/contour/anatomy edit only when current measured evidence supports it; explain expected numeric changes. The existing host no-regression gate decides acceptance and preserves comparisons/history. A queued request is not an applied edit; an applied, unchanged or generated model is not evidence of goal achievement.',
  'You may refine generic local fixture depth ONLY against measured file-unit gingival-envelope goals, pilar dimensions/emergence/slope and crown contacts. The 1.5 mm bone-crest and adjacent-root rules remain UNKNOWN without verified scale/registration and reviewed bone-crest/EACH-root datums. Gingiva, a site origin, a visible gap or an axis cannot substitute. Never prescribe surgical depth/dimensions or edit unsupported clinical unknowns.',
  'At most FOUR requested edits, including failed, duplicate and rejected requests, and FIVE provider requests are available for this follow-up. Request exactly one supported revision per round, wait for the host result, then reread the fresh inventory. After the fourth handoff the fifth provider request MUST end with a final answer and no further handoff. Never repeat unchanged/rejected values without new evidence. Stop earlier when no supported improvement is justified; report remaining failed/unknown rows and evidence needed.',
  'After an applied edit, old aggregate collision reports and rendered images are unavailable; fresh getRestorationDesign component measurements/goals are authoritative. Use only the available read-only evidence and existing requestRestorationEdit tool. Do not request additional views or another kind of continuation.',
  'Report mesh distances in file units; sampled distances are not exact contact area or overlap volume. Distinguish measured facts, design hypotheses, incomplete geometry and CBCT registration uncertainty. Do not diagnose, certify clinical safety, anatomical validity, compatibility or fabrication readiness. Return a concise final review grounded in fresh tools with clinician review requirements and explicit unresolved goals.',
].join('\n');

/** Existing chat continuation, with a maximum of four host attempts plus one final review. */
export async function reviewAndRefineDraft(input: RestorationAgentReviewInput, fetcher: typeof fetch = fetch): Promise<DraftReviewResult> {
  const { signal } = input;
  const checkAbort = () => signal.throwIfAborted();
  checkAbort();
  let expected: SourceState;
  let activeActivity: { id: string; name: string; started: number } | undefined;
  const emit = (activity: PlanningActivity) => input.onActivity?.(activity);
  const begin = (id: string, name: string, value?: unknown) => {
    const started = performance.now();
    emit({ id, name, phase: 'running', ...(value === undefined ? {} : { input: compactPlanningValue(value) }) });
    return { id, name, started };
  };
  const finish = (activity: { id: string; name: string; started: number }, phase: 'complete' | 'error', output: unknown) =>
    emit({ id: activity.id, name: activity.name, phase, output: compactPlanningValue(output), durationMs: Math.max(0, performance.now() - activity.started) });
  try {
    const initialSource = input.getSource();
    if (!initialSource) throw stale();
    if (!initialSource.assemblies.length) throw new RestorationAgentReviewError('incomplete', ASSISTANT_FAILURES['no-restorations'], 'no-restorations');
    expected = capture(initialSource);
    const initialCaseRevision = input.getCaseRevision?.();
    const initialSnapshot = reviewSnapshot(input.snapshot);
    const initialCaseEvidence = caseEvidence(initialSnapshot);
    const assertExternal = () => {
      checkAbort();
      const source = input.getSource();
      if (!source || source.sourceRevision !== expected.sourceRevision || source.selectedId !== expected.selectedId
        || input.getCaseRevision?.() !== initialCaseRevision
        || caseEvidence(reviewSnapshot(input.getSnapshot())) !== initialCaseEvidence) throw stale();
      return source;
    };
    const assertCurrent = () => { const source = assertExternal(); if (!sameSource(source, expected)) throw stale(); return source; };
    let tomography = input.tomography === undefined ? undefined : tomographyEvidenceSchema.parse(input.tomography);
    if (tomography) tomography.canRequestViews = false;
    let continuation: ReturnType<typeof restorationContinuationSchema.parse> | undefined;
    let editsUsed = 0, invalidateCollision = false, actualModel = input.model;
    // Compare resulting editable values, not JSON patch spelling, empty groups or reasons.
    // Include initial values so cycling back to a previously seen design is also bounded out.
    const seenEdits = new Set(expected.snapshot.assemblies.map((design, i) => `${expected.assemblies[i].id}:${canonical(editableValues(design))}`));
    const usedTokens = new Set<string>();
    const tools = new Map<string, { name: string; state: string }>();
    const messages = [{ role: 'user', content: prompt }]; // Must remain identical for one-use server continuations.
    for (let round = 1; round <= DRAFT_REFINEMENT_BUDGET.providerRequests; round++) {
      assertCurrent();
      let snapshot = reviewSnapshot(input.getSnapshot());
      if (invalidateCollision) snapshot = reviewSnapshot({ ...snapshot, collision: null, analysisState: 'unavailable', probe: null });
      activeActivity = begin(`draft-review:${round}:provider`, 'reviewMeasuredRestoration', { request: round, maxRequests: 5, requestedEdits: editsUsed, maxEdits: 4, model: input.model });
      let response: Response | undefined, stream: ReadableStream<Uint8Array> | undefined;
      let terminal: Extract<AssistantEvent, { type: 'done' | 'edit-request' }> | undefined;
      let text = '', eventCount = 0;
      const roundTools = new Map<string, { name: string; state: string; input?: unknown; started: number }>();
      const requested = new Map<string, RestorationAssistantEditRequest>();
      try {
        response = await fetcher('/api/assistant/chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
          body: JSON.stringify({ snapshot, messages,
            ...(isAnthropicModelId(input.model) ? { model: input.model } : {}),
            restoration: { snapshot: expected.snapshot, allowEdits: true, mode: 'measurement-follow-up', ...(continuation ? { continuation } : {}) },
            ...(tomography ? { tomography } : {}),
          }),
        });
        assertCurrent();
        if (!response.ok) throw httpFailure(response.status);
        if (!response.body || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/x-ndjson')
          throw incomplete('The assistant API returned an unexpected response. Refresh the workspace and retry.', 'unexpected-response');
        actualModel = response.headers.get('X-Assistant-Model')?.trim() || actualModel;
        // readAssistantEvents is shared with chat. Add strict newline/UTF-8/size framing here:
        // a truncated final JSON record must never authorize a host mutation.
        let bytes = 0, lineBytes = 0;
        const decoder = new TextDecoder('utf-8', { fatal: true });
        stream = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            bytes += chunk.byteLength;
            if (bytes > 4 * 1024 * 1024) throw incomplete();
            decoder.decode(chunk, { stream: true });
            for (const byte of chunk) { if (byte === 10) lineBytes = 0; else if (++lineBytes > 1024 * 1024) throw incomplete(); }
            controller.enqueue(chunk);
          },
          flush() { decoder.decode(); if (lineBytes) throw incomplete(); },
        }), { signal });
        await readAssistantEvents(stream, event => {
          assertCurrent();
          // Token-sized text deltas are transport fragments, not additional tool work.
          // Text and total stream bytes remain bounded independently of this control limit.
          if (!record(event) || terminal || event.type !== 'text' && ++eventCount > 128) throw incomplete();
          if (event.type === 'text') {
            if (typeof event.text !== 'string' || text.length + event.text.length > 16000) throw incomplete();
            text += event.text;
          } else if (event.type === 'tool') {
            if (typeof event.id !== 'string' || !event.id || event.id.length > 128
              || typeof event.name !== 'string' || !event.name.trim() || event.name.length > 128
              || !['running', 'complete', 'error'].includes(event.state) || roundTools.size >= 64 && !roundTools.has(event.id)) throw incomplete();
            const previous = roundTools.get(event.id);
            if (previous && (previous.name !== event.name || previous.state === 'complete' || event.state === 'running')) throw incomplete();
            const started = previous?.started ?? performance.now();
            const toolInput = event.input ?? previous?.input;
            roundTools.set(event.id, { name: event.name, state: event.state, input: toolInput, started });
            tools.set(`${round}:${event.id}`, { name: event.name, state: event.state });
            emit({ id: `draft-review:${round}:tool:${event.id}`, name: event.name, phase: event.state,
              ...(toolInput === undefined ? {} : { input: compactPlanningValue(toolInput) }),
              ...(event.output === undefined ? {} : { output: compactPlanningValue(event.output) }),
              ...(event.state !== 'running' ? { durationMs: Math.max(0, performance.now() - started) } : {}),
            });
            if (event.state === 'error') throw incomplete('A case-evidence tool failed. Review its recorded inputs and retry the workflow.', 'tool-error');
            if (event.name === 'requestRestorationEdit' && event.state === 'complete') {
              const output = event.output;
              // A validated tool refusal is evidence for the model to resolve, not a host handoff.
              if (restorationEditRefusalSchema.safeParse(output).success) return;
              if (!record(output) || output.status !== 'requested' || output.applied !== false
                || Object.keys(output).some(key => !['status', 'request', 'applied'].includes(key))) throw incomplete();
              const action = restorationEditRequestSchema.parse(output.request);
              if (toolInput !== undefined && canonical(restorationEditRequestSchema.parse(toolInput)) !== canonical(action)) throw incomplete();
              requested.set(event.id, action);
            }
          } else if (event.type === 'edit-request') {
            const action = restorationEditRequestSchema.parse(event.request);
            restorationContinuationSchema.parse({ token: event.continuationToken });
            if (requested.size !== 1 || canonical(requested.get(event.id)) !== canonical(action)
              || event.editsUsed !== editsUsed + 1 || usedTokens.has(event.continuationToken)) throw incomplete();
            terminal = { ...event, request: action };
          } else if (event.type === 'done') {
            if (requested.size || !text.trim() || Object.keys(event).some(key => key !== 'type')) throw incomplete();
            terminal = event;
          } else if (event.type === 'error') {
            // Accept only shared public codes; provider messages can contain private payloads.
            if (typeof event.code !== 'string' || !Object.hasOwn(ASSISTANT_FAILURES, event.code)) throw incomplete();
            throw incomplete(ASSISTANT_FAILURES[event.code as AssistantFailureCode], event.code);
          } else throw incomplete();
        });
        assertCurrent();
        if (!terminal || [...roundTools.values()].some(tool => tool.state !== 'complete')) throw incomplete();
      } finally { await (stream ?? response?.body)?.cancel().catch(() => {}); }
      finish(activeActivity, 'complete', { status: terminal.type === 'done' ? 'done' : 'edit-queued', model: actualModel });
      activeActivity = undefined;
      if (terminal.type === 'done') {
        assertCurrent();
        return { text: text.trim(), model: actualModel, completedAt: new Date().toISOString(), tools: [...tools.values()] };
      }
      if (editsUsed >= DRAFT_REFINEMENT_BUDGET.edits || round === DRAFT_REFINEMENT_BUDGET.providerRequests) throw budget();
      const action = terminal.request;
      const index = expected.snapshot.assemblies.findIndex(assembly => assembly.id === action.assemblyId);
      const before = expected.snapshot.assemblies[index];
      if (!before || before.stale || before.editRevision !== action.expectedRevision) throw stale();
      editsUsed = terminal.editsUsed; usedTokens.add(terminal.continuationToken);
      const editKey = `${expected.assemblies[index].id}:${canonical(editableValues(before, action))}`;
      activeActivity = begin(`draft-review:${round}:host`, 'applyAndMeasureRestorationEdit', action);
      let result: RestorationAssistantEditResult;
      if (seenEdits.has(editKey)) {
        result = { status: 'error', request: action, before, code: 'invalid', message: 'Duplicate or unchanged values were not applied. Read fresh measurements and propose a different justified change, or finish.' };
      } else {
        seenEdits.add(editKey);
        const source = assertCurrent();
        const beforeState = expected;
        input.onEditTransition?.({ pending: true, assemblies: beforeState.assemblies });
        // Use the latest host callback, while capturing the immutable inventory this edit is bound to.
        const outcome = await applyAssistantRestorationEdit({ ...source, assemblies: [...beforeState.assemblies], applyEdit: (...args) => {
          const current = assertCurrent();
          return current.applyEdit(...args);
        } }, action, signal);
        assertExternal();
        result = outcome.result;
        if (result.status === 'applied') {
          if (!outcome.assembly) throw incomplete();
          if (result.after.stale || fixedAssemblyEvidence(outcome.assembly) !== beforeState.fixedEvidence[index]
            || canonical(editableValues(result.after)) !== canonical(editableValues(before, action))) throw stale();
          const assemblies = beforeState.assemblies.map((assembly, i) => i === index ? outcome.assembly! : assembly);
          const after = result.after;
          // Keep other assemblies' frozen revisions, even if a host accidentally mutates an
          // object in place while the target worker is pending. Only the returned target changes.
          const next: SourceState = { ...beforeState, assemblies,
            snapshot: { ...beforeState.snapshot, assemblies: beforeState.snapshot.assemblies.map((design, i) => i === index ? after : design) },
            revisions: beforeState.revisions.map((revision, i) => i === index ? restorationEditRevision(outcome.assembly!) : revision),
            fixedEvidence: beforeState.fixedEvidence,
          };
          const deadline = performance.now() + DRAFT_REFINEMENT_BUDGET.commitMs;
          // Hook promises resolve before committed React props. Only before -> exact returned after is legal.
          while (true) {
            const current = assertExternal();
            if (sameSource(current, next)) break;
            if (!sameSource(current, beforeState) || performance.now() >= deadline) throw stale();
            await new Promise<void>((resolve, reject) => {
              const abort = () => { clearTimeout(timer); reject(signal.reason); };
              const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 16);
              signal.addEventListener('abort', abort, { once: true });
              if (signal.aborted) { signal.removeEventListener('abort', abort); abort(); }
            });
          }
          expected = next;
          invalidateCollision = true;
          tomography = undefined; // Captures may contain old generated geometry. Never reuse them after an edit.
        } else { assertCurrent(); if (result.code === 'stale') throw stale(); }
        input.onEditTransition?.({ pending: false, assemblies: expected.assemblies });
      }
      assertCurrent();
      continuation = restorationContinuationSchema.parse({ token: terminal.continuationToken, result });
      finish(activeActivity, result.status === 'applied' ? 'complete' : 'error', {
        status: result.status, ...(result.status === 'error' ? { code: result.code, message: result.message } : {}),
        beforeRevision: result.before.editRevision, request: result.request,
        ...(result.status === 'applied' ? { after: result.after, changes: result.changes, failureFeedback: result.failureFeedback }
          : { rejectedCandidate: result.rejectedCandidate }),
      });
      activeActivity = undefined;
    }
    throw budget();
  } catch (cause) {
    const failure = cause instanceof RestorationAgentReviewError ? cause : incomplete();
    const error = signal.aborted ? signal.reason : failure;
    const output = signal.aborted ? { status: 'cancelled', code: 'cancelled', message: 'AI measurement follow-up stopped. Completed geometry is retained.' }
      : { status: failure.status, code: failure.code, message: failure.message };
    if (activeActivity) finish(activeActivity, 'error', output);
    emit({ id: 'draft-review:incomplete', name: 'measurementFollowUp', phase: 'error', output });
    throw error;
  }
}
