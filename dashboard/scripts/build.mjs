import fs from "node:fs";
const source=fs.readFileSync("worker/monitor.mjs","utf8");
const assets=Object.fromEntries([["/","index.html","text/html; charset=utf-8"],["/style.css","style.css","text/css; charset=utf-8"],["/app.js","app.js","text/javascript; charset=utf-8"]].map(([path,file,type])=>[path,{type,body:fs.readFileSync("ui/"+file,"utf8")}]));
const launch=fs.readFileSync("worker/entry.mjs","utf8");
fs.mkdirSync("dist/server",{recursive:true});
fs.mkdirSync("dist/.openai",{recursive:true});
fs.writeFileSync("dist/server/index.js",source+"\nconst assets="+JSON.stringify(assets)+";\n"+launch);
if(fs.existsSync(".openai/hosting.json")) fs.copyFileSync(".openai/hosting.json","dist/.openai/hosting.json");
