export interface RegistryCheckResult {
  readonly exists: boolean;
  // ISO timestamp of the package's first release, when the registry exposes
  // one and the caller asked for metadata. null means "unknown" — callers
  // treat that as "cannot judge age" and skip age-based checks.
  readonly createdAt: string | null;
}

export interface RegistryClient {
  readonly ecosystem: 'npm' | 'pypi';
  check(name: string, options?: { metadata?: boolean }): Promise<RegistryCheckResult>;
}

const REGISTRY_TIMEOUT_MS = 10_000;

async function fetchRegistry(url: string, fetchFn: typeof fetch): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS);
  try {
    return await fetchFn(url, { signal: controller.signal, method: 'GET' });
  } finally {
    clearTimeout(timer);
  }
}

// The packument body is only parsed for names already flagged as look-alikes
// of popular packages, so status-only checks never pay the JSON.parse cost.
async function createdAtFrom(
  response: Response,
  extract: (doc: unknown) => string | null,
): Promise<string | null> {
  try {
    const doc: unknown = await response.json();
    return extract(doc);
  } catch {
    return null;
  }
}

function npmCreatedAt(doc: unknown): string | null {
  const time = (doc as { time?: { created?: unknown } } | null)?.time;
  return typeof time?.created === 'string' ? time.created : null;
}

function pypiCreatedAt(doc: unknown): string | null {
  const releases = (doc as { releases?: Record<string, unknown> } | null)?.releases;
  if (!releases || typeof releases !== 'object') {
    return null;
  }
  // PyPI has no "created" field; the earliest upload across releases is the
  // closest equivalent.
  let earliest: string | null = null;
  let earliestMs = Number.POSITIVE_INFINITY;
  for (const files of Object.values(releases)) {
    if (!Array.isArray(files)) {
      continue;
    }
    for (const file of files) {
      const uploaded = (file as { upload_time_iso_8601?: unknown } | null)?.upload_time_iso_8601;
      if (typeof uploaded !== 'string') {
        continue;
      }
      const ms = Date.parse(uploaded);
      if (Number.isNaN(ms)) {
        continue;
      }
      if (ms < earliestMs) {
        earliestMs = ms;
        earliest = uploaded;
      }
    }
  }
  return earliest;
}

function trimTrailingSlash(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

export function createNpmClient(baseUrl: string, fetchFn: typeof fetch = fetch): RegistryClient {
  return {
    ecosystem: 'npm',
    async check(name: string, options: { metadata?: boolean } = {}): Promise<RegistryCheckResult> {
      // npm convention: keep the @ literal, encode only the scope separator.
      const encoded = name.replace('/', '%2F');
      const url = `${trimTrailingSlash(baseUrl)}/${encoded}`;
      const response = await fetchRegistry(url, fetchFn);
      if (response.status === 200) {
        return {
          exists: true,
          createdAt: options.metadata ? await createdAtFrom(response, npmCreatedAt) : null,
        };
      }
      if (response.status === 404) {
        return { exists: false, createdAt: null };
      }
      throw new Error(`npm registry returned HTTP ${response.status} for "${name}"`);
    },
  };
}

export function normalizePypiName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

export function createPypiClient(baseUrl: string, fetchFn: typeof fetch = fetch): RegistryClient {
  return {
    ecosystem: 'pypi',
    async check(name: string, options: { metadata?: boolean } = {}): Promise<RegistryCheckResult> {
      const url = `${trimTrailingSlash(baseUrl)}/${normalizePypiName(name)}/json`;
      const response = await fetchRegistry(url, fetchFn);
      if (response.status === 200) {
        return {
          exists: true,
          createdAt: options.metadata ? await createdAtFrom(response, pypiCreatedAt) : null,
        };
      }
      if (response.status === 404) {
        return { exists: false, createdAt: null };
      }
      throw new Error(`PyPI returned HTTP ${response.status} for "${name}"`);
    },
  };
}
