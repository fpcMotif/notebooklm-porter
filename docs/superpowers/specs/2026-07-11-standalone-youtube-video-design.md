# Standalone YouTube video capture design

## Goal

Capture a single public YouTube watch URL as one durable NotebookLM YouTube
source, without pretending it is a one-item playlist and without duplicating a
video already imported through a playlist.

## Chosen approach

Add a first-class `Video` capture/domain shape. The YouTube adapter detects a
watch URL with `v=` only (and `youtu.be/<id>`), while any URL with `list=`
remains a playlist capture. A small pure video module canonicalizes URLs and
reads best-effort title/channel/duration from `ytInitialPlayerResponse`; the
background capture wrapper only fetches the watch page.

The stored `SourceDoc` has `kind: 'video'`, a canonical watch URL, and an id
of `youtube:<videoId>`. Its ingest plan is exactly one URL unit with the same
`youtube:<videoId>` unit id used by playlist videos. That shared identity is
the idempotency rule: importing a video standalone and through a playlist
does not create two NotebookLM sources in the same target notebook.

## Alternatives rejected

- Model a standalone video as a single-item playlist. That leaks playlist ToC
  behavior, UI labels, and future watch semantics into a different domain.
- Paste the captured metadata as text. NotebookLM's native YouTube importer is
  the intended source type; text would lose the provider's video grounding.
- Require metadata parsing to succeed. The URL is already sufficient for a
  valid import, so page-shape drift degrades only the display title, never the
  capture itself.

## Modules and seams

- `core/adapters/youtube/video.ts` is the pure module for URL normalization
  and player-response metadata parsing.
- `core/adapters/youtube/capture.ts` remains the service-worker fetch adapter
  and dispatches between video and playlist capture.
- `core/format/video.ts` owns export Markdown for the new domain shape.
- `core/ingest/units.ts` owns the one-unit URL plan and its stable receipt id.

## Verification

Unit-test standard and shortened URLs, playlist rejection, metadata fallback,
formatting, adapter detection, and standalone/playlist receipt identity. Run
the full project gate. A live Chrome/NotebookLM source appearance is part of
the existing authenticated P0 acceptance gate.
