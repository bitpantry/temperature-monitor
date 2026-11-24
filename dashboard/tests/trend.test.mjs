import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';

test('trend buttons filter points and preserve the selected range across refresh',async()=>{
  const make=(hours)=>({
    dataset:{trendHours:hours}, events:{}, attrs:{}, clientWidth:640,clientHeight:240,
    setAttribute(k,v){this.attrs[k]=v;},addEventListener(k,fn){this.events[k]=fn;},
    replaceChildren(){this.children=[];},append(el){this.children.push(el);},
    remove(){},classList:{toggle(){}},getBoundingClientRect(){return {left:0};}
  });
  const buttons=[1,6,12,24].map(make);
  const nodes=new Map();
  const getElementById=(id)=>{if(!nodes.has(id)) nodes.set(id,make());return nodes.get(id);};
  const now=Date.UTC(2026,10,22,5,0), h=3600000;
  const data={now,series:[[22,34],[10,35],[3,36],[.5,37],[.25,38]].map(([back,f])=>({at:now-back*h,f})),rows:[]};
  const ctx={document:{getElementById,querySelectorAll:()=>buttons,querySelector:()=>make(),createElementNS:(ns,tag)=>({...make(),tag})},URLSearchParams,fetch:async()=>({ok:true,json:async()=>data}),addEventListener(){},setInterval(){}};
  runInNewContext(readFileSync(new URL('../ui/app.js',import.meta.url),'utf8'),ctx);
  await new Promise(setImmediate);
  const chart=getElementById('chart');
  const plotCount=()=>chart.children.filter(el=>el.tag==='circle').length;
  assert.equal(plotCount(),5);
  for(const [i,expected] of [2,3,4,5].entries()){
    buttons[i].events.click();
    assert.equal(plotCount(),expected);
    assert.deepEqual(buttons.map(b=>b.attrs['aria-pressed']),buttons.map((_,j)=>String(i===j)));
  }
  buttons[0].events.click();
  chart.events.pointermove({clientX:620});
  assert.match(getElementById('chart-reading').textContent,/^38.0 °F/);
  await ctx.load();
  assert.equal(buttons[0].attrs['aria-pressed'],'true');
  assert.equal(plotCount(),3); // two samples plus the selected sample marker
  data.series=[];
  await ctx.load();
  assert.equal(chart.hidden,true);
  assert.equal(getElementById('chart-empty').textContent,'No readings in the past hour.');
});
