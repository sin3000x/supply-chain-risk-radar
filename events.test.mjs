import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildEvents} from './events.mjs';
import {createEventLocator, loadGeography} from './geography.mjs';
import {computeNodeExposure, loadNetwork} from './network.mjs';

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

test('military strikes are not classified as labor_action and oil price stories stay in market_change', () => {
  const strikeHeadlines = [
    'US Now Has Three Carrier Strike Groups In Middle East As Roosevelt Arrives',
    'One crew member missing after two missile strikes on LPG carrier in Strait of Hormuz',
    'U.S. Military Strikes Iranian Missile Site Near Strait of Hormuz',
    'Iran says it targeted US military radar in Bahrain in retaliatory strike',
    'Oil tanker burns after mine strike in Strait of Hormuz',
    'Thailand Says US Agrees to Lower Forced-Labor Tariff to 10%',
    'European Union imposes sanctions on Russian shadow fleet tankers',
  ];
  const strikeEvents = buildEvents([{
    records: strikeHeadlines.map((title, i) => article(`s${i}`, title, `2026-11-18T0${i}:00:00Z`)),
  }], 'live');
  for (const ev of strikeEvents) {
    assert.notEqual(ev.action, 'labor_action', `unexpected labor_action for: ${ev.title}`);
  }

  const [laborEv] = buildEvents([{
    records: [article('labor', 'Strike Threat Looms at Ports of Los Angeles and Long Beach as Labor Talks Stall', '2026-11-18T17:08:00Z')],
  }], 'live');
  assert.equal(laborEv.action, 'labor_action');

  const oilAndTanker = buildEvents([{
    records: [
      article('o1', 'Oil edges up on tanker attacks, expected US crude drop', '2026-11-18T02:59:00Z'),
      article('o2', 'Oil prices rise after Strait of Hormuz attacks', '2026-11-18T04:08:00Z'),
      article('o3', 'The Oil Market Is Brimming With Crude Despite Tanker Attacks', '2026-11-16T18:45:00Z'),
      article('m1', 'New Tanker Attack Reported in Strait of Hormuz', '2026-11-16T11:08:00Z'),
    ],
  }], 'live');
  for (const id of ['o1', 'o2', 'o3']) {
    const found = oilAndTanker.find(ev => ev.records.some(r => r.id === id));
    assert.equal(found.topic, 'market_change', `expected market_change for ${id}`);
  }
  const tankerEv = oilAndTanker.find(ev => ev.records.some(r => r.id === 'm1'));
  assert.equal(tankerEv.topic, 'maritime_security');
  assert.equal(tankerEv.records.length, 1);
});

