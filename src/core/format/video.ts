import type { Video } from '../model/types'

/** Renders the local/export representation of one URL-backed YouTube source. */
export function videoToMarkdown(video: Video, capturedAt: string): string {
  const frontmatter = [
    '---',
    'source: youtube',
    `url: ${JSON.stringify(video.url)}`,
    `title: ${JSON.stringify(video.title)}`,
    `video_id: ${video.videoId}`,
    `captured_at: ${capturedAt}`,
    ...(video.channel !== undefined ? [`channel: ${JSON.stringify(video.channel)}`] : []),
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
