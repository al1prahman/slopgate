import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SLOPGATE_VERSION } from '../../src/version.js';

describe('SLOPGATE_VERSION', () => {
  it('is derived from package.json — no manual sync to drift', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(SLOPGATE_VERSION).toBe(pkg.version);
  });

  it('resolves from the built dist layout too', () => {
    // dist/version.js sits one directory below the package root, same as
    // src/version.ts sits one below the repo root — the relative lookup
    // must hold in the published tarball, not just in tests.
    const dist = readFileSync(new URL('../../dist/version.js', import.meta.url), 'utf8');
    expect(dist).toContain("join(here, '..', 'package.json')");
  });
});
