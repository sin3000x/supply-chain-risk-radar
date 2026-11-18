import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {readFile, stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {brotliCompressSync, gzipSync, constants as zlib} from 'node:zlib';
import {installEnvProxy} from './proxy-fetch.mjs';

const proxyStatus = installEnvProxy();
if (proxyStatus.enabled) {
  const parts = [
    proxyStatus.httpProxy && `http=${proxyStatus.httpProxy}`,
    proxyStatus.httpsProxy && `https=${proxyStatus.httpsProxy}`,
    proxyStatus.allProxy && `all=${proxyStatus.allProxy}`,
    proxyStatus.noProxy && `no_proxy=${proxyStatus.noProxy}`,
  ].filter(Boolean);
  console.log(`Outbound proxy enabled (${parts.join(', ')})`);
}

import {feeds, normalize} from './feed.mjs';
import {openEventStore} from './event-store.mjs';
import {buildEvents} from './events.mjs';
import {applyPresentation, presentEvent} from './event-presentation.mjs';
import {createForecastTranslator, createPresentationQueue} from './model-presentation.mjs';
import {openModelSettings} from './model-settings.mjs';
import {openIntakeSettings} from './intake-settings.mjs';
import {loadNetwork} from './network.mjs';
import {createEventLocator, regions} from './geography.mjs';
import {createFeedReader} from './rss.mjs';
import {createSignalReader} from './signals.mjs';
import {createMarketReader} from './markets.mjs';
import {samples} from './samples.mjs';

const networkDirectory = process.env.RISK_NETWORK_DATA_DIR || fileURLToPath(new URL('./data/',import.meta.url));
const network = await loadNetwork(networkDirectory, process.env.RISK_NETWORK_DATA_DIR ? '自定义线路数据' : 'risk_network 默认线路');
const findPlaces = record => network.findPlaces(record);
const locateEvent = createEventLocator(network);
const present = event => presentEvent({...network.annotate(event),geo:locateEvent(event)});
const modelSettings = await openModelSettings();
const intakeSettings = await openIntakeSettings();
const eventStore = await openEventStore(
  process.env.EVENT_STORE_PATH || fileURLToPath(new URL('./var/events.json',import.meta.url)),
  findPlaces,
  {getWindowMs: () => intakeSettings.read().clusterWindowHours * 3600_000},
);
// Chinese event titles and progress are written in the background and stored with each event.
const presenter = createPresentationQueue({store:eventStore,getProfile:()=>modelSettings.read()});
const forecastTranslator = await createForecastTranslator({
  getProfile: () => modelSettings.read(),
  cachePath: process.env.MARKET_TRANSLATIONS_PATH || fileURLToPath(new URL('./var/market-translations.json',import.meta.url)),
});
function withPresentation(event) {
  let result = applyPresentation(event,eventStore.get(event.id)?.presentation);
  if (!result.records?.some(record => record.kind === 'forecast')) return result;
  let changed = false;
  const records = result.records.map(record => {
    if (record.kind !== 'forecast') return record;
    const zh = forecastTranslator.get(record.title);
    if (!zh) return record;
    changed = true;
    return {...record,title:zh};
  });
  if (!changed) return result;
  result = {...result,records};
  if (!result.displayTitle && records.length === 1 && records[0].kind === 'forecast') {
    result.displayTitle = records[0].title;
  }
  return result;
}
const origin = process.env.WM_BASE_URL;
const key = process.env.WM_API_KEY;
const readRss = createFeedReader(undefined, {getSettings: () => intakeSettings.read()});
const readLiveSignals = createSignalReader({findPlaces, getSettings: () => intakeSettings.read()});
const readLiveMarkets = createMarketReader({findPlaces, getSettings: () => intakeSettings.read()});

const assets = ['index.html','app.js','style.css','favicon.svg','vendor/worldmonitor/countries.geojson'];
const mime = {html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',mjs:'text/javascript; charset=utf-8',
  css:'text/css; charset=utf-8',svg:'image/svg+xml; charset=utf-8',geojson:'application/geo+json; charset=utf-8'};
const routes = new Map(assets.map(file => [file === 'index.html' ? '/' : '/'+file, {
  url:new URL(`./public/${file}`,import.meta.url),
  type:mime[file.split('.').at(-1)],
}]));

async function readAsset(route) {
  const {ino, size, mtimeNs, ctimeNs} = await stat(route.url,{bigint:true});
  const version = `${ino}:${size}:${mtimeNs}:${ctimeNs}`;
  if (route.cached?.version === version) return route.cached;
  const body = await readFile(route.url);
  route.cached = {
    version, type:route.type, body,
    etag:`"${createHash('sha256').update(body).digest('base64url').slice(0,22)}"`,
    br:brotliCompressSync(body,{params:{[zlib.BROTLI_PARAM_QUALITY]:5}}), gzip:gzipSync(body),
  };
  return route.cached;
}

async function readLiveNews() {
  const payload = await readRss();
  const errors = payload.feedStatus.filter(feed=>feed.error);
  const records = normalize('news', payload).map(record => ({
    ...record,
    id: record.id.replace(/^worldmonitor:/, 'rss:'),
    source:{...record.source,provider:'Publisher RSS',endpoint:null},
  }));
  const failed = errors.filter(feed=>!feed.count);
  return {kind:'news', records, feedStatus:payload.feedStatus,
    state:failed.length === payload.feedStatus.length ? 'unavailable' : errors.length ? 'partial' : records.length ? 'ok' : 'empty',
    error:errors.length ? errors.map(feed=>feed.name).join('、')+' 获取失败' : null};
}

async function getFeed(kind, path, mode) {
  try {
    if (mode === 'live' && !origin) {
      if (kind === 'news') return await readLiveNews();
      if (kind === 'signal') return await readLiveSignals();
      if (kind === 'forecast') return await readLiveMarkets();
      return {kind,state:'not_configured',records:[]};
    }
    let data = samples[kind];
    if (mode === 'live') {
      const response = await fetch(new URL(`/api/${path}`, origin), {
        headers:{accept:'application/json', ...(key ? {'X-WorldMonitor-Key':key} : {})},
        signal:AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`WorldMonitor HTTP ${response.status}`);
      data = await response.json();
    }
    const records = normalize(kind, data);
    if (mode === 'sample') for (const record of records) {
      record.id = record.id.replace('worldmonitor:', 'sample:');
      record.source.provider = '虚构样例';
    }
    const coverage = data.coverage?.state || null;
    const state = data.degraded || data.upstreamUnavailable || coverage === 'unavailable' ? 'unavailable'
      : data.stale || data.coverage?.servedStale ? 'stale' : records.length ? 'ok' : 'empty';
    return {kind, state, coverage, records};
  } catch (error) {
    return {kind,state:'unavailable',error:error.cause?.code || error.message,records:[]};
  }
}

function describeSourceRule(kind, mode, intake) {
  if (mode === 'sample') return '虚构演示样例，仅用于界面预览与功能验证';
  if (origin) return '通过自建 WorldMonitor API 拉取';
  if (kind === 'news') {
    const gnewsRule = intake.googleNewsWindowDays > 0
      ? `Google News 统一抓近 ${intake.googleNewsWindowDays} 天`
      : 'Google News 按各源默认 1–7 天';
    const ageRule = intake.newsMaxAgeHours > 0 ? ` · 仅保留近 ${intake.newsMaxAgeHours} 小时` : '';
    return `每 5 分钟刷新 · 单源最多 30 条 · ${gnewsRule}${ageRule} · ${intake.clusterWindowHours} 小时内同事件归并`;
  }
  if (kind === 'signal') {
    return `每 15 分钟刷新 · PortWatch 近 ${intake.portWatchWindowDays} 日均值对比上期/去年同期（异动 ≥${intake.portWatchThresholdPct}%）· WMO 严重/极端且未过期预警（最多 15 条）`;
  }
  if (kind === 'forecast') {
    const minVol = intake.marketMinVolume >= 1_000_000
      ? `$${(intake.marketMinVolume / 1_000_000).toFixed(1)}M`
      : `$${Math.round(intake.marketMinVolume / 1000)}K`;
    const horizonRule = intake.marketHorizonDays > 0 ? ` · 未来 ${intake.marketHorizonDays} 天内到期` : '';
    return `每 10 分钟刷新 · Polymarket 6 个地缘/贸易标签 · 成交量 ≥${minVol}${horizonRule} · 命中供应链词或地理节点（前 20 条）`;
  }
  return null;
}

// Concurrent page loads share one build; an unchanged batch reuses the last result.
let liveBuild = null;
let lastLive = {fingerprint:null,events:[]};
async function buildFeed(mode) {
  const intake = intakeSettings.read();
  const sources = await Promise.all(Object.entries(feeds).map(([kind,path]) => getFeed(kind,path,mode)));
  let events;
  let presentationPending = 0;
  if (mode === 'live') {
    const fingerprint = createHash('sha256').update(JSON.stringify({
      intake,
      records: sources.map(source=>source.records.map(record=>
        [record.id,record.time.value,record.title,record.summary,record.region,record.geoAnchors])),
    })).digest('hex');
    if (fingerprint !== lastLive.fingerprint) {
      const clusterWindowMs = intake.clusterWindowHours * 3600_000;
      const annotated = (await eventStore.update(buildEvents(sources,mode,findPlaces,{clusterWindowMs}))).map(present);
      lastLive = {fingerprint,events:annotated};
    }
    // Only queues events still missing a presentation; the response never waits for the model.
    const ids = lastLive.events.map(event=>event.id);
    const forecastTitles = lastLive.events.flatMap(event =>
      event.records.filter(record => record.kind === 'forecast').map(record => record.title));
    presenter.schedule(ids);
    forecastTranslator.schedule(forecastTitles);
    presentationPending = presenter.pending(ids) + forecastTranslator.pending(forecastTitles);
    events = lastLive.events.map(withPresentation);
  } else events = buildEvents(sources,mode,findPlaces).map(present);
  // Events carry every record they use; the full input batch would only bloat the response.
  const status = sources.map(({records,...source})=>({
    ...source,
    recordCount:records.length,
    ruleSummary:describeSourceRule(source.kind,mode,intake),
  }));
  return {schemaVersion:'0.5',mode,liveSource:origin ? 'self-hosted' : 'rss',fetchedAt:new Date().toISOString(),sources:status,
    intake:intakeSettings.describe(),network:network.summary,regions,
    ...(mode === 'live' && {presentationPending}),events};
}

function send(req, res, status, type, body, headers = {}) {
  const accepts = req.headers['accept-encoding'] ?? '';
  const encoding = body.length > 1024 ? (/\bbr\b/.test(accepts) ? 'br' : /\bgzip\b/.test(accepts) ? 'gzip' : null) : null;
  const payload = encoding === 'br' ? brotliCompressSync(body,{params:{[zlib.BROTLI_PARAM_QUALITY]:5}}) : encoding === 'gzip' ? gzipSync(body) : body;
  res.writeHead(status,{'content-type':type,vary:'accept-encoding',...(encoding ? {'content-encoding':encoding} : {}),...headers});
  res.end(payload);
}

async function handleJsonSettings(req, res, json, {label, onGet, onPut}) {
  const reply = (status, value) => send(req,res,status,json,Buffer.from(JSON.stringify(value)),{'cache-control':'no-store'});
  const host = req.headers.host ?? '';
  let sameOrigin = Boolean(host);
  if (sameOrigin && req.headers.origin) {
    try {
      const originUrl = new URL(req.headers.origin);
      sameOrigin = (originUrl.protocol === 'http:' || originUrl.protocol === 'https:') && originUrl.host === host;
    } catch {
      sameOrigin = false;
    }
  }
  if (!sameOrigin) {
    reply(403,{error:`仅可从雷达页面修改${label}。`}); return;
  }
  if (req.method === 'GET') {reply(200,onGet()); return;}
  if (req.method !== 'PUT') {reply(405,{error:'不支持的请求。'}); return;}
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
    reply(415,{error:`${label}需要 JSON。`}); return;
  }
  try {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 8192) throw Error('配置过长。');
    }
    reply(200, await onPut(JSON.parse(body)));
  } catch (error) {
    const message = error instanceof SyntaxError ? `无法读取${label}。`
      : error.code ? `无法保存${label}。` : error.message;
    reply(400,{error:message});
  }
}

