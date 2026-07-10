# Effect Layer → Extension Entrypoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **DO NOT COMMIT** — repo etiquette forbids commits unless the user asks. Leave all changes in the working tree.

**Goal:** Make the Chrome-extension glue (background SW, popup, content scripts) genuinely consume the Effect-TS v4 `fx` abstraction instead of raw promise/callback glue, with a single typed message protocol driving both the background router and the popup client.

**Architecture:** Three moves. (1) **Typed protocol as single source of truth** — a `PorterResponseMap` in `core/messaging.ts` maps every message type to its success payload; the background handler map and the popup client are both typed against it, so the compiler enforces popup↔background agreement and exhaustive handling. (2) **Router moves into core** — the 108-line untested `switch` in `background.ts` becomes `src/core/router.ts`, fully unit-testable against in-memory test layers; `background.ts` shrinks to ~15 lines of listener glue. (3) **Popup gets its own runtime** — a `PorterClient` + `Tabs` service pair, a `popupRuntime`, and one `useAction` hook that replaces the 5× duplicated busy/error/try-finally pattern in `App.tsx`.

Raw `browser.*` / `fetch` access remains confined to `src/core/fx/layers.ts` (the one sanctioned seam). Considered and **rejected**: `effect/unstable/rpc` over a `runtime.sendMessage` transport — unstable module in a beta, bundle weight, and protocol-drift risk for zero user-visible gain over the typed-map approach.

**Tech Stack:** effect `4.0.0-beta.93` (verified installed API: `Context.Service`, `Layer.succeed/mergeAll`, `ManagedRuntime.make`, `Data.TaggedError`, `@effect/vitest` `it.effect`/`layer()`), WXT + Preact, oxfmt/oxlint/tsgo/vitest.

**Verified-API constraints (from node_modules recon, do not use unverified APIs):**
- Services: `class X extends Context.Service<X, Shape>()('porter/X') {}` + `X.of({...})`.
- Layers: `Layer.succeed`, `Layer.mergeAll`, `Layer.effect` (no `Layer.scoped` in this beta).
- Runtime: `ManagedRuntime.make(layer)` → `.runPromise/.runSync/.runFork`.
- Errors: `Data.TaggedError('Tag')<{fields}>`.
- Tests: `import { assert, describe, it } from '@effect/vitest'`, `it.effect`, `Effect.result` + `Result.isFailure/isSuccess`. For providing layers in tests prefer `Effect.provide(effect, layer)` if present in `node_modules/effect/dist/Effect.d.ts` (check first); fallback: `ManagedRuntime.make(testLayer).runPromise(...)` inside plain `it`.

**House rules (repeat in every task):** bun/bunx only; oxfmt style (2-space, single quotes, no semicolons, trailing commas, parens arrows); WXT `browser` global (never `chrome`, never import it in entrypoints); strict TS with `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` — omit optional keys via conditional spread, never assign `undefined`.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/core/fx/errors.ts` | modify | add `IpcError`; extend `PorterError` union |
| `src/core/fx/services.ts` | modify | add `Tabs` service; extend `DebugLogShape` with `entries`/`clear` |
| `src/core/fx/layers.ts` | modify | add `TabsLive`, `PorterClientLive`, `PopupLive`; extend `DebugLive`; `PorterLive` += `TabsLive` |
| `src/core/messaging.ts` | modify | typed protocol: `PorterResponseMap`, `PorterReply`, content-script shapes + guards, `PorterClient` service; drop raw `sendMessage` |
| `src/core/router.ts` | create | typed handler map + `handlePorterMessage` (moved from background.ts, 1:1 behavior) |
| `src/core/router.test.ts` | create | unit tests for router against test layers |
| `src/core/fx/testing.ts` | create | in-memory test layers (Kv, DebugLog, Tabs, Http, Identity) |
| `src/core/messaging.test.ts` | create | tests for the pure guards |
| `src/core/store/ledger.ts` | modify | `loadLedger`/`saveLedger` → Effects over `Kv` |
| `src/core/fx/runtime-popup.ts` | create | `popupRuntime = ManagedRuntime.make(PopupLive)` |
| `src/entrypoints/background.ts` | modify | shrink to thin listener over `handlePorterMessage` |
| `src/entrypoints/x.content.ts` | modify | shared typed shapes/guard instead of inline casts |
| `src/entrypoints/notebooklm.content.ts` | modify | same |
| `src/entrypoints/popup/useAction.ts` | create | Preact hook running popup Effects with busy/error state |
| `src/entrypoints/popup/App.tsx` | modify | data layer on `popupRuntime` + `useAction`; **JSX/UI features unchanged** |

Dependency order: T1 → T2 → {T3, T5, T6 in parallel} → T4 (needs T3). Final integration gate after all.

---

## Task 1: fx seam — `IpcError`, `Tabs` service, `DebugLog.entries/clear`

**Files:** Modify `src/core/fx/errors.ts`, `src/core/fx/services.ts`, `src/core/fx/layers.ts`.

- [ ] **Step 1.1** In `errors.ts`, after `StorageError`, add (and add `IpcError` to the `PorterError` union; update the header comment's "COMPLETE set" note to include it):

```ts
/** runtime.sendMessage / tabs.sendMessage transport failure. */
export class IpcError extends Data.TaggedError('IpcError')<{
  reason: string
}> {}
```

- [ ] **Step 1.2** In `services.ts`, add (importing `IpcError` and `type { DebugEntry } from '../debug'`):

```ts
export interface TabsShape {
  /** Active tab in the current window; fields omitted when Chrome doesn't report them. */
  readonly activeTab: () => Effect.Effect<{ id?: number; url?: string }, IpcError>
  readonly sendMessage: (tabId: number, msg: unknown) => Effect.Effect<unknown, IpcError>
}

