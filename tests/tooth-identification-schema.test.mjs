import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_IMAGE_BASE64_LENGTH,
  ToothIdentificationError,
  autoToothIdentificationRequestSchema,
  identificationOutputSchema,
  validateIdentification,
} from '../src/tooth-identification-schema.ts';

const jpegBase64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0xff, 0xd9]).toString('base64');
const request = () => ({
  arch: 'upper',
  patientRight: 'image-left',
  views: [{ label: 'Occlusal overview', mediaType: 'image/jpeg', base64: jpegBase64 }],
  candidates: [
    { id: 0, triangles: 120, area: 4.5, height: 7.2, warnings: [] },
    { id: 1, triangles: 90, area: 3.1, height: 6, warnings: ['open edge'] },
    { id: 2, triangles: 80, area: 2.9, height: 5.5, warnings: [] },
  ],
});
const mapping = (candidateId, fdi, extra = {}) => ({ candidateId, fdi, needsReview: fdi === null, reason: 'Crown shape', ...extra });
const output = (overrides = {}) => ({
  mappings: [mapping(0, 11), mapping(1, 12), mapping(2, null)],
  possibleMissing: [{ fdi: 13, reason: 'No crown in this segment' }],
  warnings: ['Candidate 2 is partial.'],
  ...overrides,
});

test('request schema accepts the contract and rejects fields outside it', () => {
  assert.equal(autoToothIdentificationRequestSchema.safeParse(request()).success, true);
  for (const mutate of [
    value => { value.fileName = 'PATIENT.stl'; },
    value => { value.views[0].notes = 'private'; },
    value => { value.candidates[0].positions = [0, 0, 0]; },
  ]) {
    const value = request();
    mutate(value);
    assert.equal(autoToothIdentificationRequestSchema.safeParse(value).success, false);
  }
});

test('candidate measurements accept large file units without assuming millimetres', () => {
  const value = request(); value.candidates[0].area = 1e24; value.candidates[0].height = 1e12;
  assert.equal(autoToothIdentificationRequestSchema.safeParse(value).success, true);
});

test('request schema bounds views, candidates, ids, and media type', () => {
  const tooManyViews = request();
  tooManyViews.views = Array.from({ length: 5 }, () => ({ label: 'v', mediaType: 'image/jpeg', base64: jpegBase64 }));
  assert.equal(autoToothIdentificationRequestSchema.safeParse(tooManyViews).success, false);
  const noViews = request(); noViews.views = [];
  assert.equal(autoToothIdentificationRequestSchema.safeParse(noViews).success, false);
  const tooManyCandidates = request();
  tooManyCandidates.candidates = Array.from({ length: 33 }, (_, id) => ({ id, triangles: 1, area: 1, height: 1, warnings: [] }));
  assert.equal(autoToothIdentificationRequestSchema.safeParse(tooManyCandidates).success, false);
  const duplicateIds = request(); duplicateIds.candidates[2].id = 1;
  assert.equal(autoToothIdentificationRequestSchema.safeParse(duplicateIds).success, false);
  const png = request(); png.views[0].mediaType = 'image/png';
  assert.equal(autoToothIdentificationRequestSchema.safeParse(png).success, false);
  const badArch = request(); badArch.arch = 'both';
  assert.equal(autoToothIdentificationRequestSchema.safeParse(badArch).success, false);
});

test('request schema requires strict padded base64 and caps the decoded image size', () => {
  for (const base64 of ['', 'abc!', '/w8=/w8', jpegBase64.slice(0, -1)]) {
    const value = request(); value.views[0].base64 = base64;
    assert.equal(autoToothIdentificationRequestSchema.safeParse(value).success, false, base64);
  }
  const atLimit = request(); atLimit.views[0].base64 = 'A'.repeat(MAX_IMAGE_BASE64_LENGTH);
  assert.equal(autoToothIdentificationRequestSchema.safeParse(atLimit).success, true);
  const overLimit = request(); overLimit.views[0].base64 = 'A'.repeat(MAX_IMAGE_BASE64_LENGTH + 4);
  assert.equal(autoToothIdentificationRequestSchema.safeParse(overLimit).success, false);
});

test('output schema exposes only the fields the model should return', () => {
  assert.equal(identificationOutputSchema.safeParse(output()).success, true);
  assert.equal(identificationOutputSchema.safeParse({ mappings: [] }).success, false);
});

