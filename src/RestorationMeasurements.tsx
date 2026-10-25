import type { RestorationAssembly } from './restoration-types';
import type { RestorationGoalReport, RestorationGoalRow } from './restoration-goals';
import { restorationFeedbackRows } from './restoration-feedback';
import './restoration-measurements.css';

const number = (value: number | null | undefined) => value == null ? 'Unmeasured' : Number(value.toPrecision(5)).toString();
const range = (lower: number | null, upper: number | null) => lower === null && upper === null ? 'Not established'
  : lower !== null && upper !== null ? `${number(lower)} – ${number(upper)}` : lower !== null ? `≥ ${number(lower)}` : `≤ ${number(upper)}`;
const targetBounds = (row: RestorationGoalRow) => [row.lower === null ? '' : `≥ ${number(row.lower)}`, row.upper === null ? '' : `${row.exclusiveUpper ? '<' : '≤'} ${number(row.upper)}`].filter(Boolean).join(' · ') || 'Not established';
const goalState = { satisfied: 'Satisfied within measured requirements', unmet: 'Unmet', unknown: 'Unknown · evidence incomplete' };
const rowState = { pass: 'Within measured bound', fail: 'Unmet', unknown: 'Unknown · evidence incomplete' };
const stopReason = { satisfied: 'Measured requirements satisfied', 'needs-evidence': 'Needs evidence', 'candidate-budget': 'Attempt budget reached',
  'time-budget': 'Time budget reached', stalled: 'No acceptable improvement found', 'measurement-only': 'Measurement only · entered values retained' };
const groups = [
  { priority: 'required', label: 'Required contacts & no-crossings', explanation: 'Each supplied contact target and crossing check must be assessed separately. Gum-envelope and component checks are also required.' },
  { priority: 'preference', label: 'Shape preferences', explanation: 'Neighbour proportions and anatomy ratios guide shape; they cannot compensate for a failed required check.' },
  { priority: 'clinical', label: 'Clinical evidence', explanation: 'Unresolved bone, root and emergence evidence remains unknown. File units cannot substitute for verified millimetre measurements.' },
] as const;

