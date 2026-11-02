import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface RegistryCacheOptions {
  positiveTtlMs?: number;
  negativeTtlMs?: number;
  now?: () => number;
}

const DEFAULT_POSITIVE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_NEGATIVE_TTL_MS = 60 * 60 * 1000;

export class RegistryCache {
  private readonly db: DatabaseSync;
  private readonly positiveTtlMs: number;
  private readonly negativeTtlMs: number;
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
    this.positiveTtlMs = options.positiveTtlMs ?? DEFAULT_POSITIVE_TTL_MS;
    this.negativeTtlMs = options.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  get(ecosystem: string, name: string): { exists: boolean } | null {
    const row = this.db
      .prepare(
        'SELECT exists_flag, checked_at FROM registry_cache WHERE ecosystem = ? AND name = ?',
      )
      .get(ecosystem, name) as { exists_flag: number; checked_at: number } | undefined;
    if (!row) {
      return null;
    }
    const ttl = row.exists_flag === 1 ? this.positiveTtlMs : this.negativeTtlMs;
    if (this.now() - row.checked_at > ttl) {
      return null;
    }
    return { exists: row.exists_flag === 1 };
  }

  set(ecosystem: string, name: string, exists: boolean): void {
    this.db
      .prepare(
        `INSERT INTO registry_cache (ecosystem, name, exists_flag, checked_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (ecosystem, name)
         DO UPDATE SET exists_flag = excluded.exists_flag, checked_at = excluded.checked_at`,
      )
      .run(ecosystem, name, exists ? 1 : 0, this.now());
  }

  close(): void {
    this.db.close();
  }
}
