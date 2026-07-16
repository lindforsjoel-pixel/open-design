import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import fs from 'node:fs';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { DesignWorkflowDelivery } from '@open-design/contracts';
import { load } from 'cheerio';
import { Agent, fetch as undiciFetch } from 'undici';

export const CORE_UI_PROJECT_ID = '1d0665de-a2b6-4845-ad78-d947c5cc0d5f';
export const GRAND_SLAM_OFFER_PROJECT_ID = '4c71d10e-b2a4-403c-ba11-9a3d28e2773b';
const WORDPRESS_SITE_ORIGIN = 'https://www.lindforsproductions.com';
const PROTECTED_WORDPRESS_PAGE_IDS = new Set([124, 213, 1733]);
const DELIVERY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REQUIRED_CORE_UI_CHECKS = new Set(['tests', 'build', 'browser']);
const MAX_PREVIEW_RECEIPT_BYTES = 16 * 1024;
const MAX_PREVIEW_HTML_BYTES = 2 * 1024 * 1024;
const DNS_LOOKUP_TIMEOUT_MS = 5_000;
const REMOTE_VERIFICATION_TIMEOUT_MS = 25_000;
const CORE_UI_LOCAL_ORIGIN = 'http://127.0.0.1:3131';
const DEFAULT_CORE_UI_TARGET_ORIGIN = 'https://studio-macbook-server.taila20f18.ts.net:8444';
const DEFAULT_CORE_UI_PREVIEW_ROOT = 'https://studio-macbook-server.taila20f18.ts.net:8446/';

function configuredCoreUiTargetOrigin(): string {
  const value = process.env.OD_CORE_UI_TARGET_ORIGIN ?? DEFAULT_CORE_UI_TARGET_ORIGIN;
  const url = new URL(value);
  if (
    url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || url.port !== '8444'
    || url.pathname !== '/'
    || url.search !== ''
    || url.hash !== ''
  ) {
    throw new Error('OD_CORE_UI_TARGET_ORIGIN must be a credential-free HTTPS root on port 8444.');
  }
  return url.origin;
}

function configuredCoreUiPreviewRoot(): string {
  const value = process.env.OD_CORE_UI_PREVIEW_URL ?? DEFAULT_CORE_UI_PREVIEW_ROOT;
  const url = new URL(value);
  if (
    url.protocol !== 'https:'
    || url.username !== ''
    || url.password !== ''
    || url.port !== '8446'
    || url.pathname !== '/'
    || url.search !== ''
    || url.hash !== ''
  ) {
    throw new Error('OD_CORE_UI_PREVIEW_URL must be a credential-free HTTPS root on port 8446.');
  }
  return url.toString();
}

export const CORE_UI_TARGET_ORIGIN = configuredCoreUiTargetOrigin();
export const CORE_UI_PREVIEW_ROOT = configuredCoreUiPreviewRoot();
const CORE_UI_LIVE_ORIGIN = CORE_UI_TARGET_ORIGIN;
const CORE_UI_CONFIGURED_TAILNET_HOSTNAMES = new Set([
  new URL(CORE_UI_TARGET_ORIGIN).hostname,
  new URL(CORE_UI_PREVIEW_ROOT).hostname,
]);
const CORE_UI_STATIC_ROOT = '99_System/core-v2/apps/web/static/';
const NON_PUBLIC_PREVIEW_IPV4_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  NON_PUBLIC_PREVIEW_IPV4_ADDRESSES.addSubnet(network, prefix, 'ipv4');
}
const NON_PUBLIC_PREVIEW_IPV6_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['100:0:0:1::', 64],
  ['2001::', 23],
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  NON_PUBLIC_PREVIEW_IPV6_ADDRESSES.addSubnet(network, prefix, 'ipv6');
}
const TAILSCALE_PREVIEW_IPV4_ADDRESSES = new BlockList();
TAILSCALE_PREVIEW_IPV4_ADDRESSES.addSubnet('100.64.0.0', 10, 'ipv4');
const TAILSCALE_PREVIEW_IPV6_ADDRESSES = new BlockList();
TAILSCALE_PREVIEW_IPV6_ADDRESSES.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6');
const PUBLIC_GLOBAL_UNICAST_IPV6_ADDRESSES = new BlockList();
PUBLIC_GLOBAL_UNICAST_IPV6_ADDRESSES.addSubnet('2000::', 3, 'ipv6');

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

interface WordPressCredentials {
  user: string;
  password: string;
}

interface WordPressManagedPage {
  pageId: number;
  status: string;
  titleRaw: string;
  slug: string;
  template: string;
  contentRaw: string;
  modifiedGmt: string;
  link: string | null;
}

interface WordPressPublishIntent {
  runId: string;
  createdAt: number;
  managedPageFingerprint: string;
}

type WordPressManagedPageState = 'draft' | 'published';

export class WordPressPublishOutcomeUnknownError extends Error {
  readonly pageId: number;

  constructor(pageId: number, cause: unknown) {
    super(
      `WordPress page ${pageId} publish outcome is unknown; approval must remain parked until the page can be read back.`,
      { cause },
    );
    this.name = 'WordPressPublishOutcomeUnknownError';
    this.pageId = pageId;
  }
}

export class WordPressPublishReconciliationRequiredError extends Error {
  readonly pageId: number;

