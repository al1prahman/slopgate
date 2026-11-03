import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

interface Hook {
  id: string;
  name: string;
  entry: string;
  language: string;
  pass_filenames: boolean;
  require_serial?: boolean;
  stages?: string[];
  additional_dependencies?: string[];
}

const hooks = parseYaml(
  readFileSync(new URL('../../.pre-commit-hooks.yaml', import.meta.url), 'utf8'),
) as Hook[];

describe('.pre-commit-hooks.yaml', () => {
  it('exposes a pre-commit hook that scans staged changes', () => {
    const hook = hooks.find((h) => h.id === 'slopgate');
    expect(hook).toBeDefined();
    expect(hook!.entry).toBe('slopgate scan --staged');
    expect(hook!.language).toBe('node');
    // slopgate reads the diff itself; per-file args would break it.
    expect(hook!.pass_filenames).toBe(false);
    expect(hook!.stages).toContain('pre-commit');
  });

  it('exposes a pre-push hook that scans the pushed range', () => {
    const hook = hooks.find((h) => h.id === 'slopgate-push');
    expect(hook).toBeDefined();
    expect(hook!.entry).toContain('slopgate scan');
    expect(hook!.entry).toContain('--range');
    expect(hook!.pass_filenames).toBe(false);
    expect(hook!.stages).toContain('pre-push');
  });

  it('installs slopgate from npm via additional_dependencies', () => {
    for (const hook of hooks) {
      expect(hook.additional_dependencies).toContain('@al1prahman/slopgate');
    }
  });

  it('runs hooks serially', () => {
    for (const hook of hooks) {
      expect(hook.require_serial).toBe(true);
    }
  });
});
