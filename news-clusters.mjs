import {clusterTexts, stripAttributionSuffix} from './vendor/worldmonitor/story-identity.js';
import {detectSyndication} from './vendor/worldmonitor/syndication.js';

const WINDOW_MS = 48 * 3600 * 1000;
const topics = [
  ['maritime_security', /\b(red sea|hormuz|bab el.mandeb|shipping lanes?|commercial vessels?|tankers?|maritime|piracy)\b/i, /\b(attacks?|mines?|seiz\w+|hit|control|retreat|blockad\w+|clos\w+|disrupt\w+)\b/i],
  ['transport_disruption', /\b(ports?|airports?|flights?|airspace|railways?|borders?|terminals?|shipping|crossings?|dockworkers|ground stop)\b/i, /\b(strikes?|clos\w+|cancell?\w+|delay\w+|congestion|suspend\w+|collision|ground stop|restrict\w+|reopen\w+|disrupt\w+)\b/i],
  ['trade_policy', /\b(tariffs?|sanctions?|export controls?|trade talks?|trade deal|trade agreement|customs|export ban|trade restrictions?)\b/i, /\b(impos\w+|announc\w+|agree\w+|fail\w*|sign\w*|lift\w*|rais\w+|cut\w*|ban\w*|consider\w+|talks?|deal)\b/i],
  ['security_development', /\b(houthis?|armed forces|military|troops|missiles?|drone|armed group|ceasefire|rebels?|carrier)\b/i, /\b(attack\w*|advance\w*|retreat\w*|control|strike\w*|deploy\w*|arriv\w+|ceasefire|defend|capture\w*)\b/i],
  ['natural_hazard', /\b(earthquake|wildfires?|cyclones?|typhoons?|hurricanes?|flood\w*|volcan\w+)\b/i, /\b(alert\w*|warn\w*|hit|kill\w*|haze|evacu\w+|clos\w+|spread\w*|apologis\w+|damag\w+)\b/i],
  ['market_change', /\b(freight rates?|oil prices?|fuel prices?|shipping rates?|cargo capacity|container rates?)\b/i, /\b(rise\w*|fell|fall\w*|surge\w*|jump\w*|drop\w*|climb\w*|declin\w+)\b/i],
  ['infrastructure_incident', /\b(power grid|communications network|pipeline|oil refinery|subsea cable|infrastructure)\b/i, /\b(outage|blackout|fail\w*|explosion|fire|attack\w*|damage\w*|restor\w+)\b/i],
];
const backgroundTitle = /^(opinion|analysis|explainer|briefing|editorial|why\b|what\b|how\b)|\bcannot be secured without\b|\b(questions|what.s next)\s*\??$/i;
const intersection = (a,b) => [...a].filter(x=>b.has(x));
const actions = [
  ['territorial_change', /\b(retreat\w*|advance\w*|capture\w*|control|defend|withdraw\w*)\b/i],
  ['closure', /\b(clos\w+|shut\w*|stop\w*|suspend\w*)\b/i],
  ['reopening', /\b(reopen\w*|resum\w*|restor\w*)\b/i],
  ['labor_action', /\b(strike\w*|walkout\w*|stoppage\w*)\b/i],
  ['attack', /\b(attack\w*|hit|bomb\w*|seiz\w+)\b/i],
];
const actionFor = title => actions.find(([,pattern])=>pattern.test(title))?.[0] ?? null;

export function clusterNews(records, findPlaces) {
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
  const recent = (a,b)=>Number.isFinite(a.at) && Number.isFinite(b.at) && Math.abs(a.at-b.at)<=WINDOW_MS;
  const sharedPlace = (a,b)=>intersection(a.places,b.places).length;
  const candidates = articles.filter(item=>item.topic && !item.background);
  const groups = clusterTexts(candidates.map(item=>item.headline)).flatMap(indices=>{
    const windows = [];
    for (const index of indices) {
      const item = candidates[index];
      const current = windows.at(-1);
      if (current && recent(item,current[0])) current.push(item);
      else windows.push([item]);
    }
    return windows;
  });
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

export const routeTopics = new Set(['maritime_security','transport_disruption','natural_hazard','infrastructure_incident']);
