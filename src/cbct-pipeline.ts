export type CbctPipelineStage = 'loading' | 'series' | 'rendering' | 'aligning' | 'done' | 'error';

export interface CbctPipelineState {
  stage: CbctPipelineStage;
  detail: string;
}

export interface CbctPipelineInput {
  loading: boolean;
  status: string;
  progress: string;
  error: string;
  volume: unknown | null;
  surface: unknown | null;
  surfaceBusy: boolean;
  alignBusy: boolean;
  alignError: string;
  biteAligning: boolean;
  waitingForBite: boolean;
  scaleKnown: boolean;
  hasScans: boolean;
  aligned: boolean;
}

/** Maps live tomography/alignment state to the user-facing pipeline step. */
export function cbctPipelineStage(input: CbctPipelineInput): CbctPipelineState | null {
  const error = input.error || input.alignError;
  if (error) return { stage: 'error', detail: error };
  if (input.loading) return { stage: 'loading', detail: input.progress || 'Reading CBCT slices…' };
  if (input.status === 'select-series') return { stage: 'series', detail: 'Multiple series found — choose one to continue' };
  if (input.alignBusy) return { stage: 'aligning', detail: 'Fitting scans to CBCT jaw region…' };
  if (input.volume && (input.surfaceBusy || !input.surface)) {
    return { stage: 'rendering', detail: input.progress || 'Reconstructing threshold surface…' };
  }
  if (!input.volume || !input.surface) return null;
  if (input.aligned) return { stage: 'done', detail: 'Scans superimposed on CBCT' };
  if (!input.hasScans) return { stage: 'done', detail: 'CBCT ready — add 3D scans to superimpose' };
  if (!input.biteAligning && input.waitingForBite) return { stage: 'aligning', detail: 'Waiting for bite registration…' };
  if (!input.scaleKnown) return { stage: 'aligning', detail: 'Confirm the scan scale to align' };
  if (input.biteAligning) return { stage: 'aligning', detail: 'Refining scan pose to bite references…' };
  return { stage: 'aligning', detail: 'Alignment pending' };
}
