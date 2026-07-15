import { assert, describe, it } from '@effect/vitest'
import { Effect, Fiber, Layer, Result } from 'effect'
import { TestClock } from 'effect/testing'
import {
  FetchError,
  HttpStatusError,
  NotLoggedIn,
  ProtocolDrift,
  RpcRefused,
} from '../../fx/errors'
import { debugLogTest, httpHandlerTest } from '../../fx/testing'
import { addTextSource, createNotebook, fetchSession, rpcCall } from './client'
import { RPC_IDS } from './protocol'

const NoopDebugLive = debugLogTest()

/** Byte-count line + JSON-array-chunk line, alternating, per the real rt=c format. */
function chunk(frames: unknown[][]): string {
  const line = JSON.stringify(frames)
  return `${line.length}\n${line}`
}

const session = { csrfToken: 'csrf-1', fSid: 'fsid-1' }

describe('fetchSession', () => {
  it.effect('resolves the session when the home page reports logged-in', () =>
    Effect.gen(function* () {
      const html = '"SNlM0e":"csrf-token-1"...."FdrFJe":"fsid-1"'
      const layer = Layer.mergeAll(
        httpHandlerTest(() => Effect.succeed(html)),
        NoopDebugLive,
      )
      const result = yield* fetchSession(0).pipe(Effect.provide(layer))
      assert.strictEqual(result.csrfToken, 'csrf-token-1')
      assert.strictEqual(result.fSid, 'fsid-1')
    }),
  )

  it.effect('fails with NotLoggedIn when the home page has no csrf token', () =>
    Effect.gen(function* () {
      const layer = Layer.mergeAll(
        httpHandlerTest(() => Effect.succeed('<html>signed out</html>')),
        NoopDebugLive,
      )
      const result = yield* Effect.result(fetchSession(0).pipe(Effect.provide(layer)))
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, NotLoggedIn)
        assert.strictEqual(result.failure.authuser, 0)
      }
    }),
  )

  it.effect('turns a stalled session page into a typed fetch failure', () =>
    Effect.gen(function* () {
      const layer = Layer.mergeAll(
        httpHandlerTest(() => Effect.never),
        NoopDebugLive,
      )
      const fiber = yield* Effect.race(
        fetchSession(0).pipe(
          Effect.provide(layer),
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

describe('rpcCall', () => {
  // Real timers: rpcCall's retry schedule sleeps between attempts, and
  // it.effect's virtual TestClock never auto-advances, so it would hang.
  it.live('retries a 500 response and succeeds on the next attempt', () =>
    Effect.gen(function* () {
      let calls = 0
      const payload = JSON.stringify({ ok: true })
      const text = `)]}'\n${chunk([['wrb.fr', RPC_IDS.addSource, payload]])}\n`
      const layer = Layer.mergeAll(
        httpHandlerTest(() => {
          calls += 1
          if (calls === 1) {
            return Effect.fail(new HttpStatusError({ url: 'u', status: 500 }))
          }
          return Effect.succeed(text)
        }),
        NoopDebugLive,
      )
      const result = yield* rpcCall(RPC_IDS.addSource, {}, session, 0).pipe(Effect.provide(layer))
      assert.deepStrictEqual(result, { ok: true })
      assert.strictEqual(calls, 2)
    }),
  )

  it.effect('never retries an add-source mutation after an ambiguous 500', () =>
    Effect.gen(function* () {
      let calls = 0
      const layer = Layer.mergeAll(
        httpHandlerTest(() => {
          calls += 1
          return Effect.fail(new HttpStatusError({ url: 'u', status: 500 }))
        }),
        NoopDebugLive,
      )
      const result = yield* Effect.result(
        addTextSource('nb-1', 'Title', 'body', session, 0).pipe(Effect.provide(layer)),
      )

      assert.isTrue(Result.isFailure(result))
      assert.strictEqual(calls, 1)
    }),
  )

  it.live('never retries a create-notebook mutation after an ambiguous 500', () =>
    Effect.gen(function* () {
      let calls = 0
      const layer = Layer.mergeAll(
        httpHandlerTest(() => {
          calls += 1
          return Effect.fail(new HttpStatusError({ url: 'u', status: 500 }))
        }),
        NoopDebugLive,
      )
      const result = yield* Effect.result(
        createNotebook('Untitled notebook', session, 0).pipe(Effect.provide(layer)),
      )

      assert.isTrue(Result.isFailure(result))
      assert.strictEqual(calls, 1)
    }),
  )

  it.effect('maps an "er" frame to RpcRefused', () =>
    Effect.gen(function* () {
      const text = `)]}'\n${chunk([['er', RPC_IDS.addSource, 'QUOTA_EXCEEDED']])}\n`
      const layer = Layer.mergeAll(
        httpHandlerTest(() => Effect.succeed(text)),
        NoopDebugLive,
      )
      const result = yield* Effect.result(
        rpcCall(RPC_IDS.addSource, {}, session, 0).pipe(Effect.provide(layer)),
      )
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, RpcRefused)
        assert.strictEqual(result.failure.rpcId, RPC_IDS.addSource)
        assert.strictEqual(result.failure.code, '"QUOTA_EXCEEDED"')
      }
    }),
  )

  it.effect('maps a placeholder-only response to a null payload (not an error)', () =>
    Effect.gen(function* () {
      const text = `)]}'\n${chunk([['wrb.fr', RPC_IDS.addSource, null]])}\n`
      const layer = Layer.mergeAll(
        httpHandlerTest(() => Effect.succeed(text)),
        NoopDebugLive,
      )
      const result = yield* rpcCall(RPC_IDS.addSource, {}, session, 0).pipe(Effect.provide(layer))
      assert.isNull(result)
    }),
  )

  it.effect('maps a drifted response (no matching frame) to ProtocolDrift', () =>
    Effect.gen(function* () {
      const text = `)]}'\n${chunk([['wrb.fr', 'unrelatedRpc', JSON.stringify({})]])}\n`
      const layer = Layer.mergeAll(
        httpHandlerTest(() => Effect.succeed(text)),
        NoopDebugLive,
      )
      const result = yield* Effect.result(
        rpcCall(RPC_IDS.addSource, {}, session, 0).pipe(Effect.provide(layer)),
      )
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, ProtocolDrift)
        assert.strictEqual(result.failure.rpcId, RPC_IDS.addSource)
      }
    }),
  )

  it.effect('does not retry a non-retryable 4xx status', () =>
    Effect.gen(function* () {
      let calls = 0
      const layer = Layer.mergeAll(
        httpHandlerTest(() => {
          calls += 1
          return Effect.fail(new HttpStatusError({ url: 'u', status: 400 }))
        }),
        NoopDebugLive,
      )
      const result = yield* Effect.result(
        rpcCall(RPC_IDS.addSource, {}, session, 0).pipe(Effect.provide(layer)),
      )
      assert.isTrue(Result.isFailure(result))
      assert.strictEqual(calls, 1)
    }),
  )
})