test('clusters separate conflicting actors and distinct Hormuz incidents while merging reworded follow-ups', async () => {
  const network = await loadNetwork(new URL('./data/', import.meta.url).pathname, 'demo');
  const findPlaces = r => network.findPlaces(r);
  const pubArticle = (id, title, time, publisher = 'Outlet') => ({
    id, kind: 'news', title, time: {value: time}, source: {publisher},
  });

  // 1. Australia vs UK sanctions merge internally, never across countries.
  const sanctions = buildEvents([{
    records: [
      pubArticle('au1', 'Australia Imposes New Sanctions Targeting Iran Shadow Fleet Expansion', '2026-11-17T21:17:00Z', 'Haaretz'),
      pubArticle('au2', 'Australia announces sanctions on Iranian oil tankers, organisations over shadow fleet expansion', '2026-11-18T00:24:00Z', 'Al-Monitor'),
      pubArticle('au3', 'Australia targets three Iranian tankers and four organizations in new sanctions, following UK sanctions', '2026-11-18T05:03:00Z', 'i24NEWS'),
      pubArticle('uk1', 'Iran imposes retaliatory bans after UK targets Iranian drone firms with sanctions', '2026-11-17T17:20:00Z', 'Al-Monitor'),
      pubArticle('uk2', 'UK announces sanctions on Iranian drone firms', '2026-11-17T18:27:00Z', 'BBC World'),
      pubArticle('uk3', 'Iran delays building contracts for drone firms after UK imposes sanctions', '2026-11-18T14:05:00Z', 'Guardian World'),
    ],
  }], 'live', findPlaces);
  assert.equal(sanctions.length, 2);
  assert.deepEqual(sanctions.map(e => e.records.length).sort((a,b) => a - b), [3, 3]);

  // 2. Reworded trade/border/cross-topic stories merge cleanly; NewsCord/Commentary become background or filtered.
  const misc = buildEvents([{
    records: [
      pubArticle('eu1', 'EU governments authorise signature of trade deal agreement with Indonesia', '2026-11-18T18:31:00Z', 'Reuters'),
      pubArticle('eu2', 'EU governments approve trade deal with Indonesia to offset Trump tariffs', '2026-11-19T00:11:00Z', 'Al Jazeera'),
      pubArticle('ee1', 'Estonia closes border to Russia after suspected drone factory arson', '2026-11-15T18:29:00Z', 'DW News'),
      pubArticle('ee2', 'Estonia to close all border crossings with Russia after attack on drone maker', '2026-11-15T22:17:00Z', 'Guardian World'),
      pubArticle('nc1', 'Oman and Iran Discuss Strait of Hormuz Security Amid Drone Attack on Bahrain Radar: 13 outlets compared', '2026-11-17T11:52:00Z', 'NewsCord'),
      pubArticle('op1', "Trump’s failed import tariff policy added to inflation | COMMENTARY | Opinion", '2026-11-18T05:00:00Z', 'LVRJ'),
    ],
  }], 'live', findPlaces);
  assert.equal(misc.length, 2);

  // 3. Hormuz commercial vessel attacks (mines, projectiles, missing/safe crew, Tara Gas) merge per chokepoint;
  // drone capture, island strikes, diplomacy, and other regions (New Orleans, Bulgaria) stay separate.
  const hormuz = buildEvents([{
    records: [
      pubArticle('hm1', 'Oil Tanker On Fire After Hitting Mine In Hormuz', '2026-11-16T01:00:00Z', 'gCaptain'),
      pubArticle('hp1', 'Projectile Strikes Oil Tanker While Attempting to Exit Strait of Hormuz', '2026-11-18T23:05:00Z', 'WANA'),
      pubArticle('hd1', 'Iran says it captured US drone south of Qeshm Island in Strait of Hormuz', '2026-11-16T10:12:00Z', 'Anadolu'),
      pubArticle('hd2', 'Iran says it seized US military drone near Strait of Hormuz', '2026-11-16T10:58:00Z', 'TRT World'),
      pubArticle('hc1', 'One crew member missing after two missile strikes on LPG carrier in Strait of Hormuz', '2026-11-17T16:30:00Z', 'Marine Log'),
      pubArticle('hc2', "UAE's ADNOC L&S says one crew member missing after attack on its vessel in Hormuz", '2026-11-18T07:41:00Z', 'Reuters'),
      pubArticle('hc3', "Update: all crew 'are safe and accounted for' following strike on ADNOC tanker in Strait of Hormuz", '2026-11-19T00:01:00Z', 'Riviera'),
      pubArticle('tg1', 'India identifies Tara Gas as tanker targeted in Strait of Hormuz missile attack', '2026-11-17T07:02:00Z', 'Gulf Business'),
      pubArticle('tg2', 'TARA GAS Burning Off Oman as Another Tanker Attack Leaves 11 Injured', '2026-11-18T19:12:00Z', 'gCaptain'),
      pubArticle('hq1', "US attacks Iran's Qeshm island in Strait of Hormuz, official says", '2026-11-17T16:52:00Z', 'MEE'),
      pubArticle('hq2', 'U.S. Military Strikes Iranian Missile Site Near Strait of Hormuz', '2026-11-17T20:14:00Z', 'gCaptain'),
      pubArticle('ht1', 'Oman, Iran discuss safeguarding maritime corridors, as attacks in Hormuz increase', '2026-11-17T05:45:00Z', 'Reuters'),
      pubArticle('ht2', 'Iran and Oman Hold Talks on Strait of Hormuz Security as Tanker Attacks Surge', '2026-11-17T10:00:00Z', 'OilPrice'),
      pubArticle('no1', 'USA: All passengers survive after tanker hits docked river cruise ship in New Orleans', '2026-11-14T13:15:00Z', 'France 24'),
      pubArticle('bg1', 'Cargo Ship Capsizes Off Bulgaria After Reported Sea Drone Attack', '2026-11-16T20:36:00Z', 'gCaptain'),
    ],
  }], 'live', findPlaces);
  assert.equal(hormuz.length, 6);
  const vesselCard = hormuz.find(ev => ev.records.some(r => r.id === 'hm1'));
  assert.equal(vesselCard.records.length, 7);
});

