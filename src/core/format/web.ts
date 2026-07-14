import type { WebCapture } from '../model/types'

function yamlScalar(value: string): string {
  if (value === '') return '""'
  const needsQuoting = /[:#?\-[\]{}&*!|>'"%@`\n]/.test(value) || /^\s|\s$/.test(value)
  return needsQuoting ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : value
}

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
  const frontmatter = [
    '---',
    'source: web',
    `url: ${yamlScalar(web.url)}`,
    `title: ${yamlScalar(web.title)}`,
    `capture_mode: ${web.mode}`,
    `captured_at: ${capturedAt}`,
    '---',
  ]
  return [...frontmatter, '', `# ${web.title}`, '', `## ${modeLabel(web.mode)}`, '', web.text].join(
    '\n',
  )
}
