const el = id => document.getElementById(id);
const store = {
  get(area, key) {try {return globalThis[area].getItem(key);} catch {return null;}},
  set(area, key, value) {try {globalThis[area].setItem(key,value);} catch {}},
};
function add(parent, tag, value, cls) {
  const child = document.createElement(tag);
  if (value) child.textContent = value;
  if (cls) child.className = cls;
  parent.append(child);
  return child;
}

const labels = {news:'新闻',signal:'观测信号',forecast:'预测'};
const topics = {maritime_security:'航道安全',transport_disruption:'运输运行',trade_policy:'经贸政策',security_development:'地缘安全',natural_hazard:'灾害',market_change:'市场变化',infrastructure_incident:'设施事故'};
const states = {ok:'已获取',empty:'无记录',stale:'缓存数据',unavailable:'暂不可用',partial:'部分可用',not_configured:'待接自建 WorldMonitor'};
const directions = {rising:'上升',falling:'下降',stable:'平稳'};
const shortTime = new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
const fullTime = new Intl.DateTimeFormat('zh-CN',{dateStyle:'medium',timeStyle:'short',hour12:false});
const percent = new Intl.NumberFormat('zh-CN',{style:'percent',maximumFractionDigits:1});
const pct = n => Number.isFinite(n) ? percent.format(n) : '—';
const validDate = value => {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? date : null;
};
function timeElement(parent, value, format = shortTime, cls = 'meta') {
  const date = validDate(value);
  if (!date) return null;
  const time = add(parent,'time',format.format(date),cls);
  time.dateTime = date.toISOString();
  time.title = fullTime.format(date);
  return time;
}

// ── Theme ────────────────────────────────────────────────────────────────
const theme = el('theme');
const themeKey = 'external-event-theme';
function applyTheme(value) {
  if (value === 'light' || value === 'dark') document.documentElement.dataset.theme = value;
  else delete document.documentElement.dataset.theme;
  drawMap();
}
const savedTheme = store.get('localStorage',themeKey);
if (savedTheme === 'light' || savedTheme === 'dark') theme.value = savedTheme;
theme.onchange = () => {
  applyTheme(theme.value);
  store.set('localStorage',themeKey,theme.value);
};
matchMedia('(prefers-color-scheme: light)').addEventListener('change',()=>drawMap());

// ── Derived event data (events are replaced on each refresh) ─────────────
const derived = new WeakMap();
function info(event) {
  let value = derived.get(event);
  if (!value) {
    const geo = event.geo ?? (event.region
      ? {id:'reported:'+event.region,label:event.region,region:'unknown'}
      : {id:'unknown',label:'地点待确认',region:'unknown'});
    const kinds = Object.keys(labels).filter(kind => event.records.some(record => record.kind === kind));
    const topic = Object.hasOwn(topics,event.topic) ? event.topic : null;
    value = {
      geo, kinds, topic,
      dimension:topic ?? (kinds.length > 1 ? 'mixed' : kinds[0] ?? ''),
      lanes:new Set(event.networkMatches.flatMap(match => match.routes.map(route => route.laneId))),
      reports:event.records.filter(record => record.role !== 'background').length,
      search:[
        event.title, event.displayTitle, event.latestUpdate?.text, event.summary, event.region, geo.label, geo.nodeId, data?.regions?.[geo.region]?.label, topic && topics[topic],
        ...event.networkMatches.flatMap(match => [match.nodeName,match.nodeId,...match.routes.flatMap(route => [route.origin,route.destination])]),
        ...event.records.flatMap(record => [record.title,record.category,record.summary,record.source?.publisher]),
      ].filter(Boolean).join('\n').toLowerCase(),
    };
    derived.set(event,value);
  }
  return value;
}

// ── Map ──────────────────────────────────────────────────────────────────
const mapView = el('map-view');
const canvas = mapView.querySelector('canvas');
const BASE_W = 960, BASE_H = 440;
const project = (lon, lat) => [(lon + 180) / 360, (80 - lat) / 165];
let landPath = null;
let mapState = 'loading';

