import test from 'node:test';
import assert from 'node:assert/strict';
import { createSignalReader, parsePortWatchCsv, parseWmoAlerts } from './signals.mjs';
import { createMarketReader, normalizePolymarketEvents } from './markets.mjs';
import { buildEvents } from './events.mjs';

test('parsePortWatchCsv detects chokepoint deviation against baseline', () => {
  const now = Date.parse('2026-11-18T00:00:00Z');
  const rows = ['date,portname,n_total,n_container,n_tanker'];
  // 20 baseline days a year ago: 60 ships/day
  for (let i = 0; i < 20; i++) {
    const d = new Date(now - (400 + i) * 86_400_000).toISOString().slice(0, 10);
    rows.push(`${d},Suez Canal,60,30,15`);
  }
  // 14 recent days: 30 ships/day (-50% vs baseline)
  for (let i = 0; i < 14; i++) {
    const d = new Date(now - (i + 1) * 86_400_000).toISOString().slice(0, 10);
    rows.push(`${d},Suez Canal,30,15,8`);
  }
  const signals = parsePortWatchCsv(rows.join('\n'), now);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].kind, 'signal');
  assert.deepEqual(signals[0].geoAnchors, ['CP_SUEZ']);
  assert.equal(signals[0].evidence.baselineDeltaPct, -50);
});

test('parseWmoAlerts filters severe unexpired alerts matching network nodes', () => {
  const now = Date.parse('2026-11-18T00:00:00Z');
  const findPlaces = r => r.title.includes('Rotterdam') ? ['PORT_ROTTERDAM'] : [];
  const signals = parseWmoAlerts({
    items: [
      { id: '1', event: 'Wind', headline: 'Minor wind in Rotterdam', s: 1, sent: '2026-11-17 12:00:00', expires: '2026-11-19 12:00:00' },
      {
        id: '2',
        event: 'Flash flood probability watch',
        headline: 'CAP Alert',
        areaDesc: 'Rotterdam port area',
        s: 4,
        u: 2,
        c: 3,
        capURL: 'nl-knmi/2026/11/17/alert.xml',
        sent: '2026-11-17 12:00:00',
        expires: '2026-11-19 12:00:00',
      },
      { id: '3', event: 'Flood', headline: 'Severe flood in Nowhere', areaDesc: 'Nowhere', s: 3, sent: '2026-11-17 12:00:00', expires: '2026-11-19 12:00:00' },
    ],
  }, findPlaces, now);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].geoAnchors[0], 'PORT_ROTTERDAM');
  assert.equal(signals[0].evidence.severity, 'HIGH');
  assert.match(signals[0].title, /^极端气象预警：山洪（Rotterdam port area）$/);
  assert.match(signals[0].summary, /Flash flood probability watch/);
  assert.match(signals[0].summary, /紧迫度：未来/);
  assert.match(signals[0].summary, /确定性：很可能/);
  assert.equal(signals[0].source.url, 'https://severeweather.wmo.int/nl-knmi/2026/11/17/alert.xml');
});

test('normalizePolymarketEvents extracts relevant supply-chain probabilities', () => {
  const now = Date.parse('2026-11-18T00:00:00Z');
  const records = normalizePolymarketEvents([
    {
      id: 'evt-sports',
      title: 'NBA Championship winner?',
      volume: 500000,
      markets: [{ id: 'm1', question: 'NBA Championship winner?', outcomePrices: '["0.4","0.6"]' }],
    },
    {
      id: 'evt-tariff',
      title: 'US tariffs on China above 60% in 2026?',
      slug: 'us-tariffs-china-2026',
      volume: 250000,
      endDate: '2026-12-31T00:00:00Z',
      markets: [{
        id: 'm2',
        question: 'US tariffs on China above 60% in 2026?',
        outcomePrices: '["0.62","0.38"]',
        oneDayPriceChange: 0.05,
        volumeNum: 250000,
      }],
    },
  ], () => [], now);
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, 'forecast');
  assert.equal(records[0].forecast.probability, 0.62);
  assert.equal(records[0].forecast.priorProbability, 0.57);
  assert.equal(records[0].forecast.direction, 'rising');
});

