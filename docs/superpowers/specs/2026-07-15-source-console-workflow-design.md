# Source Console workflow design

## Goal

Make Source Console a deep module. Hide bound-account authentication, source inspection,
duplicate removal, retry, post-mutation re-listing, global exclusion, and diagnostic logging from
the router. Preserve behavior.

## Current problem

`src/core/ingest/sources/console.ts` only combines pure analysis results. The router still owns
three remote workflows:

- authenticate, list, analyze, and log;
- list, choose duplicate keepers, delete sequentially, re-list, and analyze;
- refresh once, log, re-list, and analyze.

Deleting the current module moves a few lines. Deleting the deepened module would return account
checks, mutation order, post-mutation re-listing, and logging to three router branches. That passes the
deletion test.

## Required behavior

- Accept an immutable Notebook target `{ authuser, accountEmail, notebookId }` for each workflow.
- Re-authenticate that binding once in the background before any source RPC.
- Reject a reassigned `authuser` before any source RPC. Never re-read mutable account selection to
  choose a remote account.
- Hold one background permit around each complete workflow. Commands from separate popup lifetimes
  cannot overlap.
- Keep RPC operation IDs fixed. Pass notebook and source IDs from runtime data.
- Auto-dedupe only a URL that resolves to a validated YouTube video identity. Watch, short, and
  `youtu.be` forms collapse to the video ID; a watch URL with `list` is playlist context and still
  identifies that video. Generic HTTP(S) URLs, even exact matches or normalizations, never
  authorize deletion. Titles are display-only: URL-less, blank, or malformed sources never
  auto-group or delete.
- Keep keeper ranking and stable removal order unchanged for YouTube-video groups.
- Delete duplicates sequentially. Stop at the first final failure.
- Keep DELETE_SOURCE's existing idempotent retry policy: retry network failures, HTTP 429, and
  HTTP 5xx at most twice with jittered exponential backoff; do not retry other failures.
- Never retry REFRESH_SOURCE automatically.
- Authorize a retry from a fresh source list. The requested ID must still be failed and diagnose to
  `retry: 'refresh'`; missing, healthy, and manual-only sources fail closed before mutation.
- Re-list only after every requested mutation succeeds. The re-list is returned truth.
- Preserve typed transport, login, drift, and refusal failures.
- Preserve current success replies, error text, popup text, and privacy-safe log facts.
- Keep tolerant source-row decoding unchanged.

## Considered interfaces

### One command union

`runSourceConsole(intent)` minimizes function count but adds a command union, overloads, and
result narrowing. The interface becomes denser than three direct calls.

### Scoped capability and mutation plans

`withSourceConsole(notebookId, scope => scope.execute(plan))` could support future manual delete
and batch refresh. Those uses do not exist. The callback, plan types, and lifetime rules are
speculative generality.

### Three named workflows

Chosen. Each entry matches one product intent and returns its natural result:

```ts
export type SourceConsoleError =
  | FetchError
  | HttpStatusError
  | IpcError
  | NotLoggedIn
  | ProtocolDrift
  | RpcRefused

export type SourceConsoleDeps = Http | DebugLog

export function scanSourceConsole(
  target: NotebookTarget,
): Effect.Effect<ConsoleScan, SourceConsoleError, SourceConsoleDeps>

export function removeSourceDuplicates(
  target: NotebookTarget,
): Effect.Effect<
  { readonly scan: ConsoleScan; readonly removedIds: string[] },
  SourceConsoleError,
  SourceConsoleDeps
>

export function retryNotebookSource(
  target: NotebookTarget,
  sourceId: string,
): Effect.Effect<ConsoleScan, SourceConsoleError, SourceConsoleDeps>
```

Three small entries give router callers the simplest interface. The implementation hides account
authentication, session details, RPC sequencing, analysis, post-mutation re-listing, and logs.

## Module seam

The interface remains in `src/core/ingest/sources/console.ts`.

- `Http` is the true external seam. Production and test adapters already exist.
- `DebugLog` is an existing local-substitutable seam.
- Account ownership is reused through `authenticateBoundAccount(target)`.
- RPC transport stays in `ingest/rpc/client.ts`.
- Batchexecute decoding stays in `ingest/rpc/protocol.ts`. URL normalization, keeper choice, and
  failure diagnosis stay in the pure sibling modules under `ingest/sources/`. "Internal" means
  router callers do not compose those stages; it does not require moving or hiding their exports.
- No Source Console adapter is added. One implementation would make that seam hypothetical.

## Workflow order

### Scan

Acquire permit -> authenticate binding -> list sources -> analyze -> log counts -> return scan ->
release permit.

### Remove duplicates

