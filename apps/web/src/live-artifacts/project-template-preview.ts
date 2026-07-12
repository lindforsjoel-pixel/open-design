import type { BoundedJsonObject } from '@open-design/contracts';

const TEMPLATE_INTERPOLATION = /{{\s*([^{}]+?)\s*}}/g;
const RAW_TEMPLATE_INTERPOLATION = /{{{[^{}]*}}}|{{\s*&[^{}]*}}/;
const TEMPLATE_PATH = /^(?:data)(?:\.(?:[A-Za-z_][A-Za-z0-9_-]*|\d+))*$/;

function escapeHtmlTemplateValue(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function readTemplatePath(dataJson: BoundedJsonObject, rawPath: string): unknown {
  const segments = rawPath.split('.');
  segments.shift();
  let current: unknown = dataJson;
  for (const segment of segments) {
    if (current == null) return '';
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) throw new Error(`invalid array segment in template binding path: ${rawPath}`);
      current = current[Number(segment)];
      continue;
    }
    if (typeof current !== 'object') return '';
    current = (current as Record<string, unknown>)[segment];
  }
  return current ?? '';
}

/**
 * Render escaped html_template_v1 bindings for the ordinary sandboxed project
 * preview. Unlike the registered live-artifact renderer, this intentionally
 * preserves the project's own scripts; registered templates continue through
 * the daemon renderer and its script prohibition.
 */
export function renderProjectTemplatePreview(
  templateHtml: string,
  dataJson: BoundedJsonObject,
): string {
  if (RAW_TEMPLATE_INTERPOLATION.test(templateHtml)) {
    throw new Error('raw template interpolation is not supported');
  }
  return templateHtml.replace(TEMPLATE_INTERPOLATION, (_match, rawBinding: string) => {
    const binding = rawBinding.trim();
    if (!TEMPLATE_PATH.test(binding)) throw new Error(`invalid template binding path: ${binding}`);
    const value = readTemplatePath(dataJson, binding);
    if (Array.isArray(value) || (value !== null && typeof value === 'object')) {
      throw new Error(`template binding must resolve to a scalar: ${binding}`);
    }
    return escapeHtmlTemplateValue(value);
  });
}
