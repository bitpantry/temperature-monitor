'use strict';
const byId = (id) => document.getElementById(id);
const ns = 'http://www.w3.org/2000/svg', hour = 3600000;
const svg = byId('chart');
const zone = {timeZone:'America/Chicago'};
const date = new Intl.DateTimeFormat('en-US', {...zone,month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});
const time = new Intl.DateTimeFormat('en-US', {...zone,hour:'numeric',minute:'2-digit'});
const degree = (temp) => temp.toFixed(1) + ' °F';
const paths = [null];
const rangeButtons = [...document.querySelectorAll('[data-trend-hours]')];
let trendHours = 24;
let dashboard, busy = false, revision = 0, selectedAt = null, dimension = null, cursor = null;
function showError(message) {
  byId('error').textContent = message || '';
  byId('error').hidden = !message;
}
function element(tag, attrs, value) {
  const node = document.createElementNS(ns,tag);
  for (const [key,val] of Object.entries(attrs)) node.setAttribute(key,val);
  if (value != null) node.textContent = value;
  svg.append(node);
  return node;
}
function selectPoint(at) {
  if (!dimension || !dimension.points.length) return;
  const {points,x,y,top,bottom} = dimension;
  let lo = 0, hi = points.length - 1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (points[m].at < at) lo = m + 1; else hi = m;
  }
  if (lo && Math.abs(points[lo-1].at-at) <= Math.abs(points[lo].at-at)) lo--;
  const p = points[lo], px = x(p.at), py = y(p.f);
  selectedAt = p.at;
  cursor?.forEach((node) => node.remove());
  cursor = [element('line',{x1:px,x2:px,y1:top,y2:bottom,class:'cursor'}),element('circle',{cx:px,cy:py,r:5})];
  byId('chart-reading').textContent = degree(p.f) + ' · ' + date.format(p.at);
}
function drawChart() {
  if (!dashboard) return;
  svg.replaceChildren();
  cursor = null;
  const {now,series} = dashboard;
  const duration = trendHours * hour, start = now - duration;
  const points = series.filter(p=>Number.isFinite(p.f) && p.at>=start && p.at<=now).slice().sort((a,b)=>a.at-b.at);
  byId('chart-empty').hidden = Boolean(points.length);
  svg.hidden = !points.length;
  document.querySelector('.hint').hidden = !points.length;
  byId('chart-reading').textContent = points.length ? 'Select a reading' : 'No readings';
  dimension = null;
  if (!points.length) return;
  const width = svg.clientWidth, height = svg.clientHeight;
  if (!width || !height) return;
  svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
  const left=37, right=width-8, top=11, bottom=height-28;
  let min=36, max=42;
  for (const {f} of points) { min=Math.min(min,f); max=Math.max(max,f); }
  const step = Math.max(2,Math.ceil((max-min)/5/2)*2);
  min=Math.floor(min/step)*step;max=Math.ceil(max/step)*step;
  const x = (t)=>left+(t-start)/duration*(right-left);
  const y = (f)=>bottom-(f-min)/(max-min)*(bottom-top);
  dimension = {points,x,y,top,bottom,left,right,start,duration};
  for (let tick=min; tick<=max; tick+=step) {
    const py=y(tick);
    element('line',{x1:left,x2:right,y1:py,y2:py,class:tick===40?'limit':'grid'});
    element('text',{x:left-5,y:py+4,'text-anchor':'end'},tick+'°');
  }
  if (40%step!==0) element('line',{x1:left,x2:right,y1:y(40),y2:y(40),class:'limit'});
  const count=width>560?6:3;
  for (let i=0;i<=count;i++) {
    const t=start + duration*i/count, px=x(t);
    element('text',{x:i===0?left:i===count?right:px,y:height-7,'text-anchor':i===0?'start':i===count?'end':'middle'},time.format(t));
  }
  const segments=[];
  for (const p of points) {
    const segment=segments.at(-1);
    if (!segment || p.at-segment.at(-1).at>300000) segments.push([p]); else segment.push(p);
  }
  for (const segment of segments) {
    if (segment.length===1) element('circle',{cx:x(segment[0].at),cy:y(segment[0].f),r:3.5});
    else element('path',{class:'series',d:segment.map((p,i)=>(i?'L':'M')+x(p.at)+' '+y(p.f)).join(' ')});
  }
  if (selectedAt!==null && selectedAt>=start) selectPoint(selectedAt);
}
function render(data) {
  dashboard=data;
  byId('status').textContent=data.monitoring ? 'Monitoring on' : 'Monitoring off';
  byId('status').classList.toggle('on',data.monitoring);
  byId('toggle').textContent=data.monitoring?'End monitoring':'Start monitoring';
  byId('toggle').hidden=!data.canManage;
  byId('owner-signin').hidden=Boolean(data.canManage);
  byId('toggle').disabled=Boolean(!data.canManage || busy);
  byId('session').textContent=data.monitoring && data.startedAt!=null?'Started '+date.format(data.startedAt):'';
  byId('latest').textContent=data.latest?degree(data.latest.f):'—';
  byId('latest-time').textContent=data.latest?date.format(data.latest.at):'Waiting for data';
  const alerts={
    stale:['warning','No recent readings','Check sensor power and Wi-Fi.'],
    warm:['warning','Brine temperature warning','Check the brine and get ice ready.'],
    critical:['critical','Brine temperature critical','Check the brine now. Add ice if needed.'],
    waiting:['','Waiting for a reading','Check that the sensor is on and connected.']
  };
  const a=data.alert && alerts[data.alert.code];
  byId('alert').hidden=!a;
  if(a){
    byId('alert').className='banner '+a[0];
    byId('alert-title').textContent=a[1];
    const fresh=(data.alert.code==='warm'||data.alert.code==='critical') && Number.isFinite(data.alert.minutes) && data.alert.minutes>=1;
    byId('alert-copy').textContent=a[2]+(fresh?' Duration: '+Math.floor(data.alert.minutes)+' min.':'');
  }
  const rows=data.rows.slice(0,50).sort((a,b)=>b.at-a.at);
  byId('rows').replaceChildren(...rows.map((r)=>{
    const tr=document.createElement('tr');
    const delta=Number.isFinite(r.delta)?Math.round(r.delta*10)/10:null;
    [date.format(r.at),degree(r.f),delta===null?'—':(delta>0?'+':delta<0?'−':'')+Math.abs(delta).toFixed(1)+' °F'].forEach((s,i)=>{
      const td=tr.insertCell();
      td.textContent=s;
      if(i===2 && delta!==null) td.className=delta>0?'delta-up':delta<0?'delta-down':'';
    });
    return tr;
  }));
  byId('history-empty').hidden=Boolean(rows.length);
  byId('page-label').textContent='Page '+paths.length;
  byId('newer').disabled=paths.length<=1;
  byId('older').disabled=!data.nextBefore;
  drawChart();
}
async function request(params) {
  const res=await fetch('/api/dashboard?'+params,{cache:'no-store',headers:{Accept:'application/json'}});
  if(!res.ok) throw Error('dashboard');
  return res.json();
}
async function load() {
  const epoch=++revision;
  const params=new URLSearchParams();
  if(paths.at(-1)) params.set('before',paths.at(-1));
  try{
    const data=await request(params);
    if(epoch!==revision) return;
    showError('');
    render(data);
  }catch{
    if(epoch===revision) showError('Couldn’t refresh the dashboard. Any displayed reading may be out of date. Check the connection and try again.');
  }
}
byId('toggle').addEventListener('click',async()=>{
  if(!dashboard?.canManage || busy) return;
  busy=true;byId('toggle').disabled=true;
  try{
    const res=await fetch('/api/monitoring',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({active:!dashboard.monitoring})});
    if(!res.ok) throw Error('monitoring');
    await load();
  }catch{
    showError('Couldn’t verify the monitoring change. Check the displayed status before retrying.');
  }finally{busy=false;byId('toggle').disabled=!dashboard?.canManage;}
});
byId('newer').addEventListener('click',()=>{if(paths.length>1){paths.pop();load();}});
byId('older').addEventListener('click',()=>{if(dashboard?.nextBefore && paths.at(-1)!==dashboard.nextBefore){paths.push(dashboard.nextBefore);load();}});
for (const button of rangeButtons) button.addEventListener('click',()=>{
  const hours = Number(button.dataset.trendHours);
  if (hours === trendHours) return;
  trendHours = hours;
  selectedAt = null;
  for (const option of rangeButtons) option.setAttribute('aria-pressed',String(option===button));
  const range = hours === 1 ? 'hour' : hours+' hours';
  byId('chart-empty').textContent = 'No readings in the past '+range+'.';
  svg.setAttribute('aria-label','Temperature over the past '+range+'. Focus the chart, then use the arrow keys to select readings.');
  drawChart();
});
function pointer(event){
  if(!dimension) return;
  const rect=svg.getBoundingClientRect(),{left,right,start,duration}=dimension;
  const fraction=Math.max(0,Math.min(1,(event.clientX-rect.left-left)/(right-left)));
  selectPoint(start+fraction*duration);
}
svg.addEventListener('pointerdown',event=>{svg.setPointerCapture?.(event.pointerId);pointer(event);});
svg.addEventListener('pointermove',pointer);
svg.addEventListener('keydown',event=>{
  if(!dimension || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
  event.preventDefault();
  const {points}=dimension;
  const i=points.findIndex(p=>p.at===selectedAt);
  const next=event.key==='Home'?0:event.key==='End'?points.length-1:Math.max(0,Math.min(points.length-1,i+(event.key==='ArrowLeft'?-1:1)));
  selectPoint(points[next].at);
});
if(typeof ResizeObserver==='function') new ResizeObserver(drawChart).observe(svg);
else addEventListener('resize',drawChart);
load();
setInterval(()=>{if(!busy && !document.hidden) load();},30000);
