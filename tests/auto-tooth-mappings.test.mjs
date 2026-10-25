import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeToothMappings } from '../src/auto-tooth-mappings.ts';
const mapping=(candidateId,fdi,source='haiku')=>({candidateId,fdi,source,needsReview:fdi===null,reason:'Evidence'});
test('a model retry cannot replace a manually corrected FDI or reuse it for another candidate',()=>{
 const current=[mapping(1,18,'user'),mapping(2,17)];
 const result={mappings:[mapping(1,16),mapping(2,18)],possibleMissing:[{fdi:18,reason:'Gap'},{fdi:15,reason:'Gap'}],warnings:[]};
 const merged=mergeToothMappings(current,result);
 assert.equal(merged.mappings[0],current[0]);
 assert.equal(merged.mappings[1].fdi,null);assert.equal(merged.mappings[1].needsReview,true);
 assert.equal(merged.mappings[1].source,'model');
 assert.deepEqual(merged.possibleMissing,[{fdi:15,reason:'Gap'}]);
 assert.equal(result.mappings[0].fdi,16);assert.equal(result.mappings[1].fdi,18);
 assert.match(merged.warnings.join(' '),/Kept the user-reviewed/);
});
test('an explicitly unresolved user mapping stays unresolved across model retries',()=>{
 const manual=mapping(1,null,'user');
 const merged=mergeToothMappings([manual],{mappings:[mapping(1,16)],possibleMissing:[],warnings:[]});
 assert.equal(merged.mappings[0],manual);assert.equal(merged.mappings[0].needsReview,true);
});