export class Tabs extends Context.Service<Tabs, TabsShape>()('porter/Tabs') {}
```

and extend `DebugLogShape`:

```ts
export interface DebugLogShape {
  readonly log: (scope: string, msg: string, data?: unknown) => Effect.Effect<void>
  readonly entries: () => Effect.Effect<DebugEntry[], StorageError>
  readonly clear: () => Effect.Effect<void, StorageError>
}
```

- [ ] **Step 1.3** In `layers.ts`: extend `DebugLive` with `entries`/`clear` wrapping the existing `getDebugLog`/`clearDebugLog` from `../debug` via `Effect.tryPromise` with `catch: (cause) => new StorageError({ key: 'porter/debug', cause })`; add:

```ts
export const TabsLive = Layer.succeed(
  Tabs,
  Tabs.of({
    activeTab: () =>
      Effect.tryPromise({
        try: async () => {
          const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
          return {
            ...(tab?.id !== undefined ? { id: tab.id } : {}),
            ...(tab?.url !== undefined ? { url: tab.url } : {}),
          }
        },
        catch: (cause) => new IpcError({ reason: String(cause) }),
      }),
    sendMessage: (tabId, msg) =>
      Effect.tryPromise({
        try: () => browser.tabs.sendMessage(tabId, msg),
        catch: (cause) => new IpcError({ reason: String(cause) }),
      }),
  }),
)
```

and change `PorterLive` to `Layer.mergeAll(HttpLive, KvLive, IdentityLive, DebugLive, TabsLive)`.

- [ ] **Step 1.4** Verify: `bun run typecheck` — expect errors ONLY if other in-flight tasks are editing concurrently; errors inside these three files must be zero. `bunx vitest run src/core/fx/services.test.ts` — PASS.

---

## Task 2: Typed protocol in `messaging.ts` + `PorterClientLive`/`PopupLive`

**Files:** Modify `src/core/messaging.ts`, `src/core/fx/layers.ts`. Create `src/core/messaging.test.ts`.

- [ ] **Step 2.1** Keep `PorterMessage` and `isPorterMessage` exactly as-is. Replace the loose `PorterResponse` + `sendMessage` with:

```ts
/** Per-message success payloads — the single source of truth for both sides of the wire. */
export interface PorterResponseMap {
  'porter/detect': { capturable?: string }
  'porter/capture-url': {}
  'porter/capture-page': {}
  'porter/capture-result': {}
  'porter/list-docs': { docs: SourceDoc[] }
  'porter/delete-doc': {}
  'porter/export': {}
  'porter/ingest': { ingest: IngestOutcome[] }
  'porter/list-notebooks': { notebooks: { id: string; title: string }[] }
  'porter/accounts-refresh': { accounts: NblmAccount[] }
  'porter/get-settings': { settings: PorterSettings }
  'porter/update-settings': { settings: PorterSettings }
  'porter/backup-drive': { backup: BackupOutcome[] }
  'porter/debug-log': { debugLog: DebugEntry[] }
  'porter/debug-clear': {}
}

