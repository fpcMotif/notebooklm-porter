import { Effect } from 'effect'
import type { StorageError } from '../fx/errors'
import { Kv } from '../fx/services'
import { emptyWatches, WATCH_STORAGE_KEY, type Watch, type WatchState } from './watch'

/** A persisted watch that may still carry the pre-`captureOptions` YouTube flag. */
type StoredWatch = Watch & { enrichYoutube?: true }

/** Folds a legacy `enrichYoutube` flag into `captureOptions`, dropping the old key. */
function migrateWatch(stored: StoredWatch): Watch {
  const { enrichYoutube, ...watch } = stored
  return watch.captureOptions === undefined && enrichYoutube === true
    ? { ...watch, captureOptions: { enrichTranscripts: true } }
    : watch
}

/** Thin persistence wrapper; state transitions remain pure in watch.ts. */
export function loadWatches(): Effect.Effect<WatchState, StorageError, Kv> {
  return Effect.gen(function* () {
    const kv = yield* Kv
    const stored = yield* kv.get<{ version: 1; watches: StoredWatch[] }>(WATCH_STORAGE_KEY)
    if (stored === undefined) return emptyWatches()
    return { ...stored, watches: stored.watches.map(migrateWatch) }
  })
}

export function saveWatches(watches: WatchState): Effect.Effect<void, StorageError, Kv> {
  return Effect.gen(function* () {
    const kv = yield* Kv
    yield* kv.set(WATCH_STORAGE_KEY, watches)
  })
}
