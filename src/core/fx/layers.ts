/**
 * Live Layer implementations — THE ONLY place browser globals/fetch are
 * touched in the fx module. Pure logic lives in services.ts.
 */
import { Effect, Layer } from 'effect'
import { clearDebugLog, dbg, getDebugLog } from '../debug'
import {
  PorterClient,
  type PorterMessage,
  type PorterReply,
  type PorterResponseMap,
} from '../messaging'
import { DriveAuthError, IpcError, StorageError } from './errors'
import {
  Alarms,
  DebugLog,
  DomTabs,
  Http,
  Identity,
  Kv,
  Scripting,
  Tabs,
  makeAlarms,
  makeDomTabs,
  makeHttp,
  makeScripting,
} from './services'

export const HttpLive = Layer.succeed(Http, makeHttp(fetch))

export const KvLive = Layer.succeed(
  Kv,
  Kv.of({
    get: <T>(key: string) =>
      Effect.tryPromise({
        try: async () => {
          const got = await browser.storage.local.get(key)
          return got[key] as T | undefined
        },
        catch: (cause) => new StorageError({ key, cause }),
      }),
    set: (key, value) =>
      Effect.tryPromise({
        try: () => browser.storage.local.set({ [key]: value }),
        catch: (cause) => new StorageError({ key, cause }),
      }),
  }),
)

export const IdentityLive = Layer.succeed(
  Identity,
  Identity.of({
    redirectUrl: () => browser.identity.getRedirectURL(),
    launchAuthFlow: (url) =>
      Effect.gen(function* () {
        const redirectUrl = yield* Effect.tryPromise({
          try: () => browser.identity.launchWebAuthFlow({ url, interactive: true }),
          catch: (cause) => new DriveAuthError({ reason: String(cause) }),
        })
        if (redirectUrl === undefined) {
          return yield* Effect.fail(new DriveAuthError({ reason: 'cancelled' }))
        }
        return redirectUrl
      }),
  }),
)

export const DebugLive = Layer.succeed(
  DebugLog,
  DebugLog.of({
    log: (scope, msg, data, meta) => Effect.sync(() => dbg(scope, msg, data, meta)),
    entries: () =>
      Effect.tryPromise({
        try: () => getDebugLog(),
        catch: (cause) => new StorageError({ key: 'porter/debug', cause }),
      }),
    clear: () =>
      Effect.tryPromise({
        try: () => clearDebugLog(),
        catch: (cause) => new StorageError({ key: 'porter/debug', cause }),
      }),
  }),
)

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

export const DomTabsLive = Layer.succeed(DomTabs, DomTabs.of(makeDomTabs(browser.tabs)))

export const ScriptingLive = Layer.succeed(
  Scripting,
  Scripting.of(makeScripting(browser.scripting)),
)

export const AlarmsLive = Layer.succeed(Alarms, Alarms.of(makeAlarms(browser.alarms)))

export const PorterLive = Layer.mergeAll(
  HttpLive,
  KvLive,
  IdentityLive,
  DebugLive,
  TabsLive,
  DomTabsLive,
  ScriptingLive,
  AlarmsLive,
)

export const PorterClientLive = Layer.succeed(
  PorterClient,
  PorterClient.of({
    request: <K extends PorterMessage['type']>(msg: Extract<PorterMessage, { type: K }>) =>
      Effect.gen(function* () {
        const reply = yield* Effect.tryPromise({
          try: () => browser.runtime.sendMessage(msg) as Promise<PorterReply<K>>,
          catch: (cause) => new IpcError({ reason: String(cause) }),
        })
        if (!reply.ok) {
          return yield* Effect.fail(new IpcError({ reason: reply.error }))
        }
        const { ok: _ok, ...payload } = reply
        // Documented cast: TS can't carry the `Omit<..., 'ok'>` shape through the
        // generic `K` back to `PorterResponseMap[K]` — this is the only remaining
        // cast on the popup↔background wire (the transport cast above is the other).
        return payload as unknown as PorterResponseMap[K]
      }),
  }),
)

/** Everything the popup runtime provides. */
export const PopupLive = Layer.mergeAll(PorterClientLive, TabsLive)
export type PopupServices = PorterClient | Tabs
