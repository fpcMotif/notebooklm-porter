import { describe, expect, it } from 'vitest'
import {
  isDomDeliveryRequest,
  isDomDeliveryResult,
  isTargetNotebookUrl,
  normalizeDomDeliveryResult,
} from './contracts'

const request = {
  notebookId: 'nb-1',
  authuser: 0,
  unit: {
    kind: 'text' as const,
    docId: 'reddit:1',
    id: 'reddit:1',
    contentHash: 'hash',
    title: 'Thread',
    markdown: '# Thread',
  },
}

describe('DOM delivery contracts', () => {
  it('accepts one complete immutable unit request', () => {
    expect(isDomDeliveryRequest(request)).toBe(true)
    expect(isDomDeliveryRequest({ ...request, authuser: -1 })).toBe(false)
    expect(isDomDeliveryRequest({ ...request, unit: { kind: 'text' } })).toBe(false)
  })

  it('keeps only explicit relay outcomes and treats malformed replies as uncertain', () => {
    expect(isDomDeliveryResult({ status: 'sent' })).toBe(true)
    expect(isDomDeliveryResult({ status: 'unavailable', reason: 'No profile' })).toBe(true)
    expect(isDomDeliveryResult({ status: 'unavailable' })).toBe(false)
    expect(normalizeDomDeliveryResult({ ok: true })).toEqual({
      status: 'uncertain',
      reason: 'NotebookLM DOM relay returned an invalid response',
    })
  })

  it('requires the exact requested NotebookLM route before a DOM driver may submit', () => {
    expect(
      isTargetNotebookUrl('https://notebooklm.google.com/notebook/nb-1?authuser=0', 'nb-1'),
    ).toBe(true)
    expect(isTargetNotebookUrl('https://notebooklm.google.com/notebook/nb-10', 'nb-1')).toBe(false)
    expect(isTargetNotebookUrl('https://example.com/notebook/nb-1', 'nb-1')).toBe(false)
  })
})
