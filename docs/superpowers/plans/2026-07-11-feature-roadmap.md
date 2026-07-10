# Feature Roadmap — 2026-07-11

> Source material: seven full feature designs (notebook-picker, sync-queue, multi-account,
> auto-watch-resync, context-menu-capture, tier-b-dom-fallback, transcript-enrichment) plus
> a value/effort judge pass that ranked and sequenced them, plus four codebase audit maps
> (supporting layers, Effect migration, popup/messaging wiring, effort). Full design +
> rationale for the base product: `docs/superpowers/specs/2026-07-06-notebooklm-porter-design.md`.

This doc is a planning artifact, not an execution plan — no subagent-driven-development
sub-skill needed. Each roadmap entry is a pointer to "what to build and why," condensed
from a much longer design; re-derive full implementation steps from the source designs
(in the workflow scratchpad) when a slot is actually picked up.

---

## 1. Now (shipped alongside this doc)

Three fixes landing in parallel with this doc, in the same working tree. Not designs —
just closing verified gaps the audit found in the mid-migration messaging/router/popup path.

- [ ] **capture-url routing for contentScript adapters.** `App.tsx`'s capture button
  unconditionally sent `porter/capture-url` for every adapter, even `xAdapter` (which sets
  `contentScript: true` and has no `captureFromUrl`) — so `router.ts`'s handler fell
  through to `{ ok: false, error: 'Nothing capturable on this page' }` despite `detect()`
  already having told the popup the page was capturable. Fix: `App.tsx`'s capture action
  branches on the matched adapter's `contentScript` flag and sends `porter/capture-page`
  (which `router.ts` already relays via `Tabs.sendMessage(tabId, { type:
  'porter/extract-thread' })`) instead of `porter/capture-url` for those adapters. Pre-existing
  bug, not introduced by the Effect migration — confirmed via `git diff HEAD --
  src/entrypoints/popup/App.tsx` showing the identical unconditional call pre-migration.

- [ ] **create-notebook wired end-to-end.** `RPC_IDS.createNotebook` (`CCqFvf`) and its
  `client.ts` wrapper have existed since before this session but had zero callers in
  `messaging.ts`/`router.ts`/`App.tsx` — half of the user's "cannot sync... by creating a
  new one" report was simply a missing message type, not a regression. Fix: add
  `porter/create-notebook` to `PorterMessage`/`PorterResponseMap` (`src/core/messaging.ts`),
  a `router.ts` handler that calls `createNotebook` and returns `{ id, title }`, and a
  create-notebook text input + button in `App.tsx` next to the existing notebook `<select>`.
  `CCqFvf`'s response shape has no live fixture (unlike `wXbhsf`'s), so treat a parse miss
  as expected, not drift, for now — the notebook-picker design (§2 below) is where the
  listNotebooks-diff fallback belongs if direct parsing proves unreliable.

- [ ] **X thread DOM-walk extraction.** `x.content.ts`'s `porter/extract-thread` handler is
  a hardcoded stub (`{ ok: false, error: 'X extraction not implemented yet' }`) — X-thread
  capture has never worked. Fix: replace the stub with a real DOM walk of
  `article[data-testid="tweet"]` nodes in the loaded conversation, plus a pure
  `assembleThread` core function (new, e.g. `src/core/adapters/x/assemble.ts`) that turns
  the walked DOM text into a `Capture { kind: 'thread' }` — kept pure and unit-tested per
  the adapters convention (`parse.ts` pure / `capture.ts` thin wrapper), even though the
  entrypoint doing the walking is untestable glue. This is the DOM-walk tier only, not the
  spec's GraphQL tee — see roadmap item (8) for the follow-up upgrade.

---

## 2. Next — ranked roadmap

Judge's rank order (`valueScore`/`effortScore` from the ranking pass). Each entry: problem,
approach, effort, key risk, dependency notes.

### 1. notebook-picker
- **Problem:** notebook picker is a bare `<select>` with no way to create a notebook and no
  memory of which notebook a platform was last synced into.
