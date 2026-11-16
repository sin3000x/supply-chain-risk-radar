import {getGeoHubById,inferGeoHubsFromTitle} from './vendor/worldmonitor/geo-hub-index.mjs';
import {matchKeyword,tokenizeForMatch} from './vendor/worldmonitor/keyword-match.mjs';

export const regions = {
  europe: {label:'欧洲', lon:15, lat:51},
  middleEast: {label:'中东', lon:48, lat:27},
  northAmerica: {label:'北美', lon:-98, lat:43},
  southAmerica: {label:'南美', lon:-60, lat:-16},
  eastAsia: {label:'东亚', lon:117, lat:38},
  southeastAsia: {label:'东南亚', lon:106, lat:10},
  westernPacific: {label:'西太平洋', lon:150, lat:21},
  southernAfrica: {label:'南部非洲', lon:26, lat:-25},
  asia: {label:'亚洲', lon:91, lat:37},
  africa: {label:'非洲', lon:16, lat:3},
  oceania: {label:'大洋洲', lon:142, lat:-28},
  arctic: {label:'北极', lon:0, lat:74},
  indianOcean: {label:'印度洋', lon:75, lat:-13},
  unknown: {label:'地点待确认'},
};

const upstreamRegions = {
  Europe:'europe', 'Middle East':'middleEast', 'North America':'northAmerica',
  'South America':'southAmerica', Asia:'asia', Africa:'africa', Oceania:'oceania',
  Arctic:'arctic', 'Indian Ocean':'indianOcean', Pacific:'westernPacific',
};
const hubLabels = {
  hormuz:'霍尔木兹海峡', redsea:'红海', tallinn:'爱沙尼亚', yemen:'也门',
  manama:'巴林', jakarta:'印度尼西亚', pretoria:'南非', washington:'美国',
  suez:'苏伊士运河', malacca:'马六甲海峡', panama:'巴拿马运河',
};
const hubRegions = {jakarta:'southeastAsia',pretoria:'southernAfrica'};
const rotterdam = {id:'rotterdam',label:'鹿特丹港',region:'europe'};
const unknown = {id:'unknown',label:regions.unknown.label,region:'unknown',basis:'unresolved'};

function hubLocation(hub, basis) {
  return {
    id:hub.id,
    label:hubLabels[hub.id] ?? (hub.type === 'capital' ? hub.country : hub.name),
    region:hubRegions[hub.id] ?? upstreamRegions[hub.region] ?? 'unknown',
    basis,
  };
}

const regionNames = [
  ['europe', /^(?:(?:western|southern|northern|eastern) )?europe$|^(?:西欧|南欧|北欧|东欧|欧洲|荷兰)$/i],
  ['middleEast', /^(?:middle east|中东)$/i],
  ['northAmerica', /^(?:north america|北美)$/i],
  ['southAmerica', /^(?:south america|南美)$/i],
  ['eastAsia', /^(?:east asia|东亚)$/i],
  ['southeastAsia', /^(?:southeast asia|东南亚)$/i],
  ['westernPacific', /^(?:western pacific|西太平洋)$/i],
  ['southernAfrica', /^(?:southern africa|南部非洲)$/i],
];

export function locateEvent(event) {
  if (event.geoAnchors?.length === 1) {
    const [anchor] = event.geoAnchors;
    if (anchor === 'PORT_ROTTERDAM') return {...rotterdam,basis:'explicit'};
    if (anchor === 'CP_HORMUZ') return hubLocation(getGeoHubById('hormuz'),'explicit');
  }

  const declared = (event.region ?? '').trim();
  if (declared) {
    const region = regionNames.find(([,pattern]) => pattern.test(declared))?.[0] ?? upstreamRegions[declared];
    if (region) return {id:region,label:regions[region].label,region,basis:'reported'};
    if (/rotterdam|鹿特丹/i.test(declared)) return {...rotterdam,basis:'reported'};
    const matches = inferGeoHubsFromTitle(declared);
    if (matches.length === 1) return {...hubLocation(matches[0].hub,'reported'),label:declared};
    return {id:'reported:'+declared,label:declared,region:'unknown',basis:'reported'};
  }

  // A market or policy headline can name a cause or counterpart rather than an event location.
  if (['market_change','trade_policy'].includes(event.topic)) return unknown;
  const title = event.title ?? '';
  const matches = inferGeoHubsFromTitle(title);
  const tokens = tokenizeForMatch(title);
  // A named chokepoint is more specific than a country or official named in the same headline.
  const strategic = matches.filter(({hub}) => hub.type === 'strategic' && (matchKeyword(tokens,hub.name) || hub.id === 'hormuz' && matchKeyword(tokens,'hormuz')));
  if (strategic.length === 1) return hubLocation(strategic[0].hub,'inferred');
  if (strategic.length > 1) return unknown;

  // The upstream hub list does not include Rotterdam or the headline abbreviation U.S.
  if (/rotterdam|鹿特丹/i.test(title)) return {...rotterdam,basis:'inferred'};
  if (/\b(?:US|U\.S\.|United States)(?=\W|$)/u.test(title) && /\b(?:ground stop|flights?|air travel|aviation)\b/i.test(title)) {
    return hubLocation(getGeoHubById('washington'),'inferred');
  }
  // For these border notices the named subject is the authority closing its own crossings.
  if (/^(?:estonia|estonian)\b/i.test(title) && /\b(?:border|crossings?)\b/i.test(title)) {
    return {...hubLocation(getGeoHubById('tallinn'),'inferred'),label:'爱沙尼亚边境'};
  }

  const candidates = matches.filter(({hub}) =>
    hub.type !== 'organization' && (matchKeyword(tokens,hub.name) || matchKeyword(tokens,hub.country)));
  if (candidates.length === 1) return hubLocation(candidates[0].hub,'inferred');
  return unknown;
}
