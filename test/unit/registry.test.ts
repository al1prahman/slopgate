import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createNpmClient, createPypiClient } from '../../src/core/registry/index.js';
import { RegistryCache, cacheKey } from '../../src/core/registry/cache.js';

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

  it('stats() counts total, existing, missing, and stale entries', () => {
    const now = 1_000_000_000_000;
    const ttl = { positiveTtlMs: 24 * 60 * 60 * 1000, negativeTtlMs: 60 * 60 * 1000 };
    const fresh = new RegistryCache(join(dir, 'cache.db'), { ...ttl, now: () => now });
    fresh.set('npm', 'commander', true);
    fresh.set('npm', 'ghost', false);

    const later = new RegistryCache(join(dir, 'cache.db'), {
      ...ttl,
      now: () => now + 2 * 60 * 60 * 1000,
    });
    expect(later.stats()).toEqual({ total: 2, existing: 1, missing: 1, stale: 1 });
  });

  it('getMany returns verdicts for a batch of names', () => {
    const cache = new RegistryCache(join(dir, 'cache.db'));
    cache.set('npm', 'commander', true);
    cache.set('pypi', 'flask', true);
    cache.set('pypi', 'reqeusts', false);

    const result = cache.getMany([
      { ecosystem: 'npm', name: 'commander' },
      { ecosystem: 'pypi', name: 'flask' },
      { ecosystem: 'pypi', name: 'reqeusts' },
      { ecosystem: 'npm', name: 'never-checked' },
    ]);

    expect(result.size).toBe(3);
    expect(result.get(cacheKey('npm', 'commander'))).toEqual({ exists: true });
    expect(result.get(cacheKey('pypi', 'reqeusts'))).toEqual({ exists: false });
    expect(result.has(cacheKey('npm', 'never-checked'))).toBe(false);
  });

  it('getMany skips entries past their TTL', () => {
    const now = 1_000_000_000_000;
    const ttl = { positiveTtlMs: 24 * 60 * 60 * 1000, negativeTtlMs: 60 * 60 * 1000 };
    const fresh = new RegistryCache(join(dir, 'cache.db'), { ...ttl, now: () => now });
    fresh.set('npm', 'real', true);
    fresh.set('npm', 'ghost', false);

    const later = new RegistryCache(join(dir, 'cache.db'), {
      ...ttl,
      now: () => now + 2 * 60 * 60 * 1000,
    });
    const result = later.getMany([
      { ecosystem: 'npm', name: 'real' },
      { ecosystem: 'npm', name: 'ghost' },
    ]);

    expect(result.get(cacheKey('npm', 'real'))).toEqual({ exists: true });
    expect(result.has(cacheKey('npm', 'ghost'))).toBe(false);
  });

  it('getMany dedupes repeated names', () => {
    const cache = new RegistryCache(join(dir, 'cache.db'));
    cache.set('npm', 'commander', true);
    const result = cache.getMany([
      { ecosystem: 'npm', name: 'commander' },
      { ecosystem: 'npm', name: 'commander' },
    ]);
    expect(result.size).toBe(1);
  });

  it('getMany chunks large batches (chunk size injectable for tests)', () => {
    const cache = new RegistryCache(join(dir, 'cache.db'), { batchChunkSize: 2 });
    cache.set('pypi', 'a', true);
    cache.set('pypi', 'b', true);
    cache.set('pypi', 'c', false);

    const result = cache.getMany([
      { ecosystem: 'pypi', name: 'a' },
      { ecosystem: 'pypi', name: 'b' },
      { ecosystem: 'pypi', name: 'c' },
      { ecosystem: 'pypi', name: 'd' },
    ]);

    expect(result.size).toBe(3);
    expect(result.get(cacheKey('pypi', 'c'))).toEqual({ exists: false });
    expect(result.has(cacheKey('pypi', 'd'))).toBe(false);
  });

  it('getMany returns an empty map for no entries', () => {
    const cache = new RegistryCache(join(dir, 'cache.db'));
    expect(cache.getMany([]).size).toBe(0);
  });
});
