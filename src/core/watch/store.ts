import { Effect } from 'effect'
import type { StorageError } from '../fx/errors'
import { Kv } from '../fx/services'
import { emptyWatches, WATCH_STORAGE_KEY, type WatchState } from './watch'

/** Thin persistence wrapper; state transitions remain pure in watch.ts. */
export function loadWatches(): Effect.Effect<WatchState, StorageError, Kv> {
  return Effect.gen(function* () {
    const kv = yield* Kv
    return (yield* kv.get<WatchState>(WATCH_STORAGE_KEY)) ?? emptyWatches()
  })
}

export function saveWatches(watches: WatchState): Effect.Effect<void, StorageError, Kv> {
  return Effect.gen(function* () {
    const kv = yield* Kv
    yield* kv.set(WATCH_STORAGE_KEY, watches)
  })
}
