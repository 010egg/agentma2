import type { Express, NextFunction, Request, Response } from 'express';
import {
  audit,
  checkUserRunQuota,
  listAgentTemplates,
  resolveQuotaUserId,
  type AuthIdentity,
} from './server-store.ts';
import {
  EvaluationStoreError,
  archiveEvaluationProject,
  canAccessEvaluationRun,
  cancelEvaluationRun,
  createEvaluationDataset,
  createEvaluationDatasetVersion,
  createEvaluationProject,
  createEvaluationRubric,
  createEvaluationRun,
  deleteEvaluationProject,
  getEvaluationDatasetVersion,
  getEvaluationOverviewMetrics,
  getEvaluationReport,
  getEvaluationReviewMatrix,
  getEvaluationRun,
  listEvaluationAttempts,
  listEvaluationDatasets,
  listEvaluationProjects,
  listEvaluationReviewAssignments,
  listEvaluationReviews,
  listEvaluationRubrics,
  listEvaluationRuns,
  restoreEvaluationProject,
  startEvaluationRun,
  submitEvaluationAttemptReview,
  submitEvaluationCaseReview,
  submitEvaluationReview,
} from './server-evaluation-store.ts';
import { getEvaluationSandboxStatus } from './server-evaluation-sandbox.ts';
import { getEvaluationWorkerState, startEvaluationWorker } from './server-evaluation-service.ts';

type AuthenticatedRequest = Request & { auth: AuthIdentity };
type Middleware = (req: Request, res: Response, next: NextFunction) => void;

function sendError(res: Response, error: unknown) {
  if (error instanceof EvaluationStoreError) {
    const status = error.code === 'not_found'
      ? 404
      : error.code === 'forbidden'
        ? 403
        : error.code === 'conflict' || error.code === 'invalid_state' || error.code === 'project_has_active_runs'
          ? 409
          : 400;
    res.status(status).json({ error: error.code, message: error.message });
    return;
  }
  console.error('[evaluations]', error);
  res.status(500).json({ error: 'evaluation_internal_error', message: (error as Error)?.message || '评估系统内部错误' });
}

function admin(req: AuthenticatedRequest) {
  return req.auth.role === 'tenant_admin';
}

function requireRunAccess(req: AuthenticatedRequest, res: Response) {
  if (!canAccessEvaluationRun(req.auth.tenantId, req.params.id, req.auth.sub, admin(req))) {
    res.status(404).json({ error: 'not_found', message: '评测运行不存在' });
    return false;
  }
  return true;
}

function snapshotCandidates(auth: AuthIdentity, value: unknown) {
  if (!Array.isArray(value)) return value;
  const templates = listAgentTemplates(auth.tenantId, auth.sub, auth.role);
  return value.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return candidate;
    const raw = candidate as Record<string, unknown>;
    if (raw.source === 'offline') return raw;
    const agentId = typeof raw.agentId === 'string' ? raw.agentId.trim() : '';
    const template = templates.find(item => String(item.id || '') === agentId);
    if (!template) throw new EvaluationStoreError('not_found', `Agent ${agentId || '(空)'} 不存在或不可见`);
    const model = typeof raw.model === 'string' ? raw.model.trim() : '';
    const templateName = typeof template.name === 'string' && template.name.trim() ? template.name.trim() : '未命名 Agent';
    return {
      ...raw,
      name: `${templateName} · ${model}`,
      alias: typeof raw.alias === 'string' ? raw.alias : typeof raw.candidateAlias === 'string' ? raw.candidateAlias : '',
      snapshot: template,
    };
  });
}

