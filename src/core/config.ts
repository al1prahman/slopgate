import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface SlopgateConfig {
  mode: 'block' | 'warn' | 'off';
  secrets: {
    enabled: boolean;
    ignore: string[];
  };
  deps: {
    enabled: boolean;
    ecosystems: string[];
    registries: { npm: string; pypi: string };
    customIndex: string[];
    allowlist: string[];
    quarantine: boolean;
    typosquat: {
      enabled: boolean;
      maxDistance: number;
      maxAgeDays: number;
    };
  };
  python: {
    unmappedImports: 'warn' | 'ignore';
  };
  imports: {
    enabled: boolean;
  };
}

export const CONFIG_FILE_NAME = '.slopgate.yml';

export function defaultConfig(): SlopgateConfig {
  return {
    mode: 'block',
    secrets: {
      enabled: true,
      ignore: [],
    },
    deps: {
      enabled: true,
      ecosystems: ['npm', 'pypi'],
      registries: {
        npm: 'https://registry.npmjs.org',
        pypi: 'https://pypi.org/pypi',
      },
      customIndex: [],
      allowlist: [],
      quarantine: false,
      typosquat: {
        enabled: true,
        maxDistance: 2,
        maxAgeDays: 90,
      },
    },
    python: {
      unmappedImports: 'warn',
    },
    imports: {
      enabled: true,
    },
  };
}

function mergeConfig(base: SlopgateConfig, partial: Record<string, unknown>): SlopgateConfig {
  const merged: SlopgateConfig = structuredClone(base);

  if (typeof partial.mode === 'string' && ['block', 'warn', 'off'].includes(partial.mode)) {
    merged.mode = partial.mode as SlopgateConfig['mode'];
  }
  const secrets = partial.secrets as Record<string, unknown> | undefined;
  if (secrets && typeof secrets === 'object') {
    if (typeof secrets.enabled === 'boolean') merged.secrets.enabled = secrets.enabled;
    if (Array.isArray(secrets.ignore)) merged.secrets.ignore = secrets.ignore.map(String);
  }
  const deps = partial.deps as Record<string, unknown> | undefined;
  if (deps && typeof deps === 'object') {
    if (typeof deps.enabled === 'boolean') merged.deps.enabled = deps.enabled;
    if (Array.isArray(deps.ecosystems)) merged.deps.ecosystems = deps.ecosystems.map(String);
    if (Array.isArray(deps.allowlist)) merged.deps.allowlist = deps.allowlist.map(String);
    const customIndex = deps['custom-index'] ?? deps.customIndex;
    if (Array.isArray(customIndex)) merged.deps.customIndex = customIndex.map(String);
    if (typeof deps.quarantine === 'boolean') merged.deps.quarantine = deps.quarantine;
    const typosquat = deps.typosquat as Record<string, unknown> | undefined;
    if (typosquat && typeof typosquat === 'object') {
      if (typeof typosquat.enabled === 'boolean') {
        merged.deps.typosquat.enabled = typosquat.enabled;
      }
      const maxDistance = typosquat['max-distance'] ?? typosquat.maxDistance;
      if (
        typeof maxDistance === 'number' &&
        Number.isInteger(maxDistance) &&
        maxDistance >= 0 &&
        maxDistance <= 5
      ) {
        merged.deps.typosquat.maxDistance = maxDistance;
      }
      const maxAgeDays = typosquat['max-age-days'] ?? typosquat.maxAgeDays;
      if (
        typeof maxAgeDays === 'number' &&
        Number.isInteger(maxAgeDays) &&
        maxAgeDays > 0 &&
        maxAgeDays <= 3650
      ) {
        merged.deps.typosquat.maxAgeDays = maxAgeDays;
      }
    }
    const registries = deps.registries as Record<string, unknown> | undefined;
    if (registries && typeof registries === 'object') {
      if (typeof registries.npm === 'string') merged.deps.registries.npm = registries.npm;
      if (typeof registries.pypi === 'string') merged.deps.registries.pypi = registries.pypi;
    }
  }
  const python = partial.python as Record<string, unknown> | undefined;
  if (python && typeof python === 'object') {
    const unmapped = python['unmapped-imports'] ?? python.unmappedImports;
    if (unmapped === 'warn' || unmapped === 'ignore') {
      merged.python.unmappedImports = unmapped;
    }
  }
  const imports = partial.imports as Record<string, unknown> | undefined;
  if (imports && typeof imports === 'object') {
    if (typeof imports.enabled === 'boolean') merged.imports.enabled = imports.enabled;
  }
  return merged;
}

export function loadConfig(repoRoot: string): SlopgateConfig {
  const configPath = join(repoRoot, CONFIG_FILE_NAME);
  if (!existsSync(configPath)) {
    return defaultConfig();
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `Failed to parse ${CONFIG_FILE_NAME}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (parsed === null || parsed === undefined) {
    return defaultConfig();
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${CONFIG_FILE_NAME} must contain a YAML mapping at the top level`);
  }
  return mergeConfig(defaultConfig(), parsed as Record<string, unknown>);
}

export function globToRegExp(pattern: string): RegExp {
  let source = '^';
  let i = 0;
  while (i < pattern.length) {
    const char = pattern[i]!;
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*';
        i += 2;
        if (pattern[i] === '/') {
          i += 1; // '**/' also matches zero directories
        }
      } else {
        source += '[^/]*';
        i += 1;
      }
    } else if (char === '?') {
      source += '[^/]';
      i += 1;
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`${source}$`);
}

export function isIgnoredPath(patterns: readonly string[], path: string): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}

export function parseInlineIgnore(content: string): 'file' | string[] | null {
  if (/\/\/\s*slopgate:ignore-file\b/.test(content)) {
    return 'file';
  }
  const rules: string[] = [];
  const matcher = /slopgate:ignore\s+([a-z0-9._-]+)/gi;
  for (const match of content.matchAll(matcher)) {
    rules.push(match[1]!.toLowerCase());
  }
  return rules.length > 0 ? rules : null;
}
