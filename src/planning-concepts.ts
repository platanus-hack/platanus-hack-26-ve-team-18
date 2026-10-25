import type { ToothCase } from './tooth-types';
import { isFdiTooth, toothCounts } from './teeth.ts';

export interface ProposedConceptSite {
  fdi: number;
  evidence: string[];
  rationale: string;
  source?: string;
}

/** A disposable generator input. AI hypotheses never modify the saved tooth chart. */
export function planningConceptCase(teeth: ToothCase, proposals: ProposedConceptSite[]): ToothCase {
  const counts = toothCounts(teeth.labels);
  const records = { ...teeth.teeth };
  for (const { fdi } of proposals) {
    const record = records[fdi];
    if (!isFdiTooth(fdi) || !record || record.status === 'present' || record.status === 'not-scanned' || counts[fdi]) continue;
    records[fdi] = { ...record, status: 'missing', restoration: 'implant' };
  }
  return { ...teeth, labels: teeth.labels, teeth: records };
}
