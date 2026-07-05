import { describe, expect, it } from 'vitest'
import type { Capture, Playlist, Post, Thread } from '../model/types'
import { formatCapture } from './format'

const FIXED_NOW = () => '2026-07-06T12:00:00.000Z'

function post(overrides: Partial<Post> & Pick<Post, 'id' | 'depth' | 'byOp'>): Post {
  return {
    author: { name: 'Alice' },
    text: 'hello world',
    ...overrides,
  }
}

function threadCapture(thread: Partial<Thread> = {}): Capture {
  return {
    kind: 'thread',
    thread: {
      site: 'reddit',
      url: 'https://www.reddit.com/r/test/comments/abc123/some_title/',
      title: 'Some title',
      author: { name: 'OP' },
      posts: [post({ id: 't1_x', depth: 0, byOp: true, text: 'root post body' })],
      ...thread,
    },
  }
}

function playlistCapture(playlist: Partial<Playlist> = {}): Capture {
  return {
    kind: 'playlist',
    playlist: {
      playlistId: 'PLabc123',
      url: 'https://www.youtube.com/playlist?list=PLabc123',
      title: 'A playlist',
      videoCount: 1,
      videos: [
        {
          videoId: 'v1',
          url: 'https://www.youtube.com/watch?v=v1',
          title: 'Video one',
          index: 1,
          durationSeconds: 61,
        },
      ],
      ...playlist,
    },
  }
}

describe('formatCapture — thread', () => {
  it('derives id as `${site}:${nativeId}` from a Reddit comments URL', () => {
    const doc = formatCapture(threadCapture(), undefined, FIXED_NOW)
    expect(doc.id).toBe('reddit:abc123')
  })

  it('derives id from an HN item URL (?id=)', () => {
    const doc = formatCapture(
      threadCapture({
        site: 'hackernews',
        url: 'https://news.ycombinator.com/item?id=987654',
      }),
      undefined,
      FIXED_NOW,
    )
    expect(doc.id).toBe('hackernews:987654')
  })

  it('derives id from an X status URL', () => {
    const doc = formatCapture(
      threadCapture({
        site: 'x',
        url: 'https://x.com/someuser/status/1234567890',
      }),
      undefined,
      FIXED_NOW,
    )
    expect(doc.id).toBe('x:1234567890')
  })

  it('sets kind, title, canonicalUrl from the thread', () => {
    const doc = formatCapture(threadCapture(), undefined, FIXED_NOW)
    expect(doc.kind).toBe('thread')
    expect(doc.title).toBe('Some title')
    expect(doc.canonicalUrl).toBe('https://www.reddit.com/r/test/comments/abc123/some_title/')
    expect(doc.site).toBe('reddit')
  })

  it('uses the injected clock for a deterministic capturedAt', () => {
    const doc = formatCapture(threadCapture(), undefined, FIXED_NOW)
    expect(doc.capturedAt).toBe('2026-07-06T12:00:00.000Z')
  })

  it('defaults truncated to false when the thread omits it', () => {
    const doc = formatCapture(threadCapture(), undefined, FIXED_NOW)
    expect(doc.truncated).toBe(false)
  })

  it('surfaces truncated: true from the thread', () => {
    const doc = formatCapture(threadCapture({ truncated: true }), undefined, FIXED_NOW)
    expect(doc.truncated).toBe(true)
  })

  it('produces jsonl with one object per post', () => {
    const posts = [
      post({ id: 'p0', depth: 0, byOp: true, text: 'root' }),
      post({ id: 'p1', depth: 1, byOp: false, text: 'reply', parentId: 'p0', score: 3 }),
    ]
    const doc = formatCapture(threadCapture({ posts }), undefined, FIXED_NOW)
    const lines = (doc.jsonl ?? '').split('\n')
    expect(lines).toHaveLength(2)

    const first = JSON.parse(lines[0] ?? '{}')
    const second = JSON.parse(lines[1] ?? '{}')
    expect(first).toMatchObject({ id: 'p0', depth: 0, byOp: true, text: 'root' })
    expect(second).toMatchObject({
      id: 'p1',
      depth: 1,
      byOp: false,
      text: 'reply',
      parentId: 'p0',
      score: 3,
    })
  })

  it('wordCount excludes the YAML frontmatter block', () => {
    const posts = [post({ id: 'p0', depth: 0, byOp: true, text: 'one two three four five' })]
    const doc = formatCapture(
      threadCapture({ posts, title: 'T', url: 'https://x.com/a/status/1' }),
      undefined,
      FIXED_NOW,
    )

    // frontmatter alone contributes many "words" (source: reddit, url: ..., etc.)
    // if it leaked into the count, wordCount would be much larger than 5 + heading words.
    const bodyOnlyDoc = formatCapture(
      threadCapture({ posts: [post({ id: 'p0', depth: 0, byOp: true, text: '' })] }),
      undefined,
      FIXED_NOW,
    )
    expect(doc.wordCount).toBeGreaterThan(bodyOnlyDoc.wordCount)
    // heading is "## Alice · " (3 tokens: "##", "Alice", "·") + 5 body words = 8
    expect(doc.wordCount).toBe(8)
  })

  it('applies FormatOptions (e.g. maxDepth) when rendering the markdown', () => {
    const posts = [
      post({ id: 'p0', depth: 0, byOp: true, text: 'root' }),
      post({ id: 'p1', depth: 2, byOp: false, text: 'too deep' }),
    ]
    const doc = formatCapture(threadCapture({ posts }), { maxDepth: 0 }, FIXED_NOW)
    expect(doc.markdown).not.toContain('too deep')
  })
})

