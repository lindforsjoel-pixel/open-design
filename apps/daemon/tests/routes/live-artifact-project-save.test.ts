import type http from 'node:http';
import express from 'express';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CORE_UI_CUSTOMIZATION_SAVE_CONTRACT_VERSION,
  type CoreUiCustomizationSaveRequest,
  type CoreUiCustomizationSaveSettings,
  type LiveArtifact,
} from '@open-design/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { coreUiCustomizationRevision } from '../../src/live-artifacts/project-save.js';
import { registerLiveArtifactRoutes } from '../../src/routes/live-artifact.js';

const oldSettings: CoreUiCustomizationSaveSettings = {
  field: 'carbon-blue',
  sidebar: 'ocean-deep',
  tabs: 'wet-slate',
  selected: 'storm-slate',
  headers: 'mineral-blue',
  data: 'clouded-steel',
};

function canonical(settings: CoreUiCustomizationSaveSettings) {
  return {
    field: settings.field,
    sidebar: settings.sidebar,
    tabs: settings.tabs,
    selected: settings.selected,
    panelHeaders: settings.headers,
    data: settings.data,
  };
}

function artifact(dataJson: Record<string, unknown>): LiveArtifact {
  return {
    schemaVersion: 1,
    id: 'artifact-1',
    projectId: 'project-1',
    title: 'Core UI',
    slug: 'core-ui',
    status: 'active',
    pinned: false,
    preview: { type: 'html', entry: 'index.html' },
    refreshStatus: 'idle',
    createdAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
    document: {
      format: 'html_template_v1',
      templatePath: 'template.html',
      generatedPreviewPath: 'index.html',
      dataPath: 'data.json',
      dataJson,
    },
  };
}

