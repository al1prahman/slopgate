import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isIgnoredPath, parseInlineIgnore, type SlopgateConfig } from './config.js';
import { extractDepCandidates, type DepCandidate, type FileReader } from './deps.js';
import { parseDiff } from './diff.js';
import { extractImportCandidates } from './imports.js';
import { createNpmClient, createPypiClient } from './registry/index.js';
import { RegistryCache, cacheKey } from './registry/cache.js';
import { findTyposquatTarget, suggestPackage, type TyposquatTarget } from './baseline.js';
import { scanSecrets } from './secrets.js';
import { getRangeDiff, getStagedDiff, readFileAtRef } from './git.js';
import type { Finding, ScanResult } from './types.js';

export interface ScanOptions {
  repoRoot: string;
  staged?: boolean;
  range?: string;
  config: SlopgateConfig;
  fetchFn?: typeof fetch;
  cachePath?: string;
  // Pre-fetched diff text; when provided the git spawn is skipped. Lets
  // callers that already hold a diff (CI actions, tests) reuse it.
  diffText?: string;
}

function notFoundFinding(candidate: DepCandidate): Finding {
  const registryLabel = candidate.ecosystem === 'npm' ? 'npm' : 'PyPI';
  const suggestion = suggestPackage(candidate.name, candidate.ecosystem);
  const subject =
    candidate.source === 'import'
      ? candidate.importName && candidate.importName !== candidate.name
        ? `import "${candidate.importName}" (package "${candidate.name}")`
        : `import "${candidate.importName ?? candidate.name}"`
      : `"${candidate.name}"`;
  return {
    severity: 'block',
    rule: candidate.source === 'import' ? 'import.not-found' : 'dep.not-found',
    file: candidate.file,
    line: candidate.line,
    message: `${subject} not found on ${registryLabel}`,
    ...(suggestion ? { suggestion } : {}),
  };
}

// A package that exists but is a fresh look-alike of a popular one is the
// classic slopsquatting shape: the name was never hallucinated, it was
// seeded. Warn — it does not block, the package is real and may even be
// legitimate. Returns null when the age is unknown (fail-open) or the
// package is older than the window.
function typosquatFinding(
  candidate: DepCandidate,
  createdAt: string | null,
  target: TyposquatTarget | null,
  maxAgeDays: number,
): Finding | null {
  if (!target || !createdAt) {
    return null;
  }
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) {
    return null;
  }
  const ageDays = Math.floor((Date.now() - created) / 86_400_000);
  if (ageDays >= maxAgeDays) {
    return null;
  }
  return {
    severity: 'warn',
    rule: 'dep.typosquat',
    file: candidate.file,
    line: candidate.line,
    message: `"${candidate.name}" exists but is ${target.distance} edit(s) from popular "${target.name}" and only ${ageDays} day(s) old — probable typosquat`,
    suggestion: target.name,
  };
}

