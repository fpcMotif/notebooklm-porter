import type { PlaylistSourceDoc, SourceDoc, TranscriptDocument } from '../model/types'
import { contentHash } from '../store/ledger'

export type IngestUnit =
  | {
      kind: 'text'
      docId: string
      id: string
      contentHash: string
      title: string
      markdown: string
    }
  | {
      kind: 'youtube'
      docId: string
      id: string
      contentHash: string
      url: string
    }

type CanonicalYoutubeVideo = Readonly<{ videoId: string; url: string }>

function canonicalYoutubeVideos(videoIds: readonly string[]): CanonicalYoutubeVideo[] {
  const seen = new Set<string>()
  const canonical: CanonicalYoutubeVideo[] = []

  for (const videoId of videoIds) {
    if (videoId.trim() === '' || seen.has(videoId)) continue
    seen.add(videoId)
    canonical.push({ videoId, url: canonicalYoutubeWatchUrl(videoId) })
  }

  return canonical
}

/** Treats a captured video id as opaque data, never as query syntax. */
export function canonicalYoutubeWatchUrl(videoId: string): string {
  const url = new URL('https://www.youtube.com/watch')
  url.searchParams.set('v', videoId)
  return url.toString()
}

function videoIdFromCanonicalYoutubeUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    const videoId = parsed.searchParams.get('v')
    if (!videoId || videoId.trim() === '' || canonicalYoutubeWatchUrl(videoId) !== url)
      return undefined
    return videoId
  } catch {
    return undefined
  }
}

/**
 * NotebookLM sources are append-only, so a receipt identifies the canonical
 * video rather than a URL or transcript representation captured at one time.
 */
function youtubeReceiptHash(url: string): string {
  return contentHash(url)
}

/**
 * Capture timestamps describe when Porter fetched a source, not whether its
 * content changed. Excluding just that frontmatter field keeps resync receipts
 * stable while preserving all user-visible Markdown exactly as captured.
 */
export function contentHashForIngest(markdown: string): string {
  if (!markdown.startsWith('---\n')) return contentHash(markdown)
  const frontmatterEnd = markdown.indexOf('\n---', 4)
  if (frontmatterEnd === -1) return contentHash(markdown)
  const frontmatter = markdown.slice(0, frontmatterEnd).split('\n')
  const stableFrontmatter = frontmatter.filter((line) => !line.startsWith('captured_at: '))
  return contentHash(`${stableFrontmatter.join('\n')}${markdown.slice(frontmatterEnd)}`)
}

function transcriptDocsByVideoId(doc: PlaylistSourceDoc): Map<string, TranscriptDocument> {
  const transcripts = new Map<string, TranscriptDocument>()
  for (const transcript of doc.videoDocs ?? []) {
    // First snapshot wins; a capture only produces one snapshot per video.
    if (!transcripts.has(transcript.videoId)) transcripts.set(transcript.videoId, transcript)
  }
  return transcripts
}

/**
 * Converts a captured document into independently receiptable NotebookLM
 * mutations. The captured SourceDoc stays the user-facing aggregate; these
 * units are the idempotency and future queue boundary.
 */
export function planIngestUnits(doc: SourceDoc): IngestUnit[] {
  if (doc.kind === 'video') {
    const videoId = videoIdFromCanonicalYoutubeUrl(doc.canonicalUrl)
    if (videoId === undefined) return []
    const url = canonicalYoutubeWatchUrl(videoId)
    return [
      {
        kind: 'youtube',
        docId: doc.id,
        id: `youtube:${videoId}`,
        contentHash: youtubeReceiptHash(url),
        url,
      },
    ]
  }

  if (doc.kind !== 'playlist') {
    return [
      {
        kind: 'text',
        docId: doc.id,
        id: doc.id,
        contentHash: contentHashForIngest(doc.markdown),
        title: doc.title,
        markdown: doc.markdown,
      },
    ]
  }

  const overview: IngestUnit = {
    kind: 'text',
    docId: doc.id,
    id: `${doc.id}:toc`,
    contentHash: contentHashForIngest(doc.markdown),
    title: doc.title,
    markdown: doc.markdown,
  }

  const transcripts = transcriptDocsByVideoId(doc)
  const videos = canonicalYoutubeVideos(doc.playlistVideos.map((video) => video.videoId)).map(
    ({ videoId, url }) => {
      const transcript = transcripts.get(videoId)
      if (transcript !== undefined) {
        return {
          kind: 'text' as const,
          docId: doc.id,
          id: `youtube:${videoId}`,
          contentHash: youtubeReceiptHash(url),
          title: transcript.title,
          markdown: transcript.markdown,
        }
      }

      return {
        kind: 'youtube' as const,
        docId: doc.id,
        id: `youtube:${videoId}`,
        contentHash: youtubeReceiptHash(url),
        url,
      }
    },
  )

  return [overview, ...videos]
}