test('buildEvents attaches matching live signals and forecasts to news events', () => {
  const findPlaces = r => r.geoAnchors ?? (r.title.includes('Suez') ? ['CP_SUEZ'] : []);
  const events = buildEvents([
    {
      kind: 'news',
      records: [{
        id: 'rss:https://news.example/suez',
        kind: 'news',
        title: 'Shipping delays hit Suez Canal after vessel grounding',
        time: { kind: 'published', value: '2026-11-18T01:00:00.000Z' },
        source: { publisher: 'Example' },
      }],
    },
    {
      kind: 'signal',
      records: [{
        id: 'signal:portwatch:CP_SUEZ:2026-11-18',
        kind: 'signal',
        title: '苏伊士运河船舶通行量异动',
        geoAnchors: ['CP_SUEZ'],
        time: { kind: 'detected', value: '2026-11-18T00:00:00.000Z' },
        source: { provider: 'IMF PortWatch' },
      }],
    },
    {
      kind: 'forecast',
      records: [{
        id: 'forecast:polymarket:suez',
        kind: 'forecast',
        title: 'Suez Canal traffic down 30% this month?',
        geoAnchors: ['CP_SUEZ'],
        time: { kind: 'updated', value: '2026-11-18T02:00:00.000Z' },
        source: { provider: 'Polymarket' },
        forecast: { probability: 0.7 },
        evidence: { triggers: [] },
      }],
    },
  ], 'live', findPlaces);

  assert.equal(events.length, 1);
  assert.equal(events[0].records.length, 3);
  assert.deepEqual(events[0].records.map(r => r.kind).sort(), ['forecast', 'news', 'signal']);
});

test('buildEvents drops unmatched live forecasts and classifies standalone signals', () => {
  const events = buildEvents([
    {
      kind: 'signal',
      records: [
        {
          id: 'signal:portwatch:CP_HORMUZ:2026-11-18',
          kind: 'signal',
          title: '霍尔木兹海峡船舶通行量异动',
          geoAnchors: ['CP_HORMUZ'],
          time: { kind: 'detected', value: '2026-11-18T00:00:00.000Z' },
          source: { provider: 'IMF PortWatch' },
        },
        {
          id: 'signal:wmo:flood-1',
          kind: 'signal',
          title: '极端气象预警：山洪',
          geoAnchors: ['PORT_ROTTERDAM'],
          time: { kind: 'detected', value: '2026-11-18T01:00:00.000Z' },
          source: { provider: 'WMO' },
        },
      ],
    },
    {
      kind: 'forecast',
      records: [{
        id: 'forecast:polymarket:tariffs',
        kind: 'forecast',
        title: 'US tariffs on China above 60% in 2026?',
        geoAnchors: ['CITY_SZ'],
        time: { kind: 'updated', value: '2026-11-18T02:00:00.000Z' },
        source: { provider: 'Polymarket' },
      }],
    },
  ], 'live');

  assert.equal(events.length, 2);
  const portwatch = events.find(e => e.id.startsWith('evt_') && e.records[0].id.includes('portwatch'));
  const wmo = events.find(e => e.id.startsWith('evt_') && e.records[0].id.includes('wmo'));
  assert.equal(portwatch.topic, 'transport_disruption');
  assert.equal(portwatch.routeRelevant, true);
  assert.equal(wmo.topic, 'natural_hazard');
  assert.equal(wmo.routeRelevant, true);
});

