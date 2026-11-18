import {CANDIDATE_STOPWORDS, clusterTexts, normalizeStoryText, stripAttributionSuffix} from './vendor/worldmonitor/story-identity.js';
import {detectSyndication} from './vendor/worldmonitor/syndication.js';
import {inferGeoHubsFromTitle} from './public/vendor/worldmonitor/geo-hub-index.mjs';
import geography from './data/geography.json' with {type:'json'};

const WINDOW_MS = 48 * 3600 * 1000;
const escapePattern = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const maritimeSubject = new RegExp(
  '\\b(?:shipping lanes?|commercial vessels?|tankers?|maritime|piracy|' +
  geography.maritimeTopicAliases.map(escapePattern).join('|') + ')\\b','i');
const topics = [
  ['maritime_security', maritimeSubject, /\b(attacks?|mines?|seiz\w+|hit|(?<!traffic )control|retreat|blockad\w+|clos\w+|disrupt\w+)\b/i],
  ['transport_disruption', /\b(ports?|airports?|flights?|airspace|railways?|borders?|terminals?|shipping|crossings?|dockworkers|ground stop)\b/i, /\b(strikes?|clos\w+|cancell?\w+|delay\w+|congestion|suspend\w+|collision|ground stop|restrict\w+|reopen\w+|disrupt\w+)\b/i],
  ['trade_policy', /\b(tariffs?|sanctions?|export controls?|trade talks?|trade deal|trade agreement|customs|export ban|trade restrictions?)\b/i, /\b(impos\w+|announc\w+|agree\w+|fail\w*|sign\w*|lift\w*|rais\w+|cut\w*|ban\w*|consider\w+|talks?|deal)\b/i],
  ['security_development', /\b(houthis?|armed forces|military|troops|missiles?|drone|armed group|ceasefire|rebels?|carrier)\b/i, /\b(attack\w*|advance\w*|retreat\w*|(?<!traffic )control|strike\w*|deploy\w*|arriv\w+|ceasefire|defend|capture\w*)\b/i],
  ['natural_hazard', /\b(earthquake|wildfires?|cyclones?|typhoons?|hurricanes?|flood\w*|volcan\w+)\b/i, /\b(alert\w*|warn\w*|hit|kill\w*|haze|evacu\w+|clos\w+|spread\w*|apologis\w+|damag\w+)\b/i],
  ['market_change', /\b(freight rates?|oil prices?|fuel prices?|shipping rates?|cargo capacity|container rates?)\b/i, /\b(rise\w*|fell|fall\w*|surge\w*|jump\w*|drop\w*|climb\w*|declin\w+)\b/i],
  ['infrastructure_incident', /\b(power grid|communications network|pipeline|oil refinery|subsea cable|infrastructure)\b/i, /\b(outage|blackout|fail\w*|explosion|fire|attack\w*|damage\w*|restor\w+)\b/i],
];
const backgroundTitle = /^(opinion|analysis|explainer|briefing|editorial|why\b|what\b|how\b)|\bcannot be secured without\b|\b(questions|what.s next)\s*\??$/i;
const intersection = (a,b) => [...a].filter(x=>b.has(x));
const actions = [
  ['territorial_change', /\b(retreat\w*|advance\w*|capture\w*|(?<!traffic )control|defend|withdraw\w*)\b/i],
  ['closure', /\b(clos\w+|shut\w*|stop\w*|suspend\w*)\b/i],
  ['reopening', /\b(reopen\w*|resum\w*|restor\w*)\b/i],
  ['labor_action', /\b(strike\w*|walkout\w*|stoppage\w*)\b/i],
  ['attack', /\b(attack\w*|hit|bomb\w*|seiz\w+)\b/i],
];
const actionFor = title => actions.find(([,pattern])=>pattern.test(title))?.[0] ?? null;

// Follow-up reports on one physical disruption ("flights resume after ground stop") reword the
// story too much for WorldMonitor's same-copy similarity. Thread them by a shared incident phrase:
// two adjacent content words, using the upstream tokenizer's stopwords and plural folding.
// Place names break phrases, so "Strait of Hormuz" alone never links two incidents.
const threadedTopics = new Set(['maritime_security','transport_disruption','natural_hazard','infrastructure_incident']);
function incidentPhrases(headline) {
  const hubs = inferGeoHubsFromTitle(headline);
  const placeWords = new Set(hubs.flatMap(({hub,matchedKeyword})=>normalizeStoryText(`${matchedKeyword} ${hub.name}`).split(' ')));
  const words = normalizeStoryText(headline).split(' ').map(word=>
    word.length < 3 || CANDIDATE_STOPWORDS.has(word) || placeWords.has(word) ? null
      : word.length > 4 && word.endsWith('s') ? word.slice(0,-1) : word);
  const phrases = new Set();
  for (let i = 1; i < words.length; i++) if (words[i-1] && words[i]) phrases.add(words[i-1]+' '+words[i]);
  return {phrases, hubs:hubs.map(({hubId})=>hubId)};
}

