import { describe, expect, it } from 'vitest'
import { htmlToText, parseHnItem } from './parse'

describe('htmlToText', () => {
  it('converts <p> paragraphs to double newlines', () => {
    const { text } = htmlToText('<p>First paragraph.<p>Second paragraph.')
    expect(text).toBe('First paragraph.\n\nSecond paragraph.')
  })

  it('renders a link with different label text as "label (href)" and collects the href', () => {
    const { text, links } = htmlToText(
      'Check out <a href="https://example.com/x">this thing</a> now.',
    )
    expect(text).toBe('Check out this thing (https://example.com/x) now.')
    expect(links).toEqual(['https://example.com/x'])
  })

  it('renders a link whose label equals the href as just the href', () => {
    const { text, links } = htmlToText('<a href="https://example.com">https://example.com</a>')
    expect(text).toBe('https://example.com')
    expect(links).toEqual(['https://example.com'])
  })

  it('strips <i>, <code> to plain text', () => {
    const { text } = htmlToText('This is <i>italic</i> and <code>code</code>.')
    expect(text).toBe('This is italic and code.')
  })

  it('unwraps <pre><code> blocks keeping inner content', () => {
    const { text } = htmlToText(
      '<p>Example:<p><pre><code>const x = 1;\nconsole.log(x);</code></pre>',
    )
    expect(text).toContain('const x = 1;\nconsole.log(x);')
  })

  it('decodes common HTML entities', () => {
    const { text } = htmlToText(
      'Tom &amp; Jerry said &#x27;hi&#x2F;bye&#x27; &lt;loudly&gt; &quot;really&quot;',
    )
    expect(text).toBe(`Tom & Jerry said 'hi/bye' <loudly> "really"`)
  })

  it('handles null/undefined/empty text gracefully', () => {
    expect(htmlToText(null)).toEqual({ text: '', links: [] })
    expect(htmlToText(undefined)).toEqual({ text: '', links: [] })
    expect(htmlToText('')).toEqual({ text: '', links: [] })
  })

  it('collapses runs of 3+ newlines down to double newlines and trims', () => {
    const { text } = htmlToText('<p><p><p>a<p><p>b')
    expect(text).toBe('a\n\nb')
  })
})

// Frozen fixture modeled on a real hn.algolia.com/api/v1/items/{id} response shape:
// a link story with a top-level text-less body, two top comments (one by OP),
// one nested reply, and one dead/deleted comment (author + text both null).
const FIXTURE_STORY_URL = 'https://blog.example.com/great-post'

function buildFixture() {
  return {
    id: 1000,
    created_at: '2026-01-01T12:00:00.000Z',
    author: 'opuser',
    title: 'Great Post About Widgets',
    url: FIXTURE_STORY_URL,
    points: 150,
    text: null,
    type: 'story',
    children: [
      {
        id: 1001,
        created_at: '2026-01-01T12:05:00.000Z',
        author: 'commenter_a',
        text: '<p>Interesting take, but have you seen <a href="https://example.com/related">this related work</a>?',
        points: 20,
        type: 'comment',
        children: [
          {
            id: 1002,
            created_at: '2026-01-01T12:10:00.000Z',
            author: 'opuser',
            text: '<p>Yes, we cite it in the appendix.',
            points: null,
            type: 'comment',
            children: [],
          },
        ],
      },
      {
        id: 1003,
        created_at: '2026-01-01T12:07:00.000Z',
        author: null,
        text: null,
        points: null,
        type: 'comment',
        children: [],
      },
    ],
  }
}

const CANONICAL_URL = 'https://news.ycombinator.com/item?id=1000'

