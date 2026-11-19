import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildEvents} from './events.mjs';
import {openEventStore} from './event-store.mjs';
import {applyPresentation,presentEvent} from './event-presentation.mjs';
import {CREATE_PROMPT,UPDATE_PROMPT,createForecastTranslator,createPresentationQueue,extractJsonObject,planRequest} from './model-presentation.mjs';

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

test('forecast translator batches English questions, caches to disk, and survives restarts', async t => {
  const directory = await mkdtemp(join(tmpdir(),'forecast-trans-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const cachePath = join(directory,'market-translations.json');
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response(JSON.stringify({
      choices:[{message:{content:JSON.stringify({translations:[
        '2026年美中关税是否会进一步上调？',
        '霍尔木兹海峡今年是否会关闭？',
      ]})}}],
    }),{status:200,headers:{'content-type':'application/json'}});
  };

  const titles = [
    'Will US raise China tariffs in 2026?',
    'Will Strait of Hormuz close this year?',
    '已有中文标题',
  ];
  const translator = await createForecastTranslator({getProfile:() => profile,cachePath,fetchImpl});
  assert.equal(translator.pending(titles),2);
  translator.schedule(titles);
  await translator.idle();
  assert.equal(calls,1);
  assert.equal(translator.pending(titles),0);
  assert.equal(translator.get(titles[0]),'2026年美中关税是否会进一步上调？');
  assert.equal(translator.get(titles[1]),'霍尔木兹海峡今年是否会关闭？');
  assert.equal(translator.get(titles[2]),null);

  // A new instance loads the cached translations without calling the model again.
  const reloaded = await createForecastTranslator({getProfile:() => profile,cachePath,fetchImpl});
  assert.equal(reloaded.pending(titles),0);
  assert.equal(reloaded.get(titles[0]),'2026年美中关税是否会进一步上调？');
  assert.equal(calls,1);
});

test('forecast translator stops retrying after invalid replies', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response(JSON.stringify({
      choices:[{message:{content:JSON.stringify({translations:['not chinese']})}}],
    }),{status:200,headers:{'content-type':'application/json'}});
  };
  const translator = await createForecastTranslator({getProfile:() => profile,fetchImpl});
  const titles = ['Will Red Sea shipping resume?'];
  translator.schedule(titles);
  await translator.idle();
  translator.schedule(titles);
  await translator.idle();
  translator.schedule(titles);
  await translator.idle();
  assert.equal(calls,2);
  assert.equal(translator.pending(titles),0);
  assert.equal(translator.get(titles[0]),null);
  const fStatus = translator.status(titles);
  assert.equal(fStatus.failed,1);
  assert.equal(fStatus.failedItems.length,1);
  assert.equal(fStatus.failedItems[0].title,titles[0]);
  assert.match(fStatus.failedItems[0].reason,/non-Chinese/);
  assert.equal(translator.retryFailed(titles),1);
  await translator.idle();
});

test('presentation queue status surfaces transport backoff, recovery, and permanent failures', async t => {
  const {queue,settle,reply,advance,ingest} = await setup(t);
  const event = await ingest(stop);
  reply(() => {throw Object.assign(new Error('timeout'),{cause:{code:'ETIMEDOUT'}});});
  queue.schedule([event.id]);
  await settle();
  const paused = queue.status([event.id]);
  assert.equal(paused.enabled,true);
  assert.equal(paused.pending,1);
  assert.ok(paused.pausedUntil);
  assert.equal(paused.lastError,'ETIMEDOUT');

  advance(61_000);
  reply(() => ({title:'美国全国航班地面停飞',titleQuote:'orders national ground stop',update:null}));
  queue.schedule([event.id]);
  await settle();
  const recovered = queue.status([event.id]);
  assert.equal(recovered.pending,0);
  assert.equal(recovered.pausedUntil,null);
  assert.equal(recovered.lastError,null);
  assert.equal(recovered.failed,0);

  // Permanent validation failure after MAX_ATTEMPTS is counted in failed.
  const distinct = article('x','Port of Rotterdam closes terminals after storm surge','2026-11-16T01:00:00Z',
    'Port operators halted container handling overnight.');
  const bad = await ingest(distinct);
  reply(() => ({title:'没有引号依据',titleQuote:'nonexistent quote',update:null}));
  queue.schedule([bad.id]);
  await settle();
  advance(61_000);
  queue.schedule([bad.id]);
  await settle();
  const failed = queue.status([bad.id]);
  assert.equal(failed.pending,0);
  assert.equal(failed.failed,1);
  assert.equal(failed.failedItems.length,1);
  assert.equal(failed.failedItems[0].id,bad.id);
  assert.match(failed.failedItems[0].reason,/not grounded/);
  assert.match(failed.lastError,/not grounded/);

  // retryFailed clears the failure marker and re-runs the event.
  reply(() => ({title:'鹿特丹港因风暴潮关闭码头',titleQuote:'closes terminals after storm surge',update:null}));
  assert.equal(await queue.retryFailed([bad.id]),1);
  await settle();
  const retried = queue.status([bad.id]);
  assert.equal(retried.failed,0);
  assert.equal(retried.failedItems.length,0);
});