function drawMap() {
  const width = canvas.clientWidth;
  if (!landPath || !width) return;
  const ratio = devicePixelRatio || 1;
  const w = Math.round(width * ratio), h = Math.round(width * BASE_H / BASE_W * ratio);
  if (canvas.width !== w || canvas.height !== h) {canvas.width = w; canvas.height = h;}
  const ctx = canvas.getContext('2d');
  const scale = w / BASE_W;
  const style = getComputedStyle(canvas);
  ctx.setTransform(1,0,0,1,0,0);
  ctx.clearRect(0,0,w,h);
  ctx.setTransform(scale,0,0,h / BASE_H,0,0);
  const gridColor = getComputedStyle(document.documentElement).getPropertyValue('--grid-line').trim();
  if (gridColor) {
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 0.5 * ratio / scale;
    ctx.beginPath();
    for (let lon = -150; lon <= 150; lon += 30) {
      const [x] = project(lon,0);
      ctx.moveTo(x * BASE_W,0);
      ctx.lineTo(x * BASE_W,BASE_H);
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const [,y] = project(0,lat);
      ctx.moveTo(0,y * BASE_H);
      ctx.lineTo(BASE_W,y * BASE_H);
    }
    ctx.stroke();
  }
  ctx.fillStyle = style.color;
  ctx.strokeStyle = style.borderTopColor;
  ctx.lineWidth = 0.6 * ratio / scale;
  ctx.lineJoin = 'round';
  ctx.fill(landPath);
  ctx.stroke(landPath);
}
new ResizeObserver(()=>drawMap()).observe(canvas);

// Start the basemap download alongside the first feed request.
fetch('/vendor/worldmonitor/countries.geojson')
  .then(response => {
    if (!response.ok) throw Error('Map unavailable');
    return response.json();
  })
  .then(geojson => {
    const path = new Path2D();
    for (const {geometry, properties} of geojson.features) {
      if (properties['ISO3166-1-Alpha-2'] === 'AQ') continue;
      const rings = geometry?.type === 'Polygon' ? [geometry.coordinates[0]]
        : geometry?.type === 'MultiPolygon' ? geometry.coordinates.map(polygon => polygon[0]) : [];
      for (const ring of rings) ring.forEach(([lon,lat],index) => {
        const [x,y] = project(lon,lat);
        path[index ? 'lineTo' : 'moveTo'](x * BASE_W,y * BASE_H);
      });
      path.closePath();
    }
    landPath = path;
    mapState = 'ready';
    drawMap();
  })
  .catch(() => {mapState = 'unavailable';})
  .finally(renderMapNote);

let unmappedEvents = 0;
function renderMapNote() {
  el('map-note').textContent = [
    mapState === 'unavailable' ? '底图暂不可用，可用区域筛选查看事件。' : '圆点为区域事件数，点击筛选。',
    unmappedEvents && `${unmappedEvents} 个事件地点待确认。`,
  ].filter(Boolean).join(' ');
}

const regionControl = el('region');
function renderRegionControls(rows) {
  const counts = new Map();
  for (const {geo} of rows) counts.set(geo.region,(counts.get(geo.region) ?? 0) + 1);
  const selected = regionControl.value;
  regionControl.replaceChildren(new Option('全部区域',''));
  const markers = el('map-markers');
  const focused = document.activeElement?.dataset.mapRegion;
  markers.replaceChildren();
  const largest = Math.max(1,...counts.values());
  for (const [id,area] of Object.entries(data?.regions ?? {unknown:{label:'地点待确认'}})) {
    const count = counts.get(id);
    if (!count && selected !== id) continue;
    regionControl.add(new Option(`${area.label} · ${count ?? 0}`,id));
    if (!count || area.lon == null) continue;
    const marker = add(markers,'button',String(count),'map-marker');
    const [x,y] = project(area.lon,area.lat);
    marker.type = 'button';
    marker.style.left = `${x * 100}%`;
    marker.style.top = `${y * 100}%`;
    marker.style.setProperty('--size',`${24 + 18 * Math.sqrt((count - 1) / Math.max(1,largest - 1))}px`);
    marker.dataset.mapRegion = id;
    marker.title = `${area.label} · ${count} 个事件`;
    marker.setAttribute('aria-label',marker.title);
    marker.setAttribute('aria-pressed',String(selected === id));
    marker.onclick = () => {
      regionControl.value = selected === id ? '' : id;
      render();
    };
    if (focused === id) marker.focus({preventScroll:true});
  }
  regionControl.value = selected;
  unmappedEvents = counts.get('unknown') ?? 0;
  renderMapNote();
}

