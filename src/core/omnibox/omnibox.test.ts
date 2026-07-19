import { describe, expect, it } from 'vitest'
import {
  buildCaptureSuggestion,
  buildDocSuggestion,
  classifyEnteredOmniboxText,
  escapeOmniboxXml,
  fuzzyMatchDocs,
  parseOmniboxInput,
} from './omnibox'

const REDDIT_THREAD = 'https://www.reddit.com/r/test/comments/abc123/some_title/'
const YOUTUBE_PLAYLIST = 'https://www.youtube.com/playlist?list=PL12345'
const X_THREAD = 'https://x.com/someone/status/12345'
const NON_CAPTURABLE = 'https://example.com/'

describe('parseOmniboxInput', () => {
  it('parses a bare query as a query', () => {
    expect(parseOmniboxInput('reddit thread about cats')).toEqual({
      kind: 'query',
      query: 'reddit thread about cats',
    })
  })

  it('parses an empty/whitespace input as an empty query', () => {
    expect(parseOmniboxInput('   ')).toEqual({ kind: 'query', query: '' })
  })

  it('parses a fully-qualified URL as a url', () => {
    expect(parseOmniboxInput(` ${REDDIT_THREAD} `)).toEqual({ kind: 'url', url: REDDIT_THREAD })
  })

  it('adds https:// to a schemeless host-shaped input', () => {
    expect(parseOmniboxInput('example.com/path')).toEqual({
      kind: 'url',
      url: 'https://example.com/path',
    })
  })

  it('rejects non-http(s) schemes as a query', () => {
    expect(parseOmniboxInput('mailto:hello@example.com')).toEqual({
      kind: 'query',
      query: 'mailto:hello@example.com',
    })
  })
})

describe('classifyEnteredOmniboxText', () => {
  it('captures a url-mode capturable URL directly', () => {
    expect(classifyEnteredOmniboxText(REDDIT_THREAD)).toEqual({
      kind: 'capture',
      url: REDDIT_THREAD,
    })
    expect(classifyEnteredOmniboxText(YOUTUBE_PLAYLIST)).toEqual({
      kind: 'capture',
      url: YOUTUBE_PLAYLIST,
    })
  })

  it('opens a content-script-only capturable URL instead of capturing it', () => {
    expect(classifyEnteredOmniboxText(X_THREAD)).toEqual({ kind: 'open-url', url: X_THREAD })
  })

  it('opens a non-capturable URL', () => {
    expect(classifyEnteredOmniboxText(NON_CAPTURABLE)).toEqual({
      kind: 'open-url',
      url: NON_CAPTURABLE,
    })
  })

  it('resolves a doc: suggestion to open-doc', () => {
    expect(classifyEnteredOmniboxText('doc:reddit:abc123')).toEqual({
      kind: 'open-doc',
      docId: 'reddit:abc123',
    })
  })

  it('no-ops on plain query text', () => {
    expect(classifyEnteredOmniboxText('just some words')).toEqual({ kind: 'noop' })
  })
})

describe('escapeOmniboxXml', () => {
  it('escapes the reserved characters', () => {
    expect(escapeOmniboxXml('A & B < C > D')).toBe('A &amp; B &lt; C &gt; D')
  })
})

describe('suggestion builders', () => {
  it('builds a capture suggestion with an escaped label', () => {
    expect(
      buildCaptureSuggestion(REDDIT_THREAD, { kind: 'thread', label: 'A & B', identity: 't-1' }),
    ).toEqual({
      content: REDDIT_THREAD,
      description: 'Capture: A &amp; B',
    })
  })

  it('builds a doc suggestion prefixed for round-tripping through onInputEntered', () => {
    const suggestion = buildDocSuggestion({ id: 'reddit:abc', title: 'Cats <3' })
    expect(suggestion.content).toBe('doc:reddit:abc')
    expect(suggestion.description).toBe('Open: Cats &lt;3')
  })
})

describe('fuzzyMatchDocs', () => {
  const docs = [
    { id: '1', title: 'YouTube playlist: React conf talks' },
    { id: '2', title: 'Reddit thread on rust borrow checker' },
    { id: '3', title: 'Hacker News: Show HN launch' },
  ]

  it('returns the first `limit` docs for an empty query', () => {
    expect(fuzzyMatchDocs(docs, '', 2).map((d) => d.id)).toEqual(['1', '2'])
  })

  it('matches an in-order subsequence case-insensitively', () => {
    const matched = fuzzyMatchDocs(docs, 'rust').map((d) => d.id)
    expect(matched).toEqual(['2'])
  })

  it('ranks tighter matches ahead of scattered ones', () => {
    const scattered = [
      { id: 'tight', title: 'abcdef' },
      { id: 'loose', title: 'a-b-c-d-e-f' },
    ]
    expect(fuzzyMatchDocs(scattered, 'abc').map((d) => d.id)).toEqual(['tight', 'loose'])
  })

  it('excludes docs with no subsequence match', () => {
    expect(fuzzyMatchDocs(docs, 'zzz')).toEqual([])
  })

  it('respects the limit', () => {
    expect(fuzzyMatchDocs(docs, 'e', 1)).toHaveLength(1)
  })
})
