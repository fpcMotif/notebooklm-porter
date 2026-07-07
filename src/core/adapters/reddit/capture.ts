import { Effect } from 'effect'
import type { Capture } from '../../model/types'
import { ExtractionError, type FetchError, type HttpStatusError } from '../../fx/errors'
import { Http } from '../../fx/services'
import { parseRedditThread } from './parse'

/**
 * Capture a Reddit discussion via the public `.json` view of the post URL,
 * flattening the t3 (post) + t1 (comment) tree into ordered Posts. Runs in
 * the background service worker: Reddit's `.json` has no ACAO header, so a
 * content script cannot fetch it, but the SW is CORS-exempt.
 */
export function captureRedditThread(
  url: string,
): Effect.Effect<Capture, FetchError | HttpStatusError | ExtractionError, Http> {
  return Effect.gen(function* () {
    const http = yield* Http
    const jsonUrl = toJsonUrl(url)
    const json = yield* http.json(jsonUrl, {
      headers: { 'User-Agent': 'notebooklm-porter (Chrome extension; +https://github.com/)' },
    })
    const thread = yield* Effect.try({
      try: () => parseRedditThread(json, url),
      catch: (cause) => new ExtractionError({ url, reason: String(cause) }),
    })
    return { kind: 'thread', thread }
  })
}

/** Strips query/hash and appends `.json` to the post's permalink URL. */
function toJsonUrl(url: string): string {
  const u = new URL(url)
  u.search = ''
  u.hash = ''
  u.pathname = u.pathname.replace(/\/+$/, '') + '.json'
  return u.toString()
}