export type PorterFail = { ok: false; error: string }
export type PorterReply<K extends PorterMessage['type']> = ({ ok: true } & PorterResponseMap[K]) | PorterFail
```

**IMPORTANT:** before finalizing the map, read the current `handleMsg` in `src/entrypoints/background.ts` and make each entry match what that handler actually returns today (1:1 port — e.g. if `accounts-refresh` also returns settings, reflect that). The table above is the recon-derived draft, not gospel.

- [ ] **Step 2.2** Add content-script wire shapes + pure guards (these replace the inline `as { type?: string }` casts):

```ts
/** Background → content-script requests. */
export type ContentRequest = { type: 'porter/extract-thread' } | { type: 'porter/ingest-doc'; doc: IngestableDoc }

export type ExtractResponse = { ok: true; capture: Capture } | { ok: false; error: string }

export function hasMessageType<T extends string>(value: unknown, type: T): boolean

export function isExtractResponse(value: unknown): value is ExtractResponse
```

Implement both guards with plain structural checks (no casts leaking out). `isExtractResponse`: object, boolean `ok`; when `ok` is true require `capture` to be an object; when false require string `error`.

- [ ] **Step 2.3** Add the popup client service (service key lives here to keep message-domain types together; live impl goes in layers.ts):

```ts
export interface PorterClientShape {
  readonly request: <K extends PorterMessage['type']>(
    msg: Extract<PorterMessage, { type: K }>,
  ) => Effect.Effect<PorterResponseMap[K], IpcError>
}

export class PorterClient extends Context.Service<PorterClient, PorterClientShape>()('porter/PorterClient') {}
```

`request` fails with `IpcError` both when the transport rejects AND when the reply is `{ ok: false }` (reason = the reply's `error` string) — so popup code never touches `ok` flags again.

- [ ] **Step 2.4** In `layers.ts` add:

```ts
export const PorterClientLive = Layer.succeed(
  PorterClient,
  PorterClient.of({
    request: (msg) =>
      Effect.gen(function* () {
        const reply = yield* Effect.tryPromise({
          try: () => browser.runtime.sendMessage(msg) as Promise<PorterReply<typeof msg.type>>,
          catch: (cause) => new IpcError({ reason: String(cause) }),
        })
        if (!reply.ok) {
          return yield* Effect.fail(new IpcError({ reason: reply.error }))
        }
        const { ok: _ok, ...payload } = reply
        return payload
      }),
  }),
)

/** Everything the popup runtime provides. */
export const PopupLive = Layer.mergeAll(PorterClientLive, TabsLive)
export type PopupServices = PorterClient | Tabs
```

(One documented cast at the transport boundary is acceptable — it is the only remaining cast on the whole wire. If the generic method resists inference through `Context.Service`, mirror how `KvShape`'s generic `get<T>` is declared.)

- [ ] **Step 2.5** Grep for remaining importers of the removed `sendMessage`/`PorterResponse` (`rg -n 'sendMessage|PorterResponse' src/`) — only entrypoints should show up, and they are rewritten in T4/T5. Do not fix entrypoints in this task.

- [ ] **Step 2.6** Write `src/core/messaging.test.ts` covering: `isPorterMessage` accepts/rejects; `hasMessageType` positive/negative/non-object; `isExtractResponse` all four branches (ok-true valid, ok-true missing capture, ok-false valid, garbage). Run `bunx vitest run src/core/messaging.test.ts` — PASS.

---

## Task 3: Test layers + `router.ts` + router tests

**Files:** Create `src/core/fx/testing.ts`, `src/core/router.ts`, `src/core/router.test.ts`. Reference (read, do not edit): `src/entrypoints/background.ts`.

- [ ] **Step 3.1** `src/core/fx/testing.ts` — in-memory layers for tests only:

```ts
import { Effect, Layer } from 'effect'
import type { DebugEntry } from '../debug'
import { IpcError } from './errors'
import { DebugLog, Http, Identity, Kv, Tabs, makeHttp } from './services'

