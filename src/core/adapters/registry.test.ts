import { describe, expect, it } from 'vitest'
import { adapterForUrl, resolveCapturable } from './registry'

describe('adapterForUrl', () => {
  it('matches a registered host without deciding whether its path is capturable', () => {
    expect(adapterForUrl('https://www.youtube.com/')).toMatchObject({ id: 'youtube' })
    expect(adapterForUrl('https://www.youtube.com/unsupported')).toMatchObject({ id: 'youtube' })
  })

  it('matches the declared origin scheme, not only its hostname', () => {
    expect(adapterForUrl('http://www.youtube.com/watch?v=abcdefghijk')).toBeUndefined()
  })
})

describe('resolveCapturable', () => {
  it.each([
    ['https://www.youtube.com/playlist?list=PL123', 'youtube', 'playlist', 'PL123'],
    ['https://www.reddit.com/r/test/comments/abc123/title', 'reddit', 'thread', 'abc123'],
    ['https://news.ycombinator.com/item?id=42', 'hackernews', 'thread', '42'],
    ['https://x.com/porter/status/42', 'x', 'thread', '42'],
  ] as const)('resolves a valid %s URL once', (url, adapterId, kind, identity) => {
    expect(resolveCapturable(url)).toMatchObject({
      url,
      adapter: { id: adapterId },
      capturable: { kind, identity },
    })
  })

  it.each([
    'https://www.youtube.com/',
    'https://www.reddit.com/r/test/',
    'https://news.ycombinator.com/newest',
    'https://x.com/porter',
  ])('rejects an invalid same-host path: %s', (url) => {
    expect(resolveCapturable(url)).toBeUndefined()
  })
})
