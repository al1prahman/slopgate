import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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
    await expect(client.check('commander')).resolves.toEqual({ exists: true, createdAt: null });
  });

  it('reports missing packages (HTTP 404)', async () => {
    const client = createNpmClient('https://registry.npmjs.org', fetchReturning(404));
    await expect(client.check('reqeusts')).resolves.toEqual({ exists: false, createdAt: null });
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

  it('returns the packument creation date when metadata is requested', async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ time: { created: '2026-10-01T00:00:00.000Z' } }), {
          status: 200,
        }),
    ) as unknown as typeof fetch;
    const client = createNpmClient('https://registry.npmjs.org', fetchFn);
    await expect(client.check('fresh-pkg', { metadata: true })).resolves.toEqual({
      exists: true,
      createdAt: '2026-10-01T00:00:00.000Z',
    });
  });

  it('does not parse the body when metadata is not requested', async () => {
    // invalid JSON on purpose: status-only checks must never touch the body
    const fetchFn = vi.fn(
      async () => new Response('not json', { status: 200 }),
    ) as unknown as typeof fetch;
    const client = createNpmClient('https://registry.npmjs.org', fetchFn);
    await expect(client.check('commander')).resolves.toEqual({ exists: true, createdAt: null });
  });

  it('returns null createdAt when the packument has no time.created', async () => {
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ name: 'x' }), { status: 200 }),
    ) as unknown as typeof fetch;
    const client = createNpmClient('https://registry.npmjs.org', fetchFn);
    const result = await client.check('x', { metadata: true });
    expect(result.exists).toBe(true);
    expect(result.createdAt).toBeNull();
  });

  it('404 with metadata requested still reports not found', async () => {
    const client = createNpmClient('https://registry.npmjs.org', fetchReturning(404));
    await expect(client.check('ghost', { metadata: true })).resolves.toEqual({
      exists: false,
      createdAt: null,
    });
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
    await expect(client.check('reqeusts')).resolves.toEqual({ exists: false, createdAt: null });
  });

  it('returns the earliest release upload as createdAt', async () => {
    const body = JSON.stringify({
      releases: {
        '1.0.0': [{ upload_time_iso_8601: '2026-09-15T00:00:00.000Z' }],
        '1.1.0': [{ upload_time_iso_8601: '2026-10-20T00:00:00.000Z' }],
      },
    });
    const fetchFn = vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    const client = createPypiClient('https://pypi.org/pypi', fetchFn);
    const result = await client.check('fresh-pkg', { metadata: true });
    expect(result.exists).toBe(true);
    expect(result.createdAt).toBe('2026-09-15T00:00:00.000Z');
  });

  // An unconsumed body holds its socket: undici cannot release the
  // connection back to the pool, so the process waits for the peer to close
  // it. Dogfooding a Python repo turned a 1s cold scan into a 31s command
  // this way — 19 of 20 checks were status-only.
  for (const [label, makeClient] of [
    ['npm', (fetchFn: typeof fetch) => createNpmClient('https://registry.npmjs.org', fetchFn)],
    ['pypi', (fetchFn: typeof fetch) => createPypiClient('https://pypi.org/pypi', fetchFn)],
  ] as const) {
    it(`drains the response body on a status-only ${label} check`, async () => {
      const cancel = vi.fn(async () => undefined);
      const body = new ReadableStream({ cancel });
      const fetchFn = vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
      await makeClient(fetchFn).check('some-package');
      expect(cancel).toHaveBeenCalled();
    });

    it(`drains the response body on a ${label} 404`, async () => {
      const cancel = vi.fn(async () => undefined);
      const body = new ReadableStream({ cancel });
      const fetchFn = vi.fn(async () => new Response(body, { status: 404 })) as unknown as typeof fetch;
      await makeClient(fetchFn).check('missing-package');
      expect(cancel).toHaveBeenCalled();
    });
  }
});