test('forecast and signal matching reject geo conflicts and weak token collisions', async () => {
  const network = await loadNetwork(new URL('./data/', import.meta.url).pathname, 'demo');
  const findPlaces = r => network.findPlaces(r);

  const events = buildEvents([
    {
      kind: 'news',
      records: [
        {
          id: 'rss:hormuz-closed', kind: 'news',
          title: 'Iran Declares Strait of Hormuz Closed as ‘Unauthorised’ Vessel Hit',
          time: {value: '2026-11-18T23:06:13.000Z'}, source: {publisher: 'EnergyNow'},
        },
        {
          id: 'rss:xi-putin', kind: 'news',
          title: 'Chinese President Xi pledges tariff cuts as Russian counterpart Putin criticises sanctions ahead of talks with US President Trump',
          time: {value: '2026-11-19T03:39:28.000Z'}, source: {publisher: 'ANN'},
        },
        {
          id: 'rss:hormuz-deal', kind: 'news',
          title: 'Iran Says Deal on Strait of Hormuz is Close But Will Not Open the Waterway by Itself',
          time: {value: '2026-11-17T16:33:10.000Z'}, source: {publisher: 'EnergyNow'},
        },
        {
          id: 'rss:blockade', kind: 'news',
          title: 'U.S. Targets Ship-to-Ship Transfers in Expanded Iran Maritime Blockade',
          time: {value: '2026-11-18T18:38:00.000Z'}, source: {publisher: 'gCaptain'},
        },
        {
          id: 'rss:old-suez', kind: 'news',
          title: 'Shipping delays hit Suez Canal after vessel grounding',
          time: {value: '2026-11-01T01:00:00.000Z'}, source: {publisher: 'Example'},
        },
      ],
    },
    {
      kind: 'signal',
      records: [
        {
          id: 'signal:portwatch:CP_SUEZ:2026-11-18', kind: 'signal',
          title: '苏伊士运河船舶通行量异动', geoAnchors: ['CP_SUEZ'],
          time: {value: '2026-11-18T00:00:00.000Z'}, source: {provider: 'IMF PortWatch'},
        },
      ],
    },
    {
      kind: 'forecast',
      records: [
        {
          id: 'forecast:bab', kind: 'forecast',
          title: 'Bab el-Mandeb Strait effectively closed by December 31?',
          geoAnchors: ['CP_BAB'],
          time: {value: '2026-11-19T06:59:00.000Z'}, source: {provider: 'Polymarket'},
        },
        {
          id: 'forecast:putin', kind: 'forecast',
          title: 'Putin out as President of Russia by June 30, 2027?',
          time: {value: '2026-11-19T06:59:00.000Z'}, source: {provider: 'Polymarket'},
        },
        {
          id: 'forecast:nuke', kind: 'forecast',
          title: 'US-Iran Final Nuclear Deal by December 31, 2026?',
          time: {value: '2026-11-18T06:39:00.000Z'}, source: {provider: 'Polymarket'},
        },
        {
          id: 'forecast:blockade', kind: 'forecast',
          title: 'US announces end of Iranian blockade by December 31, 2026?',
          time: {value: '2026-11-18T06:39:00.000Z'}, source: {provider: 'Polymarket'},
        },
      ],
    },
  ], 'live', findPlaces);

  const attachedForecasts = events.flatMap(ev =>
    ev.records.filter(r => r.kind === 'forecast').map(r => ({eventTitle: ev.title, forecastId: r.id})));
  assert.deepEqual(attachedForecasts, [{
    eventTitle: 'U.S. Targets Ship-to-Ship Transfers in Expanded Iran Maritime Blockade',
    forecastId: 'forecast:blockade',
  }]);

  // PortWatch signal 17 days after old Suez news should stay standalone rather than attaching to stale news.
  const suezNews = events.find(ev => ev.records.some(r => r.id === 'rss:old-suez'));
  assert.equal(suezNews.records.length, 1);
  assert.ok(events.some(ev => ev.records.length === 1 && ev.records[0].id === 'signal:portwatch:CP_SUEZ:2026-11-18'));
});

