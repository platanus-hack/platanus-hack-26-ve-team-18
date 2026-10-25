import { z } from 'zod';

export const WORKFLOW_STAGE_IDS = ['preparation', 'assessment', 'sites', 'anatomy', 'review'] as const;
export const WORKFLOW_STAGE_LABELS = { preparation: 'Prepare evidence', assessment: 'Assess case', sites: 'Localize spaces', anatomy: 'Generate & fit', review: 'Review & handoff' };
export type WorkflowStageId = typeof WORKFLOW_STAGE_IDS[number];
// Eight fit dimensions need sixteen trials plus the baseline for one full sweep.
export const WORKFLOW_BUDGET = Object.freeze({ providerRequests: 6, providerSteps: 6, outputTokensPerStep: 8192, toolCalls: 48, sites: 16, candidatesPerSite: 32, fitMsPerSite: 12_000, workflowMs: 240_000, reviewMs: 90_000 });
const stageStatus = z.enum(['pending', 'running', 'complete', 'partial', 'cancelled', 'stale']);
const finiteTime = z.number().finite().nonnegative();
export const workflowRunSchema = z.strictObject({
  id: z.string().max(160), revision: z.string().max(160), startedAt: z.iso.datetime(), endedAt: z.iso.datetime().nullable(),
  status: z.enum(['running', 'complete', 'partial', 'cancelled', 'stale']),
  stages: z.array(z.strictObject({ id: z.enum(WORKFLOW_STAGE_IDS), status: stageStatus, durationMs: finiteTime, detail: z.string().max(4000) })).length(5),
  tools: z.array(z.strictObject({ name: z.string().max(100), stage: z.enum(WORKFLOW_STAGE_IDS), status: z.enum(['complete', 'partial', 'failed', 'cancelled']), durationMs: finiteTime, detail: z.string().max(4000), artifactIds: z.array(z.string().max(160)).max(64) })).max(128),
  aiActivity: z.array(z.strictObject({ id: z.string().max(512), name: z.string().max(100), phase: z.enum(['running', 'complete', 'error']), input: z.unknown().optional(), output: z.unknown().optional(), durationMs: finiteTime.optional(), origin: z.literal('structured-command').optional() })).max(192).optional(),
});
export type WorkflowRun = z.infer<typeof workflowRunSchema>;
export const correctionEventSchema = z.strictObject({ kind: z.enum(['identity', 'site', 'surface', 'chart', 'calibration', 'candidate', 'role', 'orientation', 'bite']), at: z.iso.datetime(), target: z.string().max(160) });
export type CorrectionEvent = z.infer<typeof correctionEventSchema>;

export function beginWorkflow(revision: string, id = crypto.randomUUID(), now = new Date().toISOString()): WorkflowRun {
  return { id, revision, startedAt: now, endedAt: null, status: 'running', stages: WORKFLOW_STAGE_IDS.map(id => ({ id, status: id === 'preparation' ? 'complete' : id === 'assessment' ? 'running' : 'pending', durationMs: 0, detail: id === 'preparation' ? 'Local source geometry, colour, coverage and reviewed corrections prepared.' : '' })), tools: [] };
}
export function stageWorkflow(run: WorkflowRun, id: WorkflowStageId, status: z.infer<typeof stageStatus>, detail: string, durationMs = 0): WorkflowRun {
  return { ...run, stages: run.stages.map(stage => stage.id === id ? { id, status, detail: detail.slice(0, 4000), durationMs: Math.max(0, durationMs) } : stage) };
}
export function journalWorkflow(run: WorkflowRun, tool: WorkflowRun['tools'][number]): WorkflowRun {
  return { ...run, tools: [...run.tools, { ...tool, detail: tool.detail.slice(0, 4000), artifactIds: tool.artifactIds.slice(0, 64) }].slice(-128) };
}
export function endWorkflow(run: WorkflowRun, status: Exclude<WorkflowRun['status'], 'running'>, now = new Date().toISOString()): WorkflowRun {
  return { ...run, endedAt: now, status, stages: run.stages.map(stage => stage.status === 'running' || stage.status === 'pending' ? { ...stage, status: status === 'stale' ? 'stale' : status === 'cancelled' ? 'cancelled' : 'partial' } : stage) };
}

/** No comparative saving is inferred without a timed, equivalent manual baseline. */
export function effortSummary(events: CorrectionEvent[], timings: { stage: string; durationMs: number }[]) {
  return { correctionSteps: events.length, byKind: Object.fromEntries(['identity', 'site', 'surface', 'chart', 'calibration', 'candidate', 'role', 'orientation', 'bite'].map(kind => [kind, events.filter(event => event.kind === kind).length])), measuredMs: timings.reduce((sum, timing) => sum + timing.durationMs, 0), manualBaselineMs: null, timeSavedMs: null, clinicalAccuracy: null };
}
