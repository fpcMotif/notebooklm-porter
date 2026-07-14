import { describe, expect, it } from 'vitest'
import { youtubeAdapter } from './adapter'

describe('youtubeAdapter.detect', () => {
  it('distinguishes a standalone video from a watch-page playlist', () => {
    expect(youtubeAdapter.detect('https://www.youtube.com/watch?v=abcdefghijk')).toEqual({
      kind: 'video',
      label: 'Capture this video',
    })
    expect(youtubeAdapter.detect('https://youtu.be/abcdefghijk')).toEqual({
      kind: 'video',
      label: 'Capture this video',
    })
    expect(youtubeAdapter.detect('https://www.youtube.com/shorts/abcdefghijk')).toEqual({
      kind: 'video',
      label: 'Capture this video',
    })
    expect(youtubeAdapter.detect('https://www.youtube.com/watch?v=abcdefghijk&list=PL123')).toEqual(
      {
        kind: 'playlist',
        label: "Capture this video's playlist",
      },
    )
  })

  it('advertises a shortened video URL with list= as its playlist', () => {
    expect(youtubeAdapter.detect('https://youtu.be/abcdefghijk?list=PL123')).toEqual({
      kind: 'playlist',
      label: "Capture this video's playlist",
    })
    expect(youtubeAdapter.detect('https://youtu.be/abcdefghijk?list=RDabcdefghijk')).toEqual({
      kind: 'playlist',
      label: 'Capture this Mix (snapshot)',
    })
  })
})
