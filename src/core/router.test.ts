import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { vi } from 'vitest'
import { notebookTargetKey } from './accounts/ownership'
import type { DebugEntry } from './debug'
import { alarmsTest, debugLogTest, httpTest, identityTest, kvTest, tabsTest } from './fx/testing'
import { buildRpcUrl, homeUrl, RPC_IDS } from './ingest/rpc/protocol'
import {
  nblmSessionHtml,
  notebookWithSources,
  rpcResponse,
  youtubeSourceEntry,
} from './ingest/rpc/testing'
import type { ThreadSourceDoc, VideoSourceDoc } from './model/types'
import { domainsForMessage, handlePorterMessage, MESSAGE_DOMAINS } from './router'
import { DEFAULT_SETTINGS } from './settings'
import { LEDGER_STORAGE_KEY, loadLedger } from './store/ledger'

const TARGET_SESSION_HTML = nblmSessionHtml({ email: 'f@example.com' })
const ACCOUNT = { authuser: 0, accountEmail: 'f@example.com' } as const
const TARGET = { ...ACCOUNT, notebookId: 'nb-1' } as const
const TARGET_LIST_URL = buildRpcUrl({
  rpcId: RPC_IDS.listNotebooks,
  authuser: 0,
  fSid: 'fsid-1',
  sourcePath: '/',
})

function notebookGetUrl(notebookId = 'nb-1'): string {
  return buildRpcUrl({
    rpcId: RPC_IDS.getNotebook,
    authuser: 0,
    fSid: 'fsid-1',
    sourcePath: `/notebook/${notebookId}`,
  })
}

function targetHttp(notebookId = 'nb-1'): Record<string, string> {
  return {
    [homeUrl(0)]: TARGET_SESSION_HTML,
    [TARGET_LIST_URL]: rpcResponse(RPC_IDS.listNotebooks, [[['Target', null, notebookId]]]),
    // Empty live sources so enqueue's advisory reconciliation is a no-op by default.
    [notebookGetUrl(notebookId)]: rpcResponse(RPC_IDS.getNotebook, notebookWithSources([])),
  }
}

