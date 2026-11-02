import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cacheCommand } from '../../src/commands/cache.js';
import { RegistryCache } from '../../src/core/registry/cache.js';

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'slopgate-cache-cmd-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

function dbPath(repo: string): string {
  return join(repo, '.slopgate', 'cache.db');
}

function captureStdout(fn: () => void): string {
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    fn();
    return spy.mock.calls.map((call) => String(call[0])).join('');
  } finally {
    spy.mockRestore();
  }
}

describe('cacheCommand', () => {
  it('reports when there is no cache yet', () => {
    const repo = makeRepo();
    const out = captureStdout(() => cacheCommand('stats', { cwd: repo }));
    expect(out).toContain('no cache yet');
    expect(out).toContain(dbPath(repo));
  });

  it('prints entry counts and file size', () => {
    const repo = makeRepo();
    const cache = new RegistryCache(dbPath(repo));
    cache.set('npm', 'commander', true);
    cache.set('npm', 'ghost-pkg', false);
    cache.close();

    const out = captureStdout(() => cacheCommand('stats', { cwd: repo }));
    expect(out).toContain('entries: 2');
    expect(out).toContain('1 found');
    expect(out).toContain('1 not found');
    expect(out).toMatch(/size: \d+\.\d KB/);
  });

  it('clear removes the cache db and reports the count', () => {
    const repo = makeRepo();
    const cache = new RegistryCache(dbPath(repo));
    cache.set('npm', 'commander', true);
    cache.close();

    const out = captureStdout(() => cacheCommand('clear', { cwd: repo }));
    expect(out).toContain('cache cleared');
    expect(out).toContain('1 entry');
    expect(existsSync(dbPath(repo))).toBe(false);
  });

  it('clear is a no-op when no cache exists', () => {
    const repo = makeRepo();
    const out = captureStdout(() => cacheCommand('clear', { cwd: repo }));
    expect(out).toContain('no cache to clear');
  });

  it('defaults to stats when no action is given', () => {
    const repo = makeRepo();
    const out = captureStdout(() => cacheCommand(undefined, { cwd: repo }));
    expect(out).toContain('no cache yet');
  });
});
