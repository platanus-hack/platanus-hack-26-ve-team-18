import { useEffect, useRef, useState } from 'react';
import { buildAssistantSnapshot, type AssistantSnapshotInput } from './assistant-context';
import { prepareTomographyEvidence, type AssistantTomographySource } from './tomography-evidence';
import type { RestorationAssembly } from './restoration-types';
import { reviewDraft, type DraftReviewResult } from './draft-review';
import { WORKFLOW_BUDGET } from './case-workflow';
import { buildRestorationAssistantSnapshot, type AssistantRestorationSource } from './restoration-assistant';
import { restorationEditRevision } from './restoration-edit';
import { reviewAndRefineDraft, RestorationAgentReviewError } from './restoration-agent-review';
import type { PlanningActivity } from './planning-events';

type ReviewState = { key: string | null; status: 'idle' | 'running' | 'complete' | 'cancelled' | 'stale' | 'error'; result: DraftReviewResult | null; error: string; activity: PlanningActivity[] };
const idle = (key: string | null): ReviewState => ({ key, status: 'idle', result: null, error: '', activity: [] });
const sourceKey = (source: AssistantRestorationSource) => JSON.stringify([
  source.sourceRevision, source.selectedId, source.assemblies.map(assembly => [assembly.id, restorationEditRevision(assembly)]),
  buildRestorationAssistantSnapshot(source.assemblies, source.selectedId),
]);