test('createEventLocator resolves single-country hubs, regional titles, site prepositions, major US ports, and cross-region trade/market buckets', async () => {
  const network = await loadNetwork(new URL('./data/', import.meta.url).pathname, 'demo');
  const locate = createEventLocator(network);

  // Single-country secondary city deduplication (Iran -> tehran, India -> newdelhi).
  assert.equal(locate({title: 'More Iran war? US military buildup and fresh attacks in Gulf fuel fears of escalation', topic: 'security_development'}).id, 'tehran');
  assert.equal(locate({title: "India's wholesale inflation accelerates to 12.29% in October on fuel price surge", topic: 'market_change'}).id, 'newdelhi');

  // Prepositional site disambiguation across two countries.
  assert.equal(locate({title: 'Iran launches drone attacks against US military base in Bahrain', topic: 'security_development'}).id, 'manama');
  assert.equal(locate({title: 'Anti-Houthi forces retreat in Yemen as Iran strikes Bahrain', topic: 'security_development'}).id, 'yemen');

  // Shared region across multi-country events.
  assert.equal(locate({title: 'Indonesia president conveys apology to Singapore, Malaysia over wildfire haze', topic: 'natural_hazard'}).region, 'southeastAsia');

  // Regional names in titles & guard against bare "strike" triggering US contextual alias.
  assert.equal(locate({title: 'Storm Charles causes floods and flight cancellations across southern Europe', topic: 'transport_disruption'}).region, 'europe');
  assert.equal(locate({title: 'US Now Has Three Carrier Strike Groups In Middle East As Roosevelt Arrives', topic: 'security_development'}).region, 'middleEast');

  // Major US ports and expanded US outage context.
  const laLoc = locate({title: 'Strike Threat Looms at Ports of Los Angeles and Long Beach as Labor Talks Stall', topic: 'transport_disruption'});
  assert.equal(laLoc.id, 'port-la-lb');
  assert.equal(laLoc.region, 'northAmerica');
  assert.equal(locate({title: 'Classified US national security communications network hit by outage, NSA says', topic: 'infrastructure_incident'}).id, 'washington');
  assert.equal(locate({title: 'United Airlines resolves tech outage that delayed flights', topic: 'transport_disruption'}).id, 'washington');

  // Cross-border / multilateral trade policy vs single-polity trade policy.
  assert.deepEqual(
    {
      id: locate({title: 'US imposes new chip sanctions aimed at China', topic: 'trade_policy'}).id,
      region: locate({title: 'US imposes new chip sanctions aimed at China', topic: 'trade_policy'}).region,
    },
    {id: 'cross:trade_policy', region: 'crossRegion'},
  );
  assert.equal(locate({title: 'EU governments authorise signature of trade deal agreement with Indonesia', topic: 'trade_policy'}).region, 'crossRegion');
  assert.equal(locate({title: 'New Congress could take up tariff bills amid USMCA talks', topic: 'trade_policy'}).region, 'crossRegion');
  assert.equal(locate({title: 'Japan announces unilateral export control reform', topic: 'trade_policy'}).region, 'eastAsia');

  // Single-location vs global market_change, while keeping routeRelevant: false (0 networkMatches).
  const hormuzOil = {title: 'Oil prices rise after Strait of Hormuz attacks', topic: 'market_change', routeRelevant: false, records: []};
  assert.equal(locate(hormuzOil).id, 'CP_HORMUZ');
  assert.equal(network.annotate(hormuzOil).networkMatches.length, 0);
  assert.equal(locate({title: 'Europe EV sales jump in October as high oil prices, subsidies fuel demand', topic: 'market_change'}).region, 'europe');
  const globalOil = locate({title: 'Oil prices fall as higher US crude stocks temper supply risks', topic: 'market_change'});
  assert.deepEqual({id: globalOil.id, region: globalOil.region}, {id: 'cross:market_change', region: 'crossRegion'});
});

test('nonSupplyChainNoise drops off-topic domestic lawsuits and settler/gang sanctions while keeping shipping and chip sanctions', () => {
  const records = [
    article('noise1', 'Australia Imposes New Sanctions Targeting West Bank Settlement Expansion', '2026-11-18T19:11:00Z'),
    article('noise1b', 'Australia imposes new sanctions over illegal settlement expansion in occupied West Bank', '2026-11-18T19:12:00Z'),
    article('noise2', 'European Union imposes sanctions on four Haiti gangs, citing killing, rape of children', '2026-11-16T18:56:00Z'),
    article('noise3', 'Washington federal court compels tariff-refund class action to individual arbitration based on Xbox warranty agreement', '2026-11-18T20:25:00Z'),
    article('noise4', 'Ecuadorian fishermen sue Trump administration over drone strike', '2026-11-18T01:04:00Z'),
    article('keep1', 'US imposes new chip sanctions aimed at China', '2026-11-19T05:18:00Z'),
    article('keep2', 'EU extends sanctions to nearly all major Russian banks', '2026-11-16T16:09:00Z'),
  ];
  const events = buildEvents([{records}], 'live');
  const keptIds = events.flatMap(ev => ev.records.map(r => r.id));
  assert.deepEqual(keptIds.sort(), ['keep1', 'keep2']);
});