// ── Data ─────────────────────────────────────────────────────────────────
let data;
const cache = new Map();
const pending = new Map();
const errors = new Map();
const modeKey = 'external-event-mode';
const snapshotKey = 'external-event-live-v3';
const modeInputs = [...document.querySelectorAll('input[name="mode"]')];
const currentMode = () => modeInputs.find(input => input.checked)?.value ?? 'sample';
const savedMode = store.get('localStorage',modeKey);
for (const input of modeInputs) input.checked = input.value === (savedMode === 'live' ? 'live' : 'sample');
try {
  const saved = JSON.parse(store.get('sessionStorage',snapshotKey));
  if (saved?.mode === 'live' && Array.isArray(saved.events) && Array.isArray(saved.sources)) cache.set('live',saved);
} catch {}

function visible(applyRegion = true) {
  const query = el('search').value.trim().toLowerCase();
  return (data?.events ?? []).filter(event => {
    const meta = info(event);
    return (!applyRegion || !regionControl.value || meta.geo.region === regionControl.value) &&
      (!query || meta.search.includes(query));
  });
}

// ── Rendering ────────────────────────────────────────────────────────────
const openEvents = new Set();
const openPlaces = new Map();

function renderStats(list) {
  const stats = el('stats');
  stats.replaceChildren();
  const stat = (label, value, tone) => {
    const item = add(stats,'div','','stat');
    if (tone) item.dataset.tone = tone;
    add(item,'dt',label);
    add(item,'dd',String(value));
  };
  stat('事件',list.length);
  stat('关联线路',new Set(list.flatMap(event => [...info(event).lanes])).size);
  stat('记录',list.reduce((sum,event) => sum + info(event).reports,0));
  if (data.mode === 'live') {
    const feeds = data.sources.flatMap(source => source.feedStatus ?? []);
    if (feeds.length) {
      const healthy = feeds.filter(feed => !feed.error).length;
      stat('可用来源',`${healthy}/${feeds.length}`,healthy === feeds.length ? 'ok' : healthy ? 'warn' : 'bad');
    }
  }
}

function renderStatus(loading, error) {
  const status = el('status');
  status.replaceChildren();
  status.dataset.loading = String(Boolean(loading));
  el('sources').hidden = !data;
  el('network-data').hidden = !data;
  if (!data) {
    status.textContent = loading ? '正在获取数据…' : error ?? '';
    return;
  }
  if (data.mode === 'live') {
    add(status,'span','更新于 ');
    timeElement(status,data.fetchedAt,fullTime,'');
  } else add(status,'span','虚构样例，仅用于演示');
  const notes = [
    data.mode === 'live' && data.sources.some(source => ['partial','stale','unavailable'].includes(source.state)) && '部分来源异常',
    loading && '更新中…',
    error && `更新失败，显示上次结果（${error}）`,
  ].filter(Boolean);
  for (const note of notes) add(status,'span',note,error && note.startsWith('更新失败') ? 'status-error' : 'status-note');

  const sourceStatus = el('source-status');
  sourceStatus.replaceChildren();
  const sourceLabel = data.mode === 'sample' ? '虚构样例'
    : data.liveSource === 'self-hosted' ? '自建 WorldMonitor' : '公开新闻 RSS';
  add(sourceStatus,'li',sourceLabel,'source-heading');
  for (const source of data.sources) {
    add(sourceStatus,'li',`${labels[source.kind]} · ${source.recordCount ?? 0} 条输入记录 · ${states[source.state]}${source.error ? '（'+source.error+'）' : ''}`);
    for (const feed of source.feedStatus ?? []) {
      const row = add(sourceStatus,'li','','feed-row');
      row.dataset.state = feed.error ? (feed.count ? 'warn' : 'bad') : 'ok';
      if (/^https?:\/\//i.test(feed.url ?? '')) {
        const link = add(row,'a',feed.name);
        link.href = feed.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      } else add(row,'span',feed.name);
      add(row,'span',feed.error ? `${feed.count ? feed.count+' 条（上次结果）' : '失败'} · ${feed.error}` : `${feed.count} 条`,'meta');
    }
  }
  const {label,nodeCount,laneCount,originCount,destinationCount} = data.network;
  el('network-label').textContent = `线路与节点 · ${nodeCount} 个节点 · ${laneCount} 条线路 · ${originCount} 个起点 · ${destinationCount} 个目的地`;
  el('network-label').title = label;
}

