import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer, Result } from 'effect'
import { HttpStatusError } from '../../fx/errors'
import { Http } from '../../fx/services'
import { captureRedditThread } from './capture'

const FROZEN_JSON = [
  {
    kind: 'Listing',
    data: {
      children: [
        {
          kind: 't3',
          data: {
            id: 'abc123',
            title: 'Some title',
            author: 'op_user',
            selftext: 'Body text.',
            created_utc: 1700000000,
            score: 5,
            permalink: '/r/test/comments/abc123/some_title/',
            num_comments: 0,
          },
        },
      ],
    },
  },
  { kind: 'Listing', data: { children: [] } },
]

function makeHttpLayer(json: unknown, opts: { fail?: boolean } = {}) {
  const calls: string[] = []
  const layer = Layer.succeed(
    Http,
    Http.of({
      text: () => Effect.die('unused in this test'),
      json: (url: string) => {
        calls.push(url)
        if (opts.fail) {
          return Effect.fail(new HttpStatusError({ url, status: 429 }))
        }
        return Effect.succeed(json)
      },
    }),
  )
  return { layer, calls }
}

describe('captureRedditThread', () => {
  it.effect('fetches the .json URL built from the post URL, stripping query and hash', () =>
    Effect.gen(function* () {
      const { layer, calls } = makeHttpLayer(FROZEN_JSON)
      yield* captureRedditThread(
        'https://www.reddit.com/r/test/comments/abc123/some_title/?utm_source=share#comment',
      ).pipe(Effect.provide(layer))
      assert.deepStrictEqual(calls, [
        'https://www.reddit.com/r/test/comments/abc123/some_title.json',
      ])
    }),
  )

  it.effect('handles a post URL with no trailing slash', () =>
    Effect.gen(function* () {
      const { layer, calls } = makeHttpLayer(FROZEN_JSON)
      yield* captureRedditThread('https://www.reddit.com/r/test/comments/abc123/some_title').pipe(
        Effect.provide(layer),
      )
      assert.deepStrictEqual(calls, [
        'https://www.reddit.com/r/test/comments/abc123/some_title.json',
      ])
    }),
  )

  it.effect('returns a Capture of kind thread wrapping the parsed thread', () =>
    Effect.gen(function* () {
      const { layer } = makeHttpLayer(FROZEN_JSON)
      const capture = yield* captureRedditThread(
        'https://www.reddit.com/r/test/comments/abc123/some_title/',
      ).pipe(Effect.provide(layer))
      assert.strictEqual(capture.kind, 'thread')
      const thread = capture.kind === 'thread' ? capture.thread : undefined
      assert.strictEqual(thread?.site, 'reddit')
      assert.strictEqual(thread?.title, 'Some title')
      assert.strictEqual(thread?.posts.length, 1)
    }),
  )

  it.effect('fails with HttpStatusError when the fetch response is not ok', () =>
    Effect.gen(function* () {
      const { layer } = makeHttpLayer(FROZEN_JSON, { fail: true })
      const result = yield* Effect.result(
        captureRedditThread('https://www.reddit.com/r/test/comments/abc123/some_title/').pipe(
          Effect.provide(layer),
        ),
      )
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, HttpStatusError)
      }
    }),
  )
})
