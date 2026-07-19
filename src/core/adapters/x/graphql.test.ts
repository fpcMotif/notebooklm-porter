import { describe, expect, it } from 'vitest'
import {
  createXThreadEvidence,
  isGraphqlTeeEventDetail,
  isXThreadGraphqlUrl,
  tweetsForStatus,
  tweetsFromGraphql,
} from './graphql'
import type { RawTweet } from './extract'

function tweet(
  id: string,
  input: {
    handle: string
    name: string
    text: string
    conversationId?: string
    longText?: string
    quoted?: unknown
    media?: boolean
  },
): Record<string, unknown> {
  return {
    __typename: 'TweetWithVisibilityResults',
    tweet: {
      rest_id: id,
      legacy: {
        id_str: id,
        conversation_id_str: input.conversationId ?? id,
        full_text: input.text,
        created_at: 'Wed Oct 10 20:19:24 +0000 2018',
        entities: {
          urls: [{ expanded_url: 'https://example.com/read', url: 'https://t.co/read' }],
        },
        ...(input.media
          ? {
              extended_entities: {
                media: [
                  {
                    type: 'photo',
                    media_url_https: 'https://pbs.twimg.com/media/example.jpg',
                    ext_alt_text: 'Example image',
                  },
                ],
              },
            }
          : {}),
      },
      core: {
        user_results: { result: { legacy: { screen_name: input.handle, name: input.name } } },
      },
      ...(input.longText !== undefined
        ? { note_tweet: { note_tweet_results: { result: { text: input.longText } } } }
        : {}),
      ...(input.quoted !== undefined ? { quoted_status_result: { result: input.quoted } } : {}),
    },
  }
}

const root = tweet('1000', {
  handle: 'alice',
  name: 'Alice',
  text: 'short preview https://t.co/read',
  longText: 'Long-form text with\n\nparagraphs',
  quoted: tweet('888', { handle: 'dave', name: 'Dave', text: 'Quoted source' }),
  media: true,
})

const payload = {
  data: {
    threaded_conversation_with_injections_v2: {
      instructions: [
        {
          entries: [
            { content: { itemContent: { tweet_results: { result: root } } } },
            {
              content: {
                itemContent: {
                  tweet_results: {
                    result: tweet('1001', {
                      handle: 'alice',
                      name: 'Alice',
                      text: 'Thread continuation',
                      conversationId: '1000',
                    }),
                  },
                },
              },
            },
            {
              content: {
                itemContent: { tweet_results: { result: { __typename: 'TweetTombstone' } } },
              },
            },
          ],
        },
      ],
    },
  },
}

function detail(bodyPayload: unknown): { url: string; body: string } {
  return {
    url: 'https://x.com/i/api/graphql/id/TweetDetail',
    body: JSON.stringify(bodyPayload),
  }
}

function rawTweet(id: string, text: string, input: Partial<RawTweet> = {}): RawTweet {
  return {
    id,
    authorHandle: 'alice',
    authorName: 'Alice',
    text,
    ...input,
  }
}

