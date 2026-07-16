import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DesignWorkflowDelivery } from '@open-design/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalCoreUiReceipt,
  publishWordPressDelivery,
  stageCoreUiDelivery,
  stageWordPressDraftDelivery,
  verifyCoreUiDeploymentReceipt,
  verifyCoreUiPreviewReceipt,
  WordPressPublishOutcomeUnknownError,
  WordPressPublishReconciliationRequiredError,
} from '../../src/design-systems/delivery-adapters.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Core UI delivery adapter', () => {
  const revisionSha = 'a'.repeat(40);
  const challenge = 'b'.repeat(64);
  const baseCommit = 'c'.repeat(40);
  const implementationCommit = 'd'.repeat(40);
  const attestationCommit = 'e'.repeat(40);
  const gitRemote = 'git@github.com:joellindfors/Core.git';
  const targetOrigin = 'https://studio-macbook-server.taila20f18.ts.net:8444';
  const previewUrl = 'https://studio-macbook-server.taila20f18.ts.net:8446/';
  const receiptPath = `99_System/core-v2/apps/web/static/open-design/attestations/${challenge}.json`;
  const previewReceiptUrl = `${previewUrl}open-design/attestations/${challenge}.json`;
  const binding = {
    challenge,
    projectId: '1d0665de-a2b6-4845-ad78-d947c5cc0d5f',
    runId: 'run',
    designRevision: revisionSha,
    baseBranch: 'master',
    baseCommit,
    gitRemote,
    implementationCommit,
    targetOrigin,
    receiptPath,
  };

  function boundHtml(overrides: Partial<typeof binding> = {}, extraHead = ''): string {
    const current = { ...binding, ...overrides };
    return [
      '<html><head>',
      `<meta name="open-design-challenge" content="${current.challenge}">`,
      `<meta name="open-design-design-revision" content="${current.designRevision}">`,
      `<meta name="open-design-implementation-commit" content="${current.implementationCommit}">`,
      `<meta name="open-design-target-origin" content="${current.targetOrigin}">`,
      `<meta name="open-design-receipt-path" content="/open-design/attestations/${current.challenge}.json">`,
      extraHead,
      '</head><body>preview</body></html>',
    ].join('');
  }

  function stage(
    overrides: Record<string, unknown> = {},
    baseBranch = 'master',
    daemonGitRemote = gitRemote,
  ) {
    const root = mkdtempSync(path.join(tmpdir(), 'od-core-ui-delivery-'));
    roots.push(root);
    mkdirSync(path.join(root, '.open-design'), { recursive: true });
    writeFileSync(path.join(root, '.open-design', 'delivery.json'), `${JSON.stringify({
      schemaVersion: 2,
      adapter: 'core-ui',
      challenge,
      branch: 'codex/open-design-preview',
      baseBranch: 'master',
      baseCommit,
      gitRemote,
      implementationCommit,
      attestationCommit,
      designRevision: revisionSha,
      targetOrigin,
      previewUrl,
      receiptPath,
      previewReceiptUrl,
      approvalRequired: true,
      approvalReady: true,
      checks: [
        { name: 'tests', status: 'passed', commit: attestationCommit },
        { name: 'build', status: 'passed', commit: attestationCommit },
        { name: 'browser', status: 'passed', commit: attestationCommit },
      ],
      ...overrides,
    })}\n`);
    return stageCoreUiDelivery({
      projectRoot: root,
      revisionSha,
      baseBranch,
      baseCommit,
      gitRemote: daemonGitRemote,
      challenge,
      runId: 'run',
      targetOrigin,
      receiptPath,
      now: 1,
    });
  }

  it('binds approval to an explicit revision, isolated branch, secure preview, and passed checks', () => {
    expect(stage()).toEqual(expect.objectContaining({
      adapter: 'core-ui',
      status: 'ready_for_approval',
      revisionSha,
      previewUrl,
      target: expect.objectContaining({
        branch: 'codex/open-design-preview',
        baseBranch: 'master',
        baseCommit,
        gitRemote,
        implementationCommit,
        attestationCommit,
        designRevision: revisionSha,
      }),
    }));
  });

  it.each([
    [{ schemaVersion: 1 }, 'schemaVersion 2'],
    [{ challenge: 'f'.repeat(64) }, 'exact daemon-issued challenge'],
    [{ branch: 'main' }, 'isolated codex/ branch'],
    [{ branch: 'codex/preview\nmalicious' }, 'isolated codex/ branch'],
    [{ branch: 'codex/preview//nested' }, 'isolated codex/ branch'],
    [{ branch: 'codex/preview..nested' }, 'isolated codex/ branch'],
    [{ branch: 'codex/.hidden' }, 'isolated codex/ branch'],
    [{ branch: 'codex/preview.lock' }, 'isolated codex/ branch'],
    [{ baseBranch: 'main' }, 'valid remote default branch'],
    [{ gitRemote: 'git@github.com:attacker/Core.git' }, 'exact safe daemon-supplied gitRemote'],
    [{ baseCommit: 'f'.repeat(40) }, 'exact base and distinct full implementation and attestation commits'],
    [{ implementationCommit: 'd'.repeat(8) }, 'exact base and distinct full implementation and attestation commits'],
    [{ attestationCommit: implementationCommit }, 'exact base and distinct full implementation and attestation commits'],
    [{ designRevision: revisionSha.slice(0, 8) }, 'must exactly match the applied design-system revision'],
    [{ targetOrigin: 'https://studio-macbook-server.taila20f18.ts.net:443' }, 'configured live Core UI origin'],
    [{ previewUrl: 'https://studio-macbook-server.taila20f18.ts.net:8444/' }, 'exact configured route'],
    [{ previewUrl: 'https://studio-macbook-server.taila20f18.ts.net:8446/?gate=1' }, 'exact configured route'],
    [{ receiptPath: '../receipt.json' }, 'exact daemon-issued receiptPath'],
    [{ previewReceiptUrl: 'https://studio-macbook-server.taila20f18.ts.net:8446/open-design/attestations/wrong.json' }, 'must match previewReceiptPath exactly'],
    [{ approvalReady: false }, 'ready only after every preview gate passes'],
    [{ checks: { tests: { status: 'passed' } } }, 'checks must be a nonempty array'],
    [{ checks: [{ name: 'browser', status: 'blocked', commit: attestationCommit }] }, 'passed against the exact attestation commit'],
    [{
      checks: [
        { name: 'tests', status: 'passed', commit: attestationCommit },
        { name: 'build', status: 'passed', commit: attestationCommit },
      ],
    }, 'missing required passed checks: browser'],
    [{
      checks: [
        { name: 'tests', status: 'passed', commit: attestationCommit },
        { name: 'build', status: 'passed', commit: attestationCommit },
        { name: 'Browser QA', status: 'passed', commit: attestationCommit },
      ],
    }, 'passed against the exact attestation commit'],
  ])('rejects an unsafe or incomplete manifest %#', (overrides, message) => {
    expect(() => stage(overrides)).toThrow(message);
  });

  it('accepts only the authenticated configured tailnet preview route for private addressing', () => {
    expect(stage().previewUrl).toBe(previewUrl);
  });

  it('rejects an invalid verified base branch', () => {
    expect(() => stage({}, 'master\nmalicious')).toThrow('valid remote default branch');
  });

  it('binds the implementation digest to the exact daemon-supplied git remote', () => {
    const alternateRemote = 'ssh://git@github.com/joellindfors/Core.git';
    expect(stage().implementationDigest).not.toBe(
      stage({ gitRemote: alternateRemote }, 'master', alternateRemote).implementationDigest,
    );
  });

  it('writes the exact canonical receipt bytes including the git remote', () => {
    expect(canonicalCoreUiReceipt(binding).toString('utf8')).toBe(`${JSON.stringify({
      schemaVersion: 2,
      kind: 'open-design-core-ui-attestation',
      challenge,
      projectId: binding.projectId,
      runId: binding.runId,
      designRevision: revisionSha,
      baseBranch: binding.baseBranch,
      baseCommit,
      gitRemote,
      implementationCommit,
      targetOrigin,
      receiptPath,
    }, null, 2)}\n`);
  });

  function verificationInput(receiptContent = canonicalCoreUiReceipt(binding)) {
    return {
      previewUrl,
      receiptUrl: previewReceiptUrl,
      receiptContent,
      receiptPath,
      projectId: binding.projectId,
      runId: binding.runId,
      challenge,
      revisionSha,
      baseBranch: binding.baseBranch,
      baseCommit,
      gitRemote,
      implementationCommit,
      targetOrigin,
    };
  }

  it('requires the exact private preview route, canonical receipt, DNS pin, and root bindings', async () => {
    const receiptContent = canonicalCoreUiReceipt(binding);
    const lookupImpl = vi.fn(async () => [{ address: '100.116.33.13', family: 4 }]);
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      new URL(String(url)).pathname.endsWith('.json')
        ? new Response(receiptContent, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
        : new Response(boundHtml(), {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }));
    await expect(verifyCoreUiPreviewReceipt({
      ...verificationInput(receiptContent),
      fetchImpl: fetchImpl as typeof fetch,
      lookupImpl,
    })).resolves.toBeUndefined();
    expect(lookupImpl).toHaveBeenCalledTimes(1);

    await expect(verifyCoreUiPreviewReceipt({
      ...verificationInput(receiptContent),
      previewUrl: targetOrigin,
      fetchImpl: fetchImpl as typeof fetch,
      lookupImpl,
    })).rejects.toThrow('exact configured route');
    await expect(verifyCoreUiPreviewReceipt({
      ...verificationInput(Buffer.from(receiptContent.toString('utf8').replace('"run"', '"other"'))),
      fetchImpl: fetchImpl as typeof fetch,
      lookupImpl,
    })).rejects.toThrow('exact canonical daemon-bound attestation');
    await expect(verifyCoreUiPreviewReceipt({
      ...verificationInput(Buffer.from(receiptContent.toString('utf8').replace(gitRemote, 'git@github.com:attacker/Core.git'))),
      fetchImpl: fetchImpl as typeof fetch,
      lookupImpl,
    })).rejects.toThrow('exact canonical daemon-bound attestation');
  });

  it('rejects non-tailnet DNS answers and stale root bindings before approval', async () => {
    const receiptContent = canonicalCoreUiReceipt(binding);
    const fetchImpl = vi.fn();
    await expect(verifyCoreUiPreviewReceipt({
      ...verificationInput(receiptContent),
      fetchImpl: fetchImpl as typeof fetch,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    })).rejects.toThrow('resolved to a private or reserved address');
    expect(fetchImpl).not.toHaveBeenCalled();

    await expect(verifyCoreUiPreviewReceipt({
      ...verificationInput(receiptContent),
      fetchImpl: (async (url: string | URL | Request) =>
        new URL(String(url)).pathname.endsWith('.json')
          ? new Response(receiptContent, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
          : new Response(boundHtml({ implementationCommit: 'f'.repeat(40) }), {
            status: 200,
            headers: { 'content-type': 'text/html' },
          })) as typeof fetch,
      lookupImpl: async () => [{ address: '100.116.33.13', family: 4 }],
    })).rejects.toThrow('open-design-implementation-commit binding');
  });

  it('proves the exact receipt and root bindings on both deployed Core UI routes', async () => {
    const receiptContent = canonicalCoreUiReceipt(binding);
    const requestedUrls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      requestedUrls.push(parsed.toString());
      return parsed.pathname.endsWith('.json')
        ? new Response(receiptContent, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
        : new Response(boundHtml(), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
    });
    await expect(verifyCoreUiDeploymentReceipt({
      ...verificationInput(receiptContent),
      fetchImpl: fetchImpl as typeof fetch,
      lookupImpl: async () => [{ address: '100.116.33.13', family: 4 }],
    })).resolves.toBeUndefined();
    expect(requestedUrls.sort()).toEqual([
      'http://127.0.0.1:3131/',
      `http://127.0.0.1:3131/open-design/attestations/${challenge}.json`,
      'https://studio-macbook-server.taila20f18.ts.net:8444/',
      `https://studio-macbook-server.taila20f18.ts.net:8444/open-design/attestations/${challenge}.json`,
    ].sort());
  });
});