/** One bounded follow-up per explicit workflow run; without current concepts, review case evidence read-only. */
export function useDraftReview(input: {
  runKey: string | null; enabled: boolean; ready: boolean; model: string;
  context: AssistantSnapshotInput; assemblies: RestorationAssembly[];
  restoration?: AssistantRestorationSource;
  tomography?: AssistantTomographySource; shareTomography: boolean; tomographyBasis: string;
  onComplete: (key: string, result: DraftReviewResult) => void;
  onError: (key: string, error: string) => void;
}) {
  const [state, setState] = useState<ReviewState>(() => idle(input.runKey));
  const request = useRef<AbortController | null>(null);
  const attempted = useRef<{ key: string; basis: string } | null>(null);
  const acceptedSource = useRef<{ key: string; assemblies: readonly RestorationAssembly[] } | null>(null);
  const editFence = useRef<{ controller: AbortController; pending: boolean } | null>(null);
  const bufferIds = useRef(new WeakMap<object, number>()), nextBufferId = useRef(0);
  const bufferId = (buffer?: object) => {
    if (!buffer) return 0;
    let id = bufferIds.current.get(buffer);
    if (!id) { id = ++nextBufferId.current; bufferIds.current.set(buffer, id); }
    return id;
  };
  const snapshot = buildAssistantSnapshot({ ...input.context, selected: null, selectedFdi: undefined, probe: null, includeNotes: false });
  const concepts = input.assemblies.slice(0, 16).map(assembly => ({
    fdi: assembly.spec.draftIdentity ? null : assembly.spec.fdi,
    components: assembly.parts.map(part => ({ id: `scan-${input.context.parts.findIndex(source => source.id === part.id) + 1}`, kind: part.restoration?.component ?? 'concept' })),
    beforeScore: assembly.fit?.before.score ?? null, afterScore: assembly.fit?.after.score ?? null,
    fitStatus: assembly.fit?.status ?? 'unmeasured', limits: assembly.fit?.limits.slice(0, 3) ?? ['Clinical fit remains unvalidated.'],
  }));
  // Passive collision completion and an authorized generated mesh change do not change the
  // original-source basis. Exact generated inventory transitions are fenced separately below.
  const externalBasis = input.restoration ? JSON.stringify([
    input.model, input.shareTomography, input.tomographyBasis, input.restoration.sourceRevision, input.restoration.selectedId,
    input.context.parts.filter(part => !part.restoration).map(part => [part.id, part.sourceByteSha256,
      bufferId(part.positions), bufferId(part.normals), bufferId(part.colors), bufferId(part.uvs), bufferId(part.tissueScores), bufferId(part.texture?.bytes),
      part.dimensions, part.role, part.visible, part.pose, part.offset, part.rotation]),
    input.context.parts.filter(part => part.restoration).map(part => [part.id, part.visible, part.pose, part.offset, part.rotation]),
    input.context.teeth, input.context.counts, input.context.tolerance, input.context.fitSummary, input.context.fitRadius,
  ]) : '';
  const basis = input.restoration ? externalBasis : JSON.stringify([snapshot, concepts, input.tomographyBasis, input.model]);
  const restorationKey = input.restoration ? sourceKey(input.restoration) : null;
  const latest = useRef({ input, snapshot, concepts, externalBasis }); latest.current = { input, snapshot, concepts, externalBasis };
  // Readiness gates startup. During refinement the host's own worker/collision refresh may
  // set ready=false; abort only for external evidence changes or explicit disable/cancel.
  const ready = input.restoration && attempted.current?.key === input.runKey ? true : input.ready;
  useEffect(() => {
    const key = input.runKey;
    if (key && attempted.current?.key === key && attempted.current.basis !== basis) {
      setState(current => ({ key, status: 'stale', result: null, error: 'The final AI review belongs to older evidence. Local checks remain available; start a new workflow for a fresh AI review.', activity: current.key === key ? current.activity : [] }));
      return;
    }
    if (!key || !input.enabled || !ready) {
      setState(current => current.key === key && current.status !== 'running' ? current : current.key === key ? { ...current, status: 'cancelled', result: null, error: 'AI review stopped. Local checks remain available.' } : idle(key));
      return;
    }
    if (attempted.current?.key === key) return;
    attempted.current = { key, basis };
    const controller = new AbortController(); request.current = controller;
    editFence.current = null;
    acceptedSource.current = input.restoration ? { key: sourceKey(input.restoration), assemblies: [...input.restoration.assemblies] } : null;
    const timeout = setTimeout(() => controller.abort(), WORKFLOW_BUDGET.reviewMs);
    setState({ key, status: 'running', result: null, error: '', activity: [] });
    const captured = latest.current;
    void (async () => {
      const tomography = captured.input.shareTomography && captured.input.tomography ? await prepareTomographyEvidence(captured.input.tomography, true, controller.signal) : undefined;
      // A completed planning run can legitimately construct no concepts. Review
      // its case evidence without asking an empty restoration host for measurements.
      const result = captured.input.restoration?.assemblies.length ? await reviewAndRefineDraft({
        snapshot: captured.snapshot, getSnapshot: () => latest.current.snapshot,
        getSource: () => latest.current.input.restoration, getCaseRevision: () => latest.current.externalBasis,
        model: captured.input.model, tomography, signal: controller.signal,
        onEditTransition: transition => {
          if (request.current !== controller || controller.signal.aborted) return;
          editFence.current = { controller, pending: transition.pending };
          if (!transition.pending && latest.current.input.restoration) acceptedSource.current = {
            key: sourceKey(latest.current.input.restoration), assemblies: [...transition.assemblies],
          };
        },
        onActivity: activity => {
          if (request.current !== controller || controller.signal.aborted) return;
          setState(current => current.key !== key || current.status !== 'running' ? current : { ...current,
            activity: current.activity.some(item => item.id === activity.id)
              ? current.activity.map(item => item.id === activity.id ? { ...item, ...activity } : item)
              : [...current.activity, activity],
          });
        },
      }) : await reviewDraft({ snapshot: captured.snapshot, model: captured.input.model, concepts: captured.concepts, tomography, signal: controller.signal });
      if (controller.signal.aborted || request.current !== controller) return;
      setState(current => ({ key, status: 'complete', result, error: '', activity: current.key === key ? current.activity : [] })); latest.current.input.onComplete(key, result);
    })().catch(cause => {
      if (request.current !== controller) return;
      const error = controller.signal.aborted ? 'AI review timed out. Local checks and completed concepts are retained.' : cause instanceof RestorationAgentReviewError ? cause.message : 'The AI review did not finish. Local checks and completed concepts are retained.';
      setState(current => ({ key, status: cause instanceof RestorationAgentReviewError && cause.status === 'stale' ? 'stale' : 'error', result: null, error, activity: current.key === key ? current.activity : [] })); latest.current.input.onError(key, error);
    }).finally(() => { clearTimeout(timeout); if (request.current === controller) { request.current = null; editFence.current = null; } });
    return () => { request.current = null; clearTimeout(timeout); controller.abort(); };
  }, [input.runKey, input.enabled, ready, basis]);
  useEffect(() => {
    const source = input.restoration, accepted = acceptedSource.current;
    if (!source || !accepted || attempted.current?.key !== input.runKey) return;
    if (restorationKey === accepted.key && source.assemblies.length === accepted.assemblies.length
      && source.assemblies.every((assembly, index) => assembly === accepted.assemblies[index])) return;
    // The executor waits up to 5 seconds for before -> its exact returned after. Do not
    // bless an arbitrary render here merely because an edit worker is running.
    if (request.current && editFence.current?.controller === request.current && editFence.current.pending) return;
    request.current?.abort(); request.current = null;
    setState(current => current.key !== input.runKey || current.status === 'stale' ? current : { ...current,
      status: 'stale', result: null, error: 'The restoration changed outside this AI follow-up. Completed geometry is retained; start a fresh workflow.',
    });
  }, [restorationKey, input.restoration?.assemblies, input.runKey, state.status]);
  const cancel = () => {
    request.current?.abort(); request.current = null;
    setState(current => current.status === 'running' ? { ...current, status: 'cancelled', result: null, error: 'AI review stopped. Local checks remain available; resume does not make another provider request.' } : current);
  };
  // A restored snapshot may reuse this exact run ID but contain an earlier trace.
  // Drop every live result and fence before the saved journal becomes authoritative.
  const reset = () => {
    request.current?.abort(); request.current = null;
    attempted.current = null; acceptedSource.current = null; editFence.current = null;
    setState(idle(null));
  };
  return { ...(state.key === input.runKey ? state : idle(input.runKey)), cancel, reset };
}