test('validateIdentification accepts a sound answer and sorts mappings by candidate id', () => {
  const result = validateIdentification(output({ mappings: [mapping(2, null), mapping(0, 11), mapping(1, 12)] }), request());
  assert.deepEqual(result.mappings.map(item => [item.candidateId, item.fdi, item.needsReview]), [[0, 11, false], [1, 12, false], [2, null, true]]);
  assert.deepEqual(result.possibleMissing, [{ fdi: 13, reason: 'No crown in this segment' }]);
  assert.deepEqual(result.warnings, ['Candidate 2 is partial.']);
  assert.equal(Object.hasOwn(result, 'model'), false);
});

test('validateIdentification rejects unknown, duplicate, and wrong-arch or invalid FDI mappings', () => {
  assert.throws(() => validateIdentification(output({ mappings: [mapping(9, 11), mapping(1, 12), mapping(2, null)] }), request()), /Unknown candidate 9/);
  assert.throws(() => validateIdentification(output({ mappings: [mapping(0, 11), mapping(0, 12), mapping(2, null)] }), request()), /more than once/);
  assert.throws(() => validateIdentification(output({ mappings: [mapping(0, 31), mapping(1, 12), mapping(2, null)] }), request()), /not a permanent upper tooth/);
  for (const fdi of [0, 9, 19, 29, 48, 55]) {
    assert.throws(() => validateIdentification(output({ mappings: [mapping(0, fdi), mapping(1, 12), mapping(2, null)] }), request()), ToothIdentificationError, `FDI ${fdi}`);
  }
  assert.throws(() => validateIdentification(output({ mappings: [mapping(0, 11), mapping(1, 11), mapping(2, null)] }), request()), /more than one candidate/);
});

test('validateIdentification checks the lower arch with lower FDI numbers only', () => {
  const lower = { ...request(), arch: 'lower' };
  const result = validateIdentification(output({ mappings: [mapping(0, 36), mapping(1, 46), mapping(2, null)], possibleMissing: [] }), lower);
  assert.deepEqual(result.mappings.map(item => item.fdi), [36, 46, null]);
  assert.throws(() => validateIdentification(output({ mappings: [mapping(0, 16), mapping(1, 46), mapping(2, null)] }), lower), /not a permanent lower tooth/);
});

test('validateIdentification fills missing candidates as unresolved, forces review for unknown identity, and keeps the request ids', () => {
  const result = validateIdentification(output({ mappings: [mapping(0, 11, { needsReview: false }), mapping(1, null, { needsReview: false })] }), request());
  assert.deepEqual(result.mappings.map(item => [item.candidateId, item.fdi, item.needsReview]), [[0, 11, false], [1, null, true], [2, null, true]]);
  assert.match(result.warnings.join('\n'), /Candidate 2 had no mapping and needs review/);
});

test('validateIdentification strips contradictory missing-tooth suggestions and keeps unique valid ones', () => {
  const result = validateIdentification(output({
    possibleMissing: [
      { fdi: 13, reason: 'Gap' },
      { fdi: 14, reason: 'Gap' },
      { fdi: 14, reason: 'Other gap' },
      { fdi: 11, reason: 'Already mapped' },
      { fdi: 36, reason: 'Wrong arch' },
      { fdi: 99, reason: 'Not a tooth' },
    ],
  }), request());
  assert.deepEqual(result.possibleMissing, [{ fdi: 13, reason: 'Gap' }]);
  const warnings = result.warnings.join('\n');
  assert.match(warnings, /conflicting missing-tooth suggestions for FDI 14/);
  assert.match(warnings, /FDI 11: a candidate is already mapped/);
  assert.match(warnings, /FDI 36: it is not a permanent upper tooth/);
  assert.match(warnings, /FDI 99: it is not a permanent upper tooth/);
});

test('validateIdentification clips free text and caps warnings', () => {
  const longReason = 'r'.repeat(1000);
  const result = validateIdentification(output({
    mappings: [mapping(0, 11, { reason: longReason }), mapping(1, 12), mapping(2, null)],
    warnings: Array.from({ length: 40 }, (_, index) => `warning ${index} ${'w'.repeat(500)}`),
  }), request());
  assert.equal(result.mappings[0].reason.length, 240);
  assert.ok(result.warnings.length <= 12);
  assert.ok(result.warnings.every(text => text.length <= 240));
});

test('validateIdentification rejects malformed output without echoing its content', () => {
  for (const value of [null, 'text', { mappings: 'many', possibleMissing: [], warnings: [] }, { mappings: [], possibleMissing: [] }]) {
    assert.throws(() => validateIdentification(value, request()), error => {
      assert.ok(error instanceof ToothIdentificationError);
      assert.doesNotMatch(error.message, /many|text/);
      return true;
    });
  }
});
