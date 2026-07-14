import { assert, describe, it } from '@effect/vitest'
import { Cause, Effect, Exit, Layer, Result } from 'effect'
import { HttpStatusError, NotLoggedIn } from '../fx/errors'
import { DebugLog, Http, Kv, type HttpInit } from '../fx/services'
import type { SourceDoc } from '../model/types'
import { ingestIntoNotebook } from './notebooklm'
import { RPC_IDS } from './rpc/protocol'

const NoopDebugLive = Layer.succeed(
  DebugLog,
  DebugLog.of({
    log: () => Effect.void,
    entries: () => Effect.succeed([]),
    clear: () => Effect.void,
  }),
)

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

function kvLayer(docs: SourceDoc[], ledger: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>([
    ['porter/docs', docs],
    ['porter/ledger', ledger],
  ])
  const writes: string[] = []
  const layer = Layer.succeed(
    Kv,
    Kv.of({
      get: <T>(key: string) => Effect.sync(() => values.get(key) as T | undefined),
      set: <T>(key: string, value: T) =>
        Effect.sync(() => {
          values.set(key, value)
          writes.push(key)
        }),
    }),
  )
  return { layer, values, writes }
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
        markdown: '# Good overview',
        jsonl: JSON.stringify({ url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' }),
      })
      const badVideoDoc = makeDoc({
        id: 'yt:bad',
        kind: 'playlist',
        markdown: '# Bad overview',
        jsonl: JSON.stringify({ url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb' }),
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

      const storage = kvLayer([goodVideoDoc, badVideoDoc])
      const layer = Layer.mergeAll(httpLayer, storage.layer, NoopDebugLive)

      const outcomes = yield* ingestIntoNotebook(['yt:good', 'yt:bad'], {
        notebookId: 'nb-1',
      }).pipe(Effect.provide(layer))

      assert.strictEqual(outcomes.length, 4)
      assert.deepStrictEqual(
        outcomes.map((outcome) => [outcome.docId, outcome.unitId, outcome.status]),
        [
          ['yt:good', 'yt:good:toc', 'sent'],
          ['yt:good', 'youtube:aaaaaaaaaaa', 'sent'],
          ['yt:bad', 'yt:bad:toc', 'sent'],
          ['yt:bad', 'youtube:bbbbbbbbbbb', 'failed'],
        ],
      )
      assert.strictEqual(storage.writes.filter((key) => key === 'porter/ledger').length, 3)
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
      const storage = kvLayer([])
      const layer = Layer.mergeAll(httpLayer, storage.layer, NoopDebugLive)

      const outcomes = yield* ingestIntoNotebook(['missing-doc'], { notebookId: 'nb-1' }).pipe(
        Effect.provide(layer),
      )

      assert.strictEqual(outcomes.length, 1)
      assert.strictEqual(outcomes[0]?.ok, false)
      assert.strictEqual(outcomes[0]?.status, 'failed')
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
        const storage = kvLayer([doc])
        const layer = Layer.mergeAll(httpLayer, storage.layer, NoopDebugLive)

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

  it.effect('skips an unchanged playlist without posting any sources on a second run', () =>
    Effect.gen(function* () {
      const doc = makeDoc({
        id: 'yt:stable',
        kind: 'playlist',
        markdown: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
      })
      let posts = 0
      const httpLayer = Layer.succeed(
        Http,
        Http.of({
          text: (_url: string, init?: HttpInit) => {
            if (init?.method !== 'POST') return Effect.succeed(LOGGED_IN_HOME)
            posts += 1
            return Effect.succeed(addSourceOkResponse())
          },
          json: () => Effect.die('not used'),
        }),
      )
      const storage = kvLayer([doc])
      const layer = Layer.mergeAll(httpLayer, storage.layer, NoopDebugLive)

      const first = yield* ingestIntoNotebook(['yt:stable'], { notebookId: 'nb-1' }).pipe(
        Effect.provide(layer),
      )
      const second = yield* ingestIntoNotebook(['yt:stable'], { notebookId: 'nb-1' }).pipe(
        Effect.provide(layer),
      )

      assert.strictEqual(posts, 2)
      assert.deepStrictEqual(
        first.map((outcome) => outcome.status),
        ['sent', 'sent'],
      )
      assert.deepStrictEqual(
        second.map((outcome) => outcome.status),
        ['skipped', 'skipped'],
      )
    }),
  )

  it.live(
    'persists each successful playlist unit so retry only posts the previously failed video',
    () =>
      Effect.gen(function* () {
        const doc = makeDoc({
          id: 'yt:partial',
          kind: 'playlist',
          markdown: '# Playlist overview',
          jsonl: [
            JSON.stringify({ url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' }),
            JSON.stringify({ url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb' }),
            JSON.stringify({ url: 'https://www.youtube.com/watch?v=ccccccccccc' }),
          ].join('\n'),
        })
        let allowBadVideo = false
        const postBodies: string[] = []
        const httpLayer = Layer.succeed(
          Http,
          Http.of({
            text: (_url: string, init?: HttpInit) => {
              if (init?.method !== 'POST') return Effect.succeed(LOGGED_IN_HOME)
              const body = init.body ?? ''
              postBodies.push(body)
              if (!allowBadVideo && body.includes('bbbbbbbbbbb')) {
                return Effect.fail(new HttpStatusError({ url: 'https://rpc.test', status: 500 }))
              }
              return Effect.succeed(addSourceOkResponse())
            },
            json: () => Effect.die('not used'),
          }),
        )
        const storage = kvLayer([doc])
        const layer = Layer.mergeAll(httpLayer, storage.layer, NoopDebugLive)

        const first = yield* ingestIntoNotebook(['yt:partial'], { notebookId: 'nb-1' }).pipe(
          Effect.provide(layer),
        )
        allowBadVideo = true
        const retry = yield* ingestIntoNotebook(['yt:partial'], { notebookId: 'nb-1' }).pipe(
          Effect.provide(layer),
        )

        assert.deepStrictEqual(
          first.map((outcome) => outcome.status),
          ['sent', 'sent', 'failed', 'sent'],
        )
        assert.deepStrictEqual(
          retry.map((outcome) => outcome.status),
          ['skipped', 'skipped', 'sent', 'skipped'],
        )
        assert.strictEqual(postBodies.filter((body) => body.includes('aaaaaaaaaaa')).length, 1)
        assert.strictEqual(postBodies.filter((body) => body.includes('ccccccccccc')).length, 1)
        assert.strictEqual(postBodies.filter((body) => body.includes('bbbbbbbbbbb')).length, 2)
      }),
  )

  it.effect('reimports only a changed playlist overview while preserving video receipts', () =>
    Effect.gen(function* () {
      const original = makeDoc({
        id: 'yt:changed',
        kind: 'playlist',
        markdown: '# Original overview',
        jsonl: JSON.stringify({ url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' }),
      })
      const updated = { ...original, markdown: '# Updated overview' }
      let posts = 0
      const httpLayer = Layer.succeed(
        Http,
        Http.of({
          text: (_url: string, init?: HttpInit) => {
            if (init?.method !== 'POST') return Effect.succeed(LOGGED_IN_HOME)
            posts += 1
            return Effect.succeed(addSourceOkResponse())
          },
          json: () => Effect.die('not used'),
        }),
      )
      const storage = kvLayer([original])
      const layer = Layer.mergeAll(httpLayer, storage.layer, NoopDebugLive)

      yield* ingestIntoNotebook(['yt:changed'], { notebookId: 'nb-1' }).pipe(Effect.provide(layer))
      storage.values.set('porter/docs', [updated])
      const rerun = yield* ingestIntoNotebook(['yt:changed'], { notebookId: 'nb-1' }).pipe(
        Effect.provide(layer),
      )

      assert.strictEqual(posts, 3)
      assert.deepStrictEqual(
        rerun.map((outcome) => outcome.status),
        ['sent', 'skipped'],
      )
    }),
  )

  it.effect('deduplicates a shared video across playlists in the same import run', () =>
    Effect.gen(function* () {
      const first = makeDoc({
        id: 'yt:first',
        kind: 'playlist',
        markdown: '# First overview',
        jsonl: JSON.stringify({ url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' }),
      })
      const second = makeDoc({
        id: 'yt:second',
        kind: 'playlist',
        markdown: '# Second overview',
        jsonl: JSON.stringify({ url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' }),
      })
      let posts = 0
      const httpLayer = Layer.succeed(
        Http,
        Http.of({
          text: (_url: string, init?: HttpInit) => {
            if (init?.method !== 'POST') return Effect.succeed(LOGGED_IN_HOME)
            posts += 1
            return Effect.succeed(addSourceOkResponse())
          },
          json: () => Effect.die('not used'),
        }),
      )
      const storage = kvLayer([first, second])
      const layer = Layer.mergeAll(httpLayer, storage.layer, NoopDebugLive)

      const outcomes = yield* ingestIntoNotebook(['yt:first', 'yt:second'], {
        notebookId: 'nb-1',
      }).pipe(Effect.provide(layer))

      assert.strictEqual(posts, 3)
      assert.deepStrictEqual(
        outcomes.map((outcome) => outcome.status),
        ['sent', 'sent', 'sent', 'skipped'],
      )
    }),
  )
})
