/**
 * Live Layer implementations — THE ONLY place browser globals/fetch are
 * touched in the fx module. Pure logic lives in services.ts.
 */
import { Effect, Layer } from 'effect'
import { dbg } from '../debug'
import { DriveAuthError, StorageError } from './errors'
import { Http, Identity, Kv, DebugLog, makeHttp } from './services'

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
    log: (scope, msg, data) => Effect.sync(() => dbg(scope, msg, data)),
  }),
)

export const PorterLive = Layer.mergeAll(HttpLive, KvLive, IdentityLive, DebugLive)
