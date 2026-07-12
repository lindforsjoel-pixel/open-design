import type { CoreUiCustomizationSaveRequest, LiveArtifact } from '@open-design/contracts';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  defaultCoreUiProjectSaveOperations,
  saveCoreUiProjectCustomization,
  type CoreUiProjectSaveOperations,
} from '../../src/live-artifacts/project-save.js';
import {
  createLiveArtifact,
  ensureLiveArtifactPreview,
  getLiveArtifact,
  updateLiveArtifact,
} from '../../src/live-artifacts/store.js';

const request: CoreUiCustomizationSaveRequest = {
  type: 'od:live-artifact-project-save-request',
  version: 1,
  requestId: 'save-1',
  kind: 'core-ui-customization',
  settings: {
    field: 'carbon-blue',
    sidebar: 'ocean-deep',
    tabs: 'wet-slate',
    selected: 'storm-slate',
    headers: 'mineral-blue',
    data: 'clouded-steel',
  },
};

function artifact(dataJson: Record<string, unknown>): LiveArtifact {
  return {
    schemaVersion: 1,
    id: 'la-core-ui',
    projectId: 'project-1',
    title: 'Core UI',
    slug: 'core-ui',
    status: 'active',
    pinned: false,
    preview: { type: 'html', entry: 'index.html' },
    refreshStatus: 'idle',
    createdAt: '2026-07-12T00:00:00.000Z',
    updatedAt: '2026-07-12T00:00:00.000Z',
    document: {
      format: 'html_template_v1',
      templatePath: 'template.html',
      generatedPreviewPath: 'index.html',
      dataPath: 'data.json',
      dataJson,
    },
  };
}

function harness(failWriteNumber?: number, failPreview = false) {
  const files = new Map<string, string>([
    ['/project/data.json', JSON.stringify({ keep: 'data', uiCustomization: { field: 'old' } })],
    ['/project/live-source.json', JSON.stringify({ keep: 'source', uiCustomization: { field: 'old' } })],
    ['/project/artifact.json', JSON.stringify({
      keep: 'artifact',
      document: {
        format: 'html_template_v1',
        templatePath: 'template.html',
        generatedPreviewPath: 'index.html',
        dataPath: 'data.json',
        dataJson: { keep: 'document', uiCustomization: { field: 'old' } },
      },
    })],
  ]);
  const originals = new Map(files);
  let registered = artifact({ keep: 'registered', uiCustomization: { field: 'old' } });
  let writeNumber = 0;
  const events: string[] = [];
  const operations: CoreUiProjectSaveOperations = {
    readText: async (filePath) => files.get(filePath)!,
    writeTextAtomic: async (filePath, contents) => {
      writeNumber += 1;
      events.push(`write:${filePath}`);
      if (writeNumber === failWriteNumber) throw new Error(`write ${writeNumber} failed`);
      files.set(filePath, contents);
    },
    getLiveArtifact: async () => registered,
    updateLiveArtifact: async (document) => {
      events.push('update-artifact');
      registered = { ...registered, document };
      return registered;
    },
    ensureLiveArtifactPreview: vi.fn(async () => {
      events.push('preview');
      if (failPreview && events.filter((event) => event === 'preview').length === 1) throw new Error('preview failed');
      return { artifact: registered, html: '<!doctype html><main>updated</main>' };
    }),
  };
  return { events, files, operations, originals, registered: () => registered };
}

