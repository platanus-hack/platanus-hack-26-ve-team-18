import { useEffect, useRef, useState } from 'react';
import { buildAssistantSnapshot, type AssistantSnapshotInput } from './assistant-context';
import { prepareTomographyEvidence, type AssistantTomographySource } from './tomography-evidence';
import type { RestorationAssembly } from './restoration-types';
import { reviewDraft, type DraftReviewResult } from './draft-review';
import { WORKFLOW_BUDGET } from './case-workflow';

type ReviewState = { key: string | null; status: 'idle' | 'running' | 'complete' | 'cancelled' | 'stale' | 'error'; result: DraftReviewResult | null; error: string };
const idle = (key: string | null): ReviewState => ({ key, status: 'idle', result: null, error: '' });

/** At most one final review attempt per explicit workflow run. Changes cancel stale work. */
export function useDraftReview(input: {
  runKey: string | null; enabled: boolean; ready: boolean; model: string;
  context: AssistantSnapshotInput; assemblies: RestorationAssembly[];
  tomography?: AssistantTomographySource; shareTomography: boolean; tomographyBasis: string;
  onComplete: (key: string, result: DraftReviewResult) => void;
  onError: (key: string, error: string) => void;
}) {
  const [state, setState] = useState<ReviewState>(() => idle(input.runKey));
  const request = useRef<AbortController | null>(null);
  const attempted = useRef<{ key: string; basis: string } | null>(null);
  const snapshot = buildAssistantSnapshot({ ...input.context, selected: null, selectedFdi: undefined, probe: null, includeNotes: false });
  const concepts = input.assemblies.slice(0, 16).map(assembly => ({
    fdi: assembly.spec.draftIdentity ? null : assembly.spec.fdi,
    components: assembly.parts.map(part => ({ id: `scan-${input.context.parts.findIndex(source => source.id === part.id) + 1}`, kind: part.restoration?.component ?? 'concept' })),
    beforeScore: assembly.fit?.before.score ?? null, afterScore: assembly.fit?.after.score ?? null,
    fitStatus: assembly.fit?.status ?? 'unmeasured', limits: assembly.fit?.limits.slice(0, 3) ?? ['Clinical fit remains unvalidated.'],
  }));
  const basis = JSON.stringify([snapshot, concepts, input.tomographyBasis, input.model]);
  const latest = useRef({ input, snapshot, concepts }); latest.current = { input, snapshot, concepts };
  useEffect(() => {
    const key = input.runKey;
    if (key && attempted.current?.key === key && attempted.current.basis !== basis) {
      setState({ key, status: 'stale', result: null, error: 'The final AI review belongs to older evidence. Local checks remain available; start a new workflow for a fresh AI review.' });
      return;
    }
    if (!key || !input.enabled || !input.ready) {
      setState(current => current.key === key && current.status !== 'running' ? current : current.key === key ? { ...current, status: 'cancelled', result: null, error: 'AI review stopped. Local checks remain available.' } : idle(key));
      return;
    }
    if (attempted.current?.key === key) return;
    attempted.current = { key, basis };
    const controller = new AbortController(); request.current = controller;
    const timeout = setTimeout(() => controller.abort(), WORKFLOW_BUDGET.reviewMs);
    setState({ key, status: 'running', result: null, error: '' });
    const captured = latest.current;
    void (async () => {
      const tomography = captured.input.shareTomography && captured.input.tomography ? await prepareTomographyEvidence(captured.input.tomography, true, controller.signal) : undefined;
      const result = await reviewDraft({ snapshot: captured.snapshot, model: captured.input.model, concepts: captured.concepts, tomography, signal: controller.signal });
      if (controller.signal.aborted || request.current !== controller) return;
      setState({ key, status: 'complete', result, error: '' }); latest.current.input.onComplete(key, result);
    })().catch(() => {
      if (request.current !== controller) return;
      const error = controller.signal.aborted ? 'AI review timed out. Local checks and completed concepts are retained.' : 'The AI review did not finish. Local checks and completed concepts are retained.';
      setState({ key, status: 'error', result: null, error }); latest.current.input.onError(key, error);
    }).finally(() => { clearTimeout(timeout); if (request.current === controller) request.current = null; });
    return () => { request.current = null; clearTimeout(timeout); controller.abort(); };
  }, [input.runKey, input.enabled, input.ready, basis]);
  const cancel = () => {
    request.current?.abort(); request.current = null;
    setState(current => current.status === 'running' ? { ...current, status: 'cancelled', result: null, error: 'AI review stopped. Local checks remain available; resume does not make another provider request.' } : current);
  };
  return { ...(state.key === input.runKey ? state : idle(input.runKey)), cancel };
}
