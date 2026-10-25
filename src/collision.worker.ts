import { analyzeCollisions } from './collision.ts';
import type { CollisionPart, CollisionReport } from './collision.ts';

interface Request { id: number; parts: CollisionPart[]; tolerance: number }
type Response = { id: number; report: CollisionReport } | { id: number; error: string };

// Explicit scope typing works with either DOM or WebWorker TypeScript libraries.
const worker = globalThis as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage: (message: Response, transfer: ArrayBuffer[]) => void;
};

worker.onmessage = ({ data: { id, parts, tolerance } }) => {
  try {
    const report = analyzeCollisions(parts, tolerance);
    const transfer = report.parts.flatMap(p => [p.distances.buffer as ArrayBuffer, p.intersecting.buffer as ArrayBuffer]);
    worker.postMessage({ id, report }, transfer);
  } catch (error) {
    worker.postMessage({ id, error: error instanceof Error ? error.message : String(error) }, []);
  }
};
