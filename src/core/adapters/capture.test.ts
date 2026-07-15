import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer, Result } from 'effect'
import { IpcError } from '../fx/errors'
import { debugLogTest, httpTest, tabsTest } from '../fx/testing'
import type { Capture } from '../model/types'
import { captureSource } from './capture'
import type { CaptureOptions, SourceAdapter } from './types'

const CAPTURE: Capture = {
  kind: 'thread',
  thread: {
    site: 'reddit',
    url: 'https://www.reddit.com/r/test/comments/abc123/title',
    title: 'A thread',
    author: { name: 'op' },
    posts: [{ id: '1', author: { name: 'op' }, depth: 0, text: 'hello', byOp: true }],
  },
}

function urlAdapter(onCapture: (url: string, options?: CaptureOptions) => void): SourceAdapter {
  return {
    id: 'reddit',
    hostMatch: [],
    detect: () => null,
    strategy: {
      mode: 'url',
      capture: (url, options) =>
        Effect.sync(() => {
          onCapture(url, options)
          return CAPTURE
        }),
    },
  }
}

const contentScriptAdapter: SourceAdapter = {
  id: 'x',
  hostMatch: [],
  detect: () => null,
  strategy: { mode: 'content-script' },
}

const base = Layer.mergeAll(httpTest({}), debugLogTest())

describe('captureSource', () => {
  it.effect('runs a url-mode adapter directly, forwarding the url and options', () =>
    Effect.gen(function* () {
      const calls: Array<{ url: string; options?: CaptureOptions }> = []
      const adapter = urlAdapter((url, options) =>
        calls.push({ url, ...(options !== undefined ? { options } : {}) }),
      )
      const capture = yield* captureSource(adapter, 'https://reddit.com/x', {
        options: { enrichTranscripts: true },
      }).pipe(Effect.provide(Layer.mergeAll(base, tabsTest({}))))

      assert.deepStrictEqual(calls, [
        { url: 'https://reddit.com/x', options: { enrichTranscripts: true } },
      ])
      assert.deepStrictEqual(capture, CAPTURE)
    }),
  )

  it.effect('fails a content-script adapter when no tab id is supplied', () =>
    Effect.gen(function* () {
      const outcome = yield* Effect.result(
        captureSource(contentScriptAdapter, 'https://x.com/u/status/1').pipe(
          Effect.provide(Layer.mergeAll(base, tabsTest({}))),
        ),
      )
      assert.isTrue(Result.isFailure(outcome))
      if (!Result.isFailure(outcome)) return
      assert.instanceOf(outcome.failure, IpcError)
      if (!(outcome.failure instanceof IpcError)) return
      assert.strictEqual(outcome.failure.reason, 'This site captures from its open tab only')
    }),
  )

  describe('content-script relay with a tab id', () => {
    it.effect('relays extract-thread and returns the capture on ok', () =>
      Effect.gen(function* () {
        let relayed: { tabId: number; msg: unknown } | undefined
        const layer = Layer.mergeAll(
          base,
          tabsTest({
            onSendMessage: (tabId, msg) => {
              relayed = { tabId, msg }
              return { ok: true, capture: CAPTURE }
            },
          }),
        )
        const capture = yield* captureSource(contentScriptAdapter, 'https://x.com/u/status/1', {
          tabId: 9,
        }).pipe(Effect.provide(layer))

        assert.deepStrictEqual(relayed, { tabId: 9, msg: { type: 'porter/extract-thread' } })
        assert.deepStrictEqual(capture, CAPTURE)
      }),
    )

    it.effect("fails with the content script's own error on ok:false", () =>
      Effect.gen(function* () {
        const layer = Layer.mergeAll(
          base,
          tabsTest({ onSendMessage: () => ({ ok: false, error: 'not signed in' }) }),
        )
        const outcome = yield* Effect.result(
          captureSource(contentScriptAdapter, 'https://x.com/u/status/1', { tabId: 9 }).pipe(
            Effect.provide(layer),
          ),
        )
        assert.isTrue(Result.isFailure(outcome))
        if (!Result.isFailure(outcome) || !(outcome.failure instanceof IpcError)) return
        assert.strictEqual(outcome.failure.reason, 'not signed in')
      }),
    )

    it.effect('fails with the malformed-response error on a garbage reply', () =>
      Effect.gen(function* () {
        const layer = Layer.mergeAll(base, tabsTest({ onSendMessage: () => 'garbage' }))
        const outcome = yield* Effect.result(
          captureSource(contentScriptAdapter, 'https://x.com/u/status/1', { tabId: 9 }).pipe(
            Effect.provide(layer),
          ),
        )
        assert.isTrue(Result.isFailure(outcome))
        if (!Result.isFailure(outcome) || !(outcome.failure instanceof IpcError)) return
        assert.strictEqual(outcome.failure.reason, 'Malformed content-script response')
      }),
    )
  })
})
