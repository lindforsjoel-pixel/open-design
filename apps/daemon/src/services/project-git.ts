import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  ProjectGitChange,
  ProjectGitChangeKind,
  ProjectGitCommitResponse,
  ProjectGitCommitSummary,
  ProjectGitStatusResponse,
} from '@open-design/contracts';

const MAX_CHANGED_FILES = 500;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

interface GitCommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  missing: boolean;
}

export interface ProjectGitCanonicalRemoteHead {
  branch: string;
  sha: string;
}

export interface ProjectGitCanonicalDeploymentInput {
  expectedRemoteUrl: string;
  baseBranch: string;
  baseCommit: string;
  targetCommit: string;
  scopePath: string;
}

export interface QuarantineProjectGitRunStateInput {
  projectId: string;
  runId: string;
  baseSha: string;
  baseBranch: string;
}

export interface QuarantineProjectGitRunStateResult {
  recoveryBranch: string | null;
  recoverySha: string | null;
  status: ProjectGitStatusResponse;
}

export class ProjectGitError extends Error {
  constructor(
    message: string,
    readonly code: 'GIT_NOT_AVAILABLE' | 'NOT_GIT_REPOSITORY' | 'INVALID_GIT_REQUEST' | 'GIT_COMMAND_FAILED',
  ) {
    super(message);
    this.name = 'ProjectGitError';
  }
}

function runGit(cwd: string, args: string[]): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER_BYTES,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          LC_ALL: 'C',
        },
      },
      (error, stdout, stderr) => {
        const execError = error as NodeJS.ErrnoException | null;
        resolve({
          ok: error == null,
          stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
          stderr: typeof stderr === 'string' ? stderr : String(stderr ?? ''),
          missing: execError?.code === 'ENOENT',
        });
      },
    );
  });
}

async function runGitWithIsolatedConfig(
  args: string[],
  canonicalRemoteUrl: string,
  sourceRepositoryRoot?: string,
): Promise<GitCommandResult> {
  const isolatedRoot = await mkdtemp(path.join(tmpdir(), 'open-design-git-remote-'));
  const emptyConfigPath = path.join(isolatedRoot, 'empty.gitconfig');
  await writeFile(emptyConfigPath, '', { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const normalizedKey = key.toUpperCase();
    if (normalizedKey.startsWith('GIT_')) continue;
    env[key] = value;
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_SYSTEM = emptyConfigPath;
  env.GIT_CONFIG_GLOBAL = emptyConfigPath;
  env.GIT_CONFIG_COUNT = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  if (canonicalRemoteUsesSsh(canonicalRemoteUrl)) {
    env.GIT_SSH_COMMAND = [
      'ssh',
      '-F /dev/null',
      '-o BatchMode=yes',
      '-o StrictHostKeyChecking=yes',
      '-o ProxyCommand=none',
      '-o ProxyJump=none',
      '-o ControlMaster=no',
      '-o ControlPath=none',
      '-o ControlPersist=no',
      '-o ForwardAgent=no',
      '-o ClearAllForwardings=yes',
    ].join(' ');
    env.GIT_SSH_VARIANT = 'ssh';
  }
  env.LC_ALL = 'C';

  try {
    const execute = (
      cwd: string,
      commandArgs: string[],
    ): Promise<GitCommandResult> => new Promise((resolve) => {
      execFile(
        'git',
        commandArgs,
        {
          cwd,
          encoding: 'utf8',
          maxBuffer: MAX_BUFFER_BYTES,
          env,
        },
        (error, stdout, stderr) => {
          const execError = error as NodeJS.ErrnoException | null;
          resolve({
            ok: error == null,
            stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
            stderr: typeof stderr === 'string' ? stderr : String(stderr ?? ''),
            missing: execError?.code === 'ENOENT',
          });
        },
      );
    });
    let commandRoot = isolatedRoot;
    if (sourceRepositoryRoot) {
      const pushRepository = path.join(isolatedRoot, 'push.git');
      const cloned = await execute(isolatedRoot, [
        'clone',
        '--bare',
        '--shared',
        '--no-tags',
        '--',
        sourceRepositoryRoot,
        pushRepository,
      ]);
      if (!cloned.ok) return cloned;
      commandRoot = pushRepository;
    }
    return await execute(commandRoot, args);
  } finally {
    await rm(isolatedRoot, { recursive: true, force: true });
  }
}

function runGitBuffer(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: MAX_BUFFER_BYTES, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } },
      (error, stdout, stderr) => resolve({
        ok: error == null,
        stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ''),
        stderr: Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? ''),
      }),
    );
  });
}

function changeKind(indexStatus: string, worktreeStatus: string): ProjectGitChangeKind {
  const pair = `${indexStatus}${worktreeStatus}`;
  if (pair === '??') return 'untracked';
  if (pair.includes('U') || pair === 'AA' || pair === 'DD') return 'conflicted';
  const status = indexStatus !== ' ' ? indexStatus : worktreeStatus;
  switch (status) {
    case 'A': return 'added';
    case 'D': return 'deleted';
    case 'R': return 'renamed';
    case 'C': return 'copied';
    case 'T': return 'type-changed';
    default: return 'modified';
  }
}

function projectRelativePath(repoPath: string, projectPrefix: string): string | null {
  const normalized = repoPath.replace(/\\/g, '/');
  if (!projectPrefix) return normalized;
  const normalizedPrefix = projectPrefix.replace(/\\/g, '/').replace(/\/$/, '');
  if (!normalized.startsWith(`${normalizedPrefix}/`)) return null;
  return normalized.slice(normalizedPrefix.length + 1);
}

export function parseProjectGitStatus(
  output: string,
  projectPrefix: string,
): { changes: ProjectGitChange[]; truncated: boolean } {
  const records = output.split('\0');
  const changes: ProjectGitChange[] = [];
  let truncated = false;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const indexStatus = record[0] ?? ' ';
    const worktreeStatus = record[1] ?? ' ';
    const repoPath = record.slice(3);
    const renameOrCopy = indexStatus === 'R' || indexStatus === 'C'
      || worktreeStatus === 'R' || worktreeStatus === 'C';
    const originalRepoPath = renameOrCopy ? records[index + 1] : undefined;
    if (renameOrCopy) index += 1;

    const relativePath = projectRelativePath(repoPath, projectPrefix);
    if (relativePath == null) continue;
    const originalPath = originalRepoPath
      ? projectRelativePath(originalRepoPath, projectPrefix) ?? undefined
      : undefined;
    const kind = changeKind(indexStatus, worktreeStatus);
    if (changes.length >= MAX_CHANGED_FILES) {
      truncated = true;
      continue;
    }
    changes.push({
      path: relativePath,
      ...(originalPath ? { originalPath } : {}),
      kind,
      indexStatus,
      worktreeStatus,
      staged: indexStatus !== ' ' && indexStatus !== '?',
      unstaged: worktreeStatus !== ' ' || indexStatus === '?',
      conflicted: kind === 'conflicted',
    });
  }

  return { changes, truncated };
}

function parseCommitSummary(output: string): ProjectGitCommitSummary | null {
  const [hash, shortHash, subject, author, authoredAt] = output.trim().split('\0');
  if (!hash || !shortHash) return null;
  return {
    hash,
    shortHash,
    subject: subject ?? '',
    author: author ?? '',
    authoredAt: authoredAt ?? '',
  };
}

