import type { Express } from 'express';
import path from 'node:path';
import {
  CORE_UI_CUSTOMIZATION_SAVE_CONTRACT_VERSION,
  CORE_UI_CUSTOMIZATION_SAVE_RESULT_TYPE,
  isCoreUiCustomizationRevision,
  type CoreUiCustomizationRevision,
  type CoreUiCustomizationSaveResult,
  type CoreUiCustomizationSaveResultCode,
} from '@open-design/contracts';
import type { RouteDeps } from '../server-context.js';
import {
  CoreUiProjectSaveConflictError,
  CoreUiProjectSaveTransactionError,
  coreUiCustomizationSaveRequestFingerprint,
  defaultCoreUiProjectSaveOperations,
  readCoreUiProjectCustomizationState,
  saveCoreUiProjectCustomization,
  validateCoreUiCustomizationSaveRequest,
} from '../live-artifacts/project-save.js';
import {
  CoreUiProjectSaveCoordinator,
  CoreUiProjectSaveRequestIdConflictError,
} from '../live-artifacts/project-save-coordinator.js';
import {
  appendCoreUiProjectSaveDiagnostic,
  type CoreUiProjectSaveDiagnosticResult,
} from '../live-artifacts/project-save-diagnostics.js';

export interface RegisterLiveArtifactRoutesDeps extends RouteDeps<'db' | 'http' | 'paths' | 'auth' | 'liveArtifacts' | 'projectStore'> {}

