import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { discoverAccounts } from './discover'
import { DebugLog, Http } from '../fx/services'

function loggedInHtml(email: string): string {
  return `<script>var data = {"SNlM0e":"csrf-token","FdrFJe":"fsid","oPEP7c":"${email}"};</script>`
}

const LOGGED_OUT_HTML = '<html><body>sign in</body></html>'

function makeHttpLayer(pagesByAuthuser: string[]) {
  return Layer.succeed(
    Http,
    Http.of({
      text: (url: string) =>
        Effect.sync(() => {
          const match = /authuser=(\d+)/.exec(url)
          const idx = match ? Number(match[1]) : 0
          return pagesByAuthuser[idx] ?? LOGGED_OUT_HTML
        }),
      json: () => Effect.die('unused in discover tests'),
    }),
  )
}

const NoopDebugLog = Layer.succeed(
  DebugLog,
  DebugLog.of({
    log: () => Effect.void,
  }),
)

describe('discoverAccounts', () => {
  it.effect('stops at the first logged-out authuser slot', () =>
    Effect.gen(function* () {
      const accounts = yield* discoverAccounts(5)
      assert.deepStrictEqual(accounts, [
        { authuser: 0, email: 'user0@example.com' },
        { authuser: 1, email: 'user1@example.com' },
      ])
    }).pipe(
      Effect.provide(
        makeHttpLayer([
          loggedInHtml('user0@example.com'),
          loggedInHtml('user1@example.com'),
          LOGGED_OUT_HTML,
          loggedInHtml('user3@example.com'),
        ]),
      ),
      Effect.provide(NoopDebugLog),
    ),
  )

  it.effect('returns an empty array when authuser=0 is already logged out', () =>
    Effect.gen(function* () {
      const accounts = yield* discoverAccounts(5)
      assert.deepStrictEqual(accounts, [])
    }).pipe(Effect.provide(makeHttpLayer([LOGGED_OUT_HTML])), Effect.provide(NoopDebugLog)),
  )

  it.effect('never probes past max', () =>
    Effect.gen(function* () {
      const accounts = yield* discoverAccounts(2)
      assert.strictEqual(accounts.length, 2)
    }).pipe(
      Effect.provide(
        makeHttpLayer([
          loggedInHtml('user0@example.com'),
          loggedInHtml('user1@example.com'),
          loggedInHtml('user2@example.com'),
        ]),
      ),
      Effect.provide(NoopDebugLog),
    ),
  )
})
