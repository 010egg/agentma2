import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentma-evaluation-smoke-'));
const db = new DatabaseSync(path.join(root, 'evaluation.sqlite'));
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE tenants (id TEXT PRIMARY KEY);
  INSERT INTO tenants (id) VALUES ('tenant-a'), ('tenant-b');
`);

const store = await import('../server-evaluation-store.ts');
const engine = await import('../server-evaluation-engine.ts');
const sandbox = await import('../server-evaluation-sandbox.ts');
store.initializeEvaluationStore(db);

const project = store.createEvaluationProject('tenant-a', 'admin-a', {
  name: 'QA regression',
  description: 'smoke',
  type: 'qa',
});
const createdDataset = store.createEvaluationDataset('tenant-a', 'admin-a', {
  name: 'Capital and format',
  type: 'qa',
  source: 'manual',
  cases: [
    { externalId: 'capital-fr', prompt: 'What is the capital of France?', expectedAnswer: 'Paris' },
    {
      externalId: 'structured',
      prompt: 'Return a short status.',
      assertions: [
        { type: 'required_keyword', values: ['ready', 'green'], required: true },
        { type: 'forbidden_keyword', values: ['failed'] },
      ],
    },
  ],
});
const rubric = store.createEvaluationRubric('tenant-a', 'admin-a', {
  name: 'Automatic smoke rubric',
  type: 'qa',
  passThreshold: 70,
  autoWeight: 100,
  judgeWeight: 0,
  metrics: [
    { key: 'exact', label: 'Exact', weight: 60, enabled: true },
    { key: 'required_keyword', label: 'Required', weight: 25, enabled: true, required: true },
    { key: 'forbidden_keyword', label: 'Forbidden', weight: 15, enabled: true },
  ],
});
const run = store.createEvaluationRun('tenant-a', { sub: 'admin-a', role: 'tenant_admin', quotaUserId: null }, {
  name: 'Offline smoke run',
  projectId: project.id,
  datasetVersionId: createdDataset.version.id,
  rubricId: rubric.id,
  reviewPolicy: 'single',
  reviewerSubs: ['reviewer-a'],
  candidates: [{
    source: 'offline',
    name: 'fixture',
    repeatCount: 1,
    offlineAnswers: {
      'capital-fr': 'Paris',
      structured: 'READY / GREEN',
    },
  }],
});
assert.equal(run.status, 'draft');
assert.equal(run.useMemory, false);
assert.equal(store.canAccessEvaluationRun('tenant-a', run.id, 'reviewer-a', false), true);
assert.equal(store.canAccessEvaluationRun('tenant-a', run.id, 'reviewer-b', false), false);
assert.equal(store.getEvaluationRun('tenant-b', run.id), null);

const memoryEnabledRun = store.createEvaluationRun('tenant-a', { sub: 'admin-a', role: 'tenant_admin', quotaUserId: null }, {
  name: 'Memory-enabled smoke run',
  projectId: project.id,
  datasetVersionId: createdDataset.version.id,
  rubricId: rubric.id,
  useMemory: true,
  reviewPolicy: 'single',
  reviewerSubs: ['reviewer-a'],
  candidates: [{
    source: 'offline',
    name: 'fixture',
    repeatCount: 1,
    offlineAnswers: { 'capital-fr': 'Paris', structured: 'READY / GREEN' },
  }],
});
assert.equal(memoryEnabledRun.useMemory, true);

const started = store.startEvaluationRun('tenant-a', run.id);
assert.equal(started.status, 'queued');
assert.equal(started.progress.executeTotal, 2);

for (;;) {
  const job = store.claimEvaluationJob('smoke-worker', 10_000);
  if (!job) break;
  const context = store.getEvaluationJobContext(job.id);
  assert(context);
  const output = context.candidate.offlineAnswers[context.evaluationCase.externalId];
  const result = engine.evaluateQaAnswer(context.evaluationCase, output, context.run.rubricSnapshot);
  store.completeEvaluationExecutionJob(job.id, {
    outputText: output,
    metrics: result.metrics,
    autoScore: result.score,
    passed: result.passed,
  });
}

const awaitingReview = store.getEvaluationRun('tenant-a', run.id);
assert.equal(awaitingReview.status, 'awaiting_review');
const report = store.getEvaluationReport('tenant-a', run.id);
assert.equal(report.rankings.length, 1);
assert.equal(report.rankings[0].attempts, 2);
assert.equal(report.rankings[0].averageScore, 100);
assert.equal(report.rankings[0].passRate, 1);

const firstAttempt = report.attempts[0];
store.submitEvaluationAttemptReview('tenant-a', run.id, 'reviewer-a', {
  attemptId: firstAttempt.id,
  decision: 'reject',
  comment: 'single attempt override',
});
const attemptOverridden = store.getEvaluationReport('tenant-a', run.id);
assert.equal(attemptOverridden.rankings[0].passRate, 0.5);
store.submitEvaluationCaseReview('tenant-a', run.id, 'reviewer-a', {
  candidateId: firstAttempt.candidateId,
  caseId: firstAttempt.caseId,
  decision: 'approve',
  comment: 'case aggregate override',
});
const caseOverridden = store.getEvaluationReport('tenant-a', run.id);
assert.equal(caseOverridden.rankings[0].passRate, 1);
assert.equal(caseOverridden.reviewMatrix.summary.reviewed, 1);

const reviewed = store.submitEvaluationReview('tenant-a', run.id, 'reviewer-a', {
  decision: 'approve',
  comment: 'evidence checked',
});
assert.equal(reviewed.status, 'completed');
assert.equal(reviewed.reviewDecision, 'approved');

const scopedMetrics = store.getEvaluationOverviewMetrics('tenant-a', { admin: true, projectId: project.id });
assert.equal(scopedMetrics.candidateCaseTotal, 2);
assert.equal(scopedMetrics.candidateCasePassed, 2);

const parallelRun = store.createEvaluationRun('tenant-a', { sub: 'admin-a', role: 'tenant_admin', quotaUserId: null }, {
  name: 'Parallel candidates',
  projectId: project.id,
  datasetVersionId: createdDataset.version.id,
  rubricId: rubric.id,
  concurrency: 2,
  reviewPolicy: 'single',
  reviewerSubs: ['reviewer-a'],
  candidates: [
    { source: 'offline', name: 'offline-one', repeatCount: 1, offlineAnswers: { 'capital-fr': 'Paris', structured: 'READY / GREEN' } },
    { source: 'offline', name: 'offline-two', repeatCount: 1, offlineAnswers: { 'capital-fr': 'Paris', structured: 'READY / GREEN' } },
  ],
});
assert.equal(parallelRun.concurrency, 2);
store.startEvaluationRun('tenant-a', parallelRun.id);
const parallelJobOne = store.claimEvaluationJob('parallel-worker-1', 10_000);
const parallelJobTwo = store.claimEvaluationJob('parallel-worker-2', 10_000);
assert(parallelJobOne);
assert(parallelJobTwo);
assert.equal(parallelJobOne.caseId, parallelJobTwo.caseId);
assert.notEqual(parallelJobOne.candidateId, parallelJobTwo.candidateId);
assert.equal(store.claimEvaluationJob('parallel-worker-3', 10_000), null);
store.cancelEvaluationRun('tenant-a', parallelRun.id);

const namedRun = store.createEvaluationRun('tenant-a', { sub: 'admin-a', role: 'tenant_admin', quotaUserId: null }, {
  name: 'Named online candidate',
  projectId: project.id,
  datasetVersionId: createdDataset.version.id,
  rubricId: rubric.id,
  reviewPolicy: 'single',
  reviewerSubs: ['reviewer-a'],
  candidates: [{
    source: 'online',
    agentId: 'agent-template-1',
    model: 'model-alpha',
    alias: 'baseline',
    snapshot: { id: 'agent-template-1', name: 'Research Agent' },
  }],
});
assert.equal(namedRun.candidates[0].name, 'Research Agent · model-alpha');
assert.equal(namedRun.candidates[0].alias, 'baseline');

const disposableProject = store.createEvaluationProject('tenant-a', 'admin-a', { name: 'Disposable project', type: 'qa' });
assert(store.archiveEvaluationProject('tenant-a', disposableProject.id).archivedAt);
assert.equal(store.restoreEvaluationProject('tenant-a', disposableProject.id).archivedAt, null);
const deletedProject = store.deleteEvaluationProject('tenant-a', disposableProject.id, 'Disposable project');
assert.equal(deletedProject.deletedRuns, 0);
assert.equal(store.getEvaluationProject('tenant-a', disposableProject.id), null);
assert.throws(
  () => store.deleteEvaluationProject('tenant-a', project.id, project.name),
  error => error?.code === 'project_has_active_runs',
);

const workspace = path.join(root, 'workspace');
fs.mkdirSync(workspace);
fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { build: 'echo build', test: 'echo test' } }));
const suggestions = sandbox.suggestEvaluationCommands(workspace);
assert(suggestions.some(item => item.key === 'build'));
assert(suggestions.some(item => item.key === 'test'));

const sandboxStatus = sandbox.getEvaluationSandboxStatus();
if (sandboxStatus.available) {
  const inside = await sandbox.runEvaluationCommand({ workspace, command: "printf 'inside' > inside.txt", timeoutMs: 5000 });
  assert.equal(inside.exitCode, 0);
  assert.equal(fs.readFileSync(path.join(workspace, 'inside.txt'), 'utf8'), 'inside');
  const outsidePath = path.join(root, 'outside.txt');
  const outside = await sandbox.runEvaluationCommand({ workspace, command: `printf 'outside' > '${outsidePath}'`, timeoutMs: 5000 });
  assert.notEqual(outside.exitCode, 0);
  assert.equal(fs.existsSync(outsidePath), false);
}

db.close();
fs.rmSync(root, { recursive: true, force: true });
console.log(JSON.stringify({
  ok: true,
  checks: [
    'tenant-isolation', 'dataset-version', 'evaluation-memory-default-off', 'evaluation-memory-explicit-on', 'offline-candidate', 'job-claim', 'automatic-scoring',
    'report-ranking', 'attempt-review-override', 'case-review-override', 'project-scoped-metrics',
    'parallel-candidate-claim', 'run-concurrency-limit', 'candidate-snapshot-name',
    'project-archive-restore-delete', 'active-project-delete-blocked', 'assigned-reviewer', 'final-approval', 'command-suggestions',
    ...(sandboxStatus.available ? ['sandbox-workspace-write', 'sandbox-outside-write-denied'] : ['sandbox-unavailable-fails-closed']),
  ],
}));
