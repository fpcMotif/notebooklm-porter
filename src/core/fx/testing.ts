/**
 * In-memory Layer implementations for tests — mirror layers.ts's live
 * bindings but never touch `browser.*`/`fetch`. Kept in fx/ (not *.test.ts)
 * so router.test.ts and any future suite can share them.
 */
import { Effect, Layer } from 'effect'
import type { DebugEntry } from '../debug'
import { DriveAuthError, IpcError } from './errors'
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
