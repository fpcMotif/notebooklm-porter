import { describe, expect, it } from 'vitest'
import type { CaptureOptions } from '../adapters/types'
import {
  disableWatch,
  emptyWatches,
  nextWatchDueAt,
  pickDueWatch,
  removeWatchesForSourceDoc,
  removeWatch,
  rescheduleWatchFailure,
  rescheduleWatchSuccess,
  upsertWatch,
  WATCH_INTERVAL_MS,
  watchId,
  watchSnapshot,
} from './watch'

const NOW = '2026-07-11T00:00:00.000Z'
const target = { notebookId: 'notebook-1', authuser: 0, accountEmail: 'user@example.com' }

function create(sourceDocId = 'reddit:one', sourceUrl = 'https://reddit.com/r/test/comments/one') {
  return upsertWatch(emptyWatches(), { sourceDocId, sourceUrl, target, now: NOW })
}

describe('watch lifecycle', () => {
  it('creates a six-hour, target-bound watch', () => {
    const state = create()
    const watch = state.watches[0]

    expect(watch).toMatchObject({
      id: watchId('reddit:one', target),
      sourceDocId: 'reddit:one',
      status: 'active',
      nextRunAt: new Date(Date.parse(NOW) + WATCH_INTERVAL_MS).toISOString(),
    })
  })

  it('re-enables the same binding without duplicating it', () => {
    const first = create()
    const disabled = disableWatch(first, first.watches[0]?.id ?? '', 'unsupported', NOW)
    const next = upsertWatch(disabled, {
      sourceDocId: 'reddit:one',
      sourceUrl: 'https://reddit.com/r/test/comments/one',
      target,
      now: '2026-07-12T00:00:00.000Z',
    })

    expect(next.watches).toHaveLength(1)
    expect(next.watches[0]).toMatchObject({ status: 'active', createdAt: NOW })
    expect(next.watches[0]?.lastError).toBeUndefined()
  })

  it('persists an explicit transcript enrichment preference', () => {
    const captureOptions: CaptureOptions = { enrichTranscripts: true }
    const state = upsertWatch(emptyWatches(), {
      sourceDocId: 'youtube:PL1',
      sourceUrl: 'https://www.youtube.com/playlist?list=PL1',
      target,
      now: NOW,
      captureOptions,
    })

    expect(state.watches[0]?.captureOptions).toEqual({ enrichTranscripts: true })
    expect(state.watches[0]?.captureOptions).not.toBe(captureOptions)
    delete captureOptions.enrichTranscripts
    expect(state.watches[0]?.captureOptions).toEqual({ enrichTranscripts: true })
  })

  it('omits an empty capture preference from canonical state', () => {
    const state = upsertWatch(emptyWatches(), {
      sourceDocId: 'youtube:PL1',
      sourceUrl: 'https://www.youtube.com/playlist?list=PL1',
      target,
      now: NOW,
      captureOptions: {},
    })

    expect(state.watches[0]?.captureOptions).toBeUndefined()
  })

  it('removes only the requested watch', () => {
    const first = create()
    const second = upsertWatch(first, {
      sourceDocId: 'hn:2',
      sourceUrl: 'https://news.ycombinator.com/item?id=2',
      target,
      now: NOW,
    })

    expect(removeWatch(second, first.watches[0]?.id ?? '').watches).toEqual([second.watches[1]])
  })

  it('removes every target binding when its source document is deleted', () => {
    const first = create()
    const anotherTarget = { ...target, notebookId: 'notebook-2' }
    const second = upsertWatch(first, {
      sourceDocId: 'reddit:one',
      sourceUrl: 'https://reddit.com/r/test/comments/one',
      target: anotherTarget,
      now: NOW,
    })

    expect(removeWatchesForSourceDoc(second, 'reddit:one').watches).toEqual([])
  })

  it('keeps same-email watches in separate authuser slots', () => {
    const first = create()
    const otherSlot = { ...target, authuser: 1 }
    const next = upsertWatch(first, {
      sourceDocId: 'reddit:one',
      sourceUrl: 'https://reddit.com/r/test/comments/one',
      target: otherSlot,
      now: NOW,
    })

    expect(next.watches).toHaveLength(2)
    expect(next.watches.map((watch) => watch.id)).toEqual([
      watchId('reddit:one', target),
      watchId('reddit:one', otherSlot),
    ])
  })
})

describe('watch scheduling', () => {
  it('selects the earliest due active watch and ignores disabled watches', () => {
    const due = upsertWatch(emptyWatches(), {
      sourceDocId: 'hn:1',
      sourceUrl: 'https://news.ycombinator.com/item?id=1',
      target,
      now: '2026-07-10T18:00:00.000Z',
    })
    const later = upsertWatch(due, {
      sourceDocId: 'reddit:2',
      sourceUrl: 'https://reddit.com/r/test/comments/2',
      target,
      now: NOW,
    })
    const disabled = disableWatch(later, later.watches[0]?.id ?? '', 'unsupported', NOW)

    expect(pickDueWatch(disabled, NOW)?.sourceDocId).toBeUndefined()
    expect(nextWatchDueAt(disabled)).toBe(later.watches[1]?.nextRunAt)
  })

  it('advances successful and failed capture attempts without mutating prior state', () => {
    const state = create()
    const id = state.watches[0]?.id ?? ''
    const successful = rescheduleWatchSuccess(state, id, '2026-07-11T06:00:00.000Z')
    const failed = rescheduleWatchFailure(
      successful,
      id,
      'network unavailable',
      '2026-07-11T12:00:00.000Z',
    )

    expect(state.watches[0]?.lastResyncedAt).toBeUndefined()
    expect(successful.watches[0]?.lastResyncedAt).toBe('2026-07-11T06:00:00.000Z')
    expect(successful.watches[0]?.lastError).toBeUndefined()
    expect(failed.watches[0]).toMatchObject({
      status: 'active',
      lastError: 'network unavailable',
      nextRunAt: '2026-07-11T18:00:00.000Z',
    })
  })

  it('projects only popup-safe watch fields and detaches the target', () => {
    const state = create()
    const snapshot = watchSnapshot(state)
    expect(snapshot).toEqual([
      {
        id: watchId('reddit:one', target),
        sourceDocId: 'reddit:one',
        target,
        status: 'active',
        nextRunAt: '2026-07-11T06:00:00.000Z',
      },
    ])
    expect(snapshot[0]?.target).not.toBe(state.watches[0]?.target)
  })
})
