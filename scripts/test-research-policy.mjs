import assert from 'node:assert/strict';
import {systemHint} from '../server/project-context.mjs';
import {RESEARCH_POLICY,RESEARCH_POLICY_VERSION} from '../lib/research-policy.mjs';
for(const config of [{}, {workbookQuery:true,westockQuery:true}]) {
 const prompt=systemHint({name:'Product Eng',root:'/tmp/qa'},config);
 assert.ok(prompt.includes(RESEARCH_POLICY));assert.ok(prompt.includes(RESEARCH_POLICY_VERSION));
 assert.ok(prompt.includes('普通问答和追问同样适用'));
}
console.log('PASS ordinary/new/resumed session systemHint always includes versioned research policy');
