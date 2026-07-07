import { assert, describe, it } from '@effect/vitest'
import { Cause, Effect, Exit, Layer, Result } from 'effect'
import { HttpStatusError, NotLoggedIn } from '../fx/errors'
import { DebugLog, Http, Kv, type HttpInit } from '../fx/services'
import type { SourceDoc } from '../model/types'
import { ingestIntoNotebook } from './notebooklm'
import { RPC_IDS } from './rpc/protocol'

const NoopDebugLive = Layer.succeed(DebugLog, DebugLog.of({ log: () => Effect.void }))

const LOGGED_IN_HOME = '"SNlM0e":"csrf-token-1"...."FdrFJe":"fsid-1"'

/** Byte-count line + JSON-array-chunk line, alternating, per the real rt=c format. */
function chunk(frames: unknown[][]): string {
  const line = JSON.stringify(frames)
  return `${line.length}\n${line}`
}

function addSourceOkResponse(): string {
  const payload = JSON.stringify({ ok: true })
  return `)]}'\n${chunk([['wrb.fr', RPC_IDS.addSource, payload]])}\n`
}

function kvLayer(docs: SourceDoc[]) {
  return Layer.succeed(
    Kv,
    Kv.of({
      get: () => Effect.succeed(docs as never),
      set: () => Effect.void,
    }),
  )
}

function makeDoc(overrides: Partial<SourceDoc> & Pick<SourceDoc, 'id'>): SourceDoc {
  return {
    site: 'reddit',
    kind: 'thread',
    title: 'Doc title',
    canonicalUrl: 'https://example.com',
    capturedAt: '2026-07-06T00:00:00.000Z',
    markdown: 'body',
    wordCount: 1,
    truncated: false,
    ...overrides,
  }
}

describe('ingestIntoNotebook', () => {
  // Real timers: the 500 from the "bad" video triggers rpcCall's retry
  // schedule, which sleeps between attempts — it.effect's virtual TestClock
  // never auto-advances, so it would hang.
  it.live('marks a doc failed in isolation while other docs still succeed', () =>
    Effect.gen(function* () {
      const goodVideoDoc = makeDoc({
        id: 'yt:good',
        kind: 'playlist',
        markdown: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
      })
      const badVideoDoc = makeDoc({
        id: 'yt:bad',
        kind: 'playlist',
        markdown: 'https://www.youtube.com/watch?v=bbbbbbbbbbb',
      })

      const httpLayer = Layer.succeed(
        Http,
        Http.of({
          text: (url: string, init?: HttpInit) => {
            if (init?.method !== 'POST') {
              return Effect.succeed(LOGGED_IN_HOME)
            }
            const body = init.body ?? ''
            if (body.includes('bbbbbbbbbbb')) {
              return Effect.fail(new HttpStatusError({ url, status: 500 }))
            }
            return Effect.succeed(addSourceOkResponse())
          },
          json: () => Effect.die('not used'),
        }),
      )

      const layer = Layer.mergeAll(httpLayer, kvLayer([goodVideoDoc, badVideoDoc]), NoopDebugLive)

      const outcomes = yield* ingestIntoNotebook(['yt:good', 'yt:bad'], {
        notebookId: 'nb-1',
      }).pipe(Effect.provide(layer))

      assert.strictEqual(outcomes.length, 2)
      const good = outcomes.find((o) => o.docId === 'yt:good')
      const bad = outcomes.find((o) => o.docId === 'yt:bad')
      assert.isDefined(good)
      assert.isDefined(bad)
      assert.strictEqual(good?.ok, true)
      assert.strictEqual(bad?.ok, false)
      assert.strictEqual(bad?.tier, 'rpc')
    }),
  )

  it.effect('marks a requested doc not found without failing the whole batch', () =>
    Effect.gen(function* () {
      const httpLayer = Layer.succeed(
        Http,
        Http.of({
          text: () => Effect.succeed(LOGGED_IN_HOME),
          json: () => Effect.die('not used'),
        }),
      )
      const layer = Layer.mergeAll(httpLayer, kvLayer([]), NoopDebugLive)

      const outcomes = yield* ingestIntoNotebook(['missing-doc'], { notebookId: 'nb-1' }).pipe(
        Effect.provide(layer),
      )

      assert.strictEqual(outcomes.length, 1)
      assert.strictEqual(outcomes[0]?.ok, false)
      assert.strictEqual(outcomes[0]?.error, 'Doc not found')
    }),
  )

  it.effect(
    'fails with the typed NotLoggedIn error when the session fetch itself fails, instead of stringifying it into IngestOutcome[]',
    () =>
      Effect.gen(function* () {
        const httpLayer = Layer.succeed(
          Http,
          Http.of({
            text: () => Effect.succeed('<html>signed out</html>'),
            json: () => Effect.die('not used'),
          }),
        )
        const doc = makeDoc({ id: 'reddit:1' })
        const layer = Layer.mergeAll(httpLayer, kvLayer([doc]), NoopDebugLive)

        const exit = yield* Effect.exit(
          ingestIntoNotebook(['reddit:1'], { notebookId: 'nb-1' }).pipe(Effect.provide(layer)),
        )

        assert.isTrue(Exit.isFailure(exit))
        if (Exit.isFailure(exit)) {
          const found = Cause.findFail(exit.cause)
          assert.isTrue(Result.isSuccess(found) && found.success.error instanceof NotLoggedIn)
        }
      }),
  )
})
