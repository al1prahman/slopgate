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

// Raw bytes for blob reads. `git()` decodes as utf8, which would corrupt
// UTF-16 content before it could be inspected.
export function gitBuffer(args: readonly string[], cwd: string): Buffer {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

// The blob at <ref>:<path>. ref is a revision (HEAD) or an index stage
// (`:0` for the staged version). Returns null when it does not exist.
export function readBlob(cwd: string, ref: string, path: string): Buffer | null {
  try {
    return gitBuffer(['show', `${ref}:${path}`], cwd);
  } catch {
    return null;
  }
}

export function getRangeDiff(cwd: string, range: string): string {
  return git(['diff', range, '-U0'], cwd);
}

// Commit messages for a range scan (the agent-commit heuristic's input).
// NUL-separated so bodies containing blank lines survive the split. An
// invalid range or a repo without commits yields no messages — fail-open,
// same contract as readFileAtRef.
export function getCommitMessages(cwd: string, range: string): string[] {
  try {
    const out = git(['log', '--format=%B%x00', range], cwd);
    return out
      .split('\0')
      .map((message) => message.trim())
      .filter((message) => message !== '');
  } catch {
    return [];
  }
}

export function readFileAtRef(cwd: string, ref: string, path: string): string | null {
  try {
    return git(['show', `${ref}:${path}`], cwd);
  } catch {
    return null;
  }
}
