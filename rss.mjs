// Public RSS intake. Parsing, charset decoding, the date gate and the body cap
// come from WorldMonitor's news digest; this module only fetches the curated
// feed list and keeps a per-feed cache like the digest's refresh loop.
import {readFileSync} from 'node:fs';
import {readBoundedResponseBody} from './vendor/worldmonitor/bounded-body.ts';
import {
  RSS_MAX_BODY_BYTES, asciiLower, decodeFeedBody, extractDescription, extractFirstDateTag,
  extractTag, looksLikeRssXml, scanTagBlocks, usableFeedDateMs,
} from './vendor/worldmonitor/feed-xml.ts';

const defaultFeedsPath = process.env.NEWS_SOURCES_PATH || new URL('./data/news-sources.json', import.meta.url);
export const FEEDS = JSON.parse(readFileSync(defaultFeedsPath, 'utf8'));
const ITEMS_PER_FEED = 30;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_CONCURRENT_PER_HOST = 3;
// Same refresh interval as WorldMonitor's FEED_REFRESH_AFTER_MS.
export const FEED_REFRESH_AFTER_MS = 5 * 60_000;
// Failed feeds use a shorter cooldown so transient/cold-start errors recover quickly
// without hammering permanently broken feeds on every request.
export const FEED_ERROR_RETRY_MS = 30_000;
const USER_AGENT = 'SupplyChainRiskRadar/0.2';
const isAggregator = url => new URL(url).hostname === 'news.google.com';

const NAMED_ENTITIES = {nbsp:' ', amp:'&', quot:'"', apos:"'", lt:'<', gt:'>', ndash:'–', mdash:'—', hellip:'…',
  lsquo:'‘', rsquo:'’', ldquo:'“', rdquo:'”'};
