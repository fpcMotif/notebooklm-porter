import { describe, expect, it } from 'vitest'
import type { Thread } from '../model/types'
import { threadToJsonl } from './jsonl'

function thread(posts: Thread['posts']): Thread {
  return {
    site: 'x',
    url: 'https://x.com/alice/status/1',
    title: 'Evidence thread',
    author: { name: 'Alice', handle: '@alice' },
    posts,
  }
}

describe('threadToJsonl', () => {
  it('preserves every evidence field on each post in flat reading order', () => {
    const posts: Thread['posts'] = [
      {
        id: 'root',
        author: { name: 'Alice', handle: '@alice' },
        createdAt: '2026-07-18T01:02:03.000Z',
        depth: 0,
        text: 'Root evidence',
        score: 42,
        byOp: true,
        media: [
          { kind: 'image', url: 'https://example.com/image.jpg', alt: 'A chart' },
          { kind: 'link-card', url: 'https://example.com/card', alt: 'Source card' },
        ],
        links: ['https://example.com/evidence', 'https://example.com/context'],
      },
      {
        id: 'reply',
        author: { name: 'Bob' },
        depth: 1,
        text: 'Reply evidence',
        parentId: 'root',
        byOp: false,
      },
    ]
    const before = structuredClone(posts)

    const records: unknown[] = threadToJsonl(thread(posts))
      .split('\n')
      .map((line) => JSON.parse(line))

    expect(records).toEqual(posts)
    expect(posts).toEqual(before)
  })
})
