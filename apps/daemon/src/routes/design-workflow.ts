import type { Express, Response } from 'express';
import type { DesignWorkflowApproveRequest, DesignWorkflowRollbackRequest } from '@open-design/contracts';
import type { RouteDeps } from '../server-context.js';
import type { DesignWorkflowService } from '../design-systems/workflow.js';

export interface RegisterDesignWorkflowRoutesDeps extends RouteDeps<'http' | 'designWorkflow'> {
  designWorkflow: DesignWorkflowService;
}

export function registerDesignWorkflowRoutes(
  app: Express,
  ctx: RegisterDesignWorkflowRoutesDeps,
): void {
  const { requireLocalDaemonRequest, sendApiError } = ctx.http;
  const workflow = ctx.designWorkflow;

  function sendWorkflowError(res: Response, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const missing = /not found|no design-system workspace/i.test(message);
    sendApiError(res, missing ? 404 : 409, missing ? 'DESIGN_WORKFLOW_NOT_FOUND' : 'DESIGN_WORKFLOW_ERROR', message);
  }

  app.get('/api/projects/:id/design-workflow', requireLocalDaemonRequest, async (req, res) => {
    try {
      res.json(await workflow.statusForProject(req.params.id));
    } catch (error) {
      sendWorkflowError(res, error);
    }
  });

  app.post('/api/projects/:id/design-workflow/init', requireLocalDaemonRequest, async (req, res) => {
    try {
      res.json(await workflow.initializeProject(req.params.id));
    } catch (error) {
      sendWorkflowError(res, error);
    }
  });

  app.post('/api/projects/:id/design-workflow/update-all', requireLocalDaemonRequest, async (req, res) => {
    try {
      res.json(await workflow.updateAll(req.params.id));
    } catch (error) {
      sendWorkflowError(res, error);
    }
  });

  app.post('/api/projects/:id/design-workflow/publish', requireLocalDaemonRequest, async (req, res) => {
    try {
      res.json(await workflow.publish(req.params.id));
    } catch (error) {
      sendWorkflowError(res, error);
    }
  });

  app.post('/api/projects/:id/design-workflow/rollback', requireLocalDaemonRequest, async (req, res) => {
    const body = (req.body ?? {}) as Partial<DesignWorkflowRollbackRequest>;
    if (typeof body.sha !== 'string' || !body.sha.trim()) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'sha is required');
    }
    try {
      res.json(await workflow.rollback(req.params.id, body.sha));
    } catch (error) {
      sendWorkflowError(res, error);
    }
  });

  app.post('/api/projects/:id/design-workflow/resume', requireLocalDaemonRequest, async (req, res) => {
    try {
      res.json(await workflow.resume(req.params.id));
    } catch (error) {
      sendWorkflowError(res, error);
    }
  });

  app.post('/api/projects/:id/design-workflow/approve', requireLocalDaemonRequest, async (req, res) => {
    const body = (req.body ?? {}) as Partial<DesignWorkflowApproveRequest>;
    if (typeof body.deliveryId !== 'string' || typeof body.implementationDigest !== 'string') {
      return sendApiError(res, 400, 'BAD_REQUEST', 'deliveryId and implementationDigest are required');
    }
    try {
      res.json(await workflow.approveDelivery(req.params.id, body.deliveryId, body.implementationDigest));
    } catch (error) {
      sendWorkflowError(res, error);
    }
  });
}
