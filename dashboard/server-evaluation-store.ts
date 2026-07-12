/* eslint-disable @typescript-eslint/no-explicit-any -- SQLite row adapters normalize untyped driver records at this boundary. */
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type EvaluationType = 'qa' | 'code_repair';
export type EvaluationRunStatus =
  | 'draft'
  | 'queued'
  | 'running'
  | 'judging'
  | 'awaiting_review'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'archived';
export type EvaluationCandidateSource = 'online' | 'offline';
export type EvaluationReviewPolicy = 'single' | 'consensus';
export type EvaluationEvidenceDecision = 'approve' | 'reject' | 'needs_attention';
export type EvaluationJobKind = 'execute' | 'judge';
export type EvaluationJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type EvaluationAssertion = {
  type: 'exact' | 'required_keyword' | 'forbidden_keyword' | 'regex' | 'json';
  value?: string;
  values?: string[];
  flags?: string;
  path?: string;
  expected?: unknown;
  weight?: number;
  required?: boolean;
};

export type EvaluationCase = {
  id: string;
  tenantId: string;
  datasetVersionId: string;
  externalId: string;
  prompt: string;
  expectedAnswer: string;
  referenceMaterial: string;
  assertions: EvaluationAssertion[];
  metadata: Record<string, unknown>;
  position: number;
};

export type EvaluationProject = {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  type: EvaluationType;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
};

export type EvaluationDataset = {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  type: EvaluationType;
  latestVersion: number;
  latestVersionId: string | null;
  caseCount: number;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};

export type EvaluationDatasetVersion = {
  id: string;
  tenantId: string;
  datasetId: string;
  version: number;
  source: 'manual' | 'json' | 'jsonl' | 'csv';
  fieldMapping: Record<string, string>;
  checksum: string;
  caseCount: number;
  createdBy: string;
  createdAt: number;
  cases?: EvaluationCase[];
};

export type EvaluationMetricDefinition = {
  key: string;
  label: string;
  weight: number;
  enabled: boolean;
  required?: boolean;
};

export type EvaluationRubric = {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  type: EvaluationType;
  metrics: EvaluationMetricDefinition[];
  passThreshold: number;
  autoWeight: number;
  judgeWeight: number;
  judgeModel: string;
  judgePrompt: string;
  builtin: boolean;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
};

export type EvaluationCandidate = {
  id: string;
  tenantId: string;
  runId: string;
  name: string;
  alias: string;
  source: EvaluationCandidateSource;
  agentId: string;
  model: string;
  repeatCount: number;
  snapshot: Record<string, unknown>;
  offlineAnswers: Record<string, string>;
  position: number;
};

export type EvaluationRun = {
  id: string;
  tenantId: string;
  projectId: string;
  datasetVersionId: string;
  rubricId: string;
  name: string;
  type: EvaluationType;
  status: EvaluationRunStatus;
  useMemory: boolean;
  concurrency: number;
  tenantConcurrencyLimit: number;
  reviewPolicy: EvaluationReviewPolicy;
  reviewRequiredCount: number;
  reviewDecision: 'approved' | 'rejected' | null;
  reviewConflict: boolean;
  rubricSnapshot: EvaluationRubric;
  budget: Record<string, unknown>;
  createdBy: string;
  creatorRole: string;
  quotaUserId: string | null;
  errorCode: string;
  errorMessage: string;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  candidates?: EvaluationCandidate[];
  progress?: EvaluationRunProgress;
};

export type EvaluationRunProgress = {
  total: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  executeTotal: number;
  judgeTotal: number;
};

export type EvaluationAttempt = {
  id: string;
  tenantId: string;
  runId: string;
  jobId: string;
  candidateId: string;
  caseId: string;
  repetition: number;
  status: 'completed' | 'failed';
  outputText: string;
  metrics: Array<Record<string, unknown>>;
  autoScore: number | null;
  judgeScore: number | null;
  judgeReason: string;
  judgeConfidence: number | null;
  finalScore: number | null;
  passed: boolean | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  errorCode: string;
  errorMessage: string;
  createdAt: number;
  completedAt: number;
};

export type EvaluationReviewAssignment = {
  runId: string;
  reviewerSub: string;
  status: 'pending' | 'submitted';
  assignedAt: number;
  submittedAt: number | null;
};

export type EvaluationReview = {
  id: string;
  tenantId: string;
  runId: string;
  reviewerSub: string;
  decision: 'approve' | 'reject';
  comment: string;
  createdAt: number;
};

export type EvaluationEvidenceReview = {
  id: string;
  tenantId: string;
  runId: string;
  candidateId: string;
  caseId: string;
  attemptId: string | null;
  reviewerSub: string;
  decision: EvaluationEvidenceDecision;
  comment: string;
  createdAt: number;
};

export type EvaluationJob = {
  id: string;
  tenantId: string;
  runId: string;
  kind: EvaluationJobKind;
  candidateId: string;
  caseId: string;
  attemptId: string | null;
  repetition: number;
  status: EvaluationJobStatus;
  attempts: number;
  leaseOwner: string | null;
  leaseUntil: number | null;
  errorCode: string;
  errorMessage: string;
  createdAt: number;
  updatedAt: number;
};

export type EvaluationJobContext = {
  job: EvaluationJob;
  run: EvaluationRun;
  candidate: EvaluationCandidate;
  evaluationCase: EvaluationCase;
  attempt: EvaluationAttempt | null;
};

export class EvaluationStoreError extends Error {
  constructor(
    public readonly code: 'invalid_input' | 'invalid_concurrency' | 'not_found' | 'invalid_state' | 'forbidden' | 'conflict' | 'project_has_active_runs',
    message: string,
  ) {
    super(message);
    this.name = 'EvaluationStoreError';
  }
}

let db: DatabaseSync | null = null;

function database() {
  if (!db) throw new Error('evaluation store is not initialized');
  return db;
}

function now() {
  return Date.now();
}

function cleanText(value: unknown, label: string, maxLength: number, required = true) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (required && !text) throw new EvaluationStoreError('invalid_input', `${label}不能为空`);
  if (text.length > maxLength) throw new EvaluationStoreError('invalid_input', `${label}不能超过 ${maxLength} 个字符`);
  return text;
}

function requireType(value: unknown): EvaluationType {
  if (value === 'qa' || value === 'code_repair') return value;
  throw new EvaluationStoreError('invalid_input', '评测类型必须是 qa 或 code_repair');
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function serializeJson(value: unknown, label: string) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    throw new EvaluationStoreError('invalid_input', `${label}不是有效 JSON: ${(error as Error).message}`);
  }
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number) {
  return Math.floor(boundedNumber(value, fallback, min, max));
}

const DEFAULT_EVALUATION_PLATFORM_CONCURRENCY = Math.max(
  1,
  Math.min(16, Math.floor(Number(process.env.AGENTMA_EVALUATION_CONCURRENCY) || 4)),
);

function normalizeRunConcurrency(input: Record<string, unknown>, candidateCount: number) {
  const platformLimit = boundedInteger(
    input.platformConcurrencyLimit,
    DEFAULT_EVALUATION_PLATFORM_CONCURRENCY,
    1,
    16,
  );
  const tenantLimit = boundedInteger(input.tenantConcurrencyLimit, platformLimit, 1, platformLimit);
  const maximum = Math.max(1, Math.min(10, platformLimit, tenantLimit));
  if (input.concurrency === undefined || input.concurrency === null || input.concurrency === '') {
    return { concurrency: Math.max(1, Math.min(candidateCount, maximum)), tenantConcurrencyLimit: tenantLimit };
  }
  const requested = Number(input.concurrency);
  if (!Number.isInteger(requested) || requested < 1 || requested > maximum) {
    throw new EvaluationStoreError('invalid_concurrency', `并发数必须是 1–${maximum} 的整数`);
  }
  return { concurrency: requested, tenantConcurrencyLimit: tenantLimit };
}

function normalizeAssertions(value: unknown): EvaluationAssertion[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<EvaluationAssertion['type']>(['exact', 'required_keyword', 'forbidden_keyword', 'regex', 'json']);
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const raw = item as Record<string, unknown>;
    if (!allowed.has(raw.type as EvaluationAssertion['type'])) return [];
    return [{
      type: raw.type as EvaluationAssertion['type'],
      ...(typeof raw.value === 'string' ? { value: raw.value.slice(0, 10_000) } : {}),
      ...(Array.isArray(raw.values) ? { values: raw.values.filter((entry): entry is string => typeof entry === 'string').slice(0, 100) } : {}),
      ...(typeof raw.flags === 'string' ? { flags: raw.flags.replace(/[^gimsuy]/g, '') } : {}),
      ...(typeof raw.path === 'string' ? { path: raw.path.slice(0, 500) } : {}),
      ...('expected' in raw ? { expected: raw.expected } : {}),
      weight: boundedNumber(raw.weight, 1, 0, 100),
      required: raw.required === true,
    }];
  });
}

function normalizeMetrics(value: unknown, type: EvaluationType): EvaluationMetricDefinition[] {
  if (!Array.isArray(value)) return defaultMetrics(type);
  const metrics = value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const raw = item as Record<string, unknown>;
    const key = cleanText(raw.key, '指标 key', 80, false).replace(/[^A-Za-z0-9._-]/g, '_');
    const label = cleanText(raw.label, '指标名称', 120, false);
    if (!key || !label) return [];
    return [{ key, label, weight: boundedNumber(raw.weight, 1, 0, 100), enabled: raw.enabled !== false, required: raw.required === true }];
  });
  return metrics.length ? metrics.slice(0, 30) : defaultMetrics(type);
}

function defaultMetrics(type: EvaluationType): EvaluationMetricDefinition[] {
  if (type === 'code_repair') {
    return [
      { key: 'build', label: '构建通过', weight: 20, enabled: true, required: true },
      { key: 'tests', label: '测试通过', weight: 50, enabled: true, required: true },
      { key: 'static_analysis', label: '静态检查', weight: 15, enabled: true },
      { key: 'patch_quality', label: '补丁质量', weight: 15, enabled: true },
    ];
  }
  return [
    { key: 'exact', label: '标准答案匹配', weight: 35, enabled: true },
    { key: 'required_keyword', label: '必含关键词', weight: 25, enabled: true },
    { key: 'forbidden_keyword', label: '禁用关键词', weight: 15, enabled: true },
    { key: 'regex', label: '格式与正则', weight: 15, enabled: true },
    { key: 'json', label: '结构化断言', weight: 10, enabled: true },
  ];
}

function mapProject(row: any): EvaluationProject {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description || '',
    type: row.type,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? null,
  };
}

