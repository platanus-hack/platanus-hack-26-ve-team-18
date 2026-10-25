import test from 'node:test';
import assert from 'node:assert/strict';
import { Matrix4, Euler, Vector3 } from 'three';
import { registerCbctLandmarks, currentCbctRegistrations, tomographyReferencePart, applyCbctRigidDelta, cbctPoseMatches, cbctSourcesMatch, cbctAssemblyRegistered, cbctAssemblyDelta, cbctResetParts } from '../src/cbct-registration.ts';
import { partMatrix } from '../src/pose.ts';

test('landmark registration recovers arbitrary rigid pose with explicit physical scale', () => {
  const transform = new Matrix4().makeRotationFromEuler(new Euler(.7, -.6, 1.4)).setPosition(41, -17, 92);
  const originals = [[0,0,0],[25,0,1],[-6,18,-1],[9,14,13],[3,-7,10]];
  const mmPerUnit = .25;
  const pairs = originals.map(source => ({source, target:new Vector3(...source).applyMatrix4(transform).multiplyScalar(mmPerUnit).toArray()}));
  const result = registerCbctLandmarks(pairs, mmPerUnit);
  assert.ok(result.rmsMm < 1e-10);
  result.matrix.forEach((v,i)=>assert.ok(Math.abs(v-transform.elements[i])<1e-10));
  assert.ok(Math.abs(new Matrix4().fromArray(result.matrix).determinant()-1)<1e-12);
  assert.deepEqual(originals[0],[0,0,0]);
});
test('no fitting scale to hide mismatched units, and degenerate landmarks are rejected', () => {
  const points=[[0,0,0],[10,0,0],[0,10,0],[0,0,10]];
  const fit=registerCbctLandmarks(points.map(source=>({source,target:source.map(v=>v*2)})),1);
  assert.ok(fit.rmsMm > 1);
  assert.throws(()=>registerCbctLandmarks(points.map(source=>({source,target:source})),0),/scale/);
  assert.throws(()=>registerCbctLandmarks([0,1,2].map(x=>({source:[x,0,0],target:[x,1,0]})),1),/noncollinear/);
});
test('CBCT review is invalidated by pose, role, scale, volume or source changes', () => {
  const positions=new Float32Array([0,0,0,1,0,0,0,1,0]);
  const part={id:'upper',role:'upper',positions,offset:[0,0,0]};
  const record={arch:'upper',volumeId:'volume',mmPerUnit:1,poses:[{id:'upper',matrix:new Matrix4().toArray(),role:'upper',positions}],reviewed:true};
  assert.equal(currentCbctRegistrations([record],[part],'volume',1).length,1);
  for(const changed of [{...part,offset:[1,0,0]},{...part,role:'lower'},{...part,positions:positions.slice()}]) assert.equal(currentCbctRegistrations([record],[changed],'volume',1).length,0);
  assert.equal(currentCbctRegistrations([record],[part],'other',1).length,0);
  assert.equal(currentCbctRegistrations([record],[part],'volume',.1).length,0);
});
test('reference surface keeps its patient origin and explicit conversion separate from local vertices', () => {
  const positions=new Float32Array([0,0,0,1,0,0,0,1,0]);
  const part=tomographyReferencePart({positions,normals:positions.slice(),origin:[12,14,-2],volumeId:'a',triangles:1},.5,true);
  assert.equal(part.positions,positions);
  assert.deepEqual(new Vector3(1,0,0).applyMatrix4(new Matrix4().fromArray(part.pose)).toArray(),[26,28,-4]);
});

test('a remaining registered arch cannot mark the entire scan assembly aligned', () => {
  const parts = [{ role: 'upper' }, { role: 'lower' }, { role: 'bite' }];
  assert.equal(cbctAssemblyRegistered([{ arch: 'lower' }], parts), false);
  assert.equal(cbctAssemblyRegistered([{ arch: 'upper' }, { arch: 'lower' }], parts), true);
  assert.equal(cbctAssemblyRegistered([{ arch: 'upper' }, { arch: 'lower' }], [...parts, { role: 'model' }]), false);
  assert.equal(cbctAssemblyRegistered([], []), false);
});

