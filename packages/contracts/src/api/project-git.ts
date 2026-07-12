export type ProjectGitChangeKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'type-changed'
  | 'untracked'
  | 'conflicted';

export interface ProjectGitChange {
  path: string;
  originalPath?: string;
  kind: ProjectGitChangeKind;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  conflicted: boolean;
}

export interface ProjectGitCommitSummary {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  authoredAt: string;
}

export interface ProjectGitStatusResponse {
  available: boolean;
  repository: boolean;
  projectRoot: string;
  repositoryRoot: string | null;
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  clean: boolean;
  changes: ProjectGitChange[];
  truncated: boolean;
  lastCommit: ProjectGitCommitSummary | null;
  error?: string;
}

export interface ProjectGitCommitRequest {
  message: string;
  paths: string[];
}

export interface ProjectGitCommitResponse {
  commit: ProjectGitCommitSummary;
  status: ProjectGitStatusResponse;
}