export function registerLiveArtifactRoutes(app: Express, ctx: RegisterLiveArtifactRoutesDeps) {
  const { db } = ctx;
  const { sendApiError, sendLiveArtifactRouteError, requireLocalDaemonRequest } = ctx.http;
  const { PROJECTS_DIR, RUNTIME_DATA_DIR } = ctx.paths;
  const { authorizeToolRequest, requestProjectOverride, requestRunOverride } = ctx.auth;
  const { createLiveArtifact, listLiveArtifacts, updateLiveArtifact, refreshLiveArtifact, emitLiveArtifactEvent, emitLiveArtifactRefreshEvent, readLiveArtifactCode, setLiveArtifactCodeHeaders, ensureLiveArtifactPreview, setLiveArtifactPreviewHeaders, getLiveArtifact, listLiveArtifactRefreshLogEntries, deleteLiveArtifact } = ctx.liveArtifacts;
  const { getProject, resolveProjectDir, updateProject } = ctx.projectStore;
  const projectSaveCoordinator = new CoreUiProjectSaveCoordinator({
    idempotencyDir: path.join(RUNTIME_DATA_DIR, 'idempotency', 'core-ui-project-save'),
  });
  app.get('/api/live-artifacts', async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (!projectId) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'projectId query parameter is required');
      }

      const artifacts = await listLiveArtifacts({
        projectsRoot: PROJECTS_DIR,
        projectId,
      });
      res.json({ artifacts });
    } catch (err: any) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.options('/api/live-artifacts/:artifactId/preview', requireLocalDaemonRequest, (_req, res) => {
    res.status(204).end();
  });

  app.get('/api/live-artifacts/:artifactId/preview', requireLocalDaemonRequest, async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (!projectId) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'projectId query parameter is required');
      }

      const variant = typeof req.query.variant === 'string' ? req.query.variant : 'rendered';
      if (variant === 'template' || variant === 'rendered-source') {
        const html = await readLiveArtifactCode({
          projectsRoot: PROJECTS_DIR,
          projectId,
          artifactId: req.params.artifactId,
          variant: variant === 'template' ? 'template' : 'rendered',
        });
        setLiveArtifactCodeHeaders(res);
        return res.status(200).send(html);
      }
      if (variant !== 'rendered') {
        return sendApiError(res, 400, 'BAD_REQUEST', 'variant must be rendered, template, or rendered-source');
      }

      const record = await ensureLiveArtifactPreview({
        projectsRoot: PROJECTS_DIR,
        projectId,
        artifactId: req.params.artifactId,
      });
      setLiveArtifactPreviewHeaders(res);
      res.status(200).send(record.html);
    } catch (err: any) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.get('/api/live-artifacts/:artifactId', async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (!projectId) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'projectId query parameter is required');
      }

      const record = await getLiveArtifact({
        projectsRoot: PROJECTS_DIR,
        projectId,
        artifactId: req.params.artifactId,
      });
      res.json({ artifact: record.artifact });
    } catch (err: any) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.get('/api/live-artifacts/:artifactId/refreshes', async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (!projectId) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'projectId query parameter is required');
      }

      const refreshes = await listLiveArtifactRefreshLogEntries({
        projectsRoot: PROJECTS_DIR,
        projectId,
        artifactId: req.params.artifactId,
      });
      res.json({ refreshes });
    } catch (err: any) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.get('/api/live-artifacts/:artifactId/project-save-state', async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (!projectId) return sendApiError(res, 400, 'BAD_REQUEST', 'projectId query parameter is required');
      const project = getProject(db, projectId);
      if (!project) return sendApiError(res, 404, 'NOT_FOUND', 'project was not found');
      await getLiveArtifact({ projectsRoot: PROJECTS_DIR, projectId, artifactId: req.params.artifactId });
      const projectDir = resolveProjectDir(PROJECTS_DIR, projectId, project.metadata);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json(await readCoreUiProjectCustomizationState({ projectDir }));
    } catch (err: any) {
      return sendLiveArtifactRouteError(res, err);
    }
  });

  app.post('/api/live-artifacts/:artifactId/project-save', async (req, res) => {
    const startedAt = Date.now();
    const suppliedRequestId = req.body && typeof req.body === 'object' && typeof req.body.requestId === 'string'
      ? req.body.requestId.slice(0, 200)
      : '';
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
    const artifactId = req.params.artifactId;
    let baseRevision: CoreUiCustomizationRevision | null = isCoreUiCustomizationRevision(req.body?.baseRevision)
      ? req.body.baseRevision
      : null;
    let revision: CoreUiCustomizationRevision | null = null;
    let diagnosticResult: CoreUiProjectSaveDiagnosticResult = 'failed';
    let rollbackOutcome: 'not_needed' | 'succeeded' | 'incomplete' = 'not_needed';
    const receipt = (
      ok: boolean,
      code: CoreUiCustomizationSaveResultCode,
      nextRevision: CoreUiCustomizationRevision | null,
      message: string,
    ): CoreUiCustomizationSaveResult => ({
      type: CORE_UI_CUSTOMIZATION_SAVE_RESULT_TYPE,
      version: CORE_UI_CUSTOMIZATION_SAVE_CONTRACT_VERSION,
      requestId: suppliedRequestId,
      ok,
      code,
      revision: nextRevision,
      message,
    });

    try {
      const request = validateCoreUiCustomizationSaveRequest(req.body);
      baseRevision = request.baseRevision;
      if (!projectId) {
        diagnosticResult = 'validation_error';
        return res.status(400).json(receipt(false, 'validation_error', null, 'The mounted project is unavailable.'));
      }
      const project = getProject(db, projectId);
      if (!project) return res.status(404).json(receipt(false, 'failed', null, 'The mounted project was not found.'));
      const projectDir = resolveProjectDir(PROJECTS_DIR, projectId, project.metadata);
      const operations = defaultCoreUiProjectSaveOperations(
        async () => (await getLiveArtifact({ projectsRoot: PROJECTS_DIR, projectId, artifactId })).artifact,
        async (document) => (await updateLiveArtifact({
          projectsRoot: PROJECTS_DIR,
          projectId,
          artifactId,
          input: { document },
        })).artifact,
        async () => ensureLiveArtifactPreview({ projectsRoot: PROJECTS_DIR, projectId, artifactId }),
      );
      try {
        const coordinated = await projectSaveCoordinator.run({
          projectId,
          artifactId,
          requestId: request.requestId,
          fingerprint: coreUiCustomizationSaveRequestFingerprint(request),
          execute: async () => {
            try {
              const result = await saveCoreUiProjectCustomization({ projectDir, request, operations });
              emitLiveArtifactEvent({ projectId }, 'updated', result.artifact);
              return {
                status: 200,
                receipt: receipt(true, 'saved', result.revision, 'Saved to canonical project files.'),
              };
            } catch (error) {
              if (error instanceof CoreUiProjectSaveConflictError) {
                return {
                  status: 409,
                  receipt: receipt(false, 'conflict', error.currentRevision, error.message),
                };
              }
              if (error instanceof CoreUiProjectSaveTransactionError) {
                rollbackOutcome = error.rollbackOutcome;
                return {
                  status: 500,
                  receipt: receipt(
                    false,
                    'failed',
                    error.rollbackOutcome === 'incomplete' ? null : request.baseRevision,
                    'Save failed. Your selections are still unsaved; try again.',
                  ),
                };
              }
              return {
                status: 500,
                receipt: receipt(false, 'failed', request.baseRevision, 'Save failed. Your selections are still unsaved; try again.'),
              };
            }
          },
        });
        revision = coordinated.receipt.revision;
        diagnosticResult = coordinated.replayed
          ? 'idempotent_replay'
          : !coordinated.idempotencyPersisted
            ? 'idempotency_persistence_failed'
            : coordinated.receipt.code === 'saved'
              ? 'succeeded'
              : coordinated.receipt.code;
        if (!coordinated.idempotencyPersisted) {
          console.error('[core-ui-project-save] completed receipt was not persisted for restart-safe replay');
        }
        return res.status(coordinated.status).json(coordinated.receipt);
      } catch (error) {
        if (!(error instanceof CoreUiProjectSaveRequestIdConflictError)) throw error;
        revision = (await readCoreUiProjectCustomizationState({ projectDir })).revision;
        diagnosticResult = 'request_id_conflict';
        return res.status(409).json(receipt(false, 'request_id_conflict', revision, error.message));
      }
    } catch (error) {
      const isValidationError = error instanceof Error && (
        error.message.startsWith('Save request')
        || error.message.startsWith('Customization')
      );
      diagnosticResult = isValidationError ? 'validation_error' : 'failed';
      return res.status(isValidationError ? 400 : 500).json(receipt(
        false,
        isValidationError ? 'validation_error' : 'failed',
        revision,
        isValidationError ? error.message : 'Save failed. Your selections are still unsaved; try again.',
      ));
    } finally {
      await appendCoreUiProjectSaveDiagnostic({
        dataDir: RUNTIME_DATA_DIR,
        entry: {
          requestId: suppliedRequestId,
          projectId,
          artifactId,
          baseRevision,
          revision,
          result: diagnosticResult,
          durationMs: Math.max(0, Date.now() - startedAt),
          rollbackOutcome,
        },
      }).catch((error) => {
        console.warn('[core-ui-project-save] unable to append diagnostics:', error instanceof Error ? error.message : 'unknown error');
      });
    }
  });

  app.post('/api/tools/live-artifacts/create', async (req, res) => {
    try {
      const toolGrant = authorizeToolRequest(req, res, 'live-artifacts:create');
      if (!toolGrant) return;
      const { projectId, input, templateHtml, provenanceJson, createdByRunId } = req.body || {};
      if (requestProjectOverride(projectId, toolGrant.projectId)) {
        return sendApiError(res, 403, 'FORBIDDEN', 'projectId is derived from the tool token', {
          details: { suppliedProjectId: projectId },
        });
      }
      if (requestRunOverride(createdByRunId, toolGrant.runId)) {
        return sendApiError(res, 403, 'FORBIDDEN', 'createdByRunId is derived from the tool token', {
          details: { suppliedRunId: createdByRunId },
        });
      }

      const record = await createLiveArtifact({
        projectsRoot: PROJECTS_DIR,
        projectId: toolGrant.projectId,
        input: input ?? {},
        templateHtml,
        provenanceJson,
        createdByRunId: toolGrant.runId,
      });
      emitLiveArtifactEvent(toolGrant, 'created', record.artifact);
      res.json({ artifact: record.artifact });
    } catch (err: any) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.get('/api/tools/live-artifacts/list', async (req, res) => {
    try {
      const toolGrant = authorizeToolRequest(req, res, 'live-artifacts:list');
      if (!toolGrant) return;
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (requestProjectOverride(projectId, toolGrant.projectId)) {
        return sendApiError(res, 403, 'FORBIDDEN', 'projectId is derived from the tool token', {
          details: { suppliedProjectId: projectId },
        });
      }

      const artifacts = await listLiveArtifacts({
        projectsRoot: PROJECTS_DIR,
        projectId: toolGrant.projectId,
      });
      res.json({ artifacts });
    } catch (err: any) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.post('/api/tools/live-artifacts/update', async (req, res) => {
    try {
      const toolGrant = authorizeToolRequest(req, res, 'live-artifacts:update');
      if (!toolGrant) return;
      const { projectId, artifactId, input, templateHtml, provenanceJson } = req.body || {};
      if (requestProjectOverride(projectId, toolGrant.projectId)) {
        return sendApiError(res, 403, 'FORBIDDEN', 'projectId is derived from the tool token', {
          details: { suppliedProjectId: projectId },
        });
      }
      if (typeof artifactId !== 'string' || artifactId.length === 0) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'artifactId is required');
      }

      const record = await updateLiveArtifact({
        projectsRoot: PROJECTS_DIR,
        projectId: toolGrant.projectId,
        artifactId,
        input: input ?? {},
        templateHtml,
        provenanceJson,
      });
      emitLiveArtifactEvent(toolGrant, 'updated', record.artifact);
      res.json({ artifact: record.artifact });
    } catch (err: any) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.post('/api/tools/live-artifacts/refresh', async (req, res) => {
    try {
      const toolGrant = authorizeToolRequest(req, res, 'live-artifacts:refresh');
      if (!toolGrant) return;
      const { projectId, artifactId } = req.body || {};
      if (requestProjectOverride(projectId, toolGrant.projectId)) {
        return sendApiError(res, 403, 'FORBIDDEN', 'projectId is derived from the tool token', {
          details: { suppliedProjectId: projectId },
        });
      }
      if (typeof artifactId !== 'string' || artifactId.length === 0) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'artifactId is required');
      }

      let result;
      try {
        result = await refreshLiveArtifact({
          projectsRoot: PROJECTS_DIR,
          projectId: toolGrant.projectId,
          projectMetadata: getProject(db, toolGrant.projectId)?.metadata,
          artifactId,
          onStarted: ({ refreshId }: any) => {
            emitLiveArtifactRefreshEvent(toolGrant, { phase: 'started', artifactId, refreshId });
          },
        });
      } catch (refreshErr) {
        emitLiveArtifactRefreshEvent(toolGrant, {
          phase: 'failed',
          artifactId,
          error: refreshErr instanceof Error ? refreshErr.message : String(refreshErr),
        });
        throw refreshErr;
      }
      emitLiveArtifactRefreshEvent(toolGrant, {
        phase: 'succeeded',
        artifactId,
        refreshId: result.refresh.id,
        title: result.artifact.title,
        refreshedSourceCount: result.refresh.refreshedSourceCount,
      });
      res.json(result);
    } catch (err: any) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.patch('/api/live-artifacts/:artifactId', async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (!projectId) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'projectId query parameter is required');
      }

      const record = await updateLiveArtifact({
        projectsRoot: PROJECTS_DIR,
        projectId,
        artifactId: req.params.artifactId,
        input: req.body ?? {},
      });
      emitLiveArtifactEvent({ projectId }, 'updated', record.artifact);
      res.json({ artifact: record.artifact });
    } catch (err: any) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.delete('/api/live-artifacts/:artifactId', async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (!projectId) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'projectId query parameter is required');
      }

      const existing = await getLiveArtifact({
        projectsRoot: PROJECTS_DIR,
        projectId,
        artifactId: req.params.artifactId,
      });
      await deleteLiveArtifact({
        projectsRoot: PROJECTS_DIR,
        projectId,
        artifactId: req.params.artifactId,
      });
      updateProject(db, projectId, {});
      emitLiveArtifactEvent({ projectId }, 'deleted', existing.artifact);
      res.json({ ok: true });
    } catch (err: any) {
      sendLiveArtifactRouteError(res, err);
    }
  });

  app.options('/api/live-artifacts/:artifactId/refresh', requireLocalDaemonRequest, (_req, res) => {
    res.status(204).end();
  });

  app.post('/api/live-artifacts/:artifactId/refresh', requireLocalDaemonRequest, async (req, res) => {
    try {
      const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
      if (!projectId) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'projectId query parameter is required');
      }

      let result;
      try {
        result = await refreshLiveArtifact({
          projectsRoot: PROJECTS_DIR,
          projectId,
          projectMetadata: getProject(db, projectId)?.metadata,
          artifactId: req.params.artifactId,
          onStarted: ({ refreshId }: any) => {
            emitLiveArtifactRefreshEvent({ projectId }, { phase: 'started', artifactId: req.params.artifactId, refreshId });
          },
        });
      } catch (refreshErr) {
        emitLiveArtifactRefreshEvent({ projectId }, {
          phase: 'failed',
          artifactId: req.params.artifactId,
          error: refreshErr instanceof Error ? refreshErr.message : String(refreshErr),
        });
        throw refreshErr;
      }
      emitLiveArtifactRefreshEvent({ projectId }, {
        phase: 'succeeded',
        artifactId: req.params.artifactId,
        refreshId: result.refresh.id,
        title: result.artifact.title,
        refreshedSourceCount: result.refresh.refreshedSourceCount,
      });
      res.json(result);
    } catch (err: any) {
      sendLiveArtifactRouteError(res, err);
    }
  });

}
