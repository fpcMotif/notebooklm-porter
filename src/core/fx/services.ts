/**
 * Context.Service keys for the fx layer (design §4). Live implementations
 * live in layers.ts — this file only declares shapes plus the pure
 * `makeHttp` constructor, which takes `fetch` as an argument so it's
 * testable without patching globals.
 */
import { Context, Effect } from 'effect'
import type { DebugEntry, DebugMeta } from '../debug'
import {
  AlarmError,
  DriveAuthError,
  FetchError,
  HttpStatusError,
  IpcError,
  StorageError,
} from './errors'

export interface HttpInit {
  method?: string
  headers?: Record<string, string>
  body?: string
  credentials?: RequestCredentials
}

export interface HttpShape {
  readonly text: (
    url: string,
    init?: HttpInit,
  ) => Effect.Effect<string, FetchError | HttpStatusError>
  readonly json: (
    url: string,
    init?: HttpInit,
  ) => Effect.Effect<unknown, FetchError | HttpStatusError>
}

export class Http extends Context.Service<Http, HttpShape>()('porter/Http') {}

export const HTTP_TIMEOUT = '20 seconds'

/** Bounds one network operation while preserving its typed failure channel. */
export function withHttpTimeout<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  url: string,
): Effect.Effect<A, E | FetchError, R> {
  return effect.pipe(
    Effect.timeout(HTTP_TIMEOUT),
    Effect.catchTag('TimeoutError', () => Effect.fail(new FetchError({ url, cause: 'timeout' }))),
  )
}

export interface KvShape {
  readonly get: <T>(key: string) => Effect.Effect<T | undefined, StorageError>
  readonly set: <T>(key: string, value: T) => Effect.Effect<void, StorageError>
}

export class Kv extends Context.Service<Kv, KvShape>()('porter/Kv') {}

export interface IdentityShape {
  readonly redirectUrl: () => string
  readonly launchAuthFlow: (url: string) => Effect.Effect<string, DriveAuthError>
}

export class Identity extends Context.Service<Identity, IdentityShape>()('porter/Identity') {}

export interface DebugLogShape {
  readonly log: (
    scope: string,
    msg: string,
    data?: unknown,
    meta?: DebugMeta,
  ) => Effect.Effect<void>
  readonly entries: () => Effect.Effect<DebugEntry[], StorageError>
  readonly clear: () => Effect.Effect<void, StorageError>
}

export class DebugLog extends Context.Service<DebugLog, DebugLogShape>()('porter/DebugLog') {}

export interface TabsShape {
  /** Active tab in the current window; fields omitted when Chrome doesn't report them. */
  readonly activeTab: () => Effect.Effect<{ id?: number; url?: string }, IpcError>
  readonly sendMessage: (tabId: number, msg: unknown) => Effect.Effect<unknown, IpcError>
}

export class Tabs extends Context.Service<Tabs, TabsShape>()('porter/Tabs') {}

interface TabsApiTab {
  id?: number | undefined
  url?: string | undefined
}

interface TabsApi {
  query: (queryInfo: { active: boolean; currentWindow: boolean }) => Promise<TabsApiTab[]>
  sendMessage: (tabId: number, message: unknown) => Promise<unknown>
}

/** Builds a `TabsShape` around the small active-tab + relay surface we use. */
export function makeTabs(tabs: TabsApi): TabsShape {
  return {
    activeTab: () =>
      Effect.tryPromise({
        try: async () => {
          const [tab] = await tabs.query({ active: true, currentWindow: true })
          return {
            ...(tab?.id !== undefined ? { id: tab.id } : {}),
            ...(tab?.url !== undefined ? { url: tab.url } : {}),
          }
        },
        catch: (cause) => new IpcError({ reason: String(cause) }),
      }),
    sendMessage: (tabId, msg) =>
      Effect.tryPromise({
        try: () => tabs.sendMessage(tabId, msg),
        catch: (cause) => new IpcError({ reason: String(cause) }),
      }),
  }
}

