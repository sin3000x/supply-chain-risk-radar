import {mkdir,readFile,rename,writeFile,unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canJoinEvent, dedupeNewsRecords, summarizeNewsRecords} from './news-clusters.mjs';

const WINDOW = 48 * 3600_000;
const reports = event => event.records?.filter(record=>record.role !== 'background') ?? [];
const isNewsReport = record => record.kind === 'news' && record.role !== 'background';
const newsReports = event => (event.records ?? []).filter(isNewsReport);
const isStandaloneSignal = event => (event.records ?? []).length > 0 && event.records.every(record => record.kind === 'signal');

function resolve(events, id) {
  let event = events.get(id);
  for (let hops = 0; event?.mergedInto && hops < 16; hops++) event = events.get(event.mergedInto);
  return event?.mergedInto ? undefined : event;
}
const firstNewsReport = event => newsReports(event)[0]?.time?.value ?? reports(event)[0]?.time?.value ?? '';

function signalGroupKey(event) {
  const record = event.records?.[0];
  if (!record || record.kind !== 'signal') return null;
  const pw = record.id?.match(/^signal:portwatch:([^:]+):/);
  if (pw) return `portwatch:${pw[1]}`;
  if (record.id?.startsWith('signal:wmo:')) {
    const node = record.geoAnchors?.[0] ?? event.geoAnchors?.[0];
    if (!node) return null;
    const match = (record.title ?? '').match(/^[^：]*：([^（(]+)/);
    const hazard = match?.[1]?.trim() || record.category || 'weather';
    return `wmo:${node}:${hazard}`;
  }
  return null;
}

export async function openEventStore(path, findPlaces = () => [], { getWindowMs = () => WINDOW } = {}) {
  let stored;
  try {
    const file = JSON.parse(await readFile(path,'utf8'));
    if (file.version !== 1 || !Array.isArray(file.events)) throw Error('Unsupported event store format');
    stored = new Map(file.events.map(event=>[event.id,event]));
  } catch(error) {
    if(error.code !== 'ENOENT') throw error;
    stored = new Map();
  }
  let queue = Promise.resolve();
  const serialize = task => {
    const result = queue.then(task);
    queue = result.catch(()=>{});
    return result;
  };
  async function persist(next) {
    await mkdir(dirname(path),{recursive:true});
    const temporary = path+'.'+randomUUID()+'.tmp';
    try {
      await writeFile(temporary,JSON.stringify({version:1,events:[...next.values()]}),{mode:0o600,flag:'wx'});
      await rename(temporary,path);
    } finally {await unlink(temporary).catch(()=>{});}
    stored = next;
  }
  async function reconcile(incoming) {
    const next = new Map(stored);
    // Track ownership strictly by primary record type so shared signals/forecasts never bridge unrelated news stories.
    const newsOwners = new Map();
    const signalOwners = new Map();
    for (const event of stored.values()) {
      if (event.mergedInto) continue;
      const news = newsReports(event);
      if (news.length) {
        for (const record of news) newsOwners.set(record.id, event.id);
      } else if (isStandaloneSignal(event)) {
        for (const record of event.records) signalOwners.set(record.id, event.id);
      }
    }
    const touched = new Map();
    let dirty = false;

    function put(event, id, incomingForecasts = null) {
      const previous = next.get(id);
      const newsMap = new Map();
      const signalMap = new Map();
      for (const record of previous?.records ?? []) {
        if (record.kind === 'news') newsMap.set(record.id, record);
        else if (record.kind === 'signal') signalMap.set(record.id, record);
      }
      for (const record of event.records ?? []) {
        if (record.kind === 'news') {
          const prior = newsMap.get(record.id);
          if (prior?.role === 'report' && record.role === 'background') continue;
          newsMap.set(record.id, record);
        } else if (record.kind === 'signal') {
          signalMap.set(record.id, record);
        }
      }

      const sortRecords = list => [...list].sort((a,b) =>
        (a.time?.value ?? '').localeCompare(b.time?.value ?? '') || a.id.localeCompare(b.id));
      const dedupedNews = dedupeNewsRecords(sortRecords(newsMap.values()));

      const forecastSource = incomingForecasts ?? (event.records ?? []).filter(r => r.kind === 'forecast');
      const forecastMap = new Map();
      if (touched.has(id)) {
        for (const record of previous?.records ?? []) {
          if (record.kind === 'forecast') forecastMap.set(record.id, record);
        }
      }
      for (const record of forecastSource) forecastMap.set(record.id, record);

      const finalRecords = sortRecords([...dedupedNews, ...signalMap.values(), ...forecastMap.values()]);
      const mergedNews = finalRecords.filter(isNewsReport);
      let updated;
      if (mergedNews.length) {
        for (const record of mergedNews) newsOwners.set(record.id, id);
        const summary = summarizeNewsRecords(mergedNews, findPlaces, {previous, incoming: event});
        const base = {...event};
        delete base.geoAnchors;
        // Model-written titles and progress belong to the issued event, not to one snapshot.
        updated = {
          ...base,
          ...(previous?.presentation && {presentation: previous.presentation}),
          id,
          title: summary.title,
          region: summary.region,
          ...(summary.geoAnchors?.length && {geoAnchors: summary.geoAnchors}),
          ...(summary.topic && {topic: summary.topic}),
          action: summary.action,
          corroborationCount: summary.corroborationCount,
          routeRelevant: summary.routeRelevant,
          records: finalRecords,
          updatedAt: mergedNews.at(-1)?.time?.value ?? null,
        };
      } else {
        const signals = finalRecords.filter(r => r.kind === 'signal');
        for (const record of signals) signalOwners.set(record.id, id);
        const latestSignal = signals.at(-1);
        updated = {
          ...event,
          ...(previous?.presentation && {presentation: previous.presentation}),
          id,
          ...(latestSignal && {
            title: latestSignal.title,
            region: latestSignal.region ?? event.region ?? previous?.region ?? null,
            ...(latestSignal.geoAnchors?.length && {geoAnchors: latestSignal.geoAnchors}),
          }),
          records: finalRecords,
          updatedAt: finalRecords.filter(r => r.role !== 'background').at(-1)?.time?.value ?? null,
        };
      }

      const previousVersion = previous?.revision ?? 0;
      if (!previous || JSON.stringify({...updated, revision: previousVersion}) !== JSON.stringify(previous)) {
        updated.revision = previousVersion + 1;
        next.set(id, updated);
        dirty = true;
      }
      touched.set(id, next.get(id));
    }

    for (const event of incoming) {
      const incNews = newsReports(event);
      if (incNews.length > 0) {
        const direct = new Set(incNews.map(record => newsOwners.get(record.id)).filter(Boolean));
        if (direct.size > 1) {
          // A later snapshot showed these issued events are one story. Keep the earliest ID and
          // leave the others as redirects so links to them still resolve.
          const [keep, ...merged] = [...direct].sort((a,b) =>
            firstNewsReport(next.get(a)).localeCompare(firstNewsReport(next.get(b))) || a.localeCompare(b));
          const mergedRecords = merged.flatMap(mid => (next.get(mid)?.records ?? []).filter(r => r.kind !== 'forecast'));
          const incomingForecasts = (event.records ?? []).filter(r => r.kind === 'forecast');
          for (const mid of merged) {
            const previous = next.get(mid);
            next.set(mid, {id: mid, mergedInto: keep, revision: (previous?.revision ?? 0) + 1});
            dirty = true;
          }
          put({...event, records: [...mergedRecords, ...event.records]}, keep, incomingForecasts);
          continue;
        }
        let id = [...direct][0];
        if (!id && event.topic) {
          const windowMs = getWindowMs() || WINDOW;
          const candidates = [...next.values()].filter(previous =>
            !previous.mergedInto &&
            newsReports(previous).length > 0 &&
            canJoinEvent(newsReports(previous), incNews, findPlaces, {
              windowMs,
              prevTopic: previous.topic,
              incTopic: event.topic,
            }));
          if (candidates.length === 1) id = candidates[0].id;
        }
        put(event, id ?? event.id);
        continue;
      }

      if (isStandaloneSignal(event)) {
        const direct = new Set(event.records.map(record => signalOwners.get(record.id)).filter(Boolean));
        let id = [...direct][0];
        if (!id) {
          const key = signalGroupKey(event);
          if (key) {
            const windowMs = getWindowMs() || WINDOW;
            const evAt = Date.parse(event.updatedAt ?? event.records[0]?.time?.value ?? '');
            const candidates = [...next.values()].filter(previous =>
              !previous.mergedInto &&
              isStandaloneSignal(previous) &&
              signalGroupKey(previous) === key &&
              Number.isFinite(evAt) && Number.isFinite(Date.parse(previous.updatedAt ?? '')) &&
              Math.abs(Date.parse(previous.updatedAt) - evAt) <= windowMs * 1.5);
            if (candidates.length === 1) id = candidates[0].id;
          }
        }
        put(event, id ?? event.id);
        continue;
      }

      put(event, event.id);
    }
    if (dirty) await persist(next);
    // An event touched early in this batch may have been merged into another afterwards.
    const result = new Map();
    for (const id of touched.keys()) {
      const event = resolve(next,id);
      if (event) result.set(event.id,event);
    }
    return [...result.values()].sort((a,b)=>(b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }
  return {
    update(events) {return serialize(()=>reconcile(events));},
    /**
     * Replace the presentation of an issued event. `change` receives the current presentation and
     * returns the next one, or undefined to leave it alone. Events merged away are skipped.
     */
    setPresentation(id, change) {
      return serialize(async ()=>{
        const event = stored.get(id);
        if (!event || event.mergedInto) return undefined;
        const presentation = change(event.presentation);
        if (presentation === undefined || JSON.stringify(presentation) === JSON.stringify(event.presentation)) return event;
        const updated = {...event,presentation,revision:(event.revision ?? 0) + 1};
        await persist(new Map(stored).set(id,updated));
        return updated;
      });
    },
    /** An event by ID, following redirects left by merges. */
    get(id) {return resolve(stored,id);},
  };
}
