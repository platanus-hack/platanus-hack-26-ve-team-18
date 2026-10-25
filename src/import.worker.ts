import { importModels } from './import-models.ts';
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<File[]>) => void) | null;
  postMessage: (message: unknown, transfer: ArrayBuffer[]) => void;
};
scope.onmessage = async ({ data }) => {
  try {
    const result = await importModels(data);
    const transfer = new Set<ArrayBuffer>();
    for (const part of result.parts) {
      for (const array of [part.positions, part.normals, part.uvs, part.colors, part.tissueScores, part.texture?.bytes]) {
        if (array) transfer.add(array.buffer as ArrayBuffer);
      }
    }
    scope.postMessage({ result }, [...transfer]);
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : String(error) }, []);
  }
};
