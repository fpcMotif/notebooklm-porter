import { Effect } from 'effect'
import { notebookTargetKey, type NotebookTarget } from '../accounts/ownership'
import type { StorageError } from '../fx/errors'
import { kvSlot } from '../fx/kv-slot'
import { Kv } from '../fx/services'
import { canonicalYoutubeWatchUrl, type IngestUnit } from '../ingest/units'
import {
  emptyQueue,
  QUEUE_STORAGE_KEY,
  type QueueJob,
  type QueueState,
  type QueueStatus,
} from './queue'

const QUEUE_STATUSES: ReadonlySet<string> = new Set([
  'queued',
  'retrying',
  'inFlight',
  'failed',
  'uncertain',
  'blocked',
])

type UnknownRecord = Record<string, unknown>

function isPlainRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasOwn(record: UnknownRecord, key: string): boolean {
  return Object.hasOwn(record, key)
}

function decodeString(record: UnknownRecord, key: string): string | undefined {
  return hasOwn(record, key) && typeof record[key] === 'string' ? record[key] : undefined
}

function decodeNonblankString(record: UnknownRecord, key: string): string | undefined {
  const value = decodeString(record, key)
  return value === undefined || value.trim() === '' ? undefined : value
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isQueueStatus(value: unknown): value is QueueStatus {
  return typeof value === 'string' && QUEUE_STATUSES.has(value)
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

function decodeTarget(value: unknown): NotebookTarget | undefined {
  if (!isPlainRecord(value)) return undefined
  const authuser = hasOwn(value, 'authuser') ? value.authuser : undefined
  const accountEmail = decodeNonblankString(value, 'accountEmail')
  const notebookId = decodeNonblankString(value, 'notebookId')
  if (!isNonNegativeSafeInteger(authuser) || !accountEmail || !notebookId) return undefined
  return { authuser, accountEmail, notebookId }
}

function decodeTextUnit(value: UnknownRecord): IngestUnit | undefined {
  const docId = decodeNonblankString(value, 'docId')
  const id = decodeNonblankString(value, 'id')
  const contentHash = decodeNonblankString(value, 'contentHash')
  const title = decodeString(value, 'title')
  const markdown = decodeString(value, 'markdown')
  if (!docId || !id || !contentHash || title === undefined || markdown === undefined)
    return undefined
  return { kind: 'text', docId, id, contentHash, title, markdown }
}

function decodeYoutubeUnit(value: UnknownRecord): IngestUnit | undefined {
  const docId = decodeNonblankString(value, 'docId')
  const id = decodeNonblankString(value, 'id')
  const contentHash = decodeNonblankString(value, 'contentHash')
  const url = decodeNonblankString(value, 'url')
  if (!docId || !id || !contentHash || !url) return undefined

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  const videoId = parsed.searchParams.get('v')
  if (
    parsed.protocol !== 'https:' ||
    parsed.hostname !== 'www.youtube.com' ||
    parsed.port !== '' ||
    parsed.pathname !== '/watch' ||
    !videoId ||
    url !== canonicalYoutubeWatchUrl(videoId) ||
    id !== `youtube:${videoId}`
  ) {
    return undefined
  }

  return { kind: 'youtube', docId, id, contentHash, url }
}

function decodeUnit(value: unknown): IngestUnit | undefined {
  if (!isPlainRecord(value) || !hasOwn(value, 'kind')) return undefined
  if (value.kind === 'text') return decodeTextUnit(value)
  if (value.kind === 'youtube') return decodeYoutubeUnit(value)
  return undefined
}

function decodeDocIds(value: unknown, unitDocId: string): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const docIds: string[] = []
  for (const docId of value) {
    if (typeof docId !== 'string' || docId.trim() === '' || docIds.includes(docId)) return undefined
    docIds.push(docId)
  }
  return docIds.includes(unitDocId) ? docIds : undefined
}

function decodeJob(value: unknown): QueueJob | undefined {
  if (!isPlainRecord(value)) return undefined
  const required = [
    'id',
    'docIds',
    'target',
    'unit',
    'status',
    'attempts',
    'enqueuedAt',
    'updatedAt',
  ]
  if (!required.every((key) => hasOwn(value, key))) return undefined
  const id = decodeNonblankString(value, 'id')
  const target = decodeTarget(value.target)
  const unit = decodeUnit(value.unit)
  const status = value.status
  const attempts = value.attempts
  const enqueuedAt = value.enqueuedAt
  const updatedAt = value.updatedAt
  if (
    !id ||
    !target ||
    !unit ||
    !isQueueStatus(status) ||
    !isNonNegativeSafeInteger(attempts) ||
    !isIsoTimestamp(enqueuedAt) ||
    !isIsoTimestamp(updatedAt)
  ) {
    return undefined
  }

  const docIds = decodeDocIds(value.docIds, unit.docId)
  if (!docIds) return undefined

  const hasNextAttemptAt = hasOwn(value, 'nextAttemptAt')
  let nextAttemptAt: string | undefined
  if (hasNextAttemptAt) {
    if (!isIsoTimestamp(value.nextAttemptAt)) return undefined
    nextAttemptAt = value.nextAttemptAt
  }
  const hasLastError = hasOwn(value, 'lastError')
  let lastError: string | undefined
  if (hasLastError) {
    if (typeof value.lastError !== 'string') return undefined
    lastError = value.lastError
  }

  if (status === 'retrying') {
    if (!hasNextAttemptAt || !hasLastError) return undefined
  } else if (hasNextAttemptAt) {
    return undefined
  }

  const requiresError =
    status === 'retrying' || status === 'failed' || status === 'uncertain' || status === 'blocked'
  if (requiresError !== hasLastError) return undefined

  return {
    id,
    docIds,
    target,
    unit,
    status,
    attempts,
    enqueuedAt,
    updatedAt,
    ...(nextAttemptAt !== undefined ? { nextAttemptAt } : {}),
    ...(lastError !== undefined ? { lastError } : {}),
  }
}

/**
 * Treat persisted delivery state as one journal. A malformed job can no
 * longer prove which source is safe to send, so reject the entire batch.
 */
export function decodeStoredQueue(value: unknown): QueueState | undefined {
  if (
    !isPlainRecord(value) ||
    !hasOwn(value, 'version') ||
    value.version !== 1 ||
    !hasOwn(value, 'roundRobinCursor') ||
    !isNonNegativeSafeInteger(value.roundRobinCursor)
  ) {
    return undefined
  }
  if (!hasOwn(value, 'jobs') || !Array.isArray(value.jobs)) return undefined

  const jobs: QueueJob[] = []
  const jobIds = new Set<string>()
  const deliveries = new Set<string>()
  for (const storedJob of value.jobs) {
    const job = decodeJob(storedJob)
    if (!job || jobIds.has(job.id)) return undefined
    const delivery = JSON.stringify([
      notebookTargetKey(job.target),
      job.unit.id,
      job.unit.contentHash,
    ])
    if (deliveries.has(delivery)) return undefined
    jobIds.add(job.id)
    deliveries.add(delivery)
    jobs.push(job)
  }

  return { version: 1, roundRobinCursor: value.roundRobinCursor, jobs }
}

const queueSlot = kvSlot<QueueState>(QUEUE_STORAGE_KEY, emptyQueue, decodeStoredQueue)

export function loadQueue(): Effect.Effect<QueueState, StorageError, Kv> {
  return queueSlot.load()
}

export function saveQueue(queue: QueueState): Effect.Effect<void, StorageError, Kv> {
  return queueSlot.save(queue)
}
