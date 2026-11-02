import type { ChangedFile } from './types.js';

export interface DepCandidate {
  name: string;
  ecosystem: 'npm' | 'pypi';
  file: string;
  line: number;
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