const networkStatus = el('network-status');
const networkTables = el('network-tables');
el('network-data').addEventListener('toggle', async event => {
  if (!event.currentTarget.open || !data || networkTables.childElementCount || networkStatus.dataset.loading) return;
  const networkLabel = data.network.label;
  networkStatus.dataset.loading = 'true';
  networkStatus.textContent = '正在读取线路底表…';
  try {
    const response = await fetch('/api/network');
    if (!response.ok) throw Error('读取失败');
    const {nodes,lanes,meta} = await response.json();
    const names = new Map(nodes.map(node => [node.id,node.name_zh || node.name_en || node.id]));
    const modeNames = {sea:'海运',air:'空运',rail:'铁路',road:'公路',local:'本地'};
    const nodeTypes = {city:'城市',country:'国家或地区',port:'港口',airport:'机场',chokepoint:'交通咽喉',sea_area:'海域'};
    const content = document.createDocumentFragment();
    add(content,'p',[networkLabel,meta?.basis].filter(Boolean).join(' · '),'meta');
    const laneTable = dataTable(content,'线路与候选路径',['线路','运输方式','候选路径']);
    for (const lane of lanes) {
      for (const [mode, detail] of Object.entries(lane.modes)) {
        const row = add(laneTable,'tr');
        add(row,'th',`${lane.origin_name} → ${lane.dest_name}`).scope = 'row';
        add(row,'td',modeNames[mode] ?? mode);
        const paths = add(row,'td');
        for (const path of detail.paths) {
          add(paths,'div',`${path.likelihood} · ${path.nodes.map(id => names.get(id) ?? id).join(' → ')}`);
        }
      }
    }
    const nodeTable = dataTable(content,'节点',['节点 ID','名称','类型','国家或地区代码','别名']);
    for (const node of nodes) {
      const row = add(nodeTable,'tr');
      const id = add(row,'th');
      id.scope = 'row';
      add(id,'code',node.id);
      add(row,'td',names.get(node.id));
      add(row,'td',nodeTypes[node.type] ?? node.type);
      add(row,'td',node.country);
      add(row,'td',node.aliases?.join('、'));
    }
    networkTables.replaceChildren(content);
    networkStatus.textContent = '';
  } catch {
    networkStatus.textContent = '线路底表读取失败，收起后重新展开可重试。';
  } finally {
    delete networkStatus.dataset.loading;
  }
});

function dataTable(parent, title, columns) {
  const panel = add(parent,'div','','data-table');
  panel.tabIndex = 0;
  panel.setAttribute('role','region');
  panel.setAttribute('aria-label',title);
  const table = add(panel,'table');
  add(table,'caption',title);
  const header = add(add(table,'thead'),'tr');
  for (const column of columns) add(header,'th',column).scope = 'col';
  return add(table,'tbody');
}

function render() {
  const mode = currentMode();
  const loading = pending.has(mode);
  const error = errors.get(mode);
  const rows = visible(false).map(event => ({event,...info(event)}));
  mapView.hidden = !data;
  el('event-list').hidden = !data;
  renderRegionControls(rows);
  renderStatus(loading,error);
  const items = el('items');
  items.replaceChildren();
  el('export').disabled = true;
  if (!data) {el('stats').replaceChildren(); return;}
  const selectedRegion = regionControl.value;
  const list = rows.filter(row => !selectedRegion || row.geo.region === selectedRegion);
  if (el('sort').value === 'routes') list.sort((a,b) => b.lanes.size - a.lanes.size);
  el('export').disabled = !list.length;
  renderStats(list.map(row => row.event));
  if (!list.length) {add(items,'p','没有匹配的事件。','empty'); return;}

  const groups = new Map();
  for (const row of list) {
    if (!groups.has(row.geo.id)) groups.set(row.geo.id,[]);
    groups.get(row.geo.id).push(row);
  }
  const placeGroups = [...groups.values()].sort((a,b) =>
    Number(a[0].geo.region === 'unknown') - Number(b[0].geo.region === 'unknown'));
  for (const group of placeGroups) {
    const {geo} = group[0];
    const section = add(items,'details','','place-group');
    // Cards are one-line summaries, so groups start open; the unresolved bucket starts closed.
    const initiallyOpen = selectedRegion !== '' || geo.region !== 'unknown' || placeGroups.length === 1;
    section.open = openPlaces.get(geo.id) ?? initiallyOpen;
    const title = add(section,'summary','','place-overview');
    const prefix = data.regions?.[geo.region]?.label;
    const name = add(title,'span','','place-name');
    if (prefix && geo.region !== 'unknown' && prefix !== geo.label) add(name,'span',prefix,'place-region');
    add(name,'strong',geo.label);
    if (geo.nodeId) add(name,'code',geo.nodeId,'meta');
    const stats = add(title,'span','','place-stats');
    add(stats,'span',`${group.length} 个事件`);
    const lanes = new Set(group.flatMap(row => [...row.lanes]));
    if (lanes.size) add(stats,'span',`${lanes.size} 条线路`,'accent');
    timeElement(stats,group.map(row => row.event.updatedAt).filter(Boolean).sort().at(-1),shortTime,'');
    section.addEventListener('toggle',() => {
      if (!section.isConnected) return;
      if (section.open === initiallyOpen) openPlaces.delete(geo.id);
      else openPlaces.set(geo.id,section.open);
    });
    const cards = add(section,'div','','place-events');
    for (const row of group) renderEvent(cards,row);
  }
}

