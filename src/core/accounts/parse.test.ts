import { describe, expect, it } from 'vitest'
import { parseNblmHome } from './parse'

const LOGGED_IN_WITH_OPEP7C = `
<html><head><script>
var data = {"SNlM0e":"AF1qip_csrf-token-abc123","oPEP7c":"user@gmail.com","otherKey":"ignored"};
</script></head></html>
`

const LOGGED_IN_GENERIC_EMAIL_ONLY = `
<html><head><script>
var data = {"SNlM0e":"AF1qip_csrf-token-xyz789","someField":"not-an-email","accountLabel":"jane.doe@example.co.uk"};
</script></head></html>
`

const LOGGED_OUT = `
<html><head><script>
var data = {"someOtherKey":"value","noCsrfHere":true};
</script></head></html>
`

const GARBAGE = `not even html <<<>>> {{{ malformed`

describe('parseNblmHome', () => {
  it('parses a logged-in page with oPEP7c email', () => {
    const result = parseNblmHome(LOGGED_IN_WITH_OPEP7C)
    expect(result).toEqual({
      loggedIn: true,
      email: 'user@gmail.com',
      csrfToken: 'AF1qip_csrf-token-abc123',
    })
  })

  it('falls back to the first quoted email-looking string when oPEP7c is absent', () => {
    const result = parseNblmHome(LOGGED_IN_GENERIC_EMAIL_ONLY)
    expect(result).toEqual({
      loggedIn: true,
      email: 'jane.doe@example.co.uk',
      csrfToken: 'AF1qip_csrf-token-xyz789',
    })
  })

  it('reports loggedIn false and omits email/csrfToken keys when no SNlM0e is present', () => {
    const result = parseNblmHome(LOGGED_OUT)
    expect(result).toEqual({ loggedIn: false })
    expect('email' in result).toBe(false)
    expect('csrfToken' in result).toBe(false)
  })

  it('handles garbage HTML without throwing', () => {
    const result = parseNblmHome(GARBAGE)
    expect(result).toEqual({ loggedIn: false })
  })
})