describe('WordPress draft delivery adapter', () => {
  const pageId = 2000;
  const title = 'Grand Slam Offer | Lindfors Productions';
  const slug = 'grand-slam-offer-preview';
  const template = 'elementor_header_footer';
  const content = '<html><body><h1>Offer</h1></body></html>';
  const draftModifiedGmt = '2026-07-15T08:00:00';

  function managedPage(
    status: 'draft' | 'publish',
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      id: pageId,
      status,
      title: { raw: title },
      slug,
      template,
      content: { raw: content },
      modified_gmt: status === 'draft' ? draftModifiedGmt : '2026-07-15T08:01:00',
      link: 'https://www.lindforsproductions.com/grand-slam-offer-preview/',
      ...overrides,
    };
  }

  function managedPageFingerprint(page: Record<string, any>): string {
    return createHash('sha256').update(JSON.stringify({
      pageId: Number(page.id),
      title: { raw: page.title.raw },
      slug: page.slug,
      template: page.template,
      content: { raw: page.content.raw },
    })).digest('hex');
  }

  function readyDelivery(
    targetOverrides: Record<string, unknown> = {},
  ): DesignWorkflowDelivery {
    const fingerprint = managedPageFingerprint(managedPage('draft'));
    return {
      id: 'delivery',
      projectId: '4c71d10e-b2a4-403c-ba11-9a3d28e2773b',
      adapter: 'wordpress-draft',
      revisionSha: 'a'.repeat(40),
      implementationDigest: createHash('sha256').update(content).digest('hex'),
      status: 'ready_for_approval',
      previewUrl: `https://www.lindforsproductions.com/?page_id=${pageId}&preview=true`,
      target: {
        pageId,
        slug,
        modifiedGmt: draftModifiedGmt,
        contentDigest: createHash('sha256').update(content).digest('hex'),
        wordpressManagedPageFingerprint: fingerprint,
        wordpressManagedPageState: 'draft',
        wordpressPublishIntent: {
          runId: 'run',
          createdAt: 1,
          managedPageFingerprint: fingerprint,
        },
        ...targetOverrides,
      },
      checkpointPath: null,
      error: null,
      createdAt: 1,
      updatedAt: 1,
      expiresAt: 10_000,
    };
  }

  it('creates only a draft and returns an approval-bound preview', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'od-wordpress-delivery-'));
    roots.push(root);
    writeFileSync(path.join(root, 'grand-slam-offer-prototype-en.html'), content);
    const responses = [
      { id: pageId, status: 'draft' },
      managedPage('draft'),
    ];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Response(
      JSON.stringify(responses.shift()),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    const delivery = await stageWordPressDraftDelivery({
      projectRoot: root,
      revisionSha: 'a'.repeat(40),
      runId: 'run',
      credentials: { user: 'test', password: 'secret' },
      fetchImpl: fetchImpl as typeof fetch,
      now: 1,
    });

    expect(delivery).toEqual(expect.objectContaining({
      adapter: 'wordpress-draft',
      status: 'ready_for_approval',
      previewUrl: `https://www.lindforsproductions.com/?page_id=${pageId}&preview=true`,
      target: expect.objectContaining({
        wordpressManagedPageFingerprint: managedPageFingerprint(managedPage('draft')),
        wordpressManagedPageState: 'draft',
      }),
    }));
    expect(delivery.target.wordpressPublishIntent).toBeUndefined();
    const createBody = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(createBody.status).toBe('draft');
    expect(fetchImpl.mock.calls.some(([, init]) => String(init?.body).includes('publish'))).toBe(false);
  });

  it.each([
    {
      name: 'deployed wrapper',
      priorDelivery: { ...readyDelivery(), status: 'deployed' as const },
    },
    {
      name: 'failed wrapper without a durable draft marker',
      priorDelivery: {
        ...readyDelivery({ wordpressManagedPageState: undefined }),
        status: 'failed' as const,
      },
    },
  ])('creates a new draft after a $name', async ({ priorDelivery }) => {
    const root = mkdtempSync(path.join(tmpdir(), 'od-wordpress-next-delivery-'));
    roots.push(root);
    writeFileSync(path.join(root, 'grand-slam-offer-prototype-en.html'), content);
    const nextPageId = 2001;
    const responses = [
      { id: nextPageId, status: 'draft' },
      managedPage('draft', { id: nextPageId }),
    ];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(
      JSON.stringify(responses.shift()),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const delivery = await stageWordPressDraftDelivery({
      projectRoot: root,
      revisionSha: 'b'.repeat(40),
      runId: 'next-run',
      priorDelivery,
      credentials: { user: 'test', password: 'secret' },
      fetchImpl: fetchImpl as typeof fetch,
      now: 2,
    });
    expect(delivery.target.pageId).toBe(nextPageId);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toMatch(/\/wp-json\/wp\/v2\/pages$/);
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe('POST');
  });

  it('reuses a failed wrapper only when its durable managed-page state is draft', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'od-wordpress-reuse-draft-'));
    roots.push(root);
    writeFileSync(path.join(root, 'grand-slam-offer-prototype-en.html'), content);
    const responses = [
      managedPage('draft'),
      { id: pageId, status: 'draft' },
      managedPage('draft'),
    ];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(
      JSON.stringify(responses.shift()),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const delivery = await stageWordPressDraftDelivery({
      projectRoot: root,
      revisionSha: 'b'.repeat(40),
      runId: 'retry-run',
      priorDelivery: { ...readyDelivery(), status: 'failed' },
      credentials: { user: 'test', password: 'secret' },
      fetchImpl: fetchImpl as typeof fetch,
      now: 2,
    });
    expect(delivery.target.pageId).toBe(pageId);
    expect(fetchImpl.mock.calls.map(([url, init]) => [
      String(url),
      init?.method,
    ])).toEqual([
      [`https://www.lindforsproductions.com/wp-json/wp/v2/pages/${pageId}?context=edit`, 'GET'],
      [`https://www.lindforsproductions.com/wp-json/wp/v2/pages/${pageId}`, 'POST'],
      [`https://www.lindforsproductions.com/wp-json/wp/v2/pages/${pageId}?context=edit`, 'GET'],
    ]);
  });

  it('never updates a prior page known to be published even when its wrapper failed', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'od-wordpress-known-published-'));
    roots.push(root);
    writeFileSync(path.join(root, 'grand-slam-offer-prototype-en.html'), content);
    const nextPageId = 2001;
    const responses = [
      { id: nextPageId, status: 'draft' },
      managedPage('draft', { id: nextPageId }),
    ];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(
      JSON.stringify(responses.shift()),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const delivery = await stageWordPressDraftDelivery({
      projectRoot: root,
      revisionSha: 'b'.repeat(40),
      runId: 'next-run',
      priorDelivery: {
        ...readyDelivery({
          wordpressManagedPageState: 'draft',
          publishedModifiedGmt: '2026-07-15T08:01:00',
        }),
        status: 'failed',
      },
      credentials: { user: 'test', password: 'secret' },
      fetchImpl: fetchImpl as typeof fetch,
      now: 2,
    });
    expect(delivery.target.pageId).toBe(nextPageId);
    expect(fetchImpl.mock.calls).toHaveLength(2);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toMatch(/\/wp-json\/wp\/v2\/pages$/);
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe('POST');
  });

  it('creates a new draft when a durable prior draft is already published remotely', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'od-wordpress-remote-published-'));
    roots.push(root);
    writeFileSync(path.join(root, 'grand-slam-offer-prototype-en.html'), content);
    const nextPageId = 2001;
    const responses = [
      managedPage('publish'),
      { id: nextPageId, status: 'draft' },
      managedPage('draft', { id: nextPageId }),
    ];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(
      JSON.stringify(responses.shift()),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const delivery = await stageWordPressDraftDelivery({
      projectRoot: root,
      revisionSha: 'b'.repeat(40),
      runId: 'next-run',
      priorDelivery: { ...readyDelivery(), status: 'failed' },
      credentials: { user: 'test', password: 'secret' },
      fetchImpl: fetchImpl as typeof fetch,
      now: 2,
    });
    expect(delivery.target.pageId).toBe(nextPageId);
    expect(fetchImpl.mock.calls.map(([url, init]) => [
      String(url),
      init?.method,
    ])).toEqual([
      [`https://www.lindforsproductions.com/wp-json/wp/v2/pages/${pageId}?context=edit`, 'GET'],
      ['https://www.lindforsproductions.com/wp-json/wp/v2/pages', 'POST'],
      [`https://www.lindforsproductions.com/wp-json/wp/v2/pages/${nextPageId}?context=edit`, 'GET'],
    ]);
  });

  it('publishes an exact staged draft and verifies the exact published readback', async () => {
    const responses = [
      managedPage('draft'),
      { id: pageId, status: 'publish' },
      managedPage('publish'),
    ];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(
      JSON.stringify(responses.shift()),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    await expect(publishWordPressDelivery(readyDelivery(), {
      credentials: { user: 'test', password: 'secret' },
      fetchImpl: fetchImpl as typeof fetch,
      now: 2,
    })).resolves.toEqual(expect.objectContaining({
      status: 'deployed',
      previewUrl: 'https://www.lindforsproductions.com/grand-slam-offer-preview/',
      target: expect.objectContaining({
        wordpressManagedPageState: 'published',
        publishedModifiedGmt: '2026-07-15T08:01:00',
      }),
    }));
    expect(fetchImpl.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'POST', 'GET']);
  });

  it('reconciles an exact already-published page without issuing another POST', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(
      JSON.stringify(managedPage('publish')),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));

    await expect(publishWordPressDelivery(readyDelivery(), {
      credentials: { user: 'test', password: 'secret' },
      fetchImpl: fetchImpl as typeof fetch,
      now: 2,
    })).resolves.toEqual(expect.objectContaining({
      status: 'deployed',
      target: expect.objectContaining({
        wordpressManagedPageState: 'published',
      }),
    }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]?.method).toBe('GET');
  });

  it('reads back after a failed POST and reconciles an exact published page', async () => {
    const responses = [
      new Response(JSON.stringify(managedPage('draft')), { status: 200 }),
      new Response('upstream timeout', { status: 504 }),
      new Response(JSON.stringify(managedPage('publish')), { status: 200 }),
    ];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => responses.shift()!);

    await expect(publishWordPressDelivery(readyDelivery(), {
      credentials: { user: 'test', password: 'secret' },
      fetchImpl: fetchImpl as typeof fetch,
      now: 2,
    })).resolves.toEqual(expect.objectContaining({ status: 'deployed' }));
    expect(fetchImpl.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'POST', 'GET']);
  });

  it('reports a normal retryable failure when a failed POST leaves the exact draft unchanged', async () => {
    const responses = [
      new Response(JSON.stringify(managedPage('draft')), { status: 200 }),
      new Response('upstream unavailable', { status: 503 }),
      new Response(JSON.stringify(managedPage('draft')), { status: 200 }),
    ];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => responses.shift()!);

    const error = await publishWordPressDelivery(readyDelivery(), {
      credentials: { user: 'test', password: 'secret' },
      fetchImpl: fetchImpl as typeof fetch,
      now: 2,
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(WordPressPublishOutcomeUnknownError);
    expect(error.message).toContain('failed with 503');
  });

  it('throws a typed unknown-outcome error when the page cannot be read after a publish attempt', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> =>
      new Response())
      .mockResolvedValueOnce(new Response(JSON.stringify(managedPage('draft')), { status: 200 }))
      .mockRejectedValueOnce(new Error('connection reset after request'))
      .mockRejectedValueOnce(new Error('readback unavailable'));

    const error = await publishWordPressDelivery(readyDelivery(), {
      credentials: { user: 'test', password: 'secret' },
      fetchImpl: fetchImpl as typeof fetch,
      now: 2,
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(WordPressPublishOutcomeUnknownError);
    expect(error).toMatchObject({ pageId });
  });

  it('throws the typed unknown-outcome error after a successful POST whose readback is unavailable', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> =>
      new Response())
      .mockResolvedValueOnce(new Response(JSON.stringify(managedPage('draft')), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: pageId, status: 'publish' }), { status: 200 }))
      .mockRejectedValueOnce(new Error('readback unavailable'));

    await expect(publishWordPressDelivery(readyDelivery(), {
      credentials: { user: 'test', password: 'secret' },
      fetchImpl: fetchImpl as typeof fetch,
      now: 2,
    })).rejects.toBeInstanceOf(WordPressPublishOutcomeUnknownError);
  });

  it('requires a durable publish intent before making any WordPress request', async () => {
    const fetchImpl = vi.fn();
    await expect(publishWordPressDelivery(readyDelivery({
      wordpressPublishIntent: undefined,
    }), {
      credentials: { user: 'test', password: 'secret' },
      fetchImpl: fetchImpl as typeof fetch,
      now: 2,
    })).rejects.toThrow('missing its durable publish intent');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('requires a durable draft lifecycle state before making any WordPress request', async () => {
    const fetchImpl = vi.fn();
    await expect(publishWordPressDelivery(readyDelivery({
      wordpressManagedPageState: 'published',
    }), {
      credentials: { user: 'test', password: 'secret' },
      fetchImpl: fetchImpl as typeof fetch,
      now: 2,
    })).rejects.toThrow('durable draft lifecycle state');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed on an already-published page whose managed fingerprint changed', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify(managedPage('publish', { content: { raw: '<p>changed</p>' } })),
      { status: 200 },
    ));
    const error = await publishWordPressDelivery(readyDelivery(), {
      credentials: { user: 'test', password: 'secret' },
      fetchImpl: fetchImpl as typeof fetch,
      now: 2,
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(WordPressPublishReconciliationRequiredError);
    expect(error).toMatchObject({ pageId });
    expect('cause' in error).toBe(false);
    expect(error.message).toContain('does not match the staged managed-page fingerprint');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('requires typed reconciliation when post-publish readback is published with a changed fingerprint', async () => {
    const publishFailure = new Error('connection reset after publish request');
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> =>
      new Response())
      .mockResolvedValueOnce(new Response(JSON.stringify(managedPage('draft')), { status: 200 }))
      .mockRejectedValueOnce(publishFailure)
      .mockResolvedValueOnce(new Response(
        JSON.stringify(managedPage('publish', { content: { raw: '<p>changed</p>' } })),
        { status: 200 },
      ));

    const error = await publishWordPressDelivery(readyDelivery(), {
      credentials: { user: 'test', password: 'secret' },
      fetchImpl: fetchImpl as typeof fetch,
      now: 2,
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(WordPressPublishReconciliationRequiredError);
    expect(error).toMatchObject({ pageId, cause: publishFailure });
    expect(fetchImpl.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'POST', 'GET']);
  });

  it('fails closed without publishing when the exact draft modification binding changed', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify(managedPage('draft', { modified_gmt: '2026-07-15T08:00:01' })),
      { status: 200 },
    ));
    await expect(publishWordPressDelivery(readyDelivery(), {
      credentials: { user: 'test', password: 'secret' },
      fetchImpl: fetchImpl as typeof fetch,
      now: 2,
    })).rejects.toThrow('draft changed after preview');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
