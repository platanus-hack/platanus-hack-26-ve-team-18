import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { assistantToolCatalog, buildAssistantSnapshot } from './assistant-context';
import { readAssistantEvents, type AssistantEvent, type ChatMessage } from './assistant-protocol';
import { ANTHROPIC_MODELS, DEFAULT_ASSISTANT_MODEL, isAnthropicModelId } from './anthropic-models';
import { AnthropicModelSelect } from './AnthropicModelSelect';
import { partMatrix } from './pose';
import { captureRequestedTomographyView, MAX_TOMOGRAPHY_ROUNDS, prepareTomographyEvidence, tomographyContinuationSchema, tomographyViewSpecSchema, type AssistantTomographySource, type TomographyContinuation, type TomographyEvidence } from './tomography-evidence';
export type { AssistantTomographySource } from './tomography-evidence';
import { applyAssistantRestorationEdit, buildRestorationAssistantSnapshot, MAX_ASSISTANT_EDITS, restorationContinuationSchema, restorationEditRequestSchema, type AssistantRestorationSource, type RestorationAssistantEditResult } from './restoration-assistant';
export type { AssistantRestorationSource } from './restoration-assistant';
import './assistant-panel.css';

type ToolEvent = Extract<AssistantEvent, { type: 'tool' }>;
interface Entry extends ChatMessage { id: string; tools: ToolEvent[]; edits?: RestorationAssistantEditResult[]; model?: string; state: 'pending' | 'complete' | 'stopped' | 'error' }
export interface AssistantPanelProps { context: Omit<Parameters<typeof buildAssistantSnapshot>[0], 'includeNotes'>; tomography?: AssistantTomographySource; restoration?: AssistantRestorationSource }
const modelLabel = (id: string) => ANTHROPIC_MODELS.find(model => model.id === id)?.label ?? id;

