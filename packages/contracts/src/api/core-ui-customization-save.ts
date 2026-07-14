export const CORE_UI_CUSTOMIZATION_SAVE_REQUEST_TYPE = 'od:live-artifact-project-save-request' as const;
export const CORE_UI_CUSTOMIZATION_SAVE_RESULT_TYPE = 'od:live-artifact-project-save-result' as const;
export const CORE_UI_CUSTOMIZATION_SAVE_LEGACY_PREVIEW_VERSION = 1 as const;

export const CORE_UI_CUSTOMIZATION_SAVE_CONTRACT = {
  version: 2,
  kind: 'core-ui-customization',
  roles: ['field', 'sidebar', 'tabs', 'selected', 'headers', 'data'],
  paletteValues: [
    'ocean-deep',
    'ocean',
    'ocean-raised',
    'carbon-blue',
    'wet-slate',
    'storm-slate',
    'muted-fjord',
    'mineral-blue',
    'clouded-steel',
    'harbor-steel',
    'silvered-slate',
  ],
} as const;

export const CORE_UI_CUSTOMIZATION_SAVE_CONTRACT_VERSION = CORE_UI_CUSTOMIZATION_SAVE_CONTRACT.version;
export const CORE_UI_CUSTOMIZATION_SAVE_ROLE_NAMES = CORE_UI_CUSTOMIZATION_SAVE_CONTRACT.roles;
export const CORE_UI_CUSTOMIZATION_SAVE_PALETTE_VALUES = CORE_UI_CUSTOMIZATION_SAVE_CONTRACT.paletteValues;

export type CoreUiCustomizationSaveRole = typeof CORE_UI_CUSTOMIZATION_SAVE_ROLE_NAMES[number];
export type CoreUiCustomizationPaletteValue = typeof CORE_UI_CUSTOMIZATION_SAVE_PALETTE_VALUES[number];
export type CoreUiCustomizationRevision = string;

export type CoreUiCustomizationSaveSettings = Record<
  CoreUiCustomizationSaveRole,
  CoreUiCustomizationPaletteValue
>;

export interface CoreUiCustomizationSaveLegacyPreviewIntent {
  type: typeof CORE_UI_CUSTOMIZATION_SAVE_REQUEST_TYPE;
  version: typeof CORE_UI_CUSTOMIZATION_SAVE_LEGACY_PREVIEW_VERSION;
  requestId: string;
  kind: typeof CORE_UI_CUSTOMIZATION_SAVE_CONTRACT.kind;
  settings: CoreUiCustomizationSaveSettings;
}

export interface CoreUiCustomizationSaveRequest {
  type: typeof CORE_UI_CUSTOMIZATION_SAVE_REQUEST_TYPE;
  version: typeof CORE_UI_CUSTOMIZATION_SAVE_CONTRACT_VERSION;
  requestId: string;
  kind: typeof CORE_UI_CUSTOMIZATION_SAVE_CONTRACT.kind;
  baseRevision: CoreUiCustomizationRevision;
  settings: CoreUiCustomizationSaveSettings;
}

export type CoreUiCustomizationSaveResultCode =
  | 'saved'
  | 'validation_error'
  | 'conflict'
  | 'request_id_conflict'
  | 'failed';

export interface CoreUiCustomizationSaveResult {
  type: typeof CORE_UI_CUSTOMIZATION_SAVE_RESULT_TYPE;
  version: typeof CORE_UI_CUSTOMIZATION_SAVE_CONTRACT_VERSION;
  requestId: string;
  ok: boolean;
  code: CoreUiCustomizationSaveResultCode;
  revision: CoreUiCustomizationRevision | null;
  message: string;
}

export interface CoreUiCustomizationSaveLegacyPreviewResult
  extends Omit<CoreUiCustomizationSaveResult, 'version'> {
  version: typeof CORE_UI_CUSTOMIZATION_SAVE_LEGACY_PREVIEW_VERSION;
}

export interface CoreUiCustomizationSaveStateResponse {
  version: typeof CORE_UI_CUSTOMIZATION_SAVE_CONTRACT_VERSION;
  revision: CoreUiCustomizationRevision;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

export function isCoreUiCustomizationPaletteValue(value: unknown): value is CoreUiCustomizationPaletteValue {
  return typeof value === 'string'
    && (CORE_UI_CUSTOMIZATION_SAVE_PALETTE_VALUES as readonly string[]).includes(value);
}

export function isCoreUiCustomizationSaveSettings(value: unknown): value is CoreUiCustomizationSaveSettings {
  if (!isPlainObject(value) || !hasExactKeys(value, CORE_UI_CUSTOMIZATION_SAVE_ROLE_NAMES)) return false;
  return CORE_UI_CUSTOMIZATION_SAVE_ROLE_NAMES.every((role) => isCoreUiCustomizationPaletteValue(value[role]));
}

export function isCoreUiCustomizationRevision(value: unknown): value is CoreUiCustomizationRevision {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/u.test(value);
}

export function isCoreUiCustomizationSaveResult(value: unknown): value is CoreUiCustomizationSaveResult {
  if (!isPlainObject(value) || !hasExactKeys(value, [
    'type', 'version', 'requestId', 'ok', 'code', 'revision', 'message',
  ])) return false;
  return value.type === CORE_UI_CUSTOMIZATION_SAVE_RESULT_TYPE
    && value.version === CORE_UI_CUSTOMIZATION_SAVE_CONTRACT_VERSION
    && typeof value.requestId === 'string'
    && typeof value.ok === 'boolean'
    && ['saved', 'validation_error', 'conflict', 'request_id_conflict', 'failed'].includes(String(value.code))
    && (value.revision === null || isCoreUiCustomizationRevision(value.revision))
    && typeof value.message === 'string';
}
