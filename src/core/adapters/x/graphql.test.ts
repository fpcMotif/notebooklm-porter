import { describe, expect, it } from 'vitest'
import {
  isGraphqlTeeEventDetail,
  isXThreadGraphqlUrl,
  preferCompleteGraphqlThread,
  tweetsForStatus,
  tweetsFromGraphql,
} from './graphql'

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

  it('uses observed GraphQL rows only when the requested root status is present', () => {
    const tweets = tweetsFromGraphql(payload)

    expect(tweetsForStatus(tweets, '1000').map((row) => row.id)).toEqual(['1000', '1001'])
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

  it('does not replace a fuller DOM capture with a partial GraphQL observation', () => {
    const graphTweets = tweetsFromGraphql({
      data: {
        result: tweet('1002', {
          handle: 'alice',
          name: 'Alice',
          text: 'Requested reply',
          conversationId: '1000',
        }),
      },
    })
    const domTweets = tweetsFromGraphql(payload)

    expect(preferCompleteGraphqlThread(graphTweets, domTweets).map((row) => row.id)).toEqual(
      domTweets.map((row) => row.id),
    )
  })
})
