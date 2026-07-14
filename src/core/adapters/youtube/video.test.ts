import { describe, expect, it } from 'vitest'
import { standaloneYoutubeVideo, videoFromPlayerResponse } from './video'

describe('standaloneYoutubeVideo', () => {
  it('canonicalizes normal and shortened public watch URLs', () => {
    expect(standaloneYoutubeVideo('https://www.youtube.com/watch?v=abcdefghijk&t=30')).toEqual({
      videoId: 'abcdefghijk',
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
    })
    expect(standaloneYoutubeVideo('https://youtu.be/abcdefghijk?feature=share')).toEqual({
      videoId: 'abcdefghijk',
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
    })
    expect(standaloneYoutubeVideo('https://www.youtube.com/shorts/abcdefghijk')).toEqual({
      videoId: 'abcdefghijk',
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
    })
  })

  it('keeps playlist URLs out of the standalone path', () => {
    expect(
      standaloneYoutubeVideo('https://www.youtube.com/watch?v=abcdefghijk&list=PL123'),
    ).toBeUndefined()
    expect(standaloneYoutubeVideo('https://www.youtube.com/watch?v=short')).toBeUndefined()
  })
})

describe('videoFromPlayerResponse', () => {
  const identity = { videoId: 'abcdefghijk', url: 'https://www.youtube.com/watch?v=abcdefghijk' }

  it('reads display metadata without changing the canonical source URL', () => {
    expect(
      videoFromPlayerResponse(
        { videoDetails: { title: 'A video', author: 'Channel', lengthSeconds: '125' } },
        identity,
      ),
    ).toEqual({ ...identity, title: 'A video', channel: 'Channel', durationSeconds: 125 })
  })

  it('falls back to a stable display title when player markup is absent', () => {
    expect(videoFromPlayerResponse(undefined, identity)).toEqual({
      ...identity,
      title: 'YouTube video abcdefghijk',
    })
  })
})
