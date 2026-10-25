import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { CbctAutoAlignmentInput, CbctAutoAlignmentResult } from './cbct-auto-alignment';
import type { ModelPart } from './models';
import { posedPositions } from './pose';
import { scanSourceGroups } from './scan-groups';
import type { TomographyVolume } from './tomography-types';

interface Options {
  parts: ModelPart[];
  volume: TomographyVolume | null;
  mmPerUnit: number | null;
  disabled: boolean;
  /**
   * Default false. Gate automatic scheduling until initial bite registration is
   * ready; try each source/volume/scale key once. Does not cancel an active fit.
   * Pose/display edits never re-arm it.
   * Public cancel suppresses this source/volume/scale key, including while waiting.
   */
  automatic?: boolean;
  onAligned: (result: CbctAutoAlignmentResult) => void;
}

const isSource = (part: ModelPart) => !part.reference && !part.restoration
  && (part.role === 'upper' || part.role === 'lower' || part.role === 'model' || part.role === undefined);
// Bite geometry establishes the optical pose even though it is not sampled by
// the CBCT worker. A newly imported/replaced bite must re-arm the later fit.
const isDependency = (part: ModelPart) => isSource(part)
  || (!part.reference && !part.restoration && part.role === 'bite');
const readable = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
// Geometry buffers are immutable. Copy the small transform values into the key,
// ignoring display fields so visibility, colors and names do not cancel work.
const sourceIdentity = (part: ModelPart) => ({
  id: part.id, sourceFileId: part.sourceFileId, positions: part.positions, role: part.role,
  transform: JSON.stringify([part.pose ?? null, part.offset, part.rotation ?? null]),
});
const inputIdentity = ({ parts, volume, mmPerUnit, disabled }: Options) => ({
  volume, voxels: volume?.voxels, mmPerUnit, disabled,
  sources: parts.filter(isDependency).map(sourceIdentity).sort((a, b) => a.id.localeCompare(b.id)),
});
type InputIdentity = ReturnType<typeof inputIdentity>;
// An automatic fit changes poses itself. Only immutable source inputs can make
// it eligible again; display edits and source reordering never do.
const sameAutomaticInputs = (a: InputIdentity, b: InputIdentity) => a.volume === b.volume && a.voxels === b.voxels
  && a.mmPerUnit === b.mmPerUnit && a.sources.length === b.sources.length
  && a.sources.every((source, index) => {
    const next = b.sources[index];
    return source.id === next.id && source.sourceFileId === next.sourceFileId && source.positions === next.positions && source.role === next.role;
  });
const sameGeometryInputs = (a: InputIdentity, b: InputIdentity) => sameAutomaticInputs(a, b)
  && a.sources.every((source, index) => source.transform === b.sources[index].transform);
const sameInputs = (a: InputIdentity, b: InputIdentity) => a.disabled === b.disabled && sameGeometryInputs(a, b);

interface Job {
  id: number;
  revision: number;
  geometryRevision: number;
  automatic: boolean;
  worker: Worker;
  timeout?: ReturnType<typeof setTimeout>;
}
type WorkerResponse = { id: number; result: CbctAutoAlignmentResult } | { id: number; error: string };

