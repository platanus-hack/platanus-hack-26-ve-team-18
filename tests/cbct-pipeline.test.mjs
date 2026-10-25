import test from 'node:test';
import assert from 'node:assert/strict';
import { cbctPipelineStage } from '../src/cbct-pipeline.ts';

const base = {
  loading: false,
  status: 'ready',
  progress: '',
  error: '',
  volume: null,
  surface: null,
  surfaceBusy: false,
  alignBusy: false,
  alignError: '',
  biteAligning: false,
  waitingForBite: false,
  scaleKnown: true,
  hasScans: true,
  aligned: false,
};
const volume = { id: 'v1' };
const surface = { threshold: 700 };

test('idle with no volume reports null', () => {
  assert.equal(cbctPipelineStage(base), null);
});

test('volume without surface is still rendering', () => {
  const state = cbctPipelineStage({ ...base, volume, progress: '' });
  assert.equal(state.stage, 'rendering');
  assert.equal(state.detail, 'Reconstructing threshold surface…');
  const busy = cbctPipelineStage({ ...base, volume, surfaceBusy: true, progress: 'Marching cubes…' });
  assert.equal(busy.stage, 'rendering');
  assert.equal(busy.detail, 'Marching cubes…');
});

test('loading takes precedence and reports worker progress', () => {
  const state = cbctPipelineStage({ ...base, loading: true, progress: 'Inspecting local DICOM headers…' });
  assert.equal(state.stage, 'loading');
  assert.equal(state.detail, 'Inspecting local DICOM headers…');
  assert.equal(cbctPipelineStage({ ...base, loading: true }).detail, 'Reading CBCT slices…');
});

test('select-series pauses on the loading step', () => {
  const state = cbctPipelineStage({ ...base, status: 'select-series' });
  assert.equal(state.stage, 'series');
});

test('any error beats every other state', () => {
  assert.deepEqual(cbctPipelineStage({ ...base, error: 'Import failed', loading: true }), { stage: 'error', detail: 'Import failed' });
  assert.deepEqual(cbctPipelineStage({ ...base, alignError: 'Fit diverged', alignBusy: true }), { stage: 'error', detail: 'Fit diverged' });
});

test('active alignment outranks rendering state', () => {
  const state = cbctPipelineStage({ ...base, volume, surfaceBusy: true, alignBusy: true });
  assert.equal(state.stage, 'aligning');
  assert.equal(state.detail, 'Fitting scans to CBCT jaw region…');
});

test('aligned volume and surface completes the pipeline', () => {
  const state = cbctPipelineStage({ ...base, volume, surface, aligned: true });
  assert.deepEqual(state, { stage: 'done', detail: 'Scans superimposed on CBCT' });
});

test('cbct without 3d scans finishes with guidance', () => {
  const state = cbctPipelineStage({ ...base, volume, surface, hasScans: false });
  assert.equal(state.stage, 'done');
  assert.match(state.detail, /add 3D scans/i);
});

test('rendered scans wait honestly for bite, scale, and bite refinement', () => {
  const waiting = cbctPipelineStage({ ...base, volume, surface, waitingForBite: true });
  assert.equal(waiting.stage, 'aligning');
  assert.equal(waiting.detail, 'Waiting for bite registration…');
  const noScale = cbctPipelineStage({ ...base, volume, surface, scaleKnown: false });
  assert.equal(noScale.detail, 'Confirm the scan scale to align');
  const bite = cbctPipelineStage({ ...base, volume, surface, biteAligning: true, waitingForBite: true });
  assert.equal(bite.detail, 'Refining scan pose to bite references…');
});

test('ready but not yet running reports pending alignment', () => {
  const state = cbctPipelineStage({ ...base, volume, surface });
  assert.deepEqual(state, { stage: 'aligning', detail: 'Alignment pending' });
});
