import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FDI_TEETH, toothName, toothArch, isFdiTooth, emptyToothRecord,
  toothCounts, applyTriangleLabels,
} from '../src/teeth.ts';

test('permanent FDI numbers contain all 32 teeth and exclude primary and malformed numbers', () => {
  const expected = [1, 2, 3, 4].flatMap(quadrant =>
    Array.from({ length: 8 }, (_, index) => quadrant * 10 + index + 1));
  assert.deepEqual(FDI_TEETH, expected);
  assert.equal(new Set(FDI_TEETH).size, 32);
  for (const code of expected) assert.equal(isFdiTooth(code), true);
  for (const code of [0, 1, 10, 19, 20, 29, 30, 39, 40, 49, 51, 85, 255, -11, 11.5, NaN, Infinity, '11', null, undefined]) {
    assert.equal(isFdiTooth(code), false, `Invalid FDI number: ${String(code)}`);
  }
});

test('arches and names use the patient’s side in every FDI quadrant', () => {
  const names = ['central incisor', 'lateral incisor', 'canine', 'first premolar',
    'second premolar', 'first molar', 'second molar', 'third molar'];
  for (const [quadrant, arch, side] of [
    [1, 'upper', 'right'], [2, 'upper', 'left'],
    [3, 'lower', 'left'], [4, 'lower', 'right'],
  ]) {
    for (let position = 1; position <= 8; position += 1) {
      const code = quadrant * 10 + position;
      assert.equal(toothArch(code), arch);
      assert.equal(toothName(code).toLowerCase(), `${arch} ${side} ${names[position - 1]}`);
    }
  }
});

test('name and arch helpers reject invalid FDI numbers', () => {
  for (const code of [0, 255, 19, 51, 11.1, NaN, Infinity, '11']) {
    assert.throws(() => toothName(code), RangeError);
    assert.throws(() => toothArch(code), RangeError);
  }
});

test('records start unreviewed and marking a tooth missing retains its FDI identity', () => {
  const record = emptyToothRecord();
  const other = emptyToothRecord();
  assert.deepEqual(record, { status: 'unreviewed', restoration: 'none', note: '' });
  assert.notEqual(record, other);
  const teeth = { 18: record };
  teeth[18].status = 'missing';
  teeth[18].note = 'Reviewed manually';
  assert.equal(isFdiTooth(18), true);
  assert.equal(toothArch(18), 'upper');
  assert.match(toothName(18), /third molar/);
  assert.equal(toothCounts({ scan: new Uint8Array([18]) })[18], 1);
  assert.equal(toothCounts({})[18], 0);
  assert.deepEqual(teeth[18], { status: 'missing', restoration: 'none', note: 'Reviewed manually' });
  assert.deepEqual(other, { status: 'unreviewed', restoration: 'none', note: '' });
});

test('counts aggregate parts, ignore unlabeled/excluded faces, and retain all zero entries', () => {
  const labels = {
    upper: new Uint8Array([0, 11, 11, 18, 255]),
    another: new Uint8Array([11, 31, 48, 255, 0]),
    empty: new Uint8Array(),
  };
  const before = Object.fromEntries(Object.entries(labels).map(([id, part]) => [id, part.slice()]));
  const counts = toothCounts(labels);
  assert.deepEqual(Object.keys(counts).map(Number), FDI_TEETH);
  assert.equal(counts[11], 3);
  assert.equal(counts[18], 1);
  assert.equal(counts[31], 1);
  assert.equal(counts[48], 1);
  assert.equal(counts[12], 0);
  assert.equal(Object.values(counts).reduce((sum, count) => sum + count, 0), 6);
  assert.deepEqual(labels, before);
  assert.ok(Object.values(toothCounts({})).every(count => count === 0));
  assert.deepEqual(toothCounts(new Uint8Array([48, 48, 0, 255])),
    { ...toothCounts({}), 48: 2 });
});

test('counts reject invalid labels in any part', () => {
  for (const invalid of [1, 10, 19, 29, 30, 39, 40, 49, 51, 254]) {
    const labels = { first: new Uint8Array([11]), last: new Uint8Array([48, invalid]) };
    const before = labels.last.slice();
    assert.throws(() => toothCounts(labels), /Invalid triangle label/);
    assert.throws(() => toothCounts(labels.last), /Invalid triangle label/);
    assert.deepEqual(labels.last, before);
  }
});

