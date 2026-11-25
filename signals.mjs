const PORTWATCH_QUERY_URL = 'https://services9.arcgis.com/weJ1QsnbMYJlCHdG/arcgis/rest/services/Daily_Chokepoints_Data/FeatureServer/0/query';
const WMO_SWIC_URL = 'https://severeweather.wmo.int/json/wmo_all.json';
const CACHE_TTL_MS = 15 * 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Maps IMF PortWatch chokepoint names to supply-chain network nodes.
const CHOKEPOINTS = [
  { name: 'Suez Canal', nodeId: 'CP_SUEZ', label: '苏伊士运河', region: '中东' },
  { name: 'Malacca Strait', nodeId: 'CP_MALACCA', label: '马六甲海峡', region: '东南亚' },
  { name: 'Strait of Hormuz', nodeId: 'CP_HORMUZ', label: '霍尔木兹海峡', region: '中东' },
  { name: 'Bab el-Mandeb Strait', nodeId: 'CP_BAB', label: '曼德海峡', region: '红海' },
  { name: 'Panama Canal', nodeId: 'CP_PANAMA', label: '巴拿马运河', region: '拉美' },
  { name: 'Taiwan Strait', nodeId: 'CP_TAIWAN', label: '台湾海峡', region: '东亚' },
  { name: 'Cape of Good Hope', nodeId: 'CP_CAPE', label: '好望角（绕行）', region: '非洲' },
  { name: 'Gibraltar Strait', nodeId: 'CP_GIBRALTAR', label: '直布罗陀海峡', region: '西欧' },
  { name: 'Bosporus Strait', nodeId: 'CP_BOSPHORUS', label: '博斯普鲁斯海峡', region: '黑海' },
  { name: 'Korea Strait', nodeId: 'CP_KOREA', label: '朝鲜海峡/对马海峡', region: '东亚' },
  { name: 'Dover Strait', nodeId: 'CP_DOVER', label: '多佛尔海峡', region: '西欧' },
];

const formatDay = epochMs => new Date(epochMs).toISOString().slice(0, 10);
const toArcgisTimestamp = epochMs => `timestamp '${formatDay(epochMs)} 00:00:00'`;
const mean = values => values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
const pctDelta = (current, base) => (base && Number.isFinite(current)) ? Math.round(((current - base) / base) * 1000) / 10 : null;

function resolveActiveChokepoints(getNode) {
  if (typeof getNode !== 'function') return CHOKEPOINTS;
  const matched = CHOKEPOINTS.flatMap(cp => {
    const node = getNode(cp.nodeId);
    return node ? [{ ...cp, label: node.name_zh || cp.label }] : [];
  });
  return matched.length ? matched : CHOKEPOINTS;
}

export function buildPortWatchSignals(recentByNode, baselineByNode, { windowDays = 7, thresholdPct = 15, chokepoints = CHOKEPOINTS } = {}) {
  const signals = [];
  for (const cp of chokepoints) {
    const rows = (recentByNode.get(cp.nodeId) ?? []).sort((a, b) => b.date.localeCompare(a.date));
    if (rows.length < windowDays * 2) continue;
    const thisWindow = mean(rows.slice(0, windowDays).map(r => r.total));
    const prevWindow = mean(rows.slice(windowDays, windowDays * 2).map(r => r.total));
    const baseline = baselineByNode.get(cp.nodeId) ?? null;
    const wowPct = pctDelta(thisWindow, prevWindow);
    const basePct = pctDelta(thisWindow, baseline);
    if (Math.abs(basePct ?? 0) < thresholdPct && Math.abs(wowPct ?? 0) < thresholdPct) continue;

    const latestDate = rows[0].date;
    const baseHit = basePct != null && Math.abs(basePct) >= thresholdPct;
    const wowHit = wowPct != null && Math.abs(wowPct) >= thresholdPct;
    // Direction follows the year-on-year baseline when it qualifies (structural change), else week-on-week.
    const leadPct = baseHit ? basePct : wowPct;
    const direction = leadPct < 0 ? 'down' : 'up';
    const parts = [];
    if (baseHit) {
      parts.push(`近 ${windowDays} 日日均通行 ${Math.round(thisWindow)} 艘，较去年同期基线${basePct > 0 ? '上升' : '下降'} ${Math.abs(basePct)}%`);
    } else {
      parts.push(`近 ${windowDays} 日日均通行 ${Math.round(thisWindow)} 艘`);
    }
    if (wowHit) {
      const prevLabel = windowDays === 7 ? '上周' : `前 ${windowDays} 日`;
      parts.push(`环比${prevLabel}${wowPct > 0 ? '上升' : '下降'} ${Math.abs(wowPct)}%`);
    }
    // Falling traffic is the disruption signal; rising traffic (e.g. rerouted flows) is context only.
    const severity = direction === 'up' ? 'LOW'
      : (basePct ?? 0) <= -Math.max(35, thresholdPct * 2) || (wowPct ?? 0) <= -Math.max(30, thresholdPct * 2) ? 'HIGH' : 'MEDIUM';
    const verb = direction === 'up' ? '上升' : severity === 'HIGH' ? '骤降' : '下降';

    signals.push({
      id: `signal:portwatch:${cp.nodeId}:${latestDate}`,
      kind: 'signal',
      title: `${cp.label}船舶通行量${verb}：${parts.join('，')}`,
      summary: null,
      region: cp.region,
      geoAnchors: [cp.nodeId],
      category: 'SHIPPING_DISRUPTION',
      classification: null,
      time: { kind: 'detected', value: `${latestDate}T00:00:00.000Z` },
      source: {
        provider: 'IMF PortWatch',
        endpoint: null,
        upstreamId: `${cp.nodeId}:${latestDate}`,
        publisher: 'IMF PortWatch',
        url: 'https://portwatch.imf.org/',
      },
      evidence: { contributingTypes: ['船舶通行量'], wowChangePct: wowPct, baselineDeltaPct: basePct, direction, severity },
      forecast: null,
    });
  }
  return signals;
}

