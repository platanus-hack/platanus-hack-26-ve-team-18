import type { RestorationAssembly } from './restoration-types';
import type { PlanningSessionFile } from './planning-session.ts';

const encode = (value: string) => new TextEncoder().encode(value);
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function header(size: number, values: [number, number, number][]) {
  const bytes = new Uint8Array(size), view = new DataView(bytes.buffer);
  for (const [offset, width, value] of values) if (width === 2) view.setUint16(offset, value, true); else view.setUint32(offset, value, true);
  return bytes;
}

const stale = (assembly: PlanningSessionFile['assemblies'][number]) => assembly.warnings.some(warning => warning.startsWith('STALE:'));
const meshPath = (assembly: PlanningSessionFile['assemblies'][number], component: string) => `${assembly.spec.draftIdentity ? 'draft-site' : `FDI-${assembly.spec.fdi}`}/assembly-${encodeURIComponent(assembly.id)}/${component}.ply`;

/** Mesh-free provenance sidecar. Editable sessions are saved separately. */
export function planningExportManifest(session: PlanningSessionFile) {
  return {
    format: 'platanus-mesh-export' as const, version: 1 as const, createdAt: session.createdAt,
    units: session.units, mmPerUnit: session.mmPerUnit, unitsProvenance: session.unitsProvenance,
    workflow: session.workflow,
    geometryHash: 'SHA-256 of original triangle-order Float32 coordinate bytes; excludes poses and PLY text',
    coordinateSystem: 'Each component is in its parent source file coordinates; apply fileToWorkspace once. No unit conversion is applied.',
    sources: session.sources,
    clinicalRequirements: {
      fixturePlanning: ['Clinical assessment.', 'Reviewed volumetric anatomy.', 'Reviewed surface-to-volume registration with calibrated units.', 'Exact implant system and compatible component catalog.', 'Clinician-selected placement constraints and anatomical exclusions.'],
      crownInterior: ['Selected abutment or Ti-base geometry and registered reference frame.', 'Reviewed internal clearance, access, retention, material and manufacturing constraints.'],
      unassessed: ['Bone-safe fixture depth, diameter, length and trajectory; nerve, root and sinus clearance; treatment suitability.', 'Tissue thickness, compression response and bone crest.', 'Dynamic excursions, loading, force and pressure.', 'Precision implant connections, intaglio fit, material thickness, self-intersection freedom and manufacturing readiness.'],
    },
    assemblies: session.assemblies.map(assembly => ({
      id: assembly.id, anatomicalFdi: assembly.spec.draftIdentity ? null : assembly.spec.fdi, spec: assembly.spec, createdAt: assembly.createdAt, warnings: assembly.warnings,
      exported: !stale(assembly), fit: assembly.fit, candidateHistory: assembly.candidateHistory, previousVersions: assembly.previousVersions,
      parts: assembly.parts.map(({ positions: _positions, normals: _normals, ...part }) => ({
        ...part, path: stale(assembly) ? null : meshPath(assembly, part.component),
        parentSourceKey: assembly.spec.parentPartId,
      })),
    })),
    limits: ['Planning concepts; clinical fit and manufacturing suitability remain unvalidated.', 'Sampled fit distances establish neither exact contact area nor overlap volume.', 'Stale historical assemblies are retained as metadata and excluded from mesh files.'],
  };
}

/** Uncompressed ZIP, with independent PLY meshes and their provenance sidecar.
 * The optional legacy argument is ignored: use one validated snapshot for both.
 */
export function planningExportBundle(session: PlanningSessionFile, _assemblies?: RestorationAssembly[]): Blob {
  const manifest = planningExportManifest(session);
  const files = [{ name: 'manifest.json', bytes: encode(JSON.stringify(manifest)) }];
  for (const assembly of session.assemblies.filter(assembly => !stale(assembly))) for (const part of assembly.parts) {
    const lines = ['ply', 'format ascii 1.0', 'comment Planning concept; clinical fit unvalidated; source file units (u)', `element vertex ${part.positions.length / 3}`, 'property float x', 'property float y', 'property float z', `element face ${part.triangles}`, 'property list uchar int vertex_indices', 'end_header'];
    for (let offset = 0; offset < part.positions.length; offset += 3) lines.push(`${part.positions[offset]} ${part.positions[offset + 1]} ${part.positions[offset + 2]}`);
    for (let face = 0; face < part.triangles; face++) lines.push(`3 ${face * 3} ${face * 3 + 1} ${face * 3 + 2}`);
    files.push({ name: meshPath(assembly, part.component), bytes: encode(lines.join('\n')) });
  }
  if (new Set(files.map(file => file.name)).size !== files.length) throw new Error('Duplicate mesh export paths. Save a validated planning session before exporting.');
  const chunks: Uint8Array<ArrayBuffer>[] = [], directory: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0, directorySize = 0;
  for (const file of files) {
    const name = encode(file.name), crc = crc32(file.bytes), size = file.bytes.length;
    const local = header(30, [[0, 4, 0x04034b50], [4, 2, 20], [14, 4, crc], [18, 4, size], [22, 4, size], [26, 2, name.length]]);
    const central = header(46, [[0, 4, 0x02014b50], [4, 2, 20], [6, 2, 20], [16, 4, crc], [20, 4, size], [24, 4, size], [28, 2, name.length], [42, 4, offset]]);
    chunks.push(local, name, file.bytes); directory.push(central, name); offset += local.length + name.length + size; directorySize += central.length + name.length;
  }
  const end = header(22, [[0, 4, 0x06054b50], [8, 2, files.length], [10, 2, files.length], [12, 4, directorySize], [16, 4, offset]]);
  return new Blob([...chunks, ...directory, end], { type: 'application/zip' });
}
