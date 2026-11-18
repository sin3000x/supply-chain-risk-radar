import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {gzipSync} from 'node:zlib';
import {createProxyFetch, getProxyForUrl, maskProxyUrl, shouldBypassProxy} from './proxy-fetch.mjs';

test('getProxyForUrl respects http_proxy, https_proxy, all_proxy and no_proxy', () => {
  const env = {
    http_proxy: 'http://proxy-http:8080',
    HTTPS_PROXY: 'http://user:secret@proxy-https:8443',
    no_proxy: 'localhost,127.0.0.1,.internal.corp,api.local:9000',
  };

  assert.equal(getProxyForUrl('http://example.com/feed.xml', env).href, 'http://proxy-http:8080/');
  assert.equal(getProxyForUrl('https://example.com/api', env).href, 'http://user:secret@proxy-https:8443/');
  assert.equal(maskProxyUrl(getProxyForUrl('https://example.com/api', env)), 'http://user:***@proxy-https:8443/');

  assert.equal(getProxyForUrl('http://localhost:4179/api/health', env), null);
  assert.equal(getProxyForUrl('http://127.0.0.1:4179/api/health', env), null);
  assert.equal(getProxyForUrl('https://service.internal.corp/v1', env), null);
  assert.equal(getProxyForUrl('http://api.local:9000/test', env), null);
  assert.notEqual(getProxyForUrl('http://api.local:8080/test', env), null);
  assert.equal(shouldBypassProxy(new URL('https://anything.example.com'), '*'), true);
});

test('createProxyFetch routes HTTP requests via proxy, decompresses gzip, and follows redirects', async () => {
  const seen = [];
  const proxyServer = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        proxyAuth: req.headers['proxy-authorization'] ?? null,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (req.url === 'http://external.example/start') {
        res.writeHead(302, {Location: 'http://external.example/final'});
        res.end();
        return;
      }
      if (req.url === 'http://external.example/final') {
        const gz = gzipSync(Buffer.from(JSON.stringify({ok: true, via: 'proxy'})));
        res.writeHead(200, {'Content-Type': 'application/json', 'Content-Encoding': 'gzip'});
        res.end(gz);
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
  });

  await new Promise(resolve => proxyServer.listen(0, '127.0.0.1', resolve));
  const {port} = proxyServer.address();

  try {
    let baseCalled = false;
    const proxyFetch = createProxyFetch({
      env: {
        http_proxy: `http://alice:p%40ss@127.0.0.1:${port}`,
        no_proxy: 'localhost',
      },
      baseFetch: async url => {
        baseCalled = true;
        return new Response(`direct:${url}`, {status: 200});
      },
    });

    const res = await proxyFetch('http://external.example/start', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({hello: 'world'}),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {ok: true, via: 'proxy'});
    assert.equal(baseCalled, false);
    assert.equal(seen.length, 2);
    assert.equal(seen[0].method, 'POST');
    assert.equal(seen[0].url, 'http://external.example/start');
    assert.equal(seen[0].proxyAuth, `Basic ${Buffer.from('alice:p@ss').toString('base64')}`);
    assert.equal(seen[0].body, '{"hello":"world"}');
    assert.equal(seen[1].method, 'GET');
    assert.equal(seen[1].url, 'http://external.example/final');

    const directRes = await proxyFetch('http://localhost:4179/api/health');
    assert.equal(baseCalled, true);
    assert.equal(await directRes.text(), 'direct:http://localhost:4179/api/health');
  } finally {
    await new Promise(resolve => proxyServer.close(resolve));
  }
});

test('createProxyFetch sends CONNECT for HTTPS URLs and surfaces proxy rejection', async () => {
  const connectRequests = [];
  const proxyServer = http.createServer((_req, res) => {
    res.writeHead(405);
    res.end();
  });
  proxyServer.on('connect', (req, clientSocket) => {
    connectRequests.push({
      url: req.url,
      proxyAuth: req.headers['proxy-authorization'] ?? null,
    });
    clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    clientSocket.destroy();
  });

  await new Promise(resolve => proxyServer.listen(0, '127.0.0.1', resolve));
  const {port} = proxyServer.address();

  try {
    const proxyFetch = createProxyFetch({
      env: {https_proxy: `http://bob:secret@127.0.0.1:${port}`},
    });
    await assert.rejects(
      () => proxyFetch('https://feeds.example.org:8443/rss.xml'),
      /Proxy CONNECT feeds\.example\.org:8443 failed with HTTP 403/,
    );
    assert.equal(connectRequests.length, 1);
    assert.equal(connectRequests[0].url, 'feeds.example.org:8443');
    assert.equal(connectRequests[0].proxyAuth, `Basic ${Buffer.from('bob:secret').toString('base64')}`);
  } finally {
    await new Promise(resolve => proxyServer.close(resolve));
  }
});

test('createProxyFetch handles AbortSignal on stalled proxy connections', async () => {
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 50);

  try {
    const proxyFetch = createProxyFetch({
      env: {https_proxy: `http://127.0.0.1:${port}`},
    });
    await assert.rejects(
      () => proxyFetch('https://example.com/slow', {signal: controller.signal}),
    );
  } finally {
    clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});
