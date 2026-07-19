import { isRecord } from '../../fx/guards'
import type { MediaRef } from '../../model/types'
import type { RawTweet } from './extract'

export const X_GRAPHQL_TEE_EVENT = 'porter:x-graphql-response'
export const X_GRAPHQL_TEE_MAX_BODY_CHARS = 2_000_000

const THREAD_OPERATIONS = new Set(['TweetDetail', 'TweetResultByRestId'])
const X_THREAD_EVIDENCE_MAX_TWEETS = 1000

export interface GraphqlTeeEventDetail {
  url: string
  body: string
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

function longerText(first: string, second: string): string {
  return second.length > first.length ? second : first
}

function mergeLinks(
  floor: readonly string[] | undefined,
  observed: readonly string[] | undefined,
): string[] | undefined {
  const links = [...new Set([...(floor ?? []), ...(observed ?? [])])]
  return links.length > 0 ? links : undefined
}

function mergeMedia(
  floor: readonly MediaRef[] | undefined,
  observed: readonly MediaRef[] | undefined,
): MediaRef[] | undefined {
  const media = new Map<string, MediaRef>()
  for (const item of [...(floor ?? []), ...(observed ?? [])]) {
    const key = `${item.kind}\u0000${item.url}`
    const existing = media.get(key)
    if (existing === undefined) {
      media.set(key, item)
      continue
    }
    if ((item.alt?.length ?? 0) > (existing.alt?.length ?? 0)) media.set(key, item)
  }
  return media.size > 0 ? [...media.values()] : undefined
}

function mergeTweetEvidence(floor: RawTweet, observed: RawTweet): RawTweet {
  const useObservedQuote = (observed.quotedText?.length ?? 0) > (floor.quotedText?.length ?? 0)
  const quotedText = useObservedQuote ? observed.quotedText : floor.quotedText
  const quotedAuthorHandle = useObservedQuote
    ? (observed.quotedAuthorHandle ?? floor.quotedAuthorHandle)
    : (floor.quotedAuthorHandle ?? observed.quotedAuthorHandle)
  const links = mergeLinks(floor.links, observed.links)
  const media = mergeMedia(floor.media, observed.media)

  return {
    id: floor.id,
    authorHandle: floor.authorHandle,
    authorName: floor.authorName,
    text: longerText(floor.text, observed.text),
    ...(floor.timestamp !== undefined
      ? { timestamp: floor.timestamp }
      : observed.timestamp !== undefined
        ? { timestamp: observed.timestamp }
        : {}),
    ...(floor.conversationId !== undefined
      ? { conversationId: floor.conversationId }
      : observed.conversationId !== undefined
        ? { conversationId: observed.conversationId }
        : {}),
    ...(quotedAuthorHandle !== undefined ? { quotedAuthorHandle } : {}),
    ...(quotedText !== undefined ? { quotedText } : {}),
    ...(links !== undefined ? { links } : {}),
    ...(media !== undefined ? { media } : {}),
  }
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
      tweets.set(tweet.id, existing === undefined ? tweet : mergeTweetEvidence(existing, tweet))
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
  const conversationId = conversationIdForStatus(tweets, statusId)
  if (conversationId === undefined) return []
  return tweets.filter(
    (tweet) => tweet.id === conversationId || tweet.conversationId === conversationId,
  )
}

function conversationIdForStatus(
  tweets: readonly RawTweet[],
  statusId: string,
): string | undefined {
  const requested = tweets.find((tweet) => tweet.id === statusId)
  return (
    requested?.conversationId ??
    requested?.id ??
    (tweets.some((tweet) => tweet.conversationId === statusId) ? statusId : undefined)
  )
}

function conversationIdForTweet(tweet: RawTweet): string {
  return tweet.conversationId ?? tweet.id
}

function orderConversation(
  tweets: readonly RawTweet[],
  preferredIds: readonly string[] | undefined,
): RawTweet[] {
  if (preferredIds === undefined) return [...tweets]
  const byId = new Map(tweets.map((tweet) => [tweet.id, tweet]))
  const ordered = preferredIds.flatMap((id) => byId.get(id) ?? [])
  const placed = new Set(ordered.map((tweet) => tweet.id))
  return [...ordered, ...tweets.filter((tweet) => !placed.has(tweet.id))]
}

function reconcileXThread(
  graphTweets: readonly RawTweet[],
  domTweets: readonly RawTweet[],
): RawTweet[] {
  if (graphTweets.length === 0) return [...domTweets]
  const graphIds = new Set(graphTweets.map((tweet) => tweet.id))
  const domById = new Map(domTweets.map((tweet) => [tweet.id, tweet]))

  if (domTweets.every((tweet) => graphIds.has(tweet.id))) {
    return graphTweets.map((tweet) => {
      const domTweet = domById.get(tweet.id)
      return domTweet === undefined ? tweet : mergeTweetEvidence(domTweet, tweet)
    })
  }

  const graphById = new Map(graphTweets.map((tweet) => [tweet.id, tweet]))
  return domTweets.map((tweet) => {
    const graphTweet = graphById.get(tweet.id)
    return graphTweet === undefined ? tweet : mergeTweetEvidence(tweet, graphTweet)
  })
}

export interface XThreadEvidence {
  observe(detail: unknown): void
  resolve(statusId: string, domTweets: readonly RawTweet[]): RawTweet[]
}

/**
 * Owns one document's bounded passive GraphQL evidence. DOM capture remains
 * the floor; observations can enrich it but cannot shrink or weaken it.
 */
export function createXThreadEvidence(): XThreadEvidence {
  const observedTweets = new Map<string, RawTweet>()
  const preferredOrderByConversation = new Map<string, string[]>()

  function removeFromPreferredOrders(tweetId: string): void {
    for (const [conversationId, order] of preferredOrderByConversation) {
      if (!order.includes(tweetId)) continue
      const remaining = order.filter((id) => id !== tweetId)
      if (remaining.length === 0) preferredOrderByConversation.delete(conversationId)
      else preferredOrderByConversation.set(conversationId, remaining)
    }
  }

  return {
    observe(detail: unknown): void {
      if (!isGraphqlTeeEventDetail(detail)) return
      try {
        const payload = JSON.parse(detail.body) as unknown
        const observationOrder = new Map<string, string[]>()
        for (const tweet of tweetsFromGraphql(payload)) {
          const existing = observedTweets.get(tweet.id)
          const merged = existing === undefined ? tweet : mergeTweetEvidence(existing, tweet)
          if (
            existing !== undefined &&
            conversationIdForTweet(existing) !== conversationIdForTweet(merged)
          ) {
            removeFromPreferredOrders(tweet.id)
          }
          if (existing === undefined && observedTweets.size >= X_THREAD_EVIDENCE_MAX_TWEETS) {
            const oldestId = observedTweets.keys().next().value
            if (oldestId !== undefined) {
              observedTweets.delete(oldestId)
              removeFromPreferredOrders(oldestId)
            }
          }
          observedTweets.set(tweet.id, merged)
          const conversationId = conversationIdForTweet(merged)
          const order = observationOrder.get(conversationId) ?? []
          order.push(tweet.id)
          observationOrder.set(conversationId, order)
        }
        for (const [conversationId, order] of observationOrder) {
          const candidate = order.filter((id) => observedTweets.has(id))
          if (candidate.length === 0) continue
          const current = preferredOrderByConversation.get(conversationId) ?? []
          // More rows give stronger order evidence; equal coverage favors the fresher response.
          if (candidate.length >= current.length) {
            preferredOrderByConversation.set(conversationId, candidate)
          }
        }
      } catch {
        // Malformed page evidence cannot invalidate the DOM capture floor.
      }
    },
    resolve(statusId: string, domTweets: readonly RawTweet[]): RawTweet[] {
      const observed = [...observedTweets.values()]
      const conversationId = conversationIdForStatus(observed, statusId)
      const graphTweets = orderConversation(
        tweetsForStatus(observed, statusId),
        conversationId === undefined ? undefined : preferredOrderByConversation.get(conversationId),
      )
      return reconcileXThread(graphTweets, domTweets)
    },
  }
}
