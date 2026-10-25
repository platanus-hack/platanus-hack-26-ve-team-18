import { prepareCase, preparationTransfers } from './case-preparation';
import type { CasePreparationRequest, CasePreparationResponse } from './case-preparation-types';

// Synchronous local executor. The host terminates this worker on dependency
// changes; queued abort messages cannot interrupt blocked geometry work.
self.onmessage = (event: MessageEvent<CasePreparationRequest>) => {
  const request = event.data;
  try {
    const result = prepareCase(request);
    self.postMessage(result, { transfer: preparationTransfers(result) });
  } catch (error) {
    const result: CasePreparationResponse = { id: request.id, revision: request.revision, error: error instanceof Error ? error.message : 'Case preparation stopped.' };
    self.postMessage(result);
  }
};
