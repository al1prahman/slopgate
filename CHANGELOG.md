# Changelog

All notable changes to slopgate are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.8] — 2026-11-03

### Fixed

- `secret.db-url` also skips bracket-wrapped placeholder passwords —
  `[YOUR-PASSWORD]`, `<your-password>`, `{YOUR_PASSWORD}` — which is how
  `.env.example` files ship them. Found auditing a real repo whose
  `.env.example` blocked the full-history scan with
  `postgresql://postgres.abc:[YOUR-PASSWORD]@aws-0-*.pooler.supabase.com`.
  A real credential on a real host still blocks.

## [1.0.7] — 2026-11-03

### Fixed

- `secret.db-url` no longer fires on placeholder passwords or loopback
  hosts. Found dogfooding: a CI fixture containing
  `postgresql://postgres:placeholder@localhost:5432/postgres` blocked a
  range scan of an otherwise clean repo. A database URL is now a finding
  only when it carries a real-looking credential to a real host — a
  placeholder password is not a credential, and a loopback host means the
  credential never leaves the machine.
- The pre-commit hook exits immediately when nothing is staged, instead of
  paying for node startup to scan zero files.

## [1.0.6] — 2026-11-03

### Fixed

- Secrets in UTF-16 files are no longer silently skipped. git reports
  UTF-16 text as binary ("Binary files ... differ", no numstat), so every
  scanner skipped it — and on Windows that is the default encoding for
  files written through PowerShell redirection or Notepad's "Unicode"
  save. New UTF-16 files are now decoded from the staged blob and scanned
  like any other text. Modified UTF-16 files remain skipped: git exposes
  no line structure to tell which lines are new.

## [1.0.5] — 2026-11-03

### Fixed

- The installed hooks now prefer `node_modules/.bin/slopgate` over the npx
  fallback. Found dogfooding in a real repo: warm commits measured 4s, and
  the scan itself was 82ms — the entire cost was `npx --yes`, which checks
  the registry on every invocation even when the package is installed
  locally. The local binary runs in ~0.2s. A hook that costs 4s per commit
  is a hook that gets `--no-verify`'d.
- The scaffolded `.slopgate.yml` no longer ships a `github.com/<you>`
  placeholder in its header comment.

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

[1.0.8]: https://github.com/al1prahman/slopgate/releases/tag/v1.0.8
[1.0.7]: https://github.com/al1prahman/slopgate/releases/tag/v1.0.7
[1.0.6]: https://github.com/al1prahman/slopgate/releases/tag/v1.0.6
[1.0.5]: https://github.com/al1prahman/slopgate/releases/tag/v1.0.5
[1.0.4]: https://github.com/al1prahman/slopgate/releases/tag/v1.0.4
[1.0.3]: https://github.com/al1prahman/slopgate/releases/tag/v1.0.3
[1.0.2]: https://github.com/al1prahman/slopgate/releases/tag/v1.0.2
[1.0.1]: https://github.com/al1prahman/slopgate/releases/tag/v1.0.1
[1.0.0]: https://github.com/al1prahman/slopgate/releases/tag/v1.0.0
