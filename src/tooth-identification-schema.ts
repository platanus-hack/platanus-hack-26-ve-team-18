import { z } from 'zod';
import { anthropicModelIdSchema } from './anthropic-models.ts';
import type { AutoToothIdentification, AutoToothIdentificationRequest } from './auto-tooth-types.ts';
import { isFdiTooth, toothArch } from './teeth.ts';

export const MAX_VIEWS = 4;
/** Shared wording for consumers of the fixed local rendering contract. */
export const TOOTH_VIEW_DESCRIPTION = 'Image 1 is an occlusal overview using the scan texture or natural vertex colors when available, with C<id> labels. The remaining three images are oblique views with each candidate drawn in a blue shade and visible C<id> labels. Labels match the candidate manifest ids; hidden candidates are not labelled.';
export const MAX_CANDIDATES = 32;
export const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
/** Exact base64 length for MAX_IMAGE_BYTES; strict padded base64 decodes to at most this size. */
export const MAX_IMAGE_BASE64_LENGTH = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);
export const MAX_REASON_LENGTH = 240;
export const MAX_WARNING_LENGTH = 240;
export const MAX_RESPONSE_WARNINGS = 12;

const jpegBase64 = z.string().min(4).max(MAX_IMAGE_BASE64_LENGTH).refine(value => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value), 'Send standard padded base64.');

/** Strict objects reject filenames, notes, raw geometry, and any other field not in the contract. */
export const autoToothIdentificationRequestSchema = z.strictObject({
  model: anthropicModelIdSchema.optional(),
  arch: z.enum(['upper', 'lower']),
  patientRight: z.enum(['image-left', 'image-right']),
  views: z.array(z.strictObject({
    label: z.string().max(80),
    mediaType: z.literal('image/jpeg'),
    base64: jpegBase64,
  })).min(1).max(MAX_VIEWS),
  candidates: z.array(z.strictObject({
    id: z.number().int().min(0).max(9999),
    triangles: z.number().int().min(1).max(10_000_000),
    area: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
    warnings: z.array(z.string().max(200)).max(8),
  })).min(1).max(MAX_CANDIDATES).refine(list => new Set(list.map(item => item.id)).size === list.length, 'Candidate ids must be unique.'),
});

/** Shape requested from the model. Limits are enforced by validateIdentification, not by the provider schema. */
export const identificationOutputSchema = z.object({
  mappings: z.array(z.object({
    candidateId: z.number().int(),
    fdi: z.number().int().nullable(),
    needsReview: z.boolean(),
    reason: z.string(),
  })),
  possibleMissing: z.array(z.object({ fdi: z.number().int(), reason: z.string() })),
  warnings: z.array(z.string()),
});

export type ToothIdentificationRequest = z.infer<typeof autoToothIdentificationRequestSchema>;
export type ToothIdentificationOutput = z.infer<typeof identificationOutputSchema>;
export type ValidatedIdentification = Omit<AutoToothIdentification, 'model'>;

/** Messages are safe to show to the user. Provider details never belong here. */
export class ToothIdentificationError extends Error {
  constructor(message: string) { super(message); this.name = 'ToothIdentificationError'; }
}

function clip(text: string, max = MAX_REASON_LENGTH): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

function acceptableFdi(fdi: number, arch: AutoToothIdentificationRequest['arch']): boolean {
  return isFdiTooth(fdi) && toothArch(fdi) === arch;
}

/**
 * Checks model output against the request. Mapping contradictions reject the whole answer;
 * suggestions that conflict with the arch or with existing mappings are removed with a warning.
 */
export function validateIdentification(result: unknown, request: AutoToothIdentificationRequest): ValidatedIdentification {
  const parsed = identificationOutputSchema.safeParse(result);
  if (!parsed.success) throw new ToothIdentificationError('The identification response did not match the required shape.');
  const known = new Set(request.candidates.map(candidate => candidate.id));
  const seen = new Set<number>();
  const assigned = new Set<number>();
  const notices: string[] = [];
  const mappings: ValidatedIdentification['mappings'] = parsed.data.mappings.map(item => {
    if (!known.has(item.candidateId)) throw new ToothIdentificationError(`Unknown candidate ${item.candidateId}.`);
    if (seen.has(item.candidateId)) throw new ToothIdentificationError(`Candidate ${item.candidateId} is mapped more than once.`);
    seen.add(item.candidateId);
    if (item.fdi !== null) {
      if (!acceptableFdi(item.fdi, request.arch)) throw new ToothIdentificationError(`FDI ${item.fdi} is not a permanent ${request.arch} tooth.`);
      if (assigned.has(item.fdi)) throw new ToothIdentificationError(`FDI ${item.fdi} is assigned to more than one candidate.`);
      assigned.add(item.fdi);
    }
    return {
      candidateId: item.candidateId,
      fdi: item.fdi,
      // Unknown identity always needs a human decision, regardless of what the model claimed.
      needsReview: item.fdi === null || item.needsReview,
      reason: clip(item.reason) || 'No reason returned.',
    };
  });
  for (const candidate of request.candidates) {
    if (seen.has(candidate.id)) continue;
    mappings.push({ candidateId: candidate.id, fdi: null, needsReview: true, reason: 'No mapping was returned for this candidate.' });
    notices.push(`Candidate ${candidate.id} had no mapping and needs review.`);
  }
  mappings.sort((a, b) => a.candidateId - b.candidateId);

  const counts = new Map<number, number>();
  for (const item of parsed.data.possibleMissing) counts.set(item.fdi, (counts.get(item.fdi) ?? 0) + 1);
  const ambiguous = new Set([...counts].filter(([, count]) => count > 1).map(([fdi]) => fdi));
  for (const fdi of ambiguous) notices.push(`Removed conflicting missing-tooth suggestions for FDI ${fdi}.`);
  const possibleMissing: ValidatedIdentification['possibleMissing'] = [];
  for (const item of parsed.data.possibleMissing) {
    if (ambiguous.has(item.fdi)) continue;
    if (!acceptableFdi(item.fdi, request.arch)) { notices.push(`Removed suggested FDI ${item.fdi}: it is not a permanent ${request.arch} tooth.`); continue; }
    if (assigned.has(item.fdi)) { notices.push(`Removed suggested FDI ${item.fdi}: a candidate is already mapped to it.`); continue; }
    possibleMissing.push({ fdi: item.fdi, reason: clip(item.reason) || 'Suggested for review only.' });
  }

  const warnings = [...notices, ...parsed.data.warnings]
    .map(text => clip(text, MAX_WARNING_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_RESPONSE_WARNINGS);
  return { mappings, possibleMissing, warnings };
}
