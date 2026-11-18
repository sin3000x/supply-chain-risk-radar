import {createHash} from 'node:crypto';
import {clusterNews,routeTopics} from './news-clusters.mjs';
import {sampleStrike} from './samples.mjs';
const eventId = (mode, key) => `${mode === 'sample' ? 'demo' : 'evt'}_${createHash('sha256').update(key).digest('hex').slice(0,24)}`;
const strikeRecords = new Set(['news:https://example.com/demo/port-strike', 'signal:sample-port-ops', 'forecast:sample-port']);

const STOP_WORDS = new Set([
  'about','after','before','between','could','first','from','have','into','more','most','over','said','says',
  'than','that','their','there','these','they','this','under','what','when','where','which','while','will',
  'with','would','year','years','month','months','week','weeks','2025','2026','2027','june','july','march',
  'april','august','december','january','february','november','october','september','before','until','during',
]);

const extractTokens = text => new Set(
  (text ?? '').toLowerCase().match(/[a-z]{4,}/g)?.filter(w => !STOP_WORDS.has(w)) ?? []
);

function findMatchingEvent(record, newsEvents, findPlaces) {
  const recAnchors = new Set(record.geoAnchors?.length ? record.geoAnchors : findPlaces(record));
  const recTokens = extractTokens(record.title);
  let best = null;
  let bestScore = 0;

  for (const entry of newsEvents) {
    const sharedAnchors = [...recAnchors].filter(id => entry.anchors.has(id)).length;
    const sharedTokens = [...recTokens].filter(t => entry.tokens.has(t)).length;

    if (record.kind === 'signal') {
      if (!sharedAnchors) continue;
      const score = sharedAnchors * 10 + sharedTokens + (entry.event.corroborationCount ?? 1) * 0.1;
      if (score > bestScore) { bestScore = score; best = entry.event; }
    } else if (record.kind === 'forecast') {
      const matches = (sharedAnchors >= 1 && sharedTokens >= 1) || sharedTokens >= 2;
      if (!matches) continue;
      const score = sharedAnchors * 10 + sharedTokens * 3;
      if (score > bestScore) { bestScore = score; best = entry.event; }
    }
  }
  return best;
}

export function buildEvents(sources, mode, findPlaces = () => []) {
  const events = new Map();
  const newsIndex = [];
  if (mode === 'live') {
    const news = sources.flatMap(source=>source.records).filter(record=>record.kind === 'news');
    for (const group of clusterNews(news,findPlaces)) {
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
      const tokens = extractTokens([primary.title, ...records.map(r => r.title)].join(' '));
      newsIndex.push({ event, anchors, tokens });
    }
  }
  for (const {records} of sources) for (const record of records) {
    if (mode === 'live' && record.kind === 'news') continue;
    if (mode === 'live') {
      const matched = findMatchingEvent(record, newsIndex, findPlaces);
      if (matched) {
        matched.records.push(record);
        continue;
      }
    }
    const linked = mode === 'sample' && strikeRecords.has(record.kind + ':' + record.source.upstreamId);
    const event = linked ? sampleStrike : {
      id:eventId(mode,record.id),title:record.title,region:record.region ?? null,
      ...(record.geoAnchors?.length && {geoAnchors:record.geoAnchors}),
    };
    if (!events.has(event.id)) events.set(event.id, {...event, records:[]});
    events.get(event.id).records.push(record);
  }
  for (const event of events.values()) {
    event.records.sort((a,b)=>(a.time.value ?? '').localeCompare(b.time.value ?? ''));
    event.updatedAt = event.records.filter(record=>record.role!=='background').at(-1).time.value;
  }
  return [...events.values()].sort((a,b)=>(b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}