/** Local alignment; each worker owns disposable copies of its inputs. */
export function useCbctAlignment(options: Options) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = useRef<Job | null>(null);
  const sequence = useRef(0);
  const alive = useRef(true);
  const attempted = useRef<InputIdentity | null>(null);
  const resumeRevision = useRef<number | null>(null);
  const inputs = inputIdentity(options);
  const observed = useRef({ inputs, revision: 0, geometryRevision: 0 });
  if (!sameInputs(observed.current.inputs, inputs)) observed.current = {
    inputs, revision: observed.current.revision + 1,
    // Keep this monotonic too: a pose changed and restored before effects flush
    // must not be mistaken for interruption solely by temporary unavailability.
    geometryRevision: observed.current.geometryRevision + (sameGeometryInputs(observed.current.inputs, inputs) ? 0 : 1),
  };
  const latest = useRef({ ...options, ...observed.current });
  latest.current = { ...options, ...observed.current };

  const stop = useCallback(() => {
    const job = active.current;
    active.current = null;
    if (!job) return;
    clearTimeout(job.timeout);
    job.worker.onmessage = null; job.worker.onerror = null; job.worker.onmessageerror = null;
    job.worker.terminate();
  }, []);
  const clear = useCallback(() => {
    stop();
    if (alive.current) { setBusy(false); setError(''); }
  }, [stop]);
  const cancel = useCallback(() => {
    // Also suppress a fit that is waiting for readiness. Calling this before a
    // source update suppresses the old key, leaving the new sources eligible.
    attempted.current = latest.current.inputs;
    resumeRevision.current = null;
    clear();
  }, [clear]);
  const deferInterruptedAutomatic = useCallback(() => {
    const job = active.current;
    if (job?.automatic && job.geometryRevision === latest.current.geometryRevision) resumeRevision.current = job.geometryRevision;
  }, []);

  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // React's effect replay may mount again with the same refs. An unfinished
      // automatic job must remain eligible after this lifecycle-only cleanup.
      deferInterruptedAutomatic();
      stop();
    };
  }, [deferInterruptedAutomatic, stop]);
  useLayoutEffect(() => {
    if (active.current && active.current.revision !== latest.current.revision) {
      deferInterruptedAutomatic();
      clear();
    }
  });

  const start = useCallback((automatic: boolean) => {
    if (!alive.current) return;
    clear();
    // Read both the source parts and the callback from the newest render, even
    // if that render's effects have not flushed when this function is invoked.
    const current = latest.current;
    if (current.disabled) { setError('CBCT alignment is currently unavailable. Finish the current operation before retrying.'); return; }
    if (!current.volume) { setError('Import a CBCT volume before running alignment.'); return; }
    if (current.mmPerUnit === null || !Number.isFinite(current.mmPerUnit) || current.mmPerUnit <= 0) {
      setError('Set a positive millimeters-per-file-unit scale before running CBCT alignment.'); return;
    }
    const parts = current.parts.filter(isSource);
    if (!parts.length) { setError('Import an upper, lower, or other source mesh before running CBCT alignment.'); return; }

    // Manual runs count as attempts as well, but can always retry this key.
    // Mark before worker setup so construction/transfer failures cannot loop.
    attempted.current = current.inputs;
    resumeRevision.current = null;
    try {
      const instance = new Worker(new URL('./cbct-alignment.worker.ts', import.meta.url), { type: 'module' });
      const job: Job = { id: ++sequence.current, revision: current.revision, geometryRevision: current.geometryRevision, automatic, worker: instance };
      active.current = job;
      setBusy(true);
      const isCurrent = () => alive.current && active.current === job && !latest.current.disabled && job.revision === latest.current.revision;
      const finish = () => {
        if (active.current !== job) return;
        // A stale response can arrive after render but before layout cleanup.
        // Resume only availability-interrupted automatic work, never pose edits.
        if (job.revision !== latest.current.revision) deferInterruptedAutomatic();
        stop();
        if (alive.current) setBusy(false);
      };
      const fail = (message: string) => {
        const valid = isCurrent();
        finish();
        if (valid) setError(message);
      };
      instance.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
        if (!isCurrent()) { finish(); return; }
        if (data.id !== job.id) return;
        finish();
        if ('error' in data) { setError(data.error || 'CBCT alignment failed. Retry alignment.'); return; }
        try { latest.current.onAligned(data.result); }
        catch (cause) { if (alive.current && sequence.current === job.id) setError(`Could not apply CBCT alignment: ${readable(cause)}`); }
      };
      instance.onerror = event => fail(event.message ? `CBCT alignment failed: ${event.message}` : 'CBCT alignment stopped unexpectedly. Retry with fewer or simpler source meshes.');
      instance.onmessageerror = () => fail('CBCT alignment returned unreadable data. Retry alignment.');
      job.timeout = setTimeout(() => fail('CBCT alignment exceeded 45 seconds. Try fewer or simpler source meshes and retry.'), 45_000);

      const voxels = current.volume.voxels.slice();
      const sources = scanSourceGroups(parts).map(group => {
        const positions = new Float64Array(group.reduce((length, part) => length + part.positions.length, 0));
        let offset = 0;
        for (const part of group) { positions.set(posedPositions(part), offset); offset += part.positions.length; }
        return { id: group[0].sourceFileId ?? group[0].id, positions };
      });
      const input: CbctAutoAlignmentInput = { volume: { ...current.volume, voxels }, sources, mmPerUnit: current.mmPerUnit };
      // posedPositions allocates new Float64Array buffers; imported mesh and
      // volume buffers remain attached and usable by rendering and later runs.
      instance.postMessage({ id: job.id, ...input }, [voxels.buffer, ...sources.map(source => source.positions.buffer as ArrayBuffer)]);
    } catch (cause) {
      stop();
      if (alive.current) { setBusy(false); setError(`Could not start CBCT alignment: ${readable(cause)}`); }
    }
  }, [clear, deferInterruptedAutomatic, stop]);
  const run = useCallback(() => start(false), [start]);

  useLayoutEffect(() => {
    const current = latest.current;
    if (!current.automatic || current.disabled || !current.volume || current.mmPerUnit === null
      || !Number.isFinite(current.mmPerUnit) || current.mmPerUnit <= 0 || !current.parts.some(isSource)
      || active.current || (attempted.current && sameAutomaticInputs(attempted.current, current.inputs)
        && resumeRevision.current !== current.geometryRevision)) return;
    start(true);
  });

  return { busy, error, run, cancel };
}
