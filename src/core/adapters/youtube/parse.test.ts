import { describe, expect, it } from 'vitest'
import realFirstPage from './fixture-firstpage.json'
import {
  extractInnertube,
  extractYtInitialData,
  parseContinuation,
  parsePlaylistPage,
} from './parse'

const PLAYLIST_ID = 'PL553DCA4DB88B0408'

/**
 * `realFirstPage` is a trimmed `ytInitialData` captured 2026-07-06 from
 * `https://www.youtube.com/playlist?list=PL553DCA4DB88B0408` (the real,
 * public "Searle: 3 Philosophy Courses (UC Berkeley)" playlist — 84 videos).
 * Trimmed to the first 3 `lockupViewModel` rows + header + sidebar + the
 * trailing `continuationItemViewModel`, all unedited real field values.
 *
 * fixtureNote: the design spec (§5.1) describes the OLDER
 * `playlistVideoListRenderer`/`playlistVideoRenderer` shape. The live page no
 * longer serves that — YouTube has migrated playlist rows to
 * `lockupViewModel` (confirmed by curling the real page on 2026-07-06; no
 * `playlistVideoRenderer` string appears anywhere in the response). This
 * parser targets the shape YouTube actually serves today. Separately: POSTing
 * this playlist's own continuation token back to `youtubei/v1/browse` (both
 * for this list and for a second, larger auto-generated playlist) returned a
 * `loggedOut: true`, item-less response for a bare `curl` session — matching
 * the spec's flagged poToken/session risk for anonymous continuation calls.
 * Since no real populated continuation response was obtainable this way, the
 * continuation-response fixture below is hand-synthesized to match the
 * documented `onResponseReceivedActions[].appendContinuationItemsAction`
 * shape, reusing the same real `lockupViewModel` row structure.
 */

describe('extractYtInitialData', () => {
  it('parses ytInitialData assigned via bracket notation', () => {
    const html = `<script>var x = 1; window["ytInitialData"] = {"a":1}; more(); </script>`
    expect(extractYtInitialData(html)).toEqual({ a: 1 })
  })

  it('parses ytInitialData assigned via bare identifier', () => {
    const html = `<script>ytInitialData = {"b":[1,2,3]};</script>`
    expect(extractYtInitialData(html)).toEqual({ b: [1, 2, 3] })
  })

  it('throws a descriptive error when ytInitialData is absent', () => {
    expect(() => extractYtInitialData('<html><body>nope</body></html>')).toThrow(
      'extractYtInitialData: ytInitialData not found in page HTML',
    )
  })

  it('throws a descriptive error when the matched blob is not valid JSON', () => {
    const html = `ytInitialData = {not valid json};`
    expect(() => extractYtInitialData(html)).toThrow(/failed to parse ytInitialData JSON/)
  })

  it('parses correctly when a field value contains a literal "};"', () => {
    const html = `<script>ytInitialData = {"title":"do this thing};  then that","b":2};</script>`
    expect(extractYtInitialData(html)).toEqual({ title: 'do this thing};  then that', b: 2 })
  })
})

describe('extractInnertube', () => {
  it('extracts the API key and context object from real page HTML', () => {
    const html = `"INNERTUBE_API_KEY":"AIzaSyTest123","INNERTUBE_CONTEXT":{"client":{"hl":"en","gl":"US"}},"INNERTUBE_CONTEXT_CLIENT_NAME":1`
    const result = extractInnertube(html)
    expect(result.apiKey).toBe('AIzaSyTest123')
    expect(result.context).toEqual({ client: { hl: 'en', gl: 'US' } })
  })

  it('throws when INNERTUBE_API_KEY is missing', () => {
    const html = `"INNERTUBE_CONTEXT":{"client":{}},"INNERTUBE_CONTEXT_CLIENT_NAME":1`
    expect(() => extractInnertube(html)).toThrow(
      'extractInnertube: INNERTUBE_API_KEY not found in page HTML',
    )
  })

  it('throws when INNERTUBE_CONTEXT is missing', () => {
    const html = `"INNERTUBE_API_KEY":"AIzaSyTest123"`
    expect(() => extractInnertube(html)).toThrow(
      'extractInnertube: INNERTUBE_CONTEXT not found in page HTML',
    )
  })
})

