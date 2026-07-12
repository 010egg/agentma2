import assert from 'node:assert/strict';

const baseUrl = process.env.AGENTMA_SMOKE_BASE_URL || 'http://127.0.0.1:3018';
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok && !options.allowError) {
    throw new Error(`${options.method || 'GET'} ${path} failed (${response.status}): ${data.message || data.error || 'unknown error'}`);
  }
  return { status: response.status, data };
}

const adminEmail = `eval-admin-${suffix}@gmail.com`;
const memberEmail = `eval-reviewer-${suffix}@gmail.com`;
const registered = await request('/api/auth/register', {
  method: 'POST',
  body: JSON.stringify({ name: 'Evaluation Admin', email: adminEmail, password: 'secret123' }),
});
assert.equal(registered.data.role, 'tenant_admin');
const adminToken = registered.data.token;

const member = await request('/api/users', {
  method: 'POST',
  token: adminToken,
  body: JSON.stringify({ name: 'Evaluation Reviewer', email: memberEmail, password: 'secret123', role: 'member' }),
});
assert.equal(member.data.role, 'member');

const memberLogin = await request('/api/auth/login', {
  method: 'POST',
  body: JSON.stringify({ email: memberEmail, password: 'secret123' }),
});
const memberToken = memberLogin.data.token;

const project = await request('/api/evaluations/projects', {
  method: 'POST', token: adminToken,
  body: JSON.stringify({ name: 'API smoke project', description: 'route test', type: 'qa' }),
});
const dataset = await request('/api/evaluations/datasets', {
  method: 'POST', token: adminToken,
  body: JSON.stringify({
    name: 'API smoke dataset', type: 'qa', source: 'json',
    cases: [
      { externalId: 'one', prompt: 'Return alpha', expectedAnswer: 'alpha' },
      { externalId: 'two', prompt: 'Return beta', assertions: [{ type: 'required_keyword', values: ['beta'], required: true }] },
    ],
  }),
});
const rubric = await request('/api/evaluations/rubrics', {
  method: 'POST', token: adminToken,
  body: JSON.stringify({
    name: 'API automatic rubric', type: 'qa', passThreshold: 70, autoWeight: 100, judgeWeight: 0,
    metrics: [
      { key: 'exact', label: 'Exact', weight: 60, enabled: true },
      { key: 'required_keyword', label: 'Keyword', weight: 40, enabled: true, required: true },
    ],
  }),
});
const run = await request('/api/evaluations/runs', {
  method: 'POST', token: adminToken,
  body: JSON.stringify({
    name: 'API smoke run',
    projectId: project.data.id,
    datasetVersionId: dataset.data.version.id,
    rubricId: rubric.data.id,
    reviewPolicy: 'single',
    reviewerSubs: [member.data.id],
    candidates: [{ source: 'offline', name: 'fixture', repeatCount: 1, offlineAnswers: { one: 'alpha', two: 'beta ready' } }],
  }),
});
assert.equal(run.data.status, 'draft');

const memberOverview = await request('/api/evaluations/overview', { token: memberToken });
assert.equal(memberOverview.data.projects.length, 0);
assert(memberOverview.data.runs.some(item => item.id === run.data.id));
const deniedProject = await request('/api/evaluations/projects', {
  method: 'POST', token: memberToken, allowError: true,
  body: JSON.stringify({ name: 'denied', type: 'qa' }),
});
assert.equal(deniedProject.status, 403);

await request(`/api/evaluations/runs/${run.data.id}/start`, { method: 'POST', token: adminToken, body: '{}' });
let report;
for (let attempt = 0; attempt < 50; attempt += 1) {
  report = (await request(`/api/evaluations/runs/${run.data.id}/report`, { token: memberToken })).data;
  if (report.run.status === 'awaiting_review') break;
  await new Promise(resolve => setTimeout(resolve, 100));
}
assert.equal(report.run.status, 'awaiting_review');
assert.equal(report.rankings[0].averageScore, 100);

const scopedOverview = await request(`/api/evaluations/overview?projectId=${project.data.id}`, { token: adminToken });
assert.equal(scopedOverview.data.metrics.projectId, project.data.id);
assert.equal(scopedOverview.data.metrics.candidateCaseTotal, 0);
assert.equal(scopedOverview.data.metrics.pendingEvidenceReviews, 2);

const firstAttempt = report.attempts[0];
await request(`/api/evaluations/runs/${run.data.id}/attempt-reviews`, {
  method: 'POST', token: memberToken,
  body: JSON.stringify({ attemptId: firstAttempt.id, decision: 'reject', comment: 'attempt override' }),
});
let granularReport = (await request(`/api/evaluations/runs/${run.data.id}/report`, { token: memberToken })).data;
assert.equal(granularReport.rankings[0].passRate, 0.5);
await request(`/api/evaluations/runs/${run.data.id}/case-reviews`, {
  method: 'POST', token: memberToken,
  body: JSON.stringify({ candidateId: firstAttempt.candidateId, caseId: firstAttempt.caseId, decision: 'approve', comment: 'case override' }),
});
granularReport = (await request(`/api/evaluations/runs/${run.data.id}/report`, { token: memberToken })).data;
assert.equal(granularReport.rankings[0].passRate, 1);
assert.equal(granularReport.reviewMatrix.summary.reviewed, 1);

const blockedDelete = await request(`/api/evaluations/projects/${project.data.id}`, {
  method: 'DELETE', token: adminToken, allowError: true,
  body: JSON.stringify({ confirmationName: project.data.name }),
});
assert.equal(blockedDelete.status, 409);

const disposable = await request('/api/evaluations/projects', {
  method: 'POST', token: adminToken,
  body: JSON.stringify({ name: `Disposable ${suffix}`, type: 'qa' }),
});
await request(`/api/evaluations/projects/${disposable.data.id}/archive`, { method: 'PATCH', token: adminToken, body: '{}' });
const restored = await request(`/api/evaluations/projects/${disposable.data.id}/restore`, { method: 'PATCH', token: adminToken, body: '{}' });
assert.equal(restored.data.archivedAt, null);
const deleted = await request(`/api/evaluations/projects/${disposable.data.id}`, {
  method: 'DELETE', token: adminToken,
  body: JSON.stringify({ confirmationName: disposable.data.name }),
});
assert.equal(deleted.data.deleted, true);

const reviewed = await request(`/api/evaluations/runs/${run.data.id}/review`, {
  method: 'POST', token: memberToken,
  body: JSON.stringify({ decision: 'approve', comment: 'API evidence checked' }),
});
assert.equal(reviewed.data.status, 'completed');
assert.equal(reviewed.data.reviewDecision, 'approved');
const completedOverview = await request(`/api/evaluations/overview?projectId=${project.data.id}`, { token: adminToken });
assert.equal(completedOverview.data.metrics.candidateCaseTotal, 2);
assert.equal(completedOverview.data.metrics.candidateCasePassed, 2);

console.log(JSON.stringify({
  ok: true,
  runId: run.data.id,
  checks: [
    'admin-crud', 'member-assignment-visibility', 'member-admin-denied', 'worker-execution',
    'offline-report', 'project-scoped-overview', 'attempt-review', 'case-review',
    'active-project-delete-blocked', 'project-archive-restore-delete', 'member-review', 'final-approval',
  ],
}));
