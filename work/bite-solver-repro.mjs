import { readFile } from 'node:fs/promises';
import { Box3, Vector3 } from 'three';
import { parseModel } from '../src/import-models.ts';
import { refineBiteAlignment } from '../src/bite-alignment.ts';

// Local diagnostic only: no mesh contents or identifying metadata are written.
const directory = process.argv[2];
if (!directory) throw new Error('Pass a local directory containing upper/lower/bite1/bite2.ply.');
const meshes = [];
for (const id of ['upper', 'lower', 'bite1', 'bite2']) {
  const bytes = await readFile(`${directory}/${id}.ply`);
  const { parts, warnings } = parseModel(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), `${id}.ply`);
  const positions = new Float64Array(parts.reduce((sum, part) => sum + part.positions.length, 0));
  let cursor = 0;
  for (const part of parts) { positions.set(part.positions, cursor); cursor += part.positions.length; }
  meshes.push({ id, positions });
  console.log(JSON.stringify({ id, triangles: positions.length / 9, parts: parts.length, warnings }));
}
const arches = meshes.slice(0, 2).map(mesh => ({ ...mesh, role: mesh.id }));
const box = new Box3(), point = new Vector3();
for (const arch of arches) for (let i = 0; i < arch.positions.length; i += 3) box.expandByPoint(point.fromArray(arch.positions, i));
const maxDistance = box.getSize(point).length() * 0.03;
console.log(JSON.stringify({ maxDistance }));
try {
  const result = refineBiteAlignment({ arches, bites: meshes.slice(2), maxDistance });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
  process.exitCode = 1;
}
