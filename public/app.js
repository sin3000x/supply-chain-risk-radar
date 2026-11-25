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
const feedCategories = {world:'全球',regional:'区域',trade:'贸易',shipping:'航运',official:'官方',chokepoint:'航道',weather:'气象',market:'盘口'};
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
        ...event.networkMatches.flatMap(match => [match.nodeName,match.nodeId,match.nodeCode,...match.routes.flatMap(route => [route.origin,route.destination])]),
        ...event.records.flatMap(record => [record.title,record.category,record.summary,record.source?.publisher]),
      ].filter(Boolean).join('\n').toLowerCase(),
    };
    derived.set(event,value);
  }
  return value;
}

// ── Map & Spatial State ──────────────────────────────────────────────────
const mapView = el('map-view');
const riskMap = el('risk-map');
const canvas = mapView.querySelector('canvas');
const mapRegions = el('map-regions');
const mapZoomIn = el('map-zoom-in');
const mapZoomOut = el('map-zoom-out');
const mapReset = el('map-reset');
const regionControl = el('region');
const sortControl = el('sort');
const timeWindowControl = el('time-window');
const customTimeBar = el('custom-time-bar');
const customHoursGroup = el('custom-hours-group');
const customTimeValue = el('custom-time-value');
const customTimeUnit = el('custom-time-unit');
const customDatesGroup = el('custom-dates-group');
const customDateFrom = el('custom-date-from');
const customDateTo = el('custom-date-to');
const BASE_W = 960, BASE_H = 440;
const GLOBAL_CAMERA = {minLon:-180, maxLon:180, minLat:-62, maxLat:78, zoomed:false};
const WORLD_LON_SPAN = GLOBAL_CAMERA.maxLon - GLOBAL_CAMERA.minLon;
const WORLD_LAT_SPAN = GLOBAL_CAMERA.maxLat - GLOBAL_CAMERA.minLat;
const WORLD_ASPECT = WORLD_LON_SPAN / WORLD_LAT_SPAN;
const MIN_LON_SPAN = 12;
let mapCamera = {...GLOBAL_CAMERA};
const project = (lon, lat, camera = mapCamera) => [
  (lon - camera.minLon) / (camera.maxLon - camera.minLon),
  (camera.maxLat - lat) / (camera.maxLat - camera.minLat),
];

let landRings = null;
let landPath = null;
let landPathKey = '';
let mapState = 'loading';
let selectedPlaceId = null;
let hoveredPlaceId = null;
let hoveredRegionId = null;
let lastAutoFramedRegion = '';
let currentRegionGroups = [];
let mapPlaces = [];
let mapCorridors = [];

const hasCoords = geo => Number.isFinite(geo?.lon) && Number.isFinite(geo?.lat);
function formatCoord(lon, lat) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return '';
  return `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`;
}
function compareSpatial(aGeo, bGeo) {
  const aLon = Number.isFinite(aGeo?.lon) ? aGeo.lon : 999;
  const bLon = Number.isFinite(bGeo?.lon) ? bGeo.lon : 999;
  if (aLon !== bLon) return aLon - bLon;
  const aLat = Number.isFinite(aGeo?.lat) ? aGeo.lat : -999;
  const bLat = Number.isFinite(bGeo?.lat) ? bGeo.lat : -999;
  if (aLat !== bLat) return bLat - aLat;
  return (aGeo?.label ?? '').localeCompare(bGeo?.label ?? '', 'zh-CN');
}

function buildLandPath() {
  if (!landRings) return null;
  const key = `${mapCamera.minLon}:${mapCamera.maxLon}:${mapCamera.minLat}:${mapCamera.maxLat}`;
  if (landPath && landPathKey === key) return landPath;
  const path = new Path2D();
  for (const ring of landRings) {
    ring.forEach(([lon, lat], index) => {
      const [x, y] = project(lon, lat);
      path[index ? 'lineTo' : 'moveTo'](x * BASE_W, y * BASE_H);
    });
    path.closePath();
  }
  landPath = path;
  landPathKey = key;
  return path;
}

function clampSpan(min, max, span, limitMin, limitMax) {
  const total = limitMax - limitMin;
  if (span >= total) return [limitMin, limitMax];
  const center = (min + max) / 2;
  let start = center - span / 2;
  let end = center + span / 2;
  if (start < limitMin) {end += limitMin - start; start = limitMin;}
  if (end > limitMax) {start -= end - limitMax; end = limitMax;}
  return [Math.max(limitMin, start), Math.min(limitMax, end)];
}

function setCameraBounds(minLon, maxLon, minLat, maxLat) {
  let lonSpan = Math.min(WORLD_LON_SPAN, Math.max(MIN_LON_SPAN, maxLon - minLon));
  let latSpan = lonSpan / WORLD_ASPECT;
  if (latSpan > WORLD_LAT_SPAN) {
    latSpan = WORLD_LAT_SPAN;
    lonSpan = latSpan * WORLD_ASPECT;
  }
  const [clampedMinLon, clampedMaxLon] = clampSpan(minLon, maxLon, lonSpan, GLOBAL_CAMERA.minLon, GLOBAL_CAMERA.maxLon);
  const [clampedMinLat, clampedMaxLat] = clampSpan(minLat, maxLat, latSpan, GLOBAL_CAMERA.minLat, GLOBAL_CAMERA.maxLat);
  mapCamera = {
    minLon:clampedMinLon,
    maxLon:clampedMaxLon,
    minLat:clampedMinLat,
    maxLat:clampedMaxLat,
    zoomed:lonSpan < WORLD_LON_SPAN - 0.5,
  };
}

const nonMapRegions = new Set(['crossRegion', 'unknown']);

function updateMapCamera(regionGroups, selectedRegion) {
  if (!selectedRegion || nonMapRegions.has(selectedRegion)) {
    mapCamera = {...GLOBAL_CAMERA};
    return;
  }
  const points = [];
  for (const group of regionGroups) {
    if (group.regionId !== selectedRegion) continue;
    for (const place of group.places) {
      if (hasCoords(place.geo)) points.push([place.geo.lon, place.geo.lat]);
    }
  }
  const area = data?.regions?.[selectedRegion];
  if (Number.isFinite(area?.lon) && Number.isFinite(area?.lat)) points.push([area.lon, area.lat]);
  if (!points.length) {
    mapCamera = {...GLOBAL_CAMERA};
    return;
  }
  const lons = points.map(p => p[0]);
  const lats = points.map(p => p[1]);
  const rawMinLon = Math.min(...lons), rawMaxLon = Math.max(...lons);
  const rawMinLat = Math.min(...lats), rawMaxLat = Math.max(...lats);
  let lonSpan = Math.max(44, (rawMaxLon - rawMinLon) + 18);
  let latSpan = Math.max(20, (rawMaxLat - rawMinLat) + 12);
  if (lonSpan / latSpan < WORLD_ASPECT) lonSpan = latSpan * WORLD_ASPECT;
  else latSpan = lonSpan / WORLD_ASPECT;
  const cLon = (rawMinLon + rawMaxLon) / 2;
  const cLat = (rawMinLat + rawMaxLat) / 2;
  setCameraBounds(cLon - lonSpan / 2, cLon + lonSpan / 2, cLat - latSpan / 2, cLat + latSpan / 2);
}

