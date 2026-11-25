import {createHash} from 'node:crypto';
import {clusterNews,routeTopics} from './news-clusters.mjs';
import {inferGeoHubsFromTitle} from './public/vendor/worldmonitor/geo-hub-index.mjs';
import {sampleStrike} from './samples.mjs';
const eventId = (mode, key) => `${mode === 'sample' ? 'demo' : 'evt'}_${createHash('sha256').update(key).digest('hex').slice(0,24)}`;
const strikeRecords = new Set(['news:https://example.com/demo/port-strike', 'signal:sample-port-ops', 'forecast:sample-port']);
const DAY_MS = 86_400_000;
const DEFAULT_CLUSTER_WINDOW_MS = 48 * 3600_000;

const STOP_WORDS = new Set([
  'about','after','before','between','could','first','from','have','into','more','most','over','said','says',
  'than','that','their','there','these','they','this','under','what','when','where','which','while','will',
  'with','would','year','years','month','months','week','weeks','2025','2026','2027','june','july','march',
  'april','august','december','january','february','november','october','september','until','during',
  'president','minister','leader','leadership','government','state','head','country','countries','world','global',
  'deal','talks','agreement','peace','final','phase','continue','continues','return','returns','normal',
  'reach','high','time','closed','close','open','strait','canal','port','ports','ship','ships','vessel','vessels',
  'military','strike','strikes','attack','attacks','clash','war','announce','announces','agree','agrees',
  'effective','effectively','attempt','full','recognizes','sovereignty','territory','other','against','cancelled',
]);

const FORECAST_EVENT_TERMS = new Set([
  'blockade','tariff','tariffs','sanction','sanctions','ceasefire','airspace','recession','nuclear','uranium',
  'shipping','traffic','crude','embargo','invasion','invade','coup','export','import','freight','refinery',
  'pipeline','semiconductor','chips','hormuz','suez','panama','mandeb',
]);

const DEMONYMS = {
  iranian: 'iran', russian: 'russia', ukrainian: 'ukraine', chinese: 'china',
  israeli: 'israel', yemeni: 'yemen', american: 'america', canadian: 'canada',
  indonesian: 'indonesia', australian: 'australia', british: 'britain',
};

const extractTokens = text => new Set(
  ((text ?? '').toLowerCase().match(/[a-z]{4,}/g) ?? [])
    .filter(w => !STOP_WORDS.has(w))
    .map(w => DEMONYMS[w] ?? w)
);

const canonicalHubs = text => inferGeoHubsFromTitle(text ?? '').map(({hub, hubId}) => hub.networkId || hubId);

function isSignalTopicCompatible(record, topic) {
  const isPortWatch = record.id?.startsWith('signal:portwatch:') || record.source?.provider === 'IMF PortWatch';
  if (isPortWatch) return topic === 'maritime_security' || topic === 'transport_disruption';
  const isWmo = record.id?.startsWith('signal:wmo:') || record.source?.provider?.startsWith('WMO');
  if (isWmo) return topic === 'natural_hazard' || topic === 'transport_disruption';
  return true;
}

function findMatchingEvent(record, newsEvents, findPlaces, windowMs) {
  const recAnchors = new Set(record.geoAnchors?.length ? record.geoAnchors : findPlaces(record));
  const recTokens = extractTokens(record.title);
  const recHubs = recAnchors.size === 0 ? new Set(canonicalHubs(record.title)) : null;
  const recAt = Date.parse(record.time?.value ?? '');
  const isPortWatch = record.id?.startsWith('signal:portwatch:') || record.source?.provider === 'IMF PortWatch';
  // PortWatch is a 7-day rolling chokepoint observation; keep it as its own card rather than attributing it to one news incident.
  if (isPortWatch) return null;
  let best = null;
  let bestScore = 0;

  for (const entry of newsEvents) {
    const sharedAnchors = [...recAnchors].filter(id => entry.anchors.has(id)).length;
    const sharedTokenList = [...recTokens].filter(t => entry.tokens.has(t));
    const sharedTokens = sharedTokenList.length;

    if (record.kind === 'signal') {
      if (!sharedAnchors) continue;
      if (!isSignalTopicCompatible(record, entry.event.topic)) continue;
      if (Number.isFinite(recAt) && Number.isFinite(entry.latestAt)) {
        if (Math.abs(recAt - entry.latestAt) > windowMs) continue;
      }
      const score = sharedAnchors * 10 + sharedTokens + (entry.event.corroborationCount ?? 1) * 0.1;
      if (score > bestScore) { bestScore = score; best = entry.event; }
    } else if (record.kind === 'forecast') {
      if (recAnchors.size > 0 && sharedAnchors === 0) continue;
      if (entry.event.topic === 'market_change' && !/\b(oil|crude|fuel|price|freight|rate)\b/i.test(record.title ?? '')) {
        continue;
      }
      let sharedHubs = 0;
      if (sharedAnchors >= 1) {
        if (sharedTokens < 1) continue;
      } else {
        sharedHubs = [...recHubs].filter(id => entry.hubs.has(id)).length;
        const ratio = sharedTokens / Math.max(1, recTokens.size);
        const hasEventTerm = sharedTokenList.some(t => FORECAST_EVENT_TERMS.has(t));
        const matches = sharedHubs >= 1 && ratio >= 0.4 && (sharedTokens >= 3 || (sharedTokens >= 2 && hasEventTerm));
        if (!matches) continue;
      }
      const routeBonus = entry.event.routeRelevant !== false ? 5 : 0;
      const score = sharedAnchors * 10 + sharedHubs * 3 + sharedTokens * 3 + routeBonus;
      if (score > bestScore) { bestScore = score; best = entry.event; }
    }
  }
  return best;
}

