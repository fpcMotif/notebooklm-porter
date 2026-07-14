import { describe, expect, it } from 'vitest'
import {
  addTextSourceParams,
  addUrlSourceParams,
  addYoutubeSourceParams,
  buildEnvelope,
  buildRpcUrl,
  createNotebookParams,
  deleteSourceParams,
  getNotebookParams,
  homeUrl,
  listNotebooksParams,
  parseBatchexecuteResponse,
  parseNotebookList,
  parseNotebookSources,
  refreshSourceParams,
  RPC_IDS,
  TEMPLATE_BLOCK,
} from './protocol'

describe('RPC_IDS', () => {
  it('pins the RPC ids used by the ingest + source-console client', () => {
    expect(RPC_IDS).toEqual({
      addSource: 'izAoDd',
      addSourceFile: 'o4cbdc',
      listNotebooks: 'wXbhsf',
      createNotebook: 'CCqFvf',
      getNotebook: 'rLM1Ne',
      deleteSource: 'tGMBJ',
      refreshSource: 'FLmJqe',
    })
  })
})

describe('source-console params', () => {
  it('builds GET_NOTEBOOK params for a notebook id', () => {
    expect(getNotebookParams('nb-1')).toEqual(['nb-1', null, [2], null, 0])
  })

  it('builds DELETE_SOURCE params for a source id', () => {
    expect(deleteSourceParams('src-1')).toEqual([[['src-1']]])
  })

  it('builds REFRESH_SOURCE params for a source id', () => {
    expect(refreshSourceParams('src-1')).toEqual([null, ['src-1'], [2]])
  })
})

describe('parseNotebookSources', () => {
  // GET_NOTEBOOK result: sources live at result[0][1]; each entry is
  // [idEnvelope, title, metadata, statusBlock]. metadata[4]=type, [7][0]/[5][0]=url,
  // [2][0]=created ts; statusBlock[1]=status code.
  const result = [
    [
      'notebook-meta',
      [
        [
          ['src-web'],
          'A web page',
          [null, null, [1700000000], null, 5, null, null, ['https://example.com/a']],
          [null, 2],
        ],
        [['src-yt'], 'A video', [null, null, null, null, 9, ['https://youtu.be/abc']], [null, 3]],
        [[null, true, ['src-drive']], 'A doc', [null, null, null, null, 1], [null, 1]],
        'malformed-row',
      ],
    ],
  ]

  it('decodes id, title, url, kind, status, and createdAt across id-envelope shapes', () => {
    expect(parseNotebookSources(result)).toEqual([
      {
        id: 'src-web',
        title: 'A web page',
        kind: 'web_page',
        status: 'ready',
        url: 'https://example.com/a',
        createdAt: 1700000000,
      },
      {
        id: 'src-yt',
        title: 'A video',
        kind: 'youtube',
        status: 'error',
        url: 'https://youtu.be/abc',
      },
      { id: 'src-drive', title: 'A doc', kind: 'google_docs', status: 'processing' },
    ])
  })

  it('returns [] for a genuinely empty notebook (null sources slot)', () => {
    expect(parseNotebookSources([['notebook-meta', null]])).toEqual([])
  })

  it('returns [] for a malformed top-level shape', () => {
    expect(parseNotebookSources(null)).toEqual([])
    expect(parseNotebookSources([['meta']])).toEqual([])
  })
})

describe('homeUrl', () => {
  it('threads authuser through the home url', () => {
    expect(homeUrl(0)).toBe('https://notebooklm.google.com/?authuser=0')
    expect(homeUrl(3)).toBe('https://notebooklm.google.com/?authuser=3')
  })
})

describe('buildRpcUrl', () => {
  it('builds the list-notebooks url with source-path "/" and f.sid present', () => {
    const url = buildRpcUrl({
      rpcId: RPC_IDS.listNotebooks,
      authuser: 0,
      fSid: '-1234567890',
      sourcePath: '/',
    })
    expect(url).toBe(
      'https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute' +
        '?rpcids=wXbhsf&source-path=%2F&f.sid=-1234567890&hl=en&rt=c&authuser=0',
    )
  })

  it('builds the add-source url with a URL-encoded notebook source-path', () => {
    const url = buildRpcUrl({
      rpcId: RPC_IDS.addSource,
      authuser: 2,
      fSid: 'abc',
      sourcePath: '/notebook/some-id-123',
    })
    expect(url).toBe(
      'https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute' +
        '?rpcids=izAoDd&source-path=%2Fnotebook%2Fsome-id-123&f.sid=abc&hl=en&rt=c&authuser=2',
    )
  })

  it('omits the f.sid param entirely when fSid is undefined', () => {
    const url = buildRpcUrl({ rpcId: RPC_IDS.listNotebooks, authuser: 0 })
    expect(url).not.toContain('f.sid')
    expect(url).toBe(
      'https://notebooklm.google.com/_/LabsTailwindUi/data/batchexecute' +
        '?rpcids=wXbhsf&source-path=%2F&hl=en&rt=c&authuser=0',
    )
  })
})

