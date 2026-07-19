import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'
import { IpcError } from './fx/errors'
import {
  decodeExtractResponse,
  decodePorterMessage,
  hasMessageType,
  unwrapPorterReply,
  type PorterMessage,
  type PorterReply,
} from './messaging'

const binding = { authuser: 0, accountEmail: 'porter@example.com' }
const target = { ...binding, notebookId: 'notebook-1' }
const capture = {
  kind: 'web' as const,
  web: {
    id: 'page-1',
    url: 'https://example.com',
    title: 'Example',
    mode: 'page' as const,
    text: 'Captured text',
  },
}

const validMessages: readonly PorterMessage[] = [
  { type: 'porter/detect', url: 'https://example.com' },
  {
    type: 'porter/capture-url',
    url: 'https://example.com',
    tabId: 1,
    options: { enrichTranscripts: true },
  },
  { type: 'porter/capture-page', tabId: 1 },
  { type: 'porter/capture-result', capture },
  { type: 'porter/list-docs' },
  { type: 'porter/delete-doc', docId: 'doc-1' },
  { type: 'porter/export', docIds: ['doc-1'], format: 'markdown' },
  { type: 'porter/queue-enqueue', docIds: ['doc-1'], target },
  { type: 'porter/queue-status' },
  { type: 'porter/queue-retry', jobIds: ['job-1'] },
  { type: 'porter/watch-create', docId: 'doc-1', target },
  { type: 'porter/watch-list' },
  { type: 'porter/watch-remove', watchId: 'watch-1' },
  { type: 'porter/list-notebooks', account: binding, forceRefresh: true },
  { type: 'porter/create-notebook', account: binding, title: 'New notebook' },
  { type: 'porter/nblm-scan-console', target },
  { type: 'porter/nblm-dedupe', target },
  { type: 'porter/nblm-retry-source', target, sourceId: 'source-1' },
  { type: 'porter/accounts-refresh' },
  { type: 'porter/get-settings' },
  { type: 'porter/update-settings', patch: { driveClientId: '' } },
  { type: 'porter/backup-drive', docIds: ['doc-1'] },
  { type: 'porter/debug-log' },
  { type: 'porter/debug-clear' },
]

describe('decodePorterMessage', () => {
  it('decodes every known message tag and drops extra top-level fields', () => {
    for (const message of validMessages) {
      const wire = { ...message, ignoredByNewerVersion: true }
      const decoded = decodePorterMessage(wire)
      expect(decoded).toEqual(message)
      expect(decoded).not.toBe(wire)
    }
  })

  it('rebuilds nested mutable payloads', () => {
    const wire = {
      type: 'porter/capture-result',
      capture: { ...capture, web: { ...capture.web } },
    }

    const decoded = decodePorterMessage(wire)

    expect(decoded).toEqual(wire)
    if (decoded?.type !== 'porter/capture-result' || decoded.capture.kind !== 'web') {
      throw new Error('expected decoded web capture')
    }
    expect(decoded.capture).not.toBe(wire.capture)
    expect(decoded.capture.web).not.toBe(wire.capture.web)
  })

  it.each([
    ['non-object', 'porter/detect'],
    ['unknown tag', { type: 'porter/unknown' }],
    ['non-string tag', { type: 42 }],
    ['missing required field', { type: 'porter/detect' }],
    ['unsafe tab id', { type: 'porter/capture-page', tabId: 1.5 }],
    [
      'invalid capture option',
      { type: 'porter/capture-url', url: 'x', tabId: 1, options: { enrichTranscripts: false } },
    ],
    ['invalid capture', { type: 'porter/capture-result', capture: { kind: 'web', web: {} } }],
    ['invalid id list', { type: 'porter/export', docIds: [1], format: 'markdown' }],
    ['invalid format', { type: 'porter/export', docIds: [], format: 'text' }],
    [
      'invalid account binding',
      { type: 'porter/list-notebooks', account: { authuser: 0, accountEmail: ' ' } },
    ],
    [
      'invalid notebook target',
      { type: 'porter/watch-create', docId: 'doc', target: { ...binding, notebookId: '' } },
    ],
    [
      'invalid force refresh',
      { type: 'porter/list-notebooks', account: binding, forceRefresh: false },
    ],
    ['invalid settings patch', { type: 'porter/update-settings', patch: { unknown: true } }],
    ['explicit undefined', { type: 'porter/delete-doc', docId: undefined }],
  ])('rejects %s', (_reason, value) => {
    expect(decodePorterMessage(value)).toBeUndefined()
  })

  it('rejects inherited message and target fields', () => {
    expect(
      decodePorterMessage(Object.create({ type: 'porter/detect', url: 'https://example.com' })),
    ).toBeUndefined()
    expect(
      decodePorterMessage({
        type: 'porter/queue-enqueue',
        docIds: [],
        target: Object.create(target),
      }),
    ).toBeUndefined()
  })
})

describe('decodeExtractResponse', () => {
  it('decodes and rebuilds a successful capture response', () => {
    const wire = { ok: true, capture, ignored: true }
    expect(decodeExtractResponse(wire)).toEqual({ ok: true, capture })
    expect(decodeExtractResponse(wire)?.ok).toBe(true)
  })

  it('decodes a failed response', () => {
    expect(decodeExtractResponse({ ok: false, error: 'not implemented yet' })).toEqual({
      ok: false,
      error: 'not implemented yet',
    })
  })

  it.each([
    'garbage',
    null,
    { ok: 'true', capture },
    { ok: true, capture: { kind: 'thread', thread: {} } },
    { ok: false, error: 42 },
  ])('rejects malformed replies', (value) => {
    expect(decodeExtractResponse(value)).toBeUndefined()
  })
})

describe('hasMessageType', () => {
  it('matches when type equals the given literal', () => {
    expect(hasMessageType({ type: 'porter/extract-thread' }, 'porter/extract-thread')).toBe(true)
  })

  it('does not match a different type or non-object value', () => {
    expect(hasMessageType({ type: 'porter/dom-deliver' }, 'porter/extract-thread')).toBe(false)
    expect(hasMessageType('porter/extract-thread', 'porter/extract-thread')).toBe(false)
    expect(hasMessageType(null, 'porter/extract-thread')).toBe(false)
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
