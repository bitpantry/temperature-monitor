import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {handleMonitor} from "../worker/monitor.mjs";
const host="https://example.chatgpt.site";
const start=1795311600000;
const M=60_000;
const ownerEmail="owner@example.test";
const owner={"oai-authenticated-user-id":"owner","oai-authenticated-user-email":ownerEmail};
function fixture(){
  const db=new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../drizzle/0000_monitor.sql",import.meta.url),"utf8"));
  const env={MONITOR_AUTH_MODE:"chatgpt-sites",MONITOR_OWNER_EMAIL:ownerEmail,MONITOR_STATUS_KEY:"a".repeat(64),DB:{prepare(sql){return {bind(...args){const q=db.prepare(sql);return {first:async()=>q.get(...args)??null,all:async()=>({results:q.all(...args)}),run:async()=>({meta:{changes:q.run(...args).changes}})};}};}}};
  const call=(path,{headers={},data,at=start,authed=true,method}={})=>handleMonitor(new Request(host+path,{method:method??(data===undefined?"GET":"POST"),headers:{...(authed?owner:{}),...data!==undefined?{"content-type":"application/json","origin":host}:{},...headers},body:data===undefined?undefined:JSON.stringify(data)}),env,at);
  return {call,db,env};
}
async function setup(call){const r=await call("/api/device-key",{data:{action:"replace"}});assert.equal(r.status,200);return {authorization:"Bearer "+(await r.json()).deviceKey};}
test("boot off, grace, stale and monitor session reset; off retains history",async()=>{
 const {call}=fixture();const h=await setup(call);
 assert.equal((await (await call("/api/dashboard")).json()).alert,null);
 assert.equal((await call("/api/readings",{data:{id:"boot-a:01",tempF:39},headers:h,authed:false})).status,409);
 await call("/api/monitoring",{data:{active:true}});
 assert.equal((await (await call("/api/status",{at:start+4*M})).json()).alert.code,"waiting");
 assert.equal((await (await call("/api/status",{at:start+5*M})).json()).alert.code,"stale");
 assert.equal((await call("/api/readings",{data:{id:"boot-a:01",tempF:39},headers:h,at:start+5*M,authed:false})).status,201);
 await call("/api/monitoring",{data:{active:false},at:start+6*M});
 const off=await (await call("/api/dashboard",{at:start+7*M})).json();
 assert.equal(off.alert,null);assert.equal(off.latest.f,39);
 await call("/api/monitoring",{data:{active:true},at:start+8*M});
 assert.equal((await (await call("/api/status",{at:start+9*M})).json()).alert.code,"waiting");
});
test("auth separation, validation, replay, rate cap and revocation",async()=>{
 const {call,db}=fixture();const h=await setup(call);
 await call("/api/monitoring",{data:{active:true}});
 assert.equal((await call("/api/monitoring",{data:{active:false},headers:{origin:"https://elsewhere.test"}})).status,403);
 assert.equal((await (await call("/api/dashboard",{headers:h,authed:false})).json()).canManage,false);
 assert.equal((await call("/api/status",{headers:h,authed:false})).status,401);
 assert.equal((await call("/api/status",{headers:{authorization:"Bearer "+"a".repeat(64)},authed:false})).status,200);
 const put=(data,headers=h,at=start)=>call("/api/readings",{data,headers,at,authed:false});
 assert.equal((await put({id:"boot-xyz1",tempF:50},{})).status,401);
 assert.equal((await put({id:"boot-xyz1",tempF:500})).status,400);
 assert.equal((await put({id:"boot-xyz1",tempF:36})).status,201);
 assert.equal((await (await put({id:"boot-xyz1",tempF:36})).json()).duplicate,true);
 assert.equal((await put({id:"boot-xyz2",tempF:36})).status,429);
 await call("/api/device-key",{data:{action:"revoke"}});
 assert.equal((await put({id:"boot-xyz2",tempF:36},h,start+M)).status,401);
 assert.equal(db.prepare("SELECT count(*) AS n FROM readings").get().n,1);
});
test("warm -> critical -> stale -> recovery and contextual duration",async()=>{
 const {call}=fixture();const h=await setup(call);await call("/api/monitoring",{data:{active:true}});
 const put=(i,tempF)=>call("/api/readings",{at:start+i*M,authed:false,headers:h,data:{id:"brine-id:"+i,tempF}});
 const get=async i=>(await (await call("/api/status",{at:start+i*M})).json()).alert;
 await put(1,38); assert.equal((await get(1)).code,"warm");
 await put(2,40); await put(3,41);assert.deepEqual(await get(4),{code:"critical",since:start+2*M,minutes:2});
 assert.equal((await get(8)).code,"stale");
 await put(9,37);assert.equal(await get(9),null);
});
test("rolling window, 50 rows, cross-page delta and legacy queries remain live-only",async()=>{
 const {call,db}=fixture();
 const q=db.prepare("INSERT INTO readings VALUES(?,?,?)");
 for(let i=0;i<56;i++)q.run("data-"+i,start+i*M,30+i*.05);
 q.run("old",start-25*60*M,35);
 const at=start+56*M;
 const page=await (await call("/api/dashboard",{at})).json();
 assert.equal(page.series.length,56);assert.equal(page.rows.length,50);assert.equal(page.rows.at(-1).delta,.05);
 const p2=await (await call("/api/dashboard?before="+encodeURIComponent(page.nextBefore),{at})).json();
 assert.equal(p2.rows.length,6);assert.equal(p2.rows[0].at,start+5*M);
 for(const mode of ["normal","warm","critical","stale","empty","single"]){
   const d=await (await call("/api/dashboard?demo="+mode+"&demoAt="+(at-60_000),{at})).json();
   assert.deepEqual(d,page);
   assert.equal(Object.hasOwn(d,"demo"),false);
 }
 assert.equal(db.prepare("SELECT count(*) AS n FROM readings").get().n,57);
});