const translateButton = el('translate');
const translationOptions = {sourceLanguage:'en', targetLanguage:'zh'};
let translator;
let translateCards = false;
const translated = new Map();

if (globalThis.Translator) {
  Translator.availability(translationOptions).then(availability => {
    translateButton.hidden = availability === 'unavailable';
  }).catch(() => {});
}

translateButton.onclick = async () => {
  translateButton.disabled = true;
  try {
    if (!translator) {
      translateButton.textContent = '准备翻译…';
      translator = await Translator.create({
        ...translationOptions,
        monitor(download) {
          download.addEventListener('downloadprogress', event => {
            translateButton.textContent = `下载翻译语言包 ${Math.round(event.loaded * 100)}%`;
          });
        },
      });
    }
    translateCards = !translateCards;
    translateButton.setAttribute('aria-pressed', String(translateCards));
    translateButton.textContent = translateCards ? '显示原文' : '翻译成中文';
    render();
  } catch {
    translateButton.textContent = '翻译失败，重试';
  } finally {
    translateButton.disabled = false;
  }
};

function addCardText(parent, original, className, prefix = '') {
  const node = add(parent,'span',prefix + original,className);
  if (!translateCards || !/[a-z]{2}/i.test(original) || /\p{Script=Han}/u.test(original)) return;
  if (!translated.has(original)) {
    // Keep the cache bounded as the live feed changes.
    if (translated.size >= 300) translated.delete(translated.keys().next().value);
    translated.set(original,translator.translate(original).catch(() => {
      translated.delete(original);
      return original;
    }));
  }
  translated.get(original).then(text => {
    if (translateCards && node.isConnected) node.textContent = prefix + text;
  });
}

