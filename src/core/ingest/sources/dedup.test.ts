import { describe, expect, it } from 'vitest'
import {
  duplicateRemovalIds,
  findDuplicateGroups,
  normalizeSourceUrl,
  sourceDedupeKey,
} from './dedup'
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

describe('normalizeSourceUrl', () => {
  it('collapses every YouTube URL form to the video identity', () => {
    const key = 'youtube:dQw4w9WgXcQ'
    expect(normalizeSourceUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(key)
    expect(normalizeSourceUrl('https://youtu.be/dQw4w9WgXcQ')).toBe(key)
    expect(normalizeSourceUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe(key)
    expect(normalizeSourceUrl('https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc')).toBe(key)
  })

  it('strips tracking params and sorts the rest', () => {
    expect(normalizeSourceUrl('https://example.com/post?utm_source=x&b=2&a=1&fbclid=zzz')).toBe(
      'example.com/post?a=1&b=2',
    )
  })

  it('drops www, fragment, and trailing slash', () => {
    expect(normalizeSourceUrl('https://www.example.com/a/b/#section')).toBe('example.com/a/b')
    expect(normalizeSourceUrl('https://example.com/')).toBe('example.com/')
  })

  it('treats two links differing only by tracking noise as one key', () => {
    expect(normalizeSourceUrl('https://news.site/story?utm_campaign=a')).toBe(
      normalizeSourceUrl('https://news.site/story?igshid=b'),
    )
  })

  it('falls back to a trimmed lowercase form for non-URL strings', () => {
    expect(normalizeSourceUrl('  Not A URL  ')).toBe('not a url')
  })
})

describe('sourceDedupeKey', () => {
  it('keys on the normalized URL when present', () => {
    expect(sourceDedupeKey(source('1', { url: 'https://youtu.be/dQw4w9WgXcQ' }))).toBe(
      'url:youtube:dQw4w9WgXcQ',
    )
  })

  it('keys on the normalized title when there is no URL', () => {
    expect(sourceDedupeKey(source('1', { title: '  Pasted Notes  ', kind: 'pasted_text' }))).toBe(
      'title:pasted notes',
    )
  })
})

describe('findDuplicateGroups', () => {
  it('groups sources that share a normalized URL', () => {
    const sources = [
      source('a', { url: 'https://youtube.com/watch?v=dQw4w9WgXcQ' }),
      source('b', { url: 'https://youtu.be/dQw4w9WgXcQ' }),
      source('c', { url: 'https://other.com/x' }),
    ]
    const groups = findDuplicateGroups(sources)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.remove.map((s) => s.id)).toEqual(['b'])
    expect(groups[0]?.keep.id).toBe('a')
  })

  it('keeps a ready copy and removes the broken duplicate', () => {
    const sources = [
      source('bad', { url: 'https://example.com/x', status: 'error' }),
      source('good', { url: 'https://example.com/x', status: 'ready' }),
    ]
    const groups = findDuplicateGroups(sources)
    expect(groups[0]?.keep.id).toBe('good')
    expect(groups[0]?.remove.map((s) => s.id)).toEqual(['bad'])
  })

  it('ignores unique sources', () => {
    const sources = [source('a', { url: 'https://a.com' }), source('b', { url: 'https://b.com' })]
    expect(findDuplicateGroups(sources)).toEqual([])
  })

  it('dedupes URL-less sources by title', () => {
    const sources = [
      source('a', { title: 'Notes', kind: 'pasted_text' }),
      source('b', { title: 'notes', kind: 'pasted_text' }),
      source('c', { title: 'Other', kind: 'pasted_text' }),
    ]
    const groups = findDuplicateGroups(sources)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.remove.map((s) => s.id)).toEqual(['b'])
  })

  it('returns groups in first-appearance order and flattens removal ids', () => {
    const sources = [
      source('a1', { url: 'https://a.com' }),
      source('b1', { url: 'https://b.com' }),
      source('a2', { url: 'https://a.com' }),
      source('b2', { url: 'https://b.com' }),
      source('b3', { url: 'https://b.com' }),
    ]
    const groups = findDuplicateGroups(sources)
    expect(groups.map((g) => g.key)).toEqual(['url:a.com/', 'url:b.com/'])
    expect(duplicateRemovalIds(groups)).toEqual(['a2', 'b2', 'b3'])
  })
})
