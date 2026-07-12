import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { OutboundRequestError, resolveOutboundTarget } from './server-outbound-url.ts';
import type { Role } from './server-store.ts';

export const MAX_MCP_CONNECTIONS_PER_TENANT = 20;
export const MAX_MCP_SERVERS_PER_TEMPLATE = 8;

const MCP_NAME_RE = /^[A-Za-z0-9._-]{1,128}$/;
const RESERVED_MCP_NAMES = new Set(['custom', 'datasource', 'model', 'image', 'memory', 'media']);
const MAX_MCP_URL_LENGTH = 2048;
const MAX_MCP_DESCRIPTION_LENGTH = 500;
const MAX_MCP_HEADERS = 20;
const MAX_MCP_HEADER_VALUE_LENGTH = 4096;
const MCP_CHECK_TIMEOUT_MS = 10_000;

export type McpConnectionType = 'http' | 'sse';

export type McpConnectionRow = {
  id: string;
  tenantId: string;
  name: string;
  url: string;
  type: McpConnectionType;
  headersEnc: string | null;
  description: string;
  enabled: boolean;
  createdBy: string;
  publishedAt: number | null;
  createdAt: number;
  updatedAt: number;
  lastCheckAt: number | null;
  lastCheckOk: boolean | null;
};

export type McpConnectionPublic = Omit<McpConnectionRow, 'headersEnc'> & {
  headers: Record<string, string>;
  hasHeaders: boolean;
};

export type RuntimeMcpConnection = {
  name: string;
  type: McpConnectionType;
  url: string;
  headers?: Record<string, string>;
};

export type McpConnectionCheckResult = {
  ok: true;
  server: { name: string; version: string } | null;
  tools: Array<{ name: string; description: string }>;
};

export class McpConnectionError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = 'invalid_mcp_connection') {
    super(message);
    this.name = 'McpConnectionError';
  }
}

const DATA_DIR = process.env.AGENTMA_DATA_DIR
  || path.join(os.homedir(), 'Library', 'Application Support', 'agentma2');
const DB_PATH = path.join(DATA_DIR, 'dashboard.sqlite');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS mcp_connections (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'http',
    headers_enc TEXT,
    description TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_by TEXT NOT NULL,
    published_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_check_at INTEGER,
    last_check_ok INTEGER,
    UNIQUE(tenant_id, name)
  );
  CREATE INDEX IF NOT EXISTS idx_mcp_connections_tenant_updated
    ON mcp_connections (tenant_id, updated_at DESC);
