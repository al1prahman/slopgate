import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isIgnoredPath, parseInlineIgnore, type SlopgateConfig } from './config.js';
import { extractDepCandidates, type DepCandidate, type FileReader } from './deps.js';
import { parseDiff } from './diff.js';
import { createNpmClient, createPypiClient } from './registry/index.js';
import { RegistryCache } from './registry/cache.js';
import { suggestPackage } from './baseline.js';
import { scanSecrets } from './secrets.js';
import { getRangeDiff, getStagedDiff, readFileAtRef } from './git.js';
import type { ChangedFile, Finding, ScanResult } from './types.js';

export interface ScanOptions {
  repoRoot: string;
  staged?: boolean;
  range?: string;
  config: SlopgateConfig;
  fetchFn?: typeof fetch;
  cachePath?: string;
}

function notFoundFinding(candidate: DepCandidate): Finding {
  const registryLabel = candidate.ecosystem === 'npm' ? 'npm' : 'PyPI';
  const suggestion = suggestPackage(candidate.name, candidate.ecosystem);
  return {
    severity: 'block',
    rule: 'dep.not-found',
    file: candidate.file,
    line: candidate.line,
    message: `"${candidate.name}" not found on ${registryLabel}`,
    ...(suggestion ? { suggestion } : {}),
  };
}

async function scanDeps(
  files: readonly ChangedFile[],
  options: ScanOptions,
): Promise<{ findings: Finding[]; cacheHits: number }> {
  const { repoRoot, config } = options;
  const reader: FileReader = {
    read(path: string): string | null {
      try {
        return readFileSync(join(repoRoot, path), 'utf8');
      } catch {
        return null;
      }
    },
    readAtRef(path: string, ref: string): string | null {
      return readFileAtRef(repoRoot, ref, path);
    },
  };

  const candidates = extractDepCandidates(files, reader);
  const cache = new RegistryCache(options.cachePath ?? join(repoRoot, '.slopgate', 'cache.db'));
  const clients = {
    npm: createNpmClient(config.deps.registries.npm, options.fetchFn),
    pypi: createPypiClient(config.deps.registries.pypi, options.fetchFn),
  };

  const findings: Finding[] = [];
  let cacheHits = 0;

  try {
    for (const candidate of candidates) {
      if (config.deps.allowlist.includes(candidate.name)) {
        continue;
      }
      const client = clients[candidate.ecosystem];
      const cached = cache.get(candidate.ecosystem, candidate.name);
      if (cached) {
        cacheHits += 1;
        if (!cached.exists) {
          findings.push(notFoundFinding(candidate));
        }
        continue;
      }
      try {
        const result = await client.check(candidate.name);
        cache.set(candidate.ecosystem, candidate.name, result.exists);
        if (!result.exists) {
          findings.push(notFoundFinding(candidate));
        }
      } catch {
        findings.push({
          severity: 'warn',
          rule: 'dep.registry-error',
          file: candidate.file,
          line: candidate.line,
          message: `Could not verify "${candidate.name}" — ${candidate.ecosystem} registry unreachable (fail-open)`,
        });
      }
    }
  } finally {
    cache.close();
  }

  return { findings, cacheHits };
}

export async function runScan(options: ScanOptions): Promise<ScanResult> {
  const started = Date.now();
  const { repoRoot, config } = options;

  const diffText = options.range
    ? getRangeDiff(repoRoot, options.range)
    : getStagedDiff(repoRoot);
  const allFiles = parseDiff(diffText);

  const fileIgnored = new Set<string>();
  for (const file of allFiles) {
    if (file.addedLines.some((added) => parseInlineIgnore(added.content) === 'file')) {
      fileIgnored.add(file.path);
    }
  }

  const lineIgnores = new Map<string, Set<string>>();
  for (const file of allFiles) {
    for (const added of file.addedLines) {
      const rules = parseInlineIgnore(added.content);
      if (Array.isArray(rules)) {
        const key = `${file.path}:${added.line}`;
        const set = lineIgnores.get(key) ?? new Set<string>();
        for (const rule of rules) {
          set.add(rule);
        }
        lineIgnores.set(key, set);
      }
    }
  }

  const scannable = allFiles.filter(
    (file) => !fileIgnored.has(file.path) && !isIgnoredPath(config.secrets.ignore, file.path),
  );

  let linesAdded = 0;
  for (const file of scannable) {
    linesAdded += file.addedLines.length;
  }

  let findings: Finding[] = [];
  let cacheHits = 0;

  if (config.mode !== 'off') {
    if (config.secrets.enabled) {
      findings.push(...scanSecrets(scannable));
    }
    if (config.deps.enabled) {
      const deps = await scanDeps(scannable, options);
      findings.push(...deps.findings);
      cacheHits = deps.cacheHits;
    }
  }

  findings = findings
    .filter((finding) => {
      const ignored = lineIgnores.get(`${finding.file}:${finding.line}`);
      return !(ignored?.has(finding.rule) ?? false);
    })
    .map((finding) =>
      config.mode === 'warn' && finding.severity === 'block'
        ? { ...finding, severity: 'warn' as const }
        : finding,
    );

  const verdict: ScanResult['verdict'] = findings.some((f) => f.severity === 'block')
    ? 'block'
    : findings.some((f) => f.severity === 'warn')
      ? 'warn'
      : 'pass';

  return {
    findings,
    filesScanned: scannable.length,
    linesAdded,
    cacheHits,
    durationMs: Date.now() - started,
    verdict,
  };
}