describe('parsePlaylistPage (real fixture)', () => {
  it('parses the real 3 trimmed videos with actual ids/titles/durations/channel', () => {
    const { playlist } = parsePlaylistPage(realFirstPage, PLAYLIST_ID)
    expect(playlist.videos).toEqual([
      {
        videoId: 'zi7Va_4ekko',
        url: 'https://www.youtube.com/watch?v=zi7Va_4ekko',
        title: 'Searle: Philosophy of Mind, lecture 1',
        channel: 'SocioPhilosophy',
        durationSeconds: 4588,
        index: 1,
      },
      {
        videoId: 'c14ZI80-gPo',
        url: 'https://www.youtube.com/watch?v=c14ZI80-gPo',
        title: 'Searle: Philosophy of Mind, lecture 2',
        channel: 'SocioPhilosophy',
        durationSeconds: 4662,
        index: 2,
      },
      {
        videoId: 'qJ9YQ5IHzrI',
        url: 'https://www.youtube.com/watch?v=qJ9YQ5IHzrI',
        title: 'Searle: Philosophy of Mind, lecture 3',
        channel: 'SocioPhilosophy',
        durationSeconds: 4535,
        index: 3,
      },
    ])
  })

  it('reads the real playlist title, channel, and video count from header/sidebar', () => {
    const { playlist } = parsePlaylistPage(realFirstPage, PLAYLIST_ID)
    expect(playlist.title).toBe('Searle: 3 Philosophy Courses (UC Berkeley)')
    expect(playlist.channel).toBe('SocioPhilosophy')
    expect(playlist.videoCount).toBe(84)
    expect(playlist.playlistId).toBe(PLAYLIST_ID)
    expect(playlist.url).toBe(`https://www.youtube.com/playlist?list=${PLAYLIST_ID}`)
  })

  it('extracts the real trailing continuation token', () => {
    const { continuation } = parsePlaylistPage(realFirstPage, PLAYLIST_ID)
    expect(continuation).toBe(
      '4qmFsgI7EhRWTFBMNTUzRENBNERCODhCMDQwOBoMa2dFRENMY0w0QXNCmgIUVkxQTDU1M0RDQTREQjg4QjA0MDg%3D',
    )
  })
})

function minimalSectionList(contents: unknown[]) {
  return {
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs: [
          {
            tabRenderer: {
              content: {
                sectionListRenderer: { contents },
              },
            },
          },
        ],
      },
    },
  }
}

describe('parsePlaylistPage (edge cases)', () => {
  it('throws when there is no ytInitialData structure at all', () => {
    expect(() => parsePlaylistPage({ unrelated: true }, 'PLxyz')).toThrow(
      'parsePlaylistPage: could not find sectionListRenderer.contents',
    )
  })

  it('throws when no videos are found in an otherwise-valid structure', () => {
    const data = minimalSectionList([{ itemSectionRenderer: { contents: [] } }])
    expect(() => parsePlaylistPage(data, 'PLxyz')).toThrow(
      'parsePlaylistPage: no videos found in playlist page',
    )
  })

  it('yields an entry without channel/duration keys when those fields are absent', () => {
    const data = minimalSectionList([
      {
        itemSectionRenderer: {
          contents: [
            {
              lockupViewModel: {
                contentId: 'onlyId123',
                metadata: { lockupMetadataViewModel: { title: { content: 'Bare video' } } },
                rendererContext: {
                  commandContext: { onTap: { innertubeCommand: { watchEndpoint: { index: 0 } } } },
                },
              },
            },
          ],
        },
      },
    ])
    const { playlist } = parsePlaylistPage(data, 'PLxyz')
    expect(playlist.videos).toHaveLength(1)
    const entry = playlist.videos[0]
    expect(entry).toEqual({
      videoId: 'onlyId123',
      url: 'https://www.youtube.com/watch?v=onlyId123',
      title: 'Bare video',
      index: 1,
    })
    expect(entry).not.toHaveProperty('channel')
    expect(entry).not.toHaveProperty('durationSeconds')
  })

  it('falls back to a sensible title/videoCount when header/sidebar are absent, once videos are found', () => {
    const data = minimalSectionList([
      {
        itemSectionRenderer: {
          contents: [
            {
              lockupViewModel: {
                contentId: 'v1',
                metadata: { lockupMetadataViewModel: { title: { content: 'Video One' } } },
                rendererContext: {
                  commandContext: { onTap: { innertubeCommand: { watchEndpoint: { index: 0 } } } },
                },
              },
            },
          ],
        },
      },
    ])
    const { playlist } = parsePlaylistPage(data, 'PLfallback')
    expect(playlist.title).toBe('Playlist PLfallback')
    expect(playlist.videoCount).toBe(1)
    expect(playlist).not.toHaveProperty('channel')
  })

  it('falls back to a 1-based position index when watchEndpoint.index is absent', () => {
    const data = minimalSectionList([
      {
        itemSectionRenderer: {
          contents: [
            {
              lockupViewModel: {
                contentId: 'first',
                metadata: { lockupMetadataViewModel: { title: { content: 'First' } } },
              },
            },
            {
              lockupViewModel: {
                contentId: 'second',
                metadata: { lockupMetadataViewModel: { title: { content: 'Second' } } },
              },
            },
          ],
        },
      },
    ])
    const { playlist } = parsePlaylistPage(data, 'PLfallback')
    expect(playlist.videos.map((v) => [v.videoId, v.index])).toEqual([
      ['first', 1],
      ['second', 2],
    ])
  })

  it('skips a lockup entry with no contentId and no watchEndpoint.videoId', () => {
    const data = minimalSectionList([
      {
        itemSectionRenderer: {
          contents: [
            {
              lockupViewModel: {
                metadata: { lockupMetadataViewModel: { title: { content: 'No id' } } },
              },
            },
            {
              lockupViewModel: {
                contentId: 'valid1',
                metadata: { lockupMetadataViewModel: { title: { content: 'Valid' } } },
              },
            },
          ],
        },
      },
    ])
    const { playlist } = parsePlaylistPage(data, 'PLfallback')
    expect(playlist.videos.map((v) => v.videoId)).toEqual(['valid1'])
  })
})

