import crypto from 'node:crypto';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  Role,
  TaskState,
  type Artifact,
  type Message,
  type TaskStatusUpdateEvent,
} from '@a2a-js/sdk';

export type A2ATaskScope = {
  tenantId: string;
  templateId: string;
  callerSub: string;
};

export type A2ATaskRecord = A2ATaskScope & {
  id: string;
  contextId: string;
  messageId: string | null;
  state: TaskState;
  statusMessage: Message | null;
  finalMessage: Message | null;
  error: unknown | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

export type A2AMessageRecord = A2ATaskScope & {
  taskId: string;
  seq: number;
  messageId: string;
  contextId: string;
  role: Role;
  message: Message;
  createdAt: number;
};

export type A2AArtifactRecord = A2ATaskScope & {
  taskId: string;
  seq: number;
  artifactId: string;
  artifact: Artifact;
  createdAt: number;
};

export type A2ATaskEventRecord = A2ATaskScope & {
  taskId: string;
  seq: number;
  event: unknown;
  createdAt: number;
};

export type A2ATaskListOptions = {
  contextId?: string;
  state?: TaskState;
  updatedAfter?: number;
  pageSize?: number;
  cursor?: string;
};

export type A2ATaskListResult = {
  tasks: A2ATaskRecord[];
  nextCursor: string | null;
};

export type A2AStoreErrorCode = 'not_found' | 'invalid_input' | 'invalid_transition' | 'terminal' | 'invalid_cursor';

export class A2AStoreError extends Error {
  constructor(public readonly code: A2AStoreErrorCode, message: string) {
    super(message);
    this.name = 'A2AStoreError';
  }
}

type TaskDbRow = {
  id: string;
  tenant_id: string;
  template_id: string;
  caller_sub: string;
  context_id: string;
  message_id: string | null;
  state: number;
  status_message_json: string | null;
  final_message_json: string | null;
  error_json: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};

type MessageDbRow = {
  task_id: string;
  tenant_id: string;
  template_id: string;
  caller_sub: string;
  seq: number;
  message_id: string;
  context_id: string;
  role: number;
  message_json: string;
  created_at: number;
};

type ArtifactDbRow = {
  task_id: string;
  tenant_id: string;
  template_id: string;
  caller_sub: string;
  seq: number;
  artifact_id: string;
  artifact_json: string;
  created_at: number;
};

type EventDbRow = {
  task_id: string;
  tenant_id: string;
  template_id: string;
  caller_sub: string;
  seq: number;
  event_json: string;
  created_at: number;
};

const TERMINAL_STATES = new Set<TaskState>([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
]);

const VALID_STATES = new Set<TaskState>([
  TaskState.TASK_STATE_SUBMITTED,
  TaskState.TASK_STATE_WORKING,
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_INPUT_REQUIRED,
  TaskState.TASK_STATE_REJECTED,
  TaskState.TASK_STATE_AUTH_REQUIRED,
]);

const ALLOWED_TRANSITIONS = new Map<TaskState, Set<TaskState>>([
  [TaskState.TASK_STATE_SUBMITTED, new Set([
    TaskState.TASK_STATE_WORKING,
    TaskState.TASK_STATE_FAILED,
    TaskState.TASK_STATE_CANCELED,
    TaskState.TASK_STATE_REJECTED,
    TaskState.TASK_STATE_AUTH_REQUIRED,
  ])],
  [TaskState.TASK_STATE_WORKING, new Set([
    TaskState.TASK_STATE_COMPLETED,
    TaskState.TASK_STATE_FAILED,
    TaskState.TASK_STATE_CANCELED,
    TaskState.TASK_STATE_INPUT_REQUIRED,
    TaskState.TASK_STATE_REJECTED,
    TaskState.TASK_STATE_AUTH_REQUIRED,
  ])],
  [TaskState.TASK_STATE_INPUT_REQUIRED, new Set([
    TaskState.TASK_STATE_WORKING,
    TaskState.TASK_STATE_FAILED,
    TaskState.TASK_STATE_CANCELED,
    TaskState.TASK_STATE_REJECTED,
  ])],
  [TaskState.TASK_STATE_AUTH_REQUIRED, new Set([
    TaskState.TASK_STATE_WORKING,
    TaskState.TASK_STATE_FAILED,
    TaskState.TASK_STATE_CANCELED,
    TaskState.TASK_STATE_REJECTED,
  ])],
]);

function requireNonEmpty(value: string, label: string) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new A2AStoreError('invalid_input', `${label} must not be empty`);
  return normalized;
}

