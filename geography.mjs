import geography from './data/geography.json' with {type:'json'};
import {GEO_HUBS, getGeoHubById} from './public/vendor/worldmonitor/geo-hub-index.mjs';
import {matchKeyword, tokenizeForMatch} from './public/vendor/worldmonitor/keyword-match.mjs';

const fold = text => text.trim().toLowerCase();
const regionsByName = new Map();
const regionsByCountry = new Map();
const regionsByNode = new Map();
const coordinates = geography.coordinates ?? {};
const hubsByNetworkId = new Map(
  GEO_HUBS.filter(hub => hub.networkId && Number.isFinite(hub.lon) && Number.isFinite(hub.lat))
    .map(hub => [hub.networkId, hub])
);

export const regions = Object.fromEntries(Object.entries(geography.regions).map(([id, area]) => {
  for (const name of [id, area.label, ...(area.aliases ?? [])]) regionsByName.set(fold(name), id);
  for (const country of area.countries?.split(' ') ?? []) regionsByCountry.set(country, id);
  for (const node of area.nodes?.split(' ') ?? []) regionsByNode.set(node, id);
  const {label, lon, lat} = area;
  return [id, {label, lon, lat}];
}));

const NON_MAP_REGIONS = new Set(['crossRegion', 'unknown']);
const unknown = {id:'unknown',label:regions.unknown.label,region:'unknown',basis:'unresolved'};
const crossTrade = {id:'cross:trade_policy',label:'跨区经贸与制裁政策',region:'crossRegion',basis:'cross_region'};
const crossMarket = {id:'cross:market_change',label:'全球能源与航运市场',region:'crossRegion',basis:'cross_region'};
const strategicNodeTypes = new Set(['chokepoint','sea_area']);

const regionAliasEntries = Object.entries(geography.regions)
  .filter(([id]) => !NON_MAP_REGIONS.has(id))
  .flatMap(([regionId, area]) =>
    [area.label, ...(area.aliases ?? [])]
      .filter(Boolean)
      .map(alias => ({regionId, alias, folded: fold(alias)})))
  .sort((a, b) => b.folded.length - a.folded.length);

const HUB_COUNTRY_CODES = new Map([
  ['USA', 'US'], ['United States', 'US'],
  ['UK', 'GB'], ['United Kingdom', 'GB'],
  ['China', 'CN'], ['Russia', 'RU'], ['Japan', 'JP'], ['South Korea', 'KR'],
  ['North Korea', 'KP'], ['India', 'IN'], ['Indonesia', 'ID'], ['Thailand', 'TH'],
  ['Philippines', 'PH'], ['Vietnam', 'VN'], ['Malaysia', 'MY'], ['Singapore', 'SG'],
  ['Australia', 'AU'], ['Canada', 'CA'], ['Mexico', 'MX'], ['Brazil', 'BR'],
  ['Iran', 'IR'], ['Israel', 'IL'], ['Ukraine', 'UA'], ['Turkey', 'TR'],
  ['UAE', 'AE'], ['Saudi Arabia', 'SA'], ['Cuba', 'CU'], ['Ecuador', 'EC'],
  ['Chile', 'CL'], ['Peru', 'PE'], ['Colombia', 'CO'], ['Belgium', 'BE'],
  ['Taiwan', 'TW'], ['Pakistan', 'PK'], ['Afghanistan', 'AF'], ['Poland', 'PL'],
  ['Romania', 'RO'], ['Finland', 'FI'], ['Sweden', 'SE'], ['Norway', 'NO'],
  ['Estonia', 'EE'], ['Latvia', 'LV'], ['Lithuania', 'LT'], ['Greece', 'GR'],
  ['Serbia', 'RS'], ['Belarus', 'BY'], ['Georgia', 'GE'], ['Moldova', 'MD'],
  ['Armenia', 'AM'], ['Azerbaijan', 'AZ'], ['Argentina', 'AR'], ['Venezuela', 'VE'],
  ['Ethiopia', 'ET'], ['Kenya', 'KE'], ['South Africa', 'ZA'], ['Nigeria', 'NG'],
  ['DR Congo', 'CD'], ['Somalia', 'SO'], ['Libya', 'LY'], ['Tunisia', 'TN'],
  ['Algeria', 'DZ'], ['Morocco', 'MA'], ['Egypt', 'EG'], ['Qatar', 'QA'],
  ['Bahrain', 'BH'], ['Kuwait', 'KW'], ['Oman', 'OM'], ['Jordan', 'JO'],
  ['Iraq', 'IQ'], ['Yemen', 'YE'], ['Syria', 'SY'], ['Lebanon', 'LB'],
  ['Sudan', 'SD'], ['Myanmar', 'MM'], ['Panama', 'PA'], ['France', 'FR'],
  ['Germany', 'DE'], ['Italy', 'IT'], ['Spain', 'ES'], ['Netherlands', 'NL'],
]);

