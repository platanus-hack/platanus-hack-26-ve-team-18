import type { RestorationFitMeasurement, RestorationFitResult, RestorationParameters, RestorationRevision } from './restoration-types';
import type { RestorationQualityReport } from './restoration-quality';
import { preservesFitEvidence } from './restoration-fit-selection.ts';
import { feedbackError, restorationFeedbackRows } from './restoration-feedback.ts';
import type { RestorationRelationshipsReport } from './restoration-relationships';
import { preservesGoalEvidence } from './restoration-goals.ts';
import type { RestorationGoalReport } from './restoration-goals';

/** Compare frozen requirement evidence by identity, excluding presentation and
 * the current audit's fingerprint, measurements and search history. */
function goalContractEvidence(goal: RestorationGoalReport | undefined): string | undefined {
  if (!goal?.contract || !goal.bounds || !goal.targetGaps) return undefined;
  const contract = goal.contract;
  return JSON.stringify({ version: goal.version,
    bounds: Object.entries(goal.bounds).sort(([a], [b]) => a.localeCompare(b)),
    targetGaps: Object.entries(goal.targetGaps).sort(([a], [b]) => a.localeCompare(b)),
    contract: { status: contract.status, requiredError: contract.requiredError, preferenceError: contract.preferenceError,
      rows: contract.rows.map(({ id, priority, actual, lower, upper, exclusiveUpper, error, units, status }) => ({ id, priority, actual, lower, upper, exclusiveUpper, error, units, status }))
        .sort((a, b) => a.id.localeCompare(b.id)) } });
}

/** Fixed public messages and anonymous rows can be sent to an agent; raw spec,
 * mesh buffers, target names and patient filenames are deliberately excluded. */
export class RestorationEditRejected extends Error {
  readonly reasons: string[];
  readonly candidate: { quality: RestorationQualityReport; measurement: RestorationFitMeasurement; parameters: RestorationParameters; relationships?: RestorationRelationshipsReport };
  constructor(reasons: string[], candidate: RestorationEditRejected['candidate']) {
    super('Agent edit rejected by measured guardrails. The current model was retained.');
    this.name = 'RestorationEditRejected';
    this.reasons = reasons; this.candidate = candidate;
  }
}

/** Evaluate before replacing an assembly. Manual edits remain inspectable even
 * when they fail; automatic edits cannot worsen observed numerical deficits. */
