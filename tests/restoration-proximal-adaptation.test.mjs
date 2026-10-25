import test from 'node:test';
import assert from 'node:assert/strict';
import { planProximalAdaptation, ProximalAdaptationCancelled } from '../src/restoration-proximal-adaptation.ts';
import { generateRestoration, restorationCrownShape } from '../src/restoration-geometry.ts';
import { auditCrownMesh, buildCrownMesh } from '../src/crown-anatomy.ts';
import { createFitIntersectionQuery } from '../src/restoration-fit-intersections.ts';
import { acceptsFitCandidate } from '../src/restoration-fit-selection.ts';
import { createNearestSurfaceQuery } from '../src/collision.ts';
import { Vector3 } from 'three';

function fixture(overrides = {}) {
  const spec = { version: 'implant-assembly/v1', fdi: 36, parentPartId: 'synthetic',
    frame: { origin: [10, -4, 2], u: [1, 0, 0], v: [0, 1, 0], up: [0, 0, 1] },
    parameters: { fixture: { radius: 1.1, length: 5, depth: .4, taper: .3 },
      abutment: { radius: .8, height: 2.1, emergenceRadius: 1.3, angleX: 0, angleY: 0 },
      crown: { width: 5.2, depth: 4.6, height: 3.5, cuspHeight: .4, rotation: 0 } },
    anatomy: 'molar', provenance: 'hypothesized', units: 'file units (u)', source: 'Synthetic geometry only', ...overrides };
  spec.crownShape = restorationCrownShape(spec);
  return spec;
}
const crown = spec => generateRestoration(spec).find(m => m.component === 'crown');
function mapping(s, x, y, z) {
  const a = s.parameters.abutment, angle = s.parameters.crown.rotation * Math.PI / 180;
  const sm = s.anatomicalSigns?.mesial ?? 1, sb = s.anatomicalSigns?.buccal ?? 1;
  const dx = a.height * Math.tan(a.angleY * Math.PI / 180), dy = -a.height * Math.tan(a.angleX * Math.PI / 180);
  const fx = dx + x * sm * Math.cos(angle) - y * sb * Math.sin(angle), fy = dy + x * sm * Math.sin(angle) + y * sb * Math.cos(angle);
  return s.frame.origin.map((v, i) => v + fx * s.frame.u[i] + fy * s.frame.v[i] + (a.height + z) * s.frame.up[i]);
}
function plane(s, x, side, gap = .025) {
  const h = s.parameters.crown.height;
  const p = (y,z) => mapping(s,x,y,z);
  return { id: side+'-target', role: 'adjacent', side, targetGap: gap,
    positions: Float32Array.from([p(-4,0),p(4,0),p(4,h),p(-4,0),p(4,h),p(-4,h)].flat()) };
}
function localWidth(s) {
  const mesh = buildCrownMesh(s.crownShape,[s.parameters.crown.width,s.parameters.crown.depth,s.parameters.crown.height]);
  let low=Infinity,high=-Infinity;
  for(let i=0;i<mesh.vertices.length;i+=3){low=Math.min(low,mesh.vertices[i]);high=Math.max(high,mesh.vertices[i]);}
  return [low,high];
}
const distances = (s, surface) => {
  const q=createNearestSurfaceQuery(surface.positions),p=crown(s).positions,point=new Vector3(),hit=new Vector3();let min=Infinity;
  for(let i=0;i<p.length;i+=3)min=Math.min(min,q.nearestPoint(point.fromArray(p,i),hit));
  return min;
};
const immediate={yieldControl:async()=>{}};

