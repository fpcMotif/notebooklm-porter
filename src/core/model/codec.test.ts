import { describe, expect, it } from 'vitest'
import { decodeCapture, decodeSourceDoc, decodeStoredSourceDocs } from './codec'

describe('decodeCapture', () => {
  it('decodes a complete thread and drops unknown fields', () => {
    const value = {
      kind: 'thread',
      ignored: true,
      thread: {
        site: 'reddit',
        url: 'https://example.com/thread',
        title: 'Thread',
        author: { name: 'OP', handle: 'u/op', ignored: true },
        createdAt: '2026-07-18T00:00:00.000Z',
        posts: [
          {
            id: 'post-1',
            author: { name: 'Reply', handle: 'u/reply' },
            createdAt: '2026-07-18T01:00:00.000Z',
            depth: 1,
            text: 'Hello',
            score: 4,
            parentId: 'root',
            byOp: false,
            media: [{ kind: 'image', url: 'https://example.com/image', alt: 'Image' }],
            links: ['https://example.com/link'],
            ignored: true,
          },
        ],
        stats: { score: 5, replyCount: 1, ignored: true },
        truncated: true,
      },
    }

    const inputLinks = value.thread.posts[0]?.links

    const decoded = decodeCapture(value)

    expect(decoded).toEqual({
      kind: 'thread',
      thread: {
        site: 'reddit',
        url: 'https://example.com/thread',
        title: 'Thread',
        author: { name: 'OP', handle: 'u/op' },
        createdAt: '2026-07-18T00:00:00.000Z',
        posts: [
          {
            id: 'post-1',
            author: { name: 'Reply', handle: 'u/reply' },
            createdAt: '2026-07-18T01:00:00.000Z',
            depth: 1,
            text: 'Hello',
            score: 4,
            parentId: 'root',
            byOp: false,
            media: [{ kind: 'image', url: 'https://example.com/image', alt: 'Image' }],
            links: ['https://example.com/link'],
          },
        ],
        stats: { score: 5, replyCount: 1 },
        truncated: true,
      },
    })
    if (decoded?.kind !== 'thread') throw new Error('expected decoded thread')
    expect(decoded.thread.posts[0]?.links).not.toBe(inputLinks)
  })

  it('decodes a complete playlist including transcript snapshots', () => {
    const value = {
      kind: 'playlist',
      playlist: {
        playlistId: 'PL123',
        url: 'https://example.com/playlist',
        title: 'Playlist',
        channel: 'Channel',
        videoCount: 1,
        videos: [
          {
            videoId: 'video-1',
            url: 'https://example.com/video-1',
            title: 'Video',
            channel: 'Channel',
            durationSeconds: 30,
            index: 1,
            hasCaptions: true,
            ignored: true,
          },
        ],
        transcriptDocs: [
          {
            videoId: 'video-1',
            url: 'https://example.com/video-1',
            title: 'Video',
            markdown: '# Video',
            ignored: true,
          },
        ],
        truncated: false,
        ignored: true,
      },
    }

    expect(decodeCapture(value)).toEqual({
      kind: 'playlist',
      playlist: {
        playlistId: 'PL123',
        url: 'https://example.com/playlist',
        title: 'Playlist',
        channel: 'Channel',
        videoCount: 1,
        videos: [
          {
            videoId: 'video-1',
            url: 'https://example.com/video-1',
            title: 'Video',
            channel: 'Channel',
            durationSeconds: 30,
            index: 1,
            hasCaptions: true,
          },
        ],
        transcriptDocs: [
          {
            videoId: 'video-1',
            url: 'https://example.com/video-1',
            title: 'Video',
            markdown: '# Video',
          },
        ],
        truncated: false,
      },
    })
  })

  it('decodes standalone video and web captures', () => {
    expect(
      decodeCapture({
        kind: 'video',
        video: {
          videoId: 'video-1',
          url: 'https://example.com/video-1',
          title: 'Video',
          channel: 'Channel',
          durationSeconds: 30,
          ignored: true,
        },
      }),
    ).toEqual({
      kind: 'video',
      video: {
        videoId: 'video-1',
        url: 'https://example.com/video-1',
        title: 'Video',
        channel: 'Channel',
        durationSeconds: 30,
      },
    })

    expect(
      decodeCapture({
        kind: 'web',
        web: {
          id: 'page:abc',
          url: 'https://example.com/page',
          title: 'Page',
          mode: 'page',
          text: 'Text',
          ignored: true,
        },
      }),
    ).toEqual({
      kind: 'web',
      web: {
        id: 'page:abc',
        url: 'https://example.com/page',
        title: 'Page',
        mode: 'page',
        text: 'Text',
      },
    })
  })

  it('rejects blank native capture identities', () => {
    expect(
      decodeCapture({
        kind: 'playlist',
        playlist: {
          playlistId: ' ',
          url: 'https://www.youtube.com/playlist?list=PL123',
          title: 'Playlist',
          videoCount: 0,
          videos: [],
        },
      }),
    ).toBeUndefined()
    expect(
      decodeCapture({
        kind: 'video',
        video: {
          videoId: '',
          url: 'https://www.youtube.com/watch?v=abcdefghijk',
          title: 'Video',
        },
      }),
    ).toBeUndefined()
    expect(
      decodeCapture({
        kind: 'thread',
        thread: {
          site: 'reddit',
          url: ' ',
          title: 'Thread',
          author: { name: 'OP' },
          posts: [],
        },
      }),
    ).toBeUndefined()
    expect(
      decodeCapture({
        kind: 'web',
        web: {
          id: '',
          url: 'https://example.com',
          title: 'Page',
          mode: 'page',
          text: 'Text',
        },
      }),
    ).toBeUndefined()
  })

  it('rejects invalid enums, malformed nested values, and non-finite optional numbers', () => {
    const validPost = {
      id: 'post-1',
      author: { name: 'Author' },
      depth: 0,
      text: 'Text',
      byOp: true,
    }
    const validThread = {
      site: 'x',
      url: 'not a url',
      title: 'Thread',
      author: { name: 'Author' },
      createdAt: 'not a date',
      posts: [validPost],
    }

    expect(decodeCapture({ kind: 'thread', thread: validThread })).toEqual({
      kind: 'thread',
      thread: validThread,
    })

    for (const value of [
      { kind: 'thread', thread: { ...validThread, site: 'other' } },
      { kind: 'thread', thread: { ...validThread, site: 'youtube' } },
      { kind: 'thread', thread: { ...validThread, site: 'web' } },
      { kind: 'thread', thread: { ...validThread, posts: [{ ...validPost, depth: -1 }] } },
      { kind: 'thread', thread: { ...validThread, posts: [{ ...validPost, depth: 0.5 }] } },
      {
        kind: 'thread',
        thread: {
          ...validThread,
          posts: [{ ...validPost, media: [{ kind: 'audio', url: 'x' }] }],
        },
      },
      { kind: 'thread', thread: { ...validThread, stats: { score: Infinity } } },
      { kind: 'thread', thread: { ...validThread, stats: { replyCount: 0.5 } } },
      {
        kind: 'playlist',
        playlist: {
          playlistId: 'PL1',
          url: 'url',
          title: 'Playlist',
          videoCount: 1,
          videos: [
            {
              videoId: 'video-1',
              url: 'url',
              title: 'Video',
              index: 1,
              durationSeconds: Number.NaN,
            },
          ],
        },
      },
      {
        kind: 'playlist',
        playlist: {
          playlistId: 'PL1',
          url: 'url',
          title: 'Playlist',
          videoCount: -1,
          videos: [],
        },
      },
      {
        kind: 'playlist',
        playlist: {
          playlistId: 'PL1',
          url: 'url',
          title: 'Playlist',
          videoCount: 1,
          videos: [{ videoId: 'video-1', url: 'url', title: 'Video', index: 0 }],
        },
      },
      {
        kind: 'video',
        video: { videoId: 'video-1', url: 'url', title: 'Video', durationSeconds: Infinity },
      },
      {
        kind: 'web',
        web: { id: 'id', url: 'url', title: 'Title', mode: 'fragment', text: 'Text' },
      },
    ]) {
      expect(decodeCapture(value)).toBeUndefined()
    }
  })

  it('rejects explicitly undefined optional capture fields', () => {
    const post = {
      id: 'post-1',
      author: { name: 'Author' },
      depth: 0,
      text: 'Text',
      byOp: true,
    }
    const thread = {
      site: 'x',
      url: 'url',
      title: 'Thread',
      author: { name: 'Author' },
      posts: [post],
    }
    const playlist = {
      playlistId: 'PL1',
      url: 'url',
      title: 'Playlist',
      videoCount: 1,
      videos: [{ videoId: 'video-1', url: 'url', title: 'Video', index: 1 }],
    }

    for (const value of [
      { kind: 'thread', thread: { ...thread, author: { name: 'Author', handle: undefined } } },
      { kind: 'thread', thread: { ...thread, createdAt: undefined } },
      { kind: 'thread', thread: { ...thread, stats: undefined } },
      { kind: 'thread', thread: { ...thread, stats: { replyCount: undefined } } },
      { kind: 'thread', thread: { ...thread, posts: [{ ...post, score: undefined }] } },
      { kind: 'thread', thread: { ...thread, posts: [{ ...post, media: undefined }] } },
      { kind: 'thread', thread: { ...thread, posts: [{ ...post, links: undefined }] } },
      {
        kind: 'thread',
        thread: {
          ...thread,
          posts: [{ ...post, media: [{ kind: 'image', url: 'url', alt: undefined }] }],
        },
      },
      { kind: 'playlist', playlist: { ...playlist, transcriptDocs: undefined } },
      {
        kind: 'playlist',
        playlist: {
          ...playlist,
          videos: [
            {
              videoId: 'video-1',
              url: 'url',
              title: 'Video',
              index: 1,
              hasCaptions: undefined,
            },
          ],
        },
      },
      {
        kind: 'video',
        video: { videoId: 'video-1', url: 'url', title: 'Video', durationSeconds: undefined },
      },
    ]) {
      expect(decodeCapture(value)).toBeUndefined()
    }
  })

  it('rejects inherited domain fields', () => {
    const inherited = Object.create({
      kind: 'web',
      web: { id: 'id', url: 'url', title: 'Title', mode: 'page', text: 'Text' },
    })
    expect(decodeCapture(inherited)).toBeUndefined()
  })
})

