import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  isCoreUiCustomizationSaveResult,
  type CoreUiCustomizationSaveResult,
} from '@open-design/contracts';

export const CORE_UI_PROJECT_SAVE_IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

export interface CoreUiProjectSaveHttpResult {
  status: number;
  receipt: CoreUiCustomizationSaveResult;
}

export interface CoordinatedCoreUiProjectSaveResult extends CoreUiProjectSaveHttpResult {
  replayed: boolean;
  idempotencyPersisted: boolean;
}

export interface CoreUiProjectSaveCoordinatorOptions {
  idempotencyDir: string;
  ttlMs?: number;
  now?: () => Date;
}

export interface RunCoordinatedCoreUiProjectSaveOptions {
  projectId: string;
  artifactId: string;
  requestId: string;
  fingerprint: string;
  execute: () => Promise<CoreUiProjectSaveHttpResult>;
}

interface CompletedRequestRecord {
  schemaVersion: 1;
  projectId: string;
  artifactId: string;
  requestId: string;
  fingerprint: string;
  completedAt: string;
  expiresAt: string;
  result: CoreUiProjectSaveHttpResult;
  idempotencyPersisted: boolean;
}

interface InFlightRequest {
  fingerprint: string;
  promise: Promise<CoordinatedCoreUiProjectSaveResult>;
}

export class CoreUiProjectSaveRequestIdConflictError extends Error {
  constructor() {
    super('Save request id was already used with different content.');
    this.name = 'CoreUiProjectSaveRequestIdConflictError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function idempotencyKey(projectId: string, artifactId: string, requestId: string): string {
  return `${projectId}\0${artifactId}\0${requestId}`;
}

function resourceKey(projectId: string, artifactId: string): string {
  return `${projectId}\0${artifactId}`;
}

function recordFileName(key: string): string {
  return `${createHash('sha256').update(key).digest('hex')}.json`;
}

function parseCompletedRequestRecord(value: unknown): CompletedRequestRecord | null {
  if (!isPlainObject(value) || value.schemaVersion !== 1) return null;
  if (
    typeof value.projectId !== 'string'
    || typeof value.artifactId !== 'string'
    || typeof value.requestId !== 'string'
    || typeof value.fingerprint !== 'string'
    || typeof value.completedAt !== 'string'
    || typeof value.expiresAt !== 'string'
    || !isPlainObject(value.result)
    || !Number.isInteger(value.result.status)
    || !isCoreUiCustomizationSaveResult(value.result.receipt)
  ) return null;
  const completedAtMs = Date.parse(value.completedAt);
  const expiresAtMs = Date.parse(value.expiresAt);
  if (!Number.isFinite(completedAtMs) || !Number.isFinite(expiresAtMs) || expiresAtMs <= completedAtMs) return null;
  return { ...(value as unknown as CompletedRequestRecord), idempotencyPersisted: true };
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export class CoreUiProjectSaveCoordinator {
  private readonly completed = new Map<string, CompletedRequestRecord>();
  private readonly inFlight = new Map<string, InFlightRequest>();
  private readonly resourceTails = new Map<string, Promise<void>>();
  private readonly idempotencyDir: string;
  private readonly now: () => Date;
  private readonly ttlMs: number;

  constructor(options: CoreUiProjectSaveCoordinatorOptions) {
    this.idempotencyDir = options.idempotencyDir;
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? CORE_UI_PROJECT_SAVE_IDEMPOTENCY_TTL_MS;
  }

  async run(options: RunCoordinatedCoreUiProjectSaveOptions): Promise<CoordinatedCoreUiProjectSaveResult> {
    const key = idempotencyKey(options.projectId, options.artifactId, options.requestId);
    const existing = this.inFlight.get(key);
    if (existing) {
      if (existing.fingerprint !== options.fingerprint) throw new CoreUiProjectSaveRequestIdConflictError();
      return { ...(await existing.promise), replayed: true };
    }

    const promise = this.runFresh(key, options);
    this.inFlight.set(key, { fingerprint: options.fingerprint, promise });
    try {
      return await promise;
    } finally {
      if (this.inFlight.get(key)?.promise === promise) this.inFlight.delete(key);
    }
  }

  private async runFresh(
    key: string,
    options: RunCoordinatedCoreUiProjectSaveOptions,
  ): Promise<CoordinatedCoreUiProjectSaveResult> {
    return this.enqueue(resourceKey(options.projectId, options.artifactId), async () => {
      const cached = await this.readCompleted(key, options);
      if (cached) return {
        ...cached.result,
        replayed: true,
        idempotencyPersisted: cached.idempotencyPersisted,
      };

      const result = await options.execute();
      const completedAt = this.now();
      const record: CompletedRequestRecord = {
        schemaVersion: 1,
        projectId: options.projectId,
        artifactId: options.artifactId,
        requestId: options.requestId,
        fingerprint: options.fingerprint,
        completedAt: completedAt.toISOString(),
        expiresAt: new Date(completedAt.getTime() + this.ttlMs).toISOString(),
        result,
        idempotencyPersisted: false,
      };
      this.completed.set(key, record);
      await this.persistCompleted(key, record)
        .then(() => { record.idempotencyPersisted = true; })
        .catch(() => {});
      return { ...result, replayed: false, idempotencyPersisted: record.idempotencyPersisted };
    });
  }

  private async readCompleted(
    key: string,
    options: Pick<RunCoordinatedCoreUiProjectSaveOptions, 'projectId' | 'artifactId' | 'requestId' | 'fingerprint'>,
  ): Promise<CompletedRequestRecord | null> {
    let record = this.completed.get(key) ?? null;
    const filePath = path.join(this.idempotencyDir, recordFileName(key));
    if (!record) {
      try {
        record = parseCompletedRequestRecord(JSON.parse(await readFile(filePath, 'utf8')));
      } catch {
        record = null;
      }
      if (record) this.completed.set(key, record);
    }
    if (!record) return null;
    if (
      record.projectId !== options.projectId
      || record.artifactId !== options.artifactId
      || record.requestId !== options.requestId
    ) return null;
    if (Date.parse(record.expiresAt) <= this.now().getTime()) {
      this.completed.delete(key);
      await rm(filePath, { force: true }).catch(() => {});
      return null;
    }
    if (record.fingerprint !== options.fingerprint) throw new CoreUiProjectSaveRequestIdConflictError();
    return record;
  }

  private async persistCompleted(key: string, record: CompletedRequestRecord): Promise<void> {
    await mkdir(this.idempotencyDir, { recursive: true });
    await writeJsonAtomic(path.join(this.idempotencyDir, recordFileName(key)), record);
  }

  private async enqueue<T>(key: string, execute: () => Promise<T>): Promise<T> {
    const previous = this.resourceTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const slot = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => slot);
    this.resourceTails.set(key, tail);
    await previous;
    try {
      return await execute();
    } finally {
      release();
      if (this.resourceTails.get(key) === tail) this.resourceTails.delete(key);
    }
  }
}
