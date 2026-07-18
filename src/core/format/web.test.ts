import { describe, expect, it } from 'vitest'
import { webToMarkdown } from './web'

describe('webToMarkdown', () => {
  it('renders explicit web source and capture-mode metadata', () => {
    // Now routed through the shared frontmatterBlock (frontmatter.ts):
    // captured_at is a yamlScalar like every other writer, so its hyphens
    // now trigger quoting. Previously emitted unquoted via string interpolation.
    expect(
      webToMarkdown(
        {
          id: 'page:123',
          url: 'https://example.com/article',
          title: 'An article',
          mode: 'page',
          text: 'Readable page text',
        },
        '2026-07-11T00:00:00.000Z',
      ),
    ).toBe(`---
source: web
url: "https://example.com/article"
title: An article
capture_mode: page
captured_at: "2026-07-11T00:00:00.000Z"
---

# An article

## Page content

Readable page text`)
  })

  it('labels link captures distinctly', () => {
    const markdown = webToMarkdown(
      {
        id: 'link:123',
        url: 'https://example.com',
        title: 'Example',
        mode: 'link',
        text: 'Example',
      },
      '2026-07-11T00:00:00.000Z',
    )

    expect(markdown).toContain('## Linked page')
  })
})
