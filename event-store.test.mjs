import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildEvents} from './events.mjs';
import {openEventStore} from './event-store.mjs';
import {rebuildEventStore} from './rebuild-events.mjs';

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

test('events later shown to be one story merge and leave redirects', async () => {
  const directory=await mkdtemp(join(tmpdir(),'event-store-'));
  try {
    const store=await openEventStore(join(directory,'events.json'),()=>[]);
    const make=(id,title,time)=>({id,kind:'news',title,time:{value:time},source:{}});
    const a=make('a','US flight authority orders national ground stop','2026-11-13T21:00:00Z');
    const b=make('b','US flights resume after nationwide ground stop lifted','2026-11-14T02:00:00Z');
    // Seen separately first (e.g. by an older clustering rule).
    const [first]=await store.update([{id:'evt_a',title:a.title,topic:'transport_disruption',records:[{...a,role:'report'}]}]);
    const [second]=await store.update([{id:'evt_b',title:b.title,records:[{...b,role:'report'}]}]);
    assert.notEqual(first.id,second.id);
    const [merged]=await store.update(buildEvents([{records:[a,b]}],'live'));
    assert.equal(merged.id,first.id);
    assert.equal(merged.records.length,2);
    assert.equal(store.get(second.id).id,first.id);
  } finally {
    await rm(directory,{recursive:true,force:true});
  }
});

