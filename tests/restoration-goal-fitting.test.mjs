import test from 'node:test';
import assert from 'node:assert/strict';
import { fitRestorationToGoals, goalEvidenceRevision } from '../src/restoration-goal-fitting.ts';
import { fitRestoration, RestorationFitCancelled } from '../src/restoration-fitting.ts';
import { generateRestoration } from '../src/restoration-geometry.ts';
import { restorationGoalSnapshot, restorationGoalSchema, goalParameterBounds, preservesGoalEvidence, acceptsGoalCandidate } from '../src/restoration-goals.ts';
import { assertAgentEditPreservesEvidence } from '../src/restoration-edit-policy.ts';
import { restorationFeedbackTargetId } from '../src/restoration-feedback.ts';
const spec=()=>({version:'implant-assembly/v1',fdi:36,parentPartId:'lower',frame:{origin:[0,0,0],u:[1,0,0],v:[0,1,0],up:[0,0,1]},parameters:{fixture:{radius:1,length:5,depth:0,taper:.1},abutment:{radius:.8,height:1,emergenceRadius:1.1,angleX:0,angleY:0},crown:{width:4,depth:4,height:3,cuspHeight:0,rotation:0}},anatomy:'molar',provenance:'hypothesized',units:'file units (u)',source:'Synthetic goal regression'});
const plane=(axis,value)=>{const p=(a,b)=>{const v=[a,b];v.splice(axis,0,value);return v;};return Float32Array.from([p(-10,-10),p(10,-10),p(10,10),p(-10,-10),p(10,10),p(-10,10)].flat());};
const tissue=()=>({id:'lower:gum',role:'tissue',positions:plane(2,-.25),targetGap:0});
const opts={maxCandidates:9,maxDurationMs:12000,samplesPerSurface:32};

test('a capped audit cannot erase or reduce observed crossings to win the goal objective', () => {
 const surface={id:'dense-target',role:'adjacent',side:'mesial',targetGap:.1,sourceComponents:['crown'],intersectionComplete:false,intersectingTriangles:4,transverseCrossingTriangles:4};
 const previous={report:{after:{surfaces:[surface]}}};
 const before={rows:[{id:'crossings',priority:'required',actual:4,status:'fail'}],requiredError:4,preferenceError:0};
 for(const remaining of [0,2]){
  const candidate={report:{after:{surfaces:[{...surface,intersectingTriangles:remaining,transverseCrossingTriangles:remaining}]}}};
  const next={rows:[{id:'crossings',priority:'required',actual:remaining,status:remaining?'fail':'unknown'}],requiredError:remaining,preferenceError:0};
  assert.equal(acceptsGoalCandidate(candidate,previous,next,before),false);
 }
 const complete={report:{after:{surfaces:[{...surface,intersectionComplete:true,intersectingTriangles:0,transverseCrossingTriangles:0}]}}};
 assert.equal(acceptsGoalCandidate(complete,previous,{rows:[{id:'crossings',priority:'required',actual:0,status:'pass'}],requiredError:0,preferenceError:0},before),true);
});

test('an exposed generic fixture drives an actual depth revision while crown and source frame are preserved',async()=>{
 const original=spec(),before=structuredClone(original),meshes=generateRestoration(original);
 const result=await fitRestorationToGoals({spec:original,surfaces:[tissue()],options:opts});
 assert.deepEqual(original,before);
 assert.ok(result.spec.parameters.fixture.depth>.25);
 assert.deepEqual(result.spec.frame,original.frame);
 assert.deepEqual(result.components.find(m=>m.component==='crown').positions,meshes.find(m=>m.component==='crown').positions);
 assert.equal(result.report.gingiva.status,'pass'); assert.equal(result.report.gingiva.coverage,1);
 assert.ok(result.report.goal.selectedAttempt>0); assert.equal(result.report.goal.status,'unknown');
 assert.equal(result.history.length,1);assert.deepEqual(result.history[0].parameters,result.spec.parameters);
 assert.deepEqual(result.report.after.surfaces[0].sourceComponents,['crown']);
 assert.ok(result.report.goal.after.rows.some(r=>r.priority==='clinical'&&r.status==='unknown'));
 assert.ok(result.report.goal.emergence?.length===1);
});

test('exact manual mode measures unmet requirements without silently changing entered values',async()=>{
 const original=spec();const result=await fitRestorationToGoals({spec:original,surfaces:[tissue()],options:{...opts,maxCandidates:1}});
 assert.deepEqual(result.spec.parameters,original.parameters);assert.equal(result.report.gingiva.status,'fail');
 assert.equal(result.report.goal.attempts.length,1);assert.equal(result.report.goal.termination,'measurement-only');
});

