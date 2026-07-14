import {
  CORE_UI_CUSTOMIZATION_SAVE_CONTRACT_VERSION,
  CORE_UI_CUSTOMIZATION_SAVE_PALETTE_VALUES,
  CORE_UI_CUSTOMIZATION_SAVE_ROLE_NAMES,
  type CoreUiCustomizationSaveRequest,
  type CoreUiCustomizationSaveSettings,
  type LiveArtifact,
} from '@open-design/contracts';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  CoreUiProjectSaveConflictError,
  CoreUiProjectSaveTransactionError,
  coreUiCustomizationRevision,
  defaultCoreUiProjectSaveOperations,
  readCoreUiProjectCustomizationState,
  saveCoreUiProjectCustomization,
  type CoreUiProjectSaveOperations,
  validateCoreUiCustomizationSaveRequest,
} from '../../src/live-artifacts/project-save.js';
import {
  createLiveArtifact,
  ensureLiveArtifactPreview,
  getLiveArtifact,
  updateLiveArtifact,
} from '../../src/live-artifacts/store.js';

const oldSettings: CoreUiCustomizationSaveSettings = {
  field: 'ocean-deep',
  sidebar: 'carbon-blue',
  tabs: 'wet-slate',
  selected: 'storm-slate',
  headers: 'mineral-blue',
  data: 'clouded-steel',
};

const oldCanonicalCustomization = {
  field: oldSettings.field,
  sidebar: oldSettings.sidebar,
  tabs: oldSettings.tabs,
  selected: oldSettings.selected,
  panelHeaders: oldSettings.headers,
  data: oldSettings.data,
};

const request: CoreUiCustomizationSaveRequest = {
  type: 'od:live-artifact-project-save-request',
  version: CORE_UI_CUSTOMIZATION_SAVE_CONTRACT_VERSION,
  requestId: 'save-1',
  kind: 'core-ui-customization',
  baseRevision: coreUiCustomizationRevision(oldSettings),
  settings: {
    field: 'ocean',
    sidebar: 'ocean-raised',
    tabs: 'wet-slate',
    selected: 'storm-slate',
    headers: 'mineral-blue',
    data: 'clouded-steel',
  },
};

const canonicalRoleNames = {
  field: 'field',
  sidebar: 'sidebar',
  tabs: 'tabs',
  selected: 'selected',
  headers: 'panelHeaders',
  data: 'data',
} as const;
const paletteCases = CORE_UI_CUSTOMIZATION_SAVE_ROLE_NAMES.flatMap((role) => (
  CORE_UI_CUSTOMIZATION_SAVE_PALETTE_VALUES.map((value) => [role, value] as const)
));
const disallowedPaletteValues = ['ocean-line', 'teal', 'amber', 'action-blue', 'success'] as const;

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

function harness(options: {
  failWriteNumbers?: readonly number[];
  failArtifactUpdateNumbers?: readonly number[];
  failPreviewNumbers?: readonly number[];
} = {}) {
  const files = new Map<string, string>([
    ['/project/data.json', JSON.stringify({ keep: 'data', uiCustomization: oldCanonicalCustomization })],
    ['/project/live-source.json', JSON.stringify({ keep: 'source', uiCustomization: oldCanonicalCustomization })],
    ['/project/artifact.json', JSON.stringify({
      keep: 'artifact',
      document: {
        format: 'html_template_v1',
        templatePath: 'template.html',
        generatedPreviewPath: 'index.html',
        dataPath: 'data.json',
        dataJson: { keep: 'document', uiCustomization: oldCanonicalCustomization },
      },
    })],
  ]);
  const originals = new Map(files);
  let registered = artifact({ keep: 'registered', uiCustomization: oldCanonicalCustomization });
  let writeNumber = 0;
  let artifactUpdateNumber = 0;
  let previewNumber = 0;
  const failWriteNumbers = new Set(options.failWriteNumbers ?? []);
  const failArtifactUpdateNumbers = new Set(options.failArtifactUpdateNumbers ?? []);
  const failPreviewNumbers = new Set(options.failPreviewNumbers ?? []);
  const events: string[] = [];
  const operations: CoreUiProjectSaveOperations = {
    resolveCanonicalFilePaths: async () => [
      '/project/data.json',
      '/project/live-source.json',
      '/project/artifact.json',
    ],
    readText: async (filePath) => files.get(filePath)!,
    writeTextAtomic: async (filePath, contents) => {
      writeNumber += 1;
      events.push(`write:${filePath}`);
      if (failWriteNumbers.has(writeNumber)) throw new Error(`write ${writeNumber} failed`);
      files.set(filePath, contents);
    },
    getLiveArtifact: async () => registered,
    updateLiveArtifact: async (document) => {
      artifactUpdateNumber += 1;
      events.push('update-artifact');
      if (failArtifactUpdateNumbers.has(artifactUpdateNumber)) {
        throw new Error(`artifact update ${artifactUpdateNumber} failed`);
      }
      registered = { ...registered, document };
      return registered;
    },
    ensureLiveArtifactPreview: vi.fn(async () => {
      previewNumber += 1;
      events.push('preview');
      if (failPreviewNumbers.has(previewNumber)) throw new Error(`preview ${previewNumber} failed`);
      return { artifact: registered, html: '<!doctype html><main>updated</main>' };
    }),
  };
  return {
    events,
    files,
    operations,
    originals,
    registered: () => registered,
    counts: () => ({ writeNumber, artifactUpdateNumber, previewNumber }),
  };
}