describe('Core UI project-save HTTP receipts', () => {
  let root: string;
  let projectDir: string;
  let server: http.Server;
  let baseUrl: string;
  let registered: LiveArtifact;
  let updateCount: number;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'od-core-ui-save-route-'));
    projectDir = path.join(root, 'external-project');
    await mkdir(projectDir, { recursive: true });
    const dataJson = { meta: { product: 'Core UI' }, uiCustomization: canonical(oldSettings) };
    registered = artifact(dataJson);
    await Promise.all([
      writeFile(path.join(projectDir, 'data.json'), `${JSON.stringify(dataJson)}\n`, 'utf8'),
      writeFile(path.join(projectDir, 'live-source.json'), `${JSON.stringify(dataJson)}\n`, 'utf8'),
      writeFile(path.join(projectDir, 'artifact.json'), `${JSON.stringify({ document: registered.document })}\n`, 'utf8'),
    ]);
    updateCount = 0;

    const app = express();
    app.use(express.json());
    registerLiveArtifactRoutes(app, {
      db: {},
      paths: { PROJECTS_DIR: path.join(root, 'managed-projects'), RUNTIME_DATA_DIR: path.join(root, 'runtime') },
      http: {
        requireLocalDaemonRequest: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
        sendApiError: (res: express.Response, status: number, code: string, message: string) => res.status(status).json({ error: { code, message } }),
        sendLiveArtifactRouteError: (res: express.Response, error: unknown) => res.status(500).json({ error: String(error) }),
      },
      auth: {
        authorizeToolRequest: () => null,
        requestProjectOverride: () => false,
        requestRunOverride: () => false,
      },
      liveArtifacts: {
        getLiveArtifact: vi.fn(async () => ({ artifact: registered })),
        updateLiveArtifact: vi.fn(async ({ input }: { input: { document: LiveArtifact['document'] } }) => {
          updateCount += 1;
          registered = { ...registered, document: input.document };
          return { artifact: registered };
        }),
        ensureLiveArtifactPreview: vi.fn(async () => ({ artifact: registered, html: '<!doctype html><main>Core UI</main>' })),
        emitLiveArtifactEvent: vi.fn(),
        emitLiveArtifactRefreshEvent: vi.fn(),
      },
      projectStore: {
        getProject: () => ({ id: 'project-1', metadata: { baseDir: projectDir } }),
        resolveProjectDir: (_projectsRoot: string, _projectId: string, metadata: { baseDir: string }) => metadata.baseDir,
        updateProject: vi.fn(),
      },
    } as never);
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server address unavailable');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  async function state() {
    const response = await fetch(`${baseUrl}/api/live-artifacts/artifact-1/project-save-state?projectId=project-1`);
    return { response, body: await response.json() as { version: number; revision: string } };
  }

  async function save(request: CoreUiCustomizationSaveRequest) {
    const response = await fetch(`${baseUrl}/api/live-artifacts/artifact-1/project-save?projectId=project-1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    return { response, body: await response.json() as Record<string, unknown> };
  }

  function request(requestId: string, baseRevision: string, settings: CoreUiCustomizationSaveSettings): CoreUiCustomizationSaveRequest {
    return {
      type: 'od:live-artifact-project-save-request',
      version: CORE_UI_CUSTOMIZATION_SAVE_CONTRACT_VERSION,
      requestId,
      kind: 'core-ui-customization',
      baseRevision,
      settings,
    };
  }

  it('returns revisioned success, idempotent replay, explicit stale conflict, and serialized concurrent behavior', async () => {
    const initial = await state();
    expect(initial.response.status).toBe(200);
    expect(initial.response.headers.get('cache-control')).toBe('no-store');
    expect(initial.body).toEqual({ version: 2, revision: coreUiCustomizationRevision(oldSettings) });

    const oceanSettings: CoreUiCustomizationSaveSettings = {
      ...oldSettings,
      field: 'ocean',
      sidebar: 'ocean-raised',
    };
    const saveRequest = request('request-ocean', initial.body.revision, oceanSettings);
    const first = await save(saveRequest);
    expect(first.response.status).toBe(200);
    expect(first.body).toMatchObject({
      requestId: 'request-ocean', ok: true, code: 'saved', revision: coreUiCustomizationRevision(oceanSettings),
    });
    const updatesAfterFirst = updateCount;
    const duplicate = await save(saveRequest);
    expect(duplicate.response.status).toBe(200);
    expect(duplicate.body).toEqual(first.body);
    expect(updateCount).toBe(updatesAfterFirst);

    const stale = await save(request('request-stale', initial.body.revision, { ...oceanSettings, data: 'harbor-steel' }));
    expect(stale.response.status).toBe(409);
    expect(stale.body).toMatchObject({
      requestId: 'request-stale', ok: false, code: 'conflict', revision: first.body.revision,
      message: expect.stringContaining('preview selections remain local'),
    });

    const current = await state();
    const concurrentASettings: CoreUiCustomizationSaveSettings = { ...oceanSettings, selected: 'silvered-slate' };
    const concurrentBSettings: CoreUiCustomizationSaveSettings = { ...oceanSettings, selected: 'harbor-steel' };
    const [concurrentA, concurrentB] = await Promise.all([
      save(request('request-concurrent-a', current.body.revision, concurrentASettings)),
      save(request('request-concurrent-b', current.body.revision, concurrentBSettings)),
    ]);
    expect([concurrentA.response.status, concurrentB.response.status].sort()).toEqual([200, 409]);
    const winner = concurrentA.response.status === 200 ? concurrentA : concurrentB;
    const loser = concurrentA.response.status === 409 ? concurrentA : concurrentB;
    expect(winner.body).toMatchObject({ ok: true, code: 'saved' });
    expect(loser.body).toMatchObject({ ok: false, code: 'conflict', revision: winner.body.revision });

    const [data, source, artifactSource] = await Promise.all([
      readFile(path.join(projectDir, 'data.json'), 'utf8').then(JSON.parse),
      readFile(path.join(projectDir, 'live-source.json'), 'utf8').then(JSON.parse),
      readFile(path.join(projectDir, 'artifact.json'), 'utf8').then(JSON.parse),
    ]);
    expect(data).toEqual(source);
    expect(data).toEqual(artifactSource.document.dataJson);
    expect(data).toEqual(registered.document.dataJson);
  });

  it('returns an explicit validation receipt for a recognized invalid request', async () => {
    const current = await state();
    const invalid = {
      ...request('request-invalid', current.body.revision, oldSettings),
      settings: { ...oldSettings, field: 'ocean-line' },
    };
    const response = await fetch(`${baseUrl}/api/live-artifacts/artifact-1/project-save?projectId=project-1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(invalid),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      requestId: 'request-invalid', ok: false, code: 'validation_error', revision: null,
    });
    expect(updateCount).toBe(0);
  });

  it('rejects a canonical file symlink that escapes the resolved external project root', async () => {
    const outsidePath = path.join(root, 'outside-data.json');
    const outsideContents = `${JSON.stringify({ secret: 'outside', uiCustomization: canonical(oldSettings) })}\n`;
    await writeFile(outsidePath, outsideContents, 'utf8');
    await rm(path.join(projectDir, 'data.json'));
    await symlink(outsidePath, path.join(projectDir, 'data.json'));

    const stateResponse = await fetch(`${baseUrl}/api/live-artifacts/artifact-1/project-save-state?projectId=project-1`);
    expect(stateResponse.status).toBe(500);
    const saveResponse = await save(request('request-symlink', coreUiCustomizationRevision(oldSettings), oldSettings));
    expect(saveResponse.response.status).toBe(500);
    expect(saveResponse.body).toMatchObject({ ok: false, code: 'failed' });
    expect(await readFile(outsidePath, 'utf8')).toBe(outsideContents);
    expect(updateCount).toBe(0);
  });
});
