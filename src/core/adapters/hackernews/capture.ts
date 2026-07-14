import { Effect } from 'effect'
import type { Capture } from '../../model/types'
import { ExtractionError, type FetchError, type HttpStatusError } from '../../fx/errors'
import { Http } from '../../fx/services'
import { parseHnItem } from './parse'

const ALGOLIA_ITEM_URL = 'https://hn.algolia.com/api/v1/items/'

/** Extracts the numeric item id from a `/item?id=<id>` URL. */
function extractItemId(url: string): Effect.Effect<string, ExtractionError> {
  const u = new URL(url)
  const id = u.searchParams.get('id')
  if (!id) {
    return Effect.fail(new ExtractionError({ url, reason: 'not an HN item URL' }))
  }
  return Effect.succeed(id)
}

/**
 * Capture a Hacker News discussion via the Algolia items API
 * (`https://hn.algolia.com/api/v1/items/{id}`), which returns the whole
 * nested comment tree in one request. Runs in the service worker; parsing
 * itself is pure and lives in `parse.ts`.
 */
export function captureHnThread(
  url: string,
): Effect.Effect<Capture, FetchError | HttpStatusError | ExtractionError, Http> {
  return Effect.gen(function* () {
    const http = yield* Http
    const id = yield* extractItemId(url)
    const canonicalUrl = `https://news.ycombinator.com/item?id=${id}`

    const json = yield* http.json(`${ALGOLIA_ITEM_URL}${id}`)
    const thread = yield* Effect.try({
      try: () => parseHnItem(json, canonicalUrl),
      catch: (cause) => new ExtractionError({ url, reason: String(cause) }),
    })

    return { kind: 'thread', thread }
  })
}
