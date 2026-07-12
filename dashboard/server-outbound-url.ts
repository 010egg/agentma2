import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { LookupAddress } from 'node:dns';
import type { IncomingHttpHeaders, RequestOptions } from 'node:http';

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 10_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 3;

export type GuardedFetchOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  maxBytes?: number;
  maxRequestBytes?: number;
  connectTimeoutMs?: number;
  headersTimeoutMs?: number;
  idleTimeoutMs?: number;
  totalTimeoutMs?: number;
  maxRedirects?: number;
  allowLoopbackHttp?: boolean;
  signal?: AbortSignal;
};

export type GuardedFetchResponse = {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  finalUrl: string;
};

export type OutboundTarget = {
  url: URL;
  address: string;
  family: 4 | 6;
  loopbackDevelopment: boolean;
};

type Resolver = (hostname: string) => Promise<LookupAddress[]>;
type RequestFactory = (
  protocol: 'http:' | 'https:',
  options: RequestOptions,
  callback: (response: http.IncomingMessage) => void,
) => http.ClientRequest;

export type OutboundClientDependencies = {
  resolve?: Resolver;
  request?: RequestFactory;
};

export class OutboundRequestError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'OutboundRequestError';
  }
}

function fail(code: string, message: string): never {
  throw new OutboundRequestError(code, message);
}

function ipv4Number(address: string) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function ipv4InCidr(value: number, base: string, prefix: number) {
  const baseValue = ipv4Number(base)!;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

const BLOCKED_IPV4: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];

