import { describe, expect, it } from 'vitest'
import type { SourceDoc } from '../model/types'
import { diffAgainstLedger, recordSynced } from '../store/ledger'
import { contentHashForIngest, planIngestUnits } from './units'

function makeDoc(overrides: Partial<SourceDoc> & Pick<SourceDoc, 'id'>): SourceDoc {
  return {
    site: 'youtube',
    kind: 'playlist',
    title: 'Playlist',
    canonicalUrl: 'https://www.youtube.com/playlist?list=PL123',
    capturedAt: '2026-07-11T00:00:00.000Z',
    markdown: '',
    wordCount: 1,
    truncated: false,
    ...overrides,
  }
}

describe('planIngestUnits', () => {
  it('keeps a thread as one text unit', () => {
    const doc = makeDoc({
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
    const doc = makeDoc({
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
    const doc = makeDoc({
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

  it('plans the playlist overview before first-seen canonical video URLs', () => {
    const doc = makeDoc({
      id: 'youtube:PL123',
      markdown: '# Overview',
      jsonl: [
        JSON.stringify({ url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa&list=PL123' }),
        JSON.stringify({ url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb' }),
        JSON.stringify({ url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' }),
      ].join('\n'),
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

  it('falls back to Markdown when JSONL contains no valid YouTube URL rows', () => {
    const doc = makeDoc({
      id: 'youtube:PL123',
      markdown: 'https://www.youtube.com/watch?v=ccccccccccc',
      jsonl: ['{not-json}', JSON.stringify({ url: 'https://example.com/not-a-video' })].join('\n'),
    })

    expect(planIngestUnits(doc)).toMatchObject([
      { kind: 'text', id: 'youtube:PL123:toc' },
      { kind: 'youtube', id: 'youtube:ccccccccccc' },
    ])
  })

  it('uses a video-scoped identity shared by different playlists', () => {
    const first = makeDoc({
      id: 'youtube:PL1',
      markdown: 'https://www.youtube.com/watch?v=ddddddddddd',
    })
    const second = makeDoc({
      id: 'youtube:PL2',
      markdown: 'https://www.youtube.com/watch?v=ddddddddddd',
    })

    expect(planIngestUnits(first)[1]?.id).toBe('youtube:ddddddddddd')
    expect(planIngestUnits(second)[1]?.id).toBe('youtube:ddddddddddd')
  })

  it('prefers an immutable transcript snapshot without changing the video receipt identity', () => {
    const doc = makeDoc({
      id: 'youtube:PL123',
      markdown: 'https://www.youtube.com/watch?v=eeeeeeeeeee',
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
    const urlOnly = makeDoc({
      id: 'youtube:PL123',
      markdown: 'https://www.youtube.com/watch?v=iiiiiiiiiii',
    })
    const withTranscript = makeDoc({
      id: 'youtube:PL123',
      markdown: 'https://www.youtube.com/watch?v=iiiiiiiiiii',
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

    const ledger = recordSynced({}, 'notebook-1', [
      {
        id: urlUnit.id,
        contentHash: urlUnit.contentHash,
        now: '2026-07-11T00:00:00.000Z',
      },
    ])

    expect(
      diffAgainstLedger(ledger, 'notebook-1', [
        { id: transcriptUnit.id, contentHash: transcriptUnit.contentHash },
      ]),
    ).toEqual({ fresh: [], changed: [], unchanged: ['youtube:iiiiiiiiiii'] })
  })

  it('falls back to the YouTube URL when a playlist video has no transcript snapshot', () => {
    const doc = makeDoc({
      id: 'youtube:PL123',
      markdown: [
        'https://www.youtube.com/watch?v=fffffffffff',
        'https://www.youtube.com/watch?v=ggggggggggg',
      ].join('\n'),
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
