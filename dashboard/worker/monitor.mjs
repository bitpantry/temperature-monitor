const MIN=60_000, STALE=5*MIN, DAY=24*60*MIN;
const READING_ID=/^[A-Za-z0-9._:-]{8,96}$/;
const KEY=/^[a-f0-9]{64}$/;
export const defaults={active:0,started_at:null,ingest_hash:null};
const hdr={"cache-control":"private, no-store","x-content-type-options":"nosniff","referrer-policy":"no-referrer","x-frame-options":"SAMEORIGIN"};
const encode=new TextEncoder();
const reply=(data,status=200,extra={})=>{
  const json=JSON.stringify(data);
  return new Response(json,{status,headers:{...hdr,...extra,"content-type":"application/json","content-length":String(encode.encode(json).length)}});
};
const normalizedEmail=(value)=>typeof value==="string"?value.trim().toLowerCase():"";
const err=(error,status)=>reply({error},status);
const readable=(a)=>a?{at:a.at,f:a.f}:null;
const between=(n,a,b)=>typeof n==="number"&&Number.isFinite(n)&&n>=a&&n<=b;
const minutes=(now,since)=>Math.max(0,Math.floor((now-since)/MIN));
const check=(a,b)=>{if(!a||!b||a.length!==b.length)return false;let x=0;for(let i=0;i<a.length;i++)x|=a.charCodeAt(i)^b.charCodeAt(i);return x===0;};
async function hash(t){return [...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(t)))].map(v=>v.toString(16).padStart(2,"0")).join("");}
function bearer(req){const a=req.headers.get("authorization");return a?.startsWith("Bearer ")?a.slice(7):null;}
async function body(req){
  if(req.headers.get("content-type")?.split(";")[0].trim()!=="application/json")return null;
  const reader=req.body?.getReader();
  if (!reader)return null;
  const d=new TextDecoder("utf-8",{fatal:true}); let v="",n=0;
  try{while(true){const {value,done}=await reader.read();if(done)break;n+=value.byteLength;if(n>512){await reader.cancel();return null;}v+=d.decode(value,{stream:true});}return JSON.parse(v+d.decode());}catch{return null;}finally{reader.releaseLock();}
}
const row=(db,sql,...args)=>db.prepare(sql).bind(...args).first();
const list=async(db,sql,...args)=>(await db.prepare(sql).bind(...args).all()).results??[];
const run=(db,sql,...args)=>db.prepare(sql).bind(...args).run();
const state=(db)=>row(db,"SELECT active, started_at, ingest_hash FROM monitor WHERE id=1");
const latest=(db)=>row(db,"SELECT at,f FROM readings ORDER BY at DESC,id DESC LIMIT 1");
export function alertFor(now, config, data, points=[]){
  if(!config.active)return null;
  const last=data&&data.at>=config.started_at?data:null;
  const base=last?.at??config.started_at;
  if(now-base>=STALE)return {code:"stale",since:base,minutes:minutes(now,base)};
  if(!last)return {code:"waiting",since:base,minutes:minutes(now,base)};
  if(last.f<38)return null;
  const cutoff=last.f>=40?40:38, code=cutoff===40?"critical":"warm";
  let since=last.at;
  for(let i=points.length-1;i>=0;i--){const p=points[i];if(p.at>last.at)continue;if(p.at<config.started_at||since-p.at>=STALE||p.f<cutoff)break;since=p.at;}
  return {code,since,minutes:minutes(now,since)};
}
const delta=(a,b)=>b?Math.round((a.f-b.f)*1000)/1000:null;
function isOwner(req,env){
  if(env.MONITOR_AUTH_MODE==="chatgpt-sites"){
    // Enable only where a trusted Sites gateway strips and injects these headers.
    const identity=req.headers.get("oai-authenticated-user-id")?.trim();
    const email=normalizedEmail(req.headers.get("oai-authenticated-user-email"));
    const registered=normalizedEmail(env.MONITOR_OWNER_EMAIL);
    return Boolean(identity&&email&&registered&&email===registered);
  }
  const key=env.MONITOR_ADMIN_KEY;
  if(!KEY.test(key??""))return false;
  const cookie=req.headers.get("cookie")?.split(";").map(c=>c.trim()).find(c=>c.startsWith("__Host-monitor-admin="));
  return check(cookie?.slice("__Host-monitor-admin=".length),key);
}
export async function handleMonitor(request,env,now=Date.now()){
  const url=new URL(request.url), path=url.pathname, method=request.method;
  if(!path.startsWith("/api/"))return null;
  const expected={"/api/dashboard":"GET","/api/status":"GET","/api/monitoring":"POST","/api/device-key":"POST","/api/readings":"POST"};
  if(!(path in expected))return err("Not found",404);
  if(method!==expected[path])return err("Method not allowed",405);
  const owner=isOwner(request,env);
  const token=bearer(request);
  if(path==="/api/status"){
    if(!owner&&!(KEY.test(token??"")&&check(token,env.MONITOR_STATUS_KEY)))return err("Unauthorized",401);
  }else if(path==="/api/readings"){
    // Ingestion is authenticated independently of the public read routes.
    if(!KEY.test(token??""))return err("Unauthorized",401);
  }else if(path!=="/api/dashboard"&&!owner)return err("Unauthorized",401);
  if(["/api/monitoring","/api/device-key"].includes(path)&&(request.headers.get("origin")!==url.origin||request.headers.get("sec-fetch-site")==="cross-site"))return err("Forbidden",403);
  const db=env.DB;
  if(!db)return err("Storage unavailable",503);
  try{
    const conf=(await state(db))??defaults;
    if(path==="/api/device-key"){
      const b=await body(request);
      if(!b||Object.keys(b).length!==1||!["replace","revoke"].includes(b.action))return err("Expected replace or revoke",400);
      const deviceKey=b.action==="replace"?[...crypto.getRandomValues(new Uint8Array(32))].map(v=>v.toString(16).padStart(2,"0")).join(""):null;
      await run(db,"INSERT INTO monitor(id,ingest_hash) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET ingest_hash=excluded.ingest_hash",deviceKey?await hash(deviceKey):null);
      return reply({deviceKey});
    }
    if(path==="/api/monitoring"){
      const b=await body(request);
      if(!b||typeof b.active!=="boolean"||Object.keys(b).length!==1)return err("Expected {active: boolean}",400);
      await run(db,"INSERT INTO monitor(id,active,started_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET started_at=CASE WHEN excluded.active=0 THEN NULL WHEN monitor.active=0 THEN excluded.started_at ELSE monitor.started_at END, active=excluded.active",b.active?1:0,b.active?now:null);
      const updated=await state(db);
      return reply({monitoring:!!updated.active,startedAt:updated.started_at});
    }
    if(path==="/api/readings"){
      const keyHash=await hash(token);
      const existing=conf.ingest_hash;
      const relayHash=env.MONITOR_RELAY_INGEST_HASH;
      const relayAuthorized=KEY.test(relayHash??"")&&check(keyHash,relayHash);
      if(!relayAuthorized&&!check(keyHash,existing))return err("Unauthorized",401);
      const b=await body(request);
      if(!b||Object.keys(b).length!==2||typeof b.id!=="string"||!READING_ID.test(b.id)||!between(b.tempF,-67,257))return err("Expected id and tempF in sensor range",400);
      if(await row(db,"SELECT id FROM readings WHERE id=?",b.id))return reply({stored:false,duplicate:true});
      if(!conf.active)return err("Monitoring is off",409);
      const f=Math.round(b.tempF*1000)/1000;
      const result=await run(db,"INSERT OR IGNORE INTO readings(id,at,f) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM monitor WHERE id=1 AND active=1 AND (?=1 OR ingest_hash=?)) AND NOT EXISTS(SELECT 1 FROM readings WHERE at>?)",b.id,now,f,relayAuthorized?1:0,keyHash,now-10_000);
      if(result.meta?.changes===1)return reply({stored:true,at:now},201);
      if(await row(db,"SELECT id FROM readings WHERE id=?",b.id))return reply({stored:false,duplicate:true});
      const fresh=await state(db);
      if(!relayAuthorized&&!check(keyHash,fresh?.ingest_hash))return err("Unauthorized",401);
      if(!fresh?.active)return err("Monitoring is off",409);
      return reply({error:"Rate limit"},429,{"retry-after":"10"});
    }
    const newest=await latest(db);
    const lower=now-DAY;
    const common={now,monitoring:!!conf.active,startedAt:conf.started_at,latest:readable(newest)};
    if(path==="/api/status"){
      const previous=conf.active&&newest?.f>=38&&now-newest.at<STALE?
        await list(db,"SELECT at,f FROM readings WHERE at>=? ORDER BY at ASC,id ASC",Math.max(conf.started_at,lower)): [];
      return reply({...common,alert:alertFor(now,conf,newest,previous)});
    }
    const before=url.searchParams.get("before");
    const cursor=before?Date.parse(before):now+1;
    if(!Number.isFinite(cursor))return err("Invalid page cursor",400);
    const [series,page]=await Promise.all([
      list(db,"SELECT at,f FROM readings WHERE at>=? ORDER BY at ASC,id ASC",lower),
      list(db,"SELECT at,f FROM readings WHERE at>=? AND at<? ORDER BY at DESC,id DESC LIMIT 51",lower,cursor),
    ]);
    let outside=null;
    if(page.length>0&&page.length<=50)outside=await row(db,"SELECT at,f FROM readings WHERE at<? ORDER BY at DESC,id DESC LIMIT 1",page.at(-1).at);
    const rows=page.slice(0,50).map((p,i)=>({...p,delta:delta(p,page[i+1]??outside)}));
    return reply({...common,alert:alertFor(now,conf,newest,series),series,rows,canManage:owner,nextBefore:page.length>50?new Date(rows.at(-1).at).toISOString():null});
  }catch{
    return err("Storage unavailable",503);
  }
}
export async function shaKey(t){return hash(t);}
