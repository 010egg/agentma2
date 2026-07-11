import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Role } from '@a2a-js/sdk';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentma-a2a-store-'));
process.env.AGENTMA_DATA_DIR = tempDir;

function userMessage(messageId, contextId = '', taskId = '', text = messageId) {
  return {
    messageId,
    contextId,
    taskId,
    role: Role.ROLE_USER,
    parts: [{
      content: { $case: 'text', value: text },
      metadata: undefined,
      filename: '',
      mediaType: 'text/plain',
    }],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

function artifact(artifactId, text = artifactId) {
  return {
    artifactId,
    name: artifactId,
    description: '',
    parts: [{
      content: { $case: 'text', value: text },
      metadata: undefined,
      filename: '',
      mediaType: 'text/plain',
    }],
    metadata: undefined,
    extensions: [],
  };
}

try {
  const store = await import('../server-store.ts');
  const a2a = await import('../server-a2a-store.ts');
  const { TaskState } = a2a;

  const stamp = crypto.randomUUID();
  const firstRegistration = store.registerUser('A2A Store One', `a2a-store-one-${stamp}@gmail.com`, 'secret123');
  const secondRegistration = store.registerUser('A2A Store Two', `a2a-store-two-${stamp}@gmail.com`, 'secret123');
  assert.equal(firstRegistration.ok, true);
  assert.equal(secondRegistration.ok, true);
  if (!firstRegistration.ok || !secondRegistration.ok) throw new Error('registration failed');

  const scope = {
    tenantId: firstRegistration.tenantId,
    templateId: 'a2a-store-template',
    callerSub: firstRegistration.user.id,
  };
  const otherCallerScope = { ...scope, callerSub: 'api_key:other-caller' };
  const otherTemplateScope = { ...scope, templateId: 'other-template' };
  const otherTenantScope = {
    tenantId: secondRegistration.tenantId,
    templateId: scope.templateId,
    callerSub: scope.callerSub,
  };

  const created = a2a.createA2ATask({
    ...scope,
    id: 'task-main',
    contextId: 'context-main',
    messageId: 'message-idempotent',
    createdAt: 1_000,
  });
  assert.equal(created.created, true);
  assert.equal(created.task.state, TaskState.TASK_STATE_SUBMITTED);
  assert.deepEqual(a2a.listA2ATaskEvents(scope, created.task.id).map(item => item.seq), [1]);

  const duplicate = a2a.createA2ATask({
    ...scope,
    id: 'task-duplicate-must-not-win',
    contextId: 'context-other',
    messageId: 'message-idempotent',
  });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.task.id, created.task.id);
  assert.equal(a2a.findA2ATaskByMessageId(scope, 'message-idempotent')?.id, created.task.id);

  const sameMessageOtherCaller = a2a.createA2ATask({
    ...otherCallerScope,
    id: 'task-other-caller',
    contextId: 'context-main',
    messageId: 'message-idempotent',
    createdAt: 1_100,
  });
  assert.equal(sameMessageOtherCaller.created, true);
  assert.equal(a2a.getA2ATask(otherCallerScope, sameMessageOtherCaller.task.id)?.id, sameMessageOtherCaller.task.id);

  assert.equal(a2a.getA2ATask(otherTenantScope, created.task.id), null);
  assert.equal(a2a.getA2ATask(otherTemplateScope, created.task.id), null);
  assert.equal(a2a.getA2ATask(otherCallerScope, created.task.id), null);
  assert.equal(a2a.findA2ATaskByMessageId(otherTemplateScope, 'message-idempotent'), null);

  a2a.transitionA2ATask(scope, created.task.id, {
    state: TaskState.TASK_STATE_WORKING,
    updatedAt: 2_000,
  });

  const firstMessage = a2a.appendA2AMessage(
    scope,
    created.task.id,
    userMessage('history-1', '', '', 'first'),
    { event: { type: 'message', messageId: 'history-1' }, createdAt: 2_100 },
  );
  assert.equal(firstMessage.created, true);
  assert.equal(firstMessage.message.contextId, created.task.contextId);
  assert.equal(firstMessage.message.taskId, created.task.id);

  const duplicateMessage = a2a.appendA2AMessage(scope, created.task.id, userMessage('history-1'));
  assert.equal(duplicateMessage.created, false);
  a2a.appendA2AMessage(scope, created.task.id, userMessage('history-2'), { createdAt: 2_200 });
  a2a.appendA2AMessage(scope, created.task.id, userMessage('history-3'), { createdAt: 2_300 });
  assert.deepEqual(a2a.listA2AMessages(scope, created.task.id, 2).map(item => item.messageId), ['history-2', 'history-3']);
  assert.deepEqual(a2a.listA2AMessages(otherCallerScope, created.task.id), []);

  const storedArtifact = a2a.appendA2AArtifact(
    scope,
    created.task.id,
    artifact('artifact-1', 'artifact output'),
    { event: { type: 'artifact', artifactId: 'artifact-1' }, createdAt: 2_400 },
  );
  assert.equal(storedArtifact.created, true);
  assert.equal(a2a.appendA2AArtifact(scope, created.task.id, artifact('artifact-1')).created, false);
  assert.deepEqual(a2a.listA2AArtifacts(scope, created.task.id).map(item => item.artifactId), ['artifact-1']);

  a2a.appendA2ATaskEvent(scope, created.task.id, { type: 'progress', percent: 50 }, 2_500);
  const beforeFailedTransition = a2a.listA2ATaskEvents(scope, created.task.id);
  assert.deepEqual(beforeFailedTransition.map(item => item.seq), [1, 2, 3, 4, 5]);
  assert.throws(
    () => a2a.transitionA2ATask(scope, created.task.id, {
      state: TaskState.TASK_STATE_COMPLETED,
      event: { invalid: 1n },
      updatedAt: 2_600,
    }),
    error => error instanceof a2a.A2AStoreError && error.code === 'invalid_input',
  );
  assert.equal(a2a.getA2ATask(scope, created.task.id)?.state, TaskState.TASK_STATE_WORKING);
  assert.equal(a2a.listA2ATaskEvents(scope, created.task.id).length, beforeFailedTransition.length);

  a2a.transitionA2ATask(scope, created.task.id, {
    state: TaskState.TASK_STATE_COMPLETED,
    finalMessage: userMessage('final-message', created.task.contextId, created.task.id, 'done'),
    updatedAt: 2_700,
  });
  const completed = a2a.getA2ATask(scope, created.task.id);
  assert.equal(completed?.state, TaskState.TASK_STATE_COMPLETED);
  assert.equal(completed?.completedAt, 2_700);
  assert.deepEqual(a2a.listA2ATaskEvents(scope, created.task.id).map(item => item.seq), [1, 2, 3, 4, 5, 6]);
  assert.throws(
    () => a2a.transitionA2ATask(scope, created.task.id, { state: TaskState.TASK_STATE_FAILED }),
    error => error instanceof a2a.A2AStoreError && error.code === 'terminal',
  );

  a2a.transitionA2ATask(otherCallerScope, sameMessageOtherCaller.task.id, {
    state: TaskState.TASK_STATE_WORKING,
    updatedAt: 2_800,
  });
  a2a.transitionA2ATask(otherCallerScope, sameMessageOtherCaller.task.id, {
    state: TaskState.TASK_STATE_COMPLETED,
    updatedAt: 2_900,
  });

  const pageTaskIds = ['page-a', 'page-b', 'page-c'];
  for (const [index, id] of pageTaskIds.entries()) {
    a2a.createA2ATask({
      ...scope,
      id,
      contextId: 'context-page',
      messageId: `message-${id}`,
      createdAt: 3_000 + index,
    });
  }
  const firstPage = a2a.listA2ATasks(scope, { contextId: 'context-page', state: TaskState.TASK_STATE_SUBMITTED, pageSize: 2 });
  assert.equal(firstPage.tasks.length, 2);
  assert.ok(firstPage.nextCursor);
  const secondPage = a2a.listA2ATasks(scope, {
    contextId: 'context-page',
    state: TaskState.TASK_STATE_SUBMITTED,
    pageSize: 2,
    cursor: firstPage.nextCursor || undefined,
  });
  assert.equal(secondPage.tasks.length, 1);
  assert.equal(secondPage.nextCursor, null);
  assert.equal(new Set([...firstPage.tasks, ...secondPage.tasks].map(task => task.id)).size, 3);
  assert.equal(a2a.listA2ATasks(scope, { contextId: 'context-page', updatedAfter: 3_001 }).tasks.length, 2);
  assert.equal(a2a.listA2ATasks(scope, { contextId: 'context-page', pageSize: 0 }).tasks.length, 1);
  assert.throws(
    () => a2a.listA2ATasks(scope, { cursor: 'not-a-valid-cursor' }),
    error => error instanceof a2a.A2AStoreError && error.code === 'invalid_cursor',
  );

  for (const id of pageTaskIds) {
    a2a.transitionA2ATask(scope, id, { state: TaskState.TASK_STATE_WORKING, updatedAt: 3_100 });
    a2a.transitionA2ATask(scope, id, { state: TaskState.TASK_STATE_COMPLETED, updatedAt: 3_200 });
  }

  const restartSubmitted = a2a.createA2ATask({
    ...scope,
    id: 'restart-submitted',
    contextId: 'context-restart',
    messageId: 'restart-submitted-message',
    createdAt: 4_000,
  }).task;
  const restartWorking = a2a.createA2ATask({
    ...scope,
    id: 'restart-working',
    contextId: 'context-restart',
    messageId: 'restart-working-message',
    createdAt: 4_100,
  }).task;
  a2a.transitionA2ATask(scope, restartWorking.id, { state: TaskState.TASK_STATE_WORKING, updatedAt: 4_200 });
  const restartInput = a2a.createA2ATask({
    ...scope,
    id: 'restart-input',
    contextId: 'context-restart',
    messageId: 'restart-input-message',
    createdAt: 4_300,
  }).task;
  a2a.transitionA2ATask(scope, restartInput.id, { state: TaskState.TASK_STATE_WORKING, updatedAt: 4_400 });
  a2a.transitionA2ATask(scope, restartInput.id, { state: TaskState.TASK_STATE_INPUT_REQUIRED, updatedAt: 4_500 });

  const reconciled = a2a.reconcileInterruptedA2ATasks({ now: 5_000, reason: 'restart smoke interruption' });
  assert.equal(reconciled, 3);
  for (const taskId of [restartSubmitted.id, restartWorking.id, restartInput.id]) {
    const task = a2a.getA2ATask(scope, taskId);
    assert.equal(task?.state, TaskState.TASK_STATE_FAILED);
    assert.equal(task?.completedAt, 5_000);
    assert.deepEqual(task?.error, { code: 'AGENTMA_RESTART_INTERRUPTION', message: 'restart smoke interruption' });
    const events = a2a.listA2ATaskEvents(scope, taskId);
    assert.equal((events[events.length - 1].event).status.state, TaskState.TASK_STATE_FAILED);
  }
  const restartEventCounts = [restartSubmitted.id, restartWorking.id, restartInput.id]
    .map(taskId => a2a.listA2ATaskEvents(scope, taskId).length);
  assert.equal(a2a.reconcileInterruptedA2ATasks({ now: 6_000 }), 0);
  assert.deepEqual(
    [restartSubmitted.id, restartWorking.id, restartInput.id].map(taskId => a2a.listA2ATaskEvents(scope, taskId).length),
    restartEventCounts,
  );
  assert.equal(a2a.getA2ATask(scope, created.task.id)?.state, TaskState.TASK_STATE_COMPLETED);

  const startupHookTask = a2a.createA2ATask({
    ...scope,
    id: 'startup-hook-task',
    contextId: 'context-startup-hook',
    messageId: 'startup-hook-message',
    createdAt: 7_000,
  }).task;
  const startupProbe = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', "await import('./server-store.ts');"],
    {
      cwd: path.resolve(import.meta.dirname, '..'),
      env: { ...process.env, AGENTMA_DATA_DIR: tempDir },
      encoding: 'utf8',
    },
  );
  assert.equal(startupProbe.status, 0, startupProbe.stderr || startupProbe.stdout);
  assert.equal(a2a.getA2ATask(scope, startupHookTask.id)?.state, TaskState.TASK_STATE_FAILED);

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'schema',
      'scope-isolation',
      'message-id-idempotency',
      'message-history',
      'artifact-storage',
      'event-sequence',
      'transition-atomicity',
      'terminal-state-guard',
      'cursor-pagination',
      'restart-reconciliation',
      'startup-reconciliation-hook',
    ],
  }));
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
