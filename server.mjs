import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { feeds, normalize } from './feed.mjs';
import { buildEvents } from './events.mjs';
import { loadNetwork } from './network.mjs';
import { samples } from './samples.mjs';
const networkDirectory = process.env.RISK_NETWORK_DATA_DIR || fileURLToPath(new URL('./data/',import.meta.url));
const network = await loadNetwork(networkDirectory, process.env.RISK_NETWORK_DATA_DIR ? '自定义线路数据' : 'risk_network 默认线路');
const origin = process.env.WM_BASE_URL;
const exec = promisify(execFile);
const key = process.env.WM_API_KEY;
const routes = {'/':'index.html','/app.js':'app.js','/style.css':'style.css'};
const mime = {html:'text/html',js:'text/javascript',css:'text/css'};
async function getFeed(kind, path, mode) {
  try {
    let data = samples[kind];
    if (mode === 'live' && !origin) {
      if (kind !== 'news') return {kind,state:'not_configured',records:[]};
      const {stdout} = await exec('python3', [fileURLToPath(new URL('./public-news.py', import.meta.url))], {
        timeout: 24000, maxBuffer: 2 * 1024 * 1024,
      });
      const payload = JSON.parse(stdout);
      const errors = payload.feedStatus.filter(feed=>feed.error);
      const records = normalize(kind, payload).map(record => ({
        ...record,
        id: record.id.replace(/^worldmonitor:/, 'rss:'),
        source:{...record.source,provider:'Publisher RSS',endpoint:null},
      }));
      return {kind, records, feedStatus:payload.feedStatus, state:errors.length === payload.feedStatus.length ? 'unavailable' : errors.length ? 'partial' : records.length ? 'ok' : 'empty',
        error:errors.length ? errors.map(feed=>feed.name).join('、')+' 获取失败' : null};
    }
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
const server = createServer(async (req,res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/feed') {
      const mode = url.searchParams.get('mode') === 'live' ? 'live' : 'sample';
      const sources = await Promise.all(Object.entries(feeds).map(([kind,path]) => getFeed(kind,path,mode)));
      res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
      res.end(JSON.stringify({schemaVersion:'0.2',mode,liveSource:origin ? 'self-hosted' : 'rss',fetchedAt:new Date().toISOString(),sources,network:network.summary,events:buildEvents(sources,mode, record=>network.annotate({records:[{...record,summary:null}]}).networkMatches.map(match=>match.nodeId)).map(event=>network.annotate(event))})); return;
    }
    const file = routes[url.pathname];
    if (!file) {res.writeHead(404); res.end('Not found'); return;}
    const body = await readFile(new URL(`./public/${file}`,import.meta.url));
    res.writeHead(200,{'content-type':mime[file.split('.').at(-1)]+'; charset=utf-8'}); res.end(body);
  } catch {res.writeHead(500);res.end('Server error');}
});
const port = Number(process.env.PORT || 4179);
server.listen(port,'127.0.0.1',()=>console.log(`External event demo: http://127.0.0.1:${port}`));