export function RestorationGoalRequirements({ goal, stale = false }: { goal?: RestorationGoalReport; stale?: boolean }) {
  if (!goal) return <details className="restoration-adjust restoration-measurements" open>
    <summary>Mouth-fit requirements · Not evaluated</summary>
    <p>No requirement report is available for this concept. Use Fit to mouth requirements to measure this loaded case. Generated geometry alone does not establish that requirements are met.</p>
  </details>;
  const rowIds = [...new Set([...goal.before.rows.map(row => row.id), ...goal.after.rows.map(row => row.id)])];
  const rows = rowIds.map(id => {
    const before = goal.before.rows.find(row => row.id === id), after = goal.after.rows.find(row => row.id === id);
    return { before, after, row: (after ?? before)! };
  });
  const unresolved = rows.filter(({ after }) => after?.status !== 'pass');
  const value = (row?: RestorationGoalRow) => row ? `${number(row.actual)} ${row.units}` : 'Unmeasured';
  return <details className="restoration-adjust restoration-measurements" open>
    <summary>Mouth-fit requirements · {stale ? 'Stale · remeasurement needed' : goalState[goal.status]}</summary>
    {stale && <p>The source evidence has changed. This is the last measured report, not the current fit.</p>}
    <p>{stopReason[goal.termination]} · {goal.attempts.length} / {goal.maxAttempts} measured attempts · {(goal.durationMs / 1000).toFixed(2)} s. {goal.selectedAttempt === 0 ? 'Initial measured design retained.' : `Selected attempt ${goal.selectedAttempt}.`}</p>
    <p>Required error {number(goal.before.requiredError)} → {number(goal.after.requiredError)}; preference error {number(goal.before.preferenceError)} → {number(goal.after.preferenceError)}. These are normalized search errors, not clinical acceptance. Unchanged or generated geometry does not establish that requirements are met.</p>
    {groups.map(group => <section key={group.priority} aria-label={group.label}>
      <h4>{group.label}</h4><p>{group.explanation}</p>
      <div className="restoration-measurement-scroll"><table>
        <thead><tr><th>Requirement</th><th>Before → after</th><th>Fixed target bounds</th><th>Current signed error</th></tr></thead>
        <tbody>{rows.filter(item => item.row.priority === group.priority).map(({ before, after, row }) => <tr key={row.id} data-status={after?.status ?? 'unknown'}>
          <th scope="row">{row.label}<small>{rowState[after?.status ?? 'unknown']}</small></th>
          <td>{value(before)} → {value(after)}<small>{before ? rowState[before.status] : 'Unmeasured'} → {after ? rowState[after.status] : 'Evidence lost'}</small></td>
          <td>{targetBounds(row)} <small>{row.units}</small></td>
          <td>{number(after?.error)}<small>{after?.reason ?? 'This row is absent from the selected measurements; obtain fresh evidence.'}</small></td>
        </tr>)}</tbody>
      </table></div>
      {!rows.some(item => item.row.priority === group.priority) && <p>No checks recorded in this group.</p>}
    </section>)}
    <details open><summary>Remaining failures & unknowns · {unresolved.length}</summary>
      {unresolved.length ? <ul>{unresolved.map(({ row, after }) => <li key={row.id}><strong>{row.priority === 'preference' ? 'Preference' : row.priority === 'clinical' ? 'Clinical evidence' : 'Required'} · {row.label}:</strong> {rowState[after?.status ?? 'unknown']}. {after?.reason ?? 'Evidence lost from the selected measurements.'}</li>)}</ul>
        : <p>No failed or unknown rows in this measured report. This does not establish clinical fit.</p>}
    </details>
    <details><summary>Fixed search bounds</summary><p>Parameter limits stay fixed across attempts; they are separate from the requirement targets above.</p>
      <div className="restoration-measurement-scroll"><table><thead><tr><th>Parameter</th><th>Allowed range</th></tr></thead><tbody>
        {Object.entries(goal.bounds).map(([key, bounds]) => <tr key={key}><th scope="row">{key}</th><td>{range(...bounds)} <small>{key === 'cervicalScale' || key === 'occlusalScale' ? 'ratio' : /\.(angleX|angleY|rotation)$/.test(key) ? 'degrees' : 'file units (u)'}</small></td></tr>)}
      </tbody></table></div>
    </details>
    <details><summary>Requirement attempt history</summary><p>Attempt 0 is the initial measurement. Accepted at a step does not mean requirements are satisfied.</p>
      <div className="restoration-measurement-scroll"><table><thead><tr><th>Attempt</th><th>Decision</th><th>Requirements</th><th>Required / preference error</th></tr></thead><tbody>
        {goal.attempts.map(attempt => <tr key={attempt.attempt} data-status={attempt.snapshot.status === 'satisfied' ? 'pass' : attempt.snapshot.status === 'unmet' ? 'fail' : 'unknown'}>
          <th scope="row">{attempt.attempt}{attempt.attempt === 0 ? ' · initial' : ''}</th><td>{attempt.attempt === goal.selectedAttempt ? 'Selected result' : attempt.accepted ? 'Accepted at this step' : 'Rejected'}<small>{attempt.reason}</small></td>
          <td>{goalState[attempt.snapshot.status]}</td><td>{number(attempt.snapshot.requiredError)} / {number(attempt.snapshot.preferenceError)}</td>
        </tr>)}
      </tbody></table></div>
    </details>
    {!!goal.emergence?.length && <details><summary>Pilar–gum emergence evidence</summary><p>The pilar bridges the gum boundary; zero intersections is not its design target. These observations do not validate the emergence contour.</p><ul>{goal.emergence.map((item, index) => <li key={item.target}>Gum target {index + 1}: {number(item.transverseCrossingTriangles)} crossed faces; {number(item.touchingOrAmbiguousTriangles)} touching or ambiguous; {item.intersectionComplete ? 'complete supplied-surface audit' : 'incomplete audit'}.</li>)}</ul></details>}
    <details><summary>Requirement scope & limits</summary><p>Sampled gaps are not exact contact area or overlap volume. Zero error cannot resolve unknown evidence.</p><ul>{goal.limits.map((limit, index) => <li key={index}>{limit}</li>)}</ul></details>
  </details>;
}