export function parsePortWatchCsv(text, nowMs = Date.now(), options = {}) {
  const windowDays = options.windowDays ?? 7;
  const chokepoints = options.chokepoints ?? CHOKEPOINTS;
  const byName = new Map(chokepoints.map(cp => [cp.name, cp]));
  const lines = text.replace(/^\uFEFF/, '').split('\n');
  const header = lines[0]?.trim().split(',');
  if (!header?.length) throw new Error('PortWatch CSV header missing');
  const col = Object.fromEntries(header.map((name, i) => [name, i]));
  for (const required of ['date', 'portname', 'n_total', 'n_container', 'n_tanker']) {
    if (!(required in col)) throw new Error(`PortWatch CSV missing column ${required}`);
  }

  const recentSince = formatDay(nowMs - Math.max(30, windowDays * 3) * DAY_MS);
  const baseFrom = formatDay(nowMs - 730 * DAY_MS);
  const baseTo = formatDay(nowMs - 365 * DAY_MS);
  const recentRows = new Map();
  const baselineTotals = new Map();

  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cells = line.split(',');
    const cp = byName.get(cells[col.portname]);
    if (!cp) continue;
    const date = cells[col.date]?.replaceAll('/', '-');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const total = Number(cells[col.n_total]);
    if (!Number.isFinite(total)) continue;

    if (date >= baseFrom && date < baseTo && cells[col.n_total] !== '') {
      if (!baselineTotals.has(cp.nodeId)) baselineTotals.set(cp.nodeId, []);
      baselineTotals.get(cp.nodeId).push(total);
    }
    if (date >= recentSince) {
      if (!recentRows.has(cp.nodeId)) recentRows.set(cp.nodeId, []);
      recentRows.get(cp.nodeId).push({
        date,
        total,
        container: Number(cells[col.n_container] || 0),
        tanker: Number(cells[col.n_tanker] || 0),
      });
    }
  }

  const baselineByNode = new Map([...baselineTotals.entries()].map(([id, vals]) => [id, mean(vals)]));
  return buildPortWatchSignals(recentRows, baselineByNode, options);
}

