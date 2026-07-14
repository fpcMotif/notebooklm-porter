import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { kvTest } from '../fx/testing'
import { contentHash, diffAgainstLedger, loadLedger, recordSynced, type Ledger } from './ledger'

describe('diffAgainstLedger', () => {
  it('classifies docs missing from the ledger as fresh', () => {
    const ledger: Ledger = {}
    const result = diffAgainstLedger(ledger, 'nb1', [{ id: 'reddit:abc', contentHash: 'h1' }])

    expect(result).toEqual({ fresh: ['reddit:abc'], changed: [], unchanged: [] })
  })

  it('classifies docs with a differing contentHash as changed', () => {
    const ledger: Ledger = {
      nb1: { 'reddit:abc': { contentHash: 'old-hash', lastSynced: '2026-01-01T00:00:00.000Z' } },
    }
    const result = diffAgainstLedger(ledger, 'nb1', [{ id: 'reddit:abc', contentHash: 'new-hash' }])

    expect(result).toEqual({ fresh: [], changed: ['reddit:abc'], unchanged: [] })
  })

  it('classifies docs with a matching contentHash as unchanged', () => {
    const ledger: Ledger = {
      nb1: { 'reddit:abc': { contentHash: 'same-hash', lastSynced: '2026-01-01T00:00:00.000Z' } },
    }
    const result = diffAgainstLedger(ledger, 'nb1', [
      { id: 'reddit:abc', contentHash: 'same-hash' },
    ])

    expect(result).toEqual({ fresh: [], changed: [], unchanged: ['reddit:abc'] })
  })

  it('classifies a mixed batch into the correct three buckets, preserving input order', () => {
    const ledger: Ledger = {
      nb1: {
        'reddit:abc': { contentHash: 'same', lastSynced: '2026-01-01T00:00:00.000Z' },
        'hn:1': { contentHash: 'stale', lastSynced: '2026-01-01T00:00:00.000Z' },
      },
    }
    const docs = [
      { id: 'hn:1', contentHash: 'fresh-content' },
      { id: 'reddit:abc', contentHash: 'same' },
      { id: 'youtube:zzz', contentHash: 'brand-new' },
    ]
    const result = diffAgainstLedger(ledger, 'nb1', docs)

    expect(result).toEqual({
      fresh: ['youtube:zzz'],
      changed: ['hn:1'],
      unchanged: ['reddit:abc'],
    })
  })

  it('scopes classification to the given notebookId — same externalId in another notebook is fresh', () => {
    const ledger: Ledger = {
      nb1: { 'reddit:abc': { contentHash: 'h1', lastSynced: '2026-01-01T00:00:00.000Z' } },
    }
    const result = diffAgainstLedger(ledger, 'nb2', [{ id: 'reddit:abc', contentHash: 'h1' }])

    expect(result).toEqual({ fresh: ['reddit:abc'], changed: [], unchanged: [] })
  })

  it('handles an empty docs list', () => {
    const result = diffAgainstLedger({}, 'nb1', [])
    expect(result).toEqual({ fresh: [], changed: [], unchanged: [] })
  })
})