test('bundled network snapshot satisfies structural, coordinate, exposure, and verified gateway invariants', async () => {
  const network = await loadNetwork(new URL('./data/', import.meta.url).pathname, 'default');
  const locate = createEventLocator(network);
  const {nodes, lanes} = network.snapshot;
  const nodeIds = new Set(nodes.map(node => node.id));

  assert.equal(network.summary.originCount, 3);
  assert.equal(network.summary.destinationCount, 29);
  assert.equal(network.summary.laneCount, 87);
  assert.equal(nodes.filter(node => node.verified).length, 56);

  for (const node of nodes) {
    assert.ok(Number.isFinite(node.lon) && Number.isFinite(node.lat), `${node.id} should carry self-contained coordinates`);
    assert.ok(node.region && node.region !== 'unknown', `${node.id} should carry self-contained region`);
    assert.notEqual(locate({geoAnchors: [node.id]}).region, 'unknown');
  }

  for (const lane of lanes) {
    for (const [mode, detail] of Object.entries(lane.modes)) {
      for (const path of detail.paths) {
        for (const id of path.nodes) {
          assert.ok(nodeIds.has(id), `${lane.lane_id}|${mode} references unknown node ${id}`);
        }
      }
      assert.deepEqual(detail.node_exposure, computeNodeExposure(detail.paths), `${lane.lane_id}|${mode} exposure matches paths`);
    }
  }

  // UAE sea lanes now require Strait of Hormuz on every path (must), whereas Oman avoids Hormuz.
  const szDxbSea = lanes.find(l => l.lane_id === 'SZ>WH_DXB').modes.sea;
  assert.equal(szDxbSea.node_exposure.CP_HORMUZ, 'must');
  const szMctSea = lanes.find(l => l.lane_id === 'SZ>WH_MCT').modes.sea;
  assert.equal(szMctSea.node_exposure.CP_HORMUZ, undefined);
});

test('real UN/LOCODE and IATA gateway matching covers updated ports/airports without false positives', async () => {
  const network = await loadNetwork(new URL('./data/', import.meta.url).pathname, 'default');
  const matchIds = (title, topic = 'transport_disruption') =>
    network.annotate({title, topic, routeRelevant: true, records: []}).networkMatches.map(m => m.nodeId);
  const matchLanes = (title, topic = 'transport_disruption') =>
    new Set(network.annotate({title, topic, routeRelevant: true, records: []})
      .networkMatches.flatMap(m => m.routes.map(r => r.laneId)));

  // UN/LOCODE matching across updated sea ports
  const locodes = [
    ['AEJEA', 'PORT_JEBELALI'], ['AEKHL', 'PORT_KHALIFA'], ['AESHJ', 'PORT_SHARJAH'],
    ['SAJED', 'PORT_JEDDAH'], ['SAJUB', 'PORT_JUBAIL'], ['SAYNB', 'PORT_YANBU'],
    ['OMSLL', 'PORT_SALALAH'], ['OMDQM', 'PORT_DUQM'], ['DJJIB', 'PORT_DJIBOUTI'],
    ['SOBBO', 'PORT_BERBERA'], ['TRIZM', 'PORT_IZMIR'], ['JOAQJ', 'PORT_AQABA'],
    ['EGALY', 'PORT_ALEXANDRIA'], ['EGDMI', 'PORT_DAMIETTA'], ['KWSAA', 'PORT_SHUAIBA'],
    ['ZACPT', 'PORT_CAPETOWN'], ['ZANGQ', 'PORT_NGQURA'], ['ZAPPE', 'PORT_PORTELIZABETH'],
    ['CNDCB', 'PORT_DACHANBAY'],
  ];
  for (const [code, expectedId] of locodes) {
    assert.ok(
      matchIds(`Port congestion alert at ${code} container terminal`).includes(expectedId),
      `expected ${code} to match ${expectedId}`,
    );
  }

  // IATA aviation-context matching & ambiguous-code protection
  assert.deepEqual(matchIds('Flights delayed at DXB due to storm'), ['AP_DXB']);
  assert.deepEqual(matchIds('Cargo flights suspended at AUH and JED').sort(), ['AP_AUH', 'AP_JED']);
  assert.deepEqual(matchIds('Sabiha Gokcen (SAW) airport ground stop'), ['AP_SAW']);
  assert.deepEqual(matchIds('Addis Ababa (ADD) cargo flights delayed'), ['AP_ADD']);
  assert.deepEqual(matchIds('Airlines can add routes after airspace reopens'), []);
  assert.deepEqual(matchIds('Oil tanker hit in Red Sea', 'maritime_security'), ['SEA_RED']);
  assert.deepEqual(matchIds('Suez Canal closure disrupts maritime shipping', 'maritime_security'), ['CP_SUEZ']);

  // New destinations: Oman (WH_MCT), Ethiopia (WH_ADD), Jordan (WH_AMM)
  assert.ok(matchLanes('Port congestion reported at Salalah').has('SZ>WH_MCT'));
  assert.ok(matchLanes('Dockworkers strike at Port of Djibouti').has('SZ>WH_ADD'));
  assert.ok(matchLanes('Berbera port operations halted after storm').has('GZ>WH_ADD'));
  assert.ok(matchLanes('Port of Aqaba container terminal closed').has('HK>WH_AMM'));
});

