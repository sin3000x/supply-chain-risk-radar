import { tokenizeForMatch, matchKeyword } from './keyword-match.mjs';
import GEO_HUBS from '../../../data/geo-hubs.json' with {type:'json'};

export {GEO_HUBS};
// Geopolitical Hub Index - aggregates news by strategic locations

let cachedIndex                     = null;

function buildGeoHubIndex()              {
  if (cachedIndex) return cachedIndex;

  const hubs = new Map                        ();
  const byKeyword = new Map                  ();

  const addKeyword = (keyword        , hubId        ) => {
    const lower = keyword.toLowerCase();
    const existing = byKeyword.get(lower) || [];
    if (!existing.includes(hubId)) {
      existing.push(hubId);
      byKeyword.set(lower, existing);
    }
  };

  for (const hub of GEO_HUBS) {
    hubs.set(hub.id, hub);
    for (const kw of hub.keywords) {
      addKeyword(kw, hub.id);
    }
  }

  cachedIndex = { hubs, byKeyword };
  return cachedIndex;
}

export function inferGeoHubsFromTitle(title        )                {
  const index = buildGeoHubIndex();
  const matches                = [];
  const tokens = tokenizeForMatch(title);
  const seenHubs = new Set        ();

  for (const [keyword, hubIds] of index.byKeyword) {
    if (keyword.length < 2) continue;

    if (matchKeyword(tokens, keyword)) {
      for (const hubId of hubIds) {
        if (seenHubs.has(hubId)) continue;
        seenHubs.add(hubId);

        const hub = index.hubs.get(hubId);
        if (!hub) continue;

        let confidence = 0.5;
        if (keyword.length >= 10) confidence = 0.9;
        else if (keyword.length >= 6) confidence = 0.75;
        else if (keyword.length >= 4) confidence = 0.6;

        // Boost for conflict/strategic zones (more newsworthy)
        if (hub.type === 'conflict' || hub.type === 'strategic') {
          confidence = Math.min(1, confidence + 0.1);
        }

        // Boost for critical tier
        if (hub.tier === 'critical') {
          confidence = Math.min(1, confidence + 0.1);
        }

        matches.push({ hubId, hub, confidence, matchedKeyword: keyword });
      }
    }
  }

  matches.sort((a, b) => b.confidence - a.confidence);
  return matches;
}

export function getGeoHubById(hubId        )                             {
  const index = buildGeoHubIndex();
  return index.hubs.get(hubId);
}
