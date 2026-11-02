import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config.js';
import { runScan } from '../../src/core/gate.js';
import { getStagedDiff } from '../../src/core/git.js';
import { RegistryCache } from '../../src/core/registry/cache.js';

const FILE_COUNT = 500;
const DEPS_PER_FILE = 3;

describe('perf: warm scan of a 500-file diff', () => {
  it('stays under the warm-path budget with every verdict cached', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'slopgate-perf-'));
    const git = (...args: string[]): void => {
      spawnSync('git', args, { cwd: repo, stdio: 'ignore' });
    };
    git('init', '-b', 'main');

    const names: string[] = [];
    for (let i = 0; i < FILE_COUNT; i += 1) {
      const dir = join(repo, `pkg${String(i).padStart(3, '0')}`);
      mkdirSync(dir, { recursive: true });
      const lines: string[] = [];
      for (let d = 0; d < DEPS_PER_FILE; d += 1) {
        const name = `dep-${i}-${d}`;
        names.push(name);
        lines.push(`${name}==1.0.0`);
      }
      lines.push('# a comment line to give the parser context');
      writeFileSync(join(dir, 'requirements.txt'), `${lines.join('\n')}\n`);
    }
    git('add', '-A');

    const cache = new RegistryCache(join(repo, '.slopgate', 'cache.db'));
    for (const name of names) {
      cache.set('pypi', name, true);
    }
    cache.close();

    // The git spawn is process-startup cost (~250ms on Windows), not scan
    // work; capture it once, report it, and keep it out of the budget.
    const diffText = getStagedDiff(repo);
    const spawnStart = performance.now();
    getStagedDiff(repo);
    const spawnMs = performance.now() - spawnStart;

    const options = { repoRoot: repo, staged: true, config: loadConfig(repo), diffText };
    await runScan(options); // warm-up: OS caches, sqlite pages, lazy module init

    // Median of 3 runs: one scheduler hiccup must not fail the gate, but a
    // real regression still moves the median.
    const runs: number[] = [];
    let result: Awaited<ReturnType<typeof runScan>> | undefined;
    for (let i = 0; i < 3; i += 1) {
      const started = performance.now();
      result = await runScan(options);
      runs.push(performance.now() - started);
    }
    runs.sort((a, b) => a - b);
    const elapsed = runs[1] ?? 0;

    console.log(
      `warm scan: ${FILE_COUNT} files, +${result?.linesAdded ?? 0} lines, ` +
        `${result?.cacheHits ?? 0} cache hits, runs=[${runs.map((r) => r.toFixed(1)).join(', ')}]ms, ` +
        `median ${elapsed.toFixed(1)}ms (git diff spawn: ${spawnMs.toFixed(1)}ms, excluded)`,
    );

    expect(result?.cacheHits).toBe(names.length);
    expect(elapsed).toBeLessThan(100);
  }, 60_000);
});