test('goal retry preserves original geometry bounds after target-ID remapping',async()=>{
 const initial=await fitRestorationToGoals({spec:spec(),surfaces:[tissue()],options:opts});
 const contract=structuredClone(initial.report.goal),oldHash=restorationFeedbackTargetId(tissue().id),newHash=restorationFeedbackTargetId('renamed:gum');
 contract.targetGaps={'renamed:gum':contract.targetGaps[tissue().id]};
 for(const snapshot of [contract.before,contract.after,contract.contract,...contract.attempts.map(a=>a.snapshot)])for(const row of snapshot.rows)row.id=row.id.replace(oldHash,newHash);
 const retry=await fitRestorationToGoals({spec:initial.spec,surfaces:[{...tissue(),id:'renamed:gum'}],goalContract:contract,options:opts});
 assert.deepEqual(retry.report.goal.bounds,initial.report.goal.bounds);
 assert.deepEqual(Object.keys(retry.report.goal.targetGaps),['renamed:gum']);
 assert.ok(retry.spec.parameters.fixture.depth<=initial.report.goal.bounds['fixture.depth'][1]);
});

test('retry cannot silently drop a previously required target',async()=>{
 const initial=await fitRestorationToGoals({spec:spec(),surfaces:[tissue()],options:{...opts,maxCandidates:1}});
 await assert.rejects(fitRestorationToGoals({spec:initial.spec,surfaces:[],goalContract:initial.report.goal,options:opts}),/previous goal target is missing/);
});

test('legacy combined and explicit crown-only tissue audits remain distinct and honest',async()=>{
 const original=spec(),surfaces=[{...tissue(),positions:plane(2,.25)}];
 const combined=await fitRestoration({spec:original,surfaces,options:{...opts,maxCandidates:1,verifyBaselineIntersections:true}});
 const goal=await fitRestorationToGoals({spec:original,surfaces,options:{...opts,maxCandidates:1}});
 assert.ok(combined.report.after.surfaces[0].transverseCrossingTriangles>0);
 assert.equal(goal.report.after.surfaces[0].transverseCrossingTriangles,0);
 assert.ok(goal.report.goal.emergence[0].transverseCrossingTriangles>0);
 assert.equal(preservesGoalEvidence(goal,combined,goal.report.goal.after,goal.report.goal.before),false);
});

test('required contact bands stay fixed and strict component boundaries remain failed',async()=>{
 const original=spec();const r=await fitRestorationToGoals({spec:original,surfaces:[],options:{...opts,maxCandidates:1}});
 const copy=structuredClone(r),before=structuredClone(r.report.goal.after);
 const row=copy.report.goal.after.rows.find(r=>r.id==='component-presentation.abutment-radius');
 copy.spec.parameters.abutment.radius=row.upper;
 copy.report.quality.final.criteria.find(c=>c.id==='component-presentation').status='fail';
 const snapshot=restorationGoalSnapshot(copy,copy.report.gingiva,before);
 const at=snapshot.rows.find(r=>r.id===row.id);assert.equal(at.exclusiveUpper,true);assert.equal(at.status,'fail');
 assert.throws(()=>assertAgentEditPreservesEvidence({spec:r.spec,fit:r.report},{...copy,report:{...copy.report,goal:{...copy.report.goal,after:snapshot}}}),/rejected/);
});

test('goal gate permits coverage variation within a requirement but rejects lost targets and complete audits',()=>{
 const surface={id:'upper:ant',role:'antagonist',targetGap:.1,sourceComponents:['crown'],transverseCrossingTriangles:0,intersectionComplete:true,occlusalRayHits:107};
 const old={report:{after:{surfaces:[surface]}}},next={report:{after:{surfaces:[{...surface,occlusalRayHits:105}]}}};
 const snapshot={rows:[{id:'coverage',priority:'required',status:'pass',actual:.89}],requiredError:0,preferenceError:0};
 assert.equal(preservesGoalEvidence(next,old,snapshot,snapshot),true);
 for(const patch of [{occlusalRayHits:0},{intersectionComplete:false},{transverseCrossingTriangles:1}]){
  next.report.after.surfaces[0]={...surface,...patch};assert.equal(preservesGoalEvidence(next,old,snapshot,snapshot),false);
 }
});