export function kvTest(seed: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(seed))
  return Layer.succeed(
    Kv,
    Kv.of({
      get: <T>(key: string) => Effect.sync(() => store.get(key) as T | undefined),
      set: (key, value) => Effect.sync(() => void store.set(key, value)),
    }),
  )
}

export function debugLogTest(sink: DebugEntry[] = []) { /* log pushes {t:'', scope, msg, data?}; entries returns sink; clear empties it */ }

export function tabsTest(opts: {
  activeTab?: { id?: number; url?: string }
  onSendMessage?: (tabId: number, msg: unknown) => unknown
}) { /* activeTab returns opts.activeTab ?? {}; sendMessage returns onSendMessage result or fails IpcError when absent */ }

export function httpTest(responses: Record<string, string>) { /* makeHttp over a fake fetch resolving new Response(responses[url]) or 404 */ }

export function identityTest(redirectResult?: string) { /* redirectUrl -> 'https://test.chromiumapp.org/'; launchAuthFlow succeeds with redirectResult or fails DriveAuthError */ }
```

Fill the elided bodies completely — same style as `kvTest`. Respect `exactOptionalPropertyTypes` everywhere.

- [ ] **Step 3.2** `src/core/router.ts` — port `toFriendlyError`, `handle`, and the entire `handleMsg` switch from `background.ts` **1:1 behavior**, restructured as a typed handler map:

```ts
export type PorterServices = Http | Kv | Identity | DebugLog | Tabs

type Handlers = {
  [K in PorterMessage['type']]: (
    msg: Extract<PorterMessage, { type: K }>,
  ) => Effect.Effect<PorterReply<K>, PorterError, PorterServices>
}

const handlers: Handlers = { /* one key per message type, bodies ported from background.ts handleMsg cases */ }

/** Single background entrypoint: dispatch + friendly-error flattening. Never fails. */
export function handlePorterMessage(
  msg: PorterMessage,
): Effect.Effect<PorterReply<PorterMessage['type']>, never, PorterServices> {
  // Correlated-union dispatch needs one local cast; the Handlers type above keeps it honest.
  const handler = handlers[msg.type] as (m: PorterMessage) => Effect.Effect<PorterReply<PorterMessage['type']>, PorterError, PorterServices>
  return toFriendlyError(handler(msg))
}
```

Port rules:
- Every `Effect.gen` body moves verbatim (imports adjusted). Success returns become `{ ok: true, ...payload }` matching `PorterResponseMap`.
- The three bare `Effect.promise` escape hatches are **eliminated**: `porter/capture-page` uses `yield* (yield* Tabs).sendMessage(msg.tabId, { type: 'porter/extract-thread' } satisfies ContentRequest)` then validates with `isExtractResponse` (malformed → `{ ok: false, error: 'Malformed content-script response' }`); `porter/debug-log` / `porter/debug-clear` use the `DebugLog` service's new `entries()`/`clear()`.
- `toFriendlyError` gains a `IpcError: (e) => Effect.succeed({ ok: false as const, error: e.reason })` arm.
- Exhaustiveness is enforced by the `Handlers` mapped type — if a message type is missing, tsgo fails. That is the point.

- [ ] **Step 3.3** `src/core/router.test.ts` — using `@effect/vitest` (`it.effect` or plain `it` + a per-suite `ManagedRuntime.make(testLayer)`), cover at minimum:
  1. `porter/detect` with a YouTube playlist URL → `ok: true` with `capturable` label; with `https://example.com` → the exact current fallback reply.
  2. `porter/list-docs` after seeding `kvTest({ 'porter/docs': [docA, docB] })` → docs sorted by `capturedAt` desc.
  3. `porter/get-settings` on empty Kv → `DEFAULT_SETTINGS` merge.
  4. `porter/update-settings` round-trips a patch into Kv.
  5. `porter/delete-doc` removes only the target doc.
  6. `porter/capture-page` with `tabsTest({ onSendMessage: () => ({ ok: false, error: 'X extraction not implemented yet' }) })` → `{ ok: false, error: 'X extraction not implemented yet' }`; and with a malformed reply (`onSendMessage: () => 'garbage'`) → the malformed-response error.
  7. `porter/debug-log` returns entries from `debugLogTest` sink; `porter/debug-clear` empties it.
  8. Friendly-error flattening: a handler path that fails typed (e.g. `porter/list-notebooks` with `httpTest` returning a logged-out home page → `NotLoggedIn`) produces the same friendly string background.ts produces today.

