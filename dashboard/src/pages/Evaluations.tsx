import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import LineIcon from '../components/LineIcon';
import ModelPicker from '../components/common/ModelPicker';
import { getAuthHeaders } from '../utils/client-runtime';

type EvaluationType = 'qa' | 'code_repair';
type RunStatus = 'draft' | 'queued' | 'running' | 'judging' | 'awaiting_review' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'archived';
type Tab = 'runs' | 'datasets' | 'rubrics' | 'reviews';

type Project = { id: string; name: string; description: string; type: EvaluationType; updatedAt: number; archivedAt: number | null };
type Dataset = { id: string; name: string; description: string; type: EvaluationType; latestVersion: number; latestVersionId: string; caseCount: number; updatedAt: number };
type Rubric = {
  id: string; name: string; description: string; type: EvaluationType; passThreshold: number;
  autoWeight: number; judgeWeight: number; judgeModel: string; builtin: boolean;
  metrics: Array<{ key: string; label: string; weight: number; enabled: boolean; required?: boolean }>;
};
type Candidate = { id: string; name: string; alias: string; source: 'online' | 'offline'; agentId: string; model: string; repeatCount: number };
type Progress = { total: number; queued: number; running: number; completed: number; failed: number; cancelled: number; executeTotal: number; judgeTotal: number };
type Run = {
  id: string; name: string; type: EvaluationType; status: RunStatus; projectId: string; datasetVersionId: string;
  rubricId: string; reviewPolicy: 'single' | 'consensus'; reviewRequiredCount: number; reviewDecision?: 'approved' | 'rejected';
  useMemory: boolean; concurrency: number; tenantConcurrencyLimit: number; reviewConflict: boolean; errorCode: string; errorMessage: string; createdAt: number; updatedAt: number;
  candidates?: Candidate[]; progress?: Progress;
};
type SandboxStatus = { available: boolean; provider: string; reason: string; networkDefault: 'deny' };
type OverviewMetrics = {
  projectId: string | null; totalRuns: number; completedRuns: number; runningRuns: number; pendingReviewRuns: number;
  candidateCaseTotal: number; candidateCasePassed: number; pendingEvidenceReviews: number; passRate: number | null;
  totalTokens: number; totalCostUsd: number; averageDurationMs: number;
};
type Overview = { projects: Project[]; datasets: Dataset[]; rubrics: Rubric[]; runs: Run[]; metrics: OverviewMetrics; sandbox: SandboxStatus; worker?: { running: boolean; activeJobs: number; concurrency: number; allowedConcurrency?: number } };
type Ranking = {
  candidateId: string; name: string; alias: string; source: string; model: string; attempts: number; completed: number; failed: number;
  passRate: number; averageScore: number; standardDeviation: number; totalTokens: number; totalCostUsd: number; averageDurationMs: number;
};
type Attempt = {
  id: string; candidateId: string; caseId: string; repetition: number; status: string; outputText: string;
  metrics: Array<{ key?: string; label?: string; score?: number; evidence?: string; applied?: boolean }>;
  autoScore: number | null; judgeScore: number | null; judgeReason: string; judgeConfidence: number | null;
  finalScore: number | null; passed: boolean | null; errorMessage: string;
};
type EvidenceDecision = 'approve' | 'reject' | 'needs_attention';
type EvidenceReview = { id: string; reviewerSub: string; decision: EvidenceDecision; comment: string; createdAt: number };
type ReviewAttempt = Attempt & { automaticDecision: EvidenceDecision; reviewDecision: EvidenceDecision | null; effectiveDecision: EvidenceDecision; reviews: EvidenceReview[] };
type ReviewGroup = {
  candidateId: string; candidateName: string; candidateAlias: string; caseId: string; caseExternalId: string; prompt: string;
  attempts: ReviewAttempt[]; automaticDecision: EvidenceDecision; decision: EvidenceDecision; reviewSource: 'case_review' | 'attempt_review' | 'automatic';
  reviews: EvidenceReview[]; humanReviewed: boolean;
};
type ReviewMatrix = { runId: string; groups: ReviewGroup[]; summary: { total: number; passed: number; rejected: number; needsAttention: number; reviewed: number; passRate: number | null } };
type Report = {
  run: Run;
  rankings: Ranking[];
  attempts: Attempt[];
  reviewMatrix: ReviewMatrix;
  assignments: Array<{ reviewerSub: string; status: string }>;
  reviews: Array<{ id: string; reviewerSub: string; decision: string; comment: string; createdAt: number }>;
};
type Agent = { id: string; name: string; model?: string; description?: string };
type Reviewer = { id?: string; email?: string; username?: string; name?: string; role?: string };
type CandidateForm = { id: string; source: 'online' | 'offline'; alias: string; name: string; agentId: string; model: string; repeatCount: number; offlineAnswersText: string };
type ManualCase = { id: string; prompt: string; expectedAnswer: string; requiredKeywords: string; forbiddenKeywords: string };

const EMPTY_OVERVIEW: Overview = {
  projects: [], datasets: [], rubrics: [], runs: [],
  metrics: { projectId: null, totalRuns: 0, completedRuns: 0, runningRuns: 0, pendingReviewRuns: 0, candidateCaseTotal: 0, candidateCasePassed: 0, pendingEvidenceReviews: 0, passRate: null, totalTokens: 0, totalCostUsd: 0, averageDurationMs: 0 },
  sandbox: { available: false, provider: 'unavailable', reason: '', networkDefault: 'deny' },
};
const ACTIVE_STATUSES = new Set<RunStatus>(['queued', 'running', 'judging']);

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function typeLabel(type: EvaluationType) {
  return type === 'qa' ? '问答评估' : '代码修复';
}

function statusLabel(status: RunStatus) {
  return ({
    draft: '草稿', queued: '排队中', running: '执行中', judging: '裁判中', awaiting_review: '待终审',
    paused: '已暂停', completed: '已完成', failed: '失败', cancelled: '已取消', archived: '已归档',
  } as Record<RunStatus, string>)[status];
}

function statusClass(status: RunStatus) {
  if (status === 'completed') return 'badge-success';
  if (status === 'failed' || status === 'cancelled') return 'badge-danger';
  if (status === 'awaiting_review' || status === 'paused') return 'badge-warning';
  if (status === 'queued' || status === 'running' || status === 'judging') return 'badge-info';
  return 'badge-muted';
}

function evidenceDecisionLabel(decision: EvidenceDecision) {
  if (decision === 'approve') return '通过';
  if (decision === 'reject') return '不通过';
  return '需关注';
}

function evidenceDecisionClass(decision: EvidenceDecision) {
  if (decision === 'approve') return 'passed';
  if (decision === 'reject') return 'failed';
  return 'weak';
}

function formatNumber(value: number, digits = 0) {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(value || 0);
}

function formatDate(value: number) {
  return value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '-';
}

function parseApiError(data: unknown, status: number) {
  const record = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : {};
  return (typeof record.message === 'string' && record.message)
    || (typeof record.error === 'string' && record.error)
    || `请求失败 (${status})`;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = getAuthHeaders(init.body ? { 'Content-Type': 'application/json' } : {});
  const response = await fetch(path, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(parseApiError(data, response.status));
  return data as T;
}

function csvRows(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { cell += '"'; index += 1; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      row.push(cell); cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(cell); cell = '';
      if (row.some(value => value.trim())) rows.push(row);
      row = [];
    } else cell += char;
  }
  row.push(cell);
  if (row.some(value => value.trim())) rows.push(row);
  return rows;
}

