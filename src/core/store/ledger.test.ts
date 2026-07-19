import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { kvTest } from '../fx/testing'
import { notebookTargetKey, type NotebookTarget } from '../accounts/ownership'
import {
  contentHash,
  diffAgainstLedger,
  isUnitSynced,
  loadLedger,
  LEDGER_STORAGE_KEY,
  partitionSynced,
  recordSynced,
  type Ledger,
} from './ledger'

const target: NotebookTarget = {
  authuser: 0,
  accountEmail: 'user@example.com',
  notebookId: 'nb1',
}

const secondTarget: NotebookTarget = { ...target, notebookId: 'nb2' }

function ledgerFor(entries: Ledger[string]): Ledger {
  return { [notebookTargetKey(target)]: entries }
}

describe('diffAgainstLedger', () => {
  it('classifies docs missing from the ledger as fresh', () => {
    const ledger: Ledger = {}
    const result = diffAgainstLedger(ledger, target, [{ id: 'reddit:abc', contentHash: 'h1' }])

    expect(result).toEqual({ fresh: ['reddit:abc'], changed: [], unchanged: [] })
  })

  it('classifies docs with a differing contentHash as changed', () => {
    const ledger = ledgerFor({
      'reddit:abc': { contentHash: 'old-hash', lastSynced: '2026-01-01T00:00:00.000Z' },
    })
    const result = diffAgainstLedger(ledger, target, [
      { id: 'reddit:abc', contentHash: 'new-hash' },
    ])

    expect(result).toEqual({ fresh: [], changed: ['reddit:abc'], unchanged: [] })
  })

  it('classifies docs with a matching contentHash as unchanged', () => {
    const ledger = ledgerFor({
      'reddit:abc': { contentHash: 'same-hash', lastSynced: '2026-01-01T00:00:00.000Z' },
    })
    const result = diffAgainstLedger(ledger, target, [
      { id: 'reddit:abc', contentHash: 'same-hash' },
    ])

    expect(result).toEqual({ fresh: [], changed: [], unchanged: ['reddit:abc'] })
  })

  it('classifies a mixed batch into the correct three buckets, preserving input order', () => {
    const ledger = ledgerFor({
      'reddit:abc': { contentHash: 'same', lastSynced: '2026-01-01T00:00:00.000Z' },
      'hn:1': { contentHash: 'stale', lastSynced: '2026-01-01T00:00:00.000Z' },
    })
    const docs = [
      { id: 'hn:1', contentHash: 'fresh-content' },
      { id: 'reddit:abc', contentHash: 'same' },
      { id: 'youtube:zzz', contentHash: 'brand-new' },
    ]
    const result = diffAgainstLedger(ledger, target, docs)

    expect(result).toEqual({
      fresh: ['youtube:zzz'],
      changed: ['hn:1'],
      unchanged: ['reddit:abc'],
    })
  })

  it('scopes classification to the complete target — same notebook id in another authuser is fresh', () => {
    const ledger = ledgerFor({
      'reddit:abc': { contentHash: 'h1', lastSynced: '2026-01-01T00:00:00.000Z' },
    })
    const result = diffAgainstLedger(ledger, { ...target, authuser: 1 }, [
      { id: 'reddit:abc', contentHash: 'h1' },
    ])

    expect(result).toEqual({ fresh: ['reddit:abc'], changed: [], unchanged: [] })
  })

  it('handles an empty docs list', () => {
    const result = diffAgainstLedger({}, target, [])
    expect(result).toEqual({ fresh: [], changed: [], unchanged: [] })
  })
})