- [ ] **Step 3.4** Run `bunx vitest run src/core/router.test.ts src/core/messaging.test.ts` — PASS. Router file compiles clean.

---

## Task 4: Entrypoints — background + content scripts (AFTER T3)

**Files:** Modify `src/entrypoints/background.ts`, `src/entrypoints/x.content.ts`, `src/entrypoints/notebooklm.content.ts`.

- [ ] **Step 4.1** `background.ts` becomes (whole file, plus the WXT auto-imports):

```ts
import { dbg } from '../core/debug'
import { porterRuntime } from '../core/fx/runtime'
import { isPorterMessage } from '../core/messaging'
import { handlePorterMessage } from '../core/router'

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isPorterMessage(message)) return
    porterRuntime
      .runPromise(handlePorterMessage(message))
      .then(sendResponse)
      .catch((err: unknown) => {
        // Defects only — typed failures are flattened inside handlePorterMessage.
        dbg('bg', `${message.type} died`, { error: String(err) })
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) })
      })
    return true
  })
})
```

Preserve the existing console.error/stack detail in the catch if trivially portable.

- [ ] **Step 4.2** Content scripts: replace the inline `(message as { type?: string }).type !== '...'` casts with `hasMessageType(message, 'porter/extract-thread')` (x) / `hasMessageType(message, 'porter/ingest-doc')` (notebooklm), keep the stub `sendResponse({ ok: false, error: '... not implemented yet' })` bodies and TODO comments **unchanged** — they are tracked stubs, not scope for this plan.

- [ ] **Step 4.3** Verify: `bun run typecheck` clean for these files; extension builds later in the integration gate.

---

## Task 5: Popup — `runtime-popup.ts`, `useAction`, `App.tsx` (parallel with T3/T4 after T2)

**Files:** Create `src/core/fx/runtime-popup.ts`, `src/entrypoints/popup/useAction.ts`. Modify `src/entrypoints/popup/App.tsx`.

- [ ] **Step 5.1** `src/core/fx/runtime-popup.ts`:

```ts
/**
 * Popup-side Effect runtime. Separate module from runtime.ts so the popup
 * bundle doesn't pull the SW layer set (and vice versa).
 */
import { ManagedRuntime } from 'effect'
import { PopupLive } from './layers'

export const popupRuntime = ManagedRuntime.make(PopupLive)
```

- [ ] **Step 5.2** `src/entrypoints/popup/useAction.ts`:

```ts
import { Effect } from 'effect'
import { useState } from 'preact/hooks'
import type { PopupServices } from '../../core/fx/layers'
import { popupRuntime } from '../../core/fx/runtime-popup'

/**
 * Runs a popup Effect with uniform busy/error bookkeeping. IpcError (the only
 * typed failure PopupServices produce) is flattened to its reason string;
 * defects surface as String(err).
 */
export function useAction<Args extends unknown[]>(
  body: (...args: Args) => Effect.Effect<void, IpcError, PopupServices>,
): { run: (...args: Args) => void; busy: boolean; error: string | undefined } {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const run = (...args: Args) => {
    setBusy(true)
    setError(undefined)
    void popupRuntime
      .runPromise(Effect.catchTag(body(...args), 'IpcError', (e) => Effect.sync(() => setError(e.reason))))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false))
  }
  return { run, busy, error }
}
```

