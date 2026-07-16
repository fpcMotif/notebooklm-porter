# Popup notebook workspace design

## Goal

Move account, notebook catalog, selection, creation, Drive-setting, and Source Console policy out
of `App.tsx`. Keep Preact as render glue. Preserve visible behavior while making request order and
stale-result rules directly testable.

## Problem

The popup component owns two generation guards, six related state values, and five multi-request
workflows. The catalog core is deep, but its UI caller is not: account switching, target
resolution, drafts, errors, and stale async completions remain coupled to one 957-line render
function.

Splitting JSX into prop-heavy components does not fix that ownership. It moves lines while leaving
the workflow in `App.tsx`.

## Domain rules

- The **notebook workspace** is the popup's local projection of settings, active account binding,
  notebooks, selected target, and new-notebook draft.
- Fresh captured docs must reach the workspace before bootstrap. Remembered target resolution uses
  the latest docs, not a render-time closure.
- A manual notebook selection made while a list request is pending wins when it remains valid in
  the returned list.
- Account-context operations supersede older account and read-only catalog results. They are
  rejected while a dispatched create or Source Console command is pending. Field-scoped Drive
  writes remain independent.
- Notebook refresh supersedes older refreshes. Create is exclusive once dispatched; account,
  catalog, selection, and another create cannot invalidate an unknown server outcome.
- Only the latest operation within one lane may clear its pending flag or publish that lane's error.
- Switching accounts clears the old catalog and selection immediately. A successful switch lists
  only the new account's notebooks.
- Account discovery runs `accounts-refresh` → `get-settings` → forced catalog refresh.
- Bootstrap runs `get-settings`, then a normal catalog read only when an account exists.
- Create trims the draft. Blank drafts send nothing. Success selects the confirmed created row and
  clears the submitted draft only when the user has not typed a replacement. Failure preserves it.
- Drive Client ID editing is optimistic. Only the latest reply may replace settings. An account
  workflow cannot overwrite the locally edited field, and a Drive reply updates only that field.
- Selection accepts only an ID in the current catalog, or the empty ID.
- Account workflows reject new refresh/create requests until their account context settles.
- Source Console results are keyed by account identity and notebook ID. Changing either after a
  completed command hides old data and prevents destructive actions from using a stale scan.
- Source Console commands share one lane. A command cannot overlap another. Dedupe and retry need
  a current scan that proves the action is valid. Account, catalog, create, and target changes are
  rejected until the command settles. A failed read-only scan preserves the last current scan and
  reports the failure. A failed mutation clears its scan because the remote outcome may be
  uncertain.
- Catalog list/create stamp the current NotebookLM account binding. Source Console commands stamp
  the current Notebook target. The background authenticates that immutable binding; it never
  re-reads mutable selection to choose the remote account.
- Drive editing stays available during account work. Its field-scoped generation and merge make it
  independent of account, catalog, create, and Source Console lanes.

## Designs considered

### Extract rendering components

Mechanical `AccountPicker`, `NotebookPicker`, and `ConsolePanel` extraction shortens `App.tsx` but
creates interfaces with up to 22 props. The parent still owns all workflow state and races. This is
shallow decomposition, so it is rejected as the architecture seam.

### One Preact hook

A large `useNotebookWorkspace` hook would name the workflow but keep policy tied to hook lifecycles
and make concurrency tests depend on a DOM renderer. It also leaves business logic in an
entrypoint. Rejected.

### Pure reducer plus effects in `App.tsx`

A reducer makes transitions testable, but request order, generation ownership, and result
application still leak into the component. The hard part remains unowned. Rejected.

### Preact-free stateful controller

Chosen. One core controller owns state, semantic operations, generations, and subscriptions. It
uses the existing typed `PorterClient` service; no second transport port is introduced. A tiny hook
creates it once and subscribes Preact to immutable snapshot replacements.

## Interface

`src/core/notebooks/workspace.ts` exposes:

```ts
export interface NotebookWorkspace {
  snapshot(): NotebookWorkspaceSnapshot
  subscribe(listener: (snapshot: NotebookWorkspaceSnapshot) => void): () => void
  updateDocs(docs: readonly { site: SiteId }[]): void
  selectNotebook(notebookId: string): void
  editNewNotebookTitle(title: string): void
  bootstrap(): Effect.Effect<void, never, PorterClient>
  refreshNotebooks(): Effect.Effect<void, never, PorterClient>
  discoverAccounts(): Effect.Effect<void, never, PorterClient>
  switchAccount(authuser: number): Effect.Effect<void, never, PorterClient>
  createNotebook(): Effect.Effect<void, never, PorterClient>
  updateDriveClientId(driveClientId: string): Effect.Effect<void, never, PorterClient>
  scanSourceConsole(): Effect.Effect<void, never, PorterClient>
  removeSourceDuplicates(): Effect.Effect<void, never, PorterClient>
  retrySource(sourceId: string): Effect.Effect<void, never, PorterClient>
}
```

The snapshot contains settings, notebooks, selected notebook ID, draft title, catalog/account and
Drive errors, per-operation pending flags, and Source Console state. Its complete object graph is
deeply readonly, and reply objects are copied at the boundary. Operations consume `IpcError` into
their owned error field. Their Effect failure type is `never`; Preact never coordinates typed
transport failures.

The controller exposes semantic actions only. It does not expose arbitrary messages or the raw
client.

## Concurrency model

