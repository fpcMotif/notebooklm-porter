import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import type { DebugEntry } from './debug'
import {
  alarmsTest,
  debugLogTest,
  httpTest,
  identityTest,
  kvTest,
  type RecordedHttpRequest,
  tabsTest,
} from './fx/testing'
import { buildRpcUrl, createNotebookParams, homeUrl, RPC_IDS } from './ingest/rpc/protocol'
import type { SourceDoc } from './model/types'
import { domainsForMessage, handlePorterMessage, MESSAGE_DOMAINS } from './router'
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

const TARGET_SESSION_HTML =
  '"SNlM0e":"csrf-token-1"...."FdrFJe":"fsid-1"...."oPEP7c":"f@example.com"'
const TARGET_LIST_URL = buildRpcUrl({
  rpcId: RPC_IDS.listNotebooks,
  authuser: 0,
  fSid: 'fsid-1',
  sourcePath: '/',
})

function targetHttp(notebookId = 'nb-1'): Record<string, string> {
  return {
    [homeUrl(0)]: TARGET_SESSION_HTML,
    [TARGET_LIST_URL]: rpcResponse(RPC_IDS.listNotebooks, [[['Target', null, notebookId]]]),
  }
}

/** A GET_NOTEBOOK web-source entry: [[id], title, metadata, [null, statusCode]]. */
function webEntry(id: string, url: string, statusCode: number): unknown[] {
  return [[id], id, [null, null, [100], null, 5, null, null, [url]], [null, statusCode]]
}
function ytEntry(id: string, url: string, statusCode: number): unknown[] {
  return [[id], id, [null, null, null, null, 9, [url]], [null, statusCode]]
}
function notebookWithSources(entries: unknown[]): unknown {
  return [['meta', entries]]
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
    alarms?: Parameters<typeof alarmsTest>[0]
    http?: Record<string, string | string[]>
    httpRequests?: RecordedHttpRequest[]
  } = {},
) {
  return Layer.mergeAll(
    kvTest(opts.kv ?? {}),
    debugLogTest(opts.debugSink ?? []),
    tabsTest(opts.tabs ?? {}),
    alarmsTest(opts.alarms),
    httpTest(opts.http ?? {}, opts.httpRequests ?? []),
    identityTest(),
  )
}

