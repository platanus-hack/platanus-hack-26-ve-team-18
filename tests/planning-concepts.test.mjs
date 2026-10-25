import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyToothCase } from '../src/tooth-session.ts';
import { planningConceptCase } from '../src/planning-concepts.ts';

test('concept hypotheses are disposable generator inputs and preserve the saved chart', () => {
  const saved = emptyToothCase(), before = structuredClone(saved);
  const result = planningConceptCase(saved, [{ fdi: 15, evidence: ['view-1'], rationale: 'Proposed gap' }]);
  assert.equal(result.teeth[15].status, 'missing');
  assert.equal(result.teeth[15].restoration, 'implant');
  assert.deepEqual(saved, before);
  assert.equal(result.labels, saved.labels);
  assert.equal(result.teeth[14], saved.teeth[14]);
});

test('concept generation cannot override present, not-scanned, assigned, or invalid positions', () => {
  const saved = emptyToothCase();
  saved.teeth[14] = { ...saved.teeth[14], status: 'present' };
  saved.teeth[16] = { ...saved.teeth[16], status: 'not-scanned' };
  saved.labels.upper = Uint8Array.of(17);
  const result = planningConceptCase(saved, [14, 16, 17, 99].map(fdi => ({ fdi, evidence: [], rationale: '' })));
  assert.deepEqual(result, saved);
});
