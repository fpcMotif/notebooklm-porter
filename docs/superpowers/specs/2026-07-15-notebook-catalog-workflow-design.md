# Notebook catalog workflow design

## Goal

Make notebook browsing and creation one deep module. Remove authentication, cache, mutation,
read-after-write, and created-row reconciliation policy from the router. Bind every catalog action
to the NotebookLM account chosen at dispatch. Prevent cache faults, account switches, or ambiguous
creation outcomes from inviting unsafe duplicate creation.

## Domain rules

- The notebook catalog is browse data for one NotebookLM account binding: `authuser` plus observed
  email.
- Every catalog action receives that immutable binding. It never reads mutable settings to choose
  a remote account.
- Every valid catalog action freshly authenticates its binding before using RPC or cache data.
- A reassigned slot fails `NotLoggedIn` before any catalog RPC or mutation.
- Catalog actions run one at a time through a module-owned semaphore.
- A cache hit requires both the bound slot and the email observed by fresh authentication.
- Cached catalog data never proves notebook ownership. Queue and watch creation still use
  `verifyNotebookTarget`.
- Create uses a fresh pre-list and never retries the mutation.
- A created notebook is identified only by a response ID that was absent from the pre-list.
- An ambiguous mutation failure is re-listed for fresh browse truth but never claimed as success.
  It never replays the mutation.
- Cache storage is an optimization. Cache failure cannot fail a successful remote list or a
  confirmed creation.

## Rejected designs

### One command union

`runNotebookCatalog({ kind: ... })` would make callers learn tags, overloads, and correlated
results. Named read, refresh, and create intents are clearer.

### Open catalog capability

An `openNotebookCatalog()` value could capture a session for several operations. Current callers
perform one action per message. Its lifetime and staleness rules would be speculative.

### Catalog port

Only one catalog implementation exists. `Http`, `Kv`, and `DebugLog` already provide real and test
adapters. A second interface would add ceremony, not depth.

### Mutable-selection authentication

Reading settings after the catalog permit would choose whichever account is active when the
workflow starts, not the account named when the user acted. Popup generations cannot close that
cross-lifetime gap. The command therefore carries a NotebookLM account binding and the catalog
authenticates that binding after it acquires the permit.

## Chosen module

`src/core/notebooks/model.ts` owns `NotebookMeta`. Messaging, cache, protocol decoding, ownership,
and catalog workflows import that domain type instead of defining transport and cache copies.

`src/core/notebooks/catalog.ts` exposes three workflows:

```ts
export interface CreatedCatalogNotebook {
  readonly notebooks: NotebookMeta[]
  readonly created: NotebookMeta
}

export type NotebookCatalogError =
  | FetchError
  | HttpStatusError
  | NotebookCreationUncertain
  | NotebookTitleInvalid
  | NotLoggedIn
  | ProtocolDrift
  | RpcRefused

export type NotebookCatalogDeps = Http | Kv | DebugLog

export function readNotebookCatalog(
  binding: NotebookLmAccountBinding,
): Effect.Effect<
  NotebookMeta[],
  NotebookCatalogError,
  NotebookCatalogDeps
>

export function refreshNotebookCatalog(
  binding: NotebookLmAccountBinding,
): Effect.Effect<
  NotebookMeta[],
  NotebookCatalogError,
  NotebookCatalogDeps
>

export function createCatalogNotebook(
  binding: NotebookLmAccountBinding,
  title: string,
): Effect.Effect<CreatedCatalogNotebook, NotebookCatalogError, NotebookCatalogDeps>
```

Cache-specific `StorageError`s are recovered inside the module and do not leak through its public
error interface.

`src/core/fx/errors.ts` adds two needed domain errors:

```ts
export class NotebookCreationUncertain extends Data.TaggedError('NotebookCreationUncertain')<{
  authuser: number
  stage: 'create-request' | 'post-create-list' | 'created-notebook'
  reason: 'network' | 'http-status' | 'protocol-drift' | 'rpc-refused' | 'missing-id'
  status?: number
}> {}

export class NotebookTitleInvalid extends Data.TaggedError('NotebookTitleInvalid')<{}> {}
```