test('loadNetwork derives node_exposure automatically and loadGeography merges custom overrides', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'custom-network-'));
  try {
    await writeFile(join(directory, 'nodes.json'), JSON.stringify([
      {id: 'CITY_A', type: 'city', name_zh: '甲市', name_en: 'Alpha City', country: 'AA', region: 'eastAsia', lon: 114, lat: 22, aliases: []},
      {id: 'PORT_A', type: 'port', code: 'AAALP', name_zh: '甲港', name_en: 'Alpha Port', country: 'AA', region: 'eastAsia', lon: 114.1, lat: 22.1, aliases: []},
      {id: 'PORT_B', type: 'port', code: 'BBBTA', name_zh: '乙港', name_en: 'Beta Port', country: 'BB', region: 'customHub', lon: 55.1, lat: 25.1, aliases: []},
      {id: 'CITY_B', type: 'city', name_zh: '乙市', name_en: 'Beta City', country: 'BB', region: 'customHub', lon: 55.2, lat: 25.2, aliases: []},
    ]));
    await writeFile(join(directory, 'lanes.json'), JSON.stringify({
      meta: {basis: 'custom test'},
      lanes: [{
        lane_id: 'A>B',
        origin_id: 'A',
        origin_name: '甲',
        origin_city: 'CITY_A',
        origin_country: 'AA',
        dest_wh: 'WH_B',
        dest_name: '乙',
        dest_city: 'CITY_B',
        dest_country: 'BB',
        modes: {
          sea: {
            confidence: '高',
            paths: [
              {id: 'A>B|sea|1', likelihood: '主要', nodes: ['CITY_A', 'PORT_A', 'PORT_B', 'CITY_B']},
              {id: 'A>B|sea|2', likelihood: '备选', nodes: ['CITY_A', 'PORT_B', 'CITY_B']},
            ],
          },
        },
      }],
    }));
    await writeFile(join(directory, 'geography.json'), JSON.stringify({
      regions: {
        customHub: {label: '自定义走廊', lon: 55, lat: 25, aliases: ['Custom Corridor'], countries: 'BB'},
      },
      coordinates: {
        PORT_B: [55.5, 25.5],
      },
    }));

    const network = await loadNetwork(directory, 'custom');
    const geoConfig = await loadGeography(directory);
    const locate = createEventLocator(network, geoConfig);

    const matched = network.annotate({title: 'Port strike at AAALP', topic: 'transport_disruption', routeRelevant: true, records: []});
    assert.equal(matched.networkMatches.length, 1);
    assert.equal(matched.networkMatches[0].nodeId, 'PORT_A');
    assert.equal(matched.networkMatches[0].nodeCode, 'AAALP');
    assert.equal(matched.networkMatches[0].routes[0].exposure, 'main');

    const bLoc = locate({geoAnchors: ['PORT_B']});
    assert.equal(bLoc.region, 'customHub');
    assert.equal(bLoc.lon, 55.1);
    assert.equal(locate({title: 'Disruption across Custom Corridor', topic: 'transport_disruption'}).region, 'customHub');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
