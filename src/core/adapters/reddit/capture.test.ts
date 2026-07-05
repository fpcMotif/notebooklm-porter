import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureRedditThread } from './capture'

const FROZEN_JSON = [
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
            selftext: 'Body text.',
            created_utc: 1700000000,
            score: 5,
            permalink: '/r/test/comments/abc123/some_title/',
            num_comments: 0,
          },
        },
      ],
    },
  },
  { kind: 'Listing', data: { children: [] } },
]

function mockFetch(json: unknown, ok = true, status = 200) {
  const fetchMock = vi.fn<
    (
      url: string,
      init?: unknown,
    ) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>
  >(async () => ({
    ok,
    status,
    json: async () => json,
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('captureRedditThread', () => {
  it('fetches the .json URL built from the post URL, stripping query and hash', async () => {
    const fetchMock = mockFetch(FROZEN_JSON)
    await captureRedditThread(
      'https://www.reddit.com/r/test/comments/abc123/some_title/?utm_source=share#comment',
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const calledUrl = fetchMock.mock.calls[0]?.[0]
    expect(calledUrl).toBe('https://www.reddit.com/r/test/comments/abc123/some_title.json')
  })

  it('handles a post URL with no trailing slash', async () => {
    const fetchMock = mockFetch(FROZEN_JSON)
    await captureRedditThread('https://www.reddit.com/r/test/comments/abc123/some_title')
    const calledUrl = fetchMock.mock.calls[0]?.[0]
    expect(calledUrl).toBe('https://www.reddit.com/r/test/comments/abc123/some_title.json')
  })

  it('returns a Capture of kind thread wrapping the parsed thread', async () => {
    mockFetch(FROZEN_JSON)
    const capture = await captureRedditThread(
      'https://www.reddit.com/r/test/comments/abc123/some_title/',
    )
    expect(capture.kind).toBe('thread')
    const thread = capture.kind === 'thread' ? capture.thread : undefined
    expect(thread?.site).toBe('reddit')
    expect(thread?.title).toBe('Some title')
    expect(thread?.posts).toHaveLength(1)
  })

  it('throws when the fetch response is not ok', async () => {
    mockFetch(FROZEN_JSON, false, 429)
    await expect(
      captureRedditThread('https://www.reddit.com/r/test/comments/abc123/some_title/'),
    ).rejects.toThrow(/429/)
  })
})