`);

function mapConnection(row: Record<string, unknown>): McpConnectionRow {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    name: String(row.name),
    url: String(row.url),
    type: row.type === 'sse' ? 'sse' : 'http',
    headersEnc: typeof row.headers_enc === 'string' && row.headers_enc ? row.headers_enc : null,
    description: typeof row.description === 'string' ? row.description : '',
    enabled: Boolean(row.enabled),
    createdBy: String(row.created_by),
    publishedAt: Number(row.published_at) || null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastCheckAt: Number(row.last_check_at) || null,
    lastCheckOk: row.last_check_ok == null ? null : Boolean(row.last_check_ok),
  };
}

function getConnection(tenantId: string, id: string) {
  const row = db.prepare(`
    SELECT * FROM mcp_connections WHERE tenant_id = ? AND id = ?
  `).get(tenantId, id) as Record<string, unknown> | undefined;
  return row ? mapConnection(row) : null;
}

function isVisible(connection: McpConnectionRow, viewerSub: string, viewerRole?: Role | null) {
  return viewerRole === 'tenant_admin'
    || connection.createdBy === viewerSub
    || connection.publishedAt != null;
}

function canManage(connection: McpConnectionRow, actorSub: string, actorRole?: Role | null) {
  return actorRole === 'tenant_admin' || connection.createdBy === actorSub;
}

function requireManageableConnection(tenantId: string, id: string, actorSub: string, actorRole?: Role | null) {
  const connection = getConnection(tenantId, id);
  if (!connection) throw new McpConnectionError('MCP 连接不存在', 404, 'not_found');
  if (!canManage(connection, actorSub, actorRole)) {
    throw new McpConnectionError('只能管理自己创建的 MCP 连接', 403, 'forbidden');
  }
  return connection;
}

function requireVisibleConnection(tenantId: string, id: string, viewerSub: string, viewerRole?: Role | null) {
  const connection = getConnection(tenantId, id);
  if (!connection || !isVisible(connection, viewerSub, viewerRole)) {
    throw new McpConnectionError('MCP 连接不存在', 404, 'not_found');
  }
  return connection;
}

function normalizeConnectionName(value: unknown) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!MCP_NAME_RE.test(name)) {
    throw new McpConnectionError('名称只能包含字母、数字、点、下划线和连字符，长度 1-128');
  }
  if (RESERVED_MCP_NAMES.has(name.toLowerCase())) {
    throw new McpConnectionError(`名称 ${name} 为平台保留字`);
  }
  return name;
}

function normalizeConnectionType(value: unknown): McpConnectionType {
  if (value === undefined || value === null || value === '') return 'http';
  if (value !== 'http' && value !== 'sse') throw new McpConnectionError('type 必须是 http 或 sse');
  return value;
}

function normalizeDescription(value: unknown) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new McpConnectionError('description 必须是字符串');
  const description = value.trim();
  if (description.length > MAX_MCP_DESCRIPTION_LENGTH) {
    throw new McpConnectionError(`description 不能超过 ${MAX_MCP_DESCRIPTION_LENGTH} 个字符`);
  }
  return description;
}

function canonicalHeaderName(value: string) {
  const lower = value.toLowerCase();
  if (lower === 'authorization') return 'Authorization';
  if (lower === 'x-api-key') return 'X-Api-Key';
  return value.split('-').map((part) => part ? `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}` : '').join('-');
}

export function normalizeMcpHeaders(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (value === null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new McpConnectionError('headers 必须是键值对象');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_MCP_HEADERS) throw new McpConnectionError(`headers 最多允许 ${MAX_MCP_HEADERS} 项`);
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [rawName, rawValue] of entries) {
    const name = rawName.trim();
    const lower = name.toLowerCase();
    if (!(lower === 'authorization' || lower === 'x-api-key' || /^x-[a-z0-9-]+$/i.test(name))) {
      throw new McpConnectionError(`不允许的 header: ${name || '<empty>'}`);
    }
    if (seen.has(lower)) throw new McpConnectionError(`重复的 header: ${name}`);
    if (typeof rawValue !== 'string') throw new McpConnectionError(`header ${name} 的值必须是字符串`);
    const headerValue = rawValue.trim();
    if (!headerValue || headerValue.length > MAX_MCP_HEADER_VALUE_LENGTH || /[\r\n]/.test(headerValue)) {
      throw new McpConnectionError(`header ${name} 的值为空、过长或包含非法换行`);
    }
    seen.add(lower);
    headers[canonicalHeaderName(name)] = headerValue;
  }
  return headers;
}

function loadSecretsKey() {
  const configured = String(process.env.AGENTMA_SECRETS_KEY || '').trim();
  if (!configured) {
    throw new McpConnectionError(
      '保存认证 header 前必须配置 AGENTMA_SECRETS_KEY（32 字节 base64）',
      503,
      'secrets_key_missing',
    );
  }
  const key = Buffer.from(configured, 'base64');
  const canonical = key.toString('base64').replace(/=+$/, '');
  if (key.length !== 32 || canonical !== configured.replace(/=+$/, '')) {
    throw new McpConnectionError(
      'AGENTMA_SECRETS_KEY 必须是 32 字节 base64',
      503,
      'secrets_key_invalid',
    );
  }
  return key;
}

function encryptHeaders(headers: Record<string, string>) {
  if (Object.keys(headers).length === 0) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', loadSecretsKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(headers), 'utf8'), cipher.final()]);
  return JSON.stringify({
    v: 1,
    alg: 'A256GCM',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
  });
}

function decryptHeaders(ciphertext: string | null) {
  if (!ciphertext) return undefined;
  try {
    const envelope = JSON.parse(ciphertext) as Record<string, unknown>;
    if (envelope.v !== 1 || envelope.alg !== 'A256GCM') throw new Error('unsupported envelope');
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      loadSecretsKey(),
      Buffer.from(String(envelope.iv || ''), 'base64'),
    );
    decipher.setAuthTag(Buffer.from(String(envelope.tag || ''), 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(String(envelope.data || ''), 'base64')),
      decipher.final(),
    ]).toString('utf8');
    return normalizeMcpHeaders(JSON.parse(plaintext)) || undefined;
  } catch (error) {
    if (error instanceof McpConnectionError) throw error;
    throw new McpConnectionError('MCP 连接凭据无法解密，请检查 AGENTMA_SECRETS_KEY', 500, 'decrypt_failed');
  }
}

function maskSecret(value: string) {
  const space = value.indexOf(' ');
  if (space > 0) {
    const scheme = value.slice(0, space);
    const secret = value.slice(space + 1);
    return `${scheme} ${secret.slice(0, Math.min(3, secret.length))}****`;
  }
  return `${value.slice(0, Math.min(3, value.length))}****`;
}

function toPublic(connection: McpConnectionRow): McpConnectionPublic {
  let headers: Record<string, string>;
  try {
    headers = decryptHeaders(connection.headersEnc) || {};
  } catch {
    return {
      ...connection,
      headers: connection.headersEnc ? { Encrypted: '****' } : {},
      hasHeaders: Boolean(connection.headersEnc),
    };
  }
  return {
    ...connection,
    headers: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, maskSecret(value)])),
    hasHeaders: Object.keys(headers).length > 0,
  };
}

function mcpHostAllowlist() {
  return new Set(String(process.env.AGENTMA_MCP_HOST_ALLOWLIST || '')
    .split(',')
    .map((host) => host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, ''))
    .filter(Boolean));
}

export async function validateMcpUrl(value: unknown) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || raw.length > MAX_MCP_URL_LENGTH) throw new McpConnectionError('url 必填且不能超过 2048 个字符');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new McpConnectionError('url 必须是绝对 HTTP(S) URL');
  }
  if (url.username || url.password) throw new McpConnectionError('url 不能包含用户名或密码');
  const allowHttp = process.env.AGENTMA_MCP_ALLOW_HTTP === '1';
  if (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:')) {
    throw new McpConnectionError('MCP URL 必须使用 HTTPS；开发环境可设置 AGENTMA_MCP_ALLOW_HTTP=1');
  }
  url.hash = '';
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (mcpHostAllowlist().has(hostname)) {
    if (!net.isIP(hostname)) {
      const addresses = await dns.lookup(hostname, { all: true, verbatim: true }).catch(() => []);
      if (addresses.length === 0) throw new McpConnectionError('MCP 主机无法解析');
    }
    return url.toString();
  }
  const validationUrl = new URL(url);
  if (validationUrl.protocol === 'http:') validationUrl.protocol = 'https:';
  try {
    await resolveOutboundTarget(validationUrl);
  } catch (error) {
    if (error instanceof OutboundRequestError) {
      if (error.code === 'blocked_destination') {
        throw new McpConnectionError('MCP URL 指向私网、回环、链路本地或其他受限地址');
      }
      if (error.code === 'dns_failed') throw new McpConnectionError('MCP 主机无法解析');
    }
    throw new McpConnectionError('MCP URL 未通过出站安全校验');
  }
  return url.toString();
}

function sqliteConflict(error: unknown) {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

export function listMcpConnections(tenantId: string, viewerSub: string, viewerRole?: Role | null) {
  const rows = db.prepare(`
    SELECT * FROM mcp_connections
    WHERE tenant_id = ?
      AND (? = 1 OR created_by = ? OR published_at IS NOT NULL)
    ORDER BY updated_at DESC, name ASC
  `).all(tenantId, viewerRole === 'tenant_admin' ? 1 : 0, viewerSub) as Array<Record<string, unknown>>;
  return rows.map(mapConnection).map(toPublic);
}

export async function createMcpConnection(
  tenantId: string,
  actorSub: string,
  input: Record<string, unknown>,
) {
  const countRow = db.prepare('SELECT COUNT(*) AS count FROM mcp_connections WHERE tenant_id = ?').get(tenantId) as { count?: number } | undefined;
  const count = Number(countRow?.count || 0);
  if (count >= MAX_MCP_CONNECTIONS_PER_TENANT) {
    throw new McpConnectionError(`每个租户最多创建 ${MAX_MCP_CONNECTIONS_PER_TENANT} 个 MCP 连接`);
  }
  const name = normalizeConnectionName(input.name);
  const url = await validateMcpUrl(input.url);
  const type = normalizeConnectionType(input.type);
  const headers = normalizeMcpHeaders(input.headers) || {};
  const description = normalizeDescription(input.description);
  const timestamp = Date.now();
  const row: McpConnectionRow = {
    id: crypto.randomUUID(),
    tenantId,
    name,
    url,
    type,
    headersEnc: encryptHeaders(headers),
    description,
    enabled: input.enabled !== false,
    createdBy: actorSub,
    publishedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastCheckAt: null,
    lastCheckOk: null,
  };
  try {
    db.prepare(`
      INSERT INTO mcp_connections (
        id, tenant_id, name, url, type, headers_enc, description, enabled,
        created_by, published_at, created_at, updated_at, last_check_at, last_check_ok
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, tenantId, name, url, type, row.headersEnc, description, row.enabled ? 1 : 0,
      actorSub, null, timestamp, timestamp, null, null,
    );
  } catch (error) {
    if (sqliteConflict(error)) throw new McpConnectionError(`连接名称 ${name} 已存在`);
    throw error;
  }
  return toPublic(row);
}

