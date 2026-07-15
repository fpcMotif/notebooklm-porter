import { assert, describe, it } from '@effect/vitest'
import { Effect, Fiber, Layer, Result } from 'effect'
import { TestClock } from 'effect/testing'
import { discoverAccounts } from './discover'
import { FetchError } from '../fx/errors'
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
    entries: () => Effect.succeed([]),
    clear: () => Effect.void,
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

  it.effect('a stalled authuser probe fails typed instead of hanging forever', () =>
    Effect.gen(function* () {
      const NeverHttpLayer = Layer.succeed(
        Http,
        Http.of({
          text: () => Effect.never,
          json: () => Effect.die('unused in discover tests'),
        }),
      )
      const fiber = yield* Effect.race(
        discoverAccounts(5).pipe(
          Effect.provide(NeverHttpLayer),
          Effect.provide(NoopDebugLog),
          Effect.result,
          Effect.map((result) => ({ kind: 'result' as const, result })),
        ),
        Effect.sleep('21 seconds').pipe(Effect.as({ kind: 'deadline' as const })),
      ).pipe(Effect.forkChild)

      yield* TestClock.adjust('21 seconds')
      const outcome = yield* Fiber.join(fiber)

      assert.strictEqual(outcome.kind, 'result')
      if (outcome.kind === 'result') {
        assert.isTrue(Result.isFailure(outcome.result))
        if (Result.isFailure(outcome.result)) assert.instanceOf(outcome.result.failure, FetchError)
      }
    }),
  )
})
