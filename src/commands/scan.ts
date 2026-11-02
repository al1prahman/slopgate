import { loadConfig } from '../core/config.js';
import { runScan } from '../core/gate.js';
import { findRepoRoot } from '../core/git.js';
import { formatJson, formatPretty } from '../core/report.js';

export interface ScanCommandOptions {
  staged?: boolean;
  range?: string;
  format?: string;
  quiet?: boolean;
  offline?: boolean;
}

const offlineFetch: typeof fetch = (() => {
  return Promise.reject(new Error('offline mode: no registry lookups'));
}) as unknown as typeof fetch;

export async function scanCommand(
  options: ScanCommandOptions,
  cwd: string = process.cwd(),
): Promise<number> {
  const repoRoot = findRepoRoot(cwd);
  const config = loadConfig(repoRoot);

  const result = await runScan({
    repoRoot,
    staged: options.staged ?? !options.range,
    ...(options.range ? { range: options.range } : {}),
    config,
    ...(options.offline ? { fetchFn: offlineFetch } : {}),
  });

  const output =
    options.format === 'json'
      ? formatJson(result)
      : formatPretty(result, { quiet: options.quiet });
  process.stdout.write(`${output}\n`);

  if (result.verdict === 'block') {
    return 2;
  }
  if (result.verdict === 'warn') {
    return 1;
  }
  return 0;
}