describe('RegistryCache', () => {
  it('stores and retrieves entries', () => {
    const cache = new RegistryCache(join(dir, 'cache.db'));
    cache.set('npm', 'commander', true);
    expect(cache.get('npm', 'commander')).toEqual({ exists: true, createdAt: null });
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
    expect(aged.get('npm', 'real')).toEqual({ exists: true, createdAt: null }); // positive entry kept
  });

  it('persists across instances (same db file)', () => {
    const dbPath = join(dir, 'cache.db');
    new RegistryCache(dbPath).set('pypi', 'flask', true);
    expect(new RegistryCache(dbPath).get('pypi', 'flask')).toEqual({ exists: true, createdAt: null });
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
    expect(result.get(cacheKey('npm', 'commander'))).toEqual({ exists: true, createdAt: null });
    expect(result.get(cacheKey('pypi', 'reqeusts'))).toEqual({ exists: false, createdAt: null });
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

    expect(result.get(cacheKey('npm', 'real'))).toEqual({ exists: true, createdAt: null });
    expect(result.has(cacheKey('npm', 'ghost'))).toBe(false);
  });

  it('setMany writes every entry in one batch', () => {
    const cache = new RegistryCache(join(dir, 'cache.db'));
    cache.setMany([
      { ecosystem: 'npm', name: 'commander', exists: true, createdAt: '2024-01-01T00:00:00.000Z' },
      { ecosystem: 'pypi', name: 'flask', exists: true },
      { ecosystem: 'pypi', name: 'reqeusts', exists: false },
    ]);

    expect(cache.get('npm', 'commander')).toEqual({
      exists: true,
      createdAt: '2024-01-01T00:00:00.000Z',
    });
    expect(cache.get('pypi', 'flask')).toEqual({ exists: true, createdAt: null });
    expect(cache.get('pypi', 'reqeusts')).toEqual({ exists: false, createdAt: null });
  });

  it('setMany is a no-op for an empty batch', () => {
    const cache = new RegistryCache(join(dir, 'cache.db'));
    cache.setMany([]);
    expect(cache.stats()).toEqual({ total: 0, existing: 0, missing: 0, stale: 0 });
  });

  it('setMany upserts over an existing entry', () => {
    const cache = new RegistryCache(join(dir, 'cache.db'));
    cache.set('npm', 'ghost-pkg', false);
    cache.setMany([{ ecosystem: 'npm', name: 'ghost-pkg', exists: true }]);

    expect(cache.get('npm', 'ghost-pkg')).toEqual({ exists: true, createdAt: null });
    expect(cache.stats().total).toBe(1);
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
    expect(result.get(cacheKey('pypi', 'c'))).toEqual({ exists: false, createdAt: null });
    expect(result.has(cacheKey('pypi', 'd'))).toBe(false);
  });

  it('getMany returns an empty map for no entries', () => {
    const cache = new RegistryCache(join(dir, 'cache.db'));
    expect(cache.getMany([]).size).toBe(0);
  });

  it('stores and returns createdAt alongside the verdict', () => {
    const cache = new RegistryCache(join(dir, 'cache.db'));
    cache.set('npm', 'fresh', true, '2026-10-01T00:00:00.000Z');
    expect(cache.get('npm', 'fresh')).toEqual({
      exists: true,
      createdAt: '2026-10-01T00:00:00.000Z',
    });
  });

  it('defaults createdAt to null when not provided', () => {
    const cache = new RegistryCache(join(dir, 'cache.db'));
    cache.set('npm', 'legacy-call', true);
    expect(cache.get('npm', 'legacy-call')).toEqual({ exists: true, createdAt: null });
  });

  it('migrates a pre-typosquat database by adding the created_at column', () => {
    const dbPath = join(dir, 'old.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE registry_cache (
      ecosystem TEXT NOT NULL,
      name TEXT NOT NULL,
      exists_flag INTEGER NOT NULL,
      checked_at INTEGER NOT NULL,
      PRIMARY KEY (ecosystem, name)
    )`);
    db.prepare(
      'INSERT INTO registry_cache (ecosystem, name, exists_flag, checked_at) VALUES (?, ?, ?, ?)',
    ).run('npm', 'legacy', 1, Date.now());
    db.close();

    const cache = new RegistryCache(dbPath);
    expect(cache.get('npm', 'legacy')).toEqual({ exists: true, createdAt: null });
    cache.set('npm', 'fresh', true, '2026-10-01T00:00:00.000Z');
    expect(cache.get('npm', 'fresh')).toEqual({
      exists: true,
      createdAt: '2026-10-01T00:00:00.000Z',
    });
  });

  it('getMany carries createdAt through', () => {
    const cache = new RegistryCache(join(dir, 'cache.db'));
    cache.set('npm', 'commander', true, '2026-10-01T00:00:00.000Z');
    cache.set('pypi', 'reqeusts', false);
    const result = cache.getMany([
      { ecosystem: 'npm', name: 'commander' },
      { ecosystem: 'pypi', name: 'reqeusts' },
    ]);
    expect(result.get(cacheKey('npm', 'commander'))).toEqual({
      exists: true,
      createdAt: '2026-10-01T00:00:00.000Z',
    });
    expect(result.get(cacheKey('pypi', 'reqeusts'))).toEqual({ exists: false, createdAt: null });
  });
});
