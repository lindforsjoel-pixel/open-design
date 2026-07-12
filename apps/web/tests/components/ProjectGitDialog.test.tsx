// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectGitStatusResponse } from '@open-design/contracts';
import { ProjectGitDialog } from '../../src/components/ProjectGitDialog';
import {
  commitProjectGitChanges,
  fetchProjectGitStatus,
  initializeProjectGit,
} from '../../src/providers/registry';

const repositoryStatus: ProjectGitStatusResponse = {
  available: true,
  repository: true,
  projectRoot: '/workspace/project',
  repositoryRoot: '/workspace/project',
  branch: 'feat/project-git',
  detached: false,
  upstream: 'origin/feat/project-git',
  ahead: 1,
  behind: 0,
  clean: false,
  changes: [
    {
      path: 'src/app.ts',
      kind: 'modified',
      indexStatus: ' ',
      worktreeStatus: 'M',
      staged: false,
      unstaged: true,
      conflicted: false,
    },
    {
      path: 'notes.txt',
      kind: 'untracked',
      indexStatus: '?',
      worktreeStatus: '?',
      staged: false,
      unstaged: true,
      conflicted: false,
    },
  ],
  truncated: false,
  lastCommit: null,
};

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    fetchProjectGitStatus: vi.fn(),
    initializeProjectGit: vi.fn(),
    commitProjectGitChanges: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProjectGitDialog', () => {
  it('commits only explicitly selected project files', async () => {
    vi.mocked(fetchProjectGitStatus).mockResolvedValue(repositoryStatus);
    vi.mocked(commitProjectGitChanges).mockResolvedValue({
      commit: {
        hash: 'abc123456789',
        shortHash: 'abc1234',
        subject: 'Update app',
        author: 'Test',
        authoredAt: '2026-07-12T10:00:00Z',
      },
      status: { ...repositoryStatus, clean: true, changes: [] },
    });

    render(<ProjectGitDialog projectId="project-1" onClose={() => {}} />);

    await screen.findByText('feat/project-git');
    fireEvent.click(screen.getByRole('checkbox', { name: 'src/app.ts' }));
    fireEvent.change(screen.getByPlaceholderText('Describe this version'), {
      target: { value: 'Update app' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Commit selected (1)' }));

    await waitFor(() => {
      expect(vi.mocked(commitProjectGitChanges)).toHaveBeenCalledWith('project-1', {
        message: 'Update app',
        paths: ['src/app.ts'],
      });
    });
    expect(await screen.findByText('Working tree clean')).toBeTruthy();
  });

  it('offers local initialization without implying a push', async () => {
    const unversioned = { ...repositoryStatus, repository: false, repositoryRoot: null, changes: [], clean: true };
    vi.mocked(fetchProjectGitStatus).mockResolvedValue(unversioned);
    vi.mocked(initializeProjectGit).mockResolvedValue({ ...unversioned, repository: true });

    render(<ProjectGitDialog projectId="project-1" onClose={() => {}} />);

    expect(await screen.findByText('This project is not versioned yet')).toBeTruthy();
    expect(screen.getByText('Initialize a local Git repository. Nothing is pushed or published.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Initialize Git' }));

    await waitFor(() => expect(vi.mocked(initializeProjectGit)).toHaveBeenCalledWith('project-1'));
  });
});
