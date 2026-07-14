import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  CORE_UI_CUSTOMIZATION_SAVE_CONTRACT_VERSION,
  CORE_UI_CUSTOMIZATION_SAVE_PALETTE_VALUES,
  CORE_UI_CUSTOMIZATION_SAVE_ROLE_NAMES,
  type CoreUiCustomizationRevision,
} from '@open-design/contracts';

import {
  coreUiProjectSaveLegacyReceipt,
  coreUiProjectSaveRequest,
  coreUiProjectSaveRevisionUnavailableReceipt,
  coreUiProjectSaveValidationReceipt,
} from '../src/live-artifacts/project-save-bridge';
import { renderProjectTemplatePreview } from '../src/live-artifacts/project-template-preview';

const paletteCases = CORE_UI_CUSTOMIZATION_SAVE_ROLE_NAMES.flatMap((role) => (
  CORE_UI_CUSTOMIZATION_SAVE_PALETTE_VALUES.map((value) => [role, value] as const)
));
const disallowedPaletteValues = ['ocean-line', 'teal', 'amber', 'action-blue', 'success'] as const;
const baseRevision = `sha256:${'a'.repeat(64)}` as CoreUiCustomizationRevision;
const nextRevision = `sha256:${'b'.repeat(64)}` as CoreUiCustomizationRevision;

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
    expect(coreUiProjectSaveRequest(request, baseRevision)).toEqual({
      ...request,
      version: CORE_UI_CUSTOMIZATION_SAVE_CONTRACT_VERSION,
      baseRevision,
    });
  });

  it.each(paletteCases)('accepts %s role with governed value %s', (role, value) => {
    const candidate = { ...request, settings: { ...settings, [role]: value } };
    expect(coreUiProjectSaveRequest(candidate, baseRevision)).toMatchObject({
      baseRevision,
      settings: { [role]: value },
    });
  });

  it.each(disallowedPaletteValues)('rejects non-governed value %s', (value) => {
    const candidate = { ...request, settings: { ...settings, field: value } };
    expect(coreUiProjectSaveRequest(candidate, baseRevision)).toBeNull();
    expect(coreUiProjectSaveValidationReceipt(candidate, baseRevision)).toEqual({
      type: 'od:live-artifact-project-save-result',
      version: 1,
      requestId: request.requestId,
      ok: false,
      code: 'validation_error',
      revision: baseRevision,
      message: 'Customization settings are invalid.',
    });
  });

  it('only creates a validation receipt for a recognized request with a matching id', () => {
    expect(coreUiProjectSaveValidationReceipt(request, baseRevision)).toBeNull();
    expect(coreUiProjectSaveValidationReceipt({ type: 'unrelated', requestId: request.requestId }, baseRevision)).toBeNull();
    expect(coreUiProjectSaveValidationReceipt({
      ...request,
      settings: { ...settings, tabs: 'unknown-color' },
    }, baseRevision)).toMatchObject({ requestId: request.requestId, ok: false, revision: baseRevision });
  });

  it.each([
    ['missing role', { ...request, settings: { ...settings, data: undefined } }],
    ['extra role', { ...request, settings: { ...settings, footer: 'carbon-blue' } }],
    ['invalid value', { ...request, settings: { ...settings, tabs: 'hot-pink' } }],
    ['extra request field', { ...request, projectId: 'attacker-project' }],
  ])('rejects %s', (_label, candidate) => {
    expect(coreUiProjectSaveRequest(candidate, baseRevision)).toBeNull();
  });

  it('requires a server-provided canonical revision before constructing a save request', () => {
    expect(coreUiProjectSaveRequest(request, null)).toBeNull();
    expect(coreUiProjectSaveRevisionUnavailableReceipt(request)).toMatchObject({
      requestId: request.requestId,
      ok: false,
      code: 'failed',
      revision: null,
    });
  });

  it('translates a v2 server receipt for the legacy template without dropping revision or conflict semantics', () => {
    expect(coreUiProjectSaveLegacyReceipt({
      type: 'od:live-artifact-project-save-result',
      version: CORE_UI_CUSTOMIZATION_SAVE_CONTRACT_VERSION,
      requestId: request.requestId,
      ok: false,
      code: 'conflict',
      revision: nextRevision,
      message: 'Canonical customization changed; your preview selections remain local.',
    })).toEqual({
      type: 'od:live-artifact-project-save-result',
      version: 1,
      requestId: request.requestId,
      ok: false,
      code: 'conflict',
      revision: nextRevision,
      message: 'Canonical customization changed; your preview selections remain local.',
    });
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