describe('Core UI canonical project save', () => {
  it.each([
    ['missing role', { ...request, settings: { ...request.settings, data: undefined } }],
    ['extra role', { ...request, settings: { ...request.settings, footer: 'carbon-blue' } }],
    ['invalid value', { ...request, settings: { ...request.settings, tabs: 'hot-pink' } }],
  ])('rejects %s before writing', async (_label, candidate) => {
    const state = harness();
    await expect(saveCoreUiProjectCustomization({ projectDir: '/project', request: candidate, operations: state.operations }))
      .rejects.toThrow(/Customization/);
    expect(state.events).toEqual([]);
    for (const [filePath, contents] of state.originals) expect(state.files.get(filePath)).toBe(contents);
  });

  it('writes identical customization to all canonical files before confirming the preview', async () => {
    const state = harness();
    await saveCoreUiProjectCustomization({ projectDir: '/project', request, operations: state.operations });

    const data = JSON.parse(state.files.get('/project/data.json')!);
    const source = JSON.parse(state.files.get('/project/live-source.json')!);
    const sourceArtifact = JSON.parse(state.files.get('/project/artifact.json')!);
    expect(data.keep).toBe('data');
    expect(source.keep).toBe('source');
    expect(sourceArtifact.keep).toBe('artifact');
    expect(data.uiCustomization).toEqual(source.uiCustomization);
    expect(data.uiCustomization).toEqual(sourceArtifact.document.dataJson.uiCustomization);
    expect(data.uiCustomization).toEqual({
      field: 'carbon-blue', sidebar: 'ocean-deep', tabs: 'wet-slate', selected: 'storm-slate',
      panelHeaders: 'mineral-blue', data: 'clouded-steel',
    });
    expect(state.events.at(-1)).toBe('preview');
  });

  it('updates and regenerates through the real live-artifact store while the visible project template remains interactive', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-core-ui-save-integration-'));
    const projectsRoot = path.join(root, 'projects');
    const projectDir = path.join(root, 'mounted-core-ui');
    const projectId = 'core-ui-project';
    const registeredTemplate = '<!doctype html><style>:root{--field:{{data.uiCustomization.field}}}</style><main>Core UI</main>';
    const visibleProjectTemplate = '<!doctype html><button id="save">Save</button><script>parent.postMessage({type:"od:live-artifact-project-save-request"},"*")</script>';
    const oldCustomization = {
      field: 'ocean-deep', sidebar: 'ocean-deep', tabs: 'ocean-deep', selected: 'ocean-deep',
      panelHeaders: 'ocean-deep', data: 'ocean-deep',
    };
    try {
      await mkdir(projectDir, { recursive: true });
      const document = {
        format: 'html_template_v1' as const,
        templatePath: 'template.html' as const,
        generatedPreviewPath: 'index.html' as const,
        dataPath: 'data.json' as const,
        dataJson: { meta: { product: 'Core UI' }, uiCustomization: oldCustomization },
      };
      const canonicalArtifact = { document };
      await Promise.all([
        writeFile(path.join(projectDir, 'data.json'), JSON.stringify(document.dataJson), 'utf8'),
        writeFile(path.join(projectDir, 'live-source.json'), JSON.stringify(document.dataJson), 'utf8'),
        writeFile(path.join(projectDir, 'artifact.json'), JSON.stringify(canonicalArtifact), 'utf8'),
        writeFile(path.join(projectDir, 'template.html'), visibleProjectTemplate, 'utf8'),
      ]);
      const created = await createLiveArtifact({
        projectsRoot,
        projectId,
        input: {
          title: 'Core UI — Responsive Shell',
          slug: 'core-ui-responsive-shell',
          preview: { type: 'html', entry: 'index.html' },
          document,
        },
        templateHtml: registeredTemplate,
      });
      const artifactId = created.artifact.id;
      const operations = defaultCoreUiProjectSaveOperations(
        async () => (await getLiveArtifact({ projectsRoot, projectId, artifactId })).artifact,
        async (nextDocument) => (await updateLiveArtifact({
          projectsRoot, projectId, artifactId, input: { document: nextDocument },
        })).artifact,
        async () => ensureLiveArtifactPreview({ projectsRoot, projectId, artifactId }),
      );

      const result = await saveCoreUiProjectCustomization({ projectDir, request, operations });

      expect(result.html).toContain('--field:carbon-blue');
      expect(await readFile(path.join(projectDir, 'template.html'), 'utf8')).toBe(visibleProjectTemplate);
      expect(await readFile(created.paths.templateHtmlPath, 'utf8')).toBe(registeredTemplate);
      expect(await readFile(created.paths.templateHtmlPath, 'utf8')).not.toContain('<script');
      const persisted = await getLiveArtifact({ projectsRoot, projectId, artifactId });
      expect(persisted.artifact.document.dataJson.uiCustomization).toEqual({
        field: 'carbon-blue', sidebar: 'ocean-deep', tabs: 'wet-slate', selected: 'storm-slate',
        panelHeaders: 'mineral-blue', data: 'clouded-steel',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([2, 3])('restores earlier files when canonical write %i fails', async (failedWrite) => {
    const state = harness(failedWrite);
    await expect(saveCoreUiProjectCustomization({ projectDir: '/project', request, operations: state.operations }))
      .rejects.toThrow(`write ${failedWrite} failed`);
    for (const [filePath, contents] of state.originals) expect(state.files.get(filePath)).toBe(contents);
  });

  it('restores all canonical and registered files when regeneration fails', async () => {
    const state = harness(undefined, true);
    const originalRegistered = await state.operations.getLiveArtifact();
    await expect(saveCoreUiProjectCustomization({ projectDir: '/project', request, operations: state.operations }))
      .rejects.toThrow('preview failed');
    for (const [filePath, contents] of state.originals) expect(state.files.get(filePath)).toBe(contents);
    expect(state.registered().document).toEqual(originalRegistered.document);
    expect(state.events).toEqual(expect.arrayContaining(['preview', 'update-artifact']));
  });
});
