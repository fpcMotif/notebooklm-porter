import { describe, expect, it } from 'vitest'
import {
  cacheNotebooks,
  emptyNotebookCache,
  isNotebookCache,
  readCachedNotebooks,
} from './notebooks-cache'

const first = {
  authuser: 0,
  email: 'first@example.com',
  notebooks: [{ id: 'nb-1', title: 'First notebook' }],
  refreshedAt: '2026-07-11T00:00:00.000Z',
}

describe('notebooks cache', () => {
  it('serves a slot only when its freshly observed email matches', () => {
    const cache = cacheNotebooks(emptyNotebookCache(), first)

    expect(readCachedNotebooks(cache, 0, 'first@example.com')).toEqual(first.notebooks)
    expect(readCachedNotebooks(cache, 0, 'replacement@example.com')).toBeUndefined()
    expect(readCachedNotebooks(cache, 1, 'first@example.com')).toBeUndefined()
  })

  it('replaces only the active slot and does not mutate the prior cache', () => {
    const initial = cacheNotebooks(emptyNotebookCache(), first)
    const next = cacheNotebooks(initial, {
      authuser: 1,
      email: 'second@example.com',
      notebooks: [{ id: 'nb-2', title: 'Second notebook' }],
      refreshedAt: '2026-07-11T01:00:00.000Z',
    })

    expect(readCachedNotebooks(initial, 1, 'second@example.com')).toBeUndefined()
    expect(readCachedNotebooks(next, 0, 'first@example.com')).toEqual(first.notebooks)
    expect(readCachedNotebooks(next, 1, 'second@example.com')).toEqual([
      { id: 'nb-2', title: 'Second notebook' },
    ])
  })

  it('does not expose mutable storage-owned notebook rows to callers', () => {
    const cache = cacheNotebooks(emptyNotebookCache(), first)
    const read = readCachedNotebooks(cache, 0, 'first@example.com')
    const notebook = read?.[0]
    if (notebook === undefined) throw new Error('expected cached notebook')
    notebook.title = 'Mutated by caller'

    expect(readCachedNotebooks(cache, 0, 'first@example.com')).toEqual(first.notebooks)
  })

  it('rejects corrupted persisted shapes', () => {
    expect(isNotebookCache({ version: 1, entries: [] })).toBe(false)
    expect(
      isNotebookCache({
        version: 1,
        entries: { 0: { email: 'f@example.com', notebooks: [{ id: 1 }], refreshedAt: 'now' } },
      }),
    ).toBe(false)
  })
})