test('bounds include initially steep slopes and cancel errors propagate before committing a candidate',async()=>{
 const original=spec();original.parameters.abutment.angleY=70;
 const [lo,hi]=goalParameterBounds(original.parameters)['abutment.angleY'];assert.ok(lo<=70&&hi>=70);
 await assert.rejects(fitRestorationToGoals({spec:spec(),surfaces:[tissue()],options:opts},{checkCancelled:()=>true}),RestorationFitCancelled);
 let yields=0;await assert.rejects(fitRestorationToGoals({spec:spec(),surfaces:[tissue()],options:opts},{checkCancelled:()=>yields>2,yieldControl:async()=>{yields++;}}),RestorationFitCancelled);
});

test('burying a larger fixture cannot discard complete gum-ray coverage and count as improvement',async()=>{
 const original=spec(),patch=Float32Array.from([-1,-2,-.2,1,-2,-.2,1,2,-.2,-1,-2,-.2,1,2,-.2,-1,2,-.2]);
 const surfaces=[{...tissue(),positions:patch}],options={...opts,maxCandidates:1};
 const before=await fitRestorationToGoals({spec:original,surfaces,options});
 const changed=structuredClone(before.spec);changed.parameters.fixture.radius=1.05;changed.parameters.fixture.depth=.3;
 const after=await fitRestorationToGoals({spec:changed,surfaces,goalContract:before.report.goal,options});
 assert.equal(before.report.gingiva.knownSamples,before.report.gingiva.samples);
 assert.equal(before.report.gingiva.status,'fail');assert.equal(after.report.gingiva.status,'unknown');
 assert.ok(after.report.gingiva.coverage<1);assert.ok(after.report.goal.after.requiredError<before.report.goal.after.requiredError);
 assert.equal(preservesGoalEvidence(after,before,after.report.goal.after,before.report.goal.after),false);
 assert.throws(()=>assertAgentEditPreservesEvidence({spec:before.spec,fit:before.report},after),/rejected/);
});

test('a peripheral ray allowance cannot erase another ray\'s exposure deficit', async () => {
 const result = await fitRestorationToGoals({spec:spec(),surfaces:[],options:{...opts,maxCandidates:1}});
 const gingiva = {...result.report.gingiva,status:'fail',maxExposure:.00002,exposureTolerance:.00005,knownSamples:2,samples:2,coverage:1,missedSamples:0,ambiguousSamples:0,
  sampleMeasurements:[{point:[0,0,0],status:'known',exposure:.00002,numericTolerance:.00001,exposureTolerance:.00001},
  {point:[1,0,0],status:'known',exposure:-1,numericTolerance:.00005,exposureTolerance:.00005}]};
 const before = restorationGoalSnapshot(result,gingiva), row = before.rows.find(row=>row.id==='fixture-gingiva');
 assert.equal(row.status,'fail'); assert.ok(Math.abs(row.error-.00001)<1e-12); assert.equal(row.upper,0);
 const resolved={...gingiva,status:'pass',maxExposure:-.00001,sampleMeasurements:gingiva.sampleMeasurements.map(sample=>({...sample,exposure:sample.exposure-.00003}))};
 const after=restorationGoalSnapshot(result,resolved,before), next=after.rows.find(row=>row.id==='fixture-gingiva');
 assert.equal(next.status,'pass'); assert.equal(next.error,0); assert.ok(after.requiredError<before.requiredError);
});

test('measured gap and headroom ceilings are required fixed goals and drive coordinated size repair on the worker path', async () => {
 const original=spec();
 original.qualityContext={version:'restoration-quality-context/v1',units:'file units (u)',
  neighbors:[{id:'source-neighbor',mesiodistal:4,buccolingual:4,height:4,method:'Synthetic source envelope',provenance:'measured'}],
  gapWidth:{value:3.5,method:'Synthetic facing-surface gap',provenance:'measured'},
  availableHeight:{value:3.7,method:'Synthetic verified headroom',provenance:'measured'},bitePoseVerified:true,expectedProximalSides:[]};
 const input={spec:original,surfaces:[],options:opts},before=structuredClone(input);
 const result=await fitRestorationToGoals(input);
 assert.deepEqual(input,before);
 for(const id of ['space-occupancy.mesiodistal','space-occupancy.vertical']){
  const initial=result.report.goal.before.rows.find(row=>row.id===id),next=result.report.goal.after.rows.find(row=>row.id===id);
  assert.equal(initial.priority,'required'); assert.equal(initial.status,'fail');
  assert.equal(next.upper,initial.upper); assert.ok(next.actual<initial.actual);
 }
 assert.ok(result.report.goal.attempts.some(attempt=>attempt.accepted&&attempt.reason.startsWith('Coordinate crown dimension repairs')));
 assert.ok(result.report.goal.after.requiredError<result.report.goal.before.requiredError);
 assert.deepEqual(result.spec.parameters.fixture,original.parameters.fixture); assert.deepEqual(result.spec.frame,original.frame);
 assert.notEqual(result.report.goal.status,'satisfied','Absent mouth/gum/clinical evidence cannot claim success.');
});

