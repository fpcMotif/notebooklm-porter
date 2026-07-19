/**
 * Live Layer implementations — THE ONLY place browser globals/fetch are
 * touched in the fx module. Pure logic lives in services.ts.
 */
import { Effect, Layer } from 'effect'
import {
  convexMutationRequest,
  convexQueryRequest,
  parseConvexResult,
  type ConvexRequest,
} from '../convex/api'
import { clearDebugLog, dbg, getDebugLog } from '../debug'
import { DomTabs, makeDomTabs } from '../ingest/dom/driver'
import { PorterClient, unwrapPorterReply, type PorterMessage, type PorterReply } from '../messaging'
import { convexUrlFromSettings, getSettings } from '../settings'
import { DriveAuthError, IpcError, StorageError } from './errors'
import { INSTALL_ID_KEY, chooseKvLayer, ensureInstallId, makeKvMirror } from './kv-mirror'
import {
  Alarms,
  DebugLog,
  Http,
  Identity,
  Kv,
  type KvShape,
  Scripting,
  Tabs,
  makeAlarms,
  makeHttp,
  makeScripting,
  makeTabs,
} from './services'

export const HttpLive = Layer.succeed(Http, makeHttp(fetch))

const kvLocal: KvShape = {
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
}

export const KvLive = Layer.succeed(Kv, Kv.of(kvLocal))

/** Runs one Convex function over fetch; throws on transport or function error. */
async function convexFunctionCall(request: ConvexRequest): Promise<unknown> {
  const res = await fetch(request.url, request.init)
  if (!res.ok) throw new Error(`convex http ${res.status}`)
  const parsed = parseConvexResult(await res.json())
  if (!parsed.ok) throw new Error(parsed.error)
  return parsed.value
}

/**
 * Kv that mirrors every write to the configured Convex deployment (namespaced
 * by a persisted per-install id). The mirror-vs-local ruling runs once per SW
 * start (layer build); MV3 restarts the worker constantly, so a settings
 * change applies on the next start. With no valid convexUrl — or any setup
 * failure — this IS the plain local shape: default behavior is unchanged, and
 * the cloud can only ever add best-effort writes, never failures.
 */
export const KvConvexMirror = Layer.effect(
  Kv,
  Effect.gen(function* () {
    const settings = yield* getSettings().pipe(Effect.provide(KvLive))
    const url = convexUrlFromSettings(settings)
    if (url === undefined || chooseKvLayer(url) === 'local') return kvLocal

    const stored = yield* kvLocal.get<string>(INSTALL_ID_KEY)
    const install = ensureInstallId(stored, () => crypto.randomUUID())
    if (install.created) yield* kvLocal.set(INSTALL_ID_KEY, install.id)
    dbg('kv-mirror', 'convex mirror active', { installId: install.id })

    return makeKvMirror(kvLocal, {
      push: async (batch) => {
        await convexFunctionCall(
          convexMutationRequest(url, 'kv:kvUpsert', { installId: install.id, rows: [...batch] }),
        )
      },
      pull: (key) =>
        convexFunctionCall(convexQueryRequest(url, 'kv:kvGet', { installId: install.id, key })),
      log: (msg, data) => dbg('kv-mirror', msg, data, { level: 'warn' }),
    })
  }).pipe(
    Effect.catch((err) =>
      Effect.sync(() => {
        dbg(
          'kv-mirror',
          'mirror setup failed — staying local',
          { error: String(err) },
          {
            level: 'warn',
          },
        )
        return kvLocal
      }),
    ),
  ),
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

export const TabsLive = Layer.succeed(Tabs, Tabs.of(makeTabs(browser.tabs)))

export const DomTabsLive = Layer.succeed(DomTabs, DomTabs.of(makeDomTabs(browser.tabs)))

export const ScriptingLive = Layer.succeed(
  Scripting,
  Scripting.of(makeScripting(browser.scripting)),
)

export const AlarmsLive = Layer.succeed(Alarms, Alarms.of(makeAlarms(browser.alarms)))

export const PorterLive = Layer.mergeAll(
  HttpLive,
  KvConvexMirror,
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
        return yield* unwrapPorterReply(reply)
      }),
  }),
)

/** Everything the popup runtime provides. */
export const PopupLive = Layer.mergeAll(PorterClientLive, TabsLive)
export type PopupServices = PorterClient | Tabs