describe('buildEnvelope', () => {
  it('builds the f.req + at body, url-encoded, with a trailing &', () => {
    const body = buildEnvelope(RPC_IDS.addSource, ['https://example.com'], 'csrf-token-1')
    const fReq = JSON.stringify([
      [[RPC_IDS.addSource, JSON.stringify(['https://example.com']), null, 'generic']],
    ])
    expect(body).toBe(`f.req=${encodeURIComponent(fReq)}&at=${encodeURIComponent('csrf-token-1')}&`)
    expect(body.endsWith('&')).toBe(true)
  })

  it('url-encodes csrf tokens containing special characters', () => {
    const body = buildEnvelope(RPC_IDS.listNotebooks, {}, 'a+b/c=d')
    expect(body).toContain(`at=${encodeURIComponent('a+b/c=d')}`)
    expect(body).not.toContain('at=a+b/c=d')
  })
})

describe('TEMPLATE_BLOCK', () => {
  it('matches the 2026 migrated wire format exactly', () => {
    expect(TEMPLATE_BLOCK).toEqual([
      2,
      null,
      null,
      [1, null, null, null, null, null, null, null, null, null, [1]],
    ])
  })
})

describe('params builders', () => {
  it('listNotebooksParams matches the wire template verbatim', () => {
    expect(listNotebooksParams()).toEqual([null, 1, null, [2]])
  })

  it('createNotebookParams matches the wire template verbatim', () => {
    expect(createNotebookParams('My Notebook')).toEqual(['My Notebook', null, null, TEMPLATE_BLOCK])
  })

  it('addUrlSourceParams matches the website-URL spec variant verbatim', () => {
    expect(addUrlSourceParams('nb-1', 'https://example.com/article')).toEqual([
      [[null, null, ['https://example.com/article'], null, null, null, null, null, null, null, 1]],
      'nb-1',
      TEMPLATE_BLOCK,
    ])
  })

  it('addYoutubeSourceParams places the url at spec index 7 verbatim', () => {
    expect(addYoutubeSourceParams('nb-1', 'https://www.youtube.com/watch?v=abc123')).toEqual([
      [
        [
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          ['https://www.youtube.com/watch?v=abc123'],
          null,
          null,
          1,
        ],
      ],
      'nb-1',
      TEMPLATE_BLOCK,
    ])
  })

  it('addTextSourceParams matches the pasted-text spec variant verbatim', () => {
    expect(addTextSourceParams('nb-1', 'Thread Title', 'body content')).toEqual([
      [[null, ['Thread Title', 'body content'], null, 2, null, null, null, null, null, null, 1]],
      'nb-1',
      TEMPLATE_BLOCK,
    ])
  })
})

/** Byte-count line + JSON-array-chunk line, alternating, per the real rt=c format. */
function chunk(frames: unknown[][]): string {
  const line = JSON.stringify(frames)
  return `${line.length}\n${line}`
}

