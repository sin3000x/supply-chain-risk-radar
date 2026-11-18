import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildEvents} from './events.mjs';
import {openEventStore} from './event-store.mjs';
import {applyPresentation,presentEvent} from './event-presentation.mjs';
import {CREATE_PROMPT,UPDATE_PROMPT,createPresentationQueue,planRequest} from './model-presentation.mjs';

const profile = {baseUrl:'https://llm.example/v1',modelId:'test-model',apiKey:'k'};
const article = (id,title,time,summary) => ({id:'rss:https://news.example/'+id,kind:'news',title,summary,time:{value:time},source:{}});
const stop = article('a','US flight authority orders national ground stop','2026-11-13T21:00:00Z',
  'The FAA halted departures nationwide on Friday after an air traffic control communication issue.');
const resume = article('b','US flights resume after nationwide ground stop lifted','2026-11-14T02:00:00Z',
  'US flights resume after nationwide ground stop lifted Example News');
const probe = article('c','Investigators probe cause of US nationwide ground stop','2026-11-15T14:00:00Z',
  'Regulators opened an inquiry on Sunday into the router overload behind the stoppage.');

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(),'presentation-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const path = join(directory,'events.json');
  const store = await openEventStore(path,()=>[]);
  const calls = [];
  let reply = () => ({});
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({system:body.messages[0].content,user:body.messages[1].content,body});
    const content = reply(calls.at(-1));
    if (content instanceof Error) throw content;
    return {ok:true,json:async () => ({choices:[{message:{content:JSON.stringify(content)}}]})};
  };
  let clock = Date.parse('2026-11-16T00:00:00Z');
  const queue = createPresentationQueue({store,getProfile:()=>profile,fetchImpl,now:()=>clock});
  const settle = () => queue.idle();
  return {path,store,calls,queue,settle,
    reply:fn => {reply = fn;},
    advance:ms => {clock += ms;},
    ingest:async (...records) => (await store.update(buildEvents([{records}],'live')))[0]};
}

test('a new event gets a grounded Chinese title from compact context, kept across restarts', async t => {
  const {path,store,calls,queue,settle,reply,ingest} = await setup(t);
  const event = await ingest(stop);
  reply(() => ({title:'美国全国航班地面停飞',titleQuote:'orders national ground stop',update:null}));
  queue.schedule([event.id]);
  await settle();
  assert.equal(calls.length,1);
  assert.equal(calls[0].system,CREATE_PROMPT);
  assert.doesNotMatch(calls[0].user,/https?:/,'record URLs are not sent');
  assert.match(calls[0].user,/^报道：\n\[0\] 2026-11-13T21:00Z｜US flight authority/);
  const stored = store.get(event.id);
  assert.equal(stored.presentation.title,'美国全国航班地面停飞');
  assert.equal(stored.presentation.update,null);
  assert.equal(queue.pending([event.id]),0);
  const shown = applyPresentation(presentEvent(stored),stored.presentation);
  assert.equal(shown.displayTitle,'美国全国航班地面停飞');
  assert.equal(shown.presentation,undefined,'bookkeeping stays internal');

  const restarted = await openEventStore(path,()=>[]);
  assert.equal(planRequest(restarted.get(event.id)),null,'nothing to pay for after a restart');
  // A later snapshot rebuilding the event keeps its stored presentation.
  const [again] = await restarted.update(buildEvents([{records:[stop]}],'live'));
  assert.equal(again.presentation.title,'美国全国航班地面停飞');
});

test('follow-ups are read once, with only the new reports and the progress schema', async t => {
  const {store,calls,queue,settle,reply,ingest} = await setup(t);
  const event = await ingest(stop);
  reply(() => ({title:'美国全国航班地面停飞',titleQuote:'orders national ground stop',update:null}));
  queue.schedule([event.id]);
  await settle();

  await ingest(stop,resume,probe);
  reply(() => ({update:{text:'航班已恢复起飞',at:'2026-11-13',report:1,quote:'flights resume after nationwide'}}));
  queue.schedule([event.id]);
  await settle();
  assert.equal(calls.length,2);
  assert.equal(calls[1].system,UPDATE_PROMPT);
  assert.match(calls[1].user,/^事件：美国全国航班地面停飞\n报道：\n\[0\] .*\n\[1\] .*\n\[2\] /);
  assert.doesNotMatch(calls[1].user,/lifted Example News/,'a summary repeating its headline is dropped');
  let stored = store.get(event.id);
  assert.deepEqual({text:stored.presentation.update.text,at:stored.presentation.update.occurredAt,precision:stored.presentation.update.precision},
    {text:'航班已恢复起飞',at:'2026-11-13',precision:'day'});
  assert.equal(stored.presentation.processedIds.length,2);

  queue.schedule([event.id]);
  await settle();
  assert.equal(calls.length,2,'no call without unread reports');

  // A progress claim with an invented quote or a time after publication is not shown.
  const later = article('d','US flights back to normal after ground stop probe','2026-11-16T09:00:00Z',
    'Airlines said on Monday that schedules had fully recovered.');
  await ingest(stop,resume,probe,later);
  reply(() => ({update:{text:'航班全面恢复正常',at:'2026-11-17',report:1,quote:'schedules had fully recovered'}}));
  queue.schedule([event.id]);
  await settle();
  stored = store.get(event.id);
  assert.equal(stored.presentation.update.text,'航班已恢复起飞');
  assert.equal(stored.presentation.processedIds.length,3);
});

test('an ungrounded title is retried once, then left to the source headline', async t => {
  const {store,calls,queue,settle,reply,advance,ingest} = await setup(t);
  const event = await ingest(stop);
  reply(() => ({title:'美国停飞',titleQuote:'not in the report at all',update:null}));
  queue.schedule([event.id]);
  await settle();
  assert.equal(calls.length,1);
  queue.schedule([event.id]);
  await settle();
  assert.equal(calls.length,1,'waits before retrying');
  advance(61_000);
  queue.schedule([event.id]);
  await settle();
  assert.equal(calls.length,2);
  advance(61_000);
  queue.schedule([event.id]);
  await settle();
  assert.equal(calls.length,2,'gives up for these reports');
  assert.equal(store.get(event.id).presentation.failed.count,2);
  assert.equal(queue.pending([event.id]),0);
});

test('provider errors pause the queue without giving up', async t => {
  const {store,calls,queue,settle,reply,advance,ingest} = await setup(t);
  const event = await ingest(stop);
  reply(() => new Error('connect ECONNREFUSED'));
  queue.schedule([event.id]);
  await settle();
  assert.equal(calls.length,1);
  assert.equal(queue.pending([event.id]),1);
  assert.equal(store.get(event.id).presentation,undefined);
  advance(61_000);
  reply(() => ({title:'美国全国航班地面停飞',titleQuote:'orders national ground stop',update:null}));
  queue.schedule([event.id]);
  await settle();
  assert.equal(store.get(event.id).presentation.title,'美国全国航班地面停飞');
});