test('goal fitting proposes actual collision relief before broad contact expansion', async () => {
 const original=spec(),surfaces=[{id:'mesial-collision',role:'adjacent',side:'mesial',positions:plane(0,1.96),targetGap:.1}];
 const before=structuredClone(surfaces),result=await fitRestorationToGoals({spec:original,surfaces,options:opts});
 const first=result.report.goal.before.rows.find(row=>row.id.endsWith('.crossings'));
 const last=result.report.goal.after.rows.find(row=>row.id===first.id);
 assert.ok(first.actual>0); assert.equal(last.actual,0);
 assert.ok(result.report.goal.attempts.some(attempt=>attempt.accepted&&attempt.reason.startsWith('Relieve observed tooth/source-arch crossings')));
 assert.ok(result.spec.parameters.crown.width<original.parameters.crown.width);
 assert.deepEqual(surfaces,before); assert.deepEqual(result.spec.parameters.fixture,original.parameters.fixture);
 assert.equal(result.report.after.surfaces[0].intersectionComplete,true);
});

test('core support is measured before every goal gate, independent of gum, and repairs keep selected history consistent', async () => {
 const original=spec(); original.componentDesign='nested-support/v1'; original.parameters.abutment.radius=2;
 const result=await fitRestorationToGoals({spec:original,surfaces:[],options:{...opts,maxCandidates:4}});
 const support=snapshot=>snapshot.rows.find(row=>row.id==='component-support.pilar-enclosure');
 assert.equal(support(result.report.goal.before).priority,'required'); assert.equal(support(result.report.goal.before).status,'fail');
 assert.ok(result.report.goal.attempts.length>1);
 assert.ok(result.report.goal.attempts.every(attempt=>support(attempt.snapshot)));
 assert.ok(result.spec.parameters.abutment.radius<original.parameters.abutment.radius);
 assert.ok(support(result.report.goal.after).actual<support(result.report.goal.before).actual);
 assert.ok(result.spec.parameters.abutment.radius>=result.report.goal.bounds['abutment.radius'][0]);
 const criterion=report=>report.criteria.find(row=>row.id==='component-support');
 assert.deepEqual(criterion(result.history[0].quality),criterion(result.report.quality.final));
 assert.deepEqual(criterion(result.report.quality.initial),criterion(result.report.quality.final));
 assert.equal(result.report.gingiva.status,'unknown'); assert.notEqual(result.report.goal.status,'satisfied');
});

test('support construction profile changes the evidence fingerprint and old optional search bounds never rebase', async () => {
 const original=spec(),input={spec:original,surfaces:[]},nested=structuredClone(input); nested.spec.componentDesign='nested-support/v1';
 assert.notEqual(goalEvidenceRevision(input),goalEvidenceRevision(nested));
 const result=await fitRestorationToGoals({...input,options:{...opts,maxCandidates:1}}),legacy=structuredClone(result.report.goal);
 for(const key of ['abutment.radius','abutment.emergenceRadius','abutment.angleX'])delete legacy.bounds[key];
 for(const snapshot of [legacy.before,legacy.after,legacy.contract,...legacy.attempts.map(attempt=>attempt.snapshot)])
  snapshot.rows=snapshot.rows.filter(row=>row.id!=='component-support.pilar-enclosure');
 assert.equal(restorationGoalSchema.safeParse(legacy).success,true);
 const retried=await fitRestorationToGoals({...input,goalContract:legacy,options:{...opts,maxCandidates:1}});
 assert.deepEqual(retried.report.goal.bounds,legacy.bounds);
 const support=retried.report.goal.after.rows.find(row=>row.id==='component-support.pilar-enclosure');
 assert.equal(support.status,'unknown'); assert.equal(support.actual,null);
 assert.ok(retried.report.goal.contract.rows.some(row=>row.id===support.id));
});

