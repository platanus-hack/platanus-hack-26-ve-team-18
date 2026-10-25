import { useCallback, useEffect, useRef, useState } from 'react';
import type { TomographySeriesChoice, TomographyStatus, TomographySurface, TomographyVolume, TomographyWorkerRequest, TomographyWorkerResponse } from './tomography-types';

const IMPORT_TIMEOUT_MS = 120_000;
const SURFACE_TIMEOUT_MS = 60_000;

/** Starts empty; all DICOM input and processing remain local to this browser. */
export function useTomography() {
  const [volume, setVolume] = useState<TomographyVolume | null>(null);
  const [surface, setSurface] = useState<TomographySurface | null>(null);
  const [loading, setLoading] = useState(false);
  const [surfaceBusy, setSurfaceBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<TomographyStatus>('empty');
  const [progress, setProgress] = useState('');
  const [seriesChoices, setSeriesChoices] = useState<TomographySeriesChoice[]>([]);
  const [threshold, setThreshold] = useState(700);
  // Explicit, visible preview setting. Never changed to satisfy capacity limits.
  const [stride, setStride] = useState(4);
  const worker = useRef<Worker | null>(null);
  const cacheId = useRef<string | null>(null);
  const operation = useRef<'import' | 'extract' | null>(null);
  const sequence = useRef(0);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const alive = useRef(true);
  const currentVolume = useRef(volume); currentVolume.current = volume;

  const terminate = useCallback(() => {
    sequence.current++; clearTimeout(timeout.current); clearTimeout(debounce.current);
    worker.current?.terminate(); worker.current = null; cacheId.current = null; operation.current = null;
  }, []);
  const finish = useCallback(() => {
    clearTimeout(timeout.current); operation.current = null; setLoading(false); setSurfaceBusy(false); setProgress('');
  }, []);
  const ensureWorker = useCallback(() => {
    if (worker.current) return worker.current;
    const instance = new Worker(new URL('./tomography.worker.ts', import.meta.url), { type: 'module' });
    worker.current = instance;
    instance.onmessage = ({ data }: MessageEvent<TomographyWorkerResponse>) => {
      if (!alive.current || worker.current !== instance || data.requestId !== sequence.current) return;
      if (data.type === 'progress') { setProgress(data.message); return; }
      const wasImport = operation.current === 'import';
      finish();
      if (data.type === 'imported') {
        cacheId.current = data.volume.id; currentVolume.current = data.volume;
        setVolume(data.volume); setSeriesChoices(data.seriesChoices); setError('');
        setStatus(data.volume.complete ? 'ready' : 'incomplete-preview');
      } else if (data.type === 'selection') {
        setSeriesChoices(data.seriesChoices); setStatus('select-series'); setProgress(data.message);
      } else if (data.type === 'surface') {
        setSurface(data.surface); setError(''); setStatus(currentVolume.current?.complete ? 'ready' : 'incomplete-preview');
      } else {
        if (data.seriesChoices?.length) setSeriesChoices(data.seriesChoices);
        if (wasImport) cacheId.current = null;
        setError(data.message); setStatus('error');
      }
    };
    instance.onerror = () => {
      if (!alive.current || worker.current !== instance) return;
      terminate(); finish(); setError('Local tomography worker stopped. Retry the import or choose a larger preview stride.'); setStatus('error');
    };
    instance.onmessageerror = () => {
      if (!alive.current || worker.current !== instance) return;
      terminate(); finish(); setError('Local tomography worker could not transfer the volume. Choose a smaller stack.'); setStatus('error');
    };
    return instance;
  }, [finish, terminate]);

  const armTimeout = useCallback((id: number, milliseconds: number) => {
    clearTimeout(timeout.current);
    timeout.current = setTimeout(() => {
      if (!alive.current || sequence.current !== id) return;
      const importing = operation.current === 'import'; terminate(); finish();
      setError(importing ? 'Local DICOM import exceeded two minutes. Choose a smaller native stack.' : 'Threshold extraction exceeded one minute. Choose a larger preview stride explicitly.'); setStatus('error');
    }, milliseconds);
  }, [finish, terminate]);

  const importFiles = useCallback((files: File[] | FileList, allowIncompletePreview = true, seriesId?: string) => {
    terminate(); setVolume(null); currentVolume.current = null; setSurface(null); setSeriesChoices([]); setError('');
    if (!files.length) { setLoading(false); setSurfaceBusy(false); setStatus('empty'); setProgress(''); return; }
    setLoading(true); setSurfaceBusy(false); setStatus('importing'); setProgress('Inspecting local DICOM headers…');
    const id = ++sequence.current;
    try {
      const instance = ensureWorker(); operation.current = 'import';
      const request: TomographyWorkerRequest = { type: 'import', requestId: id, files: Array.from(files), allowIncompletePreview, seriesId };
      instance.postMessage(request); armTimeout(id, IMPORT_TIMEOUT_MS);
    } catch { terminate(); finish(); setError('Unable to start local DICOM import. This browser must support module workers.'); setStatus('error'); }
  }, [armTimeout, ensureWorker, finish, terminate]);

  const cancel = useCallback(() => {
    terminate(); finish(); setStatus('cancelled');
  }, [finish, terminate]);
  const clear = useCallback(() => {
    terminate(); finish(); currentVolume.current = null; setVolume(null); setSurface(null); setSeriesChoices([]); setError(''); setStatus('empty');
  }, [finish, terminate]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; terminate(); };
  }, [terminate]);

  useEffect(() => {
    if (!volume) return;
    // A synchronous extraction must be terminated to cancel its CPU work. Idle
    // workers keep their volume cache; a cancelled worker is restored once from
    // the retained UI copy. Debouncing avoids copying on every slider event.
    if (operation.current === 'extract') terminate();
    setSurface(null); setError(''); setSurfaceBusy(true); setStatus('extracting'); setProgress('Preparing threshold surface…');
    const id = ++sequence.current;
    let instance: Worker | null = null;
    debounce.current = setTimeout(() => {
      if (!alive.current || sequence.current !== id) return;
      if (!Number.isFinite(threshold) || !Number.isInteger(stride) || stride < 1 || stride > 8) {
        finish(); setError('Choose a finite threshold and an integer preview stride from 1 to 8.'); setStatus('error'); return;
      }
      try {
        instance = ensureWorker(); operation.current = 'extract';
        const request: TomographyWorkerRequest = { type: 'extract', requestId: id, volumeId: volume.id, threshold, stride };
        if (cacheId.current !== volume.id) {
          // Transfer the one explicit cache copy; never detach UI voxel data.
          const voxels = volume.voxels.slice(); request.volume = { ...volume, voxels };
          instance.postMessage(request, [voxels.buffer]); cacheId.current = volume.id;
        } else instance.postMessage(request);
        armTimeout(id, SURFACE_TIMEOUT_MS);
      } catch { terminate(); finish(); setError('Unable to prepare the local threshold surface. Choose a smaller volume.'); setStatus('error'); }
    }, 200);
    return () => {
      clearTimeout(debounce.current);
      if (instance && worker.current === instance && operation.current === 'extract') terminate();
    };
  }, [volume, threshold, stride, armTimeout, ensureWorker, finish, terminate]);

  return { volume, loading, surfaceBusy, error, status, progress, seriesChoices, importFiles, cancel, clear, threshold, setThreshold, stride, setStride, surface };
}
