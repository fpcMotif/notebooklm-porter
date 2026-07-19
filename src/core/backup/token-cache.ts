/**
 * Drive OAuth token cache — pure decision logic only (no `Kv`, no fetch).
 * `client.ts` persists a `CachedToken` after a successful interactive auth
 * (using `drive.ts`'s `expiresInSec`, previously thrown away) and consults
 * this module to decide whether to reuse it or run the interactive flow
 * again, and whether a failed Drive request means the token is dead.
 */

/** Reuse is refused this long before the real expiry, to absorb request latency. */
const SAFETY_MARGIN_MS = 60_000

export interface CachedToken {
  accessToken: string
  expiresAt: number
}

/**
 * Sentinel written on invalidation. `expiresAt: 0` makes `shouldReuse` fail
 * for any `now`, without needing `Kv` to support deleting a key.
 */
export const CLEARED_TOKEN_CACHE: CachedToken = { accessToken: '', expiresAt: 0 }

/** True when `cached` is present and still valid at least `SAFETY_MARGIN_MS` past `now`. */
export function shouldReuse(cached: CachedToken | undefined, now: number): cached is CachedToken {
  return cached !== undefined && now < cached.expiresAt - SAFETY_MARGIN_MS
}

/** Builds the cache entry to persist right after a successful interactive auth. */
export function cacheFromAuthResult(
  accessToken: string,
  expiresInSec: number,
  now: number,
): CachedToken {
  return { accessToken, expiresAt: now + expiresInSec * 1000 }
}

/** Drive's signal that the bearer token is dead — expired, revoked, or malformed. */
export function isUnauthorizedStatus(status: number): boolean {
  return status === 401
}
