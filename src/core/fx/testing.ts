/**
 * In-memory Layer implementations for tests — mirror layers.ts's live
 * bindings but never touch `browser.*`/`fetch`. Kept in fx/ (not *.test.ts)
 * so router.test.ts and any future suite can share them.
 */
import { Effect, Layer } from 'effect'
import type { DebugEntry } from '../debug'
import type { DomDeliveryRequest, DomDeliveryResult } from '../ingest/dom/contracts'
import { DomTabs } from '../ingest/dom/driver'
import { PorterClient, unwrapPorterReply, type PorterMessage, type PorterReply } from '../messaging'
import { DriveAuthError, FetchError, HttpStatusError, IpcError } from './errors'
import {
  Alarms,
  DebugLog,
  Http,
  type HttpInit,
  Identity,
  Kv,
  Scripting,
  Tabs,
  makeHttp,
} from './services'

export interface RecordedKvWrite {
  key: string
  value: unknown
}

/**
 * `seed` is normally a plain record (the store stays private to the test).
 * Pass a `Map` instead when the test needs to read the store back after the
 * effect runs — `kvTest` mutates it in place rather than copying it, mirroring
 * how a caller-held `writes` sink (httpTest's `requests` pattern) records
 * every `set` in call order.
 */
export function kvTest(
  seed: Record<string, unknown> | Map<string, unknown> = {},
  writes: RecordedKvWrite[] = [],
) {
  const store = seed instanceof Map ? seed : new Map(Object.entries(seed))
  return Layer.succeed(
    Kv,
    Kv.of({
      get: <T>(key: string) => Effect.sync(() => store.get(key) as T | undefined),
      set: (key, value) =>
        Effect.sync(() => {
          store.set(key, value)
          writes.push({ key, value })
        }),
    }),
  )
}

export function debugLogTest(sink: DebugEntry[] = []) {
  return Layer.succeed(
    DebugLog,
    DebugLog.of({
      log: (scope, msg, data, meta) =>
        Effect.sync(() => {
          sink.push({
            t: '',
            scope,
            msg,
            ...(meta?.level !== undefined && meta.level !== 'info' ? { level: meta.level } : {}),
            ...(meta?.elapsedMs !== undefined ? { elapsedMs: meta.elapsedMs } : {}),
            ...(meta?.run !== undefined ? { run: meta.run } : {}),
            ...(data !== undefined ? { data } : {}),
          })
        }),
      entries: () => Effect.sync(() => sink),
      clear: () =>
        Effect.sync(() => {
          sink.length = 0
        }),
    }),
  )
}

export function tabsTest(opts: {
  activeTab?: { id?: number; url?: string }
  onSendMessage?: (tabId: number, msg: unknown) => unknown
}) {
  return Layer.succeed(
    Tabs,
    Tabs.of({
      activeTab: () => Effect.sync(() => opts.activeTab ?? {}),
      sendMessage: (tabId, msg) =>
        opts.onSendMessage
          ? Effect.sync(() => opts.onSendMessage?.(tabId, msg))
          : Effect.fail(new IpcError({ reason: 'tabsTest: no onSendMessage configured' })),
    }),
  )
}

export function scriptingTest(
  opts: {
    onExtractPageText?: (tabId: number) => { title: string; text: string }
  } = {},
) {
  return Layer.succeed(
    Scripting,
    Scripting.of({
      extractPageText: (tabId) =>
        opts.onExtractPageText
          ? Effect.sync(() => opts.onExtractPageText?.(tabId) ?? { title: '', text: '' })
          : Effect.fail(new IpcError({ reason: 'scriptingTest: no extraction configured' })),
    }),
  )
}

export function alarmsTest(
  opts: {
    onSchedule?: (name: string, when: number) => void
    onClear?: (name: string) => boolean
  } = {},
) {
  return Layer.succeed(
    Alarms,
    Alarms.of({
      schedule: (name, when) =>
        Effect.sync(() => {
          opts.onSchedule?.(name, when)
        }),
      clear: (name) => Effect.sync(() => opts.onClear?.(name) ?? true),
    }),
  )
}

export interface RecordedHttpRequest {
  url: string
  body?: string
}

/**
 * `requests`, if passed, is pushed into (mirrors `debugLogTest`'s sink
 * pattern) with every call's `{ url, body }` — lets a router test assert on
 * an outgoing RPC's envelope without router.ts exposing anything new.
 */
export function httpTest(
  responses: Record<string, string | string[]>,
  requests: RecordedHttpRequest[] = [],
) {
  const queued = new Map(
    Object.entries(responses).map(([url, body]) => [url, Array.isArray(body) ? [...body] : body]),
  )
  const fakeFetch = (async (url: string, init?: HttpInit) => {
    requests.push({ url, ...(init?.body !== undefined ? { body: init.body.toString() } : {}) })
    const configured = queued.get(url)
    const body = Array.isArray(configured) ? configured.shift() : configured
    return body !== undefined
      ? new Response(body, { status: 200 })
      : new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
  return Layer.succeed(Http, makeHttp(fakeFetch))
}

export function identityTest(redirectResult?: string) {
  return Layer.succeed(
    Identity,
    Identity.of({
      redirectUrl: () => 'https://test.chromiumapp.org/',
      launchAuthFlow: () =>
        redirectResult !== undefined
          ? Effect.succeed(redirectResult)
          : Effect.fail(new DriveAuthError({ reason: 'cancelled' })),
    }),
  )
}

export function domTabsTest(
  opts: {
    available?: boolean
    onDeliver?: (request: DomDeliveryRequest) => DomDeliveryResult
  } = {},
) {
  return Layer.succeed(
    DomTabs,
    DomTabs.of({
      available: opts.available ?? false,
      deliver: (request) =>
        Effect.sync(
          () =>
            opts.onDeliver?.(request) ?? {
              status: 'unavailable',
              reason: 'domTabsTest: no onDeliver configured',
            },
        ),
    }),
  )
}

/**
 * Full control over `Http.text` via a handler, for RPC-shaped tests that need
 * per-call status codes, a hang (`Effect.never`), or a call counter — things
 * `httpTest`'s static URL→body map can't express. `json` is unused by these
 * callers, so it dies loudly if ever invoked.
 */
export function httpHandlerTest(
  handler: (url: string, init?: HttpInit) => Effect.Effect<string, FetchError | HttpStatusError>,
) {
  return Layer.succeed(
    Http,
    Http.of({
      text: handler,
      json: () => Effect.die('httpHandlerTest: json() not configured'),
    }),
  )
}

type PorterClientHandlers = {
  [K in PorterMessage['type']]?: (msg: Extract<PorterMessage, { type: K }>) => PorterReply<K>
}

/**
 * Drives `PorterClient.request` from a per-message-type handler map of
 * canned replies, reusing `unwrapPorterReply` so ok:false/ok:true behave
 * exactly like the live client. A message type with no configured handler
 * fails loudly rather than hanging, so a missing case shows up immediately.
 */
export function porterClientTest(handlers: PorterClientHandlers = {}) {
  return Layer.succeed(
    PorterClient,
    PorterClient.of({
      request: <K extends PorterMessage['type']>(msg: Extract<PorterMessage, { type: K }>) => {
        const handler = handlers[msg.type as K]
        if (handler === undefined) {
          return Effect.fail(
            new IpcError({ reason: `porterClientTest: no handler configured for ${msg.type}` }),
          )
        }
        // Documented cast: TS can't carry the handler's own K, resolved by
        // indexing `handlers` above, back through to this call site's K.
        return unwrapPorterReply(handler(msg))
      },
    }),
  )
}