Acquire permit -> authenticate binding -> list sources -> compute stable removal IDs -> log plan ->
delete each ID in order -> re-list -> analyze -> return fresh scan and acknowledged IDs -> release
permit.

If a delete fails, later deletes and the final re-list do not run. Earlier acknowledged deletes
remain applied. The existing failure reply does not claim partial success.

Zero removals still trigger the second list. This preserves current behavior.

### Retry source

Acquire permit -> authenticate binding -> list sources -> diagnose the requested ID -> refresh once
only when it is currently failed with `retry: 'refresh'` -> log success -> re-list -> analyze ->
return fresh scan -> release permit.

Missing, healthy, and manual-only IDs fail with `IpcError` before REFRESH_SOURCE. This list is the
authorization check, not a stale popup projection.

If a post-mutation list fails, propagate that typed failure. The acknowledged remote mutation
remains applied. Do not replay the mutation. Return no success or partial-success payload.

## Errors and replies

The module propagates `FetchError`, `HttpStatusError`, `NotLoggedIn`, `ProtocolDrift`, and
`RpcRefused` unchanged. Ineligible retries fail with `IpcError`. The router remains responsible
for flattening typed errors into the existing reply text.

Applicable error text remains exact:

- `Not signed in to notebooklm.google.com for account <authuser> — open it and sign in`;
- `NotebookLM protocol changed (drift): <snippet>`;
- `NotebookLM refused (<code>)`;
- `Request to <url> failed (<status>)`;
- `Network request to <url> failed`;

Success shapes remain:

- scan: `{ scan }`;
- remove duplicates: `{ scan, removedIds }`;
- retry: `{ scan }`.

Popup text remains exact:

- `Removed 1 duplicate source`, or `Removed N duplicate sources` for other counts;
- `Retry requested — re-scan in a moment to see the new status`.

Diagnostic log contracts remain:

- scan: scope `console`, message `scan`, after analysis, with `notebookId`, `sources`,
  `duplicateGroups`, `duplicates`, and `failed`;
- dedupe: scope `console`, message `dedupe`, before deletion, with `notebookId`, `sources`, and
  `removing`;
- retry: scope `console`, message `retry`, after refresh and before re-list, with `notebookId` and
  `sourceId`.

These log entries never include account email, source title, source URL, or source content.

## Test seam

The three workflow functions are the interface and primary test seam. Tests use the existing
`Http` and `DebugLog` adapters. Pure protocol, duplicate-policy, and diagnosis tests remain.

Required workflow tests:

- scan authenticates once, lists once, returns analysis, and logs counts;
- account mismatch performs no source RPC;
- commands from separate callers cannot overlap, including authentication and final re-list;
- duplicate deletion follows the stable plan and returns re-listed truth;
- same-title or generic-URL sources without validated video identities produce no delete requests;
- a middle deletion failure prevents later deletes and the final re-list;
- zero duplicates still performs the post-plan re-list;
- retry authorizes a current failed refreshable source, runs once, and re-lists only after success;
- missing, healthy, and manual-only retry IDs fail with no refresh request;
- a failed post-mutation re-list propagates without replaying the mutation;
- dynamic notebook and source IDs reach RPC paths and envelopes;
- typed drift, refusal, and transport failures remain distinct.
- scan, dedupe, and retry preserve their exact diagnostic log facts and ordering.

Interface tests own workflow behavior. Router tests retain bound-message-to-result mapping,
friendly error flattening, and the integration proof that a reassigned binding is rejected.

## Non-goals

- No popup redesign.
- No new source-management actions.
- No durable lock or new storage lane. The in-process permit is the correctness mechanism.
- No partial-success reply redesign.
- No fresh notebook-catalog proof before Source Console actions.
- No diagnosis-policy changes.
- No live-RPC acceptance claim without an authenticated browser run.

## Self-grill decisions

- Put authentication inside the module? Yes. Source Console means the command's bound account and
  notebook, and raw sessions should not escape to the router.
- Add a source backend port? No. `Http` already supplies the real seam.
- Merge RPC protocol code into the module? No. Transport varies independently.
- Add a generic mutation plan? No current caller needs it.
- Serialize concurrent popup actions here? Yes. A popup-local lock disappears when the popup
  closes; one background permit covers all callers and the whole remote workflow.
- Use titles or generic URLs as destructive duplicate identities? No. They are display or locator
  data, not proof of the same captured content. Only validated YouTube video identity authorizes
  auto-dedupe.

Bound-account authentication proves the stamped email still matches the live session in the
stamped slot. It does not add a catalog-list round trip. The existing source RPC remains the access
check for the stamped notebook ID.
