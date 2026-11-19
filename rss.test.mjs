import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createFeedReader, parseFeed, resolveFeedMeta} from './rss.mjs';
import {normalize} from './feed.mjs';

const rss = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Feed</title>
<item><title>Port of Rotterdam strike &amp; delays - Example Wire</title><link>https://example.com/a?utm_source=x</link>
<pubDate>Mon, 16 Nov 2026 10:00:00 CET</pubDate><source url="https://example.com">Example Wire</source>
<description><![CDATA[<p>Dockworkers at two terminals plan a stoppage on Friday as talks continue.</p>]]></description></item>
<item><title>Undated item</title><link>https://example.com/b</link></item>
<item><title>Bad link</title><link>javascript:alert(1)</link><pubDate>Mon, 16 Nov 2026 10:00:00 GMT</pubDate></item>
</channel></rss>`;

test('parses RSS with upstream entity, date-zone, and description rules', () => {
  const items = parseFeed(rss,{name:'Google News',category:'shipping',url:'https://news.google.com/rss/search?q=x'});
  assert.equal(items.length,1);
  assert.equal(items[0].title,'Port of Rotterdam strike & delays');
  assert.equal(items[0].source,'Example Wire');
  assert.equal(new Date(items[0].publishedAt).toISOString(),'2026-11-16T09:00:00.000Z');
  assert.equal(items[0].snippet,'Dockworkers at two terminals plan a stoppage on Friday as talks continue.');
});

test('parses Atom entries', () => {
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Canal closes</title>
<link rel="alternate" href="https://example.org/canal"/><updated>2026-11-16T01:00:00Z</updated></entry></feed>`;
  const [item] = parseFeed(atom,{name:'Atom',category:'world',url:'https://example.org/feed'});
  assert.equal(item.link,'https://example.org/canal');
});

test('normalize drops tracking-parameter duplicates across feeds', () => {
  const item = {title:'A',link:'https://example.com/a?utm_source=x',publishedAt:1};
  const records = normalize('news',{categories:{a:{items:[item]},b:{items:[{...item,link:'https://example.com/a'}]}}});
  assert.equal(records.length,1);
});

