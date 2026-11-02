export interface RegistryCheckResult {
  readonly exists: boolean;
}

export interface RegistryClient {
  readonly ecosystem: 'npm' | 'pypi';
  check(name: string): Promise<RegistryCheckResult>;
}

const REGISTRY_TIMEOUT_MS = 10_000;

async function statusOf(url: string, fetchFn: typeof fetch): Promise<number> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS);
  try {
    const response = await fetchFn(url, { signal: controller.signal, method: 'GET' });
    return response.status;
  } finally {
    clearTimeout(timer);
  }
}

function trimTrailingSlash(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

export function createNpmClient(baseUrl: string, fetchFn: typeof fetch = fetch): RegistryClient {
  return {
    ecosystem: 'npm',
    async check(name: string): Promise<RegistryCheckResult> {
      // npm convention: keep the @ literal, encode only the scope separator.
      const encoded = name.replace('/', '%2F');
      const url = `${trimTrailingSlash(baseUrl)}/${encoded}`;
      const status = await statusOf(url, fetchFn);
      if (status === 200) {
        return { exists: true };
      }
      if (status === 404) {
        return { exists: false };
      }
      throw new Error(`npm registry returned HTTP ${status} for "${name}"`);
    },
  };
}

export function normalizePypiName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

export function createPypiClient(baseUrl: string, fetchFn: typeof fetch = fetch): RegistryClient {
  return {
    ecosystem: 'pypi',
    async check(name: string): Promise<RegistryCheckResult> {
      const url = `${trimTrailingSlash(baseUrl)}/${normalizePypiName(name)}/json`;
      const status = await statusOf(url, fetchFn);
      if (status === 200) {
        return { exists: true };
      }
      if (status === 404) {
        return { exists: false };
      }
      throw new Error(`PyPI returned HTTP ${status} for "${name}"`);
    },
  };
}
