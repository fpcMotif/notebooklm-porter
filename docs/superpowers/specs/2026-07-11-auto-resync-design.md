# Auto-resync design

## Goal

Let a user keep an already captured, background-capturable source synchronized
to a chosen NotebookLM notebook every six hours without bypassing the durable
ingest queue.

## Scope

The first slice watches captured YouTube playlists, Reddit threads, and Hacker
News discussions. It excludes X (capture requires a live page content script)
and generic web captures (page extraction requires a user gesture). Bookmark
folders and arbitrary tabs are separate features, not hidden fallbacks.

## Watch contract

A watch is an immutable binding between a source URL, its stable source id,
and an account-verified queue target. It records the next due time, last
successful resync, and the last safe error string. Watch creation is idempotent
per source plus notebook target; stopping a watch removes only that binding.

The target is accepted only after a fresh authenticated notebook listing proves
that its id belongs to the active account. A transcript-enriched YouTube
playlist records that opt-in on the watch and repeats it on future captures.

The fixed initial interval is six hours. Users explicitly choose a notebook
before enabling a watch; the existing Send action remains the explicit way to
perform an initial import.

## Resync flow

1. A single named alarm wakes the background service worker at the earliest
   due watch.
2. The worker picks one due watch, resolves an adapter with the `url` strategy,
   and recaptures from the stored canonical URL.
3. It formats and persists the new document snapshot, plans immutable ingest
   units, and enqueues them against the stored account/email/notebook target.
   A newer scheduled snapshot supersedes an older queued, retrying, or blocked
   snapshot for the same logical unit; in-flight, uncertain, and failed work
   stays visible because its remote outcome is not safe to erase.
4. The existing queue drain performs the only remote mutation and uses its
   per-unit ledger receipts to remove unchanged units. No watch code sends a
   NotebookLM RPC directly.
5. The watch is advanced to its next six-hour run. Capture failure is recorded
   and retried at the normal interval; invalid/unsupported sources are
   disabled rather than retried indefinitely.

## Boundaries

- `core/watch/watch.ts` holds pure state transitions, due selection, and
  view projection.
- `core/watch/store.ts` is the thin `Kv` persistence wrapper.
- `core/watch/resync.ts` composes capture, formatting, queue enqueueing, and
  alarm scheduling.
- Router messages create/list/remove watches; the popup only renders their
  status and sends explicit user actions. Each view carries a detached full
  target. Popup matching uses all target fields, never just `notebookId`.
  It uses the current catalog title only when the watch belongs to the current
  account; other-account watches show their raw notebook id.
- Background serializes watch and queue operations through the same executor,
  preventing concurrent read-modify-write of queue state.

## Safety and verification

The stored target includes account email as well as `authuser`; existing queue
preflight blocks a reassigned account slot before any source mutation. Watch
creation performs only local storage writes. A scheduled run may enqueue a
future remote action only because the user expressly enabled that watch and
targeted its notebook.

Receipt hashes exclude the volatile `captured_at` frontmatter field, so a
byte-identical recapture does not become a new source simply because it ran at
a different time. Queue snapshots are saved before the watch is advanced, but
the queue alarm is armed only after that advance; if the worker dies between
the saves, the next run merges the same immutable unit identity rather than
performing a duplicate remote mutation.

Unit-test pure watch lifecycle/due scheduling, unsupported-source rejection,
resync queueing, error advancement, alarm scheduling, router wiring, and
popup status behavior. Run `bun run check` after integration.
