import { assert, describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { vi } from 'vitest'
import { kvTest } from '../fx/testing'
import {
  TIER_A_COOLDOWN_MS,
  TIER_STATE_STORAGE_KEY,
  decodeStoredTierState,
  degradeForPreflightDrift,
  emptyTierState,
  loadTierState,
  recoverAfterHealthyPreflight,
  routeForTierA,
} from './tier-state'

const NOW = '2026-07-11T00:00:00.000Z'
const NOW_MS = Date.parse(NOW)

function storedState(entries: Record<string, unknown> = {}) {
  return { version: 1, tierADegradedUntilByAccount: entries }
}

describe('Tier A degradation state', () => {
  it('routes around a degraded canary for exactly its bounded cooldown', () => {
    const state = degradeForPreflightDrift(emptyTierState(), 'f@example.com', NOW)
    const until = state.tierADegradedUntilByAccount['f@example.com']

    expect(until).toBe(new Date(Date.parse(NOW) + TIER_A_COOLDOWN_MS).toISOString())
    expect(routeForTierA(state, 'f@example.com', NOW)).toBe('dom')
    expect(routeForTierA(state, 'f@example.com', until ?? NOW)).toBe('rpc')
    expect(routeForTierA(state, 'other@example.com', NOW)).toBe('rpc')
  })

  it('leaves the persisted routing state unchanged when the preflight clock is invalid', () => {
    const state = {
      version: 1 as const,
      tierADegradedUntilByAccount: { 'existing@example.com': '2026-07-11T00:10:00.000Z' },
    }

    expect(degradeForPreflightDrift(state, 'f@example.com', 'not-a-time')).toBe(state)
  })

  it('recovers only a healthy account', () => {
    expect(
      recoverAfterHealthyPreflight(
        {
          version: 1,
          tierADegradedUntilByAccount: { f: 'later', g: 'later' },
        },
        'f',
      ),
    ).toEqual({ version: 1, tierADegradedUntilByAccount: { g: 'later' } })
  })

  it('drops every persisted form that could spuriously route to DOM', () => {
    const bounded = new Date(NOW_MS + 1).toISOString()
    const nonCanonical = '2026-07-11T00:00:01Z'
    const unbounded = new Date(NOW_MS + TIER_A_COOLDOWN_MS + 1).toISOString()
    const prototypeRoot = Object.create(storedState({ 'f@example.com': bounded }))
    const prototypeEntries = Object.create({ 'f@example.com': bounded })
    const cases: unknown[] = [
      [],
      undefined,
      prototypeRoot,
      { version: 1, tierADegradedUntilByAccount: [] },
      { version: 1, tierADegradedUntilByAccount: prototypeEntries },
      storedState({ 'f@example.com': undefined }),
      storedState({ 'f@example.com': nonCanonical }),
      storedState({ 'f@example.com': unbounded }),
    ]

    for (const stored of cases) {
      const decoded = decodeStoredTierState(stored, NOW_MS)
      expect(routeForTierA(decoded, 'f@example.com', NOW)).toBe('rpc')
    }
  })

  it('keeps only fresh bounded entries in detached records', () => {
    const valid = new Date(NOW_MS + 1).toISOString()
    const stored = storedState({
      'f@example.com': valid,
      ' ': valid,
      expired: NOW,
      malformed: 'later',
    })

    const decoded = decodeStoredTierState(stored, NOW_MS)

    expect(decoded).toEqual(storedState({ 'f@example.com': valid }))
    expect(decoded).not.toBe(stored)
    expect(decoded.tierADegradedUntilByAccount).not.toBe(stored.tierADegradedUntilByAccount)
    expect(routeForTierA(decoded, 'f@example.com', NOW)).toBe('dom')
  })

  it('loads a detached, bounded state using the current clock', async () => {
    const valid = new Date(NOW_MS + TIER_A_COOLDOWN_MS).toISOString()
    const stored = storedState({ 'f@example.com': valid })
    const now = vi.spyOn(Date, 'now').mockReturnValue(NOW_MS)

    try {
      const state = await Effect.runPromise(
        loadTierState().pipe(Effect.provide(kvTest({ [TIER_STATE_STORAGE_KEY]: stored }))),
      )
      assert.deepStrictEqual(state, stored)
      expect(state).not.toBe(stored)
      expect(state.tierADegradedUntilByAccount).not.toBe(stored.tierADegradedUntilByAccount)
    } finally {
      now.mockRestore()
    }
  })

  it('uses an injected clock instead of the ambient clock', async () => {
    const valid = new Date(NOW_MS + 1).toISOString()
    const ambientNow = vi.spyOn(Date, 'now').mockReturnValue(NOW_MS + TIER_A_COOLDOWN_MS + 1)

    try {
      const state = await Effect.runPromise(
        loadTierState(NOW_MS).pipe(
          Effect.provide(
            kvTest({ [TIER_STATE_STORAGE_KEY]: storedState({ 'f@example.com': valid }) }),
          ),
        ),
      )
      expect(state.tierADegradedUntilByAccount).toEqual({ 'f@example.com': valid })
    } finally {
      ambientNow.mockRestore()
    }
  })
})
