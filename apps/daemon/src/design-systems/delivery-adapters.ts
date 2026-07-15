import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DesignWorkflowDelivery } from '@open-design/contracts';

export const CORE_UI_PROJECT_ID = '1d0665de-a2b6-4845-ad78-d947c5cc0d5f';
export const GRAND_SLAM_OFFER_PROJECT_ID = '4c71d10e-b2a4-403c-ba11-9a3d28e2773b';
const WORDPRESS_SITE_ORIGIN = 'https://www.lindforsproductions.com';
const PROTECTED_WORDPRESS_PAGE_IDS = new Set([124, 213, 1733]);
const DELIVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type FetchLike = typeof fetch;

interface WordPressCredentials {
  user: string;
  password: string;
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeProjectFile(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\0')) {
    throw new Error('Delivery entry file must be project-relative.');
  }
  const resolved = path.resolve(root, relativePath);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!resolved.startsWith(prefix)) throw new Error('Delivery entry file cannot leave the project.');
  return resolved;
}

function readManifest(projectRoot: string): Record<string, unknown> {
  const manifestPath = path.join(projectRoot, '.open-design', 'delivery.json');
  if (!fs.existsSync(manifestPath)) return {};
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The delivery manifest must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

function unquoteEnvValue(value: string): string | null {
  const trimmed = value.trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1);
  }
  if (/^[^\s$`;&|]+$/.test(trimmed)) return trimmed;
  return null;
}

export function readWordPressCredentials(
  env: NodeJS.ProcessEnv = process.env,
  envPath = path.join(os.homedir(), '.core-wordpress', 'lp-wp-app.env'),
): WordPressCredentials {
  const values: Record<string, string> = {};
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?(LP_WP_USER|LP_WP_APP_PASSWORD)=(.*)$/.exec(line);
      if (!match) continue;
      const parsed = unquoteEnvValue(match[2] ?? '');
      if (parsed) values[match[1]!] = parsed;
    }
  }
  const user = env.LP_WP_USER || values.LP_WP_USER;
  const password = env.LP_WP_APP_PASSWORD || values.LP_WP_APP_PASSWORD;
  if (!user || !password) {
    throw new Error('WordPress draft delivery is not initialized: rotate and configure LP_WP_USER and LP_WP_APP_PASSWORD in the machine-local credential route.');
  }
  return { user, password: password.replace(/\s+/g, '') };
}

function authHeaders(credentials: WordPressCredentials): Record<string, string> {
  return { Authorization: `Basic ${Buffer.from(`${credentials.user}:${credentials.password}`).toString('base64')}` };
}

async function wordpressJson(
  fetchImpl: FetchLike,
  credentials: WordPressCredentials,
  method: string,
  route: string,
  body?: unknown,
): Promise<Record<string, any>> {
  const response = await fetchImpl(`${WORDPRESS_SITE_ORIGIN}/wp-json${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...authHeaders(credentials) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  if (!response.ok || !parsed || typeof parsed !== 'object') {
    throw new Error(`WordPress ${method} ${route} failed with ${response.status}: ${text.slice(0, 500)}`);
  }
  return parsed as Record<string, any>;
}

function mimeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.svg': return 'image/svg+xml';
    default: return 'application/octet-stream';
  }
}

