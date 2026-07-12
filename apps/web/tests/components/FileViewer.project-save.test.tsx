// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileViewer } from '../../src/components/FileViewer';
import type { ProjectFile } from '../../src/types';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Core UI rendered project viewer save', () => {
  it('interpolates data.json, accepts Save from its real preview window, and updates all canonical files', async () => {
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
      if (url.endsWith('/files')) {
        return new Response(JSON.stringify({ files: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.endsWith('/deployments')) {
        return new Response(JSON.stringify({ deployments: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/project-save') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as {
          requestId: string;
          settings: Record<string, string>;
        };
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
          version: 1,
          requestId: body.requestId,
          ok: true,
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
    window.dispatchEvent(new MessageEvent('message', {
      source: previewWindow,
      data: {
        type: 'od:live-artifact-project-save-request',
        version: 1,
        requestId: 'viewer-save-1',
        kind: 'core-ui-customization',
        settings: {
          field: 'ocean-deep',
          sidebar: 'mineral-blue',
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
    expect(canonical.data.uiCustomization).toEqual(canonical.liveSource.uiCustomization);
    expect(canonical.data.uiCustomization).toEqual(canonical.artifact.document.dataJson.uiCustomization);
    expect(canonical.data.uiCustomization).toEqual({
      field: 'ocean-deep',
      sidebar: 'mineral-blue',
      tabs: 'harbor-steel',
      selected: 'silvered-slate',
      panelHeaders: 'muted-fjord',
      data: 'clouded-steel',
    });
  });
});
