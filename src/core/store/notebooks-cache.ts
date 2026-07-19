import { Effect } from 'effect'
import type { StorageError } from '../fx/errors'
import { isRecord } from '../fx/guards'
import { kvSlot } from '../fx/kv-slot'
import { Kv } from '../fx/services'
import type { NotebookMeta } from '../notebooks/model'

export interface NotebookCacheEntry {
  email: string
  notebooks: NotebookMeta[]
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
): NotebookMeta[] | undefined {
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
    notebooks: readonly NotebookMeta[]
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

const notebookCacheSlot = kvSlot<NotebookCache>(
  NOTEBOOK_CACHE_STORAGE_KEY,
  emptyNotebookCache,
  (stored) => (isNotebookCache(stored) ? stored : undefined),
)

export function loadNotebookCache(): Effect.Effect<NotebookCache, StorageError, Kv> {
  return notebookCacheSlot.load()
}

export function saveNotebookCache(cache: NotebookCache): Effect.Effect<void, StorageError, Kv> {
  return notebookCacheSlot.save(cache)
}
