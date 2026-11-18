const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const POLYMARKET_TAGS = ['geopolitics', 'tariffs', 'trade', 'middle-east', 'china', 'ukraine'];
const CACHE_TTL_MS = 10 * 60_000;

const EXCLUDE_PATTERN = /\b(nba|nfl|mlb|nhl|fifa|world cup|super bowl|championship|playoffs|oscar|grammy|emmy|box office|movie|album|song|streamer|influencer|celebrity|kardashian|bachelor|reality tv|mvp|touchdown|home run|goal scorer)\b/i;

const SUPPLY_CHAIN_PATTERN = /\b(tariff|tariffs|trade|sanction|sanctions|embargo|export|import|shipping|ship|vessel|canal|suez|panama|hormuz|red sea|bab|strait|port|maritime|oil|crude|opec|gas|lng|energy|semiconductor|chip|chips|rare earth|blockade|ceasefire|strike|war|invasion|taiwan|iran|russia|ukraine|china|houthi|recession|supply)\b/i;

function parseYesPrice(market) {
  try {
    const prices = typeof market.outcomePrices === 'string'
      ? JSON.parse(market.outcomePrices)
      : market.outcomePrices;
    if (!Array.isArray(prices) || prices.length < 2) return null;
    const yes = Number(prices[0]);
    return Number.isFinite(yes) && yes >= 0 && yes <= 1 ? yes : null;
  } catch {
    return null;
  }
}

function formatHorizon(endDate) {
  if (!endDate) return null;
  const ms = Date.parse(endDate);
  if (!Number.isFinite(ms)) return null;
  const days = Math.ceil((ms - Date.now()) / 86_400_000);
  if (days <= 0) return null;
  if (days <= 14) return `${days} 天内`;
  if (days <= 90) return `${Math.round(days / 7)} 周内`;
  return endDate.slice(0, 10) + ' 前';
}

export function normalizePolymarketEvents(
  events,
  findPlaces = () => [],
  nowMs = Date.now(),
  { minVolume = 25_000, horizonDays = 0 } = {},
) {
  const seen = new Set();
  const candidates = [];
  const maxEndMs = horizonDays > 0 ? nowMs + horizonDays * 86_400_000 : null;

  for (const ev of events) {
    if (!ev?.title || EXCLUDE_PATTERN.test(ev.title)) continue;
    const markets = Array.isArray(ev.markets) ? ev.markets : [];
    const active = markets
      .map(m => ({ market: m, yesPrice: parseYesPrice(m) }))
      .filter(({ market, yesPrice }) =>
        yesPrice !== null && yesPrice >= 0.02 && yesPrice <= 0.98 &&
        !EXCLUDE_PATTERN.test(market.question || '')
      );
    if (!active.length) continue;

    // Pick the highest-volume or closest-to-50% active sub-market in the event.
    active.sort((a, b) => (Number(b.market.volumeNum ?? b.market.volume ?? 0) - Number(a.market.volumeNum ?? a.market.volume ?? 0)));
    const { market, yesPrice } = active[0];
    const title = market.question || ev.title;
    const volume = Number(ev.volume ?? market.volumeNum ?? market.volume ?? 0);
    if (volume < minVolume) continue;

    const endDate = market.endDate || ev.endDate;
    if (maxEndMs !== null) {
      const endMs = endDate ? Date.parse(endDate) : NaN;
      if (!Number.isFinite(endMs) || endMs <= nowMs || endMs > maxEndMs) continue;
    }

    const geoAnchors = findPlaces({ title, summary: ev.description });
    if (!SUPPLY_CHAIN_PATTERN.test(title) && !geoAnchors.length) continue;

    const key = title.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);

    const delta = Number(market.oneDayPriceChange);
    const hasDelta = Number.isFinite(delta) && Math.abs(delta) >= 0.001;
    const priorProbability = hasDelta ? Math.max(0, Math.min(1, Math.round((yesPrice - delta) * 1000) / 1000)) : null;
    const direction = !hasDelta ? 'stable' : delta > 0.01 ? 'rising' : delta < -0.01 ? 'falling' : 'stable';
    const horizon = formatHorizon(endDate);
    const updatedAt = market.updatedAt || ev.updatedAt || new Date(nowMs).toISOString();
    const url = ev.slug ? `https://polymarket.com/event/${ev.slug}` : 'https://polymarket.com/';
    const volLabel = volume >= 1_000_000 ? `$${(volume / 1_000_000).toFixed(1)}M` : `$${Math.round(volume / 1000)}K`;

    candidates.push({
      volume,
      record: {
        id: `forecast:polymarket:${market.id || ev.id || key}`,
        kind: 'forecast',
        title,
        summary: `预测市场盘口（成交量 ${volLabel}）`,
        region: null,
        ...(geoAnchors.length && { geoAnchors: geoAnchors.slice(0, 3) }),
        category: 'prediction_market',
        classification: null,
        time: { kind: 'updated', value: new Date(Date.parse(updatedAt) || nowMs).toISOString() },
        source: {
          provider: 'Polymarket',
          endpoint: null,
          upstreamId: String(market.id || ev.id || key),
          publisher: 'Polymarket',
          url,
        },
        evidence: { supporting: [], counter: [], triggers: [] },
        forecast: {
          probability: Math.round(yesPrice * 1000) / 1000,
          priorProbability,
          confidence: null,
          horizon,
          direction,
          change: hasDelta ? `24 小时隐含概率${delta > 0 ? '上升' : '下降'} ${Math.abs(Math.round(delta * 1000) / 10)} 个百分点` : null,
          resolution: null,
        },
      },
    });
  }

  candidates.sort((a, b) => b.volume - a.volume);
  return candidates.slice(0, 20).map(c => c.record);
}

