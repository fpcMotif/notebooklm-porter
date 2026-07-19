import { describe, expect, it } from 'vitest'
import type { IngestUnit } from '../units'
import type { NotebookSource, SourceKind, SourceLoadStatus } from './model'
import { reconcileUnits } from './reconcile'

function source(id: string, over: Partial<Omit<NotebookSource, 'id'>> = {}): NotebookSource {
  const kind: SourceKind = over.kind ?? 'web_page'
  const status: SourceLoadStatus = over.status ?? 'ready'
  return {
    id,
    title: over.title ?? `Source ${id}`,
    kind,
    status,
    ...(over.url !== undefined ? { url: over.url } : {}),
    ...(over.createdAt !== undefined ? { createdAt: over.createdAt } : {}),
  }
}

function youtubeUnit(videoId: string): IngestUnit {
  return {
    kind: 'youtube',
    docId: `youtube:${videoId}`,
    id: `youtube:${videoId}`,
    contentHash: `hash-${videoId}`,
    url: `https://www.youtube.com/watch?v=${videoId}`,
  }
}

/** A playlist video captured with a transcript — pasted text, video identity. */
function transcriptUnit(videoId: string): IngestUnit {
  return {
    kind: 'text',
    docId: 'youtube:PL123',
    id: `youtube:${videoId}`,
    contentHash: `hash-${videoId}`,
    title: `Transcript ${videoId}`,
    markdown: `# Transcript ${videoId}`,
  }
}

function tocUnit(): IngestUnit {
  return {
    kind: 'text',
    docId: 'youtube:PL123',
    id: 'youtube:PL123:toc',
    contentHash: 'hash-toc',
    title: 'Playlist overview',
    markdown: '# Playlist overview',
  }
}

function threadUnit(): IngestUnit {
  return {
    kind: 'text',
    docId: 'reddit:abc',
    id: 'reddit:abc',
    contentHash: 'hash-thread',
    title: 'A thread',
    markdown: '# A thread',
  }
}

describe('reconcileUnits', () => {
  it('matches a youtube unit against any YouTube URL form server-side', () => {
    const unit = youtubeUnit('dQw4w9WgXcQ')
    for (const url of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc&utm_source=share',
    ]) {
      const server = source('s1', { kind: 'youtube', url })
      const result = reconcileUnits([unit], [server])
      expect(result.absent).toEqual([])
      expect(result.present).toEqual([{ unit, source: server, errored: false }])
    }
  })

  it('suppresses a transcript unit when the notebook already links that video', () => {
    const unit = transcriptUnit('dQw4w9WgXcQ')
    const server = source('s1', {
      kind: 'youtube',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    })
    const result = reconcileUnits([unit], [server])
    expect(result.present).toEqual([{ unit, source: server, errored: false }])
    expect(result.absent).toEqual([])
  })

  it('never server-matches URL-less text units, even on equal titles', () => {
    const toc = tocUnit()
    const thread = threadUnit()
    const sources = [
      source('s1', { kind: 'youtube', url: 'https://youtu.be/dQw4w9WgXcQ' }),
      source('s2', { kind: 'pasted_text', title: 'A thread' }),
      source('s3', { kind: 'pasted_text', title: 'Playlist overview' }),
    ]
    expect(reconcileUnits([toc, thread], sources)).toEqual({
      present: [],
      absent: [toc, thread],
    })
  })

  it('counts an errored server row as present and flags it for telemetry', () => {
    const unit = youtubeUnit('dQw4w9WgXcQ')
    const server = source('s1', {
      kind: 'youtube',
      status: 'error',
      url: 'https://youtu.be/dQw4w9WgXcQ',
    })
    expect(reconcileUnits([unit], [server])).toEqual({
      present: [{ unit, source: server, errored: true }],
      absent: [],
    })
  })

  it('matches the usable row when the notebook holds duplicate copies', () => {
    const unit = youtubeUnit('dQw4w9WgXcQ')
    const broken = source('broken', {
      kind: 'youtube',
      status: 'error',
      url: 'https://youtu.be/dQw4w9WgXcQ',
    })
    const ready = source('ready', {
      kind: 'youtube',
      status: 'ready',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    })
    expect(reconcileUnits([unit], [broken, ready])).toEqual({
      present: [{ unit, source: ready, errored: false }],
      absent: [],
    })
  })

  it('leaves units absent when no server source shares their identity', () => {
    const unit = youtubeUnit('dQw4w9WgXcQ')
    const sources = [
      source('s1', { kind: 'youtube', url: 'https://youtu.be/ooooooooooo' }),
      source('s2', { kind: 'web_page', url: 'https://example.com/article' }),
    ]
    expect(reconcileUnits([unit], sources)).toEqual({ present: [], absent: [unit] })
  })

  it('preserves input order within both buckets for mixed batches', () => {
    const presentA = youtubeUnit('aaaaaaaaaaa')
    const absentToc = tocUnit()
    const presentB = transcriptUnit('bbbbbbbbbbb')
    const absentVideo = youtubeUnit('ccccccccccc')
    const serverA = source('sa', { kind: 'youtube', url: 'https://youtu.be/aaaaaaaaaaa' })
    const serverB = source('sb', { kind: 'youtube', url: 'https://youtu.be/bbbbbbbbbbb' })
    expect(
      reconcileUnits([presentA, absentToc, presentB, absentVideo], [serverA, serverB]),
    ).toEqual({
      present: [
        { unit: presentA, source: serverA, errored: false },
        { unit: presentB, source: serverB, errored: false },
      ],
      absent: [absentToc, absentVideo],
    })
  })

  it('treats an empty notebook as entirely absent and empty input as a no-op', () => {
    const unit = youtubeUnit('dQw4w9WgXcQ')
    expect(reconcileUnits([unit], [])).toEqual({ present: [], absent: [unit] })
    expect(reconcileUnits([], [source('s1')])).toEqual({ present: [], absent: [] })
  })
})