test('painting, exclusion, and erasing protect every other tooth', () => {
  const active = 11;
  const labels = new Uint8Array([0, ...FDI_TEETH, 255]);
  const original = labels.slice();
  const faces = Uint32Array.from(labels, (_, index) => index);
  for (const requested of [active, 255, 0]) {
    const result = applyTriangleLabels(labels, faces, requested, active);
    assert.notEqual(result, labels);
    assert.notEqual(result.buffer, labels.buffer);
    assert.deepEqual(labels, original);
    for (let face = 0; face < labels.length; face += 1) {
      const current = labels[face];
      if (current !== 0 && current !== active && current !== 255) assert.equal(result[face], current);
    }
    assert.equal(result[0], requested === 0 ? 0 : requested);
    assert.equal(result[1], requested);
    assert.equal(result.at(-1), requested === 0 ? 0 : 255);
  }
});

test('editing selected faces handles the last index and duplicate faces without touching others', () => {
  const labels = new Uint8Array([11, 12, 0, 11, 255, 0]);
  const result = applyTriangleLabels(labels, new Uint32Array([0, 4, 4, 5]), 0, 11);
  assert.deepEqual(result, new Uint8Array([0, 12, 0, 11, 0, 0]));
  assert.deepEqual(labels, new Uint8Array([11, 12, 0, 11, 255, 0]));
  result[1] = 48;
  assert.equal(labels[1], 12);
});

test('successful empty and protected edits still return independent copies', () => {
  const labels = new Uint8Array([12, 255]);
  for (const faces of [new Uint32Array(), new Uint32Array([0, 1])]) {
    const result = applyTriangleLabels(labels, faces, 11, 11);
    assert.deepEqual(result, labels);
    assert.notEqual(result.buffer, labels.buffer);
  }
  const empty = new Uint8Array();
  assert.notEqual(applyTriangleLabels(empty, new Uint32Array(), 0, 48), empty);
});

test('active tooth and requested label are validated even when no faces are selected', () => {
  const labels = new Uint8Array([0, 11, 255]);
  for (const active of [0, 255, 19, 51, 11.1, NaN, Infinity, '11']) {
    assert.throws(() => applyTriangleLabels(labels, new Uint32Array(), 0, active), RangeError);
  }
  for (const requested of [12, 1, 19, -1, 256, 11.1, NaN, Infinity, '11']) {
    assert.throws(() => applyTriangleLabels(labels, new Uint32Array(), requested, 11), RangeError);
  }
  assert.deepEqual(labels, new Uint8Array([0, 11, 255]));
});

test('invalid source labels are rejected outside the selection and during empty edits', () => {
  for (const invalid of [1, 10, 19, 29, 30, 39, 40, 49, 51, 254]) {
    const labels = new Uint8Array([0, invalid]);
    const original = labels.slice();
    for (const faces of [new Uint32Array(), new Uint32Array([0])]) {
      assert.throws(() => applyTriangleLabels(labels, faces, 11, 11), /Invalid triangle label/);
      assert.deepEqual(labels, original);
    }
  }
});

test('out-of-range face indices reject the entire edit without changing input', () => {
  const labels = new Uint8Array([0, 11, 255]);
  for (const faces of [new Uint32Array([0, labels.length]), new Uint32Array([0, -1])]) {
    const original = labels.slice();
    assert.throws(() => applyTriangleLabels(labels, faces, 11, 11), /Face index out of range/);
    assert.deepEqual(labels, original);
  }
  assert.throws(() => applyTriangleLabels(new Uint8Array(), new Uint32Array([0]), 0, 11), RangeError);
});

test('runtime callers must supply byte labels and unsigned face indices', () => {
  assert.throws(() => toothCounts({ part: [11] }), TypeError);
  assert.throws(() => applyTriangleLabels([0], new Uint32Array([0]), 11, 11), TypeError);
  assert.throws(() => applyTriangleLabels(new Uint8Array([0]), [0.5], 11, 11), TypeError);
});
