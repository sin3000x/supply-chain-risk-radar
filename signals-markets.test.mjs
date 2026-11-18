import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePortWatchCsv, parseWmoAlerts } from './signals.mjs';
import { normalizePolymarketEvents } from './markets.mjs';
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
