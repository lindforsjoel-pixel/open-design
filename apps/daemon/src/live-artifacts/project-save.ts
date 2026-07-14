import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  CORE_UI_CUSTOMIZATION_SAVE_CONTRACT,
  CORE_UI_CUSTOMIZATION_SAVE_CONTRACT_VERSION,
  CORE_UI_CUSTOMIZATION_SAVE_REQUEST_TYPE,
  CORE_UI_CUSTOMIZATION_SAVE_ROLE_NAMES,
  isCoreUiCustomizationPaletteValue,
  isCoreUiCustomizationRevision,
  isCoreUiCustomizationSaveSettings,
  type BoundedJsonObject,
  type CoreUiCustomizationRevision,
  type CoreUiCustomizationSaveRequest,
  type CoreUiCustomizationSaveSettings,
  type CoreUiCustomizationSaveStateResponse,
  type LiveArtifact,
} from '@open-design/contracts';

type JsonObject = Record<string, unknown>;

export interface CoreUiProjectSaveOperations {
  resolveCanonicalFilePaths(projectDir: string): Promise<readonly [string, string, string]>;
  readText(filePath: string): Promise<string>;
  writeTextAtomic(filePath: string, contents: string): Promise<void>;
  getLiveArtifact(): Promise<LiveArtifact>;
  updateLiveArtifact(document: LiveArtifact['document']): Promise<LiveArtifact>;
  ensureLiveArtifactPreview(): Promise<{ artifact: LiveArtifact; html: string }>;
}

export interface SaveCoreUiProjectCustomizationOptions {
  projectDir: string;
  request: unknown;
  operations: CoreUiProjectSaveOperations;
}

export type CoreUiProjectSaveRollbackOutcome = 'not_needed' | 'succeeded' | 'incomplete';

export class CoreUiProjectSaveConflictError extends Error {
  readonly currentRevision: CoreUiCustomizationRevision;

  constructor(currentRevision: CoreUiCustomizationRevision) {
    super('Canonical customization changed after this preview was opened. Your preview selections remain local; retry to save them against the latest revision.');
    this.name = 'CoreUiProjectSaveConflictError';
    this.currentRevision = currentRevision;
  }
}

export class CoreUiProjectSaveTransactionError extends Error {
  readonly originalError: unknown;
  readonly rollbackErrors: readonly unknown[];
  readonly rollbackOutcome: CoreUiProjectSaveRollbackOutcome;

  constructor(
    originalError: unknown,
    rollbackOutcome: CoreUiProjectSaveRollbackOutcome,
    rollbackErrors: readonly unknown[] = [],
  ) {
    super(
      rollbackOutcome === 'incomplete'
        ? 'Customization save failed and rollback was incomplete.'
        : originalError instanceof Error
          ? originalError.message
          : 'Customization save failed.',
    );
    this.name = 'CoreUiProjectSaveTransactionError';
    this.originalError = originalError;
    this.rollbackErrors = rollbackErrors;
    this.rollbackOutcome = rollbackOutcome;
  }
}

function isPlainObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function validateCoreUiCustomizationSaveRequest(value: unknown): CoreUiCustomizationSaveRequest {
  if (!isPlainObject(value)) throw new Error('Save request must be an object.');
  const topKeys = Object.keys(value).sort();
  if (topKeys.join(',') !== ['baseRevision', 'kind', 'requestId', 'settings', 'type', 'version'].sort().join(',')) {
    throw new Error('Save request fields are invalid.');
  }
  if (
    value.type !== CORE_UI_CUSTOMIZATION_SAVE_REQUEST_TYPE
    || value.version !== CORE_UI_CUSTOMIZATION_SAVE_CONTRACT_VERSION
    || value.kind !== CORE_UI_CUSTOMIZATION_SAVE_CONTRACT.kind
  ) {
    throw new Error('Save request contract is not supported.');
  }
  if (typeof value.requestId !== 'string' || value.requestId.trim().length === 0 || value.requestId.length > 200) {
    throw new Error('Save request id is invalid.');
  }
  if (!isCoreUiCustomizationRevision(value.baseRevision)) throw new Error('Save request base revision is invalid.');
  if (!isPlainObject(value.settings)) throw new Error('Customization settings are invalid.');
  const settingKeys = Object.keys(value.settings).sort();
  if (settingKeys.join(',') !== [...CORE_UI_CUSTOMIZATION_SAVE_ROLE_NAMES].sort().join(',')) {
    throw new Error('Customization settings must contain exactly six roles.');
  }
  for (const role of CORE_UI_CUSTOMIZATION_SAVE_ROLE_NAMES) {
    if (!isCoreUiCustomizationPaletteValue(value.settings[role])) {
      throw new Error(`Customization value for ${role} is invalid.`);
    }
  }
  if (!isCoreUiCustomizationSaveSettings(value.settings)) throw new Error('Customization settings are invalid.');
  return value as unknown as CoreUiCustomizationSaveRequest;
}

