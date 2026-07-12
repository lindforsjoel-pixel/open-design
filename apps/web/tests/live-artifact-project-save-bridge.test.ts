import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

import { coreUiProjectSaveRequest } from '../src/live-artifacts/project-save-bridge';
import { renderProjectTemplatePreview } from '../src/live-artifacts/project-template-preview';

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
    const bridgeCall = source.indexOf('coreUiProjectSaveRequest(', htmlViewerStart);
    expect(liveViewerStart).toBeGreaterThan(-1);
    expect(htmlViewerStart).toBeGreaterThan(liveViewerStart);
    expect(bridgeCall).toBeGreaterThan(htmlViewerStart);
    expect(bridgeCall).toBeLessThan(htmlViewerEnd);
    expect(source.slice(liveViewerStart, htmlViewerStart)).not.toContain('coreUiProjectSaveRequest(');
    expect(source.slice(htmlViewerStart, htmlViewerEnd)).toContain('isOurPreviewIframeSource(event.source)');
  });

  it('accepts the exact request after the viewer authenticates its source', () => {
    expect(coreUiProjectSaveRequest(request)).toEqual(request);
  });

  it.each([
    ['missing role', { ...request, settings: { ...settings, data: undefined } }],
    ['extra role', { ...request, settings: { ...settings, footer: 'carbon-blue' } }],
    ['invalid value', { ...request, settings: { ...settings, tabs: 'hot-pink' } }],
    ['extra request field', { ...request, projectId: 'attacker-project' }],
  ])('rejects %s', (_label, candidate) => {
    expect(coreUiProjectSaveRequest(candidate)).toBeNull();
  });

  it('renders escaped project-template bindings while preserving project scripts', () => {
    const rendered = renderProjectTemplatePreview(
      '<style>:root{--field:var(--{{data.uiCustomization.field}})}</style><p>{{data.label}}</p><script>save()</script>',
      { uiCustomization: { field: 'ocean-deep' }, label: '<Core & UI>' },
    );
    expect(rendered).toContain('--field:var(--ocean-deep)');
    expect(rendered).toContain('&lt;Core &amp; UI&gt;');
    expect(rendered).toContain('<script>save()</script>');
    expect(rendered).not.toContain('{{data.');
  });
});
