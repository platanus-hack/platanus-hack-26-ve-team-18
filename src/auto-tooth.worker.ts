import { detectToothRegions } from './auto-tooth-geometry.ts';
import type { AutoToothScan, AutoToothSettings } from './auto-tooth-types';

type Request = { id: number; positions: Float32Array; settings: AutoToothSettings; tissueScores?: Float32Array };
type Response = { id: number; scan: AutoToothScan } | { id: number; error: string };
const worker = globalThis as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage: (message: Response, transfer: ArrayBuffer[]) => void;
};

// Synchronous geometry has an internal 8 s budget. The caller owns cancellation:
// terminate this worker for stale requests, with a separate 30 s outer timeout.
worker.onmessage = ({ data }) => {
  const id = data?.id;
  try {
    if (!Number.isSafeInteger(id)) throw new Error('Automatic tooth request ID must be a safe integer.');
    const scan = detectToothRegions(data.positions, data.settings, data.tissueScores);
    worker.postMessage({ id, scan }, scan.candidates.map(candidate => candidate.faces.buffer as ArrayBuffer));
  } catch (error) {
    worker.postMessage({ id, error: error instanceof Error ? error.message : String(error) }, []);
  }
};
