import {mkdir,readFile,rename,writeFile,unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {clusterNews} from './news-clusters.mjs';

const WINDOW = 48 * 3600_000;
const reports = event => event.records?.filter(record=>record.role !== 'background') ?? [];
function resolve(events, id) {
  let event = events.get(id);
  for (let hops = 0; event?.mergedInto && hops < 16; hops++) event = events.get(event.mergedInto);
  return event?.mergedInto ? undefined : event;
}
const firstReport = event => reports(event)[0]?.time.value ?? '';

export async function openEventStore(path, findPlaces, { getWindowMs = () => WINDOW } = {}) {
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
    const owners = new Map();
    for (const event of stored.values()) for (const record of reports(event)) owners.set(record.id,event.id);
    const touched = new Map();
    let dirty = false;
    function put(event, id) {
      const previous = next.get(id);
      const records = new Map((previous?.records ?? []).map(record=>[record.id,record]));
      for (const record of event.records) {
        const prior=records.get(record.id);
        if (prior?.role === 'report' && record.role === 'background') continue;
        records.set(record.id,record);
        if(record.role !== 'background') owners.set(record.id,id);
      }
      // Model-written titles and progress belong to the issued event, not to one snapshot.
      const updated = {...event,...(previous?.presentation && {presentation:previous.presentation}),
        id,records:[...records.values()].sort((a,b)=>
        (a.time.value ?? '').localeCompare(b.time.value ?? '') || a.id.localeCompare(b.id))};
      updated.updatedAt = reports(updated).at(-1)?.time.value ?? null;
      const previousVersion = previous?.revision ?? 0;
      if (!previous || JSON.stringify({...updated,revision:previousVersion}) !== JSON.stringify(previous)) {
        updated.revision = previousVersion + 1;
        next.set(id,updated);
        dirty = true;
      }
      touched.set(id,next.get(id));
    }
    for (const event of incoming) {
      const direct = new Set(reports(event).map(record=>owners.get(record.id)).filter(Boolean));
      if (direct.size > 1) {
        // A later snapshot showed these issued events are one story. Keep the earliest ID and
        // leave the others as redirects so links to them still resolve.
        const [keep,...merged] = [...direct].sort((a,b)=>firstReport(next.get(a)).localeCompare(firstReport(next.get(b))) || a.localeCompare(b));
        const records = merged.flatMap(id=>next.get(id).records);
        for (const id of merged) {
          const previous = next.get(id);
          next.set(id,{id,mergedInto:keep,revision:previous.revision + 1});
          dirty = true;
        }
        put({...event,records:[...records,...event.records]},keep);
        continue;
      }
      let id = [...direct][0];
      if (!id && event.topic) {
        const windowMs = getWindowMs() || WINDOW;
        const candidates = [...next.values()].filter(previous=>
          !previous.mergedInto && previous.topic === event.topic &&
          Math.abs(Date.parse(previous.updatedAt)-Date.parse(event.updatedAt)) <= windowMs &&
          reports(event).some(a=>reports(previous).some(b=>clusterNews([a,b],findPlaces,{windowMs}).some(group=>group.records.length===2))));
        if(candidates.length===1) id = candidates[0].id;
      }
      // The proposed ID matches the old release for its first observed article.
      put(event,id ?? event.id);
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
