import type { AutoToothIdentification, AutoToothMapping } from './auto-tooth-types';

/** Keep user corrections authoritative when a new model response disagrees. */
export function mergeToothMappings(current: AutoToothMapping[], result: Pick<AutoToothIdentification, 'mappings' | 'possibleMissing' | 'warnings'>) {
  const reviewed = new Map(current.filter(mapping => mapping.source === 'user').map(mapping => [mapping.candidateId, mapping]));
  const assigned = new Set([...reviewed.values()].flatMap(mapping => mapping.fdi === null ? [] : [mapping.fdi]));
  const warnings = [...result.warnings];
  const mappings: AutoToothMapping[] = result.mappings.map(mapping => {
    const manual = reviewed.get(mapping.candidateId);
    if (manual) {
      if (manual.fdi !== mapping.fdi) warnings.push(`Kept the user-reviewed mapping for C${mapping.candidateId}; the model suggested a different identity.`);
      return manual;
    }
    if (mapping.fdi !== null && assigned.has(mapping.fdi)) return { ...mapping, fdi: null, needsReview: true, source: 'model', reason: `The model suggested FDI ${mapping.fdi}, which already has a user-reviewed mapping. Resolve this region separately.` };
    return { ...mapping, source: 'model' };
  });
  return { mappings, possibleMissing: result.possibleMissing.filter(gap => !assigned.has(gap.fdi)), warnings };
}
