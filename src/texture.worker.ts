import { decodeTextureEvidence } from './texture-evidence.ts';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<{ bytes: Uint8Array; mimeType: 'image/jpeg' | 'image/png'; uvs: Float32Array }>) => void) | null;
  postMessage: (message: unknown, transfer: ArrayBuffer[]) => void;
};
scope.onmessage = async ({ data }) => {
  try {
    const evidence = await decodeTextureEvidence(data.bytes, data.mimeType, data.uvs);
    scope.postMessage({ evidence }, evidence ? [evidence.colors.buffer as ArrayBuffer, evidence.tissueScores.buffer as ArrayBuffer] : []);
  } catch (error) {
    scope.postMessage({ error: error instanceof Error ? error.message : String(error) }, []);
  }
};
