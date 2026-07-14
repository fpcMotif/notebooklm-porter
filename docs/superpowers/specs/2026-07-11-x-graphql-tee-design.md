# X GraphQL tee design

## Goal

Improve X thread capture when the virtualized DOM omits posts or clips long
text, without issuing a request to X, hardcoding a rotating query id, or
making DOM capture unavailable when GraphQL data is absent.

## Chosen approach

Install a passive MAIN-world tee at `document_start`. It observes the page's
own `fetch` and XHR responses only for `TweetDetail` and
`TweetResultByRestId`, clones successful fetch responses, and publishes bounded
JSON strings to the isolated content script through one `CustomEvent`. The
isolated content script owns a document-local map of parsed `RawTweet`s and
uses it after the existing DOM scroll-drain; it selects GraphQL tweets only
when it observed the requested root status id, otherwise it retains the DOM
result exactly as today.

The alternatives are rejected:

- A direct GraphQL client would require query ids, headers, and session
  credentials that rotate and would introduce a second, mutating-looking X
  network path.
- Replacing the DOM capture entirely would make a transient tee miss turn into
  a hard failure. The DOM remains the reliable floor.

## Modules and seams

- `core/adapters/x/graphql.ts` is the deep pure module. Its interface accepts
  unknown JSON and returns normalized `RawTweet[]`; its implementation owns
  graph traversal, wrapper unwrapping, tombstone skipping, long-post priority,
  quote extraction, media/link normalization, deduplication, and timestamp
  conversion.
- `entrypoints/x-tee.content.ts` is the MAIN-world adapter. It owns only page
  monkey-patching and event emission. It never parses tweets, sends requests,
  or calls extension APIs.
- `entrypoints/x.content.ts` is the isolated-world adapter. It validates event
  detail, invokes the pure module, stores document-local snapshots, and merges
  them at the existing `RawTweet` seam.

## Invariants

- The tee always returns the original page fetch/XHR behavior untouched.
- Only a successful response body under a fixed size limit is emitted.
- No query id, auth header, or X request is manufactured by Porter.
- A GraphQL snapshot is used only if it contains the requested status id or
  its matching conversation id; unrelated feed traffic cannot replace the
  current capture.
- No graph data means the existing DOM scroll-drain is unchanged.
- A parser failure or malformed event is ignored locally and never breaks the
  page or capture request.

## Verification

Use frozen synthetic response fixtures to prove wrapper unwrapping,
`TweetTombstone` exclusion, `note_tweet` long-text preference, quote/media/link
mapping, conversation filtering, deduplication, and event-shape validation.
Run the full project gate. Live signed-in X validation remains a separate
acceptance gate: confirm one standard thread and one long post through the
real extension before treating the tee as a replacement for DOM capture.
