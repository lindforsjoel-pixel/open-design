import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express, { type Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeDatabase,
  insertConversation,
  insertProject,
  openDatabase,
} from '../../src/db.js';
import { registerRunRoutes } from '../../src/routes/runs.js';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

interface RouteHarness {
  baseUrl: string;
  events: string[];
  cancelRun: ReturnType<typeof vi.fn>;
  completeRun: ReturnType<typeof vi.fn>;
  captureRunStart: ReturnType<typeof vi.fn>;
  createdRuns: Array<Record<string, unknown>>;
  startChatRun: ReturnType<typeof vi.fn>;
  startRun: ReturnType<typeof vi.fn>;
  terminal: Deferred<Record<string, unknown>>;
  close: () => Promise<void>;
}

interface RouteHarnessOptions {
  executeStarter?: boolean;
  setupError?: Error;
  startError?: Error;
}

const openHarnesses: RouteHarness[] = [];

afterEach(async () => {
  await Promise.all(openHarnesses.splice(0).map((harness) => harness.close()));
});

async function createHarness(options: RouteHarnessOptions = {}): Promise<RouteHarness> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'od-runs-workflow-route-'));
  const projectsRoot = path.join(root, 'projects');
  const dataDir = path.join(root, 'data');
  await mkdir(projectsRoot, { recursive: true });
  const db = openDatabase(root, { dataDir });
  const now = Date.now();
  insertProject(db, {
    id: 'workflow-project',
    name: 'Workflow project',
    designSystemId: 'user:brand',
    createdAt: now,
    updatedAt: now,
  });
  insertProject(db, {
    id: 'legacy-project',
    name: 'Legacy project',
    createdAt: now,
    updatedAt: now,
  });
  insertConversation(db, {
    id: 'workflow-conversation',
    projectId: 'workflow-project',
    title: 'Workflow',
    createdAt: now,
    updatedAt: now,
  });
  await Promise.all([
    mkdir(path.join(projectsRoot, 'workflow-project'), { recursive: true }),
    mkdir(path.join(projectsRoot, 'legacy-project'), { recursive: true }),
  ]);

  const events: string[] = [];
  const createdRuns: Array<Record<string, unknown>> = [];
  const terminal = deferred<Record<string, unknown>>();
  let runCounter = 0;
  const captureRunStart = vi.fn(async () => {
    events.push('capture');
  });
  const completeRun = vi.fn(async () => {
    events.push('complete');
  });
  const startRun = vi.fn((
    run: Record<string, unknown>,
    starter: () => Promise<unknown>,
  ) => {
    events.push('start');
    if (options.startError) throw options.startError;
    run.status = 'running';
    if (options.executeStarter) {
      void starter().then(() => {
        run.status = 'succeeded';
        terminal.resolve(run);
      }, (error) => {
        run.status = 'failed';
        run.error = error instanceof Error ? error.message : String(error);
        terminal.resolve(run);
      });
    }
    return run;
  });
  const cancelRun = vi.fn(async (run: Record<string, unknown>) => {
    events.push('cancel');
    run.status = 'canceled';
    terminal.resolve(run);
    return run;
  });
  const startChatRun = vi.fn(async () => undefined);
  const runs = {
    create: vi.fn((meta: Record<string, unknown>) => {
      events.push('create');
      const run = {
        id: `run-${++runCounter}`,
        projectId: typeof meta.projectId === 'string' ? meta.projectId : null,
        conversationId: typeof meta.conversationId === 'string' ? meta.conversationId : null,
        assistantMessageId: typeof meta.assistantMessageId === 'string'
          ? meta.assistantMessageId
          : null,
        agentId: typeof meta.agentId === 'string' ? meta.agentId : null,
        status: 'queued',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        events: [],
        clients: new Set(),
      };
      createdRuns.push(run);
      return run;
    }),
    get: vi.fn(() => null),
    list: vi.fn(() => []),
    statusBody: vi.fn((run: Record<string, unknown>) => run),
    stream: vi.fn((run: Record<string, unknown>, _req: unknown, res: Response) => {
      events.push('stream');
      res.status(200).json({ runId: run.id });
    }),
    start: startRun,
    wait: vi.fn(() => {
      events.push('wait');
      return terminal.promise;
    }),
    cancel: cancelRun,
    isTerminal: vi.fn(() => false),
  };

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const json = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (req.path === '/api/runs') events.push('response');
      return json(body);
    }) as typeof res.json;
    next();
  });
  registerRunRoutes(app, {
    db,
    design: {
      runs,
      analytics: { capture: vi.fn() },
      getAppVersion: () => 'test',
    },
    http: {
      createSseResponse: vi.fn(),
      sendApiError: (res: Response, status: number, code: string, message: string) =>
        res.status(status).json({ error: { code, message } }),
    },
    paths: {
      PROJECTS_DIR: projectsRoot,
      RUNTIME_DATA_DIR: dataDir,
    },
    agents: {
      detectAgents: vi.fn(async () => []),
      getAgentDef: vi.fn(() => null),
    },
    chat: {
      startChatRun,
    },
    lifecycle: {
      isDaemonShuttingDown: () => false,
    },
    plugins: {
      connectorService: {
        listFastDefinitions: () => [],
        getStatus: vi.fn(),
      },
      detectSkillPluginCandidateOnRunSuccess: vi.fn(() => {
        events.push('setup');
      }),
      firePipelineForRun: vi.fn(() => {
        events.push('pipeline');
      }),
      loadPluginRegistryView: vi.fn(async () => ({
        skills: [],
        designSystems: [],
        craft: [],
        atoms: [],
      })),
      renderPluginBriefTemplate: (template: string) => template,
    },
    telemetry: {
      reportRunCompletionTelemetryFallback: vi.fn(),
      resolveRunProjectKindForAnalytics: vi.fn(() => null),
      runArtifactBaselines: { take: vi.fn(() => undefined) },
      runRetryEventsForAnalytics: vi.fn(() => []),
    },
    messages: {
      pinAssistantMessageOnRunCreate: vi.fn(),
      reconcileAssistantMessageOnRunEnd: vi.fn(() => {
        events.push('reconcile');
        if (options.setupError) throw options.setupError;
      }),
    },
    designWorkflow: {
      captureRunStart,
      completeRun,
    },
  } as never);

  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let closed = false;
  const harness: RouteHarness = {
    baseUrl,
    events,
    cancelRun,
    completeRun,
    captureRunStart,
    createdRuns,
    startChatRun,
    startRun,
    terminal,
    close: async () => {
      if (closed) return;
      closed = true;
      terminal.resolve({ status: 'canceled' });
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      closeDatabase();
      await rm(root, { recursive: true, force: true });
    },
  };
  openHarnesses.push(harness);
  return harness;
}

