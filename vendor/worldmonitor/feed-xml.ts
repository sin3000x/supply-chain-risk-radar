// Excerpts from WorldMonitor server/worldmonitor/news/v1/list-feed-digest.ts
// (constants, feed-body decoding, date gate and linear XML tag scanners), plus
// FUTURE_DATE_TOLERANCE_MS from _rss-cache.ts. Function bodies are unchanged;
// only the imports and the export list at the end were added.
import { normalizeFeedDateZone } from './feed-date-zone.js';

export const FUTURE_DATE_TOLERANCE_MS = 60 * 60 * 1000;

const MAX_DESCRIPTION_LEN = 400;
const MIN_DESCRIPTION_LEN = 40;

const DESCRIPTION_TAG_PRIORITY = {
  rss: ['description', 'content:encoded'] as const,
  atom: ['summary', 'content'] as const,
};

const DATE_TAG_PRIORITY = {
  rss: ['pubDate', 'dc:date', 'dc:Date.Issued', 'published'] as const,
  atom: ['published', 'updated', 'dc:date', 'dc:Date.Issued'] as const,
};

export function looksLikeRssXml(text: string): boolean {
  const head = text.slice(0, 2048).toLowerCase();
  if (/<!doctype\s+html|<html[\s>]/.test(head)) return false;
  return /<rss[\s>]|<feed[\s>]|<rdf:rdf[\s>]/.test(head);
}

const RSS_MAX_BODY_BYTES = 5 * 1024 * 1024;

/**
 * Decode a feed body in the charset it declares: the Content-Type charset,
 * else the XML prolog's encoding, else UTF-8. Folha de S.Paulo serves
 * ISO-8859-1 with a bare `text/xml`, so a fixed UTF-8 decode garbled every
 * accented title. An unknown label falls back to UTF-8.
 */
export function decodeFeedBody(bytes: Uint8Array, contentType: string | null): string {
  // A byte-order mark wins over any declaration, as in browsers. UTF-16 has
  // no ASCII prolog to sniff, so the BOM is the only way to find it.
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 'utf-8'
    : bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be'
        : null;
  if (bom) return new TextDecoder(bom).decode(bytes);
  let label = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType ?? '')?.[1];
  if (!label) {
    // The prolog is ASCII in every encoding a feed declares, so a Latin-1
    // read of the first bytes finds it without knowing the charset yet.
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 256));
    label = /^\s*<\?xml[^>]*\bencoding\s*=\s*["']([\w.:-]+)["']/i.exec(head)?.[1];
  }
  if (label) {
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // Unknown label: fall through to UTF-8.
    }
  }
  return new TextDecoder().decode(bytes);
}

function extractFirstDateTag(block: string, isAtom: boolean, lower = asciiLower(block)): string {
  const tags = isAtom ? DATE_TAG_PRIORITY.atom : DATE_TAG_PRIORITY.rss;
  for (const tag of tags) {
    const value = extractTag(block, tag, lower);
    if (value) return value;
  }
  return '';
}

/** Epoch ms of a feed date that parses and is not in the future, else null. */
function usableFeedDateMs(raw: string): number | null {
  if (!raw) return null;
  const ms = new Date(normalizeFeedDateZone(raw)).getTime();
  if (Number.isNaN(ms) || ms > Date.now() + FUTURE_DATE_TOLERANCE_MS) return null;
  return ms;
}

/**
 * The date of a snapshot feed's channel, read from the markup before its first
 * item, so an item's own date is never mistaken for it.

/**
 * Raw-body extractor for HTML-carrying tags (description, content:encoded,
 * summary, content). Non-greedy `[\s\S]*?` captures the full tag body including
 * nested markup; the CDATA end is anchored to the closing tag so internal `]]>`
 * sequences followed by more content do not truncate the match prematurely.
 * Returns the raw content without entity decoding — caller strips HTML and
 * decodes entities via `decodeXmlEntities`.
 */
function extractRawTagBody(xml: string, tag: string, lower = asciiLower(xml)): string {
  const cdata = matchCdataTag(xml, lower, tag);
  if (cdata !== null) return cdata;
  return matchTagBody(xml, lower, tag) ?? '';
}

