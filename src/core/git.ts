import { execFileSync } from 'node:child_process';

export function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // Keep git's stderr (CRLF warnings, "fatal: invalid object name" noise
    // from git show on repos without commits) out of the hook's output.
    // Failures still surface as thrown errors via the exit code.
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

// git config --get exits 1 when the key is unset; treat that as empty, not an error.
export function gitConfig(repoRoot: string, key: string): string {
  try {
    return git(['config', '--get', key], repoRoot).trim();
  } catch {
    return '';
  }
}

export function findRepoRoot(cwd: string): string {
  return git(['rev-parse', '--show-toplevel'], cwd).trim();
}

export function getStagedDiff(cwd: string): string {
  return git(['diff', '--cached', '-U0'], cwd);
}

export function getRangeDiff(cwd: string, range: string): string {
  return git(['diff', range, '-U0'], cwd);
}

export function readFileAtRef(cwd: string, ref: string, path: string): string | null {
  try {
    return git(['show', `${ref}:${path}`], cwd);
  } catch {
    return null;
  }
}