function makeDoc(
  overrides: Partial<ThreadSourceDoc> & Pick<ThreadSourceDoc, 'id' | 'capturedAt'>,
): ThreadSourceDoc {
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
    kv?: Parameters<typeof kvTest>[0]
    debugSink?: DebugEntry[]
    tabs?: Parameters<typeof tabsTest>[0]
    alarms?: Parameters<typeof alarmsTest>[0]
    http?: Record<string, string | string[]>
    requests?: Array<{ url: string; body?: string }>
  } = {},
) {
  return Layer.mergeAll(
    kvTest(opts.kv ?? {}),
    debugLogTest(opts.debugSink ?? []),
    tabsTest(opts.tabs ?? {}),
    alarmsTest(opts.alarms),
    httpTest(opts.http ?? {}, opts.requests),
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
      const docA = makeDoc({ id: 'reddit:a', capturedAt: '2026-01-01T00:00:00.000Z' })
      const docB = makeDoc({ id: 'reddit:b', capturedAt: '2026-02-01T00:00:00.000Z' })
      const reply = yield* handlePorterMessage({ type: 'porter/list-docs' }).pipe(
        Effect.provide(testLayer({ kv: { 'porter/docs': [docA, docB] } })),
      )
      assert.deepStrictEqual(reply, { ok: true, docs: [docB, docA] })
    }),
  )

  it.effect('porter/export-vault only downloads the requested docIds', () =>
    Effect.gen(function* () {
      const download = vi.spyOn(browser.downloads, 'download').mockResolvedValue(undefined)
      const docA = makeDoc({ id: 'reddit:a', capturedAt: '2026-01-01T00:00:00.000Z', title: 'A' })
      const docB = makeDoc({ id: 'reddit:b', capturedAt: '2026-02-01T00:00:00.000Z', title: 'B' })
      const reply = yield* handlePorterMessage({
        type: 'porter/export-vault',
        docIds: ['reddit:a'],
      }).pipe(Effect.provide(testLayer({ kv: { 'porter/docs': [docA, docB] } })))
      assert.deepStrictEqual(reply, { ok: true })
      assert.strictEqual(download.mock.calls.length, 1)
      assert.strictEqual(download.mock.calls[0]?.[0]?.filename, 'NotebookLM Porter/reddit/A.md')
      download.mockRestore()
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

  it.effect('porter/list-notebooks uses its account binding without mutable settings', () =>
    Effect.gen(function* () {
      const reply = yield* handlePorterMessage({
        type: 'porter/list-notebooks',
        account: ACCOUNT,
      }).pipe(
        Effect.provide(
          testLayer({
            kv: {
              'porter/settings': {
                ...DEFAULT_SETTINGS,
                nblmAuthuser: 1,
                accounts: [{ authuser: 1, email: 'other@example.com' }],
              },
            },
            http: targetHttp(),
          }),
        ),
      )

      assert.deepStrictEqual(reply, {
        ok: true,
        notebooks: [{ id: 'nb-1', title: 'Target' }],
      })
    }),
  )

  it.effect('porter/delete-doc removes only the target doc', () =>
    Effect.gen(function* () {
      const docA = makeDoc({ id: 'reddit:a', capturedAt: '2026-01-01T00:00:00.000Z' })
      const docB = makeDoc({ id: 'reddit:b', capturedAt: '2026-02-01T00:00:00.000Z' })
      const layer = testLayer({ kv: { 'porter/docs': [docA, docB] } })
      const reply = yield* handlePorterMessage({
        type: 'porter/delete-doc',
        docId: 'reddit:a',
      }).pipe(Effect.provide(layer))
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
    it.effect('rejects a same-host URL with nothing capturable before Http or Tabs', () =>
      Effect.gen(function* () {
        const requests: Array<{ url: string }> = []
        let tabMessages = 0
        const layer = testLayer({
          requests,
          tabs: {
            onSendMessage: () => {
              tabMessages += 1
              return { ok: true, capture: {} }
            },
          },
        })
        const reply = yield* handlePorterMessage({
          type: 'porter/capture-url',
          url: 'https://x.com/porter',
          tabId: 7,
        }).pipe(Effect.provide(layer))

        assert.deepStrictEqual(reply, { ok: false, error: 'Nothing capturable on this page' })
        assert.strictEqual(tabMessages, 0)
        assert.deepStrictEqual(requests, [])
      }),
    )

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

    it.effect('maps an invalid title to the exact catalog message', () =>
      Effect.gen(function* () {
        const reply = yield* handlePorterMessage({
          type: 'porter/create-notebook',
          account: ACCOUNT,
          title: '   ',
        }).pipe(Effect.provide(testLayer()))

        assert.deepStrictEqual(reply, { ok: false, error: 'Enter a notebook title' })
      }),
    )

    it.effect(
      'locates the created notebook in the re-list by the id parsed from the create reply',
      () =>
        Effect.gen(function* () {
          const layer = testLayer({
            http: {
              [homeUrl(0)]: TARGET_SESSION_HTML,
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
          })
          const reply = yield* handlePorterMessage({
            type: 'porter/create-notebook',
            account: ACCOUNT,
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
  })

  describe('source console', () => {
    const CONFLICTING_SETTINGS = {
      ...DEFAULT_SETTINGS,
      nblmAuthuser: 1,
      accounts: [{ authuser: 1, email: 'other@example.com' }],
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
          kv: { 'porter/settings': CONFLICTING_SETTINGS },
          http: {
            [homeUrl(0)]: TARGET_SESSION_HTML,
            [getUrl]: rpcResponse(
              RPC_IDS.getNotebook,
              notebookWithSources([
                youtubeSourceEntry('a', 'https://youtu.be/dQw4w9WgXcQ', 2),
                youtubeSourceEntry('b', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 2),
                youtubeSourceEntry('bad', 'https://youtu.be/M7lc1UVf-VE', 3),
              ]),
            ),
          },
        })
        const reply = yield* handlePorterMessage({
          type: 'porter/nblm-scan-console',
          target: TARGET,
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

    it.effect('maps duplicate removal to its scan and removed IDs reply', () =>
      Effect.gen(function* () {
        const layer = testLayer({
          kv: { 'porter/settings': CONFLICTING_SETTINGS },
          http: {
            [homeUrl(0)]: TARGET_SESSION_HTML,
            [getUrl]: [
              rpcResponse(
                RPC_IDS.getNotebook,
                notebookWithSources([
                  youtubeSourceEntry('a', 'https://youtu.be/dQw4w9WgXcQ', 2),
                  youtubeSourceEntry('b', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 2),
                ]),
              ),
              rpcResponse(
                RPC_IDS.getNotebook,
                notebookWithSources([youtubeSourceEntry('a', 'https://youtu.be/dQw4w9WgXcQ', 2)]),
              ),
            ],
            [deleteUrl]: rpcResponse(RPC_IDS.deleteSource, null),
          },
        })

        const reply = yield* handlePorterMessage({
          type: 'porter/nblm-dedupe',
          target: TARGET,
        }).pipe(Effect.provide(layer))

        assert.isTrue(reply.ok)
        if (!reply.ok || !('removedIds' in reply)) return
        assert.deepStrictEqual(reply.removedIds, ['b'])
        assert.strictEqual(reply.scan.duplicateCount, 0)
      }),
    )

    it.effect('maps source retry to its fresh scan reply', () =>
      Effect.gen(function* () {
        const layer = testLayer({
          kv: { 'porter/settings': CONFLICTING_SETTINGS },
          http: {
            [homeUrl(0)]: TARGET_SESSION_HTML,
            [refreshUrl]: rpcResponse(RPC_IDS.refreshSource, null),
            [getUrl]: [
              rpcResponse(
                RPC_IDS.getNotebook,
                notebookWithSources([youtubeSourceEntry('bad', 'https://youtu.be/zzz', 3)]),
              ),
              rpcResponse(
                RPC_IDS.getNotebook,
                notebookWithSources([youtubeSourceEntry('bad', 'https://youtu.be/zzz', 1)]),
              ),
            ],
          },
        })

        const reply = yield* handlePorterMessage({
          type: 'porter/nblm-retry-source',
          target: TARGET,
          sourceId: 'bad',
        }).pipe(Effect.provide(layer))

        assert.isTrue(reply.ok)
        if (!reply.ok || !('scan' in reply)) return
        assert.strictEqual(reply.scan.sources[0]?.status, 'processing')
      }),
    )

    it.effect('surfaces NotLoggedIn when the signed-in email does not match the account', () =>
      Effect.gen(function* () {
        const layer = testLayer({
          kv: { 'porter/settings': CONFLICTING_SETTINGS },
          http: { [homeUrl(0)]: '"SNlM0e":"csrf-token-1"...."oPEP7c":"other@example.com"' },
        })
        const reply = yield* handlePorterMessage({
          type: 'porter/nblm-scan-console',
          target: TARGET,
        }).pipe(Effect.provide(layer))
        assert.deepStrictEqual(reply, {
          ok: false,
          error: 'Not signed in to notebooklm.google.com for account 0 — open it and sign in',
        })
      }),
    )
  })

  describe('queue messages', () => {
    it.effect('queues planned units under the bound target and arms the durable alarm', () =>
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
          target: TARGET,
        }).pipe(Effect.provide(layer))
        assert.isTrue(reply.ok)
        if (!reply.ok || !('queue' in reply)) return
        assert.deepStrictEqual(
          reply.queue.jobs.map((job) => [job.unitId, job.status]),
          [['reddit:queued', 'queued']],
        )
        assert.strictEqual(scheduled[0]?.name, 'porter/ingest-queue')

        const settings = yield* handlePorterMessage({ type: 'porter/get-settings' }).pipe(
          Effect.provide(layer),
        )
        assert.isTrue(settings.ok)
        if (settings.ok && 'settings' in settings) {
          assert.strictEqual(settings.settings.notebookTargets.reddit, 'nb-1')
        }

        const status = yield* handlePorterMessage({ type: 'porter/queue-status' }).pipe(
          Effect.provide(layer),
        )
        assert.deepStrictEqual(status, reply)
      }),
    )

    it.effect('receipts server-present units at enqueue and excludes them from the queue', () =>
      Effect.gen(function* () {
        const doc: VideoSourceDoc = {
          id: 'youtube:dQw4w9WgXcQ',
          site: 'youtube',
          kind: 'video',
          title: 'Never Gonna Give You Up',
          canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          capturedAt: '2026-07-11T00:00:00.000Z',
          markdown: '# Never Gonna Give You Up',
          wordCount: 5,
          truncated: false,
        }
        const sink: DebugEntry[] = []
        const layer = testLayer({
          kv: {
            'porter/docs': [doc],
            'porter/settings': {
              ...DEFAULT_SETTINGS,
              accounts: [{ authuser: 0, email: 'f@example.com' }],
            },
            [LEDGER_STORAGE_KEY]: {},
          },
          http: {
            ...targetHttp(),
            [notebookGetUrl()]: rpcResponse(
              RPC_IDS.getNotebook,
              notebookWithSources([
                youtubeSourceEntry('src-yt', 'https://youtu.be/dQw4w9WgXcQ', 2),
              ]),
            ),
          },
          debugSink: sink,
          alarms: { onSchedule: () => undefined },
        })

        const reply = yield* handlePorterMessage({
          type: 'porter/queue-enqueue',
          docIds: [doc.id],
          target: TARGET,
        }).pipe(Effect.provide(layer))
        assert.isTrue(reply.ok)
        if (!reply.ok || !('queue' in reply)) return
        assert.deepStrictEqual(reply.queue.jobs, [])
        const enqueueLog = sink.find((entry) => entry.msg === 'enqueue')
        assert.deepStrictEqual(enqueueLog?.data, {
          notebookId: 'nb-1',
          requestedDocs: 1,
          plannedUnits: 1,
          alreadySynced: 0,
          alreadyOnServer: 1,
          changed: 0,
          enqueued: 0,
          pending: 0,
        })
        const ledger = yield* loadLedger().pipe(Effect.provide(layer))
        assert.isDefined(ledger[notebookTargetKey(TARGET)]?.['youtube:dQw4w9WgXcQ'])
      }),
    )

    it.effect('falls back to ledger-only enqueue when the advisory source listing fails', () =>
      Effect.gen(function* () {
        const doc = makeDoc({ id: 'reddit:queued', capturedAt: '2026-07-11T00:00:00.000Z' })
        const sink: DebugEntry[] = []
        const layer = testLayer({
          kv: {
            'porter/docs': [doc],
            'porter/settings': {
              ...DEFAULT_SETTINGS,
              accounts: [{ authuser: 0, email: 'f@example.com' }],
            },
          },
          // No GET_NOTEBOOK response → 404 → advisory warn + ledger-only enqueue.
          http: {
            [homeUrl(0)]: TARGET_SESSION_HTML,
            [TARGET_LIST_URL]: rpcResponse(RPC_IDS.listNotebooks, [[['Target', null, 'nb-1']]]),
          },
          debugSink: sink,
          alarms: { onSchedule: () => undefined },
        })

        const reply = yield* handlePorterMessage({
          type: 'porter/queue-enqueue',
          docIds: [doc.id],
          target: TARGET,
        }).pipe(Effect.provide(layer))
        assert.isTrue(reply.ok)
        if (!reply.ok || !('queue' in reply)) return
        assert.deepStrictEqual(
          reply.queue.jobs.map((job) => [job.unitId, job.status]),
          [['reddit:queued', 'queued']],
        )
        assert.ok(
          sink.some(
            (entry) =>
              entry.msg === 'enqueue advisory source listing failed' && entry.level === 'warn',
          ),
        )
        const enqueueLog = sink.find((entry) => entry.msg === 'enqueue')
        assert.strictEqual((enqueueLog?.data as { alreadyOnServer?: number })?.alreadyOnServer, 0)
      }),
    )

    it.effect('refuses a Notebook target absent from the fresh account listing', () =>
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
          target: { ...TARGET, notebookId: 'nb-not-allowed' },
        }).pipe(Effect.provide(layer))

        assert.deepStrictEqual(reply, {
          ok: false,
          error: 'Choose a notebook from the current account',
        })
      }),
    )

    it.effect('keeps a queued target bound when the mutable account selection has changed', () =>
      Effect.gen(function* () {
        const doc = makeDoc({ id: 'reddit:bound', capturedAt: '2026-07-11T00:00:00.000Z' })
        const changedSettings = {
          ...DEFAULT_SETTINGS,
          nblmAuthuser: 1,
          accounts: [{ authuser: 1, email: 'other@example.com' }],
          notebookTargets: { reddit: 'nb-old' },
        }
        const layer = testLayer({
          kv: {
            'porter/docs': [doc],
            'porter/settings': changedSettings,
          },
          http: targetHttp(),
        })

        const reply = yield* handlePorterMessage({
          type: 'porter/queue-enqueue',
          docIds: [doc.id],
          target: TARGET,
        }).pipe(Effect.provide(layer))

        assert.isTrue(reply.ok)
        if (!reply.ok || !('queue' in reply)) return
        assert.match(reply.queue.jobs[0]?.id ?? '', /^\["queue-delivery:v2",/)

        const settings = yield* handlePorterMessage({ type: 'porter/get-settings' }).pipe(
          Effect.provide(layer),
        )
        assert.deepStrictEqual(settings, { ok: true, settings: changedSettings })
      }),
    )

    it.effect('rejects a queued target when its authuser now names another email', () =>
      Effect.gen(function* () {
        const doc = makeDoc({ id: 'reddit:queued', capturedAt: '2026-07-11T00:00:00.000Z' })
        const layer = testLayer({
          kv: { 'porter/docs': [doc] },
          http: {
            [homeUrl(0)]: nblmSessionHtml({ email: 'different@example.com' }),
          },
        })

        const reply = yield* handlePorterMessage({
          type: 'porter/queue-enqueue',
          docIds: [doc.id],
          target: TARGET,
        }).pipe(Effect.provide(layer))

        assert.deepStrictEqual(reply, {
          ok: false,
          error: 'Not signed in to notebooklm.google.com for account 0 — open it and sign in',
        })
        const status = yield* handlePorterMessage({ type: 'porter/queue-status' }).pipe(
          Effect.provide(layer),
        )
        assert.deepStrictEqual(status, { ok: true, queue: { jobs: [] } })
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
        const store = new Map<string, unknown>([
          ['porter/docs', [doc]],
          [
            'porter/settings',
            {
              ...DEFAULT_SETTINGS,
              nblmAuthuser: 1,
              accounts: [{ authuser: 1, email: 'other@example.com' }],
            },
          ],
        ])
        const layer = testLayer({
          kv: store,
          http: targetHttp(),
          alarms: { onSchedule: (name, when) => scheduled.push({ name, when }) },
        })

        const created = yield* handlePorterMessage({
          type: 'porter/watch-create',
          docId: doc.id,
          target: TARGET,
        }).pipe(Effect.provide(layer))
        assert.isTrue(created.ok)
        if (!created.ok || !('watches' in created)) return
        assert.strictEqual(created.watches.length, 1)
        assert.strictEqual(created.watches[0]?.sourceDocId, doc.id)
        assert.strictEqual(scheduled[0]?.name, 'porter/watch-resync')
        const persisted = store.get('porter/watch/v1') as
          | { readonly watches?: readonly { readonly target?: unknown }[] }
          | undefined
        assert.deepStrictEqual(persisted?.watches?.[0]?.target, TARGET)

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
          target: TARGET,
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
          target: TARGET,
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
      const reply = yield* handlePorterMessage({
        type: 'porter/list-notebooks',
        account: ACCOUNT,
      }).pipe(Effect.provide(layer))
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
      'porter/export-vault',
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
