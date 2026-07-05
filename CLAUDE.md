# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

NotebookLM Porter — a Chrome MV3 extension (WXT + Preact) that ports YouTube playlists
and web threads (X/Twitter, Hacker News, Reddit) into Google NotebookLM as clean,
structured sources. Full design + rationale: `@docs/superpowers/specs/2026-07-06-notebooklm-porter-design.md`.

## Commands

- Package manager is **bun** (never npm/npx). Install: `bun install`.
- `bun run dev` — WXT dev server (loads the unpacked extension).
- **`bun run check`** — the full gate: fmt-check + oxlint + wxt prepare + tsgo typecheck +
  vitest + production build. Run this before considering any change done.
- Single test file: `bunx vitest run src/core/adapters/reddit/parse.test.ts`.

## Conventions Claude gets wrong by default

- **Use WXT's typed `browser` global, NOT `chrome`.** It's auto-imported in entrypoints;
  do not `import` it and do not write `chrome.*`. `defineBackground` / `defineContentScript`
  are likewise WXT auto-imports.
- Formatting is **oxfmt**: 2-space indent, single quotes, **no semicolons**, trailing
  commas, always-parens arrows. Lint is **oxlint** (`bun run fmt` / `bun run lint`).
- **Strict TS with `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`.** Guard all
  array/object index access. For optional fields, **omit the key** via conditional spread
  (`...(x !== undefined ? { x } : {})`) — never assign `undefined` to an optional property.

## Architecture

Capture pipeline with clean seams: **adapters** (per-site capture) → **formatters**
(render Markdown/JSONL) → **ingest** (deliver to NotebookLM). The dependency spine is
`src/core/`; `src/entrypoints/` (background SW, content scripts, popup) is thin glue.

- `src/core/adapters/registry.ts` is the **single source of truth** for platforms.
  `wxt.config.ts` derives all `host_permissions` from it — never hand-edit the manifest
  to add a site; add a `SourceAdapter` and one registry entry.
- Per adapter: **`parse.ts` is a pure function** (network JSON → domain model, fully
  unit-tested against frozen fixtures); **`capture.ts` is a thin fetch wrapper** that runs
  in the background service worker (CORS-exempt — content scripts can't fetch these APIs).
- `src/core/**` is pure and unit-tested; entrypoints are exercised by the real extension,
  not unit tests. Keep new business logic in `src/core/**` so it stays testable.
- NotebookLM ingest is **RPC-first, layered** (Tier A internal `batchexecute` RPC from the
  SW → Tier B DOM automation → Tier C file export). See the spec §4 before touching ingest.

## Etiquette

- Don't commit or push unless asked. Branch off `main` for feature work.
- Match the surrounding code's comment density — comment only non-obvious constraints.
