import { describe, expect, it } from 'vitest'
import {
  extractYtInitialPlayerResponse,
  parseAutoChapters,
  parseCaptionTracks,
  parseJson3Cues,
  renderTranscriptMarkdown,
  selectCaptionTrack,
} from './transcript'

describe('extractYtInitialPlayerResponse', () => {
  it('parses a response without being confused by braces in JSON strings', () => {
    const html =
      '<script>window["ytInitialPlayerResponse"] = {"caption":"a }; b","captions":{}};</script>'
    expect(extractYtInitialPlayerResponse(html)).toEqual({ caption: 'a }; b', captions: {} })
  })

  it('returns undefined for absent, malformed, or unclosed values', () => {
    expect(extractYtInitialPlayerResponse('<html />')).toBeUndefined()
    expect(extractYtInitialPlayerResponse('ytInitialPlayerResponse = {bad};')).toBeUndefined()
    expect(extractYtInitialPlayerResponse('ytInitialPlayerResponse = {"a": 1')).toBeUndefined()
  })
})

describe('caption tracks', () => {
  it('selects manual English, then English ASR, then the first available track', () => {
    const tracks = parseCaptionTracks({
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [
            {
              baseUrl: 'https://example.test/fr',
              languageCode: 'fr',
              name: { simpleText: 'French' },
            },
            { baseUrl: 'https://example.test/en-asr', languageCode: 'en', kind: 'asr' },
            {
              baseUrl: 'https://example.test/en-manual',
              languageCode: 'en-US',
              name: { runs: [{ text: 'English' }] },
            },
          ],
        },
      },
    })
    expect(selectCaptionTrack(tracks)).toMatchObject({ url: 'https://example.test/en-manual' })
    expect(selectCaptionTrack(tracks.slice(0, 2))).toMatchObject({
      url: 'https://example.test/en-asr',
    })
    expect(selectCaptionTrack(tracks.slice(0, 1))).toMatchObject({ url: 'https://example.test/fr' })
  })

  it('does not throw on malformed responses or tracks without a URL', () => {
    expect(parseCaptionTracks(null)).toEqual([])
    expect(
      parseCaptionTracks({
        captions: { playerCaptionsTracklistRenderer: { captionTracks: [{}] } },
      }),
    ).toEqual([])
    expect(selectCaptionTrack([])).toBeUndefined()
  })
})

describe('parseAutoChapters', () => {
  it('finds AUTO_CHAPTERS in nested initial-data shapes and orders them by start', () => {
    const data = {
      playerOverlays: {
        playerOverlayRenderer: {
          decoratedPlayerBarRenderer: {
            decoratedPlayerBarRenderer: {
              playerBar: {
                multiMarkersPlayerBarRenderer: {
                  markersMap: [
                    {
                      key: 'OTHER',
                      value: {
                        chapters: [
                          {
                            chapterRenderer: {
                              timeRangeStartMillis: 9,
                              title: { simpleText: 'Ignore' },
                            },
                          },
                        ],
                      },
                    },
                    {
                      key: 'AUTO_CHAPTERS',
                      value: {
                        chapters: [
                          {
                            chapterRenderer: {
                              timeRangeStartMillis: '61000',
                              title: { runs: [{ text: 'Second' }] },
                            },
                          },
                          {
                            chapterRenderer: {
                              timeRangeStartMillis: 0,
                              title: { simpleText: 'Start' },
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
    }
    expect(parseAutoChapters(data)).toEqual([
      { startMs: 0, title: 'Start' },
      { startMs: 61000, title: 'Second' },
    ])
  })

  it('returns no chapters for malformed or unrelated input', () => {
    expect(
      parseAutoChapters({
        chapterRenderer: { timeRangeStartMillis: 0, title: { simpleText: 'Not automatic' } },
      }),
    ).toEqual([])
    expect(parseAutoChapters(null)).toEqual([])
  })
})

describe('parseJson3Cues', () => {
  it('keeps nonempty cues and normalizes text across caption segments', () => {
    expect(
      parseJson3Cues(
        '{"events":[{"tStartMs":0,"dDurationMs":1250,"segs":[{"utf8":"Hello "},{"utf8":"world"}]},{"tStartMs":1000,"segs":[]},{"tStartMs":2500,"segs":[{"utf8":"\\n Next   line "}]}]}',
      ),
    ).toEqual([
      { startMs: 0, durationMs: 1250, text: 'Hello world' },
      { startMs: 2500, text: 'Next line' },
    ])
  })

  it('returns no cues for malformed, empty, or timing-only json3', () => {
    expect(parseJson3Cues('not json')).toEqual([])
    expect(
      parseJson3Cues({
        events: [{ tStartMs: 0, segs: [{ utf8: '   ' }] }, { segs: [{ utf8: 'No time' }] }],
      }),
    ).toEqual([])
  })
})

describe('renderTranscriptMarkdown', () => {
  const video = {
    videoId: 'abc123',
    url: 'https://www.youtube.com/watch?v=abc123',
    title: 'A: video',
  }
  const cues = [
    { startMs: 0, text: 'Hello' },
    { startMs: 62000, text: 'World' },
  ]

  it('renders captions and optional automatic chapters as a standalone text source', () => {
    expect(renderTranscriptMarkdown(video, cues, [{ startMs: 0, title: 'Intro' }])).toBe(`---
source: youtube
url: "https://www.youtube.com/watch?v=abc123"
title: "A: video"
video_id: abc123
---

# A: video

## Chapters

- 0:00 — Intro

## Transcript

[0:00] Hello
[1:02] World`)
  })

  it('does not render an empty transcript source', () => {
    expect(renderTranscriptMarkdown(video, [])).toBeUndefined()
  })
})
