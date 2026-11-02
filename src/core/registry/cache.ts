import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

export interface RegistryCacheOptions {
  positiveTtlMs?: number;
  negativeTtlMs?: number;
  now?: () => number;
  batchChunkSize?: number;
}

export interface CacheStats {
  readonly total: number;
  readonly existing: number;
  readonly missing: number;
  readonly stale: number;
}

const DEFAULT_POSITIVE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_NEGATIVE_TTL_MS = 60 * 60 * 1000;
// Stay well under SQLITE_MAX_VARIABLE_NUMBER (32766): chunk entries, 2 params each.
const DEFAULT_BATCH_CHUNK = 4000;

export function cacheKey(ecosystem: string, name: string): string {
  return `${ecosystem}\u0000${name}`;
}

export class RegistryCache {
  private readonly db: DatabaseSync;
  private readonly getStmt: StatementSync;
  private readonly setStmt: StatementSync;
  private readonly statsStmt: StatementSync;
  private readonly positiveTtlMs: number;
  private readonly negativeTtlMs: number;
  private readonly batchChunkSize: number;
  private readonly now: () => number;

  constructor(dbPath: string, options: RegistryCacheOptions = {}) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`CREATE TABLE IF NOT EXISTS registry_cache (
      ecosystem TEXT NOT NULL,
      name TEXT NOT NULL,
      exists_flag INTEGER NOT NULL,
      checked_at INTEGER NOT NULL,
      PRIMARY KEY (ecosystem, name)
    )`);
    // Migration: caches written before the typosquat check lack created_at.
    // The DB is disposable (TTL-bounded), but ALTER is cheap and keeps old
    // files working instead of forcing a manual cache clear.
    const columns = this.db.prepare('PRAGMA table_info(registry_cache)').all() as {
      name: string;
    }[];
    if (!columns.some((column) => column.name === 'created_at')) {
      this.db.exec('ALTER TABLE registry_cache ADD COLUMN created_at TEXT');
    }
    // Statements are prepared once and reused: preparing per call costs
    // ~100us on node:sqlite, which dominates a warm 500-file scan.
    this.getStmt = this.db.prepare(
      'SELECT exists_flag, checked_at, created_at FROM registry_cache WHERE ecosystem = ? AND name = ?',
    );
    this.setStmt = this.db.prepare(
      `INSERT INTO registry_cache (ecosystem, name, exists_flag, checked_at, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (ecosystem, name)
       DO UPDATE SET exists_flag = excluded.exists_flag, checked_at = excluded.checked_at, created_at = excluded.created_at`,
    );
    this.statsStmt = this.db.prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(exists_flag), 0) AS existing,
              COALESCE(SUM(
                CASE WHEN ? - checked_at > CASE WHEN exists_flag = 1 THEN ? ELSE ? END
                THEN 1 ELSE 0 END
              ), 0) AS stale
       FROM registry_cache`,
    );
    this.positiveTtlMs = options.positiveTtlMs ?? DEFAULT_POSITIVE_TTL_MS;
    this.negativeTtlMs = options.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
    this.batchChunkSize = options.batchChunkSize ?? DEFAULT_BATCH_CHUNK;
    this.now = options.now ?? (() => Date.now());
  }

  get(ecosystem: string, name: string): { exists: boolean; createdAt: string | null } | null {
    const row = this.getStmt.get(ecosystem, name) as
      | { exists_flag: number; checked_at: number; created_at: string | null }
      | undefined;
    if (!row) {
      return null;
    }
    const ttl = row.exists_flag === 1 ? this.positiveTtlMs : this.negativeTtlMs;
    if (this.now() - row.checked_at > ttl) {
      return null;
    }
    return { exists: row.exists_flag === 1, createdAt: row.created_at ?? null };
  }

  set(ecosystem: string, name: string, exists: boolean, createdAt: string | null = null): void {
    this.setStmt.run(ecosystem, name, exists ? 1 : 0, this.now(), createdAt);
  }

  // node:sqlite costs ~100us per statement round-trip on current Node, so a
  // warm 1500-dep diff would spend ~170ms on individual gets. One batched
  // query per chunk brings the whole lookup down to a few milliseconds.
  // Expired entries are filtered here, same rule as get().
  getMany(
    entries: readonly { ecosystem: string; name: string }[],
  ): Map<string, { exists: boolean; createdAt: string | null }> {
    const result = new Map<string, { exists: boolean; createdAt: string | null }>();
    const unique = new Map<string, { ecosystem: string; name: string }>();
    for (const entry of entries) {
      const key = cacheKey(entry.ecosystem, entry.name);
      if (!unique.has(key)) {
        unique.set(key, entry);
      }
    }
    const items = [...unique.values()];
    const now = this.now();
    for (let i = 0; i < items.length; i += this.batchChunkSize) {
      const chunk = items.slice(i, i + this.batchChunkSize);
      const params: string[] = [];
      for (const item of chunk) {
        params.push(item.ecosystem, item.name);
      }
      const placeholders = chunk.map(() => '(?, ?)').join(', ');
      const rows = this.db
        .prepare(
          `SELECT ecosystem, name, exists_flag, checked_at, created_at FROM registry_cache
           WHERE (ecosystem, name) IN (VALUES ${placeholders})`,
        )
        .all(...params) as {
        ecosystem: string;
        name: string;
        exists_flag: number;
        checked_at: number;
        created_at: string | null;
      }[];
      for (const row of rows) {
        const ttl = row.exists_flag === 1 ? this.positiveTtlMs : this.negativeTtlMs;
        if (now - row.checked_at > ttl) {
          continue;
        }
        result.set(cacheKey(row.ecosystem, row.name), {
          exists: row.exists_flag === 1,
          createdAt: row.created_at ?? null,
        });
      }
    }
    return result;
  }

  stats(): CacheStats {
    const row = this.statsStmt.get(this.now(), this.positiveTtlMs, this.negativeTtlMs) as {
      total: number;
      existing: number;
      stale: number;
    };
    return {
      total: row.total,
      existing: row.existing,
      missing: row.total - row.existing,
      stale: row.stale,
    };
  }

  close(): void {
    this.db.close();
  }
}
