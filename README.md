# slopgate ☠️

**Stop your AI coding agent from shipping hallucinated dependencies and leaked secrets.**

`slopgate` is a git-native security gate built for the vibe-coding era. It scans agent-authored diffs *before* they land — blocking package names that don't exist (slopsquatting) and credentials that shouldn't be committed.

[![CI](https://github.com/al1prahman/slopgate/actions/workflows/ci.yml/badge.svg)](https://github.com/al1prahman/slopgate/actions)
[![npm version](https://img.shields.io/npm/v/@al1prahman%2Fslopgate.svg)](https://www.npmjs.com/package/@al1prahman/slopgate)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **Status:** MVP + import scanning + typosquat warnings + GitHub Action/SARIF + agent-commit detection done — 252 tests green, [published to npm](https://www.npmjs.com/package/@al1prahman/slopgate). Requires Node ≥ 22.13 (uses the built-in `node:sqlite` module — zero native dependencies).

---

## Why this exists

AI coding agents write code fast. They also write *broken* code fast:

- **~19.7%** of AI-generated code samples reference packages that **do not exist** (Cloud Security Alliance, 2026) — attackers register those exact hallucinated names to poison the next install. This is *slopsquatting*.
- Claude Code-assisted commits expose secrets **more than 2× as often** as human-only commits (GitGuardian, 2026).
- CVEs formally attributed to AI-generated code jumped from **6 in January 2026 to 35 in March 2026**.

Existing tools don't cover this: `gitleaks`/`trufflehog` find secrets generically but know nothing about dependency hallucination. Commercial supply-chain platforms exist but aren't git-native, diff-scoped, or free. `slopgate` fills exactly that gap: one command, runs in your hook, blocks the commit.

## What it does

| Layer | Catches | MVP |
|---|---|---|
| 🔑 Secret scan | API keys, tokens, private keys, DB URLs in added lines | ✅ |
| 📦 Slopsquat firewall | New deps that don't exist in npm/PyPI, or exist but are 1-2 edits from a popular name | ✅ |
| 🧭 Import scan | Hallucinated `import`/`require` statements in changed files (JS/TS + Python, alias-aware) | ✅ |
| 🤖 Agent-commit detection | Flags commits written by coding agents (`Co-Authored-By: Claude`, "Generated with") | ✅ |
| ⚙️ GitHub Action | SARIF annotations on the PR diff + a summary comment | ✅ |

## Quick start

```bash
# inside any repo
npx @al1prahman/slopgate init

# commit as usual — the hook does the rest
git commit -m "add fetch util"
```

What a bad commit looks like:

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

## Configuration

`init` generates `.slopgate.yml`:

```yaml
mode: block                # block | warn | off
secrets:
  enabled: true
  ignore:
    - '**/*.test.*'
deps:
  enabled: true
  ecosystems: [npm, pypi]
  registries:
    npm: https://registry.npmjs.org
    pypi: https://pypi.org/pypi
  custom-index: []         # internal registries to check first
  allowlist: []            # trusted internal package names
  quarantine: false        # hold installs instead of blocking commit
  typosquat:
    enabled: true          # warn on young look-alikes of popular packages
    max-distance: 2        # edits from a popular name (0-5)
    max-age-days: 90       # packages younger than this look seeded
  cache:
    positive-ttl-hours: 24    # how long an "exists" verdict is trusted
    negative-ttl-minutes: 60  # how long a "missing" verdict is re-checked
python:
  unmapped-imports: warn   # import names with no known package mapping
imports:
  enabled: true            # scan import statements, not just manifests
agent:
  enabled: true            # flag agent-authored commits in range scans
```

Manual scans:

```bash
slopgate scan --staged        # what pre-commit runs
slopgate scan --range origin/main..HEAD
slopgate scan --json          # machine-readable
slopgate scan --format sarif  # SARIF 2.1.0 for code scanning upload
slopgate scan --mode warn     # downgrade blocks to warnings for this run
slopgate scan --offline       # cache-only; registry misses warn (fail-open)
slopgate cache                # cache stats (path, entries, size)
slopgate cache clear          # drop the local verdict cache
```

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

Findings land as inline annotations on the diff (via `github/codeql-action/upload-sarif`) and as one upserted comment on the PR. Inputs: `range`, `mode`, `comment`, `token`, `version`.

## Agent-authored commits

Range scans (`--range`, pre-push hook, the GitHub Action) read the commit messages in scope and flag the ones written by a coding agent — the `Co-Authored-By: Claude <noreply@anthropic.com>` trailer, the `🤖 Generated with Claude Code` footer, and the equivalents from Cursor, Copilot, Codex, Gemini, Devin and aider:

```
slopgate: scanned 3 file(s), +42 added line(s), 38ms
  agent-authored commit (🤖 Generated with Claude Code) — extra scrutiny applied
  ⚠ dep.typosquat  requirements.txt:7  [WARN]
      "expres" exists but is 1 edit(s) from popular "express" and only 3 day(s) old — probable typosquat
1 warning(s). commit allowed.
```

The signal is informational: it never changes the verdict on its own. It tells a reviewer that machine-speed code landed in this diff, so the findings above it deserve a harder look. Full marker list rides along in `--format json` and in the SARIF run's property bag. Staged scans have no commit message yet, so the heuristic only applies to range scans. Disable with `agent: { enabled: false }`.

## pre-commit framework

`.pre-commit-hooks.yaml` ships in the repo, so framework users need no local install:

```yaml
repos:
  - repo: https://github.com/al1prahman/slopgate
    rev: v1.0.1
    hooks:
      - id: slopgate          # pre-commit: scans staged changes
      - id: slopgate-push     # pre-push: scans the pushed range
```

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

Three design rules keep it fast and quiet:

1. **Diff-scoped** — only added lines are scanned; lockfiles are never dependency-checked.
2. **Cache-first** — every registry verdict is cached in local SQLite; a warm pre-commit run is < 100 ms.
3. **Fail-open on registry outage** — if npm/PyPI is unreachable, warn instead of blocking your commit.
4. **Alias-aware, never guessing** — Python imports resolve through a curated alias table (`bs4` → `beautifulsoup4`); names with no entry are checked as-is and only *warn* when unknown, because the mapping might simply be missing.

## Roadmap

- **MVP** — git hook + secret scan + dependency existence check (`package.json`, `requirements.txt`) + typosquat warnings, CLI, config
- **v1** — ✅ import scanning (JS/Python) · ✅ typosquat warnings · ✅ GitHub Action + SARIF · ✅ agent-commit detection · ✅ cache TTL controls · ✅ `.pre-commit-hooks.yaml`
- **v2** — `go.mod` / `Cargo.toml` / `Gemfile`, registry-metadata risk scoring, quarantine mode, MCP server (agents self-check before commit)

## Contributing

PRs welcome. The spec lives in [`docs/`](docs/) — `01-design-doc.md` is the product PRD, `02-implementation-spec.md` is the engineering plan, `03-agent-build-handoff.md` is the agent-ready build source of truth.

```bash
git clone <repo>
cd slopgate
npm install
npm test
```

## License

[MIT](LICENSE)