function zoomCameraBy(factor, anchorX = 0.5, anchorY = 0.5) {
  const currentLonSpan = mapCamera.maxLon - mapCamera.minLon;
  const currentLatSpan = mapCamera.maxLat - mapCamera.minLat;
  const anchorLon = mapCamera.minLon + anchorX * currentLonSpan;
  const anchorLat = mapCamera.maxLat - anchorY * currentLatSpan;
  const newLonSpan = Math.min(WORLD_LON_SPAN, Math.max(MIN_LON_SPAN, currentLonSpan * factor));
  const newLatSpan = newLonSpan / WORLD_ASPECT;
  const minLon = anchorLon - anchorX * newLonSpan;
  const maxLat = anchorLat + anchorY * newLatSpan;
  setCameraBounds(minLon, minLon + newLonSpan, maxLat - newLatSpan, maxLat);
  refreshMapViewport();
}

function panCameraByPixels(dx, dy, startCamera, rect) {
  if (!rect.width || !rect.height) return;
  const lonSpan = startCamera.maxLon - startCamera.minLon;
  const latSpan = startCamera.maxLat - startCamera.minLat;
  const dLon = -(dx / rect.width) * lonSpan;
  const dLat = (dy / rect.height) * latSpan;
  setCameraBounds(
    startCamera.minLon + dLon,
    startCamera.maxLon + dLon,
    startCamera.minLat + dLat,
    startCamera.maxLat + dLat
  );
  refreshMapViewport();
}

function centerCameraOnPlace(geo) {
  if (!hasCoords(geo)) return;
  const currentLonSpan = mapCamera.maxLon - mapCamera.minLon;
  const lonSpan = Math.min(currentLonSpan, 72);
  const latSpan = lonSpan / WORLD_ASPECT;
  setCameraBounds(
    geo.lon - lonSpan / 2,
    geo.lon + lonSpan / 2,
    geo.lat - latSpan / 2,
    geo.lat + latSpan / 2
  );
  refreshMapViewport();
}

function layoutMapOverlays(regionGroups) {
  const activePlaces = regionGroups.flatMap(group =>
    group.places.filter(place => !nonMapRegions.has(place.regionId) && hasCoords(place.geo)));
  const largest = Math.max(1, ...activePlaces.map(p => p.events.length));
  const projected = activePlaces.map(place => {
    const [nx, ny] = project(place.geo.lon, place.geo.lat);
    const size = 22 + 16 * Math.sqrt((place.events.length - 1) / Math.max(1, largest - 1));
    const anchorX = nx * BASE_W;
    const anchorY = ny * BASE_H;
    const inView = nx >= -0.03 && nx <= 1.03 && ny >= -0.03 && ny <= 1.03;
    return {
      ...place,
      size,
      radius:size / 2,
      anchorX,
      anchorY,
      inView,
      displayX:Math.min(BASE_W - 18, Math.max(18, anchorX)),
      displayY:Math.min(BASE_H - 18, Math.max(18, anchorY)),
    };
  });

  const nodes = projected.filter(node => node.inView);
  // Relax close in-view place markers so counts stay clickable while leader lines point back to true coordinates.
  for (let iter = 0; iter < 24; iter++) {
    if (iter < 16) {
      for (const node of nodes) {
        node.displayX += (node.anchorX - node.displayX) * 0.08;
        node.displayY += (node.anchorY - node.displayY) * 0.08;
      }
    }
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = b.displayX - a.displayX;
        let dy = b.displayY - a.displayY;
        let dist = Math.hypot(dx, dy);
        const minDist = a.radius + b.radius + 8;
        if (dist < minDist) {
          if (dist < 0.01) {
            const angle = (i * 2.39996) % (Math.PI * 2);
            dx = Math.cos(angle);
            dy = Math.sin(angle);
            dist = 1;
          }
          const push = (minDist - dist) * 0.5;
          const ux = dx / dist, uy = dy / dist;
          a.displayX -= ux * push; a.displayY -= uy * push;
          b.displayX += ux * push; b.displayY += uy * push;
        }
      }
    }
    for (const node of nodes) {
      node.displayX = Math.min(BASE_W - 18, Math.max(18, node.displayX));
      node.displayY = Math.min(BASE_H - 18, Math.max(18, node.displayY));
    }
  }

  const byRegion = new Map();
  for (const node of projected) {
    if (!byRegion.has(node.regionId)) byRegion.set(node.regionId, []);
    byRegion.get(node.regionId).push(node);
  }
  mapPlaces = nodes;
  mapCorridors = [...byRegion.entries()]
    .filter(([, list]) => list.length >= 2)
    .map(([regionId, list]) => ({regionId, points:list}));
}