export function mountEvaluationRoutes(
  app: Express,
  dependencies: { authMiddleware: Middleware; requireAdmin: Middleware },
) {
  const { authMiddleware, requireAdmin } = dependencies;

  app.get('/api/evaluations/overview', authMiddleware, (request, response) => {
    const req = request as AuthenticatedRequest;
    try {
      const isAdmin = admin(req);
      const requestedProjectId = typeof req.query.projectId === 'string' ? req.query.projectId.trim() : '';
      const projectId = requestedProjectId && requestedProjectId !== 'all' ? requestedProjectId : undefined;
      const visibility = { reviewerSub: req.auth.sub, admin: isAdmin, projectId };
      const workerState = getEvaluationWorkerState();
      const quotaUserId = resolveQuotaUserId(req.auth);
      const quota = quotaUserId ? checkUserRunQuota(req.auth.tenantId, quotaUserId) : null;
      const allowedConcurrency = quota?.ok
        ? Math.max(1, Math.min(workerState.concurrency, quota.quota.effective.maxConcurrentRuns))
        : workerState.concurrency;
      response.json({
        projects: isAdmin ? listEvaluationProjects(req.auth.tenantId) : [],
        datasets: isAdmin ? listEvaluationDatasets(req.auth.tenantId) : [],
        rubrics: isAdmin ? listEvaluationRubrics(req.auth.tenantId, req.auth.sub) : [],
        runs: listEvaluationRuns(req.auth.tenantId, visibility),
        metrics: getEvaluationOverviewMetrics(req.auth.tenantId, visibility),
        sandbox: getEvaluationSandboxStatus(),
        worker: isAdmin ? { ...workerState, allowedConcurrency } : undefined,
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get('/api/evaluations/projects', authMiddleware, requireAdmin, (request, response) => {
    const req = request as AuthenticatedRequest;
    response.json(listEvaluationProjects(req.auth.tenantId));
  });

  app.post('/api/evaluations/projects', authMiddleware, requireAdmin, (request, response) => {
    const req = request as AuthenticatedRequest;
    try {
      const project = createEvaluationProject(req.auth.tenantId, req.auth.sub, req.body || {});
      audit(req.auth.tenantId, 'create_evaluation_project', req.auth.sub, 'user', `evaluation_project:${project.id}`, { type: project.type });
      response.status(201).json(project);
    } catch (error) {
      sendError(response, error);
    }
  });

  app.patch('/api/evaluations/projects/:id/archive', authMiddleware, requireAdmin, (request, response) => {
    const req = request as AuthenticatedRequest;
    try {
      const project = archiveEvaluationProject(req.auth.tenantId, req.params.id);
      audit(req.auth.tenantId, 'archive_evaluation_project', req.auth.sub, 'user', `evaluation_project:${project.id}`, {});
      response.json(project);
    } catch (error) {
      sendError(response, error);
    }
  });

  app.patch('/api/evaluations/projects/:id/restore', authMiddleware, requireAdmin, (request, response) => {
    const req = request as AuthenticatedRequest;
    try {
      const project = restoreEvaluationProject(req.auth.tenantId, req.params.id);
      audit(req.auth.tenantId, 'restore_evaluation_project', req.auth.sub, 'user', `evaluation_project:${project.id}`, {});
      response.json(project);
    } catch (error) {
      sendError(response, error);
    }
  });

  app.delete('/api/evaluations/projects/:id', authMiddleware, requireAdmin, (request, response) => {
    const req = request as AuthenticatedRequest;
    try {
      const result = deleteEvaluationProject(req.auth.tenantId, req.params.id, req.body?.confirmationName);
      audit(req.auth.tenantId, 'delete_evaluation_project', req.auth.sub, 'user', `evaluation_project:${result.project.id}`, {
        name: result.project.name,
        type: result.project.type,
        deletedRuns: result.deletedRuns,
      });
      response.json({ deleted: true, projectId: result.project.id, deletedRuns: result.deletedRuns });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get('/api/evaluations/datasets', authMiddleware, requireAdmin, (request, response) => {
    const req = request as AuthenticatedRequest;
    response.json(listEvaluationDatasets(req.auth.tenantId));
  });

  app.post('/api/evaluations/datasets', authMiddleware, requireAdmin, (request, response) => {
    const req = request as AuthenticatedRequest;
    try {
      const result = createEvaluationDataset(req.auth.tenantId, req.auth.sub, req.body || {});
      audit(req.auth.tenantId, 'create_evaluation_dataset', req.auth.sub, 'user', `evaluation_dataset:${result.dataset.id}`, {
        type: result.dataset.type,
        version: result.version.version,
        caseCount: result.version.caseCount,
      });
      response.status(201).json(result);
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post('/api/evaluations/datasets/:id/versions', authMiddleware, requireAdmin, (request, response) => {
    const req = request as AuthenticatedRequest;
    try {
      const version = createEvaluationDatasetVersion(req.auth.tenantId, req.auth.sub, req.params.id, req.body || {});
      audit(req.auth.tenantId, 'create_evaluation_dataset_version', req.auth.sub, 'user', `evaluation_dataset:${req.params.id}`, {
        version: version.version,
        caseCount: version.caseCount,
      });
      response.status(201).json(version);
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get('/api/evaluations/datasets/versions/:id', authMiddleware, requireAdmin, (request, response) => {
    const req = request as AuthenticatedRequest;
    const version = getEvaluationDatasetVersion(req.auth.tenantId, req.params.id, true);
    if (!version) {
      response.status(404).json({ error: 'not_found', message: '测试集版本不存在' });
      return;
    }
    response.json(version);
  });

  app.get('/api/evaluations/rubrics', authMiddleware, requireAdmin, (request, response) => {
    const req = request as AuthenticatedRequest;
    response.json(listEvaluationRubrics(req.auth.tenantId, req.auth.sub));
  });

  app.post('/api/evaluations/rubrics', authMiddleware, requireAdmin, (request, response) => {
    const req = request as AuthenticatedRequest;
    try {
      const rubric = createEvaluationRubric(req.auth.tenantId, req.auth.sub, req.body || {});
      audit(req.auth.tenantId, 'create_evaluation_rubric', req.auth.sub, 'user', `evaluation_rubric:${rubric.id}`, { type: rubric.type });
      response.status(201).json(rubric);
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get('/api/evaluations/runs', authMiddleware, (request, response) => {
    const req = request as AuthenticatedRequest;
    const requestedProjectId = typeof req.query.projectId === 'string' ? req.query.projectId.trim() : '';
    response.json(listEvaluationRuns(req.auth.tenantId, {
      reviewerSub: req.auth.sub,
      admin: admin(req),
      projectId: requestedProjectId && requestedProjectId !== 'all' ? requestedProjectId : undefined,
    }));
  });

  app.post('/api/evaluations/runs', authMiddleware, requireAdmin, (request, response) => {
    const req = request as AuthenticatedRequest;
    try {
      const quotaUserId = resolveQuotaUserId(req.auth);
      const workerConcurrency = getEvaluationWorkerState().concurrency;
      const quota = quotaUserId ? checkUserRunQuota(req.auth.tenantId, quotaUserId) : null;
      const tenantConcurrencyLimit = quota?.ok
        ? Math.max(1, Math.min(workerConcurrency, quota.quota.effective.maxConcurrentRuns))
        : workerConcurrency;
      const run = createEvaluationRun(req.auth.tenantId, {
        sub: req.auth.sub,
        role: req.auth.role,
        quotaUserId,
      }, {
        ...(req.body || {}),
        candidates: snapshotCandidates(req.auth, req.body?.candidates),
        platformConcurrencyLimit: workerConcurrency,
        tenantConcurrencyLimit,
      });
      audit(req.auth.tenantId, 'create_evaluation_run', req.auth.sub, 'user', `evaluation_run:${run.id}`, {
        type: run.type,
        candidates: run.candidates?.length || 0,
      });
      response.status(201).json(run);
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get('/api/evaluations/runs/:id', authMiddleware, (request, response) => {
    const req = request as AuthenticatedRequest;
    if (!requireRunAccess(req, response)) return;
    response.json({
      run: getEvaluationRun(req.auth.tenantId, req.params.id),
      assignments: listEvaluationReviewAssignments(req.auth.tenantId, req.params.id),
      reviews: listEvaluationReviews(req.auth.tenantId, req.params.id),
    });
  });

  app.post('/api/evaluations/runs/:id/start', authMiddleware, requireAdmin, (request, response) => {
    const req = request as AuthenticatedRequest;
    try {
      const run = getEvaluationRun(req.auth.tenantId, req.params.id, false);
      if (!run) throw new EvaluationStoreError('not_found', '评测运行不存在');
      if (run.type === 'code_repair') {
        const sandbox = getEvaluationSandboxStatus();
        if (!sandbox.available) {
          response.status(409).json({ error: 'sandbox_unavailable', message: sandbox.reason, sandbox });
          return;
        }
        response.status(409).json({
          error: 'code_repair_pipeline_not_ready',
          message: '安全执行器已就绪，但仓库准备、Agent 修复和补丁采集尚未开放；代码评测不会降级为宿主机执行。',
          sandbox,
        });
        return;
      }
      if (run.quotaUserId) {
        const quota = checkUserRunQuota(req.auth.tenantId, run.quotaUserId);
        if (!quota.ok) {
          response.status(quota.status).json({ error: quota.error, message: quota.message, quota: quota.quota });
          return;
        }
      }
      const started = startEvaluationRun(req.auth.tenantId, req.params.id);
      audit(req.auth.tenantId, 'start_evaluation_run', req.auth.sub, 'user', `evaluation_run:${req.params.id}`, {
        jobs: started.progress?.executeTotal || 0,
      });
      response.json(started);
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post('/api/evaluations/runs/:id/cancel', authMiddleware, requireAdmin, (request, response) => {
    const req = request as AuthenticatedRequest;
    try {
      const run = cancelEvaluationRun(req.auth.tenantId, req.params.id);
      audit(req.auth.tenantId, 'cancel_evaluation_run', req.auth.sub, 'user', `evaluation_run:${req.params.id}`, {});
      response.json(run);
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get('/api/evaluations/runs/:id/attempts', authMiddleware, (request, response) => {
    const req = request as AuthenticatedRequest;
    if (!requireRunAccess(req, response)) return;
    response.json(listEvaluationAttempts(req.auth.tenantId, req.params.id, Number(req.query.limit) || 5000));
  });

  app.get('/api/evaluations/runs/:id/report', authMiddleware, (request, response) => {
    const req = request as AuthenticatedRequest;
    if (!requireRunAccess(req, response)) return;
    try {
      response.json(getEvaluationReport(req.auth.tenantId, req.params.id));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get('/api/evaluations/runs/:id/review-matrix', authMiddleware, (request, response) => {
    const req = request as AuthenticatedRequest;
    if (!requireRunAccess(req, response)) return;
    try {
      response.json(getEvaluationReviewMatrix(req.auth.tenantId, req.params.id));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post('/api/evaluations/runs/:id/case-reviews', authMiddleware, (request, response) => {
    const req = request as AuthenticatedRequest;
    if (!requireRunAccess(req, response)) return;
    try {
      const result = submitEvaluationCaseReview(req.auth.tenantId, req.params.id, req.auth.sub, {
        candidateId: req.body?.candidateId,
        caseId: req.body?.caseId,
        decision: req.body?.decision,
        comment: req.body?.comment,
        isAdmin: admin(req),
      });
      audit(req.auth.tenantId, 'review_evaluation_case', req.auth.sub, 'user', `evaluation_run:${req.params.id}`, {
        candidateId: result.review.candidateId,
        caseId: result.review.caseId,
        decision: result.review.decision,
      });
      if (result.autoCompleted) {
        audit(req.auth.tenantId, 'auto_complete_evaluation_review', req.auth.sub, 'user', `evaluation_run:${req.params.id}`, {
          decision: result.run.reviewDecision,
          total: result.reviewMatrix.summary.total,
          passed: result.reviewMatrix.summary.passed,
          rejected: result.reviewMatrix.summary.rejected,
        });
      }
      response.status(201).json(result);
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post('/api/evaluations/runs/:id/attempt-reviews', authMiddleware, (request, response) => {
    const req = request as AuthenticatedRequest;
    if (!requireRunAccess(req, response)) return;
    try {
      const result = submitEvaluationAttemptReview(req.auth.tenantId, req.params.id, req.auth.sub, {
        attemptId: req.body?.attemptId,
        decision: req.body?.decision,
        comment: req.body?.comment,
        isAdmin: admin(req),
      });
      audit(req.auth.tenantId, 'review_evaluation_attempt', req.auth.sub, 'user', `evaluation_run:${req.params.id}`, {
        attemptId: result.review.attemptId,
        decision: result.review.decision,
      });
      if (result.autoCompleted) {
        audit(req.auth.tenantId, 'auto_complete_evaluation_review', req.auth.sub, 'user', `evaluation_run:${req.params.id}`, {
          decision: result.run.reviewDecision,
          total: result.reviewMatrix.summary.total,
          passed: result.reviewMatrix.summary.passed,
          rejected: result.reviewMatrix.summary.rejected,
        });
      }
      response.status(201).json(result);
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post('/api/evaluations/runs/:id/review', authMiddleware, (request, response) => {
    const req = request as AuthenticatedRequest;
    if (!requireRunAccess(req, response)) return;
    try {
      const run = submitEvaluationReview(req.auth.tenantId, req.params.id, req.auth.sub, {
        decision: req.body?.decision,
        comment: req.body?.comment,
        isAdmin: admin(req),
        finalize: req.body?.finalize === true,
      });
      audit(req.auth.tenantId, 'review_evaluation_run', req.auth.sub, 'user', `evaluation_run:${req.params.id}`, {
        decision: req.body?.decision,
        finalize: req.body?.finalize === true,
      });
      response.json(run);
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get('/api/evaluations/sandbox', authMiddleware, requireAdmin, (_request, response) => {
    response.json(getEvaluationSandboxStatus());
  });

  startEvaluationWorker();
}
