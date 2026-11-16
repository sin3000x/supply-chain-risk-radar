import {mkdir,readFile,rename,writeFile,unlink} from 'node:fs/promises';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {clusterNews} from './news-clusters.mjs';

const WINDOW = 48 * 3600_000;
const reports = event => event.records.filter(record=>record.role !== 'background');

export async function openEventStore(path, findPlaces) {
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
      const updated = {...event,id,records:[...records.values()].sort((a,b)=>
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
        // Keep already issued IDs separate when a later snapshot bridges two events.
        for (const id of direct) put({...next.get(id),records:event.records.filter(record=>owners.get(record.id)===id)},id);
        const unassigned = reports(event).filter(record=>!owners.has(record.id));
        if (unassigned.length) put({...event,title:unassigned[0].title,records:unassigned},next.has(event.id) ? 'evt_'+randomUUID() : event.id);
        continue;
      }
      let id = [...direct][0];
      if (!id && event.topic) {
        const candidates = [...next.values()].filter(previous=>
          previous.topic === event.topic &&
          Math.abs(Date.parse(previous.updatedAt)-Date.parse(event.updatedAt)) <= WINDOW &&
          reports(event).some(a=>reports(previous).some(b=>clusterNews([a,b],findPlaces).some(group=>group.records.length===2))));
        if(candidates.length===1) id = candidates[0].id;
      }
      // The proposed ID matches the old release for its first observed article.
      put(event,id ?? event.id);
    }
    if (dirty) {
      await mkdir(dirname(path),{recursive:true});
      const temporary = path+'.'+randomUUID()+'.tmp';
      try {
        await writeFile(temporary,JSON.stringify({version:1,events:[...next.values()]}),{mode:0o600,flag:'wx'});
        await rename(temporary,path);
      } finally {await unlink(temporary).catch(()=>{});}
      stored = next;
    }
    return [...touched.values()].sort((a,b)=>(b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }
  return {
    update(events) {
      const result = queue.then(()=>reconcile(events));
      queue = result.catch(()=>{});
      return result;
    },
    get(id) {return stored.get(id);},
  };
}