const TRADE_POLITY_PATTERNS = [
  ['US', /\b(?:u\.?s\.?a?|united states|american|washington|trump|white house|u\.s\. trade)\b/i],
  ['EU', /\b(?:eu|european union|brussels|european commission|council,\s*european union)\b/i],
  ['GB', /\b(?:uk|u\.k\.|britain|british|united kingdom|london)\b/i],
  ['CA', /\b(?:canada|canadian|ottawa|carney)\b/i],
  ['CN', /\b(?:china|chinese|beijing|prc)\b/i],
  ['RU', /\b(?:russia|russian|moscow|kremlin|putin)\b/i],
  ['KP', /\b(?:north korea|dprk|pyongyang)\b/i],
  ['ID', /\b(?:indonesia|indonesian|jakarta)\b/i],
  ['TH', /\b(?:thailand|thai|bangkok)\b/i],
  ['PH', /\b(?:philippines|filipino|manila|marcos)\b/i],
  ['IN', /\b(?:india|indian|new delhi|modi)\b/i],
  ['CU', /\b(?:cuba|cuban|havana)\b/i],
  ['IR', /\b(?:iran|iranian|tehran)\b/i],
  ['JP', /\b(?:japan|japanese|tokyo)\b/i],
  ['KR', /\b(?:south korea|korean|seoul)\b/i],
  ['MX', /\b(?:mexico|mexican|mexico city)\b/i],
  ['BR', /\b(?:brazil|brazilian|brasilia|lula)\b/i],
  ['AU', /\b(?:australia|australian|canberra)\b/i],
  ['VN', /\b(?:vietnam|vietnamese|hanoi)\b/i],
  ['MY', /\b(?:malaysia|malaysian|kuala lumpur)\b/i],
  ['SG', /\b(?:singapore|singaporean)\b/i],
  ['TR', /\b(?:turkey|turkish|türkiye|ankara|erdogan)\b/i],
  ['BG', /\b(?:bulgaria|bulgarian|sofia)\b/i],
  ['IL', /\b(?:israel|israeli|jerusalem)\b/i],
  ['UA', /\b(?:ukraine|ukrainian|kyiv|kiev)\b/i],
  ['SA', /\b(?:saudi|saudi arabia|riyadh)\b/i],
  ['AE', /\b(?:uae|emirates|emirati|abu dhabi|dubai)\b/i],
];
const MULTILATERAL_TRADE = /\b(?:usmca|wto|apec|g7|g20|brics|asean|opec)\b/i;

