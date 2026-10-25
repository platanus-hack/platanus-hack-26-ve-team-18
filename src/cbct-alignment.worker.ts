import { alignOpticalScansToCbct, type CbctAutoAlignmentInput, type CbctAutoAlignmentResult } from './cbct-auto-alignment.ts';

export type CbctAlignmentWorkerRequest = CbctAutoAlignmentInput & { id: number };
export type CbctAlignmentWorkerResponse = { id: number; result: CbctAutoAlignmentResult } | { id: number; error: string };

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<CbctAlignmentWorkerRequest>) => void) | null;
  postMessage: (message: CbctAlignmentWorkerResponse) => void;
};

// This work is synchronous. The owner terminates/replaces the worker to cancel
// stale requests or enforce its outer timeout; a queued cancel cannot interrupt it.
scope.onmessage = ({ data }) => {
  try {
    scope.postMessage({ id: data.id, result: alignOpticalScansToCbct(data) });
  } catch (cause) {
    scope.postMessage({ id: data.id, error: cause instanceof Error ? cause.message : 'Local automatic CBCT alignment failed.' });
  }
};
