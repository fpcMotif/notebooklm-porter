import { describe, expect, it } from 'vitest'
import { duplicateRemovalIds, findDuplicateGroups, sourceDedupeKey } from './dedup'
import type { NotebookSource, SourceKind, SourceLoadStatus } from './model'

function source(id: string, over: Partial<Omit<NotebookSource, 'id'>> = {}): NotebookSource {
  const kind: SourceKind = over.kind ?? 'web_page'
  const status: SourceLoadStatus = over.status ?? 'ready'
  return {
    id,
    title: over.title ?? `Source ${id}`,
    kind,
    status,
    ...(over.url !== undefined ? { url: over.url } : {}),
    ...(over.createdAt !== undefined ? { createdAt: over.createdAt } : {}),
  }
}

describe('sourceDedupeKey', () => {
  it('keys only validated YouTube video URLs, including playlist context', () => {
    expect(sourceDedupeKey(source('1', { url: 'https://youtu.be/dQw4w9WgXcQ' }))).toBe(
      'youtube:dQw4w9WgXcQ',
    )
    expect(
      sourceDedupeKey(
        source('2', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc' }),
      ),
    ).toBe('youtube:dQw4w9WgXcQ')
  })

  it('has no key without a validated YouTube video URL', () => {
    expect(sourceDedupeKey(source('missing', { title: 'Pasted Notes', kind: 'pasted_text' }))).toBe(
      undefined,
    )
    expect(sourceDedupeKey(source('blank', { url: '   ' }))).toBe(undefined)
    expect(sourceDedupeKey(source('malformed', { url: 'not a URL' }))).toBe(undefined)
    expect(sourceDedupeKey(source('ftp', { url: 'ftp://example.com/file' }))).toBe(undefined)
    expect(sourceDedupeKey(source('http-youtube', { url: 'http://youtu.be/dQw4w9WgXcQ' }))).toBe(
      undefined,
    )
    expect(sourceDedupeKey(source('ftp-youtube', { url: 'ftp://youtu.be/dQw4w9WgXcQ' }))).toBe(
      undefined,
    )
    expect(sourceDedupeKey(source('generic', { url: 'https://example.com/article' }))).toBe(
      undefined,
    )
  })
})

describe('findDuplicateGroups', () => {
  it('groups YouTube watch, short, and shortened URLs by video identity', () => {
    const sources = [
      source('a', { url: 'https://youtube.com/watch?v=dQw4w9WgXcQ' }),
      source('b', { url: 'https://youtu.be/dQw4w9WgXcQ' }),
      source('c', { url: 'https://www.youtube.com/shorts/dQw4w9WgXcQ' }),
      source('d', { url: 'https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc' }),
    ]
    const groups = findDuplicateGroups(sources)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.remove.map((s) => s.id)).toEqual(['b', 'c', 'd'])
    expect(groups[0]?.keep.id).toBe('a')
  })

  it('does not group the same generic URL', () => {
    const sources = [
      source('first', { url: 'https://example.com/article' }),
      source('second', { url: 'https://example.com/article' }),
    ]
    expect(findDuplicateGroups(sources)).toEqual([])
  })

  it('does not group generic URL normalizations', () => {
    const variants = [
      'http://example.com/article',
      'https://example.com/article',
      'https://www.example.com/article',
      'https://example.com/article/',
      'https://example.com/article#comments',
      'https://example.com/article?a=1&b=2',
      'https://example.com/article?b=2&a=1',
      'https://example.com/article?utm_source=newsletter',
    ]
    const sources = variants.map((url, index) => source(`source-${index}`, { url }))
    expect(findDuplicateGroups(sources)).toEqual([])
  })

  it('does not group same-title sources without canonical URLs', () => {
    const sources = [
      source('a', { title: 'Notes', kind: 'pasted_text' }),
      source('b', { title: 'notes', kind: 'pasted_text' }),
      source('c', { title: 'Other', kind: 'pasted_text' }),
    ]
    expect(findDuplicateGroups(sources)).toEqual([])
  })

  it('keeps a ready YouTube source and removes the broken duplicate', () => {
    const sources = [
      source('bad', { url: 'https://youtu.be/dQw4w9WgXcQ', status: 'error' }),
      source('good', { url: 'https://youtube.com/watch?v=dQw4w9WgXcQ', status: 'ready' }),
    ]
    const groups = findDuplicateGroups(sources)
    expect(groups[0]?.keep.id).toBe('good')
    expect(duplicateRemovalIds(groups)).toEqual(['bad'])
  })
})
