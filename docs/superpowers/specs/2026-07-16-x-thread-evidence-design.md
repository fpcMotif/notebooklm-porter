# X thread evidence design

## Goal

Use passive X GraphQL observations to enrich DOM thread capture without losing DOM rows,
text, media, links, or ordering. Remove host and startup drift between the X adapter and both
content scripts.

## Evidence

Current behavior has four proven faults:

- The tee starts at `document_start`; its receiver starts at `document_idle`.
- Both scripts omit `mobile.twitter.com`, though the adapter advertises it.
- Partial GraphQL coverage discards longer text for matching DOM tweets.
- Full GraphQL coverage can replace better DOM fields with worse values.

The conversation filter also rejects a root-missing response whose rows declare
`conversationId === requestedStatusId`, contrary to the existing tee invariant.

## Chosen design

Deepen `core/adapters/x/graphql.ts` into the X thread evidence module.

Its small stateful interface is:

```ts
const evidence = createXThreadEvidence()
evidence.observe(detail)
const tweets = evidence.resolve(statusId, domTweets)
```

The implementation owns:

- event validation and JSON parsing;
- GraphQL traversal and normalization;
- bounded, document-local evidence storage;
- conversation selection;
- duplicate observation merging;
- DOM/GraphQL reconciliation.

The X content entrypoint owns only DOM scraping, event plumbing, and thread assembly.

## Reconciliation

DOM is the floor.

For matching tweet IDs:

- keep DOM author identity;
- keep the longer text;
- fill missing timestamp and conversation ID;
- keep the longer quoted tweet;
- union links and media without duplicates.

When GraphQL covers every DOM ID, use GraphQL order and include GraphQL-only rows. Merge matching
DOM rows first so GraphQL cannot downgrade them.

When GraphQL coverage is partial, preserve DOM order and enrich matching rows only. Do not append
GraphQL-only rows because their safe position is unknown.

Within one conversation, the observation with the most distinct rows supplies order. An equally
complete later observation replaces that order. A smaller later response may still add links,
media, or conversation identity, but it does not reorder the best complete observation.

## Conversation selection

Use the requested row's `conversationId` when that row exists.

If the requested row is absent, accept the requested ID as the conversation root only when at
least one row declares `conversationId === requestedStatusId`. Reject unrelated traffic.

## Startup and hosts

Both X scripts run at `document_start`. Extension content scripts then install the receiver and
tee before page scripts can issue observed requests.

One exported `X_CONTENT_MATCHES` constant feeds:

- `xAdapter.hostMatch`;
- `x.content.ts`;
- `x-tee.content.ts`.

## Truncation

Keep the DOM drain's conservative `truncated` result. GraphQL enrichment does not prove that every
clipped or unmounted tweet was recovered.

## Rejected designs

### Keep the all-or-nothing selector

Small, but it defeats long-text enrichment and permits field downgrade.

### Append partial GraphQL-only rows

Adds content, but cannot place rows safely without reply-edge or timeline-entry evidence.

### Build an X Article parser now

The product spec names X Articles, but this branch has no frozen response fixture or live payload.
That is feature work, not a justified architecture deepening.

### Add a cross-world replay protocol

Unneeded once both scripts start before page scripts. Add replay only with a reproduced missed
event after the timing fix.

## Verification

Unit tests prove:

- malformed and unrelated observations are ignored;
- evidence stays bounded;
- root-missing conversation matches are accepted;
- unrelated conversations are rejected;
- partial observations enrich matching DOM text;
- full coverage preserves GraphQL order and graph-only rows;
- GraphQL never downgrades DOM text, quote, links, or media;
- repeated observations accumulate evidence while preserving the best complete order.

Static code and the production build prove both scripts share hosts and `document_start`.

Live signed-in X validation remains required before declaring the capture path production-proven:
standard thread, reply permalink, long post, and `mobile.twitter.com`.
