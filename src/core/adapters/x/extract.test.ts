import { describe, expect, it } from 'vitest'
import { assembleThread, parseStatusUrl, renderTweetTextNodes, stripTrailingTco } from './extract'
import type { RawTweet } from './extract'

const PAGE_URL = 'https://x.com/alice/status/1000'

describe('parseStatusUrl', () => {
  it('extracts handle and status id from a status permalink', () => {
    expect(parseStatusUrl(PAGE_URL)).toEqual({ handle: 'alice', statusId: '1000' })
  })

  it('returns null for a non-status page', () => {
    expect(parseStatusUrl('https://x.com/alice')).toBeNull()
    expect(parseStatusUrl('https://x.com/home')).toBeNull()
  })

  it('returns null for an unparseable URL', () => {
    expect(parseStatusUrl('not a url')).toBeNull()
  })
})

describe('stripTrailingTco', () => {
  it('strips a trailing t.co link', () => {
    expect(stripTrailingTco('check this out https://t.co/aBc123')).toBe('check this out')
  })

  it('leaves text without a trailing t.co link untouched', () => {
    expect(stripTrailingTco('no links here')).toBe('no links here')
  })

  it('does not strip a t.co link that is not at the end', () => {
    expect(stripTrailingTco('https://t.co/aBc123 is neat')).toBe('https://t.co/aBc123 is neat')
  })
})

describe('renderTweetTextNodes', () => {
  it('joins text, emoji-alt, and break nodes in order', () => {
    const text = renderTweetTextNodes([
      { kind: 'text', value: 'hello ' },
      { kind: 'emoji', alt: '🔥' },
      { kind: 'break' },
      { kind: 'text', value: 'second line' },
    ])
    expect(text).toBe('hello 🔥\nsecond line')
  })
})

describe('assembleThread — OP-only thread', () => {
  it('produces a single depth-0 byOp post', () => {
    const raw: RawTweet[] = [
      { id: '1000', authorHandle: 'alice', authorName: 'Alice', text: 'Hello world' },
    ]
    const thread = assembleThread(raw, PAGE_URL)

    expect(thread.site).toBe('x')
    expect(thread.url).toBe(PAGE_URL)
    expect(thread.title).toBe('Hello world')
    expect(thread.author).toEqual({ name: 'Alice', handle: '@alice' })
    expect(thread.posts).toHaveLength(1)
    expect(thread.posts[0]).toMatchObject({
      id: '1000',
      depth: 0,
      byOp: true,
      text: 'Hello world',
    })
    expect(thread.truncated).toBeUndefined()
  })
})

describe('assembleThread — OP multi-post self-thread with interleaved replies', () => {
  const raw: RawTweet[] = [
    { id: '1000', authorHandle: 'alice', authorName: 'Alice', text: 'Thread part 1' },
    { id: '1001', authorHandle: 'bob', authorName: 'Bob', text: 'Nice thread' },
    { id: '1002', authorHandle: 'alice', authorName: 'Alice', text: 'Thread part 2' },
    { id: '1003', authorHandle: 'carol', authorName: 'Carol', text: 'Adding on' },
  ]

  it('keeps DOM order and marks byOp/depth per post without inventing a reply tree', () => {
    const thread = assembleThread(raw, PAGE_URL)
    expect(thread.posts.map((p) => p.id)).toEqual(['1000', '1001', '1002', '1003'])
    expect(thread.posts.map((p) => p.depth)).toEqual([0, 1, 0, 1])
    expect(thread.posts.map((p) => p.byOp)).toEqual([true, false, true, false])
    expect(thread.posts.every((p) => p.parentId === undefined)).toBe(true)
  })

  it('is case-insensitive when matching the OP handle', () => {
    const mixedCase: RawTweet[] = [
      { id: '1000', authorHandle: 'Alice', authorName: 'Alice', text: 'Thread part 1' },
    ]
    const thread = assembleThread(mixedCase, PAGE_URL)
    expect(thread.posts[0]?.byOp).toBe(true)
  })
})

describe('assembleThread — truncated capture', () => {
  const raw: RawTweet[] = [
    { id: '1000', authorHandle: 'alice', authorName: 'Alice', text: 'Thread part 1' },
  ]

  it('sets truncated:true when opts.truncated is true', () => {
    const thread = assembleThread(raw, PAGE_URL, { truncated: true })
    expect(thread.truncated).toBe(true)
  })

  it('omits truncated when opts.truncated is false/absent', () => {
    const thread = assembleThread(raw, PAGE_URL, { truncated: false })
    expect(thread.truncated).toBeUndefined()
    expect('truncated' in thread).toBe(false)
  })
})

describe('assembleThread — quote-tweet text inclusion', () => {
  it('folds the quoted author + text into the post text as a nested blockquote', () => {
    const raw: RawTweet[] = [
      {
        id: '1000',
        authorHandle: 'alice',
        authorName: 'Alice',
        text: 'Look at this',
        quotedAuthorHandle: 'dave',
        quotedText: 'Original claim\nwith two lines',
      },
    ]
    const thread = assembleThread(raw, PAGE_URL)
    expect(thread.posts[0]?.text).toBe(
      'Look at this\n\nQuoting @dave:\n> Original claim\n> with two lines',
    )
  })

  it('handles a quote with no attributed author', () => {
    const raw: RawTweet[] = [
      {
        id: '1000',
        authorHandle: 'alice',
        authorName: 'Alice',
        text: 'Look at this',
        quotedText: 'Anonymous original',
      },
    ]
    const thread = assembleThread(raw, PAGE_URL)
    expect(thread.posts[0]?.text).toBe('Look at this\n\nQuoting:\n> Anonymous original')
  })
})

describe('assembleThread — long-post text', () => {
  it('preserves a long multi-paragraph tweet verbatim (minus a trailing t.co link)', () => {
    const paragraphs = Array.from({ length: 8 }, (_, i) => `Paragraph ${i + 1} of a long post.`)
    const longText = `${paragraphs.join('\n\n')} https://t.co/longlink1`
    const raw: RawTweet[] = [
      { id: '1000', authorHandle: 'alice', authorName: 'Alice', text: longText },
    ]
    const thread = assembleThread(raw, PAGE_URL)
    expect(thread.posts[0]?.text).toBe(paragraphs.join('\n\n'))
    expect(thread.title).toBe('Paragraph 1 of a long post.')
  })
})

describe('assembleThread — failure cases', () => {
  it('throws when the page URL is not a /status/ page', () => {
    expect(() =>
      assembleThread(
        [{ id: '1', authorHandle: 'alice', authorName: 'Alice', text: 'hi' }],
        'https://x.com/alice',
      ),
    ).toThrow(/not a \/status\/ page/)
  })

  it('throws when there are no tweets to assemble', () => {
    expect(() => assembleThread([], PAGE_URL)).toThrow(/no tweets/)
  })
})

describe('assembleThread — root tweet resolution', () => {
  it('derives title/createdAt from the tweet matching the permalink status id, not the first tweet', () => {
    const raw: RawTweet[] = [
      {
        id: '999',
        authorHandle: 'bob',
        authorName: 'Bob',
        text: 'ancestor context tweet',
      },
      {
        id: '1000',
        authorHandle: 'alice',
        authorName: 'Alice',
        text: 'the actual focused tweet',
        timestamp: '2026-01-01T00:00:00.000Z',
      },
    ]
    const thread = assembleThread(raw, PAGE_URL)
    expect(thread.title).toBe('the actual focused tweet')
    expect(thread.createdAt).toBe('2026-01-01T00:00:00.000Z')
  })
})