export function assertAgentEditPreservesEvidence(previous: RestorationRevision, candidate: RestorationFitResult): void {
  const before = previous.fit?.quality?.final, after = candidate.report.quality?.final;
  if (!after) throw new Error('Agent edits require a current independent evaluation.');
  const reasons: string[] = [];
  if (!before || !previous.fit) reasons.push('The current design has no measured baseline. Remeasure it before comparing an agent edit.');
  if (before && previous.fit) {
    const inheritedGoal = previous.fit.goal;
    if (inheritedGoal) {
      const contract = goalContractEvidence(inheritedGoal);
      if (contract === undefined || contract !== goalContractEvidence(candidate.report.goal)) reasons.push('The candidate did not preserve the original goal contract.');
      // Match session validation: exact, inclusive parameter bounds and an
      // implicit contour scale of 1. Inspect the spec, not reported scores.
      for (const [key, range] of Object.entries(inheritedGoal.bounds ?? {})) {
        const [component, field, extra] = key.split('.');
        const values = candidate.spec.parameters[component as keyof typeof candidate.spec.parameters];
        const selected = key === 'cervicalScale' || key === 'occlusalScale' ? candidate.spec.contour?.[key] ?? 1
          : !extra && values && Object.hasOwn(values, field) ? values[field as keyof typeof values] : undefined;
        if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite) || range[0] > range[1]
          || selected === undefined || !Number.isFinite(selected)) reasons.push('An original goal parameter bound or candidate value is invalid.');
        else if (selected < range[0] || selected > range[1]) reasons.push('A candidate parameter is outside its original goal bounds.');
      }
    }
    for (const old of previous.fit.after.surfaces) {
      const next = candidate.report.after.surfaces.find(row => row.id === old.id);
      if (old.intersectionComplete && !next?.intersectionComplete) reasons.push('A complete target crossing audit became incomplete; a smaller capped count is not improvement.');
    }
    const goalBefore = previous.fit.goal?.after, goalAfter = candidate.report.goal?.after;
    const oldPilar = previous.fit.abutmentGingiva ?? previous.fit.relationships?.abutmentGingiva;
    const newPilar = candidate.report.abutmentGingiva ?? candidate.report.relationships?.abutmentGingiva;
    if (oldPilar && (!newPilar || oldPilar.status === 'pass' && newPilar.status !== 'pass'
      || newPilar.unsupportedSamples > oldPilar.unsupportedSamples
      || oldPilar.knownSamples === oldPilar.samples && oldPilar.samples > 0
        && (newPilar.knownSamples !== newPilar.samples || !newPilar.samples || newPilar.unknownSupportSamples > oldPilar.unknownSupportSamples))) {
      reasons.push('The emitted pilar/gum audit worsened or lost complete crown-support evidence.');
    }
    if (goalBefore && goalAfter ? !preservesGoalEvidence(candidate, { report: previous.fit }, goalAfter, goalBefore)
      : !preservesFitEvidence(candidate.report.after, previous.fit.after, after, before)) {
      reasons.push('The candidate lost a passing check, target contact, ray coverage or complete crossing evidence.');
    }
    const oldRows = goalBefore && goalAfter ? goalBefore.rows.filter(row => row.priority === 'required')
      : restorationFeedbackRows(before, previous.spec.parameters, previous.fit.after, previous.spec.qualityContext);
    const newRows = goalBefore && goalAfter ? goalAfter.rows
      : restorationFeedbackRows(after, candidate.spec.parameters, candidate.report.after, candidate.spec.qualityContext);
    for (const old of oldRows) {
      const next = newRows.find(row => row.id === old.id);
      if (!next || old.units !== next.units || old.status === 'pass' && next.status !== 'pass' || old.status === 'unknown' && next.status === 'fail') {
        reasons.push(`${old.label}: previously available evidence or status was lost.`); continue;
      }
      // Keep the original bounds for this comparison. Growing the crown must
      // not relax its contact tolerance and make a larger gap look improved.
      const nextError = feedbackError(next.actual, old.lower, old.upper, old.exclusiveUpper);
      if (old.error === null || nextError === null) {
        if (old.actual !== null && next.actual === null) reasons.push(`${old.label}: a measurement became unknown.`);
        continue;
      }
      const scale = Math.max(Math.abs(old.actual ?? 0), Math.abs(next.actual ?? 0), Math.abs(old.lower ?? 0), Math.abs(old.upper ?? 0), Number.MIN_VALUE);
      if (Math.abs(nextError) > Math.abs(old.error) + scale * 1e-6) reasons.push(`${old.label}: the numerical error increased against the previous target bounds.`);
    }
    for (const issue of (goalBefore && goalAfter ? before.guardrails?.issues.filter(issue => ['subcrestal-placement', 'adjacent-root-clearance'].includes(issue.id)) : before.guardrails?.issues) ?? []) {
      const next = after.guardrails?.issues.find(item => item.id === issue.id);
      if (!next || issue.status !== 'fail' && next.status === 'fail') reasons.push(`${issue.id}: a new dentist-feedback failure appeared.`);
    }
    for (const [index, old] of (previous.fit.relationships?.relationships ?? []).entries()) {
      const next = candidate.report.relationships?.relationships.find(row => row.id === old.id);
      const label = `Component surface pair ${index + 1}`;
      if (!next || next.source !== old.source || next.target !== old.target || next.targetId !== old.targetId || next.side !== old.side
        || old.status === 'measured' && next.status !== 'measured'
        || old.intersectionComplete && !next.intersectionComplete
        || old.transverseCrossingTriangles !== null && next.transverseCrossingTriangles === null) reasons.push(`${label}: measurement or complete crossing evidence was lost.`);
      else if (old.transverseCrossingTriangles !== null && next.transverseCrossingTriangles !== null) {
        if (old.transverseCrossingTriangles > 0 && next.transverseCrossingTriangles < old.transverseCrossingTriangles && !next.intersectionComplete) {
          reasons.push(`${label}: an incomplete audit cannot remove observed crossing evidence.`);
        }
        // Solid component envelopes intentionally overlap. Their core support
        // has its own required audit; external scan crossings remain strict.
        if (old.target === 'adjacent' && next.transverseCrossingTriangles > old.transverseCrossingTriangles) reasons.push(`${label}: transverse crossing evidence increased.`);
      }
    }
  }
  if (reasons.length) throw new RestorationEditRejected([...new Set(reasons)], { quality: after, measurement: candidate.report.after, parameters: candidate.spec.parameters, relationships: candidate.report.relationships });
}
