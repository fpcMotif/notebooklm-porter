# Notebook cache and account-safety design

## Goal

Make NotebookLM account switching feel immediate without letting a positional
Google `authuser` slot leak a notebook from one account into another. Cached
notebooks are browse data only; every operation that can mutate a notebook
keeps its existing fresh remote validation.

## Chosen approach

Add one deep `notebooks-cache` module with a small interface: read cached
notebooks only when both `authuser` and the freshly observed account email
match, then replace that entry after a successful fresh listing. Its storage
schema is versioned and its pure lookup/update functions own the email guard,
so router callers never reimplement it.

The alternatives are rejected:

- Popup-local cache would duplicate account-safety logic across the UI and
  background, and disappears whenever the popup closes.
- Keying only by `authuser` is unsafe: Google can reassign a numerical slot
  after sign-out, so a cached notebook id could target the wrong account.

## Module and seam

`core/store/notebooks-cache.ts` owns a versioned cache of
`authuser -> { email, notebooks, refreshedAt }` and exposes pure read/replace
operations plus thin `Kv` load/save helpers. A read returns nothing unless the
caller supplies the exact email from a fresh NotebookLM session. This gives
the module depth: callers learn one cache interface while it owns schema,
slot-keying, email comparison, and immutable updates.

## Router behavior

`porter/list-notebooks` always fetches a fresh session first. With a session
email, it returns a matching cache entry unless `forceRefresh` is set. A cache
miss, email mismatch, missing session email, or forced refresh calls the
existing read-only `listNotebooks` RPC and replaces the cache entry only after
that call succeeds.

The queue, watch creation, and notebook creation paths never use cached data
to establish a target. Their existing fresh `fetchSession` plus
`listNotebooks` checks remain the source of truth. After a successful create
and post-create re-list, the router replaces the active account's cache so the
popup cannot display a stale picker.

## Popup behavior

The existing account-switch path already clears its selected notebook and
reloads the list. Initial load and account switching may use cache-first
listing; the visible refresh button passes `forceRefresh: true`. The popup
still resolves a selected id only against the returned list, so remembered
site targets cannot cross accounts.

## Verification

Unit-test cache lookup for exact email matches, slot reassignment, immutable
replacement, and invalid stored data. Router tests prove a cache hit skips the
list RPC but not the session check; a forced refresh and email mismatch make a
fresh list call and update storage. Run `bun run check` after integration.
