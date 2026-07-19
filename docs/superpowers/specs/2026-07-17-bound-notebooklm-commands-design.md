# Bound NotebookLM commands design

## Goal

Keep every NotebookLM action bound to the account and notebook the user chose, even when the popup
closes, reopens, or changes account before the background handler starts.

## Problem

The popup controller owns strong request-order rules, but its lifetime ends with the popup. Several
wire messages carry only a title or notebook ID. Their background workflows later read mutable
settings to choose an account.

This creates a time-of-check/time-of-use gap:

1. The user starts create under account A.
2. The catalog permit delays that create.
3. The popup closes. A new popup switches to account B.
4. The delayed create reads B from settings and creates there.

Source Console, enqueue, and watch creation have the same unstamped intent. A local generation or
pending flag cannot protect work after its popup disappears.

## Domain rules

- A **NotebookLM account binding** is immutable `{ authuser, accountEmail }`. The slot chooses a
  live session; the observed email proves that the slot still names the intended account.
- A **Notebook target** adds `notebookId` to that binding.
- Account-sensitive wire messages carry the binding captured at dispatch. Background code never
  re-reads mutable selection to choose a remote account.
- Catalog list and create carry a NotebookLM account binding.
- Source Console, enqueue, and watch creation carry a Notebook target.
- Every received binding is authenticated again in the background. A reassigned slot fails closed
  before a notebook RPC or mutation.
- Enqueue and watch creation still require a fresh notebook listing that contains the bound target.
- Durable receipts, watch IDs, queue fairness, and queued-version supersession use the complete
  target. Notebook ID or email alone never identifies their owner.
- Source Console authenticates the bound account. Its existing notebook RPC remains the source of
  notebook access truth; no extra browse-list request is added.
- Source Console commands share one background permit. Popup-local locks remain useful UX, but are
  not the correctness boundary.
- A failed read-only Source Console scan preserves the last scan for the same current target and
  reports the error. A failed mutation clears it because the remote outcome may be uncertain.
- `porter/get-settings` joins the FIFO settings lane. A bootstrap read cannot observe the middle of
  an earlier settings read-modify-write.
- Enqueue records a remembered target only when the current settings binding still equals the
  command binding. A completed action for A cannot write A's notebook choice into an active B view.
- Ambiguous create outcomes remain uncertain. No layer retries a create mutation.
- Drive Client ID editing is field-scoped and remains independent of account-command activity.

## Designs considered

### Keep popup generations as the boundary

Rejected. They protect one controller instance. Popup teardown deletes the lock while background
work continues.

### Bind create only

Rejected. It fixes the reproduced mutation but leaves the same lifetime leak in Source Console,
enqueue, and watch creation. One message pattern should express all NotebookLM intent.

### Persist popup locks

Rejected. A durable lock protocol adds storage, expiry, and recovery policy while still failing to
name the intended account. Immutable command data solves the cause.

### Bind every account-sensitive command

Chosen. The message itself carries intent. Account ownership authenticates it. Catalog and Source
Console keep their existing protocol policy behind their deep interfaces.

## Interfaces

```ts
interface NotebookLmAccountBinding {
  authuser: number
  accountEmail: string
}

interface NotebookTarget extends NotebookLmAccountBinding {
  notebookId: string
}

accountBindingFor(settings): NotebookLmAccountBinding | undefined
notebookTargetFor(settings, notebookId): NotebookTarget | undefined
sameAccountBinding(left, right): boolean
sameNotebookTarget(left, right): boolean
authenticateBoundAccount(binding)
verifyNotebookTarget(target)
```

Wire shapes use `account` for catalog commands and `target` for notebook commands. They do not carry
session tokens.

## Module ownership

- `accounts/ownership.ts` owns binding construction, equality, authentication, and fresh target
  verification.
- `notebooks/catalog.ts` owns bound catalog sessions, cache policy, create serialization, and create
  uncertainty.
- `ingest/sources/console.ts` owns bound Source Console authentication and its global operation
  permit.
- `notebooks/workspace.ts` captures the current binding or target before dispatch.
- `router.ts` translates bound messages into those deep interfaces. It does not choose an account.
- `background.ts` preserves storage read/write coherence through declared lanes.
- `App.tsx` stamps queue/watch targets and keeps Drive editing independent of account activity.

## Verification

Tests must prove:

- Binding construction needs both the active slot and observed email.
- Reassigned bindings fail before notebook RPCs.
- A catalog create queued behind the permit still uses its original account after settings switch.
- Catalog list uses the message binding, not current settings.
- Source Console commands for different popup lifetimes cannot overlap.
- Source Console mutation under A cannot authenticate or mutate under B.
- A scan failure preserves a current prior scan; a mutation failure invalidates it.
- Enqueue and watch creation verify the message target, not current selection.
- A stale enqueue does not overwrite remembered targets for another active binding.
- A settings read waits for an in-flight settings write and returns the committed value.
- Drive editing remains available during account activity and only merges its own field.
- Existing create uncertainty, queue durability, and cache behavior remain unchanged.

The full gate remains `bun run check`. Signed-in Chrome smoke remains required for account switch,
catalog create, Source Console, enqueue, and watch routing.

## Scope

- No session tokens on the wire.
- No new storage key or durable lock.
- No replay of create or whole Source Console workflows. Existing bounded idempotent-delete retry
  remains unchanged.
- No visual redesign.
