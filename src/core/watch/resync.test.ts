import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import realMixPanel from '../adapters/youtube/fixture-mix-panel.json'
import { alarmsTest, debugLogTest, httpTest, kvTest } from '../fx/testing'
import { QUEUE_ALARM, QUEUE_STORAGE_KEY, emptyQueue, enqueueUnits } from '../queue/queue'
import { loadQueue } from '../queue/store'
import { contentHash } from '../store/ledger'
import { loadWatches } from './store'
import { resyncOneDueWatch } from './resync'
import { emptyWatches, upsertWatch, WATCH_ALARM } from './watch'

const NOW = '2026-07-11T00:00:00.000Z'
const EARLIER = '2026-07-10T18:00:00.000Z'
const target = { notebookId: 'notebook-1', authuser: 0, accountEmail: 'user@example.com' }
const HN_URL = 'https://news.ycombinator.com/item?id=42'
const HN_API_URL = 'https://hn.algolia.com/api/v1/items/42'
const HN_ITEM = { id: 42, author: 'op', title: 'An HN item', text: '<p>Body', children: [] }

function dueWatch(sourceUrl = HN_URL) {
  return upsertWatch(emptyWatches(), {
    sourceDocId: 'hackernews:42',
    sourceUrl,
    target,
    now: EARLIER,
  })
}

function firstWatchId(state: ReturnType<typeof dueWatch>): string {
  const id = state.watches[0]?.id
  if (id === undefined) throw new Error('expected a watch')
  return id
}

function layer(
  watches = dueWatch(),
  http: Record<string, string | string[]> = { [HN_API_URL]: JSON.stringify(HN_ITEM) },
  alarmCalls: Array<[string, number | 'clear']> = [],
  ledger: Record<string, unknown> = {},
  queue = emptyQueue(),
) {
  return Layer.mergeAll(
    kvTest({
      'porter/watch/v1': watches,
      'porter/ledger': ledger,
      [QUEUE_STORAGE_KEY]: queue,
    }),
    debugLogTest(),
    httpTest(http),
    alarmsTest({
      onSchedule: (name, when) => alarmCalls.push([name, when]),
      onClear: (name) => {
        alarmCalls.push([name, 'clear'])
        return true
      },
    }),
  )
}

// Mix playlist fixture — the one multi-unit doc kind (overview + per-video
// units) available without a continuation-walk, so a single resync tick can
// produce a genuinely mixed pending/synced batch.
const MIX_URL = 'https://www.youtube.com/watch?v=9UZKYgqcY8U&list=RD9UZKYgqcY8U&start_radio=1'
const MIX_FETCH_URL = 'https://www.youtube.com/watch?v=9UZKYgqcY8U&list=RD9UZKYgqcY8U'
const MIX_DOC_ID = 'youtube:RD9UZKYgqcY8U'
const MIX_VIDEO_IDS = ['9UZKYgqcY8U', 'ArmDp-zijuc', 'Km71Rr9K-Bw']

function mixHtml(): string {
  return `<html><body><script>
    var ytInitialData = ${JSON.stringify(realMixPanel)};
  </script></body></html>`
}

function mixWatch() {
  return upsertWatch(emptyWatches(), {
    sourceDocId: MIX_DOC_ID,
    sourceUrl: MIX_URL,
    target,
    now: EARLIER,
  })
}

/** youtube ingest units hash the canonical watch URL — deterministic, no capture needed. */
function videoUnitId(videoId: string): string {
  return `youtube:${videoId}`
}
function videoContentHash(videoId: string): string {
  return contentHash(`https://www.youtube.com/watch?v=${videoId}`)
}

describe('resyncOneDueWatch', () => {
  it.effect('recaptures a due source, enqueues immutable units, and advances the watch', () =>
    Effect.gen(function* () {
      const alarms: Array<[string, number | 'clear']> = []
      const testLayer = layer(dueWatch(), undefined, alarms)
      const result = yield* resyncOneDueWatch({ now: NOW }).pipe(Effect.provide(testLayer))

      assert.deepStrictEqual(result, {
        status: 'queued',
        watchId: firstWatchId(dueWatch()),
        docId: 'hackernews:42',
      })
      const queue = yield* loadQueue().pipe(Effect.provide(testLayer))
      assert.strictEqual(queue.jobs.length, 1)
      assert.strictEqual(queue.jobs[0]?.unit.id, 'hackernews:42')
      const watches = yield* loadWatches().pipe(Effect.provide(testLayer))
      assert.strictEqual(watches.watches[0]?.lastResyncedAt, NOW)
      assert.isTrue(alarms.some(([name]) => name === WATCH_ALARM))
    }),
  )

  it.effect('records a safe failure and retries on the ordinary watch cadence', () =>
    Effect.gen(function* () {
      const testLayer = layer(dueWatch(), {})
      const result = yield* resyncOneDueWatch({ now: NOW }).pipe(Effect.provide(testLayer))

      assert.deepStrictEqual(result, { status: 'failed', watchId: firstWatchId(dueWatch()) })
      const watches = yield* loadWatches().pipe(Effect.provide(testLayer))
      assert.strictEqual(watches.watches[0]?.lastError, 'Could not recapture source')
    }),
  )

  it.effect('disables a source that cannot be captured in the background', () =>
    Effect.gen(function* () {
      const state = dueWatch('https://x.com/porter/status/42')
      const testLayer = layer(state)
      const result = yield* resyncOneDueWatch({ now: NOW }).pipe(Effect.provide(testLayer))

      assert.deepStrictEqual(result, { status: 'disabled', watchId: firstWatchId(state) })
      const watches = yield* loadWatches().pipe(Effect.provide(testLayer))
      assert.strictEqual(watches.watches[0]?.status, 'disabled')
    }),
  )

  it.effect('arms the next watch when nothing is due', () =>
    Effect.gen(function* () {
      const alarms: Array<[string, number | 'clear']> = []
      const state = upsertWatch(emptyWatches(), {
        sourceDocId: 'hackernews:42',
        sourceUrl: HN_URL,
        target,
        now: NOW,
      })
      const result = yield* resyncOneDueWatch({ now: NOW }).pipe(
        Effect.provide(layer(state, undefined, alarms)),
      )

      assert.deepStrictEqual(result, { status: 'idle' })
      assert.isTrue(alarms.some(([name]) => name === WATCH_ALARM))
    }),
  )
})

