import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import type { DepCandidate } from './deps.js';
import type { ChangedFile } from './types.js';

/**
 * A dependency candidate extracted from an import statement rather than a
 * manifest. `name` is the package to check on the registry; `importName` is
 * the specifier as written (they differ for aliased Python imports).
 */
export interface ImportCandidate extends DepCandidate {
  source: 'import';
  importName: string;
  /**
   * Python import with no alias-table entry: the identity mapping is a
   * guess, so a not-found verdict is a warn (policy-driven), not a block.
   */
  unmapped?: boolean;
}

const JS_EXTENSIONS = new Set([
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
]);
const PY_EXTENSIONS = new Set(['.py', '.pyi']);

let stdlibModules: ReadonlySet<string> | null = null;
let importAliases: ReadonlyMap<string, string> | null = null;

function loadStdlib(): ReadonlySet<string> {
  stdlibModules ??= new Set(
    readFileSync(new URL('../../data/python-stdlib.txt', import.meta.url), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#')),
  );
  return stdlibModules;
}

function loadAliases(): ReadonlyMap<string, string> {
  importAliases ??= new Map(
    Object.entries(
      JSON.parse(
        readFileSync(new URL('../../data/python-import-aliases.json', import.meta.url), 'utf8'),
      ) as Record<string, string>,
    ),
  );
  return importAliases;
}

// Each pattern captures the module specifier of one import form. A single
// line matches at most one form in practice, so overlap is harmless.
const JS_IMPORT_PATTERNS: readonly RegExp[] = [
  /\bimport\s+[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bexport\s+[^;'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const NON_PACKAGE_PREFIXES = ['./', '../', '/', 'node:', 'http:', 'https:', 'data:'];

function jsSpecifiers(line: string): string[] {
  const specs: string[] = [];
  for (const pattern of JS_IMPORT_PATTERNS) {
    for (const match of line.matchAll(pattern)) {
      specs.push(match[1]!);
    }
  }
  return specs;
}

function jsPackageName(specifier: string): string | null {
  if (NON_PACKAGE_PREFIXES.some((prefix) => specifier.startsWith(prefix))) {
    return null;
  }
  if (specifier.startsWith('@')) {
    const segments = specifier.split('/');
    return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : null;
  }
  return specifier.split('/')[0]!;
}

// import a, b.c as d, e
const PY_IMPORT_RE = /^\s*import\s+(.+?)\s*$/;
// from a.b import c   |   from . import c   |   from .mod import c
const PY_FROM_RE = /^\s*from\s+([\w.]+)\s+import\s+/;

function pythonModules(line: string): string[] {
  const modules: string[] = [];
  const fromMatch = PY_FROM_RE.exec(line);
  if (fromMatch) {
    const dotted = fromMatch[1]!;
    // Relative imports address local modules, never the registry.
    if (!dotted.startsWith('.')) {
      modules.push(dotted.split('.')[0]!);
    }
    return modules;
  }
  const importMatch = PY_IMPORT_RE.exec(line);
  if (importMatch) {
    for (const part of importMatch[1]!.split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0]!.trim();
      if (name) {
        modules.push(name.split('.')[0]!);
      }
    }
  }
  return modules;
}

function toCandidate(
  moduleName: string,
  ecosystem: 'npm' | 'pypi',
  file: string,
  line: number,
): ImportCandidate | null {
  if (ecosystem === 'npm') {
    return { name: moduleName, ecosystem, file, line, source: 'import', importName: moduleName };
  }
  if (loadStdlib().has(moduleName)) {
    return null;
  }
  const distribution = loadAliases().get(moduleName);
  if (distribution) {
    return {
      name: distribution,
      ecosystem,
      file,
      line,
      source: 'import',
      importName: moduleName,
    };
  }
  return {
    name: moduleName,
    ecosystem,
    file,
    line,
    source: 'import',
    importName: moduleName,
    unmapped: true,
  };
}

/**
 * Extracts registry candidates from import statements on added lines. Only
 * added lines are inspected — the same diff-scoping the secret scanner uses.
 */
export function extractImportCandidates(
  files: readonly ChangedFile[],
): ImportCandidate[] {
  const candidates: ImportCandidate[] = [];

  for (const file of files) {
    if (file.isBinary || file.isDeleted) {
      continue;
    }
    const extension = extname(file.path).toLowerCase();
    const ecosystem = JS_EXTENSIONS.has(extension)
      ? ('npm' as const)
      : PY_EXTENSIONS.has(extension)
        ? ('pypi' as const)
        : null;
    if (!ecosystem) {
      continue;
    }

    for (const added of file.addedLines) {
      const specs =
        ecosystem === 'npm' ? jsSpecifiers(added.content) : pythonModules(added.content);
      for (const spec of specs) {
        const name = ecosystem === 'npm' ? jsPackageName(spec) : spec;
        if (!name) {
          continue;
        }
        const candidate = toCandidate(name, ecosystem, file.path, added.line);
        if (candidate) {
          candidates.push(candidate);
        }
      }
    }
  }

  return candidates;
}