async function fetchPortWatchArcgis(fetchFn, nowMs = Date.now(), options = {}) {
  const windowDays = options.windowDays ?? 7;
  const chokepoints = options.chokepoints ?? CHOKEPOINTS;
  const byName = new Map(chokepoints.map(cp => [cp.name, cp]));
  const recentDays = Math.max(30, windowDays * 3);
  const namesList = chokepoints.map(cp => `'${cp.name.replace(/'/g, "''")}'`).join(',');
  const recentParams = new URLSearchParams({
    where: `portname IN (${namesList}) AND date >= ${toArcgisTimestamp(nowMs - recentDays * DAY_MS)}`,
    outFields: 'date,portname,n_total,n_container,n_tanker',
    orderByFields: 'date DESC',
    resultRecordCount: '1000',
    f: 'json',
  });
  const baseParams = new URLSearchParams({
    where: `portname IN (${namesList}) AND date >= ${toArcgisTimestamp(nowMs - 730 * DAY_MS)} AND date < ${toArcgisTimestamp(nowMs - 365 * DAY_MS)}`,
    groupByFieldsForStatistics: 'portname',
    outStatistics: JSON.stringify([{ statisticType: 'avg', onStatisticField: 'n_total', outStatisticFieldName: 'avg_total' }]),
    f: 'json',
  });

  const [recentRes, baseRes] = await Promise.all([
    fetchFn(`${PORTWATCH_QUERY_URL}?${recentParams}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12_000) }),
    fetchFn(`${PORTWATCH_QUERY_URL}?${baseParams}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12_000) }),
  ]);
  if (!recentRes.ok) throw new Error(`PortWatch HTTP ${recentRes.status}`);
  const recentJson = await recentRes.json();
  if (recentJson.error) throw new Error(recentJson.error.message || 'PortWatch query error');

  const recentByNode = new Map();
  for (const feat of recentJson.features ?? []) {
    const a = feat.attributes ?? {};
    const cp = byName.get(a.portname);
    if (!cp || !Number.isFinite(a.n_total) || !a.date) continue;
    const date = typeof a.date === 'number' ? formatDay(a.date) : String(a.date).replaceAll('/', '-').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (!recentByNode.has(cp.nodeId)) recentByNode.set(cp.nodeId, []);
    recentByNode.get(cp.nodeId).push({ date, total: Number(a.n_total) });
  }

  const baselineByNode = new Map();
  if (baseRes.ok) {
    const baseJson = await baseRes.json().catch(() => null);
    for (const feat of baseJson?.features ?? []) {
      const a = feat.attributes ?? {};
      const cp = byName.get(a.portname);
      if (cp && Number.isFinite(a.avg_total)) baselineByNode.set(cp.nodeId, Number(a.avg_total));
    }
  }
  return buildPortWatchSignals(recentByNode, baselineByNode, options);
}

