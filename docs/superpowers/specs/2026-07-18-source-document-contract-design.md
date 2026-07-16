# Source document contract

## Decision

`SourceDoc` is a discriminated union. A playlist document owns a required
`playlistVideos: VideoEntry[]` snapshot and optional transcript snapshots.
Other document kinds cannot carry those playlist fields. Site and kind are
paired: playlists and videos are YouTube, web captures are `web`, and threads
are X, Reddit, or Hacker News.

`formatCapture` copies playlist rows into this snapshot. The snapshot is the
only planner input for per-video ingest. JSONL and Markdown remain rendered
export artifacts; ingest never reads either to discover videos.

## Ingest

The planner emits the playlist overview first. It then reads `playlistVideos`
in capture order, keeps the first occurrence of each `videoId`, and derives
each canonical URL by encoding the opaque `videoId` as the sole `v` query
value. Transcript
snapshots join by `videoId`; the first snapshot wins. Orphan snapshots do not
produce a source.

## Storage boundary

`porter/docs` decodes every stored row before use. Canonical documents need
own, nonblank `id` and `canonicalUrl` fields plus a canonical ISO
`capturedAt`. An id must be `${site}:${nativeId}`. YouTube source ids must
also match their canonical `v` or `list` URL parameter. Video and transcript
snapshots need nonblank `videoId` values.
The decoder rejects inherited fields, invalid shapes, and explicit `undefined`
optionals. Accepted values are cloned.

Old playlist rows may migrate only when `playlistVideos` is absent and every
nonblank JSONL row decodes as a complete `VideoEntry`. A malformed or partial
row rejects that legacy playlist as a whole. Invalid rows never discard valid
sibling documents. Duplicate ids keep the newest capture; equal timestamps
keep the first row. Returned documents are newest-first.

## Consequences

The typed inventory is durable capture truth. Export formatting can change
without changing ingest semantics. Corrupt legacy data fails closed instead of
silently creating a partial NotebookLM import. The planner is total: a bad
standalone YouTube URL produces no unit, and impossible blank playlist ids are
skipped defensively.
