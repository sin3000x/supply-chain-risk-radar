import geography from './data/geography.json' with {type:'json'};
import {GEO_HUBS, getGeoHubById} from './public/vendor/worldmonitor/geo-hub-index.mjs';
import {matchKeyword, tokenizeForMatch} from './public/vendor/worldmonitor/keyword-match.mjs';

const fold = text => text.trim().toLowerCase();
const regionsByName = new Map();
const regionsByCountry = new Map();
const regionsByNode = new Map();

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
  function networkLocation(node, basis) {
    return {
      id:node.id, nodeId:node.id, label:node.name_zh || node.name_en || node.id, basis,
      region:regionsByName.get(fold(node.region ?? '')) ?? regionsByNode.get(node.id) ??
        regionsByCountry.get(node.country) ?? 'unknown',
    };
  }

  function hubLocation(hub, basis) {
    const linked = network.getNode(hub.networkId);
    if (linked) return networkLocation(linked,basis);
    return {
      id:hub.id, nodeId:hub.id, basis,
      label:hub.label ?? (hub.type === 'capital' ? hub.country : hub.name),
      region:regionsByName.get(fold(hub.region)) ?? 'unknown',
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
      if (region) return {id:region,label:regions[region].label,region,basis:'reported'};
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