/**
 * `s.replace(re, replacement)` for a global regex whose every match ends with
 * `terminator`. Each failed match attempt scans to the end of the string, so a
 * long unterminated tail (`<<<<…`, `<![CDATA[…` with no `]]>`) made the replace
 * quadratic. No match can end past the last terminator, so only the prefix
 * through it is handed to the regex, where each attempt stops at the next
 * terminator; the tail is appended unchanged. Same result as the plain replace.
 */
function replaceBeforeLast(s: string, terminator: string, re: RegExp, replacement: string): string {
  const end = s.lastIndexOf(terminator);
  if (end < 0) return s;
  const cut = end + terminator.length;
  return s.slice(0, cut).replace(re, replacement) + s.slice(cut);
}

function normalizeForDescriptionEquality(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Extract + clean the article description/summary for an RSS `<item>` or Atom
 * `<entry>` block. Picks the LONGEST non-empty candidate across the dialect's
 * tag priority list after HTML-strip + entity-decode + whitespace-normalise.
 * Returns '' when the best candidate is empty, shorter than
 * MIN_DESCRIPTION_LEN, or normalises-equal to the headline — in those cases
 * downstream consumers must fall back to the cleaned headline (R6).
 */
function extractDescription(
  block: string,
  isAtom: boolean,
  title: string,
  lower = asciiLower(block),
): string {
  const tags = isAtom ? DESCRIPTION_TAG_PRIORITY.atom : DESCRIPTION_TAG_PRIORITY.rss;

  let best = '';
  for (const tag of tags) {
    const raw = extractRawTagBody(block, tag, lower);
    if (!raw) continue;
    // Some publisher feeds place entity-encoded thumbnail markup before a
    // literal CDATA summary in one tag body (Times of India is one example).
    // Unwrap complete embedded CDATA sections before entity decoding and HTML
    // stripping; otherwise `<...>` removal consumes the wrapper and its text.
    const unwrapped = replaceBeforeLast(raw, ']]>', /<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
    const cleaned = replaceBeforeLast(decodeXmlEntities(unwrapped), '>', /<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (cleaned.length > best.length) best = cleaned;
  }

  if (best.length === 0) return '';
  if (best.length < MIN_DESCRIPTION_LEN) return '';
  if (normalizeForDescriptionEquality(best) === normalizeForDescriptionEquality(title)) return '';

  return best.slice(0, MAX_DESCRIPTION_LEN);
}

function extractTag(xml: string, tag: string, lower = asciiLower(xml)): string {
  const cdata = matchCdataTag(xml, lower, tag);
  if (cdata !== null) return cdata.trim();

  const text = matchTagText(xml, lower, tag);
  return text !== null ? decodeXmlEntities(text.trim()) : '';
}

// ── Linear tag scanners ─────────────────────────────────────────────────────
// Feed bodies are publisher-controlled and parsed synchronously on the edge
// isolate. The lazy/`[^>]*` tag regexes these replace backtrack quadratically
// on unterminated markup (a 1 MB run of `<title` took ~2 min), so each scanner
// below reproduces one regex's first match with indexOf walks that never
// revisit a character more than a constant number of times. Tag names are
// matched literally and ASCII-case-insensitively, like the `/i` regexes did.
// `lower` must be `asciiLower(xml)`: index-aligned with `xml`, so a match
// found in `lower` is sliced from `xml` with the original case.

const JS_WHITESPACE = /\s/;

/** Lowercase A-Z only. Index-preserving, unlike toLowerCase (`İ` grows to 2 units). */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (run) => run.toLowerCase());
}

function isJsWhitespace(c: string | undefined): boolean {
  return c !== undefined && JS_WHITESPACE.test(c);
}

/**
 * For each `<tag` opener in order, yields the index of the first `>` after
 * it: where `<tag[^>]*>` ends for that opener. The `>` lookup is reused while
 * it still lies past the opener, so a run of openers before one `>` costs
 * O(n) in total.
 */
function* tagOpeners(lower: string, tag: string): Generator<number> {
  const open = `<${tag.toLowerCase()}`;
  let pos = 0;
  let gt = -1;
  for (;;) {
    const o = lower.indexOf(open, pos);
    if (o < 0) return;
    if (gt < o + open.length) gt = lower.indexOf('>', o + open.length);
    if (gt < 0) return; // no `>` after this opener, so none after a later one
    yield gt;
    pos = o + 1;
  }
}

/** Every `/<tag[\s>]([\s\S]*?)<\/tag>/gi` capture, in order (item/entry split). */
function scanTagBlocks(xml: string, lower: string, tag: string): string[] {
  const open = `<${tag}`;
  const close = `</${tag}>`;
  const blocks: string[] = [];
  let pos = 0;
  for (;;) {
    const o = lower.indexOf(open, pos);
    if (o < 0) break;
    const next = lower[o + open.length];
    if (next !== '>' && !isJsWhitespace(next)) {
      pos = o + 1;
      continue;
    }
    const bodyStart = o + open.length + 1;
    const c = lower.indexOf(close, bodyStart);
    if (c < 0) break; // no close after this opener, so none after a later one
    blocks.push(xml.slice(bodyStart, c));
    pos = c + close.length;
  }
  return blocks;
}

/** First `<tag[^>]*>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/tag>` capture (`/i`), or null. */
function matchCdataTag(xml: string, lower: string, tag: string): string | null {
  const close = `</${tag.toLowerCase()}>`;
  let lastGt = -1;
  let bodyStart = -1;
  for (const gt of tagOpeners(lower, tag)) {
    if (gt !== lastGt) {
      // Openers sharing one `>` share the same verdict.
      lastGt = gt;
      let j = gt + 1;
      while (isJsWhitespace(lower[j])) j++;
      bodyStart = lower.startsWith('<![cdata[', j) ? j + 9 : -1;
    }
    if (bodyStart < 0) continue;
    // The first CDATA opener decides: a later opener's body starts later, so
    // it cannot reach a terminator this one did not.
    let k = lower.indexOf(']]>', bodyStart);
    while (k >= 0) {
      let j = k + 3;
      while (isJsWhitespace(lower[j])) j++;
      if (lower.startsWith(close, j)) return xml.slice(bodyStart, k);
      k = lower.indexOf(']]>', k + 1);
    }
    return null;
  }
  return null;
}

/** First `<tag[^>]*>([^<]*)<\/tag>` capture (`/i`), or null. */
function matchTagText(xml: string, lower: string, tag: string): string | null {
  const close = `</${tag.toLowerCase()}>`;
  let lastGt = -1;
  let lt = -1;
  for (const gt of tagOpeners(lower, tag)) {
    if (gt !== lastGt) {
      lastGt = gt;
      lt = lower.indexOf('<', gt + 1);
    }
    if (lt < 0) return null; // no `<` left for any later opener either
    if (lower.startsWith(close, lt)) return xml.slice(gt + 1, lt);
  }
  return null;
}

/** First `<tag[^>]*>([\s\S]*?)<\/tag>` capture (`/i`), or null. */
function matchTagBody(xml: string, lower: string, tag: string): string | null {
  for (const gt of tagOpeners(lower, tag)) {
    // The first opener decides: a later one's body starts no earlier.
    const c = lower.indexOf(`</${tag.toLowerCase()}>`, gt + 1);
    return c < 0 ? null : xml.slice(gt + 1, c);
  }
  return null;
}

/**
 * `String.fromCodePoint` throws `RangeError` on anything outside the Unicode
 * range, which would turn one malformed numeric reference into a failed feed
 * parse. Drop those instead. `fromCharCode` is not usable here: it truncates to
 * 16 bits, so `&#128512;` decoded to U+F600 (a private-use glyph) rather than 😀.
 */
function decodeNumericReference(codePoint: number): string {
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : '';
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => decodeNumericReference(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => decodeNumericReference(parseInt(n, 16)))
    // `&amp;` MUST be decoded last. Decoding it first turns the escaped
    // ampersand of `&amp;lt;` into a live `&`, which the very next replace then
    // consumes as `&lt;` — one pass decoding twice.
    .replace(/&amp;/g, '&');
}

export {
  MAX_DESCRIPTION_LEN, MIN_DESCRIPTION_LEN, RSS_MAX_BODY_BYTES,
  asciiLower, decodeXmlEntities, extractDescription, extractFirstDateTag,
  extractTag, scanTagBlocks, usableFeedDateMs,
};
