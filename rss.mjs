// Public RSS intake. Parsing, charset decoding, the date gate and the body cap
// come from WorldMonitor's news digest; this module only fetches the curated
// feed list and keeps a per-feed cache like the digest's refresh loop.
import {readFileSync} from 'node:fs';
import {readBoundedResponseBody} from './vendor/worldmonitor/bounded-body.ts';
import {
  RSS_MAX_BODY_BYTES, asciiLower, decodeFeedBody, extractDescription, extractFirstDateTag,
  extractTag, looksLikeRssXml, scanTagBlocks, usableFeedDateMs,
} from './vendor/worldmonitor/feed-xml.ts';

export const FEEDS = JSON.parse(readFileSync(new URL('./data/news-sources.json', import.meta.url), 'utf8'));
const ITEMS_PER_FEED = 30;
const FETCH_TIMEOUT_MS = 8000;
// Same refresh interval as WorldMonitor's FEED_REFRESH_AFTER_MS.
export const FEED_REFRESH_AFTER_MS = 5 * 60_000;
// Failed feeds use a shorter cooldown so transient/cold-start errors recover quickly
// without hammering permanently broken feeds on every request.
export const FEED_ERROR_RETRY_MS = 30_000;
const USER_AGENT = 'SupplyChainRiskRadar/0.2';
const isAggregator = url => new URL(url).hostname === 'news.google.com';

/** One feed body into digest-shaped items. Mirrors the per-item steps of upstream parseRssXml. */
export function parseFeed(xml, feed) {
  const lower = asciiLower(xml);
  let blocks = scanTagBlocks(xml, lower, 'item');
  const isAtom = blocks.length === 0;
  if (isAtom) blocks = scanTagBlocks(xml, lower, 'entry');
  const aggregator = !isAtom && isAggregator(feed.url);
  const items = [];
  for (const block of blocks.slice(0, ITEMS_PER_FEED)) {
    const blockLower = asciiLower(block);
    let title = extractTag(block, 'title', blockLower);
    if (!title) continue;
    let link = isAtom ? block.match(/<link[^<>]+href=["']([^"']+)["']/)?.[1] ?? '' : extractTag(block, 'link', blockLower);
    link = link.replace(/^https?:\/\/[^/?#*]+\/[^*?#]*\*(?=https?:\/\/)/i, '');
    if (!/^https?:\/\//i.test(link)) continue;
    const publishedAt = usableFeedDateMs(extractFirstDateTag(block, isAtom, blockLower));
    if (publishedAt === null) continue;
    let source = feed.name;
    if (aggregator) {
      // Google News names the originating publisher and repeats it after the headline.
      source = extractTag(block, 'source', blockLower).slice(0, 200) || source;
      const suffix = ' - ' + source;
      if (title.endsWith(suffix) && title.length > suffix.length) title = title.slice(0, -suffix.length);
    }
    items.push({
      title, link, source, publishedAt,
      feedName:feed.name, feedCategory:feed.category,
      snippet:extractDescription(block, isAtom, title, blockLower),
    });
  }
  return items;
}

async function fetchFeed(feed, validators) {
  const headers = {'user-agent':USER_AGENT, accept:'application/rss+xml, application/atom+xml, application/xml, text/xml, */*'};
  if (validators?.etag) headers['if-none-match'] = validators.etag;
  if (validators?.lastModified) headers['if-modified-since'] = validators.lastModified;
  const response = await fetch(feed.url, {headers, signal:AbortSignal.timeout(FETCH_TIMEOUT_MS)});
  if (response.status === 304 && validators) return {notModified:true};
  if (!response.ok) throw Error(`HTTP ${response.status}`);
  const text = decodeFeedBody(await readBoundedResponseBody(response, RSS_MAX_BODY_BYTES), response.headers.get('content-type'));
  if (!looksLikeRssXml(text)) throw Error('not an RSS or Atom feed');
  const etag = response.headers.get('etag') ?? undefined;
  const lastModified = response.headers.get('last-modified') ?? undefined;
  return {items:parseFeed(text, feed), validators:etag || lastModified ? {etag, lastModified} : undefined};
}

/**
 * Feeds are refreshed at most every five minutes and in parallel; concurrent
 * callers share one in-flight refresh. A failed refresh keeps the last good
 * items and reports the error alongside them.
 */
export function createFeedReader(feeds = FEEDS, {
  refreshAfterMs = FEED_REFRESH_AFTER_MS,
  errorRetryMs = FEED_ERROR_RETRY_MS,
  now = Date.now,
} = {}) {
  const cache = new Map();
  async function refresh(feed, force) {
    const entry = cache.get(feed.url);
    if (entry?.inFlight) return entry.inFlight;
    const ttl = entry?.error ? Math.min(refreshAfterMs, errorRetryMs) : refreshAfterMs;
    if (entry && !force && now() - entry.checkedAt < ttl) return entry;
    const inFlight = fetchFeed(feed, entry?.validators).then(result => {
      const next = result.notModified
        ? {...entry, checkedAt:now(), error:null}
        : {items:result.items, validators:result.validators, checkedAt:now(), error:null};
      cache.set(feed.url, next);
      return next;
    }, error => {
      const next = {items:entry?.items ?? [], validators:entry?.validators, checkedAt:now(),
        error:error.name === 'TimeoutError' ? 'timeout' : error.cause?.code || error.message};
      cache.set(feed.url, next);
      return next;
    });
    cache.set(feed.url, {...entry, inFlight});
    return inFlight;
  }
  return async function read({force = false} = {}) {
    const results = await Promise.all(feeds.map(feed => refresh(feed, force)));
    const categories = {};
    const feedStatus = feeds.map((feed, index) => {
      const {items, error} = results[index];
      (categories[feed.category] ??= {items:[]}).items.push(...items);
      return {name:feed.name, url:feed.url, category:feed.category, count:items.length, error};
    });
    return {categories, feedStatus};
  };
}