- **Approach:** `createAndResolveNotebook` in `src/core/ingest/notebooklm.ts` — direct-parse
  `CCqFvf`'s result via a new `parseCreatedNotebook` (protocol.ts), falling back to a
  listNotebooks-before/listNotebooks-after diff when the parse misses. Add
  `PorterSettings.lastNotebookBySite: Partial<Record<SiteId,string>>`, written in
  `router.ts`'s `porter/ingest` handler off a new `IngestOutcome.site`. Popup pre-selects
  the remembered notebook only if it's present in the *current account's* freshly fetched
  list (passive cross-account guard).
- **Effort:** M, 5-7h.
- **Key risk:** `CCqFvf`'s response shape is completely unverified — no fixture exists like
  `wXbhsf`'s. The listNotebooks-diff fallback adds a round-trip and a real race window
  (another tab creating/deleting a same-titled notebook mid-diff).
- **Depends on:** the "Now" create-notebook wiring lands this session; this item deepens it
  with the diff-fallback and per-site memory. Independent of the existing-notebook sync path.

### 2. multi-account (authuser) support
- **Problem:** `settings.ts`/`rpc/client.ts` already thread `authuser` everywhere, but there's
  no notebook cache (every switch is a live round-trip) and `selectAccount()` never reloads
  notebooks or clears the stale selection after a switch.
- **Approach:** new pure module `src/core/store/notebooks-cache.ts` (mirrors `ledger.ts`'s
  pure-reducer/thin-`Kv` split), keyed by `authuser` with an **email-match guard**
  (`readCacheEntry` only serves a cache hit if the stored email matches the account
  currently reported at that authuser slot — the load-bearing mitigation for Chrome's
  positional, reassignable `authuser` index). `router.ts`'s `porter/list-notebooks` becomes
  cache-first with a `forceRefresh` flag; fix `App.tsx`'s `selectAccount` to clear
  `selectedNotebookId` and reload on switch.
- **Effort:** S/M, 4-6h — cheapest, safest item on the list.
- **Key risk:** authuser-slot reassignment (sign out of one account, index N points at a
  different one) — the email-match guard is what prevents serving the wrong account's
  cached notebooks; don't simplify it away.
- **Depends on:** nothing new; do opportunistically alongside #1 since both only touch
  `router.ts`/`messaging.ts`/`App.tsx` lightly.

### 3. sync-queue
- **Problem:** `porter/ingest` is one giant synchronous request with zero persistence until
  it fully completes — an MV3 SW eviction or a closed popup mid-batch silently loses
  progress, and the (currently dead) ledger means a retry re-sends already-successful docs
  as duplicates. This is at least as plausible an explanation for "completely non-functional"
  ingest as RPC protocol drift.
- **Approach:** `porter/queue-enqueue` replaces the popup's direct `ingestIntoNotebook` call;
  a new pure `src/core/queue/queue.ts` (upsert-by-`notebookId:docId`, fair round-robin
  `pickNext`, exponential backoff, `reapStuck` for SW-died-mid-attempt) plus
  `src/core/queue/drain.ts` orchestrating one RPC step per tick at ~1.5s spacing. New
  `Alarms` fx service (SW-only) re-arms a near-term alarm before each in-memory sleep as a
  crash-safety net. `notebooklm.ts`'s per-video loop is extract-method refactored into
  `nextSourceStep` so `ingestOneDoc`/`ingestIntoNotebook` behavior and
  `notebooklm.test.ts`'s assertions stay byte-identical.
- **Effort:** L, 12-16h.
- **Key risk:** relies on a forked/detached effect (`Effect.forkDaemon` or equivalent)
  surviving past the message-reply boundary inside `ManagedRuntime` — **unverified in this
  v4 beta** (fallback: a second unawaited `porterRuntime.runPromise(runDrainLoop())`,
  bypassing structured concurrency). `chrome.alarms`' minimum-delay clamping as a crash-safety
  net is also untested in packaged (Web Store) builds vs. dev/unpacked.
- **Depends on:** doesn't wire the ledger itself (re-enqueuing an unchanged doc still
  duplicates — see item 9) and doesn't touch the create-notebook gap (handled in "Now").

