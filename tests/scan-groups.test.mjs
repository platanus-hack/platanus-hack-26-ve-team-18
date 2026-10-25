import test from 'node:test';
import assert from 'node:assert/strict';
import { canRefineCaseBite, prepareCaseBite, scanSourceGroups } from '../src/scan-groups.ts';
import { importModels } from '../src/import-models.ts';
const part = (id, role, sourceFileId, x = 0) => ({ id, role, sourceFileId, fileName: 'same.ply', name: id, positions: Float32Array.from([0,0,0,1,0,0,0,1,0]), normals: new Float32Array(9), offset: [x,0,0], visible: true, closed: false, dimensions:[1,1,0], triangles:1, vertices:3 });
test('disconnected patches of a capture stay together without merging unrelated same-named files', () => {
  const parts = [part('upper1','upper','upper'),part('upper2','upper','upper',2),part('lower','lower','lower'),part('bite-upper','bite','bite'),part('bite-lower','bite','bite',3)];
  assert.equal(canRefineCaseBite(parts),true);
  const grouped = prepareCaseBite(parts);
  assert.equal(grouped.arches.length,2); assert.equal(grouped.bites.length,1);
  assert.equal(grouped.arches[0].positions.length,18); assert.equal(grouped.bites[0].positions.length,18);
  assert.equal(grouped.arches[0].positions[9],2); assert.equal(grouped.bites[0].positions[9],3);
  assert.deepEqual(grouped.members.get('upper1'),['upper1','upper2']);
  assert.equal(scanSourceGroups([part('a','bite','one'),part('b','bite','two')]).length,2);
  assert.equal(canRefineCaseBite([...parts,part('unrelated-upper','upper','another')]),false);
});
test('source file identities are assigned per import file and shared by its components', async () => {
  const ply = ['ply','format ascii 1.0','element vertex 6','property float x','property float y','property float z','element face 2','property list uchar int vertex_indices','end_header','0 0 0','1 0 0','0 1 0','10 0 0','11 0 0','10 1 0','3 0 1 2','3 3 4 5'].join('\n');
  const result = await importModels([new File([ply],'bite1.ply'),new File([ply],'bite2.ply')]);
  assert.equal(result.parts.length,4);
  assert.equal(result.parts[0].sourceFileId,result.parts[1].sourceFileId);
  assert.equal(result.parts[2].sourceFileId,result.parts[3].sourceFileId);
  assert.notEqual(result.parts[0].sourceFileId,result.parts[2].sourceFileId);
});