describe('run-route design workflow lifecycle', () => {
  it('arms workflow completion immediately after capture and completes exactly once', async () => {
    const harness = await createHarness();

    const response = await fetch(`${harness.baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'workflow-project',
        conversationId: 'workflow-conversation',
        agentId: 'codex',
        message: '/push',
      }),
    });

    const responseBody = await response.text();
    expect(response.status, responseBody).toBe(202);
    expect(harness.captureRunStart).toHaveBeenCalledWith(
      'run-1',
      'workflow-project',
      '/push',
    );
    const captureIndex = harness.events.indexOf('capture');
    const firstWaitIndex = harness.events.indexOf('wait');
    const responseIndex = harness.events.indexOf('response');
    const setupIndex = harness.events.indexOf('setup');
    const startIndex = harness.events.indexOf('start');
    expect(captureIndex).toBeGreaterThanOrEqual(0);
    expect(firstWaitIndex).toBe(captureIndex + 1);
    expect(firstWaitIndex).toBeLessThan(responseIndex);
    expect(firstWaitIndex).toBeLessThan(setupIndex);
    expect(firstWaitIndex).toBeLessThan(startIndex);
    expect(startIndex).toBeLessThan(responseIndex);

    harness.terminal.resolve({ status: 'succeeded' });
    await vi.waitFor(() => {
      expect(harness.completeRun).toHaveBeenCalledTimes(1);
    });
    expect(harness.completeRun).toHaveBeenCalledWith({
      runId: 'run-1',
      projectId: 'workflow-project',
      prompt: '/push',
      succeeded: true,
    });
  });

  it('executes exact approval commands directly without starting an agent', async () => {
    const harness = await createHarness({ executeStarter: true });
    const digest = 'd'.repeat(64);

    const response = await fetch(`${harness.baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'workflow-project',
        conversationId: 'workflow-conversation',
        message: `/approve delivery-1 ${digest}`,
      }),
    });

    const responseBody = await response.text();
    expect(response.status, responseBody).toBe(202);
    await vi.waitFor(() => {
      expect(harness.completeRun).toHaveBeenCalledTimes(1);
    });
    expect(harness.captureRunStart).toHaveBeenCalledWith(
      'run-1',
      'workflow-project',
      `/approve delivery-1 ${digest}`,
    );
    expect(harness.completeRun).toHaveBeenCalledWith({
      runId: 'run-1',
      projectId: 'workflow-project',
      prompt: `/approve delivery-1 ${digest}`,
      succeeded: true,
    });
    expect(harness.startChatRun).not.toHaveBeenCalled();
    expect(harness.createdRuns[0]?.status).toBe('succeeded');
  });

  it('fails closed when synchronous post-capture setup throws and completes workflow cleanup once', async () => {
    const harness = await createHarness({
      setupError: new Error('run lifecycle setup failed'),
    });

    const response = await fetch(`${harness.baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'workflow-project',
        conversationId: 'workflow-conversation',
        agentId: 'codex',
        message: '/push',
      }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: 'AGENT_EXECUTION_FAILED',
        message: 'run lifecycle setup failed',
      },
    });
    expect(harness.startRun).not.toHaveBeenCalled();
    expect(harness.cancelRun).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(harness.completeRun).toHaveBeenCalledTimes(1);
    });
    expect(harness.completeRun).toHaveBeenCalledWith({
      runId: 'run-1',
      projectId: 'workflow-project',
      prompt: '/push',
      succeeded: false,
    });
    expect(harness.createdRuns[0]?.status).toBe('canceled');
    const waitIndex = harness.events.indexOf('wait');
    expect(waitIndex).toBeGreaterThanOrEqual(0);
    expect(waitIndex).toBeLessThan(harness.events.indexOf('reconcile'));
    expect(harness.events.indexOf('complete')).toBeLessThan(harness.events.indexOf('cancel'));
    expect(harness.events.indexOf('cancel')).toBeLessThan(harness.events.indexOf('response'));
  });

  it('fails closed when runs.start throws and the terminal waiter does not complete twice', async () => {
    const harness = await createHarness({
      startError: new Error('run start failed'),
    });

    const response = await fetch(`${harness.baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'workflow-project',
        conversationId: 'workflow-conversation',
        agentId: 'codex',
        message: '/push',
      }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: 'AGENT_EXECUTION_FAILED',
        message: 'run start failed',
      },
    });
    expect(harness.startRun).toHaveBeenCalledTimes(1);
    expect(harness.cancelRun).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(harness.completeRun).toHaveBeenCalledTimes(1);
    });
    expect(harness.completeRun).toHaveBeenCalledWith({
      runId: 'run-1',
      projectId: 'workflow-project',
      prompt: '/push',
      succeeded: false,
    });
    expect(harness.createdRuns[0]?.status).toBe('canceled');
    expect(harness.events.filter((event) => event === 'complete')).toHaveLength(1);
    expect(harness.events.indexOf('complete')).toBeLessThan(harness.events.indexOf('cancel'));
    expect(harness.events.indexOf('cancel')).toBeLessThan(harness.events.indexOf('response'));
  });

  it('keeps legacy chat available but rejects user-design-system projects before creating a run', async () => {
    const harness = await createHarness();

    const rejected = await fetch(`${harness.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'workflow-project',
        agentId: 'codex',
        message: 'hello',
      }),
    });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({
      error: {
        code: 'DESIGN_WORKFLOW_RUN_REQUIRED',
        message: 'Projects using a user design system must run through /api/runs so Open Design can protect revisions, approvals, and recovery.',
      },
    });
    expect(harness.createdRuns).toHaveLength(0);
    expect(harness.events).not.toContain('stream');
    expect(harness.events).not.toContain('start');

    const legacy = await fetch(`${harness.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'legacy-project',
        agentId: 'codex',
        message: 'hello',
      }),
    });
    expect(legacy.status).toBe(200);
    expect(await legacy.json()).toEqual({ runId: 'run-1' });
    expect(harness.events).toEqual(expect.arrayContaining([
      'create',
      'stream',
      'reconcile',
      'start',
    ]));
    expect(harness.captureRunStart).not.toHaveBeenCalled();
  });
});
