import type { MediaRef } from '../../model/types'
import type { RawTweet } from './extract'

export const X_GRAPHQL_TEE_EVENT = 'porter:x-graphql-response'
export const X_GRAPHQL_TEE_MAX_BODY_CHARS = 2_000_000

const THREAD_OPERATIONS = new Set(['TweetDetail', 'TweetResultByRestId'])

export interface GraphqlTeeEventDetail {
  url: string
  body: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recordAt(value: unknown, key: string): Record<string, unknown> | undefined {
  return isRecord(value) && isRecord(value[key]) ? value[key] : undefined
}

function stringAt(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === 'string' ? value[key] : undefined
}

function arrayAt(value: unknown, key: string): unknown[] {
  return isRecord(value) && Array.isArray(value[key]) ? value[key] : []
}

function firstString(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.length > 0)
}

/** True only for page-owned thread result requests; Porter never makes this request itself. */
export function isXThreadGraphqlUrl(url: string): boolean {
  try {
    const parsed = new URL(url, 'https://x.com')
    const match = parsed.pathname.match(/^\/i\/api\/graphql\/[^/]+\/([^/]+)$/)
    const operation = match?.[1]
    return operation !== undefined && THREAD_OPERATIONS.has(operation)
  } catch {
    return false
  }
}

export function isGraphqlTeeEventDetail(value: unknown): value is GraphqlTeeEventDetail {
  return (
    isRecord(value) &&
    typeof value.url === 'string' &&
    isXThreadGraphqlUrl(value.url) &&
    typeof value.body === 'string' &&
    value.body.length <= X_GRAPHQL_TEE_MAX_BODY_CHARS
  )
}

function unwrapTweet(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  if (value['__typename'] === 'TweetTombstone') return undefined
  if (value['__typename'] === 'TweetWithVisibilityResults') return unwrapTweet(value.tweet)
  return value
}

function nestedText(value: unknown): string | undefined {
  const noteTweet = recordAt(value, 'note_tweet')
  const noteResults = recordAt(noteTweet, 'note_tweet_results')
  return stringAt(recordAt(noteResults, 'result'), 'text')
}

function isoTimestamp(value: unknown): string | undefined {
  const raw = stringAt(value, 'created_at')
  if (raw === undefined) return undefined
  const milliseconds = Date.parse(raw)
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined
}

function linksFromLegacy(legacy: Record<string, unknown>): string[] | undefined {
  const entities = recordAt(legacy, 'entities')
  const links = arrayAt(entities, 'urls')
    .flatMap((link) => firstString(stringAt(link, 'expanded_url'), stringAt(link, 'url')) ?? [])
    .filter((link, index, all) => all.indexOf(link) === index)
  return links.length > 0 ? links : undefined
}

function mediaFromLegacy(legacy: Record<string, unknown>): MediaRef[] | undefined {
  const extended = recordAt(legacy, 'extended_entities')
  const entities = extended ?? recordAt(legacy, 'entities')
  const media = arrayAt(entities, 'media').flatMap((item) => {
    const url = firstString(stringAt(item, 'media_url_https'), stringAt(item, 'media_url'))
    if (url === undefined) return []
    const type = stringAt(item, 'type')
    const alt = stringAt(item, 'ext_alt_text')
    return [
      {
        kind: type === 'video' || type === 'animated_gif' ? ('video' as const) : ('image' as const),
        url,
        ...(alt !== undefined && alt.length > 0 ? { alt } : {}),
      },
    ]
  })
  return media.length > 0 ? media : undefined
}

function userFromTweet(
  value: Record<string, unknown>,
): { handle: string; name: string } | undefined {
  const core = recordAt(value, 'core')
  const userResults = recordAt(core, 'user_results')
  const user = recordAt(userResults, 'result')
  const legacy = recordAt(user, 'legacy')
  const handle = stringAt(legacy, 'screen_name')
  if (handle === undefined) return undefined
  return { handle, name: stringAt(legacy, 'name') ?? handle }
}

function quotedTweet(value: Record<string, unknown>): RawTweet | undefined {
  const direct =
    recordAt(value, 'quoted_status_result') ??
    recordAt(recordAt(value, 'legacy'), 'quoted_status_result')
  const result = recordAt(direct, 'result')
  return result === undefined ? undefined : tweetFromGraphql(result)
}

function tweetFromGraphql(value: unknown): RawTweet | undefined {
  const tweet = unwrapTweet(value)
  if (tweet === undefined) return undefined
  const legacy = recordAt(tweet, 'legacy')
  const id = firstString(stringAt(tweet, 'rest_id'), stringAt(legacy, 'id_str'))
  const author = userFromTweet(tweet)
  if (id === undefined || author === undefined || legacy === undefined) return undefined

  const quote = quotedTweet(tweet)
  const timestamp = isoTimestamp(legacy)
  const conversationId = stringAt(legacy, 'conversation_id_str')
  const links = linksFromLegacy(legacy)
  const media = mediaFromLegacy(legacy)
  return {
    id,
    authorHandle: author.handle,
    authorName: author.name,
    text:
      firstString(nestedText(tweet), stringAt(legacy, 'full_text'), stringAt(legacy, 'text')) ?? '',
    ...(timestamp !== undefined ? { timestamp } : {}),
    ...(conversationId !== undefined ? { conversationId } : {}),
    ...(quote !== undefined
      ? { quotedAuthorHandle: quote.authorHandle, quotedText: quote.text }
      : {}),
    ...(links !== undefined ? { links } : {}),
    ...(media !== undefined ? { media } : {}),
  }
}

/**
 * Walks a GraphQL response defensively. Result wrappers vary often, so only
 * a shape that has a tweet id, user handle, and legacy payload becomes a row.
 */
export function tweetsFromGraphql(payload: unknown): RawTweet[] {
  const seen = new WeakSet<object>()
  const tweets = new Map<string, RawTweet>()

  const visit = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || seen.has(value)) return
    seen.add(value)
    const tweet = tweetFromGraphql(value)
    if (tweet !== undefined) {
      const existing = tweets.get(tweet.id)
      if (existing === undefined || tweet.text.length > existing.text.length)
        tweets.set(tweet.id, tweet)
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    for (const nested of Object.values(value)) visit(nested)
  }

  visit(payload)
  return [...tweets.values()]
}

/**
 * Returns the requested status's observed conversation. A permalink may point
 * at any reply, so its `conversationId` — rather than its own status id —
 * defines the graph boundary.
 */
export function tweetsForStatus(tweets: readonly RawTweet[], statusId: string): RawTweet[] {
  const requested = tweets.find((tweet) => tweet.id === statusId)
  if (requested === undefined) return []

  const conversationId = requested.conversationId ?? requested.id
  return tweets.filter(
    (tweet) => tweet.id === conversationId || tweet.conversationId === conversationId,
  )
}

/**
 * Passive GraphQL observation can enrich a DOM capture, but must never shrink
 * it. Prefer it only when it covers every tweet the scroll drain found.
 */
export function preferCompleteGraphqlThread(
  graphTweets: readonly RawTweet[],
  domTweets: readonly RawTweet[],
): RawTweet[] {
  if (graphTweets.length === 0) return [...domTweets]
  const graphIds = new Set(graphTweets.map((tweet) => tweet.id))
  return domTweets.every((tweet) => graphIds.has(tweet.id)) ? [...graphTweets] : [...domTweets]
}