test('extractJsonObject handles think tags, markdown fences, and prose with escaped braces', () => {
  assert.deepEqual(extractJsonObject('{"title":"测试"}'),{title:'测试'});
  assert.deepEqual(
    extractJsonObject('<think>考虑 {"fake": 1} 后决定输出</think>\n```json\n{"title":"港口关闭","titleQuote":"port \\"closed\\" {today}"}\n```'),
    {title:'港口关闭',titleQuote:'port "closed" {today}'},
  );
  assert.deepEqual(
    extractJsonObject('结果如下：\n{"title":"航线中断","update":null}\n请查收。'),
    {title:'航线中断',update:null},
  );
  assert.equal(extractJsonObject('{"title":"被截断'),null);
});

test('intranet DeepSeek models get expanded max_tokens and tolerate think/fenced JSON', async t => {
  const directory = await mkdtemp(join(tmpdir(),'presentation-intranet-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  const store = await openEventStore(join(directory,'events.json'),()=>[]);
  const sentBodies = [];
  const fetchImpl = async (_url, init) => {
    sentBodies.push(JSON.parse(init.body));
    return {
      ok:true,
      json:async () => ({
        choices:[{
          finish_reason:'stop',
          message:{content:'<think>analyze</think>\n```json\n{"title":"美国全国航班地面停飞","titleQuote":"orders national ground stop","update":null}\n```'},
        }],
      }),
    };
  };
  const intranetProfile = {baseUrl:'http://deepseek.intranet.local:8000/v1',modelId:'DeepSeek-R1',apiKey:'k'};
  const queue = createPresentationQueue({store,getProfile:()=>intranetProfile,fetchImpl});
  const [event] = await store.update(buildEvents([{records:[stop]}],'live'));
  queue.schedule([event.id]);
  await queue.idle();
  assert.equal(sentBodies.length,1);
  assert.ok(sentBodies[0].max_tokens >= 2000);
  assert.equal(sentBodies[0].thinking,undefined);
  assert.equal(store.get(event.id).presentation.title,'美国全国航班地面停飞');
});

test('applyPresentation hides raw English latestUpdate once follow-up has been reviewed with no progress', () => {
  const event = {
    id: 'evt_pres',
    title: stop.title,
    records: [{...stop, role: 'report'}, {...resume, role: 'report'}],
  };
  const display = presentEvent(event);
  assert.equal(display.latestUpdate.recordId, resume.id);

  // Reviewed with update: null -> suppress raw English fallback.
  const reviewed = applyPresentation(display, {
    title: '美国全国航班地面停飞',
    titleEvidence: {recordId: stop.id, quote: 'orders national ground stop'},
    update: null,
    processedIds: [resume.id],
  });
  assert.equal(reviewed.latestUpdate, undefined);

  // Unreviewed newer report -> keep raw latestUpdate until model processes it.
  const unreviewed = applyPresentation(display, {
    title: '美国全国航班地面停飞',
    titleEvidence: {recordId: stop.id, quote: 'orders national ground stop'},
    update: null,
    processedIds: [],
  });
  assert.equal(unreviewed.latestUpdate.text, resume.title);

  // Reviewed with actual Chinese progress -> expose kind: 'progress'.
  const withProgress = applyPresentation(display, {
    title: '美国全国航班地面停飞',
    titleEvidence: {recordId: stop.id, quote: 'orders national ground stop'},
    update: {text: '航班已恢复起飞', occurredAt: '2026-11-14', precision: 'day', recordId: resume.id},
    processedIds: [resume.id],
  });
  assert.equal(withProgress.latestUpdate.kind, 'progress');
  assert.equal(withProgress.latestUpdate.text, '航班已恢复起飞');
});
