# Changelog

All notable changes to slopgate are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.4] — 2026-11-03

### Fixed

- The installed git hooks now resolve slopgate over `npx --yes
  @al1prahman/slopgate` instead of `npx --no-install slopgate`. The old
  fallback failed outright in the exact state the documented quick start
  leaves behind — `npx slopgate init` in a repo that does not depend on
  slopgate — blocking every commit with an npx error. The scoped name
  resolves a local devDependency first and the registry second, and a
  new e2e test exercises that path for real (no shim, no local install).

## [1.0.3] — 2026-11-03

### Fixed

- The GitHub Action now fetches the PR base ref before diffing against
  it. `actions/checkout` with `fetch-depth: 0` does not guarantee
  `origin/<base>` exists on `pull_request` events, so the default range
  could resolve to nothing and every PR would scan as silently clean.

### Added

- `action-smoke.yml` runs `action.yml` through the real `uses:` path on
  every push to main — the published action had never been executed
  end-to-end before.
- package.json metadata (`repository`, `homepage`, `bugs`, `author`) so
  the npm page links back to the repo.

## [1.0.2] — 2026-11-03

### Fixed

- `slopgate init` now appends `.slopgate/` to `.gitignore` (creating the
  file when absent, idempotently). Without it the verdict cache showed up
  as untracked noise in every consumer repo the day after install.

## [1.0.1] — 2026-11-03

### Fixed

- `--version` and the SARIF driver version reported a stale `0.1.0` in the
  1.0.0 tarball: the version was a hardcoded literal in `src/version.ts`
  that the release bump missed. It is now derived from `package.json` at
  import time, so the two can never drift again. 1.0.0 is deprecated on npm.

## [1.0.0] — 2026-11-02

First release. A git-native security gate that blocks AI coding agents from
committing hallucinated dependencies (slopsquatting) and leaked secrets, in
one command. Node ≥ 22.13, zero native dependencies (built-in `node:sqlite`).

Published as **`@al1prahman/slopgate`** (scoped — the unscoped `slopgate`
name is blocked by npm's similarity policy against the existing `slop-gate`
package). The installed command stays `slopgate`.

### Added

- **Secret scanning** on added lines only — provider key patterns (Anthropic,
  OpenAI, GitHub, AWS, …), private-key headers, database URLs, JWTs,
  high-entropy assignments — with inline `slopgate:ignore` suppression and
  glob-based ignore config.
- **Dependency existence checking** for `package.json` and `requirements.txt`
  against the live npm and PyPI registries, with "did you mean …?"
  suggestions from an embedded popular-package baseline. Fail-open on
  registry outage (warn, never block on unreachable infrastructure).
- **Import scanning** — hallucinated `import`/`require` statements in changed
  JS/TS and Python files, checked through the same registry clients, cache,
  allowlist and typosquat rules as manifest dependencies. Python module
  names resolve through a curated alias table (`bs4` → `beautifulsoup4`,
  `cv2` → `opencv-python`, …); stdlib modules are skipped; unmapped names
  warn rather than block.
- **Typosquat warnings** — a package that exists but is ≤ 2 edits from a
  popular baseline name and younger than 90 days warns as `dep.typosquat`.
  Registry metadata is fetched on demand only for flagged names.
- **Agent-commit detection** — range scans flag commits written by coding
  agents (`Co-Authored-By: Claude`, `🤖 Generated with …`) as an
  informational banner; the verdict never changes on this signal alone.
- **GitHub Action** (`action.yml`) — composite action that scans a PR range,
  uploads SARIF for inline diff annotations, upserts one summary comment,
  and fails the job only on blocking findings.
- **SARIF 2.1.0 reporter** (`--format sarif`) for
  `github/codeql-action/upload-sarif`.
- **pre-commit framework adapter** (`.pre-commit-hooks.yaml`) — `slopgate`
  on pre-commit and `slopgate-push` on pre-push.
- **Local verdict cache** in SQLite with configurable TTLs
  (`deps.cache.positive-ttl-hours`, `deps.cache.negative-ttl-minutes`),
  batched reads and writes — a warm 500-file scan stays under 100 ms.
- **CLI** — `init` (hooks + config scaffold), `scan` (`--staged`,
  `--range`, `--format pretty|json|sarif`, `--mode block|warn|off`,
  `--offline`, `--quiet`), `cache stats|clear`.
- Exit codes: 0 clean, 1 warnings, 2 blocked.

[1.0.4]: https://github.com/al1prahman/slopgate/releases/tag/v1.0.4
[1.0.3]: https://github.com/al1prahman/slopgate/releases/tag/v1.0.3
[1.0.2]: https://github.com/al1prahman/slopgate/releases/tag/v1.0.2
[1.0.1]: https://github.com/al1prahman/slopgate/releases/tag/v1.0.1
[1.0.0]: https://github.com/al1prahman/slopgate/releases/tag/v1.0.0