describe('isUnitSynced', () => {
  it('is false for a unit id the ledger has never seen', () => {
    const ledger: Ledger = {}
    expect(isUnitSynced(ledger, target, { id: 'reddit:abc', contentHash: 'h1' })).toBe(false)
  })

  it('is true for a known id with a matching contentHash', () => {
    const ledger = ledgerFor({
      'reddit:abc': { contentHash: 'h1', lastSynced: '2026-01-01T00:00:00.000Z' },
    })
    expect(isUnitSynced(ledger, target, { id: 'reddit:abc', contentHash: 'h1' })).toBe(true)
  })

  it('is false for a known id with a different contentHash', () => {
    const ledger = ledgerFor({
      'reddit:abc': { contentHash: 'old-hash', lastSynced: '2026-01-01T00:00:00.000Z' },
    })
    expect(isUnitSynced(ledger, target, { id: 'reddit:abc', contentHash: 'new-hash' })).toBe(false)
  })
})

describe('partitionSynced', () => {
  it('splits units into pending and synced', () => {
    const ledger = ledgerFor({
      'reddit:abc': { contentHash: 'same', lastSynced: '2026-01-01T00:00:00.000Z' },
    })
    const units = [
      { id: 'reddit:abc', contentHash: 'same' },
      { id: 'youtube:zzz', contentHash: 'brand-new' },
    ]
    const result = partitionSynced(ledger, target, units)

    expect(result.synced).toEqual([{ id: 'reddit:abc', contentHash: 'same' }])
    expect(result.pending).toEqual([{ id: 'youtube:zzz', contentHash: 'brand-new' }])
  })

  it('counts a changed unit in pending and increments changed, without counting a brand-new unit', () => {
    const ledger = ledgerFor({
      'hn:1': { contentHash: 'stale', lastSynced: '2026-01-01T00:00:00.000Z' },
    })
    const units = [
      { id: 'hn:1', contentHash: 'fresh-content' },
      { id: 'youtube:zzz', contentHash: 'brand-new' },
    ]
    const result = partitionSynced(ledger, target, units)

    expect(result.pending).toEqual(units)
    expect(result.synced).toEqual([])
    expect(result.changed).toBe(1)
  })

  it('handles an all-synced batch with zero pending and zero changed', () => {
    const ledger = ledgerFor({
      'reddit:abc': { contentHash: 'same', lastSynced: '2026-01-01T00:00:00.000Z' },
    })
    const units = [{ id: 'reddit:abc', contentHash: 'same' }]
    const result = partitionSynced(ledger, target, units)

    expect(result).toEqual({ pending: [], synced: units, changed: 0 })
  })
})

