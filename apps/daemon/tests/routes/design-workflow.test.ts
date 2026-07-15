import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type Response } from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerDesignWorkflowRoutes } from '../../src/routes/design-workflow.js';

let server: http.Server;
let baseUrl: string;
const status = {
  projectId: 'asset',
  role: 'subscriber' as const,
  designSystemId: 'user:brand',
  sourceProjectId: 'source',
  status: 'update_needed' as const,
  currentRevision: {
    id: 'user:brand:abc', designSystemId: 'user:brand', sourceProjectId: 'source',
    sha: 'abc', shortSha: 'abc', branch: 'branch', classification: 'structural' as const,
    changedPaths: ['DESIGN.md'], runId: 'run', createdAt: 1,
  },
  subscription: null,
  subscriberCount: 2,
};
const workflow = {
  statusForProject: vi.fn(async () => status),
  initializeProject: vi.fn(async () => status),
  updateAll: vi.fn(async () => ({ designSystemId: 'user:brand', sourceProjectId: 'source', subscriptions: [] })),
  publish: vi.fn(async () => status),
  rollback: vi.fn(async () => status),
  resume: vi.fn(async () => status),
  approveDelivery: vi.fn(async () => status),
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  registerDesignWorkflowRoutes(app, {
    http: {
      requireLocalDaemonRequest: (_req: unknown, _res: unknown, next: () => void) => next(),
      sendApiError: (res: Response, code: number, errorCode: string, message: string) =>
        res.status(code).json({ error: { code: errorCode, message } }),
    },
    designWorkflow: workflow,
  } as never);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

describe('design workflow routes', () => {
  it('auto-initializes status and exposes resume', async () => {
    expect(await (await fetch(`${baseUrl}/api/projects/asset/design-workflow`)).json()).toEqual(status);
    expect(await (await fetch(`${baseUrl}/api/projects/asset/design-workflow/resume`, { method: 'POST' })).json()).toEqual(status);
    expect(workflow.statusForProject).toHaveBeenCalledWith('asset');
    expect(workflow.resume).toHaveBeenCalledWith('asset');
  });

  it('publishes the current source revision through the shared workflow endpoint', async () => {
    expect(await (await fetch(`${baseUrl}/api/projects/source/design-workflow/publish`, { method: 'POST' })).json()).toEqual(status);
    expect(workflow.publish).toHaveBeenCalledWith('source');
  });

  it('validates rollback revisions', async () => {
    const missing = await fetch(`${baseUrl}/api/projects/asset/design-workflow/rollback`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(missing.status).toBe(400);
    const ok = await fetch(`${baseUrl}/api/projects/asset/design-workflow/rollback`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sha: 'abc' }),
    });
    expect(ok.status).toBe(200);
    expect(workflow.rollback).toHaveBeenCalledWith('asset', 'abc');
  });

  it('binds approval to both delivery id and implementation digest', async () => {
    const missing = await fetch(`${baseUrl}/api/projects/asset/design-workflow/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deliveryId: 'delivery' }),
    });
    expect(missing.status).toBe(400);
    const ok = await fetch(`${baseUrl}/api/projects/asset/design-workflow/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deliveryId: 'delivery', implementationDigest: 'digest' }),
    });
    expect(ok.status).toBe(200);
    expect(workflow.approveDelivery).toHaveBeenCalledWith('asset', 'delivery', 'digest');
  });
});
