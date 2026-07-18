import { Effect } from 'effect'
import type { StorageError } from '../fx/errors'
import { kvSlot } from '../fx/kv-slot'
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

/** Preserves the pre-slot decode exactly: no shape validation, just the legacy migration. */
function decodeWatchState(stored: unknown): WatchState {
  const state = stored as { version: 1; watches: StoredWatch[] }
  return { ...state, watches: state.watches.map(migrateWatch) }
}

/** Thin persistence wrapper; state transitions remain pure in watch.ts. */
const watchesSlot = kvSlot<WatchState>(WATCH_STORAGE_KEY, emptyWatches, decodeWatchState)

export function loadWatches(): Effect.Effect<WatchState, StorageError, Kv> {
  return watchesSlot.load()
}

export function saveWatches(watches: WatchState): Effect.Effect<void, StorageError, Kv> {
  return watchesSlot.save(watches)
}