function parseIpv6(address: string) {
  let input = address.toLowerCase().split('%')[0];
  if (input.includes('.')) {
    const lastColon = input.lastIndexOf(':');
    const ipv4 = ipv4Number(input.slice(lastColon + 1));
    if (ipv4 === null) return null;
    input = `${input.slice(0, lastColon)}:${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  const halves = input.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const groups = [...left, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(parseInt(group, 16)), 0n);
}

function ipv6InCidr(value: bigint, base: string, prefix: number) {
  const baseValue = parseIpv6(base)!;
  const shift = 128n - BigInt(prefix);
  return (value >> shift) === (baseValue >> shift);
}

function isIpv4Loopback(address: string) {
  const value = ipv4Number(address);
  return value !== null && ipv4InCidr(value, '127.0.0.0', 8);
}

function isIpv6Loopback(address: string) {
  return parseIpv6(address) === 1n;
}

function isLoopback(address: string) {
  return net.isIP(address) === 4 ? isIpv4Loopback(address) : net.isIP(address) === 6 && isIpv6Loopback(address);
}

function isGlobalUnicast(address: string) {
  const family = net.isIP(address);
  if (family === 4) {
    const value = ipv4Number(address)!;
    return !BLOCKED_IPV4.some(([base, prefix]) => ipv4InCidr(value, base, prefix));
  }
  if (family !== 6) return false;
  const value = parseIpv6(address);
  if (value === null || !ipv6InCidr(value, '2000::', 3)) return false;
  return ![
    ['2001::', 23],
    ['2001:2::', 48],
    ['2001:db8::', 32],
    ['3fff::', 20],
  ].some(([base, prefix]) => ipv6InCidr(value, String(base), Number(prefix)));
}

function normalizeUrl(input: string | URL) {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.toString()) : new URL(input);
  } catch {
    fail('invalid_url', 'The outbound URL is invalid.');
  }
  if (url.username || url.password) fail('invalid_url', 'Credentials are not allowed in outbound URLs.');
  if (url.protocol !== 'https:' && url.protocol !== 'http:') fail('invalid_url', 'Only HTTP(S) outbound URLs are supported.');
  url.hash = '';
  return url;
}

async function defaultResolver(hostname: string) {
  if (net.isIP(hostname)) return [{ address: hostname, family: net.isIP(hostname) as 4 | 6 }];
  return await dns.lookup(hostname, { all: true, verbatim: true });
}

export async function resolveOutboundTarget(
  input: string | URL,
  options: Pick<GuardedFetchOptions, 'allowLoopbackHttp'> = {},
  dependencies: OutboundClientDependencies = {},
): Promise<OutboundTarget> {
  const url = normalizeUrl(input);
  const allowLoopback = options.allowLoopbackHttp === true;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await (dependencies.resolve || defaultResolver)(hostname).catch(() => (
    fail('dns_failed', 'The outbound destination could not be resolved.')
  ));
  if (!addresses.length) fail('dns_failed', 'The outbound destination could not be resolved.');
  const normalized = addresses.map((item) => ({ address: item.address.split('%')[0], family: item.family as 4 | 6 }));
  if (normalized.some((item) => net.isIP(item.address) !== item.family)) {
    fail('blocked_destination', 'The outbound destination is not allowed.');
  }
  const allLoopback = normalized.every((item) => isLoopback(item.address));
  if (url.protocol === 'http:' && !(allowLoopback && allLoopback)) {
    fail('https_required', 'Outbound URLs must use HTTPS.');
  }
  if (!allLoopback && normalized.some((item) => !isGlobalUnicast(item.address))) {
    fail('blocked_destination', 'The outbound destination is not allowed.');
  }
  if (allLoopback && !allowLoopback) fail('blocked_destination', 'The outbound destination is not allowed.');
  return { url, ...normalized[0], loopbackDevelopment: allLoopback };
}

function bounded(value: number | undefined, fallback: number, min: number, max: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value!)));
}

function defaultRequestFactory(protocol: 'http:' | 'https:', options: RequestOptions, callback: (response: http.IncomingMessage) => void) {
  return (protocol === 'https:' ? https : http).request(options, callback);
}

function requestOnce(
  target: OutboundTarget,
  options: GuardedFetchOptions,
  dependencies: OutboundClientDependencies,
): Promise<GuardedFetchResponse> {
  const body = options.body === undefined ? undefined : Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body);
  const maxRequestBytes = bounded(options.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES, 1, 16 * 1024 * 1024);
  if (body && body.length > maxRequestBytes) fail('request_too_large', 'The outbound request body is too large.');
  const maxBytes = bounded(options.maxBytes, DEFAULT_MAX_BYTES, 1, 32 * 1024 * 1024);
  const connectTimeout = bounded(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS, 100, 60_000);
  const headersTimeout = bounded(options.headersTimeoutMs, DEFAULT_HEADERS_TIMEOUT_MS, 100, 120_000);
  const idleTimeout = bounded(options.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS, 100, 120_000);
  const totalTimeout = bounded(options.totalTimeoutMs, DEFAULT_TOTAL_TIMEOUT_MS, 100, 300_000);

  return new Promise((resolve, reject) => {
    let settled = false;
    // Assigned once after callbacks are declared; abort closes over this request.
    // eslint-disable-next-line prefer-const
    let request: http.ClientRequest;
    const abort = () => {
      request?.destroy(new Error('aborted'));
      finish(new OutboundRequestError('aborted', 'The outbound request was canceled.'));
    };
    const finish = (error?: OutboundRequestError, response?: GuardedFetchResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      clearTimeout(headersTimer);
      clearTimeout(connectTimer);
      options.signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(response!);
    };
    const headers = Object.fromEntries(Object.entries(options.headers || {}).filter(([name]) => name.toLowerCase() !== 'host'));
    headers.Host = target.url.host;
    const requestOptions: RequestOptions = {
      protocol: target.url.protocol,
      hostname: target.address,
      family: target.family,
      port: target.url.port || undefined,
      method: options.method || 'GET',
      path: `${target.url.pathname}${target.url.search}`,
      headers,
      ...(target.url.protocol === 'https:' ? { servername: target.url.hostname.replace(/^\[|\]$/g, '') } : {}),
    };
    request = (dependencies.request || defaultRequestFactory)(target.url.protocol as 'http:' | 'https:', requestOptions, (response) => {
      clearTimeout(headersTimer);
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.setTimeout(idleTimeout, () => response.destroy(new Error('idle timeout')));
      response.on('data', (chunk) => {
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > maxBytes) {
          finish(new OutboundRequestError('response_too_large', 'The outbound response is too large.'));
          response.destroy(new Error('response too large'));
          return;
        }
        chunks.push(buffer);
      });
      response.on('end', () => finish(undefined, {
        status: response.statusCode || 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
        finalUrl: target.url.toString(),
      }));
      response.on('error', (error) => finish(
        new OutboundRequestError(error.message === 'response too large' ? 'response_too_large' : 'request_failed', 'The outbound response failed.'),
      ));
    });
    const totalTimer = setTimeout(() => {
      request.destroy(new Error('total timeout'));
      finish(new OutboundRequestError('total_timeout', 'The outbound request timed out.'));
    }, totalTimeout);
    const headersTimer = setTimeout(() => {
      request.destroy(new Error('headers timeout'));
      finish(new OutboundRequestError('headers_timeout', 'The outbound server did not respond in time.'));
    }, headersTimeout);
    const connectTimer = setTimeout(() => {
      request.destroy(new Error('connect timeout'));
      finish(new OutboundRequestError('connect_timeout', 'The outbound connection timed out.'));
    }, connectTimeout);
    request.on('socket', (socket) => {
      const event = target.url.protocol === 'https:' ? 'secureConnect' : 'connect';
      socket.once(event, () => clearTimeout(connectTimer));
    });
    request.on('error', () => finish(new OutboundRequestError('request_failed', 'The outbound request failed.')));
    if (options.signal?.aborted) {
      abort();
      return;
    }
    options.signal?.addEventListener('abort', abort, { once: true });
    if (body) request.write(body);
    request.end();
  });
}

export async function guardedFetch(
  input: string | URL,
  options: GuardedFetchOptions = {},
  dependencies: OutboundClientDependencies = {},
): Promise<GuardedFetchResponse> {
  const maxRedirects = bounded(options.maxRedirects, DEFAULT_MAX_REDIRECTS, 0, 10);
  let url = normalizeUrl(input);
  let method = (options.method || 'GET').toUpperCase();
  let body = options.body;
  let headers = { ...(options.headers || {}) };
  for (let redirect = 0; ; redirect += 1) {
    const target = await resolveOutboundTarget(url, options, dependencies);
    const response = await requestOnce(target, { ...options, method, body, headers }, dependencies);
    if (![301, 302, 303, 307, 308].includes(response.status) || !response.headers.location) return response;
    if (redirect >= maxRedirects) fail('too_many_redirects', 'The outbound request exceeded the redirect limit.');
    const next = normalizeUrl(new URL(response.headers.location, url));
    if (next.origin !== url.origin) {
      headers = Object.fromEntries(Object.entries(headers).filter(([name]) => ![
        'authorization', 'proxy-authorization', 'cookie', 'host',
      ].includes(name.toLowerCase())));
    }
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
      headers = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'content-length'));
    }
    url = next;
  }
}
