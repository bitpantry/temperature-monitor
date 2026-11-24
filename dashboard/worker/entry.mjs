const security={
  "cache-control":"private, no-store",
  "content-security-policy":"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'",
  "x-content-type-options":"nosniff",
  "referrer-policy":"no-referrer"
};
export default {async fetch(req,env){
  const url = new URL(req.url);
  if(url.pathname==="/manage" && env.MONITOR_AUTH_MODE!=="chatgpt-sites"){
    if(req.method!=="GET")return new Response("Method not allowed",{status:405,headers:security});
    const key=env.MONITOR_ADMIN_KEY;
    if(!KEY.test(key??""))return new Response("Owner access is not configured",{status:503,headers:security});
    const authorization=req.headers.get("authorization");
    if(!check(authorization,"Basic "+btoa("owner:"+key)))return new Response("Owner sign-in required",{status:401,headers:{...security,"www-authenticate":'Basic realm="Temperature Monitor", charset="UTF-8"'}});
    return new Response(null,{status:303,headers:{...security,location:"/","set-cookie":"__Host-monitor-admin="+key+"; Path=/; Secure; HttpOnly; SameSite=Strict"}});
  }
  const specialized=await handleMonitor(req,env);
  if(specialized)return specialized;
  const path=url.pathname;
  const asset=Object.hasOwn(assets,path)?assets[path]:null;
  if(!asset)return new Response("Not found",{status:404,headers:security});
  if(!["GET","HEAD"].includes(req.method))return new Response("Method not allowed",{status:405,headers:security});
  return new Response(req.method==="HEAD"?null:(path==="/"&&env.MONITOR_AUTH_MODE==="chatgpt-sites"?asset.body.replace('href="/manage"','href="/signin-with-chatgpt?return_to=%2F"'):asset.body),{headers:{...security,"content-type":asset.type}});
}};