function validateScope(scope: A2ATaskScope): A2ATaskScope {
  return {
    tenantId: requireNonEmpty(scope.tenantId, 'tenantId'),
    templateId: requireNonEmpty(scope.templateId, 'templateId'),
    callerSub: requireNonEmpty(scope.callerSub, 'callerSub'),
  };
}

function boundedInteger(value: unknown, defaultValue: number, min: number, max: number, label: string) {
  if (value === undefined || value === null) return defaultValue;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new A2AStoreError('invalid_input', `${label} must be a finite number`);
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function serializeJson(value: unknown, label: string) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('value is not JSON serializable');
    return serialized;
  } catch (error) {
    throw new A2AStoreError('invalid_input', `${label} must be JSON serializable: ${(error as Error).message}`);
  }
}

function serializeNullableJson(value: unknown | null | undefined, label: string) {
  return value === null || value === undefined ? null : serializeJson(value, label);
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`invalid ${label} stored in A2A database`, { cause: error });
  }
}

function parseNullableJson<T>(value: string | null, label: string): T | null {
  return value === null ? null : parseJson<T>(value, label);
}

function mapTask(row: TaskDbRow): A2ATaskRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    templateId: row.template_id,
    callerSub: row.caller_sub,
    contextId: row.context_id,
    messageId: row.message_id,
    state: row.state as TaskState,
    statusMessage: parseNullableJson<Message>(row.status_message_json, 'task status message'),
    finalMessage: parseNullableJson<Message>(row.final_message_json, 'task final message'),
    error: parseNullableJson<unknown>(row.error_json, 'task error'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function mapMessage(row: MessageDbRow): A2AMessageRecord {
  return {
    taskId: row.task_id,
    tenantId: row.tenant_id,
    templateId: row.template_id,
    callerSub: row.caller_sub,
    seq: row.seq,
    messageId: row.message_id,
    contextId: row.context_id,
    role: row.role as Role,
    message: parseJson<Message>(row.message_json, 'A2A message'),
    createdAt: row.created_at,
  };
}

function mapArtifact(row: ArtifactDbRow): A2AArtifactRecord {
  return {
    taskId: row.task_id,
    tenantId: row.tenant_id,
    templateId: row.template_id,
    callerSub: row.caller_sub,
    seq: row.seq,
    artifactId: row.artifact_id,
    artifact: parseJson<Artifact>(row.artifact_json, 'A2A artifact'),
    createdAt: row.created_at,
  };
}

function mapEvent(row: EventDbRow): A2ATaskEventRecord {
  return {
    taskId: row.task_id,
    tenantId: row.tenant_id,
    templateId: row.template_id,
    callerSub: row.caller_sub,
    seq: row.seq,
    event: parseJson<unknown>(row.event_json, 'A2A task event'),
    createdAt: row.created_at,
  };
}

function isTerminalState(state: TaskState) {
  return TERMINAL_STATES.has(state);
}

function validateTaskState(state: TaskState) {
  if (!VALID_STATES.has(state)) throw new A2AStoreError('invalid_input', `unsupported A2A task state: ${state}`);
}

function validateTransition(from: TaskState, to: TaskState) {
  validateTaskState(to);
  if (isTerminalState(from)) throw new A2AStoreError('terminal', 'terminal A2A tasks cannot transition');
  if (from === to) return;
  if (!ALLOWED_TRANSITIONS.get(from)?.has(to)) {
    throw new A2AStoreError('invalid_transition', `invalid A2A task transition: ${from} -> ${to}`);
  }
}

function buildStatusEvent(task: Pick<A2ATaskRecord, 'id' | 'contextId'>, state: TaskState, statusMessage: Message | null, timestamp: number): TaskStatusUpdateEvent {
  return {
    taskId: task.id,
    contextId: task.contextId,
    status: {
      state,
      message: statusMessage || undefined,
      timestamp: new Date(timestamp).toISOString(),
    },
    metadata: undefined,
  };
}

function normalizeTaskMessage(message: Message | null, taskId: string, contextId: string, label: string) {
  if (message === null) return null;
  requireNonEmpty(message.messageId, `${label}.messageId`);
  if (message.taskId && message.taskId !== taskId) {
    throw new A2AStoreError('invalid_input', `${label}.taskId does not match the stored task`);
  }
  if (message.contextId && message.contextId !== contextId) {
    throw new A2AStoreError('invalid_input', `${label}.contextId does not match the stored task`);
  }
  return { ...message, taskId, contextId };
}

function buildRestartMessage(taskId: string, contextId: string, reason: string): Message {
  return {
    messageId: crypto.randomUUID(),
    contextId,
    taskId,
    role: Role.ROLE_AGENT,
    parts: [{
      content: { $case: 'text', value: reason },
      metadata: undefined,
      filename: '',
      mediaType: 'text/plain',
    }],
    metadata: { reason: 'server_restart' },
    extensions: [],
    referenceTaskIds: [],
  };
}

function encodeCursor(task: A2ATaskRecord) {
  return Buffer.from(JSON.stringify({ updatedAt: task.updatedAt, id: task.id }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string) {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { updatedAt?: unknown; id?: unknown };
    const updatedAt = Number(parsed.updatedAt);
    const id = typeof parsed.id === 'string' ? parsed.id : '';
    if (!Number.isFinite(updatedAt) || !id) throw new Error('invalid fields');
    return { updatedAt, id };
  } catch (error) {
    throw new A2AStoreError('invalid_cursor', `invalid A2A task cursor: ${(error as Error).message}`);
  }
}

function withTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function initializeSchema(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS a2a_tasks (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      template_id TEXT NOT NULL,
      caller_sub TEXT NOT NULL,
      context_id TEXT NOT NULL,
      message_id TEXT,
      state INTEGER NOT NULL,
      status_message_json TEXT,
      final_message_json TEXT,
      error_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      UNIQUE (tenant_id, template_id, caller_sub, id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_a2a_tasks_idempotency
      ON a2a_tasks (tenant_id, template_id, caller_sub, message_id)
      WHERE message_id IS NOT NULL AND message_id != '';
    CREATE INDEX IF NOT EXISTS idx_a2a_tasks_scope_updated
      ON a2a_tasks (tenant_id, template_id, caller_sub, updated_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_a2a_tasks_scope_context_updated
      ON a2a_tasks (tenant_id, template_id, caller_sub, context_id, updated_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_a2a_tasks_scope_state_updated
      ON a2a_tasks (tenant_id, template_id, caller_sub, state, updated_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS a2a_messages (
      task_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      template_id TEXT NOT NULL,
      caller_sub TEXT NOT NULL,
      seq INTEGER NOT NULL,
      message_id TEXT NOT NULL,
      context_id TEXT NOT NULL,
      role INTEGER NOT NULL,
      parts_json TEXT NOT NULL,
      message_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (task_id, seq),
      UNIQUE (task_id, message_id),
      FOREIGN KEY (tenant_id, template_id, caller_sub, task_id)
        REFERENCES a2a_tasks (tenant_id, template_id, caller_sub, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_a2a_messages_scope_task_seq
      ON a2a_messages (tenant_id, template_id, caller_sub, task_id, seq ASC);

    CREATE TABLE IF NOT EXISTS a2a_artifacts (
      task_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      template_id TEXT NOT NULL,
      caller_sub TEXT NOT NULL,
      seq INTEGER NOT NULL,
      artifact_id TEXT NOT NULL,
      artifact_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (task_id, seq),
      UNIQUE (task_id, artifact_id),
      FOREIGN KEY (tenant_id, template_id, caller_sub, task_id)
        REFERENCES a2a_tasks (tenant_id, template_id, caller_sub, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_a2a_artifacts_scope_task_seq
      ON a2a_artifacts (tenant_id, template_id, caller_sub, task_id, seq ASC);

    CREATE TABLE IF NOT EXISTS a2a_task_events (
      task_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL,
      template_id TEXT NOT NULL,
      caller_sub TEXT NOT NULL,
      seq INTEGER NOT NULL,
      event_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (task_id, seq),
      FOREIGN KEY (tenant_id, template_id, caller_sub, task_id)
        REFERENCES a2a_tasks (tenant_id, template_id, caller_sub, id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_a2a_task_events_scope_task_seq
      ON a2a_task_events (tenant_id, template_id, caller_sub, task_id, seq ASC);
  `);
}

function createStore(database: DatabaseSync) {
  const scopedTaskRow = (scope: A2ATaskScope, taskId: string) => database.prepare(`
    SELECT * FROM a2a_tasks
    WHERE id = ? AND tenant_id = ? AND template_id = ? AND caller_sub = ?
  `).get(taskId, scope.tenantId, scope.templateId, scope.callerSub) as TaskDbRow | undefined;

  const nextSequence = (table: 'a2a_messages' | 'a2a_artifacts' | 'a2a_task_events', scope: A2ATaskScope, taskId: string) => {
    const row = database.prepare(`
      SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq
      FROM ${table}
      WHERE task_id = ? AND tenant_id = ? AND template_id = ? AND caller_sub = ?
    `).get(taskId, scope.tenantId, scope.templateId, scope.callerSub) as { next_seq: number };
    return Number(row.next_seq);
  };

  const appendEventInTransaction = (scope: A2ATaskScope, taskId: string, event: unknown, createdAt: number) => {
    const seq = nextSequence('a2a_task_events', scope, taskId);
    const eventJson = serializeJson(event, 'A2A task event');
    database.prepare(`
      INSERT INTO a2a_task_events (
        task_id, tenant_id, template_id, caller_sub, seq, event_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(taskId, scope.tenantId, scope.templateId, scope.callerSub, seq, eventJson, createdAt);
    return {
      taskId,
      ...scope,
      seq,
      event,
      createdAt,
    } satisfies A2ATaskEventRecord;
  };

  const findByMessageId = (scopeInput: A2ATaskScope, messageIdInput: string) => {
    const scope = validateScope(scopeInput);
    const messageId = requireNonEmpty(messageIdInput, 'messageId');
    const row = database.prepare(`
      SELECT * FROM a2a_tasks
      WHERE tenant_id = ? AND template_id = ? AND caller_sub = ? AND message_id = ?
    `).get(scope.tenantId, scope.templateId, scope.callerSub, messageId) as TaskDbRow | undefined;
    return row ? mapTask(row) : null;
  };

  const getTask = (scopeInput: A2ATaskScope, taskIdInput: string) => {
    const scope = validateScope(scopeInput);
    const taskId = requireNonEmpty(taskIdInput, 'taskId');
    const row = scopedTaskRow(scope, taskId);
    return row ? mapTask(row) : null;
  };

  const createTask = (input: A2ATaskScope & {
    id?: string;
    contextId: string;
    messageId?: string | null;
    statusMessage?: Message | null;
    event?: unknown;
    createdAt?: number;
  }) => {
    const scope = validateScope(input);
    const id = input.id ? requireNonEmpty(input.id, 'taskId') : crypto.randomUUID();
    const contextId = requireNonEmpty(input.contextId, 'contextId');
    const messageId = input.messageId ? requireNonEmpty(input.messageId, 'messageId') : null;
    const createdAt = Number.isFinite(input.createdAt) ? Number(input.createdAt) : Date.now();

    return withTransaction(database, () => {
      if (messageId) {
        const existing = database.prepare(`
          SELECT * FROM a2a_tasks
          WHERE tenant_id = ? AND template_id = ? AND caller_sub = ? AND message_id = ?
        `).get(scope.tenantId, scope.templateId, scope.callerSub, messageId) as TaskDbRow | undefined;
        if (existing) return { created: false as const, task: mapTask(existing) };
      }

      const statusMessage = normalizeTaskMessage(input.statusMessage || null, id, contextId, 'statusMessage');
      const statusMessageJson = serializeNullableJson(statusMessage, 'task status message');
      database.prepare(`
        INSERT INTO a2a_tasks (
          id, tenant_id, template_id, caller_sub, context_id, message_id, state,
          status_message_json, final_message_json, error_json, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, NULL)
      `).run(
        id,
        scope.tenantId,
        scope.templateId,
        scope.callerSub,
        contextId,
        messageId,
        TaskState.TASK_STATE_SUBMITTED,
        statusMessageJson,
        createdAt,
        createdAt,
      );
      const task = mapTask(scopedTaskRow(scope, id)!);
      appendEventInTransaction(
        scope,
        id,
        input.event ?? buildStatusEvent(task, TaskState.TASK_STATE_SUBMITTED, task.statusMessage, createdAt),
        createdAt,
      );
      return { created: true as const, task };
    });
  };

  const transitionTask = (scopeInput: A2ATaskScope, taskIdInput: string, input: {
    state: TaskState;
    statusMessage?: Message | null;
    finalMessage?: Message | null;
    error?: unknown | null;
    event?: unknown;
    updatedAt?: number;
  }) => {
    const scope = validateScope(scopeInput);
    const taskId = requireNonEmpty(taskIdInput, 'taskId');
    const requestedUpdatedAt = Number.isFinite(input.updatedAt) ? Number(input.updatedAt) : Date.now();

    return withTransaction(database, () => {
      const currentRow = scopedTaskRow(scope, taskId);
      if (!currentRow) throw new A2AStoreError('not_found', 'A2A task not found');
      const current = mapTask(currentRow);
      validateTransition(current.state, input.state);
      const updatedAt = Math.max(current.updatedAt, requestedUpdatedAt);
      const statusMessage = input.statusMessage === undefined
        ? current.statusMessage
        : normalizeTaskMessage(input.statusMessage, taskId, current.contextId, 'statusMessage');
      const finalMessage = input.finalMessage === undefined
        ? current.finalMessage
        : normalizeTaskMessage(input.finalMessage, taskId, current.contextId, 'finalMessage');
      const error = input.error === undefined ? current.error : input.error;
      const completedAt = isTerminalState(input.state) ? updatedAt : null;

      database.prepare(`
        UPDATE a2a_tasks
        SET state = ?, status_message_json = ?, final_message_json = ?, error_json = ?,
            updated_at = ?, completed_at = ?
        WHERE id = ? AND tenant_id = ? AND template_id = ? AND caller_sub = ?
      `).run(
        input.state,
        serializeNullableJson(statusMessage, 'task status message'),
        serializeNullableJson(finalMessage, 'task final message'),
        serializeNullableJson(error, 'task error'),
        updatedAt,
        completedAt,
        taskId,
        scope.tenantId,
        scope.templateId,
        scope.callerSub,
      );

      const updated = mapTask(scopedTaskRow(scope, taskId)!);
      const event = input.event ?? buildStatusEvent(updated, updated.state, updated.statusMessage, updatedAt);
      const storedEvent = appendEventInTransaction(scope, taskId, event, updatedAt);
      return { task: updated, event: storedEvent };
    });
  };

  const appendMessage = (scopeInput: A2ATaskScope, taskIdInput: string, messageInput: Message, options: {
    event?: unknown;
    createdAt?: number;
  } = {}) => {
    const scope = validateScope(scopeInput);
    const taskId = requireNonEmpty(taskIdInput, 'taskId');
    const messageId = requireNonEmpty(messageInput.messageId, 'message.messageId');
    const createdAt = Number.isFinite(options.createdAt) ? Number(options.createdAt) : Date.now();

    return withTransaction(database, () => {
      const taskRow = scopedTaskRow(scope, taskId);
      if (!taskRow) throw new A2AStoreError('not_found', 'A2A task not found');
      const task = mapTask(taskRow);
      if (messageInput.taskId && messageInput.taskId !== taskId) {
        throw new A2AStoreError('invalid_input', 'message.taskId does not match the stored task');
      }
      if (messageInput.contextId && messageInput.contextId !== task.contextId) {
        throw new A2AStoreError('invalid_input', 'message.contextId does not match the stored task');
      }
      const existing = database.prepare(`
        SELECT * FROM a2a_messages
        WHERE task_id = ? AND tenant_id = ? AND template_id = ? AND caller_sub = ? AND message_id = ?
      `).get(taskId, scope.tenantId, scope.templateId, scope.callerSub, messageId) as MessageDbRow | undefined;
      if (existing) return { created: false as const, message: mapMessage(existing), event: null };

      const message: Message = { ...messageInput, taskId, contextId: task.contextId };
      const seq = nextSequence('a2a_messages', scope, taskId);
      database.prepare(`
        INSERT INTO a2a_messages (
          task_id, tenant_id, template_id, caller_sub, seq, message_id, context_id,
          role, parts_json, message_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        taskId,
        scope.tenantId,
        scope.templateId,
        scope.callerSub,
        seq,
        message.messageId,
        message.contextId,
        message.role,
        serializeJson(message.parts, 'message.parts'),
        serializeJson(message, 'message'),
        createdAt,
      );
      const row = database.prepare(`
        SELECT * FROM a2a_messages
        WHERE task_id = ? AND tenant_id = ? AND template_id = ? AND caller_sub = ? AND seq = ?
      `).get(taskId, scope.tenantId, scope.templateId, scope.callerSub, seq) as MessageDbRow;
      const storedEvent = options.event === undefined
        ? null
        : appendEventInTransaction(scope, taskId, options.event, createdAt);
      return { created: true as const, message: mapMessage(row), event: storedEvent };
    });
  };

  const appendArtifact = (scopeInput: A2ATaskScope, taskIdInput: string, artifact: Artifact, options: {
    event?: unknown;
    createdAt?: number;
  } = {}) => {
    const scope = validateScope(scopeInput);
    const taskId = requireNonEmpty(taskIdInput, 'taskId');
    const artifactId = requireNonEmpty(artifact.artifactId, 'artifact.artifactId');
    const createdAt = Number.isFinite(options.createdAt) ? Number(options.createdAt) : Date.now();

    return withTransaction(database, () => {
      if (!scopedTaskRow(scope, taskId)) throw new A2AStoreError('not_found', 'A2A task not found');
      const existing = database.prepare(`
        SELECT * FROM a2a_artifacts
        WHERE task_id = ? AND tenant_id = ? AND template_id = ? AND caller_sub = ? AND artifact_id = ?
      `).get(taskId, scope.tenantId, scope.templateId, scope.callerSub, artifactId) as ArtifactDbRow | undefined;
      if (existing) return { created: false as const, artifact: mapArtifact(existing), event: null };

      const seq = nextSequence('a2a_artifacts', scope, taskId);
      database.prepare(`
        INSERT INTO a2a_artifacts (
          task_id, tenant_id, template_id, caller_sub, seq, artifact_id, artifact_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        taskId,
        scope.tenantId,
        scope.templateId,
        scope.callerSub,
        seq,
        artifactId,
        serializeJson(artifact, 'artifact'),
        createdAt,
      );
      const row = database.prepare(`
        SELECT * FROM a2a_artifacts
        WHERE task_id = ? AND tenant_id = ? AND template_id = ? AND caller_sub = ? AND seq = ?
      `).get(taskId, scope.tenantId, scope.templateId, scope.callerSub, seq) as ArtifactDbRow;
      const storedEvent = options.event === undefined
        ? null
        : appendEventInTransaction(scope, taskId, options.event, createdAt);
      return { created: true as const, artifact: mapArtifact(row), event: storedEvent };
    });
  };

  const appendEvent = (scopeInput: A2ATaskScope, taskIdInput: string, event: unknown, createdAtInput?: number) => {
    const scope = validateScope(scopeInput);
    const taskId = requireNonEmpty(taskIdInput, 'taskId');
    const createdAt = Number.isFinite(createdAtInput) ? Number(createdAtInput) : Date.now();
    return withTransaction(database, () => {
      if (!scopedTaskRow(scope, taskId)) throw new A2AStoreError('not_found', 'A2A task not found');
      return appendEventInTransaction(scope, taskId, event, createdAt);
    });
  };

  const listMessages = (scopeInput: A2ATaskScope, taskIdInput: string, limitInput?: number) => {
    const scope = validateScope(scopeInput);
    const taskId = requireNonEmpty(taskIdInput, 'taskId');
    if (!scopedTaskRow(scope, taskId)) return [];
    const limit = boundedInteger(limitInput, 1000, 0, 1000, 'message history limit');
    if (limit === 0) return [];
    const rows = database.prepare(`
      SELECT * FROM (
        SELECT * FROM a2a_messages
        WHERE task_id = ? AND tenant_id = ? AND template_id = ? AND caller_sub = ?
        ORDER BY seq DESC LIMIT ?
      ) ORDER BY seq ASC
    `).all(taskId, scope.tenantId, scope.templateId, scope.callerSub, limit) as MessageDbRow[];
    return rows.map(mapMessage);
  };

  const listArtifacts = (scopeInput: A2ATaskScope, taskIdInput: string) => {
    const scope = validateScope(scopeInput);
    const taskId = requireNonEmpty(taskIdInput, 'taskId');
    if (!scopedTaskRow(scope, taskId)) return [];
    return (database.prepare(`
      SELECT * FROM a2a_artifacts
      WHERE task_id = ? AND tenant_id = ? AND template_id = ? AND caller_sub = ?
      ORDER BY seq ASC
    `).all(taskId, scope.tenantId, scope.templateId, scope.callerSub) as ArtifactDbRow[]).map(mapArtifact);
  };

  const listEvents = (scopeInput: A2ATaskScope, taskIdInput: string, options: { afterSeq?: number; limit?: number } = {}) => {
    const scope = validateScope(scopeInput);
    const taskId = requireNonEmpty(taskIdInput, 'taskId');
    if (!scopedTaskRow(scope, taskId)) return [];
    const afterSeq = boundedInteger(options.afterSeq, 0, 0, Number.MAX_SAFE_INTEGER, 'event afterSeq');
    const limit = boundedInteger(options.limit, 1000, 1, 1000, 'event limit');
    return (database.prepare(`
      SELECT * FROM a2a_task_events
      WHERE task_id = ? AND tenant_id = ? AND template_id = ? AND caller_sub = ? AND seq > ?
      ORDER BY seq ASC LIMIT ?
    `).all(taskId, scope.tenantId, scope.templateId, scope.callerSub, afterSeq, limit) as EventDbRow[]).map(mapEvent);
  };

  const listTasks = (scopeInput: A2ATaskScope, options: A2ATaskListOptions = {}): A2ATaskListResult => {
    const scope = validateScope(scopeInput);
    const filters = ['tenant_id = ?', 'template_id = ?', 'caller_sub = ?'];
    const params: SQLInputValue[] = [scope.tenantId, scope.templateId, scope.callerSub];
    if (options.contextId) {
      filters.push('context_id = ?');
      params.push(requireNonEmpty(options.contextId, 'contextId'));
    }
    if (options.state !== undefined && options.state !== TaskState.TASK_STATE_UNSPECIFIED) {
      validateTaskState(options.state);
      filters.push('state = ?');
      params.push(options.state);
    }
    if (options.updatedAfter !== undefined) {
      const updatedAfter = Number(options.updatedAfter);
      if (!Number.isFinite(updatedAfter)) throw new A2AStoreError('invalid_input', 'updatedAfter must be a timestamp');
      filters.push('updated_at >= ?');
      params.push(updatedAfter);
    }
    if (options.cursor) {
      const cursor = decodeCursor(options.cursor);
      filters.push('(updated_at < ? OR (updated_at = ? AND id < ?))');
      params.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
    }
    const pageSize = boundedInteger(options.pageSize, 50, 1, 100, 'pageSize');
    params.push(pageSize + 1);
    const rows = database.prepare(`
      SELECT * FROM a2a_tasks
      WHERE ${filters.join(' AND ')}
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `).all(...params) as TaskDbRow[];
    const hasMore = rows.length > pageSize;
    const tasks = rows.slice(0, pageSize).map(mapTask);
    return {
      tasks,
      nextCursor: hasMore && tasks.length ? encodeCursor(tasks[tasks.length - 1]) : null,
    };
  };

  const reconcileInterruptedTasks = (options: { now?: number; reason?: string } = {}) => {
    const timestamp = Number.isFinite(options.now) ? Number(options.now) : Date.now();
    const reason = options.reason || 'AgentMa restarted while this A2A task was still active; live execution could not be resumed.';
    return withTransaction(database, () => {
      const rows = database.prepare(`
        SELECT * FROM a2a_tasks
        WHERE state IN (?, ?, ?)
        ORDER BY created_at ASC, id ASC
      `).all(
        TaskState.TASK_STATE_SUBMITTED,
        TaskState.TASK_STATE_WORKING,
        TaskState.TASK_STATE_INPUT_REQUIRED,
      ) as TaskDbRow[];

      for (const row of rows) {
        const scope = { tenantId: row.tenant_id, templateId: row.template_id, callerSub: row.caller_sub };
        const reconciledAt = Math.max(timestamp, row.updated_at);
        const statusMessage = buildRestartMessage(row.id, row.context_id, reason);
        const error = { code: 'AGENTMA_RESTART_INTERRUPTION', message: reason };
        database.prepare(`
          UPDATE a2a_tasks
          SET state = ?, status_message_json = ?, error_json = ?, updated_at = ?, completed_at = ?
          WHERE id = ? AND tenant_id = ? AND template_id = ? AND caller_sub = ?
        `).run(
          TaskState.TASK_STATE_FAILED,
          serializeJson(statusMessage, 'restart status message'),
          serializeJson(error, 'restart error'),
          reconciledAt,
          reconciledAt,
          row.id,
          scope.tenantId,
          scope.templateId,
          scope.callerSub,
        );
        appendEventInTransaction(
          scope,
          row.id,
          buildStatusEvent({ id: row.id, contextId: row.context_id }, TaskState.TASK_STATE_FAILED, statusMessage, reconciledAt),
          reconciledAt,
        );
      }
      return rows.length;
    });
  };

  return {
    findByMessageId,
    getTask,
    createTask,
    transitionTask,
    appendMessage,
    appendArtifact,
    appendEvent,
    listMessages,
    listArtifacts,
    listEvents,
    listTasks,
    reconcileInterruptedTasks,
  };
}

type A2ATaskStore = ReturnType<typeof createStore>;
let defaultStore: A2ATaskStore | null = null;

function requireDefaultStore() {
  if (!defaultStore) throw new Error('A2A task store has not been initialized');
  return defaultStore;
}

export function initializeA2ATaskStore(database: DatabaseSync) {
  initializeSchema(database);
  defaultStore = createStore(database);
  return defaultStore.reconcileInterruptedTasks();
}

export function createA2ATask(...args: Parameters<A2ATaskStore['createTask']>) {
  return requireDefaultStore().createTask(...args);
}

export function findA2ATaskByMessageId(...args: Parameters<A2ATaskStore['findByMessageId']>) {
  return requireDefaultStore().findByMessageId(...args);
}

export function getA2ATask(...args: Parameters<A2ATaskStore['getTask']>) {
  return requireDefaultStore().getTask(...args);
}

export function transitionA2ATask(...args: Parameters<A2ATaskStore['transitionTask']>) {
  return requireDefaultStore().transitionTask(...args);
}

export function appendA2AMessage(...args: Parameters<A2ATaskStore['appendMessage']>) {
  return requireDefaultStore().appendMessage(...args);
}

export function appendA2AArtifact(...args: Parameters<A2ATaskStore['appendArtifact']>) {
  return requireDefaultStore().appendArtifact(...args);
}

export function appendA2ATaskEvent(...args: Parameters<A2ATaskStore['appendEvent']>) {
  return requireDefaultStore().appendEvent(...args);
}

export function listA2AMessages(...args: Parameters<A2ATaskStore['listMessages']>) {
  return requireDefaultStore().listMessages(...args);
}

export function listA2AArtifacts(...args: Parameters<A2ATaskStore['listArtifacts']>) {
  return requireDefaultStore().listArtifacts(...args);
}

export function listA2ATaskEvents(...args: Parameters<A2ATaskStore['listEvents']>) {
  return requireDefaultStore().listEvents(...args);
}

export function listA2ATasks(...args: Parameters<A2ATaskStore['listTasks']>) {
  return requireDefaultStore().listTasks(...args);
}

export function reconcileInterruptedA2ATasks(...args: Parameters<A2ATaskStore['reconcileInterruptedTasks']>) {
  return requireDefaultStore().reconcileInterruptedTasks(...args);
}

export function a2aTaskStateIsTerminal(state: TaskState) {
  return isTerminalState(state);
}

export { TaskState };
