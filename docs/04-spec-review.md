# slopgate — 04 Spec Review

Verdict: **PASS WITH CHANGES**

## Summary

The package is build-ready: product goal is sharp, MVP scope is fenced by explicit non-goals, technical defaults are decided, and acceptance criteria are testable. Three items must be resolved before or during Phase 1 — none block starting.

## Readiness Checklist

- [x] Product goal is clear
- [x] Requirements are testable (F1–F8 map to concrete assertions)
- [x] Product decisions are resolved or explicitly listed
- [x] Technical decisions are resolved or explicitly listed
- [x] Storage recommendation present (SQLite, repo-local, override noted)
- [x] Technical defaults documented with rationale
- [x] Acceptance criteria are concrete (exit codes, timing budgets, fixture cases)
- [x] Done Means is specific
- [x] A fresh agent could build from `03-agent-build-handoff.md` without obvious missing context
- [x] Testing requirements are included (unit/integration/e2e/perf)
- [x] Verification commands/checks are included
- [x] Non-goals prevent likely scope creep (no SAST, no GUI, no telemetry)

## Required Changes Before Build

1. **Verify npm name `slopgate` availability before Phase 9 publish work** — if taken, switch all docs to the fallback (`slopgate-cli` or `@slopgate/cli`) *before* writing hook templates that hardcode the package path.
2. **Decide cache location default** — spec recommends repo-local `.slopgate/cache.db`; the handoff records it as a recommendation. Confirm in Phase 5 before implementing the cache module.
3. **Windows hook testing must be in the CI matrix from Phase 1** — the spec names git-bash/PowerShell hook quirks as a known risk; adding `windows-latest` to CI on day one avoids a late-stage rewrite of the hook shims.

## Optional Improvements

- Add a `pre-commit` framework adapter (`.pre-commit-hooks.yaml`) in v1 for users who already use pre-commit.
- Ship an `examples/` repo with a deliberately bad commit for demo/testing.
- Consider a `--fix` mode later (auto-remove a blocked dep from the manifest) — parked, not MVP.

## Superpowers Handoff Recommendation

**PASS WITH CHANGES** — the three required changes are Phase 1 housekeeping, not design gaps. Feed `03-agent-build-handoff.md` to Superpowers with the changes folded in: name verification as the first build task, cache-location confirmation before Phase 5, and Windows CI from the first commit.
