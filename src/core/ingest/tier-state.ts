import { Effect } from 'effect'
import type { StorageError } from '../fx/errors'
import { Kv } from '../fx/services'

export const TIER_STATE_STORAGE_KEY = 'porter/ingest-tier/v1'
export const TIER_A_COOLDOWN_MS = 10 * 60 * 1000

export interface TierState {
  version: 1
  tierADegradedUntilByAccount: Record<string, string>
}

type UnknownRecord = Record<string, unknown>

function isPlainRecord(value: unknown): value is UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) return false
  try {
    return new Date(milliseconds).toISOString() === value
  } catch {
    return false
  }
}

export function emptyTierState(): TierState {
  return { version: 1, tierADegradedUntilByAccount: {} }
}

/**
 * Decode the short-lived Tier A circuit breaker. Stored state cannot extend
 * the DOM fallback beyond one fresh cooldown window.
 */
export function decodeStoredTierState(value: unknown, nowMs: number): TierState {
  if (
    !Number.isFinite(nowMs) ||
    !isPlainRecord(value) ||
    !Object.hasOwn(value, 'version') ||
    value.version !== 1 ||
    !Object.hasOwn(value, 'tierADegradedUntilByAccount') ||
    !isPlainRecord(value.tierADegradedUntilByAccount)
  ) {
    return emptyTierState()
  }

  const tierADegradedUntilByAccount: Record<string, string> = {}
  const latestAllowedMs = nowMs + TIER_A_COOLDOWN_MS
  for (const [accountEmail, until] of Object.entries(value.tierADegradedUntilByAccount)) {
    if (accountEmail.trim() === '' || !isCanonicalIsoTimestamp(until)) continue
    const untilMs = Date.parse(until)
    if (untilMs <= nowMs || untilMs > latestAllowedMs) continue
    Object.defineProperty(tierADegradedUntilByAccount, accountEmail, {
      value: until,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }

  return { version: 1, tierADegradedUntilByAccount }
}

/** Tier A is skipped only while an observed read-only canary remains degraded. */
export function routeForTierA(state: TierState, accountEmail: string, now: string): 'rpc' | 'dom' {
  const until = state.tierADegradedUntilByAccount[accountEmail]
  if (until === undefined) return 'rpc'
  const untilMs = Date.parse(until)
  const nowMs = Date.parse(now)
  return Number.isFinite(untilMs) && Number.isFinite(nowMs) && untilMs > nowMs ? 'dom' : 'rpc'
}

export function degradeForPreflightDrift(
  state: TierState,
  accountEmail: string,
  now: string,
): TierState {
  const nowMs = Date.parse(now)
  if (!Number.isFinite(nowMs)) return state
  return {
    ...state,
    tierADegradedUntilByAccount: {
      ...state.tierADegradedUntilByAccount,
      [accountEmail]: new Date(nowMs + TIER_A_COOLDOWN_MS).toISOString(),
    },
  }
}

export function recoverAfterHealthyPreflight(state: TierState, accountEmail: string): TierState {
  const { [accountEmail]: _until, ...tierADegradedUntilByAccount } =
    state.tierADegradedUntilByAccount
  return { ...state, tierADegradedUntilByAccount }
}

export function loadTierState(nowMs = Date.now()): Effect.Effect<TierState, StorageError, Kv> {
  return Effect.gen(function* () {
    const kv = yield* Kv
    const stored = yield* kv.get<unknown>(TIER_STATE_STORAGE_KEY)
    return decodeStoredTierState(stored, nowMs)
  })
}

export function saveTierState(state: TierState): Effect.Effect<void, StorageError, Kv> {
  return Effect.gen(function* () {
    const kv = yield* Kv
    yield* kv.set(TIER_STATE_STORAGE_KEY, state)
  })
}
