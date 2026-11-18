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

const unknown = {id:'unknown',label:regions.unknown.label,region:'unknown',basis:'unresolved'};
const strategicNodeTypes = new Set(['chokepoint','sea_area']);

export function createEventLocator(network) {
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
      const priority = strategicNodeTypes.has(node.type) ? 2 : 1;
      matches.set(node.id,{location:networkLocation(node,basis),priority});
    }
    for (const hub of GEO_HUBS) {
      if (hub.type === 'organization') continue;
      const country = ['capital','conflict'].includes(hub.type) ? hub.country : null;
      const names = [hub.name,country,hub.label].filter(Boolean);
      const named = names.some(name=>matchKeyword(tokens,name) ||
        (/\p{Script=Han}/u.test(name) && text.includes(name)));
      const contextual = hub.contextualAliases?.some(({names = [],abbreviations = [],terms}) =>
        (names.some(name=>matchKeyword(tokens,name)) || abbreviations.some(name=>caseSensitiveWords.has(name))) &&
        terms.some(term=>matchKeyword(tokens,term)));
      if (!named && !contextual) continue;
      const location = hubLocation(hub,basis);
      if (!matches.has(location.id)) {
        matches.set(location.id,{location,priority:hub.type === 'strategic' ? 2 : 0});
      }
    }
    const highest = Math.max(...[...matches.values()].map(match=>match.priority));
    return [...matches.values()].filter(match=>match.priority === highest).map(match=>match.location);
  }

  return function locateEvent(event) {
    const anchors = [...new Set(event.geoAnchors ?? [])];
    if (anchors.length === 1) {
      const location = locationById(anchors[0],'explicit');
      if (location) return location;
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

    if (anchors.length > 1 || ['market_change','trade_policy'].includes(event.topic)) return unknown;
    const matches = namedLocations(event.title ?? '','inferred');
    return matches.length === 1 ? matches[0] : unknown;
  };
}
