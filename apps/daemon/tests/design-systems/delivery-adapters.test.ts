import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stageWordPressDraftDelivery } from '../../src/design-systems/delivery-adapters.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('WordPress draft delivery adapter', () => {
  it('creates only a draft and returns an approval-bound preview', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'od-wordpress-delivery-'));
    roots.push(root);
    writeFileSync(path.join(root, 'grand-slam-offer-prototype-en.html'), '<html><body><h1>Offer</h1></body></html>');
    const responses = [
      { id: 2000, status: 'draft' },
      {
        id: 2000,
        status: 'draft',
        slug: 'grand-slam-offer-preview',
        modified_gmt: '2026-07-15T08:00:00',
        content: { raw: '<html><body><h1>Offer</h1></body></html>' },
      },
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
      previewUrl: 'https://www.lindforsproductions.com/?page_id=2000&preview=true',
    }));
    const createBody = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(createBody.status).toBe('draft');
    expect(fetchImpl.mock.calls.some(([, init]) => String(init?.body).includes('publish'))).toBe(false);
  });
});
