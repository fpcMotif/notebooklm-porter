import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer, Result } from 'effect'
import type { NotebookTarget } from '../../accounts/ownership'
import type { DebugEntry } from '../../debug'
import { HttpStatusError, IpcError, NotLoggedIn, ProtocolDrift, RpcRefused } from '../../fx/errors'
import { Http } from '../../fx/services'
import { debugLogTest, httpTest, type RecordedHttpRequest } from '../../fx/testing'
import { buildRpcUrl, homeUrl, RPC_IDS } from '../rpc/protocol'
import {
  nblmSessionHtml,
  notebookWithSources,
  rpcRefusedResponse,
  rpcResponse,
  webSourceEntry,
} from '../rpc/testing'
import { removeSourceDuplicates, retryNotebookSource, scanSourceConsole } from './console'

function sourceRpcUrl(rpcId: string, notebookId = 'nb-1'): string {
  return buildRpcUrl({
    rpcId,
    authuser: 0,
    fSid: 'fsid-1',
    sourcePath: `/notebook/${notebookId}`,
  })
}

function rpcParams(request: RecordedHttpRequest | undefined): unknown {
  const fReq = new URLSearchParams(request?.body ?? '').get('f.req')
  const frame = JSON.parse(fReq ?? '[]')[0]?.[0]
  return JSON.parse(frame?.[1] ?? 'null')
}

const SESSION_HTML = nblmSessionHtml({ email: 'f@example.com' })
const TARGET = {
  authuser: 0,
  accountEmail: 'f@example.com',
  notebookId: 'nb-1',
} satisfies NotebookTarget

function target(notebookId = TARGET.notebookId): NotebookTarget {
  return { ...TARGET, notebookId }
}