describe('formatCapture — playlist', () => {
  it('derives id as youtube:<playlistId>', () => {
    const doc = formatCapture(playlistCapture(), undefined, FIXED_NOW)
    expect(doc.id).toBe('youtube:PLabc123')
    expect(doc.site).toBe('youtube')
    expect(doc.kind).toBe('playlist')
  })

  it('sets title and canonicalUrl from the playlist', () => {
    const doc = formatCapture(playlistCapture(), undefined, FIXED_NOW)
    expect(doc.title).toBe('A playlist')
    expect(doc.canonicalUrl).toBe('https://www.youtube.com/playlist?list=PLabc123')
  })

  it('uses the injected clock', () => {
    const doc = formatCapture(playlistCapture(), undefined, FIXED_NOW)
    expect(doc.capturedAt).toBe('2026-07-06T12:00:00.000Z')
  })

  it('defaults truncated to false', () => {
    const doc = formatCapture(playlistCapture(), undefined, FIXED_NOW)
    expect(doc.truncated).toBe(false)
  })

  it('surfaces truncated: true from the playlist', () => {
    const doc = formatCapture(playlistCapture({ truncated: true }), undefined, FIXED_NOW)
    expect(doc.truncated).toBe(true)
  })

  it('produces jsonl with one object per video', () => {
    const doc = formatCapture(
      playlistCapture({
        videos: [
          { videoId: 'v1', url: 'https://www.youtube.com/watch?v=v1', title: 'One', index: 1 },
          { videoId: 'v2', url: 'https://www.youtube.com/watch?v=v2', title: 'Two', index: 2 },
        ],
      }),
      undefined,
      FIXED_NOW,
    )
    const lines = (doc.jsonl ?? '').split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ videoId: 'v1', index: 1 })
    expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({ videoId: 'v2', index: 2 })
  })

  it('markdown contains the ToC table (not per-video sources)', () => {
    const doc = formatCapture(playlistCapture(), undefined, FIXED_NOW)
    expect(doc.markdown).toContain('| # | Title | Channel | Duration | Captions |')
    expect(doc.markdown).toContain('| 1 | Video one |')
  })

  it('wordCount excludes frontmatter for playlists too', () => {
    const doc = formatCapture(playlistCapture(), undefined, FIXED_NOW)
    expect(doc.markdown.startsWith('---\n')).toBe(true)
    // wordCount should be small (H1 + table), not inflated by frontmatter keys
    expect(doc.wordCount).toBeLessThan(30)
  })
})

describe('formatCapture — default clock', () => {
  it('uses a real ISO timestamp when now is not provided', () => {
    const before = Date.now()
    const doc = formatCapture(threadCapture())
    const after = Date.now()
    const parsed = new Date(doc.capturedAt).getTime()
    expect(parsed).toBeGreaterThanOrEqual(before)
    expect(parsed).toBeLessThanOrEqual(after)
  })
})