function mapCase(row: any): EvaluationCase {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    datasetVersionId: row.dataset_version_id,
    externalId: row.external_id,
    prompt: row.prompt,
    expectedAnswer: row.expected_answer || '',
    referenceMaterial: row.reference_material || '',
    assertions: parseJson(row.assertions_json, []),
    metadata: parseJson(row.metadata_json, {}),
    position: row.position,
  };
}

function mapDataset(row: any): EvaluationDataset {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description || '',
    type: row.type,
    latestVersion: Number(row.latest_version || 0),
    latestVersionId: row.latest_version_id || null,
    caseCount: Number(row.case_count || 0),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapVersion(row: any, includeCases = false): EvaluationDatasetVersion {
  const version: EvaluationDatasetVersion = {
    id: row.id,
    tenantId: row.tenant_id,
    datasetId: row.dataset_id,
    version: row.version,
    source: row.source,
    fieldMapping: parseJson(row.field_mapping_json, {}),
    checksum: row.checksum,
    caseCount: row.case_count,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
  if (includeCases) version.cases = listEvaluationCases(version.tenantId, version.id);
  return version;
}

function mapRubric(row: any): EvaluationRubric {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    description: row.description || '',
    type: row.type,
    metrics: parseJson(row.metrics_json, defaultMetrics(row.type)),
    passThreshold: row.pass_threshold,
    autoWeight: row.auto_weight,
    judgeWeight: row.judge_weight,
    judgeModel: row.judge_model || '',
    judgePrompt: row.judge_prompt || '',
    builtin: Boolean(row.builtin),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCandidate(row: any): EvaluationCandidate {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    runId: row.run_id,
    name: row.name,
    alias: row.alias || '',
    source: row.source,
    agentId: row.agent_id || '',
    model: row.model || '',
    repeatCount: row.repeat_count,
    snapshot: parseJson(row.snapshot_json, {}),
    offlineAnswers: parseJson(row.offline_answers_json, {}),
    position: row.position,
  };
}

function mapRun(row: any, includeRelations = false): EvaluationRun {
  const run: EvaluationRun = {
    id: row.id,
    tenantId: row.tenant_id,
    projectId: row.project_id,
    datasetVersionId: row.dataset_version_id,
    rubricId: row.rubric_id,
    name: row.name,
    type: row.type,
    status: row.status,
    useMemory: Boolean(row.use_memory),
    concurrency: Number(row.concurrency || 1),
    tenantConcurrencyLimit: Number(row.tenant_concurrency_limit || row.concurrency || 1),
    reviewPolicy: row.review_policy,
    reviewRequiredCount: row.review_required_count,
    reviewDecision: row.review_decision || null,
    reviewConflict: Boolean(row.review_conflict),
    rubricSnapshot: parseJson(row.rubric_snapshot_json, {} as EvaluationRubric),
    budget: parseJson(row.budget_json, {}),
    createdBy: row.created_by,
    creatorRole: row.creator_role || '',
    quotaUserId: row.quota_user_id || null,
    errorCode: row.error_code || '',
    errorMessage: row.error_message || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
  };
  if (includeRelations) {
    run.candidates = listEvaluationCandidates(run.tenantId, run.id);
    run.progress = getEvaluationRunProgress(run.tenantId, run.id);
  }
  return run;
}

function mapAttempt(row: any): EvaluationAttempt {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    runId: row.run_id,
    jobId: row.job_id,
    candidateId: row.candidate_id,
    caseId: row.case_id,
    repetition: row.repetition,
    status: row.status,
    outputText: row.output_text || '',
    metrics: parseJson(row.metrics_json, []),
    autoScore: row.auto_score == null ? null : Number(row.auto_score),
    judgeScore: row.judge_score == null ? null : Number(row.judge_score),
    judgeReason: row.judge_reason || '',
    judgeConfidence: row.judge_confidence == null ? null : Number(row.judge_confidence),
    finalScore: row.final_score == null ? null : Number(row.final_score),
    passed: row.passed == null ? null : Boolean(row.passed),
    inputTokens: row.input_tokens || 0,
    outputTokens: row.output_tokens || 0,
    costUsd: Number(row.cost_usd || 0),
    durationMs: row.duration_ms || 0,
    errorCode: row.error_code || '',
    errorMessage: row.error_message || '',
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function mapJob(row: any): EvaluationJob {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    runId: row.run_id,
    kind: row.kind,
    candidateId: row.candidate_id,
    caseId: row.case_id,
    attemptId: row.attempt_id || null,
    repetition: row.repetition,
    status: row.status,
    attempts: row.attempts,
    leaseOwner: row.lease_owner || null,
    leaseUntil: row.lease_until ?? null,
    errorCode: row.error_code || '',
    errorMessage: row.error_message || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function initializeEvaluationStore(databaseConnection: DatabaseSync) {
  db = databaseConnection;
  db.exec(`
    CREATE TABLE IF NOT EXISTS evaluation_projects (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_evaluation_projects_tenant ON evaluation_projects (tenant_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS evaluation_datasets (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL,
      latest_version INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evaluation_datasets_tenant ON evaluation_datasets (tenant_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS evaluation_dataset_versions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      dataset_id TEXT NOT NULL REFERENCES evaluation_datasets(id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      source TEXT NOT NULL,
      field_mapping_json TEXT NOT NULL DEFAULT '{}',
      checksum TEXT NOT NULL,
      case_count INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (tenant_id, dataset_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_evaluation_dataset_versions_dataset ON evaluation_dataset_versions (tenant_id, dataset_id, version DESC);

    CREATE TABLE IF NOT EXISTS evaluation_cases (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      dataset_version_id TEXT NOT NULL REFERENCES evaluation_dataset_versions(id) ON DELETE CASCADE,
      external_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      expected_answer TEXT NOT NULL DEFAULT '',
      reference_material TEXT NOT NULL DEFAULT '',
      assertions_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      position INTEGER NOT NULL,
      UNIQUE (tenant_id, dataset_version_id, external_id)
    );
    CREATE INDEX IF NOT EXISTS idx_evaluation_cases_version ON evaluation_cases (tenant_id, dataset_version_id, position ASC);

    CREATE TABLE IF NOT EXISTS evaluation_rubrics (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL,
      metrics_json TEXT NOT NULL,
      pass_threshold REAL NOT NULL,
      auto_weight REAL NOT NULL,
      judge_weight REAL NOT NULL,
      judge_model TEXT NOT NULL DEFAULT '',
      judge_prompt TEXT NOT NULL DEFAULT '',
      builtin INTEGER NOT NULL DEFAULT 0,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evaluation_rubrics_tenant ON evaluation_rubrics (tenant_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS evaluation_runs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES evaluation_projects(id),
      dataset_version_id TEXT NOT NULL REFERENCES evaluation_dataset_versions(id),
      rubric_id TEXT NOT NULL REFERENCES evaluation_rubrics(id),
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      use_memory INTEGER NOT NULL DEFAULT 0,
      concurrency INTEGER NOT NULL DEFAULT 1,
      tenant_concurrency_limit INTEGER NOT NULL DEFAULT 1,
      review_policy TEXT NOT NULL,
      review_required_count INTEGER NOT NULL,
      review_decision TEXT,
      review_conflict INTEGER NOT NULL DEFAULT 0,
      rubric_snapshot_json TEXT NOT NULL,
      budget_json TEXT NOT NULL DEFAULT '{}',
      created_by TEXT NOT NULL,
      creator_role TEXT NOT NULL DEFAULT '',
      quota_user_id TEXT,
      error_code TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_evaluation_runs_tenant ON evaluation_runs (tenant_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_evaluation_runs_status ON evaluation_runs (tenant_id, status, updated_at DESC);

    CREATE TABLE IF NOT EXISTS evaluation_candidates (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES evaluation_runs(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      alias TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      repeat_count INTEGER NOT NULL DEFAULT 1,
      snapshot_json TEXT NOT NULL DEFAULT '{}',
      offline_answers_json TEXT NOT NULL DEFAULT '{}',
      position INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evaluation_candidates_run ON evaluation_candidates (tenant_id, run_id, position ASC);

    CREATE TABLE IF NOT EXISTS evaluation_jobs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES evaluation_runs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      candidate_id TEXT NOT NULL REFERENCES evaluation_candidates(id) ON DELETE CASCADE,
      case_id TEXT NOT NULL REFERENCES evaluation_cases(id) ON DELETE CASCADE,
      attempt_id TEXT,
      repetition INTEGER NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT,
      lease_until INTEGER,
      error_code TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evaluation_jobs_claim ON evaluation_jobs (status, kind, lease_until, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_evaluation_jobs_run ON evaluation_jobs (tenant_id, run_id, status, kind);

    CREATE TABLE IF NOT EXISTS evaluation_attempts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES evaluation_runs(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL REFERENCES evaluation_jobs(id),
      candidate_id TEXT NOT NULL REFERENCES evaluation_candidates(id),
      case_id TEXT NOT NULL REFERENCES evaluation_cases(id),
      repetition INTEGER NOT NULL,
      status TEXT NOT NULL,
      output_text TEXT NOT NULL DEFAULT '',
      metrics_json TEXT NOT NULL DEFAULT '[]',
      auto_score REAL,
      judge_score REAL,
      judge_reason TEXT NOT NULL DEFAULT '',
      judge_confidence REAL,
      final_score REAL,
      passed INTEGER,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      error_code TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      completed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evaluation_attempts_run ON evaluation_attempts (tenant_id, run_id, candidate_id, case_id);

    CREATE TABLE IF NOT EXISTS evaluation_review_assignments (
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES evaluation_runs(id) ON DELETE CASCADE,
      reviewer_sub TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      assigned_at INTEGER NOT NULL,
      submitted_at INTEGER,
      PRIMARY KEY (tenant_id, run_id, reviewer_sub)
    );
    CREATE INDEX IF NOT EXISTS idx_evaluation_review_assignments_reviewer ON evaluation_review_assignments (tenant_id, reviewer_sub, status, assigned_at DESC);

    CREATE TABLE IF NOT EXISTS evaluation_reviews (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES evaluation_runs(id) ON DELETE CASCADE,
      reviewer_sub TEXT NOT NULL,
      decision TEXT NOT NULL,
      comment TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evaluation_reviews_run ON evaluation_reviews (tenant_id, run_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS evaluation_case_reviews (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES evaluation_runs(id) ON DELETE CASCADE,
      candidate_id TEXT NOT NULL REFERENCES evaluation_candidates(id) ON DELETE CASCADE,
      case_id TEXT NOT NULL REFERENCES evaluation_cases(id) ON DELETE CASCADE,
      reviewer_sub TEXT NOT NULL,
      decision TEXT NOT NULL,
      comment TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evaluation_case_reviews_target
      ON evaluation_case_reviews (tenant_id, run_id, candidate_id, case_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS evaluation_attempt_reviews (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES evaluation_runs(id) ON DELETE CASCADE,
      candidate_id TEXT NOT NULL REFERENCES evaluation_candidates(id) ON DELETE CASCADE,
      case_id TEXT NOT NULL REFERENCES evaluation_cases(id) ON DELETE CASCADE,
      attempt_id TEXT NOT NULL REFERENCES evaluation_attempts(id) ON DELETE CASCADE,
      reviewer_sub TEXT NOT NULL,
      decision TEXT NOT NULL,
      comment TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_evaluation_attempt_reviews_target
      ON evaluation_attempt_reviews (tenant_id, run_id, attempt_id, created_at DESC);
  `);
  const runColumns = db.prepare('PRAGMA table_info(evaluation_runs)').all() as Array<{ name: string }>;
  if (!runColumns.some(column => column.name === 'use_memory')) {
    db.exec('ALTER TABLE evaluation_runs ADD COLUMN use_memory INTEGER NOT NULL DEFAULT 0');
  }
  if (!runColumns.some(column => column.name === 'concurrency')) {
    db.exec('ALTER TABLE evaluation_runs ADD COLUMN concurrency INTEGER NOT NULL DEFAULT 1');
  }
  if (!runColumns.some(column => column.name === 'tenant_concurrency_limit')) {
    db.exec('ALTER TABLE evaluation_runs ADD COLUMN tenant_concurrency_limit INTEGER NOT NULL DEFAULT 1');
  }
  const candidateColumns = db.prepare('PRAGMA table_info(evaluation_candidates)').all() as Array<{ name: string }>;
  if (!candidateColumns.some(column => column.name === 'alias')) {
    db.exec("ALTER TABLE evaluation_candidates ADD COLUMN alias TEXT NOT NULL DEFAULT ''");
  }
}

export function createEvaluationProject(tenantId: string, actorSub: string, input: Record<string, unknown>) {
  const timestamp = now();
  const project: EvaluationProject = {
    id: crypto.randomUUID(),
    tenantId,
    name: cleanText(input.name, '项目名称', 160),
    description: cleanText(input.description, '项目描述', 2000, false),
    type: requireType(input.type),
    createdBy: actorSub,
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
  };
  database().prepare(`
    INSERT INTO evaluation_projects (id, tenant_id, name, description, type, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(project.id, tenantId, project.name, project.description, project.type, actorSub, timestamp, timestamp);
  return project;
}

export function listEvaluationProjects(tenantId: string) {
  return (database().prepare(`
    SELECT * FROM evaluation_projects WHERE tenant_id = ? ORDER BY archived_at IS NOT NULL, updated_at DESC
  `).all(tenantId) as any[]).map(mapProject);
}

export function getEvaluationProject(tenantId: string, projectId: string) {
  const row = database().prepare('SELECT * FROM evaluation_projects WHERE tenant_id = ? AND id = ?').get(tenantId, projectId);
  return row ? mapProject(row) : null;
}

export function archiveEvaluationProject(tenantId: string, projectId: string) {
  const project = getEvaluationProject(tenantId, projectId);
  if (!project) throw new EvaluationStoreError('not_found', '评测项目不存在');
  const timestamp = now();
  database().prepare(`
    UPDATE evaluation_projects SET archived_at = COALESCE(archived_at, ?), updated_at = ?
    WHERE tenant_id = ? AND id = ?
  `).run(timestamp, timestamp, tenantId, projectId);
  return getEvaluationProject(tenantId, projectId)!;
}

export function restoreEvaluationProject(tenantId: string, projectId: string) {
  const project = getEvaluationProject(tenantId, projectId);
  if (!project) throw new EvaluationStoreError('not_found', '评测项目不存在');
  database().prepare(`
    UPDATE evaluation_projects SET archived_at = NULL, updated_at = ? WHERE tenant_id = ? AND id = ?
  `).run(now(), tenantId, projectId);
  return getEvaluationProject(tenantId, projectId)!;
}

export function deleteEvaluationProject(tenantId: string, projectId: string, confirmationName: unknown) {
  const connection = database();
  connection.exec('BEGIN IMMEDIATE');
  try {
    const row = connection.prepare(`
      SELECT * FROM evaluation_projects WHERE tenant_id = ? AND id = ?
    `).get(tenantId, projectId) as any;
    if (!row) throw new EvaluationStoreError('not_found', '评测项目不存在');
    const project = mapProject(row);
    if (cleanText(confirmationName, '项目名称', 160) !== project.name) {
      throw new EvaluationStoreError('invalid_input', '输入的项目名称不匹配');
    }
    const activeRuns = connection.prepare(`
      SELECT COUNT(*) AS count FROM evaluation_runs
      WHERE tenant_id = ? AND project_id = ?
        AND status NOT IN ('completed', 'failed', 'cancelled', 'archived')
    `).get(tenantId, projectId) as { count: number };
    if (Number(activeRuns.count) > 0) {
      throw new EvaluationStoreError('project_has_active_runs', '项目存在未结束的评测运行，请先取消或完成这些运行');
    }
    const runCount = Number((connection.prepare(`
      SELECT COUNT(*) AS count FROM evaluation_runs WHERE tenant_id = ? AND project_id = ?
    `).get(tenantId, projectId) as { count: number }).count || 0);
    connection.prepare('DELETE FROM evaluation_runs WHERE tenant_id = ? AND project_id = ?').run(tenantId, projectId);
    connection.prepare('DELETE FROM evaluation_projects WHERE tenant_id = ? AND id = ?').run(tenantId, projectId);
    connection.exec('COMMIT');
    return { project, deletedRuns: runCount };
  } catch (error) {
    connection.exec('ROLLBACK');
    throw error;
  }
}

function normalizeCases(value: unknown, type: EvaluationType) {
  if (!Array.isArray(value) || value.length === 0) throw new EvaluationStoreError('invalid_input', '测试集至少需要 1 个用例');
  if (value.length > 10_000) throw new EvaluationStoreError('invalid_input', '单个测试集版本最多 10,000 个用例');
  const seen = new Set<string>();
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new EvaluationStoreError('invalid_input', `第 ${index + 1} 个用例格式无效`);
    }
    const raw = item as Record<string, unknown>;
    const externalId = cleanText(raw.externalId ?? raw.id, `第 ${index + 1} 个用例 ID`, 160, false) || `case-${index + 1}`;
    if (seen.has(externalId)) throw new EvaluationStoreError('conflict', `用例 ID 重复: ${externalId}`);
    seen.add(externalId);
    const prompt = cleanText(raw.prompt ?? raw.question ?? raw.issue, `第 ${index + 1} 个用例内容`, 100_000);
    const expectedAnswer = cleanText(raw.expectedAnswer ?? raw.expected, '标准答案', 100_000, false);
    const assertions = normalizeAssertions(raw.assertions);
    if (type === 'qa' && expectedAnswer && !assertions.some(assertion => assertion.type === 'exact')) {
      assertions.unshift({ type: 'exact', value: expectedAnswer, weight: 1 });
    }
    return {
      externalId,
      prompt,
      expectedAnswer,
      referenceMaterial: cleanText(raw.referenceMaterial ?? raw.reference, '引用材料', 200_000, false),
      assertions,
      metadata: raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata)
        ? raw.metadata as Record<string, unknown>
        : {},
    };
  });
}

export function createEvaluationDataset(tenantId: string, actorSub: string, input: Record<string, unknown>) {
  const type = requireType(input.type);
  const datasetId = crypto.randomUUID();
  const timestamp = now();
  const name = cleanText(input.name, '测试集名称', 160);
  const description = cleanText(input.description, '测试集描述', 2000, false);
  const connection = database();
  connection.exec('BEGIN');
  try {
    connection.prepare(`
      INSERT INTO evaluation_datasets (id, tenant_id, name, description, type, latest_version, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(datasetId, tenantId, name, description, type, actorSub, timestamp, timestamp);
    const version = createEvaluationDatasetVersionInternal(connection, tenantId, actorSub, datasetId, type, input);
    connection.exec('COMMIT');
    return { dataset: getEvaluationDataset(tenantId, datasetId)!, version };
  } catch (error) {
    connection.exec('ROLLBACK');
    throw error;
  }
}

function createEvaluationDatasetVersionInternal(
  connection: DatabaseSync,
  tenantId: string,
  actorSub: string,
  datasetId: string,
  type: EvaluationType,
  input: Record<string, unknown>,
) {
  const cases = normalizeCases(input.cases, type);
  const current = connection.prepare(`
    SELECT latest_version FROM evaluation_datasets WHERE tenant_id = ? AND id = ?
  `).get(tenantId, datasetId) as { latest_version: number } | undefined;
  if (!current) throw new EvaluationStoreError('not_found', '测试集不存在');
  const versionNumber = Number(current.latest_version || 0) + 1;
  const versionId = crypto.randomUUID();
  const timestamp = now();
  const source = ['manual', 'json', 'jsonl', 'csv'].includes(String(input.source)) ? String(input.source) : 'manual';
  const checksum = crypto.createHash('sha256').update(serializeJson(cases, '测试集用例')).digest('hex');
  connection.prepare(`
    INSERT INTO evaluation_dataset_versions (
      id, tenant_id, dataset_id, version, source, field_mapping_json, checksum, case_count, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    versionId,
    tenantId,
    datasetId,
    versionNumber,
    source,
    serializeJson(input.fieldMapping && typeof input.fieldMapping === 'object' ? input.fieldMapping : {}, '字段映射'),
    checksum,
    cases.length,
    actorSub,
    timestamp,
  );
  const insertCase = connection.prepare(`
    INSERT INTO evaluation_cases (
      id, tenant_id, dataset_version_id, external_id, prompt, expected_answer, reference_material,
      assertions_json, metadata_json, position
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  cases.forEach((evaluationCase, index) => {
    insertCase.run(
      crypto.randomUUID(),
      tenantId,
      versionId,
      evaluationCase.externalId,
      evaluationCase.prompt,
      evaluationCase.expectedAnswer,
      evaluationCase.referenceMaterial,
      serializeJson(evaluationCase.assertions, '断言'),
      serializeJson(evaluationCase.metadata, '用例元数据'),
      index,
    );
  });
  connection.prepare(`
    UPDATE evaluation_datasets SET latest_version = ?, updated_at = ? WHERE tenant_id = ? AND id = ?
  `).run(versionNumber, timestamp, tenantId, datasetId);
  const row = connection.prepare('SELECT * FROM evaluation_dataset_versions WHERE id = ?').get(versionId);
  return mapVersion(row, true);
}

export function createEvaluationDatasetVersion(tenantId: string, actorSub: string, datasetId: string, input: Record<string, unknown>) {
  const dataset = getEvaluationDataset(tenantId, datasetId);
  if (!dataset) throw new EvaluationStoreError('not_found', '测试集不存在');
  const connection = database();
  connection.exec('BEGIN');
  try {
    const version = createEvaluationDatasetVersionInternal(connection, tenantId, actorSub, datasetId, dataset.type, input);
    connection.exec('COMMIT');
    return version;
  } catch (error) {
    connection.exec('ROLLBACK');
    throw error;
  }
}

export function listEvaluationDatasets(tenantId: string) {
  return (database().prepare(`
    SELECT d.*, v.id AS latest_version_id, COALESCE(v.case_count, 0) AS case_count
    FROM evaluation_datasets d
    LEFT JOIN evaluation_dataset_versions v
      ON v.tenant_id = d.tenant_id AND v.dataset_id = d.id AND v.version = d.latest_version
    WHERE d.tenant_id = ?
    ORDER BY d.updated_at DESC
  `).all(tenantId) as any[]).map(mapDataset);
}

export function getEvaluationDataset(tenantId: string, datasetId: string) {
  const row = database().prepare(`
    SELECT d.*, v.id AS latest_version_id, COALESCE(v.case_count, 0) AS case_count
    FROM evaluation_datasets d
    LEFT JOIN evaluation_dataset_versions v
      ON v.tenant_id = d.tenant_id AND v.dataset_id = d.id AND v.version = d.latest_version
    WHERE d.tenant_id = ? AND d.id = ?
  `).get(tenantId, datasetId);
  return row ? mapDataset(row) : null;
}

export function getEvaluationDatasetVersion(tenantId: string, versionId: string, includeCases = true) {
  const row = database().prepare(`
    SELECT * FROM evaluation_dataset_versions WHERE tenant_id = ? AND id = ?
  `).get(tenantId, versionId);
  return row ? mapVersion(row, includeCases) : null;
}

export function listEvaluationCases(tenantId: string, versionId: string) {
  return (database().prepare(`
    SELECT * FROM evaluation_cases WHERE tenant_id = ? AND dataset_version_id = ? ORDER BY position ASC
  `).all(tenantId, versionId) as any[]).map(mapCase);
}

function ensureBuiltinRubrics(tenantId: string, actorSub: string) {
  const connection = database();
  for (const type of ['qa', 'code_repair'] as EvaluationType[]) {
    const id = `builtin-${type}`;
    const existing = connection.prepare('SELECT id FROM evaluation_rubrics WHERE tenant_id = ? AND id = ?').get(tenantId, id);
    if (existing) continue;
    const timestamp = now();
    connection.prepare(`
      INSERT INTO evaluation_rubrics (
        id, tenant_id, name, description, type, metrics_json, pass_threshold, auto_weight, judge_weight,
        judge_model, judge_prompt, builtin, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, 1, ?, ?, ?)
    `).run(
      id,
      tenantId,
      type === 'qa' ? '问答综合评分' : '代码修复综合评分',
      type === 'qa' ? '规则验证、裁判 Agent 与人工终审。' : '构建、测试、静态检查、裁判 Agent 与人工终审。',
      type,
      serializeJson(defaultMetrics(type), '默认指标'),
      type === 'qa' ? 70 : 80,
      type === 'qa' ? 60 : 70,
      type === 'qa' ? 40 : 30,
      type === 'qa'
        ? '依据评分量表审查回答的正确性、完整性和证据质量。'
        : '依据测试证据和补丁内容审查修复正确性与变更质量。',
      actorSub,
      timestamp,
      timestamp,
    );
  }
}

export function listEvaluationRubrics(tenantId: string, actorSub = 'system') {
  ensureBuiltinRubrics(tenantId, actorSub);
  return (database().prepare(`
    SELECT * FROM evaluation_rubrics WHERE tenant_id = ? ORDER BY builtin DESC, updated_at DESC
  `).all(tenantId) as any[]).map(mapRubric);
}

export function getEvaluationRubric(tenantId: string, rubricId: string) {
  const row = database().prepare('SELECT * FROM evaluation_rubrics WHERE tenant_id = ? AND id = ?').get(tenantId, rubricId);
  return row ? mapRubric(row) : null;
}

export function createEvaluationRubric(tenantId: string, actorSub: string, input: Record<string, unknown>) {
  const type = requireType(input.type);
  const timestamp = now();
  const autoWeight = boundedNumber(input.autoWeight, 60, 0, 100);
  const judgeWeight = boundedNumber(input.judgeWeight, 40, 0, 100);
  if (autoWeight + judgeWeight <= 0) throw new EvaluationStoreError('invalid_input', '自动评分和裁判评分权重不能同时为 0');
  const rubric: EvaluationRubric = {
    id: crypto.randomUUID(),
    tenantId,
    name: cleanText(input.name, '评分模板名称', 160),
    description: cleanText(input.description, '评分模板描述', 2000, false),
    type,
    metrics: normalizeMetrics(input.metrics, type),
    passThreshold: boundedNumber(input.passThreshold, 70, 0, 100),
    autoWeight,
    judgeWeight,
    judgeModel: cleanText(input.judgeModel, '裁判模型', 200, false),
    judgePrompt: cleanText(input.judgePrompt, '裁判提示词', 20_000, false),
    builtin: false,
    createdBy: actorSub,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  database().prepare(`
    INSERT INTO evaluation_rubrics (
      id, tenant_id, name, description, type, metrics_json, pass_threshold, auto_weight, judge_weight,
      judge_model, judge_prompt, builtin, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
  `).run(
    rubric.id,
    tenantId,
    rubric.name,
    rubric.description,
    type,
    serializeJson(rubric.metrics, '评分指标'),
    rubric.passThreshold,
    rubric.autoWeight,
    rubric.judgeWeight,
    rubric.judgeModel,
    rubric.judgePrompt,
    actorSub,
    timestamp,
    timestamp,
  );
  return rubric;
}

export function createEvaluationRun(
  tenantId: string,
  actor: { sub: string; role?: string | null; quotaUserId?: string | null },
  input: Record<string, unknown>,
) {
  const project = getEvaluationProject(tenantId, cleanText(input.projectId, '项目', 160));
  if (!project) throw new EvaluationStoreError('not_found', '评测项目不存在');
  if (project.archivedAt) throw new EvaluationStoreError('invalid_state', '已归档项目不能创建新的评测运行');
  const version = getEvaluationDatasetVersion(tenantId, cleanText(input.datasetVersionId, '测试集版本', 160), false);
  if (!version) throw new EvaluationStoreError('not_found', '测试集版本不存在');
  const dataset = getEvaluationDataset(tenantId, version.datasetId);
  const rubric = getEvaluationRubric(tenantId, cleanText(input.rubricId, '评分模板', 160));
  if (!rubric) throw new EvaluationStoreError('not_found', '评分模板不存在');
  if (!dataset || project.type !== dataset.type || project.type !== rubric.type) {
    throw new EvaluationStoreError('invalid_input', '项目、测试集与评分模板类型必须一致');
  }
  if (!Array.isArray(input.candidates) || input.candidates.length === 0 || input.candidates.length > 10) {
    throw new EvaluationStoreError('invalid_input', '候选数量必须为 1–10 个');
  }
  const timestamp = now();
  const runId = crypto.randomUUID();
  const concurrency = normalizeRunConcurrency(input, input.candidates.length);
  const reviewPolicy: EvaluationReviewPolicy = input.reviewPolicy === 'consensus' ? 'consensus' : 'single';
  const reviewerSubs = Array.from(new Set(
    (Array.isArray(input.reviewerSubs) ? input.reviewerSubs : [])
      .filter((value): value is string => typeof value === 'string')
      .map(value => value.trim())
      .filter(Boolean),
  ));
  if (!reviewerSubs.length) reviewerSubs.push(actor.sub);
  const requiredCount = reviewPolicy === 'single'
    ? 1
    : Math.min(reviewerSubs.length, boundedInteger(input.reviewRequiredCount, reviewerSubs.length, 2, reviewerSubs.length));
  const budget = input.budget && typeof input.budget === 'object' && !Array.isArray(input.budget)
    ? input.budget as Record<string, unknown>
    : {};
  const connection = database();
  connection.exec('BEGIN');
  try {
    connection.prepare(`
      INSERT INTO evaluation_runs (
        id, tenant_id, project_id, dataset_version_id, rubric_id, name, type, status, use_memory, concurrency,
        tenant_concurrency_limit, review_policy,
        review_required_count, rubric_snapshot_json, budget_json, created_by, creator_role, quota_user_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      tenantId,
      project.id,
      version.id,
      rubric.id,
      cleanText(input.name, '运行名称', 160, false) || `${project.name} · ${new Date(timestamp).toLocaleDateString('zh-CN')}`,
      project.type,
      input.useMemory === true ? 1 : 0,
      concurrency.concurrency,
      concurrency.tenantConcurrencyLimit,
      reviewPolicy,
      requiredCount,
      serializeJson(rubric, '评分模板快照'),
      serializeJson(budget, '运行预算'),
      actor.sub,
      actor.role || '',
      actor.quotaUserId || null,
      timestamp,
      timestamp,
    );
    const insertCandidate = connection.prepare(`
      INSERT INTO evaluation_candidates (
        id, tenant_id, run_id, name, alias, source, agent_id, model, repeat_count, snapshot_json, offline_answers_json, position
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    (input.candidates as Array<Record<string, unknown>>).forEach((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new EvaluationStoreError('invalid_input', `候选 ${index + 1} 格式无效`);
      const source: EvaluationCandidateSource = raw.source === 'offline' ? 'offline' : 'online';
      const agentId = cleanText(raw.agentId, 'Agent', 160, false);
      const model = cleanText(raw.model, '模型', 200, false);
      if (source === 'online' && (!agentId || !model)) throw new EvaluationStoreError('invalid_input', `在线候选 ${index + 1} 必须选择 Agent 和模型`);
      const offlineAnswers = raw.offlineAnswers && typeof raw.offlineAnswers === 'object' && !Array.isArray(raw.offlineAnswers)
        ? raw.offlineAnswers as Record<string, string>
        : {};
      if (source === 'offline' && !Object.keys(offlineAnswers).length) {
        throw new EvaluationStoreError('invalid_input', `离线候选 ${index + 1} 没有答案数据`);
      }
      const snapshot = raw.snapshot && typeof raw.snapshot === 'object' && !Array.isArray(raw.snapshot)
        ? raw.snapshot as Record<string, unknown>
        : {};
      const templateName = cleanText(snapshot.name, 'Agent 名称', 160, false) || `Agent ${index + 1}`;
      const candidateName = source === 'online'
        ? `${templateName} · ${model}`
        : cleanText(raw.name, '候选名称', 160, false) || `离线候选 ${index + 1}`;
      const candidateAlias = source === 'online'
        ? cleanText(raw.alias ?? raw.candidateAlias, '候选别名', 160, false)
        : '';
      insertCandidate.run(
        crypto.randomUUID(),
        tenantId,
        runId,
        candidateName,
        candidateAlias,
        source,
        agentId,
        model,
        boundedInteger(raw.repeatCount, 1, 1, 10),
        serializeJson(snapshot, '候选快照'),
        serializeJson(offlineAnswers, '离线答案'),
        index,
      );
    });
    const insertAssignment = connection.prepare(`
      INSERT INTO evaluation_review_assignments (tenant_id, run_id, reviewer_sub, status, assigned_at)
      VALUES (?, ?, ?, 'pending', ?)
    `);
    for (const reviewerSub of reviewerSubs) insertAssignment.run(tenantId, runId, reviewerSub, timestamp);
    connection.exec('COMMIT');
  } catch (error) {
    connection.exec('ROLLBACK');
    throw error;
  }
  return getEvaluationRun(tenantId, runId)!;
}

export function listEvaluationCandidates(tenantId: string, runId: string) {
  return (database().prepare(`
    SELECT * FROM evaluation_candidates WHERE tenant_id = ? AND run_id = ? ORDER BY position ASC
  `).all(tenantId, runId) as any[]).map(mapCandidate);
}

export function listEvaluationRuns(tenantId: string, options: { reviewerSub?: string; admin?: boolean; projectId?: string } = {}) {
  const params: unknown[] = [tenantId];
  let visibility = '';
  if (!options.admin && options.reviewerSub) {
    visibility = `AND EXISTS (
      SELECT 1 FROM evaluation_review_assignments a
      WHERE a.tenant_id = r.tenant_id AND a.run_id = r.id AND a.reviewer_sub = ?
    )`;
    params.push(options.reviewerSub);
  }
  let projectFilter = '';
  if (options.projectId) {
    projectFilter = 'AND r.project_id = ?';
    params.push(options.projectId);
  }
  const rows = database().prepare(`
    SELECT r.* FROM evaluation_runs r
    WHERE r.tenant_id = ? ${visibility} ${projectFilter}
    ORDER BY r.updated_at DESC LIMIT 200
  `).all(...params) as any[];
  return rows.map(row => mapRun(row, true));
}

export function getEvaluationRun(tenantId: string, runId: string, includeRelations = true) {
  const row = database().prepare('SELECT * FROM evaluation_runs WHERE tenant_id = ? AND id = ?').get(tenantId, runId);
  return row ? mapRun(row, includeRelations) : null;
}

export function canAccessEvaluationRun(tenantId: string, runId: string, actorSub: string, isAdmin: boolean) {
  if (isAdmin) return Boolean(getEvaluationRun(tenantId, runId, false));
  return Boolean(database().prepare(`
    SELECT 1 FROM evaluation_review_assignments WHERE tenant_id = ? AND run_id = ? AND reviewer_sub = ?
  `).get(tenantId, runId, actorSub));
}

export function startEvaluationRun(tenantId: string, runId: string) {
  const run = getEvaluationRun(tenantId, runId, false);
  if (!run) throw new EvaluationStoreError('not_found', '评测运行不存在');
  if (run.status !== 'draft' && run.status !== 'paused') throw new EvaluationStoreError('invalid_state', '只有草稿或暂停的运行可以启动');
  const cases = listEvaluationCases(tenantId, run.datasetVersionId);
  const candidates = listEvaluationCandidates(tenantId, runId);
  if (!cases.length || !candidates.length) throw new EvaluationStoreError('invalid_input', '运行缺少用例或候选');
  const connection = database();
  const timestamp = now();
  connection.exec('BEGIN');
  try {
    const existingCount = (connection.prepare(`
      SELECT COUNT(*) AS count FROM evaluation_jobs WHERE tenant_id = ? AND run_id = ? AND kind = 'execute'
    `).get(tenantId, runId) as { count: number }).count;
    if (!existingCount) {
      const insert = connection.prepare(`
        INSERT INTO evaluation_jobs (
          id, tenant_id, run_id, kind, candidate_id, case_id, repetition, status, created_at, updated_at
        ) VALUES (?, ?, ?, 'execute', ?, ?, ?, 'queued', ?, ?)
      `);
      const maximumRepeats = Math.max(...candidates.map(candidate => candidate.repeatCount));
      for (const evaluationCase of cases) {
        for (let repetition = 1; repetition <= maximumRepeats; repetition += 1) {
          for (const candidate of candidates) {
            if (repetition > candidate.repeatCount) continue;
            insert.run(crypto.randomUUID(), tenantId, runId, candidate.id, evaluationCase.id, repetition, timestamp, timestamp);
          }
        }
      }
    } else {
      connection.prepare(`
        UPDATE evaluation_jobs SET status = 'queued', lease_owner = NULL, lease_until = NULL, updated_at = ?
        WHERE tenant_id = ? AND run_id = ? AND status = 'cancelled'
      `).run(timestamp, tenantId, runId);
    }
    connection.prepare(`
      UPDATE evaluation_runs
      SET status = 'queued', error_code = '', error_message = '', started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE tenant_id = ? AND id = ?
    `).run(timestamp, timestamp, tenantId, runId);
    connection.exec('COMMIT');
  } catch (error) {
    connection.exec('ROLLBACK');
    throw error;
  }
  return getEvaluationRun(tenantId, runId)!;
}

export function cancelEvaluationRun(tenantId: string, runId: string) {
  const run = getEvaluationRun(tenantId, runId, false);
  if (!run) throw new EvaluationStoreError('not_found', '评测运行不存在');
  if (['completed', 'failed', 'cancelled', 'archived'].includes(run.status)) return run;
  const timestamp = now();
  const connection = database();
  connection.exec('BEGIN');
  try {
    connection.prepare(`
      UPDATE evaluation_runs SET status = 'cancelled', updated_at = ?, completed_at = ? WHERE tenant_id = ? AND id = ?
    `).run(timestamp, timestamp, tenantId, runId);
    connection.prepare(`
      UPDATE evaluation_jobs SET status = 'cancelled', lease_owner = NULL, lease_until = NULL, updated_at = ?
      WHERE tenant_id = ? AND run_id = ? AND status IN ('queued', 'running')
    `).run(timestamp, tenantId, runId);
    connection.exec('COMMIT');
  } catch (error) {
    connection.exec('ROLLBACK');
    throw error;
  }
  return getEvaluationRun(tenantId, runId)!;
}

export function pauseEvaluationRun(tenantId: string, runId: string, errorCode: string, errorMessage: string) {
  const run = getEvaluationRun(tenantId, runId, false);
  if (!run) throw new EvaluationStoreError('not_found', '评测运行不存在');
  if (['completed', 'failed', 'cancelled', 'archived'].includes(run.status)) return run;
  const timestamp = now();
  database().prepare(`
    UPDATE evaluation_runs
    SET status = 'paused', error_code = ?, error_message = ?, updated_at = ?
    WHERE tenant_id = ? AND id = ?
  `).run(cleanText(errorCode, '错误代码', 120, false), cleanText(errorMessage, '错误信息', 10_000, false), timestamp, tenantId, runId);
  return getEvaluationRun(tenantId, runId)!;
}

export function releaseEvaluationJob(jobId: string, errorCode = '', errorMessage = '') {
  const timestamp = now();
  database().prepare(`
    UPDATE evaluation_jobs
    SET status = 'queued', lease_owner = NULL, lease_until = NULL, error_code = ?, error_message = ?, updated_at = ?
    WHERE id = ? AND status = 'running'
  `).run(errorCode, errorMessage, timestamp, jobId);
}

export function recoverExpiredEvaluationJobs(at = now()) {
  return database().prepare(`
    UPDATE evaluation_jobs
    SET status = 'queued', lease_owner = NULL, lease_until = NULL, error_code = 'lease_expired',
        error_message = 'Worker lease expired; job requeued', updated_at = ?
    WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until < ?
  `).run(at, at).changes;
}

export function claimEvaluationJob(workerId: string, leaseMs = 120_000) {
  const connection = database();
  const timestamp = now();
  connection.exec('BEGIN IMMEDIATE');
  try {
    const row = connection.prepare(`
      SELECT j.*
      FROM evaluation_jobs j
      JOIN evaluation_runs r ON r.id = j.run_id AND r.tenant_id = j.tenant_id
      JOIN evaluation_candidates candidate ON candidate.id = j.candidate_id
      JOIN evaluation_cases evaluation_case ON evaluation_case.id = j.case_id
      WHERE j.status = 'queued'
        AND ((j.kind = 'execute' AND r.status IN ('queued', 'running')) OR (j.kind = 'judge' AND r.status = 'judging'))
        AND (
          SELECT COUNT(*) FROM evaluation_jobs active_run
          WHERE active_run.run_id = r.id AND active_run.status = 'running'
        ) < r.concurrency
        AND (
          SELECT COUNT(*) FROM evaluation_jobs active_tenant
          WHERE active_tenant.tenant_id = r.tenant_id AND active_tenant.status = 'running'
        ) < r.tenant_concurrency_limit
      ORDER BY
        (SELECT COUNT(*) FROM evaluation_jobs active_run WHERE active_run.run_id = r.id AND active_run.status = 'running') ASC,
        r.created_at ASC,
        evaluation_case.position ASC,
        j.repetition ASC,
        candidate.position ASC,
        j.created_at ASC
      LIMIT 1
    `).get() as any;
    if (!row) {
      connection.exec('COMMIT');
      return null;
    }
    connection.prepare(`
      UPDATE evaluation_jobs
      SET status = 'running', attempts = attempts + 1, lease_owner = ?, lease_until = ?, updated_at = ?
      WHERE id = ? AND status = 'queued'
    `).run(workerId, timestamp + leaseMs, timestamp, row.id);
    if (row.kind === 'execute') {
      connection.prepare(`
        UPDATE evaluation_runs SET status = 'running', updated_at = ? WHERE id = ? AND status = 'queued'
      `).run(timestamp, row.run_id);
    }
    connection.exec('COMMIT');
    return mapJob({ ...row, status: 'running', attempts: row.attempts + 1, lease_owner: workerId, lease_until: timestamp + leaseMs, updated_at: timestamp });
  } catch (error) {
    connection.exec('ROLLBACK');
    throw error;
  }
}

export function getEvaluationJobContext(jobId: string): EvaluationJobContext | null {
  const connection = database();
  const jobRow = connection.prepare('SELECT * FROM evaluation_jobs WHERE id = ?').get(jobId) as any;
  if (!jobRow) return null;
  const job = mapJob(jobRow);
  const run = getEvaluationRun(job.tenantId, job.runId, false);
  const candidateRow = connection.prepare('SELECT * FROM evaluation_candidates WHERE id = ? AND tenant_id = ?').get(job.candidateId, job.tenantId);
  const caseRow = connection.prepare('SELECT * FROM evaluation_cases WHERE id = ? AND tenant_id = ?').get(job.caseId, job.tenantId);
  const attemptRow = job.attemptId ? connection.prepare('SELECT * FROM evaluation_attempts WHERE id = ?').get(job.attemptId) : null;
  if (!run || !candidateRow || !caseRow) return null;
  return {
    job,
    run,
    candidate: mapCandidate(candidateRow),
    evaluationCase: mapCase(caseRow),
    attempt: attemptRow ? mapAttempt(attemptRow) : null,
  };
}

export function completeEvaluationExecutionJob(jobId: string, result: {
  outputText: string;
  metrics: Array<Record<string, unknown>>;
  autoScore: number;
  passed: boolean;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs?: number;
}) {
  const context = getEvaluationJobContext(jobId);
  if (!context) throw new EvaluationStoreError('not_found', '评测任务不存在');
  if (context.job.kind !== 'execute' || context.job.status !== 'running') throw new EvaluationStoreError('invalid_state', '任务不在执行状态');
  const attemptId = crypto.randomUUID();
  const timestamp = now();
  const connection = database();
  connection.exec('BEGIN');
  try {
    connection.prepare(`
      INSERT INTO evaluation_attempts (
        id, tenant_id, run_id, job_id, candidate_id, case_id, repetition, status, output_text, metrics_json,
        auto_score, final_score, passed, input_tokens, output_tokens, cost_usd, duration_ms, created_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      attemptId,
      context.job.tenantId,
      context.job.runId,
      jobId,
      context.job.candidateId,
      context.job.caseId,
      context.job.repetition,
      result.outputText,
      serializeJson(result.metrics, '评分指标结果'),
      boundedNumber(result.autoScore, 0, 0, 100),
      boundedNumber(result.autoScore, 0, 0, 100),
      result.passed ? 1 : 0,
      boundedInteger(result.inputTokens, 0, 0, Number.MAX_SAFE_INTEGER),
      boundedInteger(result.outputTokens, 0, 0, Number.MAX_SAFE_INTEGER),
      boundedNumber(result.costUsd, 0, 0, Number.MAX_SAFE_INTEGER),
      boundedInteger(result.durationMs, 0, 0, Number.MAX_SAFE_INTEGER),
      timestamp,
      timestamp,
    );
    connection.prepare(`
      UPDATE evaluation_jobs SET status = 'completed', attempt_id = ?, lease_owner = NULL, lease_until = NULL,
        error_code = '', error_message = '', updated_at = ? WHERE id = ?
    `).run(attemptId, timestamp, jobId);
    connection.prepare('UPDATE evaluation_runs SET updated_at = ? WHERE id = ?').run(timestamp, context.job.runId);
    connection.exec('COMMIT');
  } catch (error) {
    connection.exec('ROLLBACK');
    throw error;
  }
  advanceEvaluationRun(context.job.tenantId, context.job.runId);
  return getEvaluationAttempt(context.job.tenantId, attemptId)!;
}

export function completeEvaluationJudgeJob(jobId: string, result: {
  score: number;
  reason: string;
  confidence: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs?: number;
}) {
  const context = getEvaluationJobContext(jobId);
  if (!context || !context.attempt) throw new EvaluationStoreError('not_found', '裁判任务或尝试不存在');
  if (context.job.kind !== 'judge' || context.job.status !== 'running') throw new EvaluationStoreError('invalid_state', '任务不在裁判状态');
  const rubric = context.run.rubricSnapshot;
  const totalWeight = Math.max(1, rubric.autoWeight + rubric.judgeWeight);
  const judgeScore = boundedNumber(result.score, 0, 0, 100);
  const autoScore = context.attempt.autoScore ?? 0;
  const finalScore = ((autoScore * rubric.autoWeight) + (judgeScore * rubric.judgeWeight)) / totalWeight;
  const timestamp = now();
  const connection = database();
  connection.exec('BEGIN');
  try {
    connection.prepare(`
      UPDATE evaluation_attempts
      SET judge_score = ?, judge_reason = ?, judge_confidence = ?, final_score = ?, passed = ?,
          input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cost_usd = cost_usd + ?,
          duration_ms = duration_ms + ?, completed_at = ?
      WHERE id = ? AND tenant_id = ?
    `).run(
      judgeScore,
      cleanText(result.reason, '裁判理由', 20_000, false),
      boundedNumber(result.confidence, 0, 0, 1),
      finalScore,
      finalScore >= rubric.passThreshold ? 1 : 0,
      boundedInteger(result.inputTokens, 0, 0, Number.MAX_SAFE_INTEGER),
      boundedInteger(result.outputTokens, 0, 0, Number.MAX_SAFE_INTEGER),
      boundedNumber(result.costUsd, 0, 0, Number.MAX_SAFE_INTEGER),
      boundedInteger(result.durationMs, 0, 0, Number.MAX_SAFE_INTEGER),
      timestamp,
      context.attempt.id,
      context.job.tenantId,
    );
    connection.prepare(`
      UPDATE evaluation_jobs SET status = 'completed', lease_owner = NULL, lease_until = NULL,
        error_code = '', error_message = '', updated_at = ? WHERE id = ?
    `).run(timestamp, jobId);
    connection.prepare('UPDATE evaluation_runs SET updated_at = ? WHERE id = ?').run(timestamp, context.job.runId);
    connection.exec('COMMIT');
  } catch (error) {
    connection.exec('ROLLBACK');
    throw error;
  }
  advanceEvaluationRun(context.job.tenantId, context.job.runId);
  return getEvaluationAttempt(context.job.tenantId, context.attempt.id)!;
}

export function failEvaluationJob(jobId: string, error: { code?: string; message: string }) {
  const context = getEvaluationJobContext(jobId);
  if (!context) return null;
  const timestamp = now();
  const connection = database();
  connection.exec('BEGIN');
  try {
    if (context.job.kind === 'execute') {
      const attemptId = crypto.randomUUID();
      connection.prepare(`
        INSERT INTO evaluation_attempts (
          id, tenant_id, run_id, job_id, candidate_id, case_id, repetition, status, output_text, metrics_json,
          auto_score, final_score, passed, error_code, error_message, created_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'failed', '', '[]', 0, 0, 0, ?, ?, ?, ?)
      `).run(
        attemptId,
        context.job.tenantId,
        context.job.runId,
        jobId,
        context.job.candidateId,
        context.job.caseId,
        context.job.repetition,
        cleanText(error.code, '错误代码', 120, false) || 'execution_failed',
        cleanText(error.message, '错误信息', 10_000, false),
        timestamp,
        timestamp,
      );
      connection.prepare(`
        UPDATE evaluation_jobs SET status = 'failed', attempt_id = ?, lease_owner = NULL, lease_until = NULL,
          error_code = ?, error_message = ?, updated_at = ? WHERE id = ?
      `).run(attemptId, error.code || 'execution_failed', error.message, timestamp, jobId);
    } else {
      connection.prepare(`
        UPDATE evaluation_jobs SET status = 'failed', lease_owner = NULL, lease_until = NULL,
          error_code = ?, error_message = ?, updated_at = ? WHERE id = ?
      `).run(error.code || 'judge_failed', error.message, timestamp, jobId);
    }
    connection.prepare('UPDATE evaluation_runs SET updated_at = ? WHERE id = ?').run(timestamp, context.job.runId);
    connection.exec('COMMIT');
  } catch (storeError) {
    connection.exec('ROLLBACK');
    throw storeError;
  }
  advanceEvaluationRun(context.job.tenantId, context.job.runId);
  return getEvaluationRun(context.job.tenantId, context.job.runId)!;
}

function terminalJobCounts(tenantId: string, runId: string, kind: EvaluationJobKind) {
  return database().prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status IN ('completed', 'failed', 'cancelled') THEN 1 ELSE 0 END) AS terminal
    FROM evaluation_jobs WHERE tenant_id = ? AND run_id = ? AND kind = ?
  `).get(tenantId, runId, kind) as { total: number; terminal: number };
}

export function advanceEvaluationRun(tenantId: string, runId: string) {
  const run = getEvaluationRun(tenantId, runId, false);
  if (!run || ['cancelled', 'completed', 'failed', 'archived', 'paused'].includes(run.status)) return run;
  const connection = database();
  const timestamp = now();
  if (run.status === 'running' || run.status === 'queued') {
    const counts = terminalJobCounts(tenantId, runId, 'execute');
    if (!counts.total || counts.terminal < counts.total) return run;
    if (run.rubricSnapshot.judgeModel.trim() && run.rubricSnapshot.judgeWeight > 0) {
      const existingJudgeJobs = (connection.prepare(`
        SELECT COUNT(*) AS count FROM evaluation_jobs WHERE tenant_id = ? AND run_id = ? AND kind = 'judge'
      `).get(tenantId, runId) as { count: number }).count;
      if (!existingJudgeJobs) {
        const attempts = connection.prepare(`
          SELECT * FROM evaluation_attempts WHERE tenant_id = ? AND run_id = ? AND status = 'completed'
        `).all(tenantId, runId) as any[];
        if (!attempts.length) {
          connection.prepare(`
            UPDATE evaluation_runs
            SET status = 'awaiting_review', error_code = 'all_attempts_failed',
                error_message = '所有候选执行均失败，等待人工终审。', updated_at = ?
            WHERE tenant_id = ? AND id = ?
          `).run(timestamp, tenantId, runId);
          return getEvaluationRun(tenantId, runId)!;
        }
        connection.exec('BEGIN');
        try {
          const insert = connection.prepare(`
            INSERT INTO evaluation_jobs (
              id, tenant_id, run_id, kind, candidate_id, case_id, attempt_id, repetition, status, created_at, updated_at
            ) VALUES (?, ?, ?, 'judge', ?, ?, ?, ?, 'queued', ?, ?)
          `);
          for (const attempt of attempts) {
            insert.run(crypto.randomUUID(), tenantId, runId, attempt.candidate_id, attempt.case_id, attempt.id, attempt.repetition, timestamp, timestamp);
          }
          connection.prepare(`
            UPDATE evaluation_runs SET status = 'judging', updated_at = ? WHERE tenant_id = ? AND id = ?
          `).run(timestamp, tenantId, runId);
          connection.exec('COMMIT');
        } catch (error) {
          connection.exec('ROLLBACK');
          throw error;
        }
      } else {
        connection.prepare('UPDATE evaluation_runs SET status = ?, updated_at = ? WHERE tenant_id = ? AND id = ?')
          .run('judging', timestamp, tenantId, runId);
      }
    } else {
      connection.prepare(`
        UPDATE evaluation_runs SET status = 'awaiting_review', error_code = ?, error_message = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ?
      `).run(
        run.rubricSnapshot.judgeWeight > 0 ? 'judge_unavailable' : '',
        run.rubricSnapshot.judgeWeight > 0 ? '评分模板未配置裁判模型，等待人工终审。' : '',
        timestamp,
        tenantId,
        runId,
      );
    }
  } else if (run.status === 'judging') {
    const counts = terminalJobCounts(tenantId, runId, 'judge');
    if (counts.total && counts.terminal >= counts.total) {
      connection.prepare(`
        UPDATE evaluation_runs SET status = 'awaiting_review', updated_at = ? WHERE tenant_id = ? AND id = ?
      `).run(timestamp, tenantId, runId);
    }
  }
  return getEvaluationRun(tenantId, runId)!;
}

export function getEvaluationAttempt(tenantId: string, attemptId: string) {
  const row = database().prepare('SELECT * FROM evaluation_attempts WHERE tenant_id = ? AND id = ?').get(tenantId, attemptId);
  return row ? mapAttempt(row) : null;
}

export function listEvaluationAttempts(tenantId: string, runId: string, limit = 5000) {
  return (database().prepare(`
    SELECT * FROM evaluation_attempts WHERE tenant_id = ? AND run_id = ?
    ORDER BY created_at ASC LIMIT ?
  `).all(tenantId, runId, Math.max(1, Math.min(10_000, limit))) as any[]).map(mapAttempt);
}

function requireEvidenceDecision(value: unknown): EvaluationEvidenceDecision {
  if (value === 'approve' || value === 'reject' || value === 'needs_attention') return value;
  throw new EvaluationStoreError('invalid_input', '审核结论无效');
}

function mapEvidenceReview(row: any, attemptId: string | null): EvaluationEvidenceReview {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    runId: row.run_id,
    candidateId: row.candidate_id,
    caseId: row.case_id,
    attemptId,
    reviewerSub: row.reviewer_sub,
    decision: row.decision,
    comment: row.comment || '',
    createdAt: row.created_at,
  };
}

export function submitEvaluationCaseReview(
  tenantId: string,
  runId: string,
  reviewerSub: string,
  input: { candidateId?: unknown; caseId?: unknown; decision?: unknown; comment?: unknown; isAdmin?: boolean },
) {
  const run = getEvaluationRun(tenantId, runId, false);
  if (!run) throw new EvaluationStoreError('not_found', '评测运行不存在');
  const candidateId = cleanText(input.candidateId, '候选', 160);
  const caseId = cleanText(input.caseId, '用例', 160);
  const candidate = database().prepare(`
    SELECT 1 FROM evaluation_candidates WHERE tenant_id = ? AND run_id = ? AND id = ?
  `).get(tenantId, runId, candidateId);
  const evidence = database().prepare(`
    SELECT 1 FROM evaluation_attempts WHERE tenant_id = ? AND run_id = ? AND candidate_id = ? AND case_id = ? LIMIT 1
  `).get(tenantId, runId, candidateId, caseId);
  if (!candidate || !evidence) throw new EvaluationStoreError('not_found', '审核对象不存在');
  const assigned = database().prepare(`
    SELECT 1 FROM evaluation_review_assignments WHERE tenant_id = ? AND run_id = ? AND reviewer_sub = ?
  `).get(tenantId, runId, reviewerSub);
  if (!assigned && !input.isAdmin) throw new EvaluationStoreError('forbidden', '你没有这个运行的审核任务');
  const review: EvaluationEvidenceReview = {
    id: crypto.randomUUID(),
    tenantId,
    runId,
    candidateId,
    caseId,
    attemptId: null,
    reviewerSub,
    decision: requireEvidenceDecision(input.decision),
    comment: cleanText(input.comment, '审核备注', 10_000, false),
    createdAt: now(),
  };
  database().prepare(`
    INSERT INTO evaluation_case_reviews (
      id, tenant_id, run_id, candidate_id, case_id, reviewer_sub, decision, comment, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    review.id, tenantId, runId, candidateId, caseId, reviewerSub,
    review.decision, review.comment, review.createdAt,
  );
  return review;
}

export function submitEvaluationAttemptReview(
  tenantId: string,
  runId: string,
  reviewerSub: string,
  input: { attemptId?: unknown; decision?: unknown; comment?: unknown; isAdmin?: boolean },
) {
  const run = getEvaluationRun(tenantId, runId, false);
  if (!run) throw new EvaluationStoreError('not_found', '评测运行不存在');
  const attemptId = cleanText(input.attemptId, '尝试', 160);
  const attempt = getEvaluationAttempt(tenantId, attemptId);
  if (!attempt || attempt.runId !== runId) throw new EvaluationStoreError('not_found', '审核尝试不存在');
  const assigned = database().prepare(`
    SELECT 1 FROM evaluation_review_assignments WHERE tenant_id = ? AND run_id = ? AND reviewer_sub = ?
  `).get(tenantId, runId, reviewerSub);
  if (!assigned && !input.isAdmin) throw new EvaluationStoreError('forbidden', '你没有这个运行的审核任务');
  const decision = requireEvidenceDecision(input.decision);
  const review: EvaluationEvidenceReview = {
    id: crypto.randomUUID(),
    tenantId,
    runId,
    candidateId: attempt.candidateId,
    caseId: attempt.caseId,
    attemptId,
    reviewerSub,
    decision,
    comment: cleanText(input.comment, '审核备注', 10_000, false),
    createdAt: now(),
  };
  database().prepare(`
    INSERT INTO evaluation_attempt_reviews (
      id, tenant_id, run_id, candidate_id, case_id, attempt_id, reviewer_sub, decision, comment, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    review.id, tenantId, runId, review.candidateId, review.caseId, attemptId,
    reviewerSub, review.decision, review.comment, review.createdAt,
  );
  return review;
}

function listEvaluationCaseReviews(tenantId: string, runId: string) {
  return (database().prepare(`
    SELECT * FROM evaluation_case_reviews WHERE tenant_id = ? AND run_id = ? ORDER BY created_at DESC
  `).all(tenantId, runId) as any[]).map(row => mapEvidenceReview(row, null));
}

function listEvaluationAttemptReviews(tenantId: string, runId: string) {
  return (database().prepare(`
    SELECT * FROM evaluation_attempt_reviews WHERE tenant_id = ? AND run_id = ? ORDER BY created_at DESC
  `).all(tenantId, runId) as any[]).map(row => mapEvidenceReview(row, row.attempt_id));
}

function resolveEvidenceReviews(reviews: EvaluationEvidenceReview[], run: EvaluationRun) {
  if (!reviews.length) return null;
  const latestByReviewer = new Map<string, EvaluationEvidenceReview>();
  for (const review of reviews) {
    if (!latestByReviewer.has(review.reviewerSub)) latestByReviewer.set(review.reviewerSub, review);
  }
  const latest = Array.from(latestByReviewer.values()).sort((a, b) => b.createdAt - a.createdAt);
  if (run.reviewPolicy === 'single') return latest[0].decision;
  if (latest.length < run.reviewRequiredCount) return 'needs_attention' as const;
  const decisions = latest.slice(0, run.reviewRequiredCount).map(review => review.decision);
  return new Set(decisions).size === 1 ? decisions[0] : 'needs_attention' as const;
}

function aggregateEvidenceDecisions(decisions: EvaluationEvidenceDecision[]) {
  if (!decisions.length || decisions.includes('needs_attention')) return 'needs_attention' as const;
  const approved = decisions.filter(decision => decision === 'approve').length;
  return approved > decisions.length / 2 ? 'approve' as const : 'reject' as const;
}

export function getEvaluationReviewMatrix(tenantId: string, runId: string) {
  const run = getEvaluationRun(tenantId, runId, false);
  if (!run) throw new EvaluationStoreError('not_found', '评测运行不存在');
  const candidates = listEvaluationCandidates(tenantId, runId);
  const candidateById = new Map(candidates.map(candidate => [candidate.id, candidate]));
  const cases = listEvaluationCases(tenantId, run.datasetVersionId);
  const caseById = new Map(cases.map(evaluationCase => [evaluationCase.id, evaluationCase]));
  const attempts = listEvaluationAttempts(tenantId, runId, 10_000);
  const caseReviews = listEvaluationCaseReviews(tenantId, runId);
  const attemptReviews = listEvaluationAttemptReviews(tenantId, runId);
  const attemptsByGroup = new Map<string, EvaluationAttempt[]>();
  for (const attempt of attempts) {
    const key = `${attempt.candidateId}:${attempt.caseId}`;
    const rows = attemptsByGroup.get(key) || [];
    rows.push(attempt);
    attemptsByGroup.set(key, rows);
  }
  const groups = Array.from(attemptsByGroup.entries()).flatMap(([key, rows]) => {
    const [candidateId, caseId] = key.split(':');
    const candidate = candidateById.get(candidateId);
    const evaluationCase = caseById.get(caseId);
    if (!candidate || !evaluationCase) return [];
    const attemptDetails = rows.sort((a, b) => a.repetition - b.repetition).map((attempt) => {
      const reviews = attemptReviews.filter(review => review.attemptId === attempt.id);
      const reviewDecision = resolveEvidenceReviews(reviews, run);
      const automaticDecision: EvaluationEvidenceDecision = attempt.passed ? 'approve' : 'reject';
      return {
        ...attempt,
        automaticDecision,
        reviewDecision,
        effectiveDecision: reviewDecision || automaticDecision,
        reviews,
      };
    });
    const reviews = caseReviews.filter(review => review.candidateId === candidateId && review.caseId === caseId);
    const caseDecision = resolveEvidenceReviews(reviews, run);
    const automaticDecision = aggregateEvidenceDecisions(attemptDetails.map(attempt => attempt.automaticDecision));
    const attemptDecision = aggregateEvidenceDecisions(attemptDetails.map(attempt => attempt.effectiveDecision));
    return [{
      candidateId,
      candidateName: candidate.name,
      candidateAlias: candidate.alias,
      caseId,
      caseExternalId: evaluationCase.externalId,
      prompt: evaluationCase.prompt,
      attempts: attemptDetails,
      automaticDecision,
      decision: caseDecision || attemptDecision,
      reviewSource: caseDecision ? 'case_review' : attemptReviews.some(review => review.candidateId === candidateId && review.caseId === caseId) ? 'attempt_review' : 'automatic',
      reviews,
      humanReviewed: reviews.length > 0 || attemptDetails.some(attempt => attempt.reviews.length > 0),
    }];
  });
  const passed = groups.filter(group => group.decision === 'approve').length;
  const rejected = groups.filter(group => group.decision === 'reject').length;
  const needsAttention = groups.filter(group => group.decision === 'needs_attention').length;
  return {
    runId,
    groups,
    summary: {
      total: groups.length,
      passed,
      rejected,
      needsAttention,
      reviewed: groups.filter(group => group.humanReviewed).length,
      passRate: groups.length ? passed / groups.length : null,
    },
  };
}

export function getEvaluationRunProgress(tenantId: string, runId: string): EvaluationRunProgress {
  const rows = database().prepare(`
    SELECT kind, status, COUNT(*) AS count
    FROM evaluation_jobs WHERE tenant_id = ? AND run_id = ? GROUP BY kind, status
  `).all(tenantId, runId) as Array<{ kind: EvaluationJobKind; status: EvaluationJobStatus; count: number }>;
  const progress: EvaluationRunProgress = {
    total: 0,
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    executeTotal: 0,
    judgeTotal: 0,
  };
  for (const row of rows) {
    progress.total += row.count;
    progress[row.status] += row.count;
    if (row.kind === 'execute') progress.executeTotal += row.count;
    else progress.judgeTotal += row.count;
  }
  return progress;
}

export function listEvaluationReviewAssignments(tenantId: string, runId: string) {
  return (database().prepare(`
    SELECT * FROM evaluation_review_assignments WHERE tenant_id = ? AND run_id = ? ORDER BY assigned_at ASC
  `).all(tenantId, runId) as any[]).map((row): EvaluationReviewAssignment => ({
    runId: row.run_id,
    reviewerSub: row.reviewer_sub,
    status: row.status,
    assignedAt: row.assigned_at,
    submittedAt: row.submitted_at ?? null,
  }));
}

export function listEvaluationReviews(tenantId: string, runId: string) {
  return (database().prepare(`
    SELECT * FROM evaluation_reviews WHERE tenant_id = ? AND run_id = ? ORDER BY created_at DESC
  `).all(tenantId, runId) as any[]).map((row): EvaluationReview => ({
    id: row.id,
    tenantId: row.tenant_id,
    runId: row.run_id,
    reviewerSub: row.reviewer_sub,
    decision: row.decision,
    comment: row.comment,
    createdAt: row.created_at,
  }));
}

export function submitEvaluationReview(
  tenantId: string,
  runId: string,
  reviewerSub: string,
  input: { decision: 'approve' | 'reject'; comment?: string; isAdmin?: boolean; finalize?: boolean },
) {
  const run = getEvaluationRun(tenantId, runId, false);
  if (!run) throw new EvaluationStoreError('not_found', '评测运行不存在');
  if (run.status !== 'awaiting_review') throw new EvaluationStoreError('invalid_state', '运行当前不在待审核状态');
  const assignment = database().prepare(`
    SELECT 1 FROM evaluation_review_assignments WHERE tenant_id = ? AND run_id = ? AND reviewer_sub = ?
  `).get(tenantId, runId, reviewerSub);
  if (!assignment && !input.isAdmin) throw new EvaluationStoreError('forbidden', '你没有这个运行的审核任务');
  if (input.decision !== 'approve' && input.decision !== 'reject') {
    throw new EvaluationStoreError('invalid_input', '审核结论无效');
  }
  const timestamp = now();
  const connection = database();
  connection.exec('BEGIN');
  try {
    connection.prepare(`
      INSERT INTO evaluation_reviews (id, tenant_id, run_id, reviewer_sub, decision, comment, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      tenantId,
      runId,
      reviewerSub,
      input.decision,
      cleanText(input.comment, '审核备注', 10_000, false),
      timestamp,
    );
    if (assignment) {
      connection.prepare(`
        UPDATE evaluation_review_assignments SET status = 'submitted', submitted_at = ?
        WHERE tenant_id = ? AND run_id = ? AND reviewer_sub = ?
      `).run(timestamp, tenantId, runId, reviewerSub);
    }
    const reviews = connection.prepare(`
      SELECT reviewer_sub, decision FROM evaluation_reviews
      WHERE tenant_id = ? AND run_id = ?
      ORDER BY created_at DESC
    `).all(tenantId, runId) as Array<{ reviewer_sub: string; decision: 'approve' | 'reject' }>;
    const latestByReviewer = new Map<string, 'approve' | 'reject'>();
    for (const review of reviews) if (!latestByReviewer.has(review.reviewer_sub)) latestByReviewer.set(review.reviewer_sub, review.decision);
    const decisions = Array.from(latestByReviewer.values());
    let completed = false;
    let conflict = false;
    let finalDecision: 'approved' | 'rejected' | null = null;
    if (input.isAdmin && input.finalize) {
      completed = true;
      finalDecision = input.decision === 'approve' ? 'approved' : 'rejected';
    } else if (run.reviewPolicy === 'single' && decisions.length >= 1) {
      completed = true;
      finalDecision = decisions[0] === 'approve' ? 'approved' : 'rejected';
    } else if (run.reviewPolicy === 'consensus' && decisions.length >= run.reviewRequiredCount) {
      conflict = new Set(decisions.slice(0, run.reviewRequiredCount)).size > 1;
      if (!conflict) {
        completed = true;
        finalDecision = decisions[0] === 'approve' ? 'approved' : 'rejected';
      }
    }
    connection.prepare(`
      UPDATE evaluation_runs SET review_conflict = ?, review_decision = ?, status = ?, updated_at = ?, completed_at = ?
      WHERE tenant_id = ? AND id = ?
    `).run(
      conflict ? 1 : 0,
      finalDecision,
      completed ? 'completed' : 'awaiting_review',
      timestamp,
      completed ? timestamp : null,
      tenantId,
      runId,
    );
    connection.exec('COMMIT');
  } catch (error) {
    connection.exec('ROLLBACK');
    throw error;
  }
  return getEvaluationRun(tenantId, runId)!;
}

export function getEvaluationReport(tenantId: string, runId: string) {
  const run = getEvaluationRun(tenantId, runId);
  if (!run) throw new EvaluationStoreError('not_found', '评测运行不存在');
  const candidates = run.candidates || [];
  const attempts = listEvaluationAttempts(tenantId, runId, 10_000);
  const reviewMatrix = getEvaluationReviewMatrix(tenantId, runId);
  const rankings = candidates.map(candidate => {
    const rows = attempts.filter(attempt => attempt.candidateId === candidate.id);
    const groups = reviewMatrix.groups.filter(group => group.candidateId === candidate.id);
    const scores = rows.map(attempt => attempt.finalScore).filter((score): score is number => score !== null);
    const averageScore = scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : 0;
    const variance = scores.length > 1
      ? scores.reduce((sum, score) => sum + ((score - averageScore) ** 2), 0) / scores.length
      : 0;
    return {
      candidateId: candidate.id,
      name: candidate.name,
      alias: candidate.alias,
      source: candidate.source,
      model: candidate.model,
      attempts: rows.length,
      completed: rows.filter(row => row.status === 'completed').length,
      failed: rows.filter(row => row.status === 'failed').length,
      passRate: groups.length ? groups.filter(group => group.decision === 'approve').length / groups.length : 0,
      averageScore,
      standardDeviation: Math.sqrt(variance),
      totalTokens: rows.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0),
      totalCostUsd: rows.reduce((sum, row) => sum + row.costUsd, 0),
      averageDurationMs: rows.length ? rows.reduce((sum, row) => sum + row.durationMs, 0) / rows.length : 0,
    };
  }).sort((a, b) => b.averageScore - a.averageScore);
  return {
    run,
    rankings,
    attempts,
    reviewMatrix,
    assignments: listEvaluationReviewAssignments(tenantId, runId),
    reviews: listEvaluationReviews(tenantId, runId),
  };
}

export function getEvaluationOverviewMetrics(
  tenantId: string,
  options: { reviewerSub?: string; admin?: boolean; projectId?: string } = {},
) {
  const runs = listEvaluationRuns(tenantId, options);
  let candidateCaseTotal = 0;
  let candidateCasePassed = 0;
  let pendingEvidenceReviews = 0;
  let totalTokens = 0;
  let totalCostUsd = 0;
  let totalDurationMs = 0;
  let attemptCount = 0;
  for (const run of runs) {
    const attempts = listEvaluationAttempts(tenantId, run.id, 10_000);
    totalTokens += attempts.reduce((sum, attempt) => sum + attempt.inputTokens + attempt.outputTokens, 0);
    totalCostUsd += attempts.reduce((sum, attempt) => sum + attempt.costUsd, 0);
    totalDurationMs += attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0);
    attemptCount += attempts.length;
    const matrix = getEvaluationReviewMatrix(tenantId, run.id);
    if (run.status === 'completed') {
      candidateCaseTotal += matrix.summary.total;
      candidateCasePassed += matrix.summary.passed;
    }
    if (run.status === 'awaiting_review' || run.status === 'completed') {
      pendingEvidenceReviews += matrix.groups.filter(group => !group.humanReviewed || group.decision === 'needs_attention').length;
    }
  }
  return {
    projectId: options.projectId || null,
    totalRuns: runs.length,
    completedRuns: runs.filter(run => run.status === 'completed').length,
    runningRuns: runs.filter(run => ['queued', 'running', 'judging'].includes(run.status)).length,
    pendingReviewRuns: runs.filter(run => run.status === 'awaiting_review').length,
    candidateCaseTotal,
    candidateCasePassed,
    pendingEvidenceReviews,
    passRate: candidateCaseTotal ? candidateCasePassed / candidateCaseTotal : null,
    totalTokens,
    totalCostUsd,
    averageDurationMs: attemptCount ? totalDurationMs / attemptCount : 0,
  };
}