export async function updateMcpConnection(
  tenantId: string,
  id: string,
  actorSub: string,
  actorRole: Role | null | undefined,
  input: Record<string, unknown>,
) {
  const current = requireManageableConnection(tenantId, id, actorSub, actorRole);
  const name = Object.hasOwn(input, 'name') ? normalizeConnectionName(input.name) : current.name;
  const url = Object.hasOwn(input, 'url') ? await validateMcpUrl(input.url) : await validateMcpUrl(current.url);
  const type = Object.hasOwn(input, 'type') ? normalizeConnectionType(input.type) : current.type;
  const description = Object.hasOwn(input, 'description') ? normalizeDescription(input.description) : current.description;
  const enabled = Object.hasOwn(input, 'enabled') ? input.enabled !== false : current.enabled;
  const headersEnc = Object.hasOwn(input, 'headers')
    ? encryptHeaders(normalizeMcpHeaders(input.headers) || {})
    : current.headersEnc;
  const updatedAt = Date.now();
  try {
    db.prepare(`
      UPDATE mcp_connections
      SET name = ?, url = ?, type = ?, headers_enc = ?, description = ?, enabled = ?, updated_at = ?
      WHERE tenant_id = ? AND id = ?
    `).run(name, url, type, headersEnc, description, enabled ? 1 : 0, updatedAt, tenantId, id);
  } catch (error) {
    if (sqliteConflict(error)) throw new McpConnectionError(`连接名称 ${name} 已存在`);
    throw error;
  }
  return toPublic({ ...current, name, url, type, headersEnc, description, enabled, updatedAt });
}

