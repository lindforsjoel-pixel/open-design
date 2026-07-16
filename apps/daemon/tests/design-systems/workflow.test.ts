import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyDesignWorkflowSubscription,
  classifyDesignWorkflowChanges,
  createDesignWorkflowService,
  createDesignWorkflowRevision,
  failDesignWorkflowSubscription,
  fanOutDesignWorkflowRevision,
  getDesignWorkflowDelivery,
  getDesignWorkflowSubscription,
  governedTokenUpdates,
  governedTokenSurfaceMismatch,
  initializeDesignWorkflowSubscription,
  isGovernedTokenOnlyTextChange,
  listDesignWorkflowSubscriptions,
  migrateDesignWorkflow,
  releaseDesignWorkflowDeliveryApproval,
  recordWordPressPublishIntent,
  reserveDesignWorkflowDeliveryApproval,
  rewriteGovernedTokens,
  resumeDesignWorkflowSubscription,
  rollbackDesignWorkflowSubscription,
  saveDesignWorkflowDelivery,
  snapshotDesignWorkflowFiles,
  touchedDesignWorkflowPaths,
} from '../../src/design-systems/workflow.js';
import {
  canonicalCoreUiReceipt,
  CORE_UI_PROJECT_ID,
} from '../../src/design-systems/delivery-adapters.js';
import { createLiveArtifact, readLiveArtifactCode, updateLiveArtifact } from '../../src/live-artifacts/store.js';

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
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

  it('does not mark an older validated revision applied after the target advances', () => {
    const db = makeDb();
    const first = createDesignWorkflowRevision(db, {
      designSystemId: 'user:brand', sourceProjectId: 'source', sha: 'a'.repeat(40), branch: 'main',
      classification: 'compatible', changedPaths: [], runId: null, createdAt: 1,
    });
    initializeDesignWorkflowSubscription(db, 'asset', first, 2);
    const validated = createDesignWorkflowRevision(db, {
      designSystemId: 'user:brand', sourceProjectId: 'source', sha: 'b'.repeat(40), branch: 'next',
      classification: 'structural', changedPaths: ['DESIGN.md'], runId: 'run', createdAt: 3,
    });
    fanOutDesignWorkflowRevision(db, validated, ['asset'], 4);
    const newer = createDesignWorkflowRevision(db, {
      designSystemId: 'user:brand', sourceProjectId: 'source', sha: 'c'.repeat(40), branch: 'newer',
      classification: 'structural', changedPaths: ['components/Button.tsx'], runId: 'run-2', createdAt: 5,
    });
    fanOutDesignWorkflowRevision(db, newer, ['asset'], 6);

    expect(applyDesignWorkflowSubscription(db, 'asset', validated.sha, 7)).toBeNull();
    expect(failDesignWorkflowSubscription(db, 'asset', validated.sha, 'stale validation failure', first.sha, 8)).toBeNull();
    expect(listDesignWorkflowSubscriptions(db, 'user:brand')[0]).toEqual(expect.objectContaining({
      status: 'update_needed',
      targetSha: newer.sha,
      appliedSha: first.sha,
    }));
  });

  it('does not silently unpin a subscription while applying the pinned target', () => {
    const db = makeDb();
    const revision = createDesignWorkflowRevision(db, {
      designSystemId: 'user:brand', sourceProjectId: 'source', sha: 'a'.repeat(40), branch: 'main',
      classification: 'compatible', changedPaths: [], runId: null, createdAt: 1,
    });
    initializeDesignWorkflowSubscription(db, 'asset', revision, 2);
    rollbackDesignWorkflowSubscription(db, 'asset', revision.sha, 3);

    expect(applyDesignWorkflowSubscription(db, 'asset', revision.sha, 4)).toBeNull();
    expect(listDesignWorkflowSubscriptions(db, 'user:brand')[0]).toEqual(expect.objectContaining({
      status: 'pinned',
      targetSha: revision.sha,
      appliedSha: revision.sha,
      pinnedSha: revision.sha,
    }));
  });

  it('refuses approval after the subscribed design revision advances', () => {
    const db = makeDb();
    const first = createDesignWorkflowRevision(db, {
      designSystemId: 'user:brand', sourceProjectId: 'source', sha: 'a'.repeat(40), branch: 'main',
      classification: 'compatible', changedPaths: [], runId: null, createdAt: 1,
    });
    initializeDesignWorkflowSubscription(db, 'asset', first, 2);
    saveDesignWorkflowDelivery(db, {
      id: 'delivery-a',
      projectId: 'asset',
      adapter: 'core-ui',
      revisionSha: first.sha,
      implementationDigest: 'd'.repeat(64),
      status: 'ready_for_approval',
      previewUrl: 'https://preview.example.test/',
      target: {},
      checkpointPath: null,
      error: null,
      createdAt: 3,
      updatedAt: 3,
      expiresAt: 100,
    });
    const newer = createDesignWorkflowRevision(db, {
      designSystemId: 'user:brand', sourceProjectId: 'source', sha: 'b'.repeat(40), branch: 'next',
      classification: 'structural', changedPaths: ['DESIGN.md'], runId: 'run', createdAt: 4,
    });
    fanOutDesignWorkflowRevision(db, newer, ['asset'], 5);

    expect(() => reserveDesignWorkflowDeliveryApproval(
      db,
      'asset',
      'delivery-a',
      'd'.repeat(64),
      'run-a',
      6,
    )).toThrow('no longer matches the current applied design-system revision');
    expect(getDesignWorkflowDelivery(db, 'delivery-a')?.status).toBe('ready_for_approval');
  });

  it('reserves approval before deployment, defers new targets, and supports expired-lease recovery', () => {
    const db = makeDb();
    const first = createDesignWorkflowRevision(db, {
      designSystemId: 'user:brand', sourceProjectId: 'source', sha: 'a'.repeat(40), branch: 'main',
      classification: 'compatible', changedPaths: [], runId: null, createdAt: 1,
    });
    initializeDesignWorkflowSubscription(db, 'asset', first, 2);
    saveDesignWorkflowDelivery(db, {
      id: 'delivery-a',
      projectId: 'asset',
      adapter: 'core-ui',
      revisionSha: first.sha,
      implementationDigest: 'd'.repeat(64),
      status: 'ready_for_approval',
      previewUrl: 'https://preview.example.test/',
      target: {},
      checkpointPath: null,
      error: null,
      createdAt: 3,
      updatedAt: 3,
      expiresAt: 10_000_000,
    });

    expect(reserveDesignWorkflowDeliveryApproval(
      db,
      'asset',
      'delivery-a',
      'd'.repeat(64),
      'run-one',
      4,
    ).status).toBe('approving');
    expect(() => reserveDesignWorkflowDeliveryApproval(
      db,
      'asset',
      'delivery-a',
      'd'.repeat(64),
      'run-two',
      5,
    )).toThrow('already in progress');

    const newer = createDesignWorkflowRevision(db, {
      designSystemId: 'user:brand', sourceProjectId: 'source', sha: 'b'.repeat(40), branch: 'next',
      classification: 'structural', changedPaths: ['DESIGN.md'], runId: 'run', createdAt: 6,
    });
    fanOutDesignWorkflowRevision(db, newer, ['asset'], 7);
    expect(listDesignWorkflowSubscriptions(db, 'user:brand')[0]).toEqual(expect.objectContaining({
      status: 'up_to_date',
      targetSha: first.sha,
      appliedSha: first.sha,
    }));
    expect((db.prepare(`
      SELECT deferred_target_sha AS deferredTargetSha
      FROM design_workflow_subscriptions
      WHERE project_id = 'asset'
    `).get() as { deferredTargetSha: string }).deferredTargetSha).toBe(newer.sha);

    expect(releaseDesignWorkflowDeliveryApproval(
      db,
      'delivery-a',
      'run-not-owner',
      'unowned failure',
      true,
      8,
    )).toBeNull();
    expect(getDesignWorkflowDelivery(db, 'delivery-a')?.status).toBe('approving');
    expect(getDesignWorkflowSubscription(db, 'asset')).toEqual(expect.objectContaining({
      status: 'up_to_date',
      targetSha: first.sha,
      appliedSha: first.sha,
    }));

    expect(releaseDesignWorkflowDeliveryApproval(
      db,
      'delivery-a',
      'run-one',
      'run failed',
      true,
      9,
    )?.status).toBe('failed');
    expect(getDesignWorkflowSubscription(db, 'asset')).toEqual(expect.objectContaining({
      status: 'update_needed',
      targetSha: newer.sha,
      appliedSha: first.sha,
    }));

    db.prepare(`
      UPDATE design_workflow_subscriptions
      SET target_sha = ?, applied_sha = ?, status = 'up_to_date', deferred_target_sha = NULL
      WHERE project_id = 'asset'
    `).run(first.sha, first.sha);
    saveDesignWorkflowDelivery(db, {
      id: 'delivery-b',
      projectId: 'asset',
      adapter: 'core-ui',
      revisionSha: first.sha,
      implementationDigest: 'e'.repeat(64),
      status: 'ready_for_approval',
      previewUrl: 'https://preview.example.test/',
      target: {},
      checkpointPath: null,
      error: null,
      createdAt: 10,
      updatedAt: 10,
      expiresAt: 10_000_000,
    });
    expect(reserveDesignWorkflowDeliveryApproval(
      db,
      'asset',
      'delivery-b',
      'e'.repeat(64),
      'run-two',
      11,
    ).target.approvalLease).toEqual(expect.objectContaining({ runId: 'run-two' }));
    expect(reserveDesignWorkflowDeliveryApproval(
      db,
      'asset',
      'delivery-b',
      'e'.repeat(64),
      'run-three',
      11 + 60 * 60 * 1000 + 1,
    ).target.approvalLease).toEqual(expect.objectContaining({ runId: 'run-three' }));
  });

  it('commits expired-lease recovery even when the stale approval cannot be reclaimed', () => {
    const db = makeDb();
    const first = createDesignWorkflowRevision(db, {
      designSystemId: 'user:brand', sourceProjectId: 'source', sha: 'a'.repeat(40), branch: 'main',
      classification: 'compatible', changedPaths: [], runId: null, createdAt: 1,
    });
    initializeDesignWorkflowSubscription(db, 'asset', first, 2);
    saveDesignWorkflowDelivery(db, {
      id: 'delivery-a',
      projectId: 'asset',
      adapter: 'core-ui',
      revisionSha: first.sha,
      implementationDigest: 'd'.repeat(64),
      status: 'ready_for_approval',
      previewUrl: 'https://preview.example.test/',
      target: {},
      checkpointPath: null,
      error: null,
      createdAt: 3,
      updatedAt: 3,
      expiresAt: 10_000_000,
    });
    reserveDesignWorkflowDeliveryApproval(
      db,
      'asset',
      'delivery-a',
      'd'.repeat(64),
      'run-one',
      4,
    );
    const newer = createDesignWorkflowRevision(db, {
      designSystemId: 'user:brand', sourceProjectId: 'source', sha: 'b'.repeat(40), branch: 'next',
      classification: 'structural', changedPaths: ['DESIGN.md'], runId: 'run', createdAt: 5,
    });
    fanOutDesignWorkflowRevision(db, newer, ['asset'], 6);

    expect(() => reserveDesignWorkflowDeliveryApproval(
      db,
      'asset',
      'delivery-a',
      'd'.repeat(64),
      'run-two',
      4 + 60 * 60 * 1000 + 1,
    )).toThrow('Only a ready preview can be approved');
    expect(getDesignWorkflowDelivery(db, 'delivery-a')?.status).toBe('failed');
    expect(getDesignWorkflowSubscription(db, 'asset')).toEqual(expect.objectContaining({
      status: 'update_needed',
      targetSha: newer.sha,
      appliedSha: first.sha,
    }));
  });

  it('keeps an unresolved WordPress publish intent frozen and reclaimable across a deferred revision', () => {
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
    initializeDesignWorkflowSubscription(db, 'asset', first, 2);
    const fingerprint = 'f'.repeat(64);
    saveDesignWorkflowDelivery(db, {
      id: 'wordpress-delivery',
      projectId: 'asset',
      adapter: 'wordpress-draft',
      revisionSha: first.sha,
      implementationDigest: 'd'.repeat(64),
      status: 'approving',
      previewUrl: 'https://example.invalid/?preview=true',
      target: {
        pageId: 2000,
        wordpressManagedPageFingerprint: fingerprint,
        wordpressPublishIntent: {
          runId: 'publish-run-one',
          createdAt: 3,
          managedPageFingerprint: fingerprint,
        },
        approvalLease: {
          runId: 'publish-run-one',
          reservedAt: 3,
          expiresAt: 4,
        },
      },
      checkpointPath: null,
      error: 'Publish outcome requires reconciliation.',
      createdAt: 3,
      updatedAt: 3,
      expiresAt: 10_000,
    });
    const newer = createDesignWorkflowRevision(db, {
      designSystemId: 'user:brand',
      sourceProjectId: 'source',
      sha: 'b'.repeat(40),
      branch: 'next',
      classification: 'structural',
      changedPaths: ['DESIGN.md'],
      runId: 'newer-run',
      createdAt: 5,
    });
    fanOutDesignWorkflowRevision(db, newer, ['asset'], 6);
    expect(getDesignWorkflowSubscription(db, 'asset')).toEqual(expect.objectContaining({
      targetSha: first.sha,
      appliedSha: first.sha,
    }));
    expect(db.prepare(`
      SELECT deferred_target_sha AS deferredTargetSha
      FROM design_workflow_subscriptions
      WHERE project_id = 'asset'
    `).get()).toEqual({ deferredTargetSha: newer.sha });

    const reclaimed = reserveDesignWorkflowDeliveryApproval(
      db,
      'asset',
      'wordpress-delivery',
      'd'.repeat(64),
      'publish-run-two',
      7,
    );
    expect(reclaimed.status).toBe('approving');
    expect((reclaimed.target.approvalLease as { runId: string }).runId).toBe('publish-run-two');
    expect(reclaimed.target.wordpressPublishIntent).toEqual(expect.objectContaining({
      managedPageFingerprint: fingerprint,
    }));
    const transferred = recordWordPressPublishIntent(
      db,
      'wordpress-delivery',
      'publish-run-two',
      8,
    );
    expect(transferred.target.wordpressPublishIntent).toEqual({
      runId: 'publish-run-two',
      createdAt: 3,
      managedPageFingerprint: fingerprint,
    });
  });

  it('keeps an observed Core deployment frozen and reclaimable across a deferred revision', () => {
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
    initializeDesignWorkflowSubscription(db, 'asset', first, 2);
    saveDesignWorkflowDelivery(db, {
      id: 'core-reconciliation-delivery',
      projectId: 'asset',
      adapter: 'core-ui',
      revisionSha: first.sha,
      implementationDigest: 'd'.repeat(64),
      status: 'approving',
      previewUrl: 'https://preview.example.test/',
      target: {
        reconciliationRequired: true,
        trustedBuildDigest: 'e'.repeat(64),
        approvalLease: {
          runId: 'deploy-run-one',
          reservedAt: 3,
          expiresAt: 4,
        },
      },
      checkpointPath: null,
      error: 'Deployment outcome requires reconciliation.',
      createdAt: 3,
      updatedAt: 3,
      expiresAt: 5,
    });
    const newer = createDesignWorkflowRevision(db, {
      designSystemId: 'user:brand',
      sourceProjectId: 'source',
      sha: 'b'.repeat(40),
      branch: 'next',
      classification: 'structural',
      changedPaths: ['DESIGN.md'],
      runId: 'newer-run',
      createdAt: 6,
    });
    fanOutDesignWorkflowRevision(db, newer, ['asset'], 7);

    const reclaimed = reserveDesignWorkflowDeliveryApproval(
      db,
      'asset',
      'core-reconciliation-delivery',
      'd'.repeat(64),
      'deploy-run-two',
      8,
    );
    expect(reclaimed.status).toBe('approving');
    expect(reclaimed.target).toEqual(expect.objectContaining({
      reconciliationRequired: true,
      trustedBuildDigest: 'e'.repeat(64),
      approvalLease: expect.objectContaining({ runId: 'deploy-run-two' }),
    }));
    expect(db.prepare(`
      SELECT deferred_target_sha AS deferredTargetSha
      FROM design_workflow_subscriptions
      WHERE project_id = 'asset'
    `).get()).toEqual({ deferredTargetSha: newer.sha });
  });

  it('binds a newly recorded WordPress publish intent to delivery creation time', () => {
    const db = makeDb();
    const fingerprint = 'a'.repeat(64);
    saveDesignWorkflowDelivery(db, {
      id: 'wordpress-intent-timestamp',
      projectId: 'asset',
      adapter: 'wordpress-draft',
      revisionSha: 'b'.repeat(40),
      implementationDigest: 'c'.repeat(64),
      status: 'approving',
      previewUrl: 'https://example.invalid/?preview=true',
      target: {
        pageId: 2001,
        modifiedGmt: '2026-07-16T08:00:00',
        wordpressManagedPageFingerprint: fingerprint,
        wordpressManagedPageState: 'draft',
        approvalLease: {
          runId: 'approval-run',
          reservedAt: 50,
          expiresAt: 100,
        },
      },
      checkpointPath: null,
      error: null,
      createdAt: 10,
      updatedAt: 50,
      expiresAt: 1_000,
    });
    expect(recordWordPressPublishIntent(
      db,
      'wordpress-intent-timestamp',
      'approval-run',
      60,
    ).target.wordpressPublishIntent).toEqual({
      runId: 'approval-run',
      createdAt: 10,
      managedPageFingerprint: fingerprint,
    });
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

  it('treats governed token removal as a first-class update and removes stale declarations', () => {
    const updates = governedTokenUpdates(
      ':root { --amber: #e1b436; --retired: oklch(79% 0.145 88); }',
      ':root { --amber: #d84d43; }',
    );
    expect(updates).toEqual([
      {
        name: 'amber',
        beforeValues: ['#e1b436'],
        afterValues: ['#d84d43'],
      },
      {
        name: 'retired',
        beforeValues: ['oklch(79% 0.145 88)'],
        afterValues: [],
      },
    ]);
    const rewritten = rewriteGovernedTokens(
      ':root { --amber: #e1b436; --retired: oklch(79% 0.145 88); --local: blue; }',
      updates,
    );
    expect(rewritten.replacements).toBe(2);
    expect(rewritten.content).toContain('--amber: #d84d43;');
    expect(rewritten.content).not.toContain('--retired:');
    expect(rewritten.content).toContain('--local: blue;');
    expect(governedTokenSurfaceMismatch([
      { path: 'template.html', content: ':root { --retired: red; }' },
    ], updates, 'subscriber source')).toContain('still declares removed governed token --retired');
  });

  it('rejects stale governed token declarations outside the materialized snapshot', () => {
    const governed = [{
      name: 'amber',
      beforeValues: [],
      afterValues: ['#d84d43', 'oklch(61% 0.205 28)'],
    }];
    expect(governedTokenSurfaceMismatch([
      { path: 'template.html', content: ':root { --amber: oklch(75% 0.155 62); }' },
    ], governed, 'subscriber source')).toContain('does not match the target revision');
    expect(governedTokenSurfaceMismatch([
      { path: 'template.html', content: ':root { --amber: oklch(61% 0.205 28); }' },
    ], governed, 'subscriber source')).toBeNull();
    expect(governedTokenSurfaceMismatch([
      { path: 'README.md', content: 'No CSS tokens here.' },
    ], governed, 'subscriber source')).toContain('does not expose any governed token declarations');
  });

  it('allows subscriber surfaces to consume a valid subset of canonical governed tokens', () => {
    const governed = [
      { name: 'amber', beforeValues: [], afterValues: ['#d84d43'] },
      { name: 'navy', beforeValues: [], afterValues: ['#14324a'] },
    ];
    expect(governedTokenSurfaceMismatch([
      { path: 'template.html', content: ':root { --amber: #d84d43; }' },
    ], governed, 'subscriber source')).toBeNull();
  });
});

