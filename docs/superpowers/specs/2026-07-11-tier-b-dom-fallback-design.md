# Tier B NotebookLM DOM fallback design

## Goal

When the read-only consumer NotebookLM preflight canary proves Tier A has
drifted, deliver the same immutable ingest unit through an open, visible
NotebookLM tab. The durable queue remains the only owner of receipts, retry
policy, and source-mutation uncertainty.

## Chosen approach

The fallback is a deep `DomDelivery` module with one interface: deliver one
already-planned `IngestUnit` to one notebook and return one of `sent`,
`unavailable`, or `uncertain`. Its implementation owns tab discovery/opening,
content-script relay, selector profile selection, dialog waiting, native input
filling, and postcondition verification. The queue never learns selectors or
DOM steps.

Two alternatives are rejected:

- Hardcoding DOM steps in `drain.ts` would make Google UI drift spread into
  queue safety code and tests.
- Falling back after any failed mutating RPC risks a duplicate source, so it is
  forbidden. Tier B runs only after the read-only preflight canary reports
  protocol drift.

## Modules and seams

- `core/ingest/dom/contracts.ts`: pure request/result types and result
  classification.
- `core/ingest/dom/selectors.ts`: the only selector profile registry. It owns
  candidate selectors and text fallbacks, not click logic.
- `core/ingest/tier-state.ts`: per-account, ten-minute Tier-A degradation
  cooldown so known preflight drift routes directly to Tier B until it expires.
- `fx/DomTabs`: the adapter that finds or opens the target NotebookLM tab and
  relays a unit to its content script.
- `entrypoints/notebooklm.content.ts`: the DOM implementation. It waits with
  `MutationObserver`, fills native inputs with the prototype setter plus
  `input`/`change` events, and verifies a visible postcondition before
  returning `sent`.

## Queue semantics

Tier B runs only when the read-only `listNotebooks` canary returns
`ProtocolDrift`, before the queue marks a unit in flight or calls an add-source
RPC. Every failed mutating Tier-A call stays on its own path: network failures,
timeouts, 429/5xx, and post-mutation protocol drift are `uncertain`; explicit
`RpcRefused` stays terminal. No mutating RPC failure triggers DOM delivery. A
DOM response of `unavailable` is a safe terminal failure and leaves the Tier C
export floor available. A response of `uncertain` is never auto-retried.

The queue writes its in-flight marker before either Tier. A successful Tier B
uses the same per-unit receipt and ledger write as Tier A.

## Live-selector gate

The current browser session is signed out of NotebookLM, so no authenticated
dialog DOM exists to inspect. Selector candidates must not be guessed or used
to click a live account. Until an authenticated NotebookLM tab is available,
implementation can safely complete the contracts, cooldown state, adapters,
and fixture tests, but the selector profile and end-to-end DOM mutation stay
explicitly unavailable rather than pretending to be functional.

## Verification

Unit-test tier cooldown transitions, DOM result classification, safe-vs-
ambiguous Tier-A fallback routing, and queue state transitions. With an
authenticated disposable notebook, verify exactly one source appears after a
forced safe Tier-A failure, then verify a second run creates none. Run the
full `bun run check` gate after every integration stage.