test('support and gum failure witnesses cannot disappear through incomplete replacement measurements', () => {
 const report=(outside,unknown=0)=>({quality:{final:{criteria:[{id:'component-support',status:outside?'fail':unknown?'unknown':'pass',measured:{supportSamples:10,outsideSamples:outside,unknownSamples:unknown,sampledMaxOutsideDistance:outside?.2:null,numericTolerance:1e-6}}]}},after:{surfaces:[]}});
 const previous={report:report(4)},before={rows:[{id:'component-support.pilar-enclosure',priority:'required',actual:4,error:4,status:'fail'}],requiredError:4,preferenceError:0};
 const next={rows:[{...before.rows[0],actual:0,error:0,status:'unknown'}],requiredError:0,preferenceError:0};
 assert.equal(preservesGoalEvidence({report:report(0,4)},previous,next,before),false);
 assert.equal(preservesGoalEvidence({report:report(0)},previous,{...next,rows:[{...next.rows[0],status:'pass'}]},before),true);
 const gum={samples:10,knownSamples:6,unknownSupportSamples:2,unsupportedSamples:4,maxUnsupportedExposure:.2,numericTolerance:1e-6};
 assert.equal(preservesGoalEvidence({report:{after:{surfaces:[]},abutmentGingiva:{...gum,knownSamples:4,unsupportedSamples:0,maxUnsupportedExposure:null}}},
  {report:{after:{surfaces:[]},abutmentGingiva:gum}},{rows:[]},{rows:[]}),false);
});

test('every target retains its own tight fixed band, coverage and crossing evidence even if total error improves', async () => {
 const surfaces=[{id:'mesial',role:'adjacent',side:'mesial',positions:plane(0,2.2),targetGap:.01},
  {id:'distal',role:'adjacent',side:'distal',positions:plane(0,-2.2),targetGap:.02},
  {id:'opponent',role:'antagonist',positions:plane(2,5),targetGap:.03}];
 const baseline=await fitRestorationToGoals({spec:spec(),surfaces,options:{...opts,maxCandidates:1}});
 const snapshot=baseline.report.goal.after,md=baseline.report.quality.final.crownExtents.mesiodistal,height=baseline.report.quality.final.crownExtents.occlusal;
 for(const surface of surfaces){
  const kind=surface.role==='adjacent'?'proximal-gap':'occlusal-gap';
  const requirement=snapshot.rows.find(row=>row.id.startsWith(restorationFeedbackTargetId(surface.id))&&row.id.endsWith(kind));
  assert.ok(Math.abs(requirement.upper-(surface.targetGap+(surface.role==='adjacent'?md*.005:height*.01)))<1e-12);
 }
 const candidate=structuredClone(baseline),distal=candidate.report.after.surfaces.find(row=>row.id==='distal');
 const mesial=candidate.report.after.surfaces.find(row=>row.id==='mesial');
 mesial.sampledMinDistance=0;
 distal.sampledMinDistance+=.05;
 let measured=restorationGoalSnapshot(candidate,candidate.report.gingiva,snapshot);
 assert.equal(preservesGoalEvidence(candidate,baseline,measured,snapshot),false,'Improved mesial proximity cannot worsen a separate required distal deficit.');
 distal.sampledMinDistance=baseline.report.after.surfaces.find(row=>row.id==='distal').sampledMinDistance;
 distal.transverseCrossingTriangles=1; measured=restorationGoalSnapshot(candidate,candidate.report.gingiva,snapshot);
 assert.equal(preservesGoalEvidence(candidate,baseline,measured,snapshot),false);
 distal.transverseCrossingTriangles=0;
 const opponent=candidate.report.after.surfaces.find(row=>row.id==='opponent'); opponent.occlusalRayHits=1;
 measured=restorationGoalSnapshot(candidate,candidate.report.gingiva,snapshot);
 assert.equal(preservesGoalEvidence(candidate,baseline,measured,snapshot),false,'Positive hits alone cannot excuse dropping below the fixed coverage requirement.');
 const missing=structuredClone(baseline); missing.report.after.surfaces.pop();
 assert.equal(preservesGoalEvidence(missing,baseline,restorationGoalSnapshot(missing,missing.report.gingiva,snapshot),snapshot),false);
});

test('unclassified incomplete crossing counts cannot increase while another objective improves', () => {
 const surface={id:'unclassified',role:'tissue',targetGap:0,sourceComponents:['crown'],intersectionComplete:false,intersectingTriangles:4};
 const previous={report:{after:{surfaces:[surface]}}},candidate={report:{after:{surfaces:[{...surface,intersectingTriangles:8}]}}};
 assert.equal(acceptsGoalCandidate(candidate,previous,{rows:[],requiredError:0,preferenceError:0},{rows:[],requiredError:1,preferenceError:0}),false);
});