function parseWmoDate(value) {
  if (!value || typeof value !== 'string') return null;
  const iso = value.trim().replace(' ', 'T') + (value.includes('Z') ? '' : 'Z');
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

const WMO_URGENCY = { 4: '立即', 3: '预期', 2: '未来', 1: '已过去' };
const WMO_CERTAINTY = { 4: '已观测', 3: '很可能', 2: '可能', 1: '不太可能' };
const WMO_HAZARD_RULES = [
  [/flash\s*flood/i, '山洪'],
  [/coastal\s*flood/i, '沿海洪水'],
  [/flood/i, '洪水'],
  [/wind\s+and\s+waves/i, '大风巨浪'],
  [/heavy\s+freezing\s+spray/i, '强冰冻浪花'],
  [/winter\s+storm/i, '冬季风暴'],
  [/blizzard/i, '暴风雪'],
  [/high\s+wind|strong\s+gale|violent\s+storm\s+gusts|severe\s+wind/i, '强风'],
  [/storm/i, '风暴'],
  [/freezing\s+rain|icing/i, '冻雨结冰'],
  [/freeze/i, '霜冻'],
  [/snowfall|snow/i, '强降雪'],
  [/dense\s+fog|fog/i, '大雾'],
  [/heavy.*rain|orange\s+rain|aviso\s+de\s+lluvias|rain/i, '强降雨'],
  [/thunderstorm|tormenta/i, '雷暴'],
  [/landslide/i, '山体滑坡'],
  [/forest\s*fire|fire\s+weather|red\s+flag/i, '森林火险'],
  [/extreme\s+heat|canicule/i, '极端高温'],
  [/avalanch/i, '雪崩'],
  [/coastal|costeros/i, '沿海灾害'],
  [/special\s+marine/i, '海上危险天气'],
  [/severe\s+weather/i, '恶劣天气'],
  [/wind/i, '大风'],
];

const isGenericWmoHeadline = value => !value || /^(cap\s*alert|aviso\s*cap|alert|warning)$/i.test(value.trim());

function formatWmoHazard(event, headline) {
  const raw = (event && !/^(awareness_type=|other\s+dangers$)/i.test(event.trim()))
    ? event.trim()
    : (!isGenericWmoHeadline(headline) ? headline.trim() : '');
  for (const [pattern, label] of WMO_HAZARD_RULES) {
    if (pattern.test(raw)) return label;
  }
  return raw || '恶劣天气';
}

/** Split a WMO areaDesc like "Antioquia (Bello, Medellín), Arauca (Tame)" into top-level entries. */
export function splitAreaList(areaDesc) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of areaDesc ?? '') {
    if (ch === '(' || ch === '（') depth++;
    if ((ch === ')' || ch === '）') && depth > 0) depth--;
    if ((ch === ',' || ch === ';') && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** Truncate an area list on whole entries so parentheses stay balanced. */
function truncateAreaList(areaDesc, maxLength) {
  if (!areaDesc || areaDesc.length <= maxLength) return areaDesc;
  const parts = splitAreaList(areaDesc);
  const kept = [];
  for (const part of parts) {
    const next = [...kept, part].join(', ');
    if (next.length > maxLength && kept.length) break;
    kept.push(part.length > maxLength ? part.replace(/\s*[（(].*$/, '') : part);
  }
  return kept.length < parts.length ? `${kept.join(', ')} 等 ${parts.length} 个地区` : kept.join(', ');
}

function buildWmoSummary(item, expiresIso) {
  const parts = [];
  if (item.event) parts.push(`类型：${item.event}`);
  if (!isGenericWmoHeadline(item.headline) && item.headline !== item.event) {
    parts.push(`说明：${item.headline}`);
  }
  if (WMO_URGENCY[item.u]) parts.push(`紧迫度：${WMO_URGENCY[item.u]}`);
  if (WMO_CERTAINTY[item.c]) parts.push(`确定性：${WMO_CERTAINTY[item.c]}`);
  if (item.areaDesc) parts.push(`影响区域：${truncateAreaList(item.areaDesc, 180)}`);
  if (expiresIso) parts.push(`有效至 ${expiresIso.slice(0, 16).replace('T', ' ')} UTC`);
  return parts.join('｜') || null;
}

function extractWmoCountry(item) {
  if (typeof item?.country === 'string' && /^[a-z]{2}$/i.test(item.country.trim())) {
    return item.country.trim().toUpperCase();
  }
  const rel = item?.url || item?.capURL || '';
  const match = String(rel).match(/^\/?([a-z]{2})-/i);
  return match ? match[1].toUpperCase() : null;
}

export function parseWmoAlerts(payload, findPlaces, nowMs = Date.now(), { getNode } = {}) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  const seen = new Set();
  const signals = [];

  for (const item of items) {
    if ((item.s ?? 0) < 3) continue; // Only Severe (3) or Extreme (4)
    const expiresIso = parseWmoDate(item.expires);
    if (expiresIso && Date.parse(expiresIso) <= nowMs) continue;

    const text = [item.event, item.headline, item.areaDesc].filter(Boolean).join(' · ');
    let places = findPlaces({ title: text, summary: item.areaDesc });
    const alertCountry = extractWmoCountry(item);
    if (alertCountry && typeof getNode === 'function') {
      places = places.filter(nodeId => {
        const node = getNode(nodeId);
        if (!node) return true;
        if (node.country) return node.country.toUpperCase() === alertCountry;
        return node.type !== 'sea_area';
      });
    }
    if (!places.length) continue;

    const primaryNode = places[0];
    const dedupKey = `${primaryNode}:${item.event ?? ''}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const sentIso = parseWmoDate(item.sent ?? item.effective) ?? new Date(nowMs).toISOString();
    const severity = item.s >= 4 ? 'HIGH' : 'MEDIUM';
    const levelLabel = item.s >= 4 ? '极端' : '严重';
    const hazardLabel = formatWmoHazard(item.event, item.headline);
    // Lead with the network node the alert touches; a long provincial list otherwise hides why it is on the radar.
    const nodeLabels = places.slice(0, 2).map(id => (typeof getNode === 'function' && getNode(id)?.name_zh) || null).filter(Boolean);
    const areaCount = splitAreaList(item.areaDesc).length;
    const areaLabel = nodeLabels.length
      ? `${nodeLabels.join('、')}所在地区${areaCount > 1 ? `，共 ${areaCount} 个地区` : ''}`
      : truncateAreaList(item.areaDesc || primaryNode, 50);
    const relUrl = item.url || item.capURL;
    signals.push({
      id: `signal:wmo:${item.id || dedupKey}`,
      kind: 'signal',
      title: `${levelLabel}气象预警：${hazardLabel}（${areaLabel}）`,
      summary: buildWmoSummary(item, expiresIso),
      region: null,
      geoAnchors: places.slice(0, 3),
      category: 'WEATHER_EXTREME',
      classification: null,
      time: { kind: 'detected', value: sentIso },
      source: {
        provider: 'WMO SWIC',
        endpoint: null,
        upstreamId: item.id || dedupKey,
        publisher: 'WMO 气象预警',
        url: relUrl ? `https://severeweather.wmo.int/${relUrl.replace(/^\//, '')}` : 'https://severeweather.wmo.int/',
      },
      evidence: { contributingTypes: ['官方天气预警'], severity },
      forecast: null,
    });
    if (signals.length >= 15) break;
  }
  return signals;
}