test('shared signals and forecasts never merge unrelated news or hijack news IDs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'event-store-isolation-'));
  try {
    const store = await openEventStore(join(directory, 'events.json'), () => ['CP_HORMUZ']);
    const sharedSignal = {
      id: 'signal:portwatch:CP_HORMUZ:2026-11-15',
      kind: 'signal',
      title: '霍尔木兹海峡船舶通行量异动',
      geoAnchors: ['CP_HORMUZ'],
      time: {kind: 'detected', value: '2026-11-15T00:00:00.000Z'},
      source: {provider: 'IMF PortWatch'},
    };
    const standaloneForecast = {
      id: 'forecast:polymarket:putin',
      kind: 'forecast',
      title: 'Putin out as President of Russia by June 30, 2027?',
      time: {kind: 'updated', value: '2026-11-18T06:39:00.000Z'},
      source: {provider: 'Polymarket'},
    };
    const oldNews = {
      id: 'rss:old-korea-hormuz',
      kind: 'news',
      title: 'South Korea to deploy military mission to keep Strait of Hormuz open',
      time: {kind: 'published', value: '2026-11-14T02:00:00.000Z'},
      source: {publisher: 'France 24'},
    };
    const newNews = {
      id: 'rss:qeshm-strike',
      kind: 'news',
      title: "US attacks Iran's Qeshm island in Strait of Hormuz, official says",
      time: {kind: 'published', value: '2026-11-17T16:52:00.000Z'},
      source: {publisher: 'Middle East Eye'},
    };

    const batch1 = await store.update([{
      id: 'evt_old',
      title: oldNews.title,
      topic: 'maritime_security',
      records: [{...oldNews, role: 'report'}, sharedSignal],
    }, {
      id: 'evt_old_fc',
      title: standaloneForecast.title,
      records: [standaloneForecast],
    }]);
    assert.equal(batch1.find(e => e.id === 'evt_old')?.id, 'evt_old');

    const [ev2] = await store.update([{
      id: 'evt_new',
      title: newNews.title,
      topic: 'maritime_security',
      records: [{...newNews, role: 'report'}, sharedSignal, standaloneForecast],
    }]);
    assert.equal(ev2.id, 'evt_new');
    assert.notEqual(ev2.id, 'evt_old');
    assert.notEqual(ev2.id, 'evt_old_fc');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('put recomputes metadata from full accumulated history and caps snowball span', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'event-store-recompute-'));
  try {
    const findPlaces = r => r.title.includes('Hormuz') ? ['CP_HORMUZ'] : [];
    const store = await openEventStore(join(directory, 'events.json'), findPlaces);

    const n1 = {
      id: 'rss:1', kind: 'news',
      title: 'Oil Tanker On Fire After Hitting Mine In Hormuz',
      time: {value: '2026-11-14T14:41:00.000Z'},
      source: {publisher: 'gCaptain'},
    };
    const n2 = {
      id: 'rss:2', kind: 'news',
      title: 'Iran says 2 oil tankers hit mines near Strait of Hormuz, 1 sinks',
      time: {value: '2026-11-15T15:04:00.000Z'},
      source: {publisher: 'Anadolu Ajansı'},
    };
    const n3 = {
      id: 'rss:3', kind: 'news',
      title: 'Oil tanker burns after mine strike in Strait of Hormuz',
      time: {value: '2026-11-16T03:21:00.000Z'},
      source: {publisher: 'Mehr News Agency'},
    };
    // 4 days after n1 (within 7-day vessel-attack crisis cap) — joins the same Hormuz vessel-attack card.
    const nDay4 = {
      id: 'rss:4', kind: 'news',
      title: 'Another oil tanker hits mine in Strait of Hormuz, fire erupts',
      time: {value: '2026-11-17T18:00:00.000Z'},
      source: {publisher: 'Reuters'},
    };
    const nDay4b = {
      id: 'rss:5', kind: 'news',
      title: 'Projectile Strikes Oil Tanker While Attempting to Exit Strait of Hormuz',
      time: {value: '2026-11-18T23:05:00.000Z'},
      source: {publisher: 'WANA News Agency'},
    };
    // 9 days after n1 (> 7-day vessel-attack cap) — must not snowball into the old event.
    const nTooLate = {
      id: 'rss:6', kind: 'news',
      title: 'Tanker hit by unknown projectile near Strait of Hormuz',
      time: {value: '2026-11-23T18:00:00.000Z'},
      source: {publisher: 'Al Jazeera'},
    };

    const [created] = await store.update(buildEvents([{records: [n1, n2]}], 'live', findPlaces));
    assert.equal(created.corroborationCount, 2);

    // Later snapshot contains only n3 (single article, no anchor title).
    const [updated] = await store.update(buildEvents([{records: [n3]}], 'live', findPlaces));
    assert.equal(updated.id, created.id);
    assert.equal(updated.title, n1.title);
    assert.equal(updated.corroborationCount, 3);
    assert.equal(updated.action, 'attack');
    assert.deepEqual(updated.geoAnchors, ['CP_HORMUZ']);

    await store.update(buildEvents([{records: [nDay4]}], 'live', findPlaces));
    const [continued] = await store.update(buildEvents([{records: [nDay4b]}], 'live', findPlaces));
    assert.equal(continued.id, created.id);
    assert.equal(continued.corroborationCount, 5);

    const [late] = await store.update(buildEvents([{records: [nTooLate]}], 'live', findPlaces));
    assert.notEqual(late.id, created.id);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('standalone rolling signals merge into one event across snapshots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'event-store-signals-'));
  try {
    const store = await openEventStore(join(directory, 'events.json'), () => []);
    const day1 = {
      id: 'signal:wmo:1', kind: 'signal',
      title: '严重气象预警：大雾（Ad Dammam）',
      geoAnchors: ['PORT_DAMMAM'],
      time: {kind: 'detected', value: '2026-11-17T15:08:00.000Z'},
      source: {provider: 'WMO SWIC'},
    };
    const day2 = {
      id: 'signal:wmo:2', kind: 'signal',
      title: '极端气象预警：大雾（Ad Dammam）',
      geoAnchors: ['PORT_DAMMAM'],
      time: {kind: 'detected', value: '2026-11-18T17:12:00.000Z'},
      source: {provider: 'WMO SWIC'},
    };
    const [first] = await store.update(buildEvents([{kind: 'signal', records: [day1]}], 'live'));
    const [second] = await store.update(buildEvents([{kind: 'signal', records: [day2]}], 'live'));
    assert.equal(second.id, first.id);
    assert.equal(second.records.length, 2);
    assert.equal(second.title, day2.title);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('rebuildEventStore splits corrupted blackhole events, drops orphan forecasts and cross-country WMO alerts, and preserves grounded titles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'event-store-rebuild-'));
  try {
    const storePath = join(directory, 'events.json');
    const intakeConfigPath = join(directory, 'intake-settings.json');
    const korea = {
      id: 'rss:korea',
      kind: 'news',
      role: 'report',
      title: 'South Korea to deploy military mission to keep Strait of Hormuz open',
      time: {kind: 'published', value: '2026-11-05T02:17:00.000Z'},
      source: {publisher: 'France 24'},
    };
    const qeshm = {
      id: 'rss:qeshm',
      kind: 'news',
      role: 'report',
      title: "US attacks Iran's Qeshm island in Strait of Hormuz, official says",
      time: {kind: 'published', value: '2026-11-17T16:52:00.000Z'},
      source: {publisher: 'Middle East Eye'},
    };
    const portwatch = {
      id: 'signal:portwatch:CP_HORMUZ:2026-11-15',
      kind: 'signal',
      title: '霍尔木兹海峡船舶通行量异动',
      geoAnchors: ['CP_HORMUZ'],
      time: {kind: 'detected', value: '2026-11-15T00:00:00.000Z'},
      source: {provider: 'IMF PortWatch'},
    };
    const badWmo = {
      id: 'signal:wmo:co-algeciras',
      kind: 'signal',
      title: '严重气象预警：森林火险（Algeciras）',
      geoAnchors: ['PORT_ALGECIRAS'],
      time: {kind: 'detected', value: '2026-11-18T20:30:00.000Z'},
      source: {provider: 'WMO SWIC', url: 'https://severeweather.wmo.int/co-ideam-es/2026/11/18/alert.xml'},
    };
    const orphanForecast = {
      id: 'forecast:polymarket:putin',
      kind: 'forecast',
      title: 'Putin out as President of Russia by June 30, 2027?',
      time: {kind: 'updated', value: '2026-11-18T06:39:00.000Z'},
      source: {provider: 'Polymarket'},
    };

    await writeFile(storePath, JSON.stringify({
      version: 1,
      events: [
        {
          id: 'evt_dirty_blackhole',
          title: korea.title,
          topic: 'maritime_security',
          records: [korea, portwatch, qeshm],
          presentation: {
            title: '韩国将向霍尔木兹海峡附近部署军事任务',
            titleEvidence: {recordId: korea.id, quote: 'South Korea to deploy military mission'},
            update: {text: '旧的脏进展', occurredAt: '2026-11-17', precision: 'day', recordId: qeshm.id},
            processedIds: [qeshm.id],
            model: 'test-model',
          },
          revision: 12,
        },
        {
          id: 'evt_bad_wmo',
          title: badWmo.title,
          topic: 'natural_hazard',
          geoAnchors: ['PORT_ALGECIRAS'],
          records: [badWmo],
          revision: 1,
        },
        {
          id: 'evt_orphan_fc',
          title: orphanForecast.title,
          records: [orphanForecast],
          revision: 1,
        },
      ],
    }));

    const result = await rebuildEventStore({storePath, intakeConfigPath});
    assert.equal(result.skipped, false);
    assert.equal(result.beforeActive, 3);
    assert.equal(result.afterActive, 2); // korea separated from qeshm+portwatch; bad WMO and orphan forecast dropped
    assert.equal(result.restoredTitleOnly, 1);

    const files = await readdir(directory);
    assert.ok(files.some(name => name.startsWith('events.before-rebuild.')), 'backup file created');

    const rebuilt = JSON.parse(await readFile(storePath, 'utf8'));
    assert.equal(rebuilt.events.length, 2);
    assert.ok(!rebuilt.events.some(e => e.records.some(r => r.id === badWmo.id)), 'cross-country WMO dropped');
    assert.ok(!rebuilt.events.some(e => e.records.some(r => r.id === orphanForecast.id)), 'orphan forecast dropped');

    const koreaEvent = rebuilt.events.find(e => e.records.some(r => r.id === korea.id));
    assert.equal(koreaEvent.records.length, 1);
    assert.equal(koreaEvent.presentation.title, '韩国将向霍尔木兹海峡附近部署军事任务');
    assert.equal(koreaEvent.presentation.update, null);

    const qeshmEvent = rebuilt.events.find(e => e.records.some(r => r.id === qeshm.id));
    assert.notEqual(qeshmEvent.id, koreaEvent.id);
    assert.ok(qeshmEvent.records.some(r => r.id === portwatch.id), 'portwatch attaches to matching recent Hormuz event only');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('retainNewsMs keeps recent untouched news events without resurrecting old news, signals, forecasts, or merged redirects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'event-store-retain-'));
  try {
    const storePath = join(directory, 'events.json');
    const now = Date.parse('2026-11-19T08:00:00.000Z');
    const isoHoursAgo = hours => new Date(now - hours * 3600_000).toISOString();

    const recentNews = {
      id: 'rss:recent-hormuz-closure',
      kind: 'news',
      title: 'Iran Declares Strait of Hormuz Closed as Vessel Hit',
      time: {kind: 'published', value: isoHoursAgo(10)},
      source: {publisher: 'EnergyNow.com'},
    };
    const oldNews = {
      id: 'rss:old-suez-delay',
      kind: 'news',
      title: 'Suez Canal container ship briefly delayed before resuming transit',
      time: {kind: 'published', value: isoHoursAgo(60)},
      source: {publisher: 'gCaptain'},
    };
    const mergeA = {
      id: 'rss:merge-a',
      kind: 'news',
      title: 'US flight authority orders national ground stop',
      time: {kind: 'published', value: isoHoursAgo(14)},
      source: {publisher: 'Reuters'},
    };
    const mergeB = {
      id: 'rss:merge-b',
      kind: 'news',
      title: 'US flights resume after nationwide ground stop lifted',
      time: {kind: 'published', value: isoHoursAgo(12)},
      source: {publisher: 'AP'},
    };
    const standaloneSignal = {
      id: 'signal:portwatch:PORT_YANTIAN:2026-11-19',
      kind: 'signal',
      title: '盐田港船舶通行量异动',
      geoAnchors: ['PORT_YANTIAN'],
      time: {kind: 'detected', value: isoHoursAgo(5)},
      source: {provider: 'IMF PortWatch'},
    };
    const standaloneForecast = {
      id: 'forecast:polymarket:hormuz-recent',
      kind: 'forecast',
      title: 'Will Iran close the Strait of Hormuz in 2026?',
      time: {kind: 'updated', value: isoHoursAgo(2)},
      source: {provider: 'Polymarket'},
    };
    const freshNews = {
      id: 'rss:fresh-rotterdam-strike',
      kind: 'news',
      title: 'Rotterdam dockworkers begin 48-hour strike at container terminals',
      time: {kind: 'published', value: isoHoursAgo(1)},
      source: {publisher: 'BBC World'},
    };

    const store = await openEventStore(storePath, () => []);
    const [evtA] = await store.update([{id: 'evt_merge_a', title: mergeA.title, topic: 'transport_disruption', records: [{...mergeA, role: 'report'}]}]);
    const [evtB] = await store.update([{id: 'evt_merge_b', title: mergeB.title, records: [{...mergeB, role: 'report'}]}]);
    assert.notEqual(evtA.id, evtB.id);

    await store.update([
      ...buildEvents([{records: [recentNews, oldNews, mergeA, mergeB]}], 'live'),
      ...buildEvents([{kind: 'signal', records: [standaloneSignal]}], 'live'),
      {id: 'evt_standalone_fc', title: standaloneForecast.title, records: [standaloneForecast], updatedAt: standaloneForecast.time.value},
    ]);

    const freshBatch = buildEvents([{records: [freshNews]}], 'live');
    const retained = await store.update(freshBatch, {retainNewsMs: 48 * 3600_000, now});
    const retainedIds = retained.map(event => event.id);

    assert.equal(new Set(retainedIds).size, retainedIds.length, 'no duplicate IDs returned');
    assert.equal(retained[0].records[0].id, freshNews.id, 'sorted by updatedAt descending');
    assert.ok(retained.some(event => event.records.some(r => r.id === recentNews.id)), 'retains recent untouched news event');
    assert.ok(retained.some(event => event.id === evtA.id && !event.mergedInto), 'keeps surviving merged event');
    assert.ok(!retained.some(event => event.id === evtB.id || event.mergedInto), 'does not return merged redirect');
    assert.ok(!retained.some(event => event.records?.some(r => r.id === oldNews.id)), 'excludes news older than retainNewsMs');
    assert.ok(!retained.some(event => event.records?.some(r => r.id === standaloneSignal.id)), 'never retains untouched standalone signal');
    assert.ok(!retained.some(event => event.records?.some(r => r.id === standaloneForecast.id)), 'never retains untouched standalone forecast');

    const touchedOnly = await store.update(freshBatch);
    assert.equal(touchedOnly.length, 1);
    assert.equal(touchedOnly[0].records[0].id, freshNews.id);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('prune removes expired events and dangling merge redirects from disk while preserving active redirects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'event-store-prune-'));
  try {
    const storePath = join(directory, 'events.json');
    const now = Date.parse('2026-11-23T02:00:00.000Z');
    const isoDaysAgo = days => new Date(now - days * 24 * 3600_000).toISOString();

    const store = await openEventStore(storePath, () => []);
    await store.update([
      {
        id: 'evt_old_target',
        title: 'Old target',
        updatedAt: isoDaysAgo(10.1),
        records: [{id: 'rss:old-1', kind: 'news', role: 'report', title: 'Old target', time: {kind: 'published', value: isoDaysAgo(10.1)}}],
      },
      {
        id: 'evt_recent_target',
        title: 'Recent target',
        updatedAt: isoDaysAgo(2.1),
        records: [{id: 'rss:recent-1', kind: 'news', role: 'report', title: 'Recent target', time: {kind: 'published', value: isoDaysAgo(2.1)}}],
      },
    ]);

    // Trigger merges so redirect entries exist for both old and recent targets.
    await store.update([
      {
        id: 'evt_old_merged',
        title: 'Old merged',
        updatedAt: isoDaysAgo(10),
        records: [{id: 'rss:old-2', kind: 'news', role: 'report', title: 'Old merged', time: {kind: 'published', value: isoDaysAgo(10)}}],
      },
      {
        id: 'evt_recent_merged',
        title: 'Recent merged',
        updatedAt: isoDaysAgo(2),
        records: [{id: 'rss:recent-2', kind: 'news', role: 'report', title: 'Recent merged', time: {kind: 'published', value: isoDaysAgo(2)}}],
      },
    ]);
    await store.update([
      {
        id: 'evt_old_combine',
        title: 'Old combined',
        records: [
          {id: 'rss:old-1', kind: 'news', role: 'report', title: 'Old target', time: {kind: 'published', value: isoDaysAgo(10.1)}},
          {id: 'rss:old-2', kind: 'news', role: 'report', title: 'Old merged', time: {kind: 'published', value: isoDaysAgo(10)}},
        ],
      },
      {
        id: 'evt_recent_combine',
        title: 'Recent combined',
        records: [
          {id: 'rss:recent-1', kind: 'news', role: 'report', title: 'Recent target', time: {kind: 'published', value: isoDaysAgo(2.1)}},
          {id: 'rss:recent-2', kind: 'news', role: 'report', title: 'Recent merged', time: {kind: 'published', value: isoDaysAgo(2)}},
        ],
      },
    ]);

    const first = await store.prune({maxAgeMs: 7 * 24 * 3600_000, now});
    assert.equal(first.removed, 2, 'removes both expired target and its redirect');
    assert.equal(first.remaining, 2, 'keeps recent target and its redirect');
    assert.equal(store.get('evt_old_target'), undefined);
    assert.equal(store.get('evt_old_merged'), undefined);
    assert.equal(store.get('evt_recent_target')?.id, 'evt_recent_target');
    assert.equal(store.get('evt_recent_merged')?.id, 'evt_recent_target');

    const second = await store.prune({maxAgeMs: 7 * 24 * 3600_000, now});
    assert.equal(second.removed, 0, 'subsequent prune is a no-op');
    assert.equal(second.remaining, 2);

    const reopened = await openEventStore(storePath, () => []);
    assert.equal(reopened.get('evt_old_target'), undefined);
    assert.equal(reopened.get('evt_recent_merged')?.id, 'evt_recent_target');
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
