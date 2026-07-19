import { Effect } from 'effect'
import type { StorageError } from '../fx/errors'
import { kvSlot } from '../fx/kv-slot'
import { Kv } from '../fx/services'
import { emptyWatches, watchId, WATCH_STORAGE_KEY, type Watch, type WatchState } from './watch'
type UnknownRecord = Record<string, unknown>

function isPlainRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function ownNonBlankString(record: UnknownRecord, key: string): string | undefined {
  const value = record[key]
  return Object.hasOwn(record, key) && typeof value === 'string' && value.trim() !== ''
    ? value
    : undefined
}

function ownIsoTimestamp(record: UnknownRecord, key: string): string | undefined {
  const value = ownNonBlankString(record, key)
  if (value === undefined) return undefined
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
    ? value
    : undefined
}

function optionalString(record: UnknownRecord, key: string): string | undefined | null {
  if (!Object.hasOwn(record, key)) return undefined
  return typeof record[key] === 'string' ? record[key] : null
}

function optionalIsoTimestamp(record: UnknownRecord, key: string): string | undefined | null {
  if (!Object.hasOwn(record, key)) return undefined
  return ownIsoTimestamp(record, key) ?? null
}

function decodeTarget(value: unknown): Watch['target'] | undefined {
  if (!isPlainRecord(value)) return undefined
  const notebookId = ownNonBlankString(value, 'notebookId')
  const accountEmail = ownNonBlankString(value, 'accountEmail')
  const authuser = value.authuser
  if (
    notebookId === undefined ||
    accountEmail === undefined ||
    !Object.hasOwn(value, 'authuser') ||
    typeof authuser !== 'number' ||
    !Number.isSafeInteger(authuser) ||
    authuser < 0
  ) {
    return undefined
  }
  return { notebookId, accountEmail, authuser }
}

function decodeCaptureOptions(value: unknown): Watch['captureOptions'] | undefined {
  if (
    !isPlainRecord(value) ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, 'enrichTranscripts') ||
    value.enrichTranscripts !== true
  ) {
    return undefined
  }
  return { enrichTranscripts: true }
}

function decodeWatch(value: unknown): Watch | undefined {
  if (!isPlainRecord(value)) return undefined
  if (!Object.hasOwn(value, 'target')) return undefined
  const sourceDocId = ownNonBlankString(value, 'sourceDocId')
  const sourceUrl = ownNonBlankString(value, 'sourceUrl')
  const target = decodeTarget(value.target)
  const intervalMs = value.intervalMs
  const status = value.status
  const nextRunAt = ownIsoTimestamp(value, 'nextRunAt')
  const createdAt = ownIsoTimestamp(value, 'createdAt')
  const updatedAt = ownIsoTimestamp(value, 'updatedAt')
  if (
    sourceDocId === undefined ||
    sourceUrl === undefined ||
    target === undefined ||
    !Object.hasOwn(value, 'intervalMs') ||
    typeof intervalMs !== 'number' ||
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 1 ||
    !Object.hasOwn(value, 'status') ||
    (status !== 'active' && status !== 'disabled') ||
    nextRunAt === undefined ||
    createdAt === undefined ||
    updatedAt === undefined
  ) {
    return undefined
  }
  try {
    if (new URL(sourceUrl).href.length === 0) return undefined
  } catch {
    return undefined
  }

  const lastResyncedAt = optionalIsoTimestamp(value, 'lastResyncedAt')
  const lastError = optionalString(value, 'lastError')
  if (lastResyncedAt === null || lastError === null) return undefined

  const hasCaptureOptions = Object.hasOwn(value, 'captureOptions')
  const captureOptions = hasCaptureOptions ? decodeCaptureOptions(value.captureOptions) : undefined
  if (hasCaptureOptions && captureOptions === undefined) return undefined

  const hasLegacyEnrichment = Object.hasOwn(value, 'enrichYoutube')
  if (hasLegacyEnrichment && value.enrichYoutube !== true) return undefined

  return {
    id: watchId(sourceDocId, target),
    sourceDocId,
    sourceUrl,
    target,
    ...(captureOptions !== undefined
      ? { captureOptions }
      : hasLegacyEnrichment
        ? { captureOptions: { enrichTranscripts: true } }
        : {}),
    intervalMs,
    status,
    nextRunAt,
    createdAt,
    updatedAt,
    ...(lastResyncedAt !== undefined ? { lastResyncedAt } : {}),
    ...(lastError !== undefined ? { lastError } : {}),
  }
}

/**
 * Validates one persisted state, migrates the old enrichment flag, and
 * rekeys each row to its complete notebook target. Bad rows cannot block
 * valid watches; a malformed root falls back to an empty state.
 */
export function decodeStoredWatchState(stored: unknown): WatchState | undefined {
  if (
    !isPlainRecord(stored) ||
    !Object.hasOwn(stored, 'version') ||
    stored.version !== 1 ||
    !Object.hasOwn(stored, 'watches') ||
    !Array.isArray(stored.watches)
  ) {
    return undefined
  }

  const ids = new Set<string>()
  const watches: Watch[] = []
  for (const item of stored.watches) {
    const watch = decodeWatch(item)
    if (watch === undefined || ids.has(watch.id)) continue
    ids.add(watch.id)
    watches.push(watch)
  }
  return { version: 1, watches }
}

/** Thin persistence wrapper; state transitions remain pure in watch.ts. */
const watchesSlot = kvSlot<WatchState>(WATCH_STORAGE_KEY, emptyWatches, decodeStoredWatchState)

export function loadWatches(): Effect.Effect<WatchState, StorageError, Kv> {
  return watchesSlot.load()
}

export function saveWatches(watches: WatchState): Effect.Effect<void, StorageError, Kv> {
  return watchesSlot.save(watches)
}
