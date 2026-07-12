import {
  CORE_UI_CUSTOMIZATION_SAVE_REQUEST_TYPE,
  type CoreUiCustomizationSaveRequest,
} from '@open-design/contracts';

const ROLES = ['field', 'sidebar', 'tabs', 'selected', 'headers', 'data'] as const;
const PALETTE_VALUES = new Set([
  'ocean-deep',
  'carbon-blue',
  'wet-slate',
  'storm-slate',
  'muted-fjord',
  'mineral-blue',
  'clouded-steel',
  'harbor-steel',
  'silvered-slate',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function activeCoreUiProjectSaveRequest(
  eventSource: MessageEventSource | null,
  activePreviewWindow: Window | null,
  value: unknown,
): CoreUiCustomizationSaveRequest | null {
  if (eventSource === null || eventSource !== activePreviewWindow || !isPlainObject(value)) return null;
  if (Object.keys(value).sort().join(',') !== ['type', 'version', 'requestId', 'kind', 'settings'].sort().join(',')) return null;
  const settings = value.settings;
  if (
    value.type !== CORE_UI_CUSTOMIZATION_SAVE_REQUEST_TYPE
    || value.version !== 1
    || value.kind !== 'core-ui-customization'
    || typeof value.requestId !== 'string'
    || value.requestId.trim().length === 0
    || value.requestId.length > 200
    || !isPlainObject(settings)
  ) return null;
  if (Object.keys(settings).sort().join(',') !== [...ROLES].sort().join(',')) return null;
  if (ROLES.some((role) => typeof settings[role] !== 'string' || !PALETTE_VALUES.has(settings[role]))) return null;
  return value as unknown as CoreUiCustomizationSaveRequest;
}
