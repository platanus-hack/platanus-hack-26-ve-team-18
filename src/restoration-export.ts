import type { ModelPart } from './models.ts';
import { displayNormals } from './restoration-appearance.ts';

/** `#rrggbb` is already sRGB; PLY uchar colors are conventionally sRGB too. */
function srgbBytes(color: string | undefined): [number, number, number] | null {
  const match = color && /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  return match ? [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)] : null;
}

/**
 * ASCII PLY of a generated component in its ORIGINAL source coordinates; no
 * pose is applied (the current pose travels in the separate planning manifest).
 * Corner order and topology match `part.positions` exactly. Normals are the
 * same display normals the viewer uses, expressed in that source frame; the
 * color is the illustrative component color. Neither is a manufacturing or
 * material specification.
 */
export function restorationPly(part: ModelPart): string {
  const corners = part.positions.length / 3;
  const { normals, mode } = displayNormals(part);
  const color = srgbBytes(part.presentationColor);
  const lines = ['ply', 'format ascii 1.0',
    'comment Planning concept; units are source file units',
    'comment Clinical fit unvalidated; no implant hardware, thread, connection, or manufacturing validation',
    'comment Coordinates are original source coordinates; the current pose is exported separately',
    mode === 'smoothed-display'
      ? 'comment Normals are smoothed display shading in the source frame, not a measured or manufacturing surface'
      : 'comment Normals are the source per-face normals',
    ...(color ? ['comment Vertex colors are illustrative component colors; materials, finish, and PBR properties are not preserved'] : []),
    `element vertex ${corners}`, 'property float x', 'property float y', 'property float z',
    'property float nx', 'property float ny', 'property float nz',
    ...(color ? ['property uchar red', 'property uchar green', 'property uchar blue'] : []),
    `element face ${part.triangles}`, 'property list uchar int vertex_indices', 'end_header'];
  const suffix = color ? ` ${color.join(' ')}` : '';
  for (let i = 0; i < part.positions.length; i += 3) {
    lines.push(`${part.positions[i]} ${part.positions[i + 1]} ${part.positions[i + 2]} ${normals[i]} ${normals[i + 1]} ${normals[i + 2]}${suffix}`);
  }
  for (let face = 0; face < part.triangles; face++) lines.push(`3 ${face * 3} ${face * 3 + 1} ${face * 3 + 2}`);
  return lines.join('\n');
}
