import { describe, expect, it } from 'vitest'
import type { NotebookTarget } from '../accounts/ownership'
import type {
  PlaylistSourceDoc,
  ThreadSourceDoc,
  VideoSourceDoc,
  WebSourceDoc,
} from '../model/types'
import { diffAgainstLedger, recordSynced } from '../store/ledger'
import { contentHashForIngest, planIngestUnits } from './units'

const target: NotebookTarget = {
  authuser: 0,
  accountEmail: 'user@example.com',
  notebookId: 'notebook-1',
}

function makePlaylistDoc(
  overrides: Partial<PlaylistSourceDoc> & Pick<PlaylistSourceDoc, 'id'>,
): PlaylistSourceDoc {
  return {
    site: 'youtube',
    kind: 'playlist',
    title: 'Playlist',
    canonicalUrl: 'https://www.youtube.com/playlist?list=PL123',
    capturedAt: '2026-07-11T00:00:00.000Z',
    markdown: '',
    playlistVideos: [],
    wordCount: 1,
    truncated: false,
    ...overrides,
  }
}

function makeThreadDoc(
  overrides: Partial<ThreadSourceDoc> & Pick<ThreadSourceDoc, 'id'>,
): ThreadSourceDoc {
  return {
    site: 'reddit',
    kind: 'thread',
    title: 'Playlist',
    canonicalUrl: 'https://example.com/source',
    capturedAt: '2026-07-11T00:00:00.000Z',
    markdown: '',
    wordCount: 1,
    truncated: false,
    ...overrides,
  }
}

function makeWebDoc(overrides: Partial<WebSourceDoc> & Pick<WebSourceDoc, 'id'>): WebSourceDoc {
  return {
    site: 'web',
    kind: 'web',
    title: 'Playlist',
    canonicalUrl: 'https://example.com/source',
    capturedAt: '2026-07-11T00:00:00.000Z',
    markdown: '',
    wordCount: 1,
    truncated: false,
    ...overrides,
  }
}

function makeVideoDoc(
  overrides: Partial<VideoSourceDoc> & Pick<VideoSourceDoc, 'id'>,
): VideoSourceDoc {
  return {
    site: 'youtube',
    kind: 'video',
    title: 'Playlist',
    canonicalUrl: 'https://www.youtube.com/watch?v=abcdefghijk',
    capturedAt: '2026-07-11T00:00:00.000Z',
    markdown: '',
    wordCount: 1,
    truncated: false,
    ...overrides,
  }
}

