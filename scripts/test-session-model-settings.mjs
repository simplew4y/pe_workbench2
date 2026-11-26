import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWorkbench } from "../server/create-app.mjs";
import { loadConfig } from "../server/config.mjs";

const root = await mkdtemp(path.join(tmpdir(),"pe-model-settings-"));
process.env.DEEPSEEK_API_KEY = "offline-fixture";
const config = {...await loadConfig({root,env:{
  DEEPSEEK_API_KEY:"offline-fixture",
  ASR:"0",WATCH_SCHEDULER:"0",TRACKING_SCHEDULER:"0",MONITOR_SCHEDULER:"0",SOURCE_SCHEDULER:"0",
}})};
const alt = {...config.model,id:"fixture-off-only",name:"Fixture model",reasoning:false};
const resolveModel = config.resolveModel;
config.allowedModels = new Set([...config.allowedModels,alt.id]);
config.resolveModel = id => id === alt.id ? alt : resolveModel(id);
const payloads = [];
config.modelPayload = payload => {
  payloads.push(payload);
  throw new Error("Offline settings test: intercepted before sending");
};
let app, base;
async function open() {
  app = await createWorkbench({config,logger:{}});
  ({url:base} = await app.listen(0,"127.0.0.1"));
}
async function request(route, body, status=200) {
  const response = await fetch(base+route,body === undefined ? {} : {
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),
  });
  assert.equal(response.status,status);
  return response.json();
}
const sessionRoute = (id,action)=>`/api/sessions/${id}/${action}`;
const read = id => request(sessionRoute(id,"state"));
const change = (id,settings,status)=>request(sessionRoute(id,"model"),settings,status);
try {
  await open();
  const health = await request("/api/health");
  assert.deepEqual(health.models.find(model=>model.id==="deepseek-flash").thinkingLevels,["off","low","high","max"]);
  const first=await request("/api/sessions",{},201);
  const second=await request("/api/sessions",{},201);
  assert.equal(first.thinkingLevel,"high");
  assert.equal((await change(first.id,{thinkingLevel:"low"})).thinkingLevel,"low");
  assert.equal((await change(second.id,{thinkingLevel:"max"})).thinkingLevel,"max");
  await change(first.id,{thinkingLevel:"medium"},400);
  await change(first.id,{model:alt.id,thinkingLevel:"high"},400);
  assert.equal((await read(first.id)).model,"deepseek-flash");
  await change(second.id,{model:alt.id});
  assert.equal((await read(second.id)).thinkingLevel,"off");
  await app.close();
  await open();
  assert.equal((await read(first.id)).thinkingLevel,"low","empty session retains its choice after restart");
  assert.equal((await read(second.id)).model,alt.id,"empty session restores its model independently");
  assert.equal((await read(second.id)).thinkingLevel,"off");
  const entry = await app.sessions.ensureEntry(first.id);
  entry.postAnswerPending = true;
  await change(first.id,{thinkingLevel:"high"},409);
  entry.postAnswerPending = false;
  for (const level of ["off","low","high","max"]) {
    await change(first.id,{thinkingLevel:level});
    payloads.length=0;
    await entry.session.prompt("你好");
    const payload=payloads.at(-1);
    assert.equal(payload?.thinking?.type,level==="off"?"disabled":"enabled");
    assert.equal(payload?.reasoning_effort,level==="off"?undefined:level);
  }
  console.log("session model settings: four wire modes, independent sessions, empty-session restart and busy guard passed");
} finally {
  await app?.close();
  await rm(root,{recursive:true,force:true});
}
