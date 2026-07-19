import { assert, describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { kvTest } from '../fx/testing'
import { QUEUE_STORAGE_KEY } from './queue'
import { decodeStoredQueue, loadQueue } from './store'

const NOW = '2026-07-11T00:00:00.000Z'
const RETRY_AT = '2026-07-11T00:00:30.000Z'

function textJob(extra: Record<string, unknown> = {}) {
  return {
    id: 'f@example.com:nb-1:reddit:1:hash-1',
    docIds: ['reddit:1'],
    target: { authuser: 0, accountEmail: 'f@example.com', notebookId: 'nb-1' },
    unit: {
      kind: 'text',
      docId: 'reddit:1',
      id: 'reddit:1',
      contentHash: 'hash-1',
      title: 'Thread',
      markdown: '# Thread',
    },
    status: 'queued',
    attempts: 0,
    enqueuedAt: NOW,
    updatedAt: NOW,
    ...extra,
  }
}

function queueState(extra: Record<string, unknown> = {}) {
  return { version: 1, roundRobinCursor: 0, jobs: [textJob()], ...extra }
}

describe('queue storage', () => {
  it('decodes a legacy-id delivery into detached records and arrays', () => {
    const job = textJob()
    const stored = queueState({ jobs: [job] })

    const decoded = decodeStoredQueue(stored)

    expect(decoded).toEqual(stored)
    expect(decoded).not.toBe(stored)
    expect(decoded?.jobs).not.toBe(stored.jobs)
    expect(decoded?.jobs[0]).not.toBe(job)
    expect(decoded?.jobs[0]?.docIds).not.toBe(job.docIds)
    expect(decoded?.jobs[0]?.target).not.toBe(job.target)
    expect(decoded?.jobs[0]?.unit).not.toBe(job.unit)
  })

  it('accepts canonical retrying and YouTube deliveries', () => {
    const retrying = textJob({
      status: 'retrying',
      attempts: 1,
      nextAttemptAt: RETRY_AT,
      lastError: 'offline',
    })
    const youtube = textJob({
      id: 'legacy-youtube-id',
      docIds: ['youtube:abcdefghijk'],
      unit: {
        kind: 'youtube',
        docId: 'youtube:abcdefghijk',
        id: 'youtube:abcdefghijk',
        contentHash: 'hash-2',
        url: 'https://www.youtube.com/watch?v=abcdefghijk',
      },
    })

    expect(decodeStoredQueue(queueState({ jobs: [retrying, youtube] }))?.jobs).toHaveLength(2)
  })

  it('rejects malformed roots atomically', () => {
    const malformed: unknown[] = [
      null,
      [],
      {},
      queueState({ version: 2 }),
      queueState({ roundRobinCursor: -1 }),
      queueState({ jobs: {} }),
    ]

    for (const stored of malformed) expect(decodeStoredQueue(stored)).toBeUndefined()
  })

  it('rejects malformed jobs atomically', () => {
    const inherited = Object.create(textJob())
    const malformed = [
      { id: 'bad' },
      textJob({ target: { authuser: -1, accountEmail: 'f@example.com', notebookId: 'nb-1' } }),
      textJob({ unit: { kind: 'other' } }),
      textJob({ status: 'later' }),
      textJob({ attempts: -1 }),
      textJob({ updatedAt: 'not-a-date' }),
      textJob({ docIds: ['reddit:other'] }),
      textJob({ nextAttemptAt: undefined }),
      textJob({ lastError: undefined }),
      inherited,
    ]

    for (const job of malformed) {
      expect(decodeStoredQueue(queueState({ jobs: [job] }))).toBeUndefined()
    }
  })

  it('rejects duplicate IDs and immutable delivery identities', () => {
    const job = textJob()
    const duplicateId = textJob({ unit: { ...job.unit, contentHash: 'hash-2' } })
    const duplicateDelivery = textJob({ id: 'other-job' })

    expect(decodeStoredQueue(queueState({ jobs: [job, duplicateId] }))).toBeUndefined()
    expect(decodeStoredQueue(queueState({ jobs: [job, duplicateDelivery] }))).toBeUndefined()
  })

  it('rejects inconsistent status metadata', () => {
    const malformed = [
      textJob({ status: 'retrying', lastError: 'offline' }),
      textJob({ status: 'retrying', nextAttemptAt: RETRY_AT }),
      textJob({ status: 'queued', lastError: 'stale' }),
      textJob({ status: 'failed' }),
      textJob({ status: 'failed', lastError: 'failed', nextAttemptAt: RETRY_AT }),
    ]

    for (const job of malformed) {
      expect(decodeStoredQueue(queueState({ jobs: [job] }))).toBeUndefined()
    }
  })

  it('rejects noncanonical YouTube delivery URLs', () => {
    const youtube = textJob({
      docIds: ['youtube:abcdefghijk'],
      unit: {
        kind: 'youtube',
        docId: 'youtube:abcdefghijk',
        id: 'youtube:abcdefghijk',
        contentHash: 'hash-1',
        url: 'https://youtu.be/abcdefghijk',
      },
    })

    expect(decodeStoredQueue(queueState({ jobs: [youtube] }))).toBeUndefined()
  })

  it.effect('loads an empty queue when persisted work is malformed', () =>
    Effect.gen(function* () {
      const queue = yield* loadQueue()
      assert.deepStrictEqual(queue, { version: 1, roundRobinCursor: 0, jobs: [] })
    }).pipe(
      Effect.provide(
        kvTest({
          [QUEUE_STORAGE_KEY]: queueState({ jobs: [{ id: 'bad' }] }),
        }),
      ),
    ),
  )
})
