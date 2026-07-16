import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type {
  DesignWorkflowRevision,
  DesignWorkflowRevisionClassification,
  DesignWorkflowStatusResponse,
  DesignWorkflowSubscription,
  DesignWorkflowSyncStatus,
  DesignWorkflowUpdateAllResponse,
  DesignWorkflowDelivery,
  DesignWorkflowDeliveryAdapter,
  DesignWorkflowDeliveryStatus,
} from '@open-design/contracts';
import {
  createAndPushProjectGitRevision,
  createProjectGitWorktree,
  deployProjectGitCanonicalRevision,
  listProjectGitFilesAtRevision,
  prepareProjectGitRevisionBase,
  projectGitRefMatchesRevision,
  publishProjectGitRevision,
  quarantineProjectGitRunState,
  readProjectGitCanonicalRemoteBranchRevision,
  readProjectGitCanonicalRemoteHead,
  readProjectGitFileAtRevision,
  readProjectGitStatus,
  verifyProjectGitLinearAttestation,
} from '../services/project-git.js';
import { listLiveArtifacts, readLiveArtifactCode, updateLiveArtifact } from '../live-artifacts/store.js';
import {
  verifyCoreUiCandidateWithTrustedCommand,
  verifyCoreUiDeploymentWithTrustedCommand,
} from './core-ui-verifier.js';
import {
  CORE_UI_PROJECT_ID,
  CORE_UI_PREVIEW_ROOT,
  CORE_UI_TARGET_ORIGIN,
  GRAND_SLAM_OFFER_PROJECT_ID,
  publishWordPressDelivery,
  stageCoreUiDelivery,
  stageWordPressDraftDelivery,
  verifyCoreUiDeploymentReceipt,
  verifyCoreUiPreviewReceipt,
  verifyCoreUiAttestationFiles,
  WordPressPublishOutcomeUnknownError,
  WordPressPublishReconciliationRequiredError,
} from './delivery-adapters.js';

type SqliteDb = Database.Database;
type DbRow = Record<string, unknown>;

const IGNORED_DIRS = new Set([
  '.git', '.next', '.cache', '.turbo', '.open-design', '.delivery', '.od-skills',
  '.impeccable', '.file-versions', '.live-artifacts', 'node_modules', 'dist', 'build',
]);
const MAX_FILES = 10_000;
const HASH_MAX_BYTES = 1024 * 1024;
const APPROVAL_LEASE_MS = 60 * 60 * 1000;
const DELIVERY_CHALLENGE_TTL_MS = 4 * 60 * 60 * 1000;
const CORE_UI_RECEIPT_ROOT = '99_System/core-v2/apps/web/static/open-design/attestations';
const DEFAULT_CORE_UI_GIT_REMOTE = 'git@github.com:lindforsjoel-pixel/Core.git';
const ACTIVE_DESIGN_WORKFLOW_APPROVAL_RUNS = new Set<string>();
const REQUIRED_TRUSTED_CORE_UI_CHECKS = new Set(['check', 'test', 'build', 'browser']);
const PROPAGATION_TEXT_EXTENSIONS = new Set([
  '.css', '.html', '.htm', '.json', '.js', '.jsx', '.md', '.mjs', '.scss', '.ts', '.tsx', '.txt', '.yaml', '.yml',
]);

export interface GovernedTokenUpdate {
  name: string;
  beforeValues: string[];
  afterValues: string[];
}

interface WorkflowFingerprint {
  size: number;
  mtimeMs: number;
  hash: string | null;
}

export type DesignWorkflowFileSnapshot = Map<string, WorkflowFingerprint>;

function validateCoreUiGitRemote(value: string): string {
  if (
    value.length === 0
    || value.length > 4096
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error('OD_CORE_UI_GIT_REMOTE_URL must be one exact nonempty Git remote URL.');
  }
  return value;
}

function configuredCoreUiGitRemote(): string {
  return validateCoreUiGitRemote(
    process.env.OD_CORE_UI_GIT_REMOTE_URL ?? DEFAULT_CORE_UI_GIT_REMOTE,
  );
}

function validateTrustedCoreUiCandidateEvidence(
  evidence: {
    attestationCommit: string;
    buildDigest: string;
    checks: Array<{ name: string; status: 'passed' }>;
    pid: number;
  },
  attestationCommit: string,
): void {
  const checks = Array.isArray(evidence.checks) ? evidence.checks : [];
  const names = checks.map((check) => check?.name);
  if (
    evidence.attestationCommit !== attestationCommit
    || !/^[a-f0-9]{64}$/.test(evidence.buildDigest)
    || !Number.isSafeInteger(evidence.pid)
    || evidence.pid <= 0
    || checks.length !== REQUIRED_TRUSTED_CORE_UI_CHECKS.size
    || checks.some((check) =>
      check?.status !== 'passed' || !REQUIRED_TRUSTED_CORE_UI_CHECKS.has(check.name))
    || new Set(names).size !== REQUIRED_TRUSTED_CORE_UI_CHECKS.size
  ) {
    throw new Error('Core UI trusted candidate verification returned invalid evidence.');
  }
}

function validateTrustedCoreUiDeploymentEvidence(
  evidence: {
    attestationCommit: string;
    buildDigest: string;
    pids: { api: number; web: number };
  },
  attestationCommit: string,
  buildDigest: string,
): void {
  if (
    evidence.attestationCommit !== attestationCommit
    || evidence.buildDigest !== buildDigest
    || !evidence.pids
    || !Number.isSafeInteger(evidence.pids?.api)
    || !Number.isSafeInteger(evidence.pids?.web)
    || evidence.pids.api <= 0
    || evidence.pids.web <= 0
  ) {
    throw new Error('Core UI trusted deployment verification returned invalid evidence.');
  }
}