describe('Core UI canonical project save', () => {
  it.each([
    ['missing role', { ...request, settings: { ...request.settings, data: undefined } }],
    ['extra role', { ...request, settings: { ...request.settings, footer: 'carbon-blue' } }],
    ['invalid value', { ...request, settings: { ...request.settings, tabs: 'hot-pink' } }],
    ['extra path field', { ...request, path: '../outside/data.json' }],
  ])('rejects %s before writing', async (_label, candidate) => {
    const state = harness();
    await expect(saveCoreUiProjectCustomization({ projectDir: '/project', request: candidate, operations: state.operations }))
      .rejects.toThrow(/Customization|Save request/);
    expect(state.events).toEqual([]);
    for (const [filePath, contents] of state.originals) expect(state.files.get(filePath)).toBe(contents);
  });

  it.each(disallowedPaletteValues)('rejects non-governed value %s', (value) => {
    expect(() => validateCoreUiCustomizationSaveRequest({
      ...request,
      settings: { ...request.settings, field: value },
    })).toThrow('Customization value for field is invalid.');
  });

  it.each(paletteCases)('saves governed role %s with value %s', async (role, value) => {
    const state = harness();
    const candidate: CoreUiCustomizationSaveRequest = {
      ...request,
      requestId: `save-${role}-${value}`,
      settings: { ...request.settings, [role]: value },
    };
    expect(validateCoreUiCustomizationSaveRequest(candidate)).toEqual(candidate);

    await saveCoreUiProjectCustomization({ projectDir: '/project', request: candidate, operations: state.operations });

    const data = JSON.parse(state.files.get('/project/data.json')!);
    const source = JSON.parse(state.files.get('/project/live-source.json')!);
    const sourceArtifact = JSON.parse(state.files.get('/project/artifact.json')!);
    const registered = state.registered().document.dataJson.uiCustomization;
    expect(data.uiCustomization).toEqual(source.uiCustomization);
    expect(data.uiCustomization).toEqual(sourceArtifact.document.dataJson.uiCustomization);
    expect(data.uiCustomization).toEqual(registered);
    expect(data.uiCustomization[canonicalRoleNames[role]]).toBe(value);
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
    expect(data.uiCustomization).toEqual(state.registered().document.dataJson.uiCustomization);
    expect(data.uiCustomization).toEqual({
      field: 'ocean', sidebar: 'ocean-raised', tabs: 'wet-slate', selected: 'storm-slate',
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
    const oldCustomization = oldCanonicalCustomization;
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

      expect(result.html).toContain('--field:ocean');
      expect(result.previousRevision).toBe(request.baseRevision);
      expect(result.revision).toBe(coreUiCustomizationRevision(request.settings));
      expect(await readFile(path.join(projectDir, 'template.html'), 'utf8')).toBe(visibleProjectTemplate);
      expect(await readFile(created.paths.templateHtmlPath, 'utf8')).toBe(registeredTemplate);
      expect(await readFile(created.paths.templateHtmlPath, 'utf8')).not.toContain('<script');
      const persisted = await getLiveArtifact({ projectsRoot, projectId, artifactId });
      const expectedCustomization = {
        field: 'ocean', sidebar: 'ocean-raised', tabs: 'wet-slate', selected: 'storm-slate',
        panelHeaders: 'mineral-blue', data: 'clouded-steel',
      };
      const dataJson = JSON.parse(await readFile(path.join(projectDir, 'data.json'), 'utf8'));
      const liveSourceJson = JSON.parse(await readFile(path.join(projectDir, 'live-source.json'), 'utf8'));
      const artifactJson = JSON.parse(await readFile(path.join(projectDir, 'artifact.json'), 'utf8'));
      expect(dataJson).toEqual({ meta: { product: 'Core UI' }, uiCustomization: expectedCustomization });
      expect(liveSourceJson).toEqual(dataJson);
      expect(artifactJson.document.dataJson).toEqual(dataJson);
      expect(persisted.artifact.document.dataJson).toEqual(dataJson);
      expect(await readCoreUiProjectCustomizationState({ projectDir })).toEqual({
        version: CORE_UI_CUSTOMIZATION_SAVE_CONTRACT_VERSION,
        revision: result.revision,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([1, 2, 3])('handles canonical write %i failure without partial state', async (failedWrite) => {
    const state = harness({ failWriteNumbers: [failedWrite] });
    await expect(saveCoreUiProjectCustomization({ projectDir: '/project', request, operations: state.operations }))
      .rejects.toThrow(`write ${failedWrite} failed`);
    for (const [filePath, contents] of state.originals) expect(state.files.get(filePath)).toBe(contents);
  });

  it('restores all canonical files when the registered artifact update fails', async () => {
    const state = harness({ failArtifactUpdateNumbers: [1] });
    const originalRegistered = await state.operations.getLiveArtifact();
    await expect(saveCoreUiProjectCustomization({ projectDir: '/project', request, operations: state.operations }))
      .rejects.toThrow('artifact update 1 failed');
    for (const [filePath, contents] of state.originals) expect(state.files.get(filePath)).toBe(contents);
    expect(state.registered().document).toEqual(originalRegistered.document);
    expect(state.counts()).toEqual({ writeNumber: 6, artifactUpdateNumber: 2, previewNumber: 1 });
  });

  it('restores all canonical and registered files when preview regeneration fails', async () => {
    const state = harness({ failPreviewNumbers: [1] });
    const originalRegistered = await state.operations.getLiveArtifact();
    await expect(saveCoreUiProjectCustomization({ projectDir: '/project', request, operations: state.operations }))
      .rejects.toThrow('preview 1 failed');
    for (const [filePath, contents] of state.originals) expect(state.files.get(filePath)).toBe(contents);
    expect(state.registered().document).toEqual(originalRegistered.document);
    expect(state.events).toEqual(expect.arrayContaining(['preview', 'update-artifact']));
  });

  it('reports an incomplete rollback without hiding the original failure', async () => {
    const state = harness({ failWriteNumbers: [3, 4] });
    const failure = await saveCoreUiProjectCustomization({ projectDir: '/project', request, operations: state.operations })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CoreUiProjectSaveTransactionError);
    expect(failure).toMatchObject({
      rollbackOutcome: 'incomplete',
      originalError: expect.objectContaining({ message: 'write 3 failed' }),
    });
    expect(state.files.get('/project/data.json')).toBe(state.originals.get('/project/data.json'));
    expect(state.files.get('/project/live-source.json')).not.toBe(state.originals.get('/project/live-source.json'));
    expect(state.files.get('/project/artifact.json')).toBe(state.originals.get('/project/artifact.json'));
  });

  it('rejects a stale revision before any mutation and preserves preview selections for retry', async () => {
    const state = harness();
    const staleRequest = {
      ...request,
      baseRevision: coreUiCustomizationRevision({ ...oldSettings, field: 'silvered-slate' }),
    };
    const failure = await saveCoreUiProjectCustomization({
      projectDir: '/project', request: staleRequest, operations: state.operations,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CoreUiProjectSaveConflictError);
    expect(failure).toMatchObject({ currentRevision: request.baseRevision });
    expect((failure as Error).message).toContain('preview selections remain local');
    expect(state.events).toEqual([]);
    for (const [filePath, contents] of state.originals) expect(state.files.get(filePath)).toBe(contents);
  });
});
