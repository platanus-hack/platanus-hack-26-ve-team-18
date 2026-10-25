import type { ToothRecord } from './tooth-types.ts';

/** Permanent FDI numbers remain valid even when a tooth is marked missing. */
export const FDI_TEETH = Object.freeze([
  11, 12, 13, 14, 15, 16, 17, 18,
  21, 22, 23, 24, 25, 26, 27, 28,
  31, 32, 33, 34, 35, 36, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48,
] as const);

type FdiTooth = typeof FDI_TEETH[number];

export function isFdiTooth(code: unknown): code is FdiTooth {
  return typeof code === 'number' && Number.isInteger(code)
    && code >= 11 && code <= 48 && code % 10 >= 1 && code % 10 <= 8;
}

function requireTooth(code: number): void {
  if (!isFdiTooth(code)) throw new RangeError('Expected a permanent FDI tooth number.');
}

const TOOTH_NAMES = [
  'central incisor', 'lateral incisor', 'canine', 'first premolar',
  'second premolar', 'first molar', 'second molar', 'third molar',
] as const;

export function toothArch(code: number): 'upper' | 'lower' {
  requireTooth(code);
  return code < 30 ? 'upper' : 'lower';
}

/** Left and right refer to the patient. */
export function toothName(code: number): string {
  const arch = toothArch(code) === 'upper' ? 'Upper' : 'Lower';
  const quadrant = Math.floor(code / 10);
  const side = quadrant === 1 || quadrant === 4 ? 'right' : 'left';
  return `${arch} ${side} ${TOOTH_NAMES[code % 10 - 1]}`;
}

export function emptyToothRecord(): ToothRecord {
  return { status: 'unreviewed', restoration: 'none', note: '' };
}

function validateLabels(labels: Uint8Array): void {
  if (!(labels instanceof Uint8Array)) throw new TypeError('Triangle labels must be a Uint8Array.');
  for (const label of labels) {
    if (label !== 0 && label !== 255 && !isFdiTooth(label)) {
      throw new RangeError(`Invalid triangle label: ${label}.`);
    }
  }
}

/** Counts labeled triangles across parts; 0 is unlabeled and 255 is excluded. */
export function toothCounts(labels: Record<string, Uint8Array> | Uint8Array): Record<number, number> {
  const counts: Record<number, number> = {};
  for (const tooth of FDI_TEETH) counts[tooth] = 0;
  const parts = labels instanceof Uint8Array ? [labels] : Object.values(labels);
  for (const part of parts) {
    validateLabels(part);
    for (const label of part) {
      if (isFdiTooth(label)) counts[label] += 1;
    }
  }
  return counts;
}

/** Validate the complete edit before copying or changing any triangle labels. */
export function applyTriangleLabels(
  labels: Uint8Array,
  faces: Uint32Array,
  label: number,
  activeTooth: number,
): Uint8Array {
  requireTooth(activeTooth);
  if (label !== 0 && label !== 255 && label !== activeTooth) {
    throw new RangeError('Requested label must be 0, 255, or the active tooth.');
  }
  validateLabels(labels);
  if (!(faces instanceof Uint32Array)) throw new TypeError('Face indices must be a Uint32Array.');
  for (const face of faces) {
    if (face >= labels.length) throw new RangeError(`Face index out of range: ${face}.`);
  }

  const result = labels.slice();
  for (const face of faces) {
    const current = labels[face];
    const editable = label === 0
      ? current === activeTooth || current === 255
      : current === 0 || current === activeTooth;
    if (editable) result[face] = label;
  }
  return result;
}
