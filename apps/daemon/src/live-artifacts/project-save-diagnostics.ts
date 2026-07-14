import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { CoreUiCustomizationRevision } from '@open-design/contracts';
import type { CoreUiProjectSaveRollbackOutcome } from './project-save.js';

export const CORE_UI_PROJECT_SAVE_DIAGNOSTICS_RELATIVE_PATH = path.join(
  'diagnostics',
  'core-ui-project-save.jsonl',
);

export type CoreUiProjectSaveDiagnosticResult =
  | 'succeeded'
  | 'conflict'
  | 'validation_error'
  | 'request_id_conflict'
  | 'failed'
  | 'idempotent_replay'
  | 'idempotency_persistence_failed';

export interface CoreUiProjectSaveDiagnosticEntry {
  requestId: string;
  projectId: string;
  artifactId: string;
  baseRevision: CoreUiCustomizationRevision | null;
  revision: CoreUiCustomizationRevision | null;
  result: CoreUiProjectSaveDiagnosticResult;
  durationMs: number;
  rollbackOutcome: CoreUiProjectSaveRollbackOutcome;
}

export async function appendCoreUiProjectSaveDiagnostic(options: {
  dataDir: string;
  entry: CoreUiProjectSaveDiagnosticEntry;
  now?: Date;
}): Promise<void> {
  const filePath = path.join(options.dataDir, CORE_UI_PROJECT_SAVE_DIAGNOSTICS_RELATIVE_PATH);
  await mkdir(path.dirname(filePath), { recursive: true });
  const row = {
    timestamp: (options.now ?? new Date()).toISOString(),
    ...options.entry,
  };
  await appendFile(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}
