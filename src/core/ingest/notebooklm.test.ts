import { assert, describe, it } from '@effect/vitest'
import { Effect, Result } from 'effect'
import type { DebugEntry } from '../debug'
import { HttpStatusError } from '../fx/errors'
import { debugLogTest, httpTest, type RecordedHttpRequest } from '../fx/testing'
import { sendIngestUnit } from './notebooklm'
import { buildRpcUrl, RPC_IDS } from './rpc/protocol'
import type { NblmSession } from './rpc/client'
import type { IngestUnit } from './units'

const session: NblmSession = { csrfToken: 'csrf-1' }

/** Byte-count line + JSON-array-chunk line, alternating, per the real rt=c format. */
function chunk(frames: unknown[][]): string {
  const line = JSON.stringify(frames)
  return `${line.length}\n${line}`
}

function addSourceOkResponse(): string {
  const payload = JSON.stringify({ ok: true })
  return `)]}'\n${chunk([['wrb.fr', RPC_IDS.addSource, payload]])}\n`
}

function addSourceUrl(notebookId: string): string {
  return buildRpcUrl({
    rpcId: RPC_IDS.addSource,
    authuser: 0,
    sourcePath: `/notebook/${encodeURIComponent(notebookId)}`,
  })
}

describe('sendIngestUnit', () => {
  it.effect('posts a text unit through addTextSource with its title and markdown', () =>
    Effect.gen(function* () {
      const unit: IngestUnit = {
        kind: 'text',
        docId: 'reddit:1',
        id: 'reddit:1',
        contentHash: 'hash-1',
        title: 'Overview',
        markdown: 'unique-markdown-body',
      }
      const requests: RecordedHttpRequest[] = []
      const layer = httpTest({ [addSourceUrl('nb-1')]: addSourceOkResponse() }, requests)

      yield* sendIngestUnit(unit, 'nb-1', session, 0).pipe(
        Effect.provide(layer),
        Effect.provide(debugLogTest()),
      )

      assert.strictEqual(requests.length, 1)
      assert.isTrue(requests[0]?.body?.includes('Overview'))
      assert.isTrue(requests[0]?.body?.includes('unique-markdown-body'))
    }),
  )

  it.effect('posts a youtube unit through addYoutubeSource with its video url', () =>
    Effect.gen(function* () {
      const unit: IngestUnit = {
        kind: 'youtube',
        docId: 'yt:1',
        id: 'youtube:aaaaaaaaaaa',
        contentHash: 'hash-2',
        url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
      }
      const requests: RecordedHttpRequest[] = []
      const layer = httpTest({ [addSourceUrl('nb-1')]: addSourceOkResponse() }, requests)

      yield* sendIngestUnit(unit, 'nb-1', session, 0).pipe(
        Effect.provide(layer),
        Effect.provide(debugLogTest()),
      )

      assert.strictEqual(requests.length, 1)
      assert.isTrue(requests[0]?.body?.includes('aaaaaaaaaaa'))
    }),
  )

  it.effect('propagates the RPC failure untouched instead of swallowing it', () =>
    Effect.gen(function* () {
      const unit: IngestUnit = {
        kind: 'text',
        docId: 'reddit:1',
        id: 'reddit:1',
        contentHash: 'hash-1',
        title: 'Overview',
        markdown: 'body',
      }
      // No response queued for the RPC url — httpTest's fake fetch 404s it.
      const layer = httpTest({})

      const result = yield* Effect.result(
        sendIngestUnit(unit, 'nb-1', session, 0).pipe(
          Effect.provide(layer),
          Effect.provide(debugLogTest()),
        ),
      )

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.instanceOf(result.failure, HttpStatusError)
        assert.strictEqual((result.failure as HttpStatusError).status, 404)
      }
    }),
  )

  it.effect('logs the unit kind and doc id before sending', () =>
    Effect.gen(function* () {
      const unit: IngestUnit = {
        kind: 'text',
        docId: 'reddit:1',
        id: 'reddit:1:toc',
        contentHash: 'hash-1',
        title: 'Overview',
        markdown: 'body',
      }
      const sink: DebugEntry[] = []
      const layer = httpTest({ [addSourceUrl('nb-1')]: addSourceOkResponse() })

      yield* sendIngestUnit(unit, 'nb-1', session, 0).pipe(
        Effect.provide(layer),
        Effect.provide(debugLogTest(sink)),
      )

      const entry = sink.find((e) => e.msg === unit.id)
      assert.isDefined(entry)
      assert.deepStrictEqual(entry?.data, { kind: 'text', docId: 'reddit:1' })
    }),
  )
})
