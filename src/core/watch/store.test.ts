import { assert, describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { kvTest } from '../fx/testing'
import { loadWatches } from './store'
import { watchId, WATCH_STORAGE_KEY } from './watch'

const NOW = '2026-07-11T00:00:00.000Z'
const target = { notebookId: 'nb-1', authuser: 0, accountEmail: 'a@example.com' }

function storedWatch(extra: Record<string, unknown>) {
  return {
    id: 'w1',
    sourceDocId: 'youtube:PL1',
    sourceUrl: 'https://www.youtube.com/playlist?list=PL1',
    target,
    intervalMs: 1000,
    status: 'active' as const,
    nextRunAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...extra,
  }
}

describe('loadWatches migration', () => {
  it.effect('falls back to empty state for malformed roots', () =>
    Effect.gen(function* () {
      for (const seed of [null, [], {}, { version: 2, watches: [] }, { version: 1, watches: {} }]) {
        const state = yield* loadWatches().pipe(
          Effect.provide(kvTest({ [WATCH_STORAGE_KEY]: seed })),
        )
        assert.deepStrictEqual(state, { version: 1, watches: [] })
      }
    }),
  )

  it.effect('drops corrupt rows while keeping valid sibling watches', () =>
    Effect.gen(function* () {
      const valid = storedWatch({})
      const seed = {
        version: 1,
        watches: [
          storedWatch({ target: { ...target, authuser: -1 } }),
          storedWatch({ nextRunAt: 'not a timestamp' }),
          storedWatch({ captureOptions: { enrichTranscripts: false } }),
          valid,
        ],
      }
      const state = yield* loadWatches().pipe(Effect.provide(kvTest({ [WATCH_STORAGE_KEY]: seed })))

      assert.strictEqual(state.watches.length, 1)
      const watch = state.watches[0]
      assert.strictEqual(watch?.id, watchId('youtube:PL1', target))
      assert.notStrictEqual(watch, valid)
      assert.notStrictEqual(watch?.target, valid.target)
      assert.deepStrictEqual(valid, storedWatch({}))
    }),
  )

  it.effect('rejects inherited required fields and explicit undefined optionals', () =>
    Effect.gen(function* () {
      const inherited = Object.create({ sourceDocId: 'youtube:PL1' }) as Record<string, unknown>
      Object.assign(inherited, storedWatch({}))
      delete inherited.sourceDocId
      const seed = {
        version: 1,
        watches: [
          inherited,
          storedWatch({ lastError: undefined }),
          storedWatch({ captureOptions: undefined }),
        ],
      }
      const state = yield* loadWatches().pipe(Effect.provide(kvTest({ [WATCH_STORAGE_KEY]: seed })))

      assert.deepStrictEqual(state, { version: 1, watches: [] })
    }),
  )

  it.effect('keeps parseable unsupported URLs so resync can disable them', () =>
    Effect.gen(function* () {
      const seed = {
        version: 1,
        watches: [
          storedWatch({ sourceUrl: 'not a URL' }),
          storedWatch({ sourceUrl: 'https://news.ycombinator.com/newest' }),
        ],
      }
      const state = yield* loadWatches().pipe(Effect.provide(kvTest({ [WATCH_STORAGE_KEY]: seed })))

      assert.deepStrictEqual(
        state.watches.map((watch) => watch.sourceUrl),
        ['https://news.ycombinator.com/newest'],
      )
    }),
  )

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

      assert.strictEqual(state.watches[0]?.id, watchId('youtube:PL1', target))
      assert.deepStrictEqual(state.watches[0]?.captureOptions, { enrichTranscripts: true })
    }),
  )

  it.effect('leaves a record with no enrichment preference free of captureOptions', () =>
    Effect.gen(function* () {
      const seed = { version: 1, watches: [storedWatch({})] }
      const state = yield* loadWatches().pipe(Effect.provide(kvTest({ [WATCH_STORAGE_KEY]: seed })))

      assert.isUndefined(state.watches[0]?.captureOptions)
    }),
  )

  it.effect('rejects a false legacy flag and keeps canonical options over the legacy flag', () =>
    Effect.gen(function* () {
      const seed = {
        version: 1,
        watches: [
          storedWatch({ enrichYoutube: false }),
          storedWatch({ captureOptions: { enrichTranscripts: true }, enrichYoutube: true }),
        ],
      }
      const state = yield* loadWatches().pipe(Effect.provide(kvTest({ [WATCH_STORAGE_KEY]: seed })))

      assert.strictEqual(state.watches.length, 1)
      assert.deepStrictEqual(state.watches[0]?.captureOptions, { enrichTranscripts: true })
      assert.notProperty(state.watches[0], 'enrichYoutube')
    }),
  )

  it.effect(
    'rekeys legacy IDs from each complete target and preserves authuser-distinct watches',
    () =>
      Effect.gen(function* () {
        const otherSlot = { ...target, authuser: 1 }
        const seed = {
          version: 1,
          watches: [
            storedWatch({ id: 'youtube:PL1:a@example.com:nb-1' }),
            storedWatch({ id: 'youtube:PL1:a@example.com:nb-1', target: otherSlot }),
          ],
        }
        const state = yield* loadWatches().pipe(
          Effect.provide(kvTest({ [WATCH_STORAGE_KEY]: seed })),
        )

        assert.deepStrictEqual(
          state.watches.map((watch) => watch.id),
          [watchId('youtube:PL1', target), watchId('youtube:PL1', otherSlot)],
        )
        assert.strictEqual(state.watches.length, 2)
      }),
  )

  it.effect('keeps only the first valid row after canonical ID rekeying', () =>
    Effect.gen(function* () {
      const seed = {
        version: 1,
        watches: [
          storedWatch({ id: 'old-one', sourceUrl: 'https://news.ycombinator.com/item?id=1' }),
          storedWatch({ id: 'old-two', sourceUrl: 'https://news.ycombinator.com/item?id=2' }),
        ],
      }
      const state = yield* loadWatches().pipe(Effect.provide(kvTest({ [WATCH_STORAGE_KEY]: seed })))

      assert.strictEqual(state.watches.length, 1)
      assert.deepStrictEqual(state.watches[0], {
        ...storedWatch({ sourceUrl: 'https://news.ycombinator.com/item?id=1' }),
        id: watchId('youtube:PL1', target),
      })
    }),
  )
})
