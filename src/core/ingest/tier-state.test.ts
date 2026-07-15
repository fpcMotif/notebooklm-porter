import { describe, expect, it } from 'vitest'
import {
  TIER_A_COOLDOWN_MS,
  degradeForPreflightDrift,
  degradedUntil,
  emptyTierState,
  isTierState,
  recoverAfterHealthyPreflight,
  routeForTierA,
} from './tier-state'

const NOW = '2026-07-11T00:00:00.000Z'

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

  it('exposes the degraded-until timestamp for a known account and undefined otherwise', () => {
    const state = degradeForPreflightDrift(emptyTierState(), 'f@example.com', NOW)

    expect(degradedUntil(state, 'f@example.com')).toBe(
      new Date(Date.parse(NOW) + TIER_A_COOLDOWN_MS).toISOString(),
    )
    expect(degradedUntil(state, 'unknown@example.com')).toBeUndefined()
  })

  it('rejects malformed persisted state and recovers only a healthy account', () => {
    expect(isTierState({ version: 2 })).toBe(false)
    expect(isTierState({ version: 1, tierADegradedUntilByAccount: { f: 'later' } })).toBe(true)
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
})