The central friendly-error seam maps it to
`Notebook creation may have succeeded. Refresh notebooks before retrying.`
It maps `NotebookTitleInvalid` to `Enter a notebook title`.

The router maps messages only:

- The message account binding into every workflow.
- `forceRefresh === true` to `refreshNotebookCatalog`; otherwise `readNotebookCatalog`.
- Catalog arrays and created rows into the existing success replies.
- Typed failures through the existing central friendly-error seam.

## Read workflow

1. Freshly authenticate the supplied NotebookLM account binding.
2. Fail closed when its slot no longer exposes the bound email.
3. `readNotebookCatalog` with a live email tries the exact slot-and-email cache entry.
4. On cache hit, log `catalog/list` with `{ authuser, source: 'cache', count }` and return it.
5. On cache miss, explicit refresh, or cache-read failure, call `listNotebooks`.
6. Log `catalog/list` with `{ authuser, source: 'remote', count }`.
7. Try to replace that slot-and-email cache entry.
8. Return the remote list even when cache replacement fails.

Cache read or write failure logs `catalog/cache-failed` at warning level with only `authuser` and
`operation: 'read' | 'write'`. A write first reloads the cache so other account slots survive. If
that reload fails, log a write failure and skip the write. Do not synthesize an empty cache.

The list RPC keeps its existing bounded policy: network, 429, and 5xx failures inside an HTTP
attempt get two retries on the jittered exponential schedule; 4xx, protocol drift, and RPC refusal
do not retry. The existing 20-second timeout wraps the whole retry program and is not itself
retried.

Catalog decoding is strict. `parseNotebookList` accepts the verified direct and one-level nested
row shapes. The exact grammar is:

- Direct empty: `[]`.
- Direct nonempty: `[row, ...]`, where every row has a string title at index 0 and string ID at
  index 2.
- Nested: `[rows]` or `[rows, null]`, where `rows` is empty or every row is valid by the same rule.
  A one-element outer array is decoded as a direct single row only when that element itself has a
  string title and ID; otherwise it is the verified nested form. Thus `[[]]` is nested empty.

No other tail, wrapper, or malformed row is accepted. `null`, mixed valid/malformed rows, and
unknown containers throw protocol drift. A partial or unknown payload can never become an
authoritative list or `[]`. `listNotebooks` lifts the throwing pure decoder into typed
`ProtocolDrift`.

## Create workflow

1. Trim the title. An empty result fails `NotebookTitleInvalid` before authentication or HTTP. The
   trimmed value is the only title passed to the RPC.
2. Freshly authenticate the supplied NotebookLM account binding.
3. Fetch a fresh pre-create list. Never use cache for this proof.
4. Call `createNotebook` once. It has `retry: false`.
5. The RPC client returns `CreateNotebookAck { hintedId?: string }`. The protocol decoder accepts
   direct `[title, null, id]` and one-level-nested `[[title, null, id]]` hints. `null`, arrays without
   a string ID at index 2, and unknown payloads become an acknowledged `{}`. Catalog code never sees
   wire arrays or `unknown`.
6. On an acknowledged result, fetch an immediate fresh list.
7. Search only rows whose IDs were absent before creation:
   - Prefer a response ID when it identifies one new row.
   - Never infer causality from title or list position.
8. If no row is found, wait 400 ms and re-list, at most twice more.
9. A missing hint or a hinted ID still absent after the bounded re-lists is
   `NotebookCreationUncertain`, not protocol drift. Delayed visibility must not invite a retry.
10. A mutation `FetchError`, `ProtocolDrift`, HTTP 408, 425, 429, or 5xx is ambiguous. Attempt
   exactly one fresh reconciliation list. On success, update browse cache best-effort. On list
   failure, leave cache unchanged. Then fail
   `NotebookCreationUncertain`. Never claim a row as this operation's creation.
