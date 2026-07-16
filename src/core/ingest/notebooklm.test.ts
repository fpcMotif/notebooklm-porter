import { assert, describe, it } from '@effect/vitest'
import { Cause, Effect, Exit, Layer, Result } from 'effect'
import { HttpStatusError, NotLoggedIn } from '../fx/errors'
import { DebugLog, Http, Kv, type HttpInit } from '../fx/services'
import type { PlaylistSourceDoc, SourceDoc, ThreadSourceDoc } from '../model/types'
import { LEDGER_STORAGE_KEY } from '../store/ledger'
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

const LOGGED_IN_HOME = '"SNlM0e":"csrf-token-1"...."FdrFJe":"fsid-1"...."oPEP7c":"f@example.com"'

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
    [LEDGER_STORAGE_KEY, ledger],
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

type ThreadDocOverrides = Partial<ThreadSourceDoc> & Pick<ThreadSourceDoc, 'id'>
type PlaylistDocOverrides = Partial<PlaylistSourceDoc> & Pick<PlaylistSourceDoc, 'id' | 'kind'>

function playlistUrl(playlistId: string): string {
  const url = new URL('https://www.youtube.com/playlist')
  url.searchParams.set('list', playlistId)
  return url.toString()
}

function videoUrl(videoId: string): string {
  const url = new URL('https://www.youtube.com/watch')
  url.searchParams.set('v', videoId)
  return url.toString()
}

function makeDoc(overrides: PlaylistDocOverrides): PlaylistSourceDoc
function makeDoc(overrides: ThreadDocOverrides): ThreadSourceDoc
function makeDoc(overrides: PlaylistDocOverrides | ThreadDocOverrides): SourceDoc {
  if (overrides.kind === 'playlist') {
    const playlistId = overrides.id.slice('youtube:'.length)
    return {
      site: 'youtube',
      title: 'Doc title',
      canonicalUrl: playlistUrl(playlistId),
      capturedAt: '2026-07-06T00:00:00.000Z',
      markdown: 'body',
      playlistVideos: [],
      wordCount: 1,
      truncated: false,
      ...overrides,
    }
  }
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
        id: 'youtube:good',
        kind: 'playlist',
        markdown: '# Good overview',
        playlistVideos: [
          { videoId: 'aaaaaaaaaaa', url: videoUrl('aaaaaaaaaaa'), title: 'Good', index: 1 },
        ],
        jsonl: JSON.stringify({ url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' }),
      })
      const badVideoDoc = makeDoc({
        id: 'youtube:bad',
        kind: 'playlist',
        markdown: '# Bad overview',
        playlistVideos: [
          { videoId: 'bbbbbbbbbbb', url: videoUrl('bbbbbbbbbbb'), title: 'Bad', index: 1 },
        ],
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

      const outcomes = yield* ingestIntoNotebook(['youtube:good', 'youtube:bad'], {
        notebookId: 'nb-1',
      }).pipe(Effect.provide(layer))

      assert.strictEqual(outcomes.length, 4)
      assert.deepStrictEqual(
        outcomes.map((outcome) => [outcome.docId, outcome.unitId, outcome.status]),
        [
          ['youtube:good', 'youtube:good:toc', 'sent'],
          ['youtube:good', 'youtube:aaaaaaaaaaa', 'sent'],
          ['youtube:bad', 'youtube:bad:toc', 'sent'],
          ['youtube:bad', 'youtube:bbbbbbbbbbb', 'failed'],
        ],
      )
      assert.strictEqual(storage.writes.filter((key) => key === LEDGER_STORAGE_KEY).length, 3)
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

  it.effect('fails closed when a legacy direct ingest session has no observed email', () =>
    Effect.gen(function* () {
      const httpLayer = Layer.succeed(
        Http,
        Http.of({
          text: () => Effect.succeed('"SNlM0e":"csrf-token-1"'),
          json: () => Effect.die('not used'),
        }),
      )
      const storage = kvLayer([makeDoc({ id: 'reddit:1' })])
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
        id: 'youtube:stable',
        kind: 'playlist',
        markdown: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
        playlistVideos: [
          { videoId: 'aaaaaaaaaaa', url: videoUrl('aaaaaaaaaaa'), title: 'Stable', index: 1 },
        ],
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

      const first = yield* ingestIntoNotebook(['youtube:stable'], { notebookId: 'nb-1' }).pipe(
        Effect.provide(layer),
      )
      const second = yield* ingestIntoNotebook(['youtube:stable'], { notebookId: 'nb-1' }).pipe(
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
          id: 'youtube:partial',
          kind: 'playlist',
          markdown: '# Playlist overview',
          playlistVideos: [
            { videoId: 'aaaaaaaaaaa', url: videoUrl('aaaaaaaaaaa'), title: 'A', index: 1 },
            { videoId: 'bbbbbbbbbbb', url: videoUrl('bbbbbbbbbbb'), title: 'B', index: 2 },
            { videoId: 'ccccccccccc', url: videoUrl('ccccccccccc'), title: 'C', index: 3 },
          ],
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

        const first = yield* ingestIntoNotebook(['youtube:partial'], { notebookId: 'nb-1' }).pipe(
          Effect.provide(layer),
        )
        allowBadVideo = true
        const retry = yield* ingestIntoNotebook(['youtube:partial'], { notebookId: 'nb-1' }).pipe(
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
        id: 'youtube:changed',
        kind: 'playlist',
        markdown: '# Original overview',
        playlistVideos: [
          { videoId: 'aaaaaaaaaaa', url: videoUrl('aaaaaaaaaaa'), title: 'A', index: 1 },
        ],
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

      yield* ingestIntoNotebook(['youtube:changed'], { notebookId: 'nb-1' }).pipe(
        Effect.provide(layer),
      )
      storage.values.set('porter/docs', [updated])
      const rerun = yield* ingestIntoNotebook(['youtube:changed'], { notebookId: 'nb-1' }).pipe(
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
        id: 'youtube:first',
        kind: 'playlist',
        markdown: '# First overview',
        playlistVideos: [
          { videoId: 'aaaaaaaaaaa', url: videoUrl('aaaaaaaaaaa'), title: 'A', index: 1 },
        ],
        jsonl: JSON.stringify({ url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' }),
      })
      const second = makeDoc({
        id: 'youtube:second',
        kind: 'playlist',
        markdown: '# Second overview',
        playlistVideos: [
          { videoId: 'aaaaaaaaaaa', url: videoUrl('aaaaaaaaaaa'), title: 'A', index: 1 },
        ],
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

      const outcomes = yield* ingestIntoNotebook(['youtube:first', 'youtube:second'], {
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
