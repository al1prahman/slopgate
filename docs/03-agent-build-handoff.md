# slopgate — 03 Agent Build Handoff

Single-file build source of truth. Derived from `01-design-doc.md` + `02-implementation-spec.md`.

## Mission

Build `slopgate`: a TypeScript CLI distributed via npm that installs git hooks and blocks commits containing (a) secrets and (b) dependencies that do not exist in npm/PyPI — the slopsquatting class of AI-coding-agent mistakes.

## Product Vision

One command (`npx @al1prahman/slopgate init`) gives any repo a fast, local, free security gate tuned for agent-authored code. Findings are decisive (BLOCK/WARN with inline suggestions), the warm path is < 100 ms, and false positives are treated as product failures.

## User Experience Goals

- `npx @al1prahman/slopgate init` → hooks + config in < 3 s
- Bad commit: colored findings, one line each, suggestion inline, exit 2
- Clean commit: silent pass, < 2 s cold / < 100 ms warm
- `--json` and `--format sarif` for CI

## Non-Negotiable Requirements

- Only **added lines** from the diff are scanned; lockfiles are never dependency-checked
- Registry verdicts cached in SQLite (positive TTL 24 h, negative TTL 1 h)
- Registry outage ⇒ WARN, never BLOCK (fail-open on infrastructure, fail-closed on findings)
- Exit codes: 0 pass, 1 warn-only, 2 blocked
- No telemetry, no network beyond registry APIs
- Node ≥ 20, works on Windows (git-bash/PowerShell-spawned hooks), macOS, Linux

## Out of Scope (MVP)

Import scanning, typosquat similarity, GitHub Action, SARIF (build the reporter interface but ship pretty+json only), go/cargo/gem ecosystems, quarantine mode, MCP server, GUI, team/hosted features.

## Technical Architecture

- TypeScript CLI (`commander`), single package `slopgate`
- `git diff -U0` spawned once; added lines parsed in-process
- Detectors: `secrets.ts` (regex corpus + entropy heuristic), `deps.ts` (package.json/requirements.txt extractors)
- Registry clients behind a `RegistryClient` interface (npm, pypi) with shared SQLite cache (`better-sqlite3`)
- `similarity.ts` + embedded `data/baseline-*.txt` for suggestions (existence check first; similarity only for suggestions in MVP)
- `config.ts` loads `.slopgate.yml` (mode, ignores, allowlist, registries, custom-index)
- `report.ts`: pretty (TTY-colored) + json; `gate.ts` orchestrates and computes exit code
- Hook shims in `hooks/templates/` (POSIX sh calling `node <pkg>/dist/cli.js scan --staged --hook`)

## Data Model

See `02-implementation-spec.md` — `Finding`, `ScanResult`, `registry_cache` table.

## Database / Storage Recommendation

SQLite via `better-sqlite3`, repo-local `.slopgate/cache.db` (gitignored). Rationale: zero-ops, synchronous API keeps the hook fast, per-project isolation avoids cross-repo cache pollution. Override option: `~/.slopgate/cache.db` if the user prefers machine-wide caching.

## Hosting / Data Location / Deployment

Local-first; no server. Distribution: npm (OIDC trusted publishing from CI). CI: GitHub Actions on Node 20/22 × ubuntu + windows runners.

## Platform Targets

MVP: any OS with Node ≥ 20. CI: GitHub Actions ubuntu-latest + windows-latest.

## Technical Stack Recommendation

| Area | Choice |
|---|---|
| Language/runtime | TypeScript, Node ≥ 20 |
| CLI | commander |
| Cache | better-sqlite3 |
| Concurrency | p-limit (8) |
| Tests | vitest (+ msw/nock fixtures) |
| Lint | ESLint + Prettier |
| CI | GitHub Actions |
| Publish | npm, OIDC |

## Integrations

- npm registry API, PyPI simple index + JSON API (read-only)
- git (diff, rev-parse)
- GitHub Actions (v1, not MVP)

## Implementation Phases

