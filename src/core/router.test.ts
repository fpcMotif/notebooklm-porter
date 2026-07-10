import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import type { DebugEntry } from './debug'
import { debugLogTest, httpTest, identityTest, kvTest, tabsTest } from './fx/testing'
import { buildRpcUrl, homeUrl, RPC_IDS } from './ingest/rpc/protocol'
import type { SourceDoc } from './model/types'
import { handlePorterMessage } from './router'
import { DEFAULT_SETTINGS } from './settings'

/** Byte-count line + JSON-array-chunk line, alternating, per the real rt=c format. */
function chunk(frames: unknown[][]): string {
  const line = JSON.stringify(frames)
  return `${line.length}\n${line}`
}

/** A well-formed `rt=c` batchexecute body carrying one wrb.fr frame for `rpcId`. */
function rpcResponse(rpcId: string, payload: unknown): string {
  return `)]}'\n${chunk([['wrb.fr', rpcId, JSON.stringify(payload)]])}\n`
}

function makeDoc(overrides: Partial<SourceDoc> & Pick<SourceDoc, 'id' | 'capturedAt'>): SourceDoc {
  return {
    site: 'reddit',
    kind: 'thread',
    title: 'Untitled',
    canonicalUrl: 'https://example.com',
    markdown: '# doc',
    wordCount: 1,
    truncated: false,
    ...overrides,
  }
}

function testLayer(
  opts: {
    kv?: Record<string, unknown>
    debugSink?: DebugEntry[]
    tabs?: Parameters<typeof tabsTest>[0]
    http?: Record<string, string>
  } = {},
) {
  return Layer.mergeAll(
    kvTest(opts.kv ?? {}),
    debugLogTest(opts.debugSink ?? []),
    tabsTest(opts.tabs ?? {}),
    httpTest(opts.http ?? {}),
    identityTest(),
  )
}

