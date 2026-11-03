import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CONFIG_FILE_NAME } from '../core/config.js';
import { gitConfig, git } from '../core/git.js';

const MARKER_START = '# >>> slopgate >>>';
const MARKER_END = '# <<< slopgate <<<';

const PRE_COMMIT_BODY = [
  // A local devDependency first: no npx, no registry round-trip. Measured
  // 0.2s versus 3-4s for `npx --yes`, which checks the registry on every
  // invocation even when the package is already installed locally.
  'if [ -f node_modules/.bin/slopgate ]; then',
  '  node_modules/.bin/slopgate scan --staged --quiet',
  '  exit $?',
  'fi',
  'if command -v slopgate >/dev/null 2>&1; then',
  '  slopgate scan --staged --quiet',
  '  exit $?',
  'fi',
  'if command -v npx >/dev/null 2>&1; then',
  // --yes + the scoped name: npx resolves a local devDep first, and falls
  // back to the registry (cached after the first run). --no-install with a
  // bare name fails outright when the package is not a local dependency,
  // which is exactly the state `npx slopgate init` leaves behind.
  '  npx --yes @al1prahman/slopgate scan --staged --quiet',
  '  exit $?',
  'fi',
  'echo "slopgate: hook present but slopgate is not installed; skipping" >&2',
  'exit 0',
].join('\n');

const PRE_PUSH_BODY = [
  // Local devDependency first — see the pre-commit hook for the numbers.
  'if [ -f node_modules/.bin/slopgate ]; then',
  '  node_modules/.bin/slopgate scan --range "@{push}...HEAD" --quiet',
  '  exit $?',
  'fi',
  'if command -v slopgate >/dev/null 2>&1; then',
  '  slopgate scan --range "@{push}...HEAD" --quiet',
  '  exit $?',
  'fi',
  'if command -v npx >/dev/null 2>&1; then',
  // Same reasoning as the pre-commit hook: the scoped name with --yes, so a
  // local devDep wins and the registry is the fallback.
  '  npx --yes @al1prahman/slopgate scan --range "@{push}...HEAD" --quiet',
  '  exit $?',
  'fi',
  'echo "slopgate: hook present but slopgate is not installed; skipping" >&2',
  'exit 0',
].join('\n');

const HOOKS: Record<string, string> = {
  'pre-commit': PRE_COMMIT_BODY,
  'pre-push': PRE_PUSH_BODY,
};

const DEFAULT_CONFIG = `# slopgate configuration — see https://github.com/al1prahman/slopgate
mode: block                # block | warn | off

secrets:
  enabled: true
  ignore: []               # glob patterns, e.g. '**/*.test.ts'

deps:
  enabled: true
  ecosystems: [npm, pypi]
  registries:
    npm: https://registry.npmjs.org
    pypi: https://pypi.org/pypi
  custom-index: []         # internal registries checked first
  allowlist: []            # trusted internal package names
  quarantine: false        # hold installs instead of blocking (v2)
  typosquat:
    enabled: true          # warn on young look-alikes of popular packages
    max-distance: 2        # edits from a popular name (0-5)
    max-age-days: 90       # packages younger than this look seeded
  cache:
    positive-ttl-hours: 24    # how long an "exists" verdict is trusted
    negative-ttl-minutes: 60  # how long a "missing" verdict is re-checked

python:
  unmapped-imports: warn   # import names with no known package mapping

imports:
  enabled: true            # scan import statements, not just manifests

agent:
  enabled: true            # flag agent-authored commits (Co-Authored-By, "Generated with")
`;

export interface InitOptions {
  cwd?: string;
  uninstall?: boolean;
}

function managedBlock(body: string): string {
  return `${MARKER_START}\n${body}\n${MARKER_END}\n`;
}

function stripManagedBlock(content: string): string {
  const pattern = new RegExp(
    `\\n?${MARKER_START}[\\s\\S]*?${MARKER_END}\\n?`,
    'g',
  );
  return content.replace(pattern, '\n').replace(/\n{3,}/g, '\n\n');
}

function resolveHooksDir(repoRoot: string): string {
  const configured = gitConfig(repoRoot, 'core.hooksPath');
  if (configured) {
    return resolve(repoRoot, configured);
  }
  const gitDir = git(['rev-parse', '--git-dir'], repoRoot).trim();
  return resolve(repoRoot, gitDir, 'hooks');
}

function installHook(hooksDir: string, name: string, body: string): 'created' | 'updated' | 'appended' {
  const hookFile = join(hooksDir, name);
  const block = managedBlock(body);

  if (!existsSync(hookFile)) {
    writeFileSync(hookFile, `#!/bin/sh\n${block}`);
    chmodSync(hookFile, 0o755);
    return 'created';
  }

  const existing = readFileSync(hookFile, 'utf8');
  if (existing.includes(MARKER_START)) {
    const stripped = stripManagedBlock(existing);
    writeFileSync(hookFile, `${stripped.replace(/\n$/, '')}\n${block}`);
    return 'updated';
  }

  const separator = existing.endsWith('\n') ? '' : '\n';
  writeFileSync(hookFile, `${existing}${separator}\n${block}`);
  chmodSync(hookFile, 0o755);
  return 'appended';
}

// Appends `.slopgate/` to .gitignore when missing. Returns the action
// label, or null when the entry is already there (idempotent re-runs).
function ensureGitignoreEntry(repoRoot: string, entry: string): string | null {
  const path = join(repoRoot, '.gitignore');
  if (existsSync(path)) {
    const content = readFileSync(path, 'utf8');
    const present = content
      .split('\n')
      .some((line) => line.trim() === entry);
    if (present) {
      return null;
    }
    const separator = content.endsWith('\n') || content === '' ? '' : '\n';
    writeFileSync(path, `${content}${separator}${entry}\n`);
    return 'added .slopgate/ to .gitignore';
  }
  writeFileSync(path, `${entry}\n`);
  return 'created .gitignore with .slopgate/';
}

function uninstallHook(hooksDir: string, name: string): boolean {
  const hookFile = join(hooksDir, name);
  if (!existsSync(hookFile)) {
    return false;
  }
  const existing = readFileSync(hookFile, 'utf8');
  if (!existing.includes(MARKER_START)) {
    return false;
  }
  writeFileSync(hookFile, stripManagedBlock(existing));
  return true;
}

export function initCommand(options: InitOptions = {}): void {
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = git(['rev-parse', '--show-toplevel'], cwd).trim();
  const hooksDir = resolveHooksDir(repoRoot);

  const actions: string[] = [];

  for (const [name, body] of Object.entries(HOOKS)) {
    if (options.uninstall) {
      if (uninstallHook(hooksDir, name)) {
        actions.push(`removed slopgate block from ${name}`);
      }
      continue;
    }
    const outcome = installHook(hooksDir, name, body);
    actions.push(`${outcome} ${name} hook`);
  }

  if (!options.uninstall) {
    const configPath = join(repoRoot, CONFIG_FILE_NAME);
    if (!existsSync(configPath)) {
      writeFileSync(configPath, DEFAULT_CONFIG);
      actions.push(`created ${CONFIG_FILE_NAME}`);
    }
    // The verdict cache is machine-local; without this it shows up as
    // untracked noise in every consumer repo the day after init.
    const ignore = ensureGitignoreEntry(repoRoot, '.slopgate/');
    if (ignore) {
      actions.push(ignore);
    }
  }

  if (actions.length === 0) {
    process.stdout.write('slopgate: nothing to do.\n');
    return;
  }
  process.stdout.write(`slopgate: ${actions.join(', ')}\n`);
}