  constructor(pageId: number, cause?: unknown) {
    super(
      `WordPress page ${pageId} is published but does not match the staged managed-page fingerprint; approval must remain parked for reconciliation.`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'WordPressPublishReconciliationRequiredError';
    this.pageId = pageId;
  }
}

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function readWordPressManagedPage(
  record: Record<string, any>,
  expectedPageId: number,
): WordPressManagedPage {
  const pageId = Number(record.id);
  const titleRaw = typeof record.title?.raw === 'string' ? record.title.raw : null;
  const contentRaw = typeof record.content?.raw === 'string' ? record.content.raw : null;
  if (
    !Number.isInteger(pageId)
    || pageId !== expectedPageId
    || typeof record.status !== 'string'
    || titleRaw == null
    || typeof record.slug !== 'string'
    || typeof record.template !== 'string'
    || contentRaw == null
    || typeof record.modified_gmt !== 'string'
  ) {
    throw new Error(`WordPress page ${expectedPageId} did not return the exact editable managed-page fields.`);
  }
  return {
    pageId,
    status: record.status,
    titleRaw,
    slug: record.slug,
    template: record.template,
    contentRaw,
    modifiedGmt: record.modified_gmt,
    link: typeof record.link === 'string' ? record.link : null,
  };
}

function wordpressManagedPageFingerprint(page: WordPressManagedPage): string {
  return digest(JSON.stringify({
    pageId: page.pageId,
    title: { raw: page.titleRaw },
    slug: page.slug,
    template: page.template,
    content: { raw: page.contentRaw },
  }));
}

function wordpressManagedPageState(
  delivery: DesignWorkflowDelivery,
): WordPressManagedPageState | null {
  const explicitState = delivery.target.wordpressManagedPageState;
  const publishedModifiedGmt = delivery.target.publishedModifiedGmt;
  if (
    delivery.status === 'deployed'
    || explicitState === 'published'
    || (typeof publishedModifiedGmt === 'string' && publishedModifiedGmt.length > 0)
  ) {
    return 'published';
  }
  return explicitState === 'draft' ? 'draft' : null;
}

function validWordPressPublishRunId(runId: string): boolean {
  return runId.length > 0
    && runId.length <= 512
    && !/[\u0000-\u001f\u007f]/.test(runId);
}

function readWordPressPublishIntent(delivery: DesignWorkflowDelivery): {
  managedPageFingerprint: string;
  modifiedGmt: string;
} {
  const managedPageFingerprint = delivery.target.wordpressManagedPageFingerprint;
  const rawIntent = delivery.target.wordpressPublishIntent;
  const modifiedGmt = delivery.target.modifiedGmt;
  if (
    typeof managedPageFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/.test(managedPageFingerprint)
    || !rawIntent
    || typeof rawIntent !== 'object'
    || Array.isArray(rawIntent)
    || typeof modifiedGmt !== 'string'
    || modifiedGmt.length === 0
  ) {
    throw new Error('WordPress delivery is missing its durable publish intent; run /push again before approving.');
  }
  const intent = rawIntent as Record<string, unknown>;
  if (
    typeof intent.runId !== 'string'
    || !validWordPressPublishRunId(intent.runId)
    || typeof intent.createdAt !== 'number'
    || !Number.isSafeInteger(intent.createdAt)
    || intent.createdAt !== delivery.createdAt
    || intent.managedPageFingerprint !== managedPageFingerprint
  ) {
    throw new Error('WordPress delivery is missing its durable publish intent; run /push again before approving.');
  }
  const durableIntent: WordPressPublishIntent = {
    runId: intent.runId,
    createdAt: intent.createdAt,
    managedPageFingerprint,
  };
  return {
    managedPageFingerprint: durableIntent.managedPageFingerprint,
    modifiedGmt,
  };
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

function validFullGitSha(value: string): boolean {
  return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);
}

function validGitBranch(branch: string): boolean {
  if (!branch || branch.length > 200) return false;
  const components = branch.split('/');
  return components.every((component) =>
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(component)
    && !component.includes('..')
    && !component.endsWith('.')
    && !component.endsWith('.lock'),
  );
}

function validCodexBranch(branch: string): boolean {
  return branch.startsWith('codex/') && branch.split('/').length >= 2 && validGitBranch(branch);
}

function validGitRemote(gitRemote: string): boolean {
  if (
    gitRemote.length === 0
    || gitRemote.length > 4096
    || gitRemote.trim() !== gitRemote
    || /[\u0000-\u001f\u007f]/.test(gitRemote)
  ) return false;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(gitRemote)) return true;
  try {
    const url = new URL(gitRemote);
    return url.password === ''
      && ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username === '');
  } catch {
    return false;
  }
}

function normalizedHostname(hostname: string): string {
  const withoutTrailingDot = hostname.toLowerCase().replace(/\.+$/, '');
  return withoutTrailingDot.startsWith('[') && withoutTrailingDot.endsWith(']')
    ? withoutTrailingDot.slice(1, -1)
    : withoutTrailingDot;
}

function normalizedUrlHostname(url: URL): string {
  return normalizedHostname(url.hostname);
}

function isNonRemotePreviewHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  const family = isIP(hostname);
  return family !== 0 && !isPermittedPreviewAddress(hostname, hostname, family);
}

