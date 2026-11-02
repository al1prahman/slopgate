# slopgate — 02 Implementation Spec

Version: 1.0 · Date: 2026-11-02

## Source idea review

From `00-idea-capture.md` / `01-design-doc.md`: a git-native gate that blocks (a) secrets and (b) non-existent dependencies in agent-authored diffs. Core risk to manage: **false positives kill hook-based tools**. Every design choice below trades recall for precision where a false BLOCK would make a user uninstall.

## Similar products / market check

| Product | Does | Gap for slopgate |
|---|---|---|
| gitleaks / trufflehog | Secret scanning (history + pre-commit) | No dependency-hallucination detection; not agent-aware |
| GuardDog (DataDog, OSS) | Malicious-package heuristics, incl. typosquatting | Scans *installed/declared* packages broadly; not diff-scoped, not commit-gate UX, heavy dependency |
| Socket.dev | Supply-chain platform | Commercial, cloud-centric, not a 5-second local hook |
| Snyk / Dependabot | Vuln alerts on known packages | Only flags *existing* vulnerable packages — a hallucinated package is invisible to them |
| `npm audit` | Known vulns in dep tree | Same blind spot; registry typo warnings are advisory at best |

**Positioning:** the only tool whose unit of work is *the added lines of a commit*, whose first-class threat is *hallucinated package names*, and whose install is one command.

## Product scope

- **MVP:** npm + PyPI dependency *existence* checks on changed dependency files; secret scan of added lines; hook + CLI + cache + config; tests; publish.
- **v1:** import scanning, typosquat similarity, GitHub Action + SARIF, agent-commit heuristic.
- **v2:** more ecosystems, risk scoring, quarantine, MCP server.

## System overview

```
src/
  cli.ts                 # commander entry
  commands/init.ts       # install hooks, scaffold config
  commands/scan.ts       # --staged | --range | --files
  commands/cache.ts      # stats / clear
  core/
    diff.ts              # git diff -U0 → added lines per file
    secrets.ts           # regex + entropy detectors
    deps.ts              # extract candidate package names
    registry/
      types.ts           # RegistryClient interface
      npm.ts             # registry.npmjs.org client
      pypi.ts            # pypi.org/simple + /pypi/<n>/json
      cache.ts           # SQLite TTL cache (shared by clients)
    similarity.ts        # levenshtein + normalization
    baseline.ts          # embedded popular-package lists
    config.ts            # .slopgate.yml load + defaults + globs
    gate.ts              # orchestration + verdict
    report.ts            # pretty / json / sarif
  hooks/templates/       # pre-commit, pre-push shims
data/
  baseline-npm.txt       # top ~1000 npm names
  baseline-pypi.txt      # top ~1000 PyPI names
  python-import-aliases.json
```

## Data model

```ts
type Severity = 'block' | 'warn' | 'info';

interface Finding {
  severity: Severity;
  rule: string;            // 'secret.anthropic-key', 'dep.not-found', ...
  file: string;
  line: number;            // line number in the new file
  message: string;
  suggestion?: string;
  evidence?: string;       // redacted snippet
}

interface ScanResult {
  findings: Finding[];
  filesScanned: number;
  linesAdded: number;
  cacheHits: number;
  durationMs: number;
}
```

SQLite cache schema:

```sql
CREATE TABLE registry_cache (
  registry TEXT NOT NULL,        -- 'npm' | 'pypi'
  name TEXT NOT NULL,
  exists_flag INTEGER NOT NULL,
  meta TEXT,                     -- JSON: created, downloads, latest
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (registry, name)
);
```

## Key workflows

### W1 — pre-commit

`git diff --cached -U0` → added lines only → detectors → exit code. Budget: < 2 s cold, < 100 ms warm.

### W2 — pre-push

`git diff origin/<default>..HEAD -U0` (fallback: `@{push}`). Same pipeline.

### W3 — GitHub Action (v1)

`slopgate scan --range origin/$BASE...HEAD --format sarif` → upload SARIF; optional sticky PR comment.

## Hard problems (the portfolio-grade parts)

1. **Dependency extraction per ecosystem.**
   - `package.json`: JSON-diff the staged blob vs HEAD blob → added/changed keys in `dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies`. Skip `workspace:*` refs and `file:` refs.
   - `requirements.txt`: added lines only; strip comments, `-r`/`--index-url`/options; parse name from `name[extra]==1.2` / `name>=x`; handle environment markers after `;`.
   - `pyproject.toml` (v1): `[project.dependencies]` and `[tool.poetry.dependencies]` via a TOML parser.
