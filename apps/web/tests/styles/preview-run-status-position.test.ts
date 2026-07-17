import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const css = readFileSync(
  path.resolve(process.cwd(), 'src/styles/workspace/drawer.css'),
  'utf8',
);

describe('preview run status position', () => {
  it('anchors delivery feedback below the artwork instead of over its center', () => {
    const rule = css.match(/\.ws-preview-run-status-slot\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(rule).toContain('bottom: 24px');
    expect(rule).toContain('transform: translateX(-50%)');
    expect(rule).not.toContain('top: 50%');
  });
});
