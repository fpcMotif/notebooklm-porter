import { assert, describe, it } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { alarmsTest, debugLogTest, httpTest, kvTest } from '../fx/testing'
import { loadQueue } from '../queue/store'
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
) {
  return Layer.mergeAll(
    kvTest({ 'porter/watch/v1': watches }),
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
