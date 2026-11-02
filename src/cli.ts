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
    .action(() => {
      // Implemented in Phase 8 (hooks + init command)
      throw new Error('init is not implemented yet — coming in Phase 8');
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
  createProgram().parse(argv);
}

if (isMainModule()) {
  run(process.argv);
}