describe('X GraphQL tee contracts', () => {
  it('limits the passive tee to page-owned thread result operations', () => {
    expect(isXThreadGraphqlUrl('https://x.com/i/api/graphql/id/TweetDetail?variables={}')).toBe(
      true,
    )
    expect(isXThreadGraphqlUrl('https://x.com/i/api/graphql/id/TweetResultByRestId')).toBe(true)
    expect(isXThreadGraphqlUrl('https://x.com/i/api/graphql/id/HomeTimeline')).toBe(false)
    expect(
      isGraphqlTeeEventDetail({ url: 'https://x.com/i/api/graphql/id/TweetDetail', body: '{}' }),
    ).toBe(true)
    expect(isGraphqlTeeEventDetail({ url: 'https://x.com/home', body: '{}' })).toBe(false)
  })

  it('unwraps GraphQL result wrappers and preserves long text, quote, links, and media', () => {
    const tweets = tweetsFromGraphql(payload)
    const parsedRoot = tweets.find((row) => row.id === '1000')

    expect(tweets.map((row) => row.id)).toEqual(['1000', '888', '1001'])
    expect(parsedRoot).toMatchObject({
      authorHandle: 'alice',
      authorName: 'Alice',
      text: 'Long-form text with\n\nparagraphs',
      conversationId: '1000',
      timestamp: '2018-10-10T20:19:24.000Z',
      quotedAuthorHandle: 'dave',
      quotedText: 'Quoted source',
      links: ['https://example.com/read'],
      media: [
        {
          kind: 'image',
          url: 'https://pbs.twimg.com/media/example.jpg',
          alt: 'Example image',
        },
      ],
    })
  })

  it('uses observed GraphQL rows when the requested root or matching conversation is present', () => {
    const tweets = tweetsFromGraphql(payload)
    const rootMissing = tweets.filter((row) => row.id !== '1000')

    expect(tweetsForStatus(tweets, '1000').map((row) => row.id)).toEqual(['1000', '1001'])
    expect(tweetsForStatus(rootMissing, '1000').map((row) => row.id)).toEqual(['1001'])
    expect(tweetsForStatus(tweets, 'missing')).toEqual([])
  })

  it('keeps the whole conversation when the requested status is a reply permalink', () => {
    const tweets = tweetsFromGraphql({
      data: {
        threaded_conversation_with_injections_v2: {
          instructions: [
            {
              entries: [
                {
                  content: {
                    itemContent: {
                      tweet_results: {
                        result: tweet('1000', {
                          handle: 'alice',
                          name: 'Alice',
                          text: 'Root',
                        }),
                      },
                    },
                  },
                },
                {
                  content: {
                    itemContent: {
                      tweet_results: {
                        result: tweet('1002', {
                          handle: 'alice',
                          name: 'Alice',
                          text: 'Requested reply',
                          conversationId: '1000',
                        }),
                      },
                    },
                  },
                },
                {
                  content: {
                    itemContent: {
                      tweet_results: {
                        result: tweet('1003', {
                          handle: 'bob',
                          name: 'Bob',
                          text: 'Later reply',
                          conversationId: '1000',
                        }),
                      },
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    })

    expect(tweetsForStatus(tweets, '1002').map((row) => row.id)).toEqual(['1000', '1002', '1003'])
  })

  it('enriches matching DOM rows without shrinking a partial observation', () => {
    const evidence = createXThreadEvidence()
    evidence.observe(
      detail({
        data: {
          result: tweet('1000', {
            handle: 'alice',
            name: 'Alice',
            text: 'preview',
            longText: 'Complete long-form text',
          }),
        },
      }),
    )
    const domTweets = [
      rawTweet('1000', 'preview'),
      rawTweet('1001', 'DOM-only reply', { conversationId: '1000' }),
    ]

    expect(evidence.resolve('1000', domTweets)).toEqual([
      rawTweet('1000', 'Complete long-form text', {
        timestamp: '2018-10-10T20:19:24.000Z',
        conversationId: '1000',
        links: ['https://example.com/read'],
      }),
      domTweets[1],
    ])
  })

  it('uses GraphQL order only with full DOM coverage and never downgrades DOM evidence', () => {
    const evidence = createXThreadEvidence()
    evidence.observe(
      detail({
        data: {
          rows: [
            tweet('1001', {
              handle: 'alice',
              name: 'Alice',
              text: '',
              conversationId: '1000',
            }),
            tweet('1002', {
              handle: 'alice',
              name: 'Alice',
              text: 'Graph-only middle',
              conversationId: '1000',
            }),
            tweet('1000', {
              handle: 'alice',
              name: 'Alice',
              text: 'root',
            }),
          ],
        },
      }),
    )
    const domTweets = [
      rawTweet('1000', 'DOM root'),
      rawTweet('1001', 'Better DOM reply', {
        conversationId: '1000',
        quotedAuthorHandle: 'bob',
        quotedText: 'Long DOM quote',
        links: ['https://dom.example/read'],
        media: [{ kind: 'image', url: 'https://dom.example/image.jpg', alt: 'DOM alt' }],
      }),
    ]

    const resolved = evidence.resolve('1000', domTweets)

    expect(resolved.map((row) => row.id)).toEqual(['1001', '1002', '1000'])
    expect(resolved[0]).toMatchObject({
      text: 'Better DOM reply',
      quotedAuthorHandle: 'bob',
      quotedText: 'Long DOM quote',
      links: ['https://dom.example/read', 'https://example.com/read'],
      media: [{ kind: 'image', url: 'https://dom.example/image.jpg', alt: 'DOM alt' }],
    })
    expect(resolved[2]?.text).toBe('DOM root')
  })

  it('replaces a partial observation order with a more complete conversation order', () => {
    const evidence = createXThreadEvidence()
    evidence.observe(
      detail({
        data: {
          rows: [
            tweet('1001', {
              handle: 'alice',
              name: 'Alice',
              text: 'Reply',
              conversationId: '1000',
            }),
            tweet('1000', { handle: 'alice', name: 'Alice', text: 'Root' }),
          ],
        },
      }),
    )
    evidence.observe(
      detail({
        data: {
          rows: [
            tweet('1000', { handle: 'alice', name: 'Alice', text: 'Root' }),
            tweet('1001', {
              handle: 'alice',
              name: 'Alice',
              text: 'Reply',
              conversationId: '1000',
            }),
            tweet('1002', {
              handle: 'alice',
              name: 'Alice',
              text: 'Graph-only reply',
              conversationId: '1000',
            }),
          ],
        },
      }),
    )

    const resolved = evidence.resolve('1000', [
      rawTweet('1000', 'DOM root'),
      rawTweet('1001', 'DOM reply', { conversationId: '1000' }),
    ])

    expect(resolved.map((row) => row.id)).toEqual(['1000', '1001', '1002'])
  })

  it('merges a smaller later observation without replacing the best complete order', () => {
    const evidence = createXThreadEvidence()
    evidence.observe(
      detail({
        data: {
          rows: [
            tweet('1000', { handle: 'alice', name: 'Alice', text: 'Root' }),
            tweet('1001', {
              handle: 'alice',
              name: 'Alice',
              text: 'Reply',
              conversationId: '1000',
            }),
            tweet('1002', {
              handle: 'alice',
              name: 'Alice',
              text: 'Last reply',
              conversationId: '1000',
            }),
          ],
        },
      }),
    )
    evidence.observe(
      detail({
        data: {
          result: tweet('1001', {
            handle: 'alice',
            name: 'Alice',
            text: 'A much longer enriched reply',
            conversationId: '1000',
            media: true,
          }),
        },
      }),
    )

    const resolved = evidence.resolve('1000', [
      rawTweet('1000', 'DOM root'),
      rawTweet('1001', 'DOM reply', { conversationId: '1000' }),
    ])

    expect(resolved.map((row) => row.id)).toEqual(['1000', '1001', '1002'])
    expect(resolved[1]).toMatchObject({
      text: 'A much longer enriched reply',
      media: [
        {
          kind: 'image',
          url: 'https://pbs.twimg.com/media/example.jpg',
          alt: 'Example image',
        },
      ],
    })
  })

  it('lets an equally complete later observation replace conversation order', () => {
    const evidence = createXThreadEvidence()
    const first = [
      tweet('1000', { handle: 'alice', name: 'Alice', text: 'Root' }),
      tweet('1001', {
        handle: 'alice',
        name: 'Alice',
        text: 'Reply',
        conversationId: '1000',
      }),
      tweet('1002', {
        handle: 'alice',
        name: 'Alice',
        text: 'Last reply',
        conversationId: '1000',
      }),
    ]
    evidence.observe(detail({ data: { rows: first } }))
    evidence.observe(detail({ data: { rows: [first[2], first[0], first[1]] } }))

    const resolved = evidence.resolve('1000', [
      rawTweet('1000', 'DOM root'),
      rawTweet('1001', 'DOM reply', { conversationId: '1000' }),
    ])

    expect(resolved.map((row) => row.id)).toEqual(['1002', '1000', '1001'])
  })

  it('merges repeated observations instead of keeping only the longest response', () => {
    const evidence = createXThreadEvidence()
    evidence.observe(
      detail({
        data: {
          result: tweet('1000', {
            handle: 'alice',
            name: 'Alice',
            text: 'A much longer first observation',
          }),
        },
      }),
    )
    evidence.observe(
      detail({
        data: {
          result: tweet('1000', {
            handle: 'alice',
            name: 'Alice',
            text: 'short',
            conversationId: 'conflicting-root',
            media: true,
          }),
        },
      }),
    )

    expect(evidence.resolve('1000', [rawTweet('1000', 'DOM')])[0]).toMatchObject({
      text: 'A much longer first observation',
      conversationId: '1000',
      media: [
        {
          kind: 'image',
          url: 'https://pbs.twimg.com/media/example.jpg',
          alt: 'Example image',
        },
      ],
    })
  })

  it('ignores malformed observations and evicts the oldest new id at its fixed bound', () => {
    const evidence = createXThreadEvidence()
    evidence.observe({ url: 'https://x.com/home', body: '{}' })
    evidence.observe({ url: 'https://x.com/i/api/graphql/id/TweetDetail', body: '{' })
    evidence.observe(
      detail({
        data: {
          rows: Array.from({ length: 1001 }, (_, index) =>
            tweet(String(1000 + index), {
              handle: 'alice',
              name: 'Alice',
              text: `Graph text ${index}`,
            }),
          ),
        },
      }),
    )

    const dom = [rawTweet('1000', 'DOM floor')]
    expect(evidence.resolve('1000', dom)).toEqual(dom)
    expect(evidence.resolve('2000', [rawTweet('2000', 'DOM')])[0]?.text).toBe('Graph text 1000')
  })
})
