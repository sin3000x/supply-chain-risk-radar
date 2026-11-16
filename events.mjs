const sampleStrike = {
  id: 'sample:event:port-strike',
  title: '鹿特丹港：两座码头拟罢工',
  summary: '工会已公告拟停工日期，港方正在调整作业安排。未来 72 小时关注装卸是否暂停。',
  region: '荷兰 · 鹿特丹港',
  geoAnchors: ['PORT_ROTTERDAM'],
};
const strikeRecords = new Set(['news:https://example.com/demo/port-strike', 'signal:sample-port-ops', 'forecast:sample-port']);

export function buildEvents(sources, mode) {
  const events = new Map();
  for (const {records} of sources) for (const record of records) {
    const linked = mode === 'sample' && strikeRecords.has(record.kind + ':' + record.source.upstreamId);
    const event = linked ? sampleStrike : {id:record.id,title:record.title,region:record.region};
    if (!events.has(event.id)) events.set(event.id, {...event, records:[]});
    events.get(event.id).records.push(record);
  }
  for (const event of events.values()) {
    event.records.sort((a,b)=>(a.time.value ?? '').localeCompare(b.time.value ?? ''));
    event.updatedAt = event.records.at(-1).time.value;
  }
  return [...events.values()].sort((a,b)=>(b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}
