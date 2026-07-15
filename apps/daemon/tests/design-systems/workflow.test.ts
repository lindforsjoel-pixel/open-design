import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyDesignWorkflowChanges,
  createDesignWorkflowService,
  createDesignWorkflowRevision,
  fanOutDesignWorkflowRevision,
  governedTokenUpdates,
  initializeDesignWorkflowSubscription,
  isGovernedTokenOnlyTextChange,
  listDesignWorkflowSubscriptions,
  migrateDesignWorkflow,
  rewriteGovernedTokens,
  resumeDesignWorkflowSubscription,
  rollbackDesignWorkflowSubscription,
  snapshotDesignWorkflowFiles,
  touchedDesignWorkflowPaths,
} from '../../src/design-systems/workflow.js';
import { CORE_UI_PROJECT_ID } from '../../src/design-systems/delivery-adapters.js';

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

  it('recognizes governed color propagation across canonical and rendered surfaces', () => {
    const beforeCss = ':root { --amber: #e1b436; --amber: oklch(79% 0.145 88); }';
    const afterCss = ':root { --amber: #d84d43; --amber: oklch(61% 0.205 28); }';
    const updates = governedTokenUpdates(beforeCss, afterCss);
    expect(updates).toEqual([{
      name: 'amber',
      beforeValues: ['#e1b436', 'oklch(79% 0.145 88)'],
      afterValues: ['#d84d43', 'oklch(61% 0.205 28)'],
    }]);
    expect(isGovernedTokenOnlyTextChange(
      '<style>--amber: oklch(79% 0.145 88);</style><code>79% 0.145 88</code>',
      '<style>--amber: oklch(61% 0.205 28);</style><code>61% 0.205 28</code>',
      updates,
    )).toBe(true);
    expect(isGovernedTokenOnlyTextChange(
      '<style>--amber: oklch(79% 0.145 88);</style><main>One</main>',
      '<style>--amber: oklch(61% 0.205 28);</style><main>Two</main>',
      updates,
    )).toBe(false);
  });

  it('rewrites governed declarations even when a subscriber carries an older local value', () => {
    const updates = governedTokenUpdates(
      ':root { --amber: #e1b436; --amber: oklch(79% 0.145 88); }',
      ':root { --amber: #d84d43; --amber: oklch(61% 0.205 28); }',
    );
    const rewritten = rewriteGovernedTokens([
      ':root { --amber: oklch(75% 0.155 62); --danger: oklch(61% 0.205 28); }',
      'amber-ink: "oklch(17% 0.038 220)"',
    ].join('\n'), updates);
    expect(rewritten.replacements).toBe(1);
    expect(rewritten.content).toContain('--amber: oklch(61% 0.205 28);');
    expect(rewritten.content).toContain('amber-ink: "oklch(17% 0.038 220)"');
  });

  it('does not rewrite adjacent colors merely because a governed token is mentioned', () => {
    const updates = governedTokenUpdates(
      ':root { --amber: oklch(79% 0.145 88); }',
      ':root { --amber: oklch(61% 0.205 28); }',
    );
    const input = 'amber-ink: "oklch(17% 0.038 220)"; note: "amber";';
    expect(rewriteGovernedTokens(input, updates)).toEqual({ content: input, replacements: 0 });
  });
});

