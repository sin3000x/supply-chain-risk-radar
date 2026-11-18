import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import {Readable} from 'node:stream';
import {createBrotliDecompress, createGunzip, createInflate} from 'node:zlib';

const NULL_BODY_STATUSES = new Set([204, 205, 304]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 20;

function readEnv(env, lower, upper) {
  const value = env[lower] ?? env[upper];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeProxyUrl(raw) {
  if (!raw) return null;
  const withScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(raw) ? raw : `http://${raw}`;
  const parsed = new URL(withScheme);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed;
}

function defaultPort(protocol) {
  return protocol === 'https:' ? '443' : '80';
}

export function shouldBypassProxy(targetUrl, noProxyRaw) {
  if (!noProxyRaw) return false;
  const hostname = targetUrl.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = targetUrl.port || defaultPort(targetUrl.protocol);

  for (const rawEntry of noProxyRaw.split(',')) {
    const entry = rawEntry.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;

    let patternHost = entry;
    let patternPort = null;
    const bracketMatch = entry.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (bracketMatch) {
      patternHost = bracketMatch[1];
      patternPort = bracketMatch[2] ?? null;
    } else {
      const colonIndex = entry.lastIndexOf(':');
      if (colonIndex > 0 && /^\d+$/.test(entry.slice(colonIndex + 1))) {
        patternHost = entry.slice(0, colonIndex);
        patternPort = entry.slice(colonIndex + 1);
      }
    }

    if (patternPort && patternPort !== port) continue;
    const cleanPattern = patternHost.replace(/^\*\.|^\./, '');
    if (!cleanPattern) continue;
    if (hostname === cleanPattern || hostname.endsWith(`.${cleanPattern}`)) {
      return true;
    }
  }
  return false;
}

export function getProxyForUrl(targetUrl, env = process.env) {
  const url = targetUrl instanceof URL ? targetUrl : new URL(targetUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const noProxy = readEnv(env, 'no_proxy', 'NO_PROXY');
  if (shouldBypassProxy(url, noProxy)) return null;

  const rawProxy = url.protocol === 'https:'
    ? (readEnv(env, 'https_proxy', 'HTTPS_PROXY') ?? readEnv(env, 'all_proxy', 'ALL_PROXY'))
    : (readEnv(env, 'http_proxy', 'HTTP_PROXY') ?? readEnv(env, 'all_proxy', 'ALL_PROXY'));

  return normalizeProxyUrl(rawProxy);
}

export function maskProxyUrl(proxyUrl) {
  if (!proxyUrl) return '';
  const url = proxyUrl instanceof URL ? new URL(proxyUrl.href) : new URL(proxyUrl);
  if (url.password) url.password = '***';
  return url.href;
}

function buildProxyAuthHeader(proxyUrl) {
  if (!proxyUrl.username && !proxyUrl.password) return null;
  const user = decodeURIComponent(proxyUrl.username);
  const pass = decodeURIComponent(proxyUrl.password);
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

function toHeaderRecord(headers) {
  const record = {};
  for (const [key, value] of headers.entries()) {
    record[key] = value;
  }
  return record;
}

function toWebHeaders(rawHeaders) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.append(key, String(value));
    }
  }
  return headers;
}

function decodeBodyStream(res, headers) {
  const encoding = headers.get('content-encoding')?.split(',')[0]?.trim().toLowerCase();
  if (!encoding || encoding === 'identity') return res;
  let decoder = null;
  if (encoding === 'gzip' || encoding === 'x-gzip') decoder = createGunzip();
  else if (encoding === 'deflate') decoder = createInflate();
  else if (encoding === 'br') decoder = createBrotliDecompress();
  if (!decoder) return res;
  headers.delete('content-encoding');
  headers.delete('content-length');
  res.on('error', err => decoder.destroy(err));
  return res.pipe(decoder);
}

function openConnectTunnel(proxyUrl, targetUrl, signal) {
  const targetHost = targetUrl.hostname.replace(/^\[|\]$/g, '');
  const targetPort = Number(targetUrl.port || 443);
  const authority = `${targetHost}:${targetPort}`;
  const proxyAuth = buildProxyAuthHeader(proxyUrl);
  const transport = proxyUrl.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request({
      hostname: proxyUrl.hostname.replace(/^\[|\]$/g, ''),
      port: Number(proxyUrl.port || defaultPort(proxyUrl.protocol)),
      method: 'CONNECT',
      path: authority,
      headers: {
        host: authority,
        ...(proxyAuth ? {'proxy-authorization': proxyAuth} : {}),
      },
      signal,
    });

    req.once('connect', (res, socket, head) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT ${authority} failed with HTTP ${res.statusCode}`));
        return;
      }
      if (head && head.length > 0) socket.unshift(head);
      const tlsSocket = tls.connect({socket, servername: targetHost});
      const onAbort = () => tlsSocket.destroy(signal?.reason ?? new Error('Aborted'));
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, {once: true});
        tlsSocket.once('close', () => signal.removeEventListener('abort', onAbort));
      }
      resolve(tlsSocket);
    });

    req.once('error', reject);
    req.end();
  });
}

async function sendViaProxyOnce({url, method, headers, bodyBuffer, proxyUrl, signal}) {
  const outgoingHeaders = {...headers};
  if (!Object.keys(outgoingHeaders).some(k => k.toLowerCase() === 'accept-encoding')) {
    outgoingHeaders['accept-encoding'] = 'gzip, deflate, br';
  }
  if (bodyBuffer && !Object.keys(outgoingHeaders).some(k => k.toLowerCase() === 'content-length')) {
    outgoingHeaders['content-length'] = String(bodyBuffer.length);
  }

  let req;
  if (url.protocol === 'https:') {
    const tlsSocket = await openConnectTunnel(proxyUrl, url, signal);
    const agent = new https.Agent({keepAlive: false});
    agent.createConnection = () => tlsSocket;
    req = https.request({
      protocol: 'https:',
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: Number(url.port || 443),
      path: `${url.pathname}${url.search}`,
      method,
      headers: outgoingHeaders,
      agent,
      signal,
    });
  } else {
    const proxyAuth = buildProxyAuthHeader(proxyUrl);
    const transport = proxyUrl.protocol === 'https:' ? https : http;
    if (!Object.keys(outgoingHeaders).some(k => k.toLowerCase() === 'host')) {
      outgoingHeaders.host = url.host;
    }
    if (proxyAuth) outgoingHeaders['proxy-authorization'] = proxyAuth;
    req = transport.request({
      hostname: proxyUrl.hostname.replace(/^\[|\]$/g, ''),
      port: Number(proxyUrl.port || defaultPort(proxyUrl.protocol)),
      method,
      path: url.href,
      headers: outgoingHeaders,
      signal,
    });
  }

  const res = await new Promise((resolve, reject) => {
    req.once('response', resolve);
    req.once('error', reject);
    if (bodyBuffer && bodyBuffer.length > 0) req.write(bodyBuffer);
    req.end();
  });

  const responseHeaders = toWebHeaders(res.headers);
  const status = res.statusCode ?? 502;
  const statusText = res.statusMessage ?? '';

  if (method === 'HEAD' || NULL_BODY_STATUSES.has(status)) {
    res.resume();
    return new Response(null, {status, statusText, headers: responseHeaders});
  }

  const stream = decodeBodyStream(res, responseHeaders);
  const webBody = Readable.toWeb(stream);
  return new Response(webBody, {status, statusText, headers: responseHeaders});
}

export function createProxyFetch({baseFetch = globalThis.fetch, env = process.env} = {}) {
  return async function proxyFetch(input, init) {
    const request = input instanceof Request && init === undefined ? input : new Request(input, init);
    const initialUrl = new URL(request.url);
    const initialProxy = getProxyForUrl(initialUrl, env);

    // Fast path: when no proxy applies, delegate untouched to native fetch.
    if (!initialProxy) {
      return baseFetch(input, init);
    }

    const signal = init?.signal ?? request.signal;
    const redirectMode = init?.redirect ?? request.redirect ?? 'follow';
    let currentUrl = initialUrl;
    let currentMethod = request.method.toUpperCase();
    let currentHeaders = toHeaderRecord(request.headers);
    let bodyBuffer = request.body ? Buffer.from(await request.arrayBuffer()) : null;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const proxyUrl = hop === 0 ? initialProxy : getProxyForUrl(currentUrl, env);
      const response = proxyUrl
        ? await sendViaProxyOnce({
            url: currentUrl,
            method: currentMethod,
            headers: currentHeaders,
            bodyBuffer,
            proxyUrl,
            signal,
          })
        : await baseFetch(currentUrl, {
            method: currentMethod,
            headers: currentHeaders,
            body: bodyBuffer,
            redirect: 'manual',
            signal,
          });

      if (!REDIRECT_STATUSES.has(response.status) || redirectMode === 'manual') {
        return response;
      }
      if (redirectMode === 'error') {
        await response.body?.cancel();
        throw new TypeError(`Redirected while redirect mode is "error": ${currentUrl.href}`);
      }

      const location = response.headers.get('location');
      if (!location) return response;
      await response.body?.cancel();

      const nextUrl = new URL(location, currentUrl);
      if (nextUrl.origin !== currentUrl.origin) {
        delete currentHeaders.authorization;
        delete currentHeaders.cookie;
      }
      if ((response.status === 301 || response.status === 302 || response.status === 303)
        && currentMethod !== 'GET' && currentMethod !== 'HEAD') {
        currentMethod = 'GET';
        bodyBuffer = null;
        delete currentHeaders['content-length'];
        delete currentHeaders['content-type'];
      }
      currentUrl = nextUrl;
    }

    throw new TypeError(`Too many redirects (${MAX_REDIRECTS})`);
  };
}

export function installEnvProxy(env = process.env) {
  const httpProxy = normalizeProxyUrl(readEnv(env, 'http_proxy', 'HTTP_PROXY'));
  const httpsProxy = normalizeProxyUrl(readEnv(env, 'https_proxy', 'HTTPS_PROXY'));
  const allProxy = normalizeProxyUrl(readEnv(env, 'all_proxy', 'ALL_PROXY'));
  if (!httpProxy && !httpsProxy && !allProxy) return {enabled: false};

  if (!globalThis.__radarBaseFetch) {
    globalThis.__radarBaseFetch = globalThis.fetch;
  }
  globalThis.fetch = createProxyFetch({baseFetch: globalThis.__radarBaseFetch, env});
  return {
    enabled: true,
    httpProxy: httpProxy ? maskProxyUrl(httpProxy) : null,
    httpsProxy: httpsProxy ? maskProxyUrl(httpsProxy) : null,
    allProxy: allProxy ? maskProxyUrl(allProxy) : null,
    noProxy: readEnv(env, 'no_proxy', 'NO_PROXY'),
  };
}
