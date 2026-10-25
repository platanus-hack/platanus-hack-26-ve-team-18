import { boundaryRegion, brushFaces } from './tooth-geometry.ts';
import type { SurfaceAnchor } from './tooth-types';

type Request =
  | { id: number; operation: 'brush'; positions: Float32Array; hits: SurfaceAnchor[]; radius: number }
  | { id: number; operation: 'boundary'; positions: Float32Array; boundary: SurfaceAnchor[]; seed: SurfaceAnchor };
type Response = { id: number; faces: Uint32Array; boundary?: Float32Array } | { id: number; error: string };

const worker = globalThis as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage: (message: Response, transfer: ArrayBuffer[]) => void;
};

worker.onmessage = ({ data }) => {
  const id = data?.id;
  try {
    if (!Number.isSafeInteger(id)) throw new Error('Selection request ID must be a safe integer.');
    if (data.operation === 'brush') {
      const faces = brushFaces(data.positions, data.hits, data.radius);
      worker.postMessage({ id, faces }, [faces.buffer as ArrayBuffer]);
    } else if (data.operation === 'boundary') {
      const result = boundaryRegion(data.positions, data.boundary, data.seed);
      worker.postMessage({ id, ...result }, [result.faces.buffer as ArrayBuffer, result.boundary.buffer as ArrayBuffer]);
    } else {
      throw new Error('Unknown surface selection operation.');
    }
  } catch (error) {
    worker.postMessage({ id, error: error instanceof Error ? error.message : String(error) }, []);
  }
};
