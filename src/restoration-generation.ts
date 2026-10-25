import { z } from 'zod';

const finite = z.number().finite();
const positive = finite.positive();

/** Model-authored construction values, in file units. No transforms, code or mesh buffers. */
export const restorationGenerationDesignSchema = z.strictObject({
  anatomy: z.enum(['incisor', 'canine', 'premolar', 'molar']),
  anatomySource: z.enum(['procedural-template', 'patient-donor']),
  parameters: z.strictObject({
    fixture: z.strictObject({ radius: positive, length: positive, depth: finite.nonnegative(), taper: finite.min(0).max(.95) }),
    abutment: z.strictObject({ radius: positive, height: positive, emergenceRadius: positive, angleX: finite.min(-80).max(80), angleY: finite.min(-80).max(80) }),
    crown: z.strictObject({ width: positive, depth: positive, height: positive, cuspHeight: finite.nonnegative(), rotation: finite.min(-360).max(360) }),
  }),
  contour: z.strictObject({ cervicalScale: finite.min(.5).max(1.5), occlusalScale: finite.min(.5).max(1.5) }),
});
export type RestorationGenerationDesign = z.infer<typeof restorationGenerationDesignSchema>;
export interface RestorationGenerationRequest {
  /** Resolved local site ID. Transport aliases must be resolved before dispatch. */
  siteId: string;
  /** For unidentified sites this chooses illustrative anatomy only. */
  fdi: number;
  rationale: string;
  design: RestorationGenerationDesign;
}
