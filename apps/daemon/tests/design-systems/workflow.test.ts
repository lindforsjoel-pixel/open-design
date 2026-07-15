import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyDesignWorkflowChanges,
  createDesignWorkflowRevision,
  fanOutDesignWorkflowRevision,
  initializeDesignWorkflowSubscription,
  listDesignWorkflowSubscriptions,
  migrateDesignWorkflow,
  resumeDesignWorkflowSubscription,
  rollbackDesignWorkflowSubscription,
  snapshotDesignWorkflowFiles,
  touchedDesignWorkflowPaths,
} from '../../src/design-systems/workflow.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  migrateDesignWorkflow(db);
  return db;
}

describe('design workflow persistence', () => {
  it('requires reconciliation when a project first subscribes at a structural revision', () => {
    const db = makeDb();
    const revision = createDesignWorkflowRevision(db, {
      designSystemId: 'user:brand', sourceProjectId: 'source', sha: 'd'.repeat(40), branch: 'feature',
      classification: 'structural', changedPaths: ['DESIGN.md'], runId: 'run', createdAt: 1,
    });
    expect(initializeDesignWorkflowSubscription(db, 'asset', revision, 2)).toEqual(expect.objectContaining({
      status: 'update_needed',
      targetSha: revision.sha,
    }));
  });

  it('auto-applies compatible revisions and stops structural revisions for review', () => {
    const db = makeDb();
    const first = createDesignWorkflowRevision(db, {
      designSystemId: 'user:brand',
      sourceProjectId: 'source',
      sha: 'a'.repeat(40),
      branch: 'main',
      classification: 'compatible',
      changedPaths: [],
      runId: null,
      createdAt: 1,
    });
    initializeDesignWorkflowSubscription(db, 'asset-a', first, 2);
    initializeDesignWorkflowSubscription(db, 'asset-b', first, 2);

    const compatible = createDesignWorkflowRevision(db, {
      designSystemId: 'user:brand',
      sourceProjectId: 'source',
      sha: 'b'.repeat(40),
      branch: 'open-design/run-1',
      classification: 'compatible',
      changedPaths: ['system/tokens.json', 'assets/logo.svg'],
      runId: 'run-1',
      createdAt: 3,
    });
    fanOutDesignWorkflowRevision(db, compatible, ['asset-a', 'asset-b'], 4);
    expect(listDesignWorkflowSubscriptions(db, 'user:brand')).toEqual([
      expect.objectContaining({ projectId: 'asset-a', status: 'updated_automatically', appliedSha: compatible.sha }),
      expect.objectContaining({ projectId: 'asset-b', status: 'updated_automatically', appliedSha: compatible.sha }),
    ]);

    const structural = createDesignWorkflowRevision(db, {
      designSystemId: 'user:brand',
      sourceProjectId: 'source',
      sha: 'c'.repeat(40),
      branch: 'open-design/run-2',
      classification: 'structural',
      changedPaths: ['DESIGN.md', 'components/Button.tsx'],
      runId: 'run-2',
      createdAt: 5,
    });
    fanOutDesignWorkflowRevision(db, structural, ['asset-a', 'asset-b'], 6);
    expect(listDesignWorkflowSubscriptions(db, 'user:brand')).toEqual([
      expect.objectContaining({ projectId: 'asset-a', status: 'update_needed', targetSha: structural.sha, appliedSha: compatible.sha }),
      expect.objectContaining({ projectId: 'asset-b', status: 'update_needed', targetSha: structural.sha, appliedSha: compatible.sha }),
    ]);
  });

  it('pins rollback until resume, then targets the newest revision', () => {
    const db = makeDb();
    const first = createDesignWorkflowRevision(db, {
      designSystemId: 'user:brand', sourceProjectId: 'source', sha: 'a'.repeat(40), branch: 'main',
      classification: 'compatible', changedPaths: [], runId: null, createdAt: 1,
    });
    initializeDesignWorkflowSubscription(db, 'asset', first, 2);
    rollbackDesignWorkflowSubscription(db, 'asset', first.sha, 3);
    const next = createDesignWorkflowRevision(db, {
      designSystemId: 'user:brand', sourceProjectId: 'source', sha: 'b'.repeat(40), branch: 'next',
      classification: 'compatible', changedPaths: ['tokens.css'], runId: 'run', createdAt: 4,
    });
    fanOutDesignWorkflowRevision(db, next, ['asset'], 5);
    expect(listDesignWorkflowSubscriptions(db, 'user:brand')[0]).toEqual(expect.objectContaining({
      status: 'pinned', appliedSha: first.sha, pinnedSha: first.sha, targetSha: next.sha,
    }));
    expect(resumeDesignWorkflowSubscription(db, 'asset', next, 6)).toEqual(expect.objectContaining({
      status: 'updated_automatically', appliedSha: next.sha, pinnedSha: null,
    }));
  });
});

describe('design workflow change detection', () => {
  it('classifies only token and static asset paths as compatible', () => {
    expect(classifyDesignWorkflowChanges(['system/tokens.json', 'tokens.css', 'assets/logo.svg'])).toBe('compatible');
    expect(classifyDesignWorkflowChanges(['DESIGN.md'])).toBe('structural');
    expect(classifyDesignWorkflowChanges(['components/Button.tsx'])).toBe('structural');
    expect(classifyDesignWorkflowChanges(['assets/logo.svg'], new Set(['assets/logo.svg']))).toBe('structural');
  });

  it('attributes same-name edits and deletions to one run snapshot', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'od-design-workflow-'));
    tempDirs.push(dir);
    execFileSync('git', ['init'], { cwd: dir });
    writeFileSync(path.join(dir, 'tokens.css'), ':root { --brand: red; }\n');
    writeFileSync(path.join(dir, 'remove.svg'), '<svg/>\n');
    const before = snapshotDesignWorkflowFiles(dir);
    writeFileSync(path.join(dir, 'tokens.css'), ':root { --brand: blue; }\n');
    rmSync(path.join(dir, 'remove.svg'));
    expect(touchedDesignWorkflowPaths(before, snapshotDesignWorkflowFiles(dir))).toEqual([
      'remove.svg',
      'tokens.css',
    ]);
  });
});
