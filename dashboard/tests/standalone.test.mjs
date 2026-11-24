import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('built Worker guards standalone owner controls and keeps keys separate', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  execFileSync(process.execPath, ['scripts/build.mjs'], {cwd: root});
  const { default: worker } = await import('../dist/server/index.js');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(readFileSync(new URL('../drizzle/0000_monitor.sql', import.meta.url), 'utf8'));
    const key = 'd'.repeat(64), statusKey = 'a'.repeat(64);
    const origin = 'https://worker.example.test';
    const env = { MONITOR_ADMIN_KEY:key, MONITOR_STATUS_KEY:statusKey,
      MONITOR_OWNER_EMAIL:'owner@example.test',
      DB:{prepare(sql){return {bind(...args){const q=db.prepare(sql);return {
        first:async()=>q.get(...args)??null,all:async()=>({results:q.all(...args)}),
        run:async()=>({meta:{changes:q.run(...args).changes}})};}};}}};
    const fetch = (path, headers = {}, json) => worker.fetch(new Request(origin+path, {
      method:json===undefined?'GET':'POST',headers:json===undefined?headers:
        {'content-type':'application/json',origin,...headers},
      body:json===undefined?undefined:JSON.stringify(json)
    }), env);
    assert.equal((await fetch('/manage')).status,401);
    assert.equal((await fetch('/manage',{authorization:'Basic '+btoa('owner:wrong')})).status,401);
    const spoof={'oai-authenticated-user-id':'someone','oai-authenticated-user-email':'owner@example.test'};
    assert.equal((await fetch('/api/monitoring',spoof,{active:true})).status,401);
    assert.equal((await (await fetch('/api/dashboard',spoof)).json()).canManage,false);
    const login=await fetch('/manage',{authorization:'Basic '+btoa('owner:'+key)});
    assert.equal(login.status,303);assert.equal(login.headers.get('location'),'/');
    assert.match(login.headers.get('set-cookie'), /; Path=\/; Secure; HttpOnly; SameSite=Strict$/);
    const cookie=login.headers.get('set-cookie').split(';')[0];
    assert.equal((await (await fetch('/api/dashboard',{cookie})).json()).canManage,true);
    const start={active:true};
    assert.equal((await fetch('/api/monitoring',{cookie,origin:'https://different.example.test'},start)).status,403);
    assert.equal((await fetch('/api/monitoring',{cookie},start)).status,200);
    const status={authorization:'Bearer '+statusKey};
    const rotation=await fetch('/api/device-key',{cookie},{action:'replace'});
    const device={authorization:'Bearer '+(await rotation.json()).deviceKey};
    assert.equal((await fetch('/api/status',device)).status,401);
    assert.equal((await fetch('/api/status',status)).status,200);
    assert.equal((await fetch('/api/readings',status,{id:'status-key:one',tempF:37})).status,401);
    assert.equal((await fetch('/api/readings',device,{id:'device-key:one',tempF:37})).status,201);
    assert.equal((await (await fetch('/api/dashboard')).json()).latest.f,37);
  } finally { db.close(); }
});
