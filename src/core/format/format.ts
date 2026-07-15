import type { Capture, SourceDoc } from '../model/types'
import { splitFrontmatter } from './frontmatter'
import { playlistToJsonl, threadToJsonl } from './jsonl'
import { playlistToMarkdown, threadToMarkdown } from './markdown'
import type { FormatOptions } from './types'
import { videoToMarkdown } from './video'
import { webToMarkdown } from './web'

/**
 * Extracts the root post id from a thread permalink so SourceDoc.id can be
 * `${site}:${nativeId}`. Falls back to the full URL when no id-shaped
 * segment is found (keeps formatCapture total rather than throwing on an
 * unexpected URL shape).
 *
 * Handles: Reddit `/r/<sub>/comments/<id>/...`, HN `?id=<id>`, X
 * `/<handle>/status/<id>`.
 */
function threadNativeId(url: string): string {
  const commentsMatch = url.match(/\/comments\/([a-zA-Z0-9_]+)/)
  if (commentsMatch?.[1]) return commentsMatch[1]

  const statusMatch = url.match(/\/status\/(\d+)/)
  if (statusMatch?.[1]) return statusMatch[1]

  try {
    const parsed = new URL(url)
    const idParam = parsed.searchParams.get('id')
    if (idParam) return idParam
  } catch {
    // Not a parseable absolute URL — fall through to the raw-url fallback.
  }

  return url
}

/** Word count of the markdown BODY, excluding the leading YAML frontmatter block. */
export function countBodyWords(markdown: string): number {
  const body = splitFrontmatter(markdown)?.body ?? markdown
  const words = body.trim().match(/\S+/g)
  return words ? words.length : 0
}

/**
 * Render a Capture into its stored SourceDoc (markdown + jsonl + counts).
 *
 * `now` is an injected clock (defaults to the real one) so tests get a
 * deterministic `capturedAt`.
 */
export function formatCapture(
  capture: Capture,
  options?: FormatOptions,
  now: () => string = () => new Date().toISOString(),
): SourceDoc {
  const capturedAt = now()

  if (capture.kind === 'thread') {
    const { thread } = capture
    const nativeId = threadNativeId(thread.url)
    const markdown = threadToMarkdown(thread, capturedAt, options)
    return {
      id: `${thread.site}:${nativeId}`,
      site: thread.site,
      kind: 'thread',
      title: thread.title,
      canonicalUrl: thread.url,
      capturedAt,
      markdown,
      jsonl: threadToJsonl(thread),
      wordCount: countBodyWords(markdown),
      truncated: thread.truncated ?? false,
    }
  }

  if (capture.kind === 'web') {
    const { web } = capture
    const markdown = webToMarkdown(web, capturedAt)
    return {
      id: `web:${web.id}`,
      site: 'web',
      kind: 'web',
      title: web.title,
      canonicalUrl: web.url,
      capturedAt,
      markdown,
      wordCount: countBodyWords(markdown),
      truncated: false,
    }
  }

  if (capture.kind === 'video') {
    const { video } = capture
    const markdown = videoToMarkdown(video, capturedAt)
    return {
      id: `youtube:${video.videoId}`,
      site: 'youtube',
      kind: 'video',
      title: video.title,
      canonicalUrl: video.url,
      capturedAt,
      markdown,
      wordCount: countBodyWords(markdown),
      truncated: false,
    }
  }

  const { playlist } = capture
  const markdown = playlistToMarkdown(playlist, capturedAt)
  // TODO(ingest): 500k-word/source chunking hooks in here — split this
  // SourceDoc into `<title> (part N)` docs by reply-depth/video-index
  // boundaries when wordCount exceeds NotebookLM's per-source cap. Rare in
  // practice; not implemented at the formatter layer per design §7.
  return {
    id: `youtube:${playlist.playlistId}`,
    site: 'youtube',
    kind: 'playlist',
    title: playlist.title,
    canonicalUrl: playlist.url,
    capturedAt,
    markdown,
    jsonl: playlistToJsonl(playlist),
    ...(playlist.transcriptDocs !== undefined && playlist.transcriptDocs.length > 0
      ? { videoDocs: playlist.transcriptDocs }
      : {}),
    wordCount: countBodyWords(markdown),
    truncated: playlist.truncated ?? false,
  }
}
