import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { engineeringFitSite, main, parseArguments } from '../scripts/evaluate-planning-case.mjs';

const required = ['--upper', '/private/upper.ply', '--lower', '/private/lower.obj', '--bite', '/private/bite-1.stl', '--out', '/private/new-evaluation'];

test('evaluation requires explicit roles/output, retains repeated bites, and has no side/FDI/fit defaults', () => {
  const parsed = parseArguments([...required, '--bite', '/private/bite-2.ply', '--texture', '/private/atlas.png']);
  assert.equal(parsed.inputs.filter(input => input.role === 'bite').length, 2);
  assert.equal(parsed.side, null);
  assert.equal(parsed.fitSite, null);
  assert.equal(parsed.hypothesisFdi, null);
  assert.throws(() => parseArguments([]), /Provide --upper/);
  assert.throws(() => parseArguments(required.slice(0, 6)), /--out/);
  assert.throws(() => parseArguments([...required, '--upper', '/private/other.ply']), /exactly one/);
  assert.throws(() => parseArguments([...required, '--bite', '/different/bite-1.stl']), /basenames/);
  assert.throws(() => parseArguments([...required, '--side', 'patient-left']), /image-left or image-right/);
});

test('fit opt-in requires a paired explicit permanent FDI and enforces bounded budgets', () => {
  assert.throws(() => parseArguments([...required, '--fit-site', '0']), /supplied together/);
  assert.throws(() => parseArguments([...required, '--hypothesis-fdi', '36']), /supplied together/);
  for (const fdi of ['19', '29', '30', '49']) assert.throws(() => parseArguments([...required, '--fit-site', '0', '--hypothesis-fdi', fdi]), /FDI|integer/);
  for (const [flag, value] of [['--fit-site', '-1'], ['--max-candidates', '81'], ['--fit-ms', '60001'], ['--timeout-ms', '0']]) assert.throws(() => parseArguments([...required, flag, value]), /integer/);
  const parsed = parseArguments([...required, '--side', 'image-right', '--fit-site', '0', '--hypothesis-fdi', '36']);
  assert.equal(parsed.fitSite, 0); assert.equal(parsed.hypothesisFdi, 36);
});

test('CLI refuses public output and an existing directory before reading patient inputs', async () => {
  const to = path => [...required.slice(0, -1), path];
  await assert.rejects(main(to(fileURLToPath(new URL('../public/..evaluation-contract', import.meta.url)))), /outside public/);
  await assert.rejects(main(to(fileURLToPath(new URL('../docs', import.meta.url)))), /EEXIST/);
});

test('explicit engineering fit never upgrades the prepared site or forces an unscanned/unlocalized site', () => {
  const original = { id: 'synthetic-space', arch: 'lower', partId: 'lower', fdi: null, status: 'identity-unresolved', kind: 'bounded', confidence: 0,
    anchor: { partId: 'lower', face: 0, point: [0, 0, 0] }, frame: { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], up: [0, 0, 1] },
    patchFaces: Uint32Array.of(0), evidence: { supporting: [], conflicting: [] }, frameBasis: 'Synthetic test geometry.', slot: { index: 0, count: 1, s: [0, 1] },
    space: { mesiodistal: { value: 2, method: 'synthetic' }, buccolingual: { value: 2 }, crownHeight: { value: 2, method: 'synthetic' } } };
  const prepared = { sites: [original], scans: [] }, before = structuredClone(prepared);
  const selected = engineeringFitSite(prepared, 0, 36);
  assert.equal(selected.fdi, 36); assert.equal(selected.confidence, 0);
  assert.match(selected.frameBasis, /Caller-supplied unreviewed engineering hypothesis/);
  assert.deepEqual(prepared, before);
  for (const changes of [{ status: 'not-scanned' }, { status: 'segmentation-unresolved' }, { anchor: null }, { frame: null }, { patchFaces: new Uint32Array() }, { kind: 'chart' }]) {
    assert.throws(() => engineeringFitSite({ ...prepared, sites: [{ ...original, ...changes }] }, 0, 36), /no forced generation/);
  }
  assert.throws(() => engineeringFitSite(prepared, 0, 16), /match the localized source arch/);
  assert.throws(() => engineeringFitSite(prepared, 1, 36), /outside/);
});
