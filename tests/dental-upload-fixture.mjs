// Explicit local-fixture integration test; no private scan or default path is
// checked in or loaded by the app/test suite. Run with:
// node --experimental-strip-types tests/dental-upload-fixture.mjs /path/to/01-models
import test from 'node:test';
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { importModels } from '../src/import-models.ts';
import { inferScanRole, partMatrix } from '../src/pose.ts';
import { prepareCase } from '../src/case-preparation.ts';
import { localPlanningResult } from '../src/draft-workflow.ts';
import { automaticConceptSites } from '../src/planning-automation.ts';
import { planningPreparationEvidence } from '../src/planning-preparation.ts';
import { emptyToothCase } from '../src/tooth-session.ts';

const directory = process.argv[2];
if (!directory) throw new Error('Pass the local six-file dental fixture directory; no sample is loaded automatically.');

test('fresh six-file import produces upper and lower neutral drafts without confirming filename roles or bite', async t => {
  const names = ['upper.ply', 'lower.ply', 'bite1.ply', 'bite2.ply', 'upper.jpg', 'lower.jpg'];
  const files = await Promise.all(names.map(async name => new File([await readFile(join(directory, name))], name)));
  const imported = await importModels(files);
  // Exactly the fresh-upload role assignment from App.tsx, followed by the
  // roleConfirmed and pose inputs from useCasePlanning. No reviewed override.
  const parts = imported.parts.map(part => ({ ...part, role: inferScanRole(part.fileName), roleSource: 'filename-hypothesis' }));
  const sources = parts.filter(part => part.role === 'upper' || part.role === 'lower').map(part => ({
    id: part.id, arch: part.role, roleConfirmed: part.roleSource !== 'filename-hypothesis',
    positions: part.positions, tissueScores: part.tissueScores, pose: partMatrix(part).toArray(),
  }));
  assert.equal(parts.length, 4); assert.equal(sources.length, 2);
  assert.ok(sources.every(source => source.roleConfirmed === false));
  const teeth = emptyToothCase(), chartBefore = structuredClone(teeth);
  const prepared = prepareCase({ id: 1, revision: 'fresh-filename-role-import', sources,
    patientRight: Object.fromEntries(sources.map(source => [source.id, null])), chart: teeth.teeth, poseVerified: false });
  assert.ok(prepared.scans.every(source => source.analysis), prepared.scans.flatMap(source => source.warnings).join('\n'));
  const result = localPlanningResult(prepared, parts);
  const eligible = automaticConceptSites({ sites: prepared.sites, teeth, counts: {}, parts, result });
  assert.equal(eligible.length, 2);
  assert.deepEqual(eligible.map(site => `${site.arch}:${site.kind}`).sort(), ['lower:distal-extension', 'upper:bounded']);
  assert.ok(eligible.every(site => site.draftIdentity));
  const distal = prepared.sites.find(site => site.kind === 'distal-extension');
  assert.equal(distal.fdi, null); assert.equal(distal.status, 'identity-unresolved');
  assert.ok(distal.slot.s[0] > 92 && distal.slot.s[1] < 102, 'The lower slot must stop before the first elevated surface.');
  assert.ok(prepared.sites.some(site => site.kind === 'terminal' && site.partId === distal.partId && !site.draftIdentity));
  assert.ok(prepared.identities.every(identity => identity.fdi === null && identity.needsReview));
  for (const site of prepared.sites) {
    assert.equal(site.fdi, null); assert.equal(site.opposing, null);
    assert.equal(site.space.vertical.value, null); assert.equal(site.space.vertical.provenance, 'unknown');
    assert.equal(site.space.vertical.sampleCount, 0);
  }
  assert.equal(planningPreparationEvidence(prepared, parts, .8, teeth).sites.filter(site => site.geometricDraftEligible).length, 2);
  assert.ok(parts.every(part => part.roleSource === 'filename-hypothesis'));
  assert.deepEqual(teeth, chartBefore);
  t.diagnostic('Two neutral drafts; filename roles, anatomical FDI and opposing/vertical evidence remain unconfirmed.');
  for (const warning of imported.warnings) t.diagnostic(warning);
});