function isPermittedPreviewAddress(
  expectedHostname: string,
  address: string,
  family: number,
): boolean {
  if (isIP(address) !== family || (family !== 4 && family !== 6)) return false;
  const type = family === 4 ? 'ipv4' : 'ipv6';
  if (CORE_UI_CONFIGURED_TAILNET_HOSTNAMES.has(expectedHostname)) {
    return family === 4
      ? TAILSCALE_PREVIEW_IPV4_ADDRESSES.check(address, type)
      : TAILSCALE_PREVIEW_IPV6_ADDRESSES.check(address, type);
  }
  return family === 4
    ? !NON_PUBLIC_PREVIEW_IPV4_ADDRESSES.check(address, type)
    : PUBLIC_GLOBAL_UNICAST_IPV6_ADDRESSES.check(address, type)
      && !NON_PUBLIC_PREVIEW_IPV6_ADDRESSES.check(address, type);
}

function validPreviewReceiptPath(receiptPath: string): boolean {
  if (
    !receiptPath.startsWith(CORE_UI_STATIC_ROOT)
    || !receiptPath.endsWith('.json')
    || path.isAbsolute(receiptPath)
    || receiptPath.includes('\0')
  ) return false;
  const components = receiptPath.split('/');
  return components.every((component) =>
    component !== '' && component !== '.' && component !== '..' && /^[A-Za-z0-9._-]+$/.test(component),
  );
}

type LookupLike = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>;

export interface CoreUiReceiptBinding {
  challenge: string;
  projectId: string;
  runId: string;
  designRevision: string;
  baseBranch: string;
  baseCommit: string;
  gitRemote: string;
  implementationCommit: string;
  targetOrigin: string;
  receiptPath: string;
}

const CORE_UI_ATTESTATION_SENTINEL = [
  '    <!-- open-design-attestation:start -->',
  '    <!-- open-design-attestation:end -->',
].join('\n');

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    timeout.unref();
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function resolveRemoteAddresses(
  url: URL,
  lookupImpl: LookupLike,
): Promise<Array<{ address: string; family: number }>> {
  const hostname = normalizedUrlHostname(url);
  if (isNonRemotePreviewHost(hostname)) {
    throw new Error('Core UI delivery preview resolved to a private or reserved address.');
  }
  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) return [{ address: hostname, family: literalFamily }];
  const addresses = await withTimeout(
    lookupImpl(hostname, { all: true, verbatim: true }),
    DNS_LOOKUP_TIMEOUT_MS,
    'Core UI delivery preview DNS lookup timed out.',
  );
  if (
    addresses.length === 0
    || addresses.some(({ address, family }) =>
      !isPermittedPreviewAddress(hostname, address, family),
    )
  ) {
    throw new Error('Core UI delivery preview resolved to a private or reserved address.');
  }
  return addresses;
}

function pinnedLookup(
  expectedHostname: string,
  addresses: Array<{ address: string; family: number }>,
): LookupFunction {
  return (hostname, options, callback) => {
    if (normalizedHostname(hostname) !== expectedHostname) {
      const error = new Error('Core UI delivery attempted to connect to an unverified hostname.') as NodeJS.ErrnoException;
      error.code = 'ENOTFOUND';
      callback(error, '', 0);
      return;
    }
    const family = typeof options.family === 'number' && options.family !== 0
      ? options.family
      : null;
    const candidates = family ? addresses.filter((address) => address.family === family) : addresses;
    const selected = candidates[0];
    if (!selected) {
      const error = new Error(`No verified address is available for address family ${family}.`) as NodeJS.ErrnoException;
      error.code = 'ENOTFOUND';
      callback(error, '', 0);
      return;
    }
    if (options.all) {
      callback(null, candidates);
      return;
    }
    callback(null, selected.address, selected.family);
  };
}

