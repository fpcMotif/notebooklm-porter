import { describe, expect, it } from 'vitest'
import type { SourceDoc } from '../model/types'
import { docBlobParts, exportFilename } from './export'

describe('exportFilename', () => {
  it('appends .md for markdown format', () => {
    expect(exportFilename('My Great Thread', 'markdown')).toBe('My Great Thread.md')
  })

  it('appends .jsonl for jsonl format', () => {
    expect(exportFilename('My Great Thread', 'jsonl')).toBe('My Great Thread.jsonl')
  })

  it('replaces path separators with a hyphen', () => {
    expect(exportFilename('a/b\\c', 'markdown')).toBe('a-b-c.md')
  })

  it('replaces Windows-reserved glyphs with a hyphen', () => {
    expect(exportFilename('what:is*this?"really"<weird>|thread', 'markdown')).toBe(
      'what-is-this--really--weird--thread.md',
    )
  })

  it('treats tab/newline as collapsible whitespace, not hostile characters', () => {
    expect(exportFilename('title\twith\ncontrol chars', 'markdown')).toBe(
      'title with control chars.md',
    )
  })

  it('replaces a true control character (non-whitespace) with a hyphen', () => {
    expect(exportFilename('title\x00with\x01control', 'markdown')).toBe('title-with-control.md')
  })

  it('leaves emoji and unicode letters intact', () => {
    expect(exportFilename('🚀 Launch Thread 日本語', 'markdown')).toBe('🚀 Launch Thread 日本語.md')
  })

  it('collapses runs of whitespace into a single space', () => {
    expect(exportFilename('too    many     spaces', 'markdown')).toBe('too many spaces.md')
  })

  it('collapses whitespace produced by sanitizing hostile chars', () => {
    expect(exportFilename('a / b : c', 'markdown')).toBe('a - b - c.md')
  })

  it('trims leading and trailing whitespace', () => {
    expect(exportFilename('   padded title   ', 'markdown')).toBe('padded title.md')
  })

  it('falls back to "source" for an empty title', () => {
    expect(exportFilename('', 'markdown')).toBe('source.md')
  })

  it('falls back to "source" for a whitespace-only title', () => {
    expect(exportFilename('   ', 'markdown')).toBe('source.md')
  })

  it('replaces a title made entirely of hostile characters with hyphens rather than emptying it', () => {
    // Each hostile char maps to its own '-', so the result is non-empty and
    // does NOT hit the 'source' fallback — only whitespace-only/empty titles do.
    expect(exportFilename('////\\\\::**', 'jsonl')).toBe('----------.jsonl')
  })

  it('falls back to "source" only when sanitizing leaves nothing (whitespace-only)', () => {
    expect(exportFilename('\t\n  ', 'markdown')).toBe('source.md')
  })

  it('caps length to ~120 chars', () => {
    const longTitle = 'x'.repeat(300)
    const result = exportFilename(longTitle, 'markdown')
    expect(result.length).toBeLessThanOrEqual(120 + '.markdown'.length)
    expect(result).toBe('x'.repeat(120) + '.md')
  })

  it('trims trailing whitespace exposed by the length cap', () => {
    const longTitle = 'x'.repeat(119) + '   ' + 'y'.repeat(50)
    const result = exportFilename(longTitle, 'markdown')
    // Slicing at 120 lands mid-whitespace-run; the final trim must remove it.
    expect(result.endsWith(' .md')).toBe(false)
  })
})

describe('docBlobParts', () => {
  const baseDoc: SourceDoc = {
    id: 'reddit:abc123',
    site: 'reddit',
    kind: 'thread',
    title: 'A thread',
    canonicalUrl: 'https://reddit.com/r/x/comments/abc123',
    capturedAt: '2026-07-06T00:00:00.000Z',
    markdown: '# A thread\n\nBody text.',
    jsonl: '{"id":"1"}\n{"id":"2"}\n',
    wordCount: 4,
    truncated: false,
  }

  it('returns the markdown body with a text/markdown mime for markdown format', () => {
    expect(docBlobParts(baseDoc, 'markdown')).toEqual({
      content: baseDoc.markdown,
      mime: 'text/markdown',
    })
  })

  it('returns the jsonl body with an ndjson mime for jsonl format', () => {
    expect(docBlobParts(baseDoc, 'jsonl')).toEqual({
      content: baseDoc.jsonl,
      mime: 'application/x-ndjson',
    })
  })

  it('falls back to an empty string when jsonl format is requested but jsonl is absent', () => {
    const { jsonl: _jsonl, ...rest } = baseDoc
    const docWithoutJsonl: SourceDoc = { ...rest }
    expect(docBlobParts(docWithoutJsonl, 'jsonl')).toEqual({
      content: '',
      mime: 'application/x-ndjson',
    })
  })
})