test('measured per-side gaps drive bounded independent wall proposals; anatomy, inputs and topology survive',async()=>{
  const input=fixture(),[low,high]=localWidth(input),targets=[plane(input,high+.12,'mesial'),plane(input,low-.08,'distal')];
  const frozen=structuredClone({input,targets});
  const result=await planProximalAdaptation(input,targets,immediate);
  assert.equal(result.report.status,'proposed',result.report.reason);
  assert.equal(result.candidates.length,3);
  assert.equal(result.spec,result.candidates.at(-1));
  assert.deepEqual({input,targets},frozen);
  assert.deepEqual(result.report.sides.map(s=>s.status),['proposed','proposed']);
  assert.ok(result.report.sides[0].boundedDisplacement>result.report.sides[1].boundedDisplacement,'Different measured deficits produce different amplitudes.');
  const before=generateRestoration(input),base=crown(input);
  for(const candidate of result.candidates){
    assert.deepEqual(candidate.parameters,input.parameters);assert.deepEqual(candidate.frame,input.frame);
    for(const key of ['rim','rimZ','occlusal','apex','dims'])assert.deepEqual(candidate.crownShape[key],input.crownShape[key],key);
    assert.deepEqual(candidate.crownShape.wall.slice(0,96),input.crownShape.wall.slice(0,96));
    assert.deepEqual(candidate.crownShape.wall.slice(13*96),input.crownShape.wall.slice(13*96));
    const after=generateRestoration(candidate),mesh=after.find(m=>m.component==='crown');
    for(const kind of ['fixture','abutment'])assert.deepEqual(after.find(m=>m.component===kind),before.find(m=>m.component===kind));
    assert.equal(mesh.positions.length,base.positions.length);
    assert.ok(auditCrownMesh(buildCrownMesh(candidate.crownShape,[5.2,4.6,3.5])).closed);
    let maximum=0;for(let i=0;i<mesh.positions.length;i+=3)maximum=Math.max(maximum,Math.hypot(...[0,1,2].map(j=>mesh.positions[i+j]-base.positions[i+j])));
    assert.ok(maximum>0 && maximum<=input.parameters.crown.width*.03,maximum);
    for(const surface of targets)assert.ok(distances(candidate,surface)<distances(input,surface));
  }
  assert.ok(result.report.candidates[0].maxDisplacement<result.report.candidates[2].maxDisplacement);
  const strongest=result.spec.crownShape.wall.slice();result.candidates[0].crownShape.wall[96]=0;
  assert.deepEqual(result.spec.crownShape.wall,strongest,'Each candidate owns independent arrays.');
});

test('rotation, both anatomical signs, frame axes, contour and abutment slopes use emitted geometry',async()=>{
  const input=fixture({anatomicalSigns:{mesial:-1,buccal:-1},frame:{origin:[10,-4,2],u:[0,1,0],v:[0,0,-1],up:[-1,0,0]}});
  input.parameters.crown.rotation=37;input.parameters.abutment.angleY=8;input.parameters.abutment.angleX=-5;
  input.contour={cervicalScale:.94,occlusalScale:.85};
  const [,high]=localWidth(input),target=plane(input,high+.08,'mesial');
  const result=await planProximalAdaptation(input,[target],immediate,{maxCandidates:1});
  assert.ok(result.spec,result.report.reason);
  assert.ok(distances(result.spec,target)<distances(input,target));
  assert.deepEqual(result.spec.anatomicalSigns,input.anatomicalSigns);assert.deepEqual(result.spec.contour,input.contour);
  for(let j=1;j<13;j++)for(let a=0;a<96;a++)if(Math.cos(a/96*2*Math.PI)<0)
    assert.equal(result.spec.crownShape.wall[j*96+a],input.crownShape.wall[j*96+a],'Anatomical distal side does not move.');
});

test('near, missing, unlabelled and behind-wall targets do not invent a useful expansion; gaps stay frozen',async()=>{
  const input=fixture(),[,high]=localWidth(input);
  const near=plane(input,high+.01,'mesial',.05);
  const result=await planProximalAdaptation(input,[near],immediate);
  assert.equal(result.spec,null);assert.equal(result.report.sides[0].status,'not-needed');
  assert.equal(result.report.sides[0].targetGap,.05);assert.equal(near.targetGap,.05);
  assert.equal(result.report.sides[1].status,'unknown');
  for(const targets of [[],[{...near,side:undefined}],[plane(input,-4,'mesial')]]){
    const r=await planProximalAdaptation(input,targets,immediate);assert.equal(r.spec,null);assert.equal(r.report.sides[0].status,'unknown');
  }
  const absentGap=plane(input,high+.3,'mesial');delete absentGap.targetGap;
  const defaulted=await planProximalAdaptation(input,[absentGap],immediate,{maxCandidates:1});
  assert.equal(defaulted.report.sides[0].targetGap,.015*3.5);assert.match(defaulted.report.sides[0].targetGapProvenance,/hypothesis/);
});

test('no stacking, invalid options and target budgets, cancellation and expired jobs are explicit',async()=>{
  const input=fixture(),[,high]=localWidth(input),targets=[plane(input,high+.4,'mesial')];
  const first=await planProximalAdaptation(input,targets,immediate,{maxCandidates:1});
  assert.ok(first.spec);
  const second=await planProximalAdaptation(first.spec,targets,immediate);
  assert.equal(second.spec,null);assert.match(second.report.reason,/stacking/);
  for(const options of [{maxDisplacementFraction:.031},{maxCandidates:4},{maxDurationMs:0},{maxTargetTriangles:1}])
    await assert.rejects(planProximalAdaptation(input,targets,immediate,options));
  await assert.rejects(planProximalAdaptation(input,[{...targets[0],targetGap:-1}],immediate),/gap/);
  await assert.rejects(planProximalAdaptation(input,[targets[0],targets[0]],immediate),/unique/);
  await assert.rejects(planProximalAdaptation(input,targets,{checkCancelled:()=>true}),ProximalAdaptationCancelled);
  let stop=false;
  await assert.rejects(planProximalAdaptation(input,targets,{checkCancelled:()=>stop,yieldControl:async()=>{stop=true;}}),ProximalAdaptationCancelled);
  class CallerCancelled extends Error{}
  await assert.rejects(planProximalAdaptation(input,targets,{checkCancelled:()=>{throw new CallerCancelled();}}),CallerCancelled);
  const expired=await planProximalAdaptation(input,targets,{yieldControl:()=>new Promise(resolve=>setTimeout(resolve,5))},{maxDurationMs:1});
  assert.equal(expired.spec,null);assert.deepEqual(expired.candidates,[]);assert.match(expired.report.reason,/time budget/);
});

