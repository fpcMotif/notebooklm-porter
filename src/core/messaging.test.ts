import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { IpcError } from './fx/errors'
import {
  hasMessageType,
  isExtractResponse,
  isPorterMessage,
  unwrapPorterReply,
  type PorterReply,
} from './messaging'

describe('isPorterMessage', () => {
  it('accepts a message with a porter/-prefixed type', () => {
    expect(isPorterMessage({ type: 'porter/detect', url: 'https://example.com' })).toBe(true)
  })

  it('rejects a non-object', () => {
    expect(isPorterMessage('porter/detect')).toBe(false)
    expect(isPorterMessage(null)).toBe(false)
    expect(isPorterMessage(undefined)).toBe(false)
  })

  it('rejects an object with a non-string type', () => {
    expect(isPorterMessage({ type: 42 })).toBe(false)
  })

  it('rejects an object whose type does not start with porter/', () => {
    expect(isPorterMessage({ type: 'other/thing' })).toBe(false)
  })
})

describe('hasMessageType', () => {
  it('matches when type equals the given literal', () => {
    expect(hasMessageType({ type: 'porter/extract-thread' }, 'porter/extract-thread')).toBe(true)
  })

  it('does not match a different type', () => {
    expect(hasMessageType({ type: 'porter/dom-deliver' }, 'porter/extract-thread')).toBe(false)
  })

  it('rejects a non-object value', () => {
    expect(hasMessageType('porter/extract-thread', 'porter/extract-thread')).toBe(false)
    expect(hasMessageType(null, 'porter/extract-thread')).toBe(false)
  })
})

describe('isExtractResponse', () => {
  it('accepts ok:true with an object capture', () => {
    expect(isExtractResponse({ ok: true, capture: { kind: 'thread', thread: {} } })).toBe(true)
  })

  it('rejects ok:true missing capture', () => {
    expect(isExtractResponse({ ok: true })).toBe(false)
  })

  it('accepts ok:false with a string error', () => {
    expect(isExtractResponse({ ok: false, error: 'not implemented yet' })).toBe(true)
  })

  it('rejects garbage', () => {
    expect(isExtractResponse('garbage')).toBe(false)
    expect(isExtractResponse(null)).toBe(false)
    expect(isExtractResponse({ ok: 'true', capture: {} })).toBe(false)
    expect(isExtractResponse({ ok: false, error: 42 })).toBe(false)
  })
})

describe('unwrapPorterReply', () => {
  it('extracts the payload from an ok:true reply', async () => {
    const reply: PorterReply<'porter/list-docs'> = { ok: true, docs: [] }
    const payload = await Effect.runPromise(unwrapPorterReply(reply))
    expect(payload).toEqual({ docs: [] })
  })

  it('extracts an empty payload from an ok:true reply with no fields', async () => {
    const reply: PorterReply<'porter/delete-doc'> = { ok: true }
    const payload = await Effect.runPromise(unwrapPorterReply(reply))
    expect(payload).toEqual({})
  })

  it('fails with IpcError carrying the reply error on ok:false', async () => {
    const reply: PorterReply<'porter/list-docs'> = { ok: false, error: 'boom' }
    const failure = await Effect.runPromise(Effect.flip(unwrapPorterReply(reply)))
    expect(failure).toBeInstanceOf(IpcError)
    expect(failure.reason).toBe('boom')
  })
})