export function deleteMcpConnection(
  tenantId: string,
  id: string,
  actorSub: string,
  actorRole?: Role | null,
) {
  requireManageableConnection(tenantId, id, actorSub, actorRole);
  db.prepare('DELETE FROM mcp_connections WHERE tenant_id = ? AND id = ?').run(tenantId, id);
}

export function setMcpConnectionPublished(
  tenantId: string,
  id: string,
  actorSub: string,
  actorRole: Role | null | undefined,
  published: boolean,
) {
  const current = requireManageableConnection(tenantId, id, actorSub, actorRole);
  const updatedAt = Date.now();
  const publishedAt = published ? (current.publishedAt || updatedAt) : null;
  db.prepare(`
    UPDATE mcp_connections SET published_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?
  `).run(publishedAt, updatedAt, tenantId, id);
  return toPublic({ ...current, publishedAt, updatedAt });
}

function sanitizeMcpError(error: unknown, headers?: Record<string, string>) {
  let message = error instanceof Error ? error.message : String(error || '连接失败');
  const status = Number((error as { code?: unknown } | null)?.code);
  if (Number.isFinite(status) && status > 0 && !message.includes(`HTTP ${status}`)) {
    message = `${message} (HTTP ${status})`;
  }
  for (const value of Object.values(headers || {})) {
    if (value) message = message.split(value).join('[redacted]');
  }
  return message
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/(api[_-]?key[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    .slice(0, 600);
}

function headersWithSignal(headers: Record<string, string> | undefined, signal: AbortSignal) {
  return { headers: { ...(headers || {}) }, signal } satisfies RequestInit;
}

export async function checkMcpConnection(
  tenantId: string,
  id: string,
  viewerSub: string,
  viewerRole?: Role | null,
): Promise<McpConnectionCheckResult> {
  const connection = requireVisibleConnection(tenantId, id, viewerSub, viewerRole);
  await validateMcpUrl(connection.url);
  const headers = decryptHeaders(connection.headersEnc);
  const controller = new AbortController();
  const client = new Client({ name: 'agentma-mcp-check', version: '1.0.0' }, { capabilities: {} });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
    void client.close().catch(() => undefined);
  }, MCP_CHECK_TIMEOUT_MS);
  try {
    const url = new URL(connection.url);
    const transport = connection.type === 'sse'
      ? new SSEClientTransport(url, {
        requestInit: headersWithSignal(headers, controller.signal),
        eventSourceInit: {
          fetch: (input: string | URL | Request, init?: RequestInit) => fetch(input, {
            ...init,
            headers: { ...(Object.fromEntries(new Headers(init?.headers).entries())), ...(headers || {}) },
            signal: controller.signal,
          }),
        } as NonNullable<NonNullable<ConstructorParameters<typeof SSEClientTransport>[1]>['eventSourceInit']>,
      })
      : new StreamableHTTPClientTransport(url, {
        requestInit: headersWithSignal(headers, controller.signal),
      });
    await client.connect(transport);
    const result = await client.listTools({}, { signal: controller.signal, timeout: MCP_CHECK_TIMEOUT_MS });
    const serverVersion = client.getServerVersion();
    db.prepare(`
      UPDATE mcp_connections SET last_check_at = ?, last_check_ok = 1 WHERE tenant_id = ? AND id = ?
    `).run(Date.now(), tenantId, id);
    return {
      ok: true,
      server: serverVersion ? { name: serverVersion.name, version: serverVersion.version } : null,
      tools: result.tools.slice(0, 100).map((tool) => ({
        name: tool.name,
        description: typeof tool.description === 'string' ? tool.description.slice(0, 500) : '',
      })),
    };
  } catch (error) {
    db.prepare(`
      UPDATE mcp_connections SET last_check_at = ?, last_check_ok = 0 WHERE tenant_id = ? AND id = ?
    `).run(Date.now(), tenantId, id);
    const reason = timedOut ? '连接测试超时（10 秒）' : sanitizeMcpError(error, headers);
    throw new McpConnectionError(`MCP 连接测试失败: ${reason}`, 502, 'check_failed');
  } finally {
    clearTimeout(timeout);
    try { await client.close(); } catch { /* best-effort transport cleanup */ }
  }
}

