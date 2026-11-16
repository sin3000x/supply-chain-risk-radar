import {locateEvent as resolveLocation, regions} from './geography.mjs';

// Location and search text depend only on the event object, which is replaced on each refresh.
const locations = new WeakMap();
const locateEvent = event => {
  if (!locations.has(event)) locations.set(event,resolveLocation(event));
  return locations.get(event);
};
const searchTexts = new WeakMap();
function searchText(event) {
  if (!searchTexts.has(event)) {
    const geo = locateEvent(event);
    searchTexts.set(event,[
      event.title, event.summary, event.region, geo.label, regions[geo.region].label,
      ...event.networkMatches.flatMap(match => [match.nodeName,...match.routes.flatMap(route => [route.origin,route.destination])]),
      ...event.records.flatMap(record => [record.title,record.category,record.summary]),
    ].filter(Boolean).join('\n').toLowerCase());
  }
  return searchTexts.get(event);
}

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
  drawMap();
  try { localStorage.setItem('external-event-theme', theme.value); } catch {}
};
const labels = {news:'新闻',signal:'观测信号',forecast:'预测'};
const topics = {maritime_security:'航道安全',transport_disruption:'运输运行',trade_policy:'经贸政策',security_development:'地缘安全',natural_hazard:'灾害',market_change:'市场变化',infrastructure_incident:'设施事故'};
const phases = {published:'发布',detected:'检测',updated:'更新'};
const states = {ok:'已获取',empty:'无记录',stale:'缓存数据',unavailable:'暂不可用',partial:'部分可用',not_configured:'待接自建 WorldMonitor'};
const directions = {rising:'上升',falling:'下降',stable:'平稳'};
const updateTime = new Intl.DateTimeFormat('zh-CN', {
  month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:false,
});
const openEvents = new Set();
const openPlaces = new Map();
const regionControl = el('region');
const mapView = el('map-view');
let land;
let landRequest;
let mapUnavailable = false;

function project(lon, lat) {
  return [(lon + 180) / 360, (80 - lat) / 165];
}

