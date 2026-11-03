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
import { getRangeDiff, getStagedDiff, getCommitMessages, readFileAtRef } from './git.js';
import { detectAgentAuthorship } from './agent.js';
import { hydrateUtf16NewFiles, rangeEndRef } from './binary-text.js';
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
  // Pre-fetched commit messages for the agent-commit heuristic; when absent
  // they are read for range scans (staged diffs have no message yet).
  commitMessages?: readonly string[];
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

// Registry checks are I/O-bound. A Python repo imports the same package
// from many files: curio-ai produced 252 candidates for 20 unique packages,
// and the serial loop paid a round-trip for every one — 55 seconds, 232 of
// them wasted. Dedupe to one call per package, then keep a handful of
// calls in flight.
const REGISTRY_CONCURRENCY = 8;

async function scanCandidates(
  candidates: readonly DepCandidate[],
  options: ScanOptions,
): Promise<{ findings: Finding[]; cacheHits: number }> {
  const { repoRoot, config } = options;
  if (candidates.length === 0) {
    return { findings: [], cacheHits: 0 };
  }
  const cache = new RegistryCache(options.cachePath ?? join(repoRoot, '.slopgate', 'cache.db'), {
    positiveTtlMs: config.deps.cache.positiveTtlHours * 3_600_000,
    negativeTtlMs: config.deps.cache.negativeTtlMinutes * 60_000,
  });
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
  // An import with no alias entry may simply use a mapping we do not know —
  // warn once per name instead of once per file.
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
    // One registry call per unique package, but every candidate still gets
    // judged — a hallucinated dep imported from ten files reports ten
    // findings, it just costs one round-trip.
    const groups = new Map<string, DepCandidate[]>();
    for (const candidate of candidates) {
      if (
        config.deps.allowlist.includes(candidate.name) ||
        (candidate.importName !== undefined &&
          config.deps.allowlist.includes(candidate.importName))
      ) {
        continue;
      }
      const key = cacheKey(candidate.ecosystem, candidate.name);
      const group = groups.get(key);
      if (group) {
        group.push(candidate);
      } else {
        groups.set(key, [candidate]);
      }
    }

    const targetFor = (candidate: DepCandidate, createdAt: string | null): TyposquatTarget | null =>
      typosquat.enabled && createdAt
        ? findTyposquatTarget(candidate.name, candidate.ecosystem, typosquat.maxDistance)
        : null;

    const uncached: { key: string; group: DepCandidate[]; first: DepCandidate; target: TyposquatTarget | null }[] = [];
    for (const [key, group] of groups) {
      const cached = cachedVerdicts.get(key);
      if (cached) {
        cacheHits += group.length;
        for (const candidate of group) {
          judge(candidate, cached.exists, cached.createdAt, targetFor(candidate, cached.createdAt));
        }
        continue;
      }
      // Only look-alikes of popular packages need the packument body, so the
      // metadata flag is set exactly when the typosquat check could fire.
      const first = group[0] as DepCandidate;
      const target = typosquat.enabled
        ? findTyposquatTarget(first.name, first.ecosystem, typosquat.maxDistance)
        : null;
      uncached.push({ key, group, first, target });
    }

    const verdicts = new Map<string, { exists: boolean; createdAt: string | null } | null>();
    for (let i = 0; i < uncached.length; i += REGISTRY_CONCURRENCY) {
      const batch = uncached.slice(i, i + REGISTRY_CONCURRENCY);
      await Promise.all(
        batch.map(async ({ key, first, target }) => {
          try {
            const result = await clients[first.ecosystem].check(first.name, {
              metadata: target !== null,
            });
            pendingWrites.push({
              ecosystem: first.ecosystem,
              name: first.name,
              exists: result.exists,
              createdAt: result.createdAt,
            });
            verdicts.set(key, result);
          } catch {
            verdicts.set(key, null);
          }
        }),
      );
    }

    // Judge in candidate order so findings stay deterministic.
    for (const { key, group } of uncached) {
      const result = verdicts.get(key);
      if (result === undefined) {
        continue;
      }
      if (result === null) {
        for (const candidate of group) {
          findings.push({
            severity: 'warn',
            rule: candidate.source === 'import' ? 'import.registry-error' : 'dep.registry-error',
            file: candidate.file,
            line: candidate.line,
            message: `Could not verify "${candidate.name}" — ${candidate.ecosystem} registry unreachable (fail-open)`,
          });
        }
        continue;
      }
      for (const candidate of group) {
        judge(candidate, result.exists, result.createdAt, targetFor(candidate, result.createdAt));
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
  // UTF-16 files arrive from git marked binary (no line data); recover the
  // new ones from the blob at the scan's end ref so their content is not
  // silently skipped. See binary-text.ts.
  const endRef = options.range ? rangeEndRef(options.range) : ':0';
  const allFiles = hydrateUtf16NewFiles(parseDiff(diffText), repoRoot, endRef);

  // F12: agent-commit heuristic. Range scans read the commit messages in
  // scope; a staged diff has no message yet, so there is nothing to detect.
  const agentSignal =
    config.agent.enabled && options.range
      ? detectAgentAuthorship(
          options.commitMessages ?? getCommitMessages(repoRoot, options.range),
        )
      : { agentAuthored: false, markers: [] as string[] };

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
    agentAuthored: agentSignal.agentAuthored,
    agentMarkers: agentSignal.markers,
  };
}