describe('handlePorterMessage', () => {
  describe('porter/detect', () => {
    it.effect('a YouTube playlist URL offers transcript enrichment with its capturable label', () =>
      Effect.gen(function* () {
        const reply = yield* handlePorterMessage({
          type: 'porter/detect',
          url: 'https://www.youtube.com/playlist?list=PL123',
        }).pipe(Effect.provide(testLayer()))
        assert.deepStrictEqual(reply, {
          ok: true,
          capturable: 'Capture this playlist',
          canEnrichTranscripts: true,
        })
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

  describe('porter/list-notebooks cache', () => {
    it.effect('uses a matching-email cache only after a fresh session check', () =>
      Effect.gen(function* () {
        const requests: RecordedHttpRequest[] = []
        const layer = testLayer({
          kv: {
            'porter/notebooks-cache/v1': {
              version: 1,
              entries: {
                0: {
                  email: 'f@example.com',
                  notebooks: [{ id: 'cached', title: 'Cached notebook' }],
                  refreshedAt: '2026-07-11T00:00:00.000Z',
                },
              },
            },
          },
          http: { [homeUrl(0)]: TARGET_SESSION_HTML },
          httpRequests: requests,
        })

        const reply = yield* handlePorterMessage({ type: 'porter/list-notebooks' }).pipe(
          Effect.provide(layer),
        )

        assert.deepStrictEqual(reply, {
          ok: true,
          notebooks: [{ id: 'cached', title: 'Cached notebook' }],
        })
        assert.deepStrictEqual(
          requests.map((request) => request.url),
          [homeUrl(0)],
        )
      }),
    )

    it.effect('refreshes and replaces cache when forced or when the authuser email changed', () =>
      Effect.gen(function* () {
        const requests: RecordedHttpRequest[] = []
        const layer = testLayer({
          kv: {
            'porter/notebooks-cache/v1': {
              version: 1,
              entries: {
                0: {
                  email: 'former@example.com',
                  notebooks: [{ id: 'old', title: 'Old notebook' }],
                  refreshedAt: '2026-07-11T00:00:00.000Z',
                },
              },
            },
          },
          http: targetHttp('fresh'),
          httpRequests: requests,
        })

        const mismatch = yield* handlePorterMessage({ type: 'porter/list-notebooks' }).pipe(
          Effect.provide(layer),
        )
        const forced = yield* handlePorterMessage({
          type: 'porter/list-notebooks',
          forceRefresh: true,
        }).pipe(Effect.provide(layer))
        const cachedAgain = yield* handlePorterMessage({ type: 'porter/list-notebooks' }).pipe(
          Effect.provide(layer),
        )

        assert.deepStrictEqual(mismatch, {
          ok: true,
          notebooks: [{ id: 'fresh', title: 'Target' }],
        })
        assert.deepStrictEqual(forced, { ok: true, notebooks: [{ id: 'fresh', title: 'Target' }] })
        assert.deepStrictEqual(cachedAgain, forced)
        assert.strictEqual(requests.filter((request) => request.url === TARGET_LIST_URL).length, 2)
      }),
    )
  })

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

  describe('porter/capture-url (content-script adapter)', () => {
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
        assert.include(reply.docs[0]?.markdown ?? '', 'hello')

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
          const httpRequests: RecordedHttpRequest[] = []
          const layer = testLayer({
            http: {
              [homeUrl(0)]: HOME_HTML,
              [createUrl]: rpcResponse(RPC_IDS.createNotebook, ['New Notebook', null, 'nb-2']),
              [listUrl]: [
                rpcResponse(RPC_IDS.listNotebooks, [[['nb-1', null, 'nb-1']]]),
                rpcResponse(RPC_IDS.listNotebooks, [
                  [
                    ['nb-1', null, 'nb-1'],
                    ['New Notebook', null, 'nb-2'],
                  ],
                ]),
              ],
            },
            httpRequests,
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

          // The create RPC's f.req envelope must carry the exact params shape,
          // not just embed the title somewhere in the encoded body.
          const createRequest = httpRequests.find((req) => req.url === createUrl)
          assert.isDefined(createRequest)
          const fReq = new URLSearchParams(createRequest?.body ?? '').get('f.req')
          assert.isNotNull(fReq)
          const frame = JSON.parse(fReq ?? '[]')[0]?.[0]
          assert.strictEqual(frame?.[0], RPC_IDS.createNotebook)
          assert.deepStrictEqual(
            JSON.parse(frame?.[1] ?? 'null'),
            createNotebookParams('New Notebook'),
          )
        }),
    )

    it.effect('replaces the active account cache from the successful post-create re-list', () =>
      Effect.gen(function* () {
        const httpRequests: RecordedHttpRequest[] = []
        const layer = testLayer({
          http: {
            [homeUrl(0)]: `${HOME_HTML}...."oPEP7c":"f@example.com"`,
            [createUrl]: rpcResponse(RPC_IDS.createNotebook, ['New Notebook', null, 'nb-2']),
            [listUrl]: [
              rpcResponse(RPC_IDS.listNotebooks, [[['Existing', null, 'nb-1']]]),
              rpcResponse(RPC_IDS.listNotebooks, [
                [
                  ['Existing', null, 'nb-1'],
                  ['New Notebook', null, 'nb-2'],
                ],
              ]),
            ],
          },
          httpRequests,
        })

        yield* handlePorterMessage({ type: 'porter/create-notebook', title: 'New Notebook' }).pipe(
          Effect.provide(layer),
        )
        const cached = yield* handlePorterMessage({ type: 'porter/list-notebooks' }).pipe(
          Effect.provide(layer),
        )

        assert.deepStrictEqual(cached, {
          ok: true,
          notebooks: [
            { id: 'nb-1', title: 'Existing' },
            { id: 'nb-2', title: 'New Notebook' },
          ],
        })
        assert.strictEqual(httpRequests.filter((request) => request.url === listUrl).length, 2)
      }),
    )

    it.effect('falls back to matching by title when the create reply has no parseable id', () =>
      Effect.gen(function* () {
        const layer = testLayer({
          http: {
            [homeUrl(0)]: HOME_HTML,
            [createUrl]: rpcResponse(RPC_IDS.createNotebook, null),
            [listUrl]: [
              rpcResponse(RPC_IDS.listNotebooks, [[['Existing', null, 'nb-1']]]),
              rpcResponse(RPC_IDS.listNotebooks, [
                [
                  ['Existing', null, 'nb-1'],
                  ['New Notebook', null, 'nb-3'],
                ],
              ]),
            ],
          },
        })
        const reply = yield* handlePorterMessage({
          type: 'porter/create-notebook',
          title: 'New Notebook',
        }).pipe(Effect.provide(layer))
        assert.deepStrictEqual(reply, {
          ok: true,
          notebooks: [
            { id: 'nb-1', title: 'Existing' },
            { id: 'nb-3', title: 'New Notebook' },
          ],
          created: { id: 'nb-3', title: 'New Notebook' },
        })
      }),
    )

    it.effect(
      'resolves an ambiguous title to the newly created notebook, not the pre-existing one with the same title',
      () =>
        Effect.gen(function* () {
          const layer = testLayer({
            http: {
              [homeUrl(0)]: HOME_HTML,
              [createUrl]: rpcResponse(RPC_IDS.createNotebook, null),
              [listUrl]: [
                rpcResponse(RPC_IDS.listNotebooks, [[['Notes', null, 'nb-old']]]),
                rpcResponse(RPC_IDS.listNotebooks, [
                  [
                    ['Notes', null, 'nb-old'],
                    ['Notes', null, 'nb-new'],
                  ],
                ]),
              ],
            },
          })
          const reply = yield* handlePorterMessage({
            type: 'porter/create-notebook',
            title: 'Notes',
          }).pipe(Effect.provide(layer))
          assert.deepStrictEqual(reply, {
            ok: true,
            notebooks: [
              { id: 'nb-old', title: 'Notes' },
              { id: 'nb-new', title: 'Notes' },
            ],
            created: { id: 'nb-new', title: 'Notes' },
          })
        }),
    )

    it.effect(
      'ignores a parsed id that collides with a pre-existing notebook and picks the genuinely new one',
      () =>
        Effect.gen(function* () {
          const layer = testLayer({
            http: {
              [homeUrl(0)]: HOME_HTML,
              // Ack-style reply echoing a PRE-existing notebook's id as the hint.
              [createUrl]: rpcResponse(RPC_IDS.createNotebook, ['Notes', null, 'nb-old']),
              [listUrl]: [
                rpcResponse(RPC_IDS.listNotebooks, [[['Notes', null, 'nb-old']]]),
                rpcResponse(RPC_IDS.listNotebooks, [
                  [
                    ['Notes', null, 'nb-old'],
                    ['Notes', null, 'nb-new'],
                  ],
                ]),
              ],
            },
          })
          const reply = yield* handlePorterMessage({
            type: 'porter/create-notebook',
            title: 'Notes',
          }).pipe(Effect.provide(layer))
          assert.deepStrictEqual(reply, {
            ok: true,
            notebooks: [
              { id: 'nb-old', title: 'Notes' },
              { id: 'nb-new', title: 'Notes' },
            ],
            created: { id: 'nb-new', title: 'Notes' },
          })
        }),
    )

    // Real timers: the handler sleeps between re-list retries, and
    // it.effect's virtual TestClock never auto-advances, so it would hang.
    it.live(
      'retries the re-list when it initially still reflects the pre-create state (read-after-write lag)',
      () =>
        Effect.gen(function* () {
          const layer = testLayer({
            http: {
              [homeUrl(0)]: HOME_HTML,
              [createUrl]: rpcResponse(RPC_IDS.createNotebook, null),
              [listUrl]: [
                rpcResponse(RPC_IDS.listNotebooks, [[['Existing', null, 'nb-1']]]),
                rpcResponse(RPC_IDS.listNotebooks, [[['Existing', null, 'nb-1']]]),
                rpcResponse(RPC_IDS.listNotebooks, [
                  [
                    ['Existing', null, 'nb-1'],
                    ['New Notebook', null, 'nb-2'],
                  ],
                ]),
              ],
            },
          })
          const reply = yield* handlePorterMessage({
            type: 'porter/create-notebook',
            title: 'New Notebook',
          }).pipe(Effect.provide(layer))
          assert.deepStrictEqual(reply, {
            ok: true,
            notebooks: [
              { id: 'nb-1', title: 'Existing' },
              { id: 'nb-2', title: 'New Notebook' },
            ],
            created: { id: 'nb-2', title: 'New Notebook' },
          })
        }),
    )

    // Real timers: same reason — exhausts both retries before failing.
    it.live('surfaces protocol-drift when the created notebook cannot be located at all', () =>
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

  describe('source console', () => {
    const CONSOLE_SETTINGS = {
      ...DEFAULT_SETTINGS,
      accounts: [{ authuser: 0, email: 'f@example.com' }],
    }
    const getUrl = buildRpcUrl({
      rpcId: RPC_IDS.getNotebook,
      authuser: 0,
      fSid: 'fsid-1',
      sourcePath: '/notebook/nb-1',
    })
    const deleteUrl = buildRpcUrl({
      rpcId: RPC_IDS.deleteSource,
      authuser: 0,
      fSid: 'fsid-1',
      sourcePath: '/notebook/nb-1',
    })
    const refreshUrl = buildRpcUrl({
      rpcId: RPC_IDS.refreshSource,
      authuser: 0,
      fSid: 'fsid-1',
      sourcePath: '/notebook/nb-1',
    })

    it.effect('scans a notebook into sources, duplicate groups, and failed diagnoses', () =>
      Effect.gen(function* () {
        const layer = testLayer({
          kv: { 'porter/settings': CONSOLE_SETTINGS },
          http: {
            [homeUrl(0)]: TARGET_SESSION_HTML,
            [getUrl]: rpcResponse(
              RPC_IDS.getNotebook,
              notebookWithSources([
                webEntry('a', 'https://ex.com/a', 2),
                webEntry('b', 'https://ex.com/a', 2),
                ytEntry('bad', 'https://youtu.be/zzz', 3),
              ]),
            ),
          },
        })
        const reply = yield* handlePorterMessage({
          type: 'porter/nblm-scan-console',
          notebookId: 'nb-1',
        }).pipe(Effect.provide(layer))
        assert.isTrue(reply.ok)
        if (!reply.ok || !('scan' in reply)) return
        assert.strictEqual(reply.scan.sources.length, 3)
        assert.strictEqual(reply.scan.duplicateCount, 1)
        assert.deepStrictEqual(
          reply.scan.duplicateGroups[0]?.remove.map((s) => s.id),
          ['b'],
        )
        assert.strictEqual(reply.scan.failed[0]?.source.id, 'bad')
        assert.strictEqual(reply.scan.failed[0]?.retry, 'refresh')
      }),
    )

    it.effect('auto-removes duplicate sources, then re-scans a clean notebook', () =>
      Effect.gen(function* () {
        const httpRequests: RecordedHttpRequest[] = []
        const layer = testLayer({
          kv: { 'porter/settings': CONSOLE_SETTINGS },
          http: {
            [homeUrl(0)]: TARGET_SESSION_HTML,
            [getUrl]: [
              rpcResponse(
                RPC_IDS.getNotebook,
                notebookWithSources([
                  webEntry('a', 'https://ex.com/a', 2),
                  webEntry('b', 'https://ex.com/a', 2),
                ]),
              ),
              rpcResponse(
                RPC_IDS.getNotebook,
                notebookWithSources([webEntry('a', 'https://ex.com/a', 2)]),
              ),
            ],
            [deleteUrl]: rpcResponse(RPC_IDS.deleteSource, null),
          },
          httpRequests,
        })
        const reply = yield* handlePorterMessage({
          type: 'porter/nblm-dedupe',
          notebookId: 'nb-1',
        }).pipe(Effect.provide(layer))
        assert.isTrue(reply.ok)
        if (!reply.ok || !('removedIds' in reply)) return
        assert.deepStrictEqual(reply.removedIds, ['b'])
        assert.strictEqual(reply.scan.duplicateCount, 0)
        assert.strictEqual(reply.scan.sources.length, 1)

        // The delete carried the removed source id in its f.req envelope.
        const del = httpRequests.find((req) => req.url === deleteUrl)
        const fReq = new URLSearchParams(del?.body ?? '').get('f.req')
        const frame = JSON.parse(fReq ?? '[]')[0]?.[0]
        assert.strictEqual(frame?.[0], RPC_IDS.deleteSource)
        assert.deepStrictEqual(JSON.parse(frame?.[1] ?? 'null'), [[['b']]])
      }),
    )

    it.effect('retries one failed source and returns the re-scanned notebook', () =>
      Effect.gen(function* () {
        const httpRequests: RecordedHttpRequest[] = []
        const layer = testLayer({
          kv: { 'porter/settings': CONSOLE_SETTINGS },
          http: {
            [homeUrl(0)]: TARGET_SESSION_HTML,
            [refreshUrl]: rpcResponse(RPC_IDS.refreshSource, null),
            [getUrl]: rpcResponse(
              RPC_IDS.getNotebook,
              notebookWithSources([ytEntry('bad', 'https://youtu.be/zzz', 1)]),
            ),
          },
          httpRequests,
        })
        const reply = yield* handlePorterMessage({
          type: 'porter/nblm-retry-source',
          notebookId: 'nb-1',
          sourceId: 'bad',
        }).pipe(Effect.provide(layer))
        assert.isTrue(reply.ok)
        if (!reply.ok || !('scan' in reply)) return
        assert.strictEqual(reply.scan.sources[0]?.status, 'processing')

        const refresh = httpRequests.find((req) => req.url === refreshUrl)
        const fReq = new URLSearchParams(refresh?.body ?? '').get('f.req')
        const frame = JSON.parse(fReq ?? '[]')[0]?.[0]
        assert.deepStrictEqual(JSON.parse(frame?.[1] ?? 'null'), [null, ['bad'], [2]])
      }),
    )

    it.effect('surfaces NotLoggedIn when the signed-in email does not match the account', () =>
      Effect.gen(function* () {
        const layer = testLayer({
          kv: { 'porter/settings': CONSOLE_SETTINGS },
          http: { [homeUrl(0)]: '"SNlM0e":"csrf-token-1"...."oPEP7c":"other@example.com"' },
        })
        const reply = yield* handlePorterMessage({
          type: 'porter/nblm-scan-console',
          notebookId: 'nb-1',
        }).pipe(Effect.provide(layer))
        assert.strictEqual(reply.ok, false)
      }),
    )
  })

  describe('queue messages', () => {
    it.effect('queues planned units under the active account and arms the durable alarm', () =>
      Effect.gen(function* () {
        const doc = makeDoc({ id: 'reddit:queued', capturedAt: '2026-07-11T00:00:00.000Z' })
        const scheduled: Array<{ name: string; when: number }> = []
        const layer = testLayer({
          kv: {
            'porter/docs': [doc],
            'porter/settings': {
              ...DEFAULT_SETTINGS,
              accounts: [{ authuser: 0, email: 'f@example.com' }],
            },
          },
          http: targetHttp(),
          alarms: { onSchedule: (name, when) => scheduled.push({ name, when }) },
        })

        const reply = yield* handlePorterMessage({
          type: 'porter/queue-enqueue',
          docIds: [doc.id],
          notebookId: 'nb-1',
        }).pipe(Effect.provide(layer))
        assert.isTrue(reply.ok)
        if (!reply.ok || !('queue' in reply)) return
        assert.deepStrictEqual(
          reply.queue.jobs.map((job) => [job.unitId, job.status]),
          [['reddit:queued', 'queued']],
        )
        assert.strictEqual(scheduled[0]?.name, 'porter/ingest-queue')

        const status = yield* handlePorterMessage({ type: 'porter/queue-status' }).pipe(
          Effect.provide(layer),
        )
        assert.deepStrictEqual(status, reply)
      }),
    )

    it.effect('refuses a notebook id that is absent from the fresh account listing', () =>
      Effect.gen(function* () {
        const doc = makeDoc({ id: 'reddit:queued', capturedAt: '2026-07-11T00:00:00.000Z' })
        const layer = testLayer({
          kv: {
            'porter/docs': [doc],
            'porter/settings': {
              ...DEFAULT_SETTINGS,
              accounts: [{ authuser: 0, email: 'f@example.com' }],
            },
          },
          http: targetHttp('nb-allowed'),
        })

        const reply = yield* handlePorterMessage({
          type: 'porter/queue-enqueue',
          docIds: [doc.id],
          notebookId: 'nb-not-allowed',
        }).pipe(Effect.provide(layer))

        assert.deepStrictEqual(reply, {
          ok: false,
          error: 'Choose a notebook from the current account',
        })
      }),
    )
  })

  describe('watch messages', () => {
    it.effect('creates, lists, and removes a background-capturable source watch', () =>
      Effect.gen(function* () {
        const doc = makeDoc({
          id: 'hackernews:42',
          site: 'hackernews',
          canonicalUrl: 'https://news.ycombinator.com/item?id=42',
          capturedAt: '2026-07-11T00:00:00.000Z',
        })
        const scheduled: Array<{ name: string; when: number }> = []
        const layer = testLayer({
          kv: {
            'porter/docs': [doc],
            'porter/settings': {
              ...DEFAULT_SETTINGS,
              accounts: [{ authuser: 0, email: 'f@example.com' }],
            },
          },
          http: targetHttp(),
          alarms: { onSchedule: (name, when) => scheduled.push({ name, when }) },
        })

        const created = yield* handlePorterMessage({
          type: 'porter/watch-create',
          docId: doc.id,
          notebookId: 'nb-1',
        }).pipe(Effect.provide(layer))
        assert.isTrue(created.ok)
        if (!created.ok || !('watches' in created)) return
        assert.strictEqual(created.watches.length, 1)
        assert.strictEqual(created.watches[0]?.sourceDocId, doc.id)
        assert.strictEqual(scheduled[0]?.name, 'porter/watch-resync')

        const listed = yield* handlePorterMessage({ type: 'porter/watch-list' }).pipe(
          Effect.provide(layer),
        )
        assert.deepStrictEqual(listed, created)

        const watchId = created.watches[0]?.id
        if (watchId === undefined) return
        const removed = yield* handlePorterMessage({
          type: 'porter/watch-remove',
          watchId,
        }).pipe(Effect.provide(layer))
        assert.deepStrictEqual(removed, { ok: true, watches: [] })
      }),
    )

    it.effect('rejects an X watch instead of pretending a background recapture exists', () =>
      Effect.gen(function* () {
        const doc = makeDoc({
          id: 'x:42',
          site: 'x',
          canonicalUrl: 'https://x.com/porter/status/42',
          capturedAt: '2026-07-11T00:00:00.000Z',
        })
        const layer = testLayer({
          kv: {
            'porter/docs': [doc],
            'porter/settings': {
              ...DEFAULT_SETTINGS,
              accounts: [{ authuser: 0, email: 'f@example.com' }],
            },
          },
          http: targetHttp(),
        })

        const reply = yield* handlePorterMessage({
          type: 'porter/watch-create',
          docId: doc.id,
          notebookId: 'nb-1',
        }).pipe(Effect.provide(layer))

        assert.deepStrictEqual(reply, {
          ok: false,
          error: 'This source cannot be resynced in the background yet',
        })
      }),
    )

    it.effect('removes watches when its captured source is deleted', () =>
      Effect.gen(function* () {
        const doc = makeDoc({
          id: 'hackernews:42',
          site: 'hackernews',
          canonicalUrl: 'https://news.ycombinator.com/item?id=42',
          capturedAt: '2026-07-11T00:00:00.000Z',
        })
        const layer = testLayer({
          kv: {
            'porter/docs': [doc],
            'porter/settings': {
              ...DEFAULT_SETTINGS,
              accounts: [{ authuser: 0, email: 'f@example.com' }],
            },
          },
          http: targetHttp(),
        })
        const created = yield* handlePorterMessage({
          type: 'porter/watch-create',
          docId: doc.id,
          notebookId: 'nb-1',
        }).pipe(Effect.provide(layer))
        assert.isTrue(created.ok)

        const deleted = yield* handlePorterMessage({
          type: 'porter/delete-doc',
          docId: doc.id,
        }).pipe(Effect.provide(layer))
        assert.deepStrictEqual(deleted, { ok: true })
        const watches = yield* handlePorterMessage({ type: 'porter/watch-list' }).pipe(
          Effect.provide(layer),
        )
        assert.deepStrictEqual(watches, { ok: true, watches: [] })
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

describe('domainsForMessage / MESSAGE_DOMAINS', () => {
  it('orders a multi-domain entry by LANE_ORDER regardless of authoring order', () => {
    assert.deepStrictEqual(domainsForMessage('porter/queue-enqueue'), ['queue', 'settings'])
  })

  it('preserves the pre-existing docs+watches lane pairing for delete-doc', () => {
    assert.deepStrictEqual(domainsForMessage('porter/delete-doc'), ['docs', 'watches'])
  })

  it('returns [] for an unknown wire type', () => {
    assert.deepStrictEqual(domainsForMessage('porter/nonsense'), [])
  })

  it('is exhaustive over every PorterMessage variant', () => {
    // Canonical list of PorterMessage['type'] values, mirrored from messaging.ts.
    // MESSAGE_DOMAINS' mapped type already forces this 1:1 at compile time —
    // this is the runtime smoke check that nobody silently deleted an entry.
    const messageTypes = [
      'porter/detect',
      'porter/capture-url',
      'porter/capture-page',
      'porter/capture-result',
      'porter/list-docs',
      'porter/delete-doc',
      'porter/export',
      'porter/queue-enqueue',
      'porter/queue-status',
      'porter/queue-retry',
      'porter/watch-create',
      'porter/watch-list',
      'porter/watch-remove',
      'porter/list-notebooks',
      'porter/create-notebook',
      'porter/nblm-scan-console',
      'porter/nblm-dedupe',
      'porter/nblm-retry-source',
      'porter/accounts-refresh',
      'porter/get-settings',
      'porter/update-settings',
      'porter/backup-drive',
      'porter/debug-log',
      'porter/debug-clear',
    ]
    assert.strictEqual(Object.keys(MESSAGE_DOMAINS).length, messageTypes.length)
    assert.deepStrictEqual(Object.keys(MESSAGE_DOMAINS).toSorted(), messageTypes.toSorted())
  })
})