function drawMap() {
  if (!land) return;
  const canvas = mapView.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const style = getComputedStyle(canvas);
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle = style.color;
  ctx.strokeStyle = style.borderTopColor;
  ctx.lineWidth = 0.8;
  for (const ring of land) {
    ctx.beginPath();
    ring.forEach(([lon,lat],index) => {
      const [x,y] = project(lon,lat);
      ctx[index === 0 ? 'moveTo' : 'lineTo'](x * canvas.width,y * canvas.height);
    });
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
}

matchMedia('(prefers-color-scheme: light)').addEventListener('change', drawMap);

function loadMap() {
  landRequest ??= fetch('/vendor/worldmonitor/countries.geojson')
    .then(response => {
      if (!response.ok) throw Error('Map unavailable');
      return response.json();
    })
    .then(data => {
      land = data.features
        .filter(feature => feature.properties['ISO3166-1-Alpha-2'] !== 'AQ')
        .flatMap(({geometry}) => {
          if (geometry?.type === 'Polygon') return [geometry.coordinates[0]];
          if (geometry?.type === 'MultiPolygon') return geometry.coordinates.map(polygon => polygon[0]);
          return [];
        });
      mapUnavailable = false;
      drawMap();
      renderMapNote();
    })
    .catch(() => {
      landRequest = null;
      mapUnavailable = true;
      renderMapNote();
    });
}

let unmappedEvents = 0;
function renderMapNote() {
  el('map-note').textContent = [
    mapUnavailable ? '底图暂不可用，可用区域筛选查看事件。' : '圆点显示区域事件数，点击筛选。',
    unmappedEvents && `${unmappedEvents} 个事件未落图`,
  ].filter(Boolean).join(' ');
}

function renderRegionControls(rows) {
  const counts = new Map();
  for (const {geo} of rows) counts.set(geo.region,(counts.get(geo.region) ?? 0) + 1);
  const selected = regionControl.value;
  regionControl.replaceChildren(new Option('全部区域',''));
  const markers = el('map-markers');
  const focusedMarker = document.activeElement?.dataset.mapRegion;
  markers.replaceChildren();
  for (const [id,area] of Object.entries(regions)) {
    const count = counts.get(id);
    if (!count && selected !== id) continue;
    regionControl.add(new Option(`${area.label} · ${count ?? 0}`,id));
    if (!count || area.lon == null) continue;
    const marker = add(markers,'button',String(count),'map-marker');
    const [x,y] = project(area.lon,area.lat);
    marker.style.left = `${x * 100}%`;
    marker.style.top = `${y * 100}%`;
    marker.dataset.mapRegion = id;
    marker.title = `${area.label} · ${count} 个事件`;
    marker.setAttribute('aria-label',marker.title);
    marker.setAttribute('aria-pressed',String(selected === id));
    marker.onclick = () => {
      regionControl.value = selected === id ? '' : id;
      render();
    };
    if (focusedMarker === id) marker.focus({preventScroll:true});
  }
  regionControl.value = selected;
  unmappedEvents = counts.get('unknown') ?? 0;
  renderMapNote();
}

let data;
const cache = new Map();
const pending = new Map();
const errors = new Map();
const modeControl = el('mode');
const modeKey = 'external-event-mode';
const snapshotKey = 'external-event-live-v1';
try {
  const savedMode = localStorage.getItem(modeKey);
  if (savedMode === 'live' || savedMode === 'sample') modeControl.value = savedMode;
} catch {}
try {
  const saved = JSON.parse(sessionStorage.getItem(snapshotKey));
  if (saved?.mode === 'live' && Array.isArray(saved.events) && Array.isArray(saved.sources)) {
    cache.set('live',saved);
  }
} catch {}
function rememberLive(result) {
  try {
    // Cards already contain the relevant articles; omit the full input feed.
    const sources = result.sources.map(({records,...source})=>({...source,recordCount:records?.length ?? 0}));
    sessionStorage.setItem(snapshotKey,JSON.stringify({...result,sources}));
  } catch {}
}
function add(parent, tag, value, cls) {
  const child = document.createElement(tag);
  child.textContent = value;
  if (cls) child.className = cls;
  parent.append(child);
  return child;
}
const pct = n => Number.isFinite(n) ? new Intl.NumberFormat('zh-CN',{style:'percent',maximumFractionDigits:1}).format(n) : '—';
function visible(applyRegion = true) {
  const query = el('search').value.trim().toLowerCase();
  const kind = el('kind').value;
  return (data?.events ?? []).filter(event =>
    (!applyRegion || !regionControl.value || locateEvent(event).region === regionControl.value) &&
    (!kind || event.records.some(record => record.kind === kind)) &&
    (!query || searchText(event).includes(query)));
}
function render() {
  const items = el('items');
  items.replaceChildren();
  const rows = visible(false).map(event => ({
    event,
    geo: locateEvent(event),
    lanes: new Set(event.networkMatches.flatMap(match => match.routes.map(route => route.laneId))),
  }));
  renderRegionControls(rows);
  mapView.hidden = !data;
  el('event-list').hidden = !data;
  if (data) loadMap();
  const selectedRegion = regionControl.value;
  const list = rows.filter(row => !selectedRegion || row.geo.region === selectedRegion);
  if (el('sort').value === 'routes') {
    list.sort((a,b) => b.lanes.size - a.lanes.size);
  }
  const linkedCount = list.filter(item => item.lanes.size > 0).length;
  el('export').disabled = !list.length;
  const mode = modeControl.value;
  const loading = pending.has(mode);
  const error = errors.get(mode);
  el('sources').hidden = data?.mode !== 'live';
  if (!data) {
    el('status').textContent = loading ? '正在获取数据…' : error ?? '';
    return;
  }
  const sourceStatus = el('source-status');
  sourceStatus.replaceChildren();
  if (data.mode === 'live') {
    add(sourceStatus,'li',data.liveSource === 'self-hosted' ? '自建 WorldMonitor' : '公开新闻 RSS');
    for (const source of data.sources) {
      const feeds = source.feedStatus;
      const availability = feeds ? ` · ${feeds.filter(feed=>!feed.error).length}/${feeds.length} 个源可用` : '';
      add(sourceStatus,'li',`${labels[source.kind]}：${states[source.state]}${availability}${source.error ? '（'+source.error+'）' : ''}`);
    }
  }
  el('status').textContent = [
    `${list.length} 个事件`,
    linkedCount > 0 && `${linkedCount} 个有关联线路`,
    data.mode === 'live' && `更新于 ${new Date(data.fetchedAt).toLocaleString('zh-CN')}`,
    data.mode === 'live' && data.sources.some(source=>['partial','stale','unavailable'].includes(source.state)) && '部分来源异常',
    loading && '更新中…',
    error && `更新失败，显示上次结果（${error}）`,
  ].filter(Boolean).join(' · ');
  if (!list.length) add(items,'p','没有匹配的事件。','meta');
  const groups = new Map();
  for (const row of list) {
    if (!groups.has(row.geo.id)) groups.set(row.geo.id, []);
    groups.get(row.geo.id).push(row);
  }
  const placeGroups = [...groups.values()].sort((a,b) =>
    Number(a[0].geo.region === 'unknown') - Number(b[0].geo.region === 'unknown'));
  for (const group of placeGroups) {
    const geo = group[0].geo;
    const section = add(items,'details','','place-group');
    const initiallyOpen = selectedRegion !== '' || placeGroups.length === 1;
    section.open = openPlaces.get(geo.id) ?? initiallyOpen;
    const title = add(section,'summary','','place-overview');
    const prefix = regions[geo.region].label;
    add(title,'strong',geo.region !== 'unknown' && prefix !== geo.label ? `${prefix} · ${geo.label}` : geo.label);
    const lanes = new Set(group.flatMap(row => [...row.lanes]));
    const newest = group.map(row => row.event.updatedAt).filter(Boolean).sort().at(-1);
    const stats = [`${group.length} 个事件`, lanes.size && `${lanes.size} 条关联线路`];
    if (newest && Number.isFinite(Date.parse(newest))) stats.push(updateTime.format(new Date(newest)));
    add(title,'span',stats.filter(Boolean).join(' · '),'meta');
    section.addEventListener('toggle', () => {
      if (section.isConnected && section.open !== initiallyOpen) openPlaces.set(geo.id, section.open);
      if (section.isConnected && section.open === initiallyOpen) openPlaces.delete(geo.id);
    });
    const cards = add(section,'div','','place-events');
    for (const {event,lanes,geo} of group) renderEvent(cards,event,lanes.size,geo);
  }
}

function renderEvent(items,event,laneCount,geo) {
  const card = add(items,'details','','event-card');
  card.open = openEvents.has(event.id);
  const summary = add(card,'summary','','event-overview');
  const headline = add(summary,'span','','event-headline');
  const kinds = Object.keys(labels).filter(kind => event.records.some(record => record.kind === kind));
  const topic = Object.hasOwn(topics, event.topic) ? event.topic : null;
  const dimension = topic ?? (kinds.length > 1 ? 'mixed' : kinds[0]);
  const category = topic ? topics[topic] : dimension === 'mixed' ? '多类信息' : labels[dimension];
  card.dataset.dimension = dimension ?? '';
  add(headline,'span',event.title,'event-title');
  const metadata = add(headline,'span','','event-metadata');
  if (category) add(metadata,'span',category,'event-category');
  if (kinds.length > 1) {
    add(metadata,'span',kinds.map(kind => labels[kind]).join(' / '),'event-evidence meta');
  }
  if (geo.basis === 'inferred') add(metadata,'span','按标题归属','event-place meta');
  const signals = add(summary,'span','','event-signals');
  if (laneCount) add(signals,'span',`${laneCount} 条关联线路`,'lane-count');
  const updated = new Date(event.updatedAt);
  if (event.updatedAt && Number.isFinite(updated.getTime())) {
    const time = add(signals,'time',updateTime.format(updated),'meta');
    time.dateTime = updated.toISOString();
    time.title = '最近更新';
  }
  card.addEventListener('toggle', () => {
    if (!card.isConnected) return;
    if (card.open) openEvents.add(event.id);
    else openEvents.delete(event.id);
  });
  const body = add(card,'div','','event-body');
  const heading = add(body,'div','','event-header');
  if (event.corroborationCount > 1) {
    add(heading,'div',`${event.corroborationCount} 个独立来源`,'meta');
  }
  const identity = add(heading,'div','事件 ID：','meta event-id');
  add(identity,'code',event.id);
  if(event.summary) add(heading,'p',event.summary);
  if(event.networkMatches.length) {
    const mapping = add(body,'section','','network-matches');
    add(mapping,'h3','关联线路');
    for (const match of event.networkMatches) {
      const group = add(mapping,'details','');
      group.open = event.networkMatches.length === 1;
      const basis = match.basis === 'event_anchor' ? '事件节点' : '报道提及地点';
      add(group,'summary',`${match.nodeName} · ${basis} · ${match.routes.length} 条线路`);
      const scrollArea = add(group,'div','','route-scroll');
      scrollArea.tabIndex = 0;
      scrollArea.setAttribute('role','region');
      scrollArea.setAttribute('aria-label',`${match.nodeName}关联线路`);
      const routes = add(scrollArea,'ul','','matched-routes');
      for (const route of match.routes) {
        const row = add(routes,'li','');
        add(row,'strong',`${route.origin} → ${route.destination}`);
        add(row,'span',`${route.modeLabel} · ${route.exposureLabel}（${route.matchedPathIds.length}/${route.candidatePathCount} 条候选路径）`,'meta');
      }
    }
  }
  const timeline = add(body,'div','','event-timeline');
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
    if(summary && normalizeHeadline(summary) !== normalizeHeadline(event.summary)) add(entry,'p',summary);
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
  const details=add(body,'details','');
  add(details,'summary','事件 JSON');
  add(details,'pre',JSON.stringify(event,null,2));
}
async function refresh() {
  const mode = modeControl.value;
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
        if (mode === 'live' && available) rememberLive(result);
      } catch (error) {
        errors.set(mode,error.message);
      } finally {
        pending.delete(mode);
        if (modeControl.value === mode) {
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
modeControl.onchange=()=>{
  regionControl.value = '';
  openPlaces.clear();
  try {localStorage.setItem(modeKey,modeControl.value);} catch {}
  refresh();
};
el('refresh').onclick=refresh;
let searchTimer;
el('search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(render,120);};
el('kind').onchange=render;el('sort').onchange=render;regionControl.onchange=render;
el('export').onclick=()=>{
  const url=URL.createObjectURL(new Blob([JSON.stringify({schemaVersion:data.schemaVersion,mode:data.mode,fetchedAt:data.fetchedAt,network:data.network,events:visible()},null,2)],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download='external-intelligence.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
refresh();