export function AssistantPanel({ context, tomography, restoration }: AssistantPanelProps) {
  const [enabled, setEnabled] = useState(false);
  const [includeNotes, setIncludeNotes] = useState(false);
  const [includeImages, setIncludeImages] = useState(false);
  const [allowAgentEdits, setAllowAgentEdits] = useState(false);
  const [evidence, setEvidence] = useState<TomographyEvidence>();
  const [captureBusy, setCaptureBusy] = useState(false);
  const [captureError, setCaptureError] = useState('');
  const [previewVersion, setPreviewVersion] = useState(0);
  const tomographyRef = useRef(tomography); tomographyRef.current = tomography;
  const previewRequest = useRef<AbortController | null>(null);
  const [configuration, setConfiguration] = useState<{ configured: boolean; model: string } | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_ASSISTANT_MODEL);
  const modelChosen = useRef(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const request = useRef<AbortController | null>(null);
  const entriesRef = useRef(entries); entriesRef.current = entries;
  // Build the small summary only while the user has opened the optional assistant.
  const snapshot = useMemo(() => enabled ? buildAssistantSnapshot({ ...context, includeNotes }) : null, [enabled, context, includeNotes]);
  const restorationSnapshot = useMemo(() => enabled && restoration ? buildRestorationAssistantSnapshot(restoration.assemblies, restoration.selectedId) : undefined, [enabled, restoration?.assemblies, restoration?.selectedId]);
  const restorationKey = JSON.stringify(restorationSnapshot);
  const bufferIds = useRef(new WeakMap<object, number>()), nextBufferId = useRef(0);
  const bufferId = (buffer?: object) => { if (!buffer) return 0; let id = bufferIds.current.get(buffer); if (!id) { id = ++nextBufferId.current; bufferIds.current.set(buffer, id); } return id; };
  // External sources/controls are independent of agent-created geometry and passive collision completion.
  const workspaceKey = JSON.stringify([enabled, includeNotes, includeImages, allowAgentEdits, previewVersion, restoration?.sourceRevision ?? tomography?.revision, restoration?.selectedId ?? null,
    context.parts.filter(part => !part.restoration).map(part => [part.id, bufferId(part.positions), bufferId(part.normals), bufferId(part.colors), bufferId(part.texture?.bytes), part.dimensions, part.role, part.visible, part.pose, part.offset, part.rotation]),
    context.parts.filter(part => part.restoration).map(part => [part.id, part.visible, partMatrix(part).toArray()]),
    context.selected, context.selectedFdi, context.teeth, context.counts, context.tolerance, context.fitSummary, context.fitRadius]);
  const live = useRef({ context, restoration, restorationSnapshot, restorationKey, workspaceKey });
  live.current = { context, restoration, restorationSnapshot, restorationKey, workspaceKey };
  const editFence = useRef<{ controller: AbortController; before: string | undefined; after?: string; pending: boolean } | null>(null);
  const acceptedRestorationKey = useRef(restorationKey);
  function clearStaleConversation() {
    request.current?.abort(); request.current = null; setBusy(false); setError('');
    editFence.current = null;
    if (entriesRef.current.length) { setEntries([]); setNotice('Workspace or sharing settings changed. The previous conversation was cleared; your next question will use the current evidence.'); }
  }
  useLayoutEffect(() => { clearStaleConversation(); acceptedRestorationKey.current = restorationKey; }, [workspaceKey]);
  useLayoutEffect(() => {
    if (restorationKey === acceptedRestorationKey.current) return;
    const fence = editFence.current;
    if (fence?.controller === request.current && fence.pending) return; // adjudicated against the exact returned assembly before continuation
    if (fence?.controller === request.current && restorationKey === fence.after) { acceptedRestorationKey.current = restorationKey; return; }
    clearStaleConversation(); acceptedRestorationKey.current = restorationKey;
  }, [restorationKey]);
  useEffect(() => {
    const controller = new AbortController(); previewRequest.current = controller;
    setEvidence(undefined); setCaptureError('');
    if (request.current) { setCaptureBusy(false); return () => controller.abort(); }
    if (!enabled || !includeImages || !tomographyRef.current) { setCaptureBusy(false); return () => controller.abort(); }
    setCaptureBusy(true);
    void prepareTomographyEvidence(tomographyRef.current, true, controller.signal).then(next => {
      if (!controller.signal.aborted) setEvidence(next);
    }).catch(() => {
      if (!controller.signal.aborted) setCaptureError('The local image previews could not be prepared. Review the tomography view and try sharing again.');
    }).finally(() => { if (!controller.signal.aborted) setCaptureBusy(false); });
    return () => controller.abort();
  }, [workspaceKey, restorationKey, tomography?.revision]);
  useEffect(() => () => { request.current?.abort(); previewRequest.current?.abort(); }, []);

  async function checkConfiguration() {
    setError('');
    try {
      const response = await fetch('/api/assistant/status');
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error();
      const status = await response.json();
      if (typeof status.configured !== 'boolean' || typeof status.model !== 'string') throw new Error();
      setConfiguration(status);
      if (!modelChosen.current) setSelectedModel(status.model);
    } catch { setConfiguration(null); setError('The assistant API is unavailable. Run this workspace with pnpm dev or pnpm preview.'); }
  }
  useEffect(() => { if (enabled) void checkConfiguration(); }, [enabled]);

  function stop() {
    request.current?.abort(); request.current = null; setBusy(false);
    setEntries(items => items.map(item => item.state === 'pending' ? { ...item, state: 'stopped' } : item));
    setNotice('Request stopped. Any partial answer is incomplete.');
  }

  async function ask(event: FormEvent) {
    event.preventDefault();
    const content = question.trim();
    if (!content || busy || captureBusy || restoration?.busy || (includeImages && tomography && !evidence) || !snapshot || !configuration?.configured) return;
    const controller = new AbortController(); request.current = controller;
    const sourceKey = workspaceKey;
    let expectedRestorationKey = restorationKey;
    const assertCurrent = (allowPending = false) => {
      controller.signal.throwIfAborted();
      if (request.current !== controller || live.current.workspaceKey !== sourceKey
        || (!allowPending && live.current.restorationKey !== expectedRestorationKey)) {
        controller.abort(); throw new DOMException('Workspace changed.', 'AbortError');
      }
    };
    const user: Entry = { id: crypto.randomUUID(), role: 'user', content, tools: [], state: 'complete' };
    const assistant: Entry = { id: crypto.randomUUID(), role: 'assistant', content: '', tools: [], model: selectedModel, state: 'pending' };
    const messages = [...entries.filter(item => item.state === 'complete' && item.content.trim()), user].slice(-19).map(({ role, content }) => ({ role, content: content.slice(0, 8000) }));
    setEntries(items => [...items, user, assistant]); setQuestion(''); setBusy(true); setError(''); setNotice('');
    const update = (change: (entry: Entry) => Entry) => { if (request.current === controller) setEntries(items => items.map(item => item.id === assistant.id ? change(item) : item)); };
    try {
      let currentEvidence = includeImages ? evidence : undefined;
      let continuation: TomographyContinuation | undefined;
      let restorationContinuation: ReturnType<typeof restorationContinuationSchema.parse> | undefined;
      let partialAnalysis = '', viewRound = 0, editsUsed = 0, invalidateCollision = false;
      const appliedRequests = new Set<string>();
      // A question may alternate edits and views; neither continuation resets the other's budget.
      for (let turn = 0; turn <= MAX_TOMOGRAPHY_ROUNDS + MAX_ASSISTANT_EDITS; turn++) {
        assertCurrent();
        let complete = false, streamError = false;
        let viewRequest: Extract<AssistantEvent, { type: 'view-request' }> | undefined;
        let editRequest: Extract<AssistantEvent, { type: 'edit-request' }> | undefined;
        const validatedEdits = new Map<string, unknown>();
        const freshSnapshot = buildAssistantSnapshot({ ...live.current.context, includeNotes,
          ...(invalidateCollision ? { report: null, analysisState: 'unavailable' as const } : {}) });
        const response = await fetch('/api/assistant/chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages, snapshot: freshSnapshot,
            ...(live.current.restorationSnapshot ? { restoration: { snapshot: live.current.restorationSnapshot, allowEdits: allowAgentEdits, ...(restorationContinuation ? { continuation: restorationContinuation } : {}) } } : {}),
            ...(currentEvidence ? { tomography: currentEvidence } : {}), ...(continuation ? { continuation } : {}), ...(isAnthropicModelId(selectedModel) ? { model: selectedModel } : {}) }), signal: controller.signal,
        });
        if (!response.ok) throw new Error('The assistant could not start.');
        if (!response.body || !response.headers.get('content-type')?.includes('application/x-ndjson')) throw new Error('The assistant API returned an unexpected response.');
        const actualModel = response.headers.get('X-Assistant-Model');
        if (actualModel) update(item => ({ ...item, model: actualModel }));
        await readAssistantEvents(response.body, event => {
          if (request.current !== controller || controller.signal.aborted) return;
          if (viewRequest || editRequest || complete) { streamError = true; return; }
          if (event.type === 'text') { partialAnalysis = (partialAnalysis + event.text).slice(-8000); update(item => ({ ...item, content: item.content + event.text })); }
          if (event.type === 'tool') {
            if (event.name === 'requestRestorationEdit' && event.state === 'complete') {
              const output = event.output as { status?: string; request?: unknown; applied?: unknown } | undefined;
              if (output?.status === 'requested' && output.applied === false && restorationEditRequestSchema.safeParse(output.request).success) validatedEdits.set(event.id, output.request);
            }
            update(item => {
              const existing = item.tools.find(tool => tool.id === event.id), next = { ...existing, ...event };
              return { ...item, tools: existing ? item.tools.map(tool => tool.id === event.id ? next : tool) : [...item.tools, next] };
            });
          }
          if (event.type === 'view-request') {
            if (event.round !== viewRound + 1 || event.round > MAX_TOMOGRAPHY_ROUNDS || !tomographyViewSpecSchema.safeParse(event.spec).success
              || (allowAgentEdits && (!event.continuationToken || event.editsUsed !== editsUsed))) { streamError = true; return; }
            viewRequest = event;
          }
          if (event.type === 'edit-request') {
            if (!allowAgentEdits || !live.current.restoration || editsUsed >= MAX_ASSISTANT_EDITS || event.editsUsed !== editsUsed + 1
              || !restorationEditRequestSchema.safeParse(event.request).success || !restorationContinuationSchema.safeParse({ token: event.continuationToken }).success
              || JSON.stringify(validatedEdits.get(event.id)) !== JSON.stringify(event.request)) { streamError = true; return; }
            editRequest = event;
          }
          if (event.type === 'error') { streamError = true; setError('The assistant did not complete this answer. No pending edit was applied.'); update(item => ({ ...item, state: 'error' })); }
          if (event.type === 'done') complete = true;
        });
        assertCurrent();
        if (streamError) { setError('The assistant returned an incomplete or invalid handoff. No pending edit was applied.'); update(item => ({ ...item, state: 'error' })); return; }
        if (editRequest) {
          const requested = editRequest as Extract<AssistantEvent, { type: 'edit-request' }>;
          const { reason: _reason, ...changes } = requested.request.edit;
          const actionKey = `${requested.request.assemblyId}:${requested.request.expectedRevision}:${JSON.stringify(changes)}`;
          if (appliedRequests.has(actionKey)) throw new Error('Duplicate restoration edit.');
          appliedRequests.add(actionKey); editsUsed = requested.editsUsed;
          setNotice(`Applying local revision ${editsUsed}/${MAX_ASSISTANT_EDITS} to ${requested.request.assemblyId}…`);
          const originalSource = live.current.restoration!;
          const beforeAssemblies = originalSource.assemblies;
          const fence = { controller, before: expectedRestorationKey, after: undefined as string | undefined, pending: true };
          editFence.current = fence;
          const outcome = await applyAssistantRestorationEdit({ ...originalSource, applyEdit: async (...args) => {
            const updated = await originalSource.applyEdit(...args);
            assertCurrent(true);
            fence.after = JSON.stringify(buildRestorationAssistantSnapshot(beforeAssemblies.map(item => item.id === updated.id ? updated : item), originalSource.selectedId));
            return updated;
          } }, requested.request, controller.signal);
          assertCurrent(true);
          if (outcome.result.status === 'applied') {
            expectedRestorationKey = fence.after!;
            // Hook success precedes React's committed props. Only this exact returned transition is authorized.
            const deadline = performance.now() + 5000;
            while (live.current.restorationKey !== expectedRestorationKey) {
              assertCurrent(true);
              if (live.current.restorationKey !== fence.before || performance.now() > deadline) throw new Error('Unexpected restoration transition.');
              await new Promise<void>(resolve => setTimeout(resolve, 16));
            }
            acceptedRestorationKey.current = expectedRestorationKey;
            invalidateCollision = true;
          } else if (live.current.restorationKey !== expectedRestorationKey) throw new Error('Restoration changed during the rejected edit.');
          fence.pending = false;
          assertCurrent();
          restorationContinuation = restorationContinuationSchema.parse({ token: requested.continuationToken, result: outcome.result });
          continuation = undefined;
          update(item => ({ ...item, content: '', edits: [...(item.edits ?? []), outcome.result],
            tools: item.tools.map(tool => tool.id === requested.id ? { ...tool, state: outcome.result.status === 'applied' ? 'complete' : 'error', output: outcome.result } : tool) }));
          // Old rendered overlays and collision metrics cannot evaluate the regenerated mesh.
          if (outcome.result.status === 'applied' && includeImages && tomographyRef.current) {
            currentEvidence = await prepareTomographyEvidence(tomographyRef.current, true, controller.signal);
            assertCurrent(); setEvidence(currentEvidence);
          }
          setNotice(outcome.result.status === 'applied' ? `Revision ${editsUsed}/${MAX_ASSISTANT_EDITS} applied. Evaluating actual values and fresh guardrails…` : 'The local edit was rejected. Returning the structured error for evaluation.');
          continue;
        }
        if (viewRequest) {
          const requested = viewRequest as Extract<AssistantEvent, { type: 'view-request' }>;
          if (!includeImages || !currentEvidence || !tomographyRef.current || viewRound >= MAX_TOMOGRAPHY_ROUNDS) throw new Error('The additional local image limit was reached.');
          setNotice(`Rendering requested ${requested.spec.plane} view at LPS [${requested.spec.center.join(', ')}] mm (${requested.round}/${MAX_TOMOGRAPHY_ROUNDS}).`);
          currentEvidence = await captureRequestedTomographyView(tomographyRef.current, currentEvidence, requested.spec, requested.round, controller.signal);
          assertCurrent(); viewRound = requested.round;
          const view = currentEvidence.views.at(-1)!;
          continuation = tomographyContinuationSchema.parse({ round: requested.round, viewId: view.id, spec: requested.spec, analysis: partialAnalysis });
          restorationContinuation = requested.continuationToken ? restorationContinuationSchema.parse({ token: requested.continuationToken }) : undefined;
          setEvidence(currentEvidence);
          update(item => ({ ...item, content: '', tools: item.tools.map(tool => tool.id === requested.id ? { ...tool, state: 'complete', output: { viewId: view.id, spec: requested.spec } } : tool) }));
          continue;
        }
        if (!complete) throw new Error('The connection ended before the answer finished.');
        update(item => ({ ...item, state: 'complete' })); setNotice(''); return;
      }
      throw new Error('The bounded continuation limit was reached.');
    } catch {
      if (request.current === controller && live.current.restorationKey !== expectedRestorationKey) clearStaleConversation();
      if (!controller.signal.aborted && request.current === controller) {
        setError('The assistant request or local operation could not be completed. Applied revisions remain listed below; any pending edit was not confirmed.');
        update(item => ({ ...item, state: 'error' }));
      }
    } finally {
      if (request.current === controller) { request.current = null; editFence.current = null; setBusy(false); }
    }
  }

  const toolCatalog = [...assistantToolCatalog, ...(restoration ? [{ name: 'getRestorationDesign', title: 'Restoration design', description: 'Read anonymous actual values, mesh dimensions, closure, guardrails and proposed local revisions.', example: 'Explain the current implant, crown and pilar design mistakes and unknown evidence.' }] : []),
    ...(allowAgentEdits && restoration ? [{ name: 'requestRestorationEdit', title: 'Bounded local revision', description: `Request one revision-bound implant, crown, pilar, contour or display change, then evaluate the host result. At most ${MAX_ASSISTANT_EDITS} per question.`, example: 'Use the measured design guardrails to improve this generic crown, then evaluate the actual result.' }] : [])];
  return <section id="case-assistant" className="assistant-panel" aria-label="Case assistant">
    <div className="assistant-heading"><div><span className="assistant-eyebrow">ANTHROPIC · CASE REVIEW</span><h2>Ask about this case</h2><p>Explore your scans, reviewed teeth, and surface relationships.</p></div><button aria-expanded={enabled} aria-controls="assistant-content" onClick={() => setEnabled(value => !value)}>{enabled ? 'Close assistant' : 'Open assistant'}</button></div>
    {enabled && <div id="assistant-content" className="assistant-content">
      <p className="assistant-disclosure">Each question sends your chat and a case summary to Anthropic: scan aliases, geometry statistics, poses, FDI records, site coordinates, restoration values and guardrails, and available analysis. Image sharing is optional and off by default. Mesh files are not uploaded; scan names and filenames are excluded from the summary. Avoid patient identifiers in questions and notes.</p>
      <label className="assistant-note-option"><input type="checkbox" checked={allowAgentEdits} disabled={!restoration} onChange={event => setAllowAgentEdits(event.target.checked)} />Allow agent edits</label>
      <p className="hint">{allowAgentEdits ? `Sending a question authorizes up to ${MAX_ASSISTANT_EDITS} local revision attempts of existing generic implant, crown and abutment/pilar concepts. Each candidate is remeasured; an edit that worsens observed guardrails is rejected. Stop cancels pending worker work.` : 'Manual mode: the assistant can inspect restoration designs and suggest changes. Enable agent edits before asking it to apply changes.'} Anatomy, clinical shade and bone/surgical clearance remain unassessed.</p>
      <label className="assistant-note-option"><input type="checkbox" checked={includeNotes} onChange={event => setIncludeNotes(event.target.checked)} />Include clinician tooth notes in the summary</label>
      <label className="assistant-note-option"><input type="checkbox" checked={includeImages} disabled={!tomography} onChange={event => setIncludeImages(event.target.checked)} />Share locally rendered tomography and current 3D images with Anthropic</label>
      <p className="hint">Raw DICOM, voxel buffers, filenames and patient metadata stay local. Shared images must have no identifying labels burned into their pixels. Sharing permits up to eight JPEGs and three additional precise slice requests per question; each capture retains its coordinates and registration status.</p>
      {includeImages && tomography && <button type="button" className="text-button" disabled={busy || captureBusy} onClick={() => setPreviewVersion(value => value + 1)}>Refresh shared views from the current viewport</button>}
      {!tomography && <p className="hint">Import local tomography to make image sharing available.</p>}
      {captureBusy && <p className="assistant-notice" role="status">Preparing local image previews…</p>}
      {captureError && <p className="assistant-error" role="alert">{captureError}</p>}
      {includeImages && evidence && <details open className="assistant-context-details"><summary>Rendered images available for the next question · {evidence.views.length}/8</summary>
        <p className="hint">{evidence.summary.complete ? 'Complete volume' : 'Incomplete preview — no bone height/depth, density or safety conclusions'}. Overlay registration: {evidence.summary.registration.status}. DICOM coordinates: LPS mm; mesh coordinates: file units.</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">{evidence.views.map(view => <figure key={view.id} className="rounded border border-slate-200 bg-slate-50 p-2">
          <img src={view.dataUrl} alt={`${view.id}: ${view.kind === 'slice' ? view.spec.plane + ' tomography slice' : 'current 3D view'}`} className="max-h-40 w-full object-contain" />
          <figcaption className="mt-2 text-xs text-slate-600">{view.id} · {view.kind === 'slice' ? `${view.spec.plane} · LPS [${view.spec.center.join(', ')}] mm · ${view.spec.widthMm} × ${view.spec.heightMm} mm · window ${view.spec.windowCenter}/${view.spec.windowWidth}` : `${view.projection} · ${view.coordinateSystem} · camera [${view.camera.position.join(', ')}]`}</figcaption>
          <details><summary>Exact image coordinates</summary><pre>{JSON.stringify(Object.fromEntries(Object.entries(view).filter(([key]) => key !== 'dataUrl')), null, 2)}</pre></details>
        </figure>)}</div>
      </details>}
      <AnthropicModelSelect label="Case chat model" value={selectedModel} defaultModel={configuration?.model} disabled={busy || !configuration} onChange={model => {
        if (busy || request.current) return;
        modelChosen.current = true; setSelectedModel(model); setError('');
      }} />
      <div className="assistant-context-details"><details><summary>Summary sent with your next question</summary><p className="hint">Local alias key: {context.parts.length ? context.parts.map((part, i) => `scan-${i + 1} = ${part.name}`).join('; ') : 'No models imported'}. These names are shown only here.</p><pre>{JSON.stringify({ snapshot, restoration: restorationSnapshot }, null, 2)}</pre></details><details><summary>Function catalog · {toolCatalog.length} tools</summary><div className="assistant-catalog">{toolCatalog.map(tool => <article key={tool.name}><code>{tool.name}</code><strong>{tool.title}</strong><p>{tool.description}</p><button className="text-button" disabled={busy} onClick={() => setQuestion(tool.example)}>{tool.example}</button></article>)}</div></details></div>
      {!configuration?.configured && <div className="assistant-setup"><p>{configuration ? 'To enable chat, set ANTHROPIC_API_KEY in .env.local and restart pnpm dev or pnpm preview. The key stays on the server.' : 'Checking the local assistant API…'}</p><button className="text-button" onClick={() => void checkConfiguration()}>Check connection</button></div>}
      {configuration?.configured && <p className="hint">Using {modelLabel(selectedModel)} · {allowAgentEdits ? 'bounded local edit tools enabled · fresh evidence after each revision' : 'read-only tools · snapshot at question time'}</p>}
      {notice && <p className="assistant-notice" role="status">{notice}</p>}
      {entries.length > 0 && <div className="assistant-messages" role="log" aria-label="Case conversation" aria-live="polite" aria-relevant="additions text">{entries.map(entry => <article className={`assistant-message ${entry.role}`} key={entry.id}><strong>{entry.role === 'user' ? 'You' : `Case assistant${entry.model ? ` · ${modelLabel(entry.model)}` : ''}`}{entry.state === 'stopped' ? ' · stopped' : entry.state === 'error' ? ' · incomplete' : ''}</strong>{entry.edits?.map((edit, index) => <details open className="assistant-tool" key={`edit-${index}`}><summary>{edit.status === 'applied' ? 'Applied' : 'Rejected'} revision {index + 1}/{MAX_ASSISTANT_EDITS} · {edit.request.assemblyId}</summary><p>{edit.request.edit.reason}</p>{edit.status === 'applied' ? <pre>{JSON.stringify({ before: { parameters: edit.before.parameters, anatomy: edit.before.anatomy, contour: edit.before.contour, appearance: edit.before.appearance }, actualAfter: { parameters: edit.after.parameters, anatomy: edit.after.anatomy, contour: edit.after.contour, appearance: edit.after.appearance, meshes: edit.after.meshes, quality: edit.after.quality.status, numericChanges: edit.changes, failureFeedback: edit.failureFeedback, unassessed: edit.after.quality.unassessed } }, null, 2)}</pre> : <><p>{edit.message}</p>{edit.rejectedCandidate && <pre>{JSON.stringify(edit.rejectedCandidate, null, 2)}</pre>}</>}</details>)}{entry.tools.map(tool => <details className="assistant-tool" key={tool.id}><summary>{tool.state === 'running' && busy ? 'Reading' : tool.state === 'complete' ? 'Read' : 'Incomplete'} · {tool.name}</summary><pre>{JSON.stringify({ input: tool.input, result: tool.output }, null, 2)}</pre></details>)}{entry.content ? <p>{entry.content}</p> : entry.state === 'pending' ? <p className="hint"><span className="spinner" /> Reviewing this snapshot…</p> : <p className="hint">No complete answer.</p>}</article>)}</div>}
      {error && <p className="assistant-error" role="alert">{error}</p>}
      <form onSubmit={event => void ask(event)}><label htmlFor="case-question">Question about the current workspace</label><textarea id="case-question" value={question} onChange={event => setQuestion(event.target.value)} maxLength={4000} rows={3} placeholder="What evidence is missing for the implant sites I marked?" disabled={busy} /><div className="assistant-form-actions"><button type="button" className="text-button" disabled={!entries.length || busy} onClick={() => { setEntries([]); setError(''); setNotice('Conversation cleared.'); }}>Clear conversation</button>{busy ? <button type="button" onClick={stop}>Stop answer</button> : <button className="primary" type="submit" disabled={!question.trim() || !configuration?.configured || captureBusy || restoration?.busy || Boolean(includeImages && tomography && !evidence)}>Send to Anthropic</button>}</div></form>
      <p className="hint">Mesh measurements are file units (u); calibrated DICOM views use LPS millimeters. Surface scans cannot establish bone dimensions, nerve or sinus clearance, implant size, or a safe surgical plan.</p>
    </div>}
  </section>;
}
