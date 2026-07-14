import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CORE_UI_PROJECT_SAVE_DIAGNOSTICS_RELATIVE_PATH,
  appendCoreUiProjectSaveDiagnostic,
} from '../../src/live-artifacts/project-save-diagnostics.js';

describe('Core UI project-save diagnostics', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'od-core-ui-diagnostics-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes only the safe machine-local diagnostic fields', async () => {
    await appendCoreUiProjectSaveDiagnostic({
      dataDir: root,
      now: new Date('2026-07-14T12:00:00.000Z'),
      entry: {
        requestId: 'request-1',
        projectId: 'project-1',
        artifactId: 'artifact-1',
        baseRevision: `sha256:${'a'.repeat(64)}`,
        revision: `sha256:${'b'.repeat(64)}`,
        result: 'succeeded',
        durationMs: 42,
        rollbackOutcome: 'not_needed',
      },
    });

    const line = await readFile(path.join(root, CORE_UI_PROJECT_SAVE_DIAGNOSTICS_RELATIVE_PATH), 'utf8');
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed).toEqual({
      timestamp: '2026-07-14T12:00:00.000Z',
      requestId: 'request-1',
      projectId: 'project-1',
      artifactId: 'artifact-1',
      baseRevision: `sha256:${'a'.repeat(64)}`,
      revision: `sha256:${'b'.repeat(64)}`,
      result: 'succeeded',
      durationMs: 42,
      rollbackOutcome: 'not_needed',
    });
    expect(Object.keys(parsed).sort()).toEqual([
      'artifactId', 'baseRevision', 'durationMs', 'projectId', 'requestId', 'result',
      'revision', 'rollbackOutcome', 'timestamp',
    ].sort());
    expect(line).not.toContain('settings');
    expect(line).not.toContain('credentials');
    expect(line).not.toContain('provider');
  });
});
