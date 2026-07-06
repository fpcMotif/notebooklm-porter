import { describe, expect, it } from 'vitest'
import {
  batchexecuteUrl,
  buildEnvelope,
  homeUrl,
  parseBatchexecuteResponse,
  RPC_IDS,
} from './protocol'

describe('RPC_IDS', () => {
  it('pins the three RPC ids used by the ingest client', () => {
    expect(RPC_IDS).toEqual({
      addSource: 'izAoDd',
      addSourceFile: 'o4cbdc',
      listNotebooks: 'wXbhsf',
    })
  })
})

describe('batchexecuteUrl / homeUrl', () => {
  it('threads authuser through the batchexecute endpoint', () => {
    expect(batchexecuteUrl(0)).toBe(
      'https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute?authuser=0',
    )
    expect(batchexecuteUrl(2)).toBe(
      'https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute?authuser=2',
    )
  })

  it('threads authuser through the home url', () => {
    expect(homeUrl(0)).toBe('https://notebooklm.google.com/?authuser=0')
    expect(homeUrl(3)).toBe('https://notebooklm.google.com/?authuser=3')
  })
})

describe('buildEnvelope', () => {
  it('builds the f.req + at body, url-encoded', () => {
    const body = buildEnvelope(RPC_IDS.addSource, ['https://example.com'], 'csrf-token-1')
    const fReq = JSON.stringify([
      [[RPC_IDS.addSource, JSON.stringify(['https://example.com']), null, 'generic']],
    ])
    expect(body).toBe(`f.req=${encodeURIComponent(fReq)}&at=${encodeURIComponent('csrf-token-1')}`)
  })

  it('url-encodes csrf tokens containing special characters', () => {
    const body = buildEnvelope(RPC_IDS.listNotebooks, {}, 'a+b/c=d')
    expect(body).toContain(`at=${encodeURIComponent('a+b/c=d')}`)
    expect(body).not.toContain('at=a+b/c=d')
  })
})

describe('parseBatchexecuteResponse', () => {
  it('parses a well-formed response, stripping the anti-XSSI prefix', () => {
    const payload = JSON.stringify({ sourceId: 'abc123', ok: true })
    const line = JSON.stringify([
      ['wrb.fr', RPC_IDS.addSource, payload, null, null, null, 'generic'],
    ])
    const text = `)]}'\n\n${line}`

    const result = parseBatchexecuteResponse(text, RPC_IDS.addSource)
    expect(result).toEqual({ sourceId: 'abc123', ok: true })
  })

  it('parses a response with multiple chunks, picking the matching rpcId', () => {
    const otherPayload = JSON.stringify({ irrelevant: true })
    const targetPayload = JSON.stringify(['notebook-1', 'notebook-2'])
    const otherLine = JSON.stringify([['wrb.fr', 'someOtherRpc', otherPayload]])
    const targetLine = JSON.stringify([['wrb.fr', RPC_IDS.listNotebooks, targetPayload]])
    const text = `)]}'\n${otherLine}\n${targetLine}`

    const result = parseBatchexecuteResponse(text, RPC_IDS.listNotebooks)
    expect(result).toEqual(['notebook-1', 'notebook-2'])
  })

  it('parses a response without the anti-XSSI prefix', () => {
    const payload = JSON.stringify({ sourceId: 'no-prefix' })
    const line = JSON.stringify([['wrb.fr', RPC_IDS.addSource, payload]])

    const result = parseBatchexecuteResponse(line, RPC_IDS.addSource)
    expect(result).toEqual({ sourceId: 'no-prefix' })
  })

  it('throws a protocol-drift error when no wrb.fr line matches the rpcId', () => {
    const line = JSON.stringify([['wrb.fr', 'unrelatedRpc', JSON.stringify({})]])
    const text = `)]}'\n${line}`

    expect(() => parseBatchexecuteResponse(text, RPC_IDS.addSource)).toThrow(/^protocol-drift:/)
  })

  it('throws a protocol-drift error on totally unparseable garbage', () => {
    const text = `)]}'\nnot json at all {{{`

    expect(() => parseBatchexecuteResponse(text, RPC_IDS.addSource)).toThrow(/^protocol-drift:/)
  })

  it('throws a protocol-drift error when the matched payload itself is unparseable', () => {
    const line = JSON.stringify([['wrb.fr', RPC_IDS.addSource, 'not-valid-json{{']])
    const text = `)]}'\n${line}`

    expect(() => parseBatchexecuteResponse(text, RPC_IDS.addSource)).toThrow(/^protocol-drift:/)
  })
})
