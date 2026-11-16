// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const consoleRoot = resolve(here, '../..');
const repoRoot = resolve(consoleRoot, '../..');

const html = readFileSync(resolve(consoleRoot, 'index.html'), 'utf8');
const containerPolicy = readFileSync(resolve(consoleRoot, 'nginx.conf'), 'utf8');
const edgePolicy = readFileSync(resolve(repoRoot, 'infra/nginx/synapsecity-sos.conf'), 'utf8');

function csp(source: string): string {
  const match = source.match(/Content-Security-Policy\s+"([^"]+)"/);
  if (!match) throw new Error('CSP not found');
  return match[1];
}

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...values] = part.split(/\s+/);
        return [name, values];
      }),
  );
}

describe('public edge CSP and splash bootstrap', () => {
  it('has no inline executable script in the built HTML shell', () => {
    const inline = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
    expect(inline).toHaveLength(0);
    expect(html).toContain('src="/splash.js"');
    expect(existsSync(resolve(consoleRoot, 'public/splash.js'))).toBe(true);
  });

  it('does not allow inline script at either nginx layer', () => {
    for (const source of [containerPolicy, edgePolicy]) {
      expect(directives(csp(source)).get('script-src')).toEqual(["'self'"]);
    }
  });

  it('keeps the security-critical directive sets aligned', () => {
    const container = directives(csp(containerPolicy));
    const edge = directives(csp(edgePolicy));
    for (const name of ['default-src', 'script-src', 'connect-src', 'object-src', 'base-uri', 'frame-ancestors']) {
      expect(edge.get(name), name).toEqual(container.get(name));
    }
  });
});
