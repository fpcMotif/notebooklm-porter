import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer, Result } from 'effect'
import { HttpStatusError } from '../../fx/errors'
import { Http } from '../../fx/services'
import { capturePlaylist, isMixList } from './capture'
import realMixPanel from './fixture-mix-panel.json'

function htmlWithInitialData(data: unknown): string {
  return `<html><body><script>
    var ytInitialData = ${JSON.stringify(data)};
  </script></body></html>`
}

function makeHttpLayer(html: string, opts: { fail?: boolean } = {}) {
  const calls: string[] = []
  const layer = Layer.succeed(
    Http,
    Http.of({
      text: (url: string) => {
        calls.push(url)
        if (opts.fail) {
          return Effect.fail(new HttpStatusError({ url, status: 500 }))
        }
        return Effect.succeed(html)
      },
      json: () => Effect.die('unused in this test'),
    }),
  )
  return { layer, calls }
}

describe('isMixList', () => {
  it('treats RD-prefixed ids as mixes', () => {
    assert.isTrue(isMixList('RD9UZKYgqcY8U'))
  })

  it('treats UL-prefixed ids as mixes', () => {
    assert.isTrue(isMixList('ULabc123'))
  })

  it('treats other prefixes (PL, OLAK) as non-mixes', () => {
    assert.isFalse(isMixList('PL553DCA4DB88B0408'))
    assert.isFalse(isMixList('OLAK5uy_abc'))
  })
})

describe('capturePlaylist (mix branch)', () => {
  const MIX_URL = 'https://www.youtube.com/watch?v=9UZKYgqcY8U&list=RD9UZKYgqcY8U&start_radio=1'

  it.effect('fetches the cleaned original watch URL, stripping non-v/list params', () =>
    Effect.gen(function* () {
      const { layer, calls } = makeHttpLayer(htmlWithInitialData(realMixPanel))
      yield* capturePlaylist(MIX_URL).pipe(Effect.provide(layer))
      assert.deepStrictEqual(calls, [
        'https://www.youtube.com/watch?v=9UZKYgqcY8U&list=RD9UZKYgqcY8U',
      ])
    }),
  )

  it.effect('parses the panel videos and sets playlist.url to the cleaned watch URL', () =>
    Effect.gen(function* () {
      const { layer } = makeHttpLayer(htmlWithInitialData(realMixPanel))
      const capture = yield* capturePlaylist(MIX_URL).pipe(Effect.provide(layer))
      assert.strictEqual(capture.kind, 'playlist')
      const playlist = capture.kind === 'playlist' ? capture.playlist : undefined
      assert.strictEqual(playlist?.videos.length, 3)
      assert.strictEqual(
        playlist?.url,
        'https://www.youtube.com/watch?v=9UZKYgqcY8U&list=RD9UZKYgqcY8U',
      )
      assert.strictEqual(
        playlist?.title,
        "Mix - 260324 KARINA 카리나 - THAT'S A NO NO & RUDE! COVER @KARINA B-DAY PARTY MEMORY BOX IN SEOUL",
      )
    }),
  )

  it.effect('always forces truncated: true for a mix snapshot', () =>
    Effect.gen(function* () {
      const { layer } = makeHttpLayer(htmlWithInitialData(realMixPanel))
      const capture = yield* capturePlaylist(MIX_URL).pipe(Effect.provide(layer))
      const playlist = capture.kind === 'playlist' ? capture.playlist : undefined
      assert.strictEqual(playlist?.truncated, true)
    }),
  )

  it.effect('does not attempt a continuation fetch for a mix (only one fetch call total)', () =>
    Effect.gen(function* () {
      const { layer, calls } = makeHttpLayer(htmlWithInitialData(realMixPanel))
      yield* capturePlaylist(MIX_URL).pipe(Effect.provide(layer))
      assert.strictEqual(calls.length, 1)
    }),
  )

  it.effect('fails with HttpStatusError including the fetched URL when the page fetch fails', () =>
    Effect.gen(function* () {
      const { layer } = makeHttpLayer('', { fail: true })
      const result = yield* Effect.result(capturePlaylist(MIX_URL).pipe(Effect.provide(layer)))
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, HttpStatusError)
        assert.strictEqual(
          result.failure.url,
          'https://www.youtube.com/watch?v=9UZKYgqcY8U&list=RD9UZKYgqcY8U',
        )
      }
    }),
  )
})
