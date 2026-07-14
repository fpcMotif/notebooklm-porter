import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { FetchError, HttpStatusError, ProtocolDrift } from '../fx/errors'
import { Alarms, DebugLog, DomTabs, Http, Kv, type HttpInit } from '../fx/services'
import type { DomDeliveryRequest, DomDeliveryResult } from '../ingest/dom/contracts'
import { TIER_STATE_STORAGE_KEY, type TierState } from '../ingest/tier-state'
import type { IngestUnit } from '../ingest/units'
import { RPC_IDS } from '../ingest/rpc/protocol'
import { contentHash } from '../store/ledger'
import { QUEUE_ALARM, QUEUE_STORAGE_KEY, emptyQueue, enqueueUnits } from './queue'
import { classifyQueueFailure, drainQueue } from './drain'

const NOW = '2026-07-11T00:00:00.000Z'
const HOME = '"SNlM0e":"csrf-token"...."oPEP7c":"f@example.com"'

const unit: IngestUnit = {
  kind: 'text',
  docId: 'reddit:1',
  id: 'reddit:1',
  contentHash: contentHash('body'),
  title: 'Thread',
  markdown: 'body',
}

const target = { notebookId: 'nb-1', authuser: 0, accountEmail: 'f@example.com' }

function addSourceResponse(): string {
  const payload = JSON.stringify({ ok: true })
  const frame = JSON.stringify([['wrb.fr', 'izAoDd', payload]])
  return `)]}'\n${frame.length}\n${frame}\n`
}

function listNotebooksResponse(notebookId = 'nb-1'): string {
  const payload = JSON.stringify([[['Target notebook', null, notebookId]]])
  const frame = JSON.stringify([['wrb.fr', RPC_IDS.listNotebooks, payload]])
  return `)]}'\n${frame.length}\n${frame}\n`
}

function protocolDriftResponse(): string {
  const payload = JSON.stringify({ ok: true })
  const frame = JSON.stringify([['wrb.fr', 'unrelatedRpc', payload]])
  return `)]}'\n${frame.length}\n${frame}\n`
}

function rpcRefusedResponse(): string {
  const frame = JSON.stringify([['er', RPC_IDS.addSource, 'QUOTA_EXCEEDED']])
  return `)]}'\n${frame.length}\n${frame}\n`
}

function runtime(
  opts: {
    accountEmail?: string
    queue?: ReturnType<typeof emptyQueue>
    ledger?: Record<string, unknown>
    sessionFailure?: FetchError
    postFailure?: HttpStatusError
    sourceResponse?: string
    listedNotebookId?: string
    listProtocolDrift?: boolean
    domResult?: DomDeliveryResult
    domAvailable?: boolean
    tierState?: TierState
  } = {},
) {
  const values = new Map<string, unknown>([
    [QUEUE_STORAGE_KEY, opts.queue ?? enqueueUnits(emptyQueue(), target, [unit], NOW)],
    ['porter/ledger', opts.ledger ?? {}],
    ...(opts.tierState !== undefined ? [[TIER_STATE_STORAGE_KEY, opts.tierState] as const] : []),
  ])
  const writes: Array<{ key: string; value: unknown }> = []
  const alarms: Array<{ type: 'schedule' | 'clear'; name: string; when?: number }> = []
  let posts = 0
  let listCalls = 0
  let sessionCalls = 0
  const domRequests: DomDeliveryRequest[] = []

  const kv = Layer.succeed(
    Kv,
    Kv.of({
      get: <T>(key: string) => Effect.sync(() => values.get(key) as T | undefined),
      set: <T>(key: string, value: T) =>
        Effect.sync(() => {
          values.set(key, value)
          writes.push({ key, value })
        }),
    }),
  )
  const http = Layer.succeed(
    Http,
    Http.of({
      text: (url: string, init?: HttpInit) => {
        if (init?.method === 'POST') {
          if (init.body?.includes(RPC_IDS.listNotebooks)) {
            listCalls += 1
            if (opts.listProtocolDrift) {
              return Effect.succeed(protocolDriftResponse())
            }
            return Effect.succeed(listNotebooksResponse(opts.listedNotebookId))
          }
          posts += 1
          if (opts.postFailure !== undefined) return Effect.fail(opts.postFailure)
          return Effect.succeed(opts.sourceResponse ?? addSourceResponse())
        }
        if (url.includes('authuser=0')) {
          sessionCalls += 1
          return opts.sessionFailure === undefined
            ? Effect.succeed(HOME.replace('f@example.com', opts.accountEmail ?? 'f@example.com'))
            : Effect.fail(opts.sessionFailure)
        }
        return Effect.succeed('<html>signed out</html>')
      },
      json: () => Effect.die('not used'),
    }),
  )
  const debug = Layer.succeed(
    DebugLog,
    DebugLog.of({
      log: () => Effect.void,
      entries: () => Effect.succeed([]),
      clear: () => Effect.void,
    }),
  )
  const alarmsLayer = Layer.succeed(
    Alarms,
    Alarms.of({
      schedule: (name, when) =>
        Effect.sync(() => {
          alarms.push({ type: 'schedule', name, when })
        }),
      clear: (name) =>
        Effect.sync(() => {
          alarms.push({ type: 'clear', name })
          return true
        }),
    }),
  )
  const domTabs = Layer.succeed(
    DomTabs,
    DomTabs.of({
      available: opts.domAvailable ?? false,
      deliver: (request) =>
        Effect.sync(() => {
          domRequests.push(request)
          return (
            opts.domResult ?? {
              status: 'unavailable' as const,
              reason: 'DOM test adapter was not configured',
            }
          )
        }),
    }),
  )

  return {
    alarms,
    domRequests,
    layer: Layer.mergeAll(kv, http, debug, alarmsLayer, domTabs),
    listCalls: () => listCalls,
    posts: () => posts,
    sessionCalls: () => sessionCalls,
    values,
    writes,
  }
}

