import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import {
  agentRunOutcomeIsFailure,
  normalizeChatMessageStatus,
  normalizeMessageOutcome,
  normalizeRunOutcome,
  outcomeToMessageStatus,
  type ChatMessageStatus,
  type RunOutcome,
} from './src/simulator/run-state.ts';

export type Role = 'tenant_admin' | 'team_admin' | 'member';

export type AuthIdentity = {
  sub: string;
  email?: string;
  username?: string;
  tenantId: string;
  role: Role | null;
  authType: 'jwt' | 'api_key';
  apiKeyId?: string;
};

export type UserRow = {
  id: string;
  username: string;
  email: string;
  name: string;
  tenantId: string;
  role: Role;
  createdAt: number;
};

export type TenantRow = {
  id: string;
  name: string;
  region: string;
  plan: string;
  status: string;
  createdAt: number;
};

export type QuotaRow = {
  tenantId: string;
  monthlyActiveSecondsLimit: number;
  monthlyActiveSecondsUsed: number;
  weeklyRunCountLimit: number;
  weeklyRunCountUsed: number;
  maxConcurrentRuns: number;
  perRunMaxActiveHours: number;
  perRunMaxWallClockHours: number;
  perRunMaxLlmTokens: number;
  perRunMaxToolCalls: number;
  knowledgeUploadAdminMaxFiles: number;
  knowledgeUploadMemberMaxFiles: number;
  knowledgeUploadMaxFileBytes: number;
};

export type QuotaUsageRun = {
  id: string;
  actor: string;
  model: string;
  status: RunOutcome;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  createdAt: number;
};

export type QuotaUsageSummary = {
  quota: QuotaRow;
  usage: {
    monthlyActiveSeconds: { used: number; limit: number; percent: number };
    weeklyRunCount: { used: number; limit: number; percent: number };
    totalRuns: number;
    successfulRuns: number;
    failedRuns: number;
    totalDurationMs: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
    totalCostUsd: number;
    lastRunAt: number | null;
  };
  recentRuns: QuotaUsageRun[];
};

export type ApiKeyRow = {
  id: string;
  tenantId: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  createdBy: string | null;
  createdAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
  expiresAt: number | null;
};

export type TeamRow = {
  id: string;
  tenantId: string;
  name: string;
  createdAt: number;
};

export type MemberRow = {
  teamId: string;
  userId: string;
  email: string;
  name: string;
  role: string;
};

export type AuditRow = {
  id: string;
  tenantId: string;
  action: string;
  actor: string;
  actorType: string;
  resource: string;
  diff: unknown;
  createdAt: number;
};

export type PermissionRuleBehavior = 'allow' | 'deny';

export type PermissionRuleRow = {
  id: string;
  tenantId: string;
  toolName: string;
  ruleContent: string;
  behavior: PermissionRuleBehavior;
  enabled: boolean;
  position: number;
  createdAt: number;
  updatedAt: number;
};

export type PermissionRuleDecision = {
  behavior: PermissionRuleBehavior;
  rule: PermissionRuleRow;
  reason: string;
};

export type HookRuleEvent = 'PreToolUse' | 'PostToolUse' | 'Notification';
export type HookRuleAction = 'allow' | 'block' | 'context' | 'log';

export type HookRuleRow = {
  id: string;
  tenantId: string;
  eventName: HookRuleEvent;
  matcher: string;
  ruleContent: string;
  action: HookRuleAction;
  message: string;
  enabled: boolean;
  position: number;
  createdAt: number;
  updatedAt: number;
};

export type HookRuleDecision = {
  action: HookRuleAction;
  rule: HookRuleRow;
  reason: string;
  output: Record<string, unknown>;
};

export type ChatRunStats = {
  costUsd?: number;
  durationMs?: number;
  inTok?: number;
  outTok?: number;
};

export type ChatHistoryMessage = {
  id?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinking?: string;
  status?: ChatMessageStatus;
  outcome?: RunOutcome;
  outcomeDetail?: string;
  runId?: string;
  runStats?: ChatRunStats;
  attachments?: ChatHistoryAttachment[];
  timestamp: number;
};

export type ChatHistoryAttachment = {
  id: string;
  type: 'image';
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  data: string;
  name?: string;
  size: number;
};

export type ChatHistorySession = {
  id: string;
  ownerSub?: string;
  templateId: string;
  title: string;
  messages: ChatHistoryMessage[];
  messageCount?: number;
  model: string;
  sdkSessionId?: string;
  sdkCwd?: string;
  visualPreprocessEnabled?: boolean;
  visualPreprocessModel?: string;
  forkedFromSessionId?: string;
  forkedFromTitle?: string;
  pinned?: boolean;
  collaborationEnabled?: boolean;
  collaborationRole?: 'owner' | 'member';
  collaborationUpdatedAt?: number;
  createdAt: number;
  updatedAt: number;
};

