import { RestorationFitCancelled } from './restoration-fitting.ts';
import { fitRestorationToGoals } from './restoration-goal-fitting.ts';
import type { RestorationFitWorkerRequest, RestorationFitWorkerResponse } from './restoration-types';
import { fittingSurfaces, withAIGenerationDesign, withPatientDonor, withQualityContext } from './workflow-geometry.ts';
import { measureRestorationRelationships, RestorationRelationshipsCancelled } from './restoration-relationships.ts';

let active: { id: number; cancelled: boolean } | null = null;
const send = (message: RestorationFitWorkerResponse, transfer: ArrayBuffer[] = []) => globalThis.postMessage(message, { transfer });
globalThis.onmessage = (event: MessageEvent<RestorationFitWorkerRequest>) => {
  const data = event.data;
  const id = data?.id;
  if (!data || !Number.isSafeInteger(data.id)) {
    send({ type: 'error', id: data?.id, error: 'Restoration fitting request ID must be a safe integer.' });
    return;
  }
  if (data.type === 'cancel') {
    if (active?.id === data.id) active.cancelled = true;
    return;
  }
  if (data.type !== 'fit' && data.type !== 'prepare-fit') { send({ type: 'error', id, error: 'Unknown restoration fitting request.' }); return; }
  if (active) active.cancelled = true;
  const job = { id: data.id, cancelled: false };
  active = job;
  const prepare = async () => {
    if (data.type === 'fit') return data.input;
    const anatomySpec = data.generationDesign !== undefined
      ? withAIGenerationDesign(data.spec, data.site, data.scans, data.parts, data.generationDesign)
      : data.spec.crownShape || data.spec.provenance === 'clinician-entered'
        ? data.spec : withPatientDonor(data.spec, data.site, data.scans, data.parts);
    const spec = withQualityContext(anatomySpec, data.site, data.scans);
    const surfaces = fittingSurfaces(spec, data.parts, data.teeth, data.site, data.scans);
    return { spec, surfaces, goalContract: data.goalContract, options: data.generationDesign !== undefined
      ? { ...data.options, maxCandidates: 1, verifyBaselineIntersections: true } : data.options };
  };
  const control = {
    checkCancelled: () => job.cancelled || active !== job,
    onPhase: (phase: 'creating' | 'fitting') => {
      if (!job.cancelled && active === job) send({ type: 'progress', id: job.id, phase, fdi: data.type === 'fit' ? data.input.spec.fdi : data.spec.fdi });
    },
  };
  const operation = prepare().then(async input => {
    if (!job.cancelled && active === job) send({ type: 'targets', id: job.id, targetIds: input.surfaces.map(surface => surface.id) });
    const result = await fitRestorationToGoals({ ...input, options: { ...input.options,
      verifyBaselineIntersections: input.options?.verifyBaselineIntersections ?? input.options?.maxCandidates === 1 } }, control);
    result.report.relationships = await measureRestorationRelationships({ spec: result.spec, components: result.components, surfaces: input.surfaces },
      { checkCancelled: control.checkCancelled, yieldControl: () => new Promise(resolve => setTimeout(resolve, 0)) });
    return result;
  });
  void operation.then(result => {
    if (job.cancelled || active !== job) return;
    const transfer: ArrayBuffer[] = [];
    for (const mesh of result.components) {
      for (const array of [mesh.positions, mesh.normals]) {
        const buffer = array.buffer;
        if (!(buffer instanceof ArrayBuffer)) throw new Error('Restoration output requires transferable ArrayBuffers.');
        transfer.push(buffer);
      }
    }
    send({ type: 'result', id: job.id, result }, transfer);
  }).catch((error: unknown) => {
    if (error instanceof RestorationFitCancelled || error instanceof RestorationRelationshipsCancelled) send({ type: 'cancelled', id: job.id });
    else send({ type: 'error', id: job.id, error: error instanceof Error ? error.message : String(error) });
  }).finally(() => { if (active === job) active = null; });
};