function canonicalCustomization(settings: CoreUiCustomizationSaveSettings): BoundedJsonObject {
  return {
    field: settings.field,
    sidebar: settings.sidebar,
    tabs: settings.tabs,
    selected: settings.selected,
    panelHeaders: settings.headers,
    data: settings.data,
  };
}

function parseObjectFile(contents: string, label: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error(`${label} contains invalid JSON.`);
  }
  if (!isPlainObject(value)) throw new Error(`${label} must contain a JSON object.`);
  return value;
}

function settingsFromCanonicalData(value: JsonObject, label: string): CoreUiCustomizationSaveSettings {
  if (!isPlainObject(value.uiCustomization)) throw new Error(`${label} uiCustomization is invalid.`);
  const settings = {
    field: value.uiCustomization.field,
    sidebar: value.uiCustomization.sidebar,
    tabs: value.uiCustomization.tabs,
    selected: value.uiCustomization.selected,
    headers: value.uiCustomization.panelHeaders,
    data: value.uiCustomization.data,
  };
  if (!isCoreUiCustomizationSaveSettings(settings)) throw new Error(`${label} uiCustomization is invalid.`);
  return settings;
}

export function coreUiCustomizationRevision(
  settings: CoreUiCustomizationSaveSettings,
): CoreUiCustomizationRevision {
  const canonicalPairs = CORE_UI_CUSTOMIZATION_SAVE_ROLE_NAMES.map((role) => [role, settings[role]] as const);
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalPairs)).digest('hex')}`;
}

export function coreUiCustomizationSaveRequestFingerprint(
  request: CoreUiCustomizationSaveRequest,
): string {
  const canonicalRequest = {
    type: request.type,
    version: request.version,
    requestId: request.requestId,
    kind: request.kind,
    baseRevision: request.baseRevision,
    settings: CORE_UI_CUSTOMIZATION_SAVE_ROLE_NAMES.map((role) => [role, request.settings[role]] as const),
  };
  return createHash('sha256').update(JSON.stringify(canonicalRequest)).digest('hex');
}

export async function readCoreUiProjectCustomizationState(options: {
  projectDir: string;
  readText?: CoreUiProjectSaveOperations['readText'];
  resolveCanonicalFilePaths?: CoreUiProjectSaveOperations['resolveCanonicalFilePaths'];
}): Promise<CoreUiCustomizationSaveStateResponse> {
  const readText = options.readText ?? ((filePath: string) => readFile(filePath, 'utf8'));
  const filePaths = await (options.resolveCanonicalFilePaths ?? resolveCoreUiCanonicalFilePaths)(options.projectDir);
  const data = parseObjectFile(
    await readText(filePaths[0]),
    'data.json',
  );
  return {
    version: CORE_UI_CUSTOMIZATION_SAVE_CONTRACT_VERSION,
    revision: coreUiCustomizationRevision(settingsFromCanonicalData(data, 'data.json')),
  };
}

function patchDataFile(value: JsonObject, uiCustomization: BoundedJsonObject): JsonObject {
  return { ...value, uiCustomization };
}

function patchArtifactFile(value: JsonObject, uiCustomization: BoundedJsonObject): JsonObject {
  if (!isPlainObject(value.document) || value.document.format !== 'html_template_v1' || !isPlainObject(value.document.dataJson)) {
    throw new Error('artifact.json document.dataJson is invalid.');
  }
  return {
    ...value,
    document: {
      ...value.document,
      dataJson: patchDataFile(value.document.dataJson, uiCustomization),
    },
  };
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function writeTextFileAtomic(filePath: string, contents: string): Promise<void> {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(temporaryPath, contents, 'utf8');
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export async function resolveCoreUiCanonicalFilePaths(
  projectDir: string,
): Promise<readonly [string, string, string]> {
  const rootReal = await realpath(projectDir);
  const names = ['data.json', 'live-source.json', 'artifact.json'] as const;
  const resolved = await Promise.all(names.map(async (name) => {
    const candidate = path.join(rootReal, name);
    const linkInfo = await lstat(candidate);
    if (linkInfo.isSymbolicLink()) throw new Error(`${name} must not be a symbolic link.`);
    const targetReal = await realpath(candidate);
    if (!targetReal.startsWith(`${rootReal}${path.sep}`) || path.dirname(targetReal) !== rootReal) {
      throw new Error(`${name} escapes the resolved project root.`);
    }
    const entryInfo = await stat(targetReal);
    if (!entryInfo.isFile()) throw new Error(`${name} must be a regular file.`);
    return targetReal;
  }));
  return resolved as [string, string, string];
}

export function defaultCoreUiProjectSaveOperations(
  getLiveArtifact: CoreUiProjectSaveOperations['getLiveArtifact'],
  updateLiveArtifact: CoreUiProjectSaveOperations['updateLiveArtifact'],
  ensureLiveArtifactPreview: CoreUiProjectSaveOperations['ensureLiveArtifactPreview'],
): CoreUiProjectSaveOperations {
  return {
    resolveCanonicalFilePaths: resolveCoreUiCanonicalFilePaths,
    readText: (filePath) => readFile(filePath, 'utf8'),
    writeTextAtomic: writeTextFileAtomic,
    getLiveArtifact,
    updateLiveArtifact,
    ensureLiveArtifactPreview,
  };
}

export async function saveCoreUiProjectCustomization(
  options: SaveCoreUiProjectCustomizationOptions,
): Promise<{
  request: CoreUiCustomizationSaveRequest;
  artifact: LiveArtifact;
  html: string;
  previousRevision: CoreUiCustomizationRevision;
  revision: CoreUiCustomizationRevision;
}> {
  const request = validateCoreUiCustomizationSaveRequest(options.request);
  const filePaths = await options.operations.resolveCanonicalFilePaths(options.projectDir);

  // Read and validate the complete transaction before mutating any file.
  const originals = await Promise.all(filePaths.map((filePath) => options.operations.readText(filePath)));
  const data = parseObjectFile(originals[0]!, 'data.json');
  const liveSource = parseObjectFile(originals[1]!, 'live-source.json');
  const artifactSource = parseObjectFile(originals[2]!, 'artifact.json');
  const previousRevision = coreUiCustomizationRevision(settingsFromCanonicalData(data, 'data.json'));
  if (request.baseRevision !== previousRevision) throw new CoreUiProjectSaveConflictError(previousRevision);
  const uiCustomization = canonicalCustomization(request.settings);
  const revision = coreUiCustomizationRevision(request.settings);
  const nextValues = [
    patchDataFile(data, uiCustomization),
    patchDataFile(liveSource, uiCustomization),
    patchArtifactFile(artifactSource, uiCustomization),
  ];
  const previousRegisteredArtifact = await options.operations.getLiveArtifact();
  const writtenIndexes: number[] = [];
  let registeredArtifactMayHaveChanged = false;

  try {
    for (let index = 0; index < filePaths.length; index += 1) {
      await options.operations.writeTextAtomic(filePaths[index]!, stableJson(nextValues[index]));
      writtenIndexes.push(index);
    }

    const canonicalDocument = (nextValues[2] as JsonObject).document as LiveArtifact['document'];
    registeredArtifactMayHaveChanged = true;
    await options.operations.updateLiveArtifact(canonicalDocument);
    const preview = await options.operations.ensureLiveArtifactPreview();
    if (preview.artifact.document.dataJson.uiCustomization == null || preview.html.length === 0) {
      throw new Error('Regenerated preview was not available.');
    }
    return { request, artifact: preview.artifact, html: preview.html, previousRevision, revision };
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    if (registeredArtifactMayHaveChanged) {
      await options.operations.updateLiveArtifact(previousRegisteredArtifact.document).catch((rollbackError) => rollbackErrors.push(rollbackError));
      await options.operations.ensureLiveArtifactPreview().catch((rollbackError) => rollbackErrors.push(rollbackError));
    }
    for (const index of writtenIndexes.reverse()) {
      await options.operations.writeTextAtomic(filePaths[index]!, originals[index]!).catch((rollbackError) => rollbackErrors.push(rollbackError));
    }
    const mutationAttempted = registeredArtifactMayHaveChanged || writtenIndexes.length > 0;
    const rollbackOutcome: CoreUiProjectSaveRollbackOutcome = rollbackErrors.length > 0
      ? 'incomplete'
      : mutationAttempted
        ? 'succeeded'
        : 'not_needed';
    throw new CoreUiProjectSaveTransactionError(error, rollbackOutcome, rollbackErrors);
  }
}