export function RestorationMeasurements({ assembly }: { assembly: RestorationAssembly }) {
  const report = assembly.fit?.quality?.final;
  const rows = restorationFeedbackRows(report, assembly.spec.parameters, assembly.fit?.after, assembly.spec.qualityContext);
  const previous = assembly.previousVersions?.at(-1);
  const oldRows = restorationFeedbackRows(previous?.fit?.quality?.final, previous?.spec.parameters, previous?.fit?.after, previous?.spec.qualityContext);
  const relationships = assembly.fit?.relationships;
  return <><RestorationGoalRequirements goal={assembly.fit?.goal} stale={assembly.warnings.some(warning => warning.startsWith('STALE:')) || assembly.parts.some(part => part.restoration?.stale)} />
    {!!rows.length && <details className="restoration-adjust restoration-measurements" open>
    <summary>Numeric guardrails · actual / target / error</summary>
    <p>Each edit is remeasured. Agent edits retain the current model when they worsen an observed error or lose evidence. Manual edits retain their failed checks for review.</p>
    <div className="restoration-measurement-scroll"><table>
      <thead><tr><th>Measurement</th>{previous && <th>Before</th>}<th>Actual</th><th>Target range</th><th>Signed error</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.id} data-status={row.status}>
        <th scope="row"><span>{row.label}</span><small>{row.status === 'pass' ? 'Within measured check' : row.status === 'fail' ? 'Needs revision' : 'Evidence incomplete'}</small></th>
        {previous && <td>{number(oldRows.find(item => item.id === row.id)?.actual)}</td>}
        <td>{number(row.actual)} <small>{row.units}</small></td>
        <td>{row.lower === null && row.upper === null ? 'Not established' : row.lower !== null && row.upper !== null ? `${number(row.lower)} – ${number(row.upper)}` : row.lower !== null ? `≥ ${number(row.lower)}` : `${row.exclusiveUpper ? '<' : '≤'} ${number(row.upper)}`}</td>
        <td>{number(row.error)}<small>{row.controls.length ? `Controls: ${row.controls.join(', ')}` : 'Requires reference evidence'}</small></td>
      </tr>)}</tbody>
    </table></div>
    <p>Negative error is below the lower bound; positive error is above the upper bound. Zero is only a numerical comparison. Unknown evidence cannot pass. Prototype ranges are file-unit engineering checks; the two clinical targets remain in mm.</p>
    {relationships && <details open><summary>Implant, pilar & adjacent-surface distances</summary>
      <p>Up to {relationships.sampling.requestedPerRelationship} source triangle samples per pair. These are distances to supplied scan surfaces, not adjacent roots. An unsigned sampled minimum can miss a closer point.</p>
      <div className="restoration-measurement-scroll"><table><thead><tr><th>Surface pair</th><th>Min / median / p95 (u)</th><th>Crossing evidence</th></tr></thead><tbody>
        {relationships.relationships.map((item, index) => <tr key={item.id}><th scope="row">{item.source === 'fixture' ? 'Implant' : 'Pilar'} → {item.target === 'abutment' ? 'pilar' : item.target === 'crown' ? 'crown' : `${item.side ?? 'adjacent'} scan surface`}<small>Pair {index + 1} · {item.samples} samples</small></th>
          <td>{[item.sampledMinDistance, item.sampledMedianDistance, item.sampledP95Distance].map(number).join(' / ')}{item.reason && <small>{item.reason}</small>}</td>
          <td>{item.transverseCrossingTriangles === null ? 'Unmeasured' : `${item.transverseCrossingTriangles} crossed faces`}<small>{item.intersectionComplete ? 'Complete supplied-surface audit' : 'Incomplete audit'} · {item.touchingOrAmbiguousTriangles ?? 'unknown'} touching / ambiguous</small><small>Numerical tolerance: {number(item.intersectionTolerance)} u</small></td></tr>)}
      </tbody></table></div>
      {relationships.interfaces.map(item => <p key={item.id}><strong>{item.id === 'fixture-platform' ? 'Implant–pilar platform' : 'Pilar–crown base'}:</strong> axial envelope gap {number(item.signedAxialGap)} u. This plane check does not establish lateral seating or hardware compatibility.</p>)}
      <details><summary>Measurement scope & limits</summary><p>{(relationships.durationMs / 1000).toFixed(2)} s · {relationships.termination}.</p><ul>{relationships.limits.map(item => <li key={item}>{item}</li>)}</ul></details>
    </details>}
  </details>}</>;
}