function queueWithInFlightJob() {
  const queued = enqueueUnits(emptyQueue(), target, [unit], NOW)
  const job = queued.jobs[0]
  if (job === undefined) throw new Error('Expected queued fixture job')
  return { ...queued, jobs: [{ ...job, status: 'inFlight' as const }] }
}

describe('drainQueue', () => {
  it.effect('persists inFlight, receipt, then removal around a one-unit source mutation', () =>
    Effect.gen(function* () {
      const fx = runtime()

      const result = yield* drainQueue({ now: NOW }).pipe(Effect.provide(fx.layer))

      assert.deepStrictEqual(result, {
        status: 'sent',
        jobId: 'f@example.com:nb-1:reddit:1:dbaa7975',
      })
      assert.strictEqual(fx.posts(), 1)
      assert.deepStrictEqual(
        fx.writes.map((write) => write.key),
        [QUEUE_STORAGE_KEY, 'porter/ledger', QUEUE_STORAGE_KEY],
      )
      const firstQueue = fx.writes[0]?.value as ReturnType<typeof emptyQueue>
      const finalQueue = fx.writes[2]?.value as ReturnType<typeof emptyQueue>
      assert.strictEqual(firstQueue.jobs[0]?.status, 'inFlight')
      assert.strictEqual(finalQueue.jobs.length, 0)
      assert.deepStrictEqual(fx.alarms, [{ type: 'clear', name: QUEUE_ALARM }])
    }),
  )

  it.effect('drains every due job in one pass, reusing one session and one notebook listing', () =>
    Effect.gen(function* () {
      const unitA = { ...unit, id: 'reddit:a', docId: 'reddit:a', contentHash: contentHash('a') }
      const unitB = { ...unit, id: 'reddit:b', docId: 'reddit:b', contentHash: contentHash('b') }
      const unitC = { ...unit, id: 'reddit:c', docId: 'reddit:c', contentHash: contentHash('c') }
      const fx = runtime({ queue: enqueueUnits(emptyQueue(), target, [unitA, unitB, unitC], NOW) })

      const result = yield* drainQueue({ now: NOW }).pipe(Effect.provide(fx.layer))

      assert.strictEqual(result.status, 'sent')
      // Three sources sent, but identity + the read-only canary fetched ONCE.
      assert.strictEqual(fx.posts(), 3)
      assert.strictEqual(fx.sessionCalls(), 1)
      assert.strictEqual(fx.listCalls(), 1)
      const finalQueue = fx.values.get(QUEUE_STORAGE_KEY) as ReturnType<typeof emptyQueue>
      assert.strictEqual(finalQueue.jobs.length, 0)
      assert.deepStrictEqual(fx.alarms, [{ type: 'clear', name: QUEUE_ALARM }])
    }),
  )

  it.effect('removes a receipted inFlight job without sending it again after restart', () =>
    Effect.gen(function* () {
      const inFlight = queueWithInFlightJob()
      const fx = runtime({
        queue: inFlight,
        ledger: {
          'nb-1': {
            'reddit:1': { contentHash: unit.contentHash, lastSynced: NOW },
          },
        },
      })

      const result = yield* drainQueue({ now: NOW }).pipe(Effect.provide(fx.layer))

      assert.deepStrictEqual(result, { status: 'idle' })
      assert.strictEqual(fx.posts(), 0)
      const finalQueue = fx.values.get(QUEUE_STORAGE_KEY) as ReturnType<typeof emptyQueue>
      assert.strictEqual(finalQueue.jobs.length, 0)
    }),
  )

  it.effect('reaps an unreceipted inFlight job to explicit uncertainty without resending it', () =>
    Effect.gen(function* () {
      const inFlight = queueWithInFlightJob()
      const fx = runtime({ queue: inFlight })

      const result = yield* drainQueue({ now: NOW }).pipe(Effect.provide(fx.layer))

      assert.deepStrictEqual(result, { status: 'idle' })
      assert.strictEqual(fx.posts(), 0)
      const finalQueue = fx.values.get(QUEUE_STORAGE_KEY) as ReturnType<typeof emptyQueue>
      assert.strictEqual(finalQueue.jobs[0]?.status, 'uncertain')
      assert.strictEqual(finalQueue.jobs[0]?.lastError, 'Worker stopped during send')
    }),
  )

  it.effect('blocks a job when its authuser now names a different account', () =>
    Effect.gen(function* () {
      const fx = runtime({ accountEmail: 'different@example.com' })

      const result = yield* drainQueue({ now: NOW }).pipe(Effect.provide(fx.layer))

      assert.deepStrictEqual(result, {
        status: 'blocked',
        jobId: 'f@example.com:nb-1:reddit:1:dbaa7975',
      })
      assert.strictEqual(fx.posts(), 0)
      const finalQueue = fx.values.get(QUEUE_STORAGE_KEY) as ReturnType<typeof emptyQueue>
      assert.strictEqual(finalQueue.jobs[0]?.status, 'blocked')
    }),
  )

  it.effect('retries a fresh job when session preflight cannot reach NotebookLM', () =>
    Effect.gen(function* () {
      const fx = runtime({
        sessionFailure: new FetchError({ url: 'https://notebooklm.google.com', cause: 'offline' }),
      })

      const result = yield* drainQueue({ now: NOW }).pipe(Effect.provide(fx.layer))

      assert.deepStrictEqual(result, {
        status: 'retrying',
        jobId: 'f@example.com:nb-1:reddit:1:dbaa7975',
      })
      assert.strictEqual(fx.posts(), 0)
      const finalQueue = fx.values.get(QUEUE_STORAGE_KEY) as ReturnType<typeof emptyQueue>
      assert.strictEqual(finalQueue.jobs[0]?.status, 'retrying')
      assert.strictEqual(finalQueue.jobs[0]?.attempts, 1)
      assert.strictEqual(finalQueue.jobs[0]?.nextAttemptAt, '2026-07-11T00:00:30.000Z')
    }),
  )

  it.effect('reports terminal failure when preflight retry attempts are exhausted', () =>
    Effect.gen(function* () {
      const queued = enqueueUnits(emptyQueue(), target, [unit], NOW)
      const job = queued.jobs[0]
      if (job === undefined) throw new Error('Expected queued fixture job')
      const fx = runtime({
        queue: {
          ...queued,
          jobs: [{ ...job, attempts: 4, status: 'retrying', nextAttemptAt: NOW }],
        },
        sessionFailure: new FetchError({ url: 'https://notebooklm.google.com', cause: 'offline' }),
      })

      const result = yield* drainQueue({ now: NOW }).pipe(Effect.provide(fx.layer))

      assert.deepStrictEqual(result, {
        status: 'failed',
        jobId: 'f@example.com:nb-1:reddit:1:dbaa7975',
      })
      const finalQueue = fx.values.get(QUEUE_STORAGE_KEY) as ReturnType<typeof emptyQueue>
      assert.strictEqual(finalQueue.jobs[0]?.status, 'failed')
      assert.strictEqual(finalQueue.jobs[0]?.attempts, 5)
      assert.strictEqual(finalQueue.jobs[0]?.nextAttemptAt, undefined)
    }),
  )

  it.effect('blocks a job when its notebook is absent from the authenticated listing', () =>
    Effect.gen(function* () {
      const fx = runtime({ listedNotebookId: 'other-notebook' })

      const result = yield* drainQueue({ now: NOW }).pipe(Effect.provide(fx.layer))

      assert.deepStrictEqual(result, {
        status: 'blocked',
        jobId: 'f@example.com:nb-1:reddit:1:dbaa7975',
      })
      assert.strictEqual(fx.posts(), 0)
      const finalQueue = fx.values.get(QUEUE_STORAGE_KEY) as ReturnType<typeof emptyQueue>
      assert.strictEqual(
        finalQueue.jobs[0]?.lastError,
        'Notebook target is no longer available; choose the target again before retrying',
      )
    }),
  )

  it.effect('persists a terminal RPC client error without leaving the job inFlight', () =>
    Effect.gen(function* () {
      const fx = runtime({
        postFailure: new HttpStatusError({ url: 'https://rpc.test', status: 400 }),
      })

      const result = yield* drainQueue({ now: NOW }).pipe(Effect.provide(fx.layer))

      assert.deepStrictEqual(result, {
        status: 'failed',
        jobId: 'f@example.com:nb-1:reddit:1:dbaa7975',
      })
      const finalQueue = fx.values.get(QUEUE_STORAGE_KEY) as ReturnType<typeof emptyQueue>
      assert.strictEqual(finalQueue.jobs[0]?.status, 'failed')
      assert.strictEqual(finalQueue.jobs[0]?.attempts, 1)
    }),
  )

  it.effect(
    'uses DOM only after a read-only preflight protocol drift and records its receipt',
    () =>
      Effect.gen(function* () {
        const fx = runtime({
          listProtocolDrift: true,
          domAvailable: true,
          domResult: { status: 'sent' },
        })

        const result = yield* drainQueue({ now: NOW }).pipe(Effect.provide(fx.layer))

        assert.deepStrictEqual(result, {
          status: 'sent',
          jobId: 'f@example.com:nb-1:reddit:1:dbaa7975',
        })
        assert.strictEqual(fx.posts(), 0)
        assert.strictEqual(fx.listCalls(), 1)
        assert.deepStrictEqual(fx.domRequests, [{ notebookId: 'nb-1', authuser: 0, unit }])
        assert.deepStrictEqual(fx.values.get(TIER_STATE_STORAGE_KEY), {
          version: 1,
          tierADegradedUntilByAccount: {
            'f@example.com': '2026-07-11T00:10:00.000Z',
          },
        })
        const finalQueue = fx.values.get(QUEUE_STORAGE_KEY) as ReturnType<typeof emptyQueue>
        assert.strictEqual(finalQueue.jobs.length, 0)
      }),
  )

  it.effect('does not route a direct add-source protocol drift through DOM', () =>
    Effect.gen(function* () {
      const fx = runtime({ sourceResponse: protocolDriftResponse() })

      const result = yield* drainQueue({ now: NOW }).pipe(Effect.provide(fx.layer))

      assert.deepStrictEqual(result, {
        status: 'uncertain',
        jobId: 'f@example.com:nb-1:reddit:1:dbaa7975',
      })
      assert.strictEqual(fx.posts(), 1)
      assert.strictEqual(fx.domRequests.length, 0)
      const finalQueue = fx.values.get(QUEUE_STORAGE_KEY) as ReturnType<typeof emptyQueue>
      assert.strictEqual(finalQueue.jobs[0]?.status, 'uncertain')
    }),
  )

  it.effect('keeps a direct server refusal terminal instead of trying DOM', () =>
    Effect.gen(function* () {
      const fx = runtime({ sourceResponse: rpcRefusedResponse() })

      const result = yield* drainQueue({ now: NOW }).pipe(Effect.provide(fx.layer))

      assert.deepStrictEqual(result, {
        status: 'failed',
        jobId: 'f@example.com:nb-1:reddit:1:dbaa7975',
      })
      assert.strictEqual(fx.posts(), 1)
      assert.strictEqual(fx.domRequests.length, 0)
      const finalQueue = fx.values.get(QUEUE_STORAGE_KEY) as ReturnType<typeof emptyQueue>
      assert.strictEqual(finalQueue.jobs[0]?.status, 'failed')
    }),
  )

  it.effect('marks an unavailable DOM path failed without a receipt or RPC source mutation', () =>
    Effect.gen(function* () {
      const fx = runtime({
        listProtocolDrift: true,
        domAvailable: true,
        domResult: { status: 'unavailable', reason: 'No selector profile' },
      })

      const result = yield* drainQueue({ now: NOW }).pipe(Effect.provide(fx.layer))

      assert.deepStrictEqual(result, {
        status: 'failed',
        jobId: 'f@example.com:nb-1:reddit:1:dbaa7975',
      })
      assert.strictEqual(fx.posts(), 0)
      assert.strictEqual(fx.values.get('porter/ledger') !== undefined, true)
      assert.deepStrictEqual(fx.values.get('porter/ledger'), {})
      const finalQueue = fx.values.get(QUEUE_STORAGE_KEY) as ReturnType<typeof emptyQueue>
      assert.strictEqual(finalQueue.jobs[0]?.status, 'failed')
    }),
  )

  it.effect('blocks a read-only preflight drift when no DOM driver is available', () =>
    Effect.gen(function* () {
      const fx = runtime({ listProtocolDrift: true })

      const result = yield* drainQueue({ now: NOW }).pipe(Effect.provide(fx.layer))

      assert.deepStrictEqual(result, {
        status: 'blocked',
        jobId: 'f@example.com:nb-1:reddit:1:dbaa7975',
      })
      // No source mutation, no dead Tier B attempt, and no account-wide cooldown.
      assert.strictEqual(fx.posts(), 0)
      assert.strictEqual(fx.domRequests.length, 0)
      assert.strictEqual(fx.values.get(TIER_STATE_STORAGE_KEY), undefined)
      const finalQueue = fx.values.get(QUEUE_STORAGE_KEY) as ReturnType<typeof emptyQueue>
      assert.strictEqual(finalQueue.jobs[0]?.status, 'blocked')
      assert.strictEqual(
        finalQueue.jobs[0]?.lastError,
        'NotebookLM changed its notebook listing and no verified fallback is available yet',
      )
    }),
  )

  it.effect('skips the read-only canary only during the current account cooldown', () =>
    Effect.gen(function* () {
      const fx = runtime({
        tierState: {
          version: 1,
          tierADegradedUntilByAccount: { 'f@example.com': '2026-07-11T00:10:00.000Z' },
        },
        domAvailable: true,
        domResult: { status: 'uncertain', reason: 'DOM tab closed after submit' },
      })

      const result = yield* drainQueue({ now: NOW }).pipe(Effect.provide(fx.layer))

      assert.deepStrictEqual(result, {
        status: 'uncertain',
        jobId: 'f@example.com:nb-1:reddit:1:dbaa7975',
      })
      assert.strictEqual(fx.listCalls(), 0)
      assert.strictEqual(fx.posts(), 0)
      const finalQueue = fx.values.get(QUEUE_STORAGE_KEY) as ReturnType<typeof emptyQueue>
      assert.strictEqual(finalQueue.jobs[0]?.status, 'uncertain')
    }),
  )

  it('marks ambiguous source results uncertain and terminal client failures failed', () => {
    assert.strictEqual(
      classifyQueueFailure(new HttpStatusError({ url: 'https://rpc.test', status: 503 })).status,
      'uncertain',
    )
    assert.strictEqual(
      classifyQueueFailure(new HttpStatusError({ url: 'https://rpc.test', status: 400 })).status,
      'failed',
    )
    assert.strictEqual(
      classifyQueueFailure(new ProtocolDrift({ rpcId: RPC_IDS.addSource, snippet: 'drift' }))
        .status,
      'uncertain',
    )
  })
})