describe('design workflow automatic propagation', () => {
  it('commits a governed token revision and updates real subscriber files before advancing the applied SHA', async () => {
    const source = mkdtempSync(path.join(tmpdir(), 'od-design-workflow-source-'));
    const subscriber = mkdtempSync(path.join(tmpdir(), 'od-design-workflow-subscriber-'));
    const remote = mkdtempSync(path.join(tmpdir(), 'od-design-workflow-remote-'));
    const liveProjectsRoot = mkdtempSync(path.join(tmpdir(), 'od-design-workflow-live-projects-'));
    tempDirs.push(source, subscriber, remote, liveProjectsRoot);
    execFileSync('git', ['init', '--bare'], { cwd: remote });
    execFileSync('git', ['init'], { cwd: source });
    execFileSync('git', ['config', 'user.name', 'Open Design Test'], { cwd: source });
    execFileSync('git', ['config', 'user.email', 'open-design-test@example.invalid'], { cwd: source });
    mkdirSync(path.join(source, 'assets'), { recursive: true });
    mkdirSync(path.join(source, '.open-design'), { recursive: true });
    mkdirSync(path.join(source, 'node_modules', 'fixture'), { recursive: true });
    writeFileSync(path.join(source, 'colors_and_type.css'), ':root { --amber: #e1b436; --amber: oklch(79% 0.145 88); --retired: red; }\n');
    writeFileSync(path.join(source, 'DESIGN.md'), 'amber: "oklch(79% 0.145 88)"\n');
    writeFileSync(path.join(source, 'assets', 'retired.svg'), '<svg id="retired"/>\n');
    writeFileSync(path.join(source, '.open-design', 'tokens.css'), ':root { --ignored: red; }\n');
    writeFileSync(path.join(source, 'node_modules', 'fixture', 'tokens.css'), ':root { --ignored: red; }\n');
    execFileSync('git', ['add', '-A'], { cwd: source });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: source });
    execFileSync('git', ['branch', '-M', 'main'], { cwd: source });
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: source });
    execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: source });
    writeFileSync(path.join(subscriber, 'template.html'), '<style>:root { --amber: oklch(75% 0.155 62); --retired: red; }</style>\n');
    const liveArtifact = await createLiveArtifact({
      projectsRoot: liveProjectsRoot,
      projectId: CORE_UI_PROJECT_ID,
      input: {
        title: 'Core UI',
        slug: 'core-ui',
        pinned: true,
        status: 'active',
        preview: { type: 'html', entry: 'index.html' },
        document: {
          format: 'html_template_v1',
          templatePath: 'template.html',
          generatedPreviewPath: 'index.html',
          dataPath: 'data.json',
          dataJson: {},
        },
      },
      templateHtml: '<style>:root { --amber: oklch(75% 0.155 62); --retired: red; }</style>\n',
    });

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
      projectsRoot: liveProjectsRoot,
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
    const initialMaterializedRoot = path.join(subscriber, '.open-design', 'design-systems', 'brand');
    expect(existsSync(path.join(initialMaterializedRoot, '.open-design', 'tokens.css'))).toBe(false);
    expect(existsSync(path.join(initialMaterializedRoot, 'node_modules', 'fixture', 'tokens.css'))).toBe(false);
    expect(queuedUpdates).toEqual([CORE_UI_PROJECT_ID]);
    queuedUpdates.length = 0;
    await service.captureRunStart('run-token', 'source');
    writeFileSync(path.join(source, 'colors_and_type.css'), ':root { --amber: #d84d43; --amber: oklch(61% 0.205 28); --retired: red; }\n');
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
    expect(await readLiveArtifactCode({
      projectsRoot: liveProjectsRoot,
      projectId: CORE_UI_PROJECT_ID,
      artifactId: liveArtifact.artifact.id,
      variant: 'rendered',
    })).toContain('--amber: oklch(61% 0.205 28);');
    expect(execFileSync('git', ['ls-remote', '--heads', 'origin', 'open-design/run-run-token'], { cwd: source, encoding: 'utf8' }).trim()).not.toBe('');
    expect(queuedUpdates).toEqual([CORE_UI_PROJECT_ID]);

    const preResidualBranch = execFileSync(
      'git',
      ['branch', '--show-current'],
      { cwd: source, encoding: 'utf8' },
    ).trim();
    const preResidualSha = execFileSync(
      'git',
      ['rev-parse', 'HEAD'],
      { cwd: source, encoding: 'utf8' },
    ).trim();
    await service.captureRunStart('run-residual-ignored', 'source');
    writeFileSync(
      path.join(source, 'DESIGN.md'),
      'amber: "oklch(61% 0.205 28)"\nResidual tracked change.\n',
    );
    writeFileSync(
      path.join(source, '.open-design', 'tokens.css'),
      ':root { --ignored: blue; }\n',
    );
    await expect(service.completeRun({
      runId: 'run-residual-ignored',
      projectId: 'source',
      prompt: 'Change a normal file and an ignored tracked file.',
      succeeded: true,
    })).rejects.toThrow('managed worktree still contains untracked or uncommitted changes');
    expect(execFileSync('git', ['status', '--short'], { cwd: source, encoding: 'utf8' })).toBe('');
    expect(execFileSync('git', ['branch', '--show-current'], { cwd: source, encoding: 'utf8' }).trim())
      .toBe(preResidualBranch);
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim())
      .toBe(preResidualSha);
    expect(execFileSync(
      'git',
      ['show', 'open-design/recovery-source-run-residual-ignored:.open-design/tokens.css'],
      { cwd: source, encoding: 'utf8' },
    )).toContain('--ignored: blue;');
    expect(execFileSync(
      'git',
      ['show', 'open-design/recovery-source-run-residual-ignored:DESIGN.md'],
      { cwd: source, encoding: 'utf8' },
    )).toContain('Residual tracked change.');

    const preFailureBranch = execFileSync(
      'git',
      ['branch', '--show-current'],
      { cwd: source, encoding: 'utf8' },
    ).trim();
    const preFailureSha = execFileSync(
      'git',
      ['rev-parse', 'HEAD'],
      { cwd: source, encoding: 'utf8' },
    ).trim();
    await service.captureRunStart('run-failed-source', 'source');
    writeFileSync(path.join(source, 'failed-run-note.txt'), 'preserve me\n');
    await service.completeRun({
      runId: 'run-failed-source',
      projectId: 'source',
      prompt: 'This run fails after editing.',
      succeeded: false,
    });
    expect(execFileSync('git', ['status', '--short'], { cwd: source, encoding: 'utf8' })).toBe('');
    expect(execFileSync('git', ['branch', '--show-current'], { cwd: source, encoding: 'utf8' }).trim()).toBe(preFailureBranch);
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim()).toBe(preFailureSha);
    expect(execFileSync(
      'git',
      ['show', 'open-design/recovery-source-run-failed-source:failed-run-note.txt'],
      { cwd: source, encoding: 'utf8' },
    )).toBe('preserve me\n');
    await service.captureRunStart('run-after-failed-source', 'source');
    await service.completeRun({
      runId: 'run-after-failed-source',
      projectId: 'source',
      prompt: 'No-op after recovery.',
      succeeded: false,
    });

    queuedUpdates.length = 0;
    await service.captureRunStart('run-structural', 'source');
    writeFileSync(path.join(source, 'colors_and_type.css'), ':root { --amber: #d84d43; --amber: oklch(61% 0.205 28); }\n');
    writeFileSync(path.join(source, 'DESIGN.md'), 'amber: "oklch(61% 0.205 28)"\nNew component contract.\n');
    rmSync(path.join(source, 'assets', 'retired.svg'));
    await service.completeRun({ runId: 'run-structural', projectId: 'source', prompt: 'Change the component contract.', succeeded: true });

    const structuralStatus = await service.statusForProject(CORE_UI_PROJECT_ID);
    expect(structuralStatus.subscription?.status).toBe('update_needed');
    expect(queuedUpdates).toEqual([CORE_UI_PROJECT_ID]);
    expect(await service.promptContext(CORE_UI_PROJECT_ID, '/update')).toContain(
      'If any required subscriber surface or registered preview remains stale or cannot be validated, do not report success.',
    );

    const priorAppliedSha = structuralStatus.subscription?.appliedSha;
    await expect(service.completeRun({
      runId: 'run-structural-update-incomplete',
      projectId: CORE_UI_PROJECT_ID,
      prompt: '/update',
      succeeded: true,
    })).rejects.toThrow('Subscriber materialized design-system revision is incomplete');
    expect((await service.statusForProject(CORE_UI_PROJECT_ID)).subscription).toEqual(expect.objectContaining({
      status: 'sync_failed',
      appliedSha: priorAppliedSha,
      targetSha: structuralStatus.currentRevision.sha,
      lastError: expect.stringContaining(`instead of ${structuralStatus.currentRevision.shortSha}`),
    }));

    await service.rollback(CORE_UI_PROJECT_ID, structuralStatus.currentRevision.sha);
    const materializedRoot = path.join(subscriber, '.open-design', 'design-systems', 'brand');
    expect(existsSync(path.join(materializedRoot, 'assets', 'retired.svg'))).toBe(false);
    await service.resume(CORE_UI_PROJECT_ID);
    mkdirSync(path.join(materializedRoot, 'assets'), { recursive: true });
    writeFileSync(path.join(materializedRoot, 'assets', 'retired.svg'), '<svg id="stale"/>\n');
    await expect(service.completeRun({
      runId: 'run-structural-update-extra',
      projectId: CORE_UI_PROJECT_ID,
      prompt: '/update',
      succeeded: true,
    })).rejects.toThrow('assets/retired.svg is not present in revision');

    await service.rollback(CORE_UI_PROJECT_ID, structuralStatus.currentRevision.sha);
    expect(existsSync(path.join(materializedRoot, 'assets', 'retired.svg'))).toBe(false);
    await service.resume(CORE_UI_PROJECT_ID);
    writeFileSync(
      path.join(materializedRoot, 'colors_and_type.css'),
      ':root { --amber: #000000; }\n',
    );
    await expect(service.completeRun({
      runId: 'run-structural-update-tampered',
      projectId: CORE_UI_PROJECT_ID,
      prompt: '/update',
      succeeded: true,
    })).rejects.toThrow('colors_and_type.css does not match');

    await service.rollback(CORE_UI_PROJECT_ID, structuralStatus.currentRevision.sha);
    await service.resume(CORE_UI_PROJECT_ID);
    rmSync(path.join(source, 'colors_and_type.css'));
    rmSync(path.join(materializedRoot, 'colors_and_type.css'));
    await expect(service.completeRun({
      runId: 'run-structural-update-missing',
      projectId: CORE_UI_PROJECT_ID,
      prompt: '/update',
      succeeded: true,
    })).rejects.toThrow('colors_and_type.css is missing from the materialized snapshot');

    await service.rollback(CORE_UI_PROJECT_ID, structuralStatus.currentRevision.sha);
    await service.resume(CORE_UI_PROJECT_ID);
    const interruptedBackup = path.join(path.dirname(materializedRoot), '.brand.backup-interrupted');
    const interruptedTemporary = path.join(path.dirname(materializedRoot), '.brand.tmp-interrupted');
    renameSync(materializedRoot, interruptedBackup);
    mkdirSync(interruptedTemporary, { recursive: true });
    writeFileSync(path.join(interruptedTemporary, 'partial.txt'), 'partial\n');
    writeFileSync(path.join(subscriber, 'template.html'), '<style>:root { --amber: oklch(75% 0.155 62); --retired: red; }</style>\n');
    await updateLiveArtifact({
      projectsRoot: liveProjectsRoot,
      projectId: CORE_UI_PROJECT_ID,
      artifactId: liveArtifact.artifact.id,
      input: {},
      templateHtml: '<style>:root { --amber: oklch(75% 0.155 62); --retired: red; }</style>\n',
    });
    await service.completeRun({
      runId: 'run-structural-update-recovered',
      projectId: CORE_UI_PROJECT_ID,
      prompt: '/update',
      succeeded: true,
    });
    expect((await service.statusForProject(CORE_UI_PROJECT_ID)).subscription).toEqual(expect.objectContaining({
      status: 'up_to_date',
      appliedSha: structuralStatus.currentRevision.sha,
      targetSha: structuralStatus.currentRevision.sha,
      lastError: null,
    }));
    expect(existsSync(interruptedBackup)).toBe(false);
    expect(existsSync(interruptedTemporary)).toBe(false);
    expect(existsSync(materializedRoot)).toBe(true);
    expect(readFileSync(path.join(subscriber, 'template.html'), 'utf8')).toContain('oklch(61% 0.205 28)');
    expect(readFileSync(path.join(subscriber, 'template.html'), 'utf8')).not.toContain('--retired:');
    const recoveredArtifact = await readLiveArtifactCode({
      projectsRoot: liveProjectsRoot,
      projectId: CORE_UI_PROJECT_ID,
      artifactId: liveArtifact.artifact.id,
      variant: 'rendered',
    });
    expect(recoveredArtifact).toContain('oklch(61% 0.205 28)');
    expect(recoveredArtifact).not.toContain('--retired:');
  });

  it('aggregates governed tokens across supported CSS files and treats a global rename as structural', async () => {
    const source = mkdtempSync(path.join(tmpdir(), 'od-design-workflow-token-files-source-'));
    const subscriber = mkdtempSync(path.join(tmpdir(), 'od-design-workflow-token-files-subscriber-'));
    const remote = mkdtempSync(path.join(tmpdir(), 'od-design-workflow-token-files-remote-'));
    tempDirs.push(source, subscriber, remote);
    execFileSync('git', ['init', '--bare'], { cwd: remote });
    execFileSync('git', ['init'], { cwd: source });
    execFileSync('git', ['config', 'user.name', 'Open Design Test'], { cwd: source });
    execFileSync('git', ['config', 'user.email', 'open-design-test@example.invalid'], { cwd: source });
    mkdirSync(path.join(source, 'system', 'tokens'), { recursive: true });
    writeFileSync(
      path.join(source, 'tokens.css'),
      ':root { --brand: red; --shared: green; }\n',
    );
    writeFileSync(
      path.join(source, 'system', 'tokens', 'theme.css'),
      ':root { --shared: green; }\n',
    );
    execFileSync('git', ['add', '-A'], { cwd: source });
    execFileSync('git', ['commit', '-m', 'initial tokens'], { cwd: source });
    execFileSync('git', ['branch', '-M', 'main'], { cwd: source });
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: source });
    execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: source });
    writeFileSync(
      path.join(subscriber, 'template.html'),
      '<style>:root { --brand: red; --shared: green; }</style>\n',
    );

    const projects = new Map<string, any>([
      ['source', {
        id: 'source',
        name: 'Brand',
        designSystemId: 'user:brand',
        updatedAt: 2,
        metadata: {
          importedFrom: 'design-system',
          baseDir: source,
          designWorkflowWorktree: source,
        },
      }],
      ['asset', {
        id: 'asset',
        name: 'Asset',
        designSystemId: 'user:brand',
        updatedAt: 1,
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
    });

    await service.initializeProject('asset');
    await service.captureRunStart('run-token-file-value', 'source');
    writeFileSync(
      path.join(source, 'tokens.css'),
      ':root { --brand: blue; --shared: green; }\n',
    );
    await service.completeRun({
      runId: 'run-token-file-value',
      projectId: 'source',
      prompt: 'Change tokens.css value.',
      succeeded: true,
    });
    const valueStatus = await service.statusForProject('asset');
    expect(valueStatus.currentRevision.classification).toBe('compatible');
    expect(valueStatus.subscription).toEqual(expect.objectContaining({
      status: 'updated_automatically',
      appliedSha: valueStatus.currentRevision.sha,
    }));
    expect(readFileSync(path.join(subscriber, 'template.html'), 'utf8')).toContain('--brand: blue;');

    await service.captureRunStart('run-token-file-duplicate-removal', 'source');
    writeFileSync(path.join(source, 'tokens.css'), ':root { --brand: blue; }\n');
    await service.completeRun({
      runId: 'run-token-file-duplicate-removal',
      projectId: 'source',
      prompt: 'Remove one duplicate token declaration.',
      succeeded: true,
    });
    const duplicateRemovalStatus = await service.statusForProject('asset');
    expect(duplicateRemovalStatus.currentRevision.classification).toBe('compatible');
    expect(duplicateRemovalStatus.subscription?.appliedSha).toBe(
      duplicateRemovalStatus.currentRevision.sha,
    );
    expect(readFileSync(path.join(subscriber, 'template.html'), 'utf8')).toContain('--shared: green;');

    const appliedBeforeRename = duplicateRemovalStatus.subscription!.appliedSha;
    await service.captureRunStart('run-token-file-rename', 'source');
    writeFileSync(
      path.join(source, 'system', 'tokens', 'theme.css'),
      ':root { --renamed: green; }\n',
    );
    await service.completeRun({
      runId: 'run-token-file-rename',
      projectId: 'source',
      prompt: 'Rename the remaining governed token.',
      succeeded: true,
    });
    const renameStatus = await service.statusForProject('asset');
    expect(renameStatus.currentRevision.classification).toBe('structural');
    expect(renameStatus.subscription).toEqual(expect.objectContaining({
      status: 'update_needed',
      appliedSha: appliedBeforeRename,
      targetSha: renameStatus.currentRevision.sha,
    }));
    expect(readFileSync(path.join(subscriber, 'template.html'), 'utf8')).toContain('--shared: green;');
  });

  it('recovers a crashed source run from the durable capture journal before starting the next run', async () => {
    const source = mkdtempSync(path.join(tmpdir(), 'od-design-workflow-crash-source-'));
    const remote = mkdtempSync(path.join(tmpdir(), 'od-design-workflow-crash-remote-'));
    tempDirs.push(source, remote);
    execFileSync('git', ['init', '--bare'], { cwd: remote });
    execFileSync('git', ['init'], { cwd: source });
    execFileSync('git', ['config', 'user.name', 'Open Design Test'], { cwd: source });
    execFileSync('git', ['config', 'user.email', 'open-design-test@example.invalid'], { cwd: source });
    writeFileSync(path.join(source, 'DESIGN.md'), '# Base\n');
    execFileSync('git', ['add', '-A'], { cwd: source });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: source });
    execFileSync('git', ['branch', '-M', 'main'], { cwd: source });
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: source });
    execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: source });
    const projects = new Map<string, any>([
      ['source', {
        id: 'source',
        name: 'Brand',
        designSystemId: 'user:brand',
        updatedAt: 1,
        metadata: {
          importedFrom: 'design-system',
          baseDir: source,
          designWorkflowWorktree: source,
        },
      }],
    ]);
    const db = makeDb();
    const makeService = () => createDesignWorkflowService({
      db,
      projectsRoot: source,
      runtimeDataDir: source,
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
    });
    const beforeCrash = makeService();
    await beforeCrash.captureRunStart('run-before-crash', 'source');
    writeFileSync(path.join(source, 'DESIGN.md'), '# Interrupted\n');

    const afterRestart = makeService();
    await afterRestart.captureRunStart('run-after-crash', 'source');
    expect(readFileSync(path.join(source, 'DESIGN.md'), 'utf8')).toBe('# Base\n');
    expect(execFileSync(
      'git',
      ['show', 'open-design/recovery-source-run-before-crash:DESIGN.md'],
      { cwd: source, encoding: 'utf8' },
    )).toBe('# Interrupted\n');
    await afterRestart.completeRun({
      runId: 'run-after-crash',
      projectId: 'source',
      prompt: 'Recovered no-op.',
      succeeded: false,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM design_workflow_source_run_captures').get())
      .toEqual({ count: 0 });
  });

  it('replays partially completed subscriber propagation before clearing a crashed source capture', async () => {
    const source = mkdtempSync(path.join(tmpdir(), 'od-design-workflow-replay-source-'));
    const subscriberA = mkdtempSync(path.join(tmpdir(), 'od-design-workflow-replay-a-'));
    const subscriberB = mkdtempSync(path.join(tmpdir(), 'od-design-workflow-replay-b-'));
    const remote = mkdtempSync(path.join(tmpdir(), 'od-design-workflow-replay-remote-'));
    tempDirs.push(source, subscriberA, subscriberB, remote);
    execFileSync('git', ['init', '--bare'], { cwd: remote });
    execFileSync('git', ['init'], { cwd: source });
    execFileSync('git', ['config', 'user.name', 'Open Design Test'], { cwd: source });
    execFileSync('git', ['config', 'user.email', 'open-design-test@example.invalid'], { cwd: source });
    writeFileSync(path.join(source, 'tokens.css'), ':root { --brand: red; }\n');
    execFileSync('git', ['add', '-A'], { cwd: source });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: source });
    execFileSync('git', ['branch', '-M', 'main'], { cwd: source });
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: source });
    execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: source });
    const baseSha = execFileSync(
      'git',
      ['rev-parse', 'HEAD'],
      { cwd: source, encoding: 'utf8' },
    ).trim();
    execFileSync('git', ['switch', '-c', 'open-design/run-crashed-propagation'], { cwd: source });
    writeFileSync(path.join(source, 'tokens.css'), ':root { --brand: blue; }\n');
    execFileSync('git', ['add', '-A'], { cwd: source });
    execFileSync('git', ['commit', '-m', 'completed source revision'], { cwd: source });
    const revisionSha = execFileSync(
      'git',
      ['rev-parse', 'HEAD'],
      { cwd: source, encoding: 'utf8' },
    ).trim();
    writeFileSync(path.join(subscriberA, 'template.html'), '<style>:root { --brand: blue; }</style>\n');
    writeFileSync(path.join(subscriberB, 'template.html'), '<style>:root { --brand: red; }</style>\n');

    const projects = new Map<string, any>([
      ['source', {
        id: 'source',
        name: 'Brand',
        designSystemId: 'user:brand',
        updatedAt: 3,
        metadata: {
          importedFrom: 'design-system',
          baseDir: source,
          designWorkflowWorktree: source,
        },
      }],
      ['asset-a', {
        id: 'asset-a',
        name: 'Asset A',
        designSystemId: 'user:brand',
        updatedAt: 2,
        metadata: { importedFrom: 'project-location', baseDir: subscriberA },
      }],
      [CORE_UI_PROJECT_ID, {
        id: CORE_UI_PROJECT_ID,
        name: 'Asset B',
        designSystemId: 'user:brand',
        updatedAt: 1,
        metadata: { importedFrom: 'project-location', baseDir: subscriberB },
      }],
    ]);
    const db = makeDb();
    const baseRevision = createDesignWorkflowRevision(db, {
      designSystemId: 'user:brand',
      sourceProjectId: 'source',
      sha: baseSha,
      branch: 'main',
      classification: 'compatible',
      changedPaths: [],
      runId: null,
      createdAt: 1,
    });
    initializeDesignWorkflowSubscription(db, 'asset-a', baseRevision, 1);
    initializeDesignWorkflowSubscription(db, CORE_UI_PROJECT_ID, baseRevision, 1);
    const completedRevision = createDesignWorkflowRevision(db, {
      designSystemId: 'user:brand',
      sourceProjectId: 'source',
      sha: revisionSha,
      branch: 'open-design/run-crashed-propagation',
      classification: 'compatible',
      changedPaths: ['tokens.css'],
      runId: 'run-crashed-propagation',
      createdAt: 2,
    });
    fanOutDesignWorkflowRevision(db, completedRevision, ['asset-a'], 2);
    db.prepare(`
      INSERT INTO design_workflow_source_run_captures
        (run_id, project_id, root, base_sha, base_branch, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      'run-crashed-propagation',
      'source',
      source,
      baseSha,
      'main',
      1,
    );
    const makeService = (queueSubscriberUpdate?: (projectId: string) => void) =>
      createDesignWorkflowService({
        db,
        projectsRoot: source,
        runtimeDataDir: source,
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
        validateSubscriberImplementation: async () => null,
        ...(queueSubscriberUpdate ? { queueSubscriberUpdate } : {}),
      });
    const failingReplay = makeService(() => {
      throw new Error('subscriber queue unavailable');
    });
    await expect(
      failingReplay.captureRunStart('run-replay-while-queue-fails', 'source'),
    ).rejects.toThrow('subscriber queue unavailable');
    expect(db.prepare(`
      SELECT run_id AS runId
      FROM design_workflow_source_run_captures
    `).all()).toEqual([{ runId: 'run-crashed-propagation' }]);

    const service = makeService();
    await service.captureRunStart('run-after-propagation-replay', 'source');
    expect(getDesignWorkflowSubscription(db, 'asset-a')).toEqual(expect.objectContaining({
      appliedSha: revisionSha,
      targetSha: revisionSha,
    }));
    expect(getDesignWorkflowSubscription(db, CORE_UI_PROJECT_ID)).toEqual(expect.objectContaining({
      appliedSha: revisionSha,
      targetSha: revisionSha,
      status: 'updated_automatically',
    }));
    expect(readFileSync(path.join(subscriberA, 'template.html'), 'utf8')).toContain('--brand: blue;');
    expect(readFileSync(path.join(subscriberB, 'template.html'), 'utf8')).toContain('--brand: blue;');
    expect(db.prepare(`
      SELECT run_id AS runId
      FROM design_workflow_source_run_captures
      ORDER BY created_at
    `).all()).toEqual([{ runId: 'run-after-propagation-replay' }]);
    await service.completeRun({
      runId: 'run-after-propagation-replay',
      projectId: 'source',
      prompt: 'No-op after propagation replay.',
      succeeded: false,
    });
  });

  it('serializes public initialization and publish mutations behind active project runs', async () => {
    const source = mkdtempSync(path.join(tmpdir(), 'od-design-workflow-lock-source-'));
    const subscriber = mkdtempSync(path.join(tmpdir(), 'od-design-workflow-lock-subscriber-'));
    const remote = mkdtempSync(path.join(tmpdir(), 'od-design-workflow-lock-remote-'));
    tempDirs.push(source, subscriber, remote);
    execFileSync('git', ['init', '--bare'], { cwd: remote });
    execFileSync('git', ['init'], { cwd: source });
    execFileSync('git', ['config', 'user.name', 'Open Design Test'], { cwd: source });
    execFileSync('git', ['config', 'user.email', 'open-design-test@example.invalid'], { cwd: source });
    writeFileSync(path.join(source, 'tokens.css'), ':root { --brand: red; }\n');
    execFileSync('git', ['add', '-A'], { cwd: source });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: source });
    execFileSync('git', ['branch', '-M', 'main'], { cwd: source });
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: source });
    execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: source });
    writeFileSync(path.join(subscriber, 'template.html'), '<style>:root { --brand: red; }</style>\n');
    const projects = new Map<string, any>([
      ['source', {
        id: 'source',
        name: 'Brand',
        designSystemId: 'user:brand',
        updatedAt: 2,
        metadata: {
          importedFrom: 'design-system',
          baseDir: source,
          designWorkflowWorktree: source,
        },
      }],
      ['asset', {
        id: 'asset',
        name: 'Asset',
        designSystemId: 'user:brand',
        updatedAt: 1,
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
    });

    await service.captureRunStart('run-lock-subscriber', 'asset', 'Hold subscriber lock.');
    let initialized = false;
    const initialization = service.initializeProject('asset').then((status) => {
      initialized = true;
      return status;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(initialized).toBe(false);
    expect(getDesignWorkflowSubscription(db, 'asset')).toBeNull();
    expect(existsSync(path.join(
      subscriber,
      '.open-design',
      'design-systems',
      'brand',
      'revision.json',
    ))).toBe(false);
    await service.completeRun({
      runId: 'run-lock-subscriber',
      projectId: 'asset',
      prompt: 'Hold subscriber lock.',
      succeeded: false,
    });
    await expect(initialization).resolves.toEqual(expect.objectContaining({ role: 'subscriber' }));

    await service.captureRunStart('run-lock-source', 'source', 'Hold source lock.');
    await expect(
      service.statusForProject('source', 'run-lock-source'),
    ).resolves.toEqual(expect.objectContaining({ role: 'source' }));
    await expect(
      service.readAppliedFile('source', 'DESIGN.md', false, 'run-lock-source'),
    ).resolves.toBeNull();
    await expect(
      service.promptContext('source', 'Hold source lock.', 'run-lock-source'),
    ).resolves.toContain('Design workflow source revision');
    await expect(
      service.statusForProject('source'),
    ).resolves.toEqual(expect.objectContaining({ role: 'source' }));
    await expect(
      service.statusForProject('asset', 'run-lock-source'),
    ).rejects.toThrow('holds the design-workflow lock for source, not asset');

    let published = false;
    const publication = service.publish('source').then((status) => {
      published = true;
      return status;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(published).toBe(false);
    await service.completeRun({
      runId: 'run-lock-source',
      projectId: 'source',
      prompt: 'Hold source lock.',
      succeeded: false,
    });
    await expect(publication).resolves.toEqual(expect.objectContaining({ role: 'source' }));
    await expect(
      service.statusForProject('source', 'routine-run-without-capture'),
    ).resolves.toEqual(expect.objectContaining({ role: 'source' }));
  });

  it('binds Core UI delivery to the exact remote preview tip and remote default branch', async () => {
    const source = mkdtempSync(path.join(tmpdir(), 'od-design-workflow-push-source-'));
    const subscriber = mkdtempSync(path.join(tmpdir(), 'od-design-workflow-push-subscriber-'));
    const core = mkdtempSync(path.join(tmpdir(), 'od-design-workflow-push-core-'));
    const coreRemote = mkdtempSync(path.join(tmpdir(), 'od-design-workflow-push-core-remote-'));
    const decoyRemote = mkdtempSync(path.join(tmpdir(), 'od-design-workflow-push-decoy-remote-'));
    tempDirs.push(source, subscriber, core, coreRemote, decoyRemote);

    execFileSync('git', ['init'], { cwd: source });
    execFileSync('git', ['config', 'user.name', 'Open Design Test'], { cwd: source });
    execFileSync('git', ['config', 'user.email', 'open-design-test@example.invalid'], { cwd: source });
    writeFileSync(path.join(source, 'tokens.json'), '{"brand":"red"}\n');
    execFileSync('git', ['add', '-A'], { cwd: source });
    execFileSync('git', ['commit', '-m', 'design revision'], { cwd: source });
    const designRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();

    execFileSync('git', ['init', '--bare'], { cwd: coreRemote });
    execFileSync('git', ['init', '--bare'], { cwd: decoyRemote });
    execFileSync('git', ['init'], { cwd: core });
    execFileSync('git', ['config', 'user.name', 'Open Design Test'], { cwd: core });
    execFileSync('git', ['config', 'user.email', 'open-design-test@example.invalid'], { cwd: core });
    mkdirSync(path.join(core, '99_System', 'core-v2', 'apps', 'web', 'src'), { recursive: true });
    writeFileSync(path.join(core, '99_System', 'core-v2', 'package.json'), '{"name":"core-v2"}\n');
    writeFileSync(
      path.join(core, '99_System', 'core-v2', 'apps', 'web', 'src', 'app.html'),
      [
        '<html>',
        '  <head>',
        '    <!-- open-design-attestation:start -->',
        '    <!-- open-design-attestation:end -->',
        '  </head>',
        '</html>',
        '',
      ].join('\n'),
    );
    execFileSync('git', ['add', '-A'], { cwd: core });
    execFileSync('git', ['commit', '-m', 'base'], { cwd: core });
    execFileSync('git', ['branch', '-M', 'master'], { cwd: core });
    execFileSync('git', ['remote', 'add', 'origin', coreRemote], { cwd: core });
    execFileSync('git', ['push', '-u', 'origin', 'master'], { cwd: core });
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/master'], { cwd: coreRemote });
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: core, encoding: 'utf8' }).trim();

    const projects = new Map<string, any>([
      ['source', {
        id: 'source', name: 'Brand', designSystemId: 'user:brand', updatedAt: 2,
        metadata: { importedFrom: 'design-system', baseDir: source, designWorkflowWorktree: source },
      }],
      [CORE_UI_PROJECT_ID, {
        id: CORE_UI_PROJECT_ID, name: 'Core UI', designSystemId: 'user:brand', updatedAt: 1,
        metadata: { importedFrom: 'project-location', baseDir: subscriber, linkedDirs: [core] },
      }],
    ]);
    const db = makeDb();
    let trustedDeploymentVerificationFails = false;
    let driftCanonicalRemoteDuringDeployment = false;
    let previewReceiptContent = '';
    let issuedReceiptPath = '';
    const trustedBuildDigest = 'c'.repeat(64);
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
      coreUiGitRemote: coreRemote,
      verifyCoreUiCandidate: async (input) => {
        expect(input.repositoryRoot).toBe(core);
        expect(input.receiptPath).toBe(issuedReceiptPath);
        return {
          attestationCommit: input.attestationCommit,
          buildDigest: trustedBuildDigest,
          checks: ['check', 'test', 'build', 'browser']
            .map((name) => ({ name, status: 'passed' as const })),
          pid: 3132,
        };
      },
      verifyCoreUiDeploymentEvidence: async (input) => {
        expect(input.repositoryRoot).toBe(core);
        expect(input.buildDigest).toBe(trustedBuildDigest);
        if (trustedDeploymentVerificationFails) {
          throw new Error('trusted deployment verification failed');
        }
        return {
          attestationCommit: input.attestationCommit,
          buildDigest: input.buildDigest,
          pids: { api: 3301, web: 3302 },
        };
      },
      verifyCoreUiPreview: async (input) => {
        expect(input.gitRemote).toBe(coreRemote);
        expect(input.previewUrl).toBe(
          'https://studio-macbook-server.taila20f18.ts.net:8446/',
        );
        expect(input.receiptUrl).toBe(
          `https://studio-macbook-server.taila20f18.ts.net:8446/${issuedReceiptPath.slice('99_System/core-v2/apps/web/static/'.length)}`,
        );
        expect(input.receiptContent.toString('utf8')).toBe(previewReceiptContent);
        expect(input.revisionSha).toBe(designRevision);
      },
      verifyCoreUiDeployment: async (input) => {
        expect(input.gitRemote).toBe(coreRemote);
        expect(input.receiptPath).toBe(issuedReceiptPath);
        expect(input.receiptContent.toString('utf8')).toBe(previewReceiptContent);
        expect(input.revisionSha).toBe(designRevision);
        if (driftCanonicalRemoteDuringDeployment) {
          execFileSync(
            'git',
            ['push', '--force', coreRemote, `${baseSha}:refs/heads/master`],
            { cwd: core },
          );
        }
      },
    });
    const status = await service.initializeProject(CORE_UI_PROJECT_ID);
    mkdirSync(path.join(subscriber, '.open-design'), { recursive: true });
    await service.captureRunStart('run-core-push', CORE_UI_PROJECT_ID, '/push');
    const issued = db.prepare(`
      SELECT challenge, run_id AS runId, project_id AS projectId,
             design_revision_sha AS designRevision, base_branch AS baseBranch,
             base_commit AS baseCommit, git_remote AS gitRemote, target_origin AS targetOrigin,
             receipt_path AS receiptPath
      FROM design_workflow_delivery_challenges
      WHERE run_id = ?
    `).get('run-core-push') as Record<string, string>;
    expect(issued.baseCommit).toBe(baseSha);
    issuedReceiptPath = issued.receiptPath!;
    execFileSync('git', ['remote', 'set-url', 'origin', decoyRemote], { cwd: core });

    execFileSync('git', ['switch', '-c', 'codex/open-design-preview'], { cwd: core });
    mkdirSync(path.join(core, '99_System', 'core-v2', 'apps', 'web', 'src', 'lib'), {
      recursive: true,
    });
    writeFileSync(
      path.join(core, '99_System', 'core-v2', 'apps', 'web', 'src', 'lib', 'preview.ts'),
      'export const preview = true;\n',
    );
    execFileSync('git', ['add', '-A'], { cwd: core });
    execFileSync('git', ['commit', '-m', 'implementation'], { cwd: core });
    const implementationCommit = execFileSync(
      'git',
      ['rev-parse', 'HEAD'],
      { cwd: core, encoding: 'utf8' },
    ).trim();
    const receiptBuffer = canonicalCoreUiReceipt({
      challenge: issued.challenge!,
      projectId: issued.projectId!,
      runId: issued.runId!,
      designRevision: issued.designRevision!,
      baseBranch: issued.baseBranch!,
      baseCommit: issued.baseCommit!,
      gitRemote: issued.gitRemote!,
      implementationCommit,
      targetOrigin: issued.targetOrigin!,
      receiptPath: issued.receiptPath!,
    });
    previewReceiptContent = receiptBuffer.toString('utf8');
    const appPath = path.join(core, '99_System', 'core-v2', 'apps', 'web', 'src', 'app.html');
    writeFileSync(
      appPath,
      readFileSync(appPath, 'utf8').replace(
        [
          '    <!-- open-design-attestation:start -->',
          '    <!-- open-design-attestation:end -->',
        ].join('\n'),
        [
          '    <!-- open-design-attestation:start -->',
          `    <meta name="open-design-challenge" content="${issued.challenge}" />`,
          `    <meta name="open-design-design-revision" content="${issued.designRevision}" />`,
          `    <meta name="open-design-implementation-commit" content="${implementationCommit}" />`,
          `    <meta name="open-design-target-origin" content="${issued.targetOrigin}" />`,
          `    <meta name="open-design-receipt-path" content="/${issued.receiptPath!.slice('99_System/core-v2/apps/web/static/'.length)}" />`,
          '    <!-- open-design-attestation:end -->',
        ].join('\n'),
      ),
    );
    const receiptFile = path.join(core, issued.receiptPath!);
    mkdirSync(path.dirname(receiptFile), { recursive: true });
    writeFileSync(receiptFile, receiptBuffer);
    execFileSync('git', ['add', '-A'], { cwd: core });
    execFileSync('git', ['commit', '-m', 'attestation'], { cwd: core });
    const previewCommit = execFileSync(
      'git',
      ['rev-parse', 'HEAD'],
      { cwd: core, encoding: 'utf8' },
    ).trim();
    execFileSync(
      'git',
      ['push', coreRemote, 'HEAD:refs/heads/codex/open-design-preview'],
      { cwd: core },
    );

    writeFileSync(path.join(subscriber, '.open-design', 'delivery.json'), `${JSON.stringify({
      schemaVersion: 2,
      adapter: 'core-ui',
      challenge: issued.challenge,
      branch: 'codex/open-design-preview',
      baseBranch: issued.baseBranch,
      baseCommit: issued.baseCommit,
      gitRemote: issued.gitRemote,
      implementationCommit,
      attestationCommit: previewCommit,
      designRevision: status.subscription?.appliedSha,
      targetOrigin: issued.targetOrigin,
      previewUrl: 'https://studio-macbook-server.taila20f18.ts.net:8446/',
      receiptPath: issued.receiptPath,
      previewReceiptUrl: `https://studio-macbook-server.taila20f18.ts.net:8446/${issued.receiptPath!.slice('99_System/core-v2/apps/web/static/'.length)}`,
      approvalRequired: true,
      approvalReady: true,
      checks: [
        { name: 'tests', status: 'passed', commit: previewCommit },
        { name: 'build', status: 'passed', commit: previewCommit },
        { name: 'browser', status: 'passed', commit: previewCommit },
      ],
    })}\n`);

    execFileSync('git', ['switch', 'master'], { cwd: core });
    await service.completeRun({
      runId: 'run-core-push',
      projectId: CORE_UI_PROJECT_ID,
      prompt: '/push',
      succeeded: true,
    });
    expect(db.prepare(`
      SELECT status, delivery_id AS deliveryId
      FROM design_workflow_delivery_challenges
      WHERE run_id = 'run-core-push'
    `).get()).toEqual({
      status: 'consumed',
      deliveryId: expect.any(String),
    });
    const readyDelivery = (await service.statusForProject(CORE_UI_PROJECT_ID)).delivery;
    expect(readyDelivery).toEqual(expect.objectContaining({
      status: 'ready_for_approval',
      target: expect.objectContaining({
        branch: 'codex/open-design-preview',
        commit: previewCommit,
        baseSha,
        baseBranch: 'master',
        baseCommit: baseSha,
        implementationCommit,
        attestationCommit: previewCommit,
        challenge: issued.challenge,
        trustedBuildDigest,
        trustedChecks: expect.arrayContaining([
          { name: 'browser', status: 'passed' },
          { name: 'build', status: 'passed' },
          { name: 'check', status: 'passed' },
          { name: 'test', status: 'passed' },
        ]),
      }),
    }));

    const approvalPrompt = `/approve ${readyDelivery!.id} ${readyDelivery!.implementationDigest}`;
    await expect(service.approveDelivery(
      CORE_UI_PROJECT_ID,
      readyDelivery!.id,
      readyDelivery!.implementationDigest,
    )).rejects.toThrow('must run through /approve');
    await service.captureRunStart('run-core-approve-failed', CORE_UI_PROJECT_ID, approvalPrompt);
    await expect(service.captureRunStart(
      'run-core-update-during-approval',
      CORE_UI_PROJECT_ID,
      '/update',
    )).rejects.toThrow('approval is in progress');
    expect(getDesignWorkflowDelivery(db, readyDelivery!.id)?.status).toBe('approving');
    await service.completeRun({
      runId: 'run-core-approve-failed',
      projectId: CORE_UI_PROJECT_ID,
      prompt: approvalPrompt,
      succeeded: false,
    });
    expect(getDesignWorkflowDelivery(db, readyDelivery!.id)).toEqual(expect.objectContaining({
      status: 'approving',
      target: expect.objectContaining({
        reconciliationRequired: true,
        coreDeploymentIntent: expect.objectContaining({
          attestationCommit: previewCommit,
        }),
      }),
    }));
    execFileSync('git', ['switch', 'codex/open-design-preview'], { cwd: core });
    await service.captureRunStart('run-core-approve-wrong-branch', CORE_UI_PROJECT_ID, approvalPrompt);
    await expect(service.completeRun({
      runId: 'run-core-approve-wrong-branch',
      projectId: CORE_UI_PROJECT_ID,
      prompt: approvalPrompt,
      succeeded: true,
    })).rejects.toThrow('on branch master');
    expect(getDesignWorkflowDelivery(db, readyDelivery!.id)).toEqual(expect.objectContaining({
      status: 'approving',
      target: expect.objectContaining({ reconciliationRequired: true }),
    }));
    execFileSync('git', ['switch', 'master'], { cwd: core });
    writeFileSync(path.join(core, 'unrelated-core-note.txt'), 'outside the governed Core V2 app scope\n');
    trustedDeploymentVerificationFails = true;
    await service.captureRunStart('run-core-approve-reconcile', CORE_UI_PROJECT_ID, approvalPrompt);
    await expect(service.completeRun({
      runId: 'run-core-approve-reconcile',
      projectId: CORE_UI_PROJECT_ID,
      prompt: approvalPrompt,
      succeeded: true,
    })).rejects.toThrow('trusted deployment verification failed');
    expect(getDesignWorkflowDelivery(db, readyDelivery!.id)).toEqual(expect.objectContaining({
      status: 'approving',
      target: expect.objectContaining({
        reconciliationRequired: true,
        trustedBuildDigest,
      }),
    }));
    trustedDeploymentVerificationFails = false;
    driftCanonicalRemoteDuringDeployment = true;
    await service.captureRunStart('run-core-approve-remote-drift', CORE_UI_PROJECT_ID, approvalPrompt);
    await expect(service.completeRun({
      runId: 'run-core-approve-remote-drift',
      projectId: CORE_UI_PROJECT_ID,
      prompt: approvalPrompt,
      succeeded: true,
    })).rejects.toThrow('changed after trusted deployment verification');
    expect(getDesignWorkflowDelivery(db, readyDelivery!.id)).toEqual(expect.objectContaining({
      status: 'approving',
      target: expect.objectContaining({ reconciliationRequired: true }),
    }));
    driftCanonicalRemoteDuringDeployment = false;
    execFileSync('git', ['push', coreRemote, `${previewCommit}:refs/heads/master`], { cwd: core });
    await service.captureRunStart('run-core-approve', CORE_UI_PROJECT_ID, approvalPrompt);
    expect(getDesignWorkflowDelivery(db, readyDelivery!.id)?.status).toBe('approving');
    const futureNow = Date.now() + 60 * 60 * 1000 + 1;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(futureNow);
    try {
      expect(getDesignWorkflowDelivery(db, readyDelivery!.id)?.status).toBe('approving');
      await service.completeRun({
        runId: 'run-core-approve',
        projectId: CORE_UI_PROJECT_ID,
        prompt: approvalPrompt,
        succeeded: true,
      });
    } finally {
      nowSpy.mockRestore();
    }
    expect(getDesignWorkflowDelivery(db, readyDelivery!.id)).toEqual(expect.objectContaining({
      id: readyDelivery!.id,
      status: 'deployed',
      target: expect.objectContaining({
        deployedCommit: previewCommit,
        trustedBuildDigest,
        trustedDeploymentPids: { api: 3301, web: 3302 },
      }),
    }));
    expect(getDesignWorkflowDelivery(db, readyDelivery!.id)?.target.reconciliationRequired).toBeUndefined();
    expect(getDesignWorkflowDelivery(db, readyDelivery!.id)?.target.coreDeploymentIntent).toBeUndefined();
    expect(readFileSync(path.join(core, 'unrelated-core-note.txt'), 'utf8')).toContain('outside the governed');
  });
});
