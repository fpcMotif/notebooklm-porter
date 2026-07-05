import { describe, expect, it } from 'vitest'
import { parseRedditThread } from './parse'

const POST_URL = 'https://www.reddit.com/r/test/comments/abc123/some_title/'

/**
 * Frozen fixture: OP + 2 top-level comments + 1 nested reply + 1 `more`
 * stub, plus a [deleted] author and an OP self-reply (byOp detection).
 *
 * Tree shape:
 *   post (op)
 *   ├─ comment1 (top1, by op) -> byOp true
 *   │   └─ reply1 (nested, by someone_else) -> depth 2, parentId = top1
 *   ├─ comment2 (top2, by [deleted])
 *   └─ more stub (count 2, unexpanded) -> truncated
 */
function buildFixture() {
  return [
    {
      kind: 'Listing',
      data: {
        children: [
          {
            kind: 't3',
            data: {
              id: 'abc123',
              title: 'Some title',
              author: 'op_user',
              selftext: 'This is the original post body.',
              created_utc: 1700000000,
              score: 42,
              permalink: '/r/test/comments/abc123/some_title/',
              num_comments: 4,
              subreddit: 'test',
            },
          },
        ],
      },
    },
    {
      kind: 'Listing',
      data: {
        children: [
          {
            kind: 't1',
            data: {
              id: 'top1',
              author: 'op_user',
              body: 'OP replying in their own thread.',
              created_utc: 1700000100,
              score: 10,
              depth: 0,
              parent_id: 't3_abc123',
              replies: {
                kind: 'Listing',
                data: {
                  children: [
                    {
                      kind: 't1',
                      data: {
                        id: 'reply1',
                        author: 'someone_else',
                        body: 'A nested reply.',
                        created_utc: 1700000200,
                        score: 3,
                        depth: 1,
                        parent_id: 't1_top1',
                        replies: '',
                      },
                    },
                  ],
                },
              },
            },
          },
          {
            kind: 't1',
            data: {
              id: 'top2',
              author: '[deleted]',
              body: '[removed]',
              created_utc: 1700000300,
              score: 1,
              depth: 0,
              parent_id: 't3_abc123',
              replies: '',
            },
          },
          {
            kind: 'more',
            data: {
              children: ['more1', 'more2'],
              count: 2,
            },
          },
        ],
      },
    },
  ]
}

describe('parseRedditThread', () => {
  it('produces post 0 as the OP with depth 0 and byOp true', () => {
    const thread = parseRedditThread(buildFixture(), POST_URL)
    expect(thread.posts[0]).toEqual({
      id: 'abc123',
      author: { name: 'op_user' },
      createdAt: new Date(1700000000 * 1000).toISOString(),
      depth: 0,
      text: 'This is the original post body.',
      score: 42,
      byOp: true,
    })
  })

  it('sets thread-level metadata from the post', () => {
    const thread = parseRedditThread(buildFixture(), POST_URL)
    expect(thread.site).toBe('reddit')
    expect(thread.url).toBe(POST_URL)
    expect(thread.title).toBe('Some title')
    expect(thread.author).toEqual({ name: 'op_user' })
    expect(thread.createdAt).toBe(new Date(1700000000 * 1000).toISOString())
    expect(thread.stats).toEqual({ score: 42, replyCount: 4 })
  })

  it('flattens the tree depth-first in reading order', () => {
    const thread = parseRedditThread(buildFixture(), POST_URL)
    const ids = thread.posts.map((p) => p.id)
    // OP, then top1, its nested reply1 (depth-first before top2), then top2.
    expect(ids).toEqual(['abc123', 'top1', 'reply1', 'top2'])
  })

  it('detects byOp for a comment authored by the OP', () => {
    const thread = parseRedditThread(buildFixture(), POST_URL)
    const top1 = thread.posts.find((p) => p.id === 'top1')
    expect(top1?.byOp).toBe(true)
    expect(top1?.depth).toBe(1)
    expect(top1?.parentId).toBe('abc123')
  })

  it('detects byOp false for a reply not authored by the OP', () => {
    const thread = parseRedditThread(buildFixture(), POST_URL)
    const reply1 = thread.posts.find((p) => p.id === 'reply1')
    expect(reply1?.byOp).toBe(false)
    expect(reply1?.depth).toBe(2)
    expect(reply1?.parentId).toBe('top1')
    expect(reply1?.author).toEqual({ name: 'someone_else' })
  })

  it('handles a [deleted] author and removed body verbatim', () => {
    const thread = parseRedditThread(buildFixture(), POST_URL)
    const top2 = thread.posts.find((p) => p.id === 'top2')
    expect(top2?.author).toEqual({ name: '[deleted]' })
    expect(top2?.text).toBe('[removed]')
    expect(top2?.byOp).toBe(false)
  })

  it('marks truncated true when a more stub with count > 0 is present', () => {
    const thread = parseRedditThread(buildFixture(), POST_URL)
    expect(thread.truncated).toBe(true)
  })

  it('does not set truncated when no more stub is present', () => {
    const fixture = buildFixture()
    // Drop the `more` stub from listing[1].
    ;(fixture[1] as any).data.children = (fixture[1] as any).data.children.filter(
      (c: any) => c.kind !== 'more',
    )
    const thread = parseRedditThread(fixture, POST_URL)
    expect(thread.truncated).toBeUndefined()
  })

  it('does not mark truncated for a more stub with count 0', () => {
    const fixture = buildFixture()
    const listing1 = fixture[1] as any
    const more = listing1.data.children.find((c: any) => c.kind === 'more')
    more.data.children = []
    more.data.count = 0
    const thread = parseRedditThread(fixture, POST_URL)
    expect(thread.truncated).toBeUndefined()
  })

  it('produces an empty-string text for an OP with no selftext (link post)', () => {
    const fixture = buildFixture()
    ;(fixture[0] as any).data.children[0].data.selftext = ''
    const thread = parseRedditThread(fixture, POST_URL)
    expect(thread.posts[0]?.text).toBe('')
  })

  it('handles a post with no top-level comments at all', () => {
    const fixture = buildFixture()
    ;(fixture[1] as any).data.children = []
    const thread = parseRedditThread(fixture, POST_URL)
    expect(thread.posts).toHaveLength(1)
    expect(thread.truncated).toBeUndefined()
  })

  it('throws when the top-level JSON is not an array', () => {
    expect(() => parseRedditThread({ not: 'an array' }, POST_URL)).toThrow(
      'parseRedditThread: expected top-level array',
    )
  })

  it('throws when listing[0] has no t3 post', () => {
    const fixture = buildFixture()
    ;(fixture[0] as any).data.children = []
    expect(() => parseRedditThread(fixture, POST_URL)).toThrow(
      'parseRedditThread: no t3 post found in listing[0]',
    )
  })
})
