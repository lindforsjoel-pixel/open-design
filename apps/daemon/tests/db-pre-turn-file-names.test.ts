import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  closeDatabase,
  insertConversation,
  insertProject,
  listMessages,
  openDatabase,
  upsertMessage,
} from '../src/db.js';

describe('pre-turn file baseline persistence', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-db-pre-turn-'));
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function seedConversation(db: ReturnType<typeof openDatabase>) {
    const now = Date.now();
    insertProject(db, { id: 'proj-1', name: 'P', createdAt: now, updatedAt: now });
    insertConversation(db, {
      id: 'conv-1',
      projectId: 'proj-1',
      title: 'C',
      createdAt: now,
      updatedAt: now,
    });
    return now;
  }

  it('round-trips preTurnFileNames through upsert and listMessages', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const now = seedConversation(db);
    upsertMessage(db, 'conv-1', {
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      runId: 'run-1',
      runStatus: 'running',
      startedAt: now,
      preTurnFileNames: ['existing.html', 'README.md'],
      preTurnFileFingerprints: [
        { name: 'existing.html', size: 120, mtime: 1_000 },
        { name: 'README.md', size: 40, mtime: 2_000 },
      ],
    });

    const reloaded = listMessages(db, 'conv-1');
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]!.preTurnFileNames).toEqual(['existing.html', 'README.md']);
    expect(reloaded[0]!.preTurnFileFingerprints).toEqual([
      { name: 'existing.html', size: 120, mtime: 1_000 },
      { name: 'README.md', size: 40, mtime: 2_000 },
    ]);
  });

  it('preserves both baselines across a subsequent UPDATE upsert', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const now = seedConversation(db);
    upsertMessage(db, 'conv-1', {
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      runId: 'run-1',
      runStatus: 'running',
      startedAt: now,
      preTurnFileNames: ['existing.html'],
      preTurnFileFingerprints: [{ name: 'existing.html', size: 10, mtime: 1_000 }],
    });
    upsertMessage(db, 'conv-1', {
      id: 'assistant-1',
      role: 'assistant',
      content: 'streamed chunk',
      runId: 'run-1',
      runStatus: 'running',
      startedAt: now,
      preTurnFileNames: ['existing.html'],
      preTurnFileFingerprints: [{ name: 'existing.html', size: 10, mtime: 1_000 }],
    });

    const [msg] = listMessages(db, 'conv-1');
    expect(msg).toBeDefined();
    expect(msg!.preTurnFileNames).toEqual(['existing.html']);
    expect(msg!.preTurnFileFingerprints).toEqual([
      { name: 'existing.html', size: 10, mtime: 1_000 },
    ]);
  });

  it('returns undefined when no baseline was ever written (legacy messages)', () => {
    const db = openDatabase(tempDir, { dataDir: tempDir });
    const now = seedConversation(db);
    upsertMessage(db, 'conv-1', {
      id: 'assistant-1',
      role: 'assistant',
      content: '',
      runStatus: 'running',
      startedAt: now,
    });

    const [msg] = listMessages(db, 'conv-1');
    expect(msg).toBeDefined();
    expect(msg!.preTurnFileNames).toBeUndefined();
    expect(msg!.preTurnFileFingerprints).toBeUndefined();
  });
});
