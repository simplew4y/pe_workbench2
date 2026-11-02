import assert from 'node:assert/strict';
import { snapshotMessages } from '../server/agent/snapshot.mjs';
const a={presentation:{verdict:{text:'旧判断'}}};
const b={presentation:{verdict:{text:'新判断'}}};
const call=(id,state)=>({role:'assistant',content:[{type:'toolCall',id,name:'write',arguments:{path:'exports/analysis-state.json',content:JSON.stringify(state)}}]});
const result=(id,isError=false)=>({role:'toolResult',toolCallId:id,isError});
const user={role:'user',content:'分析'};
const ctx={root:'/tmp/project'};
const session={messages:[user,call('1',a),result('1'),{role:'assistant',content:[{type:'text',text:'回答'}]},user,call('2',b),result('2')]};
let messages=snapshotMessages(session,ctx).filter(x=>x.role==='assistant');
assert.deepEqual(messages[0].analysisState,a); assert.deepEqual(messages[1].analysisState,b);
session.messages.push(user,call('3',a),result('3',true));
messages=snapshotMessages(session,ctx).filter(x=>x.role==='assistant'); assert.equal(messages[2].analysisState,undefined);
session.messages.push(user,{role:'assistant',content:[{type:'toolCall',id:'4',name:'edit',arguments:{path:'exports/analysis-state.json',oldText:'新判断',newText:'更新判断'}}]},result('4'));
messages=snapshotMessages(session,ctx).filter(x=>x.role==='assistant'); assert.equal(messages[3].analysisState.presentation.verdict.text,'更新判断');
const existing={messages:[user,{role:'assistant',content:[{type:'toolCall',id:'r1',name:'read',arguments:{path:'exports/analysis-state.json'}}]},{role:'toolResult',toolCallId:'r1',content:[{type:'text',text:JSON.stringify(a)}]},{role:'assistant',content:[{type:'toolCall',id:'e1',name:'edit',arguments:{path:'exports/analysis-state.json',oldText:'旧判断',newText:'新会话更新'}}]},result('e1')]};
assert.equal(snapshotMessages(existing,ctx)[1].analysisState?.presentation.verdict.text,'新会话更新');
console.log('presentation snapshot passed');

const timedSession={messages:[
  {...user,timestamp:'2026-11-03T02:05:00Z'},
  {...call('timed',a),timestamp:'2026-11-03T02:06:00Z'},result('timed'),
  {role:'assistant',timestamp:'2026-11-03T02:10:00Z',content:'回答'},
]};
assert.equal(snapshotMessages(timedSession,ctx)[1].turnStartedAt,'2026-11-03T02:05:00Z');
