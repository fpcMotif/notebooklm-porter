import { assert, describe, it } from '@effect/vitest'
import { Deferred, Effect, Fiber, Layer, Result } from 'effect'
import { TestClock } from 'effect/testing'
import type { NotebookLmAccountBinding } from '../accounts/ownership'
import type { DebugEntry } from '../debug'
import {
  HttpStatusError,
  NotebookCreationUncertain,
  NotebookTitleInvalid,
  NotLoggedIn,
  StorageError,
} from '../fx/errors'
import { Kv } from '../fx/services'
import {
  debugLogTest,
  httpHandlerTest,
  httpTest,
  type HttpTestReply,
  type RecordedHttpRequest,
} from '../fx/testing'
import { buildRpcUrl, createNotebookParams, homeUrl, RPC_IDS } from '../ingest/rpc/protocol'
import {
  nblmSessionHtml,
  notebookListResponse,
  rpcRefusedResponse,
  rpcResponse,
} from '../ingest/rpc/testing'
import { DEFAULT_SETTINGS } from '../settings'
import { NOTEBOOK_CACHE_STORAGE_KEY } from '../store/notebooks-cache'
import { createCatalogNotebook, readNotebookCatalog, refreshNotebookCatalog } from './catalog'

const ACCOUNT = {
  authuser: 0,
  accountEmail: 'f@example.com',
} satisfies NotebookLmAccountBinding

const HOME_URL = homeUrl(0)
const LIST_URL = buildRpcUrl({
  rpcId: RPC_IDS.listNotebooks,
  authuser: 0,
  fSid: 'fsid-1',
  sourcePath: '/',
})
const CREATE_URL = buildRpcUrl({
  rpcId: RPC_IDS.createNotebook,
  authuser: 0,
  fSid: 'fsid-1',
  sourcePath: '/',
})
const SESSION_HTML = nblmSessionHtml({ email: 'f@example.com' })

function shouldFail(failures: Map<string, number>, key: string): boolean {
  const remaining = failures.get(key) ?? 0
  if (remaining === 0) return false
  failures.set(key, remaining - 1)
  return true
}

function faultingKv(
  seed: Record<string, unknown> = {},
  faults: { get?: Record<string, number>; set?: Record<string, number> } = {},
  onOperation?: (operation: 'get' | 'set', key: string) => void,
) {
  const store = new Map(Object.entries(seed))
  const getFaults = new Map(Object.entries(faults.get ?? {}))
  const setFaults = new Map(Object.entries(faults.set ?? {}))
  return {
    store,
    layer: Layer.succeed(
      Kv,
      Kv.of({
        get: <T>(key: string) =>
          Effect.suspend(() => {
            onOperation?.('get', key)
            return shouldFail(getFaults, key)
              ? Effect.fail(new StorageError({ key, cause: 'test get failure' }))
              : Effect.succeed(store.get(key) as T | undefined)
          }),
        set: <T>(key: string, value: T) =>
          Effect.suspend(() => {
            onOperation?.('set', key)
            return shouldFail(setFaults, key)
              ? Effect.fail(new StorageError({ key, cause: 'test set failure' }))
              : Effect.sync(() => void store.set(key, value))
          }),
      }),
    ),
  }
}

function catalogLayer(options: {
  responses?: Record<string, HttpTestReply | HttpTestReply[]>
  requests?: RecordedHttpRequest[]
  logs?: DebugEntry[]
  timeline?: string[]
  kv?: ReturnType<typeof faultingKv>
  sessionHtml?: string
}) {
  const kv = options.kv ?? faultingKv({ 'porter/settings': DEFAULT_SETTINGS })
  return {
    kv,
    layer: Layer.mergeAll(
      kv.layer,
      httpTest(
        { [HOME_URL]: options.sessionHtml ?? SESSION_HTML, ...options.responses },
        options.requests,
        (request) => options.timeline?.push(`http:${request.url}`),
      ),
      debugLogTest(options.logs, (entry) => {
        if (entry.scope === 'catalog') options.timeline?.push(`log:${entry.msg}`)
      }),
    ),
  }
}

