#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateRestoration } from '../../../src/restoration-geometry.ts';
import { parseModel } from '../../../src/import-models.ts';
import { inspectMesh, toPLY } from './dental-concept.mjs';
import { createOutputDirectory } from './inspect-scans.mjs';

const HELP = `Generate THREE separate planning-concept meshes: fixture, abutment (pilar), crown.
Usage (Node 24, from repository root):
  node --experimental-strip-types skills/dental-restoration-design/scripts/generate-assembly.mjs \\
    --spec /private/assembly-spec.json --out-dir /tmp/new-assembly
--spec must be a local implant-assembly/v1 JSON file of at most 1 MiB.
--out-dir must be a NEW directory. --help prints this message.
Writes fixture.ply, abutment.ply, crown.ply and manifest.json.
Uses the SAME pure TypeScript generator as the in-app worker. No scan is opened,
uploaded, identified, registered or fitted. Source/frame/provenance are supplied
by the caller. Coordinates remain in that SOURCE frame, in file units (u).
The smooth tapered fixture has no thread or manufacturer interface. All basal
caps are artificial; abutment fit, bone-safe depth, manufacturer compatibility,
contacts, occlusion and material thickness are unassessed. NOT FOR MANUFACTURING.
See references/component-parameters.md and scripts/README.md for the contract.
The existing generate-concept.mjs crown CLI is unchanged.`;

function indexed(component) {
  const points = [], indices = [], vertices = new Map();
  for (let i = 0; i < component.positions.length; i += 3) {
    const point = Array.from(component.positions.subarray(i, i + 3)), key = point.join(',');
    let index = vertices.get(key);
    if (index === undefined) { index = points.length / 3; vertices.set(key, index); points.push(...point); }
    indices.push(index);
  }
  return { positions: Float32Array.from(points), indices: Uint32Array.from(indices) };
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) { console.log(HELP); return; }
  let specPath, out;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}. Use --help.`);
    if (flag === '--spec' && !specPath) specPath = value;
    else if (flag === '--out-dir' && !out) out = value;
    else throw new Error(`Unsupported or repeated option ${flag}. Use --help.`);
  }
  if (!specPath || !out) throw new Error('Provide --spec and --out-dir. Use --help.');
  const info = await stat(specPath);
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error('Spec must be a local JSON file of at most 1 MiB.');
  const specBytes = await readFile(specPath), spec = JSON.parse(specBytes.toString('utf8'));
  const components = generateRestoration(spec), files = [];
  const manifest = {
    version: 'implant-assembly-artifacts/v1', purpose: 'three-part-planning-concept-only',
    units: spec.units, coordinateSystem: 'original-source-frame', spec,
    specFileId: `sha256:${createHash('sha256').update(specBytes).digest('hex')}`,
    sourceVerification: 'Caller-supplied source identity and pose; no source file was read or verified.',
    assessments: { boneSafeDepth: 'unassessed', manufacturerCompatibility: 'unassessed', clinicalFit: 'unassessed',
      contacts: 'unassessed', occlusion: 'unassessed', materialThickness: 'unassessed', manufacturing: 'not-for-manufacturing' },
    limitations: [
      'Dimensions are geometric hypotheses or clinician-entered values, never surgical prescriptions.',
      'IOS surfaces cannot establish bone-safe fixture depth or manufacturer compatibility.',
      'Fixture is a smooth tapered envelope with no thread, implant connection, or screw geometry.',
      'Abutment starts at the fixture platform and bridges any conceptual depth to the site and crown planes; the contiguous generic envelopes do not encode a precision implant connection.',
      'Caps are artificial closures, not fitted intaglios, tissue margins, or mating surfaces.',
      'Procedural anatomy and topology checks do not validate clinical fit, self-intersection, or fabrication.',
      'Apply the parent scan pose once when presenting these source-frame meshes.',
    ],
    components: [],
  };
  for (const component of components) {
    const mesh = indexed(component), integrity = inspectMesh(mesh);
    if (!integrity.closed || integrity.signedVolume <= 0) throw new Error(`${component.component}: failed independent topology validation.`);
    const name = `${component.component}.ply`, ply = toPLY(mesh);
    const imported = parseModel(new TextEncoder().encode(ply).buffer, name);
    if (imported.parts.length !== 1 || !imported.parts[0].closed || imported.parts[0].triangles !== component.triangles) {
      throw new Error(`${name}: did not round-trip as one closed surface through the repository importer.`);
    }
    files.push([name, ply]);
    manifest.components.push({ component: component.component, fileName: name,
      id: `sha256:${createHash('sha256').update(ply).digest('hex')}`, vertices: component.vertices,
      triangles: component.triangles, dimensions: component.dimensions, integrity,
      importerRoundTrip: 'one closed component', artificialClosure: true });
  }
  const directory = await createOutputDirectory(out);
  for (const [name, data] of files) await writeFile(resolve(directory, name), data, { flag: 'wx' });
  await writeFile(resolve(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ directory, components: manifest.components.map(component => component.fileName),
    units: spec.units, manufacturing: 'not-for-manufacturing' }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
