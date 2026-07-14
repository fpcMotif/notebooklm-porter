import { Effect } from 'effect'
import type { StorageError } from '../fx/errors'
import { Kv } from '../fx/services'

export interface CachedNotebook {
  id: string
  title: string
}

export interface NotebookCacheEntry {
  email: string
  notebooks: CachedNotebook[]
  refreshedAt: string
}

export interface NotebookCache {
  version: 1
  entries: Record<string, NotebookCacheEntry>
}

export const NOTEBOOK_CACHE_STORAGE_KEY = 'porter/notebooks-cache/v1'

export function emptyNotebookCache(): NotebookCache {
  return { version: 1, entries: {} }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCacheEntry(value: unknown): value is NotebookCacheEntry {
  return (
    isRecord(value) &&
    typeof value.email === 'string' &&
    typeof value.refreshedAt === 'string' &&
    Array.isArray(value.notebooks) &&
    value.notebooks.every(
      (notebook) =>
        isRecord(notebook) && typeof notebook.id === 'string' && typeof notebook.title === 'string',
    )
  )
}

export function isNotebookCache(value: unknown): value is NotebookCache {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isRecord(value.entries) &&
    Object.values(value.entries).every(isCacheEntry)
  )
}

function entryKey(authuser: number): string {
  return String(authuser)
}

/** Returns browse data only when the freshly observed account email agrees. */
export function readCachedNotebooks(
  cache: NotebookCache,
  authuser: number,
  email: string,
): CachedNotebook[] | undefined {
  const entry = cache.entries[entryKey(authuser)]
  if (entry === undefined || entry.email !== email) return undefined
  return entry.notebooks.map(({ id, title }) => ({ id, title }))
}

/** Replaces one slot atomically while preserving cache entries for other accounts. */
export function cacheNotebooks(
  cache: NotebookCache,
  input: {
    authuser: number
    email: string
    notebooks: readonly CachedNotebook[]
    refreshedAt: string
  },
): NotebookCache {
  return {
    ...cache,
    entries: {
      ...cache.entries,
      [entryKey(input.authuser)]: {
        email: input.email,
        notebooks: input.notebooks.map((notebook) => ({ ...notebook })),
        refreshedAt: input.refreshedAt,
      },
    },
  }
}

export function loadNotebookCache(): Effect.Effect<NotebookCache, StorageError, Kv> {
  return Effect.gen(function* () {
    const kv = yield* Kv
    const stored = yield* kv.get<unknown>(NOTEBOOK_CACHE_STORAGE_KEY)
    return isNotebookCache(stored) ? stored : emptyNotebookCache()
  })
}

export function saveNotebookCache(cache: NotebookCache): Effect.Effect<void, StorageError, Kv> {
  return Effect.gen(function* () {
    const kv = yield* Kv
    yield* kv.set(NOTEBOOK_CACHE_STORAGE_KEY, cache)
  })
}