export function clusterNews(records, findPlaces, { windowMs = WINDOW_MS } = {}) {
  const articles = records.map(record=>{
    const {title}=record;
    return {
      record, at:Date.parse(record.time.value),
      headline:stripAttributionSuffix(title),
      places:new Set(findPlaces(record)),
      topic:topics.find(([,subject,change])=>subject.test(title) && change.test(title))?.[0],
      contextTopics:topics.filter(([,subject])=>subject.test(title)).map(([key])=>key),
      background:backgroundTitle.test(title), action:actionFor(title),
    };
  }).sort((a,b)=> a.at - b.at || a.record.id.localeCompare(b.record.id));
  const recent = (a,b)=>Number.isFinite(a.at) && Number.isFinite(b.at) && Math.abs(a.at-b.at)<=windowMs;
  const sharedPlace = (a,b)=>intersection(a.places,b.places).length;
  const candidates = articles.filter(item=>item.topic && !item.background);
  const copies = clusterTexts(candidates.map(item=>item.headline)).flatMap(indices=>{
    const windows = [];
    for (const index of indices) {
      const item = candidates[index];
      const current = windows.at(-1);
      if (current && recent(item,current[0])) current.push(item);
      else windows.push([item]);
    }
    return windows;
  });
  const groups = threadIncidents(copies, recent);
  // Attach context to one clear match so commentary cannot bridge two event groups.
  const context = new Map();
  for (const item of articles.filter(item=>item.background)) {
    const matches=groups.filter(group=>group.some(other=>recent(item,other) &&
      item.contextTopics.includes(other.topic) &&
      sharedPlace(item,other)));
    if (matches.length===1) {
      if (!context.has(matches[0])) context.set(matches[0],[]);
      context.get(matches[0]).push({...item.record,role:'background'});
    }
  }
  return groups.map(group=>{
    const primary=group.find(item=>item.topic==='maritime_security') ?? group[0];
    return {
      primary:primary.record, topic:primary.topic, action:primary.action,
      corroborationCount:detectSyndication(group.map(({record})=>({
        title:record.title, snippet:record.summary, source:record.source?.publisher ?? '',
      }))).publishers,
      records:[...group.map(item=>({...item.record,role:'report'})),...(context.get(group) ?? [])],
    };
  });
}

function threadIncidents(groups, recent) {
  const info = groups.map(group=>{
    const phrases = new Set(), places = new Set();
    for (const item of group) {
      const found = incidentPhrases(item.headline);
      for (const phrase of found.phrases) phrases.add(phrase);
      for (const place of [...item.places,...found.hubs]) places.add(place);
    }
    return {topic:group[0].topic, phrases, places, members:[...group]};
  });
  const compatible = (a,b) => !a.places.size || !b.places.size || intersection(a.places,b.places).length > 0;
  const parent = info.map((_,i)=>i);
  const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
  for (let i = 0; i < info.length; i++) for (let j = i + 1; j < info.length; j++) {
    const a = info[find(i)], b = info[find(j)];
    if (a === b || a.topic !== b.topic || !threadedTopics.has(a.topic) || !compatible(a,b)) continue;
    if (!intersection(a.phrases,b.phrases).length) continue;
    if (!a.members.some(x=>b.members.some(y=>recent(x,y)))) continue;
    // Merge into the root that started earlier so the group keeps its first report.
    const [keep,drop] = find(i) < find(j) ? [find(i),find(j)] : [find(j),find(i)];
    parent[drop] = keep;
    const target = info[keep], source = info[drop];
    for (const phrase of source.phrases) target.phrases.add(phrase);
    for (const place of source.places) target.places.add(place);
    target.members.push(...source.members);
  }
  return info.filter((_,i)=>find(i) === i).map(({members})=>members.sort((a,b)=>a.at-b.at || a.record.id.localeCompare(b.record.id)));
}

export const routeTopics = new Set(['maritime_security','transport_disruption','natural_hazard','infrastructure_incident']);
