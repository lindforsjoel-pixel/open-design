import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  CORE_UI_CUSTOMIZATION_SAVE_REQUEST_TYPE,
  type BoundedJsonObject,
  type CoreUiCustomizationSaveRequest,
  type CoreUiCustomizationSaveSettings,
  type LiveArtifact,
} from '@open-design/contracts';

const ROLE_NAMES = ['field', 'sidebar', 'tabs', 'selected', 'headers', 'data'] as const;
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

type JsonObject = Record<string, unknown>;

export interface CoreUiProjectSaveOperations {
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

function isPlainObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function validateCoreUiCustomizationSaveRequest(value: unknown): CoreUiCustomizationSaveRequest {
  if (!isPlainObject(value)) throw new Error('Save request must be an object.');
  const topKeys = Object.keys(value).sort();
  if (topKeys.join(',') !== ['kind', 'requestId', 'settings', 'type', 'version'].sort().join(',')) {
    throw new Error('Save request fields are invalid.');
  }
  if (value.type !== CORE_UI_CUSTOMIZATION_SAVE_REQUEST_TYPE || value.version !== 1 || value.kind !== 'core-ui-customization') {
    throw new Error('Save request contract is not supported.');
  }
  if (typeof value.requestId !== 'string' || value.requestId.trim().length === 0 || value.requestId.length > 200) {
    throw new Error('Save request id is invalid.');
  }
  if (!isPlainObject(value.settings)) throw new Error('Customization settings are invalid.');
  const settingKeys = Object.keys(value.settings).sort();
  if (settingKeys.join(',') !== [...ROLE_NAMES].sort().join(',')) {
    throw new Error('Customization settings must contain exactly six roles.');
  }
  for (const role of ROLE_NAMES) {
    if (typeof value.settings[role] !== 'string' || !PALETTE_VALUES.has(value.settings[role])) {
      throw new Error(`Customization value for ${role} is invalid.`);
    }
  }
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

export function defaultCoreUiProjectSaveOperations(
  getLiveArtifact: CoreUiProjectSaveOperations['getLiveArtifact'],
  updateLiveArtifact: CoreUiProjectSaveOperations['updateLiveArtifact'],
  ensureLiveArtifactPreview: CoreUiProjectSaveOperations['ensureLiveArtifactPreview'],
): CoreUiProjectSaveOperations {
  return {
    readText: (filePath) => readFile(filePath, 'utf8'),
    writeTextAtomic: writeTextFileAtomic,
    getLiveArtifact,
    updateLiveArtifact,
    ensureLiveArtifactPreview,
  };
}

export async function saveCoreUiProjectCustomization(
  options: SaveCoreUiProjectCustomizationOptions,
): Promise<{ request: CoreUiCustomizationSaveRequest; artifact: LiveArtifact; html: string }> {
  const request = validateCoreUiCustomizationSaveRequest(options.request);
  const filePaths = [
    path.join(options.projectDir, 'data.json'),
    path.join(options.projectDir, 'live-source.json'),
    path.join(options.projectDir, 'artifact.json'),
  ];

  // Read and validate the complete transaction before mutating any file.
  const originals = await Promise.all(filePaths.map((filePath) => options.operations.readText(filePath)));
  const data = parseObjectFile(originals[0]!, 'data.json');
  const liveSource = parseObjectFile(originals[1]!, 'live-source.json');
  const artifactSource = parseObjectFile(originals[2]!, 'artifact.json');
  const uiCustomization = canonicalCustomization(request.settings);
  const nextValues = [
    patchDataFile(data, uiCustomization),
    patchDataFile(liveSource, uiCustomization),
    patchArtifactFile(artifactSource, uiCustomization),
  ];
  const previousRegisteredArtifact = await options.operations.getLiveArtifact();
  const writtenIndexes: number[] = [];
  let registeredArtifactWasUpdated = false;

  try {
    for (let index = 0; index < filePaths.length; index += 1) {
      await options.operations.writeTextAtomic(filePaths[index]!, stableJson(nextValues[index]));
      writtenIndexes.push(index);
    }

    const canonicalDocument = (nextValues[2] as JsonObject).document as LiveArtifact['document'];
    await options.operations.updateLiveArtifact(canonicalDocument);
    registeredArtifactWasUpdated = true;
    const preview = await options.operations.ensureLiveArtifactPreview();
    if (preview.artifact.document.dataJson.uiCustomization == null || preview.html.length === 0) {
      throw new Error('Regenerated preview was not available.');
    }
    return { request, artifact: preview.artifact, html: preview.html };
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    if (registeredArtifactWasUpdated) {
      await options.operations.updateLiveArtifact(previousRegisteredArtifact.document).catch((rollbackError) => rollbackErrors.push(rollbackError));
      await options.operations.ensureLiveArtifactPreview().catch((rollbackError) => rollbackErrors.push(rollbackError));
    }
    for (const index of writtenIndexes.reverse()) {
      await options.operations.writeTextAtomic(filePaths[index]!, originals[index]!).catch((rollbackError) => rollbackErrors.push(rollbackError));
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], 'Customization save failed and rollback was incomplete.');
    }
    throw error;
  }
}
