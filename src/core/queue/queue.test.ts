import { describe, expect, it } from 'vitest'
import type { IngestUnit } from '../ingest/units'
import {
  emptyQueue,
  enqueueUnits,
  markInFlight,
  pickNext,
  reapInterrupted,
  retryJob,
  settleRetryableFailure,
  settleTerminalFailure,
  summarizeQueue,
  supersedePendingUnitVersions,
  type QueueJobView,
  type QueueSnapshot,
} from './queue'

const NOW = '2026-07-11T00:00:00.000Z'
const target = { notebookId: 'nb-1', authuser: 0, accountEmail: 'f@example.com' }
const secondTarget = { notebookId: 'nb-2', authuser: 0, accountEmail: 'f@example.com' }
type TextUnit = Extract<IngestUnit, { kind: 'text' }>

function unit(overrides: Partial<TextUnit> = {}): TextUnit {
  return {
    kind: 'text',
    docId: 'reddit:1',
    id: 'reddit:1',
    contentHash: 'hash-1',
    title: 'Thread',
    markdown: '# Thread',
    ...overrides,
  }
}

describe('ingest queue', () => {
  it('deduplicates the same unit version while retaining every source document owner', () => {
    const first = enqueueUnits(emptyQueue(), target, [unit()], NOW)
    const second = enqueueUnits(first, target, [unit({ docId: 'reddit:2' })], NOW)

    expect(second.jobs).toHaveLength(1)
    expect(second.jobs[0]?.docIds).toEqual(['reddit:1', 'reddit:2'])
  })

  it('keeps a changed unit as a distinct delivery snapshot', () => {
    const first = enqueueUnits(emptyQueue(), target, [unit()], NOW)
    const next = enqueueUnits(
      first,
      target,
      [unit({ contentHash: 'hash-2', markdown: '# Updated' })],
      NOW,
    )

    expect(next.jobs).toHaveLength(2)
  })

  it('supersedes only safely unsent snapshots when a watched source changes', () => {
    const initial = enqueueUnits(emptyQueue(), target, [unit()], NOW)
    const blocked = settleTerminalFailure(
      initial,
      initial.jobs[0]?.id ?? '',
      'account changed',
      NOW,
      'blocked',
    )
    const nextUnit = unit({ contentHash: 'hash-2', markdown: '# Updated' })
    const superseded = supersedePendingUnitVersions(blocked, target, [nextUnit])
    const next = enqueueUnits(superseded, target, [nextUnit], NOW)

    expect(next.jobs).toHaveLength(1)
    expect(next.jobs[0]?.unit.contentHash).toBe('hash-2')
  })

  it('does not discard uncertain work when a newer source snapshot arrives', () => {
    const initial = enqueueUnits(emptyQueue(), target, [unit()], NOW)
    const uncertain = reapInterrupted(markInFlight(initial, initial.jobs[0]?.id ?? '', NOW), NOW)
    const nextUnit = unit({ contentHash: 'hash-2', markdown: '# Updated' })
    const superseded = supersedePendingUnitVersions(uncertain, target, [nextUnit])

    expect(superseded.jobs).toHaveLength(1)
    expect(superseded.jobs[0]?.status).toBe('uncertain')
  })

  it('makes interrupted in-flight work uncertain rather than resending it', () => {
    const queued = enqueueUnits(emptyQueue(), target, [unit()], NOW)
    const inFlight = markInFlight(queued, queued.jobs[0]?.id ?? '', NOW)
    const recovered = reapInterrupted(inFlight, NOW)

    expect(recovered.jobs[0]?.status).toBe('uncertain')
    expect(pickNext(recovered, NOW)).toBeUndefined()
  })

  it('uses bounded retry backoff and requires the due time before selection', () => {
    const queued = enqueueUnits(emptyQueue(), target, [unit()], NOW)
    const inFlight = markInFlight(queued, queued.jobs[0]?.id ?? '', NOW)
    const retrying = settleRetryableFailure(inFlight, inFlight.jobs[0]?.id ?? '', 'network', NOW)

    expect(retrying.jobs[0]?.nextAttemptAt).toBe('2026-07-11T00:00:30.000Z')
    expect(pickNext(retrying, NOW)).toBeUndefined()
    expect(pickNext(retrying, '2026-07-11T00:00:30.000Z')?.status).toBe('retrying')
  })

  it('alternates due jobs across targets when one target has contiguous jobs', () => {
    let queue = enqueueUnits(
      emptyQueue(),
      target,
      [
        unit({ docId: 'reddit:a-1', id: 'reddit:a-1', contentHash: 'a-1' }),
        unit({ docId: 'reddit:a-2', id: 'reddit:a-2', contentHash: 'a-2' }),
        unit({ docId: 'reddit:a-3', id: 'reddit:a-3', contentHash: 'a-3' }),
      ],
      NOW,
    )
    queue = enqueueUnits(
      queue,
      secondTarget,
      [
        unit({ docId: 'reddit:b-1', id: 'reddit:b-1', contentHash: 'b-1' }),
        unit({ docId: 'reddit:b-2', id: 'reddit:b-2', contentHash: 'b-2' }),
      ],
      NOW,
    )

    const pickedTargets: string[] = []
    for (let count = 0; count < 5; count += 1) {
      const next = pickNext(queue, NOW)
      expect(next).toBeDefined()
      pickedTargets.push(next?.target.notebookId ?? '')
      queue = markInFlight(queue, next?.id ?? '', NOW)
    }

    expect(pickedTargets).toEqual(['nb-1', 'nb-2', 'nb-1', 'nb-2', 'nb-1'])
  })

  it('makes explicit retry available for uncertain work', () => {
    const queued = enqueueUnits(emptyQueue(), target, [unit()], NOW)
    const uncertain = reapInterrupted(markInFlight(queued, queued.jobs[0]?.id ?? '', NOW), NOW)
    const retried = retryJob(uncertain, uncertain.jobs[0]?.id ?? '', NOW)

    expect(retried.jobs[0]?.status).toBe('queued')
    expect(retried.jobs[0]?.attempts).toBe(0)
  })

  it('makes explicit retry available for blocked work', () => {
    const queued = enqueueUnits(emptyQueue(), target, [unit()], NOW)
    const blocked = settleTerminalFailure(
      queued,
      queued.jobs[0]?.id ?? '',
      'account changed',
      NOW,
      'blocked',
    )
    const retried = retryJob(blocked, blocked.jobs[0]?.id ?? '', NOW)

    expect(retried.jobs[0]?.status).toBe('queued')
    expect(retried.jobs[0]?.attempts).toBe(0)
    expect(retried.jobs[0]?.lastError).toBeUndefined()
  })

  it('revives a blocked delivery to queued when the same unit is re-enqueued', () => {
    const queued = enqueueUnits(emptyQueue(), target, [unit()], NOW)
    const blocked = settleTerminalFailure(
      queued,
      queued.jobs[0]?.id ?? '',
      'account changed',
      NOW,
      'blocked',
    )
    const reEnqueued = enqueueUnits(blocked, target, [unit({ docId: 'reddit:2' })], NOW)

    expect(reEnqueued.jobs).toHaveLength(1)
    expect(reEnqueued.jobs[0]?.status).toBe('queued')
    expect(reEnqueued.jobs[0]?.attempts).toBe(0)
    expect(reEnqueued.jobs[0]?.lastError).toBeUndefined()
    expect(reEnqueued.jobs[0]?.docIds).toEqual(['reddit:1', 'reddit:2'])
  })
})

