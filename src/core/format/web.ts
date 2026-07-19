import type { WebCapture } from '../model/types'
import { CAPTURED_AT_KEY, frontmatterBlock } from './frontmatter'

function modeLabel(mode: WebCapture['mode']): string {
  switch (mode) {
    case 'selection':
      return 'Selection'
    case 'page':
      return 'Page content'
    case 'link':
      return 'Linked page'
  }
}

/** Renders a generic browser-context capture as a standalone text source. */
export function webToMarkdown(web: WebCapture, capturedAt: string): string {
  const fm = frontmatterBlock([
    ['source', 'web'],
    ['url', web.url],
    ['title', web.title],
    ['capture_mode', web.mode],
    [CAPTURED_AT_KEY, capturedAt],
  ])
  return [...fm, '', `# ${web.title}`, '', `## ${modeLabel(web.mode)}`, '', web.text].join('\n')
}
