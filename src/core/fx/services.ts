/**
 * Context.Service keys for the fx layer (design §4). Live implementations
 * live in layers.ts — this file only declares shapes plus the pure
 * `makeHttp` constructor, which takes `fetch` as an argument so it's
 * testable without patching globals.
 */
import { Context, Effect } from 'effect'
import { DriveAuthError, FetchError, HttpStatusError, StorageError } from './errors'

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
  readonly log: (scope: string, msg: string, data?: unknown) => Effect.Effect<void>
}

export class DebugLog extends Context.Service<DebugLog, DebugLogShape>()('porter/DebugLog') {}

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
