import { describe, expect, it } from 'vitest';

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
