import { generateRestoration } from './restoration-geometry.ts';
import type { RestorationMesh, RestorationSpec } from './restoration-types';

type Request = { id: number; spec: RestorationSpec };
type Response = { id: number; components: RestorationMesh[] } | { id: number; error: string };
const worker = globalThis as unknown as {
  onmessage: ((event: MessageEvent<Request>) => void) | null;
  postMessage: (response: Response, transfer: ArrayBuffer[]) => void;
};

worker.onmessage = ({ data }) => {
  const id = data?.id;
  try {
    if (!Number.isSafeInteger(id)) throw new Error('Restoration request ID must be a safe integer.');
    const components = generateRestoration(data.spec);
    worker.postMessage({ id, components }, components.flatMap(mesh => [mesh.positions.buffer as ArrayBuffer, mesh.normals.buffer as ArrayBuffer]));
  } catch (error) {
    worker.postMessage({ id, error: error instanceof Error ? error.message : String(error) }, []);
  }
};
