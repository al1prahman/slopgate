# slopgate — 01 Design Doc (PRD)

Version: 1.0 · Date: 2026-11-02 · Status: Draft for implementation

## One-line summary

A git-native security gate that blocks AI coding agents from committing hallucinated dependencies (slopsquatting) and leaked secrets, in one command.

## Problem / purpose

Vibe-coding agents generate dependencies and credentials at machine speed with machine-grade error rates. A hallucinated package name is not a typo — it is a registered attack vector, because attackers seed registries with the names models predictably invent. Meanwhile agent-assisted commits leak secrets at 2× the human rate. Developers have no fast, free, local tool that catches *both* classes at commit time, scoped to exactly the lines an agent wrote.

## Product philosophy

1. **Block, don't nag.** Findings must be decisive: BLOCK or WARN, with the fix inline (`did you mean 'requests'?`).
2. **Fast or dead.** A pre-commit hook that takes > 2 s gets disabled with `--no-verify`. Speed is a feature.
3. **Diff-scoped.** Only added lines. Lockfiles are never dependency-checked. Context and deleted lines are noise.
4. **Fail-open on infrastructure, fail-closed on findings.** Registry outage warns; a real finding blocks.
5. **Zero config to start.** `npx @al1prahman/slopgate init` and done. Config exists for suppression, not for setup.

## Target user

- **Primary:** solo devs / small teams shipping with AI coding agents (Claude Code, Codex, Cursor, OpenClaw).
- **Secondary:** teams that need a cheap supply-chain gate in CI before a commercial platform is justified.
- **Tertiary (contributors):** OSS-minded devs who want a portfolio-grade dev-tool project.

## Core concept

`slopgate` sits between the agent and git. Every commit diff passes through two detectors — secrets and dependencies — each verdict cached locally, then reported as an exit code the hook enforces.

## Desired behavior

1. `npx @al1prahman/slopgate init` installs hooks and writes `.slopgate.yml` in under 3 s.
2. On commit: extract added lines → run detectors → print findings → exit 0/1/2.
3. A dependency that does not exist in the registry is **blocked** with the nearest real package suggested.
4. A dependency that exists but is ≤ 2 edits from a popular package and younger than 90 days is **warned** as a probable typosquat.
5. Secrets matching known provider formats are **blocked**; allowlisted via inline comment or config.
6. Warm re-runs complete in < 100 ms from cache.
7. `--json` and SARIF outputs make CI integration first-class.

## Key features

### P0 (MVP)

- F1 Pre-commit + pre-push hooks (staged diff / range diff)
- F2 Secret detection: AWS, GitHub, OpenAI, Anthropic, Stripe, Slack, private keys, DB URLs, generic assignment patterns, entropy heuristic (warn-only)
- F3 Dependency existence check on changed `package.json` and `requirements.txt`
- F4 Suggestion engine (nearest existing package) on blocked deps
- F5 `.slopgate.yml` config: mode, ignore globs, allowlist, custom registries
- F6 CLI: `init`, `scan --staged`, `scan --range`, `--json`, cache management
- F7 SQLite registry cache with TTL + negative caching
- F8 Exit-code contract (0/1/2) and `--no-verify` override notice

### P1 (v1)

- F9 Import-statement scanning (JS/TS `import`/`require`, Python `import`/`from`)
- F10 Typosquat similarity check against embedded popular-package baseline
- F11 GitHub Action: PR comment + SARIF upload
- F12 Agent-commit heuristic (Co-Authored-By, "Generated with" markers) for reporting/risk score

### P2 (v2)

- F13 `go.mod`, `Cargo.toml`, `Gemfile` support
- F14 Registry-metadata risk scoring (age, downloads, maintainer count)
- F15 Quarantine mode (hold install instead of blocking commit)
- F16 MCP server so coding agents self-check before committing

## UX / CLI notes

This is a CLI; UX = output discipline:

```
slopgate: scanning 2 files, +34 -2 lines

  ✗ SECRET   src/fetch.ts:12    anthropic-api-key   ***...        [BLOCK]
  ✗ SLOP     requirements.txt:4 'reqeusts' not found on PyPI
                                → did you mean 'requests'?         [BLOCK]

commit blocked. 2 blocking findings.
```

- One line per finding: severity glyph, file:line, rule, message, suggestion.
- Summary line with counts and the override hint.
- Colors when TTY; plain when piped; never break `--json` parsing.
- `--quiet` prints only the verdict line.

## Technical shape

- TypeScript / Node CLI (single npm package, ships as `slopgate`)
- Modules: diff parser → detectors (secrets, deps) → registry clients (npm, PyPI) → similarity engine → policy/config → reporters (pretty/json/sarif) → gate orchestrator
- Storage: local SQLite (`~/.slopgate/cache.db` or repo-local `.slopgate/cache.db`), TTL-based
- Embedded data: popular-package baseline (top ~1000 npm + ~1000 PyPI names), Python import-alias table, secret regex corpus
- No network beyond registry APIs; no telemetry

## Data / integrations

- Inputs: `git diff` output, dependency files, import statements, `.slopgate.yml`
- External: `registry.npmjs.org`, `pypi.org/simple` + `pypi.org/pypi/<name>/json`
- Integrations: git hooks, GitHub Actions, (v2) MCP

## Hosting / data location

Local-first. No server in MVP. Distribution via npm + GitHub. Cache stays on the developer's machine. (Future hosted tier, if any, would be team policy/dashboard only — explicitly not required for the product to work.)

## Platform targets

- MVP: any OS with Node ≥ 20 (Windows/macOS/Linux) — must work in git-bash, WSL, and PowerShell-spawned hooks
- CI: GitHub Actions (Linux runner)
- Future: GitLab CI template, pre-commit framework adapter

## Recommended technical defaults (accepted)

| Area | Default | Why |
|---|---|---|
| Language | TypeScript (Node ≥ 20) | git-hook ecosystem, npm distribution, Alip's stack |
| CLI framework | `commander` | boring, tiny, universal |
| Cache | `better-sqlite3` | sync, fast, zero-ops |
| Tests | `vitest` | Alip's existing convention |
| Lint/format | ESLint + Prettier | standard |
| CI | GitHub Actions | where the users are |
| Diff parsing | spawn `git diff -U0`, parse in-process | no deps, full control |

## Non-goals

- Not replacing gitleaks/trufflehog — complements them (we block deps; they deep-scan history)
- Not a SAST engine (no code vuln analysis beyond secrets)
- Not a malware scanner of installed packages (that's GuardDog/Socket territory)
- No GUI, no dashboard in MVP
- No telemetry / analytics / phone-home
- No support for non-git VCS

## Success criteria

- `npx @al1prahman/slopgate init` → hook active in < 3 s
- Commit with hallucinated dep in `requirements.txt` → blocked with correct suggestion
- Commit with `sk-ant-...` → blocked
- Clean commit passes in < 2 s cold, < 100 ms warm
- 100+ GitHub stars within 3 months of launch
- Author uses it daily on his own repos (dogfood standard)

## Open questions

- npm package name availability (`slopgate` vs fallbacks)
- Python unmapped-import policy default (`warn` vs `ignore`) — affects false-positive rate
- Whether to ship a pre-commit-framework `.pre-commit-hooks.yaml` in v1

## Next steps

- Proceed to `02-implementation-spec.md` (phases, tasks, tests)
- Then `03-agent-build-handoff.md` as the single build source of truth
