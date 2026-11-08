import assert from 'node:assert/strict';
import {searchTranscript, createTranscriptSearchTool} from '../lib/transcript-search-tool.mjs';
const messages=[
 {role:'custom',customType:'pe_turn_context',content:'7.3'},
 {role:'user',content:'利润 7.3 亿',timestamp:1},
 {role:'assistant',content:[{type:'text',text:'工具前噪音 7.3'},{type:'toolCall',name:'read'}],stopReason:'toolUse'},
 {role:'toolResult',content:'7.3'},
 {role:'assistant',content:'利润为 7.3 亿。',stopReason:'stop',timestamp:2},
 {role:'user',peInternal:true,content:'7.3'},
 {role:'user',content:'更正为72.93亿',timestamp:3},
 {role:'assistant',content:'利润现值72.93亿。',stopReason:'stop',timestamp:4},
];
let r=searchTranscript(messages,{query:'利润 7.3',limit:1});
assert.equal(r.totalMatches,2); assert.equal(r.matches.length,1); assert.equal(r.matches[0].turn,1); assert.ok(r.matches[0].excerpt.includes('**7.3**')); assert.equal(r.coverage.turnsScanned,2);
assert.equal(searchTranscript(messages,{query:'7.3',turn:2}).totalMatches,0);
assert.equal(searchTranscript(messages,{query:'72.93',turnRange:[2,2]}).totalMatches,2);
assert.equal(searchTranscript(messages,{query:'工具前噪音'}).totalMatches,0);
assert.equal(searchTranscript(messages,{query:''}).totalMatches,0);
const tool=createTranscriptSearchTool({getMessages:()=>messages});
assert.equal((await tool.execute('x',{query:'7.3'})).details.totalMatches,2);
console.log('transcript search PASS');
