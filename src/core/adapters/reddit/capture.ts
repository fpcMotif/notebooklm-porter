import type { Capture } from '../../model/types'
import { parseRedditThread } from './parse'

/**
 * Capture a Reddit discussion via the public `.json` view of the post URL,
 * flattening the t3 (post) + t1 (comment) tree into ordered Posts. Runs in
 * the background service worker: Reddit's `.json` has no ACAO header, so a
 * content script cannot fetch it, but the SW is CORS-exempt.
 */
export async function captureRedditThread(url: string): Promise<Capture> {
  const jsonUrl = toJsonUrl(url)
  const res = await fetch(jsonUrl, {
    headers: { 'User-Agent': 'notebooklm-porter (Chrome extension; +https://github.com/)' },
  })
  if (!res.ok) {
    throw new Error(`captureRedditThread: fetch ${jsonUrl} failed with ${res.status}`)
  }
  const json = await res.json()
  const thread = parseRedditThread(json, url)
  return { kind: 'thread', thread }
}

/** Strips query/hash and appends `.json` to the post's permalink URL. */
function toJsonUrl(url: string): string {
  const u = new URL(url)
  u.search = ''
  u.hash = ''
  u.pathname = u.pathname.replace(/\/+$/, '') + '.json'
  return u.toString()
}
