import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const VERIFIER_TIMEOUT_MS = 30 * 60 * 1000;
const VERIFIER_MAX_BUFFER_BYTES = 1024 * 1024;
const REQUIRED_CHECKS = new Set(['check', 'test', 'build', 'browser']);

export interface CoreUiTrustedCandidateEvidence {
  attestationCommit: string;
  buildDigest: string;
  checks: Array<{ name: string; status: 'passed' }>;
  pid: number;
}

export interface CoreUiTrustedDeploymentEvidence {
  attestationCommit: string;
  buildDigest: string;
  pids: { api: number; web: number };
}

function verifierConfig(): { command: string; sha256: string } {
  const command = process.env.OD_CORE_UI_VERIFIER_COMMAND ?? '';
  const sha256 = process.env.OD_CORE_UI_VERIFIER_SHA256 ?? '';
  if (
    !path.isAbsolute(command)
    || !/^[a-f0-9]{64}$/.test(sha256)
    || /[\u0000-\u001f\u007f]/.test(command)
  ) {
    throw new Error(
      'Core UI trusted verification requires absolute OD_CORE_UI_VERIFIER_COMMAND and exact OD_CORE_UI_VERIFIER_SHA256.',
    );
  }
  return { command, sha256 };
}

function verifyCommandFile(command: string, expectedSha256: string): void {
  const stat = fs.lstatSync(command);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('Core UI trusted verifier must be one regular non-symlinked file.');
  }
  const actual = createHash('sha256').update(fs.readFileSync(command)).digest('hex');
  if (actual !== expectedSha256) {
    throw new Error('Core UI trusted verifier failed its pinned SHA-256 check.');
  }
}

function verifierEnvironment(): NodeJS.ProcessEnv {
  const home = process.env.HOME;
  if (!home || !path.isAbsolute(home)) {
    throw new Error('Core UI trusted verifier requires an absolute HOME.');
  }
  return {
    HOME: home,
    PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: 'C',
    LC_ALL: 'C',
    CI: '1',
    BASH_ENV: '/dev/null',
    ENV: '/dev/null',
    NODE_OPTIONS: '',
    NODE_PATH: '',
  };
}

async function runVerifier(
  mode: 'candidate' | 'deployment',
  args: string[],
): Promise<Record<string, unknown>> {
  const config = verifierConfig();
  verifyCommandFile(config.command, config.sha256);
  const result = await execFileAsync(
    '/bin/bash',
    [config.command, mode, ...args],
    {
      encoding: 'utf8',
      timeout: VERIFIER_TIMEOUT_MS,
      maxBuffer: VERIFIER_MAX_BUFFER_BYTES,
      env: verifierEnvironment(),
    },
  );
  const stdout = result.stdout.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Core UI trusted verifier did not return one exact JSON result.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Core UI trusted verifier returned an invalid result.');
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.mode !== mode) {
    throw new Error('Core UI trusted verifier returned the wrong schema or mode.');
  }
  return record;
}

function validCommit(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
}

function validDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

export async function verifyCoreUiCandidateWithTrustedCommand(input: {
  repositoryRoot: string;
  attestationCommit: string;
  challenge: string;
  receiptPath: string;
  previewPort?: number;
}): Promise<CoreUiTrustedCandidateEvidence> {
  const previewPort = input.previewPort ?? 3132;
  const record = await runVerifier('candidate', [
    '--repository', input.repositoryRoot,
    '--attestation', input.attestationCommit,
    '--challenge', input.challenge,
    '--receipt-path', input.receiptPath,
    '--preview-port', String(previewPort),
  ]);
  if (
    !hasExactKeys(record, [
      'schemaVersion',
      'mode',
      'attestationCommit',
      'buildDigest',
      'checks',
      'pid',
    ])
    ||
    !validCommit(record.attestationCommit)
    || record.attestationCommit !== input.attestationCommit
    || !validDigest(record.buildDigest)
    || typeof record.pid !== 'number'
    || !Number.isSafeInteger(record.pid)
    || record.pid <= 0
    || !Array.isArray(record.checks)
  ) {
    throw new Error('Core UI trusted candidate verifier returned invalid evidence.');
  }
  const checks = record.checks.map((check) => {
    if (
      !check
      || typeof check !== 'object'
      || Array.isArray(check)
      || !hasExactKeys(check as Record<string, unknown>, ['name', 'status'])
      || typeof (check as Record<string, unknown>).name !== 'string'
      || (check as Record<string, unknown>).status !== 'passed'
    ) {
      throw new Error('Core UI trusted candidate verifier returned invalid check evidence.');
    }
    return {
      name: (check as Record<string, unknown>).name as string,
      status: 'passed' as const,
    };
  });
  if (
    checks.length !== REQUIRED_CHECKS.size
    || checks.some((check) => !REQUIRED_CHECKS.has(check.name))
    || new Set(checks.map((check) => check.name)).size !== REQUIRED_CHECKS.size
  ) {
    throw new Error('Core UI trusted candidate verifier did not pass every required check.');
  }
  return {
    attestationCommit: record.attestationCommit,
    buildDigest: record.buildDigest,
    checks,
    pid: Number(record.pid),
  };
}

export async function verifyCoreUiDeploymentWithTrustedCommand(input: {
  repositoryRoot: string;
  attestationCommit: string;
  buildDigest: string;
}): Promise<CoreUiTrustedDeploymentEvidence> {
  const record = await runVerifier('deployment', [
    '--repository', input.repositoryRoot,
    '--attestation', input.attestationCommit,
    '--build-digest', input.buildDigest,
  ]);
  const pids = record.pids;
  const pidRecord = pids && typeof pids === 'object' && !Array.isArray(pids)
    ? pids as Record<string, unknown>
    : null;
  const apiPid = pidRecord?.api;
  const webPid = pidRecord?.web;
  if (
    !hasExactKeys(record, [
      'schemaVersion',
      'mode',
      'attestationCommit',
      'buildDigest',
      'pids',
    ])
    || !pidRecord
    || !hasExactKeys(pidRecord, ['api', 'web'])
    ||
    !validCommit(record.attestationCommit)
    || record.attestationCommit !== input.attestationCommit
    || !validDigest(record.buildDigest)
    || record.buildDigest !== input.buildDigest
    || typeof apiPid !== 'number'
    || typeof webPid !== 'number'
    || !Number.isSafeInteger(apiPid)
    || !Number.isSafeInteger(webPid)
    || apiPid <= 0
    || webPid <= 0
  ) {
    throw new Error('Core UI trusted deployment verifier returned invalid evidence.');
  }
  return {
    attestationCommit: record.attestationCommit,
    buildDigest: record.buildDigest,
    pids: {
      api: apiPid,
      web: webPid,
    },
  };
}
