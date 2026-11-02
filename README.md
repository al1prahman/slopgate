# slopgate ☠️

**Stop your AI coding agent from shipping hallucinated dependencies and leaked secrets.**

`slopgate` is a git-native security gate built for the vibe-coding era. It scans agent-authored diffs *before* they land — blocking package names that don't exist (slopsquatting) and credentials that shouldn't be committed.

[![CI](https://github.com/<you>/slopgate/actions/workflows/ci.yml/badge.svg)](https://github.com/<you>/slopgate/actions)
[![npm version](https://img.shields.io/npm/v/slopgate.svg)](https://www.npmjs.com/package/slopgate)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **Status:** MVP complete — all 9 build phases done, 170+ tests green, published to npm pending. Requires Node ≥ 22.13 (uses the built-in `node:sqlite` module — zero native dependencies).

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
| 🧭 Import scan | Hallucinated `import`/`require` statements in changed files | v1 |
| 🤖 Agent-diff targeting | Extra scrutiny on agent-authored commits | v1 |

## Quick start

```bash
# inside any repo
npx slopgate init

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
python:
  unmapped-imports: warn   # import names with no known package mapping
```

Manual scans:

```bash
slopgate scan --staged        # what pre-commit runs
slopgate scan --range origin/main..HEAD
slopgate scan --json          # machine-readable
slopgate scan --offline       # cache-only; registry misses warn (fail-open)
slopgate cache                # cache stats (path, entries, size)
slopgate cache clear          # drop the local verdict cache
```

## How it works

```
git diff (staged / range / PR)
        │
        ▼
  added-lines only ──► secret detector ──► findings
        │
        └──► dependency extractor ──► registry existence check ──► similarity check
                                              │                          │
                                        SQLite cache            popular-package baseline
                                              ▼                          ▼
                                        report ──► exit code (block / warn / pass)
```

Three design rules keep it fast and quiet:

1. **Diff-scoped** — only added lines are scanned; lockfiles are never dependency-checked.
2. **Cache-first** — every registry verdict is cached in local SQLite; a warm pre-commit run is < 100 ms.
3. **Fail-open on registry outage** — if npm/PyPI is unreachable, warn instead of blocking your commit.

## Roadmap

- **MVP** — git hook + secret scan + dependency existence check (`package.json`, `requirements.txt`) + typosquat warnings, CLI, config
- **v1** — import scanning (JS/Python), GitHub Action + SARIF, cache TTL controls
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