describe('planIngestUnits', () => {
  it('keeps a thread as one text unit', () => {
    const doc = makeThreadDoc({
      id: 'reddit:abc',
      site: 'reddit',
      kind: 'thread',
      markdown: '# Thread',
    })

    expect(planIngestUnits(doc)).toMatchObject([
      {
        kind: 'text',
        docId: 'reddit:abc',
        id: 'reddit:abc',
        title: 'Playlist',
        markdown: '# Thread',
      },
    ])
  })

  it('keeps a generic web capture as one text unit', () => {
    const doc = makeWebDoc({
      id: 'web:selection:abc',
      site: 'web',
      kind: 'web',
      markdown: '# Selected text',
    })

    expect(planIngestUnits(doc)).toMatchObject([
      {
        kind: 'text',
        docId: 'web:selection:abc',
        id: 'web:selection:abc',
        markdown: '# Selected text',
      },
    ])
  })

  it('plans a standalone video as the same URL receipt a playlist would use', () => {
    const doc = makeVideoDoc({
      id: 'youtube:hhhhhhhhhhh',
      kind: 'video',
      canonicalUrl: 'https://www.youtube.com/watch?v=hhhhhhhhhhh',
      markdown: '# One video',
    })

    expect(planIngestUnits(doc)).toMatchObject([
      {
        kind: 'youtube',
        docId: 'youtube:hhhhhhhhhhh',
        id: 'youtube:hhhhhhhhhhh',
        url: 'https://www.youtube.com/watch?v=hhhhhhhhhhh',
      },
    ])
  })

  it('drops malformed or noncanonical standalone YouTube URLs without throwing', () => {
    for (const canonicalUrl of [
      'not a URL',
      'https://www.youtube.com/watch?v=abcdefghijk&list=PL123',
      'https://www.youtube.com/embed/abcdefghijk',
      'https://www.youtube.com/watch?v=+',
    ]) {
      const doc = makeVideoDoc({ id: 'youtube:bad', canonicalUrl })
      expect(() => planIngestUnits(doc)).not.toThrow()
      expect(planIngestUnits(doc)).toEqual([])
    }
  })

  it('plans the playlist overview before first-seen canonical video URLs', () => {
    const doc = makePlaylistDoc({
      id: 'youtube:PL123',
      markdown: '# Overview',
      playlistVideos: [
        { videoId: 'aaaaaaaaaaa', url: 'stale', title: 'A', index: 1 },
        { videoId: 'bbbbbbbbbbb', url: 'wrong', title: 'B', index: 2 },
        { videoId: 'aaaaaaaaaaa', url: 'duplicate', title: 'A again', index: 3 },
      ],
    })

    expect(planIngestUnits(doc)).toMatchObject([
      { kind: 'text', id: 'youtube:PL123:toc', markdown: '# Overview' },
      {
        kind: 'youtube',
        id: 'youtube:aaaaaaaaaaa',
        url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
      },
      {
        kind: 'youtube',
        id: 'youtube:bbbbbbbbbbb',
        url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb',
      },
    ])
  })

  it('encodes opaque video IDs instead of letting them add query parameters', () => {
    const doc = makePlaylistDoc({
      id: 'youtube:PL123',
      playlistVideos: [{ videoId: 'x&list=foreign', url: 'ignored', title: 'Opaque ID', index: 1 }],
    })

    expect(planIngestUnits(doc)[1]).toMatchObject({
      id: 'youtube:x&list=foreign',
      url: 'https://www.youtube.com/watch?v=x%26list%3Dforeign',
    })
  })

  it('skips blank playlist ids but keeps opaque ids query-encoded', () => {
    const doc = makePlaylistDoc({
      id: 'youtube:PL123',
      playlistVideos: [
        { videoId: ' ', url: 'ignored', title: 'Impossible', index: 1 },
        { videoId: 'x&list=foreign', url: 'ignored', title: 'Opaque', index: 2 },
      ],
    })

    expect(planIngestUnits(doc)).toMatchObject([
      { kind: 'text', id: 'youtube:PL123:toc' },
      {
        kind: 'youtube',
        id: 'youtube:x&list=foreign',
        url: 'https://www.youtube.com/watch?v=x%26list%3Dforeign',
      },
    ])
  })

  it('ignores absent, malformed, stale, and extra JSONL because the typed inventory wins', () => {
    const doc = makePlaylistDoc({
      id: 'youtube:PL123',
      markdown: 'https://www.youtube.com/watch?v=ccccccccccc',
      jsonl: [
        '{not-json}',
        JSON.stringify({ videoId: 'stale' }),
        JSON.stringify({ videoId: 'extra' }),
      ].join('\n'),
      playlistVideos: [{ videoId: 'ddddddddddd', url: 'ignored', title: 'Inventory', index: 1 }],
    })

    expect(planIngestUnits(doc)).toMatchObject([
      { kind: 'text', id: 'youtube:PL123:toc' },
      {
        kind: 'youtube',
        id: 'youtube:ddddddddddd',
        url: 'https://www.youtube.com/watch?v=ddddddddddd',
      },
    ])
  })

  it('uses a video-scoped identity shared by different playlists', () => {
    const first = makePlaylistDoc({
      id: 'youtube:PL1',
      playlistVideos: [{ videoId: 'ddddddddddd', url: 'ignored', title: 'Shared', index: 1 }],
    })
    const second = makePlaylistDoc({
      id: 'youtube:PL2',
      playlistVideos: [{ videoId: 'ddddddddddd', url: 'ignored', title: 'Shared', index: 1 }],
    })

    expect(planIngestUnits(first)[1]?.id).toBe('youtube:ddddddddddd')
    expect(planIngestUnits(second)[1]?.id).toBe('youtube:ddddddddddd')
  })

  it('prefers an immutable transcript snapshot without changing the video receipt identity', () => {
    const doc = makePlaylistDoc({
      id: 'youtube:PL123',
      playlistVideos: [
        { videoId: 'eeeeeeeeeee', url: 'ignored', title: 'Enriched video', index: 1 },
      ],
      videoDocs: [
        {
          videoId: 'eeeeeeeeeee',
          url: 'https://www.youtube.com/watch?v=eeeeeeeeeee',
          title: 'Enriched video',
          markdown: '# Enriched video\n\nTranscript text',
        },
      ],
    })

    expect(planIngestUnits(doc)).toMatchObject([
      { kind: 'text', id: 'youtube:PL123:toc' },
      {
        kind: 'text',
        id: 'youtube:eeeeeeeeeee',
        title: 'Enriched video',
        markdown: '# Enriched video\n\nTranscript text',
      },
    ])
  })

  it('does not treat a later transcript upgrade as a new YouTube source', () => {
    const urlOnly = makePlaylistDoc({
      id: 'youtube:PL123',
      playlistVideos: [
        { videoId: 'iiiiiiiiiii', url: 'ignored', title: 'Enriched video', index: 1 },
      ],
    })
    const withTranscript = makePlaylistDoc({
      id: 'youtube:PL123',
      playlistVideos: [
        { videoId: 'iiiiiiiiiii', url: 'ignored', title: 'Enriched video', index: 1 },
      ],
      videoDocs: [
        {
          videoId: 'iiiiiiiiiii',
          url: 'https://www.youtube.com/watch?v=iiiiiiiiiii',
          title: 'Enriched video',
          markdown: '# Enriched video\n\nTranscript text',
        },
      ],
    })

    const urlUnit = planIngestUnits(urlOnly)[1]
    const transcriptUnit = planIngestUnits(withTranscript)[1]
    if (urlUnit === undefined || transcriptUnit === undefined) {
      throw new Error('Expected a video unit for both playlist captures')
    }

    expect(transcriptUnit.id).toBe(urlUnit.id)
    expect(transcriptUnit.contentHash).toBe(urlUnit.contentHash)

    const ledger = recordSynced({}, target, [
      {
        id: urlUnit.id,
        contentHash: urlUnit.contentHash,
        now: '2026-07-11T00:00:00.000Z',
      },
    ])

    expect(
      diffAgainstLedger(ledger, target, [
        { id: transcriptUnit.id, contentHash: transcriptUnit.contentHash },
      ]),
    ).toEqual({ fresh: [], changed: [], unchanged: ['youtube:iiiiiiiiiii'] })
  })

  it('falls back to the YouTube URL when a playlist video has no transcript snapshot', () => {
    const doc = makePlaylistDoc({
      id: 'youtube:PL123',
      playlistVideos: [
        { videoId: 'fffffffffff', url: 'ignored', title: 'Captured transcript', index: 1 },
        { videoId: 'ggggggggggg', url: 'ignored', title: 'URL only', index: 2 },
      ],
      videoDocs: [
        {
          videoId: 'fffffffffff',
          url: 'https://www.youtube.com/watch?v=fffffffffff',
          title: 'Captured transcript',
          markdown: '# Captured transcript',
        },
      ],
    })

    expect(planIngestUnits(doc)).toMatchObject([
      { kind: 'text', id: 'youtube:PL123:toc' },
      { kind: 'text', id: 'youtube:fffffffffff' },
      {
        kind: 'youtube',
        id: 'youtube:ggggggggggg',
        url: 'https://www.youtube.com/watch?v=ggggggggggg',
      },
    ])
  })

  it('does not treat only captured_at frontmatter as a changed ingest source', () => {
    const first = `---
source: web
captured_at: 2026-07-11T00:00:00.000Z
---

# Article

Body`
    const later = `---
source: web
captured_at: 2026-07-12T00:00:00.000Z
---

# Article

Body`

    expect(contentHashForIngest(first)).toBe(contentHashForIngest(later))
    expect(contentHashForIngest(`${later}\nChanged`)).not.toBe(contentHashForIngest(later))
  })
})