describe('resyncOneDueWatch — ledger dedup', () => {
  it.effect(
    'skips enqueue and the queue alarm when every recaptured unit is already receipted',
    () =>
      Effect.gen(function* () {
        // Learn the unit's stable contentHash from an ordinary (unseeded) resync.
        const probeLayer = layer(dueWatch())
        yield* resyncOneDueWatch({ now: NOW }).pipe(Effect.provide(probeLayer))
        const probed = yield* loadQueue().pipe(Effect.provide(probeLayer))
        const unit = probed.jobs[0]?.unit
        if (unit === undefined) throw new Error('expected a probed unit')

        const alarms: Array<[string, number | 'clear']> = []
        const ledger = {
          [target.notebookId]: {
            [unit.id]: { contentHash: unit.contentHash, lastSynced: EARLIER },
          },
        }
        const testLayer = layer(dueWatch(), undefined, alarms, ledger)
        const result = yield* resyncOneDueWatch({ now: NOW }).pipe(Effect.provide(testLayer))

        assert.deepStrictEqual(result, {
          status: 'queued',
          watchId: firstWatchId(dueWatch()),
          docId: 'hackernews:42',
        })
        const queue = yield* loadQueue().pipe(Effect.provide(testLayer))
        assert.strictEqual(queue.jobs.length, 0)
        assert.isFalse(alarms.some(([name]) => name === QUEUE_ALARM))
        const watches = yield* loadWatches().pipe(Effect.provide(testLayer))
        assert.strictEqual(watches.watches[0]?.lastResyncedAt, NOW)
      }),
  )

  it.effect('wakes the drain to remove a queued unit that became receipted', () =>
    Effect.gen(function* () {
      const probeLayer = layer(dueWatch())
      yield* resyncOneDueWatch({ now: NOW }).pipe(Effect.provide(probeLayer))
      const probed = yield* loadQueue().pipe(Effect.provide(probeLayer))
      const unit = probed.jobs[0]?.unit
      if (unit === undefined) throw new Error('expected a probed unit')

      const ledger = {
        [target.notebookId]: {
          [unit.id]: { contentHash: unit.contentHash, lastSynced: EARLIER },
        },
      }
      const queue = enqueueUnits(emptyQueue(), target, [unit], EARLIER)
      const alarms: Array<[string, number | 'clear']> = []
      const testLayer = layer(dueWatch(), undefined, alarms, ledger, queue)

      yield* resyncOneDueWatch({ now: NOW }).pipe(Effect.provide(testLayer))

      const persisted = yield* loadQueue().pipe(Effect.provide(testLayer))
      assert.strictEqual(persisted.jobs.length, 1)
      assert.isTrue(alarms.some(([name]) => name === QUEUE_ALARM))
    }),
  )

  it.effect('enqueues only the units not already receipted, from a mixed playlist batch', () =>
    Effect.gen(function* () {
      const [syncedVideoId, pendingVideoIdA, pendingVideoIdB] = MIX_VIDEO_IDS
      if (
        syncedVideoId === undefined ||
        pendingVideoIdA === undefined ||
        pendingVideoIdB === undefined
      ) {
        throw new Error('expected three fixture video ids')
      }
      const ledger = {
        [target.notebookId]: {
          [videoUnitId(syncedVideoId)]: {
            contentHash: videoContentHash(syncedVideoId),
            lastSynced: EARLIER,
          },
        },
      }
      const alarms: Array<[string, number | 'clear']> = []
      const testLayer = Layer.mergeAll(
        kvTest({ 'porter/watch/v1': mixWatch(), 'porter/ledger': ledger }),
        debugLogTest(),
        httpTest({ [MIX_FETCH_URL]: mixHtml() }),
        alarmsTest({
          onSchedule: (name, when) => alarms.push([name, when]),
          onClear: (name) => {
            alarms.push([name, 'clear'])
            return true
          },
        }),
      )

      const result = yield* resyncOneDueWatch({ now: NOW }).pipe(Effect.provide(testLayer))
      assert.strictEqual(result.status, 'queued')

      const queue = yield* loadQueue().pipe(Effect.provide(testLayer))
      const queuedUnitIds = queue.jobs.map((job) => job.unit.id).toSorted()
      assert.deepStrictEqual(
        queuedUnitIds,
        [
          `${MIX_DOC_ID}:toc`,
          videoUnitId(pendingVideoIdA),
          videoUnitId(pendingVideoIdB),
        ].toSorted(),
      )
      assert.isFalse(queuedUnitIds.includes(videoUnitId(syncedVideoId)))
      assert.isTrue(alarms.some(([name]) => name === QUEUE_ALARM))
    }),
  )
})
