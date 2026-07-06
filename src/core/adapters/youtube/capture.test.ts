import { afterEach, describe, expect, it, vi } from 'vitest'
import { capturePlaylist, isMixList } from './capture'
import realMixPanel from './fixture-mix-panel.json'

function htmlWithInitialData(data: unknown): string {
  return `<html><body><script>
    var ytInitialData = ${JSON.stringify(data)};
  </script></body></html>`
}

function mockFetchText(html: string, ok = true, status = 200) {
  const fetchMock = vi.fn<(url: string, init?: unknown) => Promise<Response>>(
    async () =>
      ({
        ok,
        status,
        text: async () => html,
      }) as unknown as Response,
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isMixList', () => {
  it('treats RD-prefixed ids as mixes', () => {
    expect(isMixList('RD9UZKYgqcY8U')).toBe(true)
  })

  it('treats UL-prefixed ids as mixes', () => {
    expect(isMixList('ULabc123')).toBe(true)
  })

  it('treats other prefixes (PL, OLAK) as non-mixes', () => {
    expect(isMixList('PL553DCA4DB88B0408')).toBe(false)
    expect(isMixList('OLAK5uy_abc')).toBe(false)
  })
})

describe('capturePlaylist (mix branch)', () => {
  const MIX_URL = 'https://www.youtube.com/watch?v=9UZKYgqcY8U&list=RD9UZKYgqcY8U&start_radio=1'

  it('fetches the cleaned original watch URL, stripping non-v/list params', async () => {
    const fetchMock = mockFetchText(htmlWithInitialData(realMixPanel))
    await capturePlaylist(MIX_URL)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const calledUrl = fetchMock.mock.calls[0]?.[0]
    expect(calledUrl).toBe('https://www.youtube.com/watch?v=9UZKYgqcY8U&list=RD9UZKYgqcY8U')
  })

  it('parses the panel videos and sets playlist.url to the cleaned watch URL', async () => {
    mockFetchText(htmlWithInitialData(realMixPanel))
    const capture = await capturePlaylist(MIX_URL)
    expect(capture.kind).toBe('playlist')
    const playlist = capture.kind === 'playlist' ? capture.playlist : undefined
    expect(playlist?.videos).toHaveLength(3)
    expect(playlist?.url).toBe('https://www.youtube.com/watch?v=9UZKYgqcY8U&list=RD9UZKYgqcY8U')
    expect(playlist?.title).toBe(
      "Mix - 260324 KARINA 카리나 - THAT'S A NO NO & RUDE! COVER @KARINA B-DAY PARTY MEMORY BOX IN SEOUL",
    )
  })

  it('always forces truncated: true for a mix snapshot', async () => {
    mockFetchText(htmlWithInitialData(realMixPanel))
    const capture = await capturePlaylist(MIX_URL)
    const playlist = capture.kind === 'playlist' ? capture.playlist : undefined
    expect(playlist?.truncated).toBe(true)
  })

  it('does not attempt a continuation fetch for a mix (only one fetch call total)', async () => {
    const fetchMock = mockFetchText(htmlWithInitialData(realMixPanel))
    await capturePlaylist(MIX_URL)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('includes the fetched URL in the error message when the page fetch fails', async () => {
    mockFetchText('', false, 500)
    await expect(capturePlaylist(MIX_URL)).rejects.toThrow(
      /https:\/\/www\.youtube\.com\/watch\?v=9UZKYgqcY8U&list=RD9UZKYgqcY8U/,
    )
  })
})