test('a wall proposal can cross another target: full parent audit observes and rejects that candidate',async()=>{
  const input=fixture(),[,high]=localWidth(input),adjacent=plane(input,high+.15,'mesial');
  const proposed=await planProximalAdaptation(input,[adjacent],immediate,{maxCandidates:1});assert.ok(proposed.spec);
  const [,grown]=localWidth(proposed.spec);assert.ok(grown>high);
  const blocker={...plane(input,(high+grown)/2,'mesial',0),id:'other-tooth',role:'other-tooth',side:undefined};
  const query=createFitIntersectionQuery(blocker.positions,2,()=>{});
  const before=query.test(crown(input).positions),after=query.test(crown(proposed.spec).positions);
  assert.equal(before.transverseCrossingTriangles,0);assert.ok(after.transverseCrossingTriangles>0);
  assert.equal(before.intersectionComplete,true);assert.equal(after.intersectionComplete,true);
  const measurement=(score,m)=>({score,surfaces:[{id:blocker.id,role:blocker.role,targetGap:0,sampledMinDistance:0,...m}]});
  assert.equal(acceptsFitCandidate(measurement(1,after),measurement(2,before)),false,'A better score never accepts the newly observed crossing.');
  assert.match(proposed.report.reason,/no candidate has been accepted/);
});

test('same-side targets with different frozen gaps are order independent and the restrictive target is retained',async()=>{
  const input=fixture(),[,high]=localWidth(input),a=plane(input,high+.12,'mesial',.025),b={...plane(input,high+.12,'mesial',.2),id:'other-mesial'};
  const one=await planProximalAdaptation(input,[a,b],immediate),two=await planProximalAdaptation(input,[b,a],immediate);
  assert.equal(one.spec,null);assert.equal(two.spec,null);
  assert.deepEqual(one.report.sides,two.report.sides);
  assert.equal(one.report.sides[0].targetId,b.id);assert.equal(one.report.sides[0].targetConstraints.length,2);
  b.targetGap=.08;
  const three=await planProximalAdaptation(input,[a,b],immediate),four=await planProximalAdaptation(input,[b,a],immediate);
  assert.ok(three.spec && four.spec);assert.deepEqual(three.spec,four.spec);
  assert.equal(three.report.sides[0].targetId,b.id);
});

test('all target coordinates and metadata are snapshotted before yielding; degenerate evidence is rejected',async()=>{
  const input=fixture(),[low,high]=localWidth(input),surfaces=[plane(input,high+.12,'mesial'),plane(input,low-.12,'distal')];
  const expected=await planProximalAdaptation(input,surfaces,immediate);
  let mutated=false;
  const observed=await planProximalAdaptation(input,surfaces,{yieldControl:async()=>{if(mutated)return;mutated=true;for(const s of surfaces){s.positions.fill(0);s.side='distal';s.id='changed';s.targetGap=100;s.targetProvenance='changed';}}});
  assert.deepEqual(observed.spec,expected.spec);assert.deepEqual(observed.report.sides,expected.report.sides);
  const degenerate={id:'invalid',role:'adjacent',side:'mesial',positions:new Float32Array(9).fill(1)};
  await assert.rejects(planProximalAdaptation(input,[degenerate],immediate),/degenerate/);
});

test('cancellation is checked inside the full-target sampling block loop',async()=>{
  const input=fixture(),[,high]=localWidth(input),target=plane(input,high+.12,'mesial');
  const positions=new Float32Array(4096*10*9);
  for(let i=0;i<positions.length;i+=target.positions.length)positions.set(target.positions,i);
  let yields=0,samplingChecks=0;
  await assert.rejects(planProximalAdaptation(input,[{...target,positions}],{
    yieldControl:async()=>{yields++;},
    checkCancelled:()=>yields===11 && ++samplingChecks>=4,
  },{maxDurationMs:60000}),ProximalAdaptationCancelled);
  assert.equal(yields,11,'Ten preparation yields then the first wall sample; cancellation occurs before leaving its block loop.');
});