export interface PageText {
  title: string
  text: string
}

/** Temporary active-tab page extraction, invoked only after a context-menu gesture. */
export interface ScriptingShape {
  readonly extractPageText: (tabId: number) => Effect.Effect<PageText, IpcError>
}

export class Scripting extends Context.Service<Scripting, ScriptingShape>()('porter/Scripting') {}

interface ScriptingApi {
  executeScript: (details: { target: { tabId: number }; func: () => unknown }) => Promise<unknown[]>
}

function extractPageSnapshot(): PageText {
  const root = document.querySelector('article') ?? document.querySelector('main') ?? document.body
  return {
    title: document.title.trim(),
    text: (root?.innerText ?? '').slice(0, 100_000),
  }
}

function isPageText(value: unknown): value is PageText {
  return (
    typeof value === 'object' &&
    value !== null &&
    'title' in value &&
    typeof value.title === 'string' &&
    'text' in value &&
    typeof value.text === 'string'
  )
}

/** Builds the small active-tab scripting surface used by context-menu capture. */
export function makeScripting(scripting: ScriptingApi): ScriptingShape {
  return {
    extractPageText: (tabId) =>
      Effect.tryPromise({
        try: async () => {
          const results = await scripting.executeScript({
            target: { tabId },
            func: extractPageSnapshot,
          })
          const first = results[0]
          const result =
            typeof first === 'object' && first !== null && 'result' in first
              ? first.result
              : undefined
          if (!isPageText(result)) throw new Error('page extraction returned no text result')
          return result
        },
        catch: (cause) => new IpcError({ reason: String(cause) }),
      }),
  }
}

/** Service-worker alarm scheduling for durable background work. */
export interface AlarmsShape {
  readonly schedule: (name: string, when: number) => Effect.Effect<void, AlarmError>
  readonly clear: (name: string) => Effect.Effect<boolean, AlarmError>
}

export class Alarms extends Context.Service<Alarms, AlarmsShape>()('porter/Alarms') {}

interface AlarmApi {
  create: (name: string, info: { when: number }) => Promise<void>
  clear: (name: string) => Promise<boolean>
}

/** Builds an `AlarmsShape` around the small browser.alarms surface we use. */
export function makeAlarms(alarms: AlarmApi): AlarmsShape {
  return {
    schedule: (name, when) =>
      Effect.tryPromise({
        try: () => alarms.create(name, { when }),
        catch: (cause) => new AlarmError({ operation: 'schedule', cause }),
      }),
    clear: (name) =>
      Effect.tryPromise({
        try: () => alarms.clear(name),
        catch: (cause) => new AlarmError({ operation: 'clear', cause }),
      }),
  }
}

/**
 * Builds an `HttpShape` around an injected `fetch`-compatible function — the
 * one seam where a rejected/failed request becomes a typed error. Kept as a
 * plain factory (not a Layer) so tests can construct it with a fake fetch
 * instead of patching `globalThis.fetch`.
 */
export function makeHttp(fetchImpl: typeof fetch): HttpShape {
  const request = (url: string, init?: HttpInit) =>
    Effect.gen(function* () {
      const res = yield* Effect.tryPromise({
        try: () => fetchImpl(url, init),
        catch: (cause) => new FetchError({ url, cause }),
      })
      if (!res.ok) {
        return yield* Effect.fail(new HttpStatusError({ url, status: res.status }))
      }
      return res
    })

  return {
    text: (url, init) =>
      Effect.gen(function* () {
        const res = yield* request(url, init)
        return yield* Effect.tryPromise({
          try: () => res.text(),
          catch: (cause) => new FetchError({ url, cause }),
        })
      }),
    json: (url, init) =>
      Effect.gen(function* () {
        const res = yield* request(url, init)
        return yield* Effect.tryPromise({
          try: () => res.json(),
          catch: (cause) => new FetchError({ url, cause }),
        })
      }),
  }
}
