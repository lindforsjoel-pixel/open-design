import type { Express } from 'express';
import type { ProjectGitCommitRequest } from '@open-design/contracts';
import type { RouteDeps } from '../server-context.js';
import {
  commitProjectGitChanges,
  initializeProjectGit,
  ProjectGitError,
  readProjectGitStatus,
} from '../services/project-git.js';

export interface RegisterProjectGitRoutesDeps
  extends RouteDeps<'db' | 'http' | 'paths' | 'projectStore' | 'projectFiles'> {}

export function registerProjectGitRoutes(app: Express, ctx: RegisterProjectGitRoutesDeps): void {
  const { db } = ctx;
  const { requireLocalDaemonRequest, sendApiError } = ctx.http;
  const { PROJECTS_DIR } = ctx.paths;
  const { getProject } = ctx.projectStore;
  const { resolveProjectDir } = ctx.projectFiles;

  function projectRoot(projectId: string): string | null {
    const project = getProject(db, projectId);
    return project
      ? resolveProjectDir(PROJECTS_DIR, projectId, project.metadata, {
          allowUnavailableSandboxImportedProject: true,
        })
      : null;
  }

  function sendGitError(res: Parameters<typeof sendApiError>[0], error: unknown): void {
    if (error instanceof ProjectGitError) {
      const status = error.code === 'GIT_NOT_AVAILABLE' ? 503 : error.code === 'GIT_COMMAND_FAILED' ? 409 : 400;
      sendApiError(res, status, error.code, error.message);
      return;
    }
    sendApiError(res, 500, 'INTERNAL_ERROR', error instanceof Error ? error.message : String(error));
  }

  app.get('/api/projects/:id/git/status', requireLocalDaemonRequest, async (req, res) => {
    const root = projectRoot(req.params.id);
    if (!root) return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
    try {
      res.json(await readProjectGitStatus(root));
    } catch (error) {
      sendGitError(res, error);
    }
  });

  app.post('/api/projects/:id/git/init', requireLocalDaemonRequest, async (req, res) => {
    const root = projectRoot(req.params.id);
    if (!root) return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
    try {
      res.json(await initializeProjectGit(root));
    } catch (error) {
      sendGitError(res, error);
    }
  });

  app.post('/api/projects/:id/git/commit', requireLocalDaemonRequest, async (req, res) => {
    const root = projectRoot(req.params.id);
    if (!root) return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
    const body = (req.body ?? {}) as Partial<ProjectGitCommitRequest>;
    try {
      res.json(await commitProjectGitChanges(root, body.message, body.paths));
    } catch (error) {
      sendGitError(res, error);
    }
  });
}
