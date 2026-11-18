# WorldMonitor upstream modules

Source: https://github.com/koala73/worldmonitor/tree/e5f9cff2fa9901a671c1ff0b36e71ebc5d9c35f1/shared

- `story-identity.js`: upstream normalization, similarity, and clustering. Only the SHA-256/HMAC calls were adapted to Node's built-in crypto; thresholds, tokenization, and clustering are unchanged.
- `publisher-families.js`, `syndication.js`: unchanged upstream publisher identity and syndicated-copy detection.
- `threat-keyword-classifier.ts`: unchanged upstream keyword classifier. Node strips its types at runtime.
- `feed-date-zone.js`, `article-identity.js`: unchanged upstream feed-date zone normalization and article-URL identity.
- `bounded-body.ts`: unchanged upstream `api/mcp/bounded-body.ts` (byte-capped response reads).
- `feed-xml.ts`: excerpts from `server/worldmonitor/news/v1/list-feed-digest.ts` (feed-body charset decoding, RSS sniffing, the date gate, description extraction and the linear XML tag scanners) plus `FUTURE_DATE_TOLERANCE_MS` from `_rss-cache.ts`. Function bodies are unchanged; only imports and an export list were added. `rss.mjs` follows the per-item steps of upstream `parseRssXml` without its Redis, LLM and scoring stages.

See the repository root `LICENSE` for the upstream AGPL v3 license. Keep these notices when updating the snapshot.

The browser copies in `public/vendor/worldmonitor/` use the same pinned commit:

- `geo-hub-index.mjs` and `keyword-match.mjs` come from `src/services/geo-hub-index.ts` and `src/utils/keyword-match.ts`. The hub catalog is stored in `data/geo-hubs.json`, with Radar display labels and links to transport nodes where available.
- `countries.geojson` is copied verbatim from upstream `public/data/countries.geojson`.
