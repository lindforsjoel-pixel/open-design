import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commitProjectGitChanges,
  createAndPushProjectGitRevision,
  createProjectGitWorktree,
  parseProjectGitStatus,
  publishProjectGitRevision,
  readProjectGitStatus,
} from '../../src/services/project-git.js';

const tempDirs: string[] = [];

function makeRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), 'od-project-git-'));
  tempDirs.push(repo);
  runGit(repo, ['init']);
  runGit(repo, ['config', 'user.name', 'Open Design Test']);
  runGit(repo, ['config', 'user.email', 'open-design-test@example.invalid']);
  return repo;
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('project Git service', () => {
  it('parses NUL-delimited paths and rename pairs relative to the project', () => {
    const parsed = parseProjectGitStatus(
      ' M nested/file with spaces.txt\0R  nested/new.txt\0nested/old.txt\0?? outside.txt\0',
      'nested',
    );

    expect(parsed).toEqual({
      truncated: false,
      changes: [
        expect.objectContaining({
          path: 'file with spaces.txt',
          kind: 'modified',
          staged: false,
          unstaged: true,
        }),
        expect.objectContaining({
          path: 'new.txt',
          originalPath: 'old.txt',
          kind: 'renamed',
          staged: true,
        }),
      ],
    });
  });

  it('scopes status and selected-path commits to the project without consuming unrelated staged work', async () => {
    const repo = makeRepo();
    const project = path.join(repo, 'project');
    await mkdir(project);
    await writeFile(path.join(project, 'tracked.txt'), 'one\n');
    await writeFile(path.join(repo, 'outside.txt'), 'outside one\n');
    runGit(repo, ['add', '-A']);
    runGit(repo, ['commit', '-m', 'initial']);

    await writeFile(path.join(project, 'tracked.txt'), 'two\n');
    await writeFile(path.join(project, 'new file.txt'), 'new\n');
    await writeFile(path.join(repo, 'outside.txt'), 'outside two\n');
    runGit(repo, ['add', 'outside.txt']);

    const before = await readProjectGitStatus(project);
    expect(before.repository).toBe(true);
    expect(before.changes.map((change) => change.path).sort()).toEqual([
      'new file.txt',
      'tracked.txt',
    ]);

    const result = await commitProjectGitChanges(project, 'Add selected project file', ['new file.txt']);
    expect(result.commit.subject).toBe('Add selected project file');
    expect(result.status.changes.map((change) => change.path)).toEqual(['tracked.txt']);
    expect(runGit(repo, ['diff', '--cached', '--name-only']).trim()).toBe('outside.txt');
    expect(runGit(repo, ['show', '--pretty=', '--name-only', 'HEAD']).trim()).toBe('project/new file.txt');
  });

  it('treats selected filenames as literal Git pathspecs', async () => {
    const repo = makeRepo();
    await writeFile(path.join(repo, 'selected*.txt'), 'literal\n');
    await writeFile(path.join(repo, 'selected-other.txt'), 'other\n');

    await commitProjectGitChanges(repo, 'Commit literal wildcard name', ['selected*.txt']);

    expect(runGit(repo, ['show', '--pretty=', '--name-only', 'HEAD']).trim()).toBe('selected*.txt');
    expect((await readProjectGitStatus(repo)).changes.map((change) => change.path)).toEqual(['selected-other.txt']);
  });

  it('creates an isolated revision branch, commits selected files, and pushes it', async () => {
    const remote = mkdtempSync(path.join(tmpdir(), 'od-project-git-remote-'));
    tempDirs.push(remote);
    runGit(remote, ['init', '--bare']);
    const repo = makeRepo();
    await writeFile(path.join(repo, 'tokens.css'), ':root { --brand: red; }\n');
    await writeFile(path.join(repo, 'notes.txt'), 'one\n');
    runGit(repo, ['add', '-A']);
    runGit(repo, ['commit', '-m', 'initial']);
    runGit(repo, ['remote', 'add', 'origin', remote]);
    await writeFile(path.join(repo, 'tokens.css'), ':root { --brand: blue; }\n');
    await writeFile(path.join(repo, 'notes.txt'), 'two\n');

    const result = await createAndPushProjectGitRevision(
      repo,
      'open-design/run-test',
      'Update design system (run-test)',
      ['tokens.css'],
    );

    expect(result.status.branch).toBe('open-design/run-test');
    expect(result.status.upstream).toBe('origin/open-design/run-test');
    expect(runGit(repo, ['show', '--pretty=', '--name-only', 'HEAD']).trim()).toBe('tokens.css');
    expect(runGit(repo, ['status', '--short']).trim()).toBe('M notes.txt');
    expect(runGit(remote, ['rev-parse', 'refs/heads/open-design/run-test']).trim()).toBe(result.commit.hash);
  });

  it('creates a managed worktree without switching the source checkout', async () => {
    const repo = makeRepo();
    await writeFile(path.join(repo, 'DESIGN.md'), '# Design\n');
    runGit(repo, ['add', '-A']);
    runGit(repo, ['commit', '-m', 'initial']);
    const originalBranch = runGit(repo, ['branch', '--show-current']).trim();
    const worktree = mkdtempSync(path.join(tmpdir(), 'od-project-worktree-parent-'));
    tempDirs.push(worktree);
    const target = path.join(worktree, 'workspace');

    const status = await createProjectGitWorktree(repo, target, 'open-design/workspace-test');

    expect(status.projectRoot).toBe(target);
    expect(status.branch).toBe('open-design/workspace-test');
    expect(runGit(repo, ['branch', '--show-current']).trim()).toBe(originalBranch);
    expect(runGit(target, ['rev-parse', 'HEAD']).trim()).toBe(runGit(repo, ['rev-parse', 'HEAD']).trim());
  });

  it('publishes an exact fast-forward revision without switching worktrees', async () => {
    const remote = mkdtempSync(path.join(tmpdir(), 'od-project-publish-remote-'));
    tempDirs.push(remote);
    runGit(remote, ['init', '--bare']);
    const repo = makeRepo();
    await writeFile(path.join(repo, 'DESIGN.md'), '# One\n');
    runGit(repo, ['add', '-A']);
    runGit(repo, ['commit', '-m', 'initial']);
    runGit(repo, ['branch', '-M', 'main']);
    runGit(repo, ['remote', 'add', 'origin', remote]);
    runGit(repo, ['push', '-u', 'origin', 'main']);
    runGit(repo, ['switch', '-c', 'open-design/run-publish']);
    await writeFile(path.join(repo, 'DESIGN.md'), '# Two\n');
    runGit(repo, ['add', '-A']);
    runGit(repo, ['commit', '-m', 'update']);
    const revision = runGit(repo, ['rev-parse', 'HEAD']).trim();

    const status = await publishProjectGitRevision(repo, revision);

    expect(status.branch).toBe('open-design/run-publish');
    expect(runGit(remote, ['rev-parse', 'refs/heads/main']).trim()).toBe(revision);
  });
});
