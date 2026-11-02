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

export interface TyposquatTarget {
  readonly name: string;
  readonly distance: number;
}

// Length-bucketed index for the typosquat scan: a name within edit distance
// k of the query can differ in length by at most k, so bucketing by exact
// length skips most of the baseline before any DP runs.
let npmBuckets: Map<number, string[]> | null = null;
let pypiBuckets: Map<number, string[]> | null = null;

function bucketsFor(ecosystem: 'npm' | 'pypi'): Map<number, string[]> {
  const cached = ecosystem === 'npm' ? npmBuckets : pypiBuckets;
  if (cached) {
    return cached;
  }
  const buckets = new Map<number, string[]>();
  for (const name of loadBaseline(ecosystem)) {
    const bucket = buckets.get(name.length);
    if (bucket) {
      bucket.push(name);
    } else {
      buckets.set(name.length, [name]);
    }
  }
  if (ecosystem === 'npm') {
    npmBuckets = buckets;
  } else {
    pypiBuckets = buckets;
  }
  return buckets;
}

// Reused DP rows: allocating two arrays per comparison dominated the scan
// (~1.4us per call, 340ms for 1500 names); with buffers the same scan is ~25ms.
let dpPrev = new Int32Array(64);
let dpCur = new Int32Array(64);

// Banded Levenshtein: only cells within |i-j| <= k can lie on a path of at
// most k edits, so the rest of the matrix is never computed. Returns the
// exact distance when it is <= k, and k + 1 otherwise (callers only compare
// against k, so the two "greater than k" outcomes are equivalent).
function distanceWithin(a: string, b: string, k: number): number {
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > k) {
    return k + 1;
  }
  const inf = k + 1;
  if (lb + 1 > dpPrev.length) {
    dpPrev = new Int32Array(lb + 1);
    dpCur = new Int32Array(lb + 1);
  }
  for (let j = 0; j <= lb; j += 1) {
    dpPrev[j] = j <= k ? j : inf;
  }
  for (let i = 1; i <= la; i += 1) {
    const lo = i - k > 1 ? i - k : 1;
    const hi = i + k < lb ? i + k : lb;
    dpCur[0] = i <= k ? i : inf;
    if (lo > 1) {
      dpCur[lo - 1] = inf;
    }
    const ca = a.charCodeAt(i - 1);
    const prevHi = i - 1 + k; // rightmost column the previous row wrote
    let rowMin = dpCur[0];
    for (let j = lo; j <= hi; j += 1) {
      const up = j <= prevHi ? dpPrev[j]! : inf;
      let v = up + 1;
      const left = dpCur[j - 1]! + 1;
      if (left < v) {
        v = left;
      }
      const diag = dpPrev[j - 1]! + (ca === b.charCodeAt(j - 1) ? 0 : 1);
      if (diag < v) {
        v = diag;
      }
      dpCur[j] = v;
      if (v < rowMin) {
        rowMin = v;
      }
    }
    if (rowMin > k) {
      return inf;
    }
    const swap = dpPrev;
    dpPrev = dpCur;
    dpCur = swap;
  }
  return dpPrev[lb]! <= k ? dpPrev[lb]! : inf;
}

// The popular package a suspicious name imitates, or null when the name is
// itself popular (not a typosquat of anything) or nothing popular is within
// maxDistance edits.
export function findTyposquatTarget(
  name: string,
  ecosystem: 'npm' | 'pypi',
  maxDistance: number,
): TyposquatTarget | null {
  const query = ecosystem === 'pypi' ? normalizePypiName(name) : name;
  if (loadBaseline(ecosystem).has(query)) {
    return null;
  }
  const buckets = bucketsFor(ecosystem);
  let best: TyposquatTarget | null = null;
  const shortest = Math.max(1, query.length - maxDistance);
  const longest = query.length + maxDistance;
  for (let len = shortest; len <= longest; len += 1) {
    const bucket = buckets.get(len);
    if (!bucket) {
      continue;
    }
    for (const candidate of bucket) {
      const distance = distanceWithin(query, candidate, maxDistance);
      if (distance === 0 || distance > maxDistance) {
        continue;
      }
      if (!best || distance < best.distance) {
        best = { name: candidate, distance };
        if (distance === 1) {
          return best; // one edit is the best a non-popular name can do
        }
      }
    }
  }
  return best;
}