function manualSourceEntry(id: string): unknown[] {
  return [[id], id, [null, null, [100], null, 3], [null, 3]]
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

function sourceConsoleLayer(
  responses: Record<string, string | string[]>,
  requests: RecordedHttpRequest[] = [],
  logs: DebugEntry[] = [],
  timeline?: string[],
) {
  return Layer.mergeAll(
    httpTest({ [homeUrl(0)]: SESSION_HTML, ...responses }, requests, (request) => {
      timeline?.push(`http:${request.url}`)
    }),
    debugLogTest(logs, (entry) => {
      if (entry.scope === 'console') timeline?.push(`log:${entry.msg}`)
    }),
  )
}

describe('Source Console', () => {
  it.effect('scans through one authenticated session and logs analyzed counts', () =>
    Effect.gen(function* () {
      const requests: RecordedHttpRequest[] = []
      const logs: DebugEntry[] = []
      const timeline: string[] = []
      const getUrl = sourceRpcUrl(RPC_IDS.getNotebook)
      const layer = sourceConsoleLayer(
        {
          [getUrl]: rpcResponse(
            RPC_IDS.getNotebook,
            notebookWithSources([
              webSourceEntry('a', 'https://youtube.com/watch?v=dQw4w9WgXcQ', 2),
              webSourceEntry('b', 'https://youtu.be/dQw4w9WgXcQ', 2),
              webSourceEntry('bad', 'https://example.com/bad', 3),
            ]),
          ),
        },
        requests,
        logs,
        timeline,
      )

      const scan = yield* scanSourceConsole(target()).pipe(Effect.provide(layer))

      assert.strictEqual(scan.sources.length, 3)
      assert.strictEqual(scan.duplicateCount, 1)
      assert.strictEqual(scan.failed.length, 1)
      assert.deepStrictEqual(
        requests.map((request) => request.url),
        [homeUrl(0), getUrl],
      )
      const log = logs.find((entry) => entry.scope === 'console' && entry.msg === 'scan')
      assert.deepStrictEqual(log?.data, {
        notebookId: 'nb-1',
        sources: 3,
        duplicateGroups: 1,
        duplicates: 1,
        failed: 1,
      })
      assert.deepStrictEqual(timeline, [`http:${homeUrl(0)}`, `http:${getUrl}`, 'log:scan'])
    }),
  )

  it.effect('removes duplicate sources in stable order and returns re-listed truth', () =>
    Effect.gen(function* () {
      const requests: RecordedHttpRequest[] = []
      const logs: DebugEntry[] = []
      const timeline: string[] = []
      const getUrl = sourceRpcUrl(RPC_IDS.getNotebook)
      const deleteUrl = sourceRpcUrl(RPC_IDS.deleteSource)
      const layer = sourceConsoleLayer(
        {
          [getUrl]: [
            rpcResponse(
              RPC_IDS.getNotebook,
              notebookWithSources([
                webSourceEntry('a1', 'https://youtube.com/watch?v=dQw4w9WgXcQ', 2),
                webSourceEntry('b1', 'https://youtube.com/watch?v=9bZkp7q19f0', 2),
                webSourceEntry('a2', 'https://youtu.be/dQw4w9WgXcQ', 2),
                webSourceEntry('b2', 'https://youtu.be/9bZkp7q19f0', 2),
              ]),
            ),
            rpcResponse(
              RPC_IDS.getNotebook,
              notebookWithSources([
                webSourceEntry('a1', 'https://youtube.com/watch?v=dQw4w9WgXcQ', 2),
                webSourceEntry('b1', 'https://youtube.com/watch?v=9bZkp7q19f0', 2),
              ]),
            ),
          ],
          [deleteUrl]: [
            rpcResponse(RPC_IDS.deleteSource, null),
            rpcResponse(RPC_IDS.deleteSource, null),
          ],
        },
        requests,
        logs,
        timeline,
      )

      const result = yield* removeSourceDuplicates(target()).pipe(Effect.provide(layer))

      assert.deepStrictEqual(result.removedIds, ['a2', 'b2'])
      assert.strictEqual(result.scan.duplicateCount, 0)
      assert.deepStrictEqual(
        requests.map((request) => request.url),
        [homeUrl(0), getUrl, deleteUrl, deleteUrl, getUrl],
      )
      const deletedIds = requests
        .filter((request) => request.url === deleteUrl)
        .map((request) => {
          return (rpcParams(request) as unknown[][][])[0]?.[0]?.[0]
        })
      assert.deepStrictEqual(deletedIds, ['a2', 'b2'])
      const log = logs.find((entry) => entry.scope === 'console' && entry.msg === 'dedupe')
      assert.deepStrictEqual(log?.data, {
        notebookId: 'nb-1',
        sources: 4,
        removing: 2,
      })
      assert.deepStrictEqual(timeline, [
        `http:${homeUrl(0)}`,
        `http:${getUrl}`,
        'log:dedupe',
        `http:${deleteUrl}`,
        `http:${deleteUrl}`,
        `http:${getUrl}`,
      ])
    }),
  )

  it.effect('stops after a middle delete failure and does not re-list', () =>
    Effect.gen(function* () {
      const requests: RecordedHttpRequest[] = []
      const getUrl = sourceRpcUrl(RPC_IDS.getNotebook)
      const deleteUrl = sourceRpcUrl(RPC_IDS.deleteSource)
      const layer = sourceConsoleLayer(
        {
          [getUrl]: rpcResponse(
            RPC_IDS.getNotebook,
            notebookWithSources([
              webSourceEntry('a1', 'https://youtube.com/watch?v=dQw4w9WgXcQ', 2),
              webSourceEntry('a2', 'https://youtu.be/dQw4w9WgXcQ', 2),
              webSourceEntry('b1', 'https://youtube.com/watch?v=9bZkp7q19f0', 2),
              webSourceEntry('b2', 'https://youtu.be/9bZkp7q19f0', 2),
              webSourceEntry('c1', 'https://youtube.com/watch?v=3JZ_D3ELwOQ', 2),
              webSourceEntry('c2', 'https://youtu.be/3JZ_D3ELwOQ', 2),
            ]),
          ),
          [deleteUrl]: [
            rpcResponse(RPC_IDS.deleteSource, null),
            rpcResponse('unrelated-rpc', null),
          ],
        },
        requests,
      )

      const result = yield* Effect.result(
        removeSourceDuplicates(target()).pipe(Effect.provide(layer)),
      )

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, ProtocolDrift)
      assert.deepStrictEqual(
        requests.map((request) => request.url),
        [homeUrl(0), getUrl, deleteUrl, deleteUrl],
      )
    }),
  )

  it.effect('re-lists even when the duplicate plan is empty', () =>
    Effect.gen(function* () {
      const requests: RecordedHttpRequest[] = []
      const getUrl = sourceRpcUrl(RPC_IDS.getNotebook)
      const listed = rpcResponse(
        RPC_IDS.getNotebook,
        notebookWithSources([webSourceEntry('only', 'https://only.example', 2)]),
      )
      const layer = sourceConsoleLayer({ [getUrl]: [listed, listed] }, requests)

      const result = yield* removeSourceDuplicates(target()).pipe(Effect.provide(layer))

      assert.deepStrictEqual(result.removedIds, [])
      assert.strictEqual(requests.filter((request) => request.url === getUrl).length, 2)
    }),
  )

  it.effect('does not delete same-title sources without validated video URLs', () =>
    Effect.gen(function* () {
      const requests: RecordedHttpRequest[] = []
      const getUrl = sourceRpcUrl(RPC_IDS.getNotebook)
      const listed = rpcResponse(
        RPC_IDS.getNotebook,
        notebookWithSources([
          [['first'], 'Pasted notes', [null, null, [100], null, 4], [null, 2]],
          [['second'], 'Pasted notes', [null, null, [101], null, 4], [null, 2]],
        ]),
      )
      const layer = sourceConsoleLayer({ [getUrl]: [listed, listed] }, requests)

      const result = yield* removeSourceDuplicates(target()).pipe(Effect.provide(layer))

      assert.deepStrictEqual(result.removedIds, [])
      assert.strictEqual(result.scan.duplicateCount, 0)
      assert.deepStrictEqual(
        requests.map((request) => request.url),
        [homeUrl(0), getUrl, getUrl],
      )
    }),
  )

  it.effect(
    'authorizes one failed refreshable source, refreshes once, then returns re-listed truth',
    () =>
      Effect.gen(function* () {
        const requests: RecordedHttpRequest[] = []
        const logs: DebugEntry[] = []
        const timeline: string[] = []
        const refreshUrl = sourceRpcUrl(RPC_IDS.refreshSource, 'nb-live')
        const getUrl = sourceRpcUrl(RPC_IDS.getNotebook, 'nb-live')
        const layer = sourceConsoleLayer(
          {
            [refreshUrl]: rpcResponse(RPC_IDS.refreshSource, null),
            [getUrl]: [
              rpcResponse(
                RPC_IDS.getNotebook,
                notebookWithSources([webSourceEntry('source-live', 'https://example.com', 3)]),
              ),
              rpcResponse(
                RPC_IDS.getNotebook,
                notebookWithSources([webSourceEntry('source-live', 'https://example.com', 1)]),
              ),
            ],
          },
          requests,
          logs,
          timeline,
        )

        const scan = yield* retryNotebookSource(target('nb-live'), 'source-live').pipe(
          Effect.provide(layer),
        )

        assert.strictEqual(scan.sources[0]?.status, 'processing')
        assert.deepStrictEqual(
          requests.map((request) => request.url),
          [homeUrl(0), getUrl, refreshUrl, getUrl],
        )
        const refresh = requests.find((request) => request.url === refreshUrl)
        assert.deepStrictEqual(rpcParams(refresh), [null, ['source-live'], [2]])
        const log = logs.find((entry) => entry.scope === 'console' && entry.msg === 'retry')
        assert.deepStrictEqual(log?.data, {
          notebookId: 'nb-live',
          sourceId: 'source-live',
        })
        assert.deepStrictEqual(timeline, [
          `http:${homeUrl(0)}`,
          `http:${getUrl}`,
          `http:${refreshUrl}`,
          'log:retry',
          `http:${getUrl}`,
        ])
      }),
  )

  it.effect('rejects a missing source before refresh', () =>
    Effect.gen(function* () {
      const requests: RecordedHttpRequest[] = []
      const getUrl = sourceRpcUrl(RPC_IDS.getNotebook)
      const refreshUrl = sourceRpcUrl(RPC_IDS.refreshSource)
      const layer = sourceConsoleLayer(
        {
          [getUrl]: rpcResponse(
            RPC_IDS.getNotebook,
            notebookWithSources([webSourceEntry('other-source', 'https://example.com', 3)]),
          ),
        },
        requests,
      )

      const result = yield* Effect.result(
        retryNotebookSource(target(), 'missing-source').pipe(Effect.provide(layer)),
      )

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, IpcError)
      assert.strictEqual(requests.filter((request) => request.url === refreshUrl).length, 0)
      assert.deepStrictEqual(
        requests.map((request) => request.url),
        [homeUrl(0), getUrl],
      )
    }),
  )

  it.effect('rejects a healthy source before refresh', () =>
    Effect.gen(function* () {
      const requests: RecordedHttpRequest[] = []
      const getUrl = sourceRpcUrl(RPC_IDS.getNotebook)
      const refreshUrl = sourceRpcUrl(RPC_IDS.refreshSource)
      const layer = sourceConsoleLayer(
        {
          [getUrl]: rpcResponse(
            RPC_IDS.getNotebook,
            notebookWithSources([webSourceEntry('source-ready', 'https://example.com', 2)]),
          ),
        },
        requests,
      )

      const result = yield* Effect.result(
        retryNotebookSource(target(), 'source-ready').pipe(Effect.provide(layer)),
      )

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, IpcError)
      assert.strictEqual(requests.filter((request) => request.url === refreshUrl).length, 0)
      assert.deepStrictEqual(
        requests.map((request) => request.url),
        [homeUrl(0), getUrl],
      )
    }),
  )

  it.effect('rejects a manual-only failed source before refresh', () =>
    Effect.gen(function* () {
      const requests: RecordedHttpRequest[] = []
      const getUrl = sourceRpcUrl(RPC_IDS.getNotebook)
      const refreshUrl = sourceRpcUrl(RPC_IDS.refreshSource)
      const layer = sourceConsoleLayer(
        {
          [getUrl]: rpcResponse(
            RPC_IDS.getNotebook,
            notebookWithSources([manualSourceEntry('source-manual')]),
          ),
        },
        requests,
      )

      const result = yield* Effect.result(
        retryNotebookSource(target(), 'source-manual').pipe(Effect.provide(layer)),
      )

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, IpcError)
      assert.strictEqual(requests.filter((request) => request.url === refreshUrl).length, 0)
      assert.deepStrictEqual(
        requests.map((request) => request.url),
        [homeUrl(0), getUrl],
      )
    }),
  )

  it.effect('does not replay refresh when the post-mutation re-list drifts', () =>
    Effect.gen(function* () {
      const requests: RecordedHttpRequest[] = []
      const refreshUrl = sourceRpcUrl(RPC_IDS.refreshSource)
      const getUrl = sourceRpcUrl(RPC_IDS.getNotebook)
      const layer = sourceConsoleLayer(
        {
          [refreshUrl]: rpcResponse(RPC_IDS.refreshSource, null),
          [getUrl]: [
            rpcResponse(
              RPC_IDS.getNotebook,
              notebookWithSources([webSourceEntry('source-1', 'https://example.com', 3)]),
            ),
            rpcResponse('unrelated-rpc', null),
          ],
        },
        requests,
      )

      const result = yield* Effect.result(
        retryNotebookSource(target(), 'source-1').pipe(Effect.provide(layer)),
      )

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, ProtocolDrift)
      assert.deepStrictEqual(
        requests.map((request) => request.url),
        [homeUrl(0), getUrl, refreshUrl, getUrl],
      )
    }),
  )

  it.effect('does not retry a failed refresh mutation', () =>
    Effect.gen(function* () {
      let refreshAttempts = 0
      const logs: DebugEntry[] = []
      const refreshUrl = sourceRpcUrl(RPC_IDS.refreshSource)
      const getUrl = sourceRpcUrl(RPC_IDS.getNotebook)
      const layer = Layer.mergeAll(
        debugLogTest(logs),
        Layer.succeed(
          Http,
          Http.of({
            text: (url) => {
              if (url === homeUrl(0)) return Effect.succeed(SESSION_HTML)
              if (url === getUrl) {
                return Effect.succeed(
                  rpcResponse(
                    RPC_IDS.getNotebook,
                    notebookWithSources([webSourceEntry('source-1', 'https://example.com', 3)]),
                  ),
                )
              }
              if (url === refreshUrl) {
                refreshAttempts += 1
                return Effect.fail(new HttpStatusError({ url, status: 503 }))
              }
              return Effect.die(`Unexpected URL: ${url}`)
            },
            json: () => Effect.die('not used'),
          }),
        ),
      )

      const result = yield* Effect.result(
        retryNotebookSource(target(), 'source-1').pipe(Effect.provide(layer)),
      )

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, HttpStatusError)
      assert.strictEqual(refreshAttempts, 1)
      assert.isUndefined(logs.find((entry) => entry.scope === 'console' && entry.msg === 'retry'))
    }),
  )

  it('serializes commands across independent callers', async () => {
    const getUrl = sourceRpcUrl(RPC_IDS.getNotebook)
    const refreshUrl = sourceRpcUrl(RPC_IDS.refreshSource)
    const listed = rpcResponse(
      RPC_IDS.getNotebook,
      notebookWithSources([webSourceEntry('source-1', 'https://example.com', 3)]),
    )
    const firstListStarted = deferred()
    const releaseFirstList = deferred()
    const requests: string[] = []
    let lists = 0
    const layer = Layer.mergeAll(
      debugLogTest(),
      Layer.succeed(
        Http,
        Http.of({
          text: (url) => {
            requests.push(url)
            if (url === homeUrl(0)) return Effect.succeed(SESSION_HTML)
            if (url === refreshUrl) return Effect.succeed(rpcResponse(RPC_IDS.refreshSource, null))
            if (url === getUrl) {
              lists += 1
              if (lists === 1) {
                firstListStarted.resolve()
                return Effect.promise(async () => {
                  await releaseFirstList.promise
                  return listed
                })
              }
              return Effect.succeed(listed)
            }
            return Effect.die(`Unexpected URL: ${url}`)
          },
          json: () => Effect.die('not used'),
        }),
      ),
    )

    const first = Effect.runPromise(scanSourceConsole(target()).pipe(Effect.provide(layer)))
    await firstListStarted.promise
    const second = Effect.runPromise(
      retryNotebookSource(target(), 'source-1').pipe(Effect.provide(layer)),
    )
    await Promise.resolve()
    await Promise.resolve()
    const beforeRelease = [...requests]

    releaseFirstList.resolve()
    await Promise.all([first, second])

    assert.deepStrictEqual(beforeRelease, [homeUrl(0), getUrl])
    assert.deepStrictEqual(requests, [homeUrl(0), getUrl, homeUrl(0), getUrl, refreshUrl, getUrl])
  })

  it.effect('rejects a reassigned bound account before any source mutation', () =>
    Effect.gen(function* () {
      const requests: RecordedHttpRequest[] = []
      const layer = sourceConsoleLayer(
        {
          [homeUrl(0)]:
            '"SNlM0e":"csrf-token-1"...."FdrFJe":"fsid-1"...."oPEP7c":"other@example.com"',
        },
        requests,
      )

      const result = yield* Effect.result(
        removeSourceDuplicates(target()).pipe(Effect.provide(layer)),
      )

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) assert.instanceOf(result.failure, NotLoggedIn)
      assert.deepStrictEqual(
        requests.map((request) => request.url),
        [homeUrl(0)],
      )
    }),
  )

  it.effect('keeps source refusal and transport failures distinct', () =>
    Effect.gen(function* () {
      const getUrl = sourceRpcUrl(RPC_IDS.getNotebook)
      const refused = yield* Effect.result(
        scanSourceConsole(target()).pipe(
          Effect.provide(
            sourceConsoleLayer({
              [getUrl]: rpcRefusedResponse(RPC_IDS.getNotebook, 'PERMISSION_DENIED'),
            }),
          ),
        ),
      )
      const transport = yield* Effect.result(
        scanSourceConsole(target()).pipe(Effect.provide(sourceConsoleLayer({}))),
      )

      assert.isTrue(Result.isFailure(refused))
      if (Result.isFailure(refused)) assert.instanceOf(refused.failure, RpcRefused)
      assert.isTrue(Result.isFailure(transport))
      if (Result.isFailure(transport)) assert.instanceOf(transport.failure, HttpStatusError)
    }),
  )
})