export function createSignalReader({ findPlaces = () => [], getNode = null, fetchFn = globalThis.fetch, getSettings = () => ({}) } = {}) {
  const cache = new Map();
  let lastCheckedAt = 0;
  let lastSettingsKey = '';
  let lastResult = null;
  let inFlight = null;

  function buildSources(windowDays, thresholdPct) {
    const activeChokepoints = resolveActiveChokepoints(getNode);
    return [
      {
        name: 'IMF PortWatch 航运通行量',
        url: 'https://portwatch.imf.org/',
        category: 'chokepoint',
        window: `近 ${windowDays} 日均值 vs 上期 / 去年同期 (≥${thresholdPct}%)`,
        scope: `${activeChokepoints.length} 个关键海峡/运河（${activeChokepoints.slice(0, 4).map(c => c.label).join('、')}等）`,
        load: () => fetchPortWatchArcgis(fetchFn, Date.now(), { windowDays, thresholdPct, chokepoints: activeChokepoints }),
      },
      {
        name: 'WMO 极端天气预警',
        url: 'https://severeweather.wmo.int/',
        category: 'weather',
        window: '实时未过期预警',
        scope: '严重级别 ≥3（严重/极端）且匹配网络节点或地理枢纽（最多 15 条）',
        load: async () => {
          const res = await fetchFn(WMO_SWIC_URL, {
            headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
            signal: AbortSignal.timeout(15_000),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return parseWmoAlerts(await res.json(), findPlaces, Date.now(), { getNode });
        },
      },
    ];
  }

  async function fetchSignals(windowDays, thresholdPct, settingsKey) {
    const sources = buildSources(windowDays, thresholdPct);
    const results = await Promise.all(sources.map(async src => {
      try {
        const records = await src.load();
        cache.set(src.name, records);
        return { name: src.name, url: src.url, category: src.category, window: src.window, scope: src.scope, count: records.length, error: null, records };
      } catch (error) {
        const prior = cache.get(src.name) ?? [];
        return { name: src.name, url: src.url, category: src.category, window: src.window, scope: src.scope, count: prior.length, error: error.message || 'fetch failed', records: prior };
      }
    }));

    const records = results.flatMap(r => r.records);
    const feedStatus = results.map(({ name, url, category, window, scope, count, error }) => ({ name, url, category, window, scope, count, error }));
    const errors = feedStatus.filter(f => f.error);
    const failedAll = errors.length === feedStatus.length;
    const state = failedAll && !records.length ? 'unavailable'
      : errors.length ? 'partial'
      : records.length ? 'ok' : 'empty';

    const result = {
      kind: 'signal',
      records,
      feedStatus,
      state,
      error: errors.length ? errors.map(f => f.name).join('、') + ' 获取失败' : null,
    };
    if (!failedAll) {
      lastCheckedAt = Date.now();
      lastSettingsKey = settingsKey;
      lastResult = result;
    }
    return result;
  }

  return async function readLiveSignals() {
    const { portWatchWindowDays = 7, portWatchThresholdPct = 15 } = getSettings() ?? {};
    const settingsKey = `${portWatchWindowDays}:${portWatchThresholdPct}`;
    if (lastResult && lastSettingsKey === settingsKey && Date.now() - lastCheckedAt < CACHE_TTL_MS) return lastResult;
    if (!inFlight) {
      inFlight = fetchSignals(portWatchWindowDays, portWatchThresholdPct, settingsKey).finally(() => { inFlight = null; });
    }
    return inFlight;
  };
}
