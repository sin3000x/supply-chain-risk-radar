import test from 'node:test';
import assert from 'node:assert/strict';
import {buildEvents} from './events.mjs';
import {createEventLocator} from './geography.mjs';
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

const article = (id,title,time) => ({id,kind:'news',title,time:{value:time},source:{}});

test('follow-up reports on one disruption share an event', () => {
  const titles = [
    "US flight authority orders national ground stop over air traffic control 'communication issue'",
    'Passengers face further disruption as US flights slowly resume after ground stop',
    'US flights resume after nationwide ground stop lifted',
    'US nationwide flight ground stop: "Our routers got overloaded with data"',
    'US probes nationwide flights stoppage as travel disruptions persist',
  ];
  const records = titles.map((title,i)=>article(String(i),title,`2026-11-1${3+Math.floor(i/2)}T0${i}:00:00Z`));
  const events = buildEvents([{records}],'live');
  assert.equal(events.length,1);
  assert.equal(events[0].title,titles[0]);
  assert.equal(events[0].action,'closure');
  assert.equal(events[0].records.length,5);
});

test('a shared phrase does not join incidents in different places or far apart in time', () => {
  const events = buildEvents([{records:[
    article('a','Oil tanker hit by mine in Strait of Hormuz','2026-11-16T01:00:00Z'),
    article('b','Oil tanker hit by drone in the Red Sea','2026-11-16T02:00:00Z'),
    article('c','Port closes after ground stop','2026-11-01T02:00:00Z'),
    article('d','Airport flights resume after ground stop','2026-11-16T02:00:00Z'),
  ]}],'live');
  assert.equal(events.length,4);
});

test('network.annotate narrows matched routes by transport mode', async () => {
  const network = await loadNetwork(new URL('./data/',import.meta.url).pathname,'demo');
  const airEvent = network.annotate({
    title: 'Flights cancelled at Dubai airport after fog',
    topic: 'transport_disruption',
    routeRelevant: true,
    records: [],
  });
  assert.ok(airEvent.networkMatches.length > 0);
  for (const match of airEvent.networkMatches) {
    assert.ok(match.routes.every(route => route.mode === 'air'));
  }

  const seaEvent = network.annotate({
    title: 'Tanker attacked near Strait of Hormuz',
    topic: 'maritime_security',
    routeRelevant: true,
    records: [],
  });
  assert.ok(seaEvent.networkMatches.length > 0);
  for (const match of seaEvent.networkMatches) {
    assert.ok(match.routes.every(route => route.mode === 'sea'));
  }
});

test('createEventLocator resolves coordinates supporting West-to-East spatial ordering within regions', async () => {
  const network = await loadNetwork(new URL('./data/',import.meta.url).pathname,'demo');
  const locate = createEventLocator(network);

  for (const node of network.snapshot.nodes) {
    const loc = locate({geoAnchors:[node.id]});
    assert.notEqual(loc.region, 'unknown', `${node.id} should map to a region`);
    assert.ok(Number.isFinite(loc.lon) && Number.isFinite(loc.lat), `${node.id} should have coordinates`);
  }

  const sortWestToEast = ids => ids.map(id => locate({geoAnchors:[id]}))
    .sort((a,b) => a.lon - b.lon || b.lat - a.lat)
    .map(loc => loc.id);

  assert.deepEqual(
    sortWestToEast(['CP_HORMUZ', 'CP_SUEZ', 'CP_BAB']),
    ['CP_SUEZ', 'CP_BAB', 'CP_HORMUZ']
  );
  assert.deepEqual(
    sortWestToEast(['CP_BOSPHORUS', 'PORT_ROTTERDAM', 'PORT_ALGECIRAS', 'PORT_VALENCIA']),
    ['PORT_ALGECIRAS', 'PORT_VALENCIA', 'PORT_ROTTERDAM', 'CP_BOSPHORUS']
  );
});