export function createEventLocator(network) {
  const nodeByAlias = new Map();
  for (const node of network.snapshot?.nodes ?? []) {
    for (const raw of [node.name_en, node.name_zh, ...(node.aliases ?? [])]) {
      const key = fold(raw ?? '');
      if (!key) continue;
      if (!nodeByAlias.has(key)) nodeByAlias.set(key, new Set());
      nodeByAlias.get(key).add(node.id);
    }
  }

  function regionLocation(regionId, basis) {
    const area = regions[regionId];
    if (!area || NON_MAP_REGIONS.has(regionId)) return null;
    return {
      id:regionId, label:area.label, region:regionId, basis,
      ...(area.lon != null && area.lat != null && {lon:area.lon, lat:area.lat}),
    };
  }

  function nodeCoordinates(node, region) {
    if (Number.isFinite(node.lon) && Number.isFinite(node.lat)) return [node.lon, node.lat];
    const direct = coordinates[node.id];
    if (Array.isArray(direct) && Number.isFinite(direct[0]) && Number.isFinite(direct[1])) return direct;
    const hub = hubsByNetworkId.get(node.id);
    if (hub) return [hub.lon, hub.lat];
    const countryCoords = node.country ? coordinates[`CTY_${node.country}`] : null;
    if (Array.isArray(countryCoords) && Number.isFinite(countryCoords[0]) && Number.isFinite(countryCoords[1])) {
      return countryCoords;
    }
    const fallback = regions[region];
    return fallback?.lon != null && fallback?.lat != null ? [fallback.lon, fallback.lat] : null;
  }

  function networkLocation(node, basis) {
    const region = regionsByName.get(fold(node.region ?? '')) ?? regionsByNode.get(node.id) ??
      regionsByCountry.get(node.country) ?? 'unknown';
    const coords = nodeCoordinates(node, region);
    return {
      id:node.id, nodeId:node.id, label:node.name_zh || node.name_en || node.id, basis,
      region,
      ...(coords && {lon:coords[0], lat:coords[1]}),
    };
  }

  function hubLocation(hub, basis) {
    const linked = network.getNode(hub.networkId);
    if (linked) {
      const location = networkLocation(linked,basis);
      if (location.lon == null && Number.isFinite(hub.lon) && Number.isFinite(hub.lat)) {
        return {...location, lon:hub.lon, lat:hub.lat};
      }
      return location;
    }
    return {
      id:hub.id, basis,
      label:hub.label ?? (hub.type === 'capital' ? hub.country : hub.name),
      region:regionsByName.get(fold(hub.region)) ?? 'unknown',
      ...(Number.isFinite(hub.lon) && Number.isFinite(hub.lat) && {lon:hub.lon, lat:hub.lat}),
    };
  }

  function locationById(id, basis) {
    const node = network.getNode(id);
    if (node) return networkLocation(node,basis);
    const hub = getGeoHubById(id);
    return hub ? hubLocation(hub,basis) : null;
  }

  function namedLocations(text, basis) {
    const tokens = tokenizeForMatch(text);
    const caseSensitiveWords = new Set(text.match(/\p{L}+(?:\.\p{L}+)*/gu) ?? []);
    const matches = new Map();
    for (const node of network.findLocationNodes(text)) {
      const priority = strategicNodeTypes.has(node.type) ? 3 : node.type === 'country' ? 1 : 2;
      matches.set(node.id,{location:networkLocation(node,basis),priority});
    }
    for (const hub of GEO_HUBS) {
      if (hub.type === 'organization') continue;
      const country = hub.type === 'capital' ? hub.country : null;
      const names = [hub.name,country,hub.label,...(hub.aliases ?? [])].filter(Boolean);
      const named = names.some(name=>matchKeyword(tokens,name) ||
        (/\p{Script=Han}/u.test(name) && text.includes(name)));
      const contextual = hub.contextualAliases?.some(({names = [],abbreviations = [],terms}) =>
        (names.some(name=>matchKeyword(tokens,name)) || abbreviations.some(name=>caseSensitiveWords.has(name))) &&
        terms.some(term=>matchKeyword(tokens,term)));
      if (!named && !contextual) continue;
      const canonicalNames = [hub.name,country,hub.label].filter(Boolean);
      const alreadyMatchedNode = canonicalNames.some(alias => {
        const ids = nodeByAlias.get(fold(alias));
        return ids && [...ids].some(id => matches.has(id));
      });
      if (alreadyMatchedNode) continue;
      const location = hubLocation(hub,basis);
      const priority = hub.type === 'strategic' ? 3 : ['port','city'].includes(hub.type) ? 2 : 1;
      if (!matches.has(location.id)) {
        matches.set(location.id,{location,priority});
      }
    }
    if (!matches.size) return [];
    const highest = Math.max(...[...matches.values()].map(match=>match.priority));
    return [...matches.values()].filter(match=>match.priority === highest).map(match=>match.location);
  }

  function matchRegionInTitle(text, basis) {
    const tokens = tokenizeForMatch(text);
    const hits = regionAliasEntries.filter(({alias}) =>
      matchKeyword(tokens, alias) || (/\p{Script=Han}/u.test(alias) && text.includes(alias)));
    if (!hits.length) return null;
    // Drop shorter parent region aliases subsumed by a longer specific hit (e.g. Asia inside Southeast Asia).
    const specific = hits.filter((entry, idx) =>
      !hits.some((other, otherIdx) =>
        otherIdx !== idx && other.folded.length > entry.folded.length && other.folded.includes(entry.folded)));
    const regionIds = [...new Set(specific.map(entry => entry.regionId))];
    return regionIds.length === 1 ? regionLocation(regionIds[0], basis) : null;
  }

  function disambiguateBySite(text, candidates) {
    const candidateIds = new Set(candidates.map(loc => loc.id));
    const siteRx = /\b(?:in|at|near|off|across|around)\s+(?:the\s+)?([A-Z][\w'’.-]+(?:\s+(?:of\s+)?[A-Z][\w'’.-]+){0,3})/g;
    const leadClause = text.split(/\b(?:as|amid|after|following|while|despite)\b|[,;—–]/i)[0] ?? '';
    for (const scope of [leadClause, text]) {
      if (!scope) continue;
      const phrases = [...scope.matchAll(siteRx)].map(match => match[1]);
      if (!phrases.length) continue;
      const matchedIds = new Set();
      for (const phrase of phrases) {
        for (const loc of namedLocations(phrase, 'inferred')) {
          if (candidateIds.has(loc.id)) matchedIds.add(loc.id);
        }
      }
      if (matchedIds.size === 1) {
        const [id] = matchedIds;
        return candidates.find(loc => loc.id === id) ?? null;
      }
    }
    return null;
  }

  function sharedRegionLocation(locations, basis) {
    if (!locations.length) return null;
    const regionIds = new Set();
    for (const loc of locations) {
      if (!loc?.region || NON_MAP_REGIONS.has(loc.region)) return null;
      regionIds.add(loc.region);
    }
    if (regionIds.size !== 1) return null;
    const [onlyRegion] = regionIds;
    return regionLocation(onlyRegion, basis);
  }

  function polityKeyForLocation(loc) {
    const node = network.getNode(loc.id);
    if (node?.country) return node.country.toUpperCase();
    const hub = getGeoHubById(loc.id);
    if (hub?.country && hub.country !== 'International') {
      return HUB_COUNTRY_CODES.get(hub.country) ?? hub.country.toUpperCase();
    }
    return loc.label || loc.id;
  }

  function isCrossBorderTradePolicy(event) {
    const text = [
      event.title,
      ...(event.records ?? [])
        .filter(record => record.kind === 'news' && record.role !== 'background')
        .map(record => `${record.title ?? ''} ${record.source?.publisher ?? ''}`),
    ].filter(Boolean).join(' ');
    if (MULTILATERAL_TRADE.test(text)) return true;
    const polities = new Set();
    for (const [code, pattern] of TRADE_POLITY_PATTERNS) {
      if (pattern.test(text)) polities.add(code);
    }
    for (const loc of namedLocations(event.title ?? '', 'inferred')) {
      polities.add(polityKeyForLocation(loc));
    }
    return polities.size !== 1;
  }

  return function locateEvent(event) {
    const anchors = [...new Set(event.geoAnchors ?? [])];
    if (anchors.length === 1) {
      const location = locationById(anchors[0],'explicit');
      if (location) return location;
    } else if (anchors.length > 1) {
      const resolved = anchors.map(id => locationById(id, 'explicit')).filter(Boolean);
      const shared = resolved.length === anchors.length ? sharedRegionLocation(resolved, 'explicit') : null;
      if (shared) return shared;
    }

    const declared = event.region?.trim();
    if (declared) {
      const region = regionsByName.get(fold(declared));
      if (region) {
        const area = regions[region];
        return {
          id:region, label:area.label, region, basis:'reported',
          ...(area.lon != null && area.lat != null && {lon:area.lon, lat:area.lat}),
        };
      }
      const location = locationById(declared,'reported');
      if (location) return location;
      const matches = namedLocations(declared,'reported');
      if (matches.length === 1) return matches[0];
      return {id:'reported:'+declared,label:declared,region:'unknown',basis:'reported'};
    }

    if (event.topic === 'trade_policy' && isCrossBorderTradePolicy(event)) return crossTrade;

    const title = event.title ?? '';
    const matches = namedLocations(title,'inferred');
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      const bySite = disambiguateBySite(title, matches);
      if (bySite) return bySite;
      const byRegion = sharedRegionLocation(matches, 'inferred');
      if (byRegion) return byRegion;
    } else {
      const byTitleRegion = matchRegionInTitle(title, 'inferred');
      if (byTitleRegion) return byTitleRegion;
    }

    if (event.topic === 'trade_policy') return crossTrade;
    if (event.topic === 'market_change') return crossMarket;
    return unknown;
  };
}