export async function resolveMcpConnectionsForRun(options: {
  tenantId: string;
  viewerSub: string;
  viewerRole?: Role | null;
  names?: string[];
}) {
  const requested = Array.from(new Set((options.names || []).map((name) => name.trim()).filter(Boolean)));
  if (requested.length > MAX_MCP_SERVERS_PER_TEMPLATE) {
    throw new McpConnectionError(`每个 Agent 模板最多选择 ${MAX_MCP_SERVERS_PER_TEMPLATE} 个 MCP 服务器`);
  }
  if (requested.length === 0) {
    return { connections: [] as RuntimeMcpConnection[], effectiveServerNames: [] as string[], warnings: [] as string[] };
  }
  const rows = (db.prepare('SELECT * FROM mcp_connections WHERE tenant_id = ?').all(options.tenantId) as Array<Record<string, unknown>>)
    .map(mapConnection);
  const byName = new Map(rows.map((connection) => [connection.name, connection]));
  const connections: RuntimeMcpConnection[] = [];
  const effectiveServerNames: string[] = [];
  const warnings: string[] = [];
  for (const name of requested) {
    const connection = byName.get(name);
    if (!connection) {
      effectiveServerNames.push(name);
      continue;
    }
    if (!isVisible(connection, options.viewerSub, options.viewerRole)) {
      warnings.push(`MCP 连接 "${name}" 未对你开放，已跳过`);
      continue;
    }
    if (!connection.enabled) {
      warnings.push(`MCP 连接 "${name}" 已停用，已跳过`);
      continue;
    }
    try {
      const url = await validateMcpUrl(connection.url);
      const headers = decryptHeaders(connection.headersEnc);
      connections.push({ name, type: connection.type, url, ...(headers ? { headers } : {}) });
      effectiveServerNames.push(name);
    } catch (error) {
      const reason = error instanceof Error ? error.message : '配置无效';
      warnings.push(`MCP 连接 "${name}" 未通过运行时安全校验，已跳过: ${reason}`);
    }
  }
  return { connections, effectiveServerNames, warnings };
}
