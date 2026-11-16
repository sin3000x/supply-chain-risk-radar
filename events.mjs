import {clusterNews,routeTopics} from './news-clusters.mjs';

const sampleStrike = {
  id: 'sample:event:port-strike',
  title: '鹿特丹港：两座码头拟罢工',
  summary: '工会已公告拟停工日期，港方正在调整作业安排。未来 72 小时关注装卸是否暂停。',
  region: '荷兰 · 鹿特丹港',
  geoAnchors: ['PORT_ROTTERDAM'],
};
const strikeRecords = new Set(['news:https://example.com/demo/port-strike', 'signal:sample-port-ops', 'forecast:sample-port']);

export function buildEvents(sources, mode, findPlaces = () => []) {
  const events = new Map();
  if (mode === 'live') {
    const news = sources.flatMap(source=>source.records).filter(record=>record.kind === 'news');
    for (const group of clusterNews(news,findPlaces)) {
      const {primary,topic,action,entities,records}=group;
      events.set(primary.id,{id:primary.id,title:primary.title,region:primary.region,
        topic,action,entities,routeRelevant:routeTopics.has(topic),records});
    }
  }
  for (const {records} of sources) for (const record of records) {
    if (mode === 'live' && record.kind === 'news') continue;
    const linked = mode === 'sample' && strikeRecords.has(record.kind + ':' + record.source.upstreamId);
    const event = linked ? sampleStrike : {id:record.id,title:record.title,region:record.region};
    if (!events.has(event.id)) events.set(event.id, {...event, records:[]});
    events.get(event.id).records.push(record);
  }
  for (const event of events.values()) {
    event.records.sort((a,b)=>(a.time.value ?? '').localeCompare(b.time.value ?? ''));
    event.updatedAt = event.records.filter(record=>record.role!=='background').at(-1).time.value;
  }
  return [...events.values()].sort((a,b)=>(b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}
