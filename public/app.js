const el = id => document.getElementById(id);
const theme = el('theme');
function applyTheme(value) {
  if (value === 'light' || value === 'dark') document.documentElement.dataset.theme = value;
  else delete document.documentElement.dataset.theme;
}
try {
  const saved = localStorage.getItem('external-event-theme');
  if (saved === 'light' || saved === 'dark') theme.value = saved;
} catch {}
applyTheme(theme.value);
theme.onchange = () => {
  applyTheme(theme.value);
  try { localStorage.setItem('external-event-theme', theme.value); } catch {}
};
const labels = {news:'新闻',signal:'观测信号',forecast:'预测'};
const phases = {published:'发布',detected:'检测',updated:'更新'};
const states = {ok:'已获取',empty:'无记录',stale:'缓存数据',unavailable:'暂不可用',partial:'部分可用',not_configured:'待接自建 WorldMonitor'};
const directions = {rising:'上升',falling:'下降',stable:'平稳'};
let data, request = 0;
function add(parent, tag, value, cls) {
  const child = document.createElement(tag);
  child.textContent = value;
  if (cls) child.className = cls;
  parent.append(child);
  return child;
}
const pct = n => Number.isFinite(n) ? new Intl.NumberFormat('zh-CN',{style:'percent',maximumFractionDigits:1}).format(n) : '—';
function visible() {
  const query = el('search').value.trim().toLowerCase();
  return (data?.events ?? []).filter(event =>
    (!el('kind').value || event.records.some(r => r.kind === el('kind').value)) &&
    [event.title,event.summary,event.region,...event.networkMatches.flatMap(m=>[m.nodeName,...m.routes.flatMap(r=>[r.origin,r.destination])]),...event.records.flatMap(r=>[r.title,r.category,r.summary])]
      .some(v=>(v ?? '').toLowerCase().includes(query)));
}
function render() {
  const items = el('items');
  items.replaceChildren();
  const list = visible();
  el('export').disabled = !list.length;
  if (!data) return;
  el('status').textContent = [data.mode === 'sample' ? '虚构样例' : data.liveSource === 'self-hosted' ? '自建 WorldMonitor' : '公开新闻 RSS',
    ...data.sources.map(s=>`${labels[s.kind]}：${states[s.state]}${s.error ? '（'+s.error+'）' : ''}`), `显示 ${list.length} 个事件`].join(' · ');
  const network = data.network;
  el('network-status').textContent = `${network.label} · ${network.originCount} 个起点 · ${network.destinationCount} 个终点 · ${network.laneCount} 条线路`;
  if (!list.length) add(items,'p','当前筛选下没有可展示的记录。','meta');
  for (const event of list) {
    const card = add(items,'article','','event-card');
    const heading = add(card,'header','','event-header');
    add(heading,'div',[event.region,`${event.records.length} 条记录`].filter(Boolean).join(' · '),'meta');
    add(heading,'h2',event.title);
    if(event.summary) add(heading,'p',event.summary);
    const mapping = add(card,'section','','network-matches');
    add(mapping,'h3','关联运输线路');
    if (!event.networkMatches.length) add(mapping,'p','默认网络中未匹配到这条记录提及的地点。','meta');
    for (const match of event.networkMatches) {
      const group = add(mapping,'details','');
      group.open = event.networkMatches.length === 1;
      const basis = match.basis === 'event_anchor' ? '事件节点' : '报道提及地点';
      add(group,'summary',`${match.nodeName} · ${basis} · ${match.routes.length} 条线路与运输方式`);
      const routes = add(group,'ul','','matched-routes');
      for (const route of match.routes) {
        const row = add(routes,'li','');
        add(row,'strong',`${route.origin} → ${route.destination}`);
        add(row,'span',`${route.modeLabel} · ${route.exposureLabel}（${route.matchedPathIds.length}/${route.candidatePathCount} 条候选路径）`,'meta');
      }
    }
    const timeline = add(card,'div','','event-timeline');
    for (const r of event.records) {
    const entry = add(timeline,'section','','event-entry');
    add(entry,'span',labels[r.kind],'badge');
    if(event.records.length > 1) add(entry,'h3',r.title);
    add(entry,'div',[r.region,r.category,r.time.value && `${phases[r.time.kind]}：${new Date(r.time.value).toLocaleString('zh-CN')}`].filter(Boolean).join(' · '),'meta');
    if(r.summary) add(entry,'p',r.summary);
    if(r.forecast) {
      const f=r.forecast;
      add(entry,'p',[`概率 ${pct(f.probability)}`,f.priorProbability != null && `上次 ${pct(f.priorProbability)}`,directions[f.direction],f.horizon].filter(Boolean).join(' · '),'forecast');
      if(f.change) add(entry,'p',f.change);
      if(r.evidence.triggers.length) add(entry,'p','关注：'+r.evidence.triggers.join('、'),'meta');
    }
    if(r.source.publisher) add(entry,'div',r.source.publisher,'meta');
    if(/^https?:\/\//i.test(r.source.url || '')) {
      const a=add(entry,'a','查看来源'); a.href=r.source.url; a.target='_blank'; a.rel='noopener noreferrer';
    }
    }
    const details=add(card,'details','');
    add(details,'summary','查看整张事件卡的 JSON');
    add(details,'pre',JSON.stringify(event,null,2));
  }
}
async function refresh() {
  const token = ++request;
  data = null; render(); el('status').textContent='正在获取数据…';
  try {
    const response = await fetch('/api/feed?mode='+el('mode').value);
    if (!response.ok) throw Error('本地接口暂不可用');
    const result = await response.json();
    if (token === request) {data=result;render();}
  } catch(e) {if (token === request) el('status').textContent=e.message;}
}
el('mode').onchange=refresh;el('refresh').onclick=refresh;el('kind').onchange=render;el('search').oninput=render;
el('export').onclick=()=>{
  const url=URL.createObjectURL(new Blob([JSON.stringify({schemaVersion:data.schemaVersion,mode:data.mode,fetchedAt:data.fetchedAt,network:data.network,events:visible()},null,2)],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download='external-intelligence.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
refresh();