11. `RpcRefused`, 3xx, and other 4xx statuses propagate without a re-list.
12. Any post-acknowledgement list failure becomes `NotebookCreationUncertain`.
13. Uncertainty records privacy-safe `stage`, `reason`, and optional HTTP `status` in the error and
    a warning-level `catalog/create-uncertain` log with exactly
    `{ authuser, stage, reason, ...(status !== undefined ? { status } : {}) }`. Internal re-lists do
    not emit `catalog/list`. The uncertainty log precedes any best-effort cache write; a cache
    warning therefore follows it.
14. On success, log `catalog/create` with `{ authuser, notebookId }`.
15. Try to replace the cache from the successful final list. Return success even if that write
    fails.

Catalog-level logs never include the notebook title. The RPC layer replaces raw parse-failure
response heads and raw-response exception snippets with byte counts. Its failure log uses only the
sanitized typed error. The workflow never issues a second create request.

## Concurrency

A module-level `Semaphore.makeUnsafe(1)` is created once when the module loads and shared for the
service worker's lifetime. Its `withPermit` covers each complete read, refresh, and create workflow.
Tests share the same instance; scoped permit release means they need no reset.
It serializes the cache's load-modify-save cycle and prevents this extension from overlapping
catalog mutations. The response ID remains a hint; the strict pre/post ID difference remains the
source of browse truth. Without a matching hint, creation stays uncertain. External NotebookLM
clients can still mutate concurrently, so titles and row positions never establish causality. No
entrypoint lane or new service is needed.

Only public entries acquire the permit. They call unlocked private helpers. Private helpers never
call public entries or reacquire the semaphore.

## Failure and cache semantics

- Authentication, pre-list, and explicit RPC refusal propagate unchanged.
- No pre-list means no create.
- A post-mutation failure never replays create.
- Prior cache data remains unchanged after remote list failure. An ambiguous mutation may update
  browse cache only when its fresh re-list succeeds.
- Cache corruption still decodes as the existing empty cache.
- Cache failures are observable warnings, not product-operation failures.
- NotebookLM home-page HTTP statuses, including 401, retain current `HttpStatusError` behavior.
  This follows the later authenticated-account design's RPC-error preservation rule; catalog work
  does not change global session semantics.

## Verification

Direct catalog tests prove:

- Fresh binding authentication precedes every cache read or RPC.
- Account mismatch fails before list or create RPC.
- A create queued behind the module permit retains its supplied binding after mutable settings
  switch accounts.
- Exact-email cache hit skips list RPC.
- Forced freshness, cache email mismatch, and cache-read failure use a remote list.
- Remote success survives cache-write failure; remote failure does not replace cache.
- A cache-read failure followed by a successful write reload preserves every other account slot.
- Blank and whitespace-only titles fail with `NotebookTitleInvalid` before HTTP.
- Create timeline is pre-list, one create, then bounded post-lists.
- Direct and nested response-ID hints resolve only a genuinely new matching row.
- Null acknowledgements, missing IDs, titles, sole unrelated rows, and multiple new rows never
  establish causality.
- Read-after-write lag uses exactly two 400 ms retries under the virtual clock.
- Ambiguous create failure re-lists but never returns success or replays mutation.
- Ambiguous and post-list-failed mutations return `NotebookCreationUncertain`.
- RPC refusal performs no reconciliation list.
- Logs prove remote-list then cache-write-warning, catalog-create then cache-write-warning, and
  catalog-create-uncertain without a `catalog/create` entry. No log contains the title.
- Concurrent effects serialize their HTTP and cache timelines.
- Cache-miss read and create complete without semaphore re-entry. Overlapping create/create and
  read/create timelines never interleave.
- Strict decoding rejects malformed rows and unknown shapes while preserving verified empty lists.
- Ownership rejects malformed listings with typed drift. Queue preflight routes the same drift
  through its existing fallback policy.

Router tests retain only message-to-workflow mapping and friendly-error flattening. Cache and RPC
protocol tests remain at their existing seams. Run `bun run check` after migration.

## Scope

- No popup redesign.
- No cache TTL or schema migration.
- No session token on the wire and no durable catalog lock.
- No new adapter, service, or entrypoint serialization lane.
- Two catalog domain errors and one module-owned semaphore.
- Both new errors join the complete global `PorterError` union and central friendly mapping.
- No retry-policy expansion.
