# YouTube transcript enrichment design

## Goal

Optionally replace a playlist video's bare NotebookLM YouTube URL source with
an authored Markdown transcript source containing captions and chapters. A
failed enrichment must never make playlist capture or normal URL import fail.

## Scope

Enrichment is a capture-time, playlist-only opt-in. It considers the first 200
videos and fetches no more than four watch pages or caption tracks at once.
Threads and ordinary YouTube URL capture do not change.

## Data contract

`SourceDoc` gains an optional `videoDocs` collection. Each entry represents a
successfully enriched video with its stable video id, canonical watch URL,
title, and rendered Markdown. It is a persisted capture snapshot, not a
reference to a later network request.

`planIngestUnits` prefers a `videoDocs` text unit for a matching video and
otherwise emits the existing canonical YouTube URL unit. Both retain the same
`youtube:<videoId>` ledger identity. The text unit hashes its Markdown; the
fallback unit hashes its URL. Existing stored documents without `videoDocs`
continue through JSONL and Markdown URL extraction unchanged.

## Enrichment pipeline

1. Fetch the canonical watch page and extract `ytInitialPlayerResponse`.
2. Parse caption tracks and choose deterministic priority: manual English,
   English ASR, then the first available track.
3. Extract automatic chapters from `multiMarkersPlayerBarRenderer` when
   present.
4. Fetch the selected caption URL as `fmt=json3`, parse nonempty cues, and
   render one Markdown document for the video.

Missing tracks, drifted HTML, an empty or malformed json3 response, network
failure, and a capped video are all per-video fallback states. Signed caption
URLs must not be logged. A playlist is saved even when every video falls back.

## Boundaries

- `adapters/youtube/transcript.ts` is pure parsing and rendering support:
  player response, caption selection, chapters, and json3 cues.
- `adapters/youtube/enrich.ts` is the bounded fetch orchestrator.
- YouTube capture invokes enrichment only after a normal playlist has been
  captured successfully.
- The router performs enrichment before `formatCapture` and `upsertDoc`, so
  the stored document and durable queue receive the same immutable content.
- `ingest/units.ts` is the only ingest change: it decides enriched text versus
  URL fallback. Queue and drain remain generic over `IngestUnit`.

## UX

The popup exposes a playlist-only opt-in. It communicates enrichment as best
effort: successful transcript sources are imported as text, while other videos
remain normal YouTube URL sources. The existing compact playlist card can show
an enriched/fallback count without promising captions for every video.

## Verification

Pure tests cover track selection, chapter parsing, json3 parsing, empty and
malformed inputs, and transcript rendering. Orchestration tests prove a
per-video failure falls back without aborting the playlist, concurrency never
exceeds four, and the 200-video cap holds. Format/unit tests prove enriched
videos become text units, fallback videos remain URL units, and legacy stored
documents preserve their existing behavior. The full repository gate remains
required.
