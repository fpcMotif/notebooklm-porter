import { describe, expect, it } from 'vitest'
import { videoToMarkdown } from './video'

describe('videoToMarkdown', () => {
  it('keeps source identity and optional display metadata in export Markdown', () => {
    const markdown = videoToMarkdown(
      {
        videoId: 'abcdefghijk',
        url: 'https://www.youtube.com/watch?v=abcdefghijk',
        title: 'A video: title',
        channel: 'Channel',
        durationSeconds: 125,
      },
      '2026-07-11T00:00:00.000Z',
    )

    expect(markdown).toContain('video_id: abcdefghijk')
    expect(markdown).toContain('title: "A video: title"')
    expect(markdown).toContain('channel: "Channel"')
    expect(markdown).toContain('duration_seconds: 125')
  })
})
