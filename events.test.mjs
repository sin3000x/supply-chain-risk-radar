import test from 'node:test';
import assert from 'node:assert/strict';
import {buildEvents} from './events.mjs';
import {loadNetwork} from './network.mjs';

test('live intake groups coverage, attaches commentary, and filters unrelated news', async () => {
  const network = await loadNetwork(new URL('./data/',import.meta.url).pathname,'demo');
  const titles = [
    "Yemeni forces' retreat leaves Houthis in control of key Red Sea waterway",
    'Houthis take control of Red Sea waterway after Yemeni forces retreat',
    'The Red Sea cannot be secured without restoring the Yemeni state',
    'Russia’s Andreeva defeats Ukraine’s Svitolina 7-5, 6-3 to win WTA Finals',
    'Vessels hit by mines in Red Sea shipping lanes',
    'US imposes new tariffs on goods from Singapore',
  ];
  const records=titles.map((title,i)=>({kind:'news',title,id:String(i),time:{value:'2026-11-16T01:00:00Z'}}));
  const events=buildEvents([{records}],'live',record=>
    network.annotate({records:[record]}).networkMatches.map(match=>match.nodeId)).map(event=>network.annotate(event));
  assert.equal(events.length,3);
  const change=events.find(event=>event.action==='territorial_change');
  // Two separate Red Sea events make the commentary ambiguous.
  assert.deepEqual(change.records.map(r=>r.id),['0','1']);
  assert.equal(change.networkMatches[0].nodeId,'SEA_RED');
  assert.equal(events.find(event=>event.topic==='trade_policy').networkMatches.length,0);
  const single=buildEvents([{records:records.slice(0,4)}],'live',()=>['SEA_RED']);
  assert.equal(single.length,1);
  assert.equal(single[0].records.find(r=>r.id==='2').role,'background');
});

test('identical short headlines share an event ID while retaining article links', () => {
  const urls=['https://example.com/one','https://example.org/two'];
  const records=urls.map((url,i)=>({
    id:'rss:'+url, kind:'news', title:i ? 'Port closes.' : 'Port closes',
    time:{value:'2026-11-16T01:00:00Z'}, source:{url},
  }));
  const events=buildEvents([{records}],'live');
  assert.equal(events.length,1);
  assert.match(events[0].id,/^evt_[0-9a-f]{24}$/);
  assert.deepEqual(events[0].records.map(record=>record.source.url),urls);
  assert.equal(events[0].id,buildEvents([{records:[...records].reverse()}],'live')[0].id);
});