function drawMap() {
  const width = canvas.clientWidth;
  if (!width) return;
  const ratio = devicePixelRatio || 1;
  const w = Math.round(width * ratio), h = Math.round(width * BASE_H / BASE_W * ratio);
  if (canvas.width !== w || canvas.height !== h) {canvas.width = w; canvas.height = h;}
  const ctx = canvas.getContext('2d');
  const scale = w / BASE_W;
  const style = getComputedStyle(canvas);
  const rootStyle = getComputedStyle(document.documentElement);
  const accent = rootStyle.getPropertyValue('--accent').trim() || '#5fd4c0';
  const gridColor = rootStyle.getPropertyValue('--grid-line').trim();
  const mutedColor = rootStyle.getPropertyValue('--muted').trim() || '#94acad';

  ctx.setTransform(1,0,0,1,0,0);
  ctx.clearRect(0,0,w,h);
  ctx.setTransform(scale,0,0,h / BASE_H,0,0);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0,0,BASE_W,BASE_H);
  ctx.clip();

  if (gridColor) {
    const lonSpan = mapCamera.maxLon - mapCamera.minLon;
    const step = lonSpan <= 45 ? 5 : lonSpan <= 120 ? 15 : 30;
    const firstLon = Math.ceil(mapCamera.minLon / step) * step;
    const firstLat = Math.ceil(mapCamera.minLat / step) * step;
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 0.5 * ratio / scale;
    ctx.beginPath();
    for (let lon = firstLon; lon <= mapCamera.maxLon; lon += step) {
      const [x] = project(lon, 0);
      ctx.moveTo(x * BASE_W, 0);
      ctx.lineTo(x * BASE_W, BASE_H);
    }
    for (let lat = firstLat; lat <= mapCamera.maxLat; lat += step) {
      const [, y] = project(0, lat);
      ctx.moveTo(0, y * BASE_H);
      ctx.lineTo(BASE_W, y * BASE_H);
    }
    ctx.stroke();
  }

  const path = buildLandPath();
  if (path) {
    ctx.fillStyle = style.color;
    ctx.strokeStyle = style.borderTopColor;
    ctx.lineWidth = 0.6 * ratio / scale;
    ctx.lineJoin = 'round';
    ctx.fill(path);
    ctx.stroke(path);
  }

  const activeRegion = regionControl.value || hoveredRegionId;
  // Intra-region West-to-East spatial corridor polylines.
  for (const corridor of mapCorridors) {
    const emphasized = activeRegion === corridor.regionId;
    ctx.save();
    ctx.strokeStyle = accent;
    ctx.globalAlpha = emphasized ? 0.78 : (activeRegion ? 0.16 : 0.36);
    ctx.lineWidth = emphasized ? 2 : 1.25;
    ctx.setLineDash(emphasized ? [6, 4] : [4, 4]);
    ctx.beginPath();
    corridor.points.forEach((pt, idx) => {
      ctx[idx ? 'lineTo' : 'moveTo'](pt.anchorX, pt.anchorY);
    });
    ctx.stroke();
    ctx.restore();
  }

  // Anchor leader lines, true coordinate dots, and focus rings.
  for (const place of mapPlaces) {
    const isFocused = place.id === selectedPlaceId || place.id === hoveredPlaceId;
    const dist = Math.hypot(place.displayX - place.anchorX, place.displayY - place.anchorY);
    if (dist > 3) {
      ctx.save();
      ctx.strokeStyle = isFocused ? accent : mutedColor;
      ctx.globalAlpha = isFocused ? 0.9 : 0.45;
      ctx.lineWidth = isFocused ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(place.anchorX, place.anchorY);
      ctx.lineTo(place.displayX, place.displayY);
      ctx.stroke();
      ctx.fillStyle = isFocused ? accent : mutedColor;
      ctx.beginPath();
      ctx.arc(place.anchorX, place.anchorY, isFocused ? 3.2 : 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    if (isFocused) {
      ctx.save();
      ctx.strokeStyle = accent;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(place.anchorX, place.anchorY, 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }
  ctx.restore();
}
new ResizeObserver(()=>drawMap()).observe(canvas);

// Start the basemap download alongside the first feed request.
fetch('/vendor/worldmonitor/countries.geojson')
  .then(response => {
    if (!response.ok) throw Error('Map unavailable');
    return response.json();
  })
  .then(geojson => {
    const rings = [];
    for (const {geometry, properties} of geojson.features) {
      if (properties['ISO3166-1-Alpha-2'] === 'AQ') continue;
      const featureRings = geometry?.type === 'Polygon' ? [geometry.coordinates[0]]
        : geometry?.type === 'MultiPolygon' ? geometry.coordinates.map(polygon => polygon[0]) : [];
      for (const ring of featureRings) if (ring?.length) rings.push(ring);
    }
    landRings = rings;
    landPath = null;
    landPathKey = '';
    mapState = 'ready';
    drawMap();
  })
  .catch(() => {mapState = 'unavailable';})
  .finally(renderMapNote);

let crossRegionEvents = 0;
let unmappedEvents = 0;
function renderMapNote() {
  el('map-note').textContent = [
    mapState === 'unavailable' ? '底图暂不可用，可用区域筛选查看事件。'
      : mapCamera.zoomed ? '滚轮/按钮缩放、拖拽平移，点击节点定位对应地点事件。'
        : '节点按真实经纬度标注，支持滚轮/+−缩放和区域聚焦，虚线按自西向东连线。',
    crossRegionEvents && `${crossRegionEvents} 个跨区经贸与市场事件（不落图）。`,
    unmappedEvents && `${unmappedEvents} 个事件地点待确认（未落图）。`,
  ].filter(Boolean).join(' ');
}

function syncGeoHighlight() {
  for (const marker of el('map-markers').children) {
    const placeId = marker.dataset.placeId;
    const region = marker.dataset.region;
    const active = placeId === selectedPlaceId;
    const highlight = placeId === hoveredPlaceId || (Boolean(hoveredRegionId) && region === hoveredRegionId);
    marker.dataset.active = String(active);
    marker.dataset.highlight = String(highlight);
    marker.dataset.showLabel = String(marker.dataset.alwaysLabel === 'true' || active || highlight);
    marker.setAttribute('aria-pressed', String(active));
  }
  for (const section of document.querySelectorAll('.place-group')) {
    const placeId = section.dataset.placeId;
    section.dataset.active = String(placeId === selectedPlaceId);
    section.dataset.highlight = String(placeId === hoveredPlaceId);
  }
  for (const step of document.querySelectorAll('.corridor-step')) {
    const placeId = step.dataset.placeId;
    const active = placeId === selectedPlaceId;
    step.dataset.active = String(active);
    step.dataset.highlight = String(placeId === hoveredPlaceId);
    step.setAttribute('aria-pressed', String(active));
  }
  for (const regionSection of document.querySelectorAll('.region-section')) {
    regionSection.dataset.highlight = String(Boolean(hoveredRegionId) && regionSection.dataset.region === hoveredRegionId);
  }
  for (const chip of mapRegions.children) {
    chip.dataset.highlight = String(Boolean(hoveredRegionId) && chip.dataset.region === hoveredRegionId);
  }
  drawMap();
}

function refreshMapViewport() {
  layoutMapOverlays(currentRegionGroups);
  renderMapMarkers();
  syncGeoHighlight();
}

function focusPlace(placeId, {scroll = true, open = true, zoom = false} = {}) {
  selectedPlaceId = selectedPlaceId === placeId ? null : placeId;
  if (selectedPlaceId) {
    const section = [...document.querySelectorAll('.place-group')].find(item => item.dataset.placeId === selectedPlaceId);
    if (section) {
      if (open) section._setOpen?.(true);
      if (scroll) section.scrollIntoView({behavior:'smooth', block:'nearest'});
    }
    if (zoom) {
      const targetPlace = currentRegionGroups.flatMap(g => g.places).find(p => p.id === selectedPlaceId);
      if (targetPlace) centerCameraOnPlace(targetPlace.geo);
    }
  }
  syncGeoHighlight();
}

function renderRegionControls(rows) {
  const counts = new Map();
  for (const {geo} of rows) counts.set(geo.region,(counts.get(geo.region) ?? 0) + 1);
  const selected = regionControl.value;
  regionControl.replaceChildren(new Option('全部区域',''));
  mapRegions.replaceChildren();
  const regionEntries = Object.entries(data?.regions ?? {unknown:{label:'地点待确认'}});
  const totalCount = rows.length;

  const allChip = add(mapRegions,'button','','map-region-chip');
  allChip.type = 'button';
  allChip.textContent = `全部 ${totalCount}`;
  allChip.dataset.region = '';
  allChip.setAttribute('aria-pressed', String(selected === ''));
  allChip.onclick = () => {
    regionControl.value = '';
    selectedPlaceId = null;
    render();
  };

  for (const [id,area] of regionEntries) {
    const count = counts.get(id);
    if (!count && selected !== id) continue;
    regionControl.add(new Option(`${area.label} · ${count ?? 0}`,id));
    const chip = add(mapRegions,'button',`${area.label} ${count ?? 0}`,'map-region-chip');
    chip.type = 'button';
    chip.dataset.region = id;
    chip.setAttribute('aria-pressed', String(selected === id));
    chip.onclick = () => {
      regionControl.value = selected === id ? '' : id;
      render();
    };
    chip.onmouseenter = () => {hoveredRegionId = id; syncGeoHighlight();};
    chip.onmouseleave = () => {if (hoveredRegionId === id) {hoveredRegionId = null; syncGeoHighlight();}};
  }
  regionControl.value = selected;
  crossRegionEvents = counts.get('crossRegion') ?? 0;
  unmappedEvents = counts.get('unknown') ?? 0;
}

function labelBox(place, placement) {
  const text = place.geo.label ?? '';
  let units = 0;
  for (const ch of text) units += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 1.85 : 1;
  const w = Math.max(36, Math.round(units * 9.5 + 16));
  const h = 22;
  const r = place.radius + 5;
  if (placement === 'top') return {x1:place.displayX - w / 2, y1:place.displayY - r - h, x2:place.displayX + w / 2, y2:place.displayY - r};
  if (placement === 'right') return {x1:place.displayX + r, y1:place.displayY - h / 2, x2:place.displayX + r + w, y2:place.displayY + h / 2};
  if (placement === 'left') return {x1:place.displayX - r - w, y1:place.displayY - h / 2, x2:place.displayX - r, y2:place.displayY + h / 2};
  return {x1:place.displayX - w / 2, y1:place.displayY + r, x2:place.displayX + w / 2, y2:place.displayY + r + h};
}

function boxesOverlap(a, b) {
  return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
}

function renderMapMarkers() {
  const markers = el('map-markers');
  const focused = document.activeElement?.dataset.placeId;
  markers.replaceChildren();
  const showAllLabels = mapCamera.zoomed || mapPlaces.length <= 10;
  const occupied = mapPlaces.map(p => ({
    x1:p.displayX - p.radius - 2, y1:p.displayY - p.radius - 2,
    x2:p.displayX + p.radius + 2, y2:p.displayY + p.radius + 2,
  }));
  const ordered = [...mapPlaces].sort((a, b) => b.events.length - a.events.length);
  const labelPlacement = new Map();
  for (const place of ordered) {
    const wantsLabel = showAllLabels || place.events.length >= 2 || place.id === selectedPlaceId;
    let chosen = 'bottom';
    let show = false;
    for (const dir of ['bottom', 'top', 'right', 'left']) {
      const box = labelBox(place, dir);
      if (box.x1 < 4 || box.x2 > BASE_W - 4 || box.y1 < 4 || box.y2 > BASE_H - 4) continue;
      if (!occupied.some(o => boxesOverlap(box, o))) {
        chosen = dir;
        if (wantsLabel) {
          occupied.push(box);
          show = true;
        }
        break;
      }
    }
    labelPlacement.set(place.id, {dir:chosen, show});
  }
  for (const place of mapPlaces) {
    const marker = add(markers,'button','','map-marker');
    marker.type = 'button';
    marker.style.left = `${(place.displayX / BASE_W) * 100}%`;
    marker.style.top = `${(place.displayY / BASE_H) * 100}%`;
    marker.style.setProperty('--size',`${place.size}px`);
    marker.dataset.placeId = place.id;
    marker.dataset.region = place.regionId;
    const {dir, show} = labelPlacement.get(place.id) ?? {dir:'bottom', show:false};
    marker.dataset.alwaysLabel = String(show);
    const coord = formatCoord(place.geo.lon, place.geo.lat);
    const regionLabel = data?.regions?.[place.regionId]?.label;
    marker.title = [regionLabel, place.geo.label, `${place.events.length} 个事件`, coord].filter(Boolean).join(' · ');
    marker.setAttribute('aria-label', marker.title);
    add(marker,'span',String(place.events.length),'map-marker-count');
    const lbl = add(marker,'span',place.geo.label,'map-marker-label');
    lbl.dataset.placement = dir;
    marker.onmouseenter = () => {hoveredPlaceId = place.id; hoveredRegionId = place.regionId; syncGeoHighlight();};
    marker.onmouseleave = () => {
      if (hoveredPlaceId === place.id) hoveredPlaceId = null;
      if (hoveredRegionId === place.regionId) hoveredRegionId = null;
      syncGeoHighlight();
    };
    marker.onfocus = () => {hoveredPlaceId = place.id; hoveredRegionId = place.regionId; syncGeoHighlight();};
    marker.onblur = () => {
      if (hoveredPlaceId === place.id) hoveredPlaceId = null;
      if (hoveredRegionId === place.regionId) hoveredRegionId = null;
      syncGeoHighlight();
    };
    marker.onclick = () => focusPlace(place.id, {scroll:true, open:true, zoom:false});
    if (focused === place.id) marker.focus({preventScroll:true});
  }
  mapZoomIn.disabled = (mapCamera.maxLon - mapCamera.minLon) <= MIN_LON_SPAN + 0.5;
  mapZoomOut.disabled = !mapCamera.zoomed;
  mapReset.hidden = !mapCamera.zoomed && !regionControl.value && !selectedPlaceId;
  riskMap.dataset.zoomed = String(mapCamera.zoomed);
  renderMapNote();
}

riskMap.addEventListener('wheel', event => {
  if (!data) return;
  event.preventDefault();
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const px = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  const py = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
  const factor = Math.min(1.35, Math.max(0.72, Math.exp(event.deltaY * 0.0018)));
  zoomCameraBy(factor, px, py);
}, {passive:false});

let dragState = null;
riskMap.addEventListener('pointerdown', event => {
  if (event.button !== 0 || !mapCamera.zoomed || event.target.closest('button')) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  dragState = {
    pointerId:event.pointerId,
    startX:event.clientX,
    startY:event.clientY,
    startCamera:{...mapCamera},
    rect,
  };
  riskMap.dataset.dragging = 'true';
  riskMap.setPointerCapture?.(event.pointerId);
});
riskMap.addEventListener('pointermove', event => {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  panCameraByPixels(event.clientX - dragState.startX, event.clientY - dragState.startY, dragState.startCamera, dragState.rect);
});
const stopDrag = event => {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  if (riskMap.hasPointerCapture?.(event.pointerId)) riskMap.releasePointerCapture(event.pointerId);
  dragState = null;
  delete riskMap.dataset.dragging;
};
riskMap.addEventListener('pointerup', stopDrag);
riskMap.addEventListener('pointercancel', stopDrag);

riskMap.addEventListener('dblclick', event => {
  if (!data || event.target.closest('button')) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const px = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  const py = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
  zoomCameraBy(0.6, px, py);
});

mapZoomIn.onclick = () => zoomCameraBy(0.65);
mapZoomOut.onclick = () => zoomCameraBy(1 / 0.65);
mapReset.onclick = () => {
  regionControl.value = '';
  selectedPlaceId = null;
  lastAutoFramedRegion = '';
  mapCamera = {...GLOBAL_CAMERA};
  render();
};

// ── Data ─────────────────────────────────────────────────────────────────
let data;
const cache = new Map();
const pending = new Map();
const errors = new Map();
const modeKey = 'external-event-mode';
const snapshotKey = 'external-event-live-v4';
const modeInputs = [...document.querySelectorAll('input[name="mode"]')];
const currentMode = () => modeInputs.find(input => input.checked)?.value ?? 'sample';
const savedMode = store.get('localStorage',modeKey);
for (const input of modeInputs) input.checked = input.value === (savedMode === 'live' ? 'live' : 'sample');
try {
  const saved = JSON.parse(store.get('sessionStorage',snapshotKey));
  if (saved?.mode === 'live' && Array.isArray(saved.events) && Array.isArray(saved.sources)) cache.set('live',saved);
} catch {}

function matchesTimeWindow(event) {
  const mode = timeWindowControl.value;
  if (!mode) return true;
  const rawTime = event.updatedAt ?? event.records?.at(-1)?.time?.value;
  const ts = Date.parse(rawTime ?? '');
  if (!Number.isFinite(ts)) return false;
  if (/^\d+h$/.test(mode)) {
    const hours = Number.parseInt(mode, 10);
    return ts >= Date.now() - hours * 3600_000;
  }
  if (mode === 'custom-hours') {
    const val = Number(customTimeValue.value);
    if (!Number.isFinite(val) || val <= 0) return true;
    const unitMs = customTimeUnit.value === 'days' ? 86_400_000 : 3600_000;
    return ts >= Date.now() - val * unitMs;
  }
  if (mode === 'custom-dates') {
    if (customDateFrom.value) {
      const fromMs = new Date(`${customDateFrom.value}T00:00:00`).getTime();
      if (Number.isFinite(fromMs) && ts < fromMs) return false;
    }
    if (customDateTo.value) {
      const toMs = new Date(`${customDateTo.value}T23:59:59.999`).getTime();
      if (Number.isFinite(toMs) && ts > toMs) return false;
    }
    return true;
  }
  return true;
}

function visible(applyRegion = true) {
  const query = el('search').value.trim().toLowerCase();
  return (data?.events ?? []).filter(event => {
    const meta = info(event);
    return (!applyRegion || !regionControl.value || meta.geo.region === regionControl.value) &&
      matchesTimeWindow(event) &&
      (!query || meta.search.includes(query));
  });
}

// ── Rendering ────────────────────────────────────────────────────────────
const openEvents = new Set();
const openPlaces = new Map();

function renderStats(list) {
  const stats = el('stats');
  stats.replaceChildren();
  const stat = (label, value, tone, title) => {
    const item = add(stats,'div','','stat');
    if (tone) item.dataset.tone = tone;
    if (title) item.title = title;
    add(item,'dt',label);
    add(item,'dd',String(value));
  };
  stat('事件',list.length);
  stat('关联线路',new Set(list.flatMap(event => [...info(event).lanes])).size);
  stat('入库记录',list.reduce((sum,event) => sum + info(event).reports,0), null, '当前筛选事件包含的新闻、观测信号与预测记录数');
  if (data.mode === 'live') {
    const feeds = data.sources.flatMap(source => source.feedStatus ?? []);
    if (feeds.length) {
      const healthy = feeds.filter(feed => !feed.error).length;
      stat('可用来源',`${healthy}/${feeds.length}`,healthy === feeds.length ? 'ok' : healthy ? 'warn' : 'bad');
    }
  }
}

function formatFeedWindow(windowValue) {
  if (!windowValue) return '';
  const dayMatch = /^(\d+)d$/i.exec(windowValue);
  if (dayMatch) return `近 ${dayMatch[1]} 天`;
  const hourMatch = /^(\d+)h$/i.exec(windowValue);
  if (hourMatch) return `近 ${hourMatch[1]} 小时`;
  return windowValue;
}

function renderStatus(loading, error) {
  const status = el('status');
  status.replaceChildren();
  const presentation = data?.mode === 'live' ? data.presentationStatus : null;
  const llmPending = data?.mode === 'live' ? (presentation?.pending ?? data.presentationPending ?? 0) : 0;
  const llmPaused = Boolean(presentation?.pausedUntil);
  const llmWorking = llmPending > 0 && !llmPaused;
  status.dataset.loading = String(Boolean(loading || llmWorking));
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
  const notes = [];
  if (data.mode === 'live' && data.sources.some(source => ['partial','stale','unavailable'].includes(source.state))) {
    notes.push({text:'部分来源异常',cls:'status-note'});
  }
  if (loading) notes.push({text:'更新中…',cls:'status-note'});
  if (error) notes.push({text:`更新失败，显示上次结果（${error}）`,cls:'status-error'});
  if (data.mode === 'live') {
    if (llmPaused) {
      const reason = presentation.error ? `（${presentation.error}）` : '';
      notes.push({text:`模型提取失败${reason}，待处理 ${llmPending} 项，稍后自动重试`,cls:'status-error'});
    } else if (llmPending > 0) {
      notes.push({text:`模型正在提取中文标题与进展（剩余 ${llmPending} 项）…`,cls:'status-note'});
    } else if (presentation?.enabled && presentation.failed > 0) {
      notes.push({
        text:`${presentation.failed} 项中文提取失败，已保留原文（查看详情）`,
        cls:'status-error status-link',
        onClick:openFailureDialog,
      });
    } else if (presentation && !presentation.enabled) {
      notes.push({text:'未配置模型，当前显示原文标题',cls:''});
    }
  }
  for (const note of notes) {
    if (note.onClick) {
      const btn = add(status,'button',note.text,note.cls);
      btn.type = 'button';
      btn.onclick = note.onClick;
    } else add(status,'span',note.text,note.cls);
  }

  const feedCount = data.sources.reduce((sum, source) => sum + (source.feedStatus?.length ?? 0), 0);
  const clusterHours = data.intake?.settings?.clusterWindowHours ?? 48;
  el('sources-label').textContent = data.mode === 'sample'
    ? '数据来源与采集规则 · 虚构样例'
    : data.liveSource === 'self-hosted'
      ? '数据来源与采集规则 · 自建 WorldMonitor'
      : `数据来源与采集规则 · ${feedCount} 个源 · 5–15 分钟刷新 · ${clusterHours} 小时事件归并`;

  const sourceStatus = el('source-status');
  sourceStatus.replaceChildren();
  const sourceLabel = data.mode === 'sample' ? '虚构样例'
    : data.liveSource === 'self-hosted' ? '自建 WorldMonitor' : '公开直连源（RSS + PortWatch + WMO + Polymarket）';
  const headingRow = add(sourceStatus,'li','','source-heading-row');
  add(headingRow,'span',sourceLabel,'source-heading');
  if (data.mode === 'live' && data.liveSource !== 'self-hosted') {
    const configBtn = add(headingRow,'button','调整采集与时间窗','source-config-btn');
    configBtn.type = 'button';
    configBtn.onclick = () => openIntakeDialog();
  }
  for (const source of data.sources) {
    add(sourceStatus,'li',`${labels[source.kind]} · ${source.recordCount ?? 0} 条输入记录 · ${states[source.state]}${source.error ? '（'+source.error+'）' : ''}`,'source-kind-row');
    if (source.ruleSummary) {
      add(sourceStatus,'li',source.ruleSummary,'source-rule meta');
    }
    for (const feed of source.feedStatus ?? []) {
      const row = add(sourceStatus,'li','','feed-row feed-item');
      row.dataset.state = feed.error ? (feed.count ? 'warn' : 'bad') : 'ok';
      const mainLine = add(row,'div','','feed-main');
      const titleGroup = add(mainLine,'span','','feed-title-group');
      if (feed.category) {
        add(titleGroup,'span',feedCategories[feed.category] ?? feed.category,'feed-badge feed-category');
      }
      if (/^https?:\/\//i.test(feed.url ?? '')) {
        const link = add(titleGroup,'a',feed.name);
        link.href = feed.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      } else add(titleGroup,'span',feed.name);
      if (feed.window) {
        add(titleGroup,'span',formatFeedWindow(feed.window),'feed-badge feed-window');
      }
      add(mainLine,'span',feed.error ? `${feed.count ? feed.count+' 条（上次结果）' : '失败'} · ${feed.error}` : `${feed.count} 条`,'meta feed-count');
      if (feed.scope) {
        add(row,'div',`范围：${feed.scope}`,'feed-scope meta');
      }
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
    const nodeTypes = {city:'城市',country:'国家或地区',port:'港口',airport:'机场',hub_airport:'中转机场',chokepoint:'交通咽喉',sea_area:'海域',airspace:'空域',rail_origin:'铁路始发',rail_border:'铁路口岸',corridor:'陆运走廊',hub:'陆运枢纽',border:'陆路口岸'};
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
    const nodeTable = dataTable(content,'节点',['节点 ID','口岸代码','名称','类型','国家或地区代码','别名']);
    for (const node of nodes) {
      const row = add(nodeTable,'tr');
      const id = add(row,'th');
      id.scope = 'row';
      add(id,'code',node.id);
      const codeCell = add(row,'td');
      if (node.code) add(codeCell,'code',node.code);
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

function buildRegionGroups(list, sortMode) {
  const byRegion = new Map();
  for (const row of list) {
    const regionId = row.geo.region || 'unknown';
    if (!byRegion.has(regionId)) byRegion.set(regionId, new Map());
    const byPlace = byRegion.get(regionId);
    if (!byPlace.has(row.geo.id)) byPlace.set(row.geo.id, []);
    byPlace.get(row.geo.id).push(row);
  }
  const regionOrder = Object.keys(data.regions ?? {});
  const orderIndex = id => {
    const idx = regionOrder.indexOf(id);
    return idx === -1 ? 999 : idx;
  };
  const compareRows = (a, b) => sortMode === 'routes'
    ? Number(a.event.action === 'reopening') - Number(b.event.action === 'reopening') ||
      b.lanes.size - a.lanes.size ||
      (b.event.updatedAt ?? '').localeCompare(a.event.updatedAt ?? '')
    : (b.event.updatedAt ?? '').localeCompare(a.event.updatedAt ?? '');

  const groups = [...byRegion.entries()].map(([regionId, byPlace]) => {
    const places = [...byPlace.values()].map(placeRows => {
      const events = [...placeRows].sort(compareRows);
      const geo = events[0].geo;
      const lanes = new Set(events.flatMap(row => [...row.lanes]));
      const latestUpdated = events.map(row => row.event.updatedAt).filter(Boolean).sort().at(-1) ?? '';
      return {id:geo.id, regionId, geo, events, lanes, latestUpdated};
    }).sort((a, b) => compareSpatial(a.geo, b.geo));
    const regionLanes = new Set(places.flatMap(place => [...place.lanes]));
    const latestUpdated = places.map(place => place.latestUpdated).filter(Boolean).sort().at(-1) ?? '';
    return {
      regionId,
      label:data.regions?.[regionId]?.label ?? regionId,
      places,
      eventCount:places.reduce((sum, place) => sum + place.events.length, 0),
      laneCount:regionLanes.size,
      latestUpdated,
    };
  });

  const tailRank = id => id === 'unknown' ? 2 : id === 'crossRegion' ? 1 : 0;
  return groups.sort((a, b) => {
    const tailDiff = tailRank(a.regionId) - tailRank(b.regionId);
    if (tailDiff) return tailDiff;
    if (sortMode === 'newest') return b.latestUpdated.localeCompare(a.latestUpdated);
    if (sortMode === 'routes') return b.laneCount - a.laneCount || b.latestUpdated.localeCompare(a.latestUpdated);
    return orderIndex(a.regionId) - orderIndex(b.regionId);
  });
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
  if (!data) {
    currentRegionGroups = [];
    mapPlaces = []; mapCorridors = [];
    lastAutoFramedRegion = '';
    updateMapCamera([], '');
    renderMapMarkers();
    drawMap();
    el('stats').replaceChildren();
    return;
  }
  const selectedRegion = regionControl.value;
  const sortMode = sortControl.value;
  const list = rows.filter(row => !selectedRegion || row.geo.region === selectedRegion);
  if (selectedPlaceId && !list.some(row => row.geo.id === selectedPlaceId)) selectedPlaceId = null;
  if (hoveredPlaceId && !list.some(row => row.geo.id === hoveredPlaceId)) hoveredPlaceId = null;

  el('export').disabled = !list.length;
  renderStats(list.map(row => row.event));
  const regionGroups = buildRegionGroups(list, sortMode);
  currentRegionGroups = regionGroups;
  if (selectedRegion !== lastAutoFramedRegion) {
    lastAutoFramedRegion = selectedRegion;
    updateMapCamera(regionGroups, selectedRegion);
  }
  layoutMapOverlays(regionGroups);
  renderMapMarkers();
  if (!list.length) {
    drawMap();
    add(items,'p','没有匹配的事件。','empty');
    return;
  }

  for (const regionGroup of regionGroups) {
    const {regionId, label, places, eventCount, laneCount} = regionGroup;
    const regionSection = add(items,'section','','region-section');
    regionSection.dataset.region = regionId;

    const header = add(regionSection,'header','','region-divider');
    header.onmouseenter = () => {hoveredRegionId = regionId; syncGeoHighlight();};
    header.onmouseleave = () => {if (hoveredRegionId === regionId) {hoveredRegionId = null; syncGeoHighlight();}};

    const titleRow = add(header,'div','','region-title-row');
    add(titleRow,'h3',label,'region-title');
    const regionStats = add(titleRow,'div','','region-stats');
    add(regionStats,'span',nonMapRegions.has(regionId) ? `${eventCount} 个事件` : `${places.length} 个地点 · ${eventCount} 个事件`);
    if (laneCount) add(regionStats,'span',`${laneCount} 条线路`,'accent');
    if (!nonMapRegions.has(regionId)) {
      const focusBtn = add(titleRow,'button',selectedRegion === regionId ? '已聚焦' : '聚焦区域','region-focus');
      focusBtn.type = 'button';
      focusBtn.setAttribute('aria-pressed', String(selectedRegion === regionId));
      focusBtn.onclick = () => {
        regionControl.value = selectedRegion === regionId ? '' : regionId;
        render();
      };

      const corridor = add(header,'nav','','region-corridor');
      corridor.setAttribute('aria-label', `${label}自西向东地点顺序`);
      add(corridor,'span','西 → 东：','corridor-axis');
      places.forEach((place, idx) => {
        if (idx > 0) add(corridor,'span','→','corridor-arrow').setAttribute('aria-hidden','true');
        const step = add(corridor,'button',place.geo.label,'corridor-step');
        step.type = 'button';
        step.dataset.placeId = place.id;
        step.dataset.region = regionId;
        step.title = [place.geo.label, `${place.events.length} 个事件`, formatCoord(place.geo.lon, place.geo.lat)].filter(Boolean).join(' · ');
        step.onmouseenter = () => {hoveredPlaceId = place.id; hoveredRegionId = regionId; syncGeoHighlight();};
        step.onmouseleave = () => {if (hoveredPlaceId === place.id) {hoveredPlaceId = null; syncGeoHighlight();}};
        step.onclick = () => focusPlace(place.id, {scroll:true, open:true, zoom:true});
      });
    }

    for (const place of places) {
      const {geo, events, lanes, latestUpdated} = place;
      const section = add(regionSection,'section','','place-group');
      section.dataset.placeId = geo.id;
      section.dataset.region = regionId;
      // Cards are one-line summaries, so groups start open; the unresolved bucket starts closed.
      const initiallyOpen = selectedRegion !== '' || geo.region !== 'unknown' || (regionGroups.length === 1 && places.length === 1);
      const isOpen = openPlaces.get(geo.id) ?? initiallyOpen;
      section.dataset.open = String(isOpen);

      const headerRow = add(section,'div','','place-overview');
      headerRow.onmouseenter = () => {hoveredPlaceId = geo.id; hoveredRegionId = regionId; syncGeoHighlight();};
      headerRow.onmouseleave = () => {
        if (hoveredPlaceId === geo.id) hoveredPlaceId = null;
        if (hoveredRegionId === regionId) hoveredRegionId = null;
        syncGeoHighlight();
      };

      const toggle = add(headerRow,'button','','place-toggle');
      toggle.type = 'button';
      toggle.setAttribute('aria-expanded', String(isOpen));
      const name = add(toggle,'span','','place-name');
      add(name,'strong',geo.label);
      if (geo.nodeId) add(name,'code',geo.nodeId,'meta');
      const coord = formatCoord(geo.lon, geo.lat);
      if (coord) add(name,'span',coord,'place-coord');

      const stats = add(toggle,'span','','place-stats');
      add(stats,'span',`${events.length} 个事件`);
      if (lanes.size) add(stats,'span',`${lanes.size} 条线路`,'accent');
      timeElement(stats,latestUpdated,shortTime,'');

      if (hasCoords(geo)) {
        const pin = add(headerRow,'button','定位','place-pin');
        pin.type = 'button';
        pin.title = '在地图上定位';
        pin.onclick = () => focusPlace(geo.id, {scroll:false, open:true, zoom:true});
      }

      const cards = add(section,'div','','place-events');
      cards.hidden = !isOpen;
      const setOpen = next => {
        const openState = Boolean(next);
        section.dataset.open = String(openState);
        toggle.setAttribute('aria-expanded', String(openState));
        cards.hidden = !openState;
        if (openState === initiallyOpen) openPlaces.delete(geo.id);
        else openPlaces.set(geo.id, openState);
      };
      section._setOpen = setOpen;
      toggle.onclick = () => setOpen(cards.hidden);
      for (const row of events) renderEvent(cards,row);
    }
  }
  syncGeoHighlight();
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
  card.dataset.eventId = event.id;
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
  const pwDrop = event.records?.find(r => r.id?.startsWith('signal:portwatch:') && r.evidence?.severity === 'HIGH');
  if (pwDrop) {
    const dropPct = pwDrop.evidence.baselineDeltaPct ?? pwDrop.evidence.wowChangePct;
    add(metadata,'span',Number.isFinite(dropPct) ? `通行量骤降 ${Math.abs(dropPct)}%` : '通行量骤降','event-alert');
  }
  if (event.action === 'reopening') add(metadata,'span','恢复/重开','event-action');
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
  add(timelineSection,'h3',entries.size !== event.records.length
    ? `动态时间线 · ${entries.size} 节点（${event.records.length} 条记录）`
    : `动态时间线 · ${entries.size}`);
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

const failureDialog = el('presentation-failures');
const failureList = el('presentation-failures-list');
const failureStatus = el('presentation-failures-status');
const retryFailuresButton = el('retry-presentation-failures');

function describeFailureReason(reason) {
  if (!reason) return '未记录具体原因（可能是早期重试耗尽，可点击下方重试）';
  if (reason.includes('not grounded')) return `原文引用校验未通过（防幻觉保护：模型给出的 titleQuote 未在首条报道中逐字出现 · ${reason}）`;
  if (reason.includes('finish_reason=length')) return `模型输出达到长度上限被截断，导致 JSON 不完整（${reason}）`;
  if (reason.includes('not JSON') || reason.includes('not a JSON object')) return `模型返回内容不是合法 JSON（${reason}）`;
  if (reason.includes('translation count mismatch')) return `模型返回的翻译条数与输入不匹配（${reason}）`;
  if (reason.includes('non-Chinese')) return `模型返回为空、非中文或超出长度限制（${reason}）`;
  return reason;
}

function locateEventCard(eventId) {
  const event = data?.events?.find(item => item.id === eventId);
  if (!event) return;
  failureDialog.close();
  const meta = info(event);
  let card = document.querySelector(`.event-card[data-event-id="${CSS.escape(eventId)}"]`);
  if (!card) {
    el('search').value = '';
    regionControl.value = '';
    timeWindowControl.value = '';
    el('custom-time-bar').hidden = true;
  }
  openPlaces.set(meta.geo.id, true);
  openEvents.add(eventId);
  render();
  card = document.querySelector(`.event-card[data-event-id="${CSS.escape(eventId)}"]`);
  if (card) card.scrollIntoView({behavior:'smooth', block:'center'});
}

function openFailureDialog() {
  const items = data?.presentationStatus?.failedItems ?? [];
  failureList.replaceChildren();
  failureStatus.textContent = '';
  retryFailuresButton.disabled = !items.length;
  if (!items.length) {
    add(failureList,'li','当前没有失败条目。','meta');
  } else {
    for (const item of items) {
      const li = add(failureList,'li','','failure-item');
      const head = add(li,'div','','failure-item-head');
      add(head,'span',item.kind === 'forecast' ? '预测市场' : '事件标题','failure-item-kind');
      if (item.kind === 'event' && item.id) {
        const locate = add(head,'button','定位到卡片','failure-locate-btn');
        locate.type = 'button';
        locate.onclick = () => locateEventCard(item.id);
      }
      add(li,'div',item.title || '（无标题）','failure-item-title');
      add(li,'div',`原因：${describeFailureReason(item.reason)}`,'failure-item-reason');
    }
  }
  if (!failureDialog.open) failureDialog.showModal();
}

el('close-presentation-failures').onclick = () => failureDialog.close();
retryFailuresButton.onclick = async () => {
  retryFailuresButton.disabled = true;
  failureStatus.textContent = '正在重新提交模型提取…';
  try {
    const response = await fetch('/api/presentation/retry', {method:'POST'});
    const body = await response.json().catch(() => null);
    if (!response.ok) throw Error(body?.error || '重试请求失败');
    failureDialog.close();
    presentationPolls = 0;
    lastPresentationPending = Infinity;
    await refresh();
  } catch (error) {
    failureStatus.textContent = error.message;
    retryFailuresButton.disabled = false;
  }
};

// ── Loading ──────────────────────────────────────────────────────────────
function rememberLive(result) {
  store.set('sessionStorage',snapshotKey,JSON.stringify(result));
}
// Event titles are written in the background; re-read while some are still pending.
let presentationPolls = 0;
let lastPresentationPending = Infinity;
let presentationTimer;
function followPresentation(result) {
  clearTimeout(presentationTimer);
  const pendingCount = result?.presentationPending ?? 0;
  if (!(pendingCount > 0)) {
    presentationPolls = 0;
    lastPresentationPending = Infinity;
    return;
  }
  if (pendingCount < lastPresentationPending) presentationPolls = 0;
  lastPresentationPending = pendingCount;
  if (presentationPolls >= 12) {presentationPolls = 0; return;}
  presentationPolls++;
  const pausedUntil = result?.presentationStatus?.pausedUntil ? Date.parse(result.presentationStatus.pausedUntil) : 0;
  const delay = pausedUntil > Date.now()
    ? Math.min(65_000, Math.max(5000, pausedUntil - Date.now() + 1500))
    : 5000;
  presentationTimer = setTimeout(() => {if (currentMode() === 'live') refresh();}, delay);
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
        if (result.intake) setIntakeSettings(result.intake);
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
  selectedPlaceId = null;
  hoveredPlaceId = null;
  hoveredRegionId = null;
  lastAutoFramedRegion = '';
  mapCamera = {...GLOBAL_CAMERA};
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
    : '尚未保存密钥。本机或内网 HTTP 模型服务可以不填。';
  modelActivate.disabled = !profile?.ready;
  modelActivate.textContent = profile && profile.id === modelSettings.activeId ? '停用此配置' : '启用此配置';
  modelSave.disabled = false;
}

async function readModelSettings() {
  const response = await fetch('/api/model-settings');
  const result = await response.json().catch(() => null);
  if (!response.ok) throw Error(result?.error ?? '无法读取模型配置，请关闭后重试。');
  setModelSettings(result);
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
  } catch (error) {
    modelStatus.textContent = error.message || '无法读取模型配置，请关闭后重试。';
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
const intakeDialog = el('intake-settings');
const intakeForm = el('intake-settings-form');
const intakeOpen = el('open-intake-settings');
const intakeClose = el('close-intake-settings');
const intakeReset = el('reset-intake-settings');
const intakeSave = el('save-intake-settings');
const intakeStatus = el('intake-settings-status');
const intakeFields = {
  googleNewsWindowDays: el('intake-google-news-days'),
  newsMaxAgeHours: el('intake-news-max-age'),
  clusterWindowHours: el('intake-cluster-hours'),
  portWatchWindowDays: el('intake-portwatch-days'),
  portWatchThresholdPct: el('intake-portwatch-pct'),
  marketHorizonDays: el('intake-market-horizon'),
  marketMinVolume: el('intake-market-volume'),
};
let intakeState;

function setIntakeSettings(descriptor) {
  if (!descriptor?.settings) return;
  intakeState = descriptor;
  intakeOpen.textContent = descriptor.isCustom ? '采集配置（已自定义）' : '采集配置';
  intakeOpen.title = descriptor.isCustom ? '当前使用自定义采集时间窗与阈值' : '查看或自定义采集时间窗与阈值';
}

function populateIntakeForm(settings) {
  for (const [key, input] of Object.entries(intakeFields)) {
    input.value = String(settings?.[key] ?? '');
  }
}

async function readIntakeSettings() {
  const response = await fetch('/api/intake-settings');
  const result = await response.json().catch(() => null);
  if (!response.ok) throw Error(result?.error ?? '无法读取采集配置，请关闭后重试。');
  setIntakeSettings(result);
  return result;
}
readIntakeSettings().catch(() => {});

async function openIntakeDialog() {
  intakeSave.disabled = true;
  intakeReset.disabled = true;
  intakeStatus.textContent = '正在读取配置…';
  intakeDialog.showModal();
  try {
    const result = await readIntakeSettings();
    populateIntakeForm(result.settings);
    intakeStatus.textContent = '';
    intakeSave.disabled = false;
    intakeReset.disabled = !result.isCustom;
  } catch (error) {
    intakeStatus.textContent = error.message || '无法读取采集配置，请关闭后重试。';
    intakeSave.disabled = false;
    intakeReset.disabled = false;
  }
}

intakeOpen.onclick = openIntakeDialog;
intakeClose.onclick = () => intakeDialog.close();

async function submitIntakeSettings(payload) {
  intakeSave.disabled = true;
  intakeReset.disabled = true;
  intakeStatus.textContent = '正在保存…';
  try {
    const response = await fetch('/api/intake-settings', {
      method: 'PUT',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(payload),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) throw Error(result?.error ?? '无法保存采集配置。');
    setIntakeSettings(result);
    populateIntakeForm(result.settings);
    intakeStatus.textContent = payload.action === 'reset' ? '已恢复默认采集配置。' : '采集配置已保存。';
    intakeSave.disabled = false;
    intakeReset.disabled = !result.isCustom;
    if (currentMode() === 'live') {
      await pending.get('live');
      if (currentMode() === 'live') refresh();
    }
  } catch (error) {
    intakeStatus.textContent = error.message;
    intakeSave.disabled = false;
    intakeReset.disabled = false;
  }
}

intakeReset.onclick = () => submitIntakeSettings({action: 'reset'});
intakeForm.onsubmit = event => {
  event.preventDefault();
  const settings = {};
  for (const [key, input] of Object.entries(intakeFields)) {
    settings[key] = Number(input.value);
  }
  submitIntakeSettings({action: 'save', settings});
};

function syncCustomTimeBar() {
  const mode = timeWindowControl.value;
  const isHours = mode === 'custom-hours';
  const isDates = mode === 'custom-dates';
  customTimeBar.hidden = !(isHours || isDates);
  customHoursGroup.hidden = !isHours;
  customDatesGroup.hidden = !isDates;
}

let searchTimer;
el('search').oninput = () => {clearTimeout(searchTimer); searchTimer = setTimeout(render,120);};
el('sort').onchange = render;
regionControl.onchange = render;
timeWindowControl.onchange = () => {syncCustomTimeBar(); render();};
customTimeValue.oninput = render;
customTimeUnit.onchange = render;
customDateFrom.onchange = render;
customDateTo.onchange = render;
el('export').onclick = () => {
  const blob = new Blob([JSON.stringify({schemaVersion:data.schemaVersion,mode:data.mode,fetchedAt:data.fetchedAt,network:data.network,events:visible()},null,2)],{type:'application/json'});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = 'external-intelligence.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(url),1000);
};
syncCustomTimeBar();
applyTheme(theme.value);
refresh();