const server = createServer(async (req,res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const json = 'application/json; charset=utf-8';
    if (url.pathname === '/api/model-settings') {
      await handleJsonSettings(req, res, json, {
        label: '模型配置',
        onGet: () => modelSettings.describe(),
        onPut: async payload => {
          const result = await modelSettings.update(payload);
          // A newly enabled model picks up events still showing source headlines.
          presenter.schedule(lastLive.events.map(event=>event.id));
          return result;
        },
      });
      return;
    }
    if (url.pathname === '/api/intake-settings') {
      await handleJsonSettings(req, res, json, {
        label: '采集配置',
        onGet: () => intakeSettings.describe(),
        onPut: async payload => {
          const result = await intakeSettings.update(payload);
          lastLive = {fingerprint:null, events:[]};
          return result;
        },
      });
      return;
    }
    if (url.pathname === '/api/health') {
      send(req,res,200,json,Buffer.from(JSON.stringify({ok:true,uptime:Math.round(process.uptime())})),{'cache-control':'no-store'}); return;
    }
    if (url.pathname === '/api/network') {
      send(req,res,200,json,Buffer.from(JSON.stringify(network.snapshot)),{'cache-control':'no-store'}); return;
    }
    if (url.pathname === '/api/feed') {
      const mode = url.searchParams.get('mode') === 'live' ? 'live' : 'sample';
      let result;
      if (mode === 'live') {
        liveBuild ??= buildFeed('live').finally(()=>{liveBuild = null;});
        result = await liveBuild;
      } else result = await buildFeed('sample');
      send(req,res,200,json,Buffer.from(JSON.stringify(result)),{'cache-control':'no-store'}); return;
    }
    const eventPath = url.pathname.match(/^\/api\/events\/(evt_[a-f0-9-]+)$/);
    if (eventPath) {
      const event = eventStore.get(eventPath[1]);
      const result = event ? withPresentation(present(event)) : null;
      send(req,res,event ? 200 : 404,json,Buffer.from(JSON.stringify(result ?? {error:'event_not_found'})),{'cache-control':'no-store'}); return;
    }
    const route = routes.get(url.pathname);
    if (!route) {res.writeHead(404); res.end('Not found'); return;}
    const asset = await readAsset(route);
    const headers = {'content-type':asset.type,etag:asset.etag,'cache-control':'no-cache',vary:'accept-encoding'};
    if (req.headers['if-none-match'] === asset.etag) {res.writeHead(304,headers); res.end(); return;}
    const accepts = req.headers['accept-encoding'] ?? '';
    const encoding = /\bbr\b/.test(accepts) ? 'br' : /\bgzip\b/.test(accepts) ? 'gzip' : null;
    res.writeHead(200,encoding ? {...headers,'content-encoding':encoding} : headers);
    res.end(encoding ? asset[encoding] : asset.body);
  } catch {
    if (!res.headersSent) res.writeHead(500);
    res.end('Server error');
  }
});
function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index !== -1 && index + 1 < process.argv.length) return process.argv[index + 1];
  const prefix = `${name}=`;
  return process.argv.find(arg => arg.startsWith(prefix))?.slice(prefix.length);
}
const host = readArg('--host') || process.env.HOST || '127.0.0.1';
const port = Number(readArg('--port') || process.env.PORT || 4179);
server.listen(port,host,()=>console.log(`Supply Chain Risk Radar: http://${host}:${port}`));

function shutdown(signal) {
  console.log(`Received ${signal}, shutting down...`);
  const forceExit = setTimeout(()=>process.exit(1),8000);
  forceExit.unref();
  server.close(()=>{clearTimeout(forceExit); process.exit(0);});
  server.closeIdleConnections?.();
}
process.on('SIGINT',()=>shutdown('SIGINT'));
process.on('SIGTERM',()=>shutdown('SIGTERM'));