function jobView(overrides: Partial<QueueJobView> = {}): QueueJobView {
  return {
    id: 'job-1',
    docIds: ['reddit:1'],
    unitId: 'reddit:1',
    status: 'queued',
    attempts: 0,
    ...overrides,
  }
}

describe('summarizeQueue', () => {
  it('returns undefined for an empty snapshot', () => {
    expect(summarizeQueue({ jobs: [] })).toBeUndefined()
  })

  it('counts queued, retrying, and inFlight jobs as queued', () => {
    const snapshot: QueueSnapshot = {
      jobs: [
        jobView({ id: 'a', status: 'queued' }),
        jobView({ id: 'b', status: 'retrying' }),
        jobView({ id: 'c', status: 'inFlight' }),
      ],
    }
    const summary = summarizeQueue(snapshot)
    expect(summary?.queued).toBe(3)
    expect(summary?.failed).toBe(0)
    expect(summary?.uncertain).toBe(0)
    expect(summary?.blocked).toBe(0)
  })

  it('reports mixed status counts', () => {
    const snapshot: QueueSnapshot = {
      jobs: [
        jobView({ id: 'a', status: 'queued' }),
        jobView({ id: 'b', status: 'failed' }),
        jobView({ id: 'c', status: 'uncertain' }),
        jobView({ id: 'd', status: 'blocked' }),
      ],
    }
    const summary = summarizeQueue(snapshot)
    expect(summary).toMatchObject({ queued: 1, failed: 1, uncertain: 1, blocked: 1 })
  })

  it('collects failed and uncertain job ids into retryJobIds, in job order', () => {
    const snapshot: QueueSnapshot = {
      jobs: [
        jobView({ id: 'a', status: 'queued' }),
        jobView({ id: 'b', status: 'failed' }),
        jobView({ id: 'c', status: 'blocked' }),
        jobView({ id: 'd', status: 'uncertain' }),
      ],
    }
    expect(summarizeQueue(snapshot)?.retryJobIds).toEqual(['b', 'd'])
  })

  it('surfaces the first retryable job lastError as the summary error', () => {
    const snapshot: QueueSnapshot = {
      jobs: [
        jobView({ id: 'a', status: 'failed', lastError: 'network down' }),
        jobView({ id: 'b', status: 'uncertain', lastError: 'ambiguous result' }),
      ],
    }
    expect(summarizeQueue(snapshot)?.error).toBe('network down')
  })

  it('omits the error key when the first retryable job has no lastError', () => {
    const snapshot: QueueSnapshot = {
      jobs: [jobView({ id: 'a', status: 'failed' })],
    }
    const summary = summarizeQueue(snapshot)
    expect(summary).toBeDefined()
    expect('error' in (summary ?? {})).toBe(false)
  })
})
