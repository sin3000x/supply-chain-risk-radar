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

/** Resolve effective feed URL, time window label, and human-readable query scope. */
export function resolveFeedMeta(feed, {googleNewsWindowDays = 0} = {}) {
  const parsed = new URL(feed.url);
  if (parsed.hostname !== 'news.google.com') {
    const host = parsed.hostname.replace(/^(www|feeds|rss)\./i, '');
    return {
      url: feed.url,
      window: '直连 RSS',
      defaultWindow: '直连 RSS',
      scope: host,
    };
  }
  const rawQ = parsed.searchParams.get('q') ?? '';
  const defaultMatch = rawQ.match(/\bwhen:(\d+[dh])\b/i);
  const defaultWindow = defaultMatch ? defaultMatch[1].toLowerCase() : '默认';
  let effectiveUrl = feed.url;
  let window = defaultWindow;
  if (Number.isFinite(googleNewsWindowDays) && googleNewsWindowDays > 0) {
    const nextWindow = `${Math.round(googleNewsWindowDays)}d`;
    const nextQ = defaultMatch
      ? rawQ.replace(/\bwhen:\d+[dh]\b/i, `when:${nextWindow}`)
      : `${rawQ} when:${nextWindow}`.trim();
    const cloned = new URL(feed.url);
    cloned.searchParams.set('q', nextQ);
    effectiveUrl = cloned.toString();
    window = nextWindow;
  }
  const stripped = rawQ.replace(/\bwhen:\d+[dh]\b/gi, '').replace(/\s+/g, ' ').trim();
  const unwrapped = stripped.replace(/^\(([^()]+)\)$/, '$1').trim();
  const scope = (unwrapped.replace(/\s+OR\s+/g, ' / ') || 'Google News').trim();
  return {url: effectiveUrl, window, defaultWindow, scope};
}

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
  getSettings = () => ({}),
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
    const {googleNewsWindowDays = 0, newsMaxAgeHours = 0} = getSettings() ?? {};
    const resolved = feeds.map(feed => ({feed, meta: resolveFeedMeta(feed, {googleNewsWindowDays})}));
    const results = await Promise.all(resolved.map(({feed, meta}) => refresh({...feed, url: meta.url}, force)));
    const cutoffMs = newsMaxAgeHours > 0 ? now() - newsMaxAgeHours * 3600_000 : null;
    const categories = {};
    const feedStatus = resolved.map(({feed, meta}, index) => {
      const {items, error} = results[index];
      const filteredItems = cutoffMs === null ? items : items.filter(item => item.publishedAt >= cutoffMs);
      (categories[feed.category] ??= {items:[]}).items.push(...filteredItems);
      return {
        name: feed.name,
        url: meta.url,
        category: feed.category,
        count: filteredItems.length,
        error,
        window: meta.window,
        defaultWindow: meta.defaultWindow,
        scope: meta.scope,
      };
    });
    return {categories, feedStatus};
  };
}
