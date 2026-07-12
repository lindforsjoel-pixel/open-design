import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
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
