import { describe, expect, it } from 'vitest'
import { appendEntry, redact, type DebugEntry } from './debug'

function entry(msg: string): DebugEntry {
  return { t: '2026-07-06T00:00:00.000Z', scope: 'test', msg }
}

describe('appendEntry', () => {
  it('appends to an empty ring', () => {
    const result = appendEntry([], entry('a'))
    expect(result).toEqual([entry('a')])
  })

  it('preserves order under the cap', () => {
    const ring = [entry('a'), entry('b')]
    const result = appendEntry(ring, entry('c'), 5)
    expect(result.map((e) => e.msg)).toEqual(['a', 'b', 'c'])
  })

  it('drops the oldest entry once past the cap', () => {
    const ring = [entry('a'), entry('b'), entry('c')]
    const result = appendEntry(ring, entry('d'), 3)
    expect(result.map((e) => e.msg)).toEqual(['b', 'c', 'd'])
  })

  it('never mutates the input ring', () => {
    const ring = [entry('a')]
    appendEntry(ring, entry('b'), 1)
    expect(ring).toEqual([entry('a')])
  })

  it('defaults the cap to 100', () => {
    const ring = Array.from({ length: 100 }, (_, i) => entry(String(i)))
    const result = appendEntry(ring, entry('100'))
    expect(result).toHaveLength(100)
    expect(result[0]?.msg).toBe('1')
    expect(result[99]?.msg).toBe('100')
  })
})

describe('redact', () => {
  it('passes through plain strings unchanged', () => {
    expect(redact('hello world')).toBe('hello world')
  })

  it('redacts at= url token values', () => {
    expect(redact('https://x.com/rpc?at=abc123XYZ&rt=c')).toBe(
      'https://x.com/rpc?at=<redacted>&rt=c',
    )
  })

  it('redacts f.sid= url token values', () => {
    expect(redact('https://x.com/rpc?f.sid=-123456&authuser=0')).toBe(
      'https://x.com/rpc?f.sid=<redacted>&authuser=0',
    )
  })

  it('redacts access_token= url token values', () => {
    expect(redact('https://x.com/cb?access_token=ya29.abc-def&expires_in=3600')).toBe(
      'https://x.com/cb?access_token=<redacted>&expires_in=3600',
    )
  })

  it('redacts SNlM0e WIZ keys embedded in a JSON-looking string', () => {
    expect(redact('prefix "SNlM0e":"AF1qip_secret-csrf" suffix')).toBe(
      'prefix "SNlM0e":"<redacted>" suffix',
    )
  })

  it('redacts FdrFJe WIZ keys embedded in a JSON-looking string', () => {
    expect(redact('{"FdrFJe":"-8675309000000000000"}')).toBe('{"FdrFJe":"<redacted>"}')
  })

  it('truncates strings over 300 chars', () => {
    const long = 'x'.repeat(400)
    const result = redact(long) as string
    expect(result.endsWith('…[truncated]')).toBe(true)
    expect(result.length).toBe(300 + '…[truncated]'.length)
  })

  it('does not truncate strings at or under 300 chars', () => {
    const exact = 'x'.repeat(300)
    expect(redact(exact)).toBe(exact)
  })

  it('redacts tokens nested inside objects', () => {
    const input = { url: 'https://x.com?at=secret123', label: 'fine' }
    expect(redact(input)).toEqual({ url: 'https://x.com?at=<redacted>', label: 'fine' })
  })

  it('redacts tokens nested inside arrays', () => {
    const input = ['https://x.com?access_token=zzz', 'plain']
    expect(redact(input)).toEqual(['https://x.com?access_token=<redacted>', 'plain'])
  })

  it('redacts deeply nested structures', () => {
    const input = { a: { b: [{ c: '"SNlM0e":"deep-secret"' }] } }
    expect(redact(input)).toEqual({ a: { b: [{ c: '"SNlM0e":"<redacted>"' }] } })
  })

  it('passes through numbers, booleans, and null unchanged', () => {
    expect(redact(42)).toBe(42)
    expect(redact(true)).toBe(true)
    expect(redact(null)).toBe(null)
  })

  it('handles non-JSON-safe values without throwing', () => {
    expect(() => redact(undefined)).not.toThrow()
    expect(() => redact(() => {})).not.toThrow()
    expect(() => redact(Symbol('x'))).not.toThrow()
  })
})
