import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer, Result } from 'effect'
import { ExtractionError, HttpStatusError } from '../../fx/errors'
import { Http } from '../../fx/services'
import { captureHnThread } from './capture'

const FIXTURE_ITEM = {
  id: 42,
  created_at: '2026-01-01T12:00:00.000Z',
  author: 'opuser',
  title: 'A Discussion',
  url: null,
  points: 5,
  text: '<p>Root text here.',
  type: 'story',
  children: [],
}

function makeHttpLayer(json: unknown, opts: { fail?: boolean } = {}) {
  const calls: string[] = []
  const layer = Layer.succeed(
    Http,
    Http.of({
      text: () => Effect.die('unused in this test'),
      json: (url: string) => {
        calls.push(url)
        if (opts.fail) {
          return Effect.fail(new HttpStatusError({ url, status: 404 }))
        }
        return Effect.succeed(json)
      },
    }),
  )
  return { layer, calls }
}

describe('captureHnThread', () => {
  it.effect('extracts the item id from the url and fetches the Algolia endpoint', () =>
    Effect.gen(function* () {
      const { layer, calls } = makeHttpLayer(FIXTURE_ITEM)
      yield* captureHnThread('https://news.ycombinator.com/item?id=42').pipe(Effect.provide(layer))
      assert.deepStrictEqual(calls, ['https://hn.algolia.com/api/v1/items/42'])
    }),
  )

  it.effect('returns a thread Capture built from the parsed item', () =>
    Effect.gen(function* () {
      const { layer } = makeHttpLayer(FIXTURE_ITEM)
      const capture = yield* captureHnThread('https://news.ycombinator.com/item?id=42').pipe(
        Effect.provide(layer),
      )
      assert.strictEqual(capture.kind, 'thread')
      if (capture.kind !== 'thread') return
      assert.strictEqual(capture.thread.site, 'hackernews')
      assert.strictEqual(capture.thread.url, 'https://news.ycombinator.com/item?id=42')
      assert.strictEqual(capture.thread.title, 'A Discussion')
      assert.strictEqual(capture.thread.posts[0]?.text, 'Root text here.')
    }),
  )

  it.effect(
    'produces the canonical /item?id= url regardless of extra query params on the input',
    () =>
      Effect.gen(function* () {
        const { layer } = makeHttpLayer(FIXTURE_ITEM)
        const capture = yield* captureHnThread(
          'https://news.ycombinator.com/item?id=42&extra=1',
        ).pipe(Effect.provide(layer))
        if (capture.kind !== 'thread') throw new Error('expected thread capture')
        assert.strictEqual(capture.thread.url, 'https://news.ycombinator.com/item?id=42')
      }),
  )

  it.effect('fails with ExtractionError when the url has no id parameter', () =>
    Effect.gen(function* () {
      const { layer } = makeHttpLayer(FIXTURE_ITEM)
      const result = yield* Effect.result(
        captureHnThread('https://news.ycombinator.com/item').pipe(Effect.provide(layer)),
      )
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, ExtractionError)
      }
    }),
  )

  it.effect('fails with HttpStatusError when the fetch response is not ok', () =>
    Effect.gen(function* () {
      const { layer } = makeHttpLayer(null, { fail: true })
      const result = yield* Effect.result(
        captureHnThread('https://news.ycombinator.com/item?id=999').pipe(Effect.provide(layer)),
      )
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, HttpStatusError)
      }
    }),
  )
})
