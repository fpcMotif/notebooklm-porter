import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { kvTest } from '../fx/testing'
import { loadWatches } from './store'
import { WATCH_STORAGE_KEY } from './watch'

const NOW = '2026-07-11T00:00:00.000Z'
const target = { notebookId: 'nb-1', authuser: 0, accountEmail: 'a@example.com' }

function storedWatch(extra: Record<string, unknown>) {
  return {
    id: 'w1',
    sourceDocId: 'youtube:PL1',
    sourceUrl: 'https://www.youtube.com/playlist?list=PL1',
    target,
    intervalMs: 1000,
    status: 'active',
    nextRunAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  }
}

describe('loadWatches migration', () => {
  it.effect('folds a legacy enrichYoutube flag into captureOptions and drops the old key', () =>
    Effect.gen(function* () {
      const seed = { version: 1, watches: [storedWatch({ enrichYoutube: true })] }
      const state = yield* loadWatches().pipe(Effect.provide(kvTest({ [WATCH_STORAGE_KEY]: seed })))

      const watch = state.watches[0]
      assert.deepStrictEqual(watch?.captureOptions, { enrichTranscripts: true })
      assert.notProperty(watch, 'enrichYoutube')
    }),
  )

  it.effect('passes an already-migrated record through untouched', () =>
    Effect.gen(function* () {
      const migrated = storedWatch({ captureOptions: { enrichTranscripts: true } })
      const seed = { version: 1, watches: [migrated] }
      const state = yield* loadWatches().pipe(Effect.provide(kvTest({ [WATCH_STORAGE_KEY]: seed })))

      assert.deepStrictEqual(state.watches[0], migrated)
    }),
  )

  it.effect('leaves a record with no enrichment preference free of captureOptions', () =>
    Effect.gen(function* () {
      const seed = { version: 1, watches: [storedWatch({})] }
      const state = yield* loadWatches().pipe(Effect.provide(kvTest({ [WATCH_STORAGE_KEY]: seed })))

      assert.isUndefined(state.watches[0]?.captureOptions)
    }),
  )
})