describe('parseBatchexecuteResponse', () => {
  it('parses the real captured add-URL response frame shape', () => {
    const resultArray = [
      [[['20d66b0b-0000-0000-0000-000000000000'], 'Artificial intelligence - Wikipedia', []]],
    ]
    const frame = [
      'wrb.fr',
      RPC_IDS.addSource,
      JSON.stringify(resultArray),
      null,
      null,
      null,
      'generic',
    ]
    const text = `)]}'\n${chunk([frame])}\n`

    const result = parseBatchexecuteResponse(text, RPC_IDS.addSource) as typeof resultArray
    expect(result[0]?.[0]?.[0]).toEqual(['20d66b0b-0000-0000-0000-000000000000'])
    expect(result[0]?.[0]?.[1]).toBe('Artificial intelligence - Wikipedia')
  })

  it('tolerates inexact/mismatched byte-count lines', () => {
    const payload = JSON.stringify({ sourceId: 'abc123', ok: true })
    const frame = ['wrb.fr', RPC_IDS.addSource, payload]
    const line = JSON.stringify([frame])
    // Deliberately wrong byte count — parser must not depend on it.
    const text = `)]}'\n999\n${line}\n`

    const result = parseBatchexecuteResponse(text, RPC_IDS.addSource)
    expect(result).toEqual({ sourceId: 'abc123', ok: true })
  })

  it('parses a response with multiple chunks, picking the matching rpcId', () => {
    const otherPayload = JSON.stringify({ irrelevant: true })
    const targetPayload = JSON.stringify(['notebook-1', 'notebook-2'])
    const text = `)]}'\n${chunk([['wrb.fr', 'someOtherRpc', otherPayload]])}\n${chunk([
      ['wrb.fr', RPC_IDS.listNotebooks, targetPayload],
    ])}\n`

    const result = parseBatchexecuteResponse(text, RPC_IDS.listNotebooks)
    expect(result).toEqual(['notebook-1', 'notebook-2'])
  })

  it('parses a response without the anti-XSSI prefix', () => {
    const payload = JSON.stringify({ sourceId: 'no-prefix' })
    const text = chunk([['wrb.fr', RPC_IDS.addSource, payload]])

    const result = parseBatchexecuteResponse(text, RPC_IDS.addSource)
    expect(result).toEqual({ sourceId: 'no-prefix' })
  })

  it('last non-null wrb.fr frame wins over an earlier placeholder frame', () => {
    const placeholder = ['wrb.fr', RPC_IDS.addSource, null]
    const real = ['wrb.fr', RPC_IDS.addSource, JSON.stringify({ sourceId: 'real' })]
    const text = `)]}'\n${chunk([placeholder])}\n${chunk([real])}\n`

    const result = parseBatchexecuteResponse(text, RPC_IDS.addSource)
    expect(result).toEqual({ sourceId: 'real' })
  })

  it('returns null for a placeholder-only response (server accepted, no payload)', () => {
    const text = `)]}'\n${chunk([['wrb.fr', RPC_IDS.addSource, null]])}\n`

    expect(parseBatchexecuteResponse(text, RPC_IDS.addSource)).toBeNull()
  })

  it('throws a distinct rpc-error for an "er" frame matching the rpcId', () => {
    const text = `)]}'\n${chunk([['er', RPC_IDS.addSource, 'QUOTA_EXCEEDED']])}\n`

    expect(() => parseBatchexecuteResponse(text, RPC_IDS.addSource)).toThrow(/^rpc-error:/)
  })

  it('throws a protocol-drift error when no wrb.fr line matches the rpcId', () => {
    const text = `)]}'\n${chunk([['wrb.fr', 'unrelatedRpc', JSON.stringify({})]])}\n`

    expect(() => parseBatchexecuteResponse(text, RPC_IDS.addSource)).toThrow(/^protocol-drift:/)
  })

  it('throws a protocol-drift error on totally unparseable garbage', () => {
    const text = `)]}'\nnot json at all {{{`

    expect(() => parseBatchexecuteResponse(text, RPC_IDS.addSource)).toThrow(/^protocol-drift:/)
  })

  it('throws a protocol-drift error when the matched payload itself is unparseable', () => {
    const text = `)]}'\n${chunk([['wrb.fr', RPC_IDS.addSource, 'not-valid-json{{']])}\n`

    expect(() => parseBatchexecuteResponse(text, RPC_IDS.addSource)).toThrow(/^protocol-drift:/)
  })
})

describe('parseNotebookList', () => {
  it('unwraps the live wXbhsf shape where rows are nested at result[0]', () => {
    const result = [
      [
        ['Searle: Philosophy of Mind, lecture 1', null, 'f6cd42fa-89e0-499c-ab21-eb526475f82b'],
        ['Topology: A Categorical Approach', null, 'b95181bf-afc8-4c03-8795-8f72b98c4df4'],
      ],
      null,
    ]
    expect(parseNotebookList(result)).toEqual([
      {
        id: 'f6cd42fa-89e0-499c-ab21-eb526475f82b',
        title: 'Searle: Philosophy of Mind, lecture 1',
      },
      { id: 'b95181bf-afc8-4c03-8795-8f72b98c4df4', title: 'Topology: A Categorical Approach' },
    ])
  })

  it('maps title (index 0) and notebookId (index 2) per row', () => {
    const result = [
      ['My Notebook', null, 'nb-1'],
      ['Another', 'x', 'nb-2'],
    ]
    expect(parseNotebookList(result)).toEqual([
      { id: 'nb-1', title: 'My Notebook' },
      { id: 'nb-2', title: 'Another' },
    ])
  })

  it('skips malformed rows (missing title or id) rather than throwing', () => {
    const result = [
      ['Good', null, 'nb-1'],
      ['Missing id', null, null],
      [null, null, 'nb-3'],
      'not-a-row',
      null,
    ]
    expect(parseNotebookList(result)).toEqual([{ id: 'nb-1', title: 'Good' }])
  })

  it('returns an empty array for a non-array result', () => {
    expect(parseNotebookList(null)).toEqual([])
    expect(parseNotebookList(undefined)).toEqual([])
    expect(parseNotebookList('garbage')).toEqual([])
  })
})