test('createMarketReader does not cache total failures and caches successful responses', async () => {
  let shouldFail = true;
  let fetchCalls = 0;
  const sampleEvent = [{
    id: 'evt-tariff',
    title: 'US tariffs on China above 60% in 2026?',
    slug: 'us-tariffs-china-2026',
    volume: 250000,
    endDate: '2026-12-31T00:00:00Z',
    markets: [{
      id: 'm2',
      question: 'US tariffs on China above 60% in 2026?',
      outcomePrices: '["0.62","0.38"]',
      oneDayPriceChange: 0.05,
      volumeNum: 250000,
    }],
  }];

  const readLiveMarkets = createMarketReader({
    fetchFn: async () => {
      fetchCalls += 1;
      if (shouldFail) throw new Error('ECONNRESET');
      return { ok: true, json: async () => sampleEvent };
    },
  });

  // 1. Cold-start transient failure should not be cached.
  const failed = await readLiveMarkets();
  assert.equal(failed.state, 'unavailable');
  assert.equal(failed.records.length, 0);
  assert.match(failed.error, /ECONNRESET/);
  const callsAfterFailure = fetchCalls;
  assert.ok(callsAfterFailure > 0);

  // 2. Subsequent call should retry and succeed immediately.
  shouldFail = false;
  const recovered = await readLiveMarkets();
  assert.equal(recovered.state, 'ok');
  assert.equal(recovered.records.length, 1);
  assert.equal(recovered.error, null);
  assert.ok(fetchCalls > callsAfterFailure);
  const callsAfterSuccess = fetchCalls;

  // 3. Subsequent call within TTL should reuse cached success.
  const cached = await readLiveMarkets();
  assert.equal(cached, recovered);
  assert.equal(fetchCalls, callsAfterSuccess);
});

test('createSignalReader does not cache total failures and caches successful responses', async () => {
  let shouldFail = true;
  let fetchCalls = 0;
  const readLiveSignals = createSignalReader({
    fetchFn: async () => {
      fetchCalls += 1;
      if (shouldFail) throw new Error('ECONNRESET');
      return { ok: true, text: async () => 'date,portname,n_total,n_container,n_tanker\n', json: async () => ({ items: [] }) };
    },
  });

  const failed = await readLiveSignals();
  assert.equal(failed.state, 'unavailable');
  assert.equal(failed.records.length, 0);
  const callsAfterFailure = fetchCalls;
  assert.ok(callsAfterFailure > 0);

  shouldFail = false;
  const recovered = await readLiveSignals();
  assert.equal(recovered.state, 'empty');
  assert.equal(recovered.error, null);
  assert.ok(fetchCalls > callsAfterFailure);
  const callsAfterSuccess = fetchCalls;

  const cached = await readLiveSignals();
  assert.equal(cached, recovered);
  assert.equal(fetchCalls, callsAfterSuccess);
});

test('parsePortWatchCsv and normalizePolymarketEvents honor custom windows and thresholds', () => {
  const now = Date.parse('2026-11-18T00:00:00Z');
  const rows = ['date,portname,n_total,n_container,n_tanker'];
  // 4 recent days: 80 ships/day; 4 prior days: 100 ships/day (-20% vs prior 4 days)
  for (let i = 0; i < 4; i++) {
    const d = new Date(now - (i + 1) * 86_400_000).toISOString().slice(0, 10);
    rows.push(`${d},Suez Canal,80,40,20`);
  }
  for (let i = 4; i < 8; i++) {
    const d = new Date(now - (i + 1) * 86_400_000).toISOString().slice(0, 10);
    rows.push(`${d},Suez Canal,100,50,25`);
  }
  assert.equal(parsePortWatchCsv(rows.join('\n'), now, { windowDays: 4, thresholdPct: 25 }).length, 0);
  const pwSignals = parsePortWatchCsv(rows.join('\n'), now, { windowDays: 4, thresholdPct: 15 });
  assert.equal(pwSignals.length, 1);
  assert.match(pwSignals[0].title, /环比前 4 日下降 20%/);

  const marketInputs = [
    {
      id: 'evt-soon',
      title: 'US tariffs on China this month?',
      volume: 100000,
      endDate: '2026-12-01T00:00:00Z',
      markets: [{ id: 'm-soon', question: 'US tariffs on China this month?', outcomePrices: '["0.5","0.5"]', volumeNum: 100000 }],
    },
    {
      id: 'evt-far',
      title: 'Suez blockade in 2027?',
      volume: 400000,
      endDate: '2027-06-01T00:00:00Z',
      markets: [{ id: 'm-far', question: 'Suez blockade in 2027?', outcomePrices: '["0.3","0.7"]', volumeNum: 400000 }],
    },
  ];
  assert.equal(normalizePolymarketEvents(marketInputs, () => [], now, { minVolume: 200000 }).length, 1);
  const shortHorizon = normalizePolymarketEvents(marketInputs, () => [], now, { minVolume: 50000, horizonDays: 30 });
  assert.equal(shortHorizon.length, 1);
  assert.equal(shortHorizon[0].source.upstreamId, 'm-soon');
});

