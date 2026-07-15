import { Effect } from 'effect'
import type { StorageError } from '../fx/errors'
import { Kv } from '../fx/services'

export const TIER_STATE_STORAGE_KEY = 'porter/ingest-tier/v1'
export const TIER_A_COOLDOWN_MS = 10 * 60 * 1000

export interface TierState {
  version: 1
  tierADegradedUntilByAccount: Record<string, string>
}

export function emptyTierState(): TierState {
  return { version: 1, tierADegradedUntilByAccount: {} }
}

export function isTierState(value: unknown): value is TierState {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 1 ||
    !('tierADegradedUntilByAccount' in value) ||
    typeof value.tierADegradedUntilByAccount !== 'object' ||
    value.tierADegradedUntilByAccount === null
  ) {
    return false
  }
  return Object.values(value.tierADegradedUntilByAccount).every(
    (until) => typeof until === 'string',
  )
}

/** The persisted Tier A cooldown expiry for an account, if it is currently degraded. */
export function degradedUntil(state: TierState, accountEmail: string): string | undefined {
  return state.tierADegradedUntilByAccount[accountEmail]
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

export function loadTierState(): Effect.Effect<TierState, StorageError, Kv> {
  return Effect.gen(function* () {
    const kv = yield* Kv
    const stored = yield* kv.get<unknown>(TIER_STATE_STORAGE_KEY)
    return isTierState(stored) ? stored : emptyTierState()
  })
}

export function saveTierState(state: TierState): Effect.Effect<void, StorageError, Kv> {
  return Effect.gen(function* () {
    const kv = yield* Kv
    yield* kv.set(TIER_STATE_STORAGE_KEY, state)
  })
}