export function migrateDesignWorkflow(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS design_workflow_revisions (
      id TEXT PRIMARY KEY,
      design_system_id TEXT NOT NULL,
      source_project_id TEXT NOT NULL,
      sha TEXT NOT NULL,
      branch TEXT,
      classification TEXT NOT NULL,
      changed_paths_json TEXT NOT NULL,
      run_id TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE(design_system_id, sha)
    );

    CREATE INDEX IF NOT EXISTS idx_design_workflow_revisions_system
      ON design_workflow_revisions(design_system_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS design_workflow_subscriptions (
      project_id TEXT PRIMARY KEY,
      design_system_id TEXT NOT NULL,
      source_project_id TEXT NOT NULL,
      status TEXT NOT NULL,
      target_sha TEXT NOT NULL,
      applied_sha TEXT NOT NULL,
      pinned_sha TEXT,
      deferred_target_sha TEXT,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_design_workflow_subscriptions_system
      ON design_workflow_subscriptions(design_system_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS design_workflow_deliveries (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      adapter TEXT NOT NULL,
      revision_sha TEXT NOT NULL,
      implementation_digest TEXT NOT NULL,
      status TEXT NOT NULL,
      preview_url TEXT,
      target_json TEXT NOT NULL,
      checkpoint_path TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_design_workflow_deliveries_project
      ON design_workflow_deliveries(project_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS design_workflow_source_run_captures (
      run_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL UNIQUE,
      root TEXT NOT NULL,
      base_sha TEXT NOT NULL,
      base_branch TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS design_workflow_delivery_challenges (
      challenge TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      run_id TEXT NOT NULL UNIQUE,
      design_revision_sha TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      base_commit TEXT NOT NULL,
      git_remote TEXT NOT NULL,
      target_origin TEXT NOT NULL,
      receipt_path TEXT NOT NULL,
      status TEXT NOT NULL,
      delivery_id TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_design_workflow_delivery_challenges_active_project
      ON design_workflow_delivery_challenges(project_id)
      WHERE status = 'issued';
  `);
  const subscriptionColumns = db.prepare('PRAGMA table_info(design_workflow_subscriptions)')
    .all() as Array<{ name?: unknown }>;
  if (!subscriptionColumns.some((column) => column.name === 'deferred_target_sha')) {
    db.exec('ALTER TABLE design_workflow_subscriptions ADD COLUMN deferred_target_sha TEXT');
  }
  const challengeColumns = db.prepare('PRAGMA table_info(design_workflow_delivery_challenges)')
    .all() as Array<{ name?: unknown }>;
  if (!challengeColumns.some((column) => column.name === 'git_remote')) {
    db.exec('ALTER TABLE design_workflow_delivery_challenges ADD COLUMN git_remote TEXT');
  }
}

function parsePaths(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function revisionFromRow(row: DbRow): DesignWorkflowRevision {
  const sha = String(row.sha);
  return {
    id: String(row.id),
    designSystemId: String(row.designSystemId),
    sourceProjectId: String(row.sourceProjectId),
    sha,
    shortSha: sha.slice(0, 8),
    branch: typeof row.branch === 'string' ? row.branch : null,
    classification: row.classification as DesignWorkflowRevisionClassification,
    changedPaths: parsePaths(row.changedPathsJson),
    runId: typeof row.runId === 'string' ? row.runId : null,
    createdAt: Number(row.createdAt),
  };
}

function subscriptionFromRow(row: DbRow): DesignWorkflowSubscription {
  return {
    projectId: String(row.projectId),
    designSystemId: String(row.designSystemId),
    sourceProjectId: String(row.sourceProjectId),
    status: row.status as DesignWorkflowSyncStatus,
    targetSha: String(row.targetSha),
    appliedSha: String(row.appliedSha),
    pinnedSha: typeof row.pinnedSha === 'string' ? row.pinnedSha : null,
    lastError: typeof row.lastError === 'string' ? row.lastError : null,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

const REVISION_SELECT = `
  id, design_system_id AS designSystemId, source_project_id AS sourceProjectId,
  sha, branch, classification, changed_paths_json AS changedPathsJson,
  run_id AS runId, created_at AS createdAt`;
const SUBSCRIPTION_SELECT = `
  project_id AS projectId, design_system_id AS designSystemId,
  source_project_id AS sourceProjectId, status, target_sha AS targetSha,
  applied_sha AS appliedSha, pinned_sha AS pinnedSha, last_error AS lastError,
  created_at AS createdAt, updated_at AS updatedAt`;
const DELIVERY_SELECT = `
  id, project_id AS projectId, adapter, revision_sha AS revisionSha,
  implementation_digest AS implementationDigest, status, preview_url AS previewUrl,
  target_json AS targetJson, checkpoint_path AS checkpointPath, error,
  created_at AS createdAt, updated_at AS updatedAt, expires_at AS expiresAt`;

function deliveryFromRow(row: DbRow): DesignWorkflowDelivery {
  let target: Record<string, unknown> = {};
  if (typeof row.targetJson === 'string') {
    try {
      const value = JSON.parse(row.targetJson) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) target = value as Record<string, unknown>;
    } catch {
      // A malformed historical target stays inspectable as an empty object.
    }
  }
  return {
    id: String(row.id),
    projectId: String(row.projectId),
    adapter: row.adapter as DesignWorkflowDeliveryAdapter,
    revisionSha: String(row.revisionSha),
    implementationDigest: String(row.implementationDigest),
    status: row.status as DesignWorkflowDeliveryStatus,
    previewUrl: typeof row.previewUrl === 'string' ? row.previewUrl : null,
    target,
    checkpointPath: typeof row.checkpointPath === 'string' ? row.checkpointPath : null,
    error: typeof row.error === 'string' ? row.error : null,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    expiresAt: Number(row.expiresAt),
  };
}

export function saveDesignWorkflowDelivery(
  db: SqliteDb,
  delivery: DesignWorkflowDelivery,
): DesignWorkflowDelivery {
  db.prepare(`
    INSERT INTO design_workflow_deliveries
      (id, project_id, adapter, revision_sha, implementation_digest, status,
       preview_url, target_json, checkpoint_path, error, created_at, updated_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status, preview_url = excluded.preview_url,
      target_json = excluded.target_json, checkpoint_path = excluded.checkpoint_path,
      error = excluded.error, updated_at = excluded.updated_at
  `).run(
    delivery.id, delivery.projectId, delivery.adapter, delivery.revisionSha,
    delivery.implementationDigest, delivery.status, delivery.previewUrl,
    JSON.stringify(delivery.target), delivery.checkpointPath, delivery.error,
    delivery.createdAt, delivery.updatedAt, delivery.expiresAt,
  );
  return getDesignWorkflowDelivery(db, delivery.id)!;
}

export function getDesignWorkflowDelivery(db: SqliteDb, id: string): DesignWorkflowDelivery | null {
  const row = db.prepare(`SELECT ${DELIVERY_SELECT} FROM design_workflow_deliveries WHERE id = ?`)
    .get(id) as DbRow | undefined;
  return row ? deliveryFromRow(row) : null;
}

export function latestDesignWorkflowDelivery(db: SqliteDb, projectId: string): DesignWorkflowDelivery | null {
  const row = db.prepare(`
    SELECT ${DELIVERY_SELECT}
    FROM design_workflow_deliveries
    WHERE project_id = ?
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `)
    .get(projectId) as DbRow | undefined;
  return row ? deliveryFromRow(row) : null;
}

interface DesignWorkflowSourceRunCapture {
  runId: string;
  projectId: string;
  root: string;
  baseSha: string;
  baseBranch: string | null;
  createdAt: number;
}

function sourceRunCaptureFromRow(row: DbRow): DesignWorkflowSourceRunCapture {
  return {
    runId: String(row.runId),
    projectId: String(row.projectId),
    root: String(row.root),
    baseSha: String(row.baseSha),
    baseBranch: typeof row.baseBranch === 'string' ? row.baseBranch : null,
    createdAt: Number(row.createdAt),
  };
}

function sourceRunCaptureForProject(
  db: SqliteDb,
  projectId: string,
): DesignWorkflowSourceRunCapture | null {
  const row = db.prepare(`
    SELECT run_id AS runId, project_id AS projectId, root, base_sha AS baseSha,
           base_branch AS baseBranch, created_at AS createdAt
    FROM design_workflow_source_run_captures
    WHERE project_id = ?
  `).get(projectId) as DbRow | undefined;
  return row ? sourceRunCaptureFromRow(row) : null;
}

function saveSourceRunCapture(
  db: SqliteDb,
  capture: DesignWorkflowSourceRunCapture,
): void {
  db.prepare(`
    INSERT INTO design_workflow_source_run_captures
      (run_id, project_id, root, base_sha, base_branch, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    capture.runId,
    capture.projectId,
    capture.root,
    capture.baseSha,
    capture.baseBranch,
    capture.createdAt,
  );
}

function deleteSourceRunCapture(
  db: SqliteDb,
  runId: string,
  projectId: string,
): boolean {
  return db.prepare(`
    DELETE FROM design_workflow_source_run_captures
    WHERE run_id = ? AND project_id = ?
  `).run(runId, projectId).changes === 1;
}

interface DesignWorkflowDeliveryChallenge {
  challenge: string;
  projectId: string;
  runId: string;
  designRevisionSha: string;
  baseBranch: string;
  baseCommit: string;
  gitRemote: string;
  targetOrigin: string;
  receiptPath: string;
  status: 'issued' | 'consumed' | 'failed' | 'expired';
  deliveryId: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

function deliveryChallengeFromRow(row: DbRow): DesignWorkflowDeliveryChallenge {
  return {
    challenge: String(row.challenge),
    projectId: String(row.projectId),
    runId: String(row.runId),
    designRevisionSha: String(row.designRevisionSha),
    baseBranch: String(row.baseBranch),
    baseCommit: String(row.baseCommit),
    gitRemote: String(row.gitRemote),
    targetOrigin: String(row.targetOrigin),
    receiptPath: String(row.receiptPath),
    status: row.status as DesignWorkflowDeliveryChallenge['status'],
    deliveryId: typeof row.deliveryId === 'string' ? row.deliveryId : null,
    error: typeof row.error === 'string' ? row.error : null,
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
    expiresAt: Number(row.expiresAt),
  };
}

const DELIVERY_CHALLENGE_SELECT = `
  challenge, project_id AS projectId, run_id AS runId,
  design_revision_sha AS designRevisionSha, base_branch AS baseBranch,
  base_commit AS baseCommit, git_remote AS gitRemote, target_origin AS targetOrigin,
  receipt_path AS receiptPath, status, delivery_id AS deliveryId,
  error, created_at AS createdAt, updated_at AS updatedAt,
  expires_at AS expiresAt`;

function deliveryChallengeForRun(
  db: SqliteDb,
  runId: string,
): DesignWorkflowDeliveryChallenge | null {
  const row = db.prepare(`
    SELECT ${DELIVERY_CHALLENGE_SELECT}
    FROM design_workflow_delivery_challenges
    WHERE run_id = ?
  `).get(runId) as DbRow | undefined;
  return row ? deliveryChallengeFromRow(row) : null;
}

function failDeliveryChallenge(
  db: SqliteDb,
  runId: string,
  error: string,
  now = Date.now(),
): void {
  db.prepare(`
    UPDATE design_workflow_delivery_challenges
    SET status = 'failed', error = ?, updated_at = ?
    WHERE run_id = ? AND status = 'issued'
  `).run(error, now, runId);
}

interface DesignWorkflowApprovalLease {
  runId: string;
  reservedAt: number;
  expiresAt: number;
}

interface WordPressPublishIntent {
  runId: string;
  createdAt: number;
  managedPageFingerprint: string;
}

function wordpressPublishIntent(
  delivery: DesignWorkflowDelivery,
): WordPressPublishIntent | null {
  const value = delivery.target.wordpressPublishIntent;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const intent = value as Record<string, unknown>;
  return typeof intent.runId === 'string'
    && typeof intent.createdAt === 'number'
    && typeof intent.managedPageFingerprint === 'string'
    ? {
        runId: intent.runId,
        createdAt: intent.createdAt,
        managedPageFingerprint: intent.managedPageFingerprint,
      }
    : null;
}

function approvalLease(delivery: DesignWorkflowDelivery): DesignWorkflowApprovalLease | null {
  const value = delivery.target.approvalLease;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const lease = value as Record<string, unknown>;
  return typeof lease.runId === 'string'
    && typeof lease.reservedAt === 'number'
    && typeof lease.expiresAt === 'number'
    ? { runId: lease.runId, reservedAt: lease.reservedAt, expiresAt: lease.expiresAt }
    : null;
}

function targetWithoutApprovalLease(target: Record<string, unknown>): Record<string, unknown> {
  const next = { ...target };
  delete next.approvalLease;
  return next;
}

function targetWithoutWordPressPublishIntent(
  target: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...target };
  delete next.wordpressPublishIntent;
  return next;
}

function deliveryRequiresReconciliation(delivery: DesignWorkflowDelivery): boolean {
  return delivery.target.reconciliationRequired === true
    || Boolean(wordpressPublishIntent(delivery));
}

function targetWithoutReconciliation(
  target: Record<string, unknown>,
): Record<string, unknown> {
  const next = targetWithoutWordPressPublishIntent(target);
  delete next.reconciliationRequired;
  delete next.coreDeploymentIntent;
  return next;
}

function approvalMatchesCurrentRevision(
  db: SqliteDb,
  delivery: DesignWorkflowDelivery,
): boolean {
  const subscription = getDesignWorkflowSubscription(db, delivery.projectId);
  return Boolean(
    subscription
    && subscription.appliedSha === delivery.revisionSha
    && subscription.targetSha === delivery.revisionSha
    && subscription.pinnedSha === null
    && (subscription.status === 'up_to_date' || subscription.status === 'updated_automatically'),
  );
}

function deferredDesignWorkflowTargetSha(
  db: SqliteDb,
  projectId: string,
): string | null {
  const row = db.prepare(`
    SELECT deferred_target_sha AS deferredTargetSha
    FROM design_workflow_subscriptions
    WHERE project_id = ?
  `).get(projectId) as { deferredTargetSha?: unknown } | undefined;
  return typeof row?.deferredTargetSha === 'string' ? row.deferredTargetSha : null;
}

function approvingDesignWorkflowDeliveries(
  db: SqliteDb,
  projectId: string,
): DesignWorkflowDelivery[] {
  return (db.prepare(`
    SELECT ${DELIVERY_SELECT}
    FROM design_workflow_deliveries
    WHERE project_id = ? AND status = 'approving'
    ORDER BY created_at DESC, rowid DESC
  `).all(projectId) as DbRow[]).map(deliveryFromRow);
}

interface DesignWorkflowApprovalReapResult {
  active: boolean;
  changed: boolean;
  deferredApplied: boolean;
}

function reapExpiredDesignWorkflowApprovalsUnlocked(
  db: SqliteDb,
  projectId: string,
  now: number,
): DesignWorkflowApprovalReapResult {
  let changed = false;
  const deferredBefore = deferredDesignWorkflowTargetSha(db, projectId);
  for (const delivery of approvingDesignWorkflowDeliveries(db, projectId)) {
    const lease = approvalLease(delivery);
    if (lease && ACTIVE_DESIGN_WORKFLOW_APPROVAL_RUNS.has(lease.runId)) continue;
    if (lease && lease.expiresAt > now) continue;
    if (deliveryRequiresReconciliation(delivery)) {
      continue;
    }
    const latest = latestDesignWorkflowDelivery(db, projectId);
    const retryable = Boolean(
      lease
      && latest?.id === delivery.id
      && approvalMatchesCurrentRevision(db, delivery)
      && delivery.expiresAt >= now
      && deferredBefore === null,
    );
    const result = db.prepare(`
      UPDATE design_workflow_deliveries
      SET status = ?, target_json = ?, error = ?, updated_at = ?
      WHERE id = ? AND status = 'approving' AND target_json = ?
    `).run(
      retryable ? 'ready_for_approval' : 'failed',
      JSON.stringify(
        retryable
          ? targetWithoutApprovalLease(delivery.target)
          : targetWithoutReconciliation(targetWithoutApprovalLease(delivery.target)),
      ),
      retryable ? null : 'Approval lease expired before deployment verification completed.',
      now,
      delivery.id,
      JSON.stringify(delivery.target),
    );
    changed = changed || result.changes === 1;
  }
  const active = approvingDesignWorkflowDeliveries(db, projectId).length > 0;
  if (!active) applyDeferredDesignWorkflowTargetUnlocked(db, projectId, now);
  return {
    active,
    changed,
    deferredApplied: deferredBefore !== null && deferredDesignWorkflowTargetSha(db, projectId) === null,
  };
}

export function reapExpiredDesignWorkflowApprovals(
  db: SqliteDb,
  projectId: string,
  now = Date.now(),
): DesignWorkflowApprovalReapResult {
  return db.transaction(() =>
    reapExpiredDesignWorkflowApprovalsUnlocked(db, projectId, now))();
}

export function reserveDesignWorkflowDeliveryApproval(
  db: SqliteDb,
  projectId: string,
  deliveryId: string,
  implementationDigest: string,
  runId: string,
  now = Date.now(),
): DesignWorkflowDelivery {
  reapExpiredDesignWorkflowApprovals(db, projectId, now);
  return db.transaction(() => {
    const delivery = getDesignWorkflowDelivery(db, deliveryId);
    if (!delivery || delivery.projectId !== projectId) throw new Error('Delivery preview not found.');
    const latest = latestDesignWorkflowDelivery(db, projectId);
    if (latest?.id !== delivery.id) {
      throw new Error('Only the latest delivery preview can be approved.');
    }
    if (delivery.implementationDigest !== implementationDigest) {
      throw new Error('Approval digest does not match the previewed implementation.');
    }
    if (
      delivery.expiresAt < now
      && !deliveryRequiresReconciliation(delivery)
    ) {
      throw new Error('Delivery approval expired; run /push again.');
    }
    const existingLease = approvalLease(delivery);
    if (
      delivery.status !== 'ready_for_approval'
      && !(delivery.status === 'approving' && existingLease && existingLease.expiresAt <= now)
    ) {
      throw new Error(
        delivery.status === 'approving'
          ? 'Delivery approval is already in progress.'
          : 'Only a ready preview can be approved.',
      );
    }
    if (!approvalMatchesCurrentRevision(db, delivery)) {
      throw new Error('Delivery approval no longer matches the current applied design-system revision.');
    }
    if (
      deferredDesignWorkflowTargetSha(db, projectId) !== null
      && !deliveryRequiresReconciliation(delivery)
    ) {
      throw new Error('A newer design-system target is pending; reconcile it before approving this delivery.');
    }
    const lease: DesignWorkflowApprovalLease = {
      runId,
      reservedAt: now,
      expiresAt: now + APPROVAL_LEASE_MS,
    };
    const targetWithoutLease = targetWithoutApprovalLease(delivery.target);
    const existingCoreIntent = targetWithoutLease.coreDeploymentIntent;
    const coreDeploymentIntent = existingCoreIntent
      && typeof existingCoreIntent === 'object'
      && !Array.isArray(existingCoreIntent)
      && typeof (existingCoreIntent as Record<string, unknown>).createdAt === 'number'
      && (existingCoreIntent as Record<string, unknown>).attestationCommit
        === targetWithoutLease.attestationCommit
      ? existingCoreIntent
      : {
          createdAt: now,
          attestationCommit: targetWithoutLease.attestationCommit,
        };
    const reservedTarget = delivery.adapter === 'core-ui'
      && delivery.projectId === CORE_UI_PROJECT_ID
      ? {
          ...targetWithoutLease,
          reconciliationRequired: true,
          coreDeploymentIntent,
          approvalLease: lease,
        }
      : { ...targetWithoutLease, approvalLease: lease };
    const reserved = db.prepare(`
      UPDATE design_workflow_deliveries
      SET status = 'approving', target_json = ?, error = NULL, updated_at = ?
      WHERE id = ? AND status = ?
        AND implementation_digest = ? AND revision_sha = ?
        AND target_json = ? AND updated_at = ?
    `).run(
      JSON.stringify(reservedTarget),
      now,
      delivery.id,
      delivery.status,
      delivery.implementationDigest,
      delivery.revisionSha,
      JSON.stringify(delivery.target),
      delivery.updatedAt,
    );
    if (reserved.changes !== 1) throw new Error('Delivery approval state changed; run /push again.');
    return getDesignWorkflowDelivery(db, delivery.id)!;
  })();
}

export function releaseDesignWorkflowDeliveryApproval(
  db: SqliteDb,
  deliveryId: string,
  runId: string,
  error: string | null,
  allowRetry = true,
  now = Date.now(),
): DesignWorkflowDelivery | null {
  return db.transaction(() => {
    const delivery = getDesignWorkflowDelivery(db, deliveryId);
    const lease = delivery ? approvalLease(delivery) : null;
    if (!delivery || delivery.status !== 'approving' || lease?.runId !== runId) return null;
    if (deliveryRequiresReconciliation(delivery)) return null;
    const latest = latestDesignWorkflowDelivery(db, delivery.projectId);
    const retryable = allowRetry
      && latest?.id === delivery.id
      && approvalMatchesCurrentRevision(db, delivery)
      && delivery.expiresAt >= now
      && deferredDesignWorkflowTargetSha(db, delivery.projectId) === null;
    const result = db.prepare(`
      UPDATE design_workflow_deliveries
      SET status = ?, target_json = ?, error = ?, updated_at = ?
      WHERE id = ? AND status = 'approving' AND target_json = ?
    `).run(
      retryable ? 'ready_for_approval' : 'failed',
      JSON.stringify(targetWithoutApprovalLease(delivery.target)),
      retryable ? null : error ?? 'Approval run ended before deployment verification completed.',
      now,
      delivery.id,
      JSON.stringify(delivery.target),
    );
    if (result.changes !== 1) return null;
    if (approvingDesignWorkflowDeliveries(db, delivery.projectId).length === 0) {
      applyDeferredDesignWorkflowTargetUnlocked(db, delivery.projectId, now);
    }
    return getDesignWorkflowDelivery(db, delivery.id);
  })();
}

export function renewDesignWorkflowDeliveryApproval(
  db: SqliteDb,
  deliveryId: string,
  runId: string,
  now = Date.now(),
): DesignWorkflowDelivery {
  return db.transaction(() => {
    const delivery = getDesignWorkflowDelivery(db, deliveryId);
    const lease = delivery ? approvalLease(delivery) : null;
    if (!delivery || delivery.status !== 'approving' || lease?.runId !== runId) {
      throw new Error('Delivery approval reservation is missing or belongs to another run.');
    }
    const renewedTarget = {
      ...targetWithoutApprovalLease(delivery.target),
      approvalLease: {
        ...lease,
        expiresAt: now + APPROVAL_LEASE_MS,
      },
    };
    const result = db.prepare(`
      UPDATE design_workflow_deliveries
      SET target_json = ?, updated_at = ?
      WHERE id = ? AND status = 'approving' AND target_json = ?
    `).run(
      JSON.stringify(renewedTarget),
      now,
      delivery.id,
      JSON.stringify(delivery.target),
    );
    if (result.changes !== 1) {
      throw new Error('Delivery approval reservation changed before it could be renewed.');
    }
    return getDesignWorkflowDelivery(db, delivery.id)!;
  })();
}

export function recordWordPressPublishIntent(
  db: SqliteDb,
  deliveryId: string,
  runId: string,
  now = Date.now(),
): DesignWorkflowDelivery {
  return db.transaction(() => {
    const delivery = getDesignWorkflowDelivery(db, deliveryId);
    const lease = delivery ? approvalLease(delivery) : null;
    if (
      !delivery
      || delivery.adapter !== 'wordpress-draft'
      || delivery.status !== 'approving'
      || lease?.runId !== runId
    ) {
      throw new Error('WordPress publish intent requires the active approval reservation.');
    }
    const managedPageFingerprint = typeof delivery.target.wordpressManagedPageFingerprint === 'string'
      ? delivery.target.wordpressManagedPageFingerprint
      : '';
    if (!/^[a-f0-9]{64}$/i.test(managedPageFingerprint)) {
      throw new Error('WordPress delivery is missing its managed-page fingerprint.');
    }
    const existing = wordpressPublishIntent(delivery);
    if (existing?.managedPageFingerprint !== undefined
      && existing.managedPageFingerprint !== managedPageFingerprint) {
      throw new Error('WordPress delivery publish intent no longer matches its managed-page fingerprint.');
    }
    if (existing?.runId === runId) {
      return delivery;
    }
    const target = {
      ...delivery.target,
      wordpressPublishIntent: {
        runId,
        createdAt: existing?.createdAt ?? delivery.createdAt,
        managedPageFingerprint,
      },
    };
    const result = db.prepare(`
      UPDATE design_workflow_deliveries
      SET target_json = ?, updated_at = ?
      WHERE id = ? AND status = 'approving' AND target_json = ?
    `).run(
      JSON.stringify(target),
      now,
      delivery.id,
      JSON.stringify(delivery.target),
    );
    if (result.changes !== 1) {
      throw new Error('WordPress delivery changed before its publish intent could be recorded.');
    }
    return getDesignWorkflowDelivery(db, delivery.id)!;
  })();
}

function parkDesignWorkflowDeliveryReconciliation(
  db: SqliteDb,
  deliveryId: string,
  runId: string,
  error: string,
  now = Date.now(),
): DesignWorkflowDelivery | null {
  return db.transaction(() => {
    const delivery = getDesignWorkflowDelivery(db, deliveryId);
    const lease = delivery ? approvalLease(delivery) : null;
    if (
      !delivery
      || delivery.status !== 'approving'
      || lease?.runId !== runId
    ) return null;
    const target = {
      ...targetWithoutApprovalLease(delivery.target),
      reconciliationRequired: true,
      approvalLease: {
        ...lease,
        expiresAt: now - 1,
      },
    };
    const result = db.prepare(`
      UPDATE design_workflow_deliveries
      SET target_json = ?, error = ?, updated_at = ?
      WHERE id = ? AND status = 'approving' AND target_json = ?
    `).run(
      JSON.stringify(target),
      error,
      now,
      delivery.id,
      JSON.stringify(delivery.target),
    );
    return result.changes === 1 ? getDesignWorkflowDelivery(db, delivery.id) : null;
  })();
}

export function finalizeDesignWorkflowDeliveryApproval(
  db: SqliteDb,
  delivery: DesignWorkflowDelivery,
  runId: string,
  now = Date.now(),
): DesignWorkflowDelivery {
  return db.transaction(() => {
    const current = getDesignWorkflowDelivery(db, delivery.id);
    const lease = current ? approvalLease(current) : null;
    if (
      !current
      || current.status !== 'approving'
      || lease?.runId !== runId
      || lease.expiresAt <= now
      || current.implementationDigest !== delivery.implementationDigest
      || current.revisionSha !== delivery.revisionSha
      || latestDesignWorkflowDelivery(db, current.projectId)?.id !== current.id
      || !approvalMatchesCurrentRevision(db, current)
    ) {
      throw new Error('Delivery approval reservation is no longer current.');
    }
    const result = db.prepare(`
      UPDATE design_workflow_deliveries
      SET status = 'deployed', preview_url = ?, target_json = ?,
          checkpoint_path = ?, error = NULL, updated_at = ?
      WHERE id = ? AND status = 'approving'
        AND implementation_digest = ? AND revision_sha = ?
        AND target_json = ?
    `).run(
      delivery.previewUrl,
      JSON.stringify(targetWithoutReconciliation(targetWithoutApprovalLease(delivery.target))),
      delivery.checkpointPath,
      now,
      delivery.id,
      delivery.implementationDigest,
      delivery.revisionSha,
      JSON.stringify(current.target),
    );
    if (result.changes !== 1) throw new Error('Delivery approval reservation changed before finalization.');
    if (approvingDesignWorkflowDeliveries(db, delivery.projectId).length === 0) {
      applyDeferredDesignWorkflowTargetUnlocked(db, delivery.projectId, now);
    }
    return getDesignWorkflowDelivery(db, delivery.id)!;
  })();
}

export function createDesignWorkflowRevision(
  db: SqliteDb,
  input: Omit<DesignWorkflowRevision, 'id' | 'shortSha'>,
): DesignWorkflowRevision {
  const id = `${input.designSystemId}:${input.sha}`;
  db.prepare(`
    INSERT INTO design_workflow_revisions
      (id, design_system_id, source_project_id, sha, branch, classification,
       changed_paths_json, run_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(design_system_id, sha) DO UPDATE SET
      branch = excluded.branch,
      classification = excluded.classification,
      changed_paths_json = excluded.changed_paths_json,
      run_id = COALESCE(excluded.run_id, design_workflow_revisions.run_id)
  `).run(
    id, input.designSystemId, input.sourceProjectId, input.sha, input.branch,
    input.classification, JSON.stringify(input.changedPaths), input.runId, input.createdAt,
  );
  return getDesignWorkflowRevision(db, input.designSystemId, input.sha)!;
}

export function getDesignWorkflowRevision(
  db: SqliteDb,
  designSystemId: string,
  sha: string,
): DesignWorkflowRevision | null {
  const row = db.prepare(`SELECT ${REVISION_SELECT} FROM design_workflow_revisions WHERE design_system_id = ? AND sha = ?`)
    .get(designSystemId, sha) as DbRow | undefined;
  return row ? revisionFromRow(row) : null;
}

export function latestDesignWorkflowRevision(db: SqliteDb, designSystemId: string): DesignWorkflowRevision | null {
  const row = db.prepare(`SELECT ${REVISION_SELECT} FROM design_workflow_revisions WHERE design_system_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(designSystemId) as DbRow | undefined;
  return row ? revisionFromRow(row) : null;
}

function designWorkflowRevisionForRun(
  db: SqliteDb,
  runId: string,
): DesignWorkflowRevision | null {
  const row = db.prepare(`
    SELECT ${REVISION_SELECT}
    FROM design_workflow_revisions
    WHERE run_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(runId) as DbRow | undefined;
  return row ? revisionFromRow(row) : null;
}

function previousDesignWorkflowRevision(
  db: SqliteDb,
  revision: DesignWorkflowRevision,
): DesignWorkflowRevision | null {
  const row = db.prepare(`
    SELECT ${REVISION_SELECT}
    FROM design_workflow_revisions
    WHERE design_system_id = ? AND sha <> ?
      AND (created_at < ? OR (created_at = ? AND rowid < (
        SELECT rowid
        FROM design_workflow_revisions
        WHERE design_system_id = ? AND sha = ?
      )))
    ORDER BY created_at DESC, rowid DESC
    LIMIT 1
  `).get(
    revision.designSystemId,
    revision.sha,
    revision.createdAt,
    revision.createdAt,
    revision.designSystemId,
    revision.sha,
  ) as DbRow | undefined;
  return row ? revisionFromRow(row) : null;
}

export function getDesignWorkflowSubscription(db: SqliteDb, projectId: string): DesignWorkflowSubscription | null {
  const row = db.prepare(`SELECT ${SUBSCRIPTION_SELECT} FROM design_workflow_subscriptions WHERE project_id = ?`)
    .get(projectId) as DbRow | undefined;
  return row ? subscriptionFromRow(row) : null;
}

export function listDesignWorkflowSubscriptions(db: SqliteDb, designSystemId: string): DesignWorkflowSubscription[] {
  return (db.prepare(`SELECT ${SUBSCRIPTION_SELECT} FROM design_workflow_subscriptions WHERE design_system_id = ? ORDER BY project_id`)
    .all(designSystemId) as DbRow[]).map(subscriptionFromRow);
}

export function initializeDesignWorkflowSubscription(
  db: SqliteDb,
  projectId: string,
  revision: DesignWorkflowRevision,
  now = Date.now(),
): DesignWorkflowSubscription {
  const initialStatus: DesignWorkflowSyncStatus = revision.classification === 'structural'
    ? 'update_needed'
    : 'up_to_date';
  db.prepare(`
    INSERT INTO design_workflow_subscriptions
      (project_id, design_system_id, source_project_id, status, target_sha,
       applied_sha, pinned_sha, last_error, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET
      deferred_target_sha = CASE
        WHEN design_workflow_subscriptions.design_system_id <> excluded.design_system_id THEN NULL
        ELSE design_workflow_subscriptions.deferred_target_sha
      END,
      design_system_id = excluded.design_system_id,
      source_project_id = excluded.source_project_id,
      updated_at = excluded.updated_at
  `).run(
    projectId, revision.designSystemId, revision.sourceProjectId, initialStatus,
    revision.sha, revision.sha, now, now,
  );
  return getDesignWorkflowSubscription(db, projectId)!;
}

export function fanOutDesignWorkflowRevision(
  db: SqliteDb,
  revision: DesignWorkflowRevision,
  projectIds: string[],
  now = Date.now(),
): DesignWorkflowSubscription[] {
  const apply = db.transaction(() => {
    for (const projectId of [...new Set(projectIds)].filter((id) => id !== revision.sourceProjectId)) {
      getDesignWorkflowSubscription(db, projectId)
        ?? initializeDesignWorkflowSubscription(db, projectId, revision, now);
      reapExpiredDesignWorkflowApprovalsUnlocked(db, projectId, now);
      if (approvingDesignWorkflowDeliveries(db, projectId).length > 0) {
        db.prepare(`
          UPDATE design_workflow_subscriptions
          SET deferred_target_sha = ?, updated_at = ?
          WHERE project_id = ?
        `).run(revision.sha, now, projectId);
        continue;
      }
      const existing = getDesignWorkflowSubscription(db, projectId)!;
      if (existing.pinnedSha) {
        db.prepare(`UPDATE design_workflow_subscriptions SET target_sha = ?, deferred_target_sha = NULL, status = 'pinned', updated_at = ? WHERE project_id = ?`)
          .run(revision.sha, now, projectId);
      } else if (revision.classification === 'compatible') {
        db.prepare(`UPDATE design_workflow_subscriptions SET target_sha = ?, applied_sha = ?, deferred_target_sha = NULL, status = 'updated_automatically', last_error = NULL, updated_at = ? WHERE project_id = ?`)
          .run(revision.sha, revision.sha, now, projectId);
      } else {
        db.prepare(`UPDATE design_workflow_subscriptions SET target_sha = ?, deferred_target_sha = NULL, status = 'update_needed', last_error = NULL, updated_at = ? WHERE project_id = ?`)
          .run(revision.sha, now, projectId);
      }
    }
  });
  apply();
  return listDesignWorkflowSubscriptions(db, revision.designSystemId);
}

function applyDeferredDesignWorkflowTargetUnlocked(
  db: SqliteDb,
  projectId: string,
  now: number,
): DesignWorkflowSubscription | null {
  const deferredSha = deferredDesignWorkflowTargetSha(db, projectId);
  if (!deferredSha) return getDesignWorkflowSubscription(db, projectId);
  const subscription = getDesignWorkflowSubscription(db, projectId);
  if (!subscription) return null;
  const revision = getDesignWorkflowRevision(db, subscription.designSystemId, deferredSha);
  if (!revision) throw new Error(`Deferred design-system revision ${deferredSha} is unavailable.`);
  const status: DesignWorkflowSyncStatus = subscription.pinnedSha ? 'pinned' : 'update_needed';
  db.prepare(`
    UPDATE design_workflow_subscriptions
    SET target_sha = ?, status = ?, deferred_target_sha = NULL,
        last_error = NULL, updated_at = ?
    WHERE project_id = ?
  `).run(revision.sha, status, now, projectId);
  return getDesignWorkflowSubscription(db, projectId);
}

export function applyDeferredDesignWorkflowTarget(
  db: SqliteDb,
  projectId: string,
  now = Date.now(),
): DesignWorkflowSubscription | null {
  return db.transaction(() => {
    const reaped = reapExpiredDesignWorkflowApprovalsUnlocked(db, projectId, now);
    if (reaped.active) return getDesignWorkflowSubscription(db, projectId);
    return applyDeferredDesignWorkflowTargetUnlocked(db, projectId, now);
  })();
}

export function applyDesignWorkflowSubscription(
  db: SqliteDb,
  projectId: string,
  expectedTargetSha: string,
  now = Date.now(),
): DesignWorkflowSubscription | null {
  const result = db.prepare(`
    UPDATE design_workflow_subscriptions
    SET applied_sha = ?, pinned_sha = NULL, deferred_target_sha = NULL,
        status = 'up_to_date', last_error = NULL, updated_at = ?
    WHERE project_id = ? AND target_sha = ? AND pinned_sha IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM design_workflow_deliveries
        WHERE project_id = ? AND status = 'approving'
      )
  `).run(expectedTargetSha, now, projectId, expectedTargetSha, projectId);
  if (result.changes !== 1) return null;
  return getDesignWorkflowSubscription(db, projectId);
}

export function failDesignWorkflowSubscription(
  db: SqliteDb,
  projectId: string,
  expectedTargetSha: string,
  error: string,
  appliedSha?: string,
  now = Date.now(),
): DesignWorkflowSubscription | null {
  const result = db.prepare(`
    UPDATE design_workflow_subscriptions
    SET status = 'sync_failed', last_error = ?,
        applied_sha = COALESCE(?, applied_sha), updated_at = ?
    WHERE project_id = ? AND target_sha = ? AND pinned_sha IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM design_workflow_deliveries
        WHERE project_id = ? AND status = 'approving'
      )
  `).run(error, appliedSha ?? null, now, projectId, expectedTargetSha, projectId);
  if (result.changes !== 1) return null;
  return getDesignWorkflowSubscription(db, projectId);
}

export function rollbackDesignWorkflowSubscription(
  db: SqliteDb,
  projectId: string,
  sha: string,
  now = Date.now(),
): DesignWorkflowSubscription | null {
  const subscription = getDesignWorkflowSubscription(db, projectId);
  if (!subscription || !getDesignWorkflowRevision(db, subscription.designSystemId, sha)) return null;
  const result = db.prepare(`
    UPDATE design_workflow_subscriptions
    SET applied_sha = ?, pinned_sha = ?, deferred_target_sha = NULL,
        status = 'pinned', last_error = NULL, updated_at = ?
    WHERE project_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM design_workflow_deliveries
        WHERE project_id = ? AND status = 'approving'
      )
  `).run(sha, sha, now, projectId, projectId);
  if (result.changes !== 1) return null;
  return getDesignWorkflowSubscription(db, projectId);
}

export function resumeDesignWorkflowSubscription(
  db: SqliteDb,
  projectId: string,
  revision: DesignWorkflowRevision,
  now = Date.now(),
): DesignWorkflowSubscription | null {
  const status: DesignWorkflowSyncStatus = revision.classification === 'compatible'
    ? 'updated_automatically'
    : 'update_needed';
  const appliedSha = revision.classification === 'compatible' ? revision.sha : undefined;
  const result = db.prepare(`
    UPDATE design_workflow_subscriptions
    SET pinned_sha = NULL, target_sha = ?, applied_sha = COALESCE(?, applied_sha),
        deferred_target_sha = NULL, status = ?, last_error = NULL, updated_at = ?
    WHERE project_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM design_workflow_deliveries
        WHERE project_id = ? AND status = 'approving'
      )
  `).run(revision.sha, appliedSha ?? null, status, now, projectId, projectId);
  if (result.changes !== 1) return null;
  return getDesignWorkflowSubscription(db, projectId);
}

export function snapshotDesignWorkflowFiles(root: string): DesignWorkflowFileSnapshot {
  const snapshot: DesignWorkflowFileSnapshot = new Map();
  const walk = (dir: string): void => {
    if (snapshot.size >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (snapshot.size >= MAX_FILES) return;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const fullPath = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        snapshot.set(path.relative(root, fullPath).replace(/\\/g, '/'), {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          hash: stat.size <= HASH_MAX_BYTES
            ? createHash('sha1').update(fs.readFileSync(fullPath)).digest('hex')
            : null,
        });
      } catch {
        // Files can disappear while the run is starting; the snapshot is best-effort.
      }
    }
  };
  walk(root);
  return snapshot;
}

export function touchedDesignWorkflowPaths(
  before: DesignWorkflowFileSnapshot,
  after: DesignWorkflowFileSnapshot,
): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((filePath) => {
    const left = before.get(filePath);
    const right = after.get(filePath);
    return !left || !right
      || left.size !== right.size
      || left.mtimeMs !== right.mtimeMs
      || left.hash !== right.hash;
  }).sort();
}

const COMPATIBLE_FILE_NAMES = new Set([
  'tokens.css', 'colors_and_type.css', 'brand.json', 'tokens.json',
]);

export function classifyDesignWorkflowChanges(
  paths: string[],
  deletedPaths: ReadonlySet<string> = new Set(),
): DesignWorkflowRevisionClassification {
  if (paths.length === 0 || paths.some((filePath) => deletedPaths.has(filePath))) return 'structural';
  return paths.every((filePath) => {
    const normalized = filePath.replace(/\\/g, '/');
    const base = path.posix.basename(normalized);
    return normalized.startsWith('assets/')
      || normalized.startsWith('fonts/')
      || normalized.startsWith('system/tokens')
      || COMPATIBLE_FILE_NAMES.has(base);
  }) ? 'compatible' : 'structural';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseGovernedCssTokens(content: string): Map<string, string[]> {
  const tokens = new Map<string, string[]>();
  for (const match of content.matchAll(/--([a-zA-Z0-9_-]+)\s*:\s*([^;{}]+);/g)) {
    const name = match[1];
    const value = match[2]?.trim();
    if (!name || !value) continue;
    const values = tokens.get(name) ?? [];
    values.push(value);
    tokens.set(name, values);
  }
  return tokens;
}

function mergeGovernedTokenMaps(
  target: Map<string, string[]>,
  source: Map<string, string[]>,
): void {
  for (const [name, values] of source) {
    const combined = target.get(name) ?? [];
    for (const value of values) {
      if (!combined.includes(value)) combined.push(value);
    }
    target.set(name, combined);
  }
}

function governedTokenUpdatesFromMaps(
  before: Map<string, string[]>,
  after: Map<string, string[]>,
): GovernedTokenUpdate[] {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].flatMap((name) => {
    const beforeValues = before.get(name) ?? [];
    const afterValues = after.get(name) ?? [];
    return JSON.stringify(beforeValues) === JSON.stringify(afterValues)
      ? []
      : [{ name, beforeValues, afterValues }];
  });
}

function isGovernedCssTokenPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const base = path.posix.basename(normalized);
  return base === 'tokens.css'
    || base === 'colors_and_type.css'
    || normalized.startsWith('system/tokens') && path.posix.extname(normalized) === '.css';
}

export function governedTokenUpdates(beforeCss: string, afterCss: string): GovernedTokenUpdate[] {
  return governedTokenUpdatesFromMaps(
    parseGovernedCssTokens(beforeCss),
    parseGovernedCssTokens(afterCss),
  );
}

export function governedTokenSurfaceMismatch(
  surfaces: Array<{ path: string; content: string }>,
  governedTokens: GovernedTokenUpdate[],
  label: string,
): string | null {
  let declarationCount = 0;
  const requiredTokens = governedTokens.filter((token) => token.afterValues.length > 0);
  // Subscribers may intentionally consume only a subset; the materialized snapshot carries
  // the complete canonical token set while this gate rejects stale values and removals.
  for (const surface of surfaces) {
    const declared = parseGovernedCssTokens(surface.content);
    for (const token of governedTokens) {
      const values = declared.get(token.name) ?? [];
      if (token.afterValues.length === 0 && values.length > 0) {
        return `${label} ${surface.path} still declares removed governed token --${token.name}`;
      }
      if (token.afterValues.length > 0) declarationCount += values.length;
      const invalid = values.find((value) => !token.afterValues.includes(value));
      if (invalid) {
        return `${label} ${surface.path} declares --${token.name}: ${invalid}, which does not match the target revision`;
      }
    }
  }
  return requiredTokens.length === 0 || declarationCount > 0
    ? null
    : `${label} does not expose any governed token declarations for verification`;
}

function canonicalTokenValue(update: GovernedTokenUpdate): string {
  return update.afterValues.at(-1) ?? '';
}

export function rewriteGovernedTokens(
  content: string,
  updates: GovernedTokenUpdate[],
): { content: string; replacements: number } {
  let rewritten = content;
  let replacements = 0;
  for (const update of [...updates].sort((left, right) => right.name.length - left.name.length)) {
    const escaped = escapeRegExp(update.name);
    const declarationPattern = new RegExp(`(--${escaped}\\s*:\\s*)([^;{}]+)(;)`, 'g');
    const declarationCount = [...rewritten.matchAll(declarationPattern)].length;
    let declarationIndex = 0;
    rewritten = rewritten.replace(
      declarationPattern,
      (_match, prefix: string, current: string, suffix: string) => {
        if (update.afterValues.length === 0) {
          replacements += 1;
          return '';
        }
        const next = declarationCount === update.afterValues.length
          ? update.afterValues[Math.min(declarationIndex, update.afterValues.length - 1)]!
          : canonicalTokenValue(update);
        declarationIndex += 1;
        if (current.trim() === next) return `${prefix}${current}${suffix}`;
        replacements += 1;
        return `${prefix}${next}${suffix}`;
      },
    );
  }
  return { content: rewritten, replacements };
}

function normalizeTokenOnlyText(content: string, updates: GovernedTokenUpdate[]): string {
  let normalized = content;
  const literals = [...new Set(updates.flatMap((update) => [...update.beforeValues, ...update.afterValues]))]
    .sort((left, right) => right.length - left.length);
  for (const literal of literals) normalized = normalized.replaceAll(literal, '<token-value>');
  return normalized
    .replace(/oklch\([^\n)]+\)|#[0-9a-fA-F]{3,8}|\b\d+(?:\.\d+)?%\s+\d+(?:\.\d+)?\s+\d+(?:\.\d+)?\b/g, '<color>')
    .replace(/(?:(?:["']?(?:<color>|<token-value>)["']?)\s*,?\s*)+/g, '<colors>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isGovernedTokenOnlyTextChange(
  before: string,
  after: string,
  updates: GovernedTokenUpdate[],
): boolean {
  const referencesGovernedToken = updates.some(({ name }) => {
    const reference = new RegExp(`(?:--)?${escapeRegExp(name)}(?![a-zA-Z0-9_-])`, 'i');
    return reference.test(before) || reference.test(after);
  });
  return updates.length > 0
    && referencesGovernedToken
    && normalizeTokenOnlyText(before, updates) === normalizeTokenOnlyText(after, updates);
}

interface WorkflowProject {
  id: string;
  name: string;
  designSystemId?: string | null;
  metadata?: Record<string, unknown> | null;
  pendingPrompt?: string | null;
  updatedAt?: number;
}

interface DesignWorkflowServiceDeps {
  db: SqliteDb;
  projectsRoot: string;
  runtimeDataDir: string;
  getProject: (db: SqliteDb, id: string) => WorkflowProject | null;
  listProjects: (db: SqliteDb) => WorkflowProject[];
  updateProject: (
    db: SqliteDb,
    id: string,
    patch: { metadata?: Record<string, unknown>; pendingPrompt?: string | null; updatedAt?: number },
  ) => WorkflowProject | null;
  resolveProjectDir: (
    projectsRoot: string,
    projectId: string,
    metadata?: Record<string, unknown> | null,
    options?: { allowUnavailableSandboxImportedProject?: boolean },
  ) => string;
  queueSubscriberUpdate?: (projectId: string) => void;
  coreUiGitRemote?: string;
  validateSubscriberImplementation?: (input: {
    projectId: string;
    projectRoot: string;
    sourceRoot: string;
    revision: DesignWorkflowRevision;
  }) => Promise<string | null>;
  verifyCoreUiCandidate?: (input: {
    repositoryRoot: string;
    attestationCommit: string;
    challenge: string;
    receiptPath: string;
  }) => Promise<{
    attestationCommit: string;
    buildDigest: string;
    checks: Array<{ name: string; status: 'passed' }>;
    pid: number;
  }>;
  verifyCoreUiDeploymentEvidence?: (input: {
    repositoryRoot: string;
    attestationCommit: string;
    buildDigest: string;
  }) => Promise<{
    attestationCommit: string;
    buildDigest: string;
    pids: { api: number; web: number };
  }>;
  verifyCoreUiPreview?: (input: {
    previewUrl: string;
    receiptUrl: string;
    receiptContent: Buffer;
    receiptPath: string;
    projectId: string;
    runId: string;
    challenge: string;
    revisionSha: string;
    baseBranch: string;
    baseCommit: string;
    gitRemote: string;
    implementationCommit: string;
    targetOrigin: string;
  }) => Promise<void>;
  verifyCoreUiDeployment?: (input: {
    receiptPath: string;
    receiptContent: Buffer;
    projectId: string;
    runId: string;
    challenge: string;
    revisionSha: string;
    baseBranch: string;
    baseCommit: string;
    gitRemote: string;
    implementationCommit: string;
    targetOrigin: string;
  }) => Promise<void>;
}

interface CapturedWorkflowRun {
  projectId: string;
  root: string;
  baseSha: string;
  baseBranch: string | null;
  before: DesignWorkflowFileSnapshot;
  dirtyBefore: Set<string>;
}

export interface DesignWorkflowService {
  initializeProject(projectId: string): Promise<DesignWorkflowStatusResponse>;
  statusForProject(projectId: string): Promise<DesignWorkflowStatusResponse>;
  updateAll(projectId: string): Promise<DesignWorkflowUpdateAllResponse>;
  publish(projectId: string): Promise<DesignWorkflowStatusResponse>;
  rollback(projectId: string, sha: string): Promise<DesignWorkflowStatusResponse>;
  resume(projectId: string): Promise<DesignWorkflowStatusResponse>;
  markApplied(projectId: string, expectedTargetSha: string): Promise<DesignWorkflowStatusResponse>;
  captureRunStart(runId: string, projectId: string, prompt?: string): Promise<void>;
  completeRun(input: { runId: string; projectId: string; prompt: string; succeeded: boolean }): Promise<void>;
  promptContext(projectId: string, prompt: string, runId?: string): Promise<string>;
  readAppliedFile(projectId: string, filePath: string, useTarget?: boolean): Promise<string | null>;
  approveDelivery(
    projectId: string,
    deliveryId: string,
    implementationDigest: string,
    runId?: string,
  ): Promise<DesignWorkflowStatusResponse>;
}

function isSourceProject(project: WorkflowProject): boolean {
  return project.metadata?.importedFrom === 'design-system'
    && typeof project.designSystemId === 'string'
    && project.designSystemId.startsWith('user:');
}

export function isUserDesignWorkflowProject(
  project: Pick<WorkflowProject, 'designSystemId'> | null | undefined,
): boolean {
  return typeof project?.designSystemId === 'string'
    && project.designSystemId.startsWith('user:');
}

function commandFromPrompt(prompt: string): string {
  return prompt.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
}

export function parseDesignWorkflowApprovalPrompt(
  prompt: string,
): { deliveryId: string; implementationDigest: string } | null {
  const parts = prompt.trim().split(/\s+/);
  if (parts[0]?.toLowerCase() !== '/approve' || parts.length !== 3) return null;
  if (!/^[a-f0-9]{64}$/i.test(parts[2] ?? '')) return null;
  return { deliveryId: parts[1]!, implementationDigest: parts[2]! };
}

function safeDesignSystemSlug(designSystemId: string): string {
  return designSystemId.replace(/^user:/, '').replace(/[^a-zA-Z0-9._-]+/g, '-');
}

export function createDesignWorkflowService(deps: DesignWorkflowServiceDeps): DesignWorkflowService {
  const {
    db,
    projectsRoot,
    runtimeDataDir,
    getProject,
    listProjects,
    updateProject,
    resolveProjectDir,
    queueSubscriberUpdate,
    coreUiGitRemote = configuredCoreUiGitRemote(),
    validateSubscriberImplementation,
    verifyCoreUiCandidate,
    verifyCoreUiDeployment,
    verifyCoreUiDeploymentEvidence,
    verifyCoreUiPreview,
  } = deps;
  validateCoreUiGitRemote(coreUiGitRemote);
  const capturedRuns = new Map<string, CapturedWorkflowRun>();
  const capturedApprovals = new Map<string, {
    projectId: string;
    deliveryId: string;
    implementationDigest: string;
  }>();
  const capturedRunLocks = new Map<string, () => void>();
  const projectLockTails = new Map<string, Promise<void>>();
  db.prepare(`
    UPDATE design_workflow_delivery_challenges
    SET status = 'failed',
        error = 'Open Design restarted before the delivery challenge was consumed.',
        updated_at = ?
    WHERE status = 'issued'
  `).run(Date.now());

  async function acquireProjectLock(projectId: string): Promise<() => void> {
    const prior = projectLockTails.get(projectId) ?? Promise.resolve();
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    projectLockTails.set(projectId, gate);
    await prior;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseGate();
      if (projectLockTails.get(projectId) === gate) projectLockTails.delete(projectId);
    };
  }

  function tryAcquireProjectLock(projectId: string): (() => void) | null {
    if (projectLockTails.has(projectId)) return null;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    projectLockTails.set(projectId, gate);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseGate();
      if (projectLockTails.get(projectId) === gate) projectLockTails.delete(projectId);
    };
  }

  async function withProjectLock<T>(projectId: string, run: () => Promise<T>): Promise<T> {
    const release = await acquireProjectLock(projectId);
    try {
      return await run();
    } finally {
      release();
    }
  }

  function rootFor(project: WorkflowProject): string {
    return resolveProjectDir(projectsRoot, project.id, project.metadata, {
      allowUnavailableSandboxImportedProject: true,
    });
  }

  function sourceFor(designSystemId: string): WorkflowProject | null {
    return listProjects(db)
      .filter((project) => project.designSystemId === designSystemId && isSourceProject(project))
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))[0] ?? null;
  }

  function queueAutomaticSubscriberUpdate(projectId: string): void {
    if (projectId !== CORE_UI_PROJECT_ID && projectId !== GRAND_SLAM_OFFER_PROJECT_ID) return;
    if (queueSubscriberUpdate) {
      updateProject(db, projectId, { pendingPrompt: null });
      queueSubscriberUpdate(projectId);
      return;
    }
    updateProject(db, projectId, { pendingPrompt: '/update' });
  }

  function queueCurrentTargetIfNeeded(projectId: string): void {
    if (getDesignWorkflowSubscription(db, projectId)?.status === 'update_needed') {
      queueAutomaticSubscriberUpdate(projectId);
    }
  }

  function reapApprovalState(projectId: string): DesignWorkflowApprovalReapResult {
    const result = reapExpiredDesignWorkflowApprovals(db, projectId);
    if (result.deferredApplied) queueCurrentTargetIfNeeded(projectId);
    return result;
  }

  function assertNoActiveApproval(projectId: string, action: string): void {
    if (reapApprovalState(projectId).active) {
      throw new Error(`A delivery approval is in progress; ${action} is unavailable until it finishes.`);
    }
  }

  function coreRepositoryRoot(project: WorkflowProject): string {
    const linkedDirs = Array.isArray(project.metadata?.linkedDirs)
      ? project.metadata.linkedDirs.filter((value): value is string => typeof value === 'string')
      : [];
    const root = linkedDirs.find((candidate) => fs.existsSync(path.join(candidate, '99_System', 'core-v2', 'package.json')));
    if (!root) throw new Error('Core UI delivery cannot find its linked Core repository.');
    return root;
  }

  async function issueCoreUiDeliveryChallenge(
    runId: string,
    project: WorkflowProject,
  ): Promise<DesignWorkflowDeliveryChallenge> {
    const status = await initializeProjectUnlocked(project.id);
    if (
      status.role !== 'subscriber'
      || !status.subscription
      || status.subscription.appliedSha !== status.subscription.targetSha
      || (status.subscription.status !== 'up_to_date'
        && status.subscription.status !== 'updated_automatically')
    ) {
      throw new Error('Run /update successfully before /push so the implementation matches the target design revision.');
    }
    const repositoryRoot = coreRepositoryRoot(project);
    const canonicalHead = await readProjectGitCanonicalRemoteHead(
      repositoryRoot,
      coreUiGitRemote,
    );
    const baseBranch = canonicalHead.branch;
    const baseCommit = canonicalHead.sha;
    const challenge = randomBytes(32).toString('hex');
    const now = Date.now();
    const issued: DesignWorkflowDeliveryChallenge = {
      challenge,
      projectId: project.id,
      runId,
      designRevisionSha: status.subscription.appliedSha,
      baseBranch,
      baseCommit,
      gitRemote: coreUiGitRemote,
      targetOrigin: CORE_UI_TARGET_ORIGIN,
      receiptPath: `${CORE_UI_RECEIPT_ROOT}/${challenge}.json`,
      status: 'issued',
      deliveryId: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + DELIVERY_CHALLENGE_TTL_MS,
    };
    db.prepare(`
      INSERT INTO design_workflow_delivery_challenges
        (challenge, project_id, run_id, design_revision_sha, base_branch,
         base_commit, git_remote, target_origin, receipt_path, status, delivery_id,
         error, created_at, updated_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', NULL, NULL, ?, ?, ?)
    `).run(
      issued.challenge,
      issued.projectId,
      issued.runId,
      issued.designRevisionSha,
      issued.baseBranch,
      issued.baseCommit,
      issued.gitRemote,
      issued.targetOrigin,
      issued.receiptPath,
      issued.createdAt,
      issued.updatedAt,
      issued.expiresAt,
    );
    return issued;
  }

  function consumeCoreUiDeliveryChallenge(
    challenge: DesignWorkflowDeliveryChallenge,
    delivery: DesignWorkflowDelivery,
    now = Date.now(),
  ): void {
    const current = deliveryChallengeForRun(db, challenge.runId);
    if (
      !current
      || current.challenge !== challenge.challenge
      || current.status !== 'issued'
      || current.expiresAt <= now
      || current.projectId !== delivery.projectId
      || current.designRevisionSha !== delivery.revisionSha
      || delivery.target.challenge !== current.challenge
      || delivery.target.baseBranch !== current.baseBranch
      || delivery.target.baseCommit !== current.baseCommit
      || delivery.target.gitRemote !== current.gitRemote
      || delivery.target.targetOrigin !== current.targetOrigin
      || delivery.target.receiptPath !== current.receiptPath
    ) {
      throw new Error('Core UI delivery challenge is missing, expired, reused, or does not match the verified delivery.');
    }
    const consumed = db.prepare(`
      UPDATE design_workflow_delivery_challenges
      SET status = 'consumed', delivery_id = ?, error = NULL, updated_at = ?
      WHERE challenge = ? AND run_id = ? AND status = 'issued'
        AND expires_at > ?
    `).run(delivery.id, now, current.challenge, current.runId, now);
    if (consumed.changes !== 1) {
      throw new Error('Core UI delivery challenge changed before it could be consumed.');
    }
    saveDesignWorkflowDelivery(db, delivery);
  }

  function subscriberIds(designSystemId: string, sourceProjectId: string): string[] {
    return listProjects(db)
      .filter((project) => project.designSystemId === designSystemId && project.id !== sourceProjectId)
      .map((project) => project.id);
  }

  async function ensureSourceWorktree(source: WorkflowProject): Promise<WorkflowProject> {
    const metadata = source.metadata ?? {};
    const configuredWorktree = typeof metadata.designWorkflowWorktree === 'string'
      ? metadata.designWorkflowWorktree
      : null;
    const configuredCheckout = typeof metadata.designWorkflowSourceCheckout === 'string'
      ? metadata.designWorkflowSourceCheckout
      : null;
    const target = configuredWorktree ?? path.join(
      runtimeDataDir,
      'design-workflow',
      'worktrees',
      source.id.replace(/[^a-zA-Z0-9._-]+/g, '-'),
    );
    if (metadata.baseDir === target && fs.existsSync(target)) return source;

    const checkout = configuredCheckout ?? rootFor(source);
    const branch = `open-design/workspace-${source.id.replace(/[^a-zA-Z0-9]+/g, '').slice(0, 12)}`;
    await createProjectGitWorktree(checkout, target, branch);
    const updated = updateProject(db, source.id, {
      metadata: {
        ...metadata,
        baseDir: target,
        designWorkflowSourceCheckout: checkout,
        designWorkflowWorktree: target,
      },
    });
    if (!updated) throw new Error('The design-system project disappeared while its managed worktree was initialized.');
    return updated;
  }

  async function recoverSourceRunCapture(
    capture: DesignWorkflowSourceRunCapture,
    expectedRoot: string,
  ): Promise<void> {
    if (path.resolve(capture.root) !== path.resolve(expectedRoot)) {
      throw new Error(
        `Interrupted design run ${capture.runId} belongs to a different managed worktree and requires manual recovery.`,
      );
    }
    const completedRevision = designWorkflowRevisionForRun(db, capture.runId);
    const restoreSha = completedRevision?.sha ?? capture.baseSha;
    const restoreBranch = completedRevision?.branch ?? capture.baseBranch;
    if (!restoreBranch) {
      throw new Error(`Interrupted design run ${capture.runId} did not record a restorable branch.`);
    }
    const current = await readProjectGitStatus(capture.root);
    const alreadyRestored = (
      current.repository
      && current.clean
      && current.branch === restoreBranch
      && current.lastCommit?.hash === restoreSha
    );
    if (!alreadyRestored) {
      await quarantineProjectGitRunState(capture.root, {
        projectId: capture.projectId,
        runId: capture.runId,
        baseSha: restoreSha,
        baseBranch: restoreBranch,
      });
    }
    if (completedRevision) {
      const source = getProject(db, capture.projectId);
      if (
        !source
        || !isSourceProject(source)
        || source.designSystemId !== completedRevision.designSystemId
      ) {
        throw new Error(
          `Interrupted design run ${capture.runId} cannot replay subscriber propagation because its source project is unavailable.`,
        );
      }
      await propagateRevision(completedRevision, source);
    }
    if (!deleteSourceRunCapture(db, capture.runId, capture.projectId)) {
      throw new Error(`Interrupted design run ${capture.runId} changed while recovery completed.`);
    }
  }

  async function recoverStaleSourceRunCapture(
    project: WorkflowProject,
    root: string,
  ): Promise<void> {
    const existing = sourceRunCaptureForProject(db, project.id);
    if (!existing) return;
    if (capturedRuns.has(existing.runId)) {
      throw new Error(`Design-system run ${existing.runId} is still active for this project.`);
    }
    await recoverSourceRunCapture(existing, root);
  }

  async function ensureCurrentRevision(
    source: WorkflowProject,
    alreadyLockedProjectId?: string,
  ): Promise<DesignWorkflowRevision> {
    const root = rootFor(source);
    const git = await readProjectGitStatus(root);
    if (!git.repository || !git.lastCommit) {
      throw new Error('The design-system project must be a Git repository with at least one commit.');
    }
    const latest = latestDesignWorkflowRevision(db, source.designSystemId!);
    if (latest?.sha === git.lastCommit.hash) return latest;
    const revision = createDesignWorkflowRevision(db, {
      designSystemId: source.designSystemId!,
      sourceProjectId: source.id,
      sha: git.lastCommit.hash,
      branch: git.branch,
      classification: latest ? 'structural' : 'compatible',
      changedPaths: latest ? ['(external Git revision)'] : [],
      runId: null,
      createdAt: Date.now(),
    });
    if (latest) {
      await propagateRevision(
        revision,
        source,
        alreadyLockedProjectId ? { alreadyLockedProjectId } : {},
      );
    }
    return revision;
  }

  async function governedTokensInWorkingTree(root: string): Promise<Map<string, string[]>> {
    const tokens = new Map<string, string[]>();
    const tokenPaths = [...snapshotDesignWorkflowFiles(root).keys()]
      .filter(isGovernedCssTokenPath)
      .sort();
    for (const tokenPath of tokenPaths) {
      let content: string;
      try {
        content = fs.readFileSync(path.join(root, tokenPath), 'utf8');
      } catch {
        continue;
      }
      mergeGovernedTokenMaps(tokens, parseGovernedCssTokens(content));
    }
    return tokens;
  }

  async function governedTokenUpdatesForWorkingTree(
    root: string,
    baseSha: string,
  ): Promise<GovernedTokenUpdate[]> {
    const [before, after] = await Promise.all([
      governedTokensAtRevision(root, baseSha),
      governedTokensInWorkingTree(root),
    ]);
    return governedTokenUpdatesFromMaps(before, after);
  }

  async function classifyCapturedChanges(
    root: string,
    baseSha: string,
    paths: string[],
    deletedPaths: ReadonlySet<string>,
  ): Promise<DesignWorkflowRevisionClassification> {
    const pathClassification = classifyDesignWorkflowChanges(paths, deletedPaths);
    const updates = await governedTokenUpdatesForWorkingTree(root, baseSha);
    if (updates.some((update) => update.beforeValues.length > 0 && update.afterValues.length === 0)) {
      return 'structural';
    }
    if (pathClassification === 'compatible' || deletedPaths.size > 0) return pathClassification;
    if (updates.length === 0) return 'structural';
    for (const relativePath of paths) {
      if (classifyDesignWorkflowChanges([relativePath]) === 'compatible') continue;
      const before = await readProjectGitFileAtRevision(root, baseSha, relativePath);
      if (before == null) return 'structural';
      let after: Buffer;
      try {
        after = fs.readFileSync(path.join(root, relativePath));
      } catch {
        return 'structural';
      }
      if (
        before.byteLength > HASH_MAX_BYTES
        || after.byteLength > HASH_MAX_BYTES
        || before.includes(0)
        || after.includes(0)
        || !isGovernedTokenOnlyTextChange(before.toString('utf8'), after.toString('utf8'), updates)
      ) return 'structural';
    }
    return 'compatible';
  }

  function subscriberTextFiles(root: string): string[] {
    const files: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (files.length >= MAX_FILES) {
          throw new Error(`Subscriber source exceeds the ${MAX_FILES}-file propagation limit.`);
        }
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name)) walk(absolute);
          continue;
        }
        if (!entry.isFile() || !PROPAGATION_TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
        const stat = fs.statSync(absolute);
        if (stat.size <= HASH_MAX_BYTES) files.push(absolute);
      }
    };
    walk(root);
    return files;
  }

  async function applyCompatibleRevision(
    project: WorkflowProject,
    source: WorkflowProject,
    revision: DesignWorkflowRevision,
    previousSha: string | null,
    snapshotPaths: string[],
  ): Promise<void> {
    const projectRoot = rootFor(project);
    const sourceRoot = rootFor(source);
    const updates = await targetGovernedTokens(sourceRoot, revision, previousSha);
    const textWrites: Array<{ path: string; content: string }> = [];
    if (updates.length > 0) {
      for (const filePath of subscriberTextFiles(projectRoot)) {
        const current = fs.readFileSync(filePath, 'utf8');
        const rewritten = rewriteGovernedTokens(current, updates);
        if (rewritten.content === current) continue;
        textWrites.push({ path: filePath, content: rewritten.content });
      }
    }

    const binaryWrites: Array<{ path: string; content: Buffer }> = [];
    for (const relativePath of snapshotPaths.filter((filePath) =>
      filePath.startsWith('assets/') || filePath.startsWith('fonts/'),
    )) {
      const next = await readProjectGitFileAtRevision(sourceRoot, revision.sha, relativePath);
      if (next == null) throw new Error(`Revision ${revision.shortSha} does not contain ${relativePath}.`);
      const previous = previousSha
        ? await readProjectGitFileAtRevision(sourceRoot, previousSha, relativePath)
        : null;
      const destination = path.resolve(projectRoot, relativePath);
      if (!destination.startsWith(`${path.resolve(projectRoot)}${path.sep}`)) {
        throw new Error(`Compatible revision path ${relativePath} cannot leave the subscriber project.`);
      }
      if (fs.existsSync(destination)) {
        const current = fs.readFileSync(destination);
        if (current.equals(next)) continue;
        if (previous == null || !current.equals(previous)) {
          throw new Error(`Automatic asset update stopped because ${relativePath} has local changes.`);
        }
      }
      binaryWrites.push({ path: destination, content: next });
    }

    await materializeRevision(project, source, revision);
    for (const write of textWrites) fs.writeFileSync(write.path, write.content);
    for (const write of binaryWrites) {
      fs.mkdirSync(path.dirname(write.path), { recursive: true });
      fs.writeFileSync(write.path, write.content);
    }
    if (project.id === CORE_UI_PROJECT_ID && updates.length > 0) {
      const artifacts = (await listLiveArtifacts({ projectsRoot, projectId: project.id }))
        .filter((artifact) => artifact.status === 'active' && artifact.pinned);
      for (const artifact of artifacts) {
        const template = await readLiveArtifactCode({
          projectsRoot,
          projectId: project.id,
          artifactId: artifact.id,
          variant: 'template',
        });
        const rewritten = rewriteGovernedTokens(template, updates);
        if (rewritten.replacements === 0) continue;
        await updateLiveArtifact({
          projectsRoot,
          projectId: project.id,
          artifactId: artifact.id,
          input: {},
          templateHtml: rewritten.content,
        });
      }
    }
  }

  async function materializeRevision(
    project: WorkflowProject,
    source: WorkflowProject,
    revision: DesignWorkflowRevision,
  ): Promise<void> {
    const targetRoot = path.join(
      rootFor(project),
      '.open-design',
      'design-systems',
      safeDesignSystemSlug(revision.designSystemId),
    );
    const sourceRoot = rootFor(source);
    const paths = await compatibleFilesAtRevision(sourceRoot, revision.sha);
    const parentRoot = path.dirname(targetRoot);
    const snapshotName = path.basename(targetRoot);
    recoverMaterializedSnapshotRoot(targetRoot);
    const temporaryRoot = path.join(parentRoot, `.${snapshotName}.tmp-${randomUUID()}`);
    const backupRoot = path.join(parentRoot, `.${snapshotName}.backup-${randomUUID()}`);
    fs.mkdirSync(parentRoot, { recursive: true });
    try {
      for (const relativePath of paths) {
        const content = await readProjectGitFileAtRevision(sourceRoot, revision.sha, relativePath);
        if (content == null) throw new Error(`Revision ${revision.shortSha} does not contain ${relativePath}.`);
        const destination = path.resolve(temporaryRoot, relativePath);
        if (!destination.startsWith(`${path.resolve(temporaryRoot)}${path.sep}`)) {
          throw new Error(`Compatible revision path ${relativePath} cannot leave the materialized snapshot.`);
        }
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, content);
      }
      fs.mkdirSync(temporaryRoot, { recursive: true });
      fs.writeFileSync(path.join(temporaryRoot, 'revision.json'), `${JSON.stringify({
        designSystemId: revision.designSystemId,
        sourceProjectId: revision.sourceProjectId,
        sha: revision.sha,
        branch: revision.branch,
        changedPaths: revision.changedPaths,
        syncedAt: new Date().toISOString(),
      }, null, 2)}\n`);
      const hadPreviousSnapshot = fs.existsSync(targetRoot);
      if (hadPreviousSnapshot) fs.renameSync(targetRoot, backupRoot);
      try {
        fs.renameSync(temporaryRoot, targetRoot);
      } catch (error) {
        if (hadPreviousSnapshot && fs.existsSync(backupRoot) && !fs.existsSync(targetRoot)) {
          fs.renameSync(backupRoot, targetRoot);
        }
        throw error;
      }
      fs.rmSync(backupRoot, { recursive: true, force: true });
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }

  async function compatibleFilesAtRevision(sourceRoot: string, sha: string): Promise<string[]> {
    const files = (await listProjectGitFilesAtRevision(sourceRoot, sha))
      .filter((filePath) => {
        const segments = filePath.split('/');
        return !segments.some((segment) => IGNORED_DIRS.has(segment))
          && classifyDesignWorkflowChanges([filePath]) === 'compatible';
      });
    if (files.length > MAX_FILES) {
      throw new Error(`Revision ${sha.slice(0, 8)} exceeds the ${MAX_FILES}-file materialization limit.`);
    }
    return files;
  }

  function recoverMaterializedSnapshotRoot(targetRoot: string): void {
    const parentRoot = path.dirname(targetRoot);
    const snapshotName = path.basename(targetRoot);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(parentRoot, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
      throw error;
    }
    const temporaryPrefix = `.${snapshotName}.tmp-`;
    const backupPrefix = `.${snapshotName}.backup-`;
    const matchingEntries = entries.filter((entry) =>
      entry.name.startsWith(temporaryPrefix) || entry.name.startsWith(backupPrefix),
    );
    const invalidEntry = matchingEntries.find((entry) => !entry.isDirectory());
    if (invalidEntry) {
      throw new Error(`Interrupted materialized snapshot entry is not a directory: ${invalidEntry.name}.`);
    }
    const temporaryRoots = matchingEntries
      .filter((entry) => entry.name.startsWith(temporaryPrefix))
      .map((entry) => path.join(parentRoot, entry.name));
    const backupRoots = matchingEntries
      .filter((entry) => entry.name.startsWith(backupPrefix))
      .map((entry) => path.join(parentRoot, entry.name));
    for (const temporaryRoot of temporaryRoots) {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
    if (fs.existsSync(targetRoot)) {
      for (const backupRoot of backupRoots) fs.rmSync(backupRoot, { recursive: true, force: true });
      return;
    }
    if (backupRoots.length > 1) {
      throw new Error(`Multiple interrupted materialized snapshots require manual recovery for ${targetRoot}.`);
    }
    if (backupRoots.length === 1) fs.renameSync(backupRoots[0]!, targetRoot);
  }

  function materializedFiles(root: string): {
    files: string[];
    invalidPath: string | null;
    readErrorPath: string | null;
    truncated: boolean;
  } {
    const files: string[] = [];
    let invalidPath: string | null = null;
    let readErrorPath: string | null = null;
    let truncated = false;
    const walk = (directory: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        readErrorPath = path.relative(root, directory).replace(/\\/g, '/') || '.';
        return;
      }
      for (const entry of entries) {
        if (files.length >= MAX_FILES) {
          truncated = true;
          return;
        }
        const absolute = path.join(directory, entry.name);
        const relative = path.relative(root, absolute).replace(/\\/g, '/');
        if (entry.isDirectory()) {
          walk(absolute);
        } else if (entry.isFile()) {
          files.push(relative);
        } else {
          invalidPath = relative;
          return;
        }
        if (invalidPath || readErrorPath || truncated) return;
      }
    };
    walk(root);
    return { files: files.sort(), invalidPath, readErrorPath, truncated };
  }

  async function materializedRevisionMismatch(
    project: WorkflowProject,
    source: WorkflowProject,
    revision: DesignWorkflowRevision,
  ): Promise<string | null> {
    const targetRoot = path.join(
      rootFor(project),
      '.open-design',
      'design-systems',
      safeDesignSystemSlug(revision.designSystemId),
    );
    recoverMaterializedSnapshotRoot(targetRoot);
    const markerPath = path.join(targetRoot, 'revision.json');
    let markerSha: string | null = null;
    try {
      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as Record<string, unknown>;
      markerSha = typeof marker.sha === 'string' ? marker.sha : null;
    } catch {
      return 'revision.json is missing or invalid';
    }
    if (markerSha !== revision.sha) {
      return `revision.json points to ${markerSha?.slice(0, 8) ?? 'no SHA'} instead of ${revision.shortSha}`;
    }
    const sourceRoot = rootFor(source);
    const expectedPaths = await compatibleFilesAtRevision(sourceRoot, revision.sha);
    const actualSnapshot = materializedFiles(targetRoot);
    if (actualSnapshot.invalidPath) {
      return `${actualSnapshot.invalidPath} is not a regular materialized file`;
    }
    if (actualSnapshot.readErrorPath) {
      return `${actualSnapshot.readErrorPath} could not be read from the materialized snapshot`;
    }
    if (actualSnapshot.truncated) {
      return `the materialized snapshot exceeds the ${MAX_FILES}-file verification limit`;
    }
    const actualPaths = actualSnapshot.files.filter((filePath) => filePath !== 'revision.json');
    const expectedSet = new Set(expectedPaths);
    const actualSet = new Set(actualPaths);
    const missing = expectedPaths.find((filePath) => !actualSet.has(filePath));
    if (missing) return `${missing} is missing from the materialized snapshot`;
    const extra = actualPaths.find((filePath) => !expectedSet.has(filePath));
    if (extra) return `${extra} is not present in revision ${revision.shortSha}`;
    for (const relativePath of expectedPaths) {
      const expected = await readProjectGitFileAtRevision(sourceRoot, revision.sha, relativePath);
      if (expected == null) return `${relativePath} is missing from revision ${revision.shortSha}`;
      let actual: Buffer;
      try {
        actual = fs.readFileSync(path.join(targetRoot, relativePath));
      } catch {
        return `${relativePath} is missing from the materialized snapshot`;
      }
      if (!actual.equals(expected)) return `${relativePath} does not match revision ${revision.shortSha}`;
    }
    return null;
  }

  async function governedTokensAtRevision(
    sourceRoot: string,
    revisionSha: string,
  ): Promise<Map<string, string[]>> {
    const tokenValues = new Map<string, string[]>();
    const tokenFiles = (await compatibleFilesAtRevision(sourceRoot, revisionSha))
      .filter(isGovernedCssTokenPath)
      .sort();
    for (const filePath of tokenFiles) {
      const content = await readProjectGitFileAtRevision(sourceRoot, revisionSha, filePath);
      if (content == null) continue;
      mergeGovernedTokenMaps(tokenValues, parseGovernedCssTokens(content.toString('utf8')));
    }
    return tokenValues;
  }

  async function targetGovernedTokens(
    sourceRoot: string,
    revision: DesignWorkflowRevision,
    previousSha: string | null,
  ): Promise<GovernedTokenUpdate[]> {
    const [before, after] = await Promise.all([
      previousSha && previousSha !== revision.sha
        ? governedTokensAtRevision(sourceRoot, previousSha)
        : Promise.resolve(new Map<string, string[]>()),
      governedTokensAtRevision(sourceRoot, revision.sha),
    ]);
    const names = new Set([...before.keys(), ...after.keys()]);
    return [...names].map((name) => ({
      name,
      beforeValues: before.get(name) ?? [],
      afterValues: after.get(name) ?? [],
    }));
  }

  async function defaultSubscriberImplementationMismatch(input: {
    projectId: string;
    projectRoot: string;
    sourceRoot: string;
    revision: DesignWorkflowRevision;
  }): Promise<string | null> {
    if (input.projectId !== CORE_UI_PROJECT_ID && input.projectId !== GRAND_SLAM_OFFER_PROJECT_ID) {
      return null;
    }
    const appliedSha = getDesignWorkflowSubscription(db, input.projectId)?.appliedSha ?? null;
    const previousSha = appliedSha === input.revision.sha
      ? previousDesignWorkflowRevision(db, input.revision)?.sha ?? null
      : appliedSha;
    const governedTokens = await targetGovernedTokens(input.sourceRoot, input.revision, previousSha);
    if (governedTokens.length === 0) return null;
    const sourceSurfaces = subscriberTextFiles(input.projectRoot).map((filePath) => ({
      path: path.relative(input.projectRoot, filePath).replace(/\\/g, '/'),
      content: fs.readFileSync(filePath, 'utf8'),
    }));
    const sourceMismatch = governedTokenSurfaceMismatch(
      sourceSurfaces,
      governedTokens,
      'subscriber source',
    );
    if (sourceMismatch) return sourceMismatch;
    if (input.projectId !== CORE_UI_PROJECT_ID) return null;

    const artifacts = (await listLiveArtifacts({ projectsRoot, projectId: input.projectId }))
      .filter((artifact) => artifact.status === 'active' && artifact.pinned);
    if (artifacts.length === 0) {
      return 'Core UI has no active pinned live artifact to verify';
    }
    const artifactSurfaces: Array<{ path: string; content: string }> = [];
    for (const artifact of artifacts) {
      for (const variant of ['template', 'rendered'] as const) {
        artifactSurfaces.push({
          path: `${artifact.id}/${variant}`,
          content: await readLiveArtifactCode({
            projectsRoot,
            projectId: input.projectId,
            artifactId: artifact.id,
            variant,
          }),
        });
      }
    }
    return governedTokenSurfaceMismatch(
      artifactSurfaces,
      governedTokens,
      'registered Core UI live artifact',
    );
  }

  async function reconcileConfiguredSubscriberTokens(
    project: WorkflowProject,
    source: WorkflowProject,
    revision: DesignWorkflowRevision,
  ): Promise<void> {
    if (project.id !== CORE_UI_PROJECT_ID && project.id !== GRAND_SLAM_OFFER_PROJECT_ID) return;
    const appliedSha = getDesignWorkflowSubscription(db, project.id)?.appliedSha ?? null;
    const previousSha = appliedSha === revision.sha
      ? previousDesignWorkflowRevision(db, revision)?.sha ?? null
      : appliedSha;
    const governedTokens = await targetGovernedTokens(rootFor(source), revision, previousSha);
    if (governedTokens.length === 0) return;
    for (const filePath of subscriberTextFiles(rootFor(project))) {
      const current = fs.readFileSync(filePath, 'utf8');
      const rewritten = rewriteGovernedTokens(current, governedTokens);
      if (rewritten.replacements > 0) fs.writeFileSync(filePath, rewritten.content);
    }
    if (project.id !== CORE_UI_PROJECT_ID) return;
    const artifacts = (await listLiveArtifacts({ projectsRoot, projectId: project.id }))
      .filter((artifact) => artifact.status === 'active' && artifact.pinned);
    for (const artifact of artifacts) {
      const template = await readLiveArtifactCode({
        projectsRoot,
        projectId: project.id,
        artifactId: artifact.id,
        variant: 'template',
      });
      const rewritten = rewriteGovernedTokens(template, governedTokens);
      if (rewritten.replacements === 0) continue;
      await updateLiveArtifact({
        projectsRoot,
        projectId: project.id,
        artifactId: artifact.id,
        input: {},
        templateHtml: rewritten.content,
      });
    }
  }

  async function subscriberImplementationMismatch(
    project: WorkflowProject,
    source: WorkflowProject,
    revision: DesignWorkflowRevision,
  ): Promise<string | null> {
    return (validateSubscriberImplementation ?? defaultSubscriberImplementationMismatch)({
      projectId: project.id,
      projectRoot: rootFor(project),
      sourceRoot: rootFor(source),
      revision,
    });
  }

  async function propagateRevision(
    revision: DesignWorkflowRevision,
    source: WorkflowProject,
    options: { alreadyLockedProjectId?: string } = {},
  ): Promise<void> {
    for (const subscriberId of subscriberIds(revision.designSystemId, source.id)) {
      const propagateSubscriber = async (): Promise<void> => {
        const approvalState = reapApprovalState(subscriberId);
        const existing = getDesignWorkflowSubscription(db, subscriberId);
        if (existing?.status === 'pinned' || approvalState.active) {
          fanOutDesignWorkflowRevision(db, revision, [subscriberId]);
          return;
        }
        if (
          revision.classification === 'compatible'
          && existing?.appliedSha === revision.sha
          && (existing.status === 'up_to_date' || existing.status === 'updated_automatically')
        ) {
          return;
        }
        if (revision.classification === 'structural') {
          fanOutDesignWorkflowRevision(db, revision, [subscriberId]);
          const subscription = getDesignWorkflowSubscription(db, subscriberId);
          if (subscription?.status !== 'pinned') queueAutomaticSubscriberUpdate(subscriberId);
          return;
        }
        const subscriber = getProject(db, subscriberId);
        if (!subscriber) return;
        const previousSha = existing?.appliedSha ?? null;
        try {
          await applyCompatibleRevision(
            subscriber,
            source,
            revision,
            previousSha,
            revision.changedPaths,
          );
          const mismatch = await subscriberImplementationMismatch(subscriber, source, revision);
          if (mismatch) throw new Error(`Subscriber implementation is incomplete: ${mismatch}.`);
          fanOutDesignWorkflowRevision(db, revision, [subscriberId]);
          queueAutomaticSubscriberUpdate(subscriberId);
        } catch (error) {
          fanOutDesignWorkflowRevision(db, revision, [subscriberId]);
          failDesignWorkflowSubscription(
            db,
            subscriberId,
            revision.sha,
            error instanceof Error ? error.message : String(error),
            previousSha ?? undefined,
          );
          queueAutomaticSubscriberUpdate(subscriberId);
        }
      };
      if (options.alreadyLockedProjectId === subscriberId) {
        await propagateSubscriber();
      } else {
        await withProjectLock(subscriberId, propagateSubscriber);
      }
    }
  }

  async function initializeProjectUnlocked(projectId: string): Promise<DesignWorkflowStatusResponse> {
    const project = getProject(db, projectId);
    if (!project) throw new Error('Project not found.');
    const designSystemId = project.designSystemId;
    if (!designSystemId?.startsWith('user:')) {
      throw new Error('Choose a user design system before initializing the design workflow.');
    }
    const foundSource = sourceFor(designSystemId);
    if (!foundSource) throw new Error(`No design-system workspace is registered for ${designSystemId}.`);
    const source = await ensureSourceWorktree(foundSource);
    const revision = await ensureCurrentRevision(source, projectId);
    if (project.id === source.id) {
      return {
        projectId,
        role: 'source',
        designSystemId,
        sourceProjectId: source.id,
        status: 'up_to_date',
        currentRevision: revision,
        subscription: null,
        subscriberCount: listDesignWorkflowSubscriptions(db, designSystemId).length,
        delivery: latestDesignWorkflowDelivery(db, projectId),
      };
    }
    const previous = getDesignWorkflowSubscription(db, projectId);
    if (previous && previous.designSystemId !== designSystemId) {
      db.prepare('DELETE FROM design_workflow_subscriptions WHERE project_id = ?').run(projectId);
    }
    const subscription = initializeDesignWorkflowSubscription(db, projectId, revision);
    reapApprovalState(projectId);
    if (!previous || previous.designSystemId !== designSystemId) {
      const sourceFiles = await compatibleFilesAtRevision(rootFor(source), revision.sha);
      try {
        if (revision.classification === 'compatible') {
          await applyCompatibleRevision(project, source, revision, null, sourceFiles);
          const mismatch = await subscriberImplementationMismatch(project, source, revision);
          if (mismatch) throw new Error(`Subscriber implementation is incomplete: ${mismatch}.`);
        } else {
          await materializeRevision(project, source, revision);
        }
      } catch (error) {
        failDesignWorkflowSubscription(
          db,
          projectId,
          revision.sha,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    const current = getDesignWorkflowSubscription(db, projectId)!;
    if (
      (!previous || previous.designSystemId !== designSystemId)
      && current.status !== 'pinned'
    ) {
      queueAutomaticSubscriberUpdate(projectId);
    }
    return {
      projectId,
      role: 'subscriber',
      designSystemId,
      sourceProjectId: source.id,
      status: current.status,
      currentRevision: revision,
      subscription: current,
      subscriberCount: listDesignWorkflowSubscriptions(db, designSystemId).length,
      delivery: latestDesignWorkflowDelivery(db, projectId),
    };
  }

  async function initializeProject(projectId: string): Promise<DesignWorkflowStatusResponse> {
    return withProjectLock(projectId, () => initializeProjectUnlocked(projectId));
  }

  async function statusForProject(projectId: string): Promise<DesignWorkflowStatusResponse> {
    return withProjectLock(projectId, () => initializeProjectUnlocked(projectId));
  }

  async function rollback(projectId: string, sha: string): Promise<DesignWorkflowStatusResponse> {
    return withProjectLock(projectId, async () => {
      assertNoActiveApproval(projectId, 'rollback');
      const status = await initializeProjectUnlocked(projectId);
      if (status.role !== 'subscriber') throw new Error('Only asset projects can be rolled back.');
      const revision = getDesignWorkflowRevision(db, status.designSystemId, sha);
      if (!revision) throw new Error(`Revision ${sha} is not known for ${status.designSystemId}.`);
      const project = getProject(db, projectId)!;
      const source = getProject(db, status.sourceProjectId)!;
      if (revision.classification === 'compatible') {
        await applyCompatibleRevision(
          project,
          source,
          revision,
          status.subscription?.appliedSha ?? null,
          await compatibleFilesAtRevision(rootFor(source), revision.sha),
        );
        const mismatch = await subscriberImplementationMismatch(project, source, revision);
        if (mismatch) throw new Error(`Subscriber implementation is incomplete: ${mismatch}.`);
      } else {
        await materializeRevision(project, source, revision);
      }
      assertNoActiveApproval(projectId, 'rollback');
      if (!rollbackDesignWorkflowSubscription(db, projectId, sha)) {
        throw new Error('The delivery approval state changed before rollback could be recorded.');
      }
      return initializeProjectUnlocked(projectId);
    });
  }

  async function resume(projectId: string): Promise<DesignWorkflowStatusResponse> {
    return withProjectLock(projectId, async () => {
      assertNoActiveApproval(projectId, 'Resume');
      const status = await initializeProjectUnlocked(projectId);
      if (status.role !== 'subscriber') throw new Error('Only asset projects can resume design-system updates.');
      if (status.currentRevision.classification === 'compatible') {
        const project = getProject(db, projectId)!;
        const source = getProject(db, status.sourceProjectId)!;
        await applyCompatibleRevision(
          project,
          source,
          status.currentRevision,
          status.subscription?.appliedSha ?? null,
          status.currentRevision.changedPaths,
        );
        const mismatch = await subscriberImplementationMismatch(project, source, status.currentRevision);
        if (mismatch) throw new Error(`Subscriber implementation is incomplete: ${mismatch}.`);
      }
      assertNoActiveApproval(projectId, 'Resume');
      if (!resumeDesignWorkflowSubscription(db, projectId, status.currentRevision)) {
        throw new Error('The delivery approval state changed before Resume could be recorded.');
      }
      return initializeProjectUnlocked(projectId);
    });
  }

  async function markAppliedUnlocked(
    projectId: string,
    expectedTargetSha: string,
  ): Promise<DesignWorkflowStatusResponse> {
    const status = await initializeProjectUnlocked(projectId);
    if (status.role !== 'subscriber') throw new Error('Only asset projects apply upstream revisions.');
    if (status.subscription?.targetSha !== expectedTargetSha) {
      throw new Error('The design-system target advanced during /update. Reconcile the newer target before marking it applied.');
    }
    const applied = applyDesignWorkflowSubscription(db, projectId, expectedTargetSha);
    if (!applied) {
      throw new Error(
        status.subscription?.pinnedSha
          ? 'The design-system subscription is pinned. Resume it before applying an upstream revision.'
          : 'The design-system target advanced during /update. Reconcile the newer target before marking it applied.',
      );
    }
    return initializeProjectUnlocked(projectId);
  }

  async function markApplied(
    projectId: string,
    expectedTargetSha: string,
  ): Promise<DesignWorkflowStatusResponse> {
    return withProjectLock(projectId, () => markAppliedUnlocked(projectId, expectedTargetSha));
  }

  async function updateAllUnlocked(projectId: string): Promise<DesignWorkflowUpdateAllResponse> {
    const status = await initializeProjectUnlocked(projectId);
    if (status.role !== 'source') throw new Error('/update-all must run from the design-system project.');
    const subscriptions = listDesignWorkflowSubscriptions(db, status.designSystemId);
    for (const subscription of subscriptions) {
      if (subscription.status !== 'update_needed' && subscription.status !== 'sync_failed') continue;
      queueAutomaticSubscriberUpdate(subscription.projectId);
    }
    return { designSystemId: status.designSystemId, sourceProjectId: status.sourceProjectId, subscriptions };
  }

  async function updateAll(projectId: string): Promise<DesignWorkflowUpdateAllResponse> {
    return withProjectLock(projectId, () => updateAllUnlocked(projectId));
  }

  async function publishUnlocked(projectId: string): Promise<DesignWorkflowStatusResponse> {
    const status = await initializeProjectUnlocked(projectId);
    if (status.role !== 'source') throw new Error('Publish is available only in the design-system project.');
    const source = getProject(db, status.sourceProjectId);
    if (!source) throw new Error('Design-system project not found.');
    await publishProjectGitRevision(rootFor(source), status.currentRevision.sha, 'main');
    return initializeProjectUnlocked(projectId);
  }

  async function publish(projectId: string): Promise<DesignWorkflowStatusResponse> {
    return withProjectLock(projectId, () => publishUnlocked(projectId));
  }

  async function captureRunStart(runId: string, projectId: string, prompt = ''): Promise<void> {
    if (capturedRunLocks.has(runId)) throw new Error('This run already holds a project workflow lock.');
    const initialProject = getProject(db, projectId);
    if (!isUserDesignWorkflowProject(initialProject)) return;
    const command = commandFromPrompt(prompt);
    const release = tryAcquireProjectLock(projectId);
    if (!release) {
      if (approvingDesignWorkflowDeliveries(db, projectId).length > 0) {
        throw new Error(
          command === '/approve'
            ? 'Delivery approval is already in progress.'
            : 'A delivery approval is in progress; project mutations are unavailable until it finishes.',
        );
      }
      throw new Error('Another design-workflow run is already active for this project.');
    }
    let keepLock = false;
    try {
      const foundProject = getProject(db, projectId);
      if (!foundProject || !isUserDesignWorkflowProject(foundProject)) return;
      const approvalState = reapApprovalState(projectId);
      if (command !== '/approve' && approvalState.active) {
        throw new Error('A delivery approval is in progress; project mutations are unavailable until it finishes.');
      }
      if (command === '/approve') {
        const approval = parseDesignWorkflowApprovalPrompt(prompt);
        if (!approval) throw new Error('Use /approve <delivery-id> <implementation-digest>.');
        reserveDesignWorkflowDeliveryApproval(
          db,
          projectId,
          approval.deliveryId,
          approval.implementationDigest,
          runId,
        );
        ACTIVE_DESIGN_WORKFLOW_APPROVAL_RUNS.add(runId);
        capturedApprovals.set(runId, {
          projectId,
          deliveryId: approval.deliveryId,
          implementationDigest: approval.implementationDigest,
        });
      } else if (command === '/push' && foundProject.id === CORE_UI_PROJECT_ID) {
        await issueCoreUiDeliveryChallenge(runId, foundProject);
      } else if (isSourceProject(foundProject)) {
        const project = await ensureSourceWorktree(foundProject);
        const root = rootFor(project);
        await recoverStaleSourceRunCapture(project, root);
        const git = await prepareProjectGitRevisionBase(root);
        if (!git.repository) {
          capturedRunLocks.set(runId, release);
          keepLock = true;
          return;
        }
        if (!git.lastCommit) throw new Error('The design-system worktree must have a committed base revision.');
        if (!git.branch) throw new Error('The managed design-system worktree must be on a branch.');
        const captured: CapturedWorkflowRun = {
          projectId,
          root,
          baseSha: git.lastCommit.hash,
          baseBranch: git.branch,
          before: snapshotDesignWorkflowFiles(root),
          dirtyBefore: new Set(git.changes.flatMap((change) => [change.path, change.originalPath].filter((item): item is string => Boolean(item)))),
        };
        saveSourceRunCapture(db, {
          runId,
          projectId,
          root,
          baseSha: captured.baseSha,
          baseBranch: captured.baseBranch,
          createdAt: Date.now(),
        });
        capturedRuns.set(runId, captured);
      }
      capturedRunLocks.set(runId, release);
      keepLock = true;
    } finally {
      if (!keepLock) {
        failDeliveryChallenge(db, runId, 'Delivery challenge capture did not complete.');
        release();
      }
    }
  }

  async function completeRunUnlocked(input: { runId: string; projectId: string; prompt: string; succeeded: boolean }): Promise<void> {
    const captured = capturedRuns.get(input.runId);
    const capturedApproval = capturedApprovals.get(input.runId);
    capturedApprovals.delete(input.runId);
    const command = capturedApproval ? '/approve' : commandFromPrompt(input.prompt);
    if (command === '/approve') {
      const approval = capturedApproval ?? parseDesignWorkflowApprovalPrompt(input.prompt);
      if (!approval) throw new Error('Use /approve <delivery-id> <implementation-digest>.');
      if (capturedApproval && capturedApproval.projectId !== input.projectId) {
        const currentDelivery = getDesignWorkflowDelivery(db, approval.deliveryId);
        if (currentDelivery && deliveryRequiresReconciliation(currentDelivery)) {
          parkDesignWorkflowDeliveryReconciliation(
            db,
            approval.deliveryId,
            input.runId,
            'Approval completion did not match its reserved project; external state still requires reconciliation.',
          );
          throw new Error('Delivery approval completion does not match its reserved project.');
        }
        const released = releaseDesignWorkflowDeliveryApproval(
          db,
          approval.deliveryId,
          input.runId,
          'Approval completion did not match its reserved project.',
          false,
        );
        if (released) queueCurrentTargetIfNeeded(capturedApproval.projectId);
        throw new Error('Delivery approval completion does not match its reserved project.');
      }
      if (!input.succeeded) {
        const currentDelivery = getDesignWorkflowDelivery(db, approval.deliveryId);
        if (currentDelivery && deliveryRequiresReconciliation(currentDelivery)) {
          parkDesignWorkflowDeliveryReconciliation(
            db,
            approval.deliveryId,
            input.runId,
            'Approval run ended before the external deployment outcome could be reconciled.',
          );
          return;
        }
        const released = releaseDesignWorkflowDeliveryApproval(
          db,
          approval.deliveryId,
          input.runId,
          'Approval agent run did not complete.',
        );
        if (released) queueCurrentTargetIfNeeded(input.projectId);
        return;
      }
      await approveDelivery(
        input.projectId,
        approval.deliveryId,
        approval.implementationDigest,
        input.runId,
      );
      return;
    }
    if (!input.succeeded) {
      if (command === '/push') {
        failDeliveryChallenge(db, input.runId, 'Core UI /push run did not complete successfully.');
      }
      return;
    }
    if (command === '/push') {
      assertNoActiveApproval(input.projectId, '/push');
      const status = await initializeProjectUnlocked(input.projectId);
      if (status.role !== 'subscriber' || !status.subscription) {
        throw new Error('/push is available only in subscribed asset projects.');
      }
      if (
        status.subscription.appliedSha !== status.subscription.targetSha
        || (status.subscription.status !== 'up_to_date' && status.subscription.status !== 'updated_automatically')
      ) {
        throw new Error('Run /update successfully before /push so the implementation matches the target design revision.');
      }
      try {
        const project = getProject(db, input.projectId)!;
        const projectRoot = rootFor(project);
        let delivery: DesignWorkflowDelivery | null = null;
        let coreChallenge: DesignWorkflowDeliveryChallenge | null = null;
        if (input.projectId === CORE_UI_PROJECT_ID) {
          const repositoryRoot = coreRepositoryRoot(project);
          coreChallenge = deliveryChallengeForRun(db, input.runId);
          if (
            !coreChallenge
            || coreChallenge.status !== 'issued'
            || coreChallenge.projectId !== input.projectId
            || coreChallenge.designRevisionSha !== status.subscription.appliedSha
            || coreChallenge.gitRemote !== coreUiGitRemote
            || coreChallenge.expiresAt <= Date.now()
          ) {
            throw new Error('Core UI /push is missing its daemon-issued delivery challenge.');
          }
          const canonicalHead = await readProjectGitCanonicalRemoteHead(
            repositoryRoot,
            coreChallenge.gitRemote,
          );
          const baseBranch = canonicalHead.branch;
          if (
            baseBranch !== coreChallenge.baseBranch
            || canonicalHead.sha !== coreChallenge.baseCommit
          ) {
            throw new Error('Core UI canonical remote default branch or frozen base changed after the delivery challenge was issued.');
          }
          delivery = stageCoreUiDelivery({
            projectRoot,
            revisionSha: status.subscription.appliedSha,
            baseBranch,
            baseCommit: coreChallenge.baseCommit,
            gitRemote: coreChallenge.gitRemote,
            challenge: coreChallenge.challenge,
            runId: input.runId,
            targetOrigin: coreChallenge.targetOrigin,
            receiptPath: coreChallenge.receiptPath,
          });
          const branch = String(delivery.target.branch ?? '');
          const attestationCommit = String(delivery.target.attestationCommit ?? '');
          const implementationCommit = String(delivery.target.implementationCommit ?? '');
          const baseCommit = String(delivery.target.baseCommit ?? '');
          const previewUrl = String(delivery.previewUrl ?? '');
          const receiptPath = String(delivery.target.receiptPath ?? '');
          const previewReceiptUrl = String(delivery.target.previewReceiptUrl ?? '');
          const remoteBranchRevision = await readProjectGitCanonicalRemoteBranchRevision(
            repositoryRoot,
            coreChallenge.gitRemote,
            branch,
          );
          if (
            remoteBranchRevision !== attestationCommit
            || canonicalHead.sha !== baseCommit
          ) {
            throw new Error(
              'Core UI delivery Git verification failed: the canonical remote preview branch tip and frozen base must exactly match the manifest.',
            );
          }
          await verifyProjectGitLinearAttestation(repositoryRoot, {
            baseCommit,
            implementationCommit,
            attestationCommit,
            appPath: '99_System/core-v2/apps/web/src/app.html',
            receiptPath,
          });
          const [implementationApp, attestationApp, receiptContent] = await Promise.all([
            readProjectGitFileAtRevision(
              repositoryRoot,
              implementationCommit,
              '99_System/core-v2/apps/web/src/app.html',
            ),
            readProjectGitFileAtRevision(
              repositoryRoot,
              attestationCommit,
              '99_System/core-v2/apps/web/src/app.html',
            ),
            readProjectGitFileAtRevision(
              repositoryRoot,
              attestationCommit,
              receiptPath,
            ),
          ]);
          if (implementationApp == null || attestationApp == null || receiptContent == null) {
            throw new Error('Core UI delivery attestation files are missing from the exact remote commits.');
          }
          const binding = {
            challenge: coreChallenge.challenge,
            projectId: coreChallenge.projectId,
            runId: coreChallenge.runId,
            designRevision: coreChallenge.designRevisionSha,
            baseBranch: coreChallenge.baseBranch,
            baseCommit: coreChallenge.baseCommit,
            gitRemote: coreChallenge.gitRemote,
            implementationCommit,
            targetOrigin: coreChallenge.targetOrigin,
            receiptPath: coreChallenge.receiptPath,
          };
          verifyCoreUiAttestationFiles({
            implementationApp,
            attestationApp,
            receiptContent,
            binding,
          });
          const trustedCandidate = await (
            verifyCoreUiCandidate ?? verifyCoreUiCandidateWithTrustedCommand
          )({
            repositoryRoot,
            attestationCommit,
            challenge: coreChallenge.challenge,
            receiptPath,
          });
          validateTrustedCoreUiCandidateEvidence(trustedCandidate, attestationCommit);
          const trustedChecks = [...trustedCandidate.checks]
            .sort((left, right) => left.name.localeCompare(right.name));
          delivery = {
            ...delivery,
            implementationDigest: createHash('sha256').update(JSON.stringify({
              stagedImplementationDigest: delivery.implementationDigest,
              trustedBuildDigest: trustedCandidate.buildDigest,
              trustedChecks,
            })).digest('hex'),
            target: {
              ...delivery.target,
              trustedBuildDigest: trustedCandidate.buildDigest,
              trustedChecks,
              trustedPreviewPid: trustedCandidate.pid,
            },
          };
          await (verifyCoreUiPreview ?? verifyCoreUiPreviewReceipt)({
            previewUrl,
            receiptUrl: previewReceiptUrl,
            receiptContent,
            receiptPath,
            projectId: coreChallenge.projectId,
            runId: coreChallenge.runId,
            challenge: coreChallenge.challenge,
            revisionSha: status.subscription.appliedSha,
            baseBranch: coreChallenge.baseBranch,
            baseCommit: coreChallenge.baseCommit,
            gitRemote: coreChallenge.gitRemote,
            implementationCommit,
            targetOrigin: coreChallenge.targetOrigin,
          });
        } else if (input.projectId === GRAND_SLAM_OFFER_PROJECT_ID) {
          delivery = await stageWordPressDraftDelivery({
            projectRoot,
            revisionSha: status.subscription.appliedSha,
            runId: input.runId,
            priorDelivery: latestDesignWorkflowDelivery(db, input.projectId),
          });
        }
        if (!delivery) throw new Error('This asset project does not have a live-target adapter yet.');
        db.transaction(() => {
          const approvalState = reapExpiredDesignWorkflowApprovalsUnlocked(
            db,
            input.projectId,
            Date.now(),
          );
          const current = getDesignWorkflowSubscription(db, input.projectId);
          if (approvalState.active) {
            throw new Error('A delivery approval started while /push was running; discard this preview and retry afterward.');
          }
          if (
            !current
            || current.appliedSha !== status.subscription!.appliedSha
            || current.targetSha !== status.subscription!.targetSha
            || (current.status !== 'up_to_date' && current.status !== 'updated_automatically')
          ) {
            throw new Error('The design-system target changed while /push was running; discard this preview and run /update.');
          }
          if (coreChallenge) {
            consumeCoreUiDeliveryChallenge(coreChallenge, delivery!);
          } else {
            saveDesignWorkflowDelivery(db, delivery!);
          }
        })();
      } catch (error) {
        failDeliveryChallenge(
          db,
          input.runId,
          error instanceof Error ? error.message : String(error),
        );
        if (reapApprovalState(input.projectId).active) {
          throw error;
        }
        const now = Date.now();
        saveDesignWorkflowDelivery(db, {
          id: randomUUID(),
          projectId: input.projectId,
          adapter: input.projectId === CORE_UI_PROJECT_ID ? 'core-ui' : 'wordpress-draft',
          revisionSha: status.subscription.appliedSha,
          implementationDigest: createHash('sha256').update(`${input.runId}\0failed`).digest('hex'),
          status: 'failed',
          previewUrl: null,
          target: latestDesignWorkflowDelivery(db, input.projectId)?.target ?? {},
          checkpointPath: latestDesignWorkflowDelivery(db, input.projectId)?.checkpointPath ?? null,
          error: error instanceof Error ? error.message : String(error),
          createdAt: now,
          updatedAt: now,
          expiresAt: now,
        });
        throw error;
      }
      return;
    }
    if (commandFromPrompt(input.prompt) === '/update') {
      assertNoActiveApproval(input.projectId, '/update');
      const status = await initializeProjectUnlocked(input.projectId);
      if (status.role === 'subscriber' && status.subscription) {
        const project = getProject(db, input.projectId)!;
        const source = getProject(db, status.sourceProjectId)!;
        const mismatch = await materializedRevisionMismatch(project, source, status.currentRevision);
        if (mismatch) {
          const message = `Subscriber materialized design-system revision is incomplete: ${mismatch}.`;
          const failed = failDesignWorkflowSubscription(
            db,
            input.projectId,
            status.currentRevision.sha,
            message,
            status.subscription.appliedSha,
          );
          if (!failed) {
            throw new Error(
              'The design-system target or pin state changed during /update validation. Reconcile the current target.',
            );
          }
          throw new Error(message);
        }
        await reconcileConfiguredSubscriberTokens(project, source, status.currentRevision);
        const implementationMismatch = await subscriberImplementationMismatch(
          project,
          source,
          status.currentRevision,
        );
        if (implementationMismatch) {
          const message = `Subscriber implementation is incomplete: ${implementationMismatch}.`;
          const failed = failDesignWorkflowSubscription(
            db,
            input.projectId,
            status.currentRevision.sha,
            message,
            status.subscription.appliedSha,
          );
          if (!failed) {
            throw new Error(
              'The design-system target or pin state changed during /update validation. Reconcile the current target.',
            );
          }
          throw new Error(message);
        }
        assertNoActiveApproval(input.projectId, '/update');
        await markAppliedUnlocked(input.projectId, status.currentRevision.sha);
      }
      return;
    }
    if (commandFromPrompt(input.prompt) === '/init') {
      await initializeProjectUnlocked(input.projectId);
    }
    if (commandFromPrompt(input.prompt) === '/update-all') {
      await updateAllUnlocked(input.projectId);
      return;
    }
    if (commandFromPrompt(input.prompt) === '/publish') {
      await publishUnlocked(input.projectId);
      return;
    }
    if (!captured || captured.projectId !== input.projectId) return;
    const project = getProject(db, input.projectId);
    if (!project || !isSourceProject(project)) return;
    const after = snapshotDesignWorkflowFiles(captured.root);
    const changedPaths = touchedDesignWorkflowPaths(captured.before, after);
    if (changedPaths.length === 0) return;
    const collided = changedPaths.filter((filePath) => captured.dirtyBefore.has(filePath));
    if (collided.length > 0) {
      throw new Error(`Open Design did not auto-commit files that were already dirty before the run: ${collided.join(', ')}`);
    }
    const deletedPaths = new Set(changedPaths.filter((filePath) => !after.has(filePath)));
    const classification = await classifyCapturedChanges(
      captured.root,
      captured.baseSha,
      changedPaths,
      deletedPaths,
    );
    const branch = `open-design/run-${input.runId.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 32)}`;
    const committed = await createAndPushProjectGitRevision(
      captured.root,
      branch,
      `Open Design: update ${project.name} (${input.runId.slice(0, 8)})`,
      changedPaths,
    );
    if (
      !committed.status.repository
      || committed.status.truncated
      || !committed.status.clean
    ) {
      throw new Error(
        'Open Design committed the detected revision, but the managed worktree still contains untracked or uncommitted changes. The complete run state will be quarantined for recovery.',
      );
    }
    const revision = createDesignWorkflowRevision(db, {
      designSystemId: project.designSystemId!,
      sourceProjectId: project.id,
      sha: committed.commit.hash,
      branch,
      classification,
      changedPaths,
      runId: input.runId,
      createdAt: Date.now(),
    });
    await propagateRevision(revision, project);
    if (!deleteSourceRunCapture(db, input.runId, input.projectId)) {
      throw new Error(`Design-system run ${input.runId} changed while propagation completed.`);
    }
  }

  async function completeRun(
    input: { runId: string; projectId: string; prompt: string; succeeded: boolean },
  ): Promise<void> {
    const capturedSource = capturedRuns.get(input.runId);
    const capturedRelease = capturedRunLocks.get(input.runId);
    if (capturedRelease) capturedRunLocks.delete(input.runId);
    if (!capturedRelease && !isUserDesignWorkflowProject(getProject(db, input.projectId))) return;
    const release = capturedRelease ?? await acquireProjectLock(input.projectId);
    let completionError: unknown = null;
    try {
      await completeRunUnlocked(input);
    } catch (error) {
      completionError = error;
    } finally {
      if (capturedSource) {
        try {
          const durableCapture = sourceRunCaptureForProject(db, capturedSource.projectId);
          if (durableCapture?.runId === input.runId) {
            await recoverSourceRunCapture(durableCapture, capturedSource.root);
          }
        } catch (recoveryError) {
          const completionMessage = completionError instanceof Error
            ? completionError.message
            : completionError == null
              ? ''
              : String(completionError);
          const recoveryMessage = recoveryError instanceof Error
            ? recoveryError.message
            : String(recoveryError);
          completionError = new Error(
            [completionMessage, `Source-run recovery failed: ${recoveryMessage}`]
              .filter(Boolean)
              .join(' '),
          );
        }
        capturedRuns.delete(input.runId);
      }
      ACTIVE_DESIGN_WORKFLOW_APPROVAL_RUNS.delete(input.runId);
      release();
    }
    if (completionError != null) throw completionError;
  }

  async function readAppliedFile(projectId: string, filePath: string, useTarget = false): Promise<string | null> {
    const status = await initializeProjectUnlocked(projectId);
    const sha = status.subscription
      ? (useTarget ? status.subscription.targetSha : status.subscription.appliedSha)
      : status.currentRevision.sha;
    const source = getProject(db, status.sourceProjectId);
    if (!source) return null;
    const content = await readProjectGitFileAtRevision(rootFor(source), sha, filePath);
    return content?.toString('utf8') ?? null;
  }

  async function promptContext(projectId: string, prompt: string, runId?: string): Promise<string> {
    const status = await initializeProjectUnlocked(projectId);
    const subscription = status.subscription;
    if (!subscription) {
      return [
        `Design workflow source revision: ${status.currentRevision.shortSha} (${status.currentRevision.branch ?? 'detached'}). Successful file-changing runs are committed to an isolated branch and pushed to origin automatically.`,
        commandFromPrompt(prompt) === '/publish'
          ? 'This is an explicit Publish command. Do not edit files. Open Design will fast-forward the exact current revision to origin/main after this run succeeds.'
          : commandFromPrompt(prompt) === '/update-all'
            ? 'This is an explicit /update-all command. Do not edit files. Open Design will queue unattended reconciliation in every subscriber that still needs it.'
            : '',
      ].filter(Boolean).join('\n');
    }
    const updateCommand = commandFromPrompt(prompt) === '/update';
    const materializedRoot = `.open-design/design-systems/${safeDesignSystemSlug(status.designSystemId)}`;
    const command = commandFromPrompt(prompt);
    const approval = parseDesignWorkflowApprovalPrompt(prompt);
    const currentDelivery = status.delivery;
    const corePushChallenge = command === '/push' && projectId === CORE_UI_PROJECT_ID
      ? runId
        ? deliveryChallengeForRun(db, runId)
        : null
      : null;
    if (
      command === '/push'
      && projectId === CORE_UI_PROJECT_ID
      && (
        !corePushChallenge
        || corePushChallenge.status !== 'issued'
        || corePushChallenge.expiresAt <= Date.now()
        || corePushChallenge.designRevisionSha !== subscription.appliedSha
        || corePushChallenge.gitRemote !== coreUiGitRemote
      )
    ) {
      throw new Error('Core UI /push cannot start without its current daemon-issued delivery challenge.');
    }
    const deliveryInstructions = command === '/push'
      ? projectId === CORE_UI_PROJECT_ID
        ? [
            'This is a Core UI /push run. Work only in an isolated codex/ branch and Core worktree targeting 99_System/core-v2; do not merge, restart the live services, or deploy.',
            `The daemon challenge is ${corePushChallenge!.challenge}. It is single-use, expires during this run, and must never be invented or reused.`,
            `Use only canonical Git remote ${corePushChallenge!.gitRemote}. Start exactly from ${corePushChallenge!.baseCommit} on its ${corePushChallenge!.baseBranch} branch. Put every implementation change into one commit I whose only parent is that base and whose changed paths stay under 99_System/core-v2/apps/web/src/ or 99_System/core-v2/apps/web/static/, excluding the open-design/attestations receipt store. Build/test/package configuration and harness files are protected.`,
            `Create one final attestation commit A whose only parent is I. A may change only 99_System/core-v2/apps/web/src/app.html inside the reserved open-design-attestation sentinel and add ${corePushChallenge!.receiptPath}.`,
            `The sentinel must expose exactly one meta each for open-design-challenge=${corePushChallenge!.challenge}, open-design-design-revision=${corePushChallenge!.designRevisionSha}, open-design-implementation-commit=<I>, open-design-target-origin=${corePushChallenge!.targetOrigin}, and open-design-receipt-path=/${corePushChallenge!.receiptPath.slice('99_System/core-v2/apps/web/static/'.length)}.`,
            `Write the schemaVersion 2 canonical attestation receipt for run ${corePushChallenge!.runId}, project ${corePushChallenge!.projectId}, base ${corePushChallenge!.baseCommit}, gitRemote ${corePushChallenge!.gitRemote}, implementation commit I, target ${corePushChallenge!.targetOrigin}, and receipt path ${corePushChallenge!.receiptPath}. Do not add extra receipt fields.`,
            'Push A as the exact codex/ branch tip. Do not start or replace the trusted preview service; Open Design owns loopback 3132 and the private preview route.',
            'Write .open-design/delivery.json schemaVersion 2 with adapter "core-ui", the exact challenge, branch, baseBranch, baseCommit, gitRemote, implementationCommit I, attestationCommit A, designRevision, targetOrigin, previewUrl, previewReceiptUrl, receiptPath, approvalRequired true, approvalReady true, and your advisory tests/build/browser results bound to A. If implementation changes after A, rebuild the exact base → I → A pair.',
            `Open Design will independently verify the frozen remote base, exact two-commit topology, exact A diff and file modes, canonical receipt bytes, run its pinned check/test/build/browser verifier against A, own the preview at ${CORE_UI_PREVIEW_ROOT}, and verify the served root and receipt before accepting approval.`,
          ].join(' ')
        : projectId === GRAND_SLAM_OFFER_PROJECT_ID
          ? 'This is a Grand Slam Offer /push run. Finish and locally QA grand-slam-offer-prototype-en.html, then write .open-design/delivery.json with adapter "wordpress-draft", entryFile, title, and slug. After the run, Open Design will checkpoint and create or update only the dedicated unpublished WordPress draft. Never publish it from the agent run.'
          : 'This project has no configured /push delivery adapter.'
      : command === '/approve'
        ? !approval || !currentDelivery
          ? 'Approval command is invalid. Use /approve <delivery-id> <implementation-digest> exactly as shown in Design workflow status. Do not deploy anything.'
          : approval.deliveryId !== currentDelivery.id || approval.implementationDigest !== currentDelivery.implementationDigest
            ? 'Approval does not match the latest preview delivery and digest. Do not deploy anything.'
            : currentDelivery.adapter === 'core-ui'
              ? `This is explicit approval for Core UI delivery ${currentDelivery.id}, digest ${currentDelivery.implementationDigest}. Do not edit files, change Git refs, build, restart services, or deploy anything from the agent run. Open Design will use a compare-and-swap fast-forward from base ${String(currentDelivery.target.baseCommit)} to exact attestation commit ${String(currentDelivery.target.attestationCommit)} on canonical remote ${String(currentDelivery.target.gitRemote)} branch ${String(currentDelivery.target.baseBranch)} and the clean live primary checkout, then rebuild the exact approved commit with its pinned verifier, compare the trusted candidate digest, restart the actual system services, and verify localhost and tailnet roots plus the exact approved receipt.`
              : `This is explicit approval for WordPress delivery ${currentDelivery.id}, digest ${currentDelivery.implementationDigest}. Do not edit or publish the page yourself. Open Design will re-read the exact draft and publish it only after this run succeeds.`
        : '';
    return [
      `Design workflow status: ${subscription.status}.`,
      `Applied revision: ${subscription.appliedSha.slice(0, 8)}. Target revision: ${subscription.targetSha.slice(0, 8)}.`,
      `The exact applied token and asset snapshot is materialized at ${materializedRoot}.`,
      subscription.status === 'update_needed'
        ? updateCommand
          ? `This is an explicit /update run. Reconcile the asset project to the target revision, preserve local additive extensions, and validate the result. Before finishing, make ${materializedRoot}/revision.json and every materialized canonical file match the target revision. If any required subscriber surface or registered preview remains stale or cannot be validated, do not report success.`
          : 'A structural upstream change is queued for unattended reconciliation. Do not claim it is applied until that run succeeds.'
        : 'Use the applied design-system revision as the canonical upstream source; local project additions may extend it but must not overwrite it.',
      subscription.status === 'pinned' ? 'Automatic updates are pinned after rollback until Resume is requested.' : '',
      deliveryInstructions,
    ].filter(Boolean).join('\n');
  }

  async function approveDeliveryWithReservation(
    projectId: string,
    deliveryId: string,
    implementationDigest: string,
    runId: string,
  ): Promise<DesignWorkflowStatusResponse> {
    let delivery = getDesignWorkflowDelivery(db, deliveryId);
    let wordpressPublicationConfirmed = false;
    let coreDeploymentObserved = false;
    try {
      delivery = renewDesignWorkflowDeliveryApproval(db, deliveryId, runId);
      await initializeProjectUnlocked(projectId);
      delivery = getDesignWorkflowDelivery(db, deliveryId);
      const lease = delivery ? approvalLease(delivery) : null;
      if (
        !delivery
        || delivery.projectId !== projectId
        || delivery.implementationDigest !== implementationDigest
        || delivery.status !== 'approving'
        || lease?.runId !== runId
        || lease.expiresAt <= Date.now()
      ) {
        throw new Error('Delivery approval reservation is missing, expired, or belongs to another run.');
      }
      if (delivery.adapter === 'core-ui') {
        const project = getProject(db, projectId);
        if (!project) throw new Error('Core UI project not found.');
        const repositoryRoot = coreRepositoryRoot(project);
        const attestationCommit = typeof delivery.target.attestationCommit === 'string'
          ? delivery.target.attestationCommit
          : '';
        const implementationCommit = typeof delivery.target.implementationCommit === 'string'
          ? delivery.target.implementationCommit
          : '';
        const baseCommit = typeof delivery.target.baseCommit === 'string'
          ? delivery.target.baseCommit
          : '';
        const gitRemote = typeof delivery.target.gitRemote === 'string'
          ? delivery.target.gitRemote
          : '';
        const baseBranch = typeof delivery.target.baseBranch === 'string'
          ? delivery.target.baseBranch
          : '';
        const challenge = typeof delivery.target.challenge === 'string' ? delivery.target.challenge : '';
        const deliveryRunId = typeof delivery.target.runId === 'string' ? delivery.target.runId : '';
        const targetOrigin = typeof delivery.target.targetOrigin === 'string'
          ? delivery.target.targetOrigin
          : '';
        const receiptPath = typeof delivery.target.receiptPath === 'string'
          ? delivery.target.receiptPath
          : '';
        const trustedBuildDigest = typeof delivery.target.trustedBuildDigest === 'string'
          ? delivery.target.trustedBuildDigest
          : '';
        if (targetOrigin !== CORE_UI_TARGET_ORIGIN) {
          throw new Error('Core UI configured target origin changed after preview approval.');
        }
        if (gitRemote !== coreUiGitRemote) {
          throw new Error('Core UI canonical Git remote changed after preview approval.');
        }
        await deployProjectGitCanonicalRevision(repositoryRoot, {
          expectedRemoteUrl: gitRemote,
          baseBranch,
          baseCommit,
          targetCommit: attestationCommit,
          scopePath: '99_System/core-v2',
        });
        coreDeploymentObserved = true;
        const canonicalHead = await readProjectGitCanonicalRemoteHead(
          repositoryRoot,
          gitRemote,
        );
        const onRemoteBase = canonicalHead.branch === baseBranch
          && canonicalHead.sha === attestationCommit;
        const coreAppRoot = path.join(repositoryRoot, '99_System', 'core-v2');
        const liveCoreStatusBefore = await readProjectGitStatus(coreAppRoot);
        const inLiveCheckout = await projectGitRefMatchesRevision(
          repositoryRoot,
          attestationCommit,
          'HEAD',
        );
        coreDeploymentObserved = onRemoteBase || inLiveCheckout;
        if (
          !liveCoreStatusBefore.repository
          || liveCoreStatusBefore.branch !== baseBranch
        ) {
          throw new Error(
            `Core UI live checkout must be on the exact canonical branch ${baseBranch} before trusted deployment verification.`,
          );
        }
        if (!onRemoteBase || !inLiveCheckout) {
          throw new Error(
            `Core UI approval has not deployed the exact preview commit to both canonical remote ${baseBranch} and the live Core checkout.`,
          );
        }
        await verifyProjectGitLinearAttestation(repositoryRoot, {
          baseCommit,
          implementationCommit,
          attestationCommit,
          appPath: '99_System/core-v2/apps/web/src/app.html',
          receiptPath,
        });
        const [implementationApp, attestationApp, receiptContent] = await Promise.all([
          readProjectGitFileAtRevision(
            repositoryRoot,
            implementationCommit,
            '99_System/core-v2/apps/web/src/app.html',
          ),
          readProjectGitFileAtRevision(
            repositoryRoot,
            attestationCommit,
            '99_System/core-v2/apps/web/src/app.html',
          ),
          readProjectGitFileAtRevision(repositoryRoot, attestationCommit, receiptPath),
        ]);
        if (implementationApp == null || attestationApp == null || receiptContent == null) {
          throw new Error('Core UI deployed attestation files are missing from the exact approved commits.');
        }
        const binding = {
          challenge,
          projectId,
          runId: deliveryRunId,
          designRevision: delivery.revisionSha,
          baseBranch,
          baseCommit,
          gitRemote,
          implementationCommit,
          targetOrigin,
          receiptPath,
        };
        verifyCoreUiAttestationFiles({
          implementationApp,
          attestationApp,
          receiptContent,
          binding,
        });
        if (!/^[a-f0-9]{64}$/.test(trustedBuildDigest)) {
          throw new Error('Core UI delivery is missing its trusted candidate build digest.');
        }
        const trustedDeployment = await (
          verifyCoreUiDeploymentEvidence ?? verifyCoreUiDeploymentWithTrustedCommand
        )({
          repositoryRoot,
          attestationCommit,
          buildDigest: trustedBuildDigest,
        });
        validateTrustedCoreUiDeploymentEvidence(
          trustedDeployment,
          attestationCommit,
          trustedBuildDigest,
        );
        await (verifyCoreUiDeployment ?? verifyCoreUiDeploymentReceipt)({
          receiptPath,
          receiptContent,
          projectId,
          runId: deliveryRunId,
          challenge,
          revisionSha: delivery.revisionSha,
          baseBranch,
          baseCommit,
          gitRemote,
          implementationCommit,
          targetOrigin,
        });
        const coreAppStatus = await readProjectGitStatus(coreAppRoot);
        if (
          !coreAppStatus.repository
          || coreAppStatus.branch !== baseBranch
          || coreAppStatus.truncated
          || !coreAppStatus.clean
          || coreAppStatus.lastCommit?.hash !== attestationCommit
        ) {
          throw new Error(
            'Core UI approval left tracked or untracked changes in 99_System/core-v2; deploy from the exact approved commit with a clean app scope.',
          );
        }
        const [finalCanonicalHead, finalCoreAppStatus] = await Promise.all([
          readProjectGitCanonicalRemoteHead(repositoryRoot, gitRemote),
          readProjectGitStatus(coreAppRoot),
        ]);
        if (
          finalCanonicalHead.branch !== baseBranch
          || finalCanonicalHead.sha !== attestationCommit
          || !finalCoreAppStatus.repository
          || finalCoreAppStatus.branch !== baseBranch
          || finalCoreAppStatus.truncated
          || !finalCoreAppStatus.clean
          || finalCoreAppStatus.lastCommit?.hash !== attestationCommit
        ) {
          throw new Error(
            'Core UI canonical remote or live checkout changed after trusted deployment verification; approval remains parked for reconciliation.',
          );
        }
        finalizeDesignWorkflowDeliveryApproval(db, {
          ...delivery,
          status: 'deployed',
          error: null,
          updatedAt: Date.now(),
          target: {
            ...delivery.target,
            deployedCommit: attestationCommit,
            liveUrl: `${CORE_UI_TARGET_ORIGIN}/`,
            trustedDeploymentPids: trustedDeployment.pids,
          },
        }, runId);
      } else {
        delivery = recordWordPressPublishIntent(db, delivery.id, runId);
        const published = await publishWordPressDelivery(delivery);
        wordpressPublicationConfirmed = true;
        finalizeDesignWorkflowDeliveryApproval(db, published, runId);
      }
    } catch (error) {
      if (
        error instanceof WordPressPublishOutcomeUnknownError
        || error instanceof WordPressPublishReconciliationRequiredError
        || wordpressPublicationConfirmed
        || coreDeploymentObserved
        || (delivery ? deliveryRequiresReconciliation(delivery) : false)
      ) {
        const parked = parkDesignWorkflowDeliveryReconciliation(
          db,
          deliveryId,
          runId,
          error instanceof Error ? error.message : String(error),
        );
        if (parked) throw error;
      }
      const released = releaseDesignWorkflowDeliveryApproval(
        db,
        deliveryId,
        runId,
        error instanceof Error ? error.message : String(error),
        false,
      );
      if (released) queueCurrentTargetIfNeeded(projectId);
      throw error;
    }
    queueCurrentTargetIfNeeded(projectId);
    return initializeProjectUnlocked(projectId);
  }

  async function approveDelivery(
    projectId: string,
    deliveryId: string,
    implementationDigest: string,
    reservedRunId?: string,
  ): Promise<DesignWorkflowStatusResponse> {
    if (reservedRunId) {
      return approveDeliveryWithReservation(
        projectId,
        deliveryId,
        implementationDigest,
        reservedRunId,
      );
    }
    const candidate = getDesignWorkflowDelivery(db, deliveryId);
    if (candidate?.adapter === 'core-ui') {
      throw new Error(
        'Core UI approval must run through /approve so the reservation exists before deployment begins.',
      );
    }
    return withProjectLock(projectId, async () => {
      const runId = `direct-${randomUUID()}`;
      reserveDesignWorkflowDeliveryApproval(
        db,
        projectId,
        deliveryId,
        implementationDigest,
        runId,
      );
      ACTIVE_DESIGN_WORKFLOW_APPROVAL_RUNS.add(runId);
      try {
        return await approveDeliveryWithReservation(projectId, deliveryId, implementationDigest, runId);
      } finally {
        ACTIVE_DESIGN_WORKFLOW_APPROVAL_RUNS.delete(runId);
      }
    });
  }

  return {
    initializeProject,
    statusForProject,
    updateAll,
    publish,
    rollback,
    resume,
    markApplied,
    captureRunStart,
    completeRun,
    promptContext,
    readAppliedFile,
    approveDelivery,
  };
}