describe('design workflow automatic propagation', () => {
  it('commits a governed token revision and updates real subscriber files before advancing the applied SHA', async () => {
    const source = mkdtempSync(path.join(tmpdir(), 'od-design-workflow-source-'));
    const subscriber = mkdtempSync(path.join(tmpdir(), 'od-design-workflow-subscriber-'));
    const remote = mkdtempSync(path.join(tmpdir(), 'od-design-workflow-remote-'));
    tempDirs.push(source, subscriber, remote);
    execFileSync('git', ['init', '--bare'], { cwd: remote });
    execFileSync('git', ['init'], { cwd: source });
    execFileSync('git', ['config', 'user.name', 'Open Design Test'], { cwd: source });
    execFileSync('git', ['config', 'user.email', 'open-design-test@example.invalid'], { cwd: source });
    writeFileSync(path.join(source, 'colors_and_type.css'), ':root { --amber: #e1b436; --amber: oklch(79% 0.145 88); }\n');
    writeFileSync(path.join(source, 'DESIGN.md'), 'amber: "oklch(79% 0.145 88)"\n');
    execFileSync('git', ['add', '-A'], { cwd: source });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: source });
    execFileSync('git', ['branch', '-M', 'main'], { cwd: source });
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: source });
    execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: source });
    writeFileSync(path.join(subscriber, 'template.html'), '<style>:root { --amber: oklch(75% 0.155 62); }</style>\n');

    const queuedUpdates: string[] = [];
    const projects = new Map<string, any>([
      ['source', {
        id: 'source', name: 'Brand', designSystemId: 'user:brand', updatedAt: 2,
        metadata: { importedFrom: 'design-system', baseDir: source, designWorkflowWorktree: source },
      }],
      [CORE_UI_PROJECT_ID, {
        id: CORE_UI_PROJECT_ID, name: 'Asset', designSystemId: 'user:brand', updatedAt: 1,
        metadata: { importedFrom: 'project-location', baseDir: subscriber },
      }],
    ]);
    const db = makeDb();
    const service = createDesignWorkflowService({
      db,
      projectsRoot: subscriber,
      runtimeDataDir: subscriber,
      getProject: (_db, id) => projects.get(id) ?? null,
      listProjects: () => [...projects.values()],
      updateProject: (_db, id, patch) => {
        const current = projects.get(id);
        if (!current) return null;
        const updated = { ...current, ...patch, metadata: patch.metadata ?? current.metadata };
        projects.set(id, updated);
        return updated;
      },
      resolveProjectDir: (_root, _id, metadata) => String(metadata?.baseDir),
      queueSubscriberUpdate: (projectId) => queuedUpdates.push(projectId),
    });

    await service.initializeProject(CORE_UI_PROJECT_ID);
    expect(readFileSync(path.join(subscriber, 'template.html'), 'utf8')).toContain('oklch(79% 0.145 88)');
    expect(queuedUpdates).toEqual([CORE_UI_PROJECT_ID]);
    queuedUpdates.length = 0;
    await service.captureRunStart('run-token', 'source');
    writeFileSync(path.join(source, 'colors_and_type.css'), ':root { --amber: #d84d43; --amber: oklch(61% 0.205 28); }\n');
    writeFileSync(path.join(source, 'DESIGN.md'), 'amber: "oklch(61% 0.205 28)"\n');

    await service.completeRun({ runId: 'run-token', projectId: 'source', prompt: 'Change the governed color.', succeeded: true });

    const status = await service.statusForProject(CORE_UI_PROJECT_ID);
    expect(status.subscription).toEqual(expect.objectContaining({
      status: 'updated_automatically',
      appliedSha: status.currentRevision.sha,
      targetSha: status.currentRevision.sha,
    }));
    expect(status.currentRevision.classification).toBe('compatible');
    expect(readFileSync(path.join(subscriber, 'template.html'), 'utf8')).toContain('--amber: oklch(61% 0.205 28);');
    expect(execFileSync('git', ['ls-remote', '--heads', 'origin', 'open-design/run-run-token'], { cwd: source, encoding: 'utf8' }).trim()).not.toBe('');
    expect(queuedUpdates).toEqual([CORE_UI_PROJECT_ID]);

    queuedUpdates.length = 0;
    await service.captureRunStart('run-structural', 'source');
    writeFileSync(path.join(source, 'DESIGN.md'), 'amber: "oklch(61% 0.205 28)"\nNew component contract.\n');
    await service.completeRun({ runId: 'run-structural', projectId: 'source', prompt: 'Change the component contract.', succeeded: true });

    const structuralStatus = await service.statusForProject(CORE_UI_PROJECT_ID);
    expect(structuralStatus.subscription?.status).toBe('update_needed');
    expect(queuedUpdates).toEqual([CORE_UI_PROJECT_ID]);
  });
});
