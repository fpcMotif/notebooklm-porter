import { describe, expect, it } from 'vitest'
import {
  CLEARED_TOKEN_CACHE,
  cacheFromAuthResult,
  isUnauthorizedStatus,
  shouldReuse,
  type CachedToken,
} from './token-cache'

describe('shouldReuse', () => {
  it('is false when there is no cached token', () => {
    expect(shouldReuse(undefined, 1_000)).toBe(false)
  })

  it('is true well before expiry', () => {
    const cached: CachedToken = { accessToken: 'tok', expiresAt: 100_000 }
    expect(shouldReuse(cached, 1_000)).toBe(true)
  })

  it('is false once inside the 60s safety margin', () => {
    const cached: CachedToken = { accessToken: 'tok', expiresAt: 100_000 }
    expect(shouldReuse(cached, 100_000 - 60_000)).toBe(false)
  })

  it('is true one millisecond before the safety margin boundary', () => {
    const cached: CachedToken = { accessToken: 'tok', expiresAt: 100_000 }
    expect(shouldReuse(cached, 100_000 - 60_000 - 1)).toBe(true)
  })

  it('is false once already expired', () => {
    const cached: CachedToken = { accessToken: 'tok', expiresAt: 100_000 }
    expect(shouldReuse(cached, 200_000)).toBe(false)
  })

  it('is false for the cleared-cache sentinel at any realistic now', () => {
    expect(shouldReuse(CLEARED_TOKEN_CACHE, Date.now())).toBe(false)
  })
})

describe('cacheFromAuthResult', () => {
  it('computes expiresAt as now + expiresInSec in milliseconds', () => {
    expect(cacheFromAuthResult('tok', 3599, 1_000)).toEqual({
      accessToken: 'tok',
      expiresAt: 1_000 + 3_599_000,
    })
  })

  it('round-trips through shouldReuse as valid immediately after caching', () => {
    const now = 1_000
    const cached = cacheFromAuthResult('tok', 3599, now)
    expect(shouldReuse(cached, now)).toBe(true)
  })
})

describe('isUnauthorizedStatus', () => {
  it('is true for 401', () => {
    expect(isUnauthorizedStatus(401)).toBe(true)
  })

  it('is false for other statuses, including other 4xx/5xx', () => {
    expect(isUnauthorizedStatus(200)).toBe(false)
    expect(isUnauthorizedStatus(403)).toBe(false)
    expect(isUnauthorizedStatus(404)).toBe(false)
    expect(isUnauthorizedStatus(500)).toBe(false)
    expect(isUnauthorizedStatus(0)).toBe(false)
  })
})