export function createMarketReader({ findPlaces = () => [], fetchFn = globalThis.fetch, getSettings = () => ({}) } = {}) {
  let lastCheckedAt = 0;
  let lastSettingsKey = '';
  let lastResult = null;
  let lastGoodRecords = [];
  let inFlight = null;

  async function fetchMarkets(minVolume, horizonDays, settingsKey) {
    const nowIso = new Date().toISOString();
    const settled = await Promise.allSettled(POLYMARKET_TAGS.map(async tag => {
      const params = new URLSearchParams({
        tag_slug: tag,
        closed: 'false',
        active: 'true',
        archived: 'false',
        end_date_min: nowIso,
        order: 'volume',
        ascending: 'false',
        limit: '40',
      });
      const res = await fetchFn(`${GAMMA_BASE}/events?${params}`, {
        headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error('Invalid Polymarket payload');
      return data;
    }));

    const events = [];
    let failures = 0;
    let firstError = null;
    for (const item of settled) {
      if (item.status === 'fulfilled') events.push(...item.value);
      else {
        failures += 1;
        firstError ??= item.reason?.message || 'fetch failed';
      }
    }

    const failedAll = failures === POLYMARKET_TAGS.length;
    const records = failedAll ? lastGoodRecords : normalizePolymarketEvents(events, findPlaces, Date.now(), { minVolume, horizonDays });
    if (!failedAll) lastGoodRecords = records;

    const minVolLabel = minVolume >= 1_000_000 ? `$${(minVolume / 1_000_000).toFixed(1)}M` : `$${Math.round(minVolume / 1000)}K`;
    const feedStatus = [{
      name: 'Polymarket 预测市场',
      url: 'https://polymarket.com/',
      category: 'market',
      window: horizonDays > 0 ? `未来 ${horizonDays} 天内到期` : '全部未到期盘口',
      scope: `标签: ${POLYMARKET_TAGS.join(', ')} · 成交量 ≥${minVolLabel}（取前 20 条）`,
      count: records.length,
      error: failedAll ? firstError : null,
    }];
    const state = failedAll && !records.length ? 'unavailable'
      : failedAll ? 'stale'
      : records.length ? 'ok' : 'empty';

    const result = {
      kind: 'forecast',
      records,
      feedStatus,
      state,
      error: failedAll ? `Polymarket 获取失败（${firstError}）` : null,
    };
    if (!failedAll) {
      lastCheckedAt = Date.now();
      lastSettingsKey = settingsKey;
      lastResult = result;
    }
    return result;
  }

  return async function readLiveMarkets() {
    const { marketMinVolume = 25_000, marketHorizonDays = 0 } = getSettings() ?? {};
    const settingsKey = `${marketMinVolume}:${marketHorizonDays}`;
    if (lastResult && lastSettingsKey === settingsKey && Date.now() - lastCheckedAt < CACHE_TTL_MS) return lastResult;
    if (!inFlight) {
      inFlight = fetchMarkets(marketMinVolume, marketHorizonDays, settingsKey).finally(() => { inFlight = null; });
    }
    return inFlight;
  };
}
