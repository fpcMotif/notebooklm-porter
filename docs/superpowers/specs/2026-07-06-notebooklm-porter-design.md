# NotebookLM Porter — Design Spec

**Status:** Draft for review
**Date:** 2026-07-06
**Author:** Architect (Claude), with research legwork by Sonnet/Haiku subagents

A Chrome MV3 extension that ports two classes of content into Google NotebookLM as
clean, structured sources:

1. **YouTube playlists** → one NotebookLM source per video (with caption-availability pre-check).
2. **Web threads** (X/Twitter, Hacker News, Reddit) → one structure-preserving Markdown source per thread.

NotebookLM's own "chat with your sources" is only as good as what you feed it. Today,
getting a 140-video playlist or a 400-comment HN thread in means either 140 manual
"Add source → paste URL" clicks or a wall of unstructured copy-paste. This extension
closes that gap, and does it better than the one adjacent competitor by being
**budget-aware, idempotent, and structure-preserving** — three things no existing tool does.

---

## 1. Why this is worth building (evidence)

Research across the reference repos and the awesome-notebooklm ecosystem (see
`docs/research/` digest) established:

- **The gap is real and specific.** Zero tools exist for YouTube-playlist→per-video
  sources or for X/HN/Reddit-thread→structured-source. The only direct importer in the
  ecosystem (NotebookLM Hub) handles single YouTube links and webpages only.
- **The named reference repos are misleading and de-risk the competitive picture:**
  - `gemini-voyager` is a Gemini web-app UX enhancer with **zero** NotebookLM code.
  - `PaulKinlan/NotebookLM-Chrome` is now **FolioLM**, a BYOK NotebookLM *clone* that
    never touches notebooklm.google.com.
  - `crazynomad/notebooklm-jetpack` (127★, on the Web Store) is the **one real
    competitor**. It fixes broken URL imports and batch-imports doc sites. It does **not**
    do playlists or social threads. Its architecture (below) is the proven blueprint.
- **The ingestion mechanism is solved-but-unofficial** (§4).

## 2. Non-goals (YAGNI)