// Characterisation: hex values below were computed by running
// contentHashForIngest against the pre-refactor implementation (the
// frontmatter scan inlined in units.ts, before it moved to the shared
// frontmatter.ts module). A changed hash here means resync would silently
// re-ingest every existing ledgered source, so these are hard-pinned.
describe('contentHashForIngest — frozen pre-refactor characterisation', () => {
  const withFrontmatterAndCapturedAt = `---
source: web
url: https://example.com
captured_at: 2026-07-11T00:00:00.000Z
---

# Title

Body text here.`

  const noFrontmatter = `# Just a body

No frontmatter at all.`

  const frontmatterWithoutCapturedAt = `---
source: web
url: https://example.com
---

# Title

Body text here.`

  const sameDocDifferentCapturedAt = `---
source: web
url: https://example.com
captured_at: 2026-07-12T00:00:00.000Z
---

# Title

Body text here.`

  it('hashes markdown with frontmatter including a captured_at line', () => {
    expect(contentHashForIngest(withFrontmatterAndCapturedAt)).toBe('76ce68c7')
  })

  it('hashes markdown with no frontmatter at all', () => {
    expect(contentHashForIngest(noFrontmatter)).toBe('d045f390')
  })

  it('hashes frontmatter that never had a captured_at line the same as one with it stripped', () => {
    expect(contentHashForIngest(frontmatterWithoutCapturedAt)).toBe('76ce68c7')
  })

  it('hashes the same doc identically regardless of captured_at value', () => {
    expect(contentHashForIngest(sameDocDifferentCapturedAt)).toBe('76ce68c7')
    expect(contentHashForIngest(sameDocDifferentCapturedAt)).toBe(
      contentHashForIngest(withFrontmatterAndCapturedAt),
    )
  })
})
