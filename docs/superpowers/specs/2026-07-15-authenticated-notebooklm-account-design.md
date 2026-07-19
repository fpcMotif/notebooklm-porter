# Authenticated NotebookLM account design

## Goal

Give the `authuser`-to-email safety rule one home. Preserve current queue durability, Tier A/B
routing, cache policy, RPC errors, and user-visible responses.

## Domain rules

- `authuser` is positional. It never identifies an account by itself.
- A blank or whitespace-only observed email is not an account.
- An authenticated account exists only when the live session email exactly matches the expected
  NotebookLM account email.
- A notebook target binds notebook ID, `authuser`, and account email immutably.
- Every durable target key includes all three fields. Receipt, watch, and queue state never narrows
  ownership back to notebook ID or email alone.
- Enqueue and watch creation require a fresh NotebookLM listing that contains the notebook.
- Queue drain re-authenticates the stored account binding. Its existing Tier A canary still owns
  fresh notebook listing and fallback policy.
- Cached notebooks remain browse-only. Cache reads still require a fresh live identity observation.

## Rejected designs

### Ownership scopes

Callback scopes would hide session tokens, but their interface would absorb catalog creation,
Source Console, delivery, and every future NotebookLM operation. Depth would fall as the
interface grew. Locality belongs in those modules, not account ownership.

### Fresh ownership proof for every drain path

Requiring a successful notebook listing before every delivery would disable the approved Tier B
fallback precisely when the Tier A list protocol drifts. Account authentication and tier routing
must remain distinct decisions.

### A new account port

Only one account implementation exists. `Http` already has production and test adapters. Another
seam would be hypothetical.

## Chosen module

`src/core/accounts/ownership.ts` exposes one binding vocabulary and three responsibilities:

- Derive an immutable account binding or notebook target from one settings snapshot.
- Authenticate an immutable account binding.
- Verify an immutable notebook target through a fresh listing.

The module returns authenticated values. It does not own catalog creation, source workflows,
tier routing, queue state, or retry policy.

## Interface

```ts
interface AuthenticatedNotebookLmAccount {
  authuser: number
  email: string
  session: NblmSession
}

interface NotebookLmAccountBinding {
  authuser: number
  accountEmail: string
}

interface NotebookTarget {
  notebookId: string
  authuser: number
  accountEmail: string
}

accountBindingFor(settings)
notebookTargetFor(settings, notebookId)
sameAccountBinding(left, right)
sameNotebookTarget(left, right)
authenticateBoundAccount(binding)
verifyNotebookTarget(target)
```

`authenticateBoundAccount` returns either an authenticated account or an account-changed result.
Transport and login failures stay in the Effect error channel. This lets queue drain preserve its
current retry/block distinctions.

## Caller flow

- The popup snapshots a binding or target before dispatching asynchronous NotebookLM work.
- Source Console authenticates its immutable target binding once.
- Enqueue and watch creation verify their immutable notebook target.
- Queue drain keeps its burst cache. On cache miss it authenticates the stored account binding.
- Account discovery remains the active-slot bootstrap. Catalog work receives the binding captured
  after discovery, so waiting behind another operation cannot redirect it to a later selection.
- RPC functions keep accepting session and `authuser`; protocol transport remains independent.

## Errors

- Missing binding at dispatch sends no command. A missing live email or mismatch while verifying a
  target becomes `NotLoggedIn`.
- Missing live email or mismatch for a stored queue binding: explicit account-changed result; drain
  blocks the job.
- Missing bound notebook: current `IpcError` text remains unchanged.
- Fetch, HTTP, protocol, and RPC failures propagate unchanged.

No new error tags are needed.

## Verification

Module tests prove:

- Missing active account or blank notebook ID derives no binding or target.
- Matching slot and email authenticate.
- Missing or mismatched live email fails.
- Stored binding mismatch is distinct from transport failure.
- Bound notebook verification uses a fresh list.
- A missing notebook preserves the current friendly error.
- Binding and target constructors snapshot notebook ID, slot, and email.

Integration tests prove:

- Queue enqueue and watch creation still require fresh ownership.
- Source Console rejects a reassigned bound slot.
- Queue drain still fetches one session and one notebook list per account per burst.
- Tier B fallback behavior is unchanged.

Run `bun run check` after migration.
