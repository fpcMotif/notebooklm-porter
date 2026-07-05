import type { Capture } from '../../model/types'
import { parseHnItem } from './parse'

const ALGOLIA_ITEM_URL = 'https://hn.algolia.com/api/v1/items/'

/** Extracts the numeric item id from a `/item?id=<id>` URL. */
function extractItemId(url: string): string {
  const u = new URL(url)
  const id = u.searchParams.get('id')
  if (!id) throw new Error(`not an HN item URL: ${url}`)
  return id
}

/**
 * Capture a Hacker News discussion via the Algolia items API
 * (`https://hn.algolia.com/api/v1/items/{id}`), which returns the whole
 * nested comment tree in one request. Runs in the service worker; parsing
 * itself is pure and lives in `parse.ts`.
 */
export async function captureHnThread(url: string): Promise<Capture> {
  const id = extractItemId(url)
  const canonicalUrl = `https://news.ycombinator.com/item?id=${id}`

  const response = await fetch(`${ALGOLIA_ITEM_URL}${id}`)
  if (!response.ok) {
    throw new Error(`HN Algolia fetch failed: ${response.status} ${response.statusText}`)
  }

  const json: unknown = JSON.parse(await response.text())
  const thread = parseHnItem(json, canonicalUrl)

  return { kind: 'thread', thread }
}
