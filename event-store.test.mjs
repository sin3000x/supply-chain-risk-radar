import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildEvents} from './events.mjs';
import {openEventStore} from './event-store.mjs';

test('event ID survives a new representative, repeat ingestion, and restart', async () => {
  const directory=await mkdtemp(join(tmpdir(),'event-store-'));
  try {
    const path=join(directory,'events.json');
    const findPlaces=()=>['PORT_ROTTERDAM'];
    const make=(id,title,time)=>({id,kind:'news',title,time:{value:time}});
    const a=make('article-a','Rotterdam dockworkers announce Friday strike action','2026-11-16T03:00:00Z');
    const b=make('article-b','Rotterdam dockworkers announce Friday strike','2026-11-16T02:00:00Z');
    const feed=(...records)=>buildEvents([{records}],'live',findPlaces);
    const store=await openEventStore(path,findPlaces);
    const [initial]=await store.update(feed(a));
    assert.equal(initial.revision,1);
    assert.notEqual(feed(b)[0].id,initial.id);
    const [updated]=await store.update(feed(b));
    assert.equal(updated.id,initial.id);
    assert.equal(updated.revision,2);
    assert.equal(updated.records.length,2);
    const restarted=await openEventStore(path,findPlaces);
    assert.deepEqual(restarted.get(initial.id),updated);
    const [again]=await restarted.update(feed(b));
    assert.equal(again.id,initial.id);
    assert.equal(again.revision,2);
  } finally {
    await rm(directory,{recursive:true,force:true});
  }
});
