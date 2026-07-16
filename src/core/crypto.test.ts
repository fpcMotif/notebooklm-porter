import { describe, expect, it } from 'vitest'
import { sha256Base64Url } from './crypto'

describe('sha256Base64Url', () => {
  it('returns the full, unpadded SHA-256 base64url digest', async () => {
    expect(await sha256Base64Url('reddit:t3_abc')).toBe(
      'BdkudWmp4cqiT12wgWEUx1kC-flHm2bN1z8FPtVJHQ0',
    )
  })
})