/**
 * Synthesized (see fixtureNote above): shape matches the documented
 * `onResponseReceivedActions[].appendContinuationItemsAction.continuationItems[]`
 * response of `POST youtubei/v1/browse`, reusing real lockupViewModel field
 * names/structure observed in the first-page fixture.
 */
function continuationResponse(hasNextToken: boolean) {
  const nextTokenItem = {
    continuationItemViewModel: {
      continuationCommand: {
        innertubeCommand: { continuationCommand: { token: 'NEXT_PAGE_TOKEN' } },
      },
    },
  }

  return {
    onResponseReceivedActions: [
      {
        appendContinuationItemsAction: {
          continuationItems: [
            {
              lockupViewModel: {
                contentId: 'cont1video',
                contentImage: {
                  thumbnailViewModel: {
                    overlays: [
                      {
                        thumbnailBottomOverlayViewModel: {
                          badges: [{ thumbnailBadgeViewModel: { text: '10:05' } }],
                        },
                      },
                    ],
                  },
                },
                metadata: {
                  lockupMetadataViewModel: {
                    title: { content: 'Continuation Video One' },
                    metadata: {
                      contentMetadataViewModel: {
                        metadataRows: [{ metadataParts: [{ text: { content: 'Some Channel' } }] }],
                      },
                    },
                  },
                },
                rendererContext: {
                  commandContext: {
                    onTap: { innertubeCommand: { watchEndpoint: { index: 84 } } },
                  },
                },
              },
            },
            {
              lockupViewModel: {
                contentId: 'cont2video',
                metadata: {
                  lockupMetadataViewModel: { title: { content: 'Continuation Video Two' } },
                },
                rendererContext: {
                  commandContext: {
                    onTap: { innertubeCommand: { watchEndpoint: { index: 85 } } },
                  },
                },
              },
            },
            ...(hasNextToken ? [nextTokenItem] : []),
          ],
        },
      },
    ],
  }
}

describe('parseContinuation', () => {
  it('parses appended videos and the next continuation token', () => {
    const result = parseContinuation(continuationResponse(true))
    expect(result.videos).toEqual([
      {
        videoId: 'cont1video',
        url: 'https://www.youtube.com/watch?v=cont1video',
        title: 'Continuation Video One',
        channel: 'Some Channel',
        durationSeconds: 605,
        index: 85,
      },
      {
        videoId: 'cont2video',
        url: 'https://www.youtube.com/watch?v=cont2video',
        title: 'Continuation Video Two',
        index: 86,
      },
    ])
    expect(result.continuation).toBe('NEXT_PAGE_TOKEN')
  })

  it('parses a final page with no further continuation token', () => {
    const result = parseContinuation(continuationResponse(false))
    expect(result.videos).toHaveLength(2)
    expect(result.continuation).toBeUndefined()
  })

  it('returns an empty video list for a response with no onResponseReceivedActions (observed real behavior)', () => {
    // Matches the real, empty `{responseContext, trackingParams}` response
    // this task's curl got back from a live anonymous continuation POST.
    const result = parseContinuation({ responseContext: {}, trackingParams: 'abc' })
    expect(result.videos).toEqual([])
    expect(result.continuation).toBeUndefined()
  })

  it('returns an empty video list for non-object input', () => {
    expect(parseContinuation(null)).toEqual({ videos: [] })
    expect(parseContinuation('not an object')).toEqual({ videos: [] })
  })
})
