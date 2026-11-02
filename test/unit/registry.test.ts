import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createNpmClient, createPypiClient } from '../../src/core/registry/index.js';
import { RegistryCache } from '../../src/core/registry/cache.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'slopgate-registry-'));
});

function fetchReturning(status: number): typeof fetch {
  return vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch;
}

describe('createNpmClient', () => {
  it('reports existing packages (HTTP 200)', async () => {
    const client = createNpmClient('https://registry.npmjs.org', fetchReturning(200));
    await expect(client.check('commander')).resolves.toEqual({ exists: true });
  });

  it('reports missing packages (HTTP 404)', async () => {
    const client = createNpmClient('https://registry.npmjs.org', fetchReturning(404));
    await expect(client.check('reqeusts')).resolves.toEqual({ exists: false });
  });

  it('url-encodes scoped names', async () => {
    const fetchFn = fetchReturning(200);
    const client = createNpmClient('https://registry.npmjs.org', fetchFn);
    await client.check('@scope/pkg');
    expect(fetchFn).toHaveBeenCalledWith(
      'https://registry.npmjs.org/@scope%2Fpkg',
      expect.anything(),
    );
  });

  it('propagates unexpected registry errors', async () => {
    const client = createNpmClient('https://registry.npmjs.org', fetchReturning(500));
    await expect(client.check('whatever')).rejects.toThrow();
  });
});

describe('createPypiClient', () => {
  it('normalizes names per PEP 503 before checking', async () => {
    const fetchFn = fetchReturning(200);
    const client = createPypiClient('https://pypi.org/pypi', fetchFn);
    await client.check('Flask_SQLAlchemy');
    expect(fetchFn).toHaveBeenCalledWith(
      'https://pypi.org/pypi/flask-sqlalchemy/json',
      expect.anything(),
    );
  });

  it('reports missing packages (HTTP 404)', async () => {
    const client = createPypiClient('https://pypi.org/pypi', fetchReturning(404));
    await expect(client.check('reqeusts')).resolves.toEqual({ exists: false });
  });
});

describe('RegistryCache', () => {
  it('stores and retrieves entries', () => {
    const cache = new RegistryCache(join(dir, 'cache.db'));
    cache.set('npm', 'commander', true);
    expect(cache.get('npm', 'commander')).toEqual({ exists: true });
  });

  it('returns null for unknown entries', () => {
    const cache = new RegistryCache(join(dir, 'cache.db'));
    expect(cache.get('npm', 'never-checked')).toBeNull();
  });

  it('expires negative entries after the short TTL but keeps positive ones', () => {
    const now = 1_000_000_000_000;
    const cache = new RegistryCache(join(dir, 'cache.db'), {
      positiveTtlMs: 24 * 60 * 60 * 1000,
      negativeTtlMs: 60 * 60 * 1000,
      now: () => now,
    });
    cache.set('npm', 'ghost', false);
    cache.set('npm', 'real', true);

    const later = now + 2 * 60 * 60 * 1000; // 2 hours later
    const aged = new RegistryCache(join(dir, 'cache.db'), {
      positiveTtlMs: 24 * 60 * 60 * 1000,
      negativeTtlMs: 60 * 60 * 1000,
      now: () => later,
    });

    expect(aged.get('npm', 'ghost')).toBeNull(); // negative entry expired
    expect(aged.get('npm', 'real')).toEqual({ exists: true }); // positive entry kept
  });

  it('persists across instances (same db file)', () => {
    const dbPath = join(dir, 'cache.db');
    new RegistryCache(dbPath).set('pypi', 'flask', true);
    expect(new RegistryCache(dbPath).get('pypi', 'flask')).toEqual({ exists: true });
  });
});