export type KnowledgeSourceRow = {
  id: string;
  tenantId: string;
  name: string;
  path: string;
  readOnly: boolean;
  enabled: boolean;
  createdBy: string | null;
  publishedAt: number | null;
  archivedAt: number | null;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type KnowledgeSourceTestResult = {
  ok: boolean;
  reason?: string;
  fileCount?: number;
  sampleFiles?: string[];
};

export type ProviderProfileRow = {
  tenantId: string;
  id: string;
  name: string;
  ANTHROPIC_AUTH_TOKEN: string;
  ANTHROPIC_BASE_URL: string;
  availableModels: string[];
  modelContextWindows?: Record<string, number>;
  enabled: boolean;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
};

export type InternalToolSettingRow = {
  tenantId: string;
  toolId: string;
  settings: Record<string, unknown>;
  updatedAt: number;
};

export type KnowledgeSourceCandidate = {
  name: string;
  path: string;
  fileCount: number;
  sampleFiles: string[];
};

export type PublicSkillRow = {
  id: string;
  slug: string;
  name: string;
  description: string;
  authorSub: string;
  authorTenantId: string;
  revision: number;
  bundlePath: string;
  publishedAt: number;
  updatedAt: number;
};

export type LearnedSkillRow = {
  tenantId: string;
  ownerSub: string;
  skillName: string;
  skillPath: string;
  publicSkillId: string;
  publicRevision: number;
  learnedAt: number;
};

export type VisualRow = {
  id: string;
  tenantId: string;
  ownerSub: string;
  title?: string;
  html: string;
  sizeBytes: number;
  sourceSlug?: string;
  createdAt: number;
};

export type VisualListRow = Pick<VisualRow, 'id' | 'title' | 'sizeBytes' | 'createdAt'>;

const LEGACY_PREFIX = 'legacy_sha256$';
export const MAX_VISUAL_BYTES = 4 * 1024 * 1024;
const DEFAULT_QUOTA = {
  monthlyActiveSecondsLimit: 36000,
  monthlyActiveSecondsUsed: 0,
  weeklyRunCountLimit: 50,
  weeklyRunCountUsed: 0,
  maxConcurrentRuns: 3,
  perRunMaxActiveHours: 4,
  perRunMaxWallClockHours: 6,
  perRunMaxLlmTokens: 5000000,
  perRunMaxToolCalls: 10000,
  knowledgeUploadAdminMaxFiles: 100,
  knowledgeUploadMemberMaxFiles: 20,
  knowledgeUploadMaxFileBytes: 1024 * 1024,
};

const DATA_DIR = process.env.AGENTMA_DATA_DIR
  || path.join(os.homedir(), 'Library', 'Application Support', 'agentma2');
const DB_PATH = path.join(DATA_DIR, 'dashboard.sqlite');
const JWT_SECRET_PATH = path.join(DATA_DIR, 'jwt-secret');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

initSchema();
migrateLegacyJson();
backfillUserIdentityColumns();
migrateOwnerSubsToUserIds();

const JWT_SECRET = process.env.JWT_SECRET || readOrCreateSecret();

function ensureColumn(tableName: string, columnName: string, definition: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(columnName)) return;
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

function baseUsernameFromEmail(email: string) {
  const prefix = String(email || '').split('@')[0] || 'user';
  const normalized = prefix
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return normalized || 'user';
}

function uniqueUsernameForEmail(email: string, existing: Set<string>) {
  const base = baseUsernameFromEmail(email);
  let candidate = base;
  let suffix = 2;
  while (existing.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  existing.add(candidate);
  return candidate;
}

function loadExistingUsernames() {
  const rows = db.prepare('SELECT username FROM users WHERE username IS NOT NULL').all() as Array<{ username: string }>;
  return new Set(rows.map((row) => row.username));
}

function backfillUserIdentityColumns() {
  const rows = db.prepare(`
    SELECT email, id, username
    FROM users
    ORDER BY created_at ASC, email ASC
  `).all() as Array<{ email: string; id?: string | null; username?: string | null }>;
  const existingUsernames = new Set(rows.flatMap((row) => row.username ? [row.username] : []));
  const updateId = db.prepare('UPDATE users SET id = ? WHERE email = ?');
  const updateUsername = db.prepare('UPDATE users SET username = ? WHERE email = ?');
  for (const row of rows) {
    if (!row.id) updateId.run(crypto.randomUUID(), row.email);
    if (!row.username) updateUsername.run(uniqueUsernameForEmail(row.email, existingUsernames), row.email);
  }
}

function migrateOwnerSubsToUserIds() {
  const ownerTables = [
    ['chat_sessions', 'owner_sub'],
    ['chat_session_members', 'member_sub'],
    ['learned_skills', 'owner_sub'],
    ['visuals', 'owner_sub'],
  ] as const;

  for (const [tableName, columnName] of ownerTables) {
    db.exec(`
      UPDATE ${tableName}
      SET ${columnName} = (
        SELECT u.id FROM users u WHERE u.email = ${tableName}.${columnName}
      )
      WHERE EXISTS (
        SELECT 1 FROM users u WHERE u.email = ${tableName}.${columnName}
      );
    `);
    db.exec(`
      UPDATE ${tableName}
      SET ${columnName} = (
        SELECT u.id
        FROM api_keys k
        JOIN users u ON u.email = k.created_by
        WHERE ('api_key:' || k.id) = ${tableName}.${columnName}
      )
      WHERE ${columnName} LIKE 'api_key:%'
        AND EXISTS (
          SELECT 1
          FROM api_keys k
          JOIN users u ON u.email = k.created_by
          WHERE ('api_key:' || k.id) = ${tableName}.${columnName}
        );
    `);
  }
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      region TEXT NOT NULL,
      plan TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT UNIQUE,
      username TEXT UNIQUE,
      email TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_users_tenant_id ON users (tenant_id);

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      scopes_json TEXT NOT NULL,
      created_by TEXT REFERENCES users(email) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER,
      last_used_at INTEGER,
      expires_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_tenant_id ON api_keys (tenant_id);

    CREATE TABLE IF NOT EXISTS quotas (
      tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
      monthly_active_seconds_limit INTEGER NOT NULL,
      monthly_active_seconds_used INTEGER NOT NULL,
      weekly_run_count_limit INTEGER NOT NULL,
      weekly_run_count_used INTEGER NOT NULL,
      max_concurrent_runs INTEGER NOT NULL,
      per_run_max_active_hours INTEGER NOT NULL,
      per_run_max_wall_clock_hours INTEGER NOT NULL,
      per_run_max_llm_tokens INTEGER NOT NULL,
      per_run_max_tool_calls INTEGER NOT NULL,
      knowledge_upload_admin_max_files INTEGER NOT NULL,
      knowledge_upload_member_max_files INTEGER NOT NULL,
      knowledge_upload_max_file_bytes INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_teams_tenant_id ON teams (tenant_id);

    CREATE TABLE IF NOT EXISTS team_members (
      team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_email TEXT NOT NULL REFERENCES users(email) ON DELETE CASCADE,
      role TEXT NOT NULL,
      PRIMARY KEY (team_id, user_email)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      resource TEXT NOT NULL,
      diff_json TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_id_created_at ON audit_logs (tenant_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_action_created_at ON audit_logs (tenant_id, action, created_at DESC);

    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      owner_sub TEXT NOT NULL,
      template_id TEXT NOT NULL,
      title TEXT NOT NULL,
      model TEXT NOT NULL,
      sdk_session_id TEXT,
      sdk_cwd TEXT,
      forked_from_session_id TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      collaboration_enabled INTEGER NOT NULL DEFAULT 0,
      collaboration_updated_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_owner_updated_at ON chat_sessions (tenant_id, owner_sub, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_owner_pinned_updated_at ON chat_sessions (tenant_id, owner_sub, pinned DESC, updated_at DESC);

    CREATE TABLE IF NOT EXISTS chat_session_members (
      session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      member_sub TEXT NOT NULL,
      role TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, member_sub)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_session_members_member ON chat_session_members (tenant_id, member_sub, joined_at DESC);

    CREATE TABLE IF NOT EXISTS chat_messages (
      session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      PRIMARY KEY (session_id, seq)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session_seq ON chat_messages (session_id, seq);

    CREATE TABLE IF NOT EXISTS permission_rules (
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      rule_content TEXT NOT NULL DEFAULT '',
      behavior TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_permission_rules_tenant_position ON permission_rules (tenant_id, position ASC, updated_at DESC);

    CREATE TABLE IF NOT EXISTS hook_rules (
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      event_name TEXT NOT NULL,
      matcher TEXT NOT NULL DEFAULT '',
      rule_content TEXT NOT NULL DEFAULT '',
      action TEXT NOT NULL,
      message TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      position INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_hook_rules_tenant_position ON hook_rules (tenant_id, position ASC, updated_at DESC);

    CREATE TABLE IF NOT EXISTS knowledge_sources (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      read_only INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_by TEXT,
      published_at INTEGER,
      archived_at INTEGER,
      deleted_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_sources_tenant ON knowledge_sources (tenant_id);

    CREATE TABLE IF NOT EXISTS provider_profiles (
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      auth_token TEXT NOT NULL DEFAULT '',
      base_url TEXT NOT NULL,
      available_models_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_provider_profiles_tenant ON provider_profiles (tenant_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS internal_tool_settings (
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      tool_id TEXT NOT NULL,
      settings_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, tool_id)
    );

    CREATE TABLE IF NOT EXISTS public_skills (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      author_sub TEXT NOT NULL,
      author_tenant_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      bundle_path TEXT NOT NULL,
      published_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_public_skills_updated_at ON public_skills (updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_public_skills_author_tenant ON public_skills (author_tenant_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS learned_skills (
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      owner_sub TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      skill_path TEXT NOT NULL,
      public_skill_id TEXT NOT NULL,
      public_revision INTEGER NOT NULL,
      learned_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, owner_sub, skill_name)
    );
    CREATE INDEX IF NOT EXISTS idx_learned_skills_owner ON learned_skills (tenant_id, owner_sub, learned_at DESC);

    CREATE TABLE IF NOT EXISTS visuals (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      owner_sub TEXT NOT NULL,
      title TEXT,
      html TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      source_slug TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_visuals_owner ON visuals (tenant_id, owner_sub, created_at DESC);

    CREATE TABLE IF NOT EXISTS datasources (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      original_filename TEXT,
      format TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      tables_json TEXT NOT NULL,
      created_by TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_datasources_tenant ON datasources (tenant_id, updated_at DESC);
  `);
  ensureColumn('users', 'id', 'TEXT');
  ensureColumn('users', 'username', 'TEXT');
  backfillUserIdentityColumns();
  migrateOwnerSubsToUserIds();
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_id ON users (id)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users (username)');
  ensureColumn('chat_sessions', 'sdk_session_id', 'TEXT');
  ensureColumn('chat_sessions', 'sdk_cwd', 'TEXT');
  ensureColumn('chat_sessions', 'visual_preprocess_enabled', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('chat_sessions', 'visual_preprocess_model', 'TEXT');
  ensureColumn('chat_sessions', 'forked_from_session_id', 'TEXT');
  ensureColumn('chat_sessions', 'collaboration_enabled', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('chat_sessions', 'collaboration_updated_at', 'INTEGER');
  ensureColumn('chat_messages', 'message_id', 'TEXT');
  ensureColumn('chat_messages', 'attachments_json', 'TEXT');
  ensureColumn('chat_messages', 'status', 'TEXT');
  ensureColumn('chat_messages', 'thinking', 'TEXT');
  ensureColumn('chat_messages', 'outcome', 'TEXT');
  ensureColumn('chat_messages', 'outcome_detail', 'TEXT');
  ensureColumn('chat_messages', 'run_id', 'TEXT');
  ensureColumn('chat_messages', 'run_stats_json', 'TEXT');
  ensureColumn('provider_profiles', 'model_context_windows_json', 'TEXT');
  ensureColumn('quotas', 'knowledge_upload_admin_max_files', 'INTEGER NOT NULL DEFAULT 100');
  ensureColumn('quotas', 'knowledge_upload_member_max_files', 'INTEGER NOT NULL DEFAULT 20');
  ensureColumn('quotas', 'knowledge_upload_max_file_bytes', 'INTEGER NOT NULL DEFAULT 1048576');
  ensureColumn('knowledge_sources', 'created_by', 'TEXT');
  ensureColumn('knowledge_sources', 'published_at', 'INTEGER');
  ensureColumn('knowledge_sources', 'archived_at', 'INTEGER');
  ensureColumn('knowledge_sources', 'deleted_at', 'INTEGER');
  // Legacy knowledge sources predate per-creator ownership. Attribute them to the
  // tenant admin so the admin's agents retain write access (subject to read_only),
  // while everyone else stays read-only. Idempotent: only fills NULL rows.
  db.exec(`
    UPDATE knowledge_sources
    SET created_by = (
      SELECT email FROM users u
      WHERE u.tenant_id = knowledge_sources.tenant_id AND u.role = 'tenant_admin'
      ORDER BY u.created_at ASC LIMIT 1
    )
    WHERE created_by IS NULL;
  `);
}

function readOrCreateSecret() {
  try {
    const secret = fs.readFileSync(JWT_SECRET_PATH, 'utf-8').trim();
    if (secret) return secret;
  } catch {}
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(JWT_SECRET_PATH, secret);
  return secret;
}

function hasImportedLegacyJson() {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('legacy_json_imported_v1') as { value: string } | undefined;
  return row?.value === '1';
}

function setImportedLegacyJson() {
  db.prepare(`
    INSERT INTO meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run('legacy_json_imported_v1', '1');
}

function migrateLegacyJson() {
  if (hasImportedLegacyJson()) return;

  const legacyUsers = readLegacy<Record<string, {
    email: string;
    name: string;
    passwordHash: string;
    tenantId: string;
    role: Role;
    createdAt: number;
  }>>('/tmp/agentma_users.json', {});
  const legacyTenants = readLegacy<Record<string, TenantRow>>('/tmp/agentma_tenants.json', {});
  const legacyQuotas = readLegacy<Record<string, QuotaRow>>('/tmp/agentma_quotas.json', {});
  const legacyKeys = readLegacy<Array<{
    id: string;
    tenantId: string;
    name: string;
    keyHash: string;
    keyPrefix: string;
    scopes: string[];
    createdBy: string;
    createdAt: number;
    revokedAt: number | null;
  }>>('/tmp/agentma_apikeys.json', []);
  const legacyTeams = readLegacy<TeamRow[]>('/tmp/agentma_teams.json', []);
  const legacyMembers = readLegacy<Array<{ teamId: string; userId: string; role: string }>>('/tmp/agentma_members.json', []);
  const legacyAuditLogs = readLegacy<AuditRow[]>('/tmp/agentma_audit.json', []);

  db.exec('BEGIN');
  try {
    for (const tenant of Object.values(legacyTenants)) {
      db.prepare(`
        INSERT OR IGNORE INTO tenants (id, name, region, plan, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(tenant.id, tenant.name, tenant.region, tenant.plan, tenant.status, tenant.createdAt);
    }

    for (const user of Object.values(legacyUsers)) {
      const passwordHash = user.passwordHash.startsWith(LEGACY_PREFIX)
        ? user.passwordHash
        : `${LEGACY_PREFIX}${user.passwordHash}`;
      db.prepare(`
        INSERT OR IGNORE INTO users (id, username, email, name, password_hash, tenant_id, role, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(crypto.randomUUID(), uniqueUsernameForEmail(user.email, loadExistingUsernames()), user.email, user.name, passwordHash, user.tenantId, user.role, user.createdAt);
    }

    for (const quota of Object.values(legacyQuotas)) {
      db.prepare(`
        INSERT OR IGNORE INTO quotas (
          tenant_id, monthly_active_seconds_limit, monthly_active_seconds_used,
          weekly_run_count_limit, weekly_run_count_used, max_concurrent_runs,
          per_run_max_active_hours, per_run_max_wall_clock_hours,
          per_run_max_llm_tokens, per_run_max_tool_calls,
          knowledge_upload_admin_max_files, knowledge_upload_member_max_files,
          knowledge_upload_max_file_bytes
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        quota.tenantId,
        quota.monthlyActiveSecondsLimit,
        quota.monthlyActiveSecondsUsed,
        quota.weeklyRunCountLimit,
        quota.weeklyRunCountUsed,
        quota.maxConcurrentRuns,
        quota.perRunMaxActiveHours,
        quota.perRunMaxWallClockHours,
        quota.perRunMaxLlmTokens,
        quota.perRunMaxToolCalls,
        quota.knowledgeUploadAdminMaxFiles ?? DEFAULT_QUOTA.knowledgeUploadAdminMaxFiles,
        quota.knowledgeUploadMemberMaxFiles ?? DEFAULT_QUOTA.knowledgeUploadMemberMaxFiles,
        quota.knowledgeUploadMaxFileBytes ?? DEFAULT_QUOTA.knowledgeUploadMaxFileBytes,
      );
    }

    for (const key of legacyKeys) {
      db.prepare(`
        INSERT OR IGNORE INTO api_keys (
          id, tenant_id, name, key_hash, key_prefix, scopes_json,
          created_by, created_at, revoked_at, last_used_at, expires_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      `).run(
        key.id,
        key.tenantId,
        key.name,
        key.keyHash,
        key.keyPrefix,
        JSON.stringify(key.scopes || []),
        key.createdBy || null,
        key.createdAt,
        key.revokedAt,
      );
    }

    for (const team of legacyTeams) {
      db.prepare(`
        INSERT OR IGNORE INTO teams (id, tenant_id, name, created_at)
        VALUES (?, ?, ?, ?)
      `).run(team.id, team.tenantId, team.name, team.createdAt);
    }

    for (const member of legacyMembers) {
      db.prepare(`
        INSERT OR IGNORE INTO team_members (team_id, user_email, role)
        VALUES (?, ?, ?)
      `).run(member.teamId, member.userId, member.role || 'member');
    }

    for (const log of legacyAuditLogs) {
      db.prepare(`
        INSERT OR IGNORE INTO audit_logs (
          id, tenant_id, action, actor, actor_type, resource, diff_json, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        log.id,
        log.tenantId,
        log.action,
        log.actor,
        log.actorType,
        log.resource,
        log.diff === undefined ? null : JSON.stringify(log.diff),
        log.createdAt,
      );
    }

    setImportedLegacyJson();
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function readLegacy<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function hashLegacyPw(password: string) {
  return crypto.createHash('sha256').update(password + 'agentma').digest('hex');
}

function sha256(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function now() {
  return Date.now();
}

function expandHome(value: string) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value.replace(/\$HOME\b/g, os.homedir());
}

function defaultKnowledgeAllowlist() {
  return [
    '$HOME/Documents',
    '$HOME/Obsidian',
    '$HOME/Notes',
    '$HOME/Library/Mobile Documents/iCloud~md~obsidian/Documents',
    path.join(DATA_DIR, 'knowledge-uploads'),
  ];
}

function knowledgeAllowlistRoots() {
  const raw = process.env.AGENTMA_KNOWLEDGE_ROOT_ALLOWLIST;
  const configuredEntries = raw && raw.trim() ? raw.split(path.delimiter) : defaultKnowledgeAllowlist();
  const entries = [...configuredEntries, path.join(DATA_DIR, 'knowledge-uploads')]
    .map((item) => expandHome(item.trim()))
    .filter(Boolean);

  return Array.from(new Set(entries.flatMap((entry) => {
    try {
      return [fs.realpathSync.native(path.resolve(entry))];
    } catch {
      return [];
    }
  })));
}

function isPathWithinRoot(candidate: string, root: string) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function findAllowedKnowledgeRoot(resolvedPath: string) {
  return knowledgeAllowlistRoots().find((root) => isPathWithinRoot(resolvedPath, root));
}

function resolveKnowledgeDirectory(inputPath: string): { ok: true; path: string } | { ok: false; reason: string } {
  const trimmed = inputPath.trim();
  if (!trimmed) return { ok: false, reason: '路径不能为空' };

  const absolute = path.resolve(expandHome(trimmed));
  let stat: fs.Stats;
  let realPath: string;
  try {
    stat = fs.statSync(absolute);
    realPath = fs.realpathSync.native(absolute);
  } catch {
    return { ok: false, reason: '目录不存在' };
  }
  if (!stat.isDirectory()) return { ok: false, reason: '路径不是目录' };
  try {
    fs.accessSync(realPath, fs.constants.R_OK);
  } catch {
    return { ok: false, reason: '无读取权限' };
  }
  if (!findAllowedKnowledgeRoot(realPath)) {
    return { ok: false, reason: '路径不在允许范围,请联系管理员加白名单' };
  }
  return { ok: true, path: realPath };
}

const KNOWLEDGE_FILE_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.csv', '.xls', '.xlsx']);

function isKnowledgeFileName(name: string) {
  return KNOWLEDGE_FILE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function collectKnowledgeFiles(root: string) {
  const sampleFiles: string[] = [];
  let fileCount = 0;
  const stack = [root];

  while (stack.length) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && isKnowledgeFileName(entry.name)) {
        fileCount += 1;
        if (sampleFiles.length < 20) {
          sampleFiles.push(path.relative(root, fullPath).split(path.sep).join('/'));
        }
      }
    }
  }

  return { fileCount, sampleFiles };
}

function collectKnowledgeFilesBounded(root: string) {
  const sampleFiles: string[] = [];
  let fileCount = 0;
  let scannedEntries = 0;
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  const maxDepth = 6;
  const maxEntries = 12000;

  while (stack.length && scannedEntries < maxEntries) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      scannedEntries += 1;
      if (scannedEntries >= maxEntries) break;
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const fullPath = path.join(current.dir, entry.name);
      if (entry.isDirectory() && current.depth < maxDepth) {
        stack.push({ dir: fullPath, depth: current.depth + 1 });
      } else if (entry.isFile() && isKnowledgeFileName(entry.name)) {
        fileCount += 1;
        if (sampleFiles.length < 8) {
          sampleFiles.push(path.relative(root, fullPath).split(path.sep).join('/'));
        }
      }
    }
  }

  return { fileCount, sampleFiles };
}

function hasDirectKnowledgeFile(dir: string) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .some((entry) => entry.isFile() && isKnowledgeFileName(entry.name));
  } catch {
    return false;
  }
}

function knowledgeCandidateForDirectory(dir: string, opts: { allowRecursiveOnly?: boolean } = {}): KnowledgeSourceCandidate | null {
  let resolved: string;
  try {
    resolved = fs.realpathSync.native(dir);
  } catch {
    return null;
  }
  if (!findAllowedKnowledgeRoot(resolved)) return null;
  const hasObsidian = fs.existsSync(path.join(resolved, '.obsidian'));
  const hasDirectKnowledgeFileEntry = hasDirectKnowledgeFile(resolved);
  const result = collectKnowledgeFilesBounded(resolved);
  if (!hasObsidian && !hasDirectKnowledgeFileEntry && (!opts.allowRecursiveOnly || result.fileCount === 0)) return null;
  return {
    name: path.basename(resolved) || '知识库',
    path: resolved,
    fileCount: result.fileCount,
    sampleFiles: result.sampleFiles,
  };
}

function scanKnowledgeCandidateDirs(root: string, maxDepth: number) {
  const candidates: KnowledgeSourceCandidate[] = [];
  const seen = new Set<string>();
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  const maxCandidates = 100;

  while (stack.length && candidates.length < maxCandidates) {
    const current = stack.pop()!;
    let resolved: string;
    try {
      resolved = fs.realpathSync.native(current.dir);
    } catch {
      continue;
    }
    if (seen.has(resolved) || !findAllowedKnowledgeRoot(resolved)) continue;
    seen.add(resolved);

    const candidate = knowledgeCandidateForDirectory(resolved);
    if (candidate) {
      candidates.push(candidate);
      if (fs.existsSync(path.join(resolved, '.obsidian'))) continue;
    }
    if (current.depth >= maxDepth) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(resolved, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || ['node_modules', 'dist', 'build', '.next', 'coverage'].includes(entry.name)) continue;
      stack.push({ dir: path.join(resolved, entry.name), depth: current.depth + 1 });
    }
  }

  return candidates;
}

function parseJsonArray(value: string | null) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mapTenant(row: any): TenantRow {
  return {
    id: row.id,
    name: row.name,
    region: row.region,
    plan: row.plan,
    status: row.status,
    createdAt: row.created_at,
  };
}

function mapUser(row: any): UserRow {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    name: row.name,
    tenantId: row.tenant_id,
    role: row.role,
    createdAt: row.created_at,
  };
}

function mapQuota(row: any): QuotaRow {
  return {
    tenantId: row.tenant_id,
    monthlyActiveSecondsLimit: row.monthly_active_seconds_limit,
    monthlyActiveSecondsUsed: row.monthly_active_seconds_used,
    weeklyRunCountLimit: row.weekly_run_count_limit,
    weeklyRunCountUsed: row.weekly_run_count_used,
    maxConcurrentRuns: row.max_concurrent_runs,
    perRunMaxActiveHours: row.per_run_max_active_hours,
    perRunMaxWallClockHours: row.per_run_max_wall_clock_hours,
    perRunMaxLlmTokens: row.per_run_max_llm_tokens,
    perRunMaxToolCalls: row.per_run_max_tool_calls,
    knowledgeUploadAdminMaxFiles: row.knowledge_upload_admin_max_files,
    knowledgeUploadMemberMaxFiles: row.knowledge_upload_member_max_files,
    knowledgeUploadMaxFileBytes: row.knowledge_upload_max_file_bytes,
  };
}

function clampPercent(used: number, limit: number) {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((used / limit) * 1000) / 10));
}

function asAgentRunDiff(diff: unknown): Record<string, unknown> {
  return diff && typeof diff === 'object' && !Array.isArray(diff) ? diff as Record<string, unknown> : {};
}

function toFiniteNumber(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function mapQuotaUsageRun(row: any): QuotaUsageRun {
  const diff = asAgentRunDiff(row.diff_json ? JSON.parse(row.diff_json) : {});
  const inputTokens = toFiniteNumber(diff.inputTokens);
  const outputTokens = toFiniteNumber(diff.outputTokens);
  const status = normalizeRunOutcome(diff.status, 'provider_error');
  return {
    id: row.id,
    actor: row.actor,
    model: String(diff.model || row.resource || '').replace(/^run:/, ''),
    status,
    durationMs: toFiniteNumber(diff.durationMs),
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd: toFiniteNumber(diff.costUsd),
    createdAt: row.created_at,
  };
}

function mapApiKey(row: any): ApiKeyRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    keyPrefix: row.key_prefix,
    scopes: parseJsonArray(row.scopes_json),
    createdBy: row.created_by,
    createdAt: row.created_at,
    revokedAt: row.revoked_at ?? null,
    lastUsedAt: row.last_used_at ?? null,
    expiresAt: row.expires_at ?? null,
  };
}

function mapAudit(row: any): AuditRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    action: row.action,
    actor: row.actor,
    actorType: row.actor_type,
    resource: row.resource,
    diff: row.diff_json ? JSON.parse(row.diff_json) : undefined,
    createdAt: row.created_at,
  };
}

function mapPermissionRule(row: any): PermissionRuleRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    toolName: row.tool_name,
    ruleContent: row.rule_content || '',
    behavior: row.behavior,
    enabled: Boolean(row.enabled),
    position: Number(row.position || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapHookRule(row: any): HookRuleRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    eventName: row.event_name,
    matcher: row.matcher || '',
    ruleContent: row.rule_content || '',
    action: row.action,
    message: row.message || '',
    enabled: Boolean(row.enabled),
    position: Number(row.position || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapKnowledgeSource(row: any): KnowledgeSourceRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    path: row.path,
    readOnly: Boolean(row.read_only),
    enabled: Boolean(row.enabled),
    createdBy: row.created_by ?? null,
    publishedAt: row.published_at ?? null,
    archivedAt: row.archived_at ?? null,
    deletedAt: row.deleted_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPublicSkill(row: any): PublicSkillRow {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    authorSub: row.author_sub,
    authorTenantId: row.author_tenant_id,
    revision: Number(row.revision || 0),
    bundlePath: row.bundle_path,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
  };
}

function mapLearnedSkill(row: any): LearnedSkillRow {
  return {
    tenantId: row.tenant_id,
    ownerSub: row.owner_sub,
    skillName: row.skill_name,
    skillPath: row.skill_path,
    publicSkillId: row.public_skill_id,
    publicRevision: Number(row.public_revision || 0),
    learnedAt: row.learned_at,
  };
}

const IMAGE_ATTACHMENT_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

function normalizeChatAttachments(value: unknown): ChatHistoryAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const raw = item as Record<string, unknown>;
    if (raw.type !== 'image') return [];
    const mediaType = String(raw.mediaType || '');
    const data = String(raw.data || '');
    if (!IMAGE_ATTACHMENT_MIME_TYPES.has(mediaType) || !data) return [];
    return [{
      id: String(raw.id || crypto.randomUUID()),
      type: 'image' as const,
      mediaType: mediaType as ChatHistoryAttachment['mediaType'],
      data,
      name: typeof raw.name === 'string' ? raw.name : undefined,
      size: Number(raw.size) || 0,
    }];
  });
}

function parseChatAttachments(value: unknown): ChatHistoryAttachment[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    return normalizeChatAttachments(JSON.parse(value));
  } catch {
    return [];
  }
}

function finiteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeChatRunStats(value: unknown): ChatRunStats | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const stats: ChatRunStats = {
    costUsd: finiteNumber(raw.costUsd),
    durationMs: finiteNumber(raw.durationMs),
    inTok: finiteNumber(raw.inTok),
    outTok: finiteNumber(raw.outTok),
  };
  return Object.values(stats).some(v => v !== undefined) ? stats : undefined;
}

function parseChatRunStats(value: unknown): ChatRunStats | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    return normalizeChatRunStats(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function normalizeChatMessages(messages: unknown): ChatHistoryMessage[] {
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message, index) => {
    if (!message || typeof message !== 'object') return [];
    const raw = message as Record<string, unknown>;
    const role = raw.role;
    const content = raw.content;
    const attachments = normalizeChatAttachments(raw.attachments);
    const timestamp = Number(raw.timestamp);
    if (!['user', 'assistant', 'system'].includes(String(role))) return [];
    if (typeof content !== 'string') return [];
    const status = normalizeChatMessageStatus(raw.status);
    const outcome = normalizeMessageOutcome(raw.outcome, status);
    const id = typeof raw.id === 'string' && raw.id ? raw.id : undefined;
    const thinking = typeof raw.thinking === 'string' && raw.thinking ? raw.thinking : undefined;
    const outcomeDetail = typeof raw.outcomeDetail === 'string' && raw.outcomeDetail ? raw.outcomeDetail : undefined;
    const runId = typeof raw.runId === 'string' && raw.runId ? raw.runId : undefined;
    const runStats = normalizeChatRunStats(raw.runStats);
    return [{
      ...(id ? { id } : {}),
      role: role as ChatHistoryMessage['role'],
      content,
      ...(thinking ? { thinking } : {}),
      ...(status || outcome ? { status: status || outcomeToMessageStatus(outcome!) } : {}),
      ...(outcome ? { outcome } : {}),
      ...(outcomeDetail ? { outcomeDetail } : {}),
      ...(runId ? { runId } : {}),
      ...(runStats ? { runStats } : {}),
      ...(attachments.length ? { attachments } : {}),
      timestamp: Number.isFinite(timestamp) ? timestamp : now() + index,
    }];
  });
}

function mapChatSession(row: any, messages: ChatHistoryMessage[], viewerSub?: string): ChatHistorySession {
  const collaborationRole = viewerSub
    ? (row.owner_sub === viewerSub ? 'owner' : 'member')
    : undefined;
  const rawMessageCount = Number(row.message_count);
  return {
    id: row.id,
    ownerSub: row.owner_sub,
    templateId: row.template_id,
    title: row.title,
    messages,
    messageCount: Number.isFinite(rawMessageCount) ? rawMessageCount : messages.length,
    model: row.model,
    sdkSessionId: row.sdk_session_id || undefined,
    sdkCwd: row.sdk_cwd || undefined,
    visualPreprocessEnabled: Boolean(row.visual_preprocess_enabled),
    visualPreprocessModel: row.visual_preprocess_model || undefined,
    forkedFromSessionId: row.forked_from_session_id || undefined,
    forkedFromTitle: row.forked_from_title || undefined,
    pinned: Boolean(row.pinned),
    collaborationEnabled: Boolean(row.collaboration_enabled),
    collaborationRole,
    collaborationUpdatedAt: row.collaboration_updated_at || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapChatSessionSummary(row: any, viewerSub?: string): ChatHistorySession {
  return mapChatSession(row, [], viewerSub);
}

function getUserWithPassword(email: string) {
  return db.prepare(`
    SELECT id, username, email, name, password_hash, tenant_id, role, created_at
    FROM users
    WHERE email = ?
  `).get(email) as {
    id: string;
    username: string;
    email: string;
    name: string;
    password_hash: string;
    tenant_id: string;
    role: Role;
    created_at: number;
  } | undefined;
}

function getUser(email: string) {
  const row = db.prepare(`
    SELECT id, username, email, name, tenant_id, role, created_at
    FROM users
    WHERE email = ?
  `).get(email);
  return row ? mapUser(row) : null;
}

function getUserById(id: string) {
  const row = db.prepare(`
    SELECT id, username, email, name, tenant_id, role, created_at
    FROM users
    WHERE id = ?
  `).get(id);
  return row ? mapUser(row) : null;
}

function getUserBySubject(subject: string) {
  return getUserById(subject) || getUser(subject);
}

function getTenant(tenantId: string) {
  const row = db.prepare(`
    SELECT id, name, region, plan, status, created_at
    FROM tenants
    WHERE id = ?
  `).get(tenantId);
  return row ? mapTenant(row) : null;
}

function ensureQuotaForTenant(tenantId: string) {
  db.prepare(`
    INSERT OR IGNORE INTO quotas (
      tenant_id, monthly_active_seconds_limit, monthly_active_seconds_used,
      weekly_run_count_limit, weekly_run_count_used, max_concurrent_runs,
      per_run_max_active_hours, per_run_max_wall_clock_hours,
      per_run_max_llm_tokens, per_run_max_tool_calls,
      knowledge_upload_admin_max_files, knowledge_upload_member_max_files,
      knowledge_upload_max_file_bytes
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    tenantId,
    DEFAULT_QUOTA.monthlyActiveSecondsLimit,
    DEFAULT_QUOTA.monthlyActiveSecondsUsed,
    DEFAULT_QUOTA.weeklyRunCountLimit,
    DEFAULT_QUOTA.weeklyRunCountUsed,
    DEFAULT_QUOTA.maxConcurrentRuns,
    DEFAULT_QUOTA.perRunMaxActiveHours,
    DEFAULT_QUOTA.perRunMaxWallClockHours,
    DEFAULT_QUOTA.perRunMaxLlmTokens,
    DEFAULT_QUOTA.perRunMaxToolCalls,
    DEFAULT_QUOTA.knowledgeUploadAdminMaxFiles,
    DEFAULT_QUOTA.knowledgeUploadMemberMaxFiles,
    DEFAULT_QUOTA.knowledgeUploadMaxFileBytes,
  );
}

export function signJWT(obj: object) {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const b = Buffer.from(JSON.stringify({ ...obj, exp: Math.floor(now() / 1000) + 7 * 86400 })).toString('base64url');
  return `${h}.${b}.${crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest('base64url')}`;
}

function verifyJwtOnly(token: string) {
  const [h, b, s] = token.split('.');
  if (!h || !b || !s) return null;
  if (crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest('base64url') !== s) return null;
  const payload = JSON.parse(Buffer.from(b, 'base64url').toString()) as { sub: string; tenantId: string; exp: number };
  return payload.exp > Math.floor(now() / 1000) ? payload : null;
}

export function authenticateToken(token: string | undefined | null): AuthIdentity | null {
  if (!token) return null;

  const jwtPayload = verifyJwtOnly(token);
  if (jwtPayload) {
    const user = getUserBySubject(jwtPayload.sub);
    if (!user) return null;
    return {
      sub: user.id,
      email: user.email,
      username: user.username,
      tenantId: jwtPayload.tenantId,
      role: user.role,
      authType: 'jwt',
    };
  }

  const keyHash = sha256(token);
  const row = db.prepare(`
    SELECT id, tenant_id, name, expires_at
    FROM api_keys
    WHERE key_hash = ? AND revoked_at IS NULL
    LIMIT 1
  `).get(keyHash) as {
    id: string;
    tenant_id: string;
    name: string;
    expires_at: number | null;
  } | undefined;
  if (!row) return null;
  if (row.expires_at && row.expires_at <= now()) return null;

  db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now(), row.id);
  return {
    sub: `api_key:${row.id}`,
    username: row.name || `api_key:${row.id}`,
    tenantId: row.tenant_id,
    role: null,
    authType: 'api_key',
    apiKeyId: row.id,
  };
}

export function registerUser(name: string, email: string, password: string) {
  if (getUser(email)) return { ok: false as const, status: 409, error: '邮箱已注册' };

  const tenantId = crypto.randomUUID();
  const createdAt = now();
  const passwordHash = bcrypt.hashSync(password, 10);

  db.exec('BEGIN');
  try {
    db.prepare(`
      INSERT INTO tenants (id, name, region, plan, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(tenantId, `${name || email}'s Workspace`, 'us', 'free', 'active', createdAt);

    db.prepare(`
      INSERT INTO users (id, username, email, name, password_hash, tenant_id, role, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), uniqueUsernameForEmail(email, loadExistingUsernames()), email, name || email.split('@')[0], passwordHash, tenantId, 'tenant_admin', createdAt);

    ensureQuotaForTenant(tenantId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  audit(tenantId, 'register', email, 'user', `tenant:${tenantId}`);
  const user = getUser(email)!;
  return { ok: true as const, user, tenantId };
}

export function createTenantUser(tenantId: string, name: string, email: string, password: string, role: Role = 'member') {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const normalizedName = String(name || '').trim() || normalizedEmail.split('@')[0] || '成员';
  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    return { ok: false as const, status: 400, error: '邮箱格式无效' };
  }
  if (!password || password.length < 6) {
    return { ok: false as const, status: 400, error: '密码至少 6 位' };
  }
  if (!['tenant_admin', 'team_admin', 'member'].includes(role)) {
    return { ok: false as const, status: 400, error: 'invalid role' };
  }
  if (!getTenant(tenantId)) {
    return { ok: false as const, status: 404, error: 'tenant not found' };
  }
  if (getUser(normalizedEmail)) {
    return { ok: false as const, status: 409, error: '邮箱已注册' };
  }

  db.prepare(`
    INSERT INTO users (id, username, email, name, password_hash, tenant_id, role, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), uniqueUsernameForEmail(normalizedEmail, loadExistingUsernames()), normalizedEmail, normalizedName, bcrypt.hashSync(password, 10), tenantId, role, now());

  return { ok: true as const, user: getUser(normalizedEmail)! };
}

export function loginUser(email: string, password: string) {
  const user = getUserWithPassword(email);
  if (!user) return { ok: false as const, status: 401, error: '该邮箱未注册' };

  const storedHash = user.password_hash;
  let valid = false;
  if (storedHash.startsWith(LEGACY_PREFIX)) {
    valid = hashLegacyPw(password) === storedHash.slice(LEGACY_PREFIX.length);
    if (valid) {
      db.prepare('UPDATE users SET password_hash = ? WHERE email = ?').run(bcrypt.hashSync(password, 10), email);
    }
  } else {
    valid = bcrypt.compareSync(password, storedHash);
  }

  if (!valid) return { ok: false as const, status: 401, error: '密码错误' };

  audit(user.tenant_id, 'login', email, 'user', `user:${email}`);
  return {
    ok: true as const,
    user: {
      id: user.id,
      username: user.username,
      email: user.email,
      name: user.name,
      tenantId: user.tenant_id,
      role: user.role,
      createdAt: user.created_at,
    },
  };
}

export function getMe(identity: AuthIdentity) {
  const user = identity.sub.startsWith('api_key:') ? null : getUserById(identity.sub);
  const tenant = getTenant(identity.tenantId);
  return {
    id: user?.id || undefined,
    username: user?.username || identity.username || undefined,
    email: user?.email || undefined,
    tenantId: identity.tenantId,
    name: user?.name,
    role: user?.role || identity.role || undefined,
    plan: tenant?.plan,
    region: tenant?.region,
  };
}

export function updateTenant(tenantId: string, patch: { name?: string; plan?: string }) {
  const tenant = getTenant(tenantId);
  if (!tenant) return null;
  const nextName = patch.name || tenant.name;
  const nextPlan = patch.plan && ['free', 'pro', 'enterprise'].includes(patch.plan) ? patch.plan : tenant.plan;
  db.prepare('UPDATE tenants SET name = ?, plan = ? WHERE id = ?').run(nextName, nextPlan, tenantId);
  return getTenant(tenantId);
}

export function listUsers(tenantId: string) {
  const rows = db.prepare(`
    SELECT id, username, email, name, tenant_id, role, created_at
    FROM users
    WHERE tenant_id = ?
    ORDER BY created_at ASC
  `).all(tenantId);
  return rows.map(mapUser);
}

export function updateUserRole(tenantId: string, email: string, role: Role) {
  const user = getUser(email);
  if (!user || user.tenantId !== tenantId) return null;
  db.prepare('UPDATE users SET role = ? WHERE email = ?').run(role, email);
  return getUser(email);
}

export function deleteUser(tenantId: string, email: string) {
  const user = getUser(email);
  if (!user || user.tenantId !== tenantId) return false;
  db.prepare('DELETE FROM users WHERE email = ?').run(email);
  return true;
}

export function listApiKeys(tenantId: string) {
  const rows = db.prepare(`
    SELECT id, tenant_id, name, key_prefix, scopes_json, created_by, created_at, revoked_at, last_used_at, expires_at
    FROM api_keys
    WHERE tenant_id = ? AND revoked_at IS NULL
    ORDER BY created_at DESC
  `).all(tenantId);
  return rows.map(mapApiKey);
}

export function createApiKey(tenantId: string, createdBy: string | null, name: string, scopes: string[]) {
  const rawKey = `sk-tenant_${crypto.randomBytes(24).toString('hex')}`;
  const row: ApiKeyRow = {
    id: crypto.randomUUID(),
    tenantId,
    name,
    keyPrefix: `${rawKey.slice(0, 18)}...`,
    scopes,
    createdBy,
    createdAt: now(),
    revokedAt: null,
    lastUsedAt: null,
    expiresAt: null,
  };
  db.prepare(`
    INSERT INTO api_keys (
      id, tenant_id, name, key_hash, key_prefix, scopes_json,
      created_by, created_at, revoked_at, last_used_at, expires_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.tenantId,
    row.name,
    sha256(rawKey),
    row.keyPrefix,
    JSON.stringify(scopes),
    row.createdBy,
    row.createdAt,
    null,
    null,
    null,
  );
  audit(tenantId, 'create_api_key', createdBy || 'api_key', 'user', `apikey:${row.id}`);
  return { ...row, rawKey };
}

export function revokeApiKey(tenantId: string, id: string) {
  const result = db.prepare(`
    UPDATE api_keys
    SET revoked_at = ?
    WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL
  `).run(now(), id, tenantId);
  return result.changes > 0;
}

export function getQuota(tenantId: string) {
  ensureQuotaForTenant(tenantId);
  const row = db.prepare(`
    SELECT tenant_id, monthly_active_seconds_limit, monthly_active_seconds_used,
           weekly_run_count_limit, weekly_run_count_used, max_concurrent_runs,
           per_run_max_active_hours, per_run_max_wall_clock_hours,
           per_run_max_llm_tokens, per_run_max_tool_calls,
           knowledge_upload_admin_max_files, knowledge_upload_member_max_files,
           knowledge_upload_max_file_bytes
    FROM quotas
    WHERE tenant_id = ?
  `).get(tenantId);
  return row ? mapQuota(row) : { tenantId, ...DEFAULT_QUOTA };
}

export function getQuotaUsageSummary(tenantId: string): QuotaUsageSummary {
  const quota = getQuota(tenantId);
  const rows = db.prepare(`
    SELECT id, actor, resource, diff_json, created_at
    FROM audit_logs
    WHERE tenant_id = ? AND action = 'agent_run'
    ORDER BY created_at DESC
    LIMIT 100
  `).all(tenantId);
  const runs = rows.map(mapQuotaUsageRun);
  const totalInputTokens = runs.reduce((sum, run) => sum + run.inputTokens, 0);
  const totalOutputTokens = runs.reduce((sum, run) => sum + run.outputTokens, 0);
  const totalDurationMs = runs.reduce((sum, run) => sum + run.durationMs, 0);
  const totalCostUsd = runs.reduce((sum, run) => sum + run.costUsd, 0);

  return {
    quota,
    usage: {
      monthlyActiveSeconds: {
        used: quota.monthlyActiveSecondsUsed,
        limit: quota.monthlyActiveSecondsLimit,
        percent: clampPercent(quota.monthlyActiveSecondsUsed, quota.monthlyActiveSecondsLimit),
      },
      weeklyRunCount: {
        used: quota.weeklyRunCountUsed,
        limit: quota.weeklyRunCountLimit,
        percent: clampPercent(quota.weeklyRunCountUsed, quota.weeklyRunCountLimit),
      },
      totalRuns: runs.length,
      successfulRuns: runs.filter((run) => run.status === 'completed').length,
      failedRuns: runs.filter((run) => agentRunOutcomeIsFailure(run.status)).length,
      totalDurationMs,
      totalInputTokens,
      totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
      totalCostUsd,
      lastRunAt: runs[0]?.createdAt ?? null,
    },
    recentRuns: runs.slice(0, 10),
  };
}

export function updateQuota(tenantId: string, body: Record<string, unknown>) {
  ensureQuotaForTenant(tenantId);
  const current = getQuota(tenantId);
  const boundedPositiveInt = (value: unknown, fallback: number, min: number, max: number) => {
    if (value === undefined) return fallback;
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  };
  const next = {
    ...current,
    monthlyActiveSecondsLimit: body.monthlyActiveSecondsLimit !== undefined ? Number(body.monthlyActiveSecondsLimit) : current.monthlyActiveSecondsLimit,
    weeklyRunCountLimit: body.weeklyRunCountLimit !== undefined ? Number(body.weeklyRunCountLimit) : current.weeklyRunCountLimit,
    maxConcurrentRuns: body.maxConcurrentRuns !== undefined ? Number(body.maxConcurrentRuns) : current.maxConcurrentRuns,
    perRunMaxActiveHours: body.perRunMaxActiveHours !== undefined ? Number(body.perRunMaxActiveHours) : current.perRunMaxActiveHours,
    perRunMaxWallClockHours: body.perRunMaxWallClockHours !== undefined ? Number(body.perRunMaxWallClockHours) : current.perRunMaxWallClockHours,
    perRunMaxLlmTokens: body.perRunMaxLlmTokens !== undefined ? Number(body.perRunMaxLlmTokens) : current.perRunMaxLlmTokens,
    perRunMaxToolCalls: body.perRunMaxToolCalls !== undefined ? Number(body.perRunMaxToolCalls) : current.perRunMaxToolCalls,
    knowledgeUploadAdminMaxFiles: boundedPositiveInt(body.knowledgeUploadAdminMaxFiles, current.knowledgeUploadAdminMaxFiles, 1, 500),
    knowledgeUploadMemberMaxFiles: boundedPositiveInt(body.knowledgeUploadMemberMaxFiles, current.knowledgeUploadMemberMaxFiles, 1, 500),
    knowledgeUploadMaxFileBytes: boundedPositiveInt(body.knowledgeUploadMaxFileBytes, current.knowledgeUploadMaxFileBytes, 1024, 20 * 1024 * 1024),
  };
  db.prepare(`
    UPDATE quotas
    SET monthly_active_seconds_limit = ?,
        weekly_run_count_limit = ?,
        max_concurrent_runs = ?,
        per_run_max_active_hours = ?,
        per_run_max_wall_clock_hours = ?,
        per_run_max_llm_tokens = ?,
        per_run_max_tool_calls = ?,
        knowledge_upload_admin_max_files = ?,
        knowledge_upload_member_max_files = ?,
        knowledge_upload_max_file_bytes = ?
    WHERE tenant_id = ?
  `).run(
    next.monthlyActiveSecondsLimit,
    next.weeklyRunCountLimit,
    next.maxConcurrentRuns,
    next.perRunMaxActiveHours,
    next.perRunMaxWallClockHours,
    next.perRunMaxLlmTokens,
    next.perRunMaxToolCalls,
    next.knowledgeUploadAdminMaxFiles,
    next.knowledgeUploadMemberMaxFiles,
    next.knowledgeUploadMaxFileBytes,
    tenantId,
  );
  return getQuota(tenantId);
}

export function createTeam(tenantId: string, name: string) {
  const team: TeamRow = { id: crypto.randomUUID(), tenantId, name, createdAt: now() };
  db.prepare(`
    INSERT INTO teams (id, tenant_id, name, created_at)
    VALUES (?, ?, ?, ?)
  `).run(team.id, team.tenantId, team.name, team.createdAt);
  return team;
}

export function listTeams(tenantId: string) {
  const rows = db.prepare(`
    SELECT t.id, t.tenant_id, t.name, t.created_at, COUNT(tm.user_email) AS member_count
    FROM teams t
    LEFT JOIN team_members tm ON tm.team_id = t.id
    WHERE t.tenant_id = ?
    GROUP BY t.id, t.tenant_id, t.name, t.created_at
    ORDER BY t.created_at ASC
  `).all(tenantId) as Array<{
    id: string;
    tenant_id: string;
    name: string;
    created_at: number;
    member_count: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    createdAt: row.created_at,
    memberCount: Number(row.member_count || 0),
  }));
}

export function listTeamMembers(tenantId: string, teamId: string) {
  const team = db.prepare('SELECT id FROM teams WHERE id = ? AND tenant_id = ?').get(teamId, tenantId);
  if (!team) return null;
  const rows = db.prepare(`
    SELECT tm.team_id, tm.user_email, tm.role, u.name
    FROM team_members tm
    JOIN users u ON u.email = tm.user_email
    WHERE tm.team_id = ?
    ORDER BY u.created_at ASC
  `).all(teamId) as Array<{
    team_id: string;
    user_email: string;
    role: string;
    name: string;
  }>;
  return rows.map((row) => ({
    teamId: row.team_id,
    userId: row.user_email,
    email: row.user_email,
    name: row.name,
    role: row.role,
  }));
}

export function addTeamMember(tenantId: string, teamId: string, userEmail: string, role: string) {
  const team = db.prepare('SELECT id FROM teams WHERE id = ? AND tenant_id = ?').get(teamId, tenantId);
  if (!team) return { ok: false as const, status: 404, error: 'not found' };
  const user = getUser(userEmail);
  if (!user || user.tenantId !== tenantId) return { ok: false as const, status: 404, error: '用户不存在' };
  const existing = db.prepare('SELECT 1 FROM team_members WHERE team_id = ? AND user_email = ?').get(teamId, userEmail);
  if (existing) return { ok: false as const, status: 409, error: '已存在' };
  db.prepare(`
    INSERT INTO team_members (team_id, user_email, role)
    VALUES (?, ?, ?)
  `).run(teamId, userEmail, role || 'member');
  return {
    ok: true as const,
    member: {
      teamId,
      userId: userEmail,
      email: userEmail,
      name: user.name,
      role: role || 'member',
    },
  };
}

export function removeTeamMember(tenantId: string, teamId: string, userEmail: string) {
  const team = db.prepare('SELECT id FROM teams WHERE id = ? AND tenant_id = ?').get(teamId, tenantId);
  if (!team) return false;
  const result = db.prepare('DELETE FROM team_members WHERE team_id = ? AND user_email = ?').run(teamId, userEmail);
  return result.changes > 0;
}

export function listAuditLogs(tenantId: string) {
  const rows = db.prepare(`
    SELECT id, tenant_id, action, actor, actor_type, resource, diff_json, created_at
    FROM audit_logs
    WHERE tenant_id = ?
    ORDER BY created_at DESC
    LIMIT 50
  `).all(tenantId);
  return rows.map(mapAudit);
}

export function listPermissionRules(tenantId: string) {
  const rows = db.prepare(`
    SELECT tenant_id, id, tool_name, rule_content, behavior, enabled, position, created_at, updated_at
    FROM permission_rules
    WHERE tenant_id = ?
    ORDER BY position ASC, updated_at DESC
  `).all(tenantId);
  return rows.map(mapPermissionRule);
}

export function replacePermissionRules(tenantId: string, rules: Array<Record<string, unknown>>) {
  const timestamp = now();
  const normalized = rules.flatMap((rule, index): PermissionRuleRow[] => {
    const toolName = String(rule?.toolName || '').trim();
    const behavior = String(rule?.behavior || '').trim();
    if (!toolName || (behavior !== 'allow' && behavior !== 'deny')) return [];
    return [{
      id: String(rule?.id || crypto.randomUUID()),
      tenantId,
      toolName,
      ruleContent: String(rule?.ruleContent || '').slice(0, 1000),
      behavior,
      enabled: rule?.enabled !== false,
      position: Number.isFinite(Number(rule?.position)) ? Number(rule.position) : index,
      createdAt: Number(rule?.createdAt) || timestamp,
      updatedAt: timestamp,
    }];
  });

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM permission_rules WHERE tenant_id = ?').run(tenantId);
    const insert = db.prepare(`
      INSERT INTO permission_rules (
        tenant_id, id, tool_name, rule_content, behavior, enabled, position, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    normalized.forEach((rule, index) => {
      insert.run(
        tenantId,
        rule.id,
        rule.toolName,
        rule.ruleContent,
        rule.behavior,
        rule.enabled ? 1 : 0,
        index,
        rule.createdAt,
        rule.updatedAt,
      );
    });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return listPermissionRules(tenantId);
}

function getBareToolName(toolName: string) {
  return toolName.startsWith('mcp__') ? (toolName.split('__').pop() || toolName) : toolName;
}

function permissionRuleMatches(rule: PermissionRuleRow, toolName: string, input: Record<string, unknown>) {
  const ruleTool = rule.toolName.trim();
  const bareName = getBareToolName(toolName);
  if (ruleTool !== '*' && ruleTool !== toolName && ruleTool !== bareName) return false;

  const ruleContent = rule.ruleContent.trim().toLowerCase();
  if (!ruleContent) return true;
  const inputText = JSON.stringify(input || {}).toLowerCase();
  return inputText.includes(ruleContent);
}

export function evaluatePermissionRules(tenantId: string, toolName: string, input: Record<string, unknown>): PermissionRuleDecision | null {
  const rule = listPermissionRules(tenantId).find((candidate) => (
    candidate.enabled && permissionRuleMatches(candidate, toolName, input)
  ));
  if (!rule) return null;
  const reason = rule.ruleContent
    ? `${rule.behavior} rule matched ${rule.toolName}:${rule.ruleContent}`
    : `${rule.behavior} rule matched ${rule.toolName}`;
  return { behavior: rule.behavior, rule, reason };
}

const HOOK_RULE_EVENTS = new Set<HookRuleEvent>(['PreToolUse', 'PostToolUse', 'Notification']);
const HOOK_RULE_ACTIONS = new Set<HookRuleAction>(['allow', 'block', 'context', 'log']);

export function listHookRules(tenantId: string) {
  const rows = db.prepare(`
    SELECT tenant_id, id, event_name, matcher, rule_content, action, message, enabled, position, created_at, updated_at
    FROM hook_rules
    WHERE tenant_id = ?
    ORDER BY position ASC, updated_at DESC
  `).all(tenantId);
  return rows.map(mapHookRule);
}

export function replaceHookRules(tenantId: string, rules: Array<Record<string, unknown>>) {
  const timestamp = now();
  const normalized = rules.flatMap((rule, index): HookRuleRow[] => {
    const eventName = String(rule?.eventName || '').trim() as HookRuleEvent;
    const action = String(rule?.action || '').trim() as HookRuleAction;
    if (!HOOK_RULE_EVENTS.has(eventName) || !HOOK_RULE_ACTIONS.has(action)) return [];
    return [{
      id: String(rule?.id || crypto.randomUUID()),
      tenantId,
      eventName,
      matcher: String(rule?.matcher || '').slice(0, 300),
      ruleContent: String(rule?.ruleContent || '').slice(0, 1000),
      action,
      message: String(rule?.message || '').slice(0, 1000),
      enabled: rule?.enabled !== false,
      position: Number.isFinite(Number(rule?.position)) ? Number(rule.position) : index,
      createdAt: Number(rule?.createdAt) || timestamp,
      updatedAt: timestamp,
    }];
  });

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM hook_rules WHERE tenant_id = ?').run(tenantId);
    const insert = db.prepare(`
      INSERT INTO hook_rules (
        tenant_id, id, event_name, matcher, rule_content, action, message, enabled, position, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    normalized.forEach((rule, index) => {
      insert.run(
        tenantId,
        rule.id,
        rule.eventName,
        rule.matcher,
        rule.ruleContent,
        rule.action,
        rule.message,
        rule.enabled ? 1 : 0,
        index,
        rule.createdAt,
        rule.updatedAt,
      );
    });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return listHookRules(tenantId);
}

function getHookMatcherValue(input: Record<string, unknown>) {
  const toolName = typeof input.tool_name === 'string' ? input.tool_name : '';
  const notificationType = typeof input.notification_type === 'string' ? input.notification_type : '';
  return toolName || notificationType;
}

function hookRuleMatches(rule: HookRuleRow, eventName: HookRuleEvent, input: Record<string, unknown>) {
  if (rule.eventName !== eventName) return false;

  const matcher = rule.matcher.trim().toLowerCase();
  if (matcher) {
    const matcherValue = getHookMatcherValue(input).toLowerCase();
    if (!matcherValue.includes(matcher)) return false;
  }

  const ruleContent = rule.ruleContent.trim().toLowerCase();
  if (!ruleContent) return true;
  return JSON.stringify(input || {}).toLowerCase().includes(ruleContent);
}

function buildHookRuleOutput(rule: HookRuleRow, reason: string): Record<string, unknown> {
  const additionalContext = rule.message || reason;
  if (rule.eventName === 'PreToolUse') {
    const hookSpecificOutput: Record<string, unknown> = { hookEventName: 'PreToolUse' };
    if (rule.action === 'allow') {
      hookSpecificOutput.permissionDecision = 'allow';
      hookSpecificOutput.permissionDecisionReason = reason;
    } else if (rule.action === 'block') {
      hookSpecificOutput.permissionDecision = 'deny';
      hookSpecificOutput.permissionDecisionReason = reason;
    } else if (rule.action === 'context') {
      hookSpecificOutput.additionalContext = additionalContext;
    }
    return {
      ...(rule.action === 'block' ? { decision: 'block', reason } : {}),
      hookSpecificOutput,
    };
  }

  if (rule.eventName === 'PostToolUse') {
    return {
      ...(rule.action === 'block' ? { decision: 'block', reason } : {}),
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext },
    };
  }

  return {
    ...(rule.action === 'block' ? { decision: 'block', reason } : {}),
    hookSpecificOutput: { hookEventName: 'Notification', additionalContext },
  };
}

export function evaluateHookRules(tenantId: string, eventName: HookRuleEvent, input: Record<string, unknown>): HookRuleDecision | null {
  const rule = listHookRules(tenantId).find((candidate) => (
    candidate.enabled && hookRuleMatches(candidate, eventName, input)
  ));
  if (!rule) return null;
  const detail = [rule.eventName, rule.matcher, rule.ruleContent].filter(Boolean).join(':');
  const reason = `${rule.action} hook rule matched ${detail}`;
  return {
    action: rule.action,
    rule,
    reason,
    output: buildHookRuleOutput(rule, reason),
  };
}

const KNOWLEDGE_ARCHIVE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function pruneArchivedKnowledgeSources(tenantId: string, timestamp = now()) {
  db.prepare(`
    UPDATE knowledge_sources
    SET deleted_at = ?, updated_at = ?
    WHERE tenant_id = ?
      AND deleted_at IS NULL
      AND archived_at IS NOT NULL
      AND archived_at <= ?
  `).run(timestamp, timestamp, tenantId, timestamp - KNOWLEDGE_ARCHIVE_RETENTION_MS);
}

export function listKnowledgeSources(tenantId: string, viewerSub?: string | null, viewerRole?: Role | null): KnowledgeSourceRow[] {
  pruneArchivedKnowledgeSources(tenantId);
  const canSeeAll = !viewerSub || viewerRole === 'tenant_admin';
  const rows = db.prepare(`
    SELECT id, tenant_id, name, path, read_only, enabled, created_by, published_at, archived_at, deleted_at, created_at, updated_at
    FROM knowledge_sources
    WHERE tenant_id = ?
      AND deleted_at IS NULL
      AND (
        ? = 1
        OR created_by = ?
        OR (published_at IS NOT NULL AND archived_at IS NULL)
      )
    ORDER BY CASE WHEN archived_at IS NULL THEN 0 ELSE 1 END ASC, updated_at DESC, name ASC
  `).all(tenantId, canSeeAll ? 1 : 0, viewerSub ?? '');
  return rows.map(mapKnowledgeSource);
}

export function replaceKnowledgeSources(
  tenantId: string,
  sources: Array<Partial<KnowledgeSourceRow> & Record<string, unknown>>,
  actorSub?: string | null,
  actorRole?: Role | null,
): KnowledgeSourceRow[] {
  const timestamp = now();
  const existingRows = new Map<string, {
    created_by: string | null;
    created_at: number;
    published_at: number | null;
    archived_at: number | null;
    deleted_at: number | null;
  }>(
    (db.prepare(`
      SELECT id, created_by, created_at, published_at, archived_at, deleted_at
      FROM knowledge_sources
      WHERE tenant_id = ?
    `).all(tenantId) as Array<{
      id: string;
      created_by: string | null;
      created_at: number;
      published_at: number | null;
      archived_at: number | null;
      deleted_at: number | null;
    }>).map((row) => [row.id, row]),
  );
  const normalized = sources.flatMap((source): KnowledgeSourceRow[] => {
    const sourcePath = String(source?.path || '').trim();
    const resolved = resolveKnowledgeDirectory(sourcePath);
    if (!resolved.ok) {
      throw new Error(`知识库路径无效: ${resolved.reason}`);
    }

    const rawName = String(source?.name || '').trim();
    const name = (rawName || path.basename(resolved.path) || '知识库').slice(0, 80);
    const id = String(source?.id || crypto.randomUUID());
    const existing = existingRows.get(id);
    if (existing && actorRole !== 'tenant_admin' && actorSub && existing.created_by !== actorSub) {
      throw new Error('只能修改自己创建的知识库');
    }
    // Existing rows keep their creator; brand-new rows are owned by the actor.
    const createdBy = existing
      ? existing.created_by ?? null
      : (typeof source?.createdBy === 'string' ? source.createdBy : null) ?? actorSub ?? null;
    const sourcePublishedAt = Number(source?.publishedAt) || null;
    const sourceArchivedAt = Number(source?.archivedAt) || null;
    const sourceDeletedAt = Number(source?.deletedAt) || null;
    const archivedAt = sourceDeletedAt
      ? (sourceArchivedAt || existing?.archived_at || timestamp)
      : sourceArchivedAt;
    const deletedAt = sourceDeletedAt || null;
    const publishedAt = archivedAt || deletedAt ? null : sourcePublishedAt;
    return [{
      id,
      tenantId,
      name,
      path: resolved.path,
      readOnly: source?.readOnly !== false,
      enabled: !archivedAt && !deletedAt && source?.enabled !== false,
      createdBy,
      publishedAt,
      archivedAt,
      deletedAt,
      createdAt: existing?.created_at || Number(source?.createdAt) || timestamp,
      updatedAt: timestamp,
    }];
  });

  db.exec('BEGIN');
  try {
    const seenIds = new Set(normalized.map((source) => source.id));
    const existingActiveIds = Array.from(existingRows.entries())
      .filter(([, row]) => row.deleted_at == null && (actorRole === 'tenant_admin' || row.created_by === actorSub))
      .map(([id]) => id);
    for (const id of existingActiveIds) {
      if (!seenIds.has(id)) {
        db.prepare(`
          UPDATE knowledge_sources
          SET deleted_at = ?, updated_at = ?
          WHERE tenant_id = ? AND id = ? AND deleted_at IS NULL
        `).run(timestamp, timestamp, tenantId, id);
      }
    }
    const insert = db.prepare(`
      INSERT INTO knowledge_sources (
        id, tenant_id, name, path, read_only, enabled, created_by, published_at, archived_at, deleted_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        tenant_id = excluded.tenant_id,
        name = excluded.name,
        path = excluded.path,
        read_only = excluded.read_only,
        enabled = excluded.enabled,
        created_by = knowledge_sources.created_by,
        published_at = excluded.published_at,
        archived_at = excluded.archived_at,
        deleted_at = excluded.deleted_at,
        created_at = knowledge_sources.created_at,
        updated_at = excluded.updated_at
    `);
    for (const source of normalized) {
      insert.run(
        source.id,
        tenantId,
        source.name,
        source.path,
        source.readOnly ? 1 : 0,
        source.enabled ? 1 : 0,
        source.createdBy,
        source.publishedAt,
        source.archivedAt,
        source.deletedAt,
        source.createdAt,
        source.updatedAt,
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return listKnowledgeSources(tenantId, actorSub, actorRole);
}

export function testKnowledgeSource(sourcePath: string): KnowledgeSourceTestResult {
  const resolved = resolveKnowledgeDirectory(sourcePath);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const result = collectKnowledgeFiles(resolved.path);
  return { ok: true, fileCount: result.fileCount, sampleFiles: result.sampleFiles };
}

export function scanKnowledgeSources(sourcePath?: string): { roots: string[]; candidates: KnowledgeSourceCandidate[] } {
  const roots = knowledgeAllowlistRoots();
  const inputPath = String(sourcePath || '').trim();
  if (!inputPath) {
    const candidates = roots.flatMap((root) => scanKnowledgeCandidateDirs(root, 5));
    const deduped = Array.from(new Map(candidates.map((candidate) => [candidate.path, candidate])).values());
    return { roots, candidates: deduped };
  }

  const resolved = resolveKnowledgeDirectory(inputPath);
  if (!resolved.ok) throw new Error(`本地导入路径无效: ${resolved.reason}`);
  const candidates = scanKnowledgeCandidateDirs(resolved.path, 6);
  const exact = knowledgeCandidateForDirectory(resolved.path, { allowRecursiveOnly: true });
  const withExact = exact ? [exact, ...candidates] : candidates;
  const deduped = Array.from(new Map(withExact.map((candidate) => [candidate.path, candidate])).values());
  return { roots, candidates: deduped };
}

export function listPublicSkills(): PublicSkillRow[] {
  const rows = db.prepare(`
    SELECT id, slug, name, description, author_sub, author_tenant_id, revision, bundle_path, published_at, updated_at
    FROM public_skills
    ORDER BY updated_at DESC, name ASC
  `).all();
  return rows.map(mapPublicSkill);
}

export function getPublicSkill(idOrSlug: string): PublicSkillRow | null {
  const key = String(idOrSlug || '').trim();
  if (!key) return null;
  const row = db.prepare(`
    SELECT id, slug, name, description, author_sub, author_tenant_id, revision, bundle_path, published_at, updated_at
    FROM public_skills
    WHERE id = ? OR slug = ?
    LIMIT 1
  `).get(key, key);
  return row ? mapPublicSkill(row) : null;
}

export function createPublicSkill(input: {
  id: string;
  slug: string;
  name: string;
  description: string;
  authorSub: string;
  authorTenantId: string;
  revision: number;
  bundlePath: string;
  publishedAt?: number;
  updatedAt?: number;
}): PublicSkillRow {
  const timestamp = now();
  const publishedAt = Number(input.publishedAt) || timestamp;
  const updatedAt = Number(input.updatedAt) || publishedAt;
  db.prepare(`
    INSERT INTO public_skills (
      id, slug, name, description, author_sub, author_tenant_id,
      revision, bundle_path, published_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.slug,
    input.name,
    input.description,
    input.authorSub,
    input.authorTenantId,
    input.revision,
    input.bundlePath,
    publishedAt,
    updatedAt,
  );
  return getPublicSkill(input.id)!;
}

export function updatePublicSkill(id: string, patch: {
  slug?: string;
  name?: string;
  description?: string;
  revision?: number;
  bundlePath?: string;
}): PublicSkillRow | null {
  const current = getPublicSkill(id);
  if (!current) return null;
  const updatedAt = now();
  db.prepare(`
    UPDATE public_skills
    SET slug = ?,
        name = ?,
        description = ?,
        revision = ?,
        bundle_path = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    patch.slug || current.slug,
    patch.name || current.name,
    patch.description || current.description,
    Number(patch.revision) || current.revision,
    patch.bundlePath || current.bundlePath,
    updatedAt,
    current.id,
  );
  return getPublicSkill(current.id);
}

export function recordLearnedSkill(input: {
  tenantId: string;
  ownerSub: string;
  skillName: string;
  skillPath: string;
  publicSkillId: string;
  publicRevision: number;
  learnedAt?: number;
}): LearnedSkillRow {
  const learnedAt = Number(input.learnedAt) || now();
  db.prepare(`
    INSERT INTO learned_skills (
      tenant_id, owner_sub, skill_name, skill_path, public_skill_id, public_revision, learned_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, owner_sub, skill_name) DO UPDATE SET
      skill_path = excluded.skill_path,
      public_skill_id = excluded.public_skill_id,
      public_revision = excluded.public_revision,
      learned_at = excluded.learned_at
  `).run(
    input.tenantId,
    input.ownerSub,
    input.skillName,
    input.skillPath,
    input.publicSkillId,
    input.publicRevision,
    learnedAt,
  );
  const row = db.prepare(`
    SELECT tenant_id, owner_sub, skill_name, skill_path, public_skill_id, public_revision, learned_at
    FROM learned_skills
    WHERE tenant_id = ? AND owner_sub = ? AND skill_name = ?
  `).get(input.tenantId, input.ownerSub, input.skillName);
  return mapLearnedSkill(row);
}

export function listLearnedSkills(tenantId: string, ownerSub: string): LearnedSkillRow[] {
  const rows = db.prepare(`
    SELECT tenant_id, owner_sub, skill_name, skill_path, public_skill_id, public_revision, learned_at
    FROM learned_skills
    WHERE tenant_id = ? AND owner_sub = ?
    ORDER BY learned_at DESC
  `).all(tenantId, ownerSub);
  return rows.map(mapLearnedSkill);
}

export function audit(tenantId: string, action: string, actor: string, actorType: string, resource: string, diff?: unknown) {
  db.prepare(`
    INSERT INTO audit_logs (id, tenant_id, action, actor, actor_type, resource, diff_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    tenantId,
    action,
    actor,
    actorType,
    resource,
    diff === undefined ? null : JSON.stringify(diff),
    now(),
  );
  db.prepare(`
    DELETE FROM audit_logs
    WHERE id IN (
      SELECT id FROM audit_logs
      ORDER BY created_at DESC
      LIMIT -1 OFFSET 1000
    )
  `).run();
}

const CHAT_SESSION_SELECT = `
  s.id, s.tenant_id, s.owner_sub, s.template_id, s.title, s.model,
  s.sdk_session_id, s.sdk_cwd, s.visual_preprocess_enabled, s.visual_preprocess_model, s.forked_from_session_id,
  parent.title AS forked_from_title,
  s.pinned, s.collaboration_enabled, s.collaboration_updated_at,
  s.created_at, s.updated_at
`;

type ChatSessionRow = {
  id: string;
  tenant_id: string;
  owner_sub: string;
  template_id: string;
  title: string;
  model: string;
  sdk_session_id?: string | null;
  sdk_cwd?: string | null;
  visual_preprocess_enabled?: number | null;
  visual_preprocess_model?: string | null;
  forked_from_session_id?: string | null;
  forked_from_title?: string | null;
  pinned: number;
  collaboration_enabled: number;
  collaboration_updated_at?: number | null;
  created_at: number;
  updated_at: number;
};

function getOwnedChatSessionRow(tenantId: string, ownerSub: string, sessionId: string) {
  return db.prepare(`
    SELECT ${CHAT_SESSION_SELECT}
    FROM chat_sessions s
    LEFT JOIN chat_sessions parent
      ON parent.id = s.forked_from_session_id
      AND parent.tenant_id = s.tenant_id
      AND parent.owner_sub = s.owner_sub
    WHERE s.tenant_id = ? AND s.owner_sub = ? AND s.id = ?
  `).get(tenantId, ownerSub, sessionId) as ChatSessionRow | undefined;
}

function getAccessibleChatSessionRow(tenantId: string, ownerSub: string, sessionId: string) {
  return db.prepare(`
    SELECT ${CHAT_SESSION_SELECT}
    FROM chat_sessions s
    LEFT JOIN chat_sessions parent
      ON parent.id = s.forked_from_session_id
      AND parent.tenant_id = s.tenant_id
      AND parent.owner_sub = s.owner_sub
    WHERE s.tenant_id = ?
      AND s.id = ?
      AND (
        s.owner_sub = ?
        OR (
          s.collaboration_enabled = 1
          AND EXISTS (
            SELECT 1 FROM chat_session_members m
            WHERE m.session_id = s.id
              AND m.tenant_id = s.tenant_id
              AND m.member_sub = ?
          )
        )
      )
  `).get(tenantId, sessionId, ownerSub, ownerSub) as ChatSessionRow | undefined;
}

function getEnabledSharedChatSessionRow(tenantId: string, sessionId: string) {
  return db.prepare(`
    SELECT ${CHAT_SESSION_SELECT}
    FROM chat_sessions s
    LEFT JOIN chat_sessions parent
      ON parent.id = s.forked_from_session_id
      AND parent.tenant_id = s.tenant_id
      AND parent.owner_sub = s.owner_sub
    WHERE s.tenant_id = ? AND s.id = ? AND s.collaboration_enabled = 1
  `).get(tenantId, sessionId) as ChatSessionRow | undefined;
}

function getAnyChatSessionRow(sessionId: string) {
  return db.prepare(`
    SELECT id, tenant_id, owner_sub
    FROM chat_sessions
    WHERE id = ?
  `).get(sessionId) as {
    id: string;
    tenant_id: string;
    owner_sub: string;
  } | undefined;
}

function listMessagesForSession(sessionId: string) {
  const rows = db.prepare(`
    SELECT message_id, role, content, attachments_json, status, thinking, outcome, outcome_detail, run_id, run_stats_json, timestamp
    FROM chat_messages
    WHERE session_id = ?
    ORDER BY seq ASC
  `).all(sessionId) as Array<{
    message_id?: string | null;
    role: ChatHistoryMessage['role'];
    content: string;
    attachments_json?: string | null;
    status?: string | null;
    thinking?: string | null;
    outcome?: string | null;
    outcome_detail?: string | null;
    run_id?: string | null;
    run_stats_json?: string | null;
    timestamp: number;
  }>;
  return rows.map((row) => {
    const attachments = parseChatAttachments(row.attachments_json);
    const status = normalizeChatMessageStatus(row.status);
    const outcome = normalizeMessageOutcome(row.outcome, status);
    const id = row.message_id || undefined;
    const thinking = row.thinking || undefined;
    const outcomeDetail = row.outcome_detail || undefined;
    const runId = row.run_id || undefined;
    const runStats = parseChatRunStats(row.run_stats_json);
    return {
      ...(id ? { id } : {}),
      role: row.role,
      content: row.content,
      ...(thinking ? { thinking } : {}),
      ...(status || outcome ? { status: status || outcomeToMessageStatus(outcome!) } : {}),
      ...(outcome ? { outcome } : {}),
      ...(outcomeDetail ? { outcomeDetail } : {}),
      ...(runId ? { runId } : {}),
      ...(runStats ? { runStats } : {}),
      ...(attachments.length ? { attachments } : {}),
      timestamp: row.timestamp,
    };
  });
}

export function listChatSessions(tenantId: string, ownerSub: string) {
  const rows = db.prepare(`
    SELECT ${CHAT_SESSION_SELECT}
    FROM chat_sessions s
    LEFT JOIN chat_sessions parent
      ON parent.id = s.forked_from_session_id
      AND parent.tenant_id = s.tenant_id
      AND parent.owner_sub = s.owner_sub
    WHERE s.tenant_id = ?
      AND (
        s.owner_sub = ?
        OR (
          s.collaboration_enabled = 1
          AND EXISTS (
            SELECT 1 FROM chat_session_members m
            WHERE m.session_id = s.id
              AND m.tenant_id = s.tenant_id
              AND m.member_sub = ?
          )
        )
      )
    ORDER BY s.pinned DESC, s.updated_at DESC
  `).all(tenantId, ownerSub, ownerSub);
  return rows.map((row: any) => mapChatSession(row, listMessagesForSession(row.id), ownerSub));
}

export function listChatSessionSummaries(tenantId: string, ownerSub: string) {
  const ownedRows = db.prepare(`
    SELECT ${CHAT_SESSION_SELECT},
      (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) AS message_count
    FROM chat_sessions s
    LEFT JOIN chat_sessions parent
      ON parent.id = s.forked_from_session_id
      AND parent.tenant_id = s.tenant_id
      AND parent.owner_sub = s.owner_sub
    WHERE s.tenant_id = ? AND s.owner_sub = ?
    ORDER BY s.pinned DESC, s.updated_at DESC
  `).all(tenantId, ownerSub);
  const joinedRows = db.prepare(`
    SELECT ${CHAT_SESSION_SELECT},
      (SELECT COUNT(*) FROM chat_messages cm WHERE cm.session_id = s.id) AS message_count
    FROM chat_session_members m
    JOIN chat_sessions s
      ON s.id = m.session_id
      AND s.tenant_id = m.tenant_id
    LEFT JOIN chat_sessions parent
      ON parent.id = s.forked_from_session_id
      AND parent.tenant_id = s.tenant_id
      AND parent.owner_sub = s.owner_sub
    WHERE m.tenant_id = ?
      AND m.member_sub = ?
      AND s.collaboration_enabled = 1
      AND s.owner_sub <> ?
    ORDER BY s.pinned DESC, s.updated_at DESC
  `).all(tenantId, ownerSub, ownerSub);
  const rows = [...ownedRows, ...joinedRows].sort((a: any, b: any) => {
    if (Number(a.pinned) !== Number(b.pinned)) return Number(b.pinned) - Number(a.pinned);
    return Number(b.updated_at || 0) - Number(a.updated_at || 0);
  });
  return rows.map((row: any) => mapChatSessionSummary(row, ownerSub));
}

export function getLatestAgentRuntimeSession(tenantId: string, ownerSub: string, templateId: string) {
  const row = db.prepare(`
    SELECT s.id, s.title, s.sdk_cwd, s.updated_at
    FROM chat_sessions s
    WHERE s.tenant_id = ?
      AND s.template_id = ?
      AND s.sdk_cwd IS NOT NULL
      AND s.sdk_cwd != ''
      AND (
        s.owner_sub = ?
        OR (
          s.collaboration_enabled = 1
          AND EXISTS (
            SELECT 1 FROM chat_session_members m
            WHERE m.session_id = s.id
              AND m.tenant_id = s.tenant_id
              AND m.member_sub = ?
          )
        )
      )
    ORDER BY s.updated_at DESC
    LIMIT 1
  `).get(tenantId, templateId, ownerSub, ownerSub) as {
    id: string;
    title: string;
    sdk_cwd: string;
    updated_at: number;
  } | undefined;

  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    sdkCwd: row.sdk_cwd,
    updatedAt: row.updated_at,
  };
}

export function getChatSession(tenantId: string, ownerSub: string, sessionId: string) {
  const row = getAccessibleChatSessionRow(tenantId, ownerSub, sessionId);
  if (!row) return null;
  return mapChatSession(row, listMessagesForSession(sessionId), ownerSub);
}

function mapVisualRow(row: {
  id: string;
  tenant_id: string;
  owner_sub: string;
  title: string | null;
  html: string;
  size_bytes: number;
  source_slug: string | null;
  created_at: number;
}): VisualRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ownerSub: row.owner_sub,
    title: row.title || undefined,
    html: row.html,
    sizeBytes: row.size_bytes,
    sourceSlug: row.source_slug || undefined,
    createdAt: row.created_at,
  };
}

export function createVisual(
  tenantId: string,
  ownerSub: string,
  input: { title?: string; html: string; sourceSlug?: string },
) {
  const html = String(input.html || '');
  const sizeBytes = Buffer.byteLength(html);
  if (sizeBytes > MAX_VISUAL_BYTES) {
    throw new Error(`visual html exceeds ${MAX_VISUAL_BYTES} bytes`);
  }
  const id = crypto.randomUUID();
  const createdAt = now();
  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : null;
  const sourceSlug = typeof input.sourceSlug === 'string' && input.sourceSlug.trim() ? input.sourceSlug.trim() : null;
  db.prepare(`
    INSERT INTO visuals (id, tenant_id, owner_sub, title, html, size_bytes, source_slug, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, tenantId, ownerSub, title, html, sizeBytes, sourceSlug, createdAt);
  return { id };
}

export function getVisual(tenantId: string, ownerSub: string, id: string) {
  const row = db.prepare(`
    SELECT id, tenant_id, owner_sub, title, html, size_bytes, source_slug, created_at
    FROM visuals
    WHERE tenant_id = ? AND owner_sub = ? AND id = ?
  `).get(tenantId, ownerSub, id) as {
    id: string;
    tenant_id: string;
    owner_sub: string;
    title: string | null;
    html: string;
    size_bytes: number;
    source_slug: string | null;
    created_at: number;
  } | undefined;
  return row ? mapVisualRow(row) : null;
}

export function listVisuals(tenantId: string, ownerSub: string): VisualListRow[] {
  const rows = db.prepare(`
    SELECT id, title, size_bytes, created_at
    FROM visuals
    WHERE tenant_id = ? AND owner_sub = ?
    ORDER BY created_at DESC
  `).all(tenantId, ownerSub) as Array<{
    id: string;
    title: string | null;
    size_bytes: number;
    created_at: number;
  }>;
  return rows.map((row) => ({
    id: row.id,
    title: row.title || undefined,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
  }));
}

export function deleteVisual(tenantId: string, ownerSub: string, id: string) {
  const result = db.prepare(`
    DELETE FROM visuals
    WHERE tenant_id = ? AND owner_sub = ? AND id = ?
  `).run(tenantId, ownerSub, id) as { changes?: number };
  return Number(result.changes || 0) > 0;
}

// ─── 数据源(ChatBI)──────────────────────────────────────────────────────────
export type DatasourceRow = {
  id: string;
  tenantId: string;
  name: string;
  path: string;
  originalFilename?: string;
  format: string;
  sizeBytes: number;
  tables: Array<{ name: string; rowCount: number; columns: Array<{ name: string; type: string }> }>;
  createdBy?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};

function mapDatasourceRow(row: Record<string, unknown>): DatasourceRow {
  let tables: DatasourceRow['tables'] = [];
  try {
    const parsed = JSON.parse(String(row.tables_json || '[]'));
    if (Array.isArray(parsed)) tables = parsed;
  } catch {}
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    name: String(row.name),
    path: String(row.path),
    originalFilename: row.original_filename ? String(row.original_filename) : undefined,
    format: String(row.format),
    sizeBytes: Number(row.size_bytes) || 0,
    tables,
    createdBy: row.created_by ? String(row.created_by) : undefined,
    enabled: row.enabled !== 0,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
}

export function createDatasource(
  tenantId: string,
  input: {
    name: string;
    path: string;
    originalFilename?: string;
    format: string;
    sizeBytes: number;
    tables: DatasourceRow['tables'];
    createdBy?: string;
  },
): DatasourceRow {
  const id = crypto.randomUUID();
  const timestamp = now();
  db.prepare(`
    INSERT INTO datasources (id, tenant_id, name, path, original_filename, format, size_bytes, tables_json, created_by, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    id,
    tenantId,
    String(input.name || '').slice(0, 80) || '数据源',
    input.path,
    input.originalFilename || null,
    input.format,
    input.sizeBytes,
    JSON.stringify(input.tables || []),
    input.createdBy || null,
    timestamp,
    timestamp,
  );
  return getDatasource(tenantId, id)!;
}

export function listDatasources(tenantId: string): DatasourceRow[] {
  const rows = db.prepare(`
    SELECT id, tenant_id, name, path, original_filename, format, size_bytes, tables_json, created_by, enabled, created_at, updated_at
    FROM datasources
    WHERE tenant_id = ?
    ORDER BY updated_at DESC, name ASC
  `).all(tenantId) as Array<Record<string, unknown>>;
  return rows.map(mapDatasourceRow);
}

export function getDatasource(tenantId: string, id: string): DatasourceRow | null {
  const row = db.prepare(`
    SELECT id, tenant_id, name, path, original_filename, format, size_bytes, tables_json, created_by, enabled, created_at, updated_at
    FROM datasources
    WHERE tenant_id = ? AND id = ?
  `).get(tenantId, id) as Record<string, unknown> | undefined;
  return row ? mapDatasourceRow(row) : null;
}

export function deleteDatasource(tenantId: string, id: string) {
  const result = db.prepare(`
    DELETE FROM datasources
    WHERE tenant_id = ? AND id = ?
  `).run(tenantId, id) as { changes?: number };
  return Number(result.changes || 0) > 0;
}

export function listProtectedSdkCwds() {
  const rows = db.prepare(`
    SELECT DISTINCT sdk_cwd
    FROM chat_sessions
    WHERE sdk_session_id IS NOT NULL
      AND sdk_session_id != ''
      AND sdk_cwd IS NOT NULL
      AND sdk_cwd != ''
  `).all() as Array<{ sdk_cwd: string }>;
  return rows.map((row) => row.sdk_cwd);
}

export function saveChatSession(
  tenantId: string,
  ownerSub: string,
  session: Partial<ChatHistorySession> & { id?: string; templateId?: string; messages?: unknown[] },
) {
  const existing = session.id ? getChatSession(tenantId, ownerSub, session.id) : null;
  if (session.id && !existing && getAnyChatSessionRow(session.id)) {
    return { ok: false as const, status: 404, error: 'not found' };
  }
  const id = String(session.id || crypto.randomUUID());
  const memberUpdatingSharedSession = existing?.collaborationRole === 'member';
  const messages = normalizeChatMessages(session.messages ?? existing?.messages ?? []);
  if (!session.templateId && !existing?.templateId) {
    return { ok: false as const, status: 400, error: '缺少 templateId' };
  }

  const firstContent = messages[0]?.content?.trim();
  const createdAt = Number(session.createdAt)
    || existing?.createdAt
    || now();
  const updatedAt = Number(session.updatedAt) || now();
  const title = memberUpdatingSharedSession
    ? existing.title
    : String(session.title || existing?.title || firstContent?.slice(0, 40) || '新对话');
  const model = memberUpdatingSharedSession
    ? existing.model
    : String(session.model || existing?.model || '');
  const sdkSessionId = String(session.sdkSessionId || existing?.sdkSessionId || '').trim();
  const sdkCwd = String(session.sdkCwd || existing?.sdkCwd || '').trim();
  const visualPreprocessEnabled = memberUpdatingSharedSession
    ? Boolean(existing.visualPreprocessEnabled)
    : (typeof session.visualPreprocessEnabled === 'boolean'
      ? session.visualPreprocessEnabled
      : Boolean(existing?.visualPreprocessEnabled));
  const visualPreprocessModel = memberUpdatingSharedSession
    ? String(existing.visualPreprocessModel || '').trim()
    : String(session.visualPreprocessModel || existing?.visualPreprocessModel || '').trim();
  const forkedFromSessionId = memberUpdatingSharedSession
    ? String(existing.forkedFromSessionId || '').trim()
    : String(session.forkedFromSessionId || existing?.forkedFromSessionId || '').trim();
  const pinned = memberUpdatingSharedSession
    ? Boolean(existing.pinned)
    : (typeof session.pinned === 'boolean' ? session.pinned : Boolean(existing?.pinned));
  const templateId = memberUpdatingSharedSession
    ? existing.templateId
    : String(session.templateId || existing?.templateId);

  db.exec('BEGIN');
  try {
    db.prepare(`
      INSERT INTO chat_sessions (
        id, tenant_id, owner_sub, template_id, title, model, sdk_session_id, sdk_cwd, visual_preprocess_enabled, visual_preprocess_model, forked_from_session_id, pinned, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        template_id = excluded.template_id,
        title = excluded.title,
        model = excluded.model,
        sdk_session_id = excluded.sdk_session_id,
        sdk_cwd = excluded.sdk_cwd,
        visual_preprocess_enabled = excluded.visual_preprocess_enabled,
        visual_preprocess_model = excluded.visual_preprocess_model,
        forked_from_session_id = excluded.forked_from_session_id,
        pinned = excluded.pinned,
        updated_at = excluded.updated_at
    `).run(id, tenantId, ownerSub, templateId, title, model, sdkSessionId || null, sdkCwd || null, visualPreprocessEnabled ? 1 : 0, visualPreprocessModel || null, forkedFromSessionId || null, pinned ? 1 : 0, createdAt, updatedAt);

    db.prepare('DELETE FROM chat_messages WHERE session_id = ?').run(id);
    if (messages.length > 0) {
      const insertMessage = db.prepare(`
        INSERT INTO chat_messages (session_id, seq, message_id, role, content, attachments_json, status, thinking, outcome, outcome_detail, run_id, run_stats_json, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      messages.forEach((message, index) => {
        const attachmentsJson = message.attachments?.length ? JSON.stringify(message.attachments) : null;
        const runStats = normalizeChatRunStats(message.runStats);
        const runStatsJson = runStats ? JSON.stringify(runStats) : null;
        insertMessage.run(
          id,
          index,
          message.id || null,
          message.role,
          message.content,
          attachmentsJson,
          message.status || null,
          message.thinking || null,
          message.outcome || null,
          message.outcomeDetail || null,
          message.runId || null,
          runStatsJson,
          Number(message.timestamp) || updatedAt + index,
        );
      });
    }

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return { ok: true as const, session: getChatSession(tenantId, ownerSub, id)! };
}

export function updateChatSession(
  tenantId: string,
  ownerSub: string,
  sessionId: string,
  patch: Partial<Pick<ChatHistorySession, 'title' | 'pinned' | 'templateId' | 'model' | 'sdkSessionId' | 'sdkCwd' | 'visualPreprocessEnabled' | 'visualPreprocessModel' | 'forkedFromSessionId'>>,
) {
  const currentRow = getOwnedChatSessionRow(tenantId, ownerSub, sessionId);
  if (!currentRow) return null;
  const current = mapChatSession(currentRow, listMessagesForSession(sessionId), ownerSub);
  const next = saveChatSession(tenantId, ownerSub, {
    ...current,
    id: sessionId,
    title: patch.title ?? current.title,
    pinned: typeof patch.pinned === 'boolean' ? patch.pinned : current.pinned,
    templateId: patch.templateId ?? current.templateId,
    model: patch.model ?? current.model,
    sdkSessionId: patch.sdkSessionId ?? current.sdkSessionId,
    sdkCwd: patch.sdkCwd ?? current.sdkCwd,
    visualPreprocessEnabled: typeof patch.visualPreprocessEnabled === 'boolean' ? patch.visualPreprocessEnabled : current.visualPreprocessEnabled,
    visualPreprocessModel: patch.visualPreprocessModel ?? current.visualPreprocessModel,
    forkedFromSessionId: patch.forkedFromSessionId ?? current.forkedFromSessionId,
    updatedAt: now(),
  });
  return next.ok ? next.session : null;
}

export function forkChatSession(tenantId: string, ownerSub: string, sessionId: string) {
  const current = getChatSession(tenantId, ownerSub, sessionId);
  if (!current) return null;
  const timestamp = now();
  const next = saveChatSession(tenantId, ownerSub, {
    id: crypto.randomUUID(),
    title: `${current.title || '新对话'} · 副本`,
    templateId: current.templateId,
    model: current.model,
    sdkSessionId: undefined,
    sdkCwd: undefined,
    visualPreprocessEnabled: current.visualPreprocessEnabled,
    visualPreprocessModel: current.visualPreprocessModel,
    forkedFromSessionId: current.id,
    pinned: false,
    messages: current.messages,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return next.ok ? next.session : null;
}

export function deleteChatSession(tenantId: string, ownerSub: string, sessionId: string) {
  const row = getOwnedChatSessionRow(tenantId, ownerSub, sessionId);
  if (!row) return false;
  const result = db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(sessionId);
  return result.changes > 0;
}

export function updateChatSessionCollaboration(tenantId: string, ownerSub: string, sessionId: string, enabled: boolean) {
  const row = getOwnedChatSessionRow(tenantId, ownerSub, sessionId);
  if (!row) return null;
  const updatedAt = now();
  db.exec('BEGIN');
  try {
    db.prepare(`
      UPDATE chat_sessions
      SET collaboration_enabled = ?, collaboration_updated_at = ?, updated_at = ?
      WHERE tenant_id = ? AND owner_sub = ? AND id = ?
    `).run(enabled ? 1 : 0, updatedAt, updatedAt, tenantId, ownerSub, sessionId);
    if (!enabled) {
      db.prepare('DELETE FROM chat_session_members WHERE session_id = ?').run(sessionId);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return getChatSession(tenantId, ownerSub, sessionId);
}

export function joinChatSession(tenantId: string, memberSub: string, sessionId: string) {
  const row = getEnabledSharedChatSessionRow(tenantId, sessionId);
  if (!row) return null;
  if (row.owner_sub === memberSub) {
    return mapChatSession(row, listMessagesForSession(sessionId), memberSub);
  }
  db.prepare(`
    INSERT INTO chat_session_members (session_id, tenant_id, member_sub, role, joined_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id, member_sub) DO UPDATE SET
      role = excluded.role,
      joined_at = excluded.joined_at
  `).run(sessionId, tenantId, memberSub, 'member', now());
  return getChatSession(tenantId, memberSub, sessionId);
}

export function canAccessChatSession(tenantId: string, ownerSub: string, sessionId: string) {
  return Boolean(getAccessibleChatSessionRow(tenantId, ownerSub, sessionId));
}

export function getTenantById(tenantId: string) {
  return getTenant(tenantId);
}

export function getDataLocation() {
  return { dataDir: DATA_DIR, dbPath: DB_PATH };
}

// ═══ Provider Profiles (tenant-shared) ═══
function parseProviderModelsJson(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return Array.from(new Set(parsed.flatMap((item) => {
      if (typeof item !== 'string') return [];
      const model = item.trim();
      return model && !model.includes('*') ? [model] : [];
    })));
  } catch {
    return [];
  }
}

function splitProviderModels(value: string): string[] {
  return Array.from(new Set(value
    .split(/[\s,，]+/)
    .map(model => model.trim())
    .filter(model => model && !model.includes('*'))));
}

function normalizeProviderModelContextWindows(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([model, tokens]) => {
    const name = model.trim();
    const numeric = Number(tokens);
    if (!name || name.includes('*') || !Number.isFinite(numeric) || numeric <= 0) return [];
    return [[name, Math.floor(numeric)] as const];
  }));
}

function parseProviderModelContextWindowsJson(value: unknown): Record<string, number> {
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    return normalizeProviderModelContextWindows(JSON.parse(value));
  } catch {
    return {};
  }
}

function normalizeProviderProfileInput(tenantId: string, input: Record<string, unknown>, fallbackIndex: number): ProviderProfileRow {
  const timestamp = now();
  const id = String(input.id || `provider-${timestamp}-${fallbackIndex}`).trim().slice(0, 96);
  const modelContextWindows = normalizeProviderModelContextWindows(input.modelContextWindows);
  const availableModels = [
    ...(Array.isArray(input.availableModels) ? input.availableModels : []),
    ...(typeof input.modelPatterns === 'string' ? splitProviderModels(input.modelPatterns) : []),
    ...(typeof input.ANTHROPIC_MODEL === 'string' ? [input.ANTHROPIC_MODEL] : []),
    ...Object.keys(modelContextWindows),
  ].flatMap((item) => {
    if (typeof item !== 'string') return [];
    const model = item.trim();
    return model && !model.includes('*') ? [model] : [];
  });

  return {
    tenantId,
    id: id || `provider-${timestamp}-${fallbackIndex}`,
    name: String(input.name || `供应商 ${fallbackIndex + 1}`).trim().slice(0, 80) || `供应商 ${fallbackIndex + 1}`,
    ANTHROPIC_AUTH_TOKEN: String(input.ANTHROPIC_AUTH_TOKEN || '').trim(),
    ANTHROPIC_BASE_URL: String(input.ANTHROPIC_BASE_URL || '').trim(),
    availableModels: Array.from(new Set(availableModels)),
    modelContextWindows,
    enabled: input.enabled !== false,
    isDefault: input.isDefault === true,
    createdAt: Number(input.createdAt) || timestamp,
    updatedAt: timestamp,
  };
}

function mapProviderProfile(row: any): ProviderProfileRow {
  return {
    tenantId: row.tenant_id,
    id: row.id,
    name: row.name,
    ANTHROPIC_AUTH_TOKEN: row.auth_token || '',
    ANTHROPIC_BASE_URL: row.base_url || '',
    availableModels: parseProviderModelsJson(row.available_models_json),
    modelContextWindows: parseProviderModelContextWindowsJson(row.model_context_windows_json),
    enabled: Boolean(row.enabled),
    isDefault: Boolean(row.is_default),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listProviderProfiles(tenantId: string): ProviderProfileRow[] {
  const rows = db.prepare(`
    SELECT tenant_id, id, name, auth_token, base_url, available_models_json, model_context_windows_json, enabled, is_default, created_at, updated_at
    FROM provider_profiles
    WHERE tenant_id = ?
    ORDER BY is_default DESC, updated_at DESC, name ASC
  `).all(tenantId);
  return rows.map(mapProviderProfile);
}

export function replaceProviderProfiles(tenantId: string, profiles: Array<Record<string, unknown>>): ProviderProfileRow[] {
  const normalized = profiles.flatMap((profile, index) => {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return [];
    const next = normalizeProviderProfileInput(tenantId, profile, index);
    return next.id && next.ANTHROPIC_BASE_URL ? [next] : [];
  });
  const defaultId = normalized.find(profile => profile.isDefault)?.id || normalized[0]?.id || '';
  const nextProfiles = normalized.map(profile => ({
    ...profile,
    isDefault: profile.id === defaultId,
  }));

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM provider_profiles WHERE tenant_id = ?').run(tenantId);
    const insert = db.prepare(`
      INSERT INTO provider_profiles (
        tenant_id, id, name, auth_token, base_url, available_models_json, model_context_windows_json, enabled, is_default, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const profile of nextProfiles) {
      insert.run(
        tenantId,
        profile.id,
        profile.name,
        profile.ANTHROPIC_AUTH_TOKEN,
        profile.ANTHROPIC_BASE_URL,
        JSON.stringify(profile.availableModels),
        JSON.stringify(profile.modelContextWindows || {}),
        profile.enabled ? 1 : 0,
        profile.isDefault ? 1 : 0,
        profile.createdAt,
        profile.updatedAt,
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  return listProviderProfiles(tenantId);
}

export function resolveProviderProfileForModel(tenantId: string, model: string): ProviderProfileRow | null {
  const profiles = listProviderProfiles(tenantId);
  if (!profiles.length) return null;
  const enabled = profiles.filter(profile => profile.enabled);
  const usable = enabled.length ? enabled : profiles;
  const normalizedModel = model.trim().toLowerCase();
  if (normalizedModel) {
    return usable.find(profile => (
      profile.availableModels.some(candidate => candidate.trim().toLowerCase() === normalizedModel)
    )) || null;
  }
  return usable.find(profile => profile.isDefault) || usable[0] || null;
}

// ═══ Internal Tool Settings (tenant-shared) ═══
function parseInternalToolSettingsJson(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function mapInternalToolSetting(row: any): InternalToolSettingRow {
  return {
    tenantId: row.tenant_id,
    toolId: row.tool_id,
    settings: parseInternalToolSettingsJson(row.settings_json),
    updatedAt: row.updated_at,
  };
}

export function listInternalToolSettings(tenantId: string): InternalToolSettingRow[] {
  const rows = db.prepare(`
    SELECT tenant_id, tool_id, settings_json, updated_at
    FROM internal_tool_settings
    WHERE tenant_id = ?
    ORDER BY tool_id ASC
  `).all(tenantId);
  return rows.map(mapInternalToolSetting);
}

export function getInternalToolSetting(tenantId: string, toolId: string): InternalToolSettingRow | null {
  const row = db.prepare(`
    SELECT tenant_id, tool_id, settings_json, updated_at
    FROM internal_tool_settings
    WHERE tenant_id = ? AND tool_id = ?
  `).get(tenantId, toolId);
  return row ? mapInternalToolSetting(row) : null;
}

export function updateInternalToolSetting(
  tenantId: string,
  toolId: string,
  settings: Record<string, unknown>,
): InternalToolSettingRow {
  const timestamp = now();
  db.prepare(`
    INSERT INTO internal_tool_settings (tenant_id, tool_id, settings_json, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(tenant_id, tool_id) DO UPDATE SET
      settings_json = excluded.settings_json,
      updated_at = excluded.updated_at
  `).run(tenantId, toolId, JSON.stringify(settings), timestamp);
  const saved = getInternalToolSetting(tenantId, toolId);
  if (!saved) throw new Error('failed to save internal tool settings');
  return saved;
}

// ═══ Agent Templates (personal + published per tenant) ═══
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_templates (
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    id TEXT NOT NULL,
    data_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_agent_templates_tenant ON agent_templates (tenant_id, updated_at DESC);
`);

function parseAgentTemplateJson(dataJson: string) {
  try {
    const parsed = JSON.parse(dataJson);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function isDeletedAgentTemplate(template: Record<string, unknown>) {
  return Boolean(Number(template.deletedAt));
}

function isPublishedAgentTemplate(template: Record<string, unknown>) {
  return Boolean(Number(template.publishedAt)) && !Number(template.archivedAt) && !isDeletedAgentTemplate(template);
}

function agentTemplateCreatedBy(template: Record<string, unknown>) {
  return typeof template.createdBy === 'string' ? template.createdBy : '';
}

function canManageAgentTemplate(template: Record<string, unknown>, actorSub?: string | null, actorRole?: Role | null) {
  if (!actorSub || actorRole === 'tenant_admin') return true;
  return agentTemplateCreatedBy(template) === actorSub;
}

function canSeeAgentTemplate(template: Record<string, unknown>, actorSub?: string | null, actorRole?: Role | null) {
  if (isDeletedAgentTemplate(template)) return false;
  if (!actorSub || actorRole === 'tenant_admin') return true;
  return agentTemplateCreatedBy(template) === actorSub || isPublishedAgentTemplate(template);
}

function normalizeStoredAgentTemplate(
  tenantId: string,
  template: Record<string, unknown>,
  actorSub: string | null | undefined,
  existing: Record<string, unknown> | null,
  timestamp: number,
) {
  const id = String(template.id || existing?.id || crypto.randomUUID());
  const createdAt = Number(existing?.createdAt) || Number(template.createdAt) || timestamp;
  const updatedAt = Number(template.updatedAt) || timestamp;
  const archivedAt = Number(template.archivedAt) || null;
  const deletedAt = Number(template.deletedAt) || null;
  const publishedAt = archivedAt || deletedAt ? null : Number(template.publishedAt) || null;
  const existingCreatedBy = typeof existing?.createdBy === 'string' && existing.createdBy.trim()
    ? existing.createdBy
    : null;
  const createdBy = existing
    ? existingCreatedBy ?? actorSub ?? null
    : actorSub ?? (typeof template.createdBy === 'string' ? template.createdBy : null);
  return {
    ...template,
    id,
    tenantId,
    createdBy,
    publishedAt,
    archivedAt,
    deletedAt,
    createdAt,
    updatedAt,
  };
}

export function listAgentTemplates(tenantId: string, viewerSub?: string | null, viewerRole?: Role | null) {
  const rows = db.prepare(`
    SELECT data_json FROM agent_templates WHERE tenant_id = ? ORDER BY updated_at DESC
  `).all(tenantId) as Array<{ data_json: string }>;
  return rows
    .map((r) => parseAgentTemplateJson(r.data_json))
    .filter((t): t is Record<string, unknown> => Boolean(t && canSeeAgentTemplate(t, viewerSub, viewerRole)));
}

export function replaceAgentTemplates(
  tenantId: string,
  templates: Array<Record<string, unknown>>,
  actorSub?: string | null,
  actorRole?: Role | null,
) {
  const timestamp = now();
  const existingRows = db.prepare(`
    SELECT id, data_json FROM agent_templates WHERE tenant_id = ?
  `).all(tenantId) as Array<{ id: string; data_json: string }>;
  const existing = new Map<string, Record<string, unknown>>();
  for (const row of existingRows) {
    const parsed = parseAgentTemplateJson(row.data_json);
    if (parsed) existing.set(row.id, { ...parsed, id: String(parsed.id || row.id) });
  }
  const incoming = new Map<string, Record<string, unknown>>();
  for (const raw of templates) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const id = String(raw.id || crypto.randomUUID());
    const previous = existing.get(id) || null;
    if (previous && !canManageAgentTemplate(previous, actorSub, actorRole)) continue;
    incoming.set(id, normalizeStoredAgentTemplate(tenantId, { ...raw, id }, actorSub, previous, timestamp));
  }
  const merged = new Map<string, Record<string, unknown>>();
  for (const [id, previous] of existing.entries()) {
    if (incoming.has(id)) {
      merged.set(id, incoming.get(id)!);
      continue;
    }
    if (!canManageAgentTemplate(previous, actorSub, actorRole)) {
      merged.set(id, previous);
    }
  }
  for (const [id, template] of incoming.entries()) {
    merged.set(id, template);
  }

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM agent_templates WHERE tenant_id = ?').run(tenantId);
    const insert = db.prepare('INSERT INTO agent_templates (tenant_id, id, data_json, updated_at) VALUES (?, ?, ?, ?)');
    for (const [id, template] of merged.entries()) {
      const updatedAt = Number(template.updatedAt) || timestamp;
      insert.run(tenantId, id, JSON.stringify(template), updatedAt);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return listAgentTemplates(tenantId, actorSub, actorRole);
}

// ═══ Agent Runs (real SDK execution metering) ═══
export function recordAgentRun(tenantId: string, info: { sub: string; model: string; durationMs: number; inputTokens: number; outputTokens: number; costUsd?: number; status: RunOutcome }) {
  ensureQuotaForTenant(tenantId);
  const seconds = Math.max(0, Math.round(info.durationMs / 1000));
  db.prepare('UPDATE quotas SET weekly_run_count_used = weekly_run_count_used + 1, monthly_active_seconds_used = monthly_active_seconds_used + ? WHERE tenant_id = ?').run(seconds, tenantId);
  audit(tenantId, 'agent_run', info.sub, 'user', `run:${info.model}`, {
    model: info.model,
    durationMs: info.durationMs,
    inputTokens: info.inputTokens,
    outputTokens: info.outputTokens,
    costUsd: info.costUsd,
    status: info.status,
  });
}
