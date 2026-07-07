import { assert, describe, it } from '@effect/vitest'
import { Effect, Result } from 'effect'
import { FetchError, HttpStatusError } from './errors'
import { makeHttp } from './services'

function fakeFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): typeof fetch {
  return impl as unknown as typeof fetch
}

describe('makeHttp', () => {
  it.effect('text() resolves on a 200 response', () =>
    Effect.gen(function* () {
      const http = makeHttp(fakeFetch(async () => new Response('hello', { status: 200 })))
      const body = yield* http.text('https://example.com')
      assert.strictEqual(body, 'hello')
    }),
  )

  it.effect('json() resolves parsed JSON on a 200 response', () =>
    Effect.gen(function* () {
      const http = makeHttp(
        fakeFetch(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
      )
      const body = yield* http.json('https://example.com')
      assert.deepStrictEqual(body, { ok: true })
    }),
  )

  it.effect('maps a rejected fetch to FetchError', () =>
    Effect.gen(function* () {
      const http = makeHttp(
        fakeFetch(async () => {
          throw new Error('network down')
        }),
      )
      const result = yield* Effect.result(http.text('https://example.com'))
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, FetchError)
        assert.strictEqual(result.failure.url, 'https://example.com')
      }
    }),
  )

  it.effect('maps a non-ok response to HttpStatusError', () =>
    Effect.gen(function* () {
      const http = makeHttp(fakeFetch(async () => new Response('nope', { status: 500 })))
      const result = yield* Effect.result(http.text('https://example.com'))
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, HttpStatusError)
        assert.strictEqual(result.failure.status, 500)
      }
    }),
  )

  it.effect('maps a rejected .json() body read to FetchError', () =>
    Effect.gen(function* () {
      const http = makeHttp(fakeFetch(async () => new Response('not json', { status: 200 })))
      const result = yield* Effect.result(http.json('https://example.com'))
      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, FetchError)
      }
    }),
  )
})