### 4. tier-b-dom-fallback
- **Problem:** Tier A (batchexecute RPC) is the only ingest path; when it drifts,
  `ingestOneDoc` just stringifies the error and gives up. `notebooklm.content.ts` is a
  literal stub — Tier B (spec §4, DOM automation on an open NBLM tab) doesn't exist.
- **Approach:** new `DomTabs` fx service (SW-only, opens a visible NBLM tab, message-relays
  to the content script); new pure `src/core/ingest/tier-state.ts` (persisted 10-minute
  degradation cooldown, mirrors `ledger.ts`'s split) so later ingest calls skip straight to
  Tier B without re-paying a failed RPC round trip; new pure
  `src/core/ingest/dom/selectors.ts` centralizing all DOM selector logic in one file, per
  spec's "a Google change is a one-file patch" mandate. `ingestIntoNotebook` tries RPC first,
  falls through to DOM for that same doc within the same iteration on failure.
- **Effort:** L, ~18-24h implementation, plus unbounded live-account QA to correct the
  selector placeholders (impossible to verify in this sandbox).
- **Key risk:** the DOM selectors are unverified placeholders with no live authenticated
  session to check them against. Also unverified: `Effect.async`'s presence in
  `effect@4.0.0-beta.93` (the same beta that's already missing `Layer.scoped`) — verify
  against `node_modules/effect` before relying on it; fallback is a manual
  `Promise`+`setTimeout` wrapped in `Effect.tryPromise`.
- **Depends on:** should follow, not precede, an actual diagnosis of whether today's ingest
  failures are really Tier-A RPC drift — otherwise this is a 20+ hour bet on the wrong root
  cause. If pursued, do it after sync-queue so DOM fallback can share its per-doc
  retry/backoff machinery. Also wires the ledger for the first time (see item 9's overlap).

### 5. context-menu-capture
- **Problem:** the only way to capture anything is popup → matched adapter site → capture
  button → (separately) send. No arbitrary-page/selection/link capture, no one-click send.
- **Approach:** `activeTab` + `scripting.executeScript` (avoids the rejected `<all_urls>`
  permission) for page/selection capture; a new `genericAdapter` deliberately excluded from
  `ALL_ADAPTERS` so it never affects `allHostPermissions()` or the popup's detect/capture
  flow. Right-clicked links first try the existing adapter registry
  (`adapterForUrl`) before falling back to bare-URL-plus-anchor-context. New `Scripting` and
  `Notify` fx services (SW-only); badge auto-clear via `alarms`, never `setTimeout` (SW can
  die first).
- **Effort:** M, ~12-14h.
- **Key risk:** needs four new manifest permissions (`contextMenus`, `activeTab`,
  `scripting`, `notifications`) plus a notifications icon asset that **doesn't exist in the
  repo at all** — a real blocking prerequisite, not just an implementation detail.
- **Depends on:** orthogonal to the core sync bug; the capture-only half is independently
  shippable, but "immediate ingest via quickCaptureNotebookId" is gated on the same ingest
  path as everything else.

### 6. transcript-enrichment
- **Problem:** playlist ingest hands NotebookLM's own lossy native YouTube importer a bare
  URL per video (drops chapters, silently fails on caption-less videos).
- **Approach:** new pure `src/core/adapters/youtube/transcript.ts` (caption-track
  extraction, `timedtext` json3 parsing, chapter extraction from
  `multiMarkersPlayerBarRenderer` — all paths **live-verified** against real YouTube HTML
  during design) and `enrich.ts` orchestrator (bounded concurrency 4, cap 200 videos, never
  fails the whole capture). New `SourceDoc.videoDocs[]` field carries a per-video rendered
  transcript Markdown; `ingestOneDoc` sends `addTextSource` for enriched videos and falls
  back to `addYoutubeSource` for the rest. Per-playlist opt-in checkbox, off by default.
- **Effort:** M, ~12-16h.
- **Key risk:** live-verified that `youtube.com/api/timedtext` can return HTTP 200 with an
  empty body from a datacenter egress IP (documented IP-blocking behavior) — must be
  treated as "no transcript," never a hard failure. Introduces a second parallel
  formatter↔ingest wire format (`SourceDoc.videoDocs` alongside the existing
  jsonl-based `videoUrlsForDoc`) rather than resolving that pre-existing inconsistency —
  the design's own confessed shortcut.
- **Depends on:** entirely orthogonal to the reported breakage; value is blocked on ingest
  working at all, same as everything else on this list.

### 7. auto-watch-resync
- **Problem:** everything is one-shot — no way to keep a playlist/thread/bookmark folder in
  sync with a bound notebook over time.
- **Approach:** new `chrome.alarms`-driven `src/core/watch/` module (types, Kv-backed CRUD,
  per-`WatchKind` resync dispatch, scheduler with startup alarm/storage drift
  reconciliation) plus new `Alarms`/`Bookmarks` fx services and a `Tabs.findTabByUrl`
  addition. Diffs against the (currently dead) ledger at a new **per-item** granularity
  (per-video, per-post) nothing in the codebase uses yet.
- **Effort:** L, ~16-22h — largest effort, most compounding dependencies of any design here.
- **Key risk:** requires the ledger to be wired into the manual-ingest success path first
  (item 9) — skipping that means the first scheduled watch-tick after any prior manual send
  re-pushes everything as "new" and duplicates sources. X-thread watches are guaranteed to
  no-op until item (1)/spec §5.4 lands, since `x.content.ts`'s extraction is a stub today
  (partially closed by the "Now" DOM-walk fix, fully closed by item 8's GraphQL tee for
  virtualized/long-form threads).
- **Depends on:** the core RPC path working, the ledger wired (item 9), and X-thread
  extraction existing. Build last.

---

## 3. Additional roadmap entries (implied, not covered by the seven designs)

### 8. X GraphQL tee upgrade (spec §5.4)
- **Problem:** the "Now" DOM-walk extraction (item in §1) only sees the ~30 articles X
  keeps mounted in the virtualized timeline, can't reliably get X Premium long-form text,
  and re-derives thread structure from rendered DOM rather than the actual API response.
- **Approach:** per spec §5.4, replace the DOM walk with a MAIN-world content script
  installed at `document_start` that monkey-patches `window.fetch`/`XHR.open`, matches
  `/i/api/graphql/` + op names (`TweetDetail`, `TweetResultByRestId`), and re-emits response
  bodies to the ISOLATED world via `CustomEvent`. A depth-first tree-walker parses tweet
  nodes generically (unwraps `TweetWithVisibilityResults`, skips `TweetTombstone`). Reads
  `note_tweet.note_tweet_results.result.text` for long-form, falling back to
  `full_text`/`text`; also captures quoted tweets and X Articles. Scroll-drains the
  virtualized timeline to load the full thread, teeing responses as they arrive, setting
  `truncated: true` if the user stops early. **Never hardcodes** the `TweetDetail` queryId
  (rotates every few weeks) — sniffs it live from the tee, same pattern as
  `xtimelinefilter`'s GraphQL sniffer.
- **Effort:** L — spec explicitly calls this "highest risk, ships last" among the four
  adapters; MAIN-world/ISOLATED-world message bridging is a new pattern for this codebase.
- **Key risk:** queryId drift is "certain (weeks)" per the spec's own risk table — the tee
  approach is the mitigation, not a nice-to-have. This supersedes, not supplements, the
  "Now" DOM-walk — once it lands, `assembleThread`'s DOM-walk input source is replaced by
  tee'd GraphQL responses, but the pure assembly/thread-shaping logic should mostly carry
  over.
- **Depends on:** the "Now" DOM-walk landing first (ships something), then this replaces
  its extraction source once the simpler version is proven insufficient (X Premium
  long-form, virtualized-timeline truncation).

### 9. Wire the ledger
- **Problem:** `src/core/store/ledger.ts` — `diffAgainstLedger`, `recordSynced`,
  `loadLedger`, `saveLedger`, `contentHash` — is fully implemented, fully unit-tested, and
  has **zero callers anywhere in `src/`** (confirmed by every design and both audits that
  looked). Every design above that touches re-sync (sync-queue's retry path,
  tier-b-dom-fallback's idempotency requirement, auto-watch-resync's whole premise) either
  depends on this being wired or explicitly flags that skipping it causes duplicate
  NotebookLM sources on re-ingest.
- **Approach:** in `src/core/ingest/notebooklm.ts`'s `ingestOneDoc`, after a successful push,
  call `recordSynced` + `saveLedger` (additive only — changes what gets *recorded*, not what
  gets pushed, so it's byte-compatible with `notebooklm.test.ts`'s existing assertions). In
  `ingestIntoNotebook`, before pushing, run `diffAgainstLedger` over the requested docs'
  `contentHash(doc.markdown)` and skip `unchanged` docs entirely (mark them
  `{ ok: true, tier: 'skip' }` rather than re-sending).
- **Effort:** S, ~2-3h — the smallest, highest-leverage item on this whole roadmap; it's a
  refactor-adjacent wiring change to code that already exists and is already tested.
  Several designs above (sync-queue, tier-b-dom-fallback, auto-watch-resync) each separately
  reinvent a version of "wire the ledger" as one of their own implementation steps —
  extracting it here means whichever of them ships first doesn't have to solve it alone,
  and the others get it for free.
- **Key risk:** this is a genuine behavior change, not a pure addition — a resend of
  unchanged content now gets silently skipped instead of re-sent. Worth flagging to the user
  once, not something to bury in a larger PR.
- **Depends on:** nothing. Should land before sync-queue's retry semantics or
  auto-watch-resync's diffing are built on top of it, so they don't each duplicate this wiring.

---

## 4. Sequencing

The judge's recommended order, adjusted for the "Now" fixes landing first (they were not
covered by any of the seven designs, but two of the three — capture-url routing,
create-notebook wiring — are the literal fixes the judge's own diagnosis step calls for).

1. **(Landing now, this session)** capture-url routing, create-notebook wiring, X thread
   DOM-walk extraction — closes the two concretely-diagnosed wiring gaps behind "cannot sync
   a tweet collection" / "cannot sync... by creating a new one," per the audit's own
   `syncPathVerdict`. This substitutes for the judge's step-1 "diagnose the core break
   first" — the audit already did that diagnosis; these are its fixes.
2. **Wire the ledger (item 9)** — smallest, highest-leverage, and several later items
   (sync-queue's retry, tier-b-dom-fallback's idempotency, auto-watch-resync's whole
   premise) each separately need it. Land it once, here, before any of them.
3. **notebook-picker** — cheapest design, deepens the "Now" create-notebook wiring with the
   diff-fallback and per-site memory; independent of the existing-notebook sync path.
4. **multi-account (authuser)** — very cheap, safe, mostly wires already-built
   infrastructure; do opportunistically alongside #3 since both only touch
   `router.ts`/`messaging.ts`/`App.tsx` lightly.
5. **sync-queue** — once ingest is confirmed working end-to-end (step 1) and the ledger is
   wired (step 2), this is the best next investment: replaces the fragile synchronous
   all-or-nothing ingest with a persisted, resumable queue. Gives auto-watch-resync a
   durable ingest primitive to build on later instead of reinventing its own dispatch loop.
6. **tier-b-dom-fallback** — only worth its 20+ hour cost if real-world use after step 1
   shows Tier-A RPC drift specifically (not some other bug); otherwise it's solving a
   problem that may not be the real one. Do it after sync-queue so DOM fallback can share
   the queue's per-doc retry/backoff machinery instead of duplicating tier-tracking logic.
7. **X GraphQL tee upgrade (item 8)** — once the "Now" DOM-walk has shipped and shown where
   it falls short (long-form text, virtualized-timeline truncation), replace its extraction
   source per spec §5.4. Ships whenever X capture quality becomes the bottleneck, not
   earlier — the spec itself calls this "highest risk, ships last."
8. **context-menu-capture** and **transcript-enrichment** — independent, additive UX/value
   features with no dependency on each other or on anything above; slot in whenever, once
   ingest is confirmed working end to end, since both are otherwise invisible wins.
9. **auto-watch-resync** last — strictly depends on the core fix (step 1), the ledger being
   wired (step 2, not reinvented locally), and X-thread extraction existing (step 1's
   DOM-walk, ideally step 7's GraphQL tee for anything beyond the simplest threads).