describe('handlePorterMessage', () => {
  describe('porter/detect', () => {
    it.effect('a YouTube playlist URL is ok:true with a capturable label', () =>
      Effect.gen(function* () {
        const reply = yield* handlePorterMessage({
          type: 'porter/detect',
          url: 'https://www.youtube.com/playlist?list=PL123',
        }).pipe(Effect.provide(testLayer()))
        assert.deepStrictEqual(reply, { ok: true, capturable: 'Capture this playlist' })
      }),
    )

    it.effect('a non-capturable URL is ok:true with no capturable field', () =>
      Effect.gen(function* () {
        const reply = yield* handlePorterMessage({
          type: 'porter/detect',
          url: 'https://example.com',
        }).pipe(Effect.provide(testLayer()))
        assert.deepStrictEqual(reply, { ok: true })
      }),
    )
  })

  it.effect('porter/list-docs returns docs sorted by capturedAt desc', () =>
    Effect.gen(function* () {
      const docA = makeDoc({ id: 'a', capturedAt: '2026-01-01T00:00:00.000Z' })
      const docB = makeDoc({ id: 'b', capturedAt: '2026-02-01T00:00:00.000Z' })
      const reply = yield* handlePorterMessage({ type: 'porter/list-docs' }).pipe(
        Effect.provide(testLayer({ kv: { 'porter/docs': [docA, docB] } })),
      )
      assert.deepStrictEqual(reply, { ok: true, docs: [docB, docA] })
    }),
  )

  it.effect('porter/get-settings on empty Kv returns DEFAULT_SETTINGS', () =>
    Effect.gen(function* () {
      const reply = yield* handlePorterMessage({ type: 'porter/get-settings' }).pipe(
        Effect.provide(testLayer()),
      )
      assert.deepStrictEqual(reply, { ok: true, settings: DEFAULT_SETTINGS })
    }),
  )

  it.effect('porter/update-settings round-trips a patch into Kv', () =>
    Effect.gen(function* () {
      const layer = testLayer()
      const updated = yield* handlePorterMessage({
        type: 'porter/update-settings',
        patch: { nblmAuthuser: 2 },
      }).pipe(Effect.provide(layer))
      const expected = { ...DEFAULT_SETTINGS, nblmAuthuser: 2 }
      assert.deepStrictEqual(updated, { ok: true, settings: expected })

      const reread = yield* handlePorterMessage({ type: 'porter/get-settings' }).pipe(
        Effect.provide(layer),
      )
      assert.deepStrictEqual(reread, { ok: true, settings: expected })
    }),
  )

  it.effect('porter/delete-doc removes only the target doc', () =>
    Effect.gen(function* () {
      const docA = makeDoc({ id: 'a', capturedAt: '2026-01-01T00:00:00.000Z' })
      const docB = makeDoc({ id: 'b', capturedAt: '2026-02-01T00:00:00.000Z' })
      const layer = testLayer({ kv: { 'porter/docs': [docA, docB] } })
      const reply = yield* handlePorterMessage({ type: 'porter/delete-doc', docId: 'a' }).pipe(
        Effect.provide(layer),
      )
      assert.deepStrictEqual(reply, { ok: true })

      const after = yield* handlePorterMessage({ type: 'porter/list-docs' }).pipe(
        Effect.provide(layer),
      )
      assert.deepStrictEqual(after, { ok: true, docs: [docB] })
    }),
  )

  describe('porter/capture-page', () => {
    it.effect("surfaces the content script's ok:false reply verbatim", () =>
      Effect.gen(function* () {
        const layer = testLayer({
          tabs: {
            onSendMessage: () => ({ ok: false, error: 'X extraction not implemented yet' }),
          },
        })
        const reply = yield* handlePorterMessage({ type: 'porter/capture-page', tabId: 1 }).pipe(
          Effect.provide(layer),
        )
        assert.deepStrictEqual(reply, { ok: false, error: 'X extraction not implemented yet' })
      }),
    )

    it.effect('a malformed content-script reply becomes the malformed-response error', () =>
      Effect.gen(function* () {
        const layer = testLayer({ tabs: { onSendMessage: () => 'garbage' } })
        const reply = yield* handlePorterMessage({ type: 'porter/capture-page', tabId: 1 }).pipe(
          Effect.provide(layer),
        )
        assert.deepStrictEqual(reply, { ok: false, error: 'Malformed content-script response' })
      }),
    )
  })

  describe('porter/capture-url (contentScript adapter)', () => {
    it.effect('relays extract-thread to the tab for an X status URL and stores the doc', () =>
      Effect.gen(function* () {
        const capture = {
          kind: 'thread' as const,
          thread: {
            site: 'x' as const,
            url: 'https://x.com/user/status/123',
            title: 'A thread',
            author: { name: 'User' },
            posts: [{ id: '123', author: { name: 'User' }, depth: 0, text: 'hello', byOp: true }],
          },
        }
        let relayed: { tabId: number; msg: unknown } | undefined
        const layer = testLayer({
          tabs: {
            onSendMessage: (tabId, msg) => {
              relayed = { tabId, msg }
              return { ok: true, capture }
            },
          },
        })
        const reply = yield* handlePorterMessage({
          type: 'porter/capture-url',
          url: 'https://x.com/user/status/123',
          tabId: 7,
        }).pipe(Effect.provide(layer))

        assert.deepStrictEqual(relayed, { tabId: 7, msg: { type: 'porter/extract-thread' } })
        assert.isTrue(reply.ok)
        if (!reply.ok || !('docs' in reply)) return
        assert.strictEqual(reply.docs.length, 1)
        assert.strictEqual(reply.docs[0]?.canonicalUrl, 'https://x.com/user/status/123')

        const after = yield* handlePorterMessage({ type: 'porter/list-docs' }).pipe(
          Effect.provide(layer),
        )
        assert.deepStrictEqual(after, { ok: true, docs: reply.docs })
      }),
    )
  })

  describe('porter/create-notebook', () => {
    const HOME_HTML = '"SNlM0e":"csrf-token-1"...."FdrFJe":"fsid-1"'
    const createUrl = buildRpcUrl({
      rpcId: RPC_IDS.createNotebook,
      authuser: 0,
      fSid: 'fsid-1',
      sourcePath: '/',
    })
    const listUrl = buildRpcUrl({
      rpcId: RPC_IDS.listNotebooks,
      authuser: 0,
      fSid: 'fsid-1',
      sourcePath: '/',
    })

    it.effect(
      'locates the created notebook in the re-list by the id parsed from the create reply',
      () =>
        Effect.gen(function* () {
          const layer = testLayer({
            http: {
              [homeUrl(0)]: HOME_HTML,
              [createUrl]: rpcResponse(RPC_IDS.createNotebook, ['New Notebook', null, 'nb-2']),
              [listUrl]: rpcResponse(RPC_IDS.listNotebooks, [
                [
                  ['nb-1', null, 'nb-1'],
                  ['New Notebook', null, 'nb-2'],
                ],
              ]),
            },
          })
          const reply = yield* handlePorterMessage({
            type: 'porter/create-notebook',
            title: 'New Notebook',
          }).pipe(Effect.provide(layer))
          assert.deepStrictEqual(reply, {
            ok: true,
            notebooks: [
              { id: 'nb-1', title: 'nb-1' },
              { id: 'nb-2', title: 'New Notebook' },
            ],
            created: { id: 'nb-2', title: 'New Notebook' },
          })
        }),
    )

    it.effect('falls back to matching by title when the create reply has no parseable id', () =>
      Effect.gen(function* () {
        const layer = testLayer({
          http: {
            [homeUrl(0)]: HOME_HTML,
            [createUrl]: rpcResponse(RPC_IDS.createNotebook, null),
            [listUrl]: rpcResponse(RPC_IDS.listNotebooks, [[['New Notebook', null, 'nb-3']]]),
          },
        })
        const reply = yield* handlePorterMessage({
          type: 'porter/create-notebook',
          title: 'New Notebook',
        }).pipe(Effect.provide(layer))
        assert.deepStrictEqual(reply, {
          ok: true,
          notebooks: [{ id: 'nb-3', title: 'New Notebook' }],
          created: { id: 'nb-3', title: 'New Notebook' },
        })
      }),
    )

    it.effect('surfaces protocol-drift when the created notebook cannot be located at all', () =>
      Effect.gen(function* () {
        const layer = testLayer({
          http: {
            [homeUrl(0)]: HOME_HTML,
            [createUrl]: rpcResponse(RPC_IDS.createNotebook, null),
            [listUrl]: rpcResponse(RPC_IDS.listNotebooks, [[['Unrelated', null, 'nb-9']]]),
          },
        })
        const reply = yield* handlePorterMessage({
          type: 'porter/create-notebook',
          title: 'New Notebook',
        }).pipe(Effect.provide(layer))
        assert.strictEqual(reply.ok, false)
        if (reply.ok) return
        assert.match(reply.error, /protocol changed \(drift\)/)
      }),
    )
  })

  describe('porter/debug-log and porter/debug-clear', () => {
    it.effect('porter/debug-log returns entries from the DebugLog sink', () =>
      Effect.gen(function* () {
        const sink: DebugEntry[] = [{ t: 't1', scope: 'bg', msg: 'hello' }]
        const reply = yield* handlePorterMessage({ type: 'porter/debug-log' }).pipe(
          Effect.provide(testLayer({ debugSink: sink })),
        )
        assert.deepStrictEqual(reply, { ok: true, debugLog: sink })
      }),
    )

    it.effect('porter/debug-clear empties the DebugLog sink', () =>
      Effect.gen(function* () {
        const sink: DebugEntry[] = [{ t: 't1', scope: 'bg', msg: 'hello' }]
        const reply = yield* handlePorterMessage({ type: 'porter/debug-clear' }).pipe(
          Effect.provide(testLayer({ debugSink: sink })),
        )
        assert.deepStrictEqual(reply, { ok: true })
        assert.deepStrictEqual(sink, [])
      }),
    )
  })

  it.effect('flattens NotLoggedIn into the same friendly string background.ts produces today', () =>
    Effect.gen(function* () {
      const layer = testLayer({ http: { [homeUrl(0)]: '<html>signed out</html>' } })
      const reply = yield* handlePorterMessage({ type: 'porter/list-notebooks' }).pipe(
        Effect.provide(layer),
      )
      assert.deepStrictEqual(reply, {
        ok: false,
        error: 'Not signed in to notebooklm.google.com for account 0 — open it and sign in',
      })
    }),
  )
})