async function readCommitSummary(projectRoot: string): Promise<ProjectGitCommitSummary | null> {
  const result = await runGit(projectRoot, [
    'log',
    '-1',
    '--format=%H%x00%h%x00%s%x00%an%x00%aI',
  ]);
  return result.ok ? parseCommitSummary(result.stdout) : null;
}

export async function readProjectGitStatus(projectRoot: string): Promise<ProjectGitStatusResponse> {
  const canonicalProjectRoot = await realpath(projectRoot);
  const rootResult = await runGit(canonicalProjectRoot, ['rev-parse', '--show-toplevel']);
  if (rootResult.missing) {
    return {
      available: false,
      repository: false,
      projectRoot,
      repositoryRoot: null,
      branch: null,
      detached: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      clean: true,
      changes: [],
      truncated: false,
      lastCommit: null,
      error: 'Git is not installed or is not available on PATH.',
    };
  }
  if (!rootResult.ok) {
    return {
      available: true,
      repository: false,
      projectRoot,
      repositoryRoot: null,
      branch: null,
      detached: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      clean: true,
      changes: [],
      truncated: false,
      lastCommit: null,
    };
  }

  const repositoryRoot = path.resolve(rootResult.stdout.trim());
  const projectPrefix = path.relative(repositoryRoot, canonicalProjectRoot);
  if (projectPrefix === '..' || projectPrefix.startsWith(`..${path.sep}`) || path.isAbsolute(projectPrefix)) {
    throw new ProjectGitError('Project directory is outside the detected Git repository.', 'GIT_COMMAND_FAILED');
  }

  const [statusResult, branchResult, upstreamResult, lastCommit] = await Promise.all([
    runGit(canonicalProjectRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']),
    runGit(canonicalProjectRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']),
    runGit(canonicalProjectRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
    readCommitSummary(canonicalProjectRoot),
  ]);
  if (!statusResult.ok) {
    throw new ProjectGitError(statusResult.stderr.trim() || 'Unable to read Git status.', 'GIT_COMMAND_FAILED');
  }

  const parsed = parseProjectGitStatus(statusResult.stdout, projectPrefix);
  const upstream = upstreamResult.ok ? upstreamResult.stdout.trim() || null : null;
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = await runGit(canonicalProjectRoot, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`]);
    if (counts.ok) {
      const [aheadRaw, behindRaw] = counts.stdout.trim().split(/\s+/);
      ahead = Number.parseInt(aheadRaw ?? '0', 10) || 0;
      behind = Number.parseInt(behindRaw ?? '0', 10) || 0;
    }
  }

  const branch = branchResult.ok ? branchResult.stdout.trim() || null : null;
  return {
    available: true,
    repository: true,
    projectRoot,
    repositoryRoot,
    branch,
    detached: branch == null && lastCommit != null,
    upstream,
    ahead,
    behind,
    clean: parsed.changes.length === 0,
    changes: parsed.changes,
    truncated: parsed.truncated,
    lastCommit,
  };
}

export async function initializeProjectGit(projectRoot: string): Promise<ProjectGitStatusResponse> {
  const current = await readProjectGitStatus(projectRoot);
  if (!current.available) {
    throw new ProjectGitError(current.error ?? 'Git is unavailable.', 'GIT_NOT_AVAILABLE');
  }
  if (current.repository) return current;
  const initialized = await runGit(projectRoot, ['init']);
  if (!initialized.ok) {
    throw new ProjectGitError(initialized.stderr.trim() || 'Unable to initialize Git.', 'GIT_COMMAND_FAILED');
  }
  return readProjectGitStatus(projectRoot);
}

function validateCommitPaths(paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_CHANGED_FILES) {
    throw new ProjectGitError('Select between 1 and 500 changed files.', 'INVALID_GIT_REQUEST');
  }
  const unique = new Set<string>();
  for (const value of paths) {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || path.isAbsolute(value)) {
      throw new ProjectGitError('Commit paths must be project-relative files.', 'INVALID_GIT_REQUEST');
    }
    const normalized = value.replace(/\\/g, '/');
    if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
      throw new ProjectGitError('Commit paths cannot leave the project directory.', 'INVALID_GIT_REQUEST');
    }
    unique.add(normalized);
  }
  return [...unique];
}

export async function commitProjectGitChanges(
  projectRoot: string,
  messageInput: unknown,
  pathsInput: unknown,
): Promise<ProjectGitCommitResponse> {
  const message = typeof messageInput === 'string' ? messageInput.trim() : '';
  if (!message || message.length > 500 || /[\0\r\n]/.test(message)) {
    throw new ProjectGitError('Commit message must be a single line between 1 and 500 characters.', 'INVALID_GIT_REQUEST');
  }
  const selectedPaths = validateCommitPaths(pathsInput);
  const before = await readProjectGitStatus(projectRoot);
  if (!before.available) throw new ProjectGitError(before.error ?? 'Git is unavailable.', 'GIT_NOT_AVAILABLE');
  if (!before.repository) throw new ProjectGitError('Project is not a Git repository.', 'NOT_GIT_REPOSITORY');

  const changesByPath = new Map(before.changes.map((change) => [change.path, change]));
  const selectedChanges = selectedPaths.map((selectedPath) => changesByPath.get(selectedPath));
  if (selectedChanges.some((change) => change == null)) {
    throw new ProjectGitError('Every selected path must be present in the current project Git status.', 'INVALID_GIT_REQUEST');
  }
  if (selectedChanges.some((change) => change?.conflicted)) {
    throw new ProjectGitError('Resolve conflicted files before committing.', 'INVALID_GIT_REQUEST');
  }

  const commitPaths = [...new Set(selectedChanges.flatMap((change) => [
    change?.path,
    change?.originalPath,
  ]).filter((value): value is string => Boolean(value)))];
  const untrackedPaths = selectedChanges
    .filter((change) => change?.kind === 'untracked')
    .map((change) => change?.path)
    .filter((value): value is string => Boolean(value));

  if (untrackedPaths.length > 0) {
    const intent = await runGit(projectRoot, ['--literal-pathspecs', 'add', '--intent-to-add', '--', ...untrackedPaths]);
    if (!intent.ok) {
      throw new ProjectGitError(intent.stderr.trim() || 'Unable to prepare untracked files.', 'GIT_COMMAND_FAILED');
    }
  }

  const committed = await runGit(projectRoot, ['--literal-pathspecs', 'commit', '--only', '-m', message, '--', ...commitPaths]);
  if (!committed.ok) {
    if (untrackedPaths.length > 0) {
      await runGit(projectRoot, ['--literal-pathspecs', 'rm', '--cached', '--force', '--ignore-unmatch', '--', ...untrackedPaths]);
    }
    throw new ProjectGitError(committed.stderr.trim() || committed.stdout.trim() || 'Git commit failed.', 'GIT_COMMAND_FAILED');
  }

  const commit = await readCommitSummary(projectRoot);
  if (!commit) {
    throw new ProjectGitError('Commit succeeded but its summary could not be read.', 'GIT_COMMAND_FAILED');
  }
  return { commit, status: await readProjectGitStatus(projectRoot) };
}

function validateBranchName(branchInput: unknown): string {
  const branch = typeof branchInput === 'string' ? branchInput.trim() : '';
  if (!branch || branch.length > 200 || branch.startsWith('-') || /[\0\r\n\s~^:?*\\\[]/.test(branch)) {
    throw new ProjectGitError('Revision branch name is invalid.', 'INVALID_GIT_REQUEST');
  }
  return branch;
}

function validateRevisionSha(shaInput: unknown): string {
  const sha = typeof shaInput === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(shaInput)
    ? shaInput
    : '';
  if (!sha) throw new ProjectGitError('Revision SHA is invalid.', 'INVALID_GIT_REQUEST');
  return sha;
}

function validateRevisionRef(refInput: unknown): string {
  const ref = typeof refInput === 'string' ? refInput : '';
  if (
    !ref
    || ref.length > 1024
    || ref.startsWith('-')
    || !/^[a-zA-Z0-9_./-]+$/.test(ref)
    || ref.includes('..')
    || ref.includes('//')
    || ref.endsWith('/')
    || ref.endsWith('.')
  ) {
    throw new ProjectGitError('Revision verification request is invalid.', 'INVALID_GIT_REQUEST');
  }
  return ref;
}

function canonicalRemoteUsesSsh(remoteUrl: string): boolean {
  return /^ssh:\/\//i.test(remoteUrl) || /^[^/@:\s]+@[^/:\s]+:.+$/.test(remoteUrl);
}

function validateCanonicalRemoteUrl(urlInput: unknown): string {
  const url = typeof urlInput === 'string' ? urlInput : '';
  if (
    !url
    || url.length > 4096
    || url !== url.trim()
    || url.startsWith('-')
    || /[\0\r\n]/.test(url)
  ) {
    throw new ProjectGitError('Canonical remote URL is invalid.', 'INVALID_GIT_REQUEST');
  }
  return url;
}

function validateRecoveryIdentifier(valueInput: unknown, label: string): string {
  const value = typeof valueInput === 'string' ? valueInput.trim() : '';
  if (!value || value.length > 64 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
    throw new ProjectGitError(`${label} is invalid.`, 'INVALID_GIT_REQUEST');
  }
  return value;
}

function recoveryCommitMessage(
  projectId: string,
  runId: string,
  baseBranch: string,
  baseSha: string,
): string {
  return [
    `Preserve failed Open Design run ${runId}`,
    '',
    `Open-Design-Recovery-Project: ${projectId}`,
    `Open-Design-Recovery-Run: ${runId}`,
    `Open-Design-Recovery-Base-Branch: ${baseBranch}`,
    `Open-Design-Recovery-Base-SHA: ${baseSha}`,
  ].join('\n');
}

async function recoveryCommitMatchesRun(
  repositoryRoot: string,
  recoverySha: string,
  projectId: string,
  runId: string,
  baseBranch: string,
  baseSha: string,
): Promise<boolean> {
  const result = await runGit(repositoryRoot, ['show', '-s', '--format=%B', recoverySha]);
  if (!result.ok) return false;
  const requiredTrailers = recoveryCommitMessage(projectId, runId, baseBranch, baseSha)
    .split('\n')
    .slice(2);
  const messageLines = new Set(result.stdout.trimEnd().split('\n'));
  return requiredTrailers.every((line) => messageLines.has(line));
}

export async function quarantineProjectGitRunState(
  projectRoot: string,
  input: QuarantineProjectGitRunStateInput,
): Promise<QuarantineProjectGitRunStateResult> {
  const projectId = validateRecoveryIdentifier(input?.projectId, 'Project ID');
  const runId = validateRecoveryIdentifier(input?.runId, 'Run ID');
  const baseBranch = validateBranchName(input?.baseBranch);
  const requestedBaseSha = validateRevisionSha(input?.baseSha);
  const recoveryBranch = `open-design/recovery-${projectId}-${runId}`;
  const recoveryRef = `refs/heads/${recoveryBranch}`;
  if (recoveryBranch === baseBranch) {
    throw new ProjectGitError('The recovery branch must differ from the captured branch.', 'INVALID_GIT_REQUEST');
  }

  const before = await readProjectGitStatus(projectRoot);
  if (!before.available) throw new ProjectGitError(before.error ?? 'Git is unavailable.', 'GIT_NOT_AVAILABLE');
  if (!before.repository || !before.repositoryRoot) {
    throw new ProjectGitError('Project is not a Git repository.', 'NOT_GIT_REPOSITORY');
  }
  const [canonicalProjectRoot, canonicalRepositoryRoot] = await Promise.all([
    realpath(projectRoot),
    realpath(before.repositoryRoot),
  ]);
  if (canonicalProjectRoot !== canonicalRepositoryRoot) {
    throw new ProjectGitError(
      'Failed-run recovery is only available for a managed worktree rooted at the Git repository.',
      'INVALID_GIT_REQUEST',
    );
  }
  const validBaseBranch = await runGit(canonicalRepositoryRoot, ['check-ref-format', '--branch', baseBranch]);
  if (!validBaseBranch.ok) {
    throw new ProjectGitError('Captured branch name is invalid.', 'INVALID_GIT_REQUEST');
  }
  const resolvedBase = await runGit(canonicalRepositoryRoot, [
    'rev-parse',
    '--verify',
    `${requestedBaseSha}^{commit}`,
  ]);
  const baseSha = resolvedBase.stdout.trim();
  if (!resolvedBase.ok || baseSha.toLowerCase() !== requestedBaseSha.toLowerCase()) {
    throw new ProjectGitError('Captured revision is not an available commit.', 'INVALID_GIT_REQUEST');
  }

  const existingRecovery = await runGit(canonicalRepositoryRoot, [
    'rev-parse',
    '--verify',
    `${recoveryRef}^{commit}`,
  ]);
  let recoverySha = existingRecovery.ok ? existingRecovery.stdout.trim() : '';
  if (
    recoverySha
    && !await recoveryCommitMatchesRun(
      canonicalRepositoryRoot,
      recoverySha,
      projectId,
      runId,
      baseBranch,
      baseSha,
    )
  ) {
    throw new ProjectGitError(
      `Recovery branch ${recoveryBranch} already exists for different run state.`,
      'GIT_COMMAND_FAILED',
    );
  }

  const currentHeadResult = await runGit(canonicalRepositoryRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!currentHeadResult.ok) {
    throw new ProjectGitError('The managed worktree does not have a current commit.', 'GIT_COMMAND_FAILED');
  }
  const currentHead = currentHeadResult.stdout.trim();
  if (before.branch === baseBranch && before.clean && currentHead === baseSha) {
    return {
      recoveryBranch: recoverySha ? recoveryBranch : null,
      recoverySha: recoverySha || null,
      status: before,
    };
  }

  const untracked = await runGit(canonicalRepositoryRoot, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    '.',
  ]);
  if (!untracked.ok) {
    throw new ProjectGitError(
      untracked.stderr.trim() || 'Unable to inspect untracked failed-run state.',
      'GIT_COMMAND_FAILED',
    );
  }
  const embeddedRepositories = untracked.stdout
    .split('\0')
    .filter((entry) => entry.endsWith('/'));
  if (embeddedRepositories.length > 0) {
    throw new ProjectGitError(
      `Failed-run recovery cannot safely capture untracked embedded Git repositories: ${
        embeddedRepositories.join(', ')
      }`,
      'GIT_COMMAND_FAILED',
    );
  }

  const staged = await runGit(canonicalRepositoryRoot, [
    '--literal-pathspecs',
    'add',
    '--all',
    '--',
    '.',
  ]);
  if (!staged.ok) {
    throw new ProjectGitError(
      staged.stderr.trim() || 'Unable to stage failed-run state for recovery.',
      'GIT_COMMAND_FAILED',
    );
  }
  const snapshotTreeResult = await runGit(canonicalRepositoryRoot, ['write-tree']);
  if (!snapshotTreeResult.ok) {
    throw new ProjectGitError(
      snapshotTreeResult.stderr.trim() || 'Unable to snapshot failed-run state.',
      'GIT_COMMAND_FAILED',
    );
  }
  const snapshotTree = snapshotTreeResult.stdout.trim();

  let reuseExistingRecovery = false;
  if (recoverySha) {
    const [existingTree, containsCurrentHead] = await Promise.all([
      runGit(canonicalRepositoryRoot, ['rev-parse', '--verify', `${recoverySha}^{tree}`]),
      runGit(canonicalRepositoryRoot, ['merge-base', '--is-ancestor', currentHead, recoverySha]),
    ]);
    reuseExistingRecovery = existingTree.ok
      && existingTree.stdout.trim() === snapshotTree
      && containsCurrentHead.ok;
  }

  if (!reuseExistingRecovery) {
    const parents = recoverySha ? [recoverySha] : [];
    if (!recoverySha) {
      parents.push(currentHead);
    } else {
      const currentAlreadyPreserved = await runGit(
        canonicalRepositoryRoot,
        ['merge-base', '--is-ancestor', currentHead, recoverySha],
      );
      if (!currentAlreadyPreserved.ok && currentHead !== recoverySha) parents.push(currentHead);
    }
    const commitArgs = [
      '-c',
      'user.name=Open Design Recovery',
      '-c',
      'user.email=open-design-recovery@example.invalid',
      '-c',
      'commit.gpgSign=false',
      'commit-tree',
      snapshotTree,
    ];
    for (const parentSha of parents) commitArgs.push('-p', parentSha);
    commitArgs.push('-m', recoveryCommitMessage(projectId, runId, baseBranch, baseSha));
    const recoveryCommit = await runGit(canonicalRepositoryRoot, commitArgs);
    if (!recoveryCommit.ok) {
      throw new ProjectGitError(
        recoveryCommit.stderr.trim() || 'Unable to commit failed-run recovery state.',
        'GIT_COMMAND_FAILED',
      );
    }
    const nextRecoverySha = recoveryCommit.stdout.trim();
    validateRevisionSha(nextRecoverySha);
    const expectedOldSha = recoverySha || '0'.repeat(nextRecoverySha.length);
    const updated = await runGit(canonicalRepositoryRoot, [
      'update-ref',
      recoveryRef,
      nextRecoverySha,
      expectedOldSha,
    ]);
    if (!updated.ok) {
      throw new ProjectGitError(
        updated.stderr.trim() || `Unable to update recovery branch ${recoveryBranch}.`,
        'GIT_COMMAND_FAILED',
      );
    }
    recoverySha = nextRecoverySha;
  }

  const resetCurrent = await runGit(canonicalRepositoryRoot, ['reset', '--hard', 'HEAD']);
  if (!resetCurrent.ok) {
    throw new ProjectGitError(
      `${resetCurrent.stderr.trim() || 'Unable to clean the managed worktree.'} Recovery is preserved on ${recoveryBranch}.`,
      'GIT_COMMAND_FAILED',
    );
  }
  const cleanedCurrent = await runGit(canonicalRepositoryRoot, ['clean', '-fd']);
  if (!cleanedCurrent.ok) {
    throw new ProjectGitError(
      `${cleanedCurrent.stderr.trim() || 'Unable to remove recovered untracked files.'} Recovery is preserved on ${recoveryBranch}.`,
      'GIT_COMMAND_FAILED',
    );
  }
  for (const operation of [
    ['rebase', '--quit'],
    ['merge', '--quit'],
    ['cherry-pick', '--quit'],
    ['revert', '--quit'],
    ['am', '--quit'],
  ]) {
    await runGit(canonicalRepositoryRoot, operation);
  }
  const restoredBranch = await runGit(canonicalRepositoryRoot, [
    'switch',
    '--discard-changes',
    '--force-create',
    baseBranch,
    baseSha,
  ]);
  if (!restoredBranch.ok) {
    throw new ProjectGitError(
      `${restoredBranch.stderr.trim() || `Unable to restore ${baseBranch}.`} Recovery is preserved on ${recoveryBranch}.`,
      'GIT_COMMAND_FAILED',
    );
  }
  const restoredHead = await runGit(canonicalRepositoryRoot, ['reset', '--hard', baseSha]);
  const cleanedRestored = await runGit(canonicalRepositoryRoot, ['clean', '-fd']);
  if (!restoredHead.ok || !cleanedRestored.ok) {
    throw new ProjectGitError(
      `${
        restoredHead.stderr.trim()
        || cleanedRestored.stderr.trim()
        || `Unable to restore ${baseBranch} at ${baseSha}.`
      } Recovery is preserved on ${recoveryBranch}.`,
      'GIT_COMMAND_FAILED',
    );
  }

  const status = await readProjectGitStatus(projectRoot);
  const finalHead = await runGit(canonicalRepositoryRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (
    !status.clean
    || status.branch !== baseBranch
    || !finalHead.ok
    || finalHead.stdout.trim() !== baseSha
  ) {
    throw new ProjectGitError(
      `Managed worktree restoration did not reach ${baseBranch} at ${baseSha}. Recovery is preserved on ${recoveryBranch}.`,
      'GIT_COMMAND_FAILED',
    );
  }
  return {
    recoveryBranch,
    recoverySha,
    status,
  };
}

export async function createAndPushProjectGitRevision(
  projectRoot: string,
  branchInput: unknown,
  messageInput: unknown,
  pathsInput: unknown,
): Promise<ProjectGitCommitResponse> {
  const branch = validateBranchName(branchInput);
  const before = await readProjectGitStatus(projectRoot);
  if (!before.available) throw new ProjectGitError(before.error ?? 'Git is unavailable.', 'GIT_NOT_AVAILABLE');
  if (!before.repository) throw new ProjectGitError('Project is not a Git repository.', 'NOT_GIT_REPOSITORY');
  const remote = await runGit(projectRoot, ['remote', 'get-url', 'origin']);
  if (!remote.ok || !remote.stdout.trim()) {
    throw new ProjectGitError('The project needs an origin remote before Open Design can publish revisions.', 'GIT_COMMAND_FAILED');
  }
  const switched = await runGit(projectRoot, ['switch', '--create', branch]);
  if (!switched.ok) {
    throw new ProjectGitError(switched.stderr.trim() || `Unable to create revision branch ${branch}.`, 'GIT_COMMAND_FAILED');
  }
  const committed = await commitProjectGitChanges(projectRoot, messageInput, pathsInput);
  const pushed = await runGit(projectRoot, ['push', '--set-upstream', 'origin', branch]);
  if (!pushed.ok) {
    throw new ProjectGitError(
      pushed.stderr.trim() || `Revision ${committed.commit.shortHash} was committed locally but could not be pushed.`,
      'GIT_COMMAND_FAILED',
    );
  }
  return { commit: committed.commit, status: await readProjectGitStatus(projectRoot) };
}

export async function prepareProjectGitRevisionBase(
  projectRoot: string,
  baseBranchInput: unknown = 'main',
  allowedUntrackedPathsInput: readonly string[] = [],
): Promise<ProjectGitStatusResponse> {
  const baseBranch = validateBranchName(baseBranchInput);
  const allowedUntrackedPaths = new Set(
    allowedUntrackedPathsInput
      .map((filePath) => filePath.replace(/\\/g, '/').replace(/^\.\//, ''))
      .filter((filePath) => (
        filePath.length > 0
        && filePath !== '.'
        && !path.posix.isAbsolute(filePath)
        && !filePath.split('/').includes('..')
      )),
  );
  const assertOnlyAllowedUntrackedChanges = (status: ProjectGitStatusResponse): void => {
    if (status.clean) return;
    const unexpected = status.truncated || status.changes.some((change) => (
      change.kind !== 'untracked'
      || !allowedUntrackedPaths.has(change.path.replace(/\\/g, '/'))
    ));
    if (unexpected) {
      throw new ProjectGitError(
        'The design-system worktree has uncommitted changes from an earlier run. Recover or commit them before starting another revision.',
        'GIT_COMMAND_FAILED',
      );
    }
  };
  const before = await readProjectGitStatus(projectRoot);
  if (!before.available) throw new ProjectGitError(before.error ?? 'Git is unavailable.', 'GIT_NOT_AVAILABLE');
  if (!before.repository || !before.repositoryRoot) {
    throw new ProjectGitError('Project is not a Git repository.', 'NOT_GIT_REPOSITORY');
  }
  assertOnlyAllowedUntrackedChanges(before);
  const remote = await runGit(before.repositoryRoot, ['remote', 'get-url', 'origin']);
  if (!remote.ok || !remote.stdout.trim()) {
    throw new ProjectGitError('The project needs an origin remote before Open Design can prepare revisions.', 'GIT_COMMAND_FAILED');
  }
  const remoteRef = `refs/remotes/origin/${baseBranch}`;
  const fetched = await runGit(before.repositoryRoot, [
    'fetch', '--prune', 'origin', `+refs/heads/${baseBranch}:${remoteRef}`,
  ]);
  if (!fetched.ok) {
    throw new ProjectGitError(fetched.stderr.trim() || `Unable to fetch origin/${baseBranch}.`, 'GIT_COMMAND_FAILED');
  }
  const remoteIsAncestor = await runGit(before.repositoryRoot, ['merge-base', '--is-ancestor', remoteRef, 'HEAD']);
  if (remoteIsAncestor.ok) {
    const current = await readProjectGitStatus(projectRoot);
    assertOnlyAllowedUntrackedChanges(current);
    return current;
  }
  const headIsAncestor = await runGit(before.repositoryRoot, ['merge-base', '--is-ancestor', 'HEAD', remoteRef]);
  if (!headIsAncestor.ok) {
    throw new ProjectGitError(
      `The design-system worktree has diverged from origin/${baseBranch}. Reconcile it before starting another revision.`,
      'GIT_COMMAND_FAILED',
    );
  }
  if (!before.branch) {
    throw new ProjectGitError(
      `The design-system worktree is detached and behind origin/${baseBranch}.`,
      'GIT_COMMAND_FAILED',
    );
  }
  const fastForwarded = await runGit(projectRoot, ['merge', '--ff-only', remoteRef]);
  if (!fastForwarded.ok) {
    throw new ProjectGitError(
      fastForwarded.stderr.trim() || `Unable to fast-forward to origin/${baseBranch}.`,
      'GIT_COMMAND_FAILED',
    );
  }
  const after = await readProjectGitStatus(projectRoot);
  assertOnlyAllowedUntrackedChanges(after);
  return after;
}

export async function readProjectGitFileAtRevision(
  projectRoot: string,
  shaInput: unknown,
  filePathInput: unknown,
): Promise<Buffer | null> {
  const sha = validateRevisionSha(shaInput);
  const [filePath] = validateCommitPaths([filePathInput]);
  const canonicalProjectRoot = await realpath(projectRoot);
  const rootResult = await runGit(canonicalProjectRoot, ['rev-parse', '--show-toplevel']);
  if (!rootResult.ok) throw new ProjectGitError('Project is not a Git repository.', 'NOT_GIT_REPOSITORY');
  const repositoryRoot = path.resolve(rootResult.stdout.trim());
  const projectPrefix = path.relative(repositoryRoot, canonicalProjectRoot).replace(/\\/g, '/');
  const repositoryPath = projectPrefix ? `${projectPrefix}/${filePath}` : filePath;
  const result = await runGitBuffer(canonicalProjectRoot, ['show', `${sha}:${repositoryPath}`]);
  return result.ok ? result.stdout : null;
}

export async function listProjectGitFilesAtRevision(
  projectRoot: string,
  shaInput: unknown,
): Promise<string[]> {
  const sha = validateRevisionSha(shaInput);
  const canonicalProjectRoot = await realpath(projectRoot);
  const rootResult = await runGit(canonicalProjectRoot, ['rev-parse', '--show-toplevel']);
  if (!rootResult.ok) throw new ProjectGitError('Project is not a Git repository.', 'NOT_GIT_REPOSITORY');
  const repositoryRoot = path.resolve(rootResult.stdout.trim());
  const projectPrefix = path.relative(repositoryRoot, canonicalProjectRoot).replace(/\\/g, '/');
  if (projectPrefix === '..' || projectPrefix.startsWith('../') || path.isAbsolute(projectPrefix)) {
    throw new ProjectGitError('Project directory is outside the detected Git repository.', 'GIT_COMMAND_FAILED');
  }
  const result = await runGitBuffer(repositoryRoot, [
    '--literal-pathspecs',
    'ls-tree',
    '-r',
    '--name-only',
    '-z',
    sha,
    '--',
    projectPrefix || '.',
  ]);
  if (!result.ok) {
    throw new ProjectGitError(
      result.stderr.trim() || `Unable to read revision ${sha.slice(0, 8)}.`,
      'GIT_COMMAND_FAILED',
    );
  }
  return result.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((repositoryPath) => projectRelativePath(repositoryPath, projectPrefix))
    .filter((filePath): filePath is string => filePath != null)
    .sort();
}

export async function createProjectGitWorktree(
  projectRoot: string,
  worktreeRoot: string,
  branchInput: unknown,
): Promise<ProjectGitStatusResponse> {
  const branch = validateBranchName(branchInput);
  const source = await readProjectGitStatus(projectRoot);
  if (!source.repository || !source.repositoryRoot) {
    throw new ProjectGitError('Project is not a Git repository.', 'NOT_GIT_REPOSITORY');
  }
  if (!source.clean) {
    throw new ProjectGitError('The source checkout must be clean before Open Design creates its managed worktree.', 'GIT_COMMAND_FAILED');
  }
  try {
    const existing = await readProjectGitStatus(worktreeRoot);
    if (existing.repository && existing.branch === branch) return existing;
  } catch {
    // The managed worktree does not exist yet.
  }
  await mkdir(path.dirname(worktreeRoot), { recursive: true });
  const branchExists = await runGit(source.repositoryRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  const added = await runGit(source.repositoryRoot, branchExists.ok
    ? ['worktree', 'add', worktreeRoot, branch]
    : ['worktree', 'add', '-b', branch, worktreeRoot, 'HEAD']);
  if (!added.ok) {
    throw new ProjectGitError(added.stderr.trim() || `Unable to create managed worktree ${worktreeRoot}.`, 'GIT_COMMAND_FAILED');
  }
  return readProjectGitStatus(worktreeRoot);
}

export async function publishProjectGitRevision(
  projectRoot: string,
  shaInput: unknown,
  baseBranchInput: unknown = 'main',
): Promise<ProjectGitStatusResponse> {
  const sha = validateRevisionSha(shaInput);
  const baseBranch = validateBranchName(baseBranchInput);
  const status = await readProjectGitStatus(projectRoot);
  if (!status.repository || !status.repositoryRoot) {
    throw new ProjectGitError('Project is not a Git repository.', 'NOT_GIT_REPOSITORY');
  }
  if (!status.clean) {
    throw new ProjectGitError('The design-system worktree must be clean before Publish.', 'GIT_COMMAND_FAILED');
  }
  const fetched = await runGit(status.repositoryRoot, ['fetch', 'origin', baseBranch]);
  if (!fetched.ok) {
    throw new ProjectGitError(fetched.stderr.trim() || `Unable to fetch origin/${baseBranch}.`, 'GIT_COMMAND_FAILED');
  }
  const commitExists = await runGit(status.repositoryRoot, ['cat-file', '-e', `${sha}^{commit}`]);
  if (!commitExists.ok) throw new ProjectGitError(`Revision ${sha} is not available locally.`, 'INVALID_GIT_REQUEST');
  const fastForward = await runGit(status.repositoryRoot, [
    'merge-base', '--is-ancestor', `origin/${baseBranch}`, sha,
  ]);
  if (!fastForward.ok) {
    throw new ProjectGitError(
      `Publish stopped because ${sha.slice(0, 8)} is not a fast-forward of origin/${baseBranch}. Rebase the design revision first.`,
      'GIT_COMMAND_FAILED',
    );
  }
  const pushed = await runGit(status.repositoryRoot, ['push', 'origin', `${sha}:refs/heads/${baseBranch}`]);
  if (!pushed.ok) {
    throw new ProjectGitError(pushed.stderr.trim() || `Unable to publish ${sha.slice(0, 8)} to ${baseBranch}.`, 'GIT_COMMAND_FAILED');
  }
  return readProjectGitStatus(projectRoot);
}

export async function projectGitRevisionIsAncestor(
  projectRoot: string,
  shaInput: unknown,
  refInput: unknown,
  options: { fetchOriginBranch?: string } = {},
): Promise<boolean> {
  const sha = validateRevisionSha(shaInput);
  const ref = validateRevisionRef(refInput);
  const status = await readProjectGitStatus(projectRoot);
  if (!status.repository || !status.repositoryRoot) {
    throw new ProjectGitError('Project is not a Git repository.', 'NOT_GIT_REPOSITORY');
  }
  if (options.fetchOriginBranch) {
    const branch = validateBranchName(options.fetchOriginBranch);
    const fetched = await runGit(status.repositoryRoot, [
      'fetch',
      '--prune',
      'origin',
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);
    if (!fetched.ok) {
      throw new ProjectGitError(fetched.stderr.trim() || `Unable to fetch origin/${branch}.`, 'GIT_COMMAND_FAILED');
    }
  }
  const result = await runGit(status.repositoryRoot, ['merge-base', '--is-ancestor', sha, ref]);
  return result.ok;
}

async function assertCanonicalRemoteProjectPath(projectRoot: string): Promise<void> {
  try {
    await realpath(projectRoot);
  } catch {
    throw new ProjectGitError('Project path is unavailable.', 'NOT_GIT_REPOSITORY');
  }
}

export async function readProjectGitCanonicalRemoteHead(
  projectRoot: string,
  expectedRemoteUrlInput: unknown,
): Promise<ProjectGitCanonicalRemoteHead> {
  await assertCanonicalRemoteProjectPath(projectRoot);
  const expectedRemoteUrl = validateCanonicalRemoteUrl(expectedRemoteUrlInput);
  const result = await runGitWithIsolatedConfig([
    'ls-remote',
    '--symref',
    '--exit-code',
    '--',
    expectedRemoteUrl,
    'HEAD',
  ], expectedRemoteUrl);
  if (result.missing) {
    throw new ProjectGitError('Git is not installed or is not available on PATH.', 'GIT_NOT_AVAILABLE');
  }
  if (!result.ok) {
    throw new ProjectGitError(
      result.stderr.trim() || 'Unable to discover the canonical remote default branch.',
      'GIT_COMMAND_FAILED',
    );
  }
  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  const symrefs = lines
    .map((line) => /^ref:\s+refs\/heads\/([^\t]+)\tHEAD$/.exec(line)?.[1] ?? null)
    .filter((branch): branch is string => branch != null);
  const headShas = lines
    .map((line) => /^([a-f0-9]+)\tHEAD$/i.exec(line)?.[1] ?? null)
    .filter((sha): sha is string => sha != null);
  if (symrefs.length !== 1 || headShas.length !== 1) {
    throw new ProjectGitError(
      'Canonical remote did not advertise one exact default branch and HEAD revision.',
      'GIT_COMMAND_FAILED',
    );
  }
  return {
    branch: validateBranchName(symrefs[0]),
    sha: validateRevisionSha(headShas[0]),
  };
}

export async function readProjectGitCanonicalRemoteBranchRevision(
  projectRoot: string,
  expectedRemoteUrlInput: unknown,
  branchInput: unknown,
): Promise<string> {
  await assertCanonicalRemoteProjectPath(projectRoot);
  const expectedRemoteUrl = validateCanonicalRemoteUrl(expectedRemoteUrlInput);
  const branch = validateBranchName(branchInput);
  const expectedRef = `refs/heads/${branch}`;
  const result = await runGitWithIsolatedConfig([
    'ls-remote',
    '--refs',
    '--exit-code',
    '--',
    expectedRemoteUrl,
    expectedRef,
  ], expectedRemoteUrl);
  if (result.missing) {
    throw new ProjectGitError('Git is not installed or is not available on PATH.', 'GIT_NOT_AVAILABLE');
  }
  if (!result.ok) {
    throw new ProjectGitError(
      result.stderr.trim() || `Unable to read canonical remote branch ${branch}.`,
      'GIT_COMMAND_FAILED',
    );
  }
  const matches = result.stdout
    .split(/\r?\n/)
    .map((line) => /^([a-f0-9]+)\t(.+)$/i.exec(line))
    .filter((match) => match?.[2] === expectedRef);
  if (matches.length !== 1 || !matches[0]?.[1]) {
    throw new ProjectGitError(
      `Canonical remote did not advertise one exact ${expectedRef} revision.`,
      'GIT_COMMAND_FAILED',
    );
  }
  return validateRevisionSha(matches[0][1]);
}

export async function deployProjectGitCanonicalRevision(
  projectRoot: string,
  input: ProjectGitCanonicalDeploymentInput,
): Promise<ProjectGitStatusResponse> {
  const expectedRemoteUrl = validateCanonicalRemoteUrl(input?.expectedRemoteUrl);
  const baseBranch = validateBranchName(input?.baseBranch);
  const baseCommit = validateRevisionSha(input?.baseCommit).toLowerCase();
  const targetCommit = validateRevisionSha(input?.targetCommit).toLowerCase();
  const [scopePath] = validateCommitPaths([input?.scopePath]);
  if (!scopePath) {
    throw new ProjectGitError('Canonical deployment scope is invalid.', 'INVALID_GIT_REQUEST');
  }
  if (baseCommit === targetCommit) {
    throw new ProjectGitError(
      'Canonical deployment base and target commits must differ.',
      'INVALID_GIT_REQUEST',
    );
  }
  const status = await readProjectGitStatus(path.join(projectRoot, scopePath));
  if (!status.repository || !status.repositoryRoot) {
    throw new ProjectGitError('Project is not a Git repository.', 'NOT_GIT_REPOSITORY');
  }
  const [canonicalProjectRoot, canonicalRepositoryRoot] = await Promise.all([
    realpath(projectRoot),
    realpath(status.repositoryRoot),
  ]);
  if (canonicalProjectRoot !== canonicalRepositoryRoot) {
    throw new ProjectGitError(
      'Canonical deployment requires the primary repository root.',
      'INVALID_GIT_REQUEST',
    );
  }
  if (
    status.branch !== baseBranch
    || status.truncated
    || !status.clean
    || !status.lastCommit
  ) {
    throw new ProjectGitError(
      `Canonical deployment requires clean scope ${scopePath} on branch ${baseBranch}.`,
      'GIT_COMMAND_FAILED',
    );
  }
  const localCommit = status.lastCommit.hash.toLowerCase();
  if (localCommit !== baseCommit && localCommit !== targetCommit) {
    throw new ProjectGitError(
      'Canonical deployment live checkout is neither the frozen base nor the approved target.',
      'GIT_COMMAND_FAILED',
    );
  }
  const [targetExists, targetIsFastForward] = await Promise.all([
    runGit(canonicalRepositoryRoot, ['cat-file', '-e', `${targetCommit}^{commit}`]),
    runGit(canonicalRepositoryRoot, [
      'merge-base',
      '--is-ancestor',
      baseCommit,
      targetCommit,
    ]),
  ]);
  if (!targetExists.ok || !targetIsFastForward.ok) {
    throw new ProjectGitError(
      'Canonical deployment target is unavailable or is not a fast-forward of the frozen base.',
      'GIT_COMMAND_FAILED',
    );
  }

  const remoteHead = await readProjectGitCanonicalRemoteHead(
    canonicalRepositoryRoot,
    expectedRemoteUrl,
  );
  if (remoteHead.branch !== baseBranch) {
    throw new ProjectGitError(
      'Canonical remote default branch changed after the delivery challenge was issued.',
      'GIT_COMMAND_FAILED',
    );
  }
  const remoteCommit = remoteHead.sha.toLowerCase();
  if (remoteCommit !== baseCommit && remoteCommit !== targetCommit) {
    throw new ProjectGitError(
      'Canonical remote changed outside the frozen base-to-target deployment transition.',
      'GIT_COMMAND_FAILED',
    );
  }
  if (remoteCommit === baseCommit) {
    const pushed = await runGitWithIsolatedConfig([
      'push',
      '--porcelain',
      '--no-verify',
      `--force-with-lease=refs/heads/${baseBranch}:${baseCommit}`,
      expectedRemoteUrl,
      `${targetCommit}:refs/heads/${baseBranch}`,
    ], expectedRemoteUrl, canonicalRepositoryRoot);
    if (!pushed.ok) {
      throw new ProjectGitError(
        pushed.stderr.trim()
          || 'Canonical remote changed before the approved target could be published.',
        'GIT_COMMAND_FAILED',
      );
    }
  }
  if (localCommit === baseCommit) {
    const fastForwarded = await runGit(canonicalRepositoryRoot, [
      '-c',
      'core.hooksPath=/dev/null',
      'merge',
      '--ff-only',
      '--no-verify',
      targetCommit,
    ]);
    if (!fastForwarded.ok) {
      throw new ProjectGitError(
        fastForwarded.stderr.trim()
          || 'Live checkout could not fast-forward to the approved target.',
        'GIT_COMMAND_FAILED',
      );
    }
  }

  const [finalRemoteHead, finalStatus] = await Promise.all([
    readProjectGitCanonicalRemoteHead(
      canonicalRepositoryRoot,
      expectedRemoteUrl,
    ),
    readProjectGitStatus(path.join(canonicalRepositoryRoot, scopePath)),
  ]);
  if (
    finalRemoteHead.branch !== baseBranch
    || finalRemoteHead.sha.toLowerCase() !== targetCommit
    || finalStatus.branch !== baseBranch
    || finalStatus.truncated
    || !finalStatus.clean
    || finalStatus.lastCommit?.hash.toLowerCase() !== targetCommit
  ) {
    throw new ProjectGitError(
      'Canonical deployment did not converge the remote and live checkout on the approved target.',
      'GIT_COMMAND_FAILED',
    );
  }
  return finalStatus;
}

export async function readProjectGitRemoteDefaultBranch(projectRoot: string): Promise<string> {
  const status = await readProjectGitStatus(projectRoot);
  if (!status.repository || !status.repositoryRoot) {
    throw new ProjectGitError('Project is not a Git repository.', 'NOT_GIT_REPOSITORY');
  }
  const result = await runGit(status.repositoryRoot, ['ls-remote', '--symref', 'origin', 'HEAD']);
  if (!result.ok) {
    throw new ProjectGitError(
      result.stderr.trim() || 'Unable to discover the origin default branch.',
      'GIT_COMMAND_FAILED',
    );
  }
  const match = /^ref:\s+refs\/heads\/([^\t\r\n]+)\s+HEAD$/m.exec(result.stdout);
  if (!match?.[1]) {
    throw new ProjectGitError('Origin did not advertise a default branch.', 'GIT_COMMAND_FAILED');
  }
  return validateBranchName(match[1]);
}

export async function projectGitRefMatchesRevision(
  projectRoot: string,
  shaInput: unknown,
  refInput: unknown,
  options: { fetchOriginBranch?: string } = {},
): Promise<boolean> {
  const sha = validateRevisionSha(shaInput);
  const ref = validateRevisionRef(refInput);
  const status = await readProjectGitStatus(projectRoot);
  if (!status.repository || !status.repositoryRoot) {
    throw new ProjectGitError('Project is not a Git repository.', 'NOT_GIT_REPOSITORY');
  }
  if (options.fetchOriginBranch) {
    const branch = validateBranchName(options.fetchOriginBranch);
    const fetched = await runGit(status.repositoryRoot, [
      'fetch',
      '--prune',
      'origin',
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);
    if (!fetched.ok) {
      throw new ProjectGitError(fetched.stderr.trim() || `Unable to fetch origin/${branch}.`, 'GIT_COMMAND_FAILED');
    }
  }
  const [expected, actual] = await Promise.all([
    runGit(status.repositoryRoot, ['rev-parse', '--verify', `${sha}^{commit}`]),
    runGit(status.repositoryRoot, ['rev-parse', '--verify', `${ref}^{commit}`]),
  ]);
  return expected.ok && actual.ok && expected.stdout.trim() === actual.stdout.trim();
}

export async function readProjectGitRefRevision(
  projectRoot: string,
  refInput: unknown,
  options: { fetchOriginBranch?: string } = {},
): Promise<string> {
  const ref = validateRevisionRef(refInput);
  const status = await readProjectGitStatus(projectRoot);
  if (!status.repository || !status.repositoryRoot) {
    throw new ProjectGitError('Project is not a Git repository.', 'NOT_GIT_REPOSITORY');
  }
  if (options.fetchOriginBranch) {
    const branch = validateBranchName(options.fetchOriginBranch);
    const fetched = await runGit(status.repositoryRoot, [
      'fetch',
      '--prune',
      'origin',
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);
    if (!fetched.ok) {
      throw new ProjectGitError(fetched.stderr.trim() || `Unable to fetch origin/${branch}.`, 'GIT_COMMAND_FAILED');
    }
  }
  const result = await runGit(status.repositoryRoot, ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (!result.ok) {
    throw new ProjectGitError(
      result.stderr.trim() || `Unable to resolve Git ref ${ref}.`,
      'INVALID_GIT_REQUEST',
    );
  }
  return validateRevisionSha(result.stdout.trim());
}

async function readProjectGitTreeEntry(
  repositoryRoot: string,
  revision: string,
  filePath: string,
): Promise<{ mode: string; type: string; object: string; path: string } | null> {
  const result = await runGitBuffer(repositoryRoot, [
    '--literal-pathspecs',
    'ls-tree',
    '-z',
    revision,
    '--',
    filePath,
  ]);
  if (!result.ok) {
    throw new ProjectGitError(
      result.stderr.trim() || `Unable to inspect ${filePath} at ${revision.slice(0, 8)}.`,
      'GIT_COMMAND_FAILED',
    );
  }
  const records = result.stdout.toString('utf8').split('\0').filter(Boolean);
  if (records.length === 0) return null;
  const match = records.length === 1
    ? /^([0-7]{6}) ([a-z]+) ([a-f0-9]+)\t([\s\S]+)$/i.exec(records[0]!)
    : null;
  if (!match || match[4] !== filePath) {
    throw new ProjectGitError(`Git returned an invalid tree entry for ${filePath}.`, 'GIT_COMMAND_FAILED');
  }
  return {
    mode: match[1]!,
    type: match[2]!,
    object: match[3]!,
    path: match[4]!,
  };
}

export async function verifyProjectGitLinearAttestation(
  projectRoot: string,
  input: {
    baseCommit: string;
    implementationCommit: string;
    attestationCommit: string;
    appPath: string;
    receiptPath: string;
  },
): Promise<void> {
  const baseCommit = validateRevisionSha(input.baseCommit);
  const implementationCommit = validateRevisionSha(input.implementationCommit);
  const attestationCommit = validateRevisionSha(input.attestationCommit);
  const paths = validateCommitPaths([input.appPath, input.receiptPath]);
  const appPath = paths[0]!;
  const receiptPath = paths[1]!;
  if (new Set([baseCommit, implementationCommit, attestationCommit]).size !== 3) {
    throw new ProjectGitError('Attestation commits must be distinct.', 'INVALID_GIT_REQUEST');
  }
  const status = await readProjectGitStatus(projectRoot);
  if (!status.repository || !status.repositoryRoot) {
    throw new ProjectGitError('Project is not a Git repository.', 'NOT_GIT_REPOSITORY');
  }
  const [implementationParents, attestationParents] = await Promise.all([
    runGit(status.repositoryRoot, ['rev-list', '--parents', '-n', '1', implementationCommit]),
    runGit(status.repositoryRoot, ['rev-list', '--parents', '-n', '1', attestationCommit]),
  ]);
  if (!implementationParents.ok || !attestationParents.ok) {
    throw new ProjectGitError('Unable to inspect Core UI attestation commit parents.', 'GIT_COMMAND_FAILED');
  }
  const implementationLine = implementationParents.stdout.trim().split(/\s+/);
  const attestationLine = attestationParents.stdout.trim().split(/\s+/);
  if (
    implementationLine.length !== 2
    || implementationLine[0] !== implementationCommit
    || implementationLine[1] !== baseCommit
    || attestationLine.length !== 2
    || attestationLine[0] !== attestationCommit
    || attestationLine[1] !== implementationCommit
  ) {
    throw new ProjectGitError(
      'Core UI delivery must be the exact linear base → implementation → attestation sequence with no merge commits.',
      'GIT_COMMAND_FAILED',
    );
  }
  const implementationChanged = await runGitBuffer(status.repositoryRoot, [
    '--literal-pathspecs',
    'diff-tree',
    '--no-commit-id',
    '--name-only',
    '-r',
    '-z',
    baseCommit,
    implementationCommit,
  ]);
  if (!implementationChanged.ok) {
    throw new ProjectGitError(
      implementationChanged.stderr.trim() || 'Unable to inspect Core UI implementation changes.',
      'GIT_COMMAND_FAILED',
    );
  }
  const implementationChangedPaths = implementationChanged.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  const implementationRoots = [
    '99_System/core-v2/apps/web/src/',
    '99_System/core-v2/apps/web/static/',
  ];
  const protectedAttestationRoot =
    '99_System/core-v2/apps/web/static/open-design/attestations/';
  if (implementationChangedPaths.some((filePath) =>
    !implementationRoots.some((root) => filePath.startsWith(root))
    || filePath.startsWith(protectedAttestationRoot))) {
    throw new ProjectGitError(
      'Core UI implementation commit may change only web source/static files and may not change the attestation receipt store.',
      'GIT_COMMAND_FAILED',
    );
  }
  for (const filePath of implementationChangedPaths) {
    const entry = await readProjectGitTreeEntry(
      status.repositoryRoot,
      implementationCommit,
      filePath,
    );
    if (
      entry !== null
      && (
        entry.type !== 'blob'
        || (entry.mode !== '100644' && entry.mode !== '100755')
      )
    ) {
      throw new ProjectGitError(
        'Core UI implementation files must be deleted or ordinary 100644/100755 blobs.',
        'GIT_COMMAND_FAILED',
      );
    }
  }
  const changed = await runGitBuffer(status.repositoryRoot, [
    '--literal-pathspecs',
    'diff-tree',
    '--no-commit-id',
    '--name-only',
    '-r',
    '-z',
    implementationCommit,
    attestationCommit,
  ]);
  if (!changed.ok) {
    throw new ProjectGitError(
      changed.stderr.trim() || 'Unable to inspect Core UI attestation changes.',
      'GIT_COMMAND_FAILED',
    );
  }
  const changedPaths = changed.stdout.toString('utf8').split('\0').filter(Boolean).sort();
  const expectedPaths = [appPath, receiptPath].sort();
  if (
    changedPaths.length !== expectedPaths.length
    || changedPaths.some((filePath, index) => filePath !== expectedPaths[index])
  ) {
    throw new ProjectGitError(
      'Core UI attestation commit may change only the app template sentinel and the unique receipt.',
      'GIT_COMMAND_FAILED',
    );
  }
  const [implementationApp, implementationReceipt, attestationApp, attestationReceipt] = await Promise.all([
    readProjectGitTreeEntry(status.repositoryRoot, implementationCommit, appPath),
    readProjectGitTreeEntry(status.repositoryRoot, implementationCommit, receiptPath),
    readProjectGitTreeEntry(status.repositoryRoot, attestationCommit, appPath),
    readProjectGitTreeEntry(status.repositoryRoot, attestationCommit, receiptPath),
  ]);
  if (
    !implementationApp
    || implementationApp.mode !== '100644'
    || implementationApp.type !== 'blob'
    || implementationReceipt !== null
    || !attestationApp
    || attestationApp.mode !== '100644'
    || attestationApp.type !== 'blob'
    || !attestationReceipt
    || attestationReceipt.mode !== '100644'
    || attestationReceipt.type !== 'blob'
  ) {
    throw new ProjectGitError(
      'Core UI attestation files must be ordinary 100644 blobs and the receipt must be new in the attestation commit.',
      'GIT_COMMAND_FAILED',
    );
  }
}
