import { refineBiteAlignment } from './bite-alignment.ts';
import type { BiteAlignmentRequest, BiteAlignmentResponse } from './bite-alignment.ts';

const worker = globalThis as unknown as {
  onmessage: ((event: MessageEvent<BiteAlignmentRequest>) => void) | null;
  postMessage: (message: BiteAlignmentResponse) => void;
};

// A request produces both arch deltas or one error. The caller terminates stale workers.
worker.onmessage = ({ data: { id, ...input } }) => {
  try {
    worker.postMessage({ id, result: refineBiteAlignment(input) });
  } catch (error) {
    worker.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
