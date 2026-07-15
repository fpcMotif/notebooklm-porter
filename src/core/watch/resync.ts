import { Effect, Result } from 'effect'
import { adapterForUrl } from '../adapters/registry'
import type { AlarmError, StorageError } from '../fx/errors'
import { Alarms, DebugLog, Http, Kv } from '../fx/services'
import { formatCapture } from '../format/format'
import { planIngestUnits } from '../ingest/units'
import { QUEUE_ALARM, enqueueUnits, supersedePendingUnitVersions } from '../queue/queue'
import { loadQueue, saveQueue } from '../queue/store'
import { upsertDoc } from '../store'
import { loadWatches, saveWatches } from './store'
import {
  disableWatch,
  nextWatchDueAt,
  pickDueWatch,
  rescheduleWatchFailure,
  rescheduleWatchSuccess,
  WATCH_ALARM,
} from './watch'

export type WatchResyncResult =
  | { status: 'idle' }
  | { status: 'queued'; watchId: string; docId: string }
  | { status: 'failed'; watchId: string }
  | { status: 'disabled'; watchId: string }

/** Arms the one durable alarm at the earliest active watch, or clears it. */
export function armNextWatch(
  watches: Parameters<typeof nextWatchDueAt>[0],
): Effect.Effect<void, AlarmError, Alarms> {
  return Effect.gen(function* () {
    const alarms = yield* Alarms
    const due = nextWatchDueAt(watches)
    if (due === undefined) {
      yield* alarms.clear(WATCH_ALARM)
      return
    }
    yield* alarms.schedule(WATCH_ALARM, Date.parse(due))
  })
}

/**
 * Recaptures and queues exactly one due watch. It never sends a NotebookLM
 * source itself: the existing receipt-aware queue owns that remote mutation.
 */
export function resyncOneDueWatch(
  opts: { now?: string } = {},
): Effect.Effect<WatchResyncResult, StorageError | AlarmError, Http | DebugLog | Kv | Alarms> {
  return Effect.gen(function* () {
    const now = opts.now ?? new Date().toISOString()
    const debugLog = yield* DebugLog
    const watches = yield* loadWatches()
    const watch = pickDueWatch(watches, now)
    if (watch === undefined) {
      yield* armNextWatch(watches)
      return { status: 'idle' }
    }
    const run = watch.id
    yield* debugLog.log(
      'watch',
      'resync tick',
      {
        sourceDocId: watch.sourceDocId,
        enrich: watch.captureOptions?.enrichTranscripts === true,
        totalWatches: watches.watches.length,
      },
      { run },
    )

    const adapter = adapterForUrl(watch.sourceUrl)
    if (
      adapter === undefined ||
      adapter.strategy.mode !== 'url' ||
      adapter.detect(watch.sourceUrl) === null
    ) {
      const disabled = disableWatch(
        watches,
        watch.id,
        'This source no longer supports background resync',
        now,
      )
      yield* debugLog.log(
        'watch',
        'disabled: adapter unsupported',
        { adapterId: adapter?.id ?? 'none' },
        { run, level: 'warn' },
      )
      yield* saveWatches(disabled)
      yield* armNextWatch(disabled)
      return { status: 'disabled', watchId: watch.id }
    }

    const captured = yield* Effect.result(
      adapter.strategy.capture(watch.sourceUrl, watch.captureOptions),
    )
    if (Result.isFailure(captured)) {
      const failed = rescheduleWatchFailure(watches, watch.id, 'Could not recapture source', now)
      yield* debugLog.log(
        'watch',
        'recapture failed',
        { adapterId: adapter.id, error: String(captured.failure) },
        { run, level: 'warn' },
      )
      yield* saveWatches(failed)
      yield* armNextWatch(failed)
      return { status: 'failed', watchId: watch.id }
    }

    const doc = formatCapture(captured.success)
    if (doc.id !== watch.sourceDocId) {
      const disabled = disableWatch(
        watches,
        watch.id,
        'The recaptured source no longer matches this watch',
        now,
      )
      yield* debugLog.log(
        'watch',
        'disabled: source drift',
        { expectedDocId: watch.sourceDocId, recapturedDocId: doc.id },
        { run, level: 'warn' },
      )
      yield* saveWatches(disabled)
      yield* armNextWatch(disabled)
      return { status: 'disabled', watchId: watch.id }
    }
    yield* upsertDoc(doc)
    const queue = yield* loadQueue()
    const units = planIngestUnits(doc)
    const withoutSuperseded = supersedePendingUnitVersions(queue, watch.target, units)
    const nextQueue = enqueueUnits(withoutSuperseded, watch.target, units, now)
    yield* saveQueue(nextQueue)

    const complete = rescheduleWatchSuccess(watches, watch.id, now)
    yield* saveWatches(complete)
    yield* armNextWatch(complete)
    const alarms = yield* Alarms
    yield* alarms.schedule(QUEUE_ALARM, Date.parse(now))
    yield* debugLog.log(
      'watch',
      'resynced',
      { docId: doc.id, unitCount: units.length, notebookId: watch.target.notebookId },
      { run },
    )
    return { status: 'queued', watchId: watch.id, docId: doc.id }
  })
}
