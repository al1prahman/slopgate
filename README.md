# slopgate ☠️

**Stop your AI coding agent from shipping hallucinated dependencies and leaked secrets — before they reach git history.**

`slopgate` is a git-native security gate. It runs in your pre-commit hook, reads only the lines you are about to commit, and blocks the commit when it finds a package that does not exist or a credential that should not be there.

[![CI](https://github.com/al1prahman/slopgate/actions/workflows/ci.yml/badge.svg)](https://github.com/al1prahman/slopgate/actions)
[![npm version](https://img.shields.io/npm/v/@al1prahman%2Fslopgate.svg)](https://www.npmjs.com/package/@al1prahman/slopgate)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen.svg)](https://nodejs.org)

**Requires Node ≥ 22.13** (uses the built-in `node:sqlite` module — zero native dependencies). 296 tests green.

---

## Why this exists

AI coding agents write code fast. They also write *broken* code fast:

- **~19.7%** of AI-generated code samples reference packages that **do not exist** ([Cloud Security Alliance, 2026](https://labs.cloudsecurityalliance.org/research/csa-research-note-slopsquatting-ai-supply-chain-20260419-csa/)). Attackers register those exact hallucinated names to poison the next install. This is *slopsquatting*.
- Claude Code co-authored commits leak secrets at **~2× the baseline** across public GitHub ([GitGuardian, State of Secrets Sprawl 2026](https://www.gitguardian.com/state-of-secrets-sprawl-report-2026)).
- CVEs attributed to AI-generated code rose from **6 in January 2026 to 35 in March 2026** ([CSA / Georgia Tech Vibe Security Radar](https://labs.cloudsecurityalliance.org/research/csa-research-note-ai-generated-code-vulnerability-surge-2026/)).

The dangerous part is not that agents hallucinate — it is that a hallucinated package name *looks plausible*. `reqeusts` reads exactly like `requests`. A human reviewer skims past it. So the check has to be automatic, and it has to happen before the code lands.

Existing tools do not cover this. `gitleaks` and `trufflehog` find secrets but know nothing about dependency hallucination. Commercial supply-chain platforms are not git-native, not diff-scoped, and not free. `slopgate` fills that gap: one command, in your hook, blocking the commit.

---

## What it does

| Layer | Catches | Status |
|---|---|---|
| 🔑 Secret scan | API keys, tokens, private keys, DB URLs in added lines | ✅ |
| 📦 Slopsquat firewall | New deps that do not exist in npm/PyPI, or exist but are 1–2 edits from a popular name | ✅ |
| 🧭 Import scan | Hallucinated `import`/`require` statements in changed files (JS/TS + Python, alias-aware) | ✅ |
| 🤖 Agent-commit detection | Flags commits written by coding agents (`Co-Authored-By: Claude`, "Generated with") | ✅ |
| ⚙️ GitHub Action | SARIF annotations on the PR diff + a summary comment | ✅ |

### What a blocked commit looks like

```
$ git commit -m "add scraping deps"
slopgate: scanning 2 files, +34 -2 lines

  ✗ SECRET   src/fetch.ts:12    anthropic-api-key   ***...        [BLOCK]
  ✗ SLOP     requirements.txt:4 'reqeusts' not found on PyPI
                                → did you mean 'requests'?         [BLOCK]
  ⚠ SLOP     src/scrape.py:8    'beaufitulsoup' is 91% similar to
                                'beautifulsoup4' (registered 12 days ago)  [WARN]

commit blocked. 2 blocking findings.
  --no-verify to override (don't).
```

Exit codes: `0` clean · `1` warnings (non-blocking) · `2` blocked.

---

## What it supports (read this first)

**Secret scanning works on every stack** — it reads text, so the language does not matter. A leaked key in a `.php` file is caught exactly like one in a `.ts` file.

**Dependency and import checking is per-ecosystem, and only two are built:**

| Your stack | Secret scan | Dependency check | Import check |
|---|---|---|---|
| Node.js, React, Next.js, Vue, Svelte, Deno | ✅ | ✅ npm | ✅ JS/TS |
| Python — Django, FastAPI, Flask, scripts | ✅ | ✅ PyPI | ✅ Python (alias-aware) |
| PHP / Laravel / Symfony | ✅ | ❌ | ❌ |
| Java / Kotlin (Maven, Gradle) | ✅ | ❌ | ❌ |
| Go | ✅ | ❌ | ❌ |
| Rust | ✅ | ❌ | ❌ |
| Ruby | ✅ | ❌ | ❌ |
| .NET / C# | ✅ | ❌ | ❌ |

So: if you write Python or JavaScript/TypeScript, you get the full slopsquatting firewall. On any other stack you still get secret scanning, but hallucinated-package protection needs a resolver for that ecosystem — see [Roadmap](#roadmap).

---

## Quick start

**1. Install the hook** (run inside any git repo):

```bash
npx @al1prahman/slopgate init
```

That creates four things:

| File | Purpose |
|---|---|
| `.git/hooks/pre-commit` | Runs on every `git commit` |
| `.git/hooks/pre-push` | Runs on every `git push` |
| `.slopgate.yml` | Your configuration |
| `.slopgate/` in `.gitignore` | Local verdict cache (never committed) |

**2. Verify it is installed:**

```bash
ls .git/hooks/ | grep -v sample       # bash
Get-ChildItem .git/hooks | Where-Object { $_.Name -notlike '*.sample' }   # PowerShell
```

You should see `pre-commit` and `pre-push`.

**3. Commit as usual.** Nothing changes about your workflow:

```bash
git add .
git commit -m "feat: add retry logic"
```

If something is wrong, the commit is refused and the output tells you why. Fix it, `git add` again, commit again.

> **Heads up for teams:** hooks live in `.git/hooks/`, which git does not track. Every teammate runs `init` once. If you want it enforced for everyone automatically, use the [pre-commit framework](#pre-commit-framework) instead.

---

## Command reference

Everything the CLI can do:

```bash
# ── Setup ──────────────────────────────────────────────
npx @al1prahman/slopgate init        # install hooks + scaffold .slopgate.yml

# ── Scanning ───────────────────────────────────────────
slopgate scan --staged               # what the pre-commit hook runs
slopgate scan --range origin/main..HEAD   # scan a commit range
slopgate scan --range <root>..HEAD   # scan the whole history
slopgate scan --json                 # machine-readable output
slopgate scan --format sarif         # SARIF 2.1.0, for code-scanning upload
slopgate scan --mode warn            # downgrade blocks to warnings, this run only
slopgate scan --offline              # cache-only; registry misses warn (fail-open)

# ── Cache ──────────────────────────────────────────────
slopgate cache                       # stats: path, entries, size
slopgate cache clear                 # drop the local verdict cache
```

**PowerShell equivalents** (Windows):

```powershell
npx @al1prahman/slopgate scan --staged
npx @al1prahman/slopgate scan --range "HEAD~5..HEAD"
npx @al1prahman/slopgate scan --format sarif
npx @al1prahman/slopgate cache
```

**Finding your root commit** (for a full-history scan):

```bash
ROOT=$(git rev-list --max-parents=0 HEAD | head -1)
slopgate scan --range "$ROOT..HEAD"
```

**Reading a full-history scan** — this is the most useful thing you can run on a repo you just inherited:

```
slopgate: scanned 89 file(s), +11858 added line(s), 2405ms
  no findings.
clean. commit allowed.
```

---

## Configuration

`init` generates `.slopgate.yml`. Every option, annotated:

```yaml
mode: block                    # block | warn | off
                               #   block = refuse the commit (default)
                               #   warn  = report but allow
                               #   off   = disable entirely

secrets:
  enabled: true
  ignore: []                   # glob patterns to skip, e.g. '**/*.test.ts'

deps:
  enabled: true
  ecosystems: [npm, pypi]      # which registries to check
  registries:
    npm: https://registry.npmjs.org
    pypi: https://pypi.org/pypi
  custom-index: []             # reserved — parsed but not yet used (see Roadmap)
  allowlist: []                # package names you trust; never flagged
  quarantine: false            # reserved — not yet active (see Roadmap)
  typosquat:
    enabled: true              # warn on young look-alikes of popular packages
    max-distance: 2            # edits from a popular name (0–5)
    max-age-days: 90           # packages younger than this look seeded
  cache:
    positive-ttl-hours: 24     # how long an "exists" verdict is trusted
    negative-ttl-minutes: 60   # how long a "missing" verdict is re-checked

python:
  unmapped-imports: warn       # import names with no alias-table entry:
                               #   warn (default) | ignore | block

imports:
  enabled: true                # scan import statements, not just manifests

agent:
  enabled: true                # flag agent-authored commits in range scans
```

### Starting on an existing repo?

If your repo has history, start in `warn` mode for a week, collect the false positives, then switch to `block`. Turning on a gate that immediately blocks your team is how gates get disabled.

```yaml
mode: warn
```

---

## When it complains

**A single line** — inline comment:

```ts
const k = "sk-ant-api03-..."; // slopgate:ignore secret.anthropic-key
```

**A whole file or directory** — glob in config:

```yaml
secrets:
  ignore:
    - '**/*.test.ts'
    - '**/fixtures/**'
    - 'docs/examples/**'
```

**A package you trust** — allowlist:

```yaml
deps:
  allowlist:
    - my-internal-lib
```

**Emergency bypass** (it exists on purpose — the tool must not become a hostage):

```bash
git commit --no-verify
```

> **If you hit a false positive that is not one of the classes below, that is a bug.** Please report it with the exact line. False-positive tuning is where most of the work on this project goes, and real-world lines are the only way to find the remaining classes.

### False positives already fixed

Found by dogfooding on two real repositories — each of these once blocked a legitimate commit:

| Class | Example | Fixed in |
|---|---|---|
| Placeholder password in a DB URL | `postgres:***@localhost:5432/db` | 1.0.7 |
| Bracket-wrapped placeholder | `postgresql://postgres:***@pooler.supabase.com` | 1.0.8 |
| Config attribute read, not a literal | `api_key=settings.QDRANT_API_KEY` | 1.0.9 |
| Shell interpolation default | `${POSTGRES_PASSWORD:-curio_dev_password}` | 1.0.9 |
| Example env file value | `.env.example` | 1.0.9 |
| Lockfile hash soup | `uv.lock`, `package-lock.json`, `yarn.lock`, … | 1.0.9 |
| URL mistaken for a secret | `DATABASE_URL: str = "postgresql+asyncpg://…"` | 1.0.9 |

---

## GitHub Action

`.github/workflows/slopgate.yml` in any repo:

```yaml
name: slopgate
on: pull_request

permissions:
  contents: read
  pull-requests: write      # for the summary comment
  security-events: write    # for the SARIF upload

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0    # the action needs the base ref for the diff
      - uses: al1prahman/slopgate@v1
        with:
          mode: block       # or warn — never fails the PR, just comments
```

Findings land as inline annotations on the diff (via `github/codeql-action/upload-sarif`) and as one upserted comment on the PR.

**Inputs:** `range`, `mode` (`block`/`warn`/`off`), `comment` (`true`/`false`), `token`, `version`.
**Outputs:** `verdict` (`pass`/`warn`/`block`).

---

## pre-commit framework

If your team already uses [pre-commit](https://pre-commit.com), nobody needs to run `init` — the framework installs the hook for everyone. `.pre-commit-hooks.yaml` ships in this repo:

```yaml
repos:
  - repo: https://github.com/al1prahman/slopgate
    rev: v1.0.9
    hooks:
      - id: slopgate          # pre-commit: scans staged changes
      - id: slopgate-push     # pre-push: scans the pushed range
```

---

## How it works

```
git diff (staged / range / PR)
        │
        ▼
  added-lines only ──► secret detector ──► findings
        │
        ├──► dependency extractor ──► registry existence check ──► similarity check
        │                                      │                          │
        │                                SQLite cache            popular-package baseline
        │
        └──► import extractor ──► (alias table for Python) ──► same registry check
                                               │
                                         report ──► exit code (block / warn / pass)
```

Four rules keep it fast and quiet:

1. **Diff-scoped** — only added lines are scanned. Lockfiles are never dependency-checked; they are hash soup, and 25 entropy warnings on a `uv.lock` help nobody.
2. **Cache-first** — every registry verdict is cached in local SQLite with a TTL. A warm pre-commit run does no network I/O at all.
3. **Fail-open on registry outage** — if npm/PyPI is unreachable you get a warning, not a blocked commit. A gate that becomes a hostage is a gate that gets disabled.
4. **Alias-aware, never guessing** — Python imports resolve through a curated alias table (`bs4` → `beautifulsoup4`). A name with no entry is checked as-is and only *warns* when unknown, because the mapping might simply be missing.

---

## Pros and cons

### Why you might want it

- **Covers an attack class nothing else in the git-hook space does.** Secrets scanners do not check dependency existence; SCA tools check what is already installed, not what you are about to add.
- **Zero native dependencies.** `node:sqlite` is built in, so there is no compile step. `npx` it and go.
- **Fast enough that people keep it on.** Empty commits short-circuit before the scanner starts; a warm real commit is ~1.2s on Windows, and the scan itself is 40–120ms.
- **Fail-open.** An unreachable registry never blocks your work.
- **Fits existing workflows.** Git hooks, the pre-commit framework, or a GitHub Action — same config file.
- **Actually tested against reality.** 296 automated tests, plus 14 bugs found and fixed by dogfooding on two real repositories.

### Why you might not

- **Dependency checking covers npm and PyPI only.** On PHP, Go, Rust, Ruby, Java or .NET you get secret scanning and nothing else.
- **It needs the network.** Fail-open is the right default, but it also means someone who can block your registry access can bypass the dependency check.
- **It is not an SCA scanner.** No CVE matching, no version-vulnerability analysis, no license checks. Different job.
- **Secret detection is heuristic.** Seven false-positive classes have been found and fixed; there will be more. Expect to tune.
- **Commits cost ~1.2s on Windows.** That is Node startup on a network-synced filesystem, not the scan — but it is the number you feel.
- **Single maintainer, young project.** No policy server, no team dashboard, no enterprise support.

---

## Limitations (the honest list)

- **Only added or changed lines are scanned.** A hallucinated dependency already sitting in your history is not caught by the hook. Run `scan --range <root>..HEAD` to find those.
- **Lockfiles are deliberately skipped** for dependency checking.
- **Binary files are skipped**, except UTF-16 files, which are hydrated from the staged blob (git reports them as binary, which used to hide secrets written by PowerShell's `Out-File`).
- **Unmapped Python imports warn, they do not block** — the identity mapping would be a guess.
- **Agent detection only applies to range scans.** A staged scan has no commit message yet.
- **`custom-index` and `quarantine` are parsed but not yet wired up.** They are reserved for v2 and do nothing today.

---

## Performance

Measured, not estimated:

| Scenario | Time |
|---|---|
| Empty commit (short-circuit, no scan) | 0.35s |
| Real commit, Node repo, warm cache | ~1.2s |
| Real commit, Python repo via `npx` (no `node_modules/`) | ~5.2s |
| The scan itself, typical staged change | 40–120ms |
| Full history, 89 files / 11,858 added lines, cold | 2.8s |
| Same, warm | 0.7s |

The gap between "real commit" and "the scan itself" is Node process startup. On a Python repo with no `node_modules/`, the hook falls back to `npx`, which adds a few seconds. If that bothers you:

```bash
npm install -g @al1prahman/slopgate
```

The hook checks `command -v slopgate` *before* trying `npx`, so a global install takes the fast path.

---

## Development

```bash
git clone https://github.com/al1prahman/slopgate.git
cd slopgate
npm install
npm test              # 296 tests
npm run lint
npm run typecheck
npm run build
```

Useful while working on it:

```bash
npm test -- --watch          # re-run on change
npm test -- test/unit/secrets.test.ts   # one file
npx vitest run -t "lockfiles"          # one test by name
```

The project holds itself to the same gates it enforces on you: coverage ≥ 80% on `src/`, and a warm 500-file scan must stay under 100ms.

---

## Contributing

PRs welcome. The most valuable contributions, in order:

1. **False-positive reports with the exact line.** A real line from a real repo that got blocked wrongly is worth more than any feature request. Open an issue with the line, the file type, and which rule fired.
2. **False-negative reports.** A hallucinated dependency or a real secret that slipped through. Same deal — the exact line.
3. **New ecosystem resolvers.** Go, Rust, Ruby, PHP, Java, .NET. Each needs a manifest parser and a registry client; the npm and PyPI ones are the template.
4. **Bug fixes and tests.** Tests first (RED, then GREEN), one rule per lesson.

Before opening a PR:

```bash
npm test && npm run lint && npm run typecheck
```

The spec lives in [`docs/`](docs/) — `01-design-doc.md` is the product PRD, `02-implementation-spec.md` is the engineering plan, `03-agent-build-handoff.md` is the agent-ready build source of truth.

---

## Roadmap

- **v1 (shipped)** — secret scanning · dependency existence checks (npm + PyPI) · import scanning (JS/TS + Python) · typosquat warnings · GitHub Action + SARIF · agent-commit detection · cache TTL controls · `pyproject.toml` support · `.pre-commit-hooks.yaml`
- **v2 (planned)** — `go.mod` / `Cargo.toml` / `Gemfile` / `composer.json` resolvers · registry-metadata risk scoring · quarantine mode · MCP server so agents can self-check before committing

---

## License

[MIT](LICENSE)