2. **Registry existence check.**
   - npm: `GET registry.npmjs.org/<urlencoded-name>`; 404 ⇒ not found. Scoped names: `@scope%2fname`.
   - PyPI: `GET pypi.org/simple/<name>/`; 404 ⇒ not found (normalize per PEP 503: lowercase, `-`/`_`/`.` collapse).
   - Both cached; negative cache TTL 1 h (a just-registered squat may appear later), positive TTL 24 h.
3. **Suggestion / similarity.**
   - Normalized Levenshtein ≤ 2 against embedded baseline + previously-seen names.
   - Not-found ⇒ BLOCK + suggestion. Found + (age < 90 d ∧ distance ≤ 2 from baseline name with ≥ 50× downloads) ⇒ WARN (probable typosquat).
   - Thresholds config-tunable; defaults chosen to keep FP ≈ 0 on legitimate new packages (most legit new names are ≥ distance 3 from anything popular).
4. **Python import→package mapping (v1).**
   - Top-level module name ≠ distribution name (`bs4` → `beautifulsoup4`).
   - Strategy: (a) embedded alias table (~150 curated entries, generated offline); (b) exact-name check on PyPI; (c) fuzzy suggestion; (d) unresolved ⇒ WARN once per session, policy configurable (`warn` | `ignore`).
5. **False-positive containment.**
   - Private registries: parse `--index-url` / `pip.conf` / `.npmrc` registry lines; check custom-index first, then public; never BLOCK a name that exists on a configured custom index.
   - Config allowlist + inline `# slopgate:ignore dep.not-found` + `# slopgate:ignore-file`.
   - Never scan lockfiles (`package-lock.json`, `poetry.lock`, `yarn.lock`) for dependency findings.
6. **Performance.**
   - Parallel registry fetches (p-limit, concurrency 8).
   - Diff parsing in-process; no child processes except `git` itself.
   - `--offline` mode: cache-only, warn on misses.

## Tech stack

TypeScript · Node ≥ 20 · commander · better-sqlite3 · p-limit · vitest · ESLint/Prettier · GitHub Actions · `npm publish` (OIDC trusted publishing).

## Testing & verification plan

- **Unit:** diff parser (fixture diffs incl. renames, binary, mode-change), requirements.txt parser (10-case table incl. markers/extras/URLs), package.json diff extractor, Levenshtein + normalization, secret corpus (positive + adversarial-negative fixtures), config resolution + glob matching, cache TTL behavior (fake timers).
- **Integration:** registry clients against recorded fixtures (msw/nock — no live network in CI).
- **E2E:** temp git repo → stage a commit containing a fake dep + a fake key → run the built hook → assert exit 2 and expected output lines; then clean commit → assert exit 0 and duration budget.
- **Perf test:** warm cache scan of a 500-file diff < 100 ms (CI-enforced).
- **Publish dry-run:** `npm pack` + `npx . --help` from the tarball.

## Acceptance criteria / done means (MVP)

- [ ] `npx slopgate init` creates hooks + `.slopgate.yml` in a fresh repo in < 3 s
- [ ] Commit adding `reqeusts` to `requirements.txt` → exit 2, output suggests `requests`
- [ ] Commit adding `sk-ant-api03-…` to any file → exit 2
- [ ] Clean commit → exit 0; cold scan < 2 s, warm < 100 ms
- [ ] `--json` emits valid `ScanResult`; `--format sarif` emits valid SARIF 2.1.0
- [ ] All unit/integration/e2e tests green in CI; coverage ≥ 80% on `core/`
- [ ] Published to npm; README quick-start verified from the tarball
- [ ] Dogfooded on ≥ 2 real repos for a week with zero false blocks

## Risks & tradeoffs

| Risk | Mitigation |
|---|---|
| False BLOCK on private packages | custom-index detection + allowlist + ignore comments; fail-open on registry outage |
| npm/PyPI rate limits | SQLite cache, concurrency cap, baseline embedded locally |
| Hook disabled by users (speed) | Perf budget as CI gate; `--quiet`; warm-path optimization |
| Name squat on `slopgate` npm package | Verify before publish; fallbacks `slopgate-cli` / `@slopgate/cli` |
| Windows git-bash hook quirks | POSIX-sh hook shim + Node entry; test matrix on Windows runner |
| Scope creep into "SAST" | Non-goals section in PRD; v2 features parked |

## Open questions

- Final npm package name (check availability first).
- Default for `python.unmapped-imports` (recommendation: `warn`).
- Cache location default: repo-local `.slopgate/` (recommended, per-project isolation) vs `~/.slopgate/`.

## Next build prompt

Hand to `03-agent-build-handoff.md`.
