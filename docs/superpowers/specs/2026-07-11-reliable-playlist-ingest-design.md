# Reliable playlist ingest design

## Scope

Make existing NotebookLM imports idempotent and resumable without adding the
future queue or DOM-fallback systems. This is the proof-P0 reliability slice.

It applies to every stored `SourceDoc`, but fixes the special case that makes
playlist imports unsafe today: a single playlist document expands into one
overview source and many individual YouTube sources.

## Decision

`SourceDoc` remains the captured-and-displayed aggregate. It is not the
ledger, retry, or queue boundary. A new pure ingest planner derives ordered
`IngestUnit`s from a source document:

1. A thread produces one Markdown-text unit with `id === doc.id`.
2. A playlist produces one Markdown overview unit whose id is the document id
   plus `:toc`.
3. A playlist then produces one YouTube URL unit per first-seen video, with
   an id formed from `youtube:` plus the video id.

The planner preserves the current JSONL-to-Markdown URL fallback and the
playlist's observed order. It does not introduce a second `SourceDoc` payload
format.

## Import and receipt contract

`ingestIntoNotebook` loads the notebook-scoped ledger once, plans all units,
and processes them sequentially.

- An unchanged unit is skipped and never reaches NotebookLM.
- A unit is recorded and persisted immediately only after its RPC call
  succeeds.
- A failed unit returns a failure outcome but does not erase earlier receipts.
- Processing continues after a unit failure so a single bad video does not
  block independent later sources. A subsequent run retries only the failed or
  unseen units.

This gives MV3 interruption safety without claiming a full background queue:
after every verified mutation, durable state has the corresponding receipt.

Legacy playlist-level ledger entries intentionally do not match the new ToC or
video unit identities. The first upgraded run creates the missing receipts and
imports the missing overview once; it does not suppress an unknown partial
playlist.

## Outcome contract

The core reports results per ingest unit, including `docId`, `unitId`,
delivery tier, and status (`sent`, `skipped`, or `failed`). The popup aggregates
those results back by captured document:

- `0 sent · N already up to date` for a safe rerun.
- `N sent · M failed` plus a retry action that sends only failed units.
- Playlist progress uses its unit count: one overview plus its video sources.

No skipped source is described as sent. The existing compact popup layout is
preserved: status lives below the Send button and the playlist card carries the
source-count context.

## Boundaries

- `src/core/ingest/units.ts` owns planning and identities; it is pure and
  independently tested.
- `src/core/ingest/notebooklm.ts` owns sequential RPC delivery, ledger
  reconciliation, and receipt persistence.
- `src/core/store/ledger.ts` remains a generic notebook-scoped hash ledger;
  no playlist knowledge enters it.
- `src/core/messaging.ts`, `src/core/router.ts`, and the popup transport and
  summarize the expanded outcomes. They do not plan or persist units.

The persisted queue, alarm-driven retries, account cache, and Tier-B DOM
fallback remain separate follow-up slices. They will consume the same
`IngestUnit` identity model instead of introducing a competing one.

## Verification

Unit tests cover thread planning, playlist overview-first ordering, URL
deduplication, fallback URL extraction, and cross-playlist video identity.
Ingest tests prove first import, zero-POST unchanged rerun, partial playlist
failure with durable prior receipts, failed-only retry, and changed-overview
reimport. The full `bun run check` gate remains required. A later real-Chrome
pass verifies the NotebookLM mutations and second-run zero-duplication
behavior.
