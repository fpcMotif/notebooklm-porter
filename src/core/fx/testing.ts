/**
 * In-memory Layer implementations for tests — mirror layers.ts's live
 * bindings but never touch `browser.*`/`fetch`. Kept in fx/ (not *.test.ts)
 * so router.test.ts and any future suite can share them.
 */
import { Effect, Layer } from 'effect'
import type { DebugEntry } from '../debug'
import { DriveAuthError, IpcError } from './errors'
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

export function debugLogTest(sink: DebugEntry[] = []) {
  return Layer.succeed(
    DebugLog,
    DebugLog.of({
      log: (scope, msg, data) =>
        Effect.sync(() => {
          sink.push({ t: '', scope, msg, ...(data !== undefined ? { data } : {}) })
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

export function httpTest(responses: Record<string, string>) {
  const fakeFetch = (async (url: string) => {
    const body = responses[url]
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