function catalogEntry(logs: DebugEntry[], message: string): DebugEntry | undefined {
  return logs.find((entry) => entry.scope === 'catalog' && entry.msg === message)
}

describe('Notebook catalog', () => {
  it.effect('reads a matching cache only after a fresh session observation', () =>
    Effect.gen(function* () {
      const requests: RecordedHttpRequest[] = []
      const logs: DebugEntry[] = []
      const cached = [{ id: 'cached', title: 'Cached' }]
      const { layer } = catalogLayer({
        requests,
        logs,
        kv: faultingKv({
          'porter/settings': DEFAULT_SETTINGS,
          [NOTEBOOK_CACHE_STORAGE_KEY]: {
            version: 1,
            entries: {
              0: {
                email: 'f@example.com',
                notebooks: cached,
                refreshedAt: '2026-07-15T00:00:00.000Z',
              },
            },
          },
        }),
      })

      const notebooks = yield* readNotebookCatalog(ACCOUNT).pipe(Effect.provide(layer))

      assert.deepStrictEqual(notebooks, cached)
      assert.deepStrictEqual(
        requests.map((request) => request.url),
        [HOME_URL],
      )
      assert.deepStrictEqual(catalogEntry(logs, 'list')?.data, {
        authuser: 0,
        source: 'cache',
        count: 1,
      })
    }),
  )

  it.effect('returns a forced remote list when its cache write fails', () =>
    Effect.gen(function* () {
      const logs: DebugEntry[] = []
      const { layer } = catalogLayer({
        logs,
        responses: { [LIST_URL]: notebookListResponse([{ id: 'fresh', title: 'Fresh' }]) },
        kv: faultingKv(
          { 'porter/settings': DEFAULT_SETTINGS },
          { set: { [NOTEBOOK_CACHE_STORAGE_KEY]: 1 } },
        ),
      })

      const notebooks = yield* refreshNotebookCatalog(ACCOUNT).pipe(Effect.provide(layer))

      assert.deepStrictEqual(notebooks, [{ id: 'fresh', title: 'Fresh' }])
      assert.deepStrictEqual(catalogEntry(logs, 'cache-failed'), {
        t: '',
        scope: 'catalog',
        msg: 'cache-failed',
        level: 'warn',
        data: { authuser: 0, operation: 'write' },
      })
    }),
  )

  it.effect('refreshes an email-mismatched slot instead of serving stale browse data', () =>
    Effect.gen(function* () {
      const requests: RecordedHttpRequest[] = []
      const { layer } = catalogLayer({
        requests,
        responses: { [LIST_URL]: notebookListResponse([{ id: 'fresh', title: 'Fresh' }]) },
        kv: faultingKv({
          'porter/settings': DEFAULT_SETTINGS,
          [NOTEBOOK_CACHE_STORAGE_KEY]: {
            version: 1,
            entries: {
              0: {
                email: 'former@example.com',
                notebooks: [{ id: 'stale', title: 'Stale' }],
                refreshedAt: '2026-07-15T00:00:00.000Z',
              },
            },
          },
        }),
      })

      const notebooks = yield* readNotebookCatalog(ACCOUNT).pipe(Effect.provide(layer))

      assert.deepStrictEqual(notebooks, [{ id: 'fresh', title: 'Fresh' }])
      assert.strictEqual(requests.filter((request) => request.url === LIST_URL).length, 1)
    }),
  )

  it.effect('reloads after a cache-read fault and preserves another account slot', () =>
    Effect.gen(function* () {
      const initialCache = {
        version: 1 as const,
        entries: {
          1: {
            email: 'other@example.com',
            notebooks: [{ id: 'other', title: 'Other' }],
            refreshedAt: '2026-07-15T00:00:00.000Z',
          },
        },
      }
      const kv = faultingKv(
        {
          'porter/settings': DEFAULT_SETTINGS,
          [NOTEBOOK_CACHE_STORAGE_KEY]: initialCache,
        },
        { get: { [NOTEBOOK_CACHE_STORAGE_KEY]: 1 } },
      )
      const { layer } = catalogLayer({
        kv,
        responses: { [LIST_URL]: notebookListResponse([{ id: 'fresh', title: 'Fresh' }]) },
      })

      yield* readNotebookCatalog(ACCOUNT).pipe(Effect.provide(layer))

      const stored = kv.store.get(NOTEBOOK_CACHE_STORAGE_KEY) as {
        entries: Record<string, unknown>
      }
      assert.deepStrictEqual(stored.entries['1'], initialCache.entries[1])
      assert.isDefined(stored.entries['0'])
    }),
  )

  it.effect('rejects a changed account before catalog RPC or cache access', () =>
    Effect.gen(function* () {
      const requests: RecordedHttpRequest[] = []
      const kv = faultingKv({
        'porter/settings': DEFAULT_SETTINGS,
        [NOTEBOOK_CACHE_STORAGE_KEY]: {
          version: 1,
          entries: {
            0: {
              email: 'former@example.com',
              notebooks: [{ id: 'old', title: 'Old' }],
              refreshedAt: '2026-07-15T00:00:00.000Z',
            },
          },
        },
      })
      const before = kv.store.get(NOTEBOOK_CACHE_STORAGE_KEY)
      const { layer } = catalogLayer({
        kv,
        requests,
        sessionHtml: nblmSessionHtml(),
        responses: { [LIST_URL]: notebookListResponse([{ id: 'fresh', title: 'Fresh' }]) },
      })

      const result = yield* Effect.result(readNotebookCatalog(ACCOUNT).pipe(Effect.provide(layer)))

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, NotLoggedIn)
      assert.deepStrictEqual(
        requests.map((request) => request.url),
        [HOME_URL],
      )
      assert.strictEqual(kv.store.get(NOTEBOOK_CACHE_STORAGE_KEY), before)
    }),
  )

  it.effect('leaves prior cache unchanged when a remote refresh fails', () =>
    Effect.gen(function* () {
      const cached = {
        version: 1 as const,
        entries: {
          0: {
            email: 'f@example.com',
            notebooks: [{ id: 'old', title: 'Old' }],
            refreshedAt: '2026-07-15T00:00:00.000Z',
          },
        },
      }
      const kv = faultingKv({
        'porter/settings': DEFAULT_SETTINGS,
        [NOTEBOOK_CACHE_STORAGE_KEY]: cached,
      })
      const { layer } = catalogLayer({
        kv,
        responses: { [LIST_URL]: { body: 'failed', status: 400 } },
      })

      const result = yield* Effect.result(
        refreshNotebookCatalog(ACCOUNT).pipe(Effect.provide(layer)),
      )

      assert.isTrue(Result.isFailure(result))
      assert.strictEqual(kv.store.get(NOTEBOOK_CACHE_STORAGE_KEY), cached)
    }),
  )

  it.effect('rejects a blank title before account authentication', () =>
    Effect.gen(function* () {
      const requests: RecordedHttpRequest[] = []
      const { layer } = catalogLayer({ requests })

      const result = yield* Effect.result(
        createCatalogNotebook(ACCOUNT, '   ').pipe(Effect.provide(layer)),
      )

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, NotebookTitleInvalid)
      assert.deepStrictEqual(requests, [])
    }),
  )

  it.effect('rejects an account mismatch before a create mutation', () =>
    Effect.gen(function* () {
      const requests: RecordedHttpRequest[] = []
      const { layer } = catalogLayer({
        requests,
        sessionHtml: nblmSessionHtml({ email: 'other@example.com' }),
        responses: {
          [LIST_URL]: notebookListResponse([]),
          [CREATE_URL]: rpcResponse(RPC_IDS.createNotebook, ['Title', null, 'new']),
        },
      })

      const result = yield* Effect.result(
        createCatalogNotebook(ACCOUNT, 'Title').pipe(Effect.provide(layer)),
      )

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, NotLoggedIn)
      assert.deepStrictEqual(
        requests.map((request) => request.url),
        [HOME_URL],
      )
    }),
  )

  it.effect('creates once, trusts only a new response id, and logs no title', () =>
    Effect.gen(function* () {
      const requests: RecordedHttpRequest[] = []
      const logs: DebugEntry[] = []
      const timeline: string[] = []
      const { layer } = catalogLayer({
        requests,
        logs,
        timeline,
        kv: faultingKv(
          { 'porter/settings': DEFAULT_SETTINGS },
          { set: { [NOTEBOOK_CACHE_STORAGE_KEY]: 1 } },
        ),
        responses: {
          [LIST_URL]: [
            notebookListResponse([{ id: 'old', title: 'Old' }]),
            notebookListResponse([
              { id: 'old', title: 'Old' },
              { id: 'external', title: 'New title' },
              { id: 'new', title: 'New title' },
            ]),
          ],
          [CREATE_URL]: rpcResponse(RPC_IDS.createNotebook, [['New title', null, 'new']]),
        },
      })

      const result = yield* createCatalogNotebook(ACCOUNT, '  New title  ').pipe(
        Effect.provide(layer),
      )

      assert.deepStrictEqual(result.created, { id: 'new', title: 'New title' })
      assert.strictEqual(requests.filter((request) => request.url === CREATE_URL).length, 1)
      const createRequest = requests.find((request) => request.url === CREATE_URL)
      const fReq = new URLSearchParams(createRequest?.body ?? '').get('f.req')
      const frame = JSON.parse(fReq ?? '[]')[0]?.[0]
      assert.deepStrictEqual(JSON.parse(frame?.[1] ?? 'null'), createNotebookParams('New title'))
      assert.deepStrictEqual(catalogEntry(logs, 'create')?.data, {
        authuser: 0,
        notebookId: 'new',
      })
      assert.notInclude(JSON.stringify(logs), 'New title')
      assert.deepStrictEqual(timeline, [
        `http:${HOME_URL}`,
        `http:${LIST_URL}`,
        `http:${CREATE_URL}`,
        `http:${LIST_URL}`,
        'log:create',
        'log:cache-failed',
      ])
    }),
  )

  it.effect('treats a hintless acknowledgement as uncertain after the bounded re-lists', () =>
    Effect.gen(function* () {
      const requests: RecordedHttpRequest[] = []
      const logs: DebugEntry[] = []
      const { layer } = catalogLayer({
        requests,
        logs,
        responses: {
          [LIST_URL]: [
            notebookListResponse([]),
            notebookListResponse([{ id: 'external', title: 'Same title' }]),
            notebookListResponse([{ id: 'external', title: 'Same title' }]),
            notebookListResponse([{ id: 'external', title: 'Same title' }]),
          ],
          [CREATE_URL]: rpcResponse(RPC_IDS.createNotebook, null),
        },
      })
      const fiber = yield* createCatalogNotebook(ACCOUNT, 'Same title').pipe(
        Effect.provide(layer),
        Effect.forkChild,
      )
      yield* TestClock.adjust('800 millis')
      const result = yield* Effect.result(Fiber.join(fiber))

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, NotebookCreationUncertain)
      assert.strictEqual(requests.filter((request) => request.url === CREATE_URL).length, 1)
      assert.strictEqual(requests.filter((request) => request.url === LIST_URL).length, 4)
      assert.deepStrictEqual(catalogEntry(logs, 'create-uncertain')?.data, {
        authuser: 0,
        stage: 'created-notebook',
        reason: 'missing-id',
      })
      assert.isUndefined(catalogEntry(logs, 'create'))
    }),
  )

  it.effect('re-lists once after an ambiguous create failure without replaying create', () =>
    Effect.gen(function* () {
      const requests: RecordedHttpRequest[] = []
      const logs: DebugEntry[] = []
      const timeline: string[] = []
      const { layer } = catalogLayer({
        requests,
        logs,
        timeline,
        kv: faultingKv(
          { 'porter/settings': DEFAULT_SETTINGS },
          { set: { [NOTEBOOK_CACHE_STORAGE_KEY]: 1 } },
        ),
        responses: {
          [LIST_URL]: [notebookListResponse([]), notebookListResponse([])],
          [CREATE_URL]: { body: 'busy', status: 503 },
        },
      })

      const result = yield* Effect.result(
        createCatalogNotebook(ACCOUNT, 'Title').pipe(Effect.provide(layer)),
      )

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, NotebookCreationUncertain)
      assert.strictEqual(requests.filter((request) => request.url === CREATE_URL).length, 1)
      assert.strictEqual(requests.filter((request) => request.url === LIST_URL).length, 2)
      assert.deepStrictEqual(catalogEntry(logs, 'create-uncertain')?.data, {
        authuser: 0,
        stage: 'create-request',
        reason: 'http-status',
        status: 503,
      })
      assert.deepStrictEqual(
        timeline.filter((entry) => entry.startsWith('log:')),
        ['log:create-uncertain', 'log:cache-failed'],
      )
    }),
  )

  it.effect('propagates a definite create rejection without a reconciliation list', () =>
    Effect.gen(function* () {
      const requests: RecordedHttpRequest[] = []
      const { layer } = catalogLayer({
        requests,
        responses: {
          [LIST_URL]: notebookListResponse([]),
          [CREATE_URL]: { body: 'bad request', status: 400 },
        },
      })

      const result = yield* Effect.result(
        createCatalogNotebook(ACCOUNT, 'Title').pipe(Effect.provide(layer)),
      )

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, HttpStatusError)
      assert.strictEqual(requests.filter((request) => request.url === LIST_URL).length, 1)
    }),
  )

  it.effect('turns a post-acknowledgement list failure into typed uncertainty', () =>
    Effect.gen(function* () {
      const requests: RecordedHttpRequest[] = []
      const logs: DebugEntry[] = []
      const { layer } = catalogLayer({
        requests,
        logs,
        responses: {
          [LIST_URL]: [notebookListResponse([]), { body: 'list rejected', status: 400 }],
          [CREATE_URL]: rpcResponse(RPC_IDS.createNotebook, ['Title', null, 'new']),
        },
      })

      const result = yield* Effect.result(
        createCatalogNotebook(ACCOUNT, 'Title').pipe(Effect.provide(layer)),
      )

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, NotebookCreationUncertain)
      assert.strictEqual(requests.filter((request) => request.url === CREATE_URL).length, 1)
      assert.deepStrictEqual(catalogEntry(logs, 'create-uncertain')?.data, {
        authuser: 0,
        stage: 'post-create-list',
        reason: 'http-status',
        status: 400,
      })
    }),
  )

  it.effect('propagates an explicit RPC refusal without a reconciliation list', () =>
    Effect.gen(function* () {
      const requests: RecordedHttpRequest[] = []
      const { layer } = catalogLayer({
        requests,
        responses: {
          [LIST_URL]: notebookListResponse([]),
          [CREATE_URL]: rpcRefusedResponse(RPC_IDS.createNotebook, 'DENIED'),
        },
      })

      const result = yield* Effect.result(
        createCatalogNotebook(ACCOUNT, 'Title').pipe(Effect.provide(layer)),
      )

      assert.isTrue(Result.isFailure(result))
      assert.strictEqual(requests.filter((request) => request.url === LIST_URL).length, 1)
    }),
  )

  it.effect('serializes overlapping create workflows through one module permit', () =>
    Effect.gen(function* () {
      const requests: RecordedHttpRequest[] = []
      const { layer } = catalogLayer({
        requests,
        responses: {
          [HOME_URL]: [SESSION_HTML, SESSION_HTML],
          [LIST_URL]: [
            notebookListResponse([]),
            notebookListResponse([{ id: 'a', title: 'A' }]),
            notebookListResponse([{ id: 'a', title: 'A' }]),
            notebookListResponse([
              { id: 'a', title: 'A' },
              { id: 'b', title: 'B' },
            ]),
          ],
          [CREATE_URL]: [
            rpcResponse(RPC_IDS.createNotebook, ['A', null, 'a']),
            rpcResponse(RPC_IDS.createNotebook, ['B', null, 'b']),
          ],
        },
      })

      const [first, second] = yield* Effect.all(
        [createCatalogNotebook(ACCOUNT, 'A'), createCatalogNotebook(ACCOUNT, 'B')],
        { concurrency: 'unbounded' },
      ).pipe(Effect.provide(layer))

      assert.strictEqual(first.created.id, 'a')
      assert.strictEqual(second.created.id, 'b')
      assert.deepStrictEqual(
        requests.map((request) => request.url),
        [HOME_URL, LIST_URL, CREATE_URL, LIST_URL, HOME_URL, LIST_URL, CREATE_URL, LIST_URL],
      )
    }),
  )

  it.effect('keeps a queued create bound after mutable settings switch accounts', () =>
    Effect.gen(function* () {
      const refreshEntered = yield* Deferred.make<void>()
      const releaseRefresh = yield* Deferred.make<void>()
      const requests: string[] = []
      const kvOperations: string[] = []
      const kv = faultingKv({ 'porter/settings': DEFAULT_SETTINGS }, {}, (operation, key) => {
        kvOperations.push(`${operation}:${key}`)
      })
      let listCalls = 0
      const layer = Layer.mergeAll(
        kv.layer,
        httpHandlerTest((url) =>
          Effect.suspend(() => {
            requests.push(url)
            if (url === HOME_URL) return Effect.succeed(SESSION_HTML)
            if (url === CREATE_URL) {
              return Effect.succeed(rpcResponse(RPC_IDS.createNotebook, ['New', null, 'new']))
            }
            if (url !== LIST_URL) return Effect.die(`Unexpected URL: ${url}`)
            listCalls += 1
            const body =
              listCalls === 3
                ? notebookListResponse([{ id: 'new', title: 'New' }])
                : notebookListResponse([])
            if (listCalls !== 1) return Effect.succeed(body)
            return Deferred.succeed(refreshEntered, undefined).pipe(
              Effect.andThen(Deferred.await(releaseRefresh)),
              Effect.as(body),
            )
          }),
        ),
        debugLogTest(),
      )

      const refreshFiber = yield* refreshNotebookCatalog(ACCOUNT).pipe(
        Effect.provide(layer),
        Effect.forkChild,
      )
      yield* Deferred.await(refreshEntered)
      const createFiber = yield* createCatalogNotebook(ACCOUNT, 'New').pipe(
        Effect.provide(layer),
        Effect.forkChild,
      )
      yield* Effect.yieldNow
      kv.store.set('porter/settings', {
        ...DEFAULT_SETTINGS,
        nblmAuthuser: 1,
        accounts: [{ authuser: 1, email: 'other@example.com' }],
      })
      yield* Deferred.succeed(releaseRefresh, undefined)

      const refreshed = yield* Fiber.join(refreshFiber)
      const created = yield* Fiber.join(createFiber)

      assert.deepStrictEqual(refreshed, [])
      assert.strictEqual(created.created.id, 'new')
      assert.deepStrictEqual(requests, [
        HOME_URL,
        LIST_URL,
        HOME_URL,
        LIST_URL,
        CREATE_URL,
        LIST_URL,
      ])
      assert.notInclude(kvOperations, 'get:porter/settings')
    }),
  )
})
