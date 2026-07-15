import { describe, expect, it } from 'vitest'
import type { SourceDoc } from '../model/types'
import { canWatchSource } from './eligibility'

const YT_PLAYLIST = 'https://www.youtube.com/playlist?list=PLabc123'
const YT_VIDEO = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
const REDDIT_THREAD = 'https://www.reddit.com/r/test/comments/abc123/title'
const HN_THREAD = 'https://news.ycombinator.com/item?id=42'
const X_THREAD = 'https://x.com/user/status/123'

function doc(part: Pick<SourceDoc, 'site' | 'kind' | 'canonicalUrl'>) {
  return part
}

describe('canWatchSource', () => {
  it('watches a YouTube playlist captured from its playlist URL', () => {
    expect(
      canWatchSource(doc({ site: 'youtube', kind: 'playlist', canonicalUrl: YT_PLAYLIST })),
    ).toBe(true)
  })

  it('watches a Reddit thread', () => {
    expect(
      canWatchSource(doc({ site: 'reddit', kind: 'thread', canonicalUrl: REDDIT_THREAD })),
    ).toBe(true)
  })

  it('watches a Hacker News thread', () => {
    expect(
      canWatchSource(doc({ site: 'hackernews', kind: 'thread', canonicalUrl: HN_THREAD })),
    ).toBe(true)
  })

  it('never watches a standalone video: its kind cannot grow', () => {
    expect(canWatchSource(doc({ site: 'youtube', kind: 'video', canonicalUrl: YT_VIDEO }))).toBe(
      false,
    )
  })

  it('never watches an X thread: it captures only from its open tab', () => {
    expect(canWatchSource(doc({ site: 'x', kind: 'thread', canonicalUrl: X_THREAD }))).toBe(false)
  })

  it('rejects a URL no adapter recognizes', () => {
    expect(
      canWatchSource(
        doc({ site: 'reddit', kind: 'thread', canonicalUrl: 'https://example.com/a' }),
      ),
    ).toBe(false)
  })

  it('rejects a kind that no longer matches what the URL detects', () => {
    expect(
      canWatchSource(doc({ site: 'youtube', kind: 'thread', canonicalUrl: YT_PLAYLIST })),
    ).toBe(false)
  })

  it('rejects a site that disagrees with the URL adapter', () => {
    expect(
      canWatchSource(doc({ site: 'reddit', kind: 'playlist', canonicalUrl: YT_PLAYLIST })),
    ).toBe(false)
  })
})
