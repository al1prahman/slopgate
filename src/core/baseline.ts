import { readFileSync } from 'node:fs';
import { normalizePypiName } from './registry/index.js';
import { findNearest } from './similarity.js';

let npmBaseline: ReadonlySet<string> | null = null;
let pypiBaseline: ReadonlySet<string> | null = null;

function loadFrom(url: URL): ReadonlySet<string> {
  const names = readFileSync(url, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  return new Set(names);
}

export function loadBaseline(ecosystem: 'npm' | 'pypi'): ReadonlySet<string> {
  if (ecosystem === 'npm') {
    npmBaseline ??= loadFrom(new URL('../../data/baseline-npm.txt', import.meta.url));
    return npmBaseline;
  }
  pypiBaseline ??= loadFrom(new URL('../../data/baseline-pypi.txt', import.meta.url));
  return pypiBaseline;
}

export function suggestPackage(name: string, ecosystem: 'npm' | 'pypi'): string | null {
  const baseline = loadBaseline(ecosystem);
  const query = ecosystem === 'pypi' ? normalizePypiName(name) : name;
  const nearest = findNearest(query, [...baseline], {
    maxDistance: ecosystem === 'pypi' ? 3 : 2,
  });
  return nearest[0] ?? null;
}