test('a later file inherits only the common CBCT delta while independent pose edits are rejected', () => {
  const positions = Float32Array.of(0,0,0, 4,0,0, 0,4,0);
  const before = [
    { id: 'upper', role: 'upper', positions, offset: [2,0,0], rotation: [5,7,-3] },
    { id: 'lower', role: 'lower', positions, offset: [0,0,-4] },
  ];
  const delta = new Matrix4().makeRotationFromEuler(new Euler(.2,-.3,.4)).setPosition(28,-16,37);
  const after = applyCbctRigidDelta(before, delta.toArray());
  const inherited = cbctAssemblyDelta(before, after);
  assert.ok(inherited);
  delta.elements.forEach((value, i) => assert.ok(Math.abs(value-inherited[i])<1e-10));
  const added = { id: 'bite', role: 'bite', positions, offset: [0,0,0] };
  const [posed] = applyCbctRigidDelta([added], inherited);
  const point = new Vector3(1,2,0);
  assert.ok(point.clone().applyMatrix4(partMatrix(posed)).distanceTo(point.applyMatrix4(delta))<1e-10);
  assert.equal(cbctAssemblyDelta(before, after.map((part,i)=>i?{...part,offset:[1,0,0]}:part)),null);
  assert.equal(cbctAssemblyDelta(before, after.slice(1)),null);
  assert.equal(cbctAssemblyDelta([], []),null);
});

test('reset snapshots keep native poses and current metadata after a source is removed or reclassified', () => {
  const positions = Float32Array.of(0,0,0, 4,0,0, 0,4,0);
  const native = [{ id: 'keep', role: 'model', positions, offset: [2,3,4] }, { id: 'removed', role: 'lower', positions, offset: [0,0,-5] }];
  const [registered] = applyCbctRigidDelta(native, new Matrix4().makeTranslation(20,-30,40).toArray());
  const current = { ...registered, role: 'upper', name: 'Reviewed upper', visible: false, offset: [1,0,0] };
  const reset = cbctResetParts(native, [current]);
  assert.equal(reset.length, 1);
  assert.equal(reset[0].name, current.name);
  assert.equal(reset[0].role, 'upper');
  assert.equal(reset[0].visible, false);
  assert.equal(reset[0].positions, positions);
  assert.deepEqual(reset[0].offset, [2,3,4]);
  assert.equal(reset[0].pose, undefined);
  assert.ok(cbctSourcesMatch(reset, [current]));
  const replacement = { ...current, positions: positions.slice() };
  assert.equal(cbctResetParts(native, [replacement])[0], replacement);
});

test('automatic CBCT delta preserves shared arch, disconnected part, and hidden bite relationships', () => {
  const positions = new Float32Array([0,0,0,4,0,0,0,3,0]);
  const parts = ['upper-a', 'upper-b', 'lower', 'bite'].map((id, i) => ({
    id, role: i < 2 ? 'upper' : id, positions, offset: [i, -i, i * 2], rotation: [i * 3, i * -2, 5],
    pose: new Matrix4().makeTranslation(i * 8, 2, -4).toArray(),
  }));
  const delta = new Matrix4().makeRotationFromEuler(new Euler(.3, -.2, .7)).setPosition(80, -60, 24);
  const next = applyCbctRigidDelta(parts, delta.toArray());
  const original = parts.map(part => new Vector3(1, 1, 0).applyMatrix4(partMatrix(part)));
  const moved = next.map(part => new Vector3(1, 1, 0).applyMatrix4(partMatrix(part)));
  for (let i = 0; i < parts.length; i++) {
    assert.ok(moved[i].distanceTo(original[i].clone().applyMatrix4(delta)) < 1e-10);
    assert.equal(next[i].positions, parts[i].positions);
    assert.deepEqual(next[i].offset, [0, 0, 0]);
    assert.deepEqual(next[i].rotation, [0, 0, 0]);
    for (let j = 0; j < i; j++) assert.ok(Math.abs(moved[i].distanceTo(moved[j]) - original[i].distanceTo(original[j])) < 1e-10);
  }
  assert.notDeepEqual(parts[0].rotation, [0,0,0]);
  assert.ok(cbctPoseMatches(next, next.map(part => ({ ...part, visible: false, name: 'changed', presentationColor: '#fff' }))));
  assert.equal(cbctPoseMatches(next, next.slice(1)), false);
  assert.equal(cbctPoseMatches(next, next.map((part, i) => i ? part : { ...part, offset: [1,0,0] })), false);
  assert.equal(cbctPoseMatches(next, next.map((part, i) => i ? part : { ...part, positions: positions.slice() })), false);
});
