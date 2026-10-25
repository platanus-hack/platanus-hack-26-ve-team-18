#!/usr/bin/env node
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseModel } from '../../../src/import-models.ts';
import { createCrownConcept, toPLY } from './dental-concept.mjs';
import { createOutputDirectory, createPreviewData, createPreviewHTML, sha256Id } from './inspect-scans.mjs';

const HELP = `Generate a hypothetical molar/premolar crown EXTERIOR CONCEPT from explicit JSON.
Usage (from repository root):
  node --experimental-strip-types skills/dental-restoration-design/scripts/generate-concept.mjs \\
    --spec /private/concept-spec.json --out /tmp/crown-concept
--spec must be <= 1 MiB. --out must be a NEW directory. --help prints this message.
Writes crown-concept.ply, spec.json (including pose matrices), report.json, preview.json, preview.html.
No scan file is read or copied. Source SHA256 IDs/provenance are caller supplied and not verified here.
First inspect real inputs with inspect-scans.mjs to obtain their byte hashes and global bounds.
Every dimension and tessellation value is explicit; no physical units or clinical defaults are assumed.
Unknown units stay unknown. Local axes must be an orthonormal right-handed frame; +z points toward occlusal.
The artificial flat basal closure is NOT an intaglio or implant connection. Fixture, abutment,
clinical fit, occlusion, and manufacturability are unassessed. Not manufacturing output.
See scripts/README.md and synthetic-example.json; example dimensions are arbitrary file units.
API: import {validateConceptSpec, createCrownConcept, toPLY, trianglePositions} from './dental-concept.mjs'.`;

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) { console.log(HELP); return; }
  let specPath, out;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}. Use --help.`);
    if (flag === '--spec' && !specPath) specPath = value;
    else if (flag === '--out' && !out) out = value;
    else throw new Error(`Unsupported or repeated option ${flag}. Use --help.`);
  }
  if (!specPath || !out) throw new Error('Provide --spec and --out. Use --help.');
  const info = await stat(specPath);
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Spec must be a local JSON file of at most 1 MiB.');
  const input = JSON.parse(await readFile(specPath, 'utf8'));
  const { spec, mesh, report } = createCrownConcept(input);
  const ply = toPLY(mesh), imported = parseModel(new TextEncoder().encode(ply).buffer, 'crown-concept.ply');
  if (imported.parts.length !== 1 || !imported.parts[0].closed || imported.parts[0].triangles !== mesh.indices.length / 3) {
    throw new Error('Concept did not round-trip as a single closed surface through the repository importer.');
  }
  report.output = { fileName: 'crown-concept.ply', id: sha256Id(ply), format: 'ASCII PLY, double xyz', importerRoundTrip: 'one closed component' };
  const preview = createPreviewData(imported.parts.map(p => ({ ...p, id: report.output.id, sourceId: report.output.id, role: 'concept' })));
  const directory = await createOutputDirectory(out);
  for (const [file, value] of Object.entries({
    'crown-concept.ply': ply, 'spec.json': `${JSON.stringify(spec, null, 2)}\n`,
    'report.json': `${JSON.stringify(report, null, 2)}\n`, 'preview.json': `${JSON.stringify(preview)}\n`,
    'preview.html': createPreviewHTML(preview),
  })) await writeFile(resolve(directory, file), value, { flag: 'wx' });
  console.log(JSON.stringify({ directory, fileName: 'crown-concept.ply', triangles: report.integrity.triangleCount,
    distanceUnit: 'file units', clinicalFit: 'unassessed' }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
