import type { IngestUnit } from '../ingest/units'

export type QueueStatus = 'queued' | 'retrying' | 'inFlight' | 'failed' | 'uncertain' | 'blocked'

export interface QueueTarget {
  notebookId: string
  authuser: number
  accountEmail: string
}

export interface QueueJob {
  id: string
  docIds: string[]
  target: QueueTarget
  unit: IngestUnit
  status: QueueStatus
  attempts: number
  nextAttemptAt?: string
  lastError?: string
  enqueuedAt: string
  updatedAt: string
}

export interface QueueState {
  version: 1
  roundRobinCursor: number
  jobs: QueueJob[]
}

export interface QueueJobView {
  id: string
  docIds: string[]
  unitId: string
  status: QueueStatus
  attempts: number
  nextAttemptAt?: string
  lastError?: string
}

export interface QueueSnapshot {
  jobs: QueueJobView[]
}

const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000] as const

export const QUEUE_STORAGE_KEY = 'porter/ingest-queue/v1'
export const QUEUE_ALARM = 'porter/ingest-queue'

export function emptyQueue(): QueueState {
  return { version: 1, roundRobinCursor: 0, jobs: [] }
}

function queueJobId(target: QueueTarget, unit: IngestUnit): string {
  return [target.accountEmail, target.notebookId, unit.id, unit.contentHash].join(':')
}

function targetKey(job: QueueJob): string {
  return `${job.target.accountEmail}:${job.target.notebookId}`
}

function mergeDocIds(existing: string[], next: string): string[] {
  return existing.includes(next) ? existing : [...existing, next]
}

/** Adds immutable unit snapshots, merging only exact same-version deliveries. */
export function enqueueUnits(
  state: QueueState,
  target: QueueTarget,
  units: readonly IngestUnit[],
  now: string,
): QueueState {
  let jobs = state.jobs
  for (const unit of units) {
    const id = queueJobId(target, unit)
    const index = jobs.findIndex((job) => job.id === id)
    if (index >= 0) {
      const existing = jobs[index]
      if (existing === undefined) continue
      // A re-enqueue of a parked delivery is an explicit "try this again":
      // revive blocked/failed jobs to `queued` so they drain instead of merging
      // silently into a job that will never retry. In-flight and uncertain work
      // is left untouched — it may already have mutated the notebook.
      let updated: QueueJob
      if (existing.status === 'blocked' || existing.status === 'failed') {
        const { nextAttemptAt: _nextAttemptAt, lastError: _lastError, ...rest } = existing
        updated = {
          ...rest,
          docIds: mergeDocIds(existing.docIds, unit.docId),
          status: 'queued',
          attempts: 0,
          updatedAt: now,
        }
      } else {
        updated = {
          ...existing,
          docIds: mergeDocIds(existing.docIds, unit.docId),
          updatedAt: now,
        }
      }
      jobs = [...jobs.slice(0, index), updated, ...jobs.slice(index + 1)]
      continue
    }
    jobs = [
      ...jobs,
      {
        id,
        docIds: [unit.docId],
        target,
        unit,
        status: 'queued',
        attempts: 0,
        enqueuedAt: now,
        updatedAt: now,
      },
    ]
  }
  return { ...state, jobs }
}

/**
 * Drops only safe, unsent older snapshots before a scheduled source update.
 * In-flight and uncertain work stays visible because it may already have
 * caused a remote mutation; failed deliveries remain reviewable as well.
 */
export function supersedePendingUnitVersions(
  state: QueueState,
  target: QueueTarget,
  units: readonly IngestUnit[],
): QueueState {
  const incomingHashes = new Map(units.map((unit) => [unit.id, unit.contentHash]))
  return {
    ...state,
    jobs: state.jobs.filter((job) => {
      const incomingHash = incomingHashes.get(job.unit.id)
      const sameTarget =
        job.target.notebookId === target.notebookId &&
        job.target.accountEmail === target.accountEmail
      const safelyReplaceable =
        job.status === 'queued' || job.status === 'retrying' || job.status === 'blocked'
      return !(
        sameTarget &&
        safelyReplaceable &&
        incomingHash !== undefined &&
        incomingHash !== job.unit.contentHash
      )
    }),
  }
}

function isDue(job: QueueJob, now: string): boolean {
  if (job.status === 'queued') return true
  return job.status === 'retrying' && (job.nextAttemptAt === undefined || job.nextAttemptAt <= now)
}

/** Picks the next due job with round-robin fairness across notebook targets. */
export function pickNext(state: QueueState, now: string): QueueJob | undefined {
  const due = state.jobs.filter((job) => isDue(job, now))
  if (due.length === 0) return undefined

  const targets = Array.from(new Set(due.map(targetKey)))
  const target = targets[state.roundRobinCursor % targets.length]
  if (target === undefined) return due[0]
  return due.find((job) => targetKey(job) === target) ?? due[0]
}

function replaceJob(
  state: QueueState,
  jobId: string,
  update: (job: QueueJob) => QueueJob,
): QueueState {
  return { ...state, jobs: state.jobs.map((job) => (job.id === jobId ? update(job) : job)) }
}

