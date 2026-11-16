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
const topics = {maritime_security:'航道安全',transport_disruption:'运输运行',trade_policy:'经贸政策',security_development:'地缘安全',natural_hazard:'灾害',market_change:'市场变化',infrastructure_incident:'设施事故'};
const phases = {published:'发布',detected:'检测',updated:'更新'};
const states = {ok:'已获取',empty:'无记录',stale:'缓存数据',unavailable:'暂不可用',partial:'部分可用',not_configured:'待接自建 WorldMonitor'};
const directions = {rising:'上升',falling:'下降',stable:'平稳'};
let data;
const cache = new Map();
const pending = new Map();
const errors = new Map();
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
  const mode = el('mode').value;
  const loading = pending.has(mode);
  const error = errors.get(mode);
  if (!data) {
    el('status').textContent = loading ? '正在获取数据…' : error ?? '';
    return;
  }
  el('status').textContent = [data.mode === 'sample' ? '虚构样例' : `筛选 ${data.sources.find(s=>s.kind==='news')?.records.length ?? 0} 篇报道`, data.mode === 'sample' ? null : data.liveSource === 'self-hosted' ? '自建 WorldMonitor' : '公开新闻 RSS',
    ...data.sources.filter(s=>s.feedStatus).map(s=>`RSS 源 ${s.feedStatus.filter(f=>!f.error).length}/${s.feedStatus.length} 可用`),
    ...data.sources.map(s=>`${labels[s.kind]}：${states[s.state]}${s.error ? '（'+s.error+'）' : ''}`), `显示 ${list.length} 个事件`,
    data.mode === 'live' && `上次更新：${new Date(data.fetchedAt).toLocaleString('zh-CN')}`,
    loading && '正在后台更新…',
    error && `更新失败，显示上次结果（${error}）`].filter(Boolean).join(' · ');
  if (!list.length) add(items,'p','当前筛选下没有可展示的记录。','meta');
  for (const event of list) {
    const card = add(items,'article','','event-card');
    const heading = add(card,'header','','event-header');
    const publishers = new Set(event.records.filter(r=>r.kind === 'news' && r.role !== 'background').map(r=>r.source.publisher).filter(Boolean));
    add(heading,'div',[topics[event.topic],event.region,publishers.size > 1 && `${publishers.size} 家媒体`,`${event.records.length} 条记录`].filter(Boolean).join(' · '),'meta');
    add(heading,'h2',event.title);
    const identity = add(heading,'div','事件 ID：','meta event-id');
    add(identity,'code',event.id);
    if(event.summary) add(heading,'p',event.summary);
    if(event.networkMatches.length) {
    const mapping = add(card,'section','','network-matches');
    add(mapping,'h3','关联运输线路');
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
    }
    const timeline = add(card,'div','','event-timeline');
    const normalizeHeadline = value => (value ?? '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(' ') ?? '';
    const entries = new Map();
    for (const r of [...event.records.filter(r=>r.role !== 'background'),...event.records.filter(r=>r.role === 'background')]) {
      const key = r.kind === 'news' ? `news:${r.role ?? ''}:${normalizeHeadline(r.title)}` : r.id;
      if (!entries.has(key)) entries.set(key,[]);
      entries.get(key).push(r);
    }
    for (const records of entries.values()) {
      const r = records[0];
      const entry = add(timeline,'section','','event-entry');
      add(entry,'span',r.role === 'background' ? '背景分析' : labels[r.kind],'badge');
      if(normalizeHeadline(event.title) !== normalizeHeadline(r.title)) add(entry,'h3',r.title);
      add(entry,'div',[r.region,r.category,r.time.value && `${phases[r.time.kind]}：${new Date(r.time.value).toLocaleString('zh-CN')}`].filter(Boolean).join(' · '),'meta');
      const headline = normalizeHeadline(r.title);
      const publisher = normalizeHeadline(r.source.publisher);
      const summary = records.find(item=>{
        const text = normalizeHeadline(item.summary);
        return text && text !== headline && text !== [headline,normalizeHeadline(item.source.publisher) || publisher].filter(Boolean).join(' ');
      })?.summary;
      if(summary) add(entry,'p',summary);
      if(r.forecast) {
        const f=r.forecast;
        add(entry,'p',[`概率 ${pct(f.probability)}`,f.priorProbability != null && `上次 ${pct(f.priorProbability)}`,directions[f.direction],f.horizon].filter(Boolean).join(' · '),'forecast');
        if(f.change) add(entry,'p',f.change);
        if(r.evidence.triggers.length) add(entry,'p','关注：'+r.evidence.triggers.join('、'),'meta');
      }
      const links = new Set();
      for (const record of records) {
        const {publisher,url} = record.source;
        if (!url || links.has(url) || !/^https?:\/\//i.test(url)) {
          if (!url && publisher) add(entry,'div',publisher,'meta');
          continue;
        }
        links.add(url);
        const line = add(entry,'div','','meta');
        const a=add(line,'a',publisher || '查看来源');
        a.href=url; a.target='_blank'; a.rel='noopener noreferrer';
      }
    }
    const details=add(card,'details','');
    add(details,'summary','查看整张事件卡的 JSON');
    add(details,'pre',JSON.stringify(event,null,2));
  }
}
async function refresh() {
  const mode = el('mode').value;
  errors.delete(mode);
  if (!pending.has(mode)) {
    const task = (async () => {
      try {
        const response = await fetch('/api/feed?mode='+mode);
        if (!response.ok) throw Error('本地接口暂不可用');
        const result = await response.json();
        if (result.mode !== mode || !Array.isArray(result.events)) throw Error('数据格式异常');
        const available = result.sources.some(source=>['ok','partial','stale','empty'].includes(source.state));
        if (!available && cache.has(mode)) throw Error('数据来源暂不可用');
        cache.set(mode,result);
      } catch (error) {
        errors.set(mode,error.message);
      } finally {
        pending.delete(mode);
        if (el('mode').value === mode) {
          data = cache.get(mode);
          render();
        }
      }
    })();
    pending.set(mode,task);
  }
  data = cache.get(mode);
  render();
}
el('mode').onchange=refresh;el('refresh').onclick=refresh;el('kind').onchange=render;el('search').oninput=render;
el('export').onclick=()=>{
  const url=URL.createObjectURL(new Blob([JSON.stringify({schemaVersion:data.schemaVersion,mode:data.mode,fetchedAt:data.fetchedAt,network:data.network,events:visible()},null,2)],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download='external-intelligence.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
refresh();
