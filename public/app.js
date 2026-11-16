const el = id => document.getElementById(id);
const labels = {news:'新闻',signal:'观测信号',forecast:'预测'};
const phases = {published:'发布',detected:'检测',updated:'更新'};
const states = {ok:'已获取',empty:'无记录',stale:'缓存数据',unavailable:'暂不可用'};
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
  return (data?.sources ?? []).flatMap(s=>s.records).filter(r =>
    (!el('kind').value || r.kind === el('kind').value) &&
    [r.title,r.region,r.category,r.summary].some(v=>(v ?? '').toLowerCase().includes(query)))
    .sort((a,b)=>(b.time.value ?? '').localeCompare(a.time.value ?? ''));
}
function render() {
  const items = el('items');
  items.replaceChildren();
  const list = visible();
  el('export').disabled = !list.length;
  if (!data) return;
  el('status').textContent = [data.mode === 'sample' ? '虚构样例' : 'WorldMonitor 实时接口',
    ...data.sources.map(s=>`${labels[s.kind]}：${states[s.state]}${s.error ? '（'+s.error+'）' : ''}`), `显示 ${list.length} 条`].join(' · ');
  if (!list.length) add(items,'p','当前筛选下没有可展示的记录。','meta');
  for (const r of list) {
    const card = add(items,'article','');
    add(card,'span',labels[r.kind],'badge');
    add(card,'h2',r.title);
    add(card,'div',[r.region,r.category,r.time.value && `${phases[r.time.kind]}：${new Date(r.time.value).toLocaleString('zh-CN')}`].filter(Boolean).join(' · '),'meta');
    if(r.summary) add(card,'p',r.summary);
    if(r.forecast) {
      const f=r.forecast;
      add(card,'p',[`概率 ${pct(f.probability)}`,f.priorProbability != null && `上次 ${pct(f.priorProbability)}`,directions[f.direction],f.horizon].filter(Boolean).join(' · '),'forecast');
      if(f.change) add(card,'p',f.change);
      if(r.evidence.triggers.length) add(card,'p','关注：'+r.evidence.triggers.join('、'),'meta');
    }
    if(r.source.publisher) add(card,'div',r.source.publisher,'meta');
    if(/^https?:\/\//i.test(r.source.url || '')) {
      const a=add(card,'a','查看来源'); a.href=r.source.url; a.target='_blank'; a.rel='noopener noreferrer';
    }
    const details=add(card,'details','');
    add(details,'summary','查看结构化记录');
    add(details,'pre',JSON.stringify(r,null,2));
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
  const url=URL.createObjectURL(new Blob([JSON.stringify({schemaVersion:data.schemaVersion,mode:data.mode,fetchedAt:data.fetchedAt,records:visible()},null,2)],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download='external-intelligence.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
refresh();
