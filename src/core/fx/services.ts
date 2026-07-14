/**
 * Context.Service keys for the fx layer (design §4). Live implementations
 * live in layers.ts — this file only declares shapes plus the pure
 * `makeHttp` constructor, which takes `fetch` as an argument so it's
 * testable without patching globals.
 */
import { Context, Effect, Result } from 'effect'
import type { DebugEntry, DebugMeta } from '../debug'
import {
  isTargetNotebookUrl,
  normalizeDomDeliveryResult,
  type DomDeliveryRequest,
  type DomDeliveryResult,
} from '../ingest/dom/contracts'
import { hasVerifiedDomDriver } from '../ingest/dom/selectors'
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

/** Browser-tab boundary used only by the NotebookLM visible-tab fallback. */
export interface DomTabsShape {
  /**
   * Whether a live-verified DOM driver exists to attempt Tier B at all. The
   * queue reads this BEFORE degrading Tier A or marking a job in-flight, so a
   * read-only protocol drift never routes into a fallback that cannot succeed.
   */
  readonly available: boolean
  readonly deliver: (request: DomDeliveryRequest) => Effect.Effect<DomDeliveryResult>
}

export class DomTabs extends Context.Service<DomTabs, DomTabsShape>()('porter/DomTabs') {}

interface DomTab {
  id?: number | undefined
  url?: string | undefined
}

interface DomTabsApi {
  query: (queryInfo: { url: string }) => Promise<DomTab[]>
  create: (createProperties: { active: boolean; url: string }) => Promise<DomTab>
  sendMessage: (tabId: number, message: unknown) => Promise<unknown>
}

const DOM_RELAY_ATTEMPTS = 4
const DOM_RELAY_RETRY_DELAY = '250 millis'

function notebookTabBaseUrl(notebookId: string): string {
  return `https://notebooklm.google.com/notebook/${encodeURIComponent(notebookId)}`
}

export function notebookTabUrl(notebookId: string, authuser: number): string {
  return `${notebookTabBaseUrl(notebookId)}?authuser=${authuser}`
}

function unavailable(reason: string): DomDeliveryResult {
  return { status: 'unavailable', reason }
}

function isMissingReceiver(reason: string): boolean {
  return reason.toLowerCase().includes('receiving end does not exist')
}

/**
 * Finds an already-open target or opens it visibly, then relays one immutable
 * unit. Only a proven absent receiver is safe-unavailable; transport breaks
 * after dispatch are treated as uncertain because the page may have acted.
 */
export function makeDomTabs(tabs: DomTabsApi): DomTabsShape {
  return {
    available: hasVerifiedDomDriver(),
    deliver: (request) =>
      Effect.gen(function* () {
        const existing = yield* Effect.result(
          Effect.tryPromise({
            try: () => tabs.query({ url: `${notebookTabBaseUrl(request.notebookId)}*` }),
            catch: (cause) => new IpcError({ reason: String(cause) }),
          }),
        )
        if (Result.isFailure(existing)) {
          return unavailable(`Could not find the target NotebookLM tab: ${existing.failure.reason}`)
        }

        let tab = existing.success.find(
          (candidate) =>
            candidate.id !== undefined &&
            candidate.url !== undefined &&
            isTargetNotebookUrl(candidate.url, request.notebookId),
        )
        if (tab === undefined) {
          const created = yield* Effect.result(
            Effect.tryPromise({
              try: () =>
                tabs.create({
                  active: true,
                  url: notebookTabUrl(request.notebookId, request.authuser),
                }),
              catch: (cause) => new IpcError({ reason: String(cause) }),
            }),
          )
          if (Result.isFailure(created)) {
            return unavailable(
              `Could not open the target NotebookLM tab: ${created.failure.reason}`,
            )
          }
          tab = created.success
        }
        const tabId = tab.id
        if (tabId === undefined) return unavailable('NotebookLM tab did not expose a tab id')

        for (let attempt = 0; attempt < DOM_RELAY_ATTEMPTS; attempt += 1) {
          const response = yield* Effect.result(
            Effect.tryPromise({
              try: () =>
                tabs.sendMessage(tabId, {
                  type: 'porter/dom-deliver',
                  request,
                }),
              catch: (cause) => new IpcError({ reason: String(cause) }),
            }),
          )
          if (!Result.isFailure(response)) return normalizeDomDeliveryResult(response.success)
          if (!isMissingReceiver(response.failure.reason)) {
            return {
              status: 'uncertain',
              reason: `NotebookLM DOM relay stopped after dispatch: ${response.failure.reason}`,
            }
          }
          if (attempt + 1 < DOM_RELAY_ATTEMPTS) yield* Effect.sleep(DOM_RELAY_RETRY_DELAY)
        }
        return unavailable('NotebookLM DOM assist is not loaded in the target tab')
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
