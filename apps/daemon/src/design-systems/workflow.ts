import { createHash, randomUUID } from 'node:crypto';
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
  projectGitRevisionIsAncestor,
  publishProjectGitRevision,
  readProjectGitFileAtRevision,
  readProjectGitStatus,
} from '../services/project-git.js';
import {
  CORE_UI_PROJECT_ID,
  GRAND_SLAM_OFFER_PROJECT_ID,
  publishWordPressDelivery,
  stageCoreUiDelivery,
  stageWordPressDraftDelivery,
} from './delivery-adapters.js';

type SqliteDb = Database.Database;
type DbRow = Record<string, unknown>;

const IGNORED_DIRS = new Set([
  '.git', '.next', '.cache', '.turbo', '.open-design', 'node_modules', 'dist', 'build',
]);
const MAX_FILES = 10_000;
const HASH_MAX_BYTES = 1024 * 1024;

interface WorkflowFingerprint {
  size: number;
  mtimeMs: number;
  hash: string | null;
}

export type DesignWorkflowFileSnapshot = Map<string, WorkflowFingerprint>;

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
  `);
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
  const row = db.prepare(`SELECT ${DELIVERY_SELECT} FROM design_workflow_deliveries WHERE project_id = ? ORDER BY created_at DESC LIMIT 1`)
    .get(projectId) as DbRow | undefined;
  return row ? deliveryFromRow(row) : null;
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
      const existing = getDesignWorkflowSubscription(db, projectId)
        ?? initializeDesignWorkflowSubscription(db, projectId, revision, now);
      if (existing.pinnedSha) {
        db.prepare(`UPDATE design_workflow_subscriptions SET target_sha = ?, status = 'pinned', updated_at = ? WHERE project_id = ?`)
          .run(revision.sha, now, projectId);
      } else if (revision.classification === 'compatible') {
        db.prepare(`UPDATE design_workflow_subscriptions SET target_sha = ?, applied_sha = ?, status = 'updated_automatically', last_error = NULL, updated_at = ? WHERE project_id = ?`)
          .run(revision.sha, revision.sha, now, projectId);
      } else {
        db.prepare(`UPDATE design_workflow_subscriptions SET target_sha = ?, status = 'update_needed', last_error = NULL, updated_at = ? WHERE project_id = ?`)
          .run(revision.sha, now, projectId);
      }
    }
  });
  apply();
  return listDesignWorkflowSubscriptions(db, revision.designSystemId);
}

export function applyDesignWorkflowSubscription(
  db: SqliteDb,
  projectId: string,
  now = Date.now(),
): DesignWorkflowSubscription | null {
  db.prepare(`UPDATE design_workflow_subscriptions SET applied_sha = target_sha, pinned_sha = NULL, status = 'up_to_date', last_error = NULL, updated_at = ? WHERE project_id = ?`)
    .run(now, projectId);
  return getDesignWorkflowSubscription(db, projectId);
}

export function failDesignWorkflowSubscription(
  db: SqliteDb,
  projectId: string,
  error: string,
  appliedSha?: string,
  now = Date.now(),
): DesignWorkflowSubscription | null {
  db.prepare(`UPDATE design_workflow_subscriptions SET status = 'sync_failed', last_error = ?, applied_sha = COALESCE(?, applied_sha), updated_at = ? WHERE project_id = ?`)
    .run(error, appliedSha ?? null, now, projectId);
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
  db.prepare(`UPDATE design_workflow_subscriptions SET applied_sha = ?, pinned_sha = ?, status = 'pinned', last_error = NULL, updated_at = ? WHERE project_id = ?`)
    .run(sha, sha, now, projectId);
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
  db.prepare(`UPDATE design_workflow_subscriptions SET pinned_sha = NULL, target_sha = ?, applied_sha = COALESCE(?, applied_sha), status = ?, last_error = NULL, updated_at = ? WHERE project_id = ?`)
    .run(revision.sha, appliedSha ?? null, status, now, projectId);
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
}

interface CapturedWorkflowRun {
  projectId: string;
  root: string;
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
  markApplied(projectId: string): Promise<DesignWorkflowStatusResponse>;
  captureRunStart(runId: string, projectId: string): Promise<void>;
  completeRun(input: { runId: string; projectId: string; prompt: string; succeeded: boolean }): Promise<void>;
  promptContext(projectId: string, prompt: string): Promise<string>;
  readAppliedFile(projectId: string, filePath: string, useTarget?: boolean): Promise<string | null>;
  approveDelivery(projectId: string, deliveryId: string, implementationDigest: string): Promise<DesignWorkflowStatusResponse>;
}

function isSourceProject(project: WorkflowProject): boolean {
  return project.metadata?.importedFrom === 'design-system'
    && typeof project.designSystemId === 'string'
    && project.designSystemId.startsWith('user:');
}

function commandFromPrompt(prompt: string): string {
  return prompt.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
}

function approvalFromPrompt(prompt: string): { deliveryId: string; implementationDigest: string } | null {
  const parts = prompt.trim().split(/\s+/);
  if (parts[0]?.toLowerCase() !== '/approve' || parts.length < 3) return null;
  if (!/^[a-f0-9]{64}$/i.test(parts[2] ?? '')) return null;
  return { deliveryId: parts[1]!, implementationDigest: parts[2]! };
}

function safeDesignSystemSlug(designSystemId: string): string {
  return designSystemId.replace(/^user:/, '').replace(/[^a-zA-Z0-9._-]+/g, '-');
}

export function createDesignWorkflowService(deps: DesignWorkflowServiceDeps): DesignWorkflowService {
  const { db, projectsRoot, runtimeDataDir, getProject, listProjects, updateProject, resolveProjectDir } = deps;
  const capturedRuns = new Map<string, CapturedWorkflowRun>();

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

  function coreRepositoryRoot(project: WorkflowProject): string {
    const linkedDirs = Array.isArray(project.metadata?.linkedDirs)
      ? project.metadata.linkedDirs.filter((value): value is string => typeof value === 'string')
      : [];
    const root = linkedDirs.find((candidate) => fs.existsSync(path.join(candidate, '99_System', 'core-v2', 'package.json')));
    if (!root) throw new Error('Core UI delivery cannot find its linked Core repository.');
    return root;
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

  async function ensureCurrentRevision(source: WorkflowProject): Promise<DesignWorkflowRevision> {
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
      fanOutDesignWorkflowRevision(
        db,
        revision,
        subscriberIds(revision.designSystemId, source.id),
      );
    }
    return revision;
  }

  async function materializeRevision(
    project: WorkflowProject,
    source: WorkflowProject,
    revision: DesignWorkflowRevision,
    paths: string[],
  ): Promise<void> {
    const targetRoot = path.join(
      rootFor(project),
      '.open-design',
      'design-systems',
      safeDesignSystemSlug(revision.designSystemId),
    );
    const sourceRoot = rootFor(source);
    for (const relativePath of paths) {
      const content = await readProjectGitFileAtRevision(sourceRoot, revision.sha, relativePath);
      if (content == null) throw new Error(`Revision ${revision.shortSha} does not contain ${relativePath}.`);
      const destination = path.join(targetRoot, relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, content);
    }
    fs.mkdirSync(targetRoot, { recursive: true });
    fs.writeFileSync(path.join(targetRoot, 'revision.json'), `${JSON.stringify({
      designSystemId: revision.designSystemId,
      sourceProjectId: revision.sourceProjectId,
      sha: revision.sha,
      branch: revision.branch,
      changedPaths: revision.changedPaths,
      syncedAt: new Date().toISOString(),
    }, null, 2)}\n`);
  }

  function compatibleFiles(snapshot: DesignWorkflowFileSnapshot): string[] {
    return [...snapshot.keys()].filter((filePath) =>
      classifyDesignWorkflowChanges([filePath]) === 'compatible',
    );
  }

  async function initializeProject(projectId: string): Promise<DesignWorkflowStatusResponse> {
    const project = getProject(db, projectId);
    if (!project) throw new Error('Project not found.');
    const designSystemId = project.designSystemId;
    if (!designSystemId?.startsWith('user:')) {
      throw new Error('Choose a user design system before initializing the design workflow.');
    }
    const foundSource = sourceFor(designSystemId);
    if (!foundSource) throw new Error(`No design-system workspace is registered for ${designSystemId}.`);
    const source = await ensureSourceWorktree(foundSource);
    const revision = await ensureCurrentRevision(source);
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
    if (!previous || previous.designSystemId !== designSystemId) {
      const sourceFiles = compatibleFiles(snapshotDesignWorkflowFiles(rootFor(source)));
      try {
        await materializeRevision(project, source, revision, sourceFiles);
      } catch (error) {
        failDesignWorkflowSubscription(db, projectId, error instanceof Error ? error.message : String(error));
      }
    }
    const current = getDesignWorkflowSubscription(db, projectId)!;
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

  async function statusForProject(projectId: string): Promise<DesignWorkflowStatusResponse> {
    return initializeProject(projectId);
  }

  async function rollback(projectId: string, sha: string): Promise<DesignWorkflowStatusResponse> {
    const status = await initializeProject(projectId);
    if (status.role !== 'subscriber') throw new Error('Only asset projects can be rolled back.');
    const revision = getDesignWorkflowRevision(db, status.designSystemId, sha);
    if (!revision) throw new Error(`Revision ${sha} is not known for ${status.designSystemId}.`);
    const project = getProject(db, projectId)!;
    const source = getProject(db, status.sourceProjectId)!;
    await materializeRevision(project, source, revision, compatibleFiles(snapshotDesignWorkflowFiles(rootFor(source))));
    rollbackDesignWorkflowSubscription(db, projectId, sha);
    return initializeProject(projectId);
  }

  async function resume(projectId: string): Promise<DesignWorkflowStatusResponse> {
    const status = await initializeProject(projectId);
    if (status.role !== 'subscriber') throw new Error('Only asset projects can resume design-system updates.');
    resumeDesignWorkflowSubscription(db, projectId, status.currentRevision);
    if (status.currentRevision.classification === 'compatible') {
      const project = getProject(db, projectId)!;
      const source = getProject(db, status.sourceProjectId)!;
      await materializeRevision(project, source, status.currentRevision, status.currentRevision.changedPaths);
    }
    return initializeProject(projectId);
  }

  async function markApplied(projectId: string): Promise<DesignWorkflowStatusResponse> {
    const status = await initializeProject(projectId);
    if (status.role !== 'subscriber') throw new Error('Only asset projects apply upstream revisions.');
    applyDesignWorkflowSubscription(db, projectId);
    return initializeProject(projectId);
  }

  async function updateAll(projectId: string): Promise<DesignWorkflowUpdateAllResponse> {
    const status = await initializeProject(projectId);
    if (status.role !== 'source') throw new Error('/update-all must run from the design-system project.');
    const subscriptions = listDesignWorkflowSubscriptions(db, status.designSystemId);
    for (const subscription of subscriptions) {
      if (subscription.status !== 'update_needed' && subscription.status !== 'sync_failed') continue;
      updateProject(db, subscription.projectId, { pendingPrompt: '/update' });
    }
    return { designSystemId: status.designSystemId, sourceProjectId: status.sourceProjectId, subscriptions };
  }

  async function publish(projectId: string): Promise<DesignWorkflowStatusResponse> {
    const status = await initializeProject(projectId);
    if (status.role !== 'source') throw new Error('Publish is available only in the design-system project.');
    const source = getProject(db, status.sourceProjectId);
    if (!source) throw new Error('Design-system project not found.');
    await publishProjectGitRevision(rootFor(source), status.currentRevision.sha, 'main');
    return initializeProject(projectId);
  }

  async function captureRunStart(runId: string, projectId: string): Promise<void> {
    const foundProject = getProject(db, projectId);
    if (!foundProject || !isSourceProject(foundProject)) return;
    const project = await ensureSourceWorktree(foundProject);
    const root = rootFor(project);
    const git = await readProjectGitStatus(root);
    if (!git.repository) return;
    capturedRuns.set(runId, {
      projectId,
      root,
      before: snapshotDesignWorkflowFiles(root),
      dirtyBefore: new Set(git.changes.flatMap((change) => [change.path, change.originalPath].filter((item): item is string => Boolean(item)))),
    });
  }

  async function completeRun(input: { runId: string; projectId: string; prompt: string; succeeded: boolean }): Promise<void> {
    const captured = capturedRuns.get(input.runId);
    capturedRuns.delete(input.runId);
    if (!input.succeeded) return;
    if (commandFromPrompt(input.prompt) === '/approve') {
      const approval = approvalFromPrompt(input.prompt);
      if (!approval) throw new Error('Use /approve <delivery-id> <implementation-digest>.');
      await approveDelivery(input.projectId, approval.deliveryId, approval.implementationDigest);
      return;
    }
    if (commandFromPrompt(input.prompt) === '/push') {
      const status = await initializeProject(input.projectId);
      if (status.role !== 'subscriber' || !status.subscription) {
        throw new Error('/push is available only in subscribed asset projects.');
      }
      if (status.subscription.appliedSha !== status.subscription.targetSha || status.subscription.status === 'update_needed') {
        throw new Error('Run /update successfully before /push so the implementation matches the target design revision.');
      }
      try {
        const project = getProject(db, input.projectId)!;
        const projectRoot = rootFor(project);
        const delivery = input.projectId === CORE_UI_PROJECT_ID
          ? stageCoreUiDelivery({
              projectRoot,
              revisionSha: status.subscription.appliedSha,
              runId: input.runId,
            })
          : input.projectId === GRAND_SLAM_OFFER_PROJECT_ID
            ? await stageWordPressDraftDelivery({
                projectRoot,
                revisionSha: status.subscription.appliedSha,
                runId: input.runId,
                priorDelivery: latestDesignWorkflowDelivery(db, input.projectId),
              })
            : null;
        if (!delivery) throw new Error('This asset project does not have a live-target adapter yet.');
        saveDesignWorkflowDelivery(db, delivery);
      } catch (error) {
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
      if (getDesignWorkflowSubscription(db, input.projectId)) await markApplied(input.projectId);
      return;
    }
    if (commandFromPrompt(input.prompt) === '/init') {
      await initializeProject(input.projectId);
    }
    if (commandFromPrompt(input.prompt) === '/update-all') {
      await updateAll(input.projectId);
      return;
    }
    if (commandFromPrompt(input.prompt) === '/publish') {
      await publish(input.projectId);
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
    const classification = classifyDesignWorkflowChanges(changedPaths, deletedPaths);
    const branch = `open-design/run-${input.runId.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 32)}`;
    const committed = await createAndPushProjectGitRevision(
      captured.root,
      branch,
      `Open Design: update ${project.name} (${input.runId.slice(0, 8)})`,
      changedPaths,
    );
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
    const subscribers = subscriberIds(revision.designSystemId, project.id);
    const previousByProject = new Map(
      listDesignWorkflowSubscriptions(db, revision.designSystemId)
        .map((subscription) => [subscription.projectId, subscription.appliedSha]),
    );
    fanOutDesignWorkflowRevision(db, revision, subscribers);
    if (classification === 'compatible') {
      for (const subscriberId of subscribers) {
        const subscription = getDesignWorkflowSubscription(db, subscriberId);
        if (subscription?.status === 'pinned') continue;
        const subscriber = getProject(db, subscriberId);
        if (!subscriber) continue;
        try {
          await materializeRevision(subscriber, project, revision, changedPaths);
        } catch (error) {
          failDesignWorkflowSubscription(
            db,
            subscriberId,
            error instanceof Error ? error.message : String(error),
            previousByProject.get(subscriberId),
          );
        }
      }
    }
  }

  async function readAppliedFile(projectId: string, filePath: string, useTarget = false): Promise<string | null> {
    const status = await initializeProject(projectId);
    const sha = status.subscription
      ? (useTarget ? status.subscription.targetSha : status.subscription.appliedSha)
      : status.currentRevision.sha;
    const source = getProject(db, status.sourceProjectId);
    if (!source) return null;
    const content = await readProjectGitFileAtRevision(rootFor(source), sha, filePath);
    return content?.toString('utf8') ?? null;
  }

  async function promptContext(projectId: string, prompt: string): Promise<string> {
    const status = await initializeProject(projectId);
    const subscription = status.subscription;
    if (!subscription) {
      return [
        `Design workflow source revision: ${status.currentRevision.shortSha} (${status.currentRevision.branch ?? 'detached'}). Successful file-changing runs are committed to an isolated branch and pushed to origin automatically.`,
        commandFromPrompt(prompt) === '/publish'
          ? 'This is an explicit Publish command. Do not edit files. Open Design will fast-forward the exact current revision to origin/main after this run succeeds.'
          : commandFromPrompt(prompt) === '/update-all'
            ? 'This is an explicit /update-all command. Do not edit files. Open Design will queue /update in every subscriber that still needs structural reconciliation.'
            : '',
      ].filter(Boolean).join('\n');
    }
    const updateCommand = commandFromPrompt(prompt) === '/update';
    const materializedRoot = `.open-design/design-systems/${safeDesignSystemSlug(status.designSystemId)}`;
    const command = commandFromPrompt(prompt);
    const approval = approvalFromPrompt(prompt);
    const currentDelivery = status.delivery;
    const deliveryInstructions = command === '/push'
      ? projectId === CORE_UI_PROJECT_ID
        ? 'This is a Core UI /push run. Work only in an isolated codex/ branch and Core worktree targeting 99_System/core-v2; run its tests, build, and browser QA; do not merge, restart the live services, or deploy. Write .open-design/delivery.json with adapter "core-ui", branch, commit, baseSha, previewUrl, and checks so Open Design can bind approval to the exact preview.'
        : projectId === GRAND_SLAM_OFFER_PROJECT_ID
          ? 'This is a Grand Slam Offer /push run. Finish and locally QA grand-slam-offer-prototype-en.html, then write .open-design/delivery.json with adapter "wordpress-draft", entryFile, title, and slug. After the run, Open Design will checkpoint and create or update only the dedicated unpublished WordPress draft. Never publish it from the agent run.'
          : 'This project has no configured /push delivery adapter.'
      : command === '/approve'
        ? !approval || !currentDelivery
          ? 'Approval command is invalid. Use /approve <delivery-id> <implementation-digest> exactly as shown in Design workflow status. Do not deploy anything.'
          : approval.deliveryId !== currentDelivery.id || approval.implementationDigest !== currentDelivery.implementationDigest
            ? 'Approval does not match the latest preview delivery and digest. Do not deploy anything.'
            : currentDelivery.adapter === 'core-ui'
              ? `This is explicit approval for Core UI delivery ${currentDelivery.id}, digest ${currentDelivery.implementationDigest}. Deploy only commit ${String(currentDelivery.target.commit)} from branch ${String(currentDelivery.target.branch)}. Preserve unrelated work, verify the branch and commit, merge the exact commit to main and push, run Core's full release gate and build, restart or kickstart the actual com.core.core-v2-api and com.core.core-v2-web system services, and verify the real localhost and tailnet routes. Do not substitute another commit or a preview server.`
              : `This is explicit approval for WordPress delivery ${currentDelivery.id}, digest ${currentDelivery.implementationDigest}. Do not edit or publish the page yourself. Open Design will re-read the exact draft and publish it only after this run succeeds.`
        : '';
    return [
      `Design workflow status: ${subscription.status}.`,
      `Applied revision: ${subscription.appliedSha.slice(0, 8)}. Target revision: ${subscription.targetSha.slice(0, 8)}.`,
      `The exact applied token and asset snapshot is materialized at ${materializedRoot}.`,
      subscription.status === 'update_needed'
        ? updateCommand
          ? 'This is an explicit /update run. Reconcile the asset project to the target revision, preserve local additive extensions, and validate the result.'
          : 'A structural upstream change is waiting. Do not claim it is applied; tell the user to run /update when they want the agent to reconcile it.'
        : 'Use the applied design-system revision as the canonical upstream source; local project additions may extend it but must not overwrite it.',
      subscription.status === 'pinned' ? 'Automatic updates are pinned after rollback until Resume is requested.' : '',
      deliveryInstructions,
    ].filter(Boolean).join('\n');
  }

  async function approveDelivery(
    projectId: string,
    deliveryId: string,
    implementationDigest: string,
  ): Promise<DesignWorkflowStatusResponse> {
    const delivery = getDesignWorkflowDelivery(db, deliveryId);
    if (!delivery || delivery.projectId !== projectId) throw new Error('Delivery preview not found.');
    if (delivery.implementationDigest !== implementationDigest) {
      throw new Error('Approval digest does not match the previewed implementation.');
    }
    if (delivery.status !== 'ready_for_approval') throw new Error('Only a ready preview can be approved.');
    if (delivery.expiresAt < Date.now()) throw new Error('Delivery approval expired; run /push again.');
    if (delivery.adapter === 'core-ui') {
      const project = getProject(db, projectId);
      if (!project) throw new Error('Core UI project not found.');
      const repositoryRoot = coreRepositoryRoot(project);
      const commit = typeof delivery.target.commit === 'string' ? delivery.target.commit : '';
      const onRemoteMain = await projectGitRevisionIsAncestor(repositoryRoot, commit, 'origin/main', {
        fetchOriginBranch: 'main',
      });
      const inLiveCheckout = await projectGitRevisionIsAncestor(repositoryRoot, commit, 'HEAD');
      if (!onRemoteMain || !inLiveCheckout) {
        throw new Error('Core UI approval has not deployed the exact preview commit to both origin/main and the live Core checkout.');
      }
      const live = await fetch('http://127.0.0.1:3131/', { signal: AbortSignal.timeout(5_000) }).catch(() => null);
      if (!live?.ok) throw new Error('Core UI live route did not pass its post-deploy probe.');
      saveDesignWorkflowDelivery(db, {
        ...delivery,
        status: 'deployed',
        updatedAt: Date.now(),
        target: { ...delivery.target, deployedCommit: commit, liveUrl: 'https://studio-macbook-server.taila20f18.ts.net:8444/' },
      });
      return initializeProject(projectId);
    }
    saveDesignWorkflowDelivery(db, await publishWordPressDelivery(delivery));
    return initializeProject(projectId);
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
