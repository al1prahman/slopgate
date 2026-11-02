import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '../core/git.js';
import { RegistryCache } from '../core/registry/cache.js';

export type CacheAction = 'stats' | 'clear';

export interface CacheCommandOptions {
  cwd?: string;
}

function cacheDbPath(repoRoot: string): string {
  return join(repoRoot, '.slopgate', 'cache.db');
}

export function cacheCommand(action: CacheAction = 'stats', options: CacheCommandOptions = {}): void {
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = findRepoRoot(cwd);
  const dbPath = cacheDbPath(repoRoot);

  if (action === 'clear') {
    if (!existsSync(dbPath)) {
      process.stdout.write('slopgate: no cache to clear\n');
      return;
    }
    const cache = new RegistryCache(dbPath);
    const { total } = cache.stats();
    cache.close();
    rmSync(dbPath, { force: true });
    process.stdout.write(
      `slopgate: cache cleared (${total} ${total === 1 ? 'entry' : 'entries'} removed)\n`,
    );
    return;
  }

  if (!existsSync(dbPath)) {
    process.stdout.write(`slopgate: no cache yet (${dbPath})\n`);
    return;
  }
  const cache = new RegistryCache(dbPath);
  const stats = cache.stats();
  cache.close();
  const sizeKb = (statSync(dbPath).size / 1024).toFixed(1);
  process.stdout.write(
    `slopgate: cache at ${dbPath}\n` +
      `  entries: ${stats.total} (${stats.existing} found, ${stats.missing} not found, ${stats.stale} stale)\n` +
      `  size: ${sizeKb} KB\n`,
  );
}