Four monotonic generations own result publication:

- `accountGeneration`: bootstrap, discovery, and switching.
- `notebookGeneration`: catalog refresh and create.
- `driveGeneration`: Drive Client ID writes.
- `sourceConsoleGeneration`: scans, dedupe, retry, and target revisions.

`draftGeneration` is a separate edit revision. It prevents create-success cleanup from confusing
equal text with the same edit (the ABA case).

Starting an account operation invalidates read-only notebook work but not Drive work. A dispatched
create blocks account and catalog operations until its server result lands; dropping an unknown
create result would invite a duplicate retry. Drive is a global, field-scoped setting: its reply
merges only `driveClientId`, so it cannot restore an old account or catalog. After the first local
Drive edit, account snapshots preserve that local field rather than trusting an older account
workflow snapshot. Refresh/create are rejected while account context is unresolved.

All settings reads and mutations run through the background's FIFO `settings` lane. The scheduler
holds the whole message handler, so each read or read-modify-write completes before the next
starts. The workspace generation drops stale UI replies; the storage lane prevents stale
persisted state.

Account/catalog errors and Drive errors are separate fields. A catalog success cannot hide a Drive
failure, and a successful Drive write cannot clear a catalog failure.

Catalog completion resolves against the controller's current docs and manual selection. It never
captures either at request start. Finalizers clear a pending flag only when their generation is
still current. Thus an older completion cannot clear a newer spinner.

Source Console accepts one command at a time and locks its structured Notebook target until
completion. Its generation changes on every accepted command and every later target revision.
Account-slot, observed-email, and notebook-ID changes clear a completed scan. Dedupe/retry need
that current scan. A→B→A cannot revive A's prior view. This local lock is UX policy; the background
module's global permit enforces cross-popup exclusion.

Every dispatch snapshots immutable intent. Catalog messages carry
`{ authuser, accountEmail }`; Source Console messages carry
`{ authuser, accountEmail, notebookId }`. The controller compares bindings and targets by fields,
not serialized identity or current settings at reply time.

## Preact boundary

`src/entrypoints/popup/useNotebookWorkspace.ts` owns no workflow. It creates one controller, seeds
state from `snapshot()`, subscribes on mount, and returns both values.

`App.tsx` must:

1. Load active-tab and general popup state as before.
2. Call `updateDocs(listedDocs)` before `bootstrap()`.
3. Render workspace snapshots.
4. Run semantic workspace Effects through the existing popup runtime.
5. Render Source Console state and run its semantic controller actions.
6. Disable conflicting create, refresh, account, and Source Console actions; controller guards
   remain authoritative. Do not disable Drive Client ID editing for account activity.

The controller stamps catalog and Source Console wire messages with their immutable account or
target. The background's storage-lane scheduler moves to a testable core module; settings reads now
join the same FIFO lane as writes.

## Verification

Controller tests prove:

- Bootstrap order, cached catalog use, remembered target resolution, and no-account clearing.
- Discovery order and forced refresh.
- Manual selection and docs updates during a pending refresh.
- Refresh-vs-refresh pending ownership and stale refresh after account switch.
- Two rapid switches: only the last publishes and clears pending.
- Trimmed create success, blank no-op, failure/retyped-draft preservation, and exclusive dispatched
  create side effects.
- Draft ABA: editing away and back to the submitted text still preserves the newer revision.
- Invalid manual target rejection.
- Out-of-order Drive replies, both Drive/bootstrap orders, and account-switch overlap.
- Cross-lane error ownership and account-pending notebook rejection.
- Source Console target locking, mutual exclusion, completed A→B→A invalidation, destructive
  preconditions, scan-failure preservation, mutation-failure invalidation, and retry routing.
- Exact account/target stamping for catalog and Source Console commands.
- Drive editing remains enabled and field-independent during account activity.
- Deep-readonly snapshot copies, replacement, and unsubscribe behavior.
- A delayed popup-open bootstrap cannot publish after refresh starts, even while fresh docs wait.
- Storage-lane FIFO ordering against one delayed shared KV store in both patch arrival orders.

The full gate proves format, lint, strict typecheck, all unit suites, and production extension build.
Popup browser smoke checks remain required for signed-in account listing, switch, creation, target
selection, Drive editing, and Source Console routing.

## Scope

- No visual redesign.
- No new message type, storage key, or durable background lock.
- No component-extraction acceptance by line count.
- No RPC operation or retry-policy change.

## Popup refresh projection

`src/core/popup/refresh.ts` owns the popup's docs, active-tab detection, queue, and watch read
projection. It is Preact-free. Its adapter is the small `usePopupRefresh` hook.

Each refresh starts one monotonic revision before any I/O. A completion checks that revision after
every await. A stale refresh cannot publish, update workspace docs, bootstrap the workspace, or
clear a newer pending state. A current list-docs reply updates workspace docs before bootstrap.
At refresh start, it synchronously supersedes only an in-flight popup-open bootstrap. That clears
the bootstrap spinner and rejects its later settings/catalog replies; it does not disturb discovery,
account switching, creation, or user-dispatched catalog work.

Detect failures, tabs without a URL, and non-capturable new tabs clear the prior capture CTA and
transcript capability. Queue and watch action replies use their own accept methods. They supersede
an older refresh only for that domain; they do not invalidate docs, detection, or workspace work.

The coordinator does not own capture, ingest, backup, debug, or UI draft state.
