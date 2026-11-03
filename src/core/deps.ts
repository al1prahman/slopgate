import type { ChangedFile } from './types.js';

export interface DepCandidate {
  name: string;
  ecosystem: 'npm' | 'pypi';
  file: string;
  line: number;
  /** 'import' when the candidate came from an import statement, not a manifest. */
  source?: 'manifest' | 'import';
  /** The import specifier as written, when it differs from `name`. */
  importName?: string;
  /**
   * Python import with no alias-table entry: the identity mapping is a
   * guess, so a not-found verdict is a warn (policy-driven), not a block.
   */
  unmapped?: boolean;
}

export interface FileReader {
  read(path: string): string | null;
  readAtRef(path: string, ref: string): string | null;
}

const DEP_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

export function parseRequirement(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) {
    return null;
  }
  const withoutComment = trimmed.split(' #')[0]!.trim();
  const withoutMarker = withoutComment.split(';')[0]!.trim();
  const urlMatch = /^([A-Za-z0-9._-]+)\s*@\s*\S+/.exec(withoutMarker);
  if (urlMatch) {
    return urlMatch[1]!;
  }
  const nameMatch = /^([A-Za-z0-9._-]+)/.exec(withoutMarker);
  return nameMatch ? nameMatch[1]! : null;
}

function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

function extractManifestDeps(content: string | null): Map<string, string> {
  const deps = new Map<string, string>();
  if (!content) {
    return deps;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return deps;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return deps;
  }
  for (const section of DEP_SECTIONS) {
    const value = (parsed as Record<string, unknown>)[section];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [name, version] of Object.entries(value as Record<string, unknown>)) {
        const spec = typeof version === 'string' ? version : '';
        // file: and workspace: refs point at local paths, never the public
        // registry — checking them would produce false "not found" blocks.
        if (spec.startsWith('file:') || spec.startsWith('workspace:')) {
          continue;
        }
        deps.set(name, spec);
      }
    }
  }
  return deps;
}

// Keys that appear in a `[tool.poetry.dependencies]` table but name no
// package — `python = "^3.13"` constrains the interpreter, `version` and
// friends belong to `[project]`.
const NON_DEP_KEYS = new Set([
  'python',
  'version',
  'name',
  'description',
  'authors',
  'readme',
  'requires-python',
  'license',
  'keywords',
  'classifiers',
  'dependencies',
  'optional-dependencies',
  'dev-dependencies',
  'source',
  'url',
  'build-backend',
  'requires',
]);

// Every quoted PEP 508 spec in a fragment: ["ruff>=0.8.0", "mypy>=1.13.0"]
// yields both names. A version string ("0.1.0") has no letter and prose
// ("CurioAI - Enterprise") has a space after the name - neither is a package.
function specsIn(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(/["']([^"']+)["']/g)) {
    const raw = match[1];
    if (raw === undefined) {
      continue;
    }
    const spec = raw.trim();
    const name = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec);
    const found = name ? name[1] : undefined;
    if (found === undefined || !/[A-Za-z]/.test(found)) {
      continue;
    }
    // After the name (and any extras bracket) must come a version operator,
    // an environment marker, or the end of the spec - otherwise this is prose
    // or a URL that merely happens to be quoted.
    const rest = spec.slice(found.length).replace(/^\[[^\]]*\]/, '');
    if (rest !== '' && !/^\s*(?:[<>=!~;]|$)/.test(rest)) {
      continue;
    }
    names.push(found);
  }
  return names;
}