- No podcast/RSS/doc-site import (jetpack's turf; not our wedge).
- No NotebookLM *clone* features (no BYOK chat, no local LLM) — we feed the real product.
- No account/cloud sync backend in v1. All state is local (`storage.local`).
- No audio/video *overview* generation — that's NotebookLM's job downstream.
- No Enterprise API path in v1 (it exists — Discovery Engine `notebooks.sources.batchCreate` —
  but is gated to Google Cloud orgs; consumer users can't use it).

## 3. Architecture

WXT + Preact + Tailwind v4 + Vitest, mirroring the sibling projects
(`xediadownloader`, `xtimelinefilter`). Package manager: bun. Lint/format: oxlint/oxfmt.
Typecheck: tsgo. All API/browser access goes through WXT's typed `browser` global.

```
┌─────────────┐   detect/capture    ┌────────────────────┐
│   Popup     │◄───── messaging ────►│  Background (SW)    │
│  (Preact)   │                      │  message router     │
└─────────────┘                      └─────────┬──────────┘
      ▲ list/export/ingest                     │
      │                          ┌─────────────┼──────────────┐
      │                          ▼             ▼              ▼
      │                   ┌──────────┐  ┌────────────┐  ┌───────────┐
      │                   │ adapters │  │ formatters │  │  ingest   │
      │                   │ (capture)│─►│  (render)  │─►│ (deliver) │
      │                   └────┬─────┘  └────────────┘  └─────┬─────┘
      │                        │                              │
      │            ┌───────────┼──────────┐          ┌────────┼─────────┐
      │            ▼           ▼          ▼          ▼        ▼         ▼
      │        youtube    reddit/hn   x (content)  RPC     DOM-drive  file
      │        (SW fetch) (SW fetch)  (page ctx)  izAoDd  (nblm CS)  export
      │                                             │        │
      └──────────── store (storage.local) ◄─────────┴────────┘
                        + sync ledger
```

### Module seams (each independently testable)

| Module | Path | Responsibility | Depends on |
|---|---|---|---|
| **model** | `src/core/model/` | Domain types: `Thread`, `Post`, `Playlist`, `VideoEntry`, `SourceDoc` | nothing |
| **adapters** | `src/core/adapters/<site>/` | Per-site capture → `Capture`. One `SourceAdapter` each. | model, fetch |
| **formatters** | `src/core/format/` | `Capture` → `SourceDoc` (Markdown + JSONL + counts) | model |
| **ingest** | `src/core/ingest/` | Deliver `SourceDoc[]` to NBLM via RPC/DOM/file | model, store |
| **store** | `src/core/store.ts` | Capture queue + sync ledger in `storage.local` | model |
| **budget** | `src/core/budget/` | Plan-cap accounting + batch planner | model, ingest(read) |
| **messaging** | `src/core/messaging.ts` | Typed message contract | model |

The adapter registry (`src/core/adapters/registry.ts`) is the single source of truth:
adding a platform is one entry there, and `wxt.config.ts` derives all
`host_permissions` from it. No manifest is hand-edited per platform.

## 4. NotebookLM ingestion (RPC-first, layered fallback)

**Decision:** RPC-first (per approval), with automatic degradation. The internal RPC
*will* break when Google reships; a one-click tool that silently no-ops is worse than
one that visibly degrades. So three tiers, tried in order, with the active tier shown
in the UI:

### Tier A — `batchexecute` RPC from the service worker (primary)

- **Endpoint:** `POST https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute`
- **Auth:** `credentials:'include'` (ambient Google cookies) + CSRF token scraped from
  the NBLM homepage HTML (`"SNlM0e":"([^"]+)"`). **No SAPISIDHASH required** — proven by
  two working extensions (testyyj/NotebookLM-Agent, crazynomad/notebooklm-jetpack).
- **RPC ids:** `izAoDd` = ADD_SOURCE (URL / pasted-text / YouTube / Drive);
  `o4cbdc` = ADD_SOURCE_FILE (after a separate Scotty upload — not needed for us);
  `wXbhsf` = list notebooks (for the budget planner's occupancy read).
- **Envelope:** `f.req=<url-encoded [[[rpcId, JSON.stringify(params), null, "generic"]]]>&at=<csrf>`;
  response is anti-XSSI-prefixed (`)]}'`) then line-delimited JSON, parse the
  `["wrb.fr","<rpcId>",<json-string>,...]` line.
- **Why the SW, not a content script:** content scripts inherit the page origin and
  **cannot** bypass CORS even with host permissions; the SW can, given
  `host_permissions: ["https://notebooklm.google.com/*"]`. This is the load-bearing
  MV3 fact.
- **Two-source types we use:** pasted-**text** (`textContent`) for threads (we own the
  Markdown), and **URL** for YouTube video watch URLs (NBLM fetches the transcript itself).

**Failure handling (non-negotiable — this is where jetpack is weak):**
- Wrap the whole RPC in a versioned client `src/core/ingest/rpc/client.ts` with the
  RPC ids, endpoint, and envelope shape isolated in one `rpc/protocol.ts` constant file
  so a Google change is a one-file patch.
- Distinguish **not-logged-in** (no CSRF token / 401) from **protocol-drift**
  (200 but unparseable envelope) from **quota** (source-cap error) — surface each
  distinctly to the user. jetpack collapses all of these to "empty array"; we must not.
- On any Tier-A failure, **auto-fall-back to Tier B**, and tell the user which tier ran.

### Tier B — DOM automation on an open NBLM tab (fallback)

Content script `src/entrypoints/notebooklm.content.ts` drives the visible Add-Source
dialog (jetpack's blueprint, hardened):
- Selector registry `src/core/ingest/dom/selectors.ts` — every selector centralized with
  a comment on *why*, plus bilingual text fallbacks. Unlike jetpack, **all** call-site
  fallbacks live here (jetpack admits theirs don't).
- Use `MutationObserver`-based waiting, **not** 100 ms busy-poll loops (jetpack's
  documented fragility). Wait for the actual dialog/insert-button mutation.
- `fillInput()` uses the native value-setter trick
  (`Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set`) then
  dispatches `input`/`change`/`InputEvent` so Angular picks it up.
- Idempotency guard: check the sync ledger before insert; never double-insert.

### Tier C — file export (always-works floor)

`src/core/ingest/export.ts` writes `.md`/`.jsonl` via `chrome.downloads`. User drags
into NBLM. Zero ToS/breakage risk. Always available as an explicit button, and the
automatic destination when both A and B fail.

### Health canary (better than jetpack's)

`scripts/check-selectors.mjs` + a background self-test: on first ingest of a session,
issue one cheap `wXbhsf` list-notebooks RPC. If it 200s-but-unparseable, mark Tier A
degraded proactively and route to B — *before* the user's real import fails.

## 5. Capture adapters

### 5.1 YouTube playlist (SW fetch, no content script)

- **Detect:** `/playlist?list=` or `/watch?...&list=`.
- **First page:** SW `fetch`es the playlist HTML, regexes `ytInitialData`
  (`/(?:window\["ytInitialData"\]|ytInitialData)\s*=\s*({.+?});/`), walks
  `...playlistVideoListRenderer.contents[].playlistVideoRenderer` → `{videoId, title,
  channel (shortBylineText), durationSeconds (lengthSeconds), index}`. First ~100 items
  are server-rendered.
- **Pagination:** extract the continuation token
  (`continuationItemRenderer.continuationEndpoint.continuationCommand.token`), read
  `INNERTUBE_API_KEY` + `INNERTUBE_CONTEXT` from the page HTML (regex, no MAIN world
  needed), then `POST youtubei/v1/browse?key=…` with `{context, continuation}` in a loop
  until no continuation. Cap at a configurable max (default 500) and set
  `truncated:true` if hit.
- **Caption pre-check (differentiator):** for each video, the planner can optionally
  probe `ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks`
  (non-empty ⇒ has captions). Videos without captions are flagged; NBLM silently drops
  them otherwise. This probe is opt-in (it's N extra fetches) — off by default, one
  toggle in the planner.
- **Canonical URL:** `https://www.youtube.com/watch?v=<id>` — **stripped of `list=`**, so
  NBLM ingests one clean video per source.
- **Risk:** YouTube may require a `poToken` for InnerTube calls from some contexts
  (flagged uncertain). Mitigation: the first-page `ytInitialData` parse needs no API
  call and covers ≤100-video playlists with zero risk; continuation is the only
  poToken-exposed path.

### 5.2 Reddit (SW fetch — lowest risk, ships first)

- **Detect:** `/r/<sub>/comments/<id>`.
- **Capture:** append `.json` to the post URL. Response `[t3 post, t1 comment listing]`.
  Flatten the comment tree depth-first into `Post[]` with `depth`/`parentId`/`byOp`.
- **`more` stubs:** `kind:'more'` → `POST /api/morechildren` with up to 100 child ids,
  `link_id`, sort. Expand up to a budget (default 3 rounds); set `truncated:true` beyond.
- **CORS:** `.json` has no ACAO header → **must** run in the SW (content scripts blocked).
- **Rate limit:** anon ~10 req/min; a typical thread is 1–2 requests. Send a descriptive
  `User-Agent`. No auth in v1.

### 5.3 Hacker News (SW fetch — lowest risk, ships first)

- **Detect:** `/item?id=<id>`.
- **Capture:** `GET https://hn.algolia.com/api/v1/items/<id>` — returns the **entire
  nested comment tree in one CORS-enabled request**. Flatten `children[]` recursively
  into `Post[]`. Fields: `author`, `text` (HTML → strip to text), `points`, `created_at`.
- Algolia is unofficial-but-stable; Firebase fallback (`item/<id>.json`, N+1) is out of
  scope for v1 (documented, not built).

### 5.4 X/Twitter (content script — highest risk, ships last)

- **Detect:** `/<handle>/status/<id>`. Needs logged-in page context.
- **Primary — GraphQL tee** (proven in `xediadownloader`): MAIN-world content script
  monkey-patches `window.fetch`/`XHR.open` at `document_start`, matches
  `/i/api/graphql/` + op names (`TweetDetail`, `TweetResultByRestId`), re-emits response
  bodies to the ISOLATED world via `CustomEvent`. A depth-first tree-walker parses tweet
  nodes generically (unwrap `TweetWithVisibilityResults`, skip `TweetTombstone`).
- **Long-post text (differentiator, and the gap in the local repos):** read
  `note_tweet.note_tweet_results.result.text` for X Premium long-form; fall back to
  `full_text`/`text`. Also capture X **Articles**
  (`article.article_results.result`), quoted tweets (`quoted_status_id_str`), and media
  `ext_alt_text`. gallery-dl is the reference for these paths.
- **Thread assembly:** filter to `byOp` for the author's self-thread; optionally include
  top replies above a score threshold (planner option).
- **Virtualized timeline:** X keeps ~30 articles in the DOM; scroll-drain to load the
  full thread, teeing responses as they arrive. Set `truncated:true` if the user stops
  scroll-drain early.
- **queryId drift:** the `TweetDetail` GraphQL queryId rotates every few weeks. We don't
  hardcode it — we sniff it live from the tee (same pattern as `xtimelinefilter`'s
  GraphQL sniffer), so we never issue our own request with a stale id.

## 6. Domain model

Already implemented in `src/core/model/types.ts`. Key shapes:

- `Post` — flat, with `depth`/`parentId`/`byOp`; formatters render nesting from `depth`
  alone (no formatter ever recurses a reply tree).
- `Thread` / `Playlist` — carry a `truncated` flag so a partial capture is never
  silently presented as complete (NBLM answers would otherwise treat a fragment as whole).
- `SourceDoc` — the stored unit: `id = "<site>:<nativeId>"` (the dedup key), plus
  `markdown`, `jsonl`, `wordCount`, `truncated`, `capturedAt`.

## 7. Formatting (structure-preserving — differentiator)

`formatCapture(capture) → SourceDoc`. Renders **both** representations:

**Markdown** (the NBLM-facing format — plain Markdown grounds better than JSONL in
NBLM's pipeline; the critics were unanimous that JSONL-as-source has no evidence of
benefit):
- **YAML frontmatter** header: `source`, `url`, `title`, `author`, `captured_at`,
  `truncated`, stats. NBLM's grounding references this cleanly.
- Threads: `## <author> · <relative-time>` per post, reply nesting as blockquote depth,
  quoted tweets as nested blockquotes, links preserved, media rendered as
  `![alt](url)` so alt text (which carries meaning) survives into a text-only source.
- Playlists: a **table-of-contents source** (one Markdown doc listing all videos with
  index/title/channel/duration/caption-status) **plus** one URL source per video. The
  ToC makes a 100-source notebook navigable in NBLM's flat source list.

**JSONL** (power-user side-export only, **not** an NBLM source format): one object per
post/video per line. Kept because it's cheap and makes export instant; decoupled from
ingestion.

**Word-cap chunking:** if a mega-thread exceeds NBLM's 500k-word/source limit, split by
reply-depth boundaries into `<title> (part N)` sources. Rare, but must not silently
truncate.

## 8. Budget-aware batch planner (differentiator)

Before any import, a pre-flight screen (`src/core/budget/`):
- Read current notebook occupancy via the `wXbhsf` list RPC (Tier A) — or ask the user
  their plan tier if the RPC is degraded.
- Plan caps: Free 50 / AI Plus 100 / AI Pro 300 / AI Ultra 500 sources per notebook;
  500k words / 200 MB per source (uniform across tiers).
- Show: "142 videos detected · 8/50 sources used · **42 will fit** · 100 exceed your
  cap." Let the user pick a strategy inline:
  - **N separate sources** (max fidelity, burns source budget), or
  - **Merge into a digest** (one source per playlist / one per thread) to conserve the
    source *count* budget.
- For YouTube: surface caption-less videos here (pre-check) so the user isn't surprised
  by NBLM silently dropping them.

## 9. Sync ledger (differentiator)

`storage.local`, keyed `notebook → { externalId → {contentHash, lastSynced} }`:
- **Idempotent re-import:** "re-check this playlist" only adds videos not already synced.
- **Staleness diff:** "re-sync this thread" diffs new replies against the last capture;
  since NBLM has no update-in-place, offer "delete + re-add" or "append new-replies-only
  source", both budget-aware.
- **Cross-import dedup:** a video linked from a captured tweet *and* present in a playlist
  import doesn't become two sources.

No competitor has any sync state — they are all fire-and-forget. This is the
hardest-to-copy differentiator because it's product logic, not scraping cleverness.

## 10. Permissions & manifest

Derived from the adapter registry + NBLM host:
- `permissions`: `storage`, `downloads`, `unlimitedStorage` (one long thread can exceed
  the 10 MB `storage.local` quota), `clipboardWrite` (copy-as-markdown fallback).
- `host_permissions`: YouTube, x.com/twitter.com, reddit (+subdomains), news.ycombinator.com,
  hn.algolia.com, **and `https://notebooklm.google.com/*`** (required for the Tier-A RPC).
- **No** `<all_urls>`, **no** `externally_connectable`, **no** `debugger`. Deliberately
  narrower than both jetpack (`debugger` + `externally_connectable: https://*/*` — a hole)
  and FolioLM (`<all_urls>`). Keeps Web Store review cleaner given we touch a Google
  authenticated surface.

## 11. Risks & mitigations (honest register)

| Risk | Likelihood | Mitigation |
|---|---|---|
| NBLM `batchexecute` envelope/RPC-id change | High (weeks–months) | Protocol isolated in one file; canary self-test; auto-fallback to Tier B; distinct error surfacing |
| NBLM Angular DOM change breaks Tier B | High | Centralized selectors + MutationObserver + fixture tests; Tier C floor |
| Google DBSC extends to extension fetches, kills cookie-replay | Low-med, unpatchable | Tier C (file export) is unaffected — it's the insurance policy |
| YouTube InnerTube `poToken` requirement | Medium | First-page parse (≤100 videos) needs no API; only continuation is exposed |
| X GraphQL queryId rotation | Certain (weeks) | Never hardcode — sniff live from the tee |
| Chrome Web Store rejects (automates a Google auth surface) | Medium | Minimal permissions; user-initiated only; Tier C makes the core value work without any automation; consider unlisted/self-host distribution as fallback |
| Source-cap disappointment ("bulk import" oversells) | Medium | Budget planner foregrounds the cap *before* import; it's NBLM's limit, shown as such |
| Capturing others' social content (privacy) | Low | Local-only storage; user-initiated; document attribution; optional handle-redaction in v2 |

## 12. Build sequence (staged by risk, per approval)

Each stage is independently shippable and proves more of the pipeline:

1. **Stage 1 — Core pipeline + Reddit + HN.** Model (done) → formatters → Reddit/HN
   adapters (pure, SW-fetch, dead-simple APIs) → store + sync ledger → Tier C export.
   Proves capture→format→deliver end-to-end with the two lowest-risk sites. Fully unit-testable.
2. **Stage 2 — Tier A RPC ingest + budget planner.** The `batchexecute` client, occupancy
   read, planner UI. Now imports are one-click. Reddit/HN threads go straight in.
3. **Stage 3 — YouTube playlist.** Playlist parse + continuation + caption pre-check +
   ToC source. Highest user value.
4. **Stage 4 — Tier B DOM fallback + X/Twitter.** Hardened NBLM DOM automation, then the
   X GraphQL tee (reusing `xediadownloader`'s proven passive-tee). Highest fragility, last.

Testing: pure `src/core/**` under Vitest against frozen fixtures (real Reddit `.json`,
HN Algolia, `ytInitialData`, X GraphQL response snapshots). Entrypoint glue exercised by
the real extension. `bun run check` gates on fmt + lint + typecheck + test + build.

## 13. Legwork delegation

Per the operating model: Sonnet/Haiku subagents implement each stage against this spec
(adapters, formatters, tests); the architect verifies interfaces, reviews for
correctness/taste, and owns the risky ingest + protocol code. Each stage → its own
implementation plan via the writing-plans skill.