(Adjust `Effect.catchTag` argument order to whatever the installed `.d.ts` declares — verify, don't guess.)

- [ ] **Step 5.3** Rewrite `App.tsx`'s data layer. **HARD SCOPE LOCK: every UI feature, every piece of JSX, every state variable that drives rendering stays. Do not remove, rename, or redesign any visible behavior.** Transformation rules:
  - Every `sendMessage({ type: X, ... })` + `if (!res.ok)` pair becomes `yield* client.request({ type: X, ... })` inside an `Effect.gen` (with `const client = yield* PorterClient` at the top), returning the typed payload directly.
  - Both raw `browser.tabs.query` sites become `yield* (yield* Tabs).activeTab()`.
  - Each of the five busy/try-finally blocks (`capture`, `loadNotebooks`, `ingest`, `refreshAccounts`, `backupToDrive`) becomes a `useAction(...)`; their bespoke result states (`ingestResult`, `backupResult`, `notebooksError`, …) are set via `Effect.sync(() => set...(...))` inside the effect (keep the exact same user-facing strings, e.g. `` `${okCount} of ${outcomes.length} docs sent` ``).
  - `refresh` keeps its detect→list-docs→settings→(conditional loadNotebooks) sequence; `porter/detect`'s `ok: false` reply now surfaces as the hook's `error` — map it to the same UI state the old code produced (read the old code carefully; "Nothing capturable on this page" must render exactly as before).
  - `copyDebugLog`/`clearDebugLog` go through `client.request({ type: 'porter/debug-log' })` / `'porter/debug-clear'`; keep `navigator.clipboard.writeText` + the 2s `setTimeout` status reset as-is (popup-local UI glue, fine).
  - The mount-only `useEffect(() => { void refresh() }, [])` stays.

- [ ] **Step 5.4** Verify: `bun run typecheck` clean for popup files; `bunx vitest run` unaffected (popup has no unit tests by convention).

---

## Task 6: Ledger onto `Kv` (parallel, independent)

**Files:** Modify `src/core/store/ledger.ts` (and `ledger.test.ts` only if it touches load/save).

- [ ] **Step 6.1** Replace the two raw promise functions with Effects over `Kv` (pure reducers above them stay byte-identical):

```ts
export function loadLedger(): Effect.Effect<Ledger, StorageError, Kv> {
  return Effect.gen(function* () {
    const kv = yield* Kv
    return (yield* kv.get<Ledger>(STORAGE_KEY)) ?? {}
  })
}

export function saveLedger(ledger: Ledger): Effect.Effect<void, StorageError, Kv> {
  return Effect.gen(function* () {
    const kv = yield* Kv
    yield* kv.set(STORAGE_KEY, ledger)
  })
}
```

- [ ] **Step 6.2** `rg -n 'loadLedger|saveLedger' src/` — update any callers (recon says likely none outside tests). Run `bunx vitest run src/core/store/ledger.test.ts` — PASS.

---

## Task 7: Integration gate + review

- [ ] **Step 7.1** `bun run check` (fmt-check + oxlint + wxt prepare + tsgo + vitest + build). Fix until fully green. `bun run fmt` first if fmt-check complains.
- [ ] **Step 7.2** Scope verification (per project memory: reviewers must verify existence, not green checks): confirm every popup feature still exists in `App.tsx` (capture, notebooks list+select, ingest, accounts refresh+select, Drive client-id input, backup, debug copy/clear, error rendering); confirm router handles all 15 message types; confirm zero `browser.*` outside `src/core/fx/layers.ts`, `src/core/debug.ts` (sanctioned), `src/core/ingest/export.ts` (pre-existing, out of scope), and entrypoint listener registration.
- [ ] **Step 7.3** Correctness review pass over the diff (adversarial: exactOptionalPropertyTypes traps, `return true` listener semantics, catchTag argument order, dropped `satisfies` anchors). Report findings; fix confirmed ones.
- [ ] **Step 7.4** Report to user with diff stat, popup bundle-size delta from the build output, and what was deliberately left raw (debug.ts internals, export.ts downloads, content-script stubs).

## Self-Review Notes

- Spec coverage: every raw seam found in recon is addressed (bg escape hatches → T3/T4; popup → T5; content guards → T4; ledger → T6; blind casts → T2) or explicitly descoped with rationale (debug.ts write-chain internals, export.ts `browser.downloads` — pre-existing sanctioned glue).
- Type consistency: `PorterReply`/`PorterResponseMap`/`PorterClientShape`/`Handlers` all reference the same map; `PopupServices = PorterClient | Tabs` matches `PopupLive`.
- Placeholders: T3.1's elided fake bodies are contracts for the implementer with a complete reference (`kvTest`) in the same block; T3.2 defers handler bodies to a 1:1 port of named, existing code — the `Handlers` mapped type makes omission a compile error.
