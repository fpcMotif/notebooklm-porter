import type { Video } from '../model/types'
import { CAPTURED_AT_KEY, frontmatterBlock } from './frontmatter'

/** Renders the local/export representation of one URL-backed YouTube source. */
export function videoToMarkdown(video: Video, capturedAt: string): string {
  const fm = frontmatterBlock([
    ['source', 'youtube'],
    ['url', video.url],
    ['title', video.title],
    ['video_id', video.videoId],
    [CAPTURED_AT_KEY, capturedAt],
    ['channel', video.channel],
    ['duration_seconds', video.durationSeconds],
  ])
  return [
    ...fm,
    '',
    `# ${video.title}`,
    '',
    `NotebookLM imports this canonical YouTube source: ${video.url}`,
  ].join('\n')
}
