import type { Video } from '../model/types'
import { CAPTURED_AT_KEY, yamlScalar } from './frontmatter'

/** Renders the local/export representation of one URL-backed YouTube source. */
export function videoToMarkdown(video: Video, capturedAt: string): string {
  const frontmatter = [
    '---',
    'source: youtube',
    `url: ${yamlScalar(video.url)}`,
    `title: ${yamlScalar(video.title)}`,
    `video_id: ${video.videoId}`,
    `${CAPTURED_AT_KEY}: ${capturedAt}`,
    ...(video.channel !== undefined ? [`channel: ${yamlScalar(video.channel)}`] : []),
    ...(video.durationSeconds !== undefined ? [`duration_seconds: ${video.durationSeconds}`] : []),
    '---',
  ]
  return [
    ...frontmatter,
    '',
    `# ${video.title}`,
    '',
    `NotebookLM imports this canonical YouTube source: ${video.url}`,
  ].join('\n')
}