const decodeResidualEntities = text => text
  .replace(/&#x([0-9a-f]+);/gi, (m, hex) => { const cp = parseInt(hex, 16); return cp <= 0x10ffff ? String.fromCodePoint(cp) : m; })
  .replace(/&#(\d+);/g, (m, dec) => { const cp = Number(dec); return cp <= 0x10ffff ? String.fromCodePoint(cp) : m; })
  .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
const comparable = text => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Google News descriptions are HTML that is entity-escaped twice, so after the shared parser runs they still
 * read "Headline &nbsp;&nbsp; Publisher". Decode the leftover entities, drop the trailing publisher and
 * return '' when what remains only repeats the headline.
 */
export function cleanSnippet(snippet, title, source = '') {
  let text = decodeResidualEntities(snippet ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  if (source) {
    const suffix = source.trim();
    if (suffix && text.toLowerCase().endsWith(suffix.toLowerCase())) text = text.slice(0, -suffix.length).trim();
  }
  text = text.replace(/[\s\-–—|·]+$/, '').trim();
  const head = comparable(title ?? '');
  const body = comparable(text);
  if (!body || body === head || (head && head.startsWith(body))) return '';
  // Snippet is "Headline + a few trailing words": keep only the extra part if meaningful.
  if (head && body.startsWith(head)) {
    const rest = text.slice(Math.min(text.length, (title ?? '').length)).replace(/^[\s\-–—|·:.]+/, '').trim();
    return comparable(rest).length >= 20 ? rest : '';
  }
  return text;
}

// Social posts and link shares are not reports: no headline, a raw URL, or a social network as publisher.
const SOCIAL_PUBLISHERS = /^(?:facebook|instagram|x|twitter|x\.com|threads|tiktok|youtube|reddit|linkedin|telegram|bluesky)$/i;
export function isJunkItem(title, source = '') {
  const text = (title ?? '').trim();
  if (SOCIAL_PUBLISHERS.test((source ?? '').trim())) return true;
  if (/https?:\/\/|\bwww\.\S+\.\w{2,}/i.test(text)) return true;
  if (/^[^.!?]{2,60}\.\s*\.\s/.test(text)) return true; // "Washington Post. . Lewis Pugh ..."
  return text.length > 220;
}

function formatFetchError(error) {
  if (error?.name === 'TimeoutError' || error?.cause?.name === 'TimeoutError') return 'timeout';
  const code = error?.cause?.code;
  if (typeof code === 'string' && code) return code;
  return error?.message || 'fetch failed';
}

function createHostLimiter(limit) {
  const active = new Map();
  const queues = new Map();
  return async function runLimited(host, task) {
    if (!Number.isFinite(limit) || limit <= 0) return task();
    const count = active.get(host) ?? 0;
    if (count >= limit) {
      await new Promise(resolve => {
        const q = queues.get(host) ?? [];
        q.push(resolve);
        queues.set(host, q);
      });
    }
    active.set(host, (active.get(host) ?? 0) + 1);
    try {
      return await task();
    } finally {
      const remaining = (active.get(host) ?? 1) - 1;
      const q = queues.get(host);
      if (q?.length) {
        active.set(host, remaining);
        q.shift()();
      } else {
        if (remaining <= 0) active.delete(host);
        else active.set(host, remaining);
        queues.delete(host);
      }
    }
  };
}

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
    title = decodeResidualEntities(title).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
    if (isJunkItem(title, source)) continue;
    items.push({
      title, link, source, publishedAt,
      feedName:feed.name, feedCategory:feed.category,
      snippet:cleanSnippet(extractDescription(block, isAtom, title, blockLower), title, source),
    });
  }
  return items;
}

async function fetchFeed(feed, validators, timeoutMs = FETCH_TIMEOUT_MS) {
  const headers = {'user-agent':USER_AGENT, accept:'application/rss+xml, application/atom+xml, application/xml, text/xml, */*'};
  if (validators?.etag) headers['if-none-match'] = validators.etag;
  if (validators?.lastModified) headers['if-modified-since'] = validators.lastModified;
  const response = await fetch(feed.url, {headers, signal:AbortSignal.timeout(timeoutMs)});
  if (response.status === 304 && validators) return {notModified:true};
  if (!response.ok) throw Error(`HTTP ${response.status}`);
  const text = decodeFeedBody(await readBoundedResponseBody(response, RSS_MAX_BODY_BYTES), response.headers.get('content-type'));
  if (!looksLikeRssXml(text)) throw Error('not an RSS or Atom feed');
  const etag = response.headers.get('etag') ?? undefined;
  const lastModified = response.headers.get('last-modified') ?? undefined;
  return {items:parseFeed(text, feed), validators:etag || lastModified ? {etag, lastModified} : undefined};
}

/**
 * Feeds are refreshed at most every five minutes and in parallel (throttled per
 * host so aggregator bursts do not time out); concurrent callers share one
 * in-flight refresh. A failed refresh keeps the last good items and reports the
 * error alongside them.
 */
export function createFeedReader(feeds = FEEDS, {
  refreshAfterMs = FEED_REFRESH_AFTER_MS,
  errorRetryMs = FEED_ERROR_RETRY_MS,
  fetchTimeoutMs = FETCH_TIMEOUT_MS,
  maxConcurrentPerHost = MAX_CONCURRENT_PER_HOST,
  now = Date.now,
  getSettings = () => ({}),
} = {}) {
  const cache = new Map();
  const runLimited = createHostLimiter(maxConcurrentPerHost);
  async function refresh(feed, force) {
    const entry = cache.get(feed.url);
    if (entry?.inFlight) return entry.inFlight;
    const ttl = entry?.error ? Math.min(refreshAfterMs, errorRetryMs) : refreshAfterMs;
    if (entry && !force && now() - entry.checkedAt < ttl) return entry;
    const host = new URL(feed.url).hostname;
    const inFlight = runLimited(host, () => fetchFeed(feed, entry?.validators, fetchTimeoutMs)).then(result => {
      const next = result.notModified
        ? {...entry, checkedAt:now(), error:null}
        : {items:result.items, validators:result.validators, checkedAt:now(), error:null};
      cache.set(feed.url, next);
      return next;
    }, error => {
      const next = {items:entry?.items ?? [], validators:entry?.validators, checkedAt:now(),
        error:formatFetchError(error)};
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
