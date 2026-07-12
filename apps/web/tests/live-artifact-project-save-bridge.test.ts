import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

import { activeCoreUiProjectSaveRequest } from '../src/live-artifacts/project-save-bridge';

const settings = {
  field: 'carbon-blue',
  sidebar: 'ocean-deep',
  tabs: 'wet-slate',
  selected: 'storm-slate',
  headers: 'mineral-blue',
  data: 'clouded-steel',
};

const request = {
  type: 'od:live-artifact-project-save-request',
  version: 1,
  requestId: 'save-1',
  kind: 'core-ui-customization',
  settings,
};

describe('live artifact project save host bridge', () => {
  it('mounts the bridge in the ordinary HTML viewer that owns the visible project template iframe', async () => {
    const source = await readFile(new URL('../src/components/FileViewer.tsx', import.meta.url), 'utf8');
    const liveViewerStart = source.indexOf('export function LiveArtifactViewer(');
    const htmlViewerStart = source.indexOf('function HtmlViewer(');
    const htmlViewerEnd = source.indexOf('function ImageViewer(', htmlViewerStart);
    const bridgeCall = source.indexOf('activeCoreUiProjectSaveRequest(', htmlViewerStart);
    expect(liveViewerStart).toBeGreaterThan(-1);
    expect(htmlViewerStart).toBeGreaterThan(liveViewerStart);
    expect(bridgeCall).toBeGreaterThan(htmlViewerStart);
    expect(bridgeCall).toBeLessThan(htmlViewerEnd);
    expect(source.slice(liveViewerStart, htmlViewerStart)).not.toContain('activeCoreUiProjectSaveRequest(');
    expect(source.slice(htmlViewerStart, htmlViewerEnd)).toContain('iframeRef.current?.contentWindow');
  });

  it('accepts the exact request only from the active preview window', () => {
    const activeWindow = {} as Window;
    expect(activeCoreUiProjectSaveRequest(activeWindow, activeWindow, request)).toEqual(request);
    expect(activeCoreUiProjectSaveRequest({} as Window, activeWindow, request)).toBeNull();
    expect(activeCoreUiProjectSaveRequest(activeWindow, {} as Window, request)).toBeNull();
  });

  it.each([
    ['missing role', { ...request, settings: { ...settings, data: undefined } }],
    ['extra role', { ...request, settings: { ...settings, footer: 'carbon-blue' } }],
    ['invalid value', { ...request, settings: { ...settings, tabs: 'hot-pink' } }],
    ['extra request field', { ...request, projectId: 'attacker-project' }],
  ])('rejects %s', (_label, candidate) => {
    const activeWindow = {} as Window;
    expect(activeCoreUiProjectSaveRequest(activeWindow, activeWindow, candidate)).toBeNull();
  });
});
