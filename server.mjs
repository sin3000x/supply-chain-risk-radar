import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {brotliCompressSync, gzipSync, constants as zlib} from 'node:zlib';
import {feeds, normalize} from './feed.mjs';
import {openEventStore} from './event-store.mjs';
import {buildEvents} from './events.mjs';
import {loadNetwork} from './network.mjs';
import {createFeedReader} from './rss.mjs';
import {samples} from './samples.mjs';

const networkDirectory = process.env.RISK_NETWORK_DATA_DIR || fileURLToPath(new URL('./data/',import.meta.url));
const network = await loadNetwork(networkDirectory, process.env.RISK_NETWORK_DATA_DIR ? '自定义线路数据' : 'risk_network 默认线路');
const findPlaces = record => network.findPlaces(record);
const eventStore = await openEventStore(process.env.EVENT_STORE_PATH || fileURLToPath(new URL('./var/events.json',import.meta.url)),findPlaces);
const origin = process.env.WM_BASE_URL;
const key = process.env.WM_API_KEY;
const readRss = createFeedReader();

const assets = ['index.html','app.js','geography.mjs','style.css','vendor/worldmonitor/countries.geojson',
  'vendor/worldmonitor/geo-hub-index.mjs','vendor/worldmonitor/keyword-match.mjs'];
const mime = {html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',mjs:'text/javascript; charset=utf-8',
  css:'text/css; charset=utf-8',geojson:'application/geo+json; charset=utf-8'};
// Static files are small and fixed for the life of the process: read and compress them once.
const routes = new Map(await Promise.all(assets.map(async file => {
  const body = await readFile(new URL(`./public/${file}`,import.meta.url));
  return [file === 'index.html' ? '/' : '/'+file, {
    type:mime[file.split('.').at(-1)], body,
    etag:`"${createHash('sha256').update(body).digest('base64url').slice(0,22)}"`,
    br:brotliCompressSync(body,{params:{[zlib.BROTLI_PARAM_QUALITY]:11}}), gzip:gzipSync(body,{level:9}),
  }];
})));

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
    if (mode === 'live' && !origin) return kind === 'news' ? await readLiveNews() : {kind,state:'not_configured',records:[]};
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

// Concurrent page loads share one build; an unchanged batch reuses the last result.
let liveBuild = null;
let lastLive = {fingerprint:null,events:[]};
async function buildFeed(mode) {
  const sources = await Promise.all(Object.entries(feeds).map(([kind,path]) => getFeed(kind,path,mode)));
  let events;
  if (mode === 'live') {
    const fingerprint = createHash('sha256').update(JSON.stringify(sources.map(source=>source.records.map(record=>[record.id,record.time.value,record.title,record.summary])))).digest('hex');
    if (fingerprint !== lastLive.fingerprint) {
      const annotated = (await eventStore.update(buildEvents(sources,mode,findPlaces))).map(event=>network.annotate(event));
      lastLive = {fingerprint,events:annotated};
    }
    events = lastLive.events;
  } else events = buildEvents(sources,mode,findPlaces).map(event=>network.annotate(event));
  // Events carry every record they use; the full input batch would only bloat the response.
  const status = sources.map(({records,...source})=>({...source,recordCount:records.length}));
  return {schemaVersion:'0.4',mode,liveSource:origin ? 'self-hosted' : 'rss',fetchedAt:new Date().toISOString(),sources:status,network:network.summary,events};
}

function send(req, res, status, type, body, headers = {}) {
  const accepts = req.headers['accept-encoding'] ?? '';
  const encoding = body.length > 1024 ? (/\bbr\b/.test(accepts) ? 'br' : /\bgzip\b/.test(accepts) ? 'gzip' : null) : null;
  const payload = encoding === 'br' ? brotliCompressSync(body,{params:{[zlib.BROTLI_PARAM_QUALITY]:5}}) : encoding === 'gzip' ? gzipSync(body) : body;
  res.writeHead(status,{'content-type':type,vary:'accept-encoding',...(encoding ? {'content-encoding':encoding} : {}),...headers});
  res.end(payload);
}

const server = createServer(async (req,res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const json = 'application/json; charset=utf-8';
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
      send(req,res,event ? 200 : 404,json,Buffer.from(JSON.stringify(event ? network.annotate(event) : {error:'event_not_found'})),{'cache-control':'no-store'}); return;
    }
    const asset = routes.get(url.pathname);
    if (!asset) {res.writeHead(404); res.end('Not found'); return;}
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
const port = Number(process.env.PORT || 4179);
server.listen(port,'127.0.0.1',()=>console.log(`Supply Chain Risk Radar: http://127.0.0.1:${port}`));