test("optional relay credential is independently scoped and respects monitoring and owner rotation",async()=>{
 const {call,env,db}=fixture();const direct=await setup(call);
 const token="b".repeat(64), relay={authorization:"Bearer "+token};
 const put=(headers,sequence,at=start)=>call("/api/readings",{at,authed:false,headers,data:{id:"relay-fixture:"+sequence,tempF:38}});
 assert.equal((await put(relay,1)).status,401);
 env.MONITOR_RELAY_INGEST_HASH=createHash("sha256").update(token).digest("hex");
 assert.equal((await (await call("/api/dashboard",{headers:relay,authed:false})).json()).canManage,false);
 assert.equal((await call("/api/status",{headers:relay,authed:false})).status,401);
 assert.equal((await call("/api/device-key",{headers:relay,authed:false,data:{action:"revoke"}})).status,401);
 assert.equal((await call("/api/monitoring",{headers:relay,authed:false,data:{active:true}})).status,401);
 assert.equal((await put(relay,1)).status,409);
 await call("/api/monitoring",{data:{active:true}});
 assert.equal((await put(relay,1)).status,201);
 assert.equal((await put(relay,1)).status,200);
 assert.equal((await put(direct,2,start+M)).status,201);
 await call("/api/device-key",{data:{action:"revoke"}});
 assert.equal((await put(direct,3,start+2*M)).status,401);
 assert.equal((await put(relay,3,start+2*M)).status,201);
 assert.equal(db.prepare("SELECT count(*) AS n FROM readings").get().n,3);
});

test("public reading access; matched owner identity required for controls",async()=>{
 const {call,env}=fixture();
 const original=await setup(call);let at=start;
 const nonOwner={"oai-authenticated-user-id":"someone","oai-authenticated-user-email":"viewer@example.test"};
 const missingId={"oai-authenticated-user-email":ownerEmail};
 const missingEmail={"oai-authenticated-user-id":"owner"};
 for(const headers of [{},nonOwner,missingId,missingEmail,original]){
   for(const path of ["/api/dashboard","/api/dashboard?demo=warm"]){
     const r=await call(path,{authed:false,headers});assert.equal(r.status,200);
     const data=await r.json();assert.equal(data.canManage,false);
     assert.ok(!JSON.stringify(data).includes(ownerEmail));
   }
   assert.equal((await call("/api/monitoring",{authed:false,headers,data:{active:true}})).status,401);
   assert.equal((await call("/api/device-key",{authed:false,headers,data:{action:"revoke"}})).status,401);
   assert.equal((await call("/api/status",{authed:false,headers})).status,401);
 }
 const matched={"oai-authenticated-user-id":"owner","oai-authenticated-user-email":" Owner@EXAMPLE.TEST "};
 assert.equal((await (await call("/api/dashboard",{authed:false,headers:matched})).json()).canManage,true);
 assert.equal((await call("/api/monitoring",{authed:false,headers:matched,data:{active:true}})).status,200);
 const write=await call("/api/readings",{at,authed:false,headers:original,data:{id:"public-demo-test:42",tempF:37}});
 assert.equal(write.status,201);
 const content=await write.text();assert.equal(Number(write.headers.get("content-length")),Buffer.byteLength(content));
 assert.deepEqual((await (await call("/api/dashboard",{authed:false})).json()).latest,{at,f:37});
 env.MONITOR_OWNER_EMAIL="";
 assert.equal((await call("/api/monitoring",{authed:false,headers:matched,data:{active:false}})).status,401);
});