async function uploadRelativeImages(
  html: string,
  projectRoot: string,
  fetchImpl: FetchLike,
  credentials: WordPressCredentials,
): Promise<{ html: string; media: Record<string, { id: number; url: string; digest: string }> }> {
  const sources = [...new Set([...html.matchAll(/<img\b[^>]*\bsrc=(['"])(.*?)\1/gi)]
    .map((match) => match[2]!)
    .filter((source) => !/^(?:https?:|data:|\/\/|#)/i.test(source)))];
  let rewritten = html;
  const media: Record<string, { id: number; url: string; digest: string }> = {};
  for (const source of sources) {
    const filePath = safeProjectFile(projectRoot, source);
    const bytes = fs.readFileSync(filePath);
    const response = await fetchImpl(`${WORDPRESS_SITE_ORIGIN}/wp-json/wp/v2/media`, {
      method: 'POST',
      headers: {
        ...authHeaders(credentials),
        'content-type': mimeFor(filePath),
        'content-disposition': `attachment; filename="${path.basename(filePath).replace(/["\r\n]/g, '')}"`,
      },
      body: bytes,
    });
    const text = await response.text();
    let record: Record<string, any> | null = null;
    try { record = JSON.parse(text) as Record<string, any>; } catch { /* handled below */ }
    if (!response.ok || !record || typeof record.source_url !== 'string') {
      throw new Error(`WordPress media upload failed with ${response.status}: ${text.slice(0, 500)}`);
    }
    media[source] = { id: Number(record.id), url: record.source_url, digest: digest(bytes) };
    rewritten = rewritten.replaceAll(source, record.source_url);
  }
  return { html: rewritten, media };
}

export function stageCoreUiDelivery(input: {
  projectRoot: string;
  revisionSha: string;
  runId: string;
  now?: number;
}): DesignWorkflowDelivery {
  const manifest = readManifest(input.projectRoot);
  if (manifest.adapter !== 'core-ui') throw new Error('Core UI /push must write .open-design/delivery.json with adapter "core-ui".');
  const branch = typeof manifest.branch === 'string' ? manifest.branch : '';
  const commit = typeof manifest.commit === 'string' ? manifest.commit : '';
  const previewUrl = typeof manifest.previewUrl === 'string' ? manifest.previewUrl : '';
  const checks = Array.isArray(manifest.checks) ? manifest.checks : [];
  if (!branch || !/^[a-f0-9]{7,64}$/i.test(commit) || !/^https?:\/\//i.test(previewUrl)) {
    throw new Error('Core UI delivery manifest requires branch, commit SHA, and previewUrl.');
  }
  if (checks.length === 0 || checks.some((check) => {
    if (!check || typeof check !== 'object') return true;
    return (check as Record<string, unknown>).status !== 'passed';
  })) {
    throw new Error('Core UI delivery requires at least one recorded check and every check must have status "passed".');
  }
  const now = input.now ?? Date.now();
  return {
    id: randomUUID(),
    projectId: CORE_UI_PROJECT_ID,
    adapter: 'core-ui',
    revisionSha: input.revisionSha,
    implementationDigest: digest(`${commit}\0${JSON.stringify(checks)}`),
    status: 'ready_for_approval',
    previewUrl,
    target: { branch, commit, baseSha: manifest.baseSha ?? null, checks },
    checkpointPath: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + DELIVERY_TTL_MS,
  };
}

export async function stageWordPressDraftDelivery(input: {
  projectRoot: string;
  revisionSha: string;
  runId: string;
  priorDelivery?: DesignWorkflowDelivery | null;
  credentials?: WordPressCredentials;
  fetchImpl?: FetchLike;
  now?: number;
}): Promise<DesignWorkflowDelivery> {
  const manifest = readManifest(input.projectRoot);
  if (manifest.adapter !== undefined && manifest.adapter !== 'wordpress-draft') {
    throw new Error('Grand Slam Offer /push delivery manifest must use adapter "wordpress-draft".');
  }
  const entryFile = typeof manifest.entryFile === 'string' ? manifest.entryFile : 'grand-slam-offer-prototype-en.html';
  const title = typeof manifest.title === 'string' && manifest.title.trim()
    ? manifest.title.trim()
    : 'Grand Slam Offer | Lindfors Productions';
  const slug = typeof manifest.slug === 'string' && /^[a-z0-9-]+$/.test(manifest.slug)
    ? manifest.slug
    : 'grand-slam-offer-preview';
  const sourcePath = safeProjectFile(input.projectRoot, entryFile);
  const sourceHtml = fs.readFileSync(sourcePath, 'utf8');
  const implementationDigest = digest(sourceHtml);
  const deliveryRoot = path.join(input.projectRoot, 'delivery', 'grand-slam-offer');
  const revisionPackage = path.join(deliveryRoot, 'revisions', implementationDigest);
  const currentPackage = path.join(deliveryRoot, 'current');
  fs.mkdirSync(revisionPackage, { recursive: true });
  fs.mkdirSync(currentPackage, { recursive: true });
  const sourceManifest = `${JSON.stringify({
    entryFile, title, slug, revisionSha: input.revisionSha, implementationDigest,
  }, null, 2)}\n`;
  for (const sourcePackage of [revisionPackage, currentPackage]) {
    fs.writeFileSync(path.join(sourcePackage, 'index.html'), sourceHtml);
    fs.writeFileSync(path.join(sourcePackage, 'manifest.json'), sourceManifest);
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  const credentials = input.credentials ?? readWordPressCredentials();
  const uploaded = await uploadRelativeImages(sourceHtml, input.projectRoot, fetchImpl, credentials);
  const priorPageId = Number(input.priorDelivery?.target.pageId ?? 0);
  const now = input.now ?? Date.now();
  let checkpointPath: string | null = null;
  let page: Record<string, any>;
  if (Number.isInteger(priorPageId) && priorPageId > 0) {
    if (PROTECTED_WORDPRESS_PAGE_IDS.has(priorPageId)) throw new Error(`Refusing to update protected WordPress page ${priorPageId}.`);
    const before = await wordpressJson(fetchImpl, credentials, 'GET', `/wp/v2/pages/${priorPageId}?context=edit`);
    if (before.status !== 'draft') throw new Error(`Refusing to update WordPress page ${priorPageId}: expected draft, got ${before.status}.`);
    const checkpointDir = path.join(input.projectRoot, '.open-design', 'wordpress-checkpoints');
    fs.mkdirSync(checkpointDir, { recursive: true });
    checkpointPath = path.join(checkpointDir, `${new Date(now).toISOString().replace(/[:.]/g, '-')}-page-${priorPageId}.json`);
    fs.writeFileSync(checkpointPath, `${JSON.stringify(before, null, 2)}\n`);
    page = await wordpressJson(fetchImpl, credentials, 'POST', `/wp/v2/pages/${priorPageId}`, {
      title, slug, status: 'draft', template: 'elementor_header_footer', content: uploaded.html,
    });
  } else {
    page = await wordpressJson(fetchImpl, credentials, 'POST', '/wp/v2/pages', {
      title, slug, status: 'draft', template: 'elementor_header_footer', content: uploaded.html,
    });
  }
  if (PROTECTED_WORDPRESS_PAGE_IDS.has(Number(page.id))) throw new Error(`WordPress returned protected page ID ${page.id}.`);
  const readback = await wordpressJson(fetchImpl, credentials, 'GET', `/wp/v2/pages/${page.id}?context=edit`);
  if (readback.status !== 'draft') throw new Error(`WordPress page ${page.id} is ${readback.status}, not draft.`);
  const storedContent = typeof readback.content?.raw === 'string' ? readback.content.raw : null;
  if (storedContent == null) throw new Error(`WordPress page ${page.id} did not return editable draft content.`);
  return {
    id: randomUUID(),
    projectId: GRAND_SLAM_OFFER_PROJECT_ID,
    adapter: 'wordpress-draft',
    revisionSha: input.revisionSha,
    implementationDigest,
    status: 'ready_for_approval',
    previewUrl: `${WORDPRESS_SITE_ORIGIN}/?page_id=${page.id}&preview=true`,
    target: {
      pageId: Number(page.id),
      slug: readback.slug,
      modifiedGmt: readback.modified_gmt,
      contentDigest: digest(storedContent),
      sourcePackage: path.relative(input.projectRoot, revisionPackage),
      media: uploaded.media,
    },
    checkpointPath,
    error: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + DELIVERY_TTL_MS,
  };
}

export async function publishWordPressDelivery(
  delivery: DesignWorkflowDelivery,
  options: { credentials?: WordPressCredentials; fetchImpl?: FetchLike; now?: number } = {},
): Promise<DesignWorkflowDelivery> {
  if (delivery.adapter !== 'wordpress-draft' || delivery.status !== 'ready_for_approval') {
    throw new Error('Only a ready WordPress draft delivery can be published.');
  }
  const now = options.now ?? Date.now();
  if (delivery.expiresAt < now) throw new Error('Delivery approval expired; run /push again.');
  const pageId = Number(delivery.target.pageId ?? 0);
  if (!Number.isInteger(pageId) || pageId <= 0 || PROTECTED_WORDPRESS_PAGE_IDS.has(pageId)) {
    throw new Error('Delivery has an invalid or protected WordPress page binding.');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const credentials = options.credentials ?? readWordPressCredentials();
  const current = await wordpressJson(fetchImpl, credentials, 'GET', `/wp/v2/pages/${pageId}?context=edit`);
  const currentContent = typeof current.content?.raw === 'string' ? current.content.raw : null;
  if (
    current.status !== 'draft'
    || current.modified_gmt !== delivery.target.modifiedGmt
    || currentContent == null
    || digest(currentContent) !== delivery.target.contentDigest
  ) {
    throw new Error('WordPress draft changed after preview; run /push again before approving.');
  }
  const published = await wordpressJson(fetchImpl, credentials, 'POST', `/wp/v2/pages/${pageId}`, { status: 'publish' });
  if (published.status !== 'publish') throw new Error(`WordPress page ${pageId} did not publish.`);
  return {
    ...delivery,
    status: 'deployed',
    previewUrl: typeof published.link === 'string' ? published.link : delivery.previewUrl,
    updatedAt: now,
    target: { ...delivery.target, publishedModifiedGmt: published.modified_gmt ?? null },
  };
}