async function scanCandidates(
  candidates: readonly DepCandidate[],
  options: ScanOptions,
): Promise<{ findings: Finding[]; cacheHits: number }> {
  const { repoRoot, config } = options;
  if (candidates.length === 0) {
    return { findings: [], cacheHits: 0 };
  }
  const cache = new RegistryCache(options.cachePath ?? join(repoRoot, '.slopgate', 'cache.db'));
  const clients = {
    npm: createNpmClient(config.deps.registries.npm, options.fetchFn),
    pypi: createPypiClient(config.deps.registries.pypi, options.fetchFn),
  };
  const cachedVerdicts = cache.getMany(candidates);
  const pendingWrites: {
    ecosystem: string;
    name: string;
    exists: boolean;
    createdAt: string | null;
  }[] = [];

  const findings: Finding[] = [];
  let cacheHits = 0;
  const typosquat = config.deps.typosquat;
  const warnedUnmapped = new Set<string>();

  const judge = (
    candidate: DepCandidate,
    exists: boolean,
    createdAt: string | null,
    target: TyposquatTarget | null,
  ): void => {
    if (!exists) {
      if (candidate.unmapped) {
        // An import with no alias entry may simply use a mapping we do not
        // know — warn once per name instead of blocking the commit.
        if (warnedUnmapped.has(candidate.name)) {
          return;
        }
        warnedUnmapped.add(candidate.name);
        const suggestion = suggestPackage(
          candidate.importName ?? candidate.name,
          candidate.ecosystem,
        );
        findings.push({
          severity: 'warn',
          rule: 'import.unmapped',
          file: candidate.file,
          line: candidate.line,
          message: `import "${candidate.importName ?? candidate.name}" has no known package mapping and "${candidate.name}" was not found on PyPI`,
          ...(suggestion ? { suggestion } : {}),
        });
        return;
      }
      findings.push(notFoundFinding(candidate));
      return;
    }
    if (typosquat.enabled && createdAt) {
      const warning = typosquatFinding(candidate, createdAt, target, typosquat.maxAgeDays);
      if (warning) {
        findings.push(warning);
      }
    }
  };

  try {
    for (const candidate of candidates) {
      if (
        config.deps.allowlist.includes(candidate.name) ||
        (candidate.importName !== undefined &&
          config.deps.allowlist.includes(candidate.importName))
      ) {
        continue;
      }
      const client = clients[candidate.ecosystem];
      const cached = cachedVerdicts.get(cacheKey(candidate.ecosystem, candidate.name));
      if (cached) {
        cacheHits += 1;
        // Without a cached age the verdict cannot be judged — skip the
        // baseline scan entirely rather than paying it for nothing.
        const target =
          typosquat.enabled && cached.createdAt
            ? findTyposquatTarget(candidate.name, candidate.ecosystem, typosquat.maxDistance)
            : null;
        judge(candidate, cached.exists, cached.createdAt, target);
        continue;
      }
      // Only look-alikes of popular packages need the packument body, so the
      // metadata flag is set exactly when the typosquat check could fire.
      const target = typosquat.enabled
        ? findTyposquatTarget(candidate.name, candidate.ecosystem, typosquat.maxDistance)
        : null;
      try {
        const result = await client.check(candidate.name, { metadata: target !== null });
        pendingWrites.push({
          ecosystem: candidate.ecosystem,
          name: candidate.name,
          exists: result.exists,
          createdAt: result.createdAt,
        });
        judge(candidate, result.exists, result.createdAt, target);
      } catch {
        findings.push({
          severity: 'warn',
          rule: candidate.source === 'import' ? 'import.registry-error' : 'dep.registry-error',
          file: candidate.file,
          line: candidate.line,
          message: `Could not verify "${candidate.name}" — ${candidate.ecosystem} registry unreachable (fail-open)`,
        });
      }
    }
  } finally {
    // One transaction for every fresh verdict: individual set() calls each
    // pay a commit, and a cold scan with hundreds of new deps would spend
    // seconds on fsyncs otherwise.
    try {
      cache.setMany(pendingWrites);
    } finally {
      cache.close();
    }
  }

  return { findings, cacheHits };
}

export async function runScan(options: ScanOptions): Promise<ScanResult> {
  const started = Date.now();
  const { repoRoot, config } = options;

  const diffText =
    options.diffText ??
    (options.range ? getRangeDiff(repoRoot, options.range) : getStagedDiff(repoRoot));
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
    const candidates: DepCandidate[] = [];
    if (config.deps.enabled) {
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
      candidates.push(...extractDepCandidates(scannable, reader));
    }
    if (config.imports.enabled) {
      candidates.push(
        ...extractImportCandidates(scannable).filter(
          (candidate) => !(candidate.unmapped && config.python.unmappedImports === 'ignore'),
        ),
      );
    }
    if (candidates.length > 0) {
      const scanned = await scanCandidates(candidates, options);
      findings.push(...scanned.findings);
      cacheHits = scanned.cacheHits;
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