describe('parseHnItem — link story fixture', () => {
  it('produces a Thread with site, url, title, author, createdAt from the root', () => {
    const thread = parseHnItem(buildFixture(), CANONICAL_URL)
    expect(thread.site).toBe('hackernews')
    expect(thread.url).toBe(CANONICAL_URL)
    expect(thread.title).toBe('Great Post About Widgets')
    expect(thread.author).toEqual({ name: 'opuser' })
    expect(thread.createdAt).toBe('2026-01-01T12:00:00.000Z')
  })

  it('post 0 is the story at depth 0, byOp true, empty text (link story, no text body), story url in links', () => {
    const thread = parseHnItem(buildFixture(), CANONICAL_URL)
    const root = thread.posts[0]
    expect(root).toBeDefined()
    expect(root?.id).toBe('1000')
    expect(root?.depth).toBe(0)
    expect(root?.byOp).toBe(true)
    expect(root?.text).toBe('')
    expect(root?.score).toBe(150)
    expect(root?.links).toContain(FIXTURE_STORY_URL)
  })

  it('flattens comments depth-first with correct depth/parentId/byOp', () => {
    const thread = parseHnItem(buildFixture(), CANONICAL_URL)
    // Expect order: root(1000), commenter_a(1001, depth1), opuser reply(1002, depth2), dead(1003, depth1)
    const ids = thread.posts.map((p) => p.id)
    expect(ids).toEqual(['1000', '1001', '1002', '1003'])

    const c1 = thread.posts.find((p) => p.id === '1001')
    expect(c1?.depth).toBe(1)
    expect(c1?.parentId).toBe('1000')
    expect(c1?.byOp).toBe(false)
    expect(c1?.author).toEqual({ name: 'commenter_a' })
    expect(c1?.score).toBe(20)
    expect(c1?.text).toBe(
      'Interesting take, but have you seen this related work (https://example.com/related)?',
    )
    expect(c1?.links).toEqual(['https://example.com/related'])

    const nested = thread.posts.find((p) => p.id === '1002')
    expect(nested?.depth).toBe(2)
    expect(nested?.parentId).toBe('1001')
    expect(nested?.byOp).toBe(true)
    expect(nested?.text).toBe('Yes, we cite it in the appendix.')
    expect(nested?.score).toBeUndefined()
  })

  it('includes dead/deleted comments (author null, text null) gracefully with empty text', () => {
    const thread = parseHnItem(buildFixture(), CANONICAL_URL)
    const dead = thread.posts.find((p) => p.id === '1003')
    expect(dead).toBeDefined()
    expect(dead?.depth).toBe(1)
    expect(dead?.parentId).toBe('1000')
    expect(dead?.text).toBe('')
    expect(dead?.byOp).toBe(false)
    expect(dead?.author.name).toBe('[deleted]')
  })
})

describe('parseHnItem — Ask HN style (no title, no url, text body)', () => {
  it('derives the title from the first non-empty line of the body text', () => {
    const fixture = {
      id: 2000,
      created_at: '2026-02-01T00:00:00.000Z',
      author: 'asker',
      title: null,
      url: null,
      points: 42,
      text: '<p>Ask HN: What is your favorite tool?<p>I am curious what people use daily.',
      type: 'story',
      children: [],
    }
    const thread = parseHnItem(fixture, 'https://news.ycombinator.com/item?id=2000')
    expect(thread.title).toBe('Ask HN: What is your favorite tool?')
    const root = thread.posts[0]
    expect(root?.text).toBe(
      'Ask HN: What is your favorite tool?\n\nI am curious what people use daily.',
    )
    expect(root?.links ?? []).toEqual([])
  })
})

describe('parseHnItem — story with both url and text', () => {
  it('keeps the body text (not forced empty) when both url and text are present', () => {
    const fixture = {
      id: 3000,
      created_at: '2026-03-01T00:00:00.000Z',
      author: 'poster',
      title: 'Link with commentary',
      url: 'https://example.com/article',
      points: 10,
      text: '<p>Here is why this matters.',
      type: 'story',
      children: [],
    }
    const thread = parseHnItem(fixture, 'https://news.ycombinator.com/item?id=3000')
    const root = thread.posts[0]
    expect(root?.text).toBe('Here is why this matters.')
    expect(root?.links).toContain('https://example.com/article')
  })
})

describe('parseHnItem — no children', () => {
  it('produces a single-post thread when there are no comments', () => {
    const fixture = {
      id: 4000,
      created_at: '2026-04-01T00:00:00.000Z',
      author: 'loner',
      title: 'Nobody replied',
      url: null,
      points: 1,
      text: '<p>Just me here.',
      type: 'story',
      children: [],
    }
    const thread = parseHnItem(fixture, 'https://news.ycombinator.com/item?id=4000')
    expect(thread.posts).toHaveLength(1)
  })

  it('tolerates a missing/null children field entirely', () => {
    const fixture = {
      id: 4001,
      created_at: '2026-04-01T00:00:00.000Z',
      author: 'loner',
      title: 'Nobody replied',
      url: null,
      points: 1,
      text: '<p>Just me here.',
      type: 'story',
    }
    const thread = parseHnItem(fixture, 'https://news.ycombinator.com/item?id=4001')
    expect(thread.posts).toHaveLength(1)
  })
})
