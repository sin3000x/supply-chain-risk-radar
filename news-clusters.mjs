import {
  CANDIDATE_STOPWORDS, STORY_SIMILARITY_THRESHOLD, clusterTexts, normalizeStoryText,
  storySimilarity, stripAttributionSuffix,
} from './vendor/worldmonitor/story-identity.js';
import {detectSyndication} from './vendor/worldmonitor/syndication.js';
import {inferGeoHubsFromTitle} from './public/vendor/worldmonitor/geo-hub-index.mjs';
import geography from './data/geography.json' with {type:'json'};

const WINDOW_MS = 48 * 3600 * 1000;
const PUB_TITLE_DEDUPE_MS = 24 * 3600 * 1000;
const escapePattern = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Merchant ship types used both for topic detection and for grouping commercial vessel attacks.
const MERCHANT_VESSELS = 'commercial vessels?|merchant (?:ships?|vessels?)|vessels?|cargo ships?|container ships?|freighters?|' +
  'lpg carriers?|lng carriers?|bulk carriers?|bulkers?|car carriers?|tankers?|supertankers?|vlccs?|ulccs?';
const maritimeSubject = new RegExp(
  `\\b(?:shipping lanes?|${MERCHANT_VESSELS}|maritime|piracy|` +
  geography.maritimeTopicAliases.map(escapePattern).join('|') + ')\\b','i');
const merchantVessel = new RegExp(`\\b(?:${MERCHANT_VESSELS}|tara gas|adnoc)\\b`, 'i');
const marketLead = /^(?:global\s+|world\s+|asian\s+|european\s+)?(?:the\s+)?(?:oil|crude|fuel|freight|shipping|container|gas|lng|energy)(?:\s*(?:,|and|&)\s*(?:\w+\s+)?(?:oil|gas|lng|fuel|diesel))?\s+(?:prices?|markets?|rates?|futures|edges?)\b/i;

const topics = [
  ['maritime_security', maritimeSubject, /\b(attacks?|mines?|seiz\w+|captur\w+|hit|hits|(?<!traffic )control|retreat|blockad\w+|clos(?:ed?|es|ing|ures?)|disrupt\w+|strike\w*|missil\w*|sink\w*|sunk|capsiz\w*|ablaze|burn\w*|disabl\w*)\b/i],
  ['transport_disruption', /\b(ports?|airports?|flights?|airspace|railways?|borders?|terminals?|shipping|crossings?|dockworkers|ground stop|bridges?)\b/i, /\b(strikes?|clos(?:ed?|es|ing|ures?)|cancell?\w+|delay\w+|congestion|suspend\w+|collision|ground stop|restrict\w+|reopen\w+|disrupt\w+|shut\w*)\b/i],
  ['trade_policy', /\b(tariffs?|sanctions?|export controls?|trade talks?|trade deal|trade agreement|customs|export ban|trade restrictions?)\b/i, /\b(impos\w+|announc\w+|agree\w+|fail\w*|sign\w*|authoris\w+|approv\w+|lift\w*|rais\w+|cut\w*|lower\w*|seek\w*|ban\w*|consider\w+|talks?|deal|extend\w+|target\w+|clamp\w*|remov\w+|delay\w+|warn\w*|threat\w*|prepar\w+|hike\w*|slap\w*)\b/i],
  ['security_development', /\b(houthis?|armed forces|military|troops|missiles?|drone|armed group|ceasefire|rebels?|carrier)\b/i, /\b(attack\w*|advance\w*|retreat\w*|(?<!traffic )control|strike\w*|deploy\w*|arriv\w+|ceasefire|defend|capture\w*|intercept\w*|thwart\w*|pull\w*\s+back|target\w*)\b/i],
  // "money floods back" / "flood of orders" are figurative; "flood-hit X" describes aftermath (aid, politics), not a new hazard.
  ['natural_hazard', /\b(earthquakes?|wildfires?|cyclones?|typhoons?|hurricanes?|floods?(?!\s+(?:back|in(?:to)?\s+(?:the\s+)?(?:market|stocks?|shares))\b)|flooding|flash floods?|volcan\w+)\b/i, /\b(alert\w*|warn\w*|(?<!-)hits?|kill\w*|haze|evacu\w+|clos(?:ed?|es|ing|ures?)|spread\w*|apologis\w+|damag\w+|strand\w*|batter\w*|lash\w*|sweep\w*|swept)\b/i],
  ['market_change', /\b(freight rates?|oil prices?|oil market|crude(?: oil)?(?: prices?)?|fuel prices?|gas prices?|shipping rates?|cargo capacity|container rates?)\b/i, /\b(rise\w*|fell|fall\w*|surge\w*|jump\w*|drop\w*|climb\w*|declin\w*|edg\w+\s+(?:up|down)|brimming|afloat|rall\w+|slump\w*|soar\w*|spike\w*|tumbl\w*|plung\w*)\b/i],
  ['infrastructure_incident', /\b(power grid|communications network|pipeline|oil refinery|subsea cable|infrastructure)\b/i, /\b(outage|blackout|fail\w*|explosion|fire|attack\w*|damage\w*|restor\w+)\b/i],
];

