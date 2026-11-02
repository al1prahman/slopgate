#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { SLOPGATE_VERSION } from './version.js';

export function createProgram(): Command {
  const program = new Command();

  program
    .name('slopgate')
    .description(
      'Git-native security gate that blocks AI coding agents from shipping hallucinated dependencies and leaked secrets',
    )
    .version(SLOPGATE_VERSION);

  program
    .command('init')
    .description('Install git hooks and scaffold .slopgate.yml')
    .option('--uninstall', 'Remove the slopgate block from installed hooks')
    .action(async (options: Record<string, unknown>) => {
      const { initCommand } = await import('./commands/init.js');
      initCommand({
        ...(typeof options.uninstall === 'boolean' ? { uninstall: options.uninstall } : {}),
      });
    });

  program
    .command('cache')
    .description('Inspect or clear the local registry verdict cache')
    .argument('[action]', 'stats | clear', 'stats')
    .action(async (action: string) => {
      const { cacheCommand } = await import('./commands/cache.js');
      if (action !== 'stats' && action !== 'clear') {
        process.stderr.write(
          `slopgate: unknown cache action "${action}" — expected "stats" or "clear"\n`,
        );
        process.exitCode = 1;
        return;
      }
      cacheCommand(action);
    });

  program
    .command('scan')
    .description('Scan a diff for secrets and hallucinated dependencies')
    .option('--staged', 'Scan staged changes (what pre-commit runs)')
    .option('--range <range>', 'Scan a git range, e.g. origin/main..HEAD')
    .option('--format <format>', 'Output format: pretty | json', 'pretty')
    .option('--quiet', 'Print only the verdict line')
    .option('--offline', 'Use the local cache only; skip registry lookups')
    .action(async (options: Record<string, unknown>) => {
      const { scanCommand } = await import('./commands/scan.js');
      process.exitCode = await scanCommand({
        ...(typeof options.staged === 'boolean' ? { staged: options.staged } : {}),
        ...(typeof options.range === 'string' ? { range: options.range } : {}),
        ...(typeof options.format === 'string' ? { format: options.format } : {}),
        ...(typeof options.quiet === 'boolean' ? { quiet: options.quiet } : {}),
        ...(typeof options.offline === 'boolean' ? { offline: options.offline } : {}),
      });
    });

  return program;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

export function run(argv: string[]): void {
  filterSqliteWarning();
  createProgram().parse(argv);
}

// node:sqlite emits an ExperimentalWarning on first import (still labeled
// experimental on Node 22; the message reads "SQLite is an experimental
// feature..." and never contains the literal module specifier). A hook that
// runs on every commit must not spam stderr, so swallow exactly that warning
// and let every other warning through untouched.
export function filterSqliteWarning(): void {
  const passthrough = process.listeners('warning');
  process.removeAllListeners('warning');
  process.on('warning', (warning) => {
    if (warning.name === 'ExperimentalWarning' && /sqlite/i.test(warning.message)) {
      return;
    }
    for (const listener of passthrough) {
      (listener as (warning: Error) => void)(warning);
    }
  });
}

if (isMainModule()) {
  run(process.argv);
}
