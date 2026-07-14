// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { CoreUiCustomizationSaveRequest } from '@open-design/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileViewer } from '../../src/components/FileViewer';
import type { ProjectFile } from '../../src/types';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Core UI rendered project viewer save', () => {
  it('interpolates data.json, accepts Save from its real preview window, and updates all canonical files', async () => {
    const baseRevision = `sha256:${'a'.repeat(64)}`;
    const nextRevision = `sha256:${'b'.repeat(64)}`;
    const conflictRevision = `sha256:${'c'.repeat(64)}`;
    const postedRequests: Array<Pick<CoreUiCustomizationSaveRequest, 'requestId' | 'baseRevision' | 'settings'>> = [];
    const canonical = {
      data: { uiCustomization: { field: 'carbon-blue' } },
      liveSource: { uiCustomization: { field: 'carbon-blue' } },
      artifact: { document: { dataJson: { uiCustomization: { field: 'carbon-blue' } } } },
    };
    const dataJson = {
      uiCustomization: {
        field: 'carbon-blue',
        sidebar: 'carbon-blue',
        tabs: 'wet-slate',
        selected: 'storm-slate',
        panelHeaders: 'carbon-blue',
        data: 'wet-slate',
      },
      label: 'Core & UI',
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/raw/data.json')) {
        return new Response(JSON.stringify(dataJson), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/project-save-state')) {
        return new Response(JSON.stringify({ version: 2, revision: baseRevision }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/files')) {
        return new Response(JSON.stringify({ files: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/deployments')) {
        return new Response(JSON.stringify({ deployments: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/project-save') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Pick<
          CoreUiCustomizationSaveRequest,
          'requestId' | 'settings' | 'version' | 'baseRevision'
        >;
        postedRequests.push(body);
        expect(body.version).toBe(2);
        if (body.requestId === 'viewer-save-stale') {
          return new Response(JSON.stringify({
            type: 'od:live-artifact-project-save-result',
            version: 2,
            requestId: body.requestId,
            ok: false,
            code: 'conflict',
            revision: conflictRevision,
            message: 'Canonical customization changed after this preview was opened. Your preview selections remain local.',
          }), { status: 409, headers: { 'content-type': 'application/json' } });
        }
        const next = {
          field: body.settings.field,
          sidebar: body.settings.sidebar,
          tabs: body.settings.tabs,
          selected: body.settings.selected,
          panelHeaders: body.settings.headers,
          data: body.settings.data,
        };
        canonical.data.uiCustomization = next;
        canonical.liveSource.uiCustomization = next;
        canonical.artifact.document.dataJson.uiCustomization = next;
        return new Response(JSON.stringify({
          type: 'od:live-artifact-project-save-result',
          version: 2,
          requestId: body.requestId,
          ok: true,
          code: 'saved',
          revision: nextRevision,
          message: 'Saved to canonical project files.',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const file: ProjectFile = {
      name: 'template.html',
      path: 'template.html',
      type: 'file',
      size: 1024,
      mtime: 1710000000,
      kind: 'html',
      mime: 'text/html',
      artifactManifest: {
        version: 1,
        kind: 'html',
        title: 'Core UI',
        entry: 'template.html',
        renderer: 'html',
        exports: ['html'],
      },
    };
    const template = `<!doctype html>
      <style>:root{--field:var(--{{data.uiCustomization.field}})}</style>
      <p>{{data.label}}</p>
      <button id="save">Save</button>
      <script>window.__coreUiSaveReady = true;</script>`;

    render(
      <FileViewer
        projectId="project-1"
        projectKind="prototype"
        file={file}
        liveHtml={template}
        projectSaveArtifactId="la-core-ui"
      />,
    );

    const frame = await screen.findByTestId('artifact-preview-frame') as HTMLIFrameElement;
    await waitFor(() => {
      expect(frame.srcdoc).toContain('--field:var(--carbon-blue)');
      expect(frame.srcdoc).toContain('Core &amp; UI');
      expect(frame.srcdoc).not.toContain('{{data.');
    });
    const previewWindow = frame.contentWindow;
    if (!previewWindow) throw new Error('rendered preview window is unavailable');
    const postMessageSpy = vi.spyOn(previewWindow, 'postMessage');
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => (
      String(input).includes('/live-artifacts/la-core-ui/project-save-state')
    ))).toBe(true));
    window.dispatchEvent(new MessageEvent('message', {
      source: previewWindow,
      data: {
        type: 'od:live-artifact-project-save-request',
        version: 1,
        requestId: 'viewer-save-1',
        kind: 'core-ui-customization',
        settings: {
          field: 'ocean',
          sidebar: 'ocean-raised',
          tabs: 'harbor-steel',
          selected: 'silvered-slate',
          headers: 'muted-fjord',
          data: 'clouded-steel',
        },
      },
    }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/live-artifacts/la-core-ui/project-save'),
      expect.objectContaining({ method: 'POST' }),
    ));
    await waitFor(() => expect(postMessageSpy).toHaveBeenCalledWith(
      {
        type: 'od:live-artifact-project-save-result',
        version: 1,
        requestId: 'viewer-save-1',
        ok: true,
        code: 'saved',
        revision: nextRevision,
        message: 'Saved to canonical project files.',
      },
      '*',
    ));
    expect(canonical.data.uiCustomization).toEqual(canonical.liveSource.uiCustomization);
    expect(canonical.data.uiCustomization).toEqual(canonical.artifact.document.dataJson.uiCustomization);
    expect(canonical.data.uiCustomization).toEqual({
      field: 'ocean',
      sidebar: 'ocean-raised',
      tabs: 'harbor-steel',
      selected: 'silvered-slate',
      panelHeaders: 'muted-fjord',
      data: 'clouded-steel',
    });
    expect(postedRequests[0]).toMatchObject({ requestId: 'viewer-save-1', baseRevision });

    const canonicalAfterSuccess = JSON.stringify(canonical);
    postMessageSpy.mockClear();
    window.dispatchEvent(new MessageEvent('message', {
      source: previewWindow,
      data: {
        type: 'od:live-artifact-project-save-request',
        version: 1,
        requestId: 'viewer-save-stale',
        kind: 'core-ui-customization',
        settings: {
          field: 'silvered-slate',
          sidebar: 'ocean-raised',
          tabs: 'harbor-steel',
          selected: 'ocean',
          headers: 'muted-fjord',
          data: 'clouded-steel',
        },
      },
    }));
    await waitFor(() => expect(postMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'od:live-artifact-project-save-result',
        version: 1,
        requestId: 'viewer-save-stale',
        ok: false,
        code: 'conflict',
        revision: conflictRevision,
        message: expect.stringContaining('preview selections remain local'),
      }),
      '*',
    ));
    expect(postedRequests[1]).toMatchObject({ requestId: 'viewer-save-stale', baseRevision: nextRevision });
    expect(JSON.stringify(canonical)).toBe(canonicalAfterSuccess);

    const saveCallsBeforeInvalid = fetchMock.mock.calls.filter(([input, init]) => (
      String(input).includes('/project-save') && init?.method === 'POST'
    )).length;
    postMessageSpy.mockClear();
    window.dispatchEvent(new MessageEvent('message', {
      source: previewWindow,
      data: {
        type: 'od:live-artifact-project-save-request',
        version: 1,
        requestId: 'viewer-save-invalid',
        kind: 'core-ui-customization',
        settings: {
          field: 'ocean-line',
          sidebar: 'ocean-raised',
          tabs: 'harbor-steel',
          selected: 'silvered-slate',
          headers: 'muted-fjord',
          data: 'clouded-steel',
        },
      },
    }));
    await waitFor(() => expect(postMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'od:live-artifact-project-save-result',
        requestId: 'viewer-save-invalid',
        ok: false,
        message: 'Customization settings are invalid.',
      }),
      '*',
    ));
    expect(fetchMock.mock.calls.filter(([input, init]) => (
      String(input).includes('/project-save') && init?.method === 'POST'
    ))).toHaveLength(saveCallsBeforeInvalid);
  });

  it('does not let an in-flight save from a previous project overwrite the newly opened revision', async () => {
    const revisionA = `sha256:${'a'.repeat(64)}`;
    const revisionB = `sha256:${'b'.repeat(64)}`;
    const oldResultRevision = `sha256:${'c'.repeat(64)}`;
    const newResultRevision = `sha256:${'d'.repeat(64)}`;
    let resolveOldSave!: (response: Response) => void;
    const oldSave = new Promise<Response>((resolve) => { resolveOldSave = resolve; });
    const posted: CoreUiCustomizationSaveRequest[] = [];
    const dataJson = {
      uiCustomization: {
        field: 'carbon-blue', sidebar: 'ocean-deep', tabs: 'wet-slate', selected: 'storm-slate',
        panelHeaders: 'mineral-blue', data: 'clouded-steel',
      },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/project-save-state')) {
        const revision = url.includes('projectId=project-b') ? revisionB : revisionA;
        expect(init).toEqual({ cache: 'no-store' });
        return new Response(JSON.stringify({ version: 2, revision }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/raw/data.json')) {
        return new Response(JSON.stringify(dataJson), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/files')) {
        return new Response(JSON.stringify({ files: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/deployments')) {
        return new Response(JSON.stringify({ deployments: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/project-save') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as CoreUiCustomizationSaveRequest;
        posted.push(body);
        if (url.includes('/artifact-a/')) return oldSave;
        return new Response(JSON.stringify({
          type: 'od:live-artifact-project-save-result',
          version: 2,
          requestId: body.requestId,
          ok: true,
          code: 'saved',
          revision: newResultRevision,
          message: 'Saved to canonical project files.',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const file: ProjectFile = {
      name: 'template.html', path: 'template.html', type: 'file', size: 1024, mtime: 1710000000,
      kind: 'html', mime: 'text/html',
      artifactManifest: {
        version: 1, kind: 'html', title: 'Core UI', entry: 'template.html', renderer: 'html', exports: ['html'],
      },
    };
    const settings = {
      field: 'ocean' as const,
      sidebar: 'ocean-raised' as const,
      tabs: 'harbor-steel' as const,
      selected: 'silvered-slate' as const,
      headers: 'muted-fjord' as const,
      data: 'clouded-steel' as const,
    };
    const view = render(
      <FileViewer
        projectId="project-a"
        projectKind="prototype"
        file={file}
        liveHtml="<!doctype html><main>Core UI</main>"
        projectSaveArtifactId="artifact-a"
      />,
    );
    const firstFrame = await screen.findByTestId('artifact-preview-frame') as HTMLIFrameElement;
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => (
      String(input).includes('/artifact-a/project-save-state')
    ))).toBe(true));
    if (!firstFrame.contentWindow) throw new Error('first preview window unavailable');
    window.dispatchEvent(new MessageEvent('message', {
      source: firstFrame.contentWindow,
      data: {
        type: 'od:live-artifact-project-save-request', version: 1, requestId: 'save-old',
        kind: 'core-ui-customization', settings,
      },
    }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toMatchObject({ requestId: 'save-old', baseRevision: revisionA });

    view.rerender(
      <FileViewer
        projectId="project-b"
        projectKind="prototype"
        file={file}
        liveHtml="<!doctype html><main>Core UI</main>"
        projectSaveArtifactId="artifact-b"
      />,
    );
    const secondFrame = await screen.findByTestId('artifact-preview-frame') as HTMLIFrameElement;
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => (
      String(input).includes('/artifact-b/project-save-state')
    ))).toBe(true));
    resolveOldSave(new Response(JSON.stringify({
      type: 'od:live-artifact-project-save-result',
      version: 2,
      requestId: 'save-old',
      ok: true,
      code: 'saved',
      revision: oldResultRevision,
      message: 'Saved to canonical project files.',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await Promise.resolve();
    if (!secondFrame.contentWindow) throw new Error('second preview window unavailable');
    window.dispatchEvent(new MessageEvent('message', {
      source: secondFrame.contentWindow,
      data: {
        type: 'od:live-artifact-project-save-request', version: 1, requestId: 'save-new',
        kind: 'core-ui-customization', settings,
      },
    }));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1]).toMatchObject({ requestId: 'save-new', baseRevision: revisionB });
  });
});