const marketChangeRule = topics.find(([key]) => key === 'market_change');
const nonSupplyChainNoise = new RegExp([
  // Off-topic domestic politics / litigation.
  String.raw`west\s+bank\s+settle\w*|israeli\s+settle\w*|illegal\s+settle\w*|settlement\s+expansion|settler\s+(?:sanctions?|violence)`,
  String.raw`class\s+action|individual\s+arbitration|warranty\s+agreement|\bxbox\b|fishermen\s+sue`,
  // Organised crime and policing rather than state/military security.
  String.raw`gangs?|gang\s+members?|drug\s+lords?|drug\s+cartels?|cartel\s+(?:leader|boss|chief)|narco\w*|kingpins?`,
  // Equity-market wraps ("stocks" as inventories, e.g. "crude stocks", are excluded by the lookbehind).
  String.raw`(?<!(?:crude|oil|fuel|gasoline|diesel|distillate|grain)\s)stocks?\s+(?:close|end|lower|higher|rise|rises|fall|falls|slip|gain|rally|rallies|slump|surge|tumble|edge|mixed|extend|open|near|hit)\w*`,
  String.raw`(?:asian|european|us|u\.s\.|global|world|indian|chinese|japanese|wall\s+street)\s+(?:stocks|shares|equities|bourses)`,
  String.raw`stock\s+markets?|sensex|nifty|dow\s+jones|nasdaq|s&p\s+500|nikkei\s+(?:index|average|225)|hang\s+seng`,
  // Utility rate schedules are "tariffs" too.
  String.raw`(?:large[-\s]load|electricity|power|utility|energy|water|feed[-\s]in|grid)\s+tariffs?`,
  // Aid / diplomacy pegged to an older disaster.
  String.raw`(?:aid|relief|package|donat\w+|bolster\s+ties)\b.*\b(?:flood|quake|earthquake|cyclone|typhoon|hurricane)[-\s]hit`,
].map(part => `(?:${part})`).join('|').replace(/^/, String.raw`\b(?:`).replace(/$/, String.raw`)\b`), 'i');

/** Classify a news headline into one of the radar topics, or undefined if unrelated. */
export function classifyTopic(title) {
  const text = title ?? '';
  if (nonSupplyChainNoise.test(text)) return undefined;
  if (marketLead.test(text) && marketChangeRule[2].test(text)) {
    return 'market_change';
  }
  return topics.find(([,subject,change]) => subject.test(text) && change.test(text))?.[0];
}

const backgroundTitle = /^(?:opinion|analysis|explainer|briefing|editorial|commentary|interview|column|perspective|podcast|why\b|what\b|how\b|to what extent\b)|\bcannot be secured without\b|\bwon.?t work\b|\b(questions|what.s next)\s*\??$|\|\s*(?:opinion|commentary|editorial|analysis)\b|:\s*(?:(?:how|who)\s+\d+\s+outlets\b|\d+\s+outlets\s+compared\b)/i;
const intersection = (a,b) => [...a].filter(x=>b.has(x));

const MILITARY_STRIKE_CONTEXT = /\b(military|missile|drone|mine|airstrike|carrier strike|retaliatory|naval|bomb|warship|radar)\b/i;
const actions = [
  ['territorial_change', /\b(retreat\w*|advance\w*|capture\w*|(?<!traffic )control|defend|withdraw\w*)\b/i],
  ['closure', /\b(clos\w+|shut\w*|stop\w*|suspend\w*)\b/i],
  ['reopening', /\b(reopen\w*|resum\w*|restor\w*)\b/i],
  ['attack', /\b(attack\w*|airstrikes?|drone strikes?|missile strikes?|mine strikes?|military strikes?|retaliatory strikes?|strikes?\s+(?:on|against|in)|hit|bomb\w*|seiz\w+)\b/i],
];