async function readResponseBytesLimited(
  response: Response,
  limit: number,
  resource: string,
): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new Error(`${resource} exceeds the verification size limit.`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.byteLength;
      if (total > limit) {
        throw new Error(`${resource} exceeds the verification size limit.`);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export function canonicalCoreUiReceipt(binding: CoreUiReceiptBinding): Buffer {
  return Buffer.from(`${JSON.stringify({
    schemaVersion: 2,
    kind: 'open-design-core-ui-attestation',
    challenge: binding.challenge,
    projectId: binding.projectId,
    runId: binding.runId,
    designRevision: binding.designRevision,
    baseBranch: binding.baseBranch,
    baseCommit: binding.baseCommit,
    gitRemote: binding.gitRemote,
    implementationCommit: binding.implementationCommit,
    targetOrigin: binding.targetOrigin,
    receiptPath: binding.receiptPath,
  }, null, 2)}\n`);
}

function parseCoreUiReceipt(
  receiptContent: Buffer,
  expected: CoreUiReceiptBinding,
): CoreUiReceiptBinding {
  if (receiptContent.byteLength > MAX_PREVIEW_RECEIPT_BYTES) {
    throw new Error('Core UI preview receipt exceeds the verification size limit.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(receiptContent.toString('utf8')) as unknown;
  } catch {
    throw new Error('Core UI preview receipt in Git is invalid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Core UI preview receipt in Git is not bound to the applied design revision.');
  }
  const receipt = parsed as Record<string, unknown>;
  if (
    receipt.schemaVersion !== 2
    || receipt.kind !== 'open-design-core-ui-attestation'
    || receipt.challenge !== expected.challenge
    || receipt.projectId !== expected.projectId
    || receipt.runId !== expected.runId
    || receipt.designRevision !== expected.designRevision
    || receipt.baseBranch !== expected.baseBranch
    || receipt.baseCommit !== expected.baseCommit
    || receipt.gitRemote !== expected.gitRemote
    || receipt.implementationCommit !== expected.implementationCommit
    || receipt.targetOrigin !== expected.targetOrigin
    || receipt.receiptPath !== expected.receiptPath
    || !/^[a-f0-9]{64}$/.test(expected.challenge)
    || !validFullGitSha(expected.designRevision)
    || !validFullGitSha(expected.baseCommit)
    || !validGitRemote(expected.gitRemote)
    || !validFullGitSha(expected.implementationCommit)
    || expected.projectId !== CORE_UI_PROJECT_ID
    || expected.targetOrigin !== CORE_UI_LIVE_ORIGIN
    || !validPreviewReceiptPath(expected.receiptPath)
    || !receiptContent.equals(canonicalCoreUiReceipt(expected))
  ) {
    throw new Error('Core UI preview receipt in Git is not the exact canonical daemon-bound attestation.');
  }
  return expected;
}

function publicReceiptUrlPath(receiptPath: string): string {
  if (!validPreviewReceiptPath(receiptPath)) {
    throw new Error('Core UI delivery requires a safe public JSON previewReceiptPath.');
  }
  return `/${receiptPath.slice(CORE_UI_STATIC_ROOT.length)}`;
}

function coreUiPreviewReceiptUrl(receiptPath: string): string {
  return new URL(
    `.${publicReceiptUrlPath(receiptPath)}`,
    CORE_UI_PREVIEW_ROOT,
  ).toString();
}

function canonicalCoreUiAttestationBlock(binding: CoreUiReceiptBinding): string {
  return [
    '    <!-- open-design-attestation:start -->',
    `    <meta name="open-design-challenge" content="${binding.challenge}" />`,
    `    <meta name="open-design-design-revision" content="${binding.designRevision}" />`,
    `    <meta name="open-design-implementation-commit" content="${binding.implementationCommit}" />`,
    `    <meta name="open-design-target-origin" content="${binding.targetOrigin}" />`,
    `    <meta name="open-design-receipt-path" content="${publicReceiptUrlPath(binding.receiptPath)}" />`,
    '    <!-- open-design-attestation:end -->',
  ].join('\n');
}

export function verifyCoreUiAttestationFiles(input: {
  implementationApp: Buffer;
  attestationApp: Buffer;
  receiptContent: Buffer;
  binding: CoreUiReceiptBinding;
}): void {
  parseCoreUiReceipt(input.receiptContent, input.binding);
  const implementationApp = input.implementationApp.toString('utf8');
  const sentinelParts = implementationApp.split(CORE_UI_ATTESTATION_SENTINEL);
  if (sentinelParts.length !== 2) {
    throw new Error('Core UI implementation commit must contain exactly one untouched Open Design attestation sentinel.');
  }
  const expectedAttestationApp = sentinelParts.join(canonicalCoreUiAttestationBlock(input.binding));
  if (!input.attestationApp.equals(Buffer.from(expectedAttestationApp))) {
    throw new Error('Core UI attestation commit changed app.html outside the canonical attestation sentinel.');
  }
}

function assertCoreUiRootBinding(
  html: string,
  binding: CoreUiReceiptBinding,
  routeLabel: string,
): void {
  const $ = load(html);
  const bindings = new Map([
    ['open-design-challenge', binding.challenge],
    ['open-design-design-revision', binding.designRevision],
    ['open-design-implementation-commit', binding.implementationCommit],
    ['open-design-target-origin', binding.targetOrigin],
    ['open-design-receipt-path', publicReceiptUrlPath(binding.receiptPath)],
  ]);
  for (const [name, expected] of bindings) {
    const metas = $('head meta').filter((_index, element) =>
      $(element).attr('name')?.toLowerCase() === name,
    );
    if (metas.length !== 1 || metas.attr('content') !== expected) {
      throw new Error(`${routeLabel} does not expose the exact Open Design ${name} binding.`);
    }
  }
}

function responseMediaType(response: Response): string {
  return (response.headers.get('content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase();
}

async function verifyServedCoreUiReceipt(input: {
  rootUrl: URL;
  receiptUrl: URL;
  receiptContent: Buffer;
  binding: CoreUiReceiptBinding;
  routeLabel: string;
  fetchImpl: FetchLike;
}): Promise<void> {
  const rootResponse = await input.fetchImpl(input.rootUrl, {
    method: 'GET',
    redirect: 'error',
    headers: { accept: 'text/html', 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(10_000),
  });
  try {
    if (!rootResponse.ok) {
      throw new Error(`${input.routeLabel} failed with HTTP ${rootResponse.status}.`);
    }
    if (responseMediaType(rootResponse) !== 'text/html') {
      throw new Error(`${input.routeLabel} did not return text/html.`);
    }
    const rootContent = await readResponseBytesLimited(
      rootResponse,
      MAX_PREVIEW_HTML_BYTES,
      `${input.routeLabel} HTML`,
    );
    assertCoreUiRootBinding(
      rootContent.toString('utf8'),
      input.binding,
      input.routeLabel,
    );
  } finally {
    await rootResponse.body?.cancel().catch(() => undefined);
  }

  const receiptResponse = await input.fetchImpl(input.receiptUrl, {
    method: 'GET',
    redirect: 'error',
    headers: { accept: 'application/json', 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(10_000),
  });
  try {
    if (!receiptResponse.ok) {
      throw new Error(`${input.routeLabel} receipt failed with HTTP ${receiptResponse.status}.`);
    }
    if (responseMediaType(receiptResponse) !== 'application/json') {
      throw new Error(`${input.routeLabel} receipt did not return application/json.`);
    }
    const servedReceipt = await readResponseBytesLimited(
      receiptResponse,
      MAX_PREVIEW_RECEIPT_BYTES,
      `${input.routeLabel} receipt`,
    );
    if (!servedReceipt.equals(input.receiptContent)) {
      throw new Error(`${input.routeLabel} receipt does not match the exact Git commit.`);
    }
  } finally {
    await receiptResponse.body?.cancel().catch(() => undefined);
  }
}

async function withPinnedRemoteFetch<T>(input: {
  url: URL;
  lookupImpl: LookupLike;
  fetchImpl?: FetchLike | undefined;
  run: (fetchImpl: FetchLike) => Promise<T>;
}): Promise<T> {
  const addresses = await resolveRemoteAddresses(input.url, input.lookupImpl);
  if (input.fetchImpl) return input.run(input.fetchImpl);
  const expectedHostname = normalizedUrlHostname(input.url);
  const dispatcher = new Agent({
    maxOrigins: 1,
    autoSelectFamily: true,
    autoSelectFamilyAttemptTimeout: 250,
    connect: {
      lookup: pinnedLookup(expectedHostname, addresses),
    },
  });
  const fetchImpl: FetchLike = (url, init) => undiciFetch(url, {
    ...init,
    dispatcher,
  } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;
  try {
    return await withTimeout(
      input.run(fetchImpl),
      REMOTE_VERIFICATION_TIMEOUT_MS,
      'Core UI remote receipt verification timed out.',
    );
  } catch (error) {
    await dispatcher.destroy(error instanceof Error ? error : new Error(String(error)));
    throw error;
  } finally {
    if (!dispatcher.destroyed) await dispatcher.close();
  }
}

export async function verifyCoreUiPreviewReceipt(input: {
  previewUrl: string;
  receiptUrl: string;
  receiptContent: Buffer;
  receiptPath: string;
  projectId: string;
  runId: string;
  challenge: string;
  revisionSha: string;
  baseBranch: string;
  baseCommit: string;
  gitRemote: string;
  implementationCommit: string;
  targetOrigin: string;
  fetchImpl?: FetchLike;
  lookupImpl?: LookupLike;
}): Promise<void> {
  const binding = parseCoreUiReceipt(input.receiptContent, {
    challenge: input.challenge,
    projectId: input.projectId,
    runId: input.runId,
    designRevision: input.revisionSha,
    baseBranch: input.baseBranch,
    baseCommit: input.baseCommit,
    gitRemote: input.gitRemote,
    implementationCommit: input.implementationCommit,
    targetOrigin: input.targetOrigin,
    receiptPath: input.receiptPath,
  });
  const preview = new URL(input.previewUrl);
  const receiptUrl = new URL(input.receiptUrl);
  if (
    preview.protocol !== 'https:'
    || receiptUrl.protocol !== 'https:'
    || preview.username !== ''
    || preview.password !== ''
    || receiptUrl.username !== ''
    || receiptUrl.password !== ''
    || preview.origin !== receiptUrl.origin
    || preview.search !== ''
    || preview.hash !== ''
    || preview.toString() !== CORE_UI_PREVIEW_ROOT
  ) {
    throw new Error(`Core UI preview receipt must use the exact configured route ${CORE_UI_PREVIEW_ROOT}.`);
  }
  if (receiptUrl.toString() !== coreUiPreviewReceiptUrl(binding.receiptPath)) {
    throw new Error('Core UI preview receipt URL must stay under the exact configured preview route.');
  }
  const lookupImpl = input.lookupImpl ?? lookup;
  await withPinnedRemoteFetch({
    url: preview,
    lookupImpl,
    fetchImpl: input.fetchImpl,
    run: (fetchImpl) => verifyServedCoreUiReceipt({
      rootUrl: preview,
      receiptUrl,
      receiptContent: input.receiptContent,
      binding,
      routeLabel: 'Core UI preview route',
      fetchImpl,
    }),
  });
}

export async function verifyCoreUiDeploymentReceipt(input: {
  receiptPath: string;
  receiptContent: Buffer;
  projectId: string;
  runId: string;
  challenge: string;
  revisionSha: string;
  baseBranch: string;
  baseCommit: string;
  gitRemote: string;
  implementationCommit: string;
  targetOrigin: string;
  fetchImpl?: FetchLike;
  lookupImpl?: LookupLike;
}): Promise<void> {
  const binding = parseCoreUiReceipt(input.receiptContent, {
    challenge: input.challenge,
    projectId: input.projectId,
    runId: input.runId,
    designRevision: input.revisionSha,
    baseBranch: input.baseBranch,
    baseCommit: input.baseCommit,
    gitRemote: input.gitRemote,
    implementationCommit: input.implementationCommit,
    targetOrigin: input.targetOrigin,
    receiptPath: input.receiptPath,
  });
  const receiptUrlPath = publicReceiptUrlPath(binding.receiptPath);
  const localRoot = new URL('/', CORE_UI_LOCAL_ORIGIN);
  const localReceipt = new URL(receiptUrlPath, CORE_UI_LOCAL_ORIGIN);
  const liveRoot = new URL('/', CORE_UI_LIVE_ORIGIN);
  const liveReceipt = new URL(receiptUrlPath, CORE_UI_LIVE_ORIGIN);
  await Promise.all([
    verifyServedCoreUiReceipt({
      rootUrl: localRoot,
      receiptUrl: localReceipt,
      receiptContent: input.receiptContent,
      binding,
      routeLabel: 'Core UI localhost route',
      fetchImpl: input.fetchImpl ?? fetch,
    }),
    withPinnedRemoteFetch({
      url: liveRoot,
      lookupImpl: input.lookupImpl ?? lookup,
      fetchImpl: input.fetchImpl,
      run: (fetchImpl) => verifyServedCoreUiReceipt({
        rootUrl: liveRoot,
        receiptUrl: liveReceipt,
        receiptContent: input.receiptContent,
        binding,
        routeLabel: 'Core UI tailnet route',
        fetchImpl,
      }),
    }),
  ]);
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
  baseBranch: string;
  baseCommit: string;
  gitRemote: string;
  challenge: string;
  runId: string;
  targetOrigin: string;
  receiptPath: string;
  now?: number;
}): DesignWorkflowDelivery {
  const manifest = readManifest(input.projectRoot);
  if (manifest.schemaVersion !== 2 || manifest.adapter !== 'core-ui') {
    throw new Error('Core UI /push must write a schemaVersion 2 .open-design/delivery.json with adapter "core-ui".');
  }
  const manifestChallenge = typeof manifest.challenge === 'string' ? manifest.challenge : '';
  const branch = typeof manifest.branch === 'string' ? manifest.branch : '';
  const baseBranch = typeof manifest.baseBranch === 'string' ? manifest.baseBranch : '';
  const baseCommit = typeof manifest.baseCommit === 'string' ? manifest.baseCommit : '';
  const gitRemote = typeof manifest.gitRemote === 'string' ? manifest.gitRemote : '';
  const implementationCommit = typeof manifest.implementationCommit === 'string'
    ? manifest.implementationCommit
    : '';
  const attestationCommit = typeof manifest.attestationCommit === 'string'
    ? manifest.attestationCommit
    : '';
  const designRevision = typeof manifest.designRevision === 'string' ? manifest.designRevision : '';
  const targetOrigin = typeof manifest.targetOrigin === 'string' ? manifest.targetOrigin : '';
  const previewUrl = typeof manifest.previewUrl === 'string' ? manifest.previewUrl : '';
  const previewReceiptUrl = typeof manifest.previewReceiptUrl === 'string' ? manifest.previewReceiptUrl : '';
  const receiptPath = typeof manifest.receiptPath === 'string' ? manifest.receiptPath : '';
  if (!Array.isArray(manifest.checks)) {
    throw new Error('Core UI delivery checks must be a nonempty array.');
  }
  const checks = manifest.checks;
  if (manifestChallenge !== input.challenge || !/^[a-f0-9]{64}$/.test(manifestChallenge)) {
    throw new Error('Core UI delivery manifest must use the exact daemon-issued challenge.');
  }
  if (!validCodexBranch(branch)) {
    throw new Error('Core UI delivery manifest requires an isolated codex/ branch.');
  }
  if (!validGitBranch(input.baseBranch) || baseBranch !== input.baseBranch) {
    throw new Error('Core UI delivery requires a valid remote default branch.');
  }
  if (
    !validGitRemote(input.gitRemote)
    || gitRemote !== input.gitRemote
  ) {
    throw new Error('Core UI delivery manifest must use the exact safe daemon-supplied gitRemote.');
  }
  if (
    !validFullGitSha(input.baseCommit)
    || baseCommit !== input.baseCommit
    || !validFullGitSha(implementationCommit)
    || !validFullGitSha(attestationCommit)
    || new Set([
      baseCommit.toLowerCase(),
      implementationCommit.toLowerCase(),
      attestationCommit.toLowerCase(),
    ]).size !== 3
  ) {
    throw new Error('Core UI delivery manifest requires the exact base and distinct full implementation and attestation commits.');
  }
  if (
    !validFullGitSha(designRevision)
    || designRevision.toLowerCase() !== input.revisionSha.toLowerCase()
  ) {
    throw new Error('Core UI delivery manifest designRevision must exactly match the applied design-system revision.');
  }
  if (targetOrigin !== input.targetOrigin || targetOrigin !== CORE_UI_LIVE_ORIGIN) {
    throw new Error('Core UI delivery manifest targetOrigin must exactly match the configured live Core UI origin.');
  }
  if (receiptPath !== input.receiptPath || !validPreviewReceiptPath(receiptPath)) {
    throw new Error('Core UI delivery manifest must use the exact daemon-issued receiptPath.');
  }
  let preview: URL;
  try {
    preview = new URL(previewUrl);
  } catch {
    throw new Error('Core UI delivery manifest requires a valid HTTPS previewUrl.');
  }
  const previewHost = normalizedUrlHostname(preview);
  if (
    preview.protocol !== 'https:'
    || preview.username !== ''
    || preview.password !== ''
    || isNonRemotePreviewHost(previewHost)
    || preview.search !== ''
    || preview.hash !== ''
    || preview.toString() !== CORE_UI_PREVIEW_ROOT
  ) {
    throw new Error(`Core UI delivery preview must use the exact configured route ${CORE_UI_PREVIEW_ROOT}.`);
  }
  let receiptUrl: URL;
  try {
    receiptUrl = new URL(previewReceiptUrl);
  } catch {
    throw new Error('Core UI delivery requires a valid previewReceiptUrl.');
  }
  const receiptHost = normalizedUrlHostname(receiptUrl);
  if (
    receiptUrl.protocol !== 'https:'
    || receiptUrl.username !== ''
    || receiptUrl.password !== ''
    || isNonRemotePreviewHost(receiptHost)
    || receiptUrl.origin !== preview.origin
  ) {
    throw new Error('Core UI delivery preview receipt must use the exact non-loopback preview origin.');
  }
  if (
    receiptUrl.toString() !== coreUiPreviewReceiptUrl(receiptPath)
    || receiptUrl.search !== ''
    || receiptUrl.hash !== ''
  ) {
    throw new Error('Core UI delivery preview receipt URL must match previewReceiptPath exactly.');
  }
  if (manifest.approvalRequired !== true || manifest.approvalReady !== true) {
    throw new Error('Core UI delivery must explicitly require approval and be ready only after every preview gate passes.');
  }
  const checkNames = new Set<string>();
  if (checks.length === 0 || checks.some((check) => {
    if (!check || typeof check !== 'object') return true;
    const record = check as Record<string, unknown>;
    if (typeof record.name !== 'string' || !/^[a-z][a-z0-9-]{1,63}$/.test(record.name)) return true;
    checkNames.add(record.name);
    return record.status !== 'passed' || record.commit !== attestationCommit;
  })) {
    throw new Error('Core UI delivery requires named checks passed against the exact attestation commit.');
  }
  const missingChecks = [...REQUIRED_CORE_UI_CHECKS].filter((name) => !checkNames.has(name));
  if (missingChecks.length > 0) {
    throw new Error(`Core UI delivery is missing required passed checks: ${missingChecks.join(', ')}.`);
  }
  const now = input.now ?? Date.now();
  return {
    id: randomUUID(),
    projectId: CORE_UI_PROJECT_ID,
    adapter: 'core-ui',
    revisionSha: input.revisionSha,
    implementationDigest: digest(JSON.stringify({
      revisionSha: input.revisionSha,
      challenge: input.challenge,
      runId: input.runId,
      branch,
      baseBranch,
      baseCommit,
      gitRemote,
      implementationCommit,
      attestationCommit,
      targetOrigin,
      previewUrl,
      previewReceiptUrl,
      receiptPath,
      checks,
    })),
    status: 'ready_for_approval',
    previewUrl,
    target: {
      challenge: input.challenge,
      runId: input.runId,
      branch,
      commit: attestationCommit,
      baseSha: baseCommit,
      baseBranch,
      baseCommit,
      gitRemote,
      implementationCommit,
      attestationCommit,
      designRevision,
      targetOrigin,
      receiptPath,
      previewReceiptPath: receiptPath,
      previewReceiptUrl,
      checks,
    },
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
  if (!validWordPressPublishRunId(input.runId)) {
    throw new Error('WordPress draft delivery requires a durable run ID.');
  }
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
  const priorPageId = input.priorDelivery
    && wordpressManagedPageState(input.priorDelivery) === 'draft'
    ? Number(input.priorDelivery.target.pageId ?? 0)
    : 0;
  const now = input.now ?? Date.now();
  let checkpointPath: string | null = null;
  let reusedPageId = 0;
  let page: Record<string, any> | null = null;
  if (Number.isInteger(priorPageId) && priorPageId > 0) {
    if (PROTECTED_WORDPRESS_PAGE_IDS.has(priorPageId)) throw new Error(`Refusing to update protected WordPress page ${priorPageId}.`);
    const before = await wordpressJson(fetchImpl, credentials, 'GET', `/wp/v2/pages/${priorPageId}?context=edit`);
    if (typeof before.status !== 'string') {
      throw new Error(`WordPress page ${priorPageId} did not return a managed lifecycle status.`);
    }
    if (before.status === 'draft') {
      reusedPageId = priorPageId;
      const checkpointDir = path.join(input.projectRoot, '.open-design', 'wordpress-checkpoints');
      fs.mkdirSync(checkpointDir, { recursive: true });
      checkpointPath = path.join(checkpointDir, `${new Date(now).toISOString().replace(/[:.]/g, '-')}-page-${priorPageId}.json`);
      fs.writeFileSync(checkpointPath, `${JSON.stringify(before, null, 2)}\n`);
      page = await wordpressJson(fetchImpl, credentials, 'POST', `/wp/v2/pages/${priorPageId}`, {
        title, slug, status: 'draft', template: 'elementor_header_footer', content: uploaded.html,
      });
    }
  }
  if (!page) {
    page = await wordpressJson(fetchImpl, credentials, 'POST', '/wp/v2/pages', {
      title, slug, status: 'draft', template: 'elementor_header_footer', content: uploaded.html,
    });
  }
  const stagedPageId = Number(page.id);
  if (
    !Number.isInteger(stagedPageId)
    || stagedPageId <= 0
    || PROTECTED_WORDPRESS_PAGE_IDS.has(stagedPageId)
    || (reusedPageId > 0 && stagedPageId !== reusedPageId)
  ) {
    throw new Error(`WordPress returned an invalid or protected page ID ${page.id}.`);
  }
  const readback = await wordpressJson(fetchImpl, credentials, 'GET', `/wp/v2/pages/${stagedPageId}?context=edit`);
  const managedPage = readWordPressManagedPage(readback, stagedPageId);
  if (managedPage.status !== 'draft') throw new Error(`WordPress page ${stagedPageId} is ${managedPage.status}, not draft.`);
  const managedPageFingerprint = wordpressManagedPageFingerprint(managedPage);
  return {
    id: randomUUID(),
    projectId: GRAND_SLAM_OFFER_PROJECT_ID,
    adapter: 'wordpress-draft',
    revisionSha: input.revisionSha,
    implementationDigest,
    status: 'ready_for_approval',
    previewUrl: `${WORDPRESS_SITE_ORIGIN}/?page_id=${stagedPageId}&preview=true`,
    target: {
      pageId: stagedPageId,
      slug: managedPage.slug,
      modifiedGmt: managedPage.modifiedGmt,
      contentDigest: digest(managedPage.contentRaw),
      wordpressManagedPageFingerprint: managedPageFingerprint,
      wordpressManagedPageState: 'draft',
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
  if (
    delivery.adapter !== 'wordpress-draft'
    || (delivery.status !== 'ready_for_approval' && delivery.status !== 'approving')
  ) {
    throw new Error('Only a reserved or ready WordPress draft delivery can be published.');
  }
  if (wordpressManagedPageState(delivery) !== 'draft') {
    throw new Error('WordPress delivery is not bound to a durable draft lifecycle state; run /push again before approving.');
  }
  const now = options.now ?? Date.now();
  const pageId = Number(delivery.target.pageId ?? 0);
  if (!Number.isInteger(pageId) || pageId <= 0 || PROTECTED_WORDPRESS_PAGE_IDS.has(pageId)) {
    throw new Error('Delivery has an invalid or protected WordPress page binding.');
  }
  const {
    managedPageFingerprint,
    modifiedGmt,
  } = readWordPressPublishIntent(delivery);
  const fetchImpl = options.fetchImpl ?? fetch;
  const credentials = options.credentials ?? readWordPressCredentials();
  const readPage = async (): Promise<WordPressManagedPage> => readWordPressManagedPage(
    await wordpressJson(fetchImpl, credentials, 'GET', `/wp/v2/pages/${pageId}?context=edit`),
    pageId,
  );
  const deployedDelivery = (page: WordPressManagedPage): DesignWorkflowDelivery => ({
    ...delivery,
    status: 'deployed',
    previewUrl: page.link ?? delivery.previewUrl,
    updatedAt: now,
    target: {
      ...delivery.target,
      wordpressManagedPageState: 'published',
      publishedModifiedGmt: page.modifiedGmt,
    },
  });

  const current = await readPage();
  const currentFingerprint = wordpressManagedPageFingerprint(current);
  if (current.status === 'publish') {
    if (currentFingerprint !== managedPageFingerprint) {
      throw new WordPressPublishReconciliationRequiredError(pageId);
    }
    return deployedDelivery(current);
  }
  if (
    current.status !== 'draft'
    || current.modifiedGmt !== modifiedGmt
    || currentFingerprint !== managedPageFingerprint
  ) {
    throw new Error('WordPress draft changed after preview; run /push again before approving.');
  }

  let publishFailure: { error: unknown } | null = null;
  try {
    await wordpressJson(fetchImpl, credentials, 'POST', `/wp/v2/pages/${pageId}`, { status: 'publish' });
  } catch (error) {
    publishFailure = { error };
  }

  let published: WordPressManagedPage;
  try {
    published = await readPage();
  } catch (readbackError) {
    const cause = publishFailure
      ? new AggregateError(
        [publishFailure.error, readbackError],
        `WordPress page ${pageId} publish request and readback both failed.`,
      )
      : readbackError;
    throw new WordPressPublishOutcomeUnknownError(pageId, cause);
  }
  const publishedFingerprint = wordpressManagedPageFingerprint(published);
  if (published.status === 'publish') {
    if (publishedFingerprint !== managedPageFingerprint) {
      throw new WordPressPublishReconciliationRequiredError(
        pageId,
        publishFailure?.error,
      );
    }
    return deployedDelivery(published);
  }
  if (
    published.status === 'draft'
    && published.modifiedGmt === modifiedGmt
    && publishedFingerprint === managedPageFingerprint
  ) {
    if (publishFailure) {
      throw publishFailure.error instanceof Error
        ? publishFailure.error
        : new Error(String(publishFailure.error));
    }
    throw new Error(`WordPress page ${pageId} remained a draft after the publish request.`);
  }
  throw new Error(`WordPress page ${pageId} changed during publish; refusing to reconcile automatically.`);
}
