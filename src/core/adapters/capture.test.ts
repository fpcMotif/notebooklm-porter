import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer, Result } from 'effect'
import { IpcError } from '../fx/errors'
import { debugLogTest, httpTest, tabsTest } from '../fx/testing'
import type { Capture } from '../model/types'
import { captureSource } from './capture'
import type { ResolvedCapturable } from './registry'
import type { CaptureOptions, Capturable, SourceAdapter } from './types'
import { xAdapter } from './x/adapter'

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

const X_CAPTURE: Capture = {
  kind: 'thread',
  thread: {
    site: 'x',
    url: 'https://x.com/user/status/1',
    title: 'An X thread',
    author: { name: 'User' },
    posts: [{ id: '1', author: { name: 'User' }, depth: 0, text: 'hello', byOp: true }],
  },
}

const FOREIGN_X_CAPTURE: Capture = {
  ...X_CAPTURE,
  thread: { ...X_CAPTURE.thread, url: 'https://evil.com/user/status/1' },
}

function urlAdapter(onCapture: (url: string, options?: CaptureOptions) => void): SourceAdapter {
  return {
    id: 'reddit',
    hostMatch: [],
    detect: () => ({ identity: 'abc123', kind: 'thread', label: 'Capture this discussion' }),
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
  detect: () => ({ identity: '1', kind: 'thread', label: 'Capture this thread' }),
  strategy: { mode: 'content-script' },
}

function resolved(adapter: SourceAdapter, capturable?: Capturable): ResolvedCapturable {
  return {
    url: 'https://reddit.com/x',
    adapter,
    capturable:
      capturable ??
      (adapter.id === 'x'
        ? { identity: '1', kind: 'thread', label: 'Capture this thread' }
        : { identity: 'abc123', kind: 'thread', label: 'Capture this discussion' }),
  }
}

const base = Layer.mergeAll(httpTest({}), debugLogTest())

describe('captureSource', () => {
  it.effect('runs a url-mode adapter directly, forwarding the url and options', () =>
    Effect.gen(function* () {
      const calls: Array<{ url: string; options?: CaptureOptions }> = []
      const adapter = urlAdapter((url, options) =>
        calls.push({ url, ...(options !== undefined ? { options } : {}) }),
      )
      const capture = yield* captureSource(resolved(adapter), {
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
        captureSource(resolved(contentScriptAdapter)).pipe(
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
              return { ok: true, capture: X_CAPTURE }
            },
          }),
        )
        const capture = yield* captureSource(resolved(contentScriptAdapter), {
          tabId: 9,
        }).pipe(Effect.provide(layer))

        assert.deepStrictEqual(relayed, { tabId: 9, msg: { type: 'porter/extract-thread' } })
        assert.deepStrictEqual(capture, X_CAPTURE)
      }),
    )

    it.effect("fails with the content script's own error on ok:false", () =>
      Effect.gen(function* () {
        const layer = Layer.mergeAll(
          base,
          tabsTest({ onSendMessage: () => ({ ok: false, error: 'not signed in' }) }),
        )
        const outcome = yield* Effect.result(
          captureSource(resolved(contentScriptAdapter), { tabId: 9 }).pipe(Effect.provide(layer)),
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
          captureSource(resolved(contentScriptAdapter), { tabId: 9 }).pipe(Effect.provide(layer)),
        )
        assert.isTrue(Result.isFailure(outcome))
        if (!Result.isFailure(outcome) || !(outcome.failure instanceof IpcError)) return
        assert.strictEqual(outcome.failure.reason, 'Malformed content-script response')
      }),
    )
  })

  it.effect('rejects an adapter result with the wrong kind before it can be stored', () =>
    Effect.gen(function* () {
      const adapter = urlAdapter(() => {})
      const outcome = yield* Effect.result(
        captureSource(
          resolved(adapter, { identity: 'abc123', kind: 'video', label: 'Capture this video' }),
        ).pipe(Effect.provide(Layer.mergeAll(base, tabsTest({})))),
      )
      assert.isTrue(Result.isFailure(outcome))
      if (!Result.isFailure(outcome)) return
      assert.instanceOf(outcome.failure, IpcError)
    }),
  )

  it.effect('rejects an adapter result from the wrong site before it can be stored', () =>
    Effect.gen(function* () {
      const adapter = {
        ...urlAdapter(() => {}),
        id: 'hackernews' as const,
      }
      const outcome = yield* Effect.result(
        captureSource(resolved(adapter)).pipe(Effect.provide(Layer.mergeAll(base, tabsTest({})))),
      )
      assert.isTrue(Result.isFailure(outcome))
      if (!Result.isFailure(outcome)) return
      assert.instanceOf(outcome.failure, IpcError)
    }),
  )

  it.effect('rejects a same-site capture for a different X status', () =>
    Effect.gen(function* () {
      const intentUrl = 'https://x.com/user/status/2'
      const capturable = xAdapter.detect(intentUrl)
      if (capturable === null) throw new Error('fixture URL must be capturable')
      const layer = Layer.mergeAll(
        base,
        tabsTest({ onSendMessage: () => ({ ok: true, capture: X_CAPTURE }) }),
      )
      const outcome = yield* Effect.result(
        captureSource({ url: intentUrl, adapter: xAdapter, capturable }, { tabId: 9 }).pipe(
          Effect.provide(layer),
        ),
      )
      assert.isTrue(Result.isFailure(outcome))
      if (!Result.isFailure(outcome) || !(outcome.failure instanceof IpcError)) return
      assert.strictEqual(outcome.failure.reason, 'Captured source did not match this URL')
    }),
  )

  it.effect('rejects a foreign-host capture that imitates the requested X status', () =>
    Effect.gen(function* () {
      const intentUrl = 'https://x.com/user/status/1'
      const capturable = xAdapter.detect(intentUrl)
      if (capturable === null) throw new Error('fixture URL must be capturable')
      const outcome = yield* Effect.result(
        captureSource({ url: intentUrl, adapter: xAdapter, capturable }, { tabId: 9 }).pipe(
          Effect.provide(
            Layer.mergeAll(
              base,
              tabsTest({ onSendMessage: () => ({ ok: true, capture: FOREIGN_X_CAPTURE }) }),
            ),
          ),
        ),
      )
      assert.isTrue(Result.isFailure(outcome))
      if (!Result.isFailure(outcome) || !(outcome.failure instanceof IpcError)) return
      assert.strictEqual(outcome.failure.reason, 'Captured source did not match this URL')
    }),
  )
})