function assertionsForKeywords(required: string, forbidden: string) {
  const assertions: Array<Record<string, unknown>> = [];
  const requiredValues = required.split(/[，,\n]/).map(value => value.trim()).filter(Boolean);
  const forbiddenValues = forbidden.split(/[，,\n]/).map(value => value.trim()).filter(Boolean);
  if (requiredValues.length) assertions.push({ type: 'required_keyword', values: requiredValues, weight: 1 });
  if (forbiddenValues.length) assertions.push({ type: 'forbidden_keyword', values: forbiddenValues, weight: 1 });
  return assertions;
}

function parseImportedCases(format: 'json' | 'jsonl' | 'csv', text: string) {
  if (format === 'json') {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('JSON 顶层必须是数组');
    return parsed;
  }
  if (format === 'jsonl') return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => JSON.parse(line));
  const rows = csvRows(text);
  if (rows.length < 2) throw new Error('CSV 至少需要表头和一行数据');
  const headers = rows[0].map(header => header.trim());
  return rows.slice(1).map((values, index) => {
    const row = Object.fromEntries(headers.map((header, position) => [header, values[position] || '']));
    return {
      externalId: row.externalId || row.id || `case-${index + 1}`,
      prompt: row.prompt || row.question || row.issue,
      expectedAnswer: row.expectedAnswer || row.expected || '',
      referenceMaterial: row.referenceMaterial || row.reference || '',
      assertions: assertionsForKeywords(row.requiredKeywords || '', row.forbiddenKeywords || ''),
    };
  });
}