describe('decodeSourceDoc', () => {
  const base = {
    id: 'youtube:PL1',
    site: 'youtube',
    kind: 'playlist',
    title: 'Playlist',
    canonicalUrl: 'https://www.youtube.com/playlist?list=PL1',
    capturedAt: '2026-07-18T00:00:00.000Z',
    markdown: '# Playlist',
    jsonl: JSON.stringify({
      videoId: 'abcdefghijk',
      url: 'https://www.youtube.com/watch?v=abcdefghijk',
      title: 'One',
      index: 1,
    }),
    wordCount: 1,
    truncated: false,
  }

  it('decodes and clones a canonical playlist document', () => {
    const input = {
      ...base,
      playlistVideos: [{ videoId: 'abcdefghijk', url: 'url', title: 'One', index: 1 }],
    }
    const decoded = decodeSourceDoc(input)
    expect(decoded).toEqual(input)
    if (decoded?.kind !== 'playlist') throw new Error('expected playlist')
    expect(decoded).not.toBe(input)
    expect(decoded.playlistVideos).not.toBe(input.playlistVideos)
    expect(decoded.playlistVideos[0]).not.toBe(input.playlistVideos[0])
  })

  it('requires nonblank document identities and canonical capture timestamps', () => {
    const canonical = { ...base, playlistVideos: [] }

    expect(decodeSourceDoc({ ...canonical, id: ' ' })).toBeUndefined()
    expect(decodeSourceDoc({ ...canonical, canonicalUrl: ' ' })).toBeUndefined()
    expect(decodeSourceDoc({ ...canonical, capturedAt: '2026-07-18T00:00:00Z' })).toBeUndefined()
  })

  it('requires site-scoped ids that match canonical YouTube URLs', () => {
    const playlist = { ...base, playlistVideos: [] }
    const video = {
      ...base,
      id: 'youtube:abcdefghijk',
      kind: 'video',
      canonicalUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
    }

    expect(decodeSourceDoc({ ...playlist, id: 'reddit:PL1' })).toBeUndefined()
    expect(decodeSourceDoc({ ...playlist, id: 'youtube:' })).toBeUndefined()
    expect(decodeSourceDoc({ ...playlist, id: 'youtube:PL2' })).toBeUndefined()
    expect(
      decodeSourceDoc({
        ...playlist,
        id: 'youtube:RDabcdefghijk',
        canonicalUrl: 'https://www.youtube.com/watch?v=abcdefghijk&list=RDabcdefghijk',
      }),
    ).toMatchObject({ id: 'youtube:RDabcdefghijk', kind: 'playlist' })
    expect(decodeSourceDoc(video)).toMatchObject({ id: 'youtube:abcdefghijk', kind: 'video' })
    expect(decodeSourceDoc({ ...video, id: 'youtube:other' })).toBeUndefined()
  })

  it('rejects mismatched source kind and site pairs', () => {
    const common = {
      id: 'source:one',
      title: 'Source',
      canonicalUrl: 'https://example.com',
      capturedAt: '2026-07-18T00:00:00.000Z',
      markdown: '# Source',
      wordCount: 1,
      truncated: false,
    }

    expect(decodeSourceDoc({ ...common, kind: 'thread', site: 'youtube' })).toBeUndefined()
    expect(decodeSourceDoc({ ...common, kind: 'thread', site: 'web' })).toBeUndefined()
    expect(decodeSourceDoc({ ...common, kind: 'video', site: 'reddit' })).toBeUndefined()
    expect(decodeSourceDoc({ ...common, kind: 'web', site: 'x' })).toBeUndefined()
  })

  it('migrates only complete legacy playlist JSONL and preserves valid siblings', () => {
    const thread = {
      id: 'reddit:one',
      site: 'reddit',
      kind: 'thread',
      title: 'Thread',
      canonicalUrl: 'https://example.com',
      capturedAt: '2026-07-18T00:00:00.000Z',
      markdown: '# Thread',
      wordCount: 1,
      truncated: false,
    }
    const migrated = decodeStoredSourceDocs([thread, base])
    expect(migrated).toHaveLength(2)
    expect(migrated?.[1]).toMatchObject({
      kind: 'playlist',
      playlistVideos: [{ videoId: 'abcdefghijk' }],
    })
  })

  it('excludes malformed legacy playlists without losing valid siblings', () => {
    const thread = {
      id: 'reddit:one',
      site: 'reddit',
      kind: 'thread',
      title: 'Thread',
      canonicalUrl: 'https://example.com',
      capturedAt: '2026-07-18T00:00:00.000Z',
      markdown: '# Thread',
      wordCount: 1,
      truncated: false,
    }
    expect(decodeStoredSourceDocs([thread, { ...base, jsonl: '{"videoId":"partial"}' }])).toEqual([
      thread,
    ])
  })

  it('rejects blank video identities in canonical and legacy playlist storage', () => {
    const thread = {
      id: 'reddit:one',
      site: 'reddit',
      kind: 'thread',
      title: 'Thread',
      canonicalUrl: 'https://example.com',
      capturedAt: '2026-07-18T00:00:00.000Z',
      markdown: '# Thread',
      wordCount: 1,
      truncated: false,
    }
    const blankVideo = { videoId: '', url: 'url', title: 'One', index: 1 }

    expect(decodeSourceDoc({ ...base, playlistVideos: [blankVideo] })).toBeUndefined()
    expect(
      decodeStoredSourceDocs([thread, { ...base, jsonl: JSON.stringify(blankVideo) }]),
    ).toEqual([thread])
  })

  it('keeps the newest duplicate and returns documents newest-first', () => {
    const old = {
      id: 'reddit:one',
      site: 'reddit',
      kind: 'thread',
      title: 'Old',
      canonicalUrl: 'https://example.com/old',
      capturedAt: '2026-07-17T00:00:00.000Z',
      markdown: '# Old',
      wordCount: 1,
      truncated: false,
    }
    const newest = {
      ...old,
      title: 'Newest',
      canonicalUrl: 'https://example.com/newest',
      capturedAt: '2026-07-19T00:00:00.000Z',
      markdown: '# Newest',
    }
    const middle = {
      ...old,
      id: 'hackernews:two',
      site: 'hackernews',
      capturedAt: '2026-07-18T00:00:00.000Z',
    }

    expect(decodeStoredSourceDocs([old, newest, middle])).toEqual([newest, middle])
  })

  it('rejects inherited fields and explicit undefined optionals', () => {
    const inherited = Object.create({ ...base, playlistVideos: [] })
    expect(decodeSourceDoc(inherited)).toBeUndefined()
    expect(decodeSourceDoc({ ...base, playlistVideos: [], jsonl: undefined })).toBeUndefined()
  })
})
