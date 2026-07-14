import type { CoreUiCustomizationSaveResult } from '@open-design/contracts';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CoreUiProjectSaveCoordinator,
  CoreUiProjectSaveRequestIdConflictError,
} from '../../src/live-artifacts/project-save-coordinator.js';

const revision = `sha256:${'a'.repeat(64)}`;

function receipt(requestId: string, message = 'Saved to canonical project files.'): CoreUiCustomizationSaveResult {
  return {
    type: 'od:live-artifact-project-save-result',
    version: 2,
    requestId,
    ok: true,
    code: 'saved',
    revision,
    message,
  };
}

describe('Core UI project-save coordinator', () => {
  let root: string;
  let nowMs: number;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'od-core-ui-idempotency-'));
    nowMs = Date.parse('2026-07-14T12:00:00.000Z');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function coordinator(ttlMs = 60_000) {
    return new CoreUiProjectSaveCoordinator({
      idempotencyDir: root,
      ttlMs,
      now: () => new Date(nowMs),
    });
  }

  function options(requestId: string, fingerprint: string, execute: () => Promise<{ status: number; receipt: CoreUiCustomizationSaveResult }>) {
    return { projectId: 'project-1', artifactId: 'artifact-1', requestId, fingerprint, execute };
  }

  it('returns the original completed receipt for a duplicate request id without repeating writes', async () => {
    const subject = coordinator();
    const execute = vi.fn(async () => ({ status: 200, receipt: receipt('request-1') }));

    const first = await subject.run(options('request-1', 'fingerprint-1', execute));
    const duplicate = await subject.run(options('request-1', 'fingerprint-1', execute));

    expect(first).toMatchObject({ status: 200, replayed: false });
    expect(duplicate).toEqual({ ...first, replayed: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('persists completed request ids across coordinator restart/reopen', async () => {
    const execute = vi.fn(async () => ({ status: 200, receipt: receipt('request-reopen') }));
    const first = await coordinator().run(options('request-reopen', 'fingerprint-reopen', execute));
    const reopenedExecute = vi.fn(async () => ({
      status: 500,
      receipt: { ...receipt('request-reopen'), ok: false, code: 'failed' as const, revision: null, message: 'must not execute' },
    }));

    const reopened = await coordinator().run(options('request-reopen', 'fingerprint-reopen', reopenedExecute));

    expect(reopened).toEqual({ ...first, replayed: true });
    expect(reopenedExecute).not.toHaveBeenCalled();
  });

  it('expires completed request ids after the bounded idempotency period', async () => {
    const subject = coordinator(1_000);
    const execute = vi.fn(async () => ({ status: 200, receipt: receipt('request-expiring') }));
    await subject.run(options('request-expiring', 'fingerprint-expiring', execute));
    nowMs += 1_001;

    const retried = await subject.run(options('request-expiring', 'fingerprint-expiring', execute));

    expect(retried.replayed).toBe(false);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('does not accept a malformed persisted expiry as an unbounded idempotency record', async () => {
    await coordinator().run(options('request-malformed', 'fingerprint-malformed', async () => ({
      status: 200,
      receipt: receipt('request-malformed'),
    })));
    const [recordName] = await readdir(root);
    if (!recordName) throw new Error('persisted idempotency record was not created');
    const recordPath = path.join(root, recordName);
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as Record<string, unknown>;
    await writeFile(recordPath, `${JSON.stringify({ ...record, expiresAt: 'not-a-date' })}\n`, 'utf8');
    const execute = vi.fn(async () => ({ status: 200, receipt: receipt('request-malformed') }));

    const reopened = await coordinator().run(options('request-malformed', 'fingerprint-malformed', execute));

    expect(reopened.replayed).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('makes a machine-local idempotency persistence failure explicit while retaining in-process replay', async () => {
    const blockedPath = path.join(root, 'not-a-directory');
    await writeFile(blockedPath, 'blocked', 'utf8');
    const subject = new CoreUiProjectSaveCoordinator({ idempotencyDir: blockedPath });
    const execute = vi.fn(async () => ({ status: 200, receipt: receipt('request-degraded') }));

    const first = await subject.run(options('request-degraded', 'fingerprint-degraded', execute));
    const retry = await subject.run(options('request-degraded', 'fingerprint-degraded', execute));

    expect(first).toMatchObject({ replayed: false, idempotencyPersisted: false });
    expect(retry).toEqual({ ...first, replayed: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rejects reuse of a request id with different content', async () => {
    const subject = coordinator();
    await subject.run(options('request-conflict', 'fingerprint-a', async () => ({
      status: 200,
      receipt: receipt('request-conflict'),
    })));

    await expect(subject.run(options('request-conflict', 'fingerprint-b', async () => ({
      status: 200,
      receipt: receipt('request-conflict'),
    })))).rejects.toBeInstanceOf(CoreUiProjectSaveRequestIdConflictError);
  });

  it('serializes overlapping requests for the same project and artifact', async () => {
    const subject = coordinator();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = subject.run(options('request-first', 'fingerprint-first', async () => {
      events.push('first:start');
      await firstGate;
      events.push('first:end');
      return { status: 200, receipt: receipt('request-first') };
    }));
    const second = subject.run(options('request-second', 'fingerprint-second', async () => {
      events.push('second:start');
      events.push('second:end');
      return { status: 409, receipt: {
        ...receipt('request-second', 'Canonical customization changed; your preview selections remain local.'),
        ok: false,
        code: 'conflict',
      } };
    }));

    await vi.waitFor(() => expect(events).toEqual(['first:start']));
    releaseFirst();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    expect(firstResult.status).toBe(200);
    expect(secondResult).toMatchObject({ status: 409, receipt: { code: 'conflict' } });
  });

  it('deduplicates overlapping retries with the same request id', async () => {
    const subject = coordinator();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async () => {
      await gate;
      return { status: 200, receipt: receipt('request-overlap') };
    });
    const first = subject.run(options('request-overlap', 'fingerprint-overlap', execute));
    const retry = subject.run(options('request-overlap', 'fingerprint-overlap', execute));
    release();

    const [firstResult, retryResult] = await Promise.all([first, retry]);
    expect(firstResult.replayed).toBe(false);
    expect(retryResult).toEqual({ ...firstResult, replayed: true });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
