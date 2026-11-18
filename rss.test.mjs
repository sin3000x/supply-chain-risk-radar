import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createFeedReader, parseFeed} from './rss.mjs';
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
