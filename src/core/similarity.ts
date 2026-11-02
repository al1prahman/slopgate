export function levenshtein(a: string, b: string, maxDistance = Number.POSITIVE_INFINITY): number {
  if (a === b) {
    return 0;
  }
  if (Math.abs(a.length - b.length) > maxDistance) {
    return maxDistance + 1;
  }

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  let current = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowMin = current[0]!;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + cost,
      );
      rowMin = Math.min(rowMin, current[j]!);
    }
    if (rowMin > maxDistance) {
      return maxDistance + 1;
    }
    [previous, current] = [current, previous];
  }

  return previous[b.length]!;
}

export interface NearestOptions {
  maxDistance?: number;
  limit?: number;
}

export function findNearest(
  query: string,
  candidates: readonly string[],
  options: NearestOptions = {},
): string[] {
  const maxDistance = options.maxDistance ?? 2;
  const limit = options.limit ?? 3;
  const scored: Array<{ name: string; distance: number }> = [];

  for (const candidate of candidates) {
    const distance = levenshtein(query, candidate, maxDistance);
    if (distance <= maxDistance) {
      scored.push({ name: candidate, distance });
    }
  }

  scored.sort((left, right) =>
    left.distance !== right.distance
      ? left.distance - right.distance
      : left.name.length - right.name.length,
  );
  return scored.slice(0, limit).map((entry) => entry.name);
}
