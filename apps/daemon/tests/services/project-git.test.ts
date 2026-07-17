import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commitProjectGitChanges,
  createAndPushProjectGitRevision,
  createProjectGitWorktree,
  deployProjectGitCanonicalRevision,
  listProjectGitFilesAtRevision,
  parseProjectGitStatus,
  prepareProjectGitRevisionBase,
  projectGitRefMatchesRevision,
  projectGitRevisionIsAncestor,
  publishProjectGitRevision,
  quarantineProjectGitRunState,
  readProjectGitCanonicalRemoteBranchRevision,
  readProjectGitCanonicalRemoteHead,
  readProjectGitRefRevision,
  readProjectGitRemoteDefaultBranch,
  readProjectGitStatus,
  verifyProjectGitLinearAttestation,
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

async function makeBareRemote(
  branch: string,
  content: string,
): Promise<{ remote: string; sha: string }> {
  const remote = mkdtempSync(path.join(tmpdir(), 'od-project-git-canonical-remote-'));
  tempDirs.push(remote);
  runGit(remote, ['init', '--bare']);
  const seed = makeRepo();
  await writeFile(path.join(seed, 'app.txt'), content);
  runGit(seed, ['add', '-A']);
  runGit(seed, ['commit', '-m', `seed ${branch}`]);
  runGit(seed, ['branch', '-M', branch]);
  runGit(seed, ['remote', 'add', 'origin', remote]);
  runGit(seed, ['push', '-u', 'origin', branch]);
  runGit(remote, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
  return {
    remote,
    sha: runGit(seed, ['rev-parse', 'HEAD']).trim(),
  };
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

  it('lists project files from the exact revision instead of the mutable working tree', async () => {
    const repo = makeRepo();
    const project = path.join(repo, 'nested', 'project');
    await mkdir(path.join(project, 'assets'), { recursive: true });
    await writeFile(path.join(project, 'tokens.css'), ':root { --brand: red; }\n');
    await writeFile(path.join(project, 'assets', 'logo.svg'), '<svg id="committed"/>\n');
    await writeFile(path.join(repo, 'outside.txt'), 'outside\n');
    runGit(repo, ['add', '-A']);
    runGit(repo, ['commit', '-m', 'snapshot']);
    const revision = runGit(repo, ['rev-parse', 'HEAD']).trim();

    rmSync(path.join(project, 'assets', 'logo.svg'));
    await writeFile(path.join(project, 'tokens.css'), ':root { --brand: blue; }\n');
    await writeFile(path.join(project, 'assets', 'working-only.svg'), '<svg/>\n');

    expect(await listProjectGitFilesAtRevision(project, revision)).toEqual([
      'assets/logo.svg',
      'tokens.css',
    ]);
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

  it('fast-forwards a clean revision base before a design run starts', async () => {
    const remote = mkdtempSync(path.join(tmpdir(), 'od-project-freshness-remote-'));
    tempDirs.push(remote);
    runGit(remote, ['init', '--bare']);
    const seed = makeRepo();
    await writeFile(path.join(seed, 'DESIGN.md'), '# One\n');
    runGit(seed, ['add', '-A']);
    runGit(seed, ['commit', '-m', 'initial']);
    runGit(seed, ['branch', '-M', 'main']);
    runGit(seed, ['remote', 'add', 'origin', remote]);
    runGit(seed, ['push', '-u', 'origin', 'main']);
    runGit(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

    const parent = mkdtempSync(path.join(tmpdir(), 'od-project-freshness-clone-'));
    tempDirs.push(parent);
    const checkout = path.join(parent, 'checkout');
    runGit(parent, ['clone', remote, checkout]);
    runGit(checkout, ['config', 'user.name', 'Open Design Test']);
    runGit(checkout, ['config', 'user.email', 'open-design-test@example.invalid']);
    await writeFile(path.join(seed, 'DESIGN.md'), '# Two\n');
    runGit(seed, ['add', 'DESIGN.md']);
    runGit(seed, ['commit', '-m', 'upstream update']);
    runGit(seed, ['push', 'origin', 'main']);

    const status = await prepareProjectGitRevisionBase(checkout);

    expect(status.clean).toBe(true);
    expect(runGit(checkout, ['rev-parse', 'HEAD']).trim()).toBe(runGit(seed, ['rev-parse', 'HEAD']).trim());
  });

  it('blocks a new design revision when an earlier run left uncommitted files', async () => {
    const remote = mkdtempSync(path.join(tmpdir(), 'od-project-dirty-remote-'));
    tempDirs.push(remote);
    runGit(remote, ['init', '--bare']);
    const repo = makeRepo();
    await writeFile(path.join(repo, 'DESIGN.md'), '# One\n');
    runGit(repo, ['add', '-A']);
    runGit(repo, ['commit', '-m', 'initial']);
    runGit(repo, ['branch', '-M', 'main']);
    runGit(repo, ['remote', 'add', 'origin', remote]);
    runGit(repo, ['push', '-u', 'origin', 'main']);
    await writeFile(path.join(repo, 'DESIGN.md'), '# Dirty\n');

    await expect(prepareProjectGitRevisionBase(repo)).rejects.toThrow(/uncommitted changes from an earlier run/i);
  });

  it('allows only exact current-run attachment uploads as an untracked revision base', async () => {
    const remote = mkdtempSync(path.join(tmpdir(), 'od-project-attachment-remote-'));
    tempDirs.push(remote);
    runGit(remote, ['init', '--bare']);
    const repo = makeRepo();
    await writeFile(path.join(repo, 'DESIGN.md'), '# One\n');
    runGit(repo, ['add', '-A']);
    runGit(repo, ['commit', '-m', 'initial']);
    runGit(repo, ['branch', '-M', 'main']);
    runGit(repo, ['remote', 'add', 'origin', remote]);
    runGit(repo, ['push', '-u', 'origin', 'main']);
    await writeFile(path.join(repo, 'reference.png'), 'image bytes');

    const status = await prepareProjectGitRevisionBase(repo, 'main', ['reference.png']);

    expect(status.clean).toBe(false);
    expect(status.changes).toEqual([
      expect.objectContaining({ path: 'reference.png', kind: 'untracked' }),
    ]);

    await writeFile(path.join(repo, 'unexpected.txt'), 'not this run');
    await expect(
      prepareProjectGitRevisionBase(repo, 'main', ['reference.png']),
    ).rejects.toThrow(/uncommitted changes from an earlier run/i);
  });

  it('quarantines failed-run commits and file state before restoring the exact clean base', async () => {
    const remote = mkdtempSync(path.join(tmpdir(), 'od-project-recovery-remote-'));
    tempDirs.push(remote);
    runGit(remote, ['init', '--bare']);
    const repo = makeRepo();
    await writeFile(path.join(repo, 'tracked.txt'), 'base\n');
    await writeFile(path.join(repo, 'deleted.txt'), 'delete me\n');
    runGit(repo, ['add', '-A']);
    runGit(repo, ['commit', '-m', 'base']);
    runGit(repo, ['branch', '-M', 'main']);
    runGit(repo, ['remote', 'add', 'origin', remote]);
    runGit(repo, ['push', '-u', 'origin', 'main']);
    const baseSha = runGit(repo, ['rev-parse', 'HEAD']).trim();
    expect(await quarantineProjectGitRunState(repo, {
      projectId: 'clean-project',
      runId: 'clean-run',
      baseSha,
      baseBranch: 'main',
    })).toEqual(expect.objectContaining({
      recoveryBranch: null,
      recoverySha: null,
      status: expect.objectContaining({ branch: 'main', clean: true }),
    }));

    runGit(repo, ['switch', '-c', 'open-design/agent-created']);
    await writeFile(path.join(repo, 'agent-commit.txt'), 'committed by the agent\n');
    runGit(repo, ['add', 'agent-commit.txt']);
    runGit(repo, ['commit', '-m', 'agent commit']);
    const agentCommit = runGit(repo, ['rev-parse', 'HEAD']).trim();
    await writeFile(path.join(repo, 'tracked.txt'), 'dirty working tree\n');
    rmSync(path.join(repo, 'deleted.txt'));
    await writeFile(path.join(repo, 'staged.txt'), 'staged state\n');
    runGit(repo, ['add', 'staged.txt']);
    await writeFile(path.join(repo, 'untracked.txt'), 'untracked state\n');
    await mkdir(path.join(repo, 'untracked-directory'));
    await writeFile(path.join(repo, 'untracked-directory', 'nested.txt'), 'nested untracked state\n');

    const result = await quarantineProjectGitRunState(repo, {
      projectId: 'project-123',
      runId: 'run-456',
      baseSha,
      baseBranch: 'main',
    });

    expect(result.recoveryBranch).toBe('open-design/recovery-project-123-run-456');
    const recoveryBranch = result.recoveryBranch!;
    const recoverySha = result.recoverySha!;
    expect(result.status.branch).toBe('main');
    expect(result.status.clean).toBe(true);
    expect(runGit(repo, ['rev-parse', 'HEAD']).trim()).toBe(baseSha);
    expect(runGit(repo, ['rev-parse', recoveryBranch]).trim()).toBe(recoverySha);
    expect(runGit(repo, ['show', `${recoverySha}:tracked.txt`])).toBe('dirty working tree\n');
    expect(runGit(repo, ['show', `${recoverySha}:staged.txt`])).toBe('staged state\n');
    expect(runGit(repo, ['show', `${recoverySha}:untracked.txt`])).toBe('untracked state\n');
    expect(runGit(repo, ['show', `${recoverySha}:untracked-directory/nested.txt`]))
      .toBe('nested untracked state\n');
    expect(runGit(repo, ['show', `${recoverySha}:agent-commit.txt`])).toBe('committed by the agent\n');
    expect(() => runGit(repo, ['cat-file', '-e', `${recoverySha}:deleted.txt`])).toThrow();
    expect(() => runGit(repo, ['merge-base', '--is-ancestor', agentCommit, recoverySha])).not.toThrow();
    expect(() => runGit(remote, ['rev-parse', `refs/heads/${recoveryBranch}`])).toThrow();

    const retried = await quarantineProjectGitRunState(repo, {
      projectId: 'project-123',
      runId: 'run-456',
      baseSha,
      baseBranch: 'main',
    });
    expect(retried.recoverySha).toBe(result.recoverySha);
    expect(runGit(repo, ['status', '--short'])).toBe('');
  });

  it('rejects untracked embedded Git repositories before staging and preserves all file state', async () => {
    const repo = makeRepo();
    await writeFile(path.join(repo, 'tracked.txt'), 'base\n');
    runGit(repo, ['add', '-A']);
    runGit(repo, ['commit', '-m', 'base']);
    runGit(repo, ['branch', '-M', 'main']);
    const baseSha = runGit(repo, ['rev-parse', 'HEAD']).trim();
    const embedded = path.join(repo, 'embedded');
    await mkdir(embedded);
    runGit(embedded, ['init']);
    runGit(embedded, ['config', 'user.name', 'Embedded Test']);
    runGit(embedded, ['config', 'user.email', 'embedded-test@example.invalid']);
    await writeFile(path.join(embedded, 'inner.txt'), 'embedded state\n');
    runGit(embedded, ['add', '-A']);
    runGit(embedded, ['commit', '-m', 'embedded commit']);
    const embeddedSha = runGit(embedded, ['rev-parse', 'HEAD']).trim();
    await mkdir(path.join(repo, 'ordinary-directory'));
    await writeFile(path.join(repo, 'ordinary-directory', 'file.txt'), 'ordinary state\n');
    await writeFile(path.join(repo, 'tracked.txt'), 'dirty state\n');
    const statusBefore = runGit(repo, ['status', '--porcelain=v1', '--untracked-files=all']);

    await expect(quarantineProjectGitRunState(repo, {
      projectId: 'project-embedded',
      runId: 'run-embedded',
      baseSha,
      baseBranch: 'main',
    })).rejects.toThrow(/untracked embedded Git repositories/i);

    expect(runGit(repo, ['status', '--porcelain=v1', '--untracked-files=all'])).toBe(statusBefore);
    expect(runGit(embedded, ['rev-parse', 'HEAD']).trim()).toBe(embeddedSha);
    expect(runGit(embedded, ['show', 'HEAD:inner.txt'])).toBe('embedded state\n');
    expect(() => runGit(repo, [
      'rev-parse',
      '--verify',
      'refs/heads/open-design/recovery-project-embedded-run-embedded',
    ])).toThrow();
  });

  it('rejects failed-run recovery from a nested project instead of cleaning outside its scope', async () => {
    const repo = makeRepo();
    const project = path.join(repo, 'project');
    await mkdir(project);
    await writeFile(path.join(project, 'tracked.txt'), 'base\n');
    runGit(repo, ['add', '-A']);
    runGit(repo, ['commit', '-m', 'base']);
    runGit(repo, ['branch', '-M', 'main']);
    const baseSha = runGit(repo, ['rev-parse', 'HEAD']).trim();

    await expect(quarantineProjectGitRunState(project, {
      projectId: 'project-123',
      runId: 'run-456',
      baseSha,
      baseBranch: 'main',
    })).rejects.toThrow(/rooted at the Git repository/i);
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

  it('discovers the remote default branch and verifies exact remote tips and ancestry', async () => {
    const remote = mkdtempSync(path.join(tmpdir(), 'od-project-git-binding-remote-'));
    tempDirs.push(remote);
    runGit(remote, ['init', '--bare']);
    const repo = makeRepo();
    await writeFile(path.join(repo, 'app.txt'), 'base\n');
    runGit(repo, ['add', '-A']);
    runGit(repo, ['commit', '-m', 'base']);
    runGit(repo, ['branch', '-M', 'master']);
    runGit(repo, ['remote', 'add', 'origin', remote]);
    runGit(repo, ['push', '-u', 'origin', 'master']);
    runGit(remote, ['symbolic-ref', 'HEAD', 'refs/heads/master']);
    const base = runGit(repo, ['rev-parse', 'HEAD']).trim();
    runGit(repo, ['switch', '-c', 'codex/preview']);
    await writeFile(path.join(repo, 'app.txt'), 'preview\n');
    runGit(repo, ['add', '-A']);
    runGit(repo, ['commit', '-m', 'preview']);
    runGit(repo, ['push', '-u', 'origin', 'codex/preview']);
    const commit = runGit(repo, ['rev-parse', 'HEAD']).trim();

    expect(await readProjectGitRemoteDefaultBranch(repo)).toBe('master');
    expect(await projectGitRefMatchesRevision(repo, commit, 'refs/remotes/origin/codex/preview', {
      fetchOriginBranch: 'codex/preview',
    })).toBe(true);
    expect(await projectGitRefMatchesRevision(repo, base, 'refs/remotes/origin/codex/preview')).toBe(false);
    expect(await projectGitRefMatchesRevision(repo, base, 'refs/remotes/origin/master', {
      fetchOriginBranch: 'master',
    })).toBe(true);
    expect(await readProjectGitRefRevision(repo, 'refs/remotes/origin/codex/preview', {
      fetchOriginBranch: 'codex/preview',
    })).toBe(commit);
    expect(await projectGitRevisionIsAncestor(repo, base, commit)).toBe(true);
  });

  it('reads canonical remote refs from the explicit URL instead of a mutable origin alias', async () => {
    const canonical = await makeBareRemote('main', 'canonical\n');
    const mutableOrigin = await makeBareRemote('trunk', 'mutable origin\n');
    const repo = makeRepo();
    runGit(repo, ['remote', 'add', 'origin', mutableOrigin.remote]);

    expect(await readProjectGitRemoteDefaultBranch(repo)).toBe('trunk');
    await expect(readProjectGitCanonicalRemoteHead(repo, canonical.remote)).resolves.toEqual({
      branch: 'main',
      sha: canonical.sha,
    });
    await expect(
      readProjectGitCanonicalRemoteBranchRevision(repo, canonical.remote, 'main'),
    ).resolves.toBe(canonical.sha);
  });

  it('CAS-deploys the approved target to the explicit canonical remote and primary branch', async () => {
    const repo = makeRepo();
    const canonicalRemote = mkdtempSync(path.join(tmpdir(), 'od-project-git-deploy-remote-'));
    const decoyRemote = mkdtempSync(path.join(tmpdir(), 'od-project-git-deploy-decoy-'));
    tempDirs.push(canonicalRemote, decoyRemote);
    runGit(canonicalRemote, ['init', '--bare']);
    runGit(decoyRemote, ['init', '--bare']);
    const scopePath = '99_System/core-v2';
    await mkdir(path.join(repo, scopePath), { recursive: true });
    await writeFile(path.join(repo, scopePath, 'app.txt'), 'base\n');
    await writeFile(path.join(repo, 'outside.txt'), 'outside base\n');
    runGit(repo, ['add', '-A']);
    runGit(repo, ['commit', '-m', 'base']);
    runGit(repo, ['branch', '-M', 'master']);
    const baseCommit = runGit(repo, ['rev-parse', 'HEAD']).trim();
    runGit(repo, ['remote', 'add', 'origin', canonicalRemote]);
    runGit(repo, ['push', '-u', 'origin', 'master']);
    runGit(canonicalRemote, ['symbolic-ref', 'HEAD', 'refs/heads/master']);

    runGit(repo, ['switch', '-c', 'codex/approved']);
    await writeFile(path.join(repo, scopePath, 'app.txt'), 'approved\n');
    runGit(repo, ['add', scopePath]);
    runGit(repo, ['commit', '-m', 'approved']);
    const targetCommit = runGit(repo, ['rev-parse', 'HEAD']).trim();
    runGit(repo, ['switch', 'master']);
    runGit(repo, ['remote', 'set-url', 'origin', decoyRemote]);
    runGit(repo, ['config', `url.${decoyRemote}.insteadOf`, canonicalRemote]);
    expect(runGit(repo, ['ls-remote', '--get-url', canonicalRemote]).trim()).toBe(decoyRemote);
    await writeFile(path.join(repo, 'outside.txt'), 'unrelated dirty work\n');

    await expect(deployProjectGitCanonicalRevision(repo, {
      expectedRemoteUrl: canonicalRemote,
      baseBranch: 'master',
      baseCommit,
      targetCommit,
      scopePath,
    })).resolves.toEqual(expect.objectContaining({
      branch: 'master',
      clean: true,
      lastCommit: expect.objectContaining({ hash: targetCommit }),
    }));
    expect(runGit(canonicalRemote, ['rev-parse', 'refs/heads/master']).trim()).toBe(targetCommit);
    expect(runGit(decoyRemote, ['for-each-ref', '--format=%(refname)']).trim()).toBe('');
    expect(runGit(repo, ['rev-parse', 'HEAD']).trim()).toBe(targetCommit);
    expect(await readFile(path.join(repo, 'outside.txt'), 'utf8')).toBe('unrelated dirty work\n');

    await expect(deployProjectGitCanonicalRevision(repo, {
      expectedRemoteUrl: canonicalRemote,
      baseBranch: 'master',
      baseCommit,
      targetCommit,
      scopePath,
    })).resolves.toEqual(expect.objectContaining({
      branch: 'master',
      clean: true,
      lastCommit: expect.objectContaining({ hash: targetCommit }),
    }));

    runGit(repo, ['config', '--unset-all', `url.${decoyRemote}.insteadOf`]);
    runGit(repo, ['switch', '-c', 'drift', baseCommit]);
    await writeFile(path.join(repo, scopePath, 'app.txt'), 'drift\n');
    runGit(repo, ['add', scopePath]);
    runGit(repo, ['commit', '-m', 'drift']);
    const driftCommit = runGit(repo, ['rev-parse', 'HEAD']).trim();
    runGit(repo, ['push', '--force', canonicalRemote, `${driftCommit}:refs/heads/master`]);
    runGit(repo, ['switch', 'master']);
    await expect(deployProjectGitCanonicalRevision(repo, {
      expectedRemoteUrl: canonicalRemote,
      baseBranch: 'master',
      baseCommit,
      targetCommit,
      scopePath,
    })).rejects.toThrow('outside the frozen base-to-target deployment transition');
  });

  it('reconciles both supported partial canonical deployment states', async () => {
    const repo = makeRepo();
    const canonicalRemote = mkdtempSync(path.join(tmpdir(), 'od-project-git-partial-remote-'));
    tempDirs.push(canonicalRemote);
    runGit(canonicalRemote, ['init', '--bare']);
    const scopePath = '99_System/core-v2';
    await mkdir(path.join(repo, scopePath), { recursive: true });
    await writeFile(path.join(repo, scopePath, 'app.txt'), 'base\n');
    runGit(repo, ['add', '-A']);
    runGit(repo, ['commit', '-m', 'base']);
    runGit(repo, ['branch', '-M', 'master']);
    const baseCommit = runGit(repo, ['rev-parse', 'HEAD']).trim();
    runGit(repo, ['remote', 'add', 'origin', canonicalRemote]);
    runGit(repo, ['push', '-u', 'origin', 'master']);
    runGit(canonicalRemote, ['symbolic-ref', 'HEAD', 'refs/heads/master']);
    runGit(repo, ['switch', '-c', 'codex/approved']);
    await writeFile(path.join(repo, scopePath, 'app.txt'), 'approved\n');
    runGit(repo, ['add', scopePath]);
    runGit(repo, ['commit', '-m', 'approved']);
    const targetCommit = runGit(repo, ['rev-parse', 'HEAD']).trim();
    runGit(repo, ['switch', 'master']);

    runGit(repo, ['push', canonicalRemote, `${targetCommit}:refs/heads/master`]);
    await expect(deployProjectGitCanonicalRevision(repo, {
      expectedRemoteUrl: canonicalRemote,
      baseBranch: 'master',
      baseCommit,
      targetCommit,
      scopePath,
    })).resolves.toEqual(expect.objectContaining({
      lastCommit: expect.objectContaining({ hash: targetCommit }),
    }));

    runGit(repo, ['push', '--force', canonicalRemote, `${baseCommit}:refs/heads/master`]);
    await expect(deployProjectGitCanonicalRevision(repo, {
      expectedRemoteUrl: canonicalRemote,
      baseBranch: 'master',
      baseCommit,
      targetCommit,
      scopePath,
    })).resolves.toEqual(expect.objectContaining({
      lastCommit: expect.objectContaining({ hash: targetCommit }),
    }));
    expect(runGit(canonicalRemote, ['rev-parse', 'refs/heads/master']).trim()).toBe(targetCommit);
  });

  it('isolates canonical remote reads from local and inherited insteadOf configuration', async () => {
    const canonical = await makeBareRemote('main', 'canonical\n');
    const redirected = await makeBareRemote('main', 'redirected\n');
    const repo = makeRepo();
    runGit(repo, ['config', `url.${redirected.remote}.insteadOf`, canonical.remote]);
    expect(runGit(repo, ['ls-remote', '--get-url', canonical.remote]).trim()).toBe(redirected.remote);

    const inheritedKeys = [
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_0',
      'GIT_CONFIG_VALUE_0',
    ] as const;
    const inheritedBefore = new Map(inheritedKeys.map((key) => [key, process.env[key]]));
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = `url.${redirected.remote}.insteadOf`;
    process.env.GIT_CONFIG_VALUE_0 = canonical.remote;
    try {
      await expect(readProjectGitCanonicalRemoteHead(repo, canonical.remote)).resolves.toEqual({
        branch: 'main',
        sha: canonical.sha,
      });
      await expect(
        readProjectGitCanonicalRemoteBranchRevision(repo, canonical.remote, 'main'),
      ).resolves.toBe(canonical.sha);
    } finally {
      for (const key of inheritedKeys) {
        const previous = inheritedBefore.get(key);
        if (previous == null) delete process.env[key];
        else process.env[key] = previous;
      }
    }
  });

  it('ignores inherited Git SSH overrides and uses a strict static SSH command', async () => {
    const canonical = await makeBareRemote('main', 'canonical over ssh\n');
    const repo = makeRepo();
    const fakeBin = mkdtempSync(path.join(tmpdir(), 'od-project-git-fake-ssh-'));
    tempDirs.push(fakeBin);
    const fakeSsh = path.join(fakeBin, 'ssh');
    const poisonSsh = path.join(fakeBin, 'poison-ssh');
    const sshArgsLog = path.join(fakeBin, 'ssh-args.log');
    const sshAuthLog = path.join(fakeBin, 'ssh-auth.log');
    const poisonLog = path.join(fakeBin, 'poison.log');
    await writeFile(fakeSsh, [
      '#!/bin/sh',
      'printf \'%s\\n\' "$@" > "$OD_TEST_SSH_ARGS_LOG"',
      'printf \'%s\' "$SSH_AUTH_SOCK" > "$OD_TEST_SSH_AUTH_LOG"',
      'last=\'\'',
      'for argument in "$@"; do last=$argument; done',
      'exec /bin/sh -c "exec $last"',
      '',
    ].join('\n'), { mode: 0o755 });
    await writeFile(poisonSsh, [
      '#!/bin/sh',
      'printf \'invoked\\n\' > "$OD_TEST_POISON_LOG"',
      'exit 97',
      '',
    ].join('\n'), { mode: 0o755 });

    const inheritedKeys = [
      'PATH',
      'GIT_ALLOW_PROTOCOL',
      'GIT_SSH_COMMAND',
      'GIT_SSH_VARIANT',
      'SSH_AUTH_SOCK',
      'OD_TEST_SSH_ARGS_LOG',
      'OD_TEST_SSH_AUTH_LOG',
      'OD_TEST_POISON_LOG',
    ] as const;
    const inheritedBefore = new Map(inheritedKeys.map((key) => [key, process.env[key]]));
    process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`;
    process.env.GIT_ALLOW_PROTOCOL = 'file';
    process.env.GIT_SSH_COMMAND = poisonSsh;
    process.env.GIT_SSH_VARIANT = 'plink';
    process.env.SSH_AUTH_SOCK = '/tmp/open-design-test-agent.sock';
    process.env.OD_TEST_SSH_ARGS_LOG = sshArgsLog;
    process.env.OD_TEST_SSH_AUTH_LOG = sshAuthLog;
    process.env.OD_TEST_POISON_LOG = poisonLog;
    let head;
    try {
      head = await readProjectGitCanonicalRemoteHead(
        repo,
        `git@example.invalid:${canonical.remote}`,
      );
    } finally {
      for (const key of inheritedKeys) {
        const previous = inheritedBefore.get(key);
        if (previous == null) delete process.env[key];
        else process.env[key] = previous;
      }
    }

    expect(head).toEqual({ branch: 'main', sha: canonical.sha });
    expect(existsSync(poisonLog)).toBe(false);
    expect(await readFile(sshAuthLog, 'utf8')).toBe('/tmp/open-design-test-agent.sock');
    expect((await readFile(sshArgsLog, 'utf8')).trim().split('\n')).toEqual(expect.arrayContaining([
      '-F',
      '/dev/null',
      'BatchMode=yes',
      'StrictHostKeyChecking=yes',
      'ProxyCommand=none',
      'ProxyJump=none',
      'ControlMaster=no',
      'ControlPath=none',
      'ControlPersist=no',
      'ForwardAgent=no',
      'ClearAllForwardings=yes',
    ]));
  });

  it('requires an exact linear implementation and attestation commit with only canonical attestation paths', async () => {
    const repo = makeRepo();
    const appPath = path.join(repo, '99_System', 'core-v2', 'apps', 'web', 'src', 'app.html');
    const implementationPath = path.join(
      repo,
      '99_System',
      'core-v2',
      'apps',
      'web',
      'src',
      'lib',
      'implemented.ts',
    );
    const receiptPath = '99_System/core-v2/apps/web/static/open-design/attestations/proof.json';
    await mkdir(path.dirname(appPath), { recursive: true });
    await writeFile(appPath, '<html><!-- sentinel --></html>\n');
    runGit(repo, ['add', '-A']);
    runGit(repo, ['commit', '-m', 'base']);
    const baseCommit = runGit(repo, ['rev-parse', 'HEAD']).trim();
    await mkdir(path.dirname(implementationPath), { recursive: true });
    await writeFile(implementationPath, 'export const implemented = true;\n');
    runGit(repo, ['add', '-A']);
    runGit(repo, ['commit', '-m', 'implementation']);
    const implementationCommit = runGit(repo, ['rev-parse', 'HEAD']).trim();
    await writeFile(appPath, '<html><meta name="proof"></html>\n');
    await mkdir(path.dirname(path.join(repo, receiptPath)), { recursive: true });
    await writeFile(path.join(repo, receiptPath), '{"proof":true}\n');
    runGit(repo, ['add', '-A']);
    runGit(repo, ['commit', '-m', 'attestation']);
    const attestationCommit = runGit(repo, ['rev-parse', 'HEAD']).trim();

    await expect(verifyProjectGitLinearAttestation(repo, {
      baseCommit,
      implementationCommit,
      attestationCommit,
      appPath: '99_System/core-v2/apps/web/src/app.html',
      receiptPath,
    })).resolves.toBeUndefined();

    runGit(repo, ['switch', '--detach', implementationCommit]);
    await writeFile(appPath, '<html><meta name="proof"></html>\n');
    await mkdir(path.dirname(path.join(repo, receiptPath)), { recursive: true });
    await writeFile(path.join(repo, receiptPath), '{"proof":true}\n');
    await writeFile(path.join(repo, 'extra.txt'), 'hidden attestation change\n');
    runGit(repo, ['add', '-A']);
    runGit(repo, ['commit', '-m', 'bad attestation']);
    const badAttestation = runGit(repo, ['rev-parse', 'HEAD']).trim();
    await expect(verifyProjectGitLinearAttestation(repo, {
      baseCommit,
      implementationCommit,
      attestationCommit: badAttestation,
      appPath: '99_System/core-v2/apps/web/src/app.html',
      receiptPath,
    })).rejects.toThrow('may change only the app template sentinel and the unique receipt');

    runGit(repo, ['switch', '--detach', baseCommit]);
    await writeFile(path.join(repo, 'package.json'), '{"name":"out-of-scope"}\n');
    runGit(repo, ['add', 'package.json']);
    runGit(repo, ['commit', '-m', 'out-of-scope implementation']);
    const outOfScopeImplementation = runGit(repo, ['rev-parse', 'HEAD']).trim();
    await writeFile(appPath, '<html><meta name="proof"></html>\n');
    await mkdir(path.dirname(path.join(repo, receiptPath)), { recursive: true });
    await writeFile(path.join(repo, receiptPath), '{"proof":true}\n');
    runGit(repo, ['add', '-A']);
    runGit(repo, ['commit', '-m', 'attestation after out-of-scope implementation']);
    const outOfScopeAttestation = runGit(repo, ['rev-parse', 'HEAD']).trim();
    await expect(verifyProjectGitLinearAttestation(repo, {
      baseCommit,
      implementationCommit: outOfScopeImplementation,
      attestationCommit: outOfScopeAttestation,
      appPath: '99_System/core-v2/apps/web/src/app.html',
      receiptPath,
    })).rejects.toThrow('may change only web source/static files');
  });

  it('rejects a symlink added by the Core UI implementation commit', async () => {
    const repo = makeRepo();
    const appPath = '99_System/core-v2/apps/web/src/app.html';
    const symlinkPath = '99_System/core-v2/apps/web/src/lib/linked.ts';
    const receiptPath = '99_System/core-v2/apps/web/static/open-design/attestations/proof.json';
    await mkdir(path.dirname(path.join(repo, appPath)), { recursive: true });
    await writeFile(path.join(repo, appPath), '<html><!-- sentinel --></html>\n');
    runGit(repo, ['add', '-A']);
    runGit(repo, ['commit', '-m', 'base']);
    const baseCommit = runGit(repo, ['rev-parse', 'HEAD']).trim();
    await mkdir(path.dirname(path.join(repo, symlinkPath)), { recursive: true });
    await symlink('implemented.ts', path.join(repo, symlinkPath));
    runGit(repo, ['add', '-A']);
    runGit(repo, ['commit', '-m', 'symlink implementation']);
    const implementationCommit = runGit(repo, ['rev-parse', 'HEAD']).trim();
    await writeFile(path.join(repo, appPath), '<html><meta name="proof"></html>\n');
    await mkdir(path.dirname(path.join(repo, receiptPath)), { recursive: true });
    await writeFile(path.join(repo, receiptPath), '{"proof":true}\n');
    runGit(repo, ['add', '--', appPath, receiptPath]);
    runGit(repo, ['commit', '-m', 'attestation']);
    const attestationCommit = runGit(repo, ['rev-parse', 'HEAD']).trim();

    await expect(verifyProjectGitLinearAttestation(repo, {
      baseCommit,
      implementationCommit,
      attestationCommit,
      appPath,
      receiptPath,
    })).rejects.toThrow('must be deleted or ordinary 100644/100755 blobs');
  });

  it('rejects a gitlink added by the Core UI implementation commit', async () => {
    const repo = makeRepo();
    const appPath = '99_System/core-v2/apps/web/src/app.html';
    const gitlinkPath = '99_System/core-v2/apps/web/src/vendor/untrusted-submodule';
    const receiptPath = '99_System/core-v2/apps/web/static/open-design/attestations/proof.json';
    await mkdir(path.dirname(path.join(repo, appPath)), { recursive: true });
    await writeFile(path.join(repo, appPath), '<html><!-- sentinel --></html>\n');
    runGit(repo, ['add', '-A']);
    runGit(repo, ['commit', '-m', 'base']);
    const baseCommit = runGit(repo, ['rev-parse', 'HEAD']).trim();
    runGit(repo, ['update-index', '--add', '--cacheinfo', `160000,${baseCommit},${gitlinkPath}`]);
    runGit(repo, ['commit', '-m', 'gitlink implementation']);
    const implementationCommit = runGit(repo, ['rev-parse', 'HEAD']).trim();
    await writeFile(path.join(repo, appPath), '<html><meta name="proof"></html>\n');
    await mkdir(path.dirname(path.join(repo, receiptPath)), { recursive: true });
    await writeFile(path.join(repo, receiptPath), '{"proof":true}\n');
    runGit(repo, ['add', '--', appPath, receiptPath]);
    runGit(repo, ['commit', '-m', 'attestation']);
    const attestationCommit = runGit(repo, ['rev-parse', 'HEAD']).trim();

    await expect(verifyProjectGitLinearAttestation(repo, {
      baseCommit,
      implementationCommit,
      attestationCommit,
      appPath,
      receiptPath,
    })).rejects.toThrow('must be deleted or ordinary 100644/100755 blobs');
  });
});