function downloadJson(filename: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function Evaluations() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'tenant_admin';
  const [overview, setOverview] = useState<Overview>(EMPTY_OVERVIEW);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [reviewers, setReviewers] = useState<Reviewer[]>([]);
  const [tab, setTab] = useState<Tab>('runs');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [modal, setModal] = useState<'project' | 'dataset' | 'rubric' | 'run' | null>(null);
  const [projectScope, setProjectScope] = useState(() => window.localStorage.getItem('agentma:evaluation-project') || '');
  const [deleteProjectTarget, setDeleteProjectTarget] = useState<Project | null>(null);
  const [deleteProjectConfirmation, setDeleteProjectConfirmation] = useState('');
  const [selectedRunId, setSelectedRunId] = useState('');
  const [report, setReport] = useState<Report | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [selectedAttempt, setSelectedAttempt] = useState<Attempt | null>(null);
  const [selectedGroupKey, setSelectedGroupKey] = useState('');

  const [projectForm, setProjectForm] = useState({ name: '', description: '', type: 'qa' as EvaluationType });
  const [datasetForm, setDatasetForm] = useState({ name: '', description: '', type: 'qa' as EvaluationType, mode: 'manual' as 'manual' | 'import', format: 'json' as 'json' | 'jsonl' | 'csv', importText: '' });
  const [manualCases, setManualCases] = useState<ManualCase[]>([{ id: 'case-1', prompt: '', expectedAnswer: '', requiredKeywords: '', forbiddenKeywords: '' }]);
  const [rubricForm, setRubricForm] = useState({ name: '', description: '', type: 'qa' as EvaluationType, passThreshold: 70, autoWeight: 60, judgeWeight: 40, judgeModel: '', judgePrompt: '' });
  const [runForm, setRunForm] = useState({ name: '', projectId: '', datasetVersionId: '', rubricId: '', useMemory: false, concurrency: 1, reviewPolicy: 'single' as 'single' | 'consensus', reviewerSubs: [] as string[], reviewRequiredCount: 2, maxTokens: '', maxCostUsd: '' });
  const [candidateForms, setCandidateForms] = useState<CandidateForm[]>([{ id: uid(), source: 'online', alias: '', name: '', agentId: '', model: '', repeatCount: 1, offlineAnswersText: '{}' }]);
  const [reviewForm, setReviewForm] = useState({ decision: 'approve' as 'approve' | 'reject', comment: '' });
  const [caseReviewForm, setCaseReviewForm] = useState({ decision: 'approve' as EvidenceDecision, comment: '' });
  const [attemptReviewForm, setAttemptReviewForm] = useState({ decision: 'approve' as EvidenceDecision, comment: '' });

  const loadOverview = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const query = isAdmin && projectScope ? `?projectId=${encodeURIComponent(projectScope)}` : '';
      const data = await api<Overview>(`/api/evaluations/overview${query}`);
      setOverview(data);
      if (isAdmin && (!projectScope || (projectScope !== 'all' && !data.projects.some(project => project.id === projectScope)))) {
        const nextScope = data.projects.find(project => !project.archivedAt)?.id || 'all';
        setProjectScope(nextScope);
        window.localStorage.setItem('agentma:evaluation-project', nextScope);
      }
      setError('');
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [isAdmin, projectScope]);

  const loadCatalogs = useCallback(async () => {
    if (!isAdmin) return;
    const [agentResult, modelResult, userResult] = await Promise.allSettled([
      api<Array<Record<string, unknown>>>('/api/agents'),
      api<unknown>('/api/provider-models'),
      api<Reviewer[]>('/api/users'),
    ]);
    if (agentResult.status === 'fulfilled') setAgents(agentResult.value.map(item => ({ id: String(item.id || ''), name: String(item.name || '未命名 Agent'), model: typeof item.model === 'string' ? item.model : '', description: typeof item.description === 'string' ? item.description : '' })));
    if (modelResult.status === 'fulfilled') {
      const raw = modelResult.value;
      const rawRecord = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      const items: unknown[] = Array.isArray(raw) ? raw : Array.isArray(rawRecord.models) ? rawRecord.models : [];
      setModels(Array.from(new Set(items.flatMap((item) => {
        if (typeof item === 'string') return [item];
        if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
        const record = item as Record<string, unknown>;
        if (typeof record.id === 'string') return [record.id];
        return typeof record.model === 'string' ? [record.model] : [];
      }))));
    }
    if (userResult.status === 'fulfilled') setReviewers(userResult.value);
  }, [isAdmin]);

  const loadReport = useCallback(async (runId: string, quiet = false) => {
    setSelectedRunId(runId);
    if (!quiet) setReportLoading(true);
    try {
      const data = await api<Report>(`/api/evaluations/runs/${encodeURIComponent(runId)}/report`);
      setReport(data);
      setError('');
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      if (!quiet) setReportLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadOverview(); void loadCatalogs(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadOverview, loadCatalogs]);

  useEffect(() => {
    if (!projectScope) return;
    window.localStorage.setItem('agentma:evaluation-project', projectScope);
  }, [projectScope]);

  useEffect(() => {
    if (!overview.runs.some(run => ACTIVE_STATUSES.has(run.status))) return;
    const timer = window.setInterval(() => { void loadOverview(true); if (selectedRunId) void loadReport(selectedRunId, true); }, 2500);
    return () => window.clearInterval(timer);
  }, [overview.runs, selectedRunId, loadOverview, loadReport]);

  const activeRun = overview.runs.find(run => run.id === selectedRunId) || report?.run || null;
  const pendingReviews = overview.metrics.pendingReviewRuns;
  const selectedProject = overview.projects.find(project => project.id === projectScope) || null;
  const selectedReviewGroup = report?.reviewMatrix.groups.find(group => `${group.candidateId}:${group.caseId}` === selectedGroupKey) || null;
  const changeProjectScope = (value: string) => {
    setProjectScope(value);
    setSelectedRunId('');
    setReport(null);
    setSelectedGroupKey('');
    setSelectedAttempt(null);
  };

  const visibleDatasets = useMemo(() => overview.datasets.filter(dataset => {
    const project = overview.projects.find(item => item.id === runForm.projectId);
    return !project || dataset.type === project.type;
  }), [overview.datasets, overview.projects, runForm.projectId]);
  const visibleRubrics = useMemo(() => overview.rubrics.filter(rubric => {
    const project = overview.projects.find(item => item.id === runForm.projectId);
    return !project || rubric.type === project.type;
  }), [overview.rubrics, overview.projects, runForm.projectId]);

  const mutate = async (operation: () => Promise<unknown>, success: string) => {
    setBusy(true); setError(''); setNotice('');
    try {
      await operation();
      setNotice(success);
      setModal(null);
      await loadOverview(true);
    } catch (mutationError) {
      setError((mutationError as Error).message);
    } finally { setBusy(false); }
  };

  const createProject = () => mutate(() => api('/api/evaluations/projects', { method: 'POST', body: JSON.stringify(projectForm) }), '评测项目已创建');
  const archiveProject = (project: Project) => mutate(
    () => api(`/api/evaluations/projects/${project.id}/archive`, { method: 'PATCH', body: '{}' }),
    '评测项目已归档',
  );
  const restoreProject = (project: Project) => mutate(
    () => api(`/api/evaluations/projects/${project.id}/restore`, { method: 'PATCH', body: '{}' }),
    '评测项目已恢复',
  );
  const deleteProject = () => {
    if (!deleteProjectTarget) return;
    const target = deleteProjectTarget;
    mutate(() => api(`/api/evaluations/projects/${target.id}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirmationName: deleteProjectConfirmation }),
    }), '评测项目已永久删除').then(() => {
      setDeleteProjectTarget(null);
      setDeleteProjectConfirmation('');
      if (projectScope === target.id) changeProjectScope('all');
    });
  };

  const createDataset = () => mutate(async () => {
    const cases = datasetForm.mode === 'manual'
      ? manualCases.map((item, index) => ({
        externalId: item.id || `case-${index + 1}`,
        prompt: item.prompt,
        expectedAnswer: item.expectedAnswer,
        assertions: assertionsForKeywords(item.requiredKeywords, item.forbiddenKeywords),
      }))
      : parseImportedCases(datasetForm.format, datasetForm.importText);
    return api('/api/evaluations/datasets', {
      method: 'POST',
      body: JSON.stringify({ name: datasetForm.name, description: datasetForm.description, type: datasetForm.type, source: datasetForm.mode === 'manual' ? 'manual' : datasetForm.format, cases }),
    });
  }, '测试集版本已创建');

  const createRubric = () => mutate(() => api('/api/evaluations/rubrics', { method: 'POST', body: JSON.stringify(rubricForm) }), '评分模板已创建');

  const createRun = () => mutate(async () => {
    const candidates = candidateForms.map(candidate => ({
      source: candidate.source,
      name: candidate.name,
      alias: candidate.alias,
      agentId: candidate.agentId,
      model: candidate.model,
      repeatCount: candidate.repeatCount,
      offlineAnswers: candidate.source === 'offline' ? JSON.parse(candidate.offlineAnswersText || '{}') : undefined,
    }));
    return api('/api/evaluations/runs', {
      method: 'POST',
      body: JSON.stringify({
        ...runForm,
        concurrency: runForm.concurrency,
        candidates,
        budget: {
          ...(runForm.maxTokens ? { maxTokens: Number(runForm.maxTokens) } : {}),
          ...(runForm.maxCostUsd ? { maxCostUsd: Number(runForm.maxCostUsd) } : {}),
        },
      }),
    });
  }, '评测运行草稿已创建');

  const startRun = (run: Run) => mutate(() => api(`/api/evaluations/runs/${run.id}/start`, { method: 'POST', body: '{}' }), '评测已进入队列');
  const cancelRun = (run: Run) => mutate(() => api(`/api/evaluations/runs/${run.id}/cancel`, { method: 'POST', body: '{}' }), '评测已取消');

  const submitReview = () => {
    if (!activeRun) return;
    mutate(() => api(`/api/evaluations/runs/${activeRun.id}/review`, {
      method: 'POST',
      body: JSON.stringify({ ...reviewForm, finalize: isAdmin }),
    }), reviewForm.decision === 'approve' ? '终审已通过' : '终审已驳回').then(() => { void loadReport(activeRun.id, true); });
  };

  const submitCaseReview = () => {
    if (!report || !selectedReviewGroup) return;
    mutate(() => api(`/api/evaluations/runs/${report.run.id}/case-reviews`, {
      method: 'POST',
      body: JSON.stringify({
        candidateId: selectedReviewGroup.candidateId,
        caseId: selectedReviewGroup.caseId,
        ...caseReviewForm,
      }),
    }), '用例审核结果已提交').then(() => { void loadReport(report.run.id, true); });
  };

  const submitAttemptReview = () => {
    if (!report || !selectedAttempt) return;
    mutate(() => api(`/api/evaluations/runs/${report.run.id}/attempt-reviews`, {
      method: 'POST',
      body: JSON.stringify({ attemptId: selectedAttempt.id, ...attemptReviewForm }),
    }), '单次尝试审核结果已提交').then(() => { void loadReport(report.run.id, true); });
  };

  const openRunModal = () => {
    const project = overview.projects.find(item => item.id === projectScope && !item.archivedAt)
      || overview.projects.find(item => !item.archivedAt);
    const dataset = overview.datasets.find(item => !project || item.type === project.type);
    const rubric = overview.rubrics.find(item => !project || item.type === project.type);
    const firstAgent = agents[0];
    const firstModel = firstAgent?.model || models[0] || '';
    setRunForm({ name: '', projectId: project?.id || '', datasetVersionId: dataset?.latestVersionId || '', rubricId: rubric?.id || '', useMemory: false, concurrency: 1, reviewPolicy: 'single', reviewerSubs: user?.id ? [user.id] : [], reviewRequiredCount: 2, maxTokens: '', maxCostUsd: '' });
    setCandidateForms([{ id: uid(), source: 'online', alias: '', name: '', agentId: firstAgent?.id || '', model: firstModel, repeatCount: 1, offlineAnswersText: '{}' }]);
    setModal('run');
  };

  const updateCandidate = (id: string, patch: Partial<CandidateForm>) => setCandidateForms(forms => forms.map(form => form.id === id ? { ...form, ...patch } : form));
  const reviewerKey = (reviewer: Reviewer) => reviewer.id || reviewer.email || '';
  const reviewerLabel = (reviewer: Reviewer) => reviewer.username || reviewer.name || reviewer.email || reviewer.id || '成员';

  return (
    <div className="evaluation-page">
      <div className="evaluation-toolbar">
        <div className="evaluation-tabs" role="tablist" aria-label="评估系统视图">
          {((isAdmin ? [
            ['runs', '运行'], ['datasets', '测试集'], ['rubrics', '评分模板'], ['reviews', `终审${pendingReviews ? ` ${pendingReviews}` : ''}`],
          ] : [
            ['runs', '运行'], ['reviews', `终审${pendingReviews ? ` ${pendingReviews}` : ''}`],
          ]) as Array<[Tab, string]>).map(([key, label]) => (
            <button key={key} type="button" className={tab === key ? 'active' : ''} onClick={() => setTab(key)} role="tab" aria-selected={tab === key}>{label}</button>
          ))}
        </div>
        <div className="evaluation-actions">
          {isAdmin && <div className="evaluation-project-scope">
            <select value={projectScope || 'all'} onChange={event => changeProjectScope(event.target.value)} aria-label="项目范围">
              <option value="all">全部项目</option>
              {overview.projects.map(project => <option key={project.id} value={project.id}>{project.name}{project.archivedAt ? '（已归档）' : ''}</option>)}
            </select>
            {selectedProject && (selectedProject.archivedAt
              ? <button className="btn btn-sm" type="button" disabled={busy} onClick={() => { void restoreProject(selectedProject); }}>恢复</button>
              : <button className="btn btn-sm" type="button" disabled={busy} onClick={() => { void archiveProject(selectedProject); }}>归档</button>)}
            {selectedProject && <button className="icon-btn danger" type="button" disabled={busy} onClick={() => { setDeleteProjectTarget(selectedProject); setDeleteProjectConfirmation(''); }} title="永久删除项目" aria-label="永久删除项目"><LineIcon name="trash" /></button>}
          </div>}
          <button className="icon-btn" type="button" onClick={() => { void loadOverview(); }} title="刷新" aria-label="刷新"><LineIcon name="refresh" /></button>
          {isAdmin && <button className="btn btn-primary" type="button" onClick={openRunModal}><LineIcon name="plus" />新建运行</button>}
        </div>
      </div>

      {(error || notice) && <div className={`evaluation-alert ${error ? 'error' : 'success'}`}><span>{error || notice}</span><button type="button" onClick={() => { setError(''); setNotice(''); }} aria-label="关闭"><LineIcon name="x" /></button></div>}

      <section className="evaluation-kpis" aria-label="评测概览">
        <div><span>运行总数</span><strong>{formatNumber(overview.metrics.totalRuns)}</strong></div>
        <div><span>进行中</span><strong>{formatNumber(overview.metrics.runningRuns)}</strong></div>
        {selectedProject
          ? <div><span>样本通过率</span><strong>{overview.metrics.passRate == null ? '-' : `${formatNumber(overview.metrics.passRate * 100, 1)}%`}</strong></div>
          : <div><span>待终审</span><strong>{formatNumber(overview.metrics.pendingReviewRuns)}</strong></div>}
        {selectedProject
          ? <div><span>待审核样本</span><strong>{formatNumber(overview.metrics.pendingEvidenceReviews)}</strong></div>
          : <div><span>已完成</span><strong>{formatNumber(overview.metrics.completedRuns)}</strong></div>}
        <div><span>Token / 成本</span><strong>{formatNumber(overview.metrics.totalTokens)} / ${overview.metrics.totalCostUsd.toFixed(2)}</strong></div>
      </section>

      {tab === 'runs' && (
        <section className="evaluation-section">
          <div className="evaluation-section-head">
            <div><h2>评测运行</h2><span>{selectedProject?.name || '全部项目'} · {overview.worker ? `Worker ${overview.worker.activeJobs}/${overview.worker.concurrency}` : '审核视图'} · 沙箱{overview.sandbox.available ? '可用' : '未配置'}</span></div>
            {isAdmin && <div className="evaluation-inline-actions"><button className="btn btn-sm" onClick={() => setModal('project')}><LineIcon name="plus" />项目</button></div>}
          </div>
          <div className="evaluation-run-layout">
            <div className="evaluation-table-panel">
              <div className="table-wrap">
                <table className="evaluation-table">
                  <thead><tr><th>运行</th><th>类型</th><th>进度</th><th>状态</th><th>更新时间</th><th><span className="sr-only">操作</span></th></tr></thead>
                  <tbody>
                    {!loading && overview.runs.length === 0 && <tr><td colSpan={6} className="evaluation-empty">暂无评测运行</td></tr>}
                    {overview.runs.map(run => {
                      const progress = run.progress;
                      const terminal = (progress?.completed || 0) + (progress?.failed || 0) + (progress?.cancelled || 0);
                      const percent = progress?.total ? Math.round((terminal / progress.total) * 100) : 0;
                      return (
                        <tr key={run.id} className={selectedRunId === run.id ? 'selected' : ''} onClick={() => { void loadReport(run.id); }}>
                          <td><strong>{run.name}</strong><span>{run.candidates?.length || 0} 个候选 · 并发 {run.concurrency || 1} · 记忆{run.useMemory ? '开启' : '关闭'}</span></td>
                          <td><span className="evaluation-type-mark">{run.type === 'qa' ? 'QA' : 'CODE'}</span>{typeLabel(run.type)}</td>
                          <td><div className="evaluation-progress"><span><i style={{ width: `${percent}%` }} /></span><em>{progress?.total ? `${terminal}/${progress.total}` : '-'}</em></div></td>
                          <td><span className={`badge ${statusClass(run.status)}`}>{statusLabel(run.status)}</span>{run.reviewConflict && <span className="badge badge-danger">有分歧</span>}</td>
                          <td>{formatDate(run.updatedAt)}</td>
                          <td className="evaluation-row-actions" onClick={event => event.stopPropagation()}>
                            {isAdmin && run.status === 'draft' && <button className="icon-btn" type="button" disabled={run.type === 'code_repair'} onClick={() => { void startRun(run); }} title={run.type === 'code_repair' ? '代码修复流水线尚未开放' : '启动'} aria-label="启动"><LineIcon name="play" /></button>}
                            {isAdmin && ACTIVE_STATUSES.has(run.status) && <button className="icon-btn danger" type="button" onClick={() => { void cancelRun(run); }} title="取消" aria-label="取消"><LineIcon name="x" /></button>}
                            <button className="icon-btn" type="button" onClick={() => { void loadReport(run.id); }} title="查看报告" aria-label="查看报告"><LineIcon name="chevronRight" /></button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <aside className={`evaluation-detail${activeRun ? ' open' : ''}`}>
              {!activeRun ? <div className="evaluation-detail-empty"><LineIcon name="chart" /><span>选择运行查看排行与证据</span></div> : (
                <>
                  <div className="evaluation-detail-head">
                    <div><span className="evaluation-detail-kicker">{typeLabel(activeRun.type)}</span><h2>{activeRun.name}</h2></div>
                    <button className="icon-btn" type="button" onClick={() => { setSelectedRunId(''); setReport(null); }} aria-label="关闭详情"><LineIcon name="x" /></button>
                  </div>
                  {reportLoading && <div className="evaluation-loading">加载报告...</div>}
                  {report && (
                    <>
                      <div className="evaluation-detail-status">
                        <span className={`badge ${statusClass(report.run.status)}`}>{statusLabel(report.run.status)}</span>
                        <span>{report.run.progress?.completed || 0} 完成</span>
                        <span>{report.run.progress?.failed || 0} 失败</span>
                        <span>并发 {report.run.progress?.running || 0}/{report.run.concurrency || 1}</span>
                        <button className="icon-btn" type="button" onClick={() => downloadJson(`${report.run.name}-report.json`, report)} title="导出 JSON" aria-label="导出 JSON"><LineIcon name="download" /></button>
                      </div>
                      {report.run.errorMessage && <div className="evaluation-run-warning">{report.run.errorMessage}</div>}
                      <div className="evaluation-ranking">
                        <div className="evaluation-subhead"><h3>候选排行</h3><span>综合分 / 稳定性 / 成本</span></div>
                        {report.rankings.map((ranking, index) => (
                          <div className="evaluation-rank-row" key={ranking.candidateId}>
                            <span className="evaluation-rank-index">{index + 1}</span>
                            <div><strong>{ranking.name}</strong><span>{ranking.alias ? `${ranking.alias} · ` : ''}{ranking.model || ranking.source}</span></div>
                            <div className="evaluation-rank-score"><strong>{ranking.averageScore.toFixed(1)}</strong><span>± {ranking.standardDeviation.toFixed(1)}</span></div>
                            <div className="evaluation-rank-meta"><span>{Math.round(ranking.passRate * 100)}% 通过</span><span>{formatNumber(ranking.totalTokens)} tok</span><span>${ranking.totalCostUsd.toFixed(3)}</span></div>
                          </div>
                        ))}
                      </div>
                      <div className="evaluation-attempts">
                        <div className="evaluation-subhead"><h3>证据审核</h3><span>{report.reviewMatrix.summary.reviewed}/{report.reviewMatrix.summary.total} 已人工审核</span></div>
                        <div className="evaluation-review-matrix">
                          {report.reviewMatrix.groups.map(group => (
                            <button
                              key={`${group.candidateId}:${group.caseId}`}
                              type="button"
                              className={`evaluation-review-cell ${evidenceDecisionClass(group.decision)}`}
                              onClick={() => {
                                setSelectedGroupKey(`${group.candidateId}:${group.caseId}`);
                                setSelectedAttempt(null);
                                setCaseReviewForm({ decision: group.decision, comment: group.reviews[0]?.comment || '' });
                              }}
                            >
                              <span>{group.caseExternalId}</span>
                              <strong>{group.candidateName}</strong>
                              {group.candidateAlias && <small>{group.candidateAlias}</small>}
                              <em>{group.attempts.length} 次 · {group.humanReviewed ? '已审' : '未审'} · {evidenceDecisionLabel(group.decision)}</em>
                            </button>
                          ))}
                        </div>
                      </div>
                      {report.run.status === 'awaiting_review' && (
                        <div className="evaluation-review-box">
                          <div className="evaluation-subhead"><h3>人工终审</h3><span>{report.assignments.filter(item => item.status === 'submitted').length}/{report.assignments.length}</span></div>
                          <div className="evaluation-review-choice">
                            <button className={reviewForm.decision === 'approve' ? 'active approve' : ''} type="button" onClick={() => setReviewForm(form => ({ ...form, decision: 'approve' }))}><LineIcon name="check" />通过</button>
                            <button className={reviewForm.decision === 'reject' ? 'active reject' : ''} type="button" onClick={() => setReviewForm(form => ({ ...form, decision: 'reject' }))}><LineIcon name="x" />驳回</button>
                          </div>
                          <textarea value={reviewForm.comment} onChange={event => setReviewForm(form => ({ ...form, comment: event.target.value }))} placeholder="终审备注" rows={3} />
                          <button className="btn btn-primary" type="button" disabled={busy} onClick={submitReview}>{busy ? '提交中...' : '提交终审'}</button>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </aside>
          </div>
        </section>
      )}

      {tab === 'datasets' && (
        <section className="evaluation-section">
          <div className="evaluation-section-head"><div><h2>测试集</h2><span>版本化用例</span></div>{isAdmin && <button className="btn btn-primary" type="button" onClick={() => setModal('dataset')}><LineIcon name="plus" />新建测试集</button>}</div>
          <div className="table-wrap"><table className="evaluation-table"><thead><tr><th>名称</th><th>类型</th><th>版本</th><th>用例</th><th>更新时间</th></tr></thead><tbody>
            {overview.datasets.length === 0 && <tr><td colSpan={5} className="evaluation-empty">暂无测试集</td></tr>}
            {overview.datasets.map(dataset => <tr key={dataset.id}><td><strong>{dataset.name}</strong><span>{dataset.description || '无描述'}</span></td><td>{typeLabel(dataset.type)}</td><td>v{dataset.latestVersion}</td><td>{formatNumber(dataset.caseCount)}</td><td>{formatDate(dataset.updatedAt)}</td></tr>)}
          </tbody></table></div>
        </section>
      )}

      {tab === 'rubrics' && (
        <section className="evaluation-section">
          <div className="evaluation-section-head"><div><h2>评分模板</h2><span>指标、权重与裁判模型</span></div>{isAdmin && <button className="btn btn-primary" type="button" onClick={() => setModal('rubric')}><LineIcon name="plus" />新建模板</button>}</div>
          <div className="evaluation-rubric-list">
            {overview.rubrics.map(rubric => (
              <article className="evaluation-rubric-row" key={rubric.id}>
                <div><div className="evaluation-rubric-title"><strong>{rubric.name}</strong>{rubric.builtin && <span className="badge badge-muted">内置</span>}</div><span>{typeLabel(rubric.type)} · 通过线 {rubric.passThreshold}</span></div>
                <div className="evaluation-weight-bar"><span style={{ width: `${rubric.autoWeight}%` }} /><i style={{ width: `${rubric.judgeWeight}%` }} /></div>
                <div className="evaluation-rubric-weights"><span>自动 {rubric.autoWeight}</span><span>裁判 {rubric.judgeWeight}</span><span>{rubric.judgeModel || '未配置裁判'}</span></div>
                <div className="evaluation-rubric-metrics">{rubric.metrics.filter(metric => metric.enabled).map(metric => <span key={metric.key}>{metric.label} {metric.weight}</span>)}</div>
              </article>
            ))}
          </div>
        </section>
      )}

      {tab === 'reviews' && (
        <section className="evaluation-section">
          <div className="evaluation-section-head"><div><h2>终审队列</h2><span>低置信度、失败与分歧运行</span></div></div>
          <div className="table-wrap"><table className="evaluation-table"><thead><tr><th>运行</th><th>类型</th><th>候选</th><th>风险</th><th>更新时间</th><th /></tr></thead><tbody>
            {overview.runs.filter(run => run.status === 'awaiting_review' || run.reviewConflict).length === 0 && <tr><td colSpan={6} className="evaluation-empty">暂无待终审运行</td></tr>}
            {overview.runs.filter(run => run.status === 'awaiting_review' || run.reviewConflict).map(run => <tr key={run.id}><td><strong>{run.name}</strong><span>{run.errorMessage || '自动与裁判阶段已结束'}</span></td><td>{typeLabel(run.type)}</td><td>{run.candidates?.length || 0}</td><td>{run.reviewConflict ? <span className="badge badge-danger">审核分歧</span> : run.progress?.failed ? <span className="badge badge-warning">{run.progress.failed} 失败</span> : <span className="badge badge-info">待签署</span>}</td><td>{formatDate(run.updatedAt)}</td><td><button className="btn btn-sm" onClick={() => { setTab('runs'); void loadReport(run.id); }}>审核</button></td></tr>)}
          </tbody></table></div>
        </section>
      )}

      {modal && (
        <div className="evaluation-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setModal(null); }}>
          <div className="evaluation-modal" role="dialog" aria-modal="true" aria-label={modal}>
            <div className="evaluation-modal-head"><div><span>evaluation console</span><h2>{modal === 'project' ? '新建评测项目' : modal === 'dataset' ? '新建测试集' : modal === 'rubric' ? '新建评分模板' : '新建评测运行'}</h2></div><button className="icon-btn" type="button" onClick={() => setModal(null)} aria-label="关闭"><LineIcon name="x" /></button></div>

            {modal === 'project' && <div className="evaluation-modal-body">
              <div className="evaluation-field"><label>项目名称</label><input value={projectForm.name} onChange={event => setProjectForm(form => ({ ...form, name: event.target.value }))} autoFocus /></div>
              <div className="evaluation-grid-2"><div className="evaluation-field"><label>类型</label><select value={projectForm.type} onChange={event => setProjectForm(form => ({ ...form, type: event.target.value as EvaluationType }))}><option value="qa">问答评估</option><option value="code_repair">代码修复</option></select></div><div /></div>
              <div className="evaluation-field"><label>描述</label><textarea rows={4} value={projectForm.description} onChange={event => setProjectForm(form => ({ ...form, description: event.target.value }))} /></div>
            </div>}

            {modal === 'dataset' && <div className="evaluation-modal-body">
              <div className="evaluation-grid-2"><div className="evaluation-field"><label>测试集名称</label><input value={datasetForm.name} onChange={event => setDatasetForm(form => ({ ...form, name: event.target.value }))} /></div><div className="evaluation-field"><label>类型</label><select value={datasetForm.type} onChange={event => setDatasetForm(form => ({ ...form, type: event.target.value as EvaluationType }))}><option value="qa">问答评估</option><option value="code_repair">代码修复</option></select></div></div>
              <div className="evaluation-field"><label>描述</label><input value={datasetForm.description} onChange={event => setDatasetForm(form => ({ ...form, description: event.target.value }))} /></div>
              <div className="evaluation-segmented"><button className={datasetForm.mode === 'manual' ? 'active' : ''} onClick={() => setDatasetForm(form => ({ ...form, mode: 'manual' }))}>手工录入</button><button className={datasetForm.mode === 'import' ? 'active' : ''} onClick={() => setDatasetForm(form => ({ ...form, mode: 'import' }))}>批量导入</button></div>
              {datasetForm.mode === 'manual' ? <div className="evaluation-case-editor">
                {manualCases.map((item, index) => <div className="evaluation-case-row" key={`${index}-${item.id}`}>
                  <div className="evaluation-case-index">{String(index + 1).padStart(2, '0')}</div>
                  <div className="evaluation-case-fields"><div className="evaluation-grid-2"><div className="evaluation-field"><label>用例 ID</label><input value={item.id} onChange={event => setManualCases(rows => rows.map((row, position) => position === index ? { ...row, id: event.target.value } : row))} /></div><div className="evaluation-field"><label>标准答案</label><input value={item.expectedAnswer} onChange={event => setManualCases(rows => rows.map((row, position) => position === index ? { ...row, expectedAnswer: event.target.value } : row))} /></div></div><div className="evaluation-field"><label>{datasetForm.type === 'qa' ? '问题' : '修复任务'}</label><textarea rows={3} value={item.prompt} onChange={event => setManualCases(rows => rows.map((row, position) => position === index ? { ...row, prompt: event.target.value } : row))} /></div><div className="evaluation-grid-2"><div className="evaluation-field"><label>必含关键词</label><input value={item.requiredKeywords} onChange={event => setManualCases(rows => rows.map((row, position) => position === index ? { ...row, requiredKeywords: event.target.value } : row))} /></div><div className="evaluation-field"><label>禁用关键词</label><input value={item.forbiddenKeywords} onChange={event => setManualCases(rows => rows.map((row, position) => position === index ? { ...row, forbiddenKeywords: event.target.value } : row))} /></div></div></div>
                  {manualCases.length > 1 && <button className="icon-btn danger" type="button" onClick={() => setManualCases(rows => rows.filter((_, position) => position !== index))} aria-label="删除用例"><LineIcon name="trash" /></button>}
                </div>)}
                <button className="btn btn-sm" type="button" onClick={() => setManualCases(rows => [...rows, { id: `case-${rows.length + 1}`, prompt: '', expectedAnswer: '', requiredKeywords: '', forbiddenKeywords: '' }])}><LineIcon name="plus" />添加用例</button>
              </div> : <><div className="evaluation-grid-2"><div className="evaluation-field"><label>格式</label><select value={datasetForm.format} onChange={event => setDatasetForm(form => ({ ...form, format: event.target.value as 'json' | 'jsonl' | 'csv' }))}><option value="json">JSON</option><option value="jsonl">JSONL</option><option value="csv">CSV</option></select></div><div /></div><div className="evaluation-field"><label>数据</label><textarea className="evaluation-code-input" rows={14} value={datasetForm.importText} onChange={event => setDatasetForm(form => ({ ...form, importText: event.target.value }))} placeholder={datasetForm.format === 'csv' ? 'id,prompt,expectedAnswer,requiredKeywords' : '[{"id":"q1","prompt":"...","expectedAnswer":"..."}]'} /></div></>}
            </div>}

            {modal === 'rubric' && <div className="evaluation-modal-body">
              <div className="evaluation-grid-2"><div className="evaluation-field"><label>模板名称</label><input value={rubricForm.name} onChange={event => setRubricForm(form => ({ ...form, name: event.target.value }))} /></div><div className="evaluation-field"><label>类型</label><select value={rubricForm.type} onChange={event => setRubricForm(form => ({ ...form, type: event.target.value as EvaluationType }))}><option value="qa">问答评估</option><option value="code_repair">代码修复</option></select></div></div>
              <div className="evaluation-grid-3"><div className="evaluation-field"><label>通过线</label><input type="number" min="0" max="100" value={rubricForm.passThreshold} onChange={event => setRubricForm(form => ({ ...form, passThreshold: Number(event.target.value) }))} /></div><div className="evaluation-field"><label>自动权重</label><input type="number" min="0" max="100" value={rubricForm.autoWeight} onChange={event => setRubricForm(form => ({ ...form, autoWeight: Number(event.target.value) }))} /></div><div className="evaluation-field"><label>裁判权重</label><input type="number" min="0" max="100" value={rubricForm.judgeWeight} onChange={event => setRubricForm(form => ({ ...form, judgeWeight: Number(event.target.value) }))} /></div></div>
              <div className="evaluation-field"><label>裁判模型</label><ModelPicker value={rubricForm.judgeModel} models={models} allowEmpty emptyLabel="不使用裁判模型" placeholder="选择裁判模型" onChange={judgeModel => setRubricForm(form => ({ ...form, judgeModel }))} /></div>
              <div className="evaluation-field"><label>裁判量表</label><textarea rows={5} value={rubricForm.judgePrompt} onChange={event => setRubricForm(form => ({ ...form, judgePrompt: event.target.value }))} /></div>
              <div className="evaluation-field"><label>描述</label><input value={rubricForm.description} onChange={event => setRubricForm(form => ({ ...form, description: event.target.value }))} /></div>
            </div>}

            {modal === 'run' && <div className="evaluation-modal-body evaluation-run-form">
              <div className="evaluation-grid-2"><div className="evaluation-field"><label>运行名称</label><input value={runForm.name} onChange={event => setRunForm(form => ({ ...form, name: event.target.value }))} /></div><div className="evaluation-field"><label>评测项目</label><select value={runForm.projectId} onChange={event => { const projectId = event.target.value; const project = overview.projects.find(item => item.id === projectId); const dataset = overview.datasets.find(item => item.type === project?.type); const rubric = overview.rubrics.find(item => item.type === project?.type); setRunForm(form => ({ ...form, projectId, datasetVersionId: dataset?.latestVersionId || '', rubricId: rubric?.id || '' })); }}><option value="">选择项目</option>{overview.projects.filter(project => !project.archivedAt).map(project => <option key={project.id} value={project.id}>{project.name} · {typeLabel(project.type)}</option>)}</select></div></div>
              <div className="evaluation-grid-2"><div className="evaluation-field"><label>测试集版本</label><select value={runForm.datasetVersionId} onChange={event => setRunForm(form => ({ ...form, datasetVersionId: event.target.value }))}><option value="">选择测试集</option>{visibleDatasets.map(dataset => <option key={dataset.id} value={dataset.latestVersionId}>{dataset.name} · v{dataset.latestVersion} · {dataset.caseCount} 条</option>)}</select></div><div className="evaluation-field"><label>评分模板</label><select value={runForm.rubricId} onChange={event => setRunForm(form => ({ ...form, rubricId: event.target.value }))}><option value="">选择模板</option>{visibleRubrics.map(rubric => <option key={rubric.id} value={rubric.id}>{rubric.name}</option>)}</select></div></div>
              <label className={`evaluation-memory-toggle${runForm.useMemory ? ' enabled' : ''}`}>
                <input type="checkbox" checked={runForm.useMemory} onChange={event => setRunForm(form => ({ ...form, useMemory: event.target.checked }))} />
                <span><strong>使用长期记忆</strong><small>默认关闭。开启后，候选与裁判运行会注入创建者的忆块；候选 Agent 自身关闭记忆时仍不注入。</small></span>
              </label>
              <div className="evaluation-form-section"><div className="evaluation-subhead"><h3>候选配置</h3><button className="btn btn-sm" type="button" onClick={() => { setCandidateForms(forms => [...forms, { id: uid(), source: 'online', alias: '', name: '', agentId: agents[0]?.id || '', model: agents[0]?.model || models[0] || '', repeatCount: 1, offlineAnswersText: '{}' }]); setRunForm(form => ({ ...form, concurrency: Math.min(form.concurrency + 1, overview.worker?.allowedConcurrency || overview.worker?.concurrency || 10) })); }} disabled={candidateForms.length >= 10}><LineIcon name="plus" />候选</button></div>
                {candidateForms.map((candidate, index) => <div className="evaluation-candidate-row" key={candidate.id}>
                  <span className="evaluation-candidate-index">{String.fromCharCode(65 + index)}</span>
                  <div className="evaluation-candidate-fields"><div className="evaluation-grid-4"><div className="evaluation-field"><label>来源</label><select value={candidate.source} onChange={event => updateCandidate(candidate.id, { source: event.target.value as 'online' | 'offline' })}><option value="online">在线运行</option><option value="offline">离线导入</option></select></div>{candidate.source === 'online' ? <><div className="evaluation-field"><label>别名（可选）</label><input value={candidate.alias} onChange={event => updateCandidate(candidate.id, { alias: event.target.value })} /></div><div className="evaluation-field"><label>Agent</label><select value={candidate.agentId} onChange={event => { const agent = agents.find(item => item.id === event.target.value); updateCandidate(candidate.id, { agentId: event.target.value, model: agent?.model || candidate.model }); }}><option value="">选择 Agent</option>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></div><div className="evaluation-field"><label>模型</label><ModelPicker value={candidate.model} models={models} placeholder="选择执行模型" onChange={model => updateCandidate(candidate.id, { model })} /></div></> : <><div className="evaluation-field"><label>离线候选名称</label><input value={candidate.name} onChange={event => updateCandidate(candidate.id, { name: event.target.value })} /></div><div className="evaluation-field evaluation-span-2"><label>离线答案 JSON</label><textarea className="evaluation-code-input" rows={3} value={candidate.offlineAnswersText} onChange={event => updateCandidate(candidate.id, { offlineAnswersText: event.target.value })} /></div></>}</div>{candidate.source === 'online' && <div className="evaluation-candidate-display"><strong>{agents.find(agent => agent.id === candidate.agentId)?.name || '未选择 Agent'} · {candidate.model || '未选择模型'}</strong>{candidate.alias && <span>{candidate.alias}</span>}</div>}<div className="evaluation-repeat"><label>重复次数</label><input type="number" min="1" max="10" value={candidate.repeatCount} onChange={event => updateCandidate(candidate.id, { repeatCount: Number(event.target.value) })} /></div></div>
                  {candidateForms.length > 1 && <button className="icon-btn danger" type="button" onClick={() => setCandidateForms(forms => forms.filter(item => item.id !== candidate.id))} aria-label="删除候选"><LineIcon name="trash" /></button>}
                </div>)}
              </div>
              <div className="evaluation-form-section"><div className="evaluation-subhead"><h3>终审与预算</h3><span>{overview.sandbox.reason}</span></div><div className="evaluation-grid-4"><div className="evaluation-field"><label>候选并发</label><input type="number" min="1" max={overview.worker?.allowedConcurrency || overview.worker?.concurrency || 10} value={runForm.concurrency} onChange={event => setRunForm(form => ({ ...form, concurrency: Number(event.target.value) }))} /></div><div className="evaluation-field"><label>终审策略</label><select value={runForm.reviewPolicy} onChange={event => setRunForm(form => ({ ...form, reviewPolicy: event.target.value as 'single' | 'consensus' }))}><option value="single">一人通过</option><option value="consensus">多人共识</option></select></div><div className="evaluation-field"><label>Token 上限</label><input inputMode="numeric" value={runForm.maxTokens} onChange={event => setRunForm(form => ({ ...form, maxTokens: event.target.value.replace(/\D/g, '') }))} /></div><div className="evaluation-field"><label>费用上限 USD</label><input inputMode="decimal" value={runForm.maxCostUsd} onChange={event => setRunForm(form => ({ ...form, maxCostUsd: event.target.value.replace(/[^\d.]/g, '') }))} /></div></div>
                <div className="evaluation-field"><label>审核人</label><div className="evaluation-reviewers">{reviewers.map(reviewer => { const key = reviewerKey(reviewer); return key ? <label key={key}><input type="checkbox" checked={runForm.reviewerSubs.includes(key)} onChange={event => setRunForm(form => ({ ...form, reviewerSubs: event.target.checked ? [...form.reviewerSubs, key] : form.reviewerSubs.filter(item => item !== key) }))} /><span>{reviewerLabel(reviewer)}</span><em>{reviewer.role}</em></label> : null; })}</div></div>
              </div>
            </div>}

            <div className="evaluation-modal-actions"><button className="btn" type="button" onClick={() => setModal(null)}>取消</button><button className="btn btn-primary" type="button" disabled={busy} onClick={() => { if (modal === 'project') void createProject(); else if (modal === 'dataset') void createDataset(); else if (modal === 'rubric') void createRubric(); else void createRun(); }}>{busy ? '保存中...' : modal === 'run' ? '创建草稿' : '保存'}</button></div>
          </div>
        </div>
      )}

      {deleteProjectTarget && (
        <div className="evaluation-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setDeleteProjectTarget(null); }}>
          <div className="evaluation-modal evaluation-confirm-modal" role="dialog" aria-modal="true" aria-label="永久删除评测项目">
            <div className="evaluation-modal-head"><div><span>permanent deletion</span><h2>永久删除项目</h2></div><button className="icon-btn" type="button" onClick={() => setDeleteProjectTarget(null)} aria-label="关闭"><LineIcon name="x" /></button></div>
            <div className="evaluation-modal-body">
              <p className="evaluation-delete-warning">项目及其历史运行、候选、证据和审核记录将被永久删除。共享测试集与评分模板会保留。</p>
              <div className="evaluation-field"><label>输入项目名称“{deleteProjectTarget.name}”确认</label><input value={deleteProjectConfirmation} onChange={event => setDeleteProjectConfirmation(event.target.value)} autoFocus /></div>
            </div>
            <div className="evaluation-modal-actions"><button className="btn" type="button" onClick={() => setDeleteProjectTarget(null)}>取消</button><button className="btn btn-danger" type="button" disabled={busy || deleteProjectConfirmation !== deleteProjectTarget.name} onClick={deleteProject}>{busy ? '删除中...' : '永久删除'}</button></div>
          </div>
        </div>
      )}

      {selectedReviewGroup && (
        <div className="evaluation-evidence-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) { setSelectedGroupKey(''); setSelectedAttempt(null); } }}>
          <aside className="evaluation-evidence" aria-label="评测证据">
            <div className="evaluation-detail-head"><div><span className="evaluation-detail-kicker">{selectedReviewGroup.caseExternalId}</span><h2>{selectedReviewGroup.candidateName}</h2>{selectedReviewGroup.candidateAlias && <small>{selectedReviewGroup.candidateAlias}</small>}</div><button className="icon-btn" onClick={() => { setSelectedGroupKey(''); setSelectedAttempt(null); }} aria-label="关闭"><LineIcon name="x" /></button></div>
            <div className="evaluation-score-strip"><div><span>自动结论</span><strong>{evidenceDecisionLabel(selectedReviewGroup.automaticDecision)}</strong></div><div><span>人工结论</span><strong>{selectedReviewGroup.humanReviewed ? evidenceDecisionLabel(selectedReviewGroup.decision) : '-'}</strong></div><div><span>重复执行</span><strong>{selectedReviewGroup.attempts.length}</strong></div></div>
            <section><h3>评测用例</h3><p className="evaluation-judge-reason">{selectedReviewGroup.prompt}</p></section>
            <section className="evaluation-evidence-review"><div className="evaluation-subhead"><h3>用例审核</h3><span>作用于该候选的全部重复执行</span></div><div className="evaluation-review-choice">
              <button className={caseReviewForm.decision === 'approve' ? 'active approve' : ''} type="button" onClick={() => setCaseReviewForm(form => ({ ...form, decision: 'approve' }))}><LineIcon name="check" />通过</button>
              <button className={caseReviewForm.decision === 'reject' ? 'active reject' : ''} type="button" onClick={() => setCaseReviewForm(form => ({ ...form, decision: 'reject' }))}><LineIcon name="x" />不通过</button>
              <button className={caseReviewForm.decision === 'needs_attention' ? 'active attention' : ''} type="button" onClick={() => setCaseReviewForm(form => ({ ...form, decision: 'needs_attention' }))}><LineIcon name="pin" />需关注</button>
            </div><textarea value={caseReviewForm.comment} onChange={event => setCaseReviewForm(form => ({ ...form, comment: event.target.value }))} placeholder="审核备注" rows={2} /><button className="btn btn-primary" type="button" disabled={busy} onClick={submitCaseReview}>提交用例审核</button></section>
            <section><div className="evaluation-subhead"><h3>重复尝试</h3><span>可逐次覆盖</span></div><div className="evaluation-evidence-attempts">{selectedReviewGroup.attempts.map(attempt => <button key={attempt.id} type="button" className={`${selectedAttempt?.id === attempt.id ? 'selected ' : ''}${evidenceDecisionClass(attempt.effectiveDecision)}`} onClick={() => { setSelectedAttempt(attempt); setAttemptReviewForm({ decision: attempt.reviewDecision || attempt.effectiveDecision, comment: attempt.reviews[0]?.comment || '' }); }}><span>#{attempt.repetition}</span><strong>{attempt.finalScore == null ? '-' : attempt.finalScore.toFixed(1)}</strong><em>{evidenceDecisionLabel(attempt.effectiveDecision)}</em></button>)}</div></section>
            {selectedAttempt && <>
              {selectedAttempt.errorMessage && <div className="evaluation-run-warning">{selectedAttempt.errorMessage}</div>}
              <section><h3>候选输出</h3><pre>{selectedAttempt.outputText || '无输出'}</pre></section>
              <section><h3>自动指标</h3>{selectedAttempt.metrics.filter(metric => metric.applied !== false).map((metric, index) => <div className="evaluation-metric" key={`${metric.key}-${index}`}><div><strong>{metric.label || metric.key}</strong><span>{Number(metric.score || 0).toFixed(1)}</span></div><p>{metric.evidence || '无证据说明'}</p></div>)}</section>
              {selectedAttempt.judgeReason && <section><h3>裁判理由</h3><p className="evaluation-judge-reason">{selectedAttempt.judgeReason}</p><span className="evaluation-confidence">置信度 {selectedAttempt.judgeConfidence?.toFixed(2)}</span></section>}
              <section className="evaluation-evidence-review"><div className="evaluation-subhead"><h3>单次尝试审核</h3><span>仅覆盖 #{selectedAttempt.repetition}</span></div><div className="evaluation-review-choice">
                <button className={attemptReviewForm.decision === 'approve' ? 'active approve' : ''} type="button" onClick={() => setAttemptReviewForm(form => ({ ...form, decision: 'approve' }))}><LineIcon name="check" />通过</button>
                <button className={attemptReviewForm.decision === 'reject' ? 'active reject' : ''} type="button" onClick={() => setAttemptReviewForm(form => ({ ...form, decision: 'reject' }))}><LineIcon name="x" />不通过</button>
                <button className={attemptReviewForm.decision === 'needs_attention' ? 'active attention' : ''} type="button" onClick={() => setAttemptReviewForm(form => ({ ...form, decision: 'needs_attention' }))}><LineIcon name="pin" />需关注</button>
              </div><textarea value={attemptReviewForm.comment} onChange={event => setAttemptReviewForm(form => ({ ...form, comment: event.target.value }))} placeholder="审核备注" rows={2} /><button className="btn btn-primary" type="button" disabled={busy} onClick={submitAttemptReview}>提交单次审核</button></section>
            </>}
          </aside>
        </div>
      )}
    </div>
  );
}