/** Identify the primary operational action in a news headline without confusing military strikes or trade phrases with labor strikes. */
export function actionFor(title, topic = undefined) {
  const text = title ?? '';
  // Price and policy stories mention attacks or closures only as context ("Oil falls as traders weigh Gulf attacks").
  if (topic === 'market_change' || topic === 'trade_policy') return null;
  const direct = actions.find(([,pattern]) => pattern.test(text))?.[0];
  if (direct) return direct;
  if (!MILITARY_STRIKE_CONTEXT.test(text) && (
    /\b(walkout\w*|stoppage\w*|dockworker\w*)\b/i.test(text) ||
    /(?<!forced[-\s])\blabou?r\s+(?:talks|dispute\w*|action\w*|strike\w*|unrest|shortage\w*|union\w*)\b/i.test(text) ||
    /\b(?:trade\s+union\w*|port|rail|airport|airline|pilot|transit|worker|staff|crew|national|general)\s+(?:strike\w*|union\w*)\b|\bstrike\s+(?:action|threat)\b/i.test(text) ||
    /\b(?:port|dock|rail|airport|airline)\b.*\bstrike\w*\b/i.test(text)
  )) {
    return 'labor_action';
  }
  return null;
}

const isGoogleNewsUrl = url => typeof url === 'string' && url.includes('news.google.com');

/**
 * Deduplicate news records from the same non-empty publisher and normalized headline within 24h
 * (e.g. Google News wrapper + direct RSS), keeping report role and direct URLs when available.
 */
export function dedupeNewsRecords(records) {
  const result = [];
  const byPubTitle = new Map();
  for (const record of records) {
    if (record.kind !== 'news') {
      result.push(record);
      continue;
    }
    const publisher = (record.source?.publisher ?? '').trim().toLowerCase();
    const normTitle = normalizeStoryText(stripAttributionSuffix(record.title ?? ''));
    if (!publisher || !normTitle) {
      result.push(record);
      continue;
    }
    const key = `${publisher}::${normTitle}`;
    const prevIdx = byPubTitle.get(key);
    if (prevIdx !== undefined) {
      const prev = result[prevIdx];
      const currAt = Date.parse(record.time?.value ?? '');
      const prevAt = Date.parse(prev.time?.value ?? '');
      if (Number.isFinite(currAt) && Number.isFinite(prevAt) && Math.abs(currAt - prevAt) <= PUB_TITLE_DEDUPE_MS) {
        const prevBg = prev.role === 'background';
        const currBg = record.role === 'background';
        const replaceRole = prevBg && !currBg;
        const replaceUrl = prevBg === currBg && isGoogleNewsUrl(prev.source?.url) && !isGoogleNewsUrl(record.source?.url);
        if (replaceRole || replaceUrl) result[prevIdx] = record;
        continue;
      }
    }
    byPubTitle.set(key, result.length);
    result.push(record);
  }
  return result;
}

const POLITY_PATTERNS = [
  ['US', /\b(?:u\.?s\.?a?|united states|american|washington|trump|pentagon)\b/i],
  ['EU', /\b(?:eu|european union|brussels|council,\s*european union)\b/i],
  ['UK', /\b(?:uk|u\.k\.|britain|british|london)\b/i],
  ['AU', /\b(?:australia|australian|canberra)\b/i],
  ['CN', /\b(?:china|chinese|beijing)\b/i],
  ['RU', /\b(?:russia|russian|moscow|kremlin|putin)\b/i],
  ['UA', /\b(?:ukraine|ukrainian|kyiv|crimea)\b/i],
  ['IR', /\b(?:iran|iranian|tehran|irgc)\b/i],
  ['IL', /\b(?:israel|israeli|jerusalem)\b/i],
  ['CA', /\b(?:canada|canadian|ottawa|carney)\b/i],
  ['ID', /\b(?:indonesia|indonesian|jakarta)\b/i],
  ['TH', /\b(?:thailand|thai|bangkok)\b/i],
  ['OM', /\b(?:oman|omani|muscat)\b/i],
  ['BH', /\b(?:bahrain|manama)\b/i],
  ['KW', /\b(?:kuwait)\b/i],
  ['YE', /\b(?:yemen|yemeni|houthi|houthis|aden)\b/i],
  ['EE', /\b(?:estonia|estonian|tallinn)\b/i],
  ['KR', /\b(?:south korea|korean|seoul)\b/i],
  ['IN', /\b(?:india|indian)\b/i],
  ['AE', /\b(?:uae|emirates|adnoc|dubai)\b/i],
];