test('feed reader caches, revalidates with ETag, and keeps items on failure', async () => {
  let hits = 0, mode = 'ok';
  const server = createServer((req,res) => {
    hits++;
    if (mode === 'fail') {res.writeHead(500); res.end(); return;}
    if (req.headers['if-none-match'] === '"v1"') {res.writeHead(304); res.end(); return;}
    res.writeHead(200,{'content-type':'application/rss+xml',etag:'"v1"'}); res.end(rss);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    let clock = 0;
    const feed = {name:'Local',category:'world',url:`http://127.0.0.1:${server.address().port}/feed`};
    const read = createFeedReader([feed],{refreshAfterMs:1000,now:()=>clock});
    const [first,second] = await Promise.all([read(),read()]);
    assert.equal(hits,1);
    assert.equal(first.feedStatus[0].count,1);
    assert.deepEqual(second,first);
    await read();
    assert.equal(hits,1);
    clock = 2000;
    const revalidated = await read();
    assert.equal(hits,2);
    assert.equal(revalidated.categories.world.items.length,1);
    mode = 'fail';
    const failed = await read({force:true});
    assert.equal(failed.feedStatus[0].error,'HTTP 500');
    assert.equal(failed.feedStatus[0].count,1);
  } finally {
    server.close();
  }
});

test('feed reader uses shorter retry cooldown after failure', async () => {
  let mode = 'fail';
  let hits = 0;
  const rss = '<rss version="2.0"><channel><item><title>Port reopened</title><link>https://example.com/1</link><pubDate>Wed, 18 Nov 2026 00:00:00 GMT</pubDate></item></channel></rss>';
  const server = createServer((_req,res)=>{
    hits++;
    if (mode === 'fail') {res.writeHead(500); res.end(); return;}
    res.writeHead(200,{'content-type':'application/rss+xml'}); res.end(rss);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    let clock = 0;
    const feed = {name:'Local',category:'world',url:`http://127.0.0.1:${server.address().port}/feed`};
    const read = createFeedReader([feed],{refreshAfterMs:60_000,errorRetryMs:1000,now:()=>clock});

    const first = await read();
    assert.equal(first.feedStatus[0].error,'HTTP 500');
    assert.equal(hits,1);

    // Within errorRetryMs: returns cached error without hitting upstream.
    clock = 500;
    const withinCooldown = await read();
    assert.equal(withinCooldown.feedStatus[0].error,'HTTP 500');
    assert.equal(hits,1);

    // Past errorRetryMs (still well within refreshAfterMs): retries and recovers.
    mode = 'ok';
    clock = 1000;
    const recovered = await read();
    assert.equal(recovered.feedStatus[0].error,null);
    assert.equal(recovered.feedStatus[0].count,1);
    assert.equal(hits,2);
  } finally {
    server.close();
  }
});

test('resolveFeedMeta parses Google News window/scope and applies custom window override', () => {
  const gnews = {
    name: 'Trade & Tariffs',
    category: 'trade',
    url: 'https://news.google.com/rss/search?q=(tariff+OR+%22trade+war%22)+when:2d&hl=en-US&gl=US&ceid=US:en',
  };
  const defMeta = resolveFeedMeta(gnews);
  assert.equal(defMeta.window, '2d');
  assert.equal(defMeta.defaultWindow, '2d');
  assert.equal(defMeta.scope, 'tariff / "trade war"');
  assert.equal(defMeta.url, gnews.url);

  const customMeta = resolveFeedMeta(gnews, {googleNewsWindowDays: 10});
  assert.equal(customMeta.window, '10d');
  assert.match(customMeta.url, /when%3A10d|when:10d/);

  const directMeta = resolveFeedMeta({name: 'BBC', category: 'world', url: 'https://feeds.bbci.co.uk/news/world/rss.xml'});
  assert.equal(directMeta.window, '直连 RSS');
  assert.equal(directMeta.scope, 'bbci.co.uk');
});

test('createFeedReader filters stale items by newsMaxAgeHours', async () => {
  const nowMs = Date.parse('2026-11-18T12:00:00Z');
  const agedRss = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>
    <item><title>Recent port delay</title><link>https://example.com/recent</link><pubDate>Wed, 18 Nov 2026 08:00:00 GMT</pubDate></item>
    <item><title>Old port delay</title><link>https://example.com/old</link><pubDate>Mon, 16 Nov 2026 08:00:00 GMT</pubDate></item>
  </channel></rss>`;
  const server = createServer((_req, res) => {
    res.writeHead(200, {'content-type': 'application/rss+xml'});
    res.end(agedRss);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    let maxAgeHours = 24;
    const feed = {name: 'Local', category: 'shipping', url: `http://127.0.0.1:${server.address().port}/feed`};
    const read = createFeedReader([feed], {now: () => nowMs, getSettings: () => ({newsMaxAgeHours: maxAgeHours})});
    const filtered = await read();
    assert.equal(filtered.feedStatus[0].count, 1);
    assert.equal(filtered.categories.shipping.items[0].title, 'Recent port delay');

    maxAgeHours = 0;
    const unfiltered = await read();
    assert.equal(unfiltered.feedStatus[0].count, 2);
  } finally {
    server.close();
  }
});

test('createFeedReader reports timeout cleanly and limits per-host concurrency', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const server = createServer((req, res) => {
    if (req.url === '/slow') {
      // Never respond; let fetchTimeoutMs abort it.
      return;
    }
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    setTimeout(() => {
      inFlight--;
      res.writeHead(200, {'content-type': 'application/rss+xml'});
      res.end(rss);
    }, 35);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address();
  try {
    const feeds = [
      {name: 'F1', category: 'world', url: `http://127.0.0.1:${port}/f1`},
      {name: 'F2', category: 'world', url: `http://127.0.0.1:${port}/f2`},
      {name: 'F3', category: 'world', url: `http://127.0.0.1:${port}/f3`},
      {name: 'F4', category: 'world', url: `http://127.0.0.1:${port}/f4`},
      {name: 'F5', category: 'world', url: `http://127.0.0.1:${port}/f5`},
    ];
    const read = createFeedReader(feeds, {maxConcurrentPerHost: 2, fetchTimeoutMs: 500});
    const result = await read();
    assert.equal(result.feedStatus.every(f => f.error === null && f.count === 1), true);
    assert.ok(maxInFlight <= 2, `expected maxInFlight <= 2, got ${maxInFlight}`);

    const readSlow = createFeedReader(
      [{name: 'Slow', category: 'world', url: `http://127.0.0.1:${port}/slow`}],
      {fetchTimeoutMs: 60},
    );
    const slowResult = await readSlow();
    assert.equal(slowResult.feedStatus[0].error, 'timeout');
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});

test('normalize deduplicates same-publisher same-headline items while preferring direct URLs', () => {
  const publishedAt = '2026-11-17T20:14:20.000Z';
  const gnews = {
    title: 'U.S. Military Strikes Iranian Missile Site Near Strait of Hormuz',
    link: 'https://news.google.com/rss/articles/CBMi123?oc=5',
    source: 'gCaptain',
    publishedAt,
  };
  const direct = {
    title: 'U.S. Military Strikes Iranian Missile Site Near Strait of Hormuz',
    link: 'https://gcaptain.com/u-s-military-strikes-iranian-missile-site/',
    source: 'gCaptain',
    publishedAt,
  };
  const otherOutlet = {
    title: 'U.S. Military Strikes Iranian Missile Site Near Strait of Hormuz',
    link: 'https://reuters.com/world/us-strikes-iran-site',
    source: 'Reuters',
    publishedAt,
  };

  const records = normalize('news', {categories: {a: {items: [gnews, otherOutlet]}, b: {items: [direct]}}});
  assert.equal(records.length, 2);
  assert.equal(records[0].source.url, direct.link);
  assert.equal(records[1].source.publisher, 'Reuters');
});
