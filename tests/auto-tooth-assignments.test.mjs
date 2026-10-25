import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAutoAssignments } from '../src/auto-tooth-assignments.ts';
import { emptyToothCase } from '../src/tooth-session.ts';

const part = { id: 'arch', role: 'upper', triangles: 8 };
const region = (tooth, faces) => ({ tooth, partId: 'arch', faces: new Uint32Array(faces) });
test('batch acceptance assigns original faces without making unlabeled positions missing', () => {
  const data = emptyToothCase();
  const result = applyAutoAssignments(data, [part], [region(16,[0,1]),region(14,[5,6])]);
  assert.deepEqual(result.data.labels.arch, new Uint8Array([16,16,0,0,0,14,14,0]));
  assert.equal(result.data.teeth[15].status, 'unreviewed');
  assert.equal(result.data.teeth[16].status, 'present');
  assert.equal(result.triangles,4);
  assert.deepEqual(data.labels,{});
});
test('reruns preserve reviewed masks, missing sites, notes, and explicit gum exclusions', () => {
  const data=emptyToothCase(); data.labels.arch=new Uint8Array([16,0,255,0,0,0,0,0]);
  data.teeth[16]={status:'present',restoration:'crown',note:'Corrected margin'};
  data.teeth[15]={status:'missing',restoration:'implant',note:'Reviewed gap',site:{partId:'arch',face:3,point:[0,0,0]}};
  const result=applyAutoAssignments(data,[part],[region(16,[0,1]),region(15,[3,4]),region(14,[2,5])]);
  assert.deepEqual(result.applied,[14]); assert.equal(result.skipped.length,2);
  assert.equal(result.data.labels.arch[1],0);assert.equal(result.data.labels.arch[2],255);assert.equal(result.data.labels.arch[5],14);
  assert.deepEqual(result.data.teeth[15],data.teeth[15]); assert.equal(result.data.teeth[16].note,'Corrected margin');
});
test('invalid identities, duplicate FDI, wrong arches, and overlapping masks fail atomically', () => {
  const data=emptyToothCase();
  for(const regions of [[region(19,[0])],[region(36,[0])],[region(16,[0]),region(16,[1])],[region(16,[0]),region(15,[0])],[region(16,[8])]]) assert.throws(()=>applyAutoAssignments(data,[part],regions));
  assert.deepEqual(data.labels,{});assert.equal(data.teeth[16].status,'unreviewed');
});