1. **Skeleton** — package.json, tsconfig, commander CLI with `--help`, vitest green on a smoke test, CI pipeline.
2. **Diff layer** — `git diff -U0` extraction, added-lines parser, fixture tests (renames, binary, mode-change).
3. **Config** — `.slopgate.yml` load, defaults, glob ignore, inline ignore comments.
4. **Secrets** — regex corpus (AWS, GitHub, OpenAI, Anthropic, Stripe, Slack, private keys, DB URLs, generic assignments) + entropy warn-only; positive/negative fixture tests.
5. **Deps + registry** — package.json diff extractor, requirements.txt parser, npm + pypi clients, SQLite cache with TTL, offline mode.
6. **Similarity/suggestions** — Levenshtein, PEP 503 normalization, baseline data files, suggestion output.
7. **Report + gate** — pretty/json output, exit-code contract, `--quiet`.
8. **Hooks + init** — templates, `init` command (detect existing hooks, append vs create, husky detection), uninstall path.
9. **Polish** — README quick-start verification from `npm pack` tarball, e2e tests in temp repos, perf test, publish dry-run.

## Build Tasks

- [ ] Inspect repo conventions first; keep dependencies minimal (target ≤ 6 runtime deps)
- [ ] Write tests before each module (RED-GREEN-REFACTOR)
- [ ] `data/baseline-npm.txt` + `data/baseline-pypi.txt`: generate offline, commit as data (no network at runtime)
- [ ] `hooks/templates/pre-commit`: POSIX sh, resolve package root robustly (npm/yarn/pnpm, npx)
- [ ] `init` must be idempotent and never clobber an existing hook (append marker block instead)
- [ ] `.slopgate.yml` written with commented defaults on init
- [ ] e2e: temp repo, fake `reqeusts` dep → exit 2 with suggestion; fake `sk-ant-` key → exit 2; clean commit → exit 0
- [ ] perf: warm 500-file diff scan < 100 ms, asserted in CI

## Testing Requirements

- Unit: diff parser, requirements parser, package.json extractor, Levenshtein/normalization, secret corpus (TP + adversarial FP), config/globs, cache TTL (fake timers)
- Integration: registry clients vs recorded fixtures (no live network in CI)
- E2E: real git repos, real hook execution, exit codes asserted
- Perf: warm-path budget as a CI gate

## Verification Commands / Checks

```bash
npm run build
npm test                      # unit + integration + e2e
npm run lint
npm pack && npx ./slopgate-*.tgz --help
# manual:
cd /tmp/testrepo && npx <tarball> init
echo "reqeusts==1.0" >> requirements.txt && git add -A && git commit -m test ; echo "exit=$?"
```

## Acceptance Criteria

All items in `02-implementation-spec.md` → "Acceptance criteria / done means (MVP)".

## Done Means

- Tests + lint green on Node 20/22 × ubuntu/windows
- e2e proves BLOCK on hallucinated dep and on secret; exit 0 on clean commit
- Warm scan < 100 ms; cold < 2 s
- `npm pack` tarball self-installs and runs (`npx <tgz> init`)
- README quick-start verified end-to-end
- Dogfooded on 2 real repos, zero false blocks

## Known Risks

- Windows hook shim edge cases (path translation, core.hooksPath) — test matrix required
- npm scoped-name URL encoding (`@scope%2fname`)
- PyPI normalization corner cases (PEP 503)
- Registry flakiness in e2e — use recorded fixtures, never live calls

## Open Questions

- Final npm name (`slopgate` availability)
- Cache location default (recommendation: repo-local)
- `python.unmapped-imports` default (v1; recommendation: `warn`)

## Prompt for Build Agent

Inspect this repository first and preserve its conventions. Create a concise implementation plan from the phases above with exact files, tests, commands, and expected results. Implement **MVP scope only** — no v1/v2 features. Write tests before each module. Run the full verification suite and capture real output (exit codes, timings) before claiming done. If a registry API behaves unexpectedly, use fixtures and note it — never fabricate results.

## Superpowers Build Handoff

Use the `superpowers-gpt` workflow on this document:

1. `superpowers-using-superpowers` to route the work
2. `superpowers-writing-plans` to inspect the repo and turn this handoff into exact implementation tasks
3. `superpowers-executing-plans` or `superpowers-subagent-driven-development` to implement without scope drift
4. `superpowers-requesting-code-review` to review the implementation
5. `superpowers-verification-before-completion` to prove acceptance criteria before claiming completion
