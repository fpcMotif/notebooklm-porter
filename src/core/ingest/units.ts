import { CAPTURED_AT_KEY, splitFrontmatter } from '../format/frontmatter'
import type { SourceDoc, TranscriptDocument } from '../model/types'
import { contentHash } from '../store/ledger'

const YOUTUBE_WATCH_URL_RE = /https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})/g

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

function videoUrlsFromJsonl(jsonl: string): string[] {
  const urls: string[] = []
  for (const line of jsonl.split('\n')) {
    if (line.trim().length === 0) continue
    try {
      const parsed = JSON.parse(line) as { url?: unknown }
      if (typeof parsed.url === 'string') urls.push(parsed.url)
    } catch {
      // A malformed row is ignored. The Markdown fallback below is only used
      // when no valid structured video URL was recovered at all.
    }
  }
  return urls
}

function canonicalYoutubeUrls(urls: string[]): string[] {
  const seen = new Set<string>()
  const canonical: string[] = []

  for (const url of urls) {
    const match = YOUTUBE_WATCH_URL_RE.exec(url)
    YOUTUBE_WATCH_URL_RE.lastIndex = 0
    const videoId = match?.[1]
    if (videoId === undefined || seen.has(videoId)) continue
    seen.add(videoId)
    canonical.push(`https://www.youtube.com/watch?v=${videoId}`)
  }

  return canonical
}

function videoUrlsForDoc(doc: SourceDoc): string[] {
  const jsonlUrls = doc.jsonl === undefined ? [] : videoUrlsFromJsonl(doc.jsonl)
  const structured = canonicalYoutubeUrls(jsonlUrls)
  if (structured.length > 0) return structured

  const urls = doc.markdown.match(YOUTUBE_WATCH_URL_RE) ?? []
  YOUTUBE_WATCH_URL_RE.lastIndex = 0
  return canonicalYoutubeUrls(urls)
}

function videoIdFromUrl(url: string): string {
  const match = YOUTUBE_WATCH_URL_RE.exec(url)
  YOUTUBE_WATCH_URL_RE.lastIndex = 0
  if (match?.[1] === undefined) throw new Error(`Expected canonical YouTube URL: ${url}`)
  return match[1]
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
  const split = splitFrontmatter(markdown)
  if (split === undefined) return contentHash(markdown)
  const stableFrontmatter = split.frontmatterLines.filter(
    (line) => !line.startsWith(`${CAPTURED_AT_KEY}: `),
  )
  return contentHash(`${stableFrontmatter.join('\n')}\n---${split.body}`)
}

function transcriptDocsByVideoId(doc: SourceDoc): Map<string, TranscriptDocument> {
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
    const videoId = videoIdFromUrl(doc.canonicalUrl)
    const url = `https://www.youtube.com/watch?v=${videoId}`
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
  const videos = videoUrlsForDoc(doc).map((url) => {
    const videoId = videoIdFromUrl(url)
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
  })

  return [overview, ...videos]
}
