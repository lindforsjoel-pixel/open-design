import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  verifyCoreUiCandidateWithTrustedCommand,
  verifyCoreUiDeploymentWithTrustedCommand,
} from '../../src/design-systems/core-ui-verifier.js';

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function verifierScript(candidateJson: string, deploymentJson: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'od-core-ui-verifier-'));
  roots.push(root);
  const script = path.join(root, 'verify.sh');
  writeFileSync(script, `#!/bin/bash
set -euo pipefail
case "$1" in
  candidate) printf '%s\\n' '${candidateJson}' ;;
  deployment) printf '%s\\n' '${deploymentJson}' ;;
  *) exit 2 ;;
esac
`);
  chmodSync(script, 0o700);
  vi.stubEnv('OD_CORE_UI_VERIFIER_COMMAND', script);
  vi.stubEnv(
    'OD_CORE_UI_VERIFIER_SHA256',
    createHash('sha256').update(readFileSync(script)).digest('hex'),
  );
  return script;
}

describe('Core UI trusted verifier command', () => {
  it('accepts exact candidate and deployment evidence', async () => {
    const commit = 'a'.repeat(40);
    const digest = 'b'.repeat(64);
    verifierScript(
      JSON.stringify({
        schemaVersion: 1,
        mode: 'candidate',
        attestationCommit: commit,
        buildDigest: digest,
        checks: ['check', 'test', 'build', 'browser'].map((name) => ({ name, status: 'passed' })),
        pid: 123,
      }),
      JSON.stringify({
        schemaVersion: 1,
        mode: 'deployment',
        attestationCommit: commit,
        buildDigest: digest,
        pids: { api: 124, web: 125 },
      }),
    );
    await expect(verifyCoreUiCandidateWithTrustedCommand({
      repositoryRoot: '/tmp/core',
      attestationCommit: commit,
      challenge: 'c'.repeat(64),
      receiptPath: '99_System/core-v2/apps/web/static/open-design/attestations/proof.json',
    })).resolves.toEqual(expect.objectContaining({ buildDigest: digest, pid: 123 }));
    await expect(verifyCoreUiDeploymentWithTrustedCommand({
      repositoryRoot: '/tmp/core',
      attestationCommit: commit,
      buildDigest: digest,
    })).resolves.toEqual(expect.objectContaining({ pids: { api: 124, web: 125 } }));
  });

  it('fails closed when the configured verifier changes', async () => {
    const commit = 'a'.repeat(40);
    const digest = 'b'.repeat(64);
    const script = verifierScript(
      JSON.stringify({
        schemaVersion: 1,
        mode: 'candidate',
        attestationCommit: commit,
        buildDigest: digest,
        checks: ['check', 'test', 'build', 'browser'].map((name) => ({ name, status: 'passed' })),
        pid: 123,
      }),
      '{}',
    );
    writeFileSync(script, '#!/bin/bash\nprintf "{}\\n"\n');
    await expect(verifyCoreUiCandidateWithTrustedCommand({
      repositoryRoot: '/tmp/core',
      attestationCommit: commit,
      challenge: 'c'.repeat(64),
      receiptPath: '99_System/core-v2/apps/web/static/open-design/attestations/proof.json',
    })).rejects.toThrow('pinned SHA-256');
  });

  it('rejects verifier evidence with unrecognized fields', async () => {
    const commit = 'a'.repeat(40);
    const digest = 'b'.repeat(64);
    verifierScript(
      JSON.stringify({
        schemaVersion: 1,
        mode: 'candidate',
        attestationCommit: commit,
        buildDigest: digest,
        checks: ['check', 'test', 'build', 'browser']
          .map((name) => ({ name, status: 'passed' })),
        pid: 123,
        untrustedClaim: true,
      }),
      '{}',
    );
    await expect(verifyCoreUiCandidateWithTrustedCommand({
      repositoryRoot: '/tmp/core',
      attestationCommit: commit,
      challenge: 'c'.repeat(64),
      receiptPath: '99_System/core-v2/apps/web/static/open-design/attestations/proof.json',
    })).rejects.toThrow('invalid evidence');
  });
});