// pyproject.toml is also the home of every Python tool's config — ruff
// ignore codes (`"SIM"`), mypy per-file overrides (`"B008"`), pytest
// `testpaths = ["tests"]`. Dogfooding a real repo produced exactly those
// three false positives, so dependencies are collected by walking the file
// with its sections and only reading the ones that hold packages:
//
//   [project]                        dependencies = [...]
//   [project.optional-dependencies]  dev = [...]
//   [tool.poetry.dependencies]       fastapi = "^0.115.0"
//
// The returned map is name -> 1-based line number, so a caller can ask
// "was this line added?" without re-deriving the section.
function extractPyprojectDeps(content: string): Map<string, number> {
  const deps = new Map<string, number>();
  const lines = content.split(/\r?\n/);
  let section = '';
  let depth = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const lineNumber = index + 1;

    const header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header) {
      section = header[1] ?? '';
      depth = 0;
      continue;
    }

    if (depth > 0) {
      // Inside a dependencies array: every quoted spec is a package.
      for (const name of specsIn(line)) {
        if (!deps.has(name)) {
          deps.set(name, lineNumber);
        }
      }
      depth += countChar(line, '[') - countChar(line, ']');
      if (depth <= 0) {
        depth = 0;
      }
      continue;
    }

    const assign = /^\s*([A-Za-z0-9._-]+)\s*=\s*(.*)$/.exec(line);
    if (!assign) {
      continue;
    }
    const key = assign[1] ?? '';
    const value = assign[2] ?? '';
    if (!pyprojectSectionHoldsDeps(section, key) && !pyprojectSectionIsPoetryTable(section)) {
      continue;
    }

    if (value.trimStart().startsWith('[')) {
      for (const name of specsIn(value)) {
        if (!deps.has(name)) {
          deps.set(name, lineNumber);
        }
      }
      depth = countChar(value, '[') - countChar(value, ']');
      continue;
    }

    // Poetry scalar: `fastapi = "^0.115.0"`.
    if (pyprojectSectionIsPoetryTable(section) && !NON_DEP_KEYS.has(key.toLowerCase())) {
      deps.set(key, lineNumber);
    }
  }

  return deps;
}

function pyprojectSectionHoldsDeps(section: string, key: string): boolean {
  if (section === 'project') {
    return key === 'dependencies';
  }
  if (section === 'project.optional-dependencies') {
    return true;
  }
  return false;
}

function pyprojectSectionIsPoetryTable(section: string): boolean {
  return (
    /^tool\.poetry\.(?:dev-)?dependencies$/.test(section) ||
    /^tool\.poetry\.group\.[^.]+\.dependencies$/.test(section)
  );
}

function countChar(text: string, char: string): number {
  let count = 0;
  for (const c of text) {
    if (c === char) {
      count += 1;
    }
  }
  return count;
}

function findLineFor(
  addedLines: readonly { line: number; content: string }[],
  name: string,
): number {
  const hit = addedLines.find((added) => added.content.includes(`"${name}"`));
  return hit?.line ?? 1;
}

export function extractDepCandidates(
  files: readonly ChangedFile[],
  reader: FileReader,
): DepCandidate[] {
  const candidates: DepCandidate[] = [];

  for (const file of files) {
    if (file.isBinary || file.isDeleted) {
      continue;
    }

    if (basename(file.path) === 'requirements.txt') {
      for (const added of file.addedLines) {
        const name = parseRequirement(added.content);
        if (name) {
          candidates.push({
            name,
            ecosystem: 'pypi',
            file: file.path,
            line: added.line,
          });
        }
      }
      continue;
    }

    if (basename(file.path) === 'pyproject.toml') {
      // Two questions, two sources: the full-file walk says which names are
      // really packages (section-aware, so tool config is excluded), and the
      // diff says which lines are new. Matching by name rather than by line
      // number keeps this correct across commits - a dependency line moves
      // as earlier ones are inserted above it, but its name does not.
      const content = reader.read(file.path);
      if (content !== null) {
        const known = extractPyprojectDeps(content);
        for (const added of file.addedLines) {
          // Poetry table entry: the package is the key, not the quoted value.
          const table = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=\s*["'^{~*]/.exec(
            added.content,
          );
          const key = table ? table[1] : undefined;
          if (key !== undefined && known.has(key)) {
            candidates.push({
              name: key,
              ecosystem: 'pypi',
              file: file.path,
              line: added.line,
            });
            continue;
          }
          for (const name of specsIn(added.content)) {
            if (known.has(name)) {
              candidates.push({
                name,
                ecosystem: 'pypi',
                file: file.path,
                line: added.line,
              });
            }
          }
        }
      }
      continue;
    }

    if (basename(file.path) === 'package.json') {
      const current = extractManifestDeps(reader.read(file.path));
      const head = extractManifestDeps(reader.readAtRef(file.path, 'HEAD'));
      for (const [name, version] of current) {
        const previous = head.get(name);
        const isNew = head.size === 0 || previous === undefined || previous !== version;
        if (isNew) {
          candidates.push({
            name,
            ecosystem: 'npm',
            file: file.path,
            line: findLineFor(file.addedLines, name),
          });
        }
      }
    }
  }

  return candidates;
}
