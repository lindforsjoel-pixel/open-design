import { execFileSync } from 'node:child_process';
import type http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Response } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerProjectGitRoutes } from '../../src/routes/project-git.js';
import type { RegisterProjectGitRoutesDeps } from '../../src/routes/project-git.js';

const projectRoot = mkdtempSync(path.join(tmpdir(), 'od-project-git-route-'));
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  registerProjectGitRoutes(app, {
    db: {},
    http: {
      requireLocalDaemonRequest: (_req: unknown, _res: unknown, next: () => void) => next(),
      sendApiError: (res: Response, status: number, code: string, message: string) =>
        res.status(status).json({ error: { code, message } }),
    },
    paths: { PROJECTS_DIR: tmpdir() },
    projectStore: {
      getProject: (_db: unknown, id: string) => id === 'project-1'
        ? { id, metadata: { baseDir: projectRoot } }
        : null,
    },
    projectFiles: { resolveProjectDir: () => projectRoot },
  } as unknown as RegisterProjectGitRoutesDeps);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('project Git routes', () => {
  it('initializes a repository and returns project-scoped status', async () => {
    const initResp = await fetch(`${baseUrl}/api/projects/project-1/git/init`, { method: 'POST' });
    expect(initResp.status).toBe(200);
    expect(await initResp.json()).toEqual(expect.objectContaining({
      available: true,
      repository: true,
      projectRoot,
    }));

    execFileSync('git', ['config', 'user.name', 'Open Design Test'], { cwd: projectRoot });
    execFileSync('git', ['config', 'user.email', 'open-design-test@example.invalid'], { cwd: projectRoot });
    await writeFile(path.join(projectRoot, 'versioned.txt'), 'content\n');

    const commitResp = await fetch(`${baseUrl}/api/projects/project-1/git/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Initial project version', paths: ['versioned.txt'] }),
    });
    expect(commitResp.status).toBe(200);
    expect(await commitResp.json()).toEqual(expect.objectContaining({
      commit: expect.objectContaining({ subject: 'Initial project version' }),
      status: expect.objectContaining({ clean: true }),
    }));
  });

  it('does not expose Git operations for a missing project', async () => {
    const resp = await fetch(`${baseUrl}/api/projects/missing/git/status`);
    expect(resp.status).toBe(404);
    expect(await resp.json()).toEqual({
      error: { code: 'PROJECT_NOT_FOUND', message: 'project not found' },
    });
  });
});
