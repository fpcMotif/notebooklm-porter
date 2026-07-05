import { describe, expect, it } from 'vitest'
import type { Playlist, Post, Thread } from '../model/types'
import { playlistToMarkdown, threadToMarkdown } from './markdown'

function post(overrides: Partial<Post> & Pick<Post, 'id' | 'depth' | 'byOp'>): Post {
  return {
    author: { name: 'Alice' },
    text: 'hello world',
    ...overrides,
  }
}

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    site: 'hackernews',
    url: 'https://news.ycombinator.com/item?id=1',
    title: 'Test thread',
    author: { name: 'OP Author' },
    posts: [],
    ...overrides,
  }
}

describe('threadToMarkdown', () => {
  it('renders frontmatter with source/url/title/author/captured_at/truncated', () => {
    const md = threadToMarkdown(thread(), '2026-07-06T00:00:00.000Z')
    expect(md).toContain('---\n')
    expect(md).toContain('source: hackernews')
    expect(md).toContain('url: "https://news.ycombinator.com/item?id=1"')
    expect(md).toContain('title: Test thread')
    expect(md).toContain('author: OP Author')
    expect(md).toContain('captured_at: "2026-07-06T00:00:00.000Z"')
    expect(md).toContain('truncated: false')
  })

  it('surfaces truncated: true in frontmatter when the capture is partial', () => {
    const md = threadToMarkdown(thread({ truncated: true }), '2026-01-01T00:00:00.000Z')
    expect(md).toContain('truncated: true')
  })

  it('includes stats when present', () => {
    const md = threadToMarkdown(
      thread({ stats: { score: 42, replyCount: 7 } }),
      '2026-01-01T00:00:00.000Z',
    )
    expect(md).toContain('score: 42')
    expect(md).toContain('reply_count: 7')
  })

  it('omits stat fields when absent', () => {
    const md = threadToMarkdown(thread(), '2026-01-01T00:00:00.000Z')
    expect(md).not.toContain('score:')
    expect(md).not.toContain('reply_count:')
  })

  it('renders depth-0 (OP) posts with no blockquote prefix', () => {
    const md = threadToMarkdown(
      thread({ posts: [post({ id: 'p0', depth: 0, byOp: true, author: { name: 'Root' } })] }),
      '2026-01-01T00:00:00.000Z',
    )
    expect(md).toContain('## Root · ')
    expect(md).not.toMatch(/> ## Root/)
  })

  it('renders nested reply depth as blockquote depth (1 => "> ", 2 => "> > ")', () => {
    const posts = [
      post({ id: 'p0', depth: 0, byOp: true, author: { name: 'Root' }, text: 'root text' }),
      post({ id: 'p1', depth: 1, byOp: false, author: { name: 'Reply1' }, text: 'reply one' }),
      post({ id: 'p2', depth: 2, byOp: false, author: { name: 'Reply2' }, text: 'reply two' }),
    ]
    const md = threadToMarkdown(thread({ posts }), '2026-01-01T00:00:00.000Z')

    expect(md).toContain('## Root · ')
    expect(md).toContain('> ## Reply1 · ')
    expect(md).toContain('> > ## Reply2 · ')
    // body text is also prefixed at the same depth
    expect(md).toContain('> reply one')
    expect(md).toContain('> > reply two')
  })

  it('preserves multi-paragraph text under blockquote nesting', () => {
    const posts = [
      post({
        id: 'p1',
        depth: 1,
        byOp: false,
        author: { name: 'Reply1' },
        text: 'first paragraph\n\nsecond paragraph',
      }),
    ]
    const md = threadToMarkdown(thread({ posts }), '2026-01-01T00:00:00.000Z')
    expect(md).toContain('> first paragraph')
    expect(md).toContain('> second paragraph')
  })

  it('appends links and media as markdown image refs', () => {
    const posts = [
      post({
        id: 'p0',
        depth: 0,
        byOp: true,
        links: ['https://example.com/a'],
        media: [{ kind: 'image', url: 'https://example.com/img.png', alt: 'a cat' }],
      }),
    ]
    const md = threadToMarkdown(thread({ posts }), '2026-01-01T00:00:00.000Z')
    expect(md).toContain('- https://example.com/a')
    expect(md).toContain('![a cat](https://example.com/img.png)')
  })

  it('renders media without alt text as an empty alt', () => {
    const posts = [
      post({
        id: 'p0',
        depth: 0,
        byOp: true,
        media: [{ kind: 'image', url: 'https://example.com/img.png' }],
      }),
    ]
    const md = threadToMarkdown(thread({ posts }), '2026-01-01T00:00:00.000Z')
    expect(md).toContain('![](https://example.com/img.png)')
  })

  it('minScore drops low-score posts but never drops byOp posts', () => {
    const posts = [
      post({ id: 'p0', depth: 0, byOp: true, score: 0, text: 'op text' }),
      post({ id: 'p1', depth: 1, byOp: true, score: 0, text: 'op continuation, low score' }),
      post({ id: 'p2', depth: 1, byOp: false, score: 1, text: 'weak reply' }),
      post({ id: 'p3', depth: 1, byOp: false, score: 100, text: 'strong reply' }),
    ]
    const md = threadToMarkdown(thread({ posts }), '2026-01-01T00:00:00.000Z', { minScore: 5 })

    expect(md).toContain('op text')
    expect(md).toContain('op continuation, low score')
    expect(md).not.toContain('weak reply')
    expect(md).toContain('strong reply')
  })

  it('maxDepth drops posts deeper than the cap', () => {
    const posts = [
      post({ id: 'p0', depth: 0, byOp: true, text: 'root' }),
      post({ id: 'p1', depth: 1, byOp: false, text: 'depth one' }),
      post({ id: 'p2', depth: 2, byOp: false, text: 'depth two' }),
    ]
    const md = threadToMarkdown(thread({ posts }), '2026-01-01T00:00:00.000Z', { maxDepth: 1 })

    expect(md).toContain('root')
    expect(md).toContain('depth one')
    expect(md).not.toContain('depth two')
  })

  it('maxDepth still drops a byOp post nested past the cap', () => {
    const posts = [
      post({ id: 'p0', depth: 0, byOp: true, text: 'root' }),
      post({ id: 'p1', depth: 5, byOp: true, text: 'deep op continuation' }),
    ]
    const md = threadToMarkdown(thread({ posts }), '2026-01-01T00:00:00.000Z', { maxDepth: 1 })

    expect(md).toContain('root')
    expect(md).not.toContain('deep op continuation')
  })

  it('adds a per-post permalink when permalinks is true', () => {
    const posts = [post({ id: 'p0', depth: 0, byOp: true, text: 'root' })]
    const withLinks = threadToMarkdown(thread({ posts }), '2026-01-01T00:00:00.000Z', {
      permalinks: true,
    })
    const withoutLinks = threadToMarkdown(thread({ posts }), '2026-01-01T00:00:00.000Z')

    expect(withLinks).toContain('[permalink](#p0)')
    expect(withoutLinks).not.toContain('[permalink]')
  })

  it('renders an empty createdAt as an empty string after the separator', () => {
    const posts = [post({ id: 'p0', depth: 0, byOp: true })]
    const md = threadToMarkdown(thread({ posts }), '2026-01-01T00:00:00.000Z')
    expect(md).toMatch(/## Alice · \n/)
  })

  it('renders handle alongside name when present', () => {
    const posts = [
      post({ id: 'p0', depth: 0, byOp: true, author: { name: 'Alice', handle: 'u/alice' } }),
    ]
    const md = threadToMarkdown(thread({ posts }), '2026-01-01T00:00:00.000Z')
    expect(md).toContain('## Alice (u/alice) · ')
  })
})

function video(overrides: Partial<Playlist['videos'][number]> & { index: number }) {
  return {
    videoId: `v${overrides.index}`,
    url: `https://www.youtube.com/watch?v=v${overrides.index}`,
    title: `Video ${overrides.index}`,
    ...overrides,
  }
}

function playlist(overrides: Partial<Playlist> = {}): Playlist {
  return {
    playlistId: 'PL123',
    url: 'https://www.youtube.com/playlist?list=PL123',
    title: 'My Playlist',
    videoCount: 0,
    videos: [],
    ...overrides,
  }
}

describe('playlistToMarkdown', () => {
  it('renders frontmatter and an H1 title', () => {
    const md = playlistToMarkdown(playlist(), '2026-07-06T00:00:00.000Z')
    expect(md).toContain('source: youtube')
    expect(md).toContain('url: "https://www.youtube.com/playlist?list=PL123"')
    expect(md).toContain('captured_at: "2026-07-06T00:00:00.000Z"')
    expect(md).toContain('# My Playlist')
  })

  it('surfaces truncated in frontmatter', () => {
    const md = playlistToMarkdown(playlist({ truncated: true }), '2026-01-01T00:00:00.000Z')
    expect(md).toContain('truncated: true')
  })

  it('renders one table row per video with index/title/channel/duration/captions', () => {
    const videos = [
      video({ index: 1, title: 'First', channel: 'Chan A', durationSeconds: 0, hasCaptions: true }),
      video({
        index: 2,
        title: 'Second',
        channel: 'Chan B',
        durationSeconds: 59,
        hasCaptions: false,
      }),
      video({ index: 3, title: 'Third', durationSeconds: 3661 }),
    ]
    const md = playlistToMarkdown(playlist({ videos }), '2026-01-01T00:00:00.000Z')

    expect(md).toContain('| 1 | First | Chan A | 0:00 | ✓ |')
    expect(md).toContain('| 2 | Second | Chan B | 0:59 | ✗ |')
    expect(md).toContain('| 3 | Third |  | 1:01:01 | ? |')
  })

  it('formats 0 seconds as 0:00', () => {
    const videos = [video({ index: 1, durationSeconds: 0 })]
    const md = playlistToMarkdown(playlist({ videos }), '2026-01-01T00:00:00.000Z')
    expect(md).toContain('| 0:00 |')
  })

  it('formats 59 seconds as 0:59 (no hour component)', () => {
    const videos = [video({ index: 1, durationSeconds: 59 })]
    const md = playlistToMarkdown(playlist({ videos }), '2026-01-01T00:00:00.000Z')
    expect(md).toContain('| 0:59 |')
  })

  it('formats 3661 seconds as 1:01:01 (H:MM:SS)', () => {
    const videos = [video({ index: 1, durationSeconds: 3661 })]
    const md = playlistToMarkdown(playlist({ videos }), '2026-01-01T00:00:00.000Z')
    expect(md).toContain('| 1:01:01 |')
  })

  it('leaves duration blank when durationSeconds is unknown', () => {
    const videos = [video({ index: 1 })]
    const md = playlistToMarkdown(playlist({ videos }), '2026-01-01T00:00:00.000Z')
    expect(md).toContain('| Video 1 |  |  | ? |')
  })

  it('escapes pipes and backticks in table cells so the table does not break', () => {
    const videos = [video({ index: 1, title: 'A | B `code`', channel: 'Ch | annel' })]
    const md = playlistToMarkdown(playlist({ videos }), '2026-01-01T00:00:00.000Z')
    expect(md).toContain('A \\| B \\`code\\`')
    expect(md).toContain('Ch \\| annel')
  })
})
