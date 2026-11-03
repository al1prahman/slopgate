# slopgate — 00 Idea Capture

Status: Full mode, UI stage skipped (CLI tool)
Captured: 2026-11-02
Owner: Alip

## Raw idea

A git hook + CI gate that scans **agent-authored diffs** and blocks two classes of damage:
1. Secrets committed by AI coding agents.
2. **Hallucinated package names** — dependencies that don't exist in the registry, which attackers deliberately register (slopsquatting).

## Origin / timing data

- Cloud Security Alliance (Apr 2026): across 2.23M AI-generated code samples from 16 models, **19.7%** contained at least one hallucinated package name.
- GitGuardian (2026): Claude Code-assisted commits exposed secrets **>2× more often** than human-only commits.
- CVEs attributed to AI-generated code: **6 (Jan 2026) → 35 (Mar 2026)**.

## Why now

Vibe coding (Claude Code, Codex, OpenClaw, Cursor) is mainstream. The security tooling around it is generic (secret scanners) or commercial (supply-chain platforms). A git-native, diff-scoped, free gate that understands *dependency hallucination* is an open slot.

## Initial scope intuition

- One command install: `npx @al1prahman/slopgate init`
- Runs in `pre-commit` / `pre-push` / GitHub Action
- Must be fast (< 2 s warm) or people will disable the hook
- MVP ecosystems: npm + PyPI
- OSS from day one (MIT), hosted tier later at most

## Non-goals (early)

- Not a replacement for gitleaks/trufflehog (complement them)
- Not a full SAST/DAST scanner
- No GUI in MVP
- No agent telemetry / no phone-home

## Open questions

- npm name `slopgate` availability (fallback: `slopgate-cli`, `@slopgate/cli`)
- Python import→package mapping strategy (alias table vs runtime resolution)
- Private registry auth support timing
