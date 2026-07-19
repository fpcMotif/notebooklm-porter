import { describe, expect, it } from 'vitest'
import { youtubeAdapter } from './adapter'

describe('youtubeAdapter.detect', () => {
  it('distinguishes a standalone video from a watch-page playlist', () => {
    expect(youtubeAdapter.detect('https://www.youtube.com/watch?v=abcdefghijk')).toEqual({
      identity: 'abcdefghijk',
      kind: 'video',
      label: 'Capture this video',
    })
    expect(youtubeAdapter.detect('https://youtu.be/abcdefghijk')).toEqual({
      identity: 'abcdefghijk',
      kind: 'video',
      label: 'Capture this video',
    })
    expect(youtubeAdapter.detect('https://www.youtube.com/shorts/abcdefghijk')).toEqual({
      identity: 'abcdefghijk',
      kind: 'video',
      label: 'Capture this video',
    })
    expect(youtubeAdapter.detect('https://www.youtube.com/watch?v=abcdefghijk&list=PL123')).toEqual(
      {
        identity: 'PL123',
        kind: 'playlist',
        label: "Capture this video's playlist",
        canEnrichTranscripts: true,
      },
    )
  })

  it('advertises a shortened video URL with list= as its playlist', () => {
    expect(youtubeAdapter.detect('https://youtu.be/abcdefghijk?list=PL123')).toEqual({
      identity: 'PL123',
      kind: 'playlist',
      label: "Capture this video's playlist",
      canEnrichTranscripts: true,
    })
    expect(youtubeAdapter.detect('https://youtu.be/abcdefghijk?list=RDabcdefghijk')).toEqual({
      identity: 'RDabcdefghijk',
      kind: 'playlist',
      label: 'Capture this Mix (snapshot)',
      canEnrichTranscripts: true,
    })
  })
})