function extractPolities(headline, publisher = '') {
  const all = new Set();
  const lead = new Set();
  const leadClause = (headline ?? '').split(/\b(?:following|despite|as|amid)\b|[,;—–]/i)[0] ?? headline ?? '';
  for (const [code, rx] of POLITY_PATTERNS) {
    if (rx.test(headline)) all.add(code);
    if (rx.test(leadClause)) lead.add(code);
  }
  if (!lead.size && publisher) {
    for (const [code, rx] of POLITY_PATTERNS) {
      if (rx.test(publisher)) {
        lead.add(code);
        all.add(code);
        break;
      }
    }
  }
  return {all, lead};
}

// Generic bigrams that denote broad recurring categories rather than one discrete incident.
const GENERIC_PHRASES = new Set([
  'oil tanker', 'tanker attack', 'oil price', 'fuel price', 'middle east',
  'new sanction', 'impose sanction', 'cargo ship', 'commercial vessel',
  'military strike', 'armed force', 'drone attack', 'missile strike',
  'trade talk', 'air traffic', 'iranian army', 'navy say', 'official say',
  'maritime agency', 'marine monitor', 'foreign minister', 'ukmto report',
  'vessel attack', 'mine attack', 'tanker hit', 'hit near', 'fire erupt',
]);

const GENERIC_WORDS = new Set([
  'say','says','said','report','reports','reported','claim','claims','new','fresh','another',
  'more','latest','update','war','amid','after','over','near','east','eastern','west','western',
  'north','northern','south','southern','global','world','country','countries','government','governments',
  'official','officials','minister','president','force','forces','army','navy','guard','guards',
  'military','security','attack','attacks','strike','strikes','hit','hits','hitting','fire','caught',
  'catch','burn','burning','ablaze','oil','tanker','tankers','vessel','vessels','ship','ships',
  'shipping','maritime','strait','sea','canal','port','ports','flight','flights','air','border',
  'trade','tariff','tariffs','sanction','sanctions','deal','agreement','talks','price','prices',
  'market','crude','fuel','energy','group','state','states','nation','national','company',
  'companies','firm','firms','organization','organizations','organisation','organisations','individual',
  'individuals','people','person','member','target','targets','targeting','targeted','impose','imposes',
  'announce','announces','announced','issue','issues','warn','warns','threat','threatens','move',
  'push','plan','plans','seek','seeks','continue','continues','persist','persists','remain','remains',
  'two','three','four','five','six','first','second','third','fourth','fifth','sixth','day','days',
  'week','weeks','month','months','year','years','today','yesterday','friday','monday','tuesday',
  'wednesday','thursday','saturday','sunday','ukmto','agency','monitor','monitors','revolutionary',
  'disable','disabled','disrupt','disrupted','disruption','close','closes','closed','closure',
  'shut','launch','launches','launched','confirm','confirms','confirmed','expand','expands','expanded',
  'extend','extends','extended','approve','approves','approved','authorise','authorises','sign','signature',
  'agree','agrees','agreed','reach','reaches','reached','cut','cuts','lower','lowers','raise','raises',
  'fail','fails','failed','stop','stops','work','works','could','would','should','still','keep','keeps',
]);