describe('recordSynced', () => {
  it('returns a new ledger with entries upserted under the notebook', () => {
    const ledger: Ledger = {}
    const next = recordSynced(ledger, 'nb1', [
      { id: 'reddit:abc', contentHash: 'h1', now: '2026-07-06T00:00:00.000Z' },
    ])

    expect(next).toEqual({
      nb1: { 'reddit:abc': { contentHash: 'h1', lastSynced: '2026-07-06T00:00:00.000Z' } },
    })
  })

  it('does not mutate the original ledger (immutability)', () => {
    const ledger: Ledger = {
      nb1: { 'reddit:abc': { contentHash: 'old', lastSynced: '2026-01-01T00:00:00.000Z' } },
    }
    const snapshot = JSON.parse(JSON.stringify(ledger))

    recordSynced(ledger, 'nb1', [
      { id: 'reddit:abc', contentHash: 'new', now: '2026-07-06T00:00:00.000Z' },
    ])

    expect(ledger).toEqual(snapshot)
  })

  it('does not mutate the original notebook record when adding a sibling entry', () => {
    const ledger: Ledger = {
      nb1: { 'reddit:abc': { contentHash: 'h1', lastSynced: '2026-01-01T00:00:00.000Z' } },
    }
    const originalNotebookRecord = ledger.nb1

    const next = recordSynced(ledger, 'nb1', [
      { id: 'hn:1', contentHash: 'h2', now: '2026-07-06T00:00:00.000Z' },
    ])

    expect(ledger.nb1).toBe(originalNotebookRecord)
    expect(next.nb1).not.toBe(originalNotebookRecord)
    expect(next).toEqual({
      nb1: {
        'reddit:abc': { contentHash: 'h1', lastSynced: '2026-01-01T00:00:00.000Z' },
        'hn:1': { contentHash: 'h2', lastSynced: '2026-07-06T00:00:00.000Z' },
      },
    })
  })

  it('upserts — overwrites an existing entry for the same id rather than duplicating', () => {
    const ledger: Ledger = {
      nb1: { 'reddit:abc': { contentHash: 'old', lastSynced: '2026-01-01T00:00:00.000Z' } },
    }
    const next = recordSynced(ledger, 'nb1', [
      { id: 'reddit:abc', contentHash: 'new', now: '2026-07-06T00:00:00.000Z' },
    ])

    expect(Object.keys(next.nb1 ?? {})).toEqual(['reddit:abc'])
    expect(next.nb1?.['reddit:abc']).toEqual({
      contentHash: 'new',
      lastSynced: '2026-07-06T00:00:00.000Z',
    })
  })

  it('applies multiple entries from a single call', () => {
    const next = recordSynced({}, 'nb1', [
      { id: 'reddit:a', contentHash: 'h1', now: '2026-07-06T00:00:00.000Z' },
      { id: 'reddit:b', contentHash: 'h2', now: '2026-07-06T00:00:00.000Z' },
    ])

    expect(Object.keys(next.nb1 ?? {}).toSorted()).toEqual(['reddit:a', 'reddit:b'])
  })

  it('leaves other notebooks in the ledger untouched', () => {
    const ledger: Ledger = {
      nb1: { 'reddit:abc': { contentHash: 'h1', lastSynced: '2026-01-01T00:00:00.000Z' } },
    }
    const next = recordSynced(ledger, 'nb2', [
      { id: 'hn:1', contentHash: 'h2', now: '2026-07-06T00:00:00.000Z' },
    ])

    expect(next.nb1).toEqual(ledger.nb1)
    expect(next.nb2).toEqual({
      'hn:1': { contentHash: 'h2', lastSynced: '2026-07-06T00:00:00.000Z' },
    })
  })

  it('handles an empty entries list as a no-op copy', () => {
    const ledger: Ledger = {
      nb1: { 'reddit:abc': { contentHash: 'h1', lastSynced: '2026-01-01T00:00:00.000Z' } },
    }
    const next = recordSynced(ledger, 'nb1', [])

    expect(next).toEqual(ledger)
    expect(next).not.toBe(ledger)
  })
})

describe('contentHash', () => {
  it('is deterministic — identical input yields identical hash', () => {
    const md =
      '# Title\n\nSome markdown body with **formatting** and a [link](https://example.com).'
    expect(contentHash(md)).toBe(contentHash(md))
  })

  it('changes when a single character changes', () => {
    const a = 'The quick brown fox jumps over the lazy dog.'
    const b = 'The quick brown fox jumps over the lazy dot.'
    expect(contentHash(a)).not.toBe(contentHash(b))
  })

  it('produces an 8-char lowercase hex string', () => {
    expect(contentHash('hello world')).toMatch(/^[0-9a-f]{8}$/)
  })

  it('handles the empty string', () => {
    expect(contentHash('')).toMatch(/^[0-9a-f]{8}$/)
    expect(contentHash('')).toBe(contentHash(''))
  })

  it('is sensitive to ordering, not just character-set (anagram-safe)', () => {
    expect(contentHash('ab')).not.toBe(contentHash('ba'))
  })

  it('handles unicode content without throwing', () => {
    const md = '# 標題\n\n本文とemoji 🎉 テスト'
    expect(() => contentHash(md)).not.toThrow()
    expect(contentHash(md)).toBe(contentHash(md))
  })

  it('produces different hashes for different-length inputs sharing a prefix', () => {
    expect(contentHash('abc')).not.toBe(contentHash('abcd'))
  })
})

describe('loadLedger', () => {
  it('returns an empty ledger when persisted storage has an invalid nested entry', async () => {
    const ledger = await Effect.runPromise(
      loadLedger().pipe(
        Effect.provide(
          kvTest({
            'porter/ledger': {
              nb1: {
                'reddit:abc': { contentHash: 42, lastSynced: '2026-07-11T00:00:00.000Z' },
              },
            },
          }),
        ),
      ),
    )

    expect(ledger).toEqual({})
  })

  it('returns a valid persisted ledger unchanged', async () => {
    const stored: Ledger = {
      nb1: {
        'reddit:abc': { contentHash: 'h1', lastSynced: '2026-07-11T00:00:00.000Z' },
      },
    }
    const ledger = await Effect.runPromise(
      loadLedger().pipe(Effect.provide(kvTest({ 'porter/ledger': stored }))),
    )

    expect(ledger).toEqual(stored)
  })
})