function signalMeta(record) {
  const topic = record.topic ?? (
    record.id?.startsWith('signal:wmo:') || record.source?.provider?.startsWith('WMO') ? 'natural_hazard'
      : record.id?.startsWith('signal:portwatch:') || record.source?.provider === 'IMF PortWatch' ? 'transport_disruption'
        : null
  );
  return {
    ...(topic && { topic }),
    routeRelevant: topic ? routeTopics.has(topic) : true,
  };
}

export function buildEvents(sources, mode, findPlaces = () => [], { clusterWindowMs } = {}) {
  const events = new Map();
  const newsIndex = [];
  const windowMs = clusterWindowMs || DEFAULT_CLUSTER_WINDOW_MS;
  if (mode === 'live') {
    const news = sources.flatMap(source=>source.records).filter(record=>record.kind === 'news');
    const clusterOptions = clusterWindowMs ? { windowMs: clusterWindowMs } : undefined;
    for (const group of clusterNews(news, findPlaces, clusterOptions)) {
      const {primary,topic,action,corroborationCount,records}=group;
      const id = eventId(mode, primary.id);
      const event = {id,title:primary.title,region:primary.region ?? null,
        ...(primary.geoAnchors?.length && {geoAnchors:primary.geoAnchors}),
        topic,action,corroborationCount,routeRelevant:routeTopics.has(topic),records};
      events.set(id, event);
      const anchors = new Set([
        ...(primary.geoAnchors ?? []),
        ...records.flatMap(r => r.geoAnchors?.length ? r.geoAnchors : findPlaces(r)),
      ]);
      const hubs = new Set([
        ...anchors,
        ...records.flatMap(r => canonicalHubs(r.title)),
      ]);
      const tokens = extractTokens([primary.title, ...records.map(r => r.title)].join(' '));
      const reportTimes = records
        .filter(r => r.role !== 'background')
        .map(r => Date.parse(r.time?.value ?? ''))
        .filter(Number.isFinite);
      const latestAt = reportTimes.length ? Math.max(...reportTimes) : NaN;
      newsIndex.push({ event, anchors, hubs, tokens, latestAt });
    }
  }
  for (const {records} of sources) for (const record of records) {
    if (mode === 'live' && record.kind === 'news') continue;
    if (mode === 'live') {
      const matched = findMatchingEvent(record, newsIndex, findPlaces, windowMs);
      if (matched) {
        matched.records.push(record);
        continue;
      }
      // Forecasts without a matching news event are market expectations, not observed disruptions.
      if (record.kind === 'forecast') continue;
    }
    const linked = mode === 'sample' && strikeRecords.has(record.kind + ':' + record.source.upstreamId);
    const event = linked ? sampleStrike : {
      id:eventId(mode,record.id),title:record.title,region:record.region ?? null,
      ...(record.geoAnchors?.length && {geoAnchors:record.geoAnchors}),
      ...(record.kind === 'signal' && signalMeta(record)),
    };
    if (!events.has(event.id)) events.set(event.id, {...event, records:[]});
    events.get(event.id).records.push(record);
  }
  for (const event of events.values()) {
    event.records.sort((a,b)=>(a.time.value ?? '').localeCompare(b.time.value ?? ''));
    const nonBackground = event.records.filter(record => record.role !== 'background');
    const newsReports = nonBackground.filter(record => record.kind === 'news');
    event.updatedAt = (newsReports.at(-1) ?? nonBackground.at(-1))?.time.value ?? null;
  }
  return [...events.values()].sort((a,b)=>(b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}