test('parseWmoAlerts rejects cross-country town collisions when getNode is provided', () => {
  const now = Date.parse('2026-11-18T00:00:00Z');
  const nodes = new Map([
    ['PORT_ALGECIRAS', {id: 'PORT_ALGECIRAS', type: 'port', country: 'ES'}],
    ['PORT_VALENCIA', {id: 'PORT_VALENCIA', type: 'port', country: 'ES'}],
    ['SEA_PACIFIC', {id: 'SEA_PACIFIC', type: 'sea_area', country: ''}],
    ['PORT_BUENAVENTURA', {id: 'PORT_BUENAVENTURA', type: 'port', country: 'CO'}],
  ]);
  const findPlaces = r => {
    const hits = [];
    if (r.title.includes('Algeciras')) hits.push('PORT_ALGECIRAS');
    if (r.title.includes('Valencia')) hits.push('PORT_VALENCIA');
    if (r.title.includes('Pacific')) hits.push('SEA_PACIFIC');
    if (r.title.includes('Buenaventura')) hits.push('PORT_BUENAVENTURA');
    return hits;
  };
  const signals = parseWmoAlerts({
    items: [
      {
        id: 'co-1', event: 'Forest fire warning', areaDesc: 'Algeciras, Valencia',
        s: 3, capURL: 'co-ideam-es/2026/11/18/alert1.xml',
        sent: '2026-11-18 10:00:00', expires: '2026-11-19 16:00:00',
      },
      {
        id: 'co-2', event: 'Severe weather warning', areaDesc: 'Pacific northern',
        s: 3, capURL: 'co-ideam-es/2026/11/18/alert2.xml',
        sent: '2026-11-18 10:00:00', expires: '2026-11-19 16:00:00',
      },
      {
        id: 'co-3', event: 'Landslide warning', areaDesc: 'Buenaventura, Pacific northern',
        s: 4, capURL: 'co-ideam-es/2026/11/18/alert3.xml',
        sent: '2026-11-18 10:00:00', expires: '2026-11-19 16:00:00',
      },
    ],
  }, findPlaces, now, {getNode: id => nodes.get(id)});

  assert.equal(signals.length, 1);
  assert.deepEqual(signals[0].geoAnchors, ['PORT_BUENAVENTURA']);
});

test('createSignalReader scopes PortWatch queries to active network chokepoints via getNode', async () => {
  const seenUrls = [];
  const networkNodes = new Map([
    ['CP_SUEZ', {id: 'CP_SUEZ', name_zh: '苏伊士主通道'}],
    ['CP_HORMUZ', {id: 'CP_HORMUZ', name_zh: '霍尔木兹海峡'}],
  ]);
  const readSignals = createSignalReader({
    getNode: id => networkNodes.get(id),
    fetchFn: async url => {
      seenUrls.push(String(url));
      if (String(url).includes('severeweather.wmo.int')) {
        return {ok: true, json: async () => ({items: []})};
      }
      return {ok: true, json: async () => ({features: []})};
    },
  });

  const res = await readSignals();
  assert.equal(res.feedStatus[0].scope.startsWith('2 个关键海峡/运河（苏伊士主通道、霍尔木兹海峡等）'), true);
  const pwUrls = seenUrls.filter(u => u.includes('Daily_Chokepoints_Data'));
  assert.equal(pwUrls.length, 2);
  for (const url of pwUrls) {
    const where = new URL(url).searchParams.get('where');
    assert.match(where, /'Suez Canal','Strait of Hormuz'/);
    assert.doesNotMatch(where, /Panama Canal/);
  }
});