describe('recordSynced', () => {
  it('returns a new ledger with entries upserted under the notebook', () => {
    const ledger: Ledger = {}
    const next = recordSynced(ledger, target, [
      { id: 'reddit:abc', contentHash: 'h1', now: '2026-07-06T00:00:00.000Z' },
    ])

    expect(next).toEqual(
      ledgerFor({
        'reddit:abc': { contentHash: 'h1', lastSynced: '2026-07-06T00:00:00.000Z' },
      }),
    )
  })

  it('does not mutate the original ledger (immutability)', () => {
    const ledger = ledgerFor({
      'reddit:abc': { contentHash: 'old', lastSynced: '2026-01-01T00:00:00.000Z' },
    })
    const snapshot = JSON.parse(JSON.stringify(ledger))

    recordSynced(ledger, target, [
      { id: 'reddit:abc', contentHash: 'new', now: '2026-07-06T00:00:00.000Z' },
    ])

    expect(ledger).toEqual(snapshot)
  })

  it('does not mutate the original notebook record when adding a sibling entry', () => {
    const ledger = ledgerFor({
      'reddit:abc': { contentHash: 'h1', lastSynced: '2026-01-01T00:00:00.000Z' },
    })
    const originalNotebookRecord = ledger[notebookTargetKey(target)]

    const next = recordSynced(ledger, target, [
      { id: 'hn:1', contentHash: 'h2', now: '2026-07-06T00:00:00.000Z' },
    ])

    expect(ledger[notebookTargetKey(target)]).toBe(originalNotebookRecord)
    expect(next[notebookTargetKey(target)]).not.toBe(originalNotebookRecord)
    expect(next).toEqual(
      ledgerFor({
        'reddit:abc': { contentHash: 'h1', lastSynced: '2026-01-01T00:00:00.000Z' },
        'hn:1': { contentHash: 'h2', lastSynced: '2026-07-06T00:00:00.000Z' },
      }),
    )
  })

  it('upserts — overwrites an existing entry for the same id rather than duplicating', () => {
    const ledger = ledgerFor({
      'reddit:abc': { contentHash: 'old', lastSynced: '2026-01-01T00:00:00.000Z' },
    })
    const next = recordSynced(ledger, target, [
      { id: 'reddit:abc', contentHash: 'new', now: '2026-07-06T00:00:00.000Z' },
    ])

    expect(Object.keys(next[notebookTargetKey(target)] ?? {})).toEqual(['reddit:abc'])
    expect(next[notebookTargetKey(target)]?.['reddit:abc']).toEqual({
      contentHash: 'new',
      lastSynced: '2026-07-06T00:00:00.000Z',
    })
  })

  it('applies multiple entries from a single call', () => {
    const next = recordSynced({}, target, [
      { id: 'reddit:a', contentHash: 'h1', now: '2026-07-06T00:00:00.000Z' },
      { id: 'reddit:b', contentHash: 'h2', now: '2026-07-06T00:00:00.000Z' },
    ])

    expect(Object.keys(next[notebookTargetKey(target)] ?? {}).toSorted()).toEqual([
      'reddit:a',
      'reddit:b',
    ])
  })

  it('leaves other notebooks in the ledger untouched', () => {
    const ledger = ledgerFor({
      'reddit:abc': { contentHash: 'h1', lastSynced: '2026-01-01T00:00:00.000Z' },
    })
    const next = recordSynced(ledger, secondTarget, [
      { id: 'hn:1', contentHash: 'h2', now: '2026-07-06T00:00:00.000Z' },
    ])

    expect(next[notebookTargetKey(target)]).toEqual(ledger[notebookTargetKey(target)])
    expect(next[notebookTargetKey(secondTarget)]).toEqual({
      'hn:1': { contentHash: 'h2', lastSynced: '2026-07-06T00:00:00.000Z' },
    })
  })

  it('handles an empty entries list as a no-op copy', () => {
    const ledger = ledgerFor({
      'reddit:abc': { contentHash: 'h1', lastSynced: '2026-01-01T00:00:00.000Z' },
    })
    const next = recordSynced(ledger, target, [])

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
  it('ignores unscoped v1 receipts rather than falsely skipping a target', async () => {
    const ledger = await Effect.runPromise(
      loadLedger().pipe(
        Effect.provide(
          kvTest({
            'porter/ledger': {
              nb1: {
                'reddit:abc': { contentHash: 'h1', lastSynced: '2026-07-11T00:00:00.000Z' },
              },
            },
          }),
        ),
      ),
    )

    expect(ledger).toEqual({})
  })

  it('keeps receipts separate for authuser slots sharing an email and notebook id', () => {
    const otherSlot = { ...target, authuser: 1 }
    const ledger = recordSynced({}, target, [
      { id: 'reddit:abc', contentHash: 'h1', now: '2026-07-11T00:00:00.000Z' },
    ])

    expect(isUnitSynced(ledger, target, { id: 'reddit:abc', contentHash: 'h1' })).toBe(true)
    expect(isUnitSynced(ledger, otherSlot, { id: 'reddit:abc', contentHash: 'h1' })).toBe(false)
    expect(ledger[notebookTargetKey(target)]).toBeDefined()
  })

  it('returns an empty ledger when persisted storage has an invalid nested entry', async () => {
    const ledger = await Effect.runPromise(
      loadLedger().pipe(
        Effect.provide(
          kvTest({
            [LEDGER_STORAGE_KEY]: {
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
      [notebookTargetKey(target)]: {
        'reddit:abc': { contentHash: 'h1', lastSynced: '2026-07-11T00:00:00.000Z' },
      },
    }
    const ledger = await Effect.runPromise(
      loadLedger().pipe(Effect.provide(kvTest({ [LEDGER_STORAGE_KEY]: stored }))),
    )

    expect(ledger).toEqual(stored)
  })
})
