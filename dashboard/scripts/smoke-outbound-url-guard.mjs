import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { OutboundRequestError, guardedFetch, resolveOutboundTarget } from '../server-outbound-url.ts';

async function blocked(url, options = {}, dependencies = {}) {
  await assert.rejects(
    () => resolveOutboundTarget(url, options, dependencies),
    error => error instanceof OutboundRequestError && ['blocked_destination', 'https_required'].includes(error.code),
  );
}

function fakeRequest(responses, observed) {
  return (_protocol, options, callback) => {
    observed.push(options);
    const request = new EventEmitter();
    request.write = () => true;
    request.destroy = error => request.emit('error', error);
    request.end = () => queueMicrotask(() => {
      const socket = new EventEmitter();
      request.emit('socket', socket);
      socket.emit(options.protocol === 'https:' ? 'secureConnect' : 'connect');
      const spec = responses.shift() || { status: 200, headers: {}, body: 'ok' };
      const response = new PassThrough();
      response.statusCode = spec.status;
      response.headers = spec.headers || {};
      response.setTimeout = () => response;
      response.destroy = error => {
        if (error) response.emit('error', error);
      };
      callback(response);
      response.end(spec.body || '');
    });
    return request;
  };
}

for (const url of [
  'https://127.0.0.1/', 'https://169.254.169.254/latest/meta-data', 'https://10.0.0.1/',
  'https://100.64.0.1/', 'https://192.0.2.1/', 'https://198.18.0.1/', 'https://224.0.0.1/',
  'https://[::1]/', 'https://[fe80::1]/', 'https://[fc00::1]/', 'https://[2001:db8::1]/',
  'https://%31%32%37.0.0.1/', 'http://8.8.8.8/',
]) await blocked(url);

await blocked('https://mixed.example/', {}, {
  resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }],
});
const publicTarget = await resolveOutboundTarget('https://public.example/path', {}, {
  resolve: async () => [
    { address: '8.8.8.8', family: 4 },
    { address: '2001:4860:4860::8888', family: 6 },
  ],
});
assert.equal(publicTarget.address, '8.8.8.8');

const observed = [];
let resolveCalls = 0;
const pinned = await guardedFetch('https://agent.example/card', {}, {
  resolve: async () => {
    resolveCalls += 1;
    return resolveCalls === 1
      ? [{ address: '93.184.216.34', family: 4 }]
      : [{ address: '127.0.0.1', family: 4 }];
  },
  request: fakeRequest([{ status: 200, body: 'card' }], observed),
});
assert.equal(pinned.body.toString(), 'card');
assert.equal(resolveCalls, 1);
assert.equal(observed[0].hostname, '93.184.216.34');
assert.equal(observed[0].servername, 'agent.example');
assert.equal(observed[0].headers.Host, 'agent.example');

let redirectResolveCalls = 0;
const redirectObserved = [];
await assert.rejects(
  () => guardedFetch('https://public.example/start', {}, {
    resolve: async hostname => {
      redirectResolveCalls += 1;
      return hostname === 'public.example'
        ? [{ address: '8.8.8.8', family: 4 }]
        : [{ address: '169.254.169.254', family: 4 }];
    },
    request: fakeRequest([{ status: 302, headers: { location: 'https://metadata.example/latest' } }], redirectObserved),
  }),
  error => error instanceof OutboundRequestError && error.code === 'blocked_destination',
);
assert.equal(redirectResolveCalls, 2);
assert.equal(redirectObserved.length, 1);

const localServer = http.createServer((req, res) => {
  if (req.url === '/redirect') {
    res.writeHead(302, { Location: '/ok' });
    res.end();
  } else if (req.url === '/large') {
    res.end('response-too-large');
  } else if (req.url === '/loop') {
    res.writeHead(302, { Location: '/loop' });
    res.end();
  } else {
    res.end('local-ok');
  }
});
await new Promise(resolve => localServer.listen(0, '127.0.0.1', resolve));
try {
  const address = localServer.address();
  assert(address && typeof address === 'object');
  const local = await guardedFetch(`http://127.0.0.1:${address.port}/redirect`, { allowLoopbackHttp: true });
  assert.equal(local.status, 200);
  assert.equal(local.body.toString(), 'local-ok');
  await assert.rejects(
    () => guardedFetch(`http://127.0.0.1:${address.port}/large`, { allowLoopbackHttp: true, maxBytes: 4 }),
    error => error instanceof OutboundRequestError && error.code === 'response_too_large',
  );
  await assert.rejects(
    () => guardedFetch(`http://127.0.0.1:${address.port}/loop`, { allowLoopbackHttp: true, maxRedirects: 0 }),
    error => error instanceof OutboundRequestError && error.code === 'too_many_redirects',
  );
} finally {
  await new Promise((resolve, reject) => localServer.close(error => error ? reject(error) : resolve()));
}

console.log(JSON.stringify({
  ok: true,
  checks: ['ipv4', 'ipv6', 'encoded-host', 'mixed-dns', 'metadata', 'https-only', 'dns-rebinding', 'sni-host', 'redirects', 'loopback-dev', 'byte-limit'],
}));
