import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureHnThread } from './capture'

const FIXTURE_ITEM = {
  id: 42,
  created_at: '2026-01-01T12:00:00.000Z',
  author: 'opuser',
  title: 'A Discussion',
  url: null,
  points: 5,
  text: '<p>Root text here.',
  type: 'story',
  children: [],
}

function fetchResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response
}

describe('captureHnThread', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('extracts the item id from the url and fetches the Algolia endpoint', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(fetchResponse(FIXTURE_ITEM))
    vi.stubGlobal('fetch', fetchMock)

    await captureHnThread('https://news.ycombinator.com/item?id=42')

    expect(fetchMock).toHaveBeenCalledWith('https://hn.algolia.com/api/v1/items/42')
  })

  it('returns a thread Capture built from the parsed item', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse(FIXTURE_ITEM)))

    const capture = await captureHnThread('https://news.ycombinator.com/item?id=42')

    expect(capture.kind).toBe('thread')
    if (capture.kind !== 'thread') throw new Error('expected thread capture')
    expect(capture.thread.site).toBe('hackernews')
    expect(capture.thread.url).toBe('https://news.ycombinator.com/item?id=42')
    expect(capture.thread.title).toBe('A Discussion')
    expect(capture.thread.posts[0]?.text).toBe('Root text here.')
  })

  it('produces the canonical /item?id= url regardless of extra query params on the input', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse(FIXTURE_ITEM)))

    const capture = await captureHnThread('https://news.ycombinator.com/item?id=42&extra=1')

    if (capture.kind !== 'thread') throw new Error('expected thread capture')
    expect(capture.thread.url).toBe('https://news.ycombinator.com/item?id=42')
  })

  it('throws when the url has no id parameter', async () => {
    vi.stubGlobal('fetch', vi.fn())

    await expect(captureHnThread('https://news.ycombinator.com/item')).rejects.toThrow(
      /not an HN item URL/,
    )
  })

  it('throws when the fetch response is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(fetchResponse(null, false, 404)))

    await expect(captureHnThread('https://news.ycombinator.com/item?id=999')).rejects.toThrow(/404/)
  })
})
