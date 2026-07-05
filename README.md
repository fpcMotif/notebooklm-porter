# NotebookLM Porter

Port **YouTube playlists** and **web threads** (X/Twitter, Hacker News, Reddit) into
Google NotebookLM as clean, structured sources — one click, budget-aware, idempotent.

NotebookLM's "chat with your sources" is only as good as what you feed it. Getting a
140-video playlist or a 400-comment thread in today means either 140 manual
"Add source" clicks or a wall of unstructured paste. Porter closes that gap.

## What makes it different

The only adjacent tool ([notebooklm-jetpack](https://github.com/crazynomad/notebooklm-jetpack))
does neither playlists nor social threads. Porter adds three things nothing in the
ecosystem has:

- **Budget-aware batch planner** — before importing, see "142 videos · 8/50 sources used
  · 42 will fit" against your plan's source cap, and choose separate-sources vs merged-digest.
- **Sync ledger** — idempotent re-import (only new videos since last sync), staleness
  diffing on threads, cross-import dedup. Every competitor is fire-and-forget.
- **Structure-preserving Markdown** — YAML frontmatter, reply nesting, X long-post
  (`note_tweet`) full text, and a per-video **caption pre-check** (NotebookLM silently
  drops caption-less videos — Porter flags them first).

## Status

Early. The architecture spine compiles and builds; capture/ingest logic is being
implemented in stages (see the spec). **Not yet functional.**

## How it works

A capture pipeline with clean seams (full detail in
[`docs/superpowers/specs/2026-07-06-notebooklm-porter-design.md`](docs/superpowers/specs/2026-07-06-notebooklm-porter-design.md)):

```
adapters (capture) → formatters (render) → ingest (deliver)
  youtube/reddit/hn/x    Markdown + JSONL     RPC → DOM → file
```

Ingestion is **RPC-first with automatic fallback**: the background service worker calls
NotebookLM's internal `batchexecute` RPC (`izAoDd`) directly; if Google reships and that
breaks, it degrades to DOM automation, then to file export — which always works.

## Develop

```bash
bun install
bun run dev        # WXT dev server, loads unpacked
bun run check      # fmt + lint + typecheck + test + build
```

Stack: [WXT](https://wxt.dev) · Preact · Tailwind v4 · Vitest · oxlint/oxfmt · tsgo.

## Build sequence

1. Core pipeline + Reddit + HN (lowest-risk public APIs)
2. Tier-A RPC ingest + budget planner
3. YouTube playlist (parse + continuation + caption pre-check)
4. Tier-B DOM fallback + X/Twitter (highest fragility, last)

## Disclaimer

Uses NotebookLM's unofficial internal endpoints (no public consumer API exists). May
break when Google reships; the file-export tier is the durable floor. User-initiated,
local-only storage, minimal permissions (no `<all_urls>`, no `externally_connectable`).