/** Persist this transition before calling NotebookLM. */
export function markInFlight(state: QueueState, jobId: string, now: string): QueueState {
  if (!state.jobs.some((job) => job.id === jobId)) return state
  return {
    ...replaceJob(state, jobId, (job) => {
      const { nextAttemptAt: _nextAttemptAt, ...rest } = job
      return { ...rest, status: 'inFlight', attempts: job.attempts + 1, updatedAt: now }
    }),
    roundRobinCursor: state.roundRobinCursor + 1,
  }
}

export function settleRetryableFailure(
  state: QueueState,
  jobId: string,
  error: string,
  now: string,
): QueueState {
  return replaceJob(state, jobId, (job) => {
    // Preflight happens before `markInFlight`, so it still needs to consume a
    // bounded queue attempt. An already in-flight failure was counted by that
    // durable transition and must not consume the count twice.
    const attempts = job.status === 'inFlight' ? job.attempts : job.attempts + 1
    const delay = RETRY_DELAYS_MS[attempts - 1]
    if (delay === undefined) {
      const { nextAttemptAt: _nextAttemptAt, ...rest } = job
      return { ...rest, attempts, status: 'failed', lastError: error, updatedAt: now }
    }
    return {
      ...job,
      attempts,
      status: 'retrying',
      lastError: error,
      updatedAt: now,
      nextAttemptAt: new Date(Date.parse(now) + delay).toISOString(),
    }
  })
}

export function settleTerminalFailure(
  state: QueueState,
  jobId: string,
  error: string,
  now: string,
  status: 'failed' | 'blocked' = 'failed',
): QueueState {
  return replaceJob(state, jobId, (job) => {
    const { nextAttemptAt: _nextAttemptAt, ...rest } = job
    return { ...rest, status, lastError: error, updatedAt: now }
  })
}

/** An ambiguous remote result must be reviewed before another source mutation. */
export function settleUncertain(
  state: QueueState,
  jobId: string,
  error: string,
  now: string,
): QueueState {
  return replaceJob(state, jobId, (job) => {
    const { nextAttemptAt: _nextAttemptAt, ...rest } = job
    return { ...rest, status: 'uncertain', lastError: error, updatedAt: now }
  })
}

/** A prior worker may have died after the remote mutation; never resend automatically. */
export function reapInterrupted(state: QueueState, now: string): QueueState {
  return {
    ...state,
    jobs: state.jobs.map((job) =>
      job.status === 'inFlight'
        ? { ...job, status: 'uncertain', updatedAt: now, lastError: 'Worker stopped during send' }
        : job,
    ),
  }
}

/**
 * Explicit user recovery for a settled job. Blocked jobs are retryable too:
 * once the account/target is corrected (or a fallback ships) a re-queue lets
 * the drain re-validate them instead of leaving them permanently stuck.
 */
export function retryJob(state: QueueState, jobId: string, now: string): QueueState {
  return replaceJob(state, jobId, (job) => {
    if (job.status !== 'failed' && job.status !== 'uncertain' && job.status !== 'blocked') {
      return job
    }
    const { lastError: _lastError, nextAttemptAt: _nextAttemptAt, ...rest } = job
    return { ...rest, status: 'queued', attempts: 0, updatedAt: now }
  })
}

export function removeJob(state: QueueState, jobId: string): QueueState {
  return { ...state, jobs: state.jobs.filter((job) => job.id !== jobId) }
}

export function queueSnapshot(state: QueueState): QueueSnapshot {
  return {
    jobs: state.jobs.map((job) => ({
      id: job.id,
      docIds: job.docIds,
      unitId: job.unit.id,
      status: job.status,
      attempts: job.attempts,
      ...(job.nextAttemptAt !== undefined ? { nextAttemptAt: job.nextAttemptAt } : {}),
      ...(job.lastError !== undefined ? { lastError: job.lastError } : {}),
    })),
  }
}

export interface QueueSummary {
  queued: number
  failed: number
  uncertain: number
  blocked: number
  /** ids of failed | uncertain jobs, in job order. */
  retryJobIds: string[]
  error?: string
}

/**
 * Aggregates a snapshot into the counts/retry set the popup surfaces.
 * Empty snapshot → undefined (the popup clears its banner).
 */
export function summarizeQueue(snapshot: QueueSnapshot): QueueSummary | undefined {
  if (snapshot.jobs.length === 0) return undefined
  const queued = snapshot.jobs.filter(
    (job) => job.status === 'queued' || job.status === 'retrying' || job.status === 'inFlight',
  )
  const retryable = snapshot.jobs.filter(
    (job) => job.status === 'failed' || job.status === 'uncertain',
  )
  return {
    queued: queued.length,
    failed: snapshot.jobs.filter((job) => job.status === 'failed').length,
    uncertain: snapshot.jobs.filter((job) => job.status === 'uncertain').length,
    blocked: snapshot.jobs.filter((job) => job.status === 'blocked').length,
    retryJobIds: retryable.map((job) => job.id),
    ...(retryable[0]?.lastError ? { error: retryable[0].lastError } : {}),
  }
}

export function nextDueAt(state: QueueState, now: string): string | undefined {
  const retryTimes = state.jobs
    .filter((job) => job.status === 'retrying' && job.nextAttemptAt !== undefined)
    .map((job) => job.nextAttemptAt)
    .toSorted()
  if (state.jobs.some((job) => job.status === 'queued')) return now
  return retryTimes[0]
}
