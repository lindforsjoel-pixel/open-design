import {
  CORE_UI_CUSTOMIZATION_SAVE_CONTRACT,
  CORE_UI_CUSTOMIZATION_SAVE_CONTRACT_VERSION,
  CORE_UI_CUSTOMIZATION_SAVE_LEGACY_PREVIEW_VERSION,
  CORE_UI_CUSTOMIZATION_SAVE_REQUEST_TYPE,
  CORE_UI_CUSTOMIZATION_SAVE_RESULT_TYPE,
  isCoreUiCustomizationRevision,
  isCoreUiCustomizationSaveSettings,
  type CoreUiCustomizationRevision,
  type CoreUiCustomizationSaveLegacyPreviewIntent,
  type CoreUiCustomizationSaveLegacyPreviewResult,
  type CoreUiCustomizationSaveRequest,
  type CoreUiCustomizationSaveResult,
} from '@open-design/contracts';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function coreUiProjectSaveIntent(value: unknown): CoreUiCustomizationSaveLegacyPreviewIntent | null {
  if (!isPlainObject(value)) return null;
  if (Object.keys(value).sort().join(',') !== ['type', 'version', 'requestId', 'kind', 'settings'].sort().join(',')) return null;
  if (
    value.type !== CORE_UI_CUSTOMIZATION_SAVE_REQUEST_TYPE
    || value.version !== CORE_UI_CUSTOMIZATION_SAVE_LEGACY_PREVIEW_VERSION
    || value.kind !== CORE_UI_CUSTOMIZATION_SAVE_CONTRACT.kind
    || typeof value.requestId !== 'string'
    || value.requestId.trim().length === 0
    || value.requestId.length > 200
    || !isCoreUiCustomizationSaveSettings(value.settings)
  ) return null;
  return value as unknown as CoreUiCustomizationSaveLegacyPreviewIntent;
}

export function coreUiProjectSaveRequest(
  value: unknown,
  baseRevision: CoreUiCustomizationRevision | null,
): CoreUiCustomizationSaveRequest | null {
  const intent = coreUiProjectSaveIntent(value);
  if (!intent || !isCoreUiCustomizationRevision(baseRevision)) return null;
  return {
    ...intent,
    version: CORE_UI_CUSTOMIZATION_SAVE_CONTRACT_VERSION,
    baseRevision,
  };
}

export function coreUiProjectSaveValidationReceipt(
  value: unknown,
  revision: CoreUiCustomizationRevision | null,
): CoreUiCustomizationSaveLegacyPreviewResult | null {
  if (
    !isPlainObject(value)
    || value.type !== CORE_UI_CUSTOMIZATION_SAVE_REQUEST_TYPE
    || typeof value.requestId !== 'string'
    || value.requestId.trim().length === 0
    || value.requestId.length > 200
    || coreUiProjectSaveIntent(value)
  ) return null;
  return {
    type: CORE_UI_CUSTOMIZATION_SAVE_RESULT_TYPE,
    version: CORE_UI_CUSTOMIZATION_SAVE_LEGACY_PREVIEW_VERSION,
    requestId: value.requestId,
    ok: false,
    code: 'validation_error',
    revision,
    message: 'Customization settings are invalid.',
  };
}

export function coreUiProjectSaveRevisionUnavailableReceipt(
  value: unknown,
): CoreUiCustomizationSaveLegacyPreviewResult | null {
  const intent = coreUiProjectSaveIntent(value);
  if (!intent) return null;
  return {
    type: CORE_UI_CUSTOMIZATION_SAVE_RESULT_TYPE,
    version: CORE_UI_CUSTOMIZATION_SAVE_LEGACY_PREVIEW_VERSION,
    requestId: intent.requestId,
    ok: false,
    code: 'failed',
    revision: null,
    message: 'Canonical project revision is unavailable. Reload the preview and try again; your selections remain local.',
  };
}

export function coreUiProjectSaveLegacyReceipt(
  receipt: CoreUiCustomizationSaveResult,
): CoreUiCustomizationSaveLegacyPreviewResult {
  return {
    ...receipt,
    version: CORE_UI_CUSTOMIZATION_SAVE_LEGACY_PREVIEW_VERSION,
  };
}
