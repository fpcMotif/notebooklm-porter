import { assert, it as effectIt } from '@effect/vitest'
import { Effect, Fiber, Layer } from 'effect'
import { TestClock } from 'effect/testing'
import { describe, expect, it } from 'vitest'
import { HttpStatusError } from '../../fx/errors'
import type { VideoEntry } from '../../model/types'
import { Http } from '../../fx/services'
import { debugLogTest } from '../../fx/testing'
import { enrichPlaylistTranscripts, MAX_TRANSCRIPT_VIDEOS } from './enrich'

function video(videoId: string, index: number): VideoEntry {
  return {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title: `Video ${index}`,
    index,
  }
}

function watchHtml(captionUrl?: string): string {
  const playerResponse =
    captionUrl === undefined
      ? {}
      : {
          captions: {
            playerCaptionsTracklistRenderer: {
              captionTracks: [{ baseUrl: captionUrl, languageCode: 'en' }],
            },
          },
        }
  return `<script>ytInitialPlayerResponse = ${JSON.stringify(playerResponse)};</script><script>var ytInitialData = {};</script>`
}

describe('enrichPlaylistTranscripts', () => {
  it('stores a successful transcript snapshot without exposing its caption URL', async () => {
    const source = video('aaaaaaaaaaa', 1)
    const calls: string[] = []
    const layer = Layer.succeed(
      Http,
      Http.of({
        text: (url: string) => {
          calls.push(url)
          if (url === source.url) {
            return Effect.succeed(watchHtml('https://captions.example.test/get?lang=en'))
          }
          return Effect.succeed('{"events":[{"tStartMs":0,"segs":[{"utf8":"Hello"}]}]}')
        },
        json: () => Effect.die('unused in transcript enrichment'),
      }),
    )

    const docs = await Effect.runPromise(
      enrichPlaylistTranscripts([source]).pipe(Effect.provide(Layer.merge(layer, debugLogTest()))),
    )

    expect(docs).toMatchObject([
      {
        videoId: source.videoId,
        url: source.url,
        title: source.title,
        markdown: expect.stringContaining('## Transcript'),
      },
    ])
    expect(calls).toEqual([source.url, 'https://captions.example.test/get?lang=en&fmt=json3'])
  })

  it('degrades failed and empty transcript fetches to no snapshot', async () => {
    const failed = video('bbbbbbbbbbb', 1)
    const empty = video('ccccccccccc', 2)
    const layer = Layer.succeed(
      Http,
      Http.of({
        text: (url: string) => {
          if (url === failed.url) return Effect.fail(new HttpStatusError({ url, status: 503 }))
          if (url === empty.url) {
            return Effect.succeed(watchHtml('https://captions.example.test/empty'))
          }
          return Effect.succeed('')
        },
        json: () => Effect.die('unused in transcript enrichment'),
      }),
    )

    await expect(
      Effect.runPromise(
        enrichPlaylistTranscripts([failed, empty]).pipe(
          Effect.provide(Layer.merge(layer, debugLogTest())),
        ),
      ),
    ).resolves.toEqual([])
  })

  effectIt.effect('degrades a stalled video fetch instead of blocking playlist capture', () =>
    Effect.gen(function* () {
      const source = video('jjjjjjjjjjj', 1)
      const layer = Layer.succeed(
        Http,
        Http.of({
          text: () => Effect.never,
          json: () => Effect.die('unused in transcript enrichment'),
        }),
      )
      const fiber = yield* Effect.race(
        enrichPlaylistTranscripts([source]).pipe(
          Effect.provide(Layer.merge(layer, debugLogTest())),
          Effect.map((docs) => ({ kind: 'result' as const, docs })),
        ),
        Effect.sleep('21 seconds').pipe(Effect.as({ kind: 'deadline' as const })),
      ).pipe(Effect.forkChild)

      yield* TestClock.adjust('21 seconds')
      const outcome = yield* Fiber.join(fiber)

      assert.strictEqual(outcome.kind, 'result')
      if (outcome.kind === 'result') assert.deepStrictEqual(outcome.docs, [])
    }),
  )

  it('bounds enrichment to the first 200 playlist videos', async () => {
    const videos = Array.from({ length: MAX_TRANSCRIPT_VIDEOS + 1 }, (_, index) =>
      video(`id${String(index).padStart(9, '0')}`, index + 1),
    )
    const calls: string[] = []
    const layer = Layer.succeed(
      Http,
      Http.of({
        text: (url: string) => {
          calls.push(url)
          return Effect.succeed(watchHtml())
        },
        json: () => Effect.die('unused in transcript enrichment'),
      }),
    )

    await Effect.runPromise(
      enrichPlaylistTranscripts(videos).pipe(Effect.provide(Layer.merge(layer, debugLogTest()))),
    )

    expect(calls).toHaveLength(MAX_TRANSCRIPT_VIDEOS)
    expect(calls).not.toContain(videos[MAX_TRANSCRIPT_VIDEOS]?.url)
  })
})