function stemWord(word) {
  if (word.length > 5 && word.endsWith('ies')) return word.slice(0, -3) + 'y';
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 5 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 5 && /(?:sh|ch|x|z|ss)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

function maritimeKind(headline, topic) {
  if (topic !== 'maritime_security' && topic !== 'security_development') return null;
  if (topic === 'maritime_security' && /\b(discuss|talks?|deal|agreement|safeguarding)\b/i.test(headline) &&
    !/\b(hit|mine|fire|ablaze|missing|struck|strike\w*|projectile|capsiz\w*|sink\w*|sunk)\b/i.test(headline)) return 'diplomacy';
  if (/\b(seiz\w+|captur\w+)\b.*\bdrone\b|\bdrone\b.*\b(seiz\w+|captur\w+)\b/i.test(headline)) return 'drone_capture';
  if (/\b(qeshm|missile\s+site)\b/i.test(headline)) return 'island_strike';
  if (/\bblockad\w+\b/i.test(headline) && !/\b(tankers?|cargo ships?|lpg|lng)\b/i.test(headline)) return 'blockade';
  if (topic === 'maritime_security' && /\b(declares?\b.*\bclosed|kept\b.*\bshut)\b/i.test(headline)) return 'closure';
  if (topic === 'maritime_security' &&
    merchantVessel.test(headline) &&
    /\b(attacks?|mines?|hit|hits|hitting|strike\w*|struck|projectile|missil\w*|fire|ablaze|burn\w*|sink\w*|sunk|capsiz\w*|disabl\w*|abandon\w*|injur\w*|crew|missing|safe|accounted|blast\w*|target\w*)\b/i.test(headline)) {
    return 'vessel_attack';
  }
  return null;
}

const physicalTopics = new Set(['maritime_security', 'transport_disruption', 'natural_hazard', 'infrastructure_incident']);
const CASUALTY_KINDS = new Set(['vessel_attack']);
const maritimeZones = places => new Set([...places].filter(id => id.startsWith('CP_') || id.startsWith('SEA_')));

function extractArticleMeta(headline, recordPlaces, topic, publisher) {
  const hubs = inferGeoHubsFromTitle(headline);
  const placeWords = new Set(hubs.flatMap(({hub, matchedKeyword}) =>
    normalizeStoryText(`${matchedKeyword} ${hub.name}`).split(' ')));
  const rawWords = normalizeStoryText(headline).split(' ');
  const phraseWords = rawWords.map(word =>
    word.length < 3 || CANDIDATE_STOPWORDS.has(word) || placeWords.has(word) ? null
      : word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word);
  const phrases = new Set();
  for (let i = 1; i < phraseWords.length; i++) {
    if (phraseWords[i - 1] && phraseWords[i]) {
      const phrase = phraseWords[i - 1] + ' ' + phraseWords[i];
      if (!GENERIC_PHRASES.has(phrase)) phrases.add(phrase);
    }
  }
  const specWords = new Set();
  const contentWords = new Set();
  for (const word of rawWords) {
    if (word.length < 3 || CANDIDATE_STOPWORDS.has(word) || placeWords.has(word)) continue;
    const stemmed = stemWord(word);
    contentWords.add(stemmed);
    if (!GENERIC_WORDS.has(word) && !GENERIC_WORDS.has(stemmed)) specWords.add(stemmed);
  }
  const canonHubs = new Set(hubs.map(({hub, hubId}) => hub.networkId || hubId));
  const places = new Set([...recordPlaces, ...canonHubs]);
  const zones = maritimeZones(places);
  const polities = extractPolities(headline, publisher);
  const mKind = maritimeKind(headline, topic);
  return {phrases, specWords, contentWords, places, zones, polities, mKind};
}

function buildArticle(record, findPlaces, fallbackTopic) {
  const title = record.title ?? '';
  const headline = stripAttributionSuffix(title);
  const topic = classifyTopic(title) ?? fallbackTopic ?? null;
  const recordPlaces = record.geoAnchors?.length ? record.geoAnchors : findPlaces(record);
  const meta = extractArticleMeta(headline, recordPlaces, topic, record.source?.publisher ?? '');
  return {
    record,
    at: Date.parse(record.time?.value ?? ''),
    headline,
    places: new Set(recordPlaces),
    topic,
    contextTopics: topics.filter(([,subject]) => subject.test(title)).map(([key]) => key),
    background: record.role === 'background' || backgroundTitle.test(title),
    action: actionFor(title, topic),
    meta,
  };
}

function crossTopicAllowed(t1, t2) {
  if (t1 === t2) return true;
  if (!t1 || !t2) return false;
  const pair = [t1, t2].sort().join('+');
  return pair === 'maritime_security+security_development' || pair === 'security_development+transport_disruption';
}

function politiesConflict(leadA, leadB) {
  if (!leadA.size || !leadB.size) return false;
  const onlyInA = [...leadA].some(code => !leadB.has(code));
  const onlyInB = [...leadB].some(code => !leadA.has(code));
  return onlyInA && onlyInB;
}

function maritimeKindsConflict(kindsA, kindsB) {
  for (const ka of kindsA) {
    for (const kb of kindsB) {
      if (ka !== kb) return true;
    }
  }
  return false;
}

function articlesMatch(a, b, recent) {
  if (!crossTopicAllowed(a.topic, b.topic)) return false;
  if (a.topic === 'market_change' || b.topic === 'market_change') return false;
  if (!recent(a, b)) return false;
  if (a.meta.mKind && b.meta.mKind && maritimeKindsConflict([a.meta.mKind], [b.meta.mKind])) return false;

  if (a.meta.zones.size > 0 && b.meta.zones.size > 0 && intersection(a.meta.zones, b.meta.zones).length === 0) {
    return false;
  }

  const sim = storySimilarity(a.headline, b.headline);
  const sharedPlaces = intersection(a.meta.places, b.meta.places);
  const sharedPhrases = intersection(a.meta.phrases, b.meta.phrases);
  const sharedSpec = intersection(a.meta.specWords, b.meta.specWords);
  const sharedContent = intersection(a.meta.contentWords, b.meta.contentWords);
  const sharedPolities = intersection(a.meta.polities.all, b.meta.polities.all);

  const bothHavePlaces = a.meta.places.size > 0 && b.meta.places.size > 0;
  const oneHasPlaces = (a.meta.places.size > 0) !== (b.meta.places.size > 0);
  if (oneHasPlaces && sim < 0.55) return false;

  const bothVesselAttacks = a.meta.mKind === 'vessel_attack' && b.meta.mKind === 'vessel_attack';
  if (bothHavePlaces && sharedPlaces.length === 0 && !(bothVesselAttacks && sharedPhrases.length > 0)) {
    return false;
  }

  const casualtyPair = CASUALTY_KINDS.has(a.meta.mKind) || CASUALTY_KINDS.has(b.meta.mKind);
  if (!casualtyPair && politiesConflict(a.meta.polities.lead, b.meta.polities.lead)) return false;

  // Rule 1: Specific incident phrase match for physical disruptions (e.g. "ground stop", "tara gas").
  if (sharedPhrases.length > 0 && (physicalTopics.has(a.topic) || physicalTopics.has(b.topic))) {
    if (!oneHasPlaces) return true;
  }

  // Rule 2: Trade policy — require actor+target overlap and minimum lexical support (never fall through to Rule 4).
  if (a.topic === 'trade_policy' || b.topic === 'trade_policy') {
    if (a.topic !== b.topic) return false;
    const geoOverlap = new Set([...sharedPlaces, ...sharedPolities]).size;
    if (sim >= 0.45 && geoOverlap >= 1) return true;
    if (geoOverlap >= 2 && ((sharedSpec.length >= 1 && sim >= 0.24) || sharedSpec.length >= 2 || (sharedContent.length >= 2 && sim >= 0.30))) {
      return true;
    }
    return false;
  }

  // Rule 3: Maritime security — group commercial vessel attacks per chokepoint; keep military/diplomacy separate.
  if (a.topic === 'maritime_security' || b.topic === 'maritime_security') {
    if (bothVesselAttacks && sharedPlaces.length > 0) return true;
    if (!sharedPlaces.length) return false;
    if (a.meta.mKind && a.meta.mKind === b.meta.mKind) {
      if (a.meta.mKind === 'closure' || sim >= 0.30 || sharedSpec.length >= 1 || sharedPhrases.length >= 1 || sharedPolities.length >= 2) {
        return true;
      }
    }
    return sim >= 0.54;
  }

  // Rule 4: Security development / transport disruption with shared place.
  if (sharedPlaces.length > 0) {
    if (sim >= 0.46) return true;
    if (a.topic === b.topic && sharedSpec.length >= 1 && (sharedPlaces.length >= 2 || sharedPolities.length >= 2 || sim >= 0.32)) {
      return true;
    }
    if (a.topic === b.topic && sharedSpec.length >= 2 && sim >= 0.25) return true;
    if (a.topic !== b.topic && sim >= 0.35 && (sharedSpec.length >= 2 || (sharedPlaces.length >= 2 && sharedSpec.length >= 1))) {
      return true;
    }
  }

  // Rule 5: Placeless physical disruptions sharing polity and specific terms (e.g. US nationwide ground stop).
  if (a.topic === b.topic && physicalTopics.has(a.topic) && !bothHavePlaces && !oneHasPlaces) {
    if (sharedPolities.length >= 1 && sharedSpec.length >= 1 && sim >= 0.35) return true;
  }

  return false;
}

function groupDescriptor(members) {
  const times = members.map(m => m.at).filter(Number.isFinite);
  const minAt = times.length ? Math.min(...times) : NaN;
  const maxAt = times.length ? Math.max(...times) : NaN;
  const leadPolities = new Set(members.flatMap(m => [...m.meta.polities.lead]));
  const mKinds = new Set(members.map(m => m.meta.mKind).filter(Boolean));
  const places = new Set(members.flatMap(m => [...m.meta.places]));
  const zones = new Set(members.flatMap(m => [...m.meta.zones]));
  return {members: [...members], minAt, maxAt, leadPolities, mKinds, places, zones};
}

function canMergeGroups(ga, gb, windowMs, recent, allowCopySimilarity = false) {
  const bothVesselCrisis = ga.mKinds.size === 1 && ga.mKinds.has('vessel_attack') &&
    gb.mKinds.size === 1 && gb.mKinds.has('vessel_attack');
  const maxSpanMs = bothVesselCrisis
    ? Math.max(windowMs * 3, 7 * 24 * 3600_000)
    : Math.round(windowMs * 1.5);
  if (Number.isFinite(ga.minAt) && Number.isFinite(ga.maxAt) && Number.isFinite(gb.minAt) && Number.isFinite(gb.maxAt)) {
    if (Math.max(ga.maxAt, gb.maxAt) - Math.min(ga.minAt, gb.minAt) > maxSpanMs) return false;
  }
  const hasCasualty = [...ga.mKinds, ...gb.mKinds].some(k => CASUALTY_KINDS.has(k));
  if (!hasCasualty && politiesConflict(ga.leadPolities, gb.leadPolities)) return false;
  if (maritimeKindsConflict(ga.mKinds, gb.mKinds)) return false;
  if (ga.zones.size > 0 && gb.zones.size > 0 && intersection(ga.zones, gb.zones).length === 0) return false;

  const anchorA = ga.members[0];
  const anchorB = gb.members[0];
  if (!crossTopicAllowed(anchorA.topic, anchorB.topic)) return false;
  if (!bothVesselCrisis && anchorA.meta.places.size > 0 && anchorB.meta.places.size > 0 &&
    intersection(anchorA.meta.places, anchorB.meta.places).length === 0) {
    return false;
  }
  return ga.members.some(a => gb.members.some(b =>
    articlesMatch(a, b, recent) ||
    (allowCopySimilarity && a.topic === b.topic && recent(a, b) &&
      storySimilarity(a.headline, b.headline) >= STORY_SIMILARITY_THRESHOLD)
  ));
}

export function clusterNews(records, findPlaces = () => [], { windowMs = WINDOW_MS } = {}) {
  const deduped = dedupeNewsRecords(records);
  const articles = deduped
    .map(record => buildArticle(record, findPlaces))
    .sort((a,b) => a.at - b.at || a.record.id.localeCompare(b.record.id));
  const recent = (a,b) => Number.isFinite(a.at) && Number.isFinite(b.at) && Math.abs(a.at - b.at) <= windowMs;
  const sharedPlace = (a,b) => intersection(a.places, b.places).length;
  const candidates = articles.filter(item => item.topic && !item.background);

  const copies = clusterTexts(candidates.map(item => item.headline)).flatMap(indices => {
    const windows = [];
    for (const index of indices) {
      const item = candidates[index];
      const target = windows.find(w =>
        recent(item, w[0]) &&
        crossTopicAllowed(item.topic, w[0].topic) &&
        !(item.meta.places.size > 0 && w[0].meta.places.size > 0 &&
          intersection(item.meta.places, w[0].meta.places).length === 0));
      if (target) target.push(item);
      else windows.push([item]);
    }
    return windows;
  });

  const groups = threadIncidents(copies, recent, windowMs);
  // Attach context to one clear match so commentary cannot bridge two event groups.
  const context = new Map();
  for (const item of articles.filter(item => item.background)) {
    const matches = groups.filter(group => group.some(other => recent(item, other) &&
      item.contextTopics.includes(other.topic) &&
      sharedPlace(item, other)));
    if (matches.length === 1) {
      if (!context.has(matches[0])) context.set(matches[0], []);
      context.get(matches[0]).push({...item.record, role:'background'});
    }
  }
  return groups.map(group => {
    const summary = summarizeNewsRecords(group.map(item => ({...item.record, role:'report'})), findPlaces);
    return {
      primary: group[0].record,
      topic: summary.topic,
      action: summary.action,
      corroborationCount: summary.corroborationCount,
      records: [...group.map(item => ({...item.record, role:'report'})), ...(context.get(group) ?? [])],
    };
  });
}

function threadIncidents(groups, recent, windowMs) {
  const info = groups.map(group => groupDescriptor(group));
  const parent = info.map((_,i) => i);
  const find = i => parent[i] === i ? i : (parent[i] = find(parent[i]));
  for (let i = 0; i < info.length; i++) for (let j = i + 1; j < info.length; j++) {
    const ri = find(i), rj = find(j);
    if (ri === rj) continue;
    const a = info[ri], b = info[rj];
    if (!canMergeGroups(a, b, windowMs, recent, false)) continue;
    // Merge into the root that started earlier so the group keeps its first report.
    const [keep, drop] = ri < rj ? [ri, rj] : [rj, ri];
    parent[drop] = keep;
    const target = info[keep], source = info[drop];
    target.members.push(...source.members);
    target.members.sort((x, y) => x.at - y.at || x.record.id.localeCompare(y.record.id));
    target.minAt = Math.min(target.minAt, source.minAt);
    target.maxAt = Math.max(target.maxAt, source.maxAt);
    for (const polity of source.leadPolities) target.leadPolities.add(polity);
    for (const kind of source.mKinds) target.mKinds.add(kind);
    for (const place of source.places) target.places.add(place);
    for (const zone of source.zones) target.zones.add(zone);
  }
  return info.filter((_,i) => find(i) === i).map(({members}) =>
    members.sort((a,b) => a.at - b.at || a.record.id.localeCompare(b.record.id)));
}

/** Check across snapshots whether two sets of news reports belong to the same event. */
export function canJoinEvent(prevRecords, incRecords, findPlaces = () => [], { windowMs = WINDOW_MS, prevTopic = null, incTopic = null } = {}) {
  const prevArticles = prevRecords.filter(r => r.kind === 'news' && r.role !== 'background')
    .map(r => buildArticle(r, findPlaces, prevTopic))
    .filter(a => a.topic && !a.background)
    .sort((a, b) => a.at - b.at || a.record.id.localeCompare(b.record.id));
  const incArticles = incRecords.filter(r => r.kind === 'news' && r.role !== 'background')
    .map(r => buildArticle(r, findPlaces, incTopic))
    .filter(a => a.topic && !a.background)
    .sort((a, b) => a.at - b.at || a.record.id.localeCompare(b.record.id));
  if (!prevArticles.length || !incArticles.length) return false;
  const recent = (a, b) => Number.isFinite(a.at) && Number.isFinite(b.at) && Math.abs(a.at - b.at) <= windowMs;
  return canMergeGroups(groupDescriptor(prevArticles), groupDescriptor(incArticles), windowMs, recent, true);
}

/** Recompute canonical event metadata from its full chronological news report history. */
export function summarizeNewsRecords(newsRecords, findPlaces = () => [], { previous = null, incoming = null } = {}) {
  const sorted = [...newsRecords].sort((a, b) =>
    (a.time?.value ?? '').localeCompare(b.time?.value ?? '') || a.id.localeCompare(b.id));
  const anchor = sorted[0];
  const reportTopics = sorted.map(r => classifyTopic(r.title)).filter(Boolean);
  const derivedTopic = reportTopics.find(t => t === 'maritime_security') ??
    reportTopics.find(t => routeTopics.has(t)) ?? reportTopics[0] ?? null;
  const topic = previous?.topic ?? incoming?.topic ?? derivedTopic;
  const routeRelevant = topic ? routeTopics.has(topic) : (incoming?.routeRelevant ?? previous?.routeRelevant ?? true);
  const action = sorted.map(r => actionFor(r.title, topic)).find(Boolean) ?? (topic === 'market_change' || topic === 'trade_policy'
    ? null : incoming?.action ?? previous?.action ?? null);
  const corroborationCount = detectSyndication(sorted.map(record => ({
    title: record.title,
    snippet: record.summary,
    source: record.source?.publisher ?? '',
  }))).publishers;
  const allPlaces = new Set(sorted.flatMap(r => r.geoAnchors?.length ? r.geoAnchors : findPlaces(r)));
  const geoAnchors = anchor?.geoAnchors?.length
    ? anchor.geoAnchors
    : (routeRelevant !== false && allPlaces.size === 1 ? [...allPlaces] : null);
  return {
    title: anchor?.title ?? incoming?.title ?? previous?.title ?? '',
    region: anchor?.region ?? incoming?.region ?? previous?.region ?? null,
    topic,
    action,
    corroborationCount,
    routeRelevant,
    geoAnchors,
  };
}

export const routeTopics = new Set(['maritime_security','transport_disruption','natural_hazard','infrastructure_incident']);
