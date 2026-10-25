/** Local image evidence only. Redness is a weak gingiva cue, never a diagnosis. */
export type TexturePixels = { width: number; height: number; data: Uint8Array | Uint8ClampedArray };
export type TextureEvidence = { colors: Float32Array; tissueScores: Float32Array };

export const MAX_TEXTURE_BYTES = 16 * 1024 * 1024;
// Bound the canvas/readback allocation independently of compressed file size.
export const MAX_TEXTURE_PIXELS = 16_777_216;

function linear(value: number): number {
  value /= 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function srgb(value: number): number {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
}

/** Linear RGB in, -1 unknown or 0..1 redness evidence out. */
export function gingivaColorCue(r: number, g: number, b: number): number {
  if (![r, g, b].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) return -1;
  const red = srgb(r), green = srgb(g), blue = srgb(b);
  // Black atlas padding, deep shadows, and near-black scan holes are unknown.
  if (Math.max(red, green, blue) < 0.12) return -1;
  const excess = red - Math.max(green, blue);
  // Warm ivory is not treated as red tissue. Low scores are only a color cue.
  return Math.max(0, Math.min(1, (excess - 0.09) / 0.22));
}

/** Per-corner linear colors retain face order, including duplicated seam vertices. */
export function tissueScoresFromColors(colors: Float32Array): Float32Array {
  if (colors.length % 9) throw new Error('Corner colors must contain RGB for every triangle corner.');
  const scores = new Float32Array(colors.length / 9).fill(-1);
  for (let face = 0; face < scores.length; face++) {
    let sum = 0, valid = 0;
    for (let corner = 0; corner < 3; corner++) {
      const offset = face * 9 + corner * 3;
      const score = gingivaColorCue(colors[offset], colors[offset + 1], colors[offset + 2]);
      if (score >= 0) { sum += score; valid++; }
    }
    if (valid === 3) scores[face] = sum / valid;
  }
  return scores;
}

/**
 * Samples conventional bottom-left OBJ/PLY UVs against top-left image rows.
 * Each corner is sampled independently: geometric welding never merges UV seams.
 * Outside-atlas coordinates and transparent/black padding provide no tissue cue.
 */
export function sampleTextureEvidence(uvs: Float32Array, pixels: TexturePixels): TextureEvidence {
  const { width, height, data } = pixels;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_TEXTURE_PIXELS || data.length !== width * height * 4) {
    throw new Error('Invalid or oversized decoded texture pixels.');
  }
  if (uvs.length % 6) throw new Error('UVs must contain a pair for every triangle corner.');
  const colors = new Float32Array(uvs.length / 2 * 3);
  const tissueScores = new Float32Array(uvs.length / 6).fill(-1);
  function sample(u: number, v: number): [number, number, number, number] {
    if (!Number.isFinite(u) || !Number.isFinite(v) || u < 0 || u > 1 || v < 0 || v > 1) return [0, 0, 0, -1];
    // Nearest texel avoids mixing atlas islands with unrelated padding evidence.
    const x = Math.min(width - 1, Math.floor(u * width));
    const y = Math.min(height - 1, Math.floor((1 - v) * height));
    const offset = (y * width + x) * 4;
    const r = linear(data[offset]), g = linear(data[offset + 1]), b = linear(data[offset + 2]);
    return [r, g, b, data[offset + 3] < 128 ? -1 : gingivaColorCue(r, g, b)];
  }
  for (let face = 0; face < tissueScores.length; face++) {
    let sum = 0, valid = 0, u = 0, v = 0;
    for (let corner = 0; corner < 3; corner++) {
      const offset = face * 6 + corner * 2;
      const sampled = sample(uvs[offset], uvs[offset + 1]);
      const colorOffset = face * 9 + corner * 3;
      colors[colorOffset] = sampled[0];
      colors[colorOffset + 1] = sampled[1];
      colors[colorOffset + 2] = sampled[2];
      if (sampled[3] >= 0) { sum += sampled[3]; valid++; }
      u += uvs[offset] / 3;
      v += uvs[offset + 1] / 3;
    }
    const center = sample(u, v)[3];
    if (center >= 0) { sum += center; valid++; }
    // A valid centroid cannot repair an invalid corner: that triangle may cross
    // an atlas border, padding or a transparent hole. Keep its cue unknown.
    if (valid === 4) tissueScores[face] = sum / valid;
  }
  return { colors, tissueScores };
}

export async function decodeTextureEvidence(bytes: Uint8Array, mimeType: 'image/jpeg' | 'image/png', uvs: Float32Array): Promise<TextureEvidence & { width: number; height: number } | null> {
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_TEXTURE_BYTES) throw new Error('Texture must contain between 1 byte and 16 MiB of local image data.');
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return null;
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: mimeType }), { imageOrientation: 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  try {
    if (bitmap.width * bitmap.height > MAX_TEXTURE_PIXELS) throw new Error('Texture exceeds the 16 megapixel decoded image limit.');
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Local texture pixel decoding is unavailable.');
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height);
    return { ...sampleTextureEvidence(uvs, pixels), width: bitmap.width, height: bitmap.height };
  } finally { bitmap.close(); }
}