// Progress dates come as YYYY-MM-DD (the date the report gives) or a UTC minute.
const progressTime = new Intl.DateTimeFormat('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
function progressDate({occurredAt, precision}) {
  if (typeof occurredAt !== 'string') return '';
  if (precision === 'day') {
    const [, month, day] = occurredAt.split('-').map(Number);
    return month && day ? `${month}月${day}日` : '';
  }
  const time = new Date(occurredAt);
  return Number.isNaN(time.getTime()) ? '' : progressTime.format(time);
}

function renderEvent(parent, {event, kinds, topic, dimension, lanes, reports}) {
  const card = add(parent,'details','','event-card');
  card.dataset.dimension = dimension;
  const summary = add(card,'summary','','event-overview');
  const headline = add(summary,'span','','event-headline');
  addCardText(headline,event.displayTitle ?? event.title,'event-title');
  if (event.latestUpdate?.text) {
    const progress = event.latestUpdate.kind === 'progress';
    const when = progress ? progressDate(event.latestUpdate) : '';
    addCardText(headline,event.latestUpdate.text + (when ? `（${when}）` : ''),'meta',progress ? '最新进展：' : '最新报道：');
  }
  const metadata = add(headline,'span','','event-metadata');
  const category = topic ? topics[topic] : dimension === 'mixed' ? '多类信息' : labels[dimension];
  if (category) add(metadata,'span',category,'event-category');
  if (kinds.length > 1) add(metadata,'span',kinds.map(kind => labels[kind]).join(' / '));
  if (reports > 1) add(metadata,'span',`${reports} 条记录`);
  if (event.corroborationCount > 1) add(metadata,'span',`${event.corroborationCount} 个独立来源`);
  const signals = add(summary,'span','','event-signals');
  if (lanes.size) add(signals,'span',`${lanes.size} 条线路`,'lane-count');
  const time = timeElement(signals,event.updatedAt);
  if (time) time.title = `最近更新：${time.title}`;

  // Card bodies are built on first open: most cards stay collapsed.
  let built = false;
  const build = () => {
    if (built) return;
    built = true;
    renderEventBody(add(card,'div','','event-body'),event);
  };
  card.open = openEvents.has(event.id);
  if (card.open) build();
  card.addEventListener('toggle',() => {
    if (!card.isConnected) return;
    if (card.open) {openEvents.add(event.id); build();}
    else openEvents.delete(event.id);
  });
}

const normalizeHeadline = value => (value ?? '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(' ') ?? '';

function renderEventBody(body, event) {
  if (event.summary) add(body,'p',event.summary,'event-summary');

  if (event.networkMatches.length) {
    const mapping = add(body,'section','','network-matches');
    add(mapping,'h3','关联线路');
    for (const match of event.networkMatches) {
      const group = add(mapping,'details','','route-group');
      group.open = event.networkMatches.length === 1;
      const heading = add(group,'summary');
      add(heading,'strong',match.nodeName);
      if (match.nodeId) add(heading,'code',match.nodeId,'meta');
      add(heading,'span',`${match.basis === 'event_anchor' ? '事件节点' : '报道提及'} · ${match.routes.length} 条线路`,'meta');
      const scrollArea = add(group,'div','','route-scroll');
      scrollArea.tabIndex = 0;
      scrollArea.setAttribute('role','region');
      scrollArea.setAttribute('aria-label',`${match.nodeName}关联线路`);
      const table = add(scrollArea,'table','','routes');
      for (const route of match.routes) {
        const row = add(table,'tr');
        add(row,'th',`${route.origin} → ${route.destination}`).scope = 'row';
        add(row,'td',route.modeLabel,'route-mode');
        add(row,'td',`${route.exposureLabel}（${route.matchedPathIds.length}/${route.candidatePathCount}）`,'meta');
      }
    }
  }

  const entries = new Map();
  const ordered = [...event.records.filter(r => r.role !== 'background'),...event.records.filter(r => r.role === 'background')];
  for (const record of ordered) {
    const key = record.kind === 'news' ? `news:${record.role ?? ''}:${normalizeHeadline(record.title)}` : record.id;
    if (!entries.has(key)) entries.set(key,[]);
    entries.get(key).push(record);
  }
  const timelineSection = add(body,'section','','timeline-section');
  add(timelineSection,'h3',`动态时间线 · ${entries.size}`);
  const timeline = add(timelineSection,'ol','','timeline');
  const eventHeadline = normalizeHeadline(event.title);
  const eventSummary = normalizeHeadline(event.summary);
  for (const records of entries.values()) {
    const record = records[0];
    const entry = add(timeline,'li','','timeline-entry');
    if (record.role === 'background') entry.dataset.role = 'background';
    const meta = add(entry,'div','','entry-meta');
    timeElement(meta,record.time.value,shortTime,'entry-time');
    if (record.role === 'background') add(meta,'span','背景分析','entry-tag');
    else if (record.kind !== 'news') add(meta,'span',labels[record.kind],'entry-tag');
    const links = new Set();
    for (const {source} of records) {
      if (source.url && /^https?:\/\//i.test(source.url)) {
        if (links.has(source.url)) continue;
        links.add(source.url);
        const link = add(meta,'a',source.publisher || '查看来源');
        link.href = source.url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      } else if (source.publisher) add(meta,'span',source.publisher);
    }
    if (record.region) add(meta,'span',record.region);
    const headline = normalizeHeadline(record.title);
    if (headline !== eventHeadline) add(entry,'p',record.title,'entry-title');
    const snippet = records.find(item => {
      const text = normalizeHeadline(item.summary);
      // Aggregator descriptions often repeat only the headline and publisher.
      return text && text !== headline && text !== [headline,normalizeHeadline(item.source.publisher)].filter(Boolean).join(' ');
    })?.summary;
    if (snippet && normalizeHeadline(snippet) !== eventSummary) add(entry,'p',snippet,'entry-snippet');
    if (record.forecast) {
      const f = record.forecast;
      add(entry,'p',[`概率 ${pct(f.probability)}`,f.priorProbability != null && `上次 ${pct(f.priorProbability)}`,directions[f.direction],f.horizon].filter(Boolean).join(' · '),'forecast');
      if (f.change) add(entry,'p',f.change,'entry-snippet');
      if (record.evidence.triggers.length) add(entry,'p','关注：'+record.evidence.triggers.join('、'),'meta');
    }
  }

  const footer = add(body,'div','','event-footer');
  const identity = add(footer,'span','事件 ID ','meta');
  add(identity,'code',event.id);
  const json = add(footer,'details','','event-json');
  add(json,'summary','事件 JSON');
  json.addEventListener('toggle',() => {
    if (json.open && !json.querySelector('pre')) add(json,'pre',JSON.stringify(event,null,2));
  });
}

// ── Loading ──────────────────────────────────────────────────────────────
function rememberLive(result) {
  store.set('sessionStorage',snapshotKey,JSON.stringify(result));
}
// Event titles are written in the background; re-read a few times while some are still pending.
let presentationPolls = 0;
let presentationTimer;
function followPresentation(result) {
  clearTimeout(presentationTimer);
  if (!(result?.presentationPending > 0) || presentationPolls >= 12) {presentationPolls = 0; return;}
  presentationPolls++;
  presentationTimer = setTimeout(() => {if (currentMode() === 'live') refresh();},5000);
}
async function refresh() {
  const mode = currentMode();
  errors.delete(mode);
  if (!pending.has(mode)) {
    const task = (async () => {
      try {
        const response = await fetch('/api/feed?mode='+mode);
        if (!response.ok) throw Error('本地接口暂不可用');
        const result = await response.json();
        if (result.mode !== mode || !Array.isArray(result.events)) throw Error('数据格式异常');
        const available = result.sources.some(source => ['ok','partial','stale','empty'].includes(source.state));
        if (!available && cache.has(mode)) throw Error('数据来源暂不可用');
        cache.set(mode,result);
        if (mode === 'live' && available) rememberLive(result);
        if (mode === 'live') followPresentation(result);
      } catch (error) {
        errors.set(mode,error.message);
      } finally {
        pending.delete(mode);
        if (currentMode() === mode) {
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

for (const input of modeInputs) input.onchange = () => {
  regionControl.value = '';
  openPlaces.clear();
  store.set('localStorage',modeKey,currentMode());
  refresh();
};
el('refresh').onclick = refresh;
const modelDialog = el('model-settings');
const modelForm = el('model-settings-form');
const modelPicker = el('model-profiles');
const modelName = el('model-profile-name');
const modelBaseUrl = el('model-base-url');
const modelId = el('model-id');
const modelKey = el('model-api-key');
const clearModelKey = el('clear-model-key');
const modelOpen = el('open-model-settings');
const modelSave = el('save-model-settings');
const modelActivate = el('activate-model-profile');
const modelStatus = el('model-settings-status');
let modelSettings;
let selectedModelId = null;

function modelProfileLabel(profile) {
  const model = profile.modelId && profile.modelId !== profile.name ? ` · ${profile.modelId}` : '';
  return `${profile.name}${model} · ${profile.baseUrl}`;
}

function setModelSettings(settings) {
  modelSettings = settings;
  const active = settings.profiles.find(profile => profile.id === settings.activeId);
  const text = active ? `当前模型：${active.name === active.modelId ? active.modelId : `${active.name} · ${active.modelId}`}`
    : '模型未启用';
  modelOpen.textContent = text;
  modelOpen.title = active ? `当前启用：${modelProfileLabel(active)}` : '打开模型配置';
  modelOpen.setAttribute('aria-label',`模型配置，${text}`);
}

function showModelProfile(id) {
  const profile = modelSettings.profiles.find(item => item.id === id);
  selectedModelId = profile?.id ?? null;
  modelPicker.replaceChildren();
  for (const entry of modelSettings.profiles) {
    modelPicker.add(new Option(modelProfileLabel(entry) + (entry.id === modelSettings.activeId ? '（当前启用）' : ''),entry.id));
  }
  if (!profile) modelPicker.add(new Option('新配置，尚未保存',''));
  modelPicker.value = selectedModelId ?? '';
  modelName.value = profile?.name ?? '';
  modelBaseUrl.value = profile?.baseUrl ?? modelSettings.defaultBaseUrl;
  modelId.value = profile?.modelId ?? '';
  modelKey.value = '';
  modelKey.disabled = false;
  clearModelKey.checked = false;
  el('clear-model-key-row').hidden = !profile?.hasApiKey;
  el('model-key-note').textContent = profile?.hasApiKey
    ? '已保存密钥。更换 Base URL 时请重新输入。'
    : '尚未保存密钥。本机模型服务可以不填。';
  modelActivate.disabled = !profile?.ready;
  modelActivate.textContent = profile && profile.id === modelSettings.activeId ? '停用此配置' : '启用此配置';
  modelSave.disabled = false;
}

async function readModelSettings() {
  const response = await fetch('/api/model-settings');
  if (!response.ok) throw Error('无法读取模型配置。');
  setModelSettings(await response.json());
}
readModelSettings().catch(() => {});

modelOpen.onclick = async () => {
  modelForm.reset();
  el('clear-model-key-row').hidden = true;
  modelSave.disabled = true;
  modelActivate.disabled = true;
  modelStatus.textContent = '正在读取配置…';
  modelDialog.showModal();
  try {
    await readModelSettings();
    showModelProfile(modelSettings.activeId ?? modelSettings.profiles[0]?.id);
    modelStatus.textContent = '';
  } catch {
    modelStatus.textContent = '无法读取模型配置，请关闭后重试。';
  }
};
el('close-model-settings').onclick = () => modelDialog.close();
modelDialog.addEventListener('close', () => {modelKey.value = '';});
modelPicker.onchange = () => {
  showModelProfile(modelPicker.value);
  modelStatus.textContent = '';
};
el('new-model-profile').onclick = () => {
  if (!modelSettings) return;
  showModelProfile(null);
  modelStatus.textContent = '';
  modelName.focus();
};
clearModelKey.onchange = () => {
  modelKey.disabled = clearModelKey.checked;
  if (clearModelKey.checked) modelKey.value = '';
};

async function submitModelSettings(payload) {
  modelSave.disabled = true;
  modelActivate.disabled = true;
  modelStatus.textContent = '正在保存…';
  try {
    const previousActiveId = modelSettings.activeId;
    const response = await fetch('/api/model-settings',{
      method:'PUT',
      headers:{'content-type':'application/json'},
      body:JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error ?? '无法保存模型配置。');
    setModelSettings(result);
    showModelProfile(result.profileId ?? selectedModelId);
    const active = result.profiles.find(profile => profile.id === result.activeId);
    const changed = previousActiveId !== result.activeId || Boolean(active && payload.action === 'save' && active.id === payload.id);
    modelStatus.textContent = payload.action === 'save' ? '配置已保存。'
      : active ? `已启用 ${active.name}。` : '已停用模型。';
    if (changed && currentMode() === 'live') {
      await pending.get('live');
      if (currentMode() === 'live') refresh();
    }
  } catch (error) {
    modelStatus.textContent = error.message;
    modelSave.disabled = false;
    modelActivate.disabled = !modelSettings.profiles.some(profile => profile.id === selectedModelId && profile.ready);
  }
}

modelActivate.onclick = () => submitModelSettings({
  action:'activate',
  id:modelSettings.activeId === selectedModelId ? null : selectedModelId,
});
modelForm.onsubmit = event => {
  event.preventDefault();
  submitModelSettings({
    action:'save',
    id:selectedModelId,
    name:modelName.value,
    baseUrl:modelBaseUrl.value,
    modelId:modelId.value,
    apiKey:modelKey.value,
    clearKey:clearModelKey.checked,
  });
};
let searchTimer;
el('search').oninput = () => {clearTimeout(searchTimer); searchTimer = setTimeout(render,120);};
el('sort').onchange = render;
regionControl.onchange = render;
el('export').onclick = () => {
  const blob = new Blob([JSON.stringify({schemaVersion:data.schemaVersion,mode:data.mode,fetchedAt:data.fetchedAt,network:data.network,events:visible()},null,2)],{type:'application/json'});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = 'external-intelligence.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url),1000);
};
applyTheme(theme.value);
refresh();
