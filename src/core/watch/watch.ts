import type { CaptureOptions } from '../adapters/types'
import type { QueueTarget } from '../queue/queue'

export const WATCH_INTERVAL_MS = 6 * 60 * 60 * 1_000
export const WATCH_ALARM = 'porter/watch-resync'
export const WATCH_STORAGE_KEY = 'porter/watch/v1'

export type WatchStatus = 'active' | 'disabled'

/** A durable, account-bound request to recapture and queue one source. */
export interface Watch {
  id: string
  sourceDocId: string
  sourceUrl: string
  target: QueueTarget
  /** Preserve the user's explicit transcript-capture choice on every run. */
  captureOptions?: CaptureOptions
  intervalMs: number
  status: WatchStatus
  nextRunAt: string
  createdAt: string
  updatedAt: string
  lastResyncedAt?: string
  lastError?: string
}

export interface WatchState {
  version: 1
  watches: Watch[]
}

export interface WatchView {
  id: string
  sourceDocId: string
  notebookId: string
  status: WatchStatus
  nextRunAt: string
  lastResyncedAt?: string
  lastError?: string
}

export interface CreateWatchInput {
  sourceDocId: string
  sourceUrl: string
  target: QueueTarget
  captureOptions?: CaptureOptions
  now: string
  intervalMs?: number
}

function nextRunAt(now: string, intervalMs: number): string {
  return new Date(Date.parse(now) + intervalMs).toISOString()
}

/** Stable per source + account + notebook; a re-enable updates this binding. */
export function watchId(sourceDocId: string, target: QueueTarget): string {
  return [sourceDocId, target.accountEmail, target.notebookId].join(':')
}

export function emptyWatches(): WatchState {
  return { version: 1, watches: [] }
}

/** Creates or re-enables a target-bound watch without mutating existing state. */
export function upsertWatch(state: WatchState, input: CreateWatchInput): WatchState {
  const intervalMs = input.intervalMs ?? WATCH_INTERVAL_MS
  const id = watchId(input.sourceDocId, input.target)
  const existing = state.watches.find((watch) => watch.id === id)
  const next: Watch = {
    id,
    sourceDocId: input.sourceDocId,
    sourceUrl: input.sourceUrl,
    target: { ...input.target },
    ...(input.captureOptions !== undefined ? { captureOptions: input.captureOptions } : {}),
    intervalMs,
    status: 'active',
    nextRunAt: nextRunAt(input.now, intervalMs),
    createdAt: existing?.createdAt ?? input.now,
    updatedAt: input.now,
    ...(existing?.lastResyncedAt !== undefined ? { lastResyncedAt: existing.lastResyncedAt } : {}),
  }
  return {
    ...state,
    watches:
      existing === undefined
        ? [...state.watches, next]
        : state.watches.map((watch) => (watch.id === id ? next : watch)),
  }
}

export function removeWatch(state: WatchState, id: string): WatchState {
  return { ...state, watches: state.watches.filter((watch) => watch.id !== id) }
}

/** Deleting a captured source also disables its future automatic recreation. */
export function removeWatchesForSourceDoc(state: WatchState, sourceDocId: string): WatchState {
  return {
    ...state,
    watches: state.watches.filter((watch) => watch.sourceDocId !== sourceDocId),
  }
}

/** Returns the earliest active watch due at or before `now`. */
export function pickDueWatch(state: WatchState, now: string): Watch | undefined {
  return state.watches
    .filter((watch) => watch.status === 'active' && watch.nextRunAt <= now)
    .toSorted((left, right) => left.nextRunAt.localeCompare(right.nextRunAt))[0]
}

export function nextWatchDueAt(state: WatchState): string | undefined {
  return state.watches
    .filter((watch) => watch.status === 'active')
    .map((watch) => watch.nextRunAt)
    .toSorted()[0]
}

function replaceWatch(state: WatchState, id: string, update: (watch: Watch) => Watch): WatchState {
  return {
    ...state,
    watches: state.watches.map((watch) => (watch.id === id ? update(watch) : watch)),
  }
}

export function rescheduleWatchSuccess(state: WatchState, id: string, now: string): WatchState {
  return replaceWatch(state, id, (watch) => {
    const { lastError: _lastError, ...rest } = watch
    return {
      ...rest,
      status: 'active',
      nextRunAt: nextRunAt(now, watch.intervalMs),
      lastResyncedAt: now,
      updatedAt: now,
    }
  })
}

/** Capture failures are safe to retry on the normal cadence: no remote send occurred here. */
export function rescheduleWatchFailure(
  state: WatchState,
  id: string,
  error: string,
  now: string,
): WatchState {
  return replaceWatch(state, id, (watch) => ({
    ...watch,
    status: 'active',
    nextRunAt: nextRunAt(now, watch.intervalMs),
    lastError: error,
    updatedAt: now,
  }))
}

/** Stops an unsupported source rather than silently retrying forever. */
export function disableWatch(
  state: WatchState,
  id: string,
  error: string,
  now: string,
): WatchState {
  return replaceWatch(state, id, (watch) => ({
    ...watch,
    status: 'disabled',
    lastError: error,
    updatedAt: now,
  }))
}

export function watchSnapshot(state: WatchState): WatchView[] {
  return state.watches.map((watch) => ({
    id: watch.id,
    sourceDocId: watch.sourceDocId,
    notebookId: watch.target.notebookId,
    status: watch.status,
    nextRunAt: watch.nextRunAt,
    ...(watch.lastResyncedAt !== undefined ? { lastResyncedAt: watch.lastResyncedAt } : {}),
    ...(watch.lastError !== undefined ? { lastError: watch.lastError } : {}),
  }))
}
