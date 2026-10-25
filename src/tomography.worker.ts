import { DicomImportError, importDicomVolume } from './dicom-volume.ts';
import { extractTomographySurface } from './tomography-geometry.ts';
import type { TomographyVolume, TomographyWorkerRequest, TomographyWorkerResponse } from './tomography-types.ts';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<TomographyWorkerRequest>) => void) | null;
  postMessage: (message: TomographyWorkerResponse, transfer?: Transferable[]) => void;
};
let cached: TomographyVolume | null = null;
let controller: AbortController | null = null;
let activeRequest = 0;

scope.onmessage = async ({ data }) => {
  if (data.type === 'clear') { activeRequest++; controller?.abort(); cached = null; return; }
  if (data.type === 'cancel') { activeRequest++; controller?.abort(); return; }
  const requestId = data.requestId;
  activeRequest = requestId;
  controller?.abort(); controller = new AbortController();
  try {
    if (data.type === 'import') {
      cached = null;
      const result = await importDicomVolume(data.files, {
        allowIncompletePreview: data.allowIncompletePreview, seriesId: data.seriesId, signal: controller.signal,
        onProgress: message => { if (activeRequest === requestId) scope.postMessage({ type: 'progress', requestId, message }); },
      });
      if (activeRequest !== requestId) return;
      cached = result.volume;
      // One structured clone gives the UI its own immutable volume. The worker
      // retains this cache, so changing thresholds normally sends only scalars.
      scope.postMessage({ type: 'imported', requestId, ...result });
    } else {
      if (data.volume) cached = data.volume;
      if (!cached || cached.id !== data.volumeId) throw new Error('Volume cache unavailable. Reimport the local volume.');
      const surface = extractTomographySurface(cached, { threshold: data.threshold, stride: data.stride, shouldCancel: () => activeRequest !== requestId });
      if (activeRequest !== requestId) return;
      scope.postMessage({ type: 'surface', requestId, surface }, [surface.positions.buffer as ArrayBuffer, surface.normals.buffer as ArrayBuffer]);
    }
  } catch (cause) {
    if (activeRequest !== requestId || (cause instanceof Error && cause.name === 'AbortError')) return;
    if (cause instanceof DicomImportError && cause.code === 'series-selection') {
      scope.postMessage({ type: 'selection', requestId, seriesChoices: cause.seriesChoices, message: cause.message });
    } else {
      // Parser exceptions can contain source header text. Never forward them.
      const message = cause instanceof DicomImportError ? cause.message : data.type === 'extract' && cause instanceof Error ? cause.message : 'Local DICOM import failed. Check the native single-frame files and geometry.';
      scope.postMessage({ type: 'error', requestId, message, seriesChoices: cause instanceof DicomImportError ? cause.seriesChoices : undefined });
    }
  }
};
