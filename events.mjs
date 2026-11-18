import {createHash} from 'node:crypto';
import {clusterNews,routeTopics} from './news-clusters.mjs';
import {sampleStrike} from './samples.mjs';
const eventId = (mode, key) => `${mode === 'sample' ? 'demo' : 'evt'}_${createHash('sha256').update(key).digest('hex').slice(0,24)}`;
const strikeRecords = new Set(['news:https://example.com/demo/port-strike', 'signal:sample-port-ops', 'forecast:sample-port']);

export function buildEvents(sources, mode, findPlaces = () => []) {
  const events = new Map();
  if (mode === 'live') {
    const news = sources.flatMap(source=>source.records).filter(record=>record.kind === 'news');
    for (const group of clusterNews(news,findPlaces)) {
      const {primary,topic,action,corroborationCount,records}=group;
      const id = eventId(mode, primary.id);
      events.set(id,{id,title:primary.title,region:primary.region ?? null,
        ...(primary.geoAnchors?.length && {geoAnchors:primary.geoAnchors}),
        topic,action,corroborationCount,routeRelevant:routeTopics.has(topic),records});
    }
  }
  for (const {records} of sources) for (const record of records) {
    if (mode === 'live' && record.kind === 'news') continue;
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
