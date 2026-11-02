import { execFileSync } from 'node:child_process';

export function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
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
