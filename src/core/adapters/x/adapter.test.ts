import { describe, expect, it } from 'vitest'
import { X_CONTENT_MATCHES, xAdapter } from './adapter'

describe('xAdapter', () => {
  it('shares every advertised X host with its content scripts', () => {
    expect(xAdapter.hostMatch).toBe(X_CONTENT_MATCHES)
    expect(X_CONTENT_MATCHES).toContain('https://mobile.twitter.com/*')
  })
})
